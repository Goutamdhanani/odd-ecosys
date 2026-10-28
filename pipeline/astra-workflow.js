import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, canonicalJson, sha256 } from './astra-ledger.js';
import { normalizeAstraTenantId, normalizeAstraUserId } from './astra-tenant-context.js';
import { recordAstraTelemetry } from './astra-telemetry.js';

export class AstraWorkflowError extends Error {
  constructor(message, statusCode=400, code='workflow_invalid') { super(message); this.name='AstraWorkflowError'; this.statusCode=statusCode; this.code=code; }
}
const TYPES = new Set(['research','verification','drafting','reply_classification']);
const CLASSES = new Set(['interactive','suppression','standard','bulk']);
const OUTPUTS = new Set(['research_report','evidence_summary','claim_set','verification_result','draft_copy','reply_classification']);
const ref = x => x && typeof x==='object' && typeof x.tenantId==='string' && typeof x.recordId==='string';
const isObj = x => x && typeof x==='object' && !Array.isArray(x);
const hash = s => createHash('sha256').update(s).digest('hex');
function pinnedEvidenceRefs(task,tenantId) {
  const entries=(task.contextManifest?.entries||[]).filter(e=>e.recordType==='evidence');
  const ids=new Set((task.inputEvidenceRefs||[]).map(x=>x.recordId));
  const selected=ids.size?entries.filter(e=>ids.has(e.recordRef?.recordId)):entries;
  return selected.map(e=>({tenantId,recordId:e.recordRef.recordId,contentSha256:e.sha256}));
}

function validateManifest(m, tenantId) {
  if (!isObj(m) || Object.keys(m).some(k=>!['manifestVersion','tenantRef','createdAt','entries','sha256'].includes(k))
    || m.manifestVersion!==1 || m.tenantRef?.tenantId!==tenantId || !Array.isArray(m.entries) || m.entries.length>256) throw new AstraWorkflowError('A tenant-scoped context manifest is required.');
  for (const e of m.entries) {
    if (!ref(e.recordRef) || e.recordRef.tenantId!==tenantId || !['account','contact','offer','evidence','claim','policy','approval','skill'].includes(e.recordType)
      || typeof e.revision!=='string' || !/^[a-f0-9]{64}$/.test(e.sha256) || !['public_business','tenant_confidential','personal_data','restricted'].includes(e.sensitivity)
      || !['MINIMIZED_REMOTE','APPROVED_REMOTE','NO_MODEL_EGRESS'].includes(e.egressMode)) throw new AstraWorkflowError('Context entries must have tenant and domain identity with versioned hashes.');
  }
  const { sha256: supplied, ...body }=m;
  if (!/^[a-f0-9]{64}$/.test(supplied || '') || supplied!==hash(canonicalJson(body))) throw new AstraWorkflowError('Context manifest hash is invalid.');
  return { manifest:m, hash:supplied };
}

/** Validate the durable subset of HarnessTask v1; execution remains registry-only. */
export function normalizeHarnessTask(task, tenantId) {
  tenantId=normalizeAstraTenantId(tenantId);
  const allowed=['contractKind','schemaVersion','task','runRef','subjectRefs','purpose','taskRevision','policyRefs','inputEvidenceRefs','contextManifest','allowedReadTools','requiredOutputs','versionPins','limits','retryPolicy','progressPolicy','completionRubric','egressMode','createdAt'];
  if (!isObj(task) || task.contractKind!=='HarnessTask' || task.schemaVersion!=='1.0.0' || !isObj(task.task)
    || Object.keys(task).some(k=>!allowed.includes(k)) || Object.keys(task.task).some(k=>!['tenantRef','taskId','revision'].includes(k))
    || task.task.tenantRef?.tenantId!==tenantId || typeof task.task.taskId!=='string' || typeof task.task.revision!=='string'
    || !TYPES.has(task.purpose) || !isObj(task.taskRevision) || typeof task.taskRevision.id!=='string' || typeof task.taskRevision.version!=='string'
    || !/^[a-f0-9]{64}$/.test(task.taskRevision.sha256||'') || !Array.isArray(task.subjectRefs) || !task.subjectRefs.length
    || task.subjectRefs.some(x=>!ref(x)||x.tenantId!==tenantId) || !Array.isArray(task.policyRefs) || !task.policyRefs.length
    || task.policyRefs.some(x=>!isObj(x)||typeof x.id!=='string'||typeof x.version!=='string'||!/^[a-f0-9]{64}$/.test(x.sha256||''))
    || (task.inputEvidenceRefs!==undefined && (!Array.isArray(task.inputEvidenceRefs)||task.inputEvidenceRefs.some(x=>!ref(x)||x.tenantId!==tenantId)))
    || !Array.isArray(task.requiredOutputs) || !task.requiredOutputs.length || task.requiredOutputs.some(x=>!OUTPUTS.has(x.artifactType)||!Number.isInteger(x.minimumCount)||x.minimumCount<1)
    || !isObj(task.retryPolicy) || task.retryPolicy.externalSideEffects!=='prohibited'
    || !isObj(task.completionRubric) || !Array.isArray(task.completionRubric.checks) || !task.completionRubric.checks.length
    || !isObj(task.limits) || !Number.isInteger(task.limits.deadlineSeconds) || task.limits.deadlineSeconds<1 || task.limits.deadlineSeconds>120
    || !Number.isInteger(task.limits.maxModelCalls)||task.limits.maxModelCalls<0||task.limits.maxModelCalls>4
    || !Number.isInteger(task.limits.maxReadToolCalls)||task.limits.maxReadToolCalls<0||task.limits.maxReadToolCalls>6
    || !Number.isSafeInteger(task.limits.maxSpendMicroUsd)||task.limits.maxSpendMicroUsd<0
    || !Number.isInteger(task.limits.maxRepairAttempts)||task.limits.maxRepairAttempts<0||task.limits.maxRepairAttempts>1
    || !Number.isInteger(task.limits.maxChallengeRounds)||task.limits.maxChallengeRounds<0||task.limits.maxChallengeRounds>1
    || !Array.isArray(task.allowedReadTools) || task.allowedReadTools.some(x=>!isObj(x)||x.capability!=='read'||typeof x.name!=='string'
      || !isObj(x.argumentSchemaRef)||typeof x.argumentSchemaRef.id!=='string'||typeof x.argumentSchemaRef.version!=='string'||!/^[a-f0-9]{64}$/.test(x.argumentSchemaRef.sha256||''))) {
    throw new AstraWorkflowError('HarnessTask does not satisfy the versioned tenant contract.');
  }
  const { manifest,hash:contextHash }=validateManifest(task.contextManifest,tenantId);
  return { task, manifest, contextHash, taskType:task.purpose, taskKey:`${task.task.taskId}:${task.task.revision}` };
}

async function emit(client, actor, eventType, workflowId, state, extra={}) {
  return appendEvent(client, actor, { eventType, entity:{type:'astra_workflow',id:workflowId}, occurredAt:new Date().toISOString(),
    idempotencyKey:`workflow:${workflowId}:${eventType}:${extra.transitionId || randomUUID()}`,
    payload:{workflowId,state,...extra}, provenance:{source:'astra.workflow',confidence:'high',fieldAuthority:'system'} });
}

export async function scheduleWorkflow(client, actor, input) {
  const tenantId=normalizeAstraTenantId(actor?.tenantId), userId=normalizeAstraUserId(actor?.userId);
  if(!isObj(input)||Object.keys(input).some(k=>!['task','priority','taskClass','maxAttempts'].includes(k))) throw new AstraWorkflowError('Workflow scheduling accepts only a HarnessTask, priority, taskClass, and maxAttempts.');
  const {task,manifest,contextHash,taskType,taskKey}=normalizeHarnessTask(input.task,tenantId);
  const priority=Number.isInteger(input.priority)?Math.max(0,Math.min(100,input.priority)):50;
  const taskClass=CLASSES.has(input.taskClass)?input.taskClass:'standard';
  const maxAttempts=Number.isInteger(input.maxAttempts)?Math.max(1,Math.min(10,input.maxAttempts)):3;
  const payloadHash=sha256(canonicalJson({task,priority,taskClass,maxAttempts}));
  const id=randomUUID();
  const inserted=await client.query(`INSERT INTO astra.workflows(tenant_id,id,task_key,task_type,schema_version,task,payload_hash,context_manifest,context_hash,state,priority,task_class,actor_id,max_attempts)
    VALUES($1,$2,$3,$4,1,$5::jsonb,$6,$7::jsonb,$8,'queued',$9,$10,$11,$12)
    ON CONFLICT(tenant_id,task_key) DO NOTHING RETURNING id,state,payload_hash`,[tenantId,id,taskKey,taskType,JSON.stringify(task),payloadHash,JSON.stringify(manifest),contextHash,priority,taskClass,userId,maxAttempts]);
  if (!inserted.rowCount) {
    const prior=(await client.query('SELECT id,state,payload_hash FROM astra.workflows WHERE tenant_id=$1 AND task_key=$2',[tenantId,taskKey])).rows[0];
    if (!prior || prior.payload_hash!==payloadHash) throw new AstraWorkflowError('Task key already exists with a different payload.',409,'idempotency_conflict');
    return { id:prior.id,state:prior.state,duplicate:true };
  }
  await emit(client,actor,'workflow.scheduled',id,'queued',{taskKey,taskType,payloadHash,contextHash});
  return {id,state:'queued',duplicate:false};
}

export async function getWorkflow(client, tenantId, id) {
  const r=await client.query(`SELECT id,task_key AS "taskKey",task_type AS "taskType",schema_version AS "schemaVersion",task,payload_hash AS "payloadHash",
    context_manifest AS "contextManifest",context_hash AS "contextHash",state,priority,task_class AS "taskClass",attempt,max_attempts AS "maxAttempts",
    available_at AS "availableAt",checkpoint,result,last_error_code AS "lastErrorCode",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
    FROM astra.workflows WHERE tenant_id=$1 AND id=$2`,[normalizeAstraTenantId(tenantId),id]);
  return r.rows[0] || null;
}

function fenceResult(result, expected, actor) {
  if (!result || result.contractKind!=='HarnessResult' || result.schemaVersion!=='1.0.0' || result.status!=='completed' || result.task?.tenantRef?.tenantId!==actor.tenantId
    || result.task?.taskId!==expected.task.task.taskId || result.task?.revision!==expected.task.task.revision || !Array.isArray(result.artifacts)
    || !Array.isArray(result.claimRefs) || result.claimRefs.some(x=>!ref(x)||x.tenantId!==actor.tenantId)
    || !Array.isArray(result.unresolvedQuestions) || result.unresolvedQuestions.some(q=>!Array.isArray(q.evidenceRefs)||q.evidenceRefs.some(x=>!ref(x)||x.tenantId!==actor.tenantId))
    || !Array.isArray(result.completionChecks) || !result.completionChecks.length || result.completionChecks.some(x=>x.outcome!=='passed')) {
    throw new AstraWorkflowError('Handler result failed deterministic completion checks.',422,'completion_check_failed');
  }
  const checkIds=new Set(result.completionChecks.map(x=>x.checkId));
  if(checkIds.size!==result.completionChecks.length) throw new AstraWorkflowError('Completion checks cannot repeat.',422,'completion_check_failed');
  for(const check of expected.task.completionRubric.checks) if(!checkIds.has(check.checkId)) throw new AstraWorkflowError('A required completion check is missing.',422,'completion_check_failed');
  for (const artifact of result.artifacts) if (!ref(artifact.recordRef)||artifact.recordRef.tenantId!==actor.tenantId||!OUTPUTS.has(artifact.artifactType)||!/^[a-f0-9]{64}$/.test(artifact.sha256||'')) throw new AstraWorkflowError('Result contains an invalid or cross-tenant evidence reference.');
  for (const required of expected.task.requiredOutputs) if (result.artifacts.filter(a=>a.artifactType===required.artifactType).length<required.minimumCount) throw new AstraWorkflowError('Required output is missing.');
  return result;
}

async function validateResearchCompletion(client,tenantId,workflowId,task,result) {
  const policyEntries=(task.contextManifest?.entries||[]).filter(e=>e.recordType==='policy');
  if(!task.policyRefs.every(pin=>policyEntries.some(e=>e.recordRef?.tenantId===tenantId&&e.recordRef?.recordId===pin.id&&e.revision===pin.version&&e.sha256===pin.sha256))) return false;
  const evidenceEntries=(task.contextManifest?.entries||[]).filter(e=>e.recordType==='evidence');
  const evidenceRefs=Array.isArray(task.inputEvidenceRefs)&&task.inputEvidenceRefs.length?task.inputEvidenceRefs:evidenceEntries.map(e=>e.recordRef);
  if(!evidenceRefs.length||evidenceRefs.length>6||evidenceRefs.some(ref=>ref?.tenantId!==tenantId||!evidenceEntries.some(e=>e.recordRef?.recordId===ref.recordId))) return false;
  const reportIds=new Set();
  for(const artifact of result.artifacts) {
    if(!['research_report','evidence_summary'].includes(artifact.artifactType)) return false;
    const r=await client.query(`SELECT report,report_sha256 FROM astra.research_reports WHERE tenant_id=$1 AND id=$2 AND workflow_id=$3`,[tenantId,artifact.recordRef.recordId,workflowId]);
    const saved=r.rows[0];
    if(!saved||saved.report_sha256!==artifact.sha256||sha256(canonicalJson(saved.report))!==saved.report_sha256||saved.report?.tenantId!==tenantId||saved.report?.workflowId!==workflowId) return false;
    reportIds.add(artifact.recordRef.recordId);
    const items=saved.report?.evidence;
    if(!Array.isArray(items)||!items.length||items.length>6) return false;
    for(const item of items) {
      const expected=evidenceRefs.find(ref=>ref.recordId===item.evidenceId);
      if(!expected) return false;
      const evidence=await client.query(`SELECT e.content_sha256,s.rights_policy,s.rights_expires_at,s.robots_allowed,s.rights_attested
        FROM astra.research_evidence e JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
        WHERE e.tenant_id=$1 AND e.id=$2`,[tenantId,item.evidenceId]);
      const current=evidence.rows[0];
      if(!current||current.content_sha256!==item.contentSha256||!current.robots_allowed||!current.rights_attested
        ||!['synthetic_fixture','user_provided','licensed','public_terms_permitted'].includes(current.rights_policy)
        ||(current.rights_expires_at&&new Date(current.rights_expires_at).getTime()<=Date.now())) return false;
    }
  }
  return reportIds.size>0;
}

export async function claimWorkflow(client, actor, {workerId,leaseSeconds=60,taskClasses=['interactive','suppression','standard','bulk']}={}) {
  workerId=String(workerId||'').trim(); if(!workerId||workerId.length>120) throw new AstraWorkflowError('workerId is required.');
  const seconds=Math.max(10,Math.min(300,Number(leaseSeconds)||60));
  const r=await client.query(`WITH chosen AS (SELECT tenant_id,id FROM astra.workflows WHERE tenant_id=$1 AND task_class=ANY($2::text[])
    AND ((state IN ('queued','checkpointed') AND available_at<=now()) OR (state='running' AND lease_until<now()))
    ORDER BY priority+LEAST(100,extract(epoch FROM (now()-created_at))/60) DESC,
      CASE task_class WHEN 'suppression' THEN 0 WHEN 'interactive' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END,available_at,created_at
    FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE astra.workflows w SET state='running',attempt=w.attempt+1,lease_owner=$3,lease_token=gen_random_uuid(),lease_until=now()+($4::int*interval '1 second'),updated_at=now()
    FROM chosen c WHERE (w.tenant_id,w.id)=(c.tenant_id,c.id) RETURNING w.*`,[actor.tenantId,taskClasses,workerId,seconds]);
  if(!r.rowCount)return null;
  const row=r.rows[0];
  await client.query(`UPDATE astra.workflow_attempts SET state='fenced',completed_at=now()
    WHERE tenant_id=$1 AND workflow_id=$2 AND state IN ('running','checkpointed')`,[actor.tenantId,row.id]);
  await client.query(`INSERT INTO astra.workflow_attempts(tenant_id,workflow_id,attempt,lease_token_sha256,runtime_version,migration_compatibility,
      context_hash,policy_refs,evidence_refs,usage_refs,state)
    VALUES($1,$2,$3,$4,'astra-runtime/1.0.0',9,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,'running')`,
  [actor.tenantId,row.id,row.attempt,sha256(row.lease_token),row.context_hash,JSON.stringify(row.task.policyRefs||[]),JSON.stringify(pinnedEvidenceRefs(row.task,actor.tenantId))]);
  await emit(client,actor,'workflow.claimed',row.id,'running',{attempt:row.attempt,workerId,transitionId:row.lease_token});
  await recordAstraTelemetry(client,actor,{kind:'task.started',taskId:row.id,payload:{state:'running'}});
  return {id:row.id,task:row.task,attempt:row.attempt,leaseToken:row.lease_token,leaseUntil:row.lease_until,checkpoint:row.checkpoint,contextHash:row.context_hash};
}

async function lockedLease(client,actor,id,token) {
  const r=await client.query(`SELECT * FROM astra.workflows WHERE tenant_id=$1 AND id=$2 AND state='running' AND lease_token=$3 AND lease_until>now() FOR UPDATE`,[actor.tenantId,id,token]);
  if(!r.rowCount)throw new AstraWorkflowError('Workflow lease is stale or expired.',409,'lease_fenced'); return r.rows[0];
}
export async function heartbeatWorkflow(client,actor,{id,leaseToken,leaseSeconds=60}) {
  await lockedLease(client,actor,id,leaseToken); const sec=Math.max(10,Math.min(300,Number(leaseSeconds)||60));
  const r=await client.query(`UPDATE astra.workflows SET lease_until=now()+($4::int*interval '1 second'),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 RETURNING lease_until`,[actor.tenantId,id,leaseToken,sec]); return {leaseUntil:r.rows[0].lease_until};
}
async function persistedCheckpointReplay(client,actor,id,checkpoint,leaseToken,release) {
  if(checkpoint.checkpointVersion!=='astra-runtime-checkpoint/1.0.0') return null;
  const attempt=Number(checkpoint.attemptRef?.attempt), tokenHash=checkpoint.attemptRef?.leaseTokenSha256;
  if(!Number.isSafeInteger(attempt)||attempt<1||typeof tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(tokenHash)
    ||tokenHash!==sha256(leaseToken)) throw new AstraWorkflowError('Checkpoint does not match the supplied attempt fence.',409,'lease_fenced');
  const checkpointHash=sha256(canonicalJson(checkpoint));
  const transitionId=`${attempt}:${checkpointHash}`;
  const prior=await client.query(`SELECT payload FROM astra.events WHERE tenant_id=$1 AND entity_type='astra_workflow'
    AND entity_id=$2 AND event_type='workflow.checkpointed' AND idempotency_key=$3`,
  [actor.tenantId,id,`workflow:${id}:workflow.checkpointed:${transitionId}`]);
  if(!prior.rowCount) return null;
  const payload=prior.rows[0].payload;
  if(payload?.workflowId!==id||payload?.checkpointHash!==checkpointHash||Number(payload?.attempt)!==attempt
    ||payload?.leaseRetained!==!release||payload?.state!==(release?'checkpointed':'running')) {
    throw new AstraWorkflowError('Checkpoint replay conflicts with its persisted lease behavior.',409,'checkpoint_conflict');
  }
  return {id,state:payload.state,updated:false,duplicate:true};
}
export async function checkpointWorkflow(client,actor,{id,leaseToken,checkpoint,releaseLease=true}) {
  if(!isObj(checkpoint))throw new AstraWorkflowError('checkpoint must be an object.');
  const release=releaseLease!==false;
  if(checkpoint.checkpointVersion && checkpoint.checkpointVersion!=='astra-runtime-checkpoint/1.0.0') throw new AstraWorkflowError('Checkpoint version is unsupported.');
  const replay=await persistedCheckpointReplay(client,actor,id,checkpoint,leaseToken,release);
  if(replay) return replay;
  const row=await lockedLease(client,actor,id,leaseToken);
  if(checkpoint.checkpointVersion==='astra-runtime-checkpoint/1.0.0') {
    const attempt=Number(checkpoint.attemptRef?.attempt), tokenHash=checkpoint.attemptRef?.leaseTokenSha256;
    if(attempt!==Number(row.attempt)||tokenHash!==sha256(leaseToken)) throw new AstraWorkflowError('Checkpoint does not match the active attempt fence.',409,'lease_fenced');
    if(!Array.isArray(checkpoint.policyRefs)||!Array.isArray(checkpoint.evidenceRefs)||!Array.isArray(checkpoint.usageRefs)
      ||checkpoint.usageRefs.length!==0||canonicalJson(checkpoint.policyRefs)!==canonicalJson(row.task.policyRefs||[])
      ||canonicalJson(checkpoint.evidenceRefs)!==canonicalJson(pinnedEvidenceRefs(row.task,actor.tenantId))) throw new AstraWorkflowError('Checkpoint references do not match the pinned task and current offline usage policy.');
  }
  const nextState=release?'checkpointed':'running';
  const r=await client.query(`UPDATE astra.workflows SET checkpoint=$4::jsonb,state=$5,
    lease_owner=CASE WHEN $6 THEN NULL ELSE lease_owner END,lease_token=CASE WHEN $6 THEN NULL ELSE lease_token END,
    lease_until=CASE WHEN $6 THEN NULL ELSE lease_until END,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,
  [actor.tenantId,id,leaseToken,JSON.stringify(checkpoint),nextState,release]);
  if(!r.rowCount) throw new AstraWorkflowError('Workflow lease is stale or expired.',409,'lease_fenced');
  const attempt=Number(row.attempt), checkpointHash=sha256(canonicalJson(checkpoint));
  if(checkpoint.checkpointVersion==='astra-runtime-checkpoint/1.0.0') {
    const p=checkpoint.progress||{};
    const updated=await client.query(`UPDATE astra.workflow_attempts SET checkpoint_version=$4,checkpoint=$5::jsonb,
      canonical_progress_hash=$6,novelty_hash=$7,state=$9,checkpointed_at=now()
      WHERE tenant_id=$1 AND workflow_id=$2 AND attempt=$3 AND lease_token_sha256=$8 AND state IN ('running','checkpointed')`,
    [actor.tenantId,id,attempt,checkpoint.checkpointVersion,JSON.stringify(checkpoint),p.canonicalHash,p.noveltyHash,sha256(leaseToken),release?'checkpointed':'running']);
    if(!updated.rowCount) throw new AstraWorkflowError('Checkpoint attempt reference is stale.',409,'lease_fenced');
  }
  const transitionId=`${attempt}:${checkpointHash}`;
  await emit(client,actor,'workflow.checkpointed',row.id,nextState,{checkpointHash,attempt,leaseRetained:!release,transitionId});
  return {id,state:nextState,updated:true,duplicate:false};
}
export async function completeWorkflow(client,actor,{id,leaseToken,result}) {
  const row=await lockedLease(client,actor,id,leaseToken); const normalized=normalizeHarnessTask(row.task,actor.tenantId); const valid=fenceResult(result,normalized,actor);
  if(row.task.purpose==='research' && !await validateResearchCompletion(client,actor.tenantId,id,row.task,valid)) throw new AstraWorkflowError('Research completion lacks current rights-backed evidence and a valid report artifact.',422,'completion_check_failed');
  const r=await client.query(`UPDATE astra.workflows SET state='completed',result=$4::jsonb,lease_owner=NULL,lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,[actor.tenantId,id,leaseToken,JSON.stringify(valid)]);
  await client.query(`UPDATE astra.workflow_attempts SET state='completed',completed_at=now() WHERE tenant_id=$1 AND workflow_id=$2 AND attempt=$3 AND lease_token_sha256=$4 AND state IN ('running','checkpointed')`,[actor.tenantId,id,row.attempt,sha256(leaseToken)]);
  await emit(client,actor,'workflow.completed',id,'completed',{resultHash:sha256(canonicalJson(valid)),transitionId:leaseToken});
  await recordAstraTelemetry(client,actor,{kind:'task.completed',taskId:id,payload:{state:'completed'}}); return {id,state:'completed',updated:r.rowCount===1};
}
export async function failWorkflow(client,actor,{id,leaseToken,errorCode='handler_failed',retryable=true,externalOutcomeUnknown=false,baseDelaySeconds=15}) {
  const row=await lockedLease(client,actor,id,leaseToken); const retry=retryable&&!externalOutcomeUnknown&&row.attempt<row.max_attempts;
  const delay=Math.min(3600,Math.max(1,Number(baseDelaySeconds)||15)*2**Math.min(8,row.attempt-1));
  const state=retry?'queued':'manual_review';
  await client.query(`UPDATE astra.workflows SET state=$4,available_at=CASE WHEN $4='queued' THEN now()+($5::int*interval '1 second') ELSE available_at END,
    last_error_code=$6,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,[actor.tenantId,id,leaseToken,state,delay,String(errorCode).slice(0,120)]);
  await client.query(`UPDATE astra.workflow_attempts SET state=$5,completed_at=now() WHERE tenant_id=$1 AND workflow_id=$2 AND attempt=$3 AND lease_token_sha256=$4 AND state IN ('running','checkpointed')`,[actor.tenantId,id,row.attempt,sha256(leaseToken),state==='queued'?'fenced':'manual_review']);
  await emit(client,actor,'workflow.failed',id,state,{errorCode:String(errorCode).slice(0,80),attempt:row.attempt,retryable:retry,transitionId:leaseToken});
  await recordAstraTelemetry(client,actor,{kind:'task.failed',taskId:id,payload:{state,errorCode:String(errorCode).slice(0,80)}}); return {id,state,retryAfterSeconds:retry?delay:null};
}
export async function cancelWorkflow(client,actor,id) {
  const r=await client.query(`UPDATE astra.workflows SET state='cancelled',lease_owner=NULL,lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now()
    WHERE tenant_id=$1 AND id=$2 AND state IN ('queued','checkpointed','running') RETURNING id`,[actor.tenantId,id]);
  if(!r.rowCount) {
    const prior=await client.query('SELECT id,state FROM astra.workflows WHERE tenant_id=$1 AND id=$2',[actor.tenantId,id]);
    if(prior.rows[0]?.state==='cancelled') return {id:prior.rows[0].id,state:'cancelled',duplicate:true};
    throw new AstraWorkflowError('Workflow cannot be cancelled in its current state.',409,'workflow_not_cancellable');
  }
  await client.query(`UPDATE astra.workflow_attempts SET state='cancelled',completed_at=now() WHERE tenant_id=$1 AND workflow_id=$2 AND state IN ('running','checkpointed')`,[actor.tenantId,id]);
  await emit(client,actor,'workflow.cancelled',id,'cancelled'); return {id,state:'cancelled',duplicate:false};
}