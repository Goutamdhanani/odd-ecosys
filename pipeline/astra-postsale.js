import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { evaluateAstraPermission } from './astra-permissions.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { getAstraCustomerApprovalStatus } from './astra-customer-approvals.js';

const fail=(m,s=400,c='postsale_invalid')=>{throw new AstraTenantContextError(m,s,c);};
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>{if(typeof x!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))fail('A valid UUID is required.');return x.toLowerCase();};
const text=(x,n,max=500)=>{if(typeof x!=='string'||!x.trim()||x.trim().length>max)fail(`${n} is required and bounded.`);return x.trim();};
const hash=x=>sha256(canonicalJson(x));

/** A post-sale project exists only for a research account with canonical, unreversed won and paid facts. */
export async function createAstraPostSaleProject(db,actor,{accountId,name}={}){
  const account=uuid(accountId);name=text(name,'name',160);
  const events=await db.query(`SELECT event_id AS id,event_type,stage,source FROM astra.canonical_outcome_events($1::uuid)
    WHERE source='twenty' AND entity_type='account' AND entity_id=$2 AND (stage IN ('opportunity_won','opportunity.won')
      OR (stage IN ('revenue_paid','revenue.paid') AND positive_net_revenue)) ORDER BY recorded_at DESC,event_id DESC`,[actor.tenantId,account]);
  const won=events.rows.find(e=>['opportunity_won','opportunity.won'].includes(e.stage)),paid=events.rows.find(e=>['revenue_paid','revenue.paid'].includes(e.stage));
  if(!won||!paid)fail('Post-sale projects require canonical won and paid outcome events for this account.',409,'postsale_outcome_required');
  const id=randomUUID();await db.query(`INSERT INTO astra.post_sale_projects(tenant_id,id,account_id,won_event_id,paid_event_id,name,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7)`,[actor.tenantId,id,account,won.id,paid.id,name,String(actor.userId)]);
  return {id,accountId:account,name,outcomeEvidence:{wonEventId:won.id,paidEventId:paid.id},status:'active'};
}

export async function listAstraPostSaleProjects(db,tenantId){
  const q=await db.query(`SELECT p.id,p.account_id AS "accountId",p.name,p.status,p.created_at AS "createdAt",p.won_event_id AS "wonEventId",p.paid_event_id AS "paidEventId",
    (SELECT count(*)::int FROM astra.post_sale_milestones m WHERE m.tenant_id=p.tenant_id AND m.project_id=p.id) AS "milestoneCount",
    (SELECT count(*)::int FROM astra.post_sale_evidence e WHERE e.tenant_id=p.tenant_id AND e.project_id=p.id AND e.consent_revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>now())) AS "currentEvidenceCount"
    FROM astra.post_sale_projects p WHERE p.tenant_id=$1::uuid ORDER BY p.created_at DESC LIMIT 100`,[tenantId]);return {items:q.rows,releaseReady:false};
}

export async function authorizeAstraDeliveryMilestone(db,actor,{projectId,key,title,authorizationRef,dueAt=null}={}){
  const project=uuid(projectId),milestoneKey=text(key,'key',80),label=text(title,'title',160),ref=text(authorizationRef,'authorizationRef',500);
  const due=dueAt==null?null:new Date(dueAt);if(due&&Number.isNaN(due.valueOf()))fail('dueAt must be a valid date.');
  const id=randomUUID();await db.query(`INSERT INTO astra.post_sale_milestones(tenant_id,id,project_id,milestone_key,title,authorized_by,authorization_ref,due_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,[actor.tenantId,id,project,milestoneKey,label,String(actor.userId),ref,due?.toISOString()||null]);
  return {id,projectId:project,key:milestoneKey,title:label,state:'authorized',authorizationRef:ref};
}

/** Persist a minimized, rights-scoped evidence snapshot. Consent revocation/expiry excludes it from future comparisons. */
export async function captureAstraPostSaleEvidence(db,actor,{projectId,milestoneId=null,kind,sourceRef,sourceRights,snapshot,capturedAt=new Date().toISOString(),expiresAt=null}={}){
  const project=uuid(projectId),milestone=milestoneId===null?null:uuid(milestoneId);
  if(!['delivery','analytics','baseline','observed','outcome'].includes(kind))fail('Unsupported post-sale evidence kind.');
  const ref=text(sourceRef,'sourceRef',1000);if(!obj(sourceRights)||!['authorized','licensed','customer_provided','public_terms_permitted'].includes(sourceRights.basis)||typeof sourceRights.reference!=='string'||!sourceRights.reference.trim())fail('Evidence requires a concrete source-rights basis and reference.');
  if(!obj(snapshot)||Buffer.byteLength(canonicalJson(snapshot),'utf8')>32768)fail('Evidence snapshot must be a bounded object.');
  const at=new Date(capturedAt),expires=expiresAt===null?null:new Date(expiresAt);if(Number.isNaN(at.valueOf())||(expires&&Number.isNaN(expires.valueOf())))fail('Evidence timestamps must be valid dates.');
  const rights={...sourceRights};
  const normalized={snapshot,capturedAt:at.toISOString(),expiresAt:expires?.toISOString()||null,sourceRights:rights};const id=randomUUID();
  await db.query(`INSERT INTO astra.post_sale_evidence(tenant_id,id,project_id,milestone_id,kind,source_ref,source_rights,snapshot,snapshot_sha256,captured_at,expires_at,created_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,[actor.tenantId,id,project,milestone,kind,ref,JSON.stringify(rights),JSON.stringify(snapshot),hash(normalized),at.toISOString(),expires?.toISOString()||null,String(actor.userId)]);
  return {id,projectId:project,kind,capturedAt:at.toISOString(),expiresAt:expires?.toISOString()||null,comparison:'observational',causalLift:null};
}

export async function revokeAstraPostSaleEvidenceConsent(db,actor,evidenceId){
  const id=uuid(evidenceId);const r=await db.query(`UPDATE astra.post_sale_evidence SET consent_revoked_at=clock_timestamp() WHERE tenant_id=$1::uuid AND id=$2::uuid AND consent_revoked_at IS NULL RETURNING id,consent_revoked_at`,[actor.tenantId,id]);
  if(!r.rowCount){const exists=await db.query('SELECT id FROM astra.post_sale_evidence WHERE tenant_id=$1::uuid AND id=$2::uuid',[actor.tenantId,id]);if(!exists.rowCount)fail('Evidence not found.',404,'postsale_evidence_not_found');}
  return {id,revoked:Boolean(r.rowCount),consentRevokedAt:r.rows[0]?.consent_revoked_at||null};
}

export async function compareAstraPostSaleEvidence(db,tenantId,projectId){
  const project=uuid(projectId);const q=await db.query(`SELECT id,kind,snapshot,captured_at AS "capturedAt",expires_at AS "expiresAt",source_ref AS "sourceRef",snapshot_sha256 AS "snapshotHash"
    FROM astra.post_sale_evidence WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND consent_revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY captured_at,id`,[tenantId,project]);
  const baseline=q.rows.filter(x=>x.kind==='baseline'),observed=q.rows.filter(x=>x.kind==='observed'||x.kind==='analytics');
  return {projectId:project,baseline,observed,comparison:{method:'descriptive_before_after',causalLift:null,causalClaimPermitted:false,limitations:['No randomized comparison is recorded.','Observed changes are descriptive and may reflect other causes.']},releaseReady:false};
}

/** Draft a versioned case study with operator attestation only; customer approval remains pending until independently authenticated evidence exists. */
export async function prepareAstraCaseStudy(db,actor,{projectId,content,evidenceIds}={}){
  const project=uuid(projectId);if(!obj(content)||Buffer.byteLength(canonicalJson(content),'utf8')>16000||!Array.isArray(evidenceIds)||evidenceIds.length<1||evidenceIds.length>30)fail('Case-study content and cited evidence must be bounded.');
  if(Object.keys(content).some(k=>['approved','customerApproved','causalLift','causalClaim'].includes(k)))fail('Approval and causal claim fields are not accepted from callers.');
  const ids=[...new Set(evidenceIds.map(uuid))];if(ids.length!==evidenceIds.length)fail('Evidence IDs must be unique.');
  const found=await db.query(`SELECT id FROM astra.post_sale_evidence WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND id=ANY($3::uuid[]) AND consent_revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,[actor.tenantId,project,ids]);if(found.rowCount!==ids.length)fail('Every cited evidence item must be current and project-scoped.',409,'postsale_evidence_unavailable');
  const prior=await db.query('SELECT COALESCE(max(version),0)::int version FROM astra.post_sale_case_studies WHERE tenant_id=$1::uuid AND project_id=$2::uuid',[actor.tenantId,project]);const version=Number(prior.rows[0].version)+1,id=randomUUID(),contentHash=hash(content);
  await db.query(`INSERT INTO astra.post_sale_case_studies(tenant_id,id,project_id,version,content,content_sha256,evidence_ids,operator_attested_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7::uuid[],$8)`,[actor.tenantId,id,project,version,JSON.stringify(content),contentHash,ids,String(actor.userId)]);
  const customerApproval=await getAstraCustomerApprovalStatus(db,actor.tenantId,id);
  return {id,projectId:project,version,contentHash,evidenceIds:ids,operatorAttestedBy:String(actor.userId),customerApproval,publishable:false,releaseReady:false};
}

/** Renewal signals are recommendations only and require a fresh purpose-specific permission evaluation. */
export async function recordAstraRenewalSignal(db,actor,{projectId,signal,evidenceIds=[]}={}){
  const project=uuid(projectId);if(!['renewal','expansion'].includes(signal)||!Array.isArray(evidenceIds)||evidenceIds.length<1||evidenceIds.length>30)fail('Signal and evidence references are required.');
  const ids=[...new Set(evidenceIds.map(uuid))];if(ids.length!==evidenceIds.length)fail('Evidence IDs must be unique.');
  const p=await db.query(`SELECT account_id FROM astra.post_sale_projects WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,project]);if(!p.rowCount)fail('Post-sale project not found.',404,'postsale_project_not_found');
  const evidence=await db.query(`SELECT id FROM astra.post_sale_evidence WHERE tenant_id=$1::uuid AND project_id=$2::uuid AND id=ANY($3::uuid[]) AND consent_revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,[actor.tenantId,project,ids]);if(evidence.rowCount!==ids.length)fail('Signal evidence must be current and project-scoped.',409,'postsale_evidence_unavailable');
  const permission=await evaluateAstraPermission(db,actor,{account:p.rows[0].account_id,purpose:'post_sale_renewal'});if(!permission.allowed)fail('A current post-sale renewal permission is required; no outreach was initiated.',409,'postsale_permission_required');
  const id=randomUUID();await db.query(`INSERT INTO astra.post_sale_renewal_signals(tenant_id,id,project_id,signal,evidence_ids,permission_evaluation,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid[],$6::jsonb,$7)`,[actor.tenantId,id,project,signal,ids,JSON.stringify({...permission,evaluatedAt:new Date().toISOString()}),String(actor.userId)]);
  return {id,signal,state:'observed',permissionEvaluated:true,outreach:false,crmMutation:false};
}
