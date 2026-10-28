import { randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { appendEvent, canonicalJson, sha256 } from './astra-ledger.js';
import { resolveAstraLearningPrediction } from './astra-learning.js';

const fail=(message,status=400,code='decision_invalid')=>{throw new AstraTenantContextError(message,status,code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,n,max=500)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))fail(`${n} is required and must be bounded printable text.`);return v.trim();};
const uuid=(v,n)=>{if(typeof v!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))fail(`${n} must be a UUID.`);return v.toLowerCase();};
const array=(v,n,max=100)=>{if(!Array.isArray(v)||v.length>max)fail(`${n} must be a bounded array.`);return v;};
const iso=(v,n,required=false)=>{if(v==null&&!required)return null;const d=new Date(v);if(!Number.isFinite(d.valueOf()))fail(`${n} must be a date.`);return d.toISOString();};
const hash=v=>sha256(canonicalJson(v));

/** Convert old ACT/BLOCK records explicitly; never reinterpret a confidence field as probability. */
export function migrateAstraLegacyDecision(input) {
  if(!object(input))fail('Legacy decision must be an object.');
  const action=String(input.action||input.decision||'').toUpperCase();
  if(!['ACT','BLOCK'].includes(action))fail('Legacy decision must explicitly be ACT or BLOCK.');
  return {schemaVersion:2,action:action==='ACT'?'ACT':'ABSTAIN',policyStatus:action==='BLOCK'?'denied':'unknown',
    policyReasons:action==='BLOCK'?['legacy_block']:[],support:[],uncertainty:null,prediction:null,utility:null,risk:null,
    reversibility:action==='ACT'?'unknown':'reversible',basis:'legacy',legacyAction:action};
}

function normalize(input,actor,trustedPolicyStatus) {
  if(!object(input)||Object.keys(input).some(k=>!['action','target','horizon','conditioning','sourceRefs','support','uncertainty','prediction','learningArtifactId','entityRef','utility','risk','reversibility','policyReasons','basis','legacyAction','decisionId','idempotencyKey'].includes(k)))fail('Decision contains unsupported fields; policy status is server-evaluated.');
  if(input.prediction!=null)fail('Caller-supplied probabilities and calibration metadata are prohibited.',400,'caller_prediction_prohibited');
  if(input.legacyAction!=null){const migrated=migrateAstraLegacyDecision({action:input.legacyAction});const conditioning=input.conditioning??{};if(!object(conditioning))fail('conditioning must be an object.');return {...migrated,target:input.target==null?null:text(input.target,'target',500),horizon:input.horizon==null?null:text(input.horizon,'horizon',120),conditioning,sourceRefs:array(input.sourceRefs??[],'sourceRefs').map(x=>text(x,'sourceRef',500)),idempotencyKey:text(input.idempotencyKey,'idempotencyKey',200),createdBy:String(actor.userId)};}
  const action=text(input.action,'action',40).toUpperCase();
  if(!['ACT','ABSTAIN','REVIEW','RESEARCH_MORE','WAIT'].includes(action))fail('action is unsupported.');
  const policyStatus=trustedPolicyStatus??'unknown';if(!['allowed','denied','unknown'].includes(policyStatus))fail('policyStatus is unsupported.');
  const support=array(input.support??[],'support').map(x=>{if(!object(x)||Object.keys(x).some(k=>!['status','sourceRef','observedAt','expiresAt','locator'].includes(k))||!['supported','contradicted','unknown','stale'].includes(x.status))fail('Each support item needs a bounded status and sourceRef.');return {status:x.status,sourceRef:text(x.sourceRef,'support.sourceRef',500),observedAt:iso(x.observedAt,'support.observedAt'),expiresAt:iso(x.expiresAt,'support.expiresAt'),locator:x.locator==null?null:text(x.locator,'support.locator',500)};});
  const uncertainty=input.uncertainty==null?null:input.uncertainty;
  if(uncertainty!==null&&(!object(uncertainty)||Object.keys(uncertainty).some(k=>!['method','version','sampleCount','signals'].includes(k))||typeof uncertainty.method!=='string'||typeof uncertainty.version!=='string'||(uncertainty.sampleCount!=null&&(!Number.isInteger(uncertainty.sampleCount)||uncertainty.sampleCount<0||uncertainty.sampleCount>1000000))||(uncertainty.signals!=null&&!Array.isArray(uncertainty.signals))))fail('uncertainty needs a versioned method and bounded optional sample count, or must be null.');
  // There is no approved S27 calibration registry linked in this slice. Do not
  // accept caller-asserted calibration metadata or convert model confidence.
  if(input.prediction!=null)fail('Caller-supplied probabilities and calibration metadata are prohibited.',400,'caller_prediction_prohibited');
  const prediction=null;
  const utility=input.utility==null?null:input.utility;if(utility!==null&&(!object(utility)||typeof utility.currency!=='string'||!Number.isFinite(utility.expectedValue)||typeof utility.basis!=='string'))fail('utility needs currency, expectedValue and basis.');
  const risk=input.risk==null?null:input.risk;if(risk!==null&&(!object(risk)||Object.keys(risk).some(k=>!['level','vetoes','impact'].includes(k))||!['low','medium','high','unknown'].includes(risk.level)||!Array.isArray(risk.vetoes)||risk.vetoes.length>30||risk.vetoes.some(x=>typeof x!=='string'||x.length>120)))fail('risk needs a level and bounded veto list.');
  const reversibility=input.reversibility??'unknown';if(!['reversible','partially_reversible','irreversible','unknown'].includes(reversibility))fail('reversibility is unsupported.');
  const policyReasons=array(input.policyReasons??[],'policyReasons',30).map(x=>text(x,'policy reason',120));
  if(policyStatus==='denied'&&action==='ACT')fail('Denied policy cannot authorize ACT.',409,'policy_denied');
  return {schemaVersion:2,action,target:input.target==null?null:text(input.target,'target',500),horizon:input.horizon==null?null:text(input.horizon,'horizon',120),
    conditioning:object(input.conditioning??{})?input.conditioning??{}:fail('conditioning must be an object.'),sourceRefs:array(input.sourceRefs??[],'sourceRefs').map(x=>text(x,'sourceRef',500)),
    learningArtifactId:input.learningArtifactId==null?null:uuid(input.learningArtifactId,'learningArtifactId'),entityRef:input.entityRef==null?null:uuid(input.entityRef,'entityRef'),
    support,uncertainty,prediction,utility,risk,reversibility,policyStatus,policyReasons,basis:input.basis==null?'rules':text(input.basis,'basis',80),legacyAction:null,
    idempotencyKey:text(input.idempotencyKey,'idempotencyKey',200),createdBy:String(actor.userId)};
}

export async function recordAstraDecision(client,actor,input,{policyStatus='unknown'}={}) {
  const d=normalize(input,actor,policyStatus);
  if(d.learningArtifactId){const computed=d.entityRef?await resolveAstraLearningPrediction(client,actor.tenantId,{artifactId:d.learningArtifactId,entityRef:d.entityRef}):null;d.prediction=computed??null;}
  if(Buffer.byteLength(canonicalJson(d),'utf8')>48000)fail('Decision record is too large.');const id=randomUUID();const decisionHash=hash(d);
  const prior=await client.query('SELECT id,decision_hash,record FROM astra.decisions WHERE tenant_id=$1 AND idempotency_key=$2',[actor.tenantId,d.idempotencyKey]);
  if(prior.rowCount){if(prior.rows[0].decision_hash!==decisionHash)fail('Idempotency key is already bound to a different decision.',409,'decision_idempotency_conflict');return {...prior.rows[0].record,id:prior.rows[0].id,duplicate:true};}
  const record={...d,id,decisionHash,createdAt:new Date().toISOString()};
  await client.query(`INSERT INTO astra.decisions(tenant_id,id,idempotency_key,action,policy_status,target,horizon,conditioning,source_refs,support,uncertainty,prediction,utility,risk,reversibility,basis,legacy_action,decision_hash,record,created_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19::jsonb,$20)`,
   [actor.tenantId,id,d.idempotencyKey,d.action,d.policyStatus,d.target,d.horizon,JSON.stringify(d.conditioning),JSON.stringify(d.sourceRefs),JSON.stringify(d.support),JSON.stringify(d.uncertainty),JSON.stringify(d.prediction),JSON.stringify(d.utility),JSON.stringify(d.risk),d.reversibility,d.basis,d.legacyAction,decisionHash,JSON.stringify(record),String(actor.userId)]);
  await appendEvent(client,actor,{eventType:'workflow.completed',entity:{type:'astra_decision',id},occurredAt:record.createdAt,idempotencyKey:`decision:${id}`,payload:{action:d.action,policyStatus:d.policyStatus,decisionHash},provenance:{source:'astra.decisions',confidence:'high',fieldAuthority:'system'}});
  return {...record,duplicate:false};
}

export async function getAstraDecision(client,tenantId,decisionId){const r=await client.query('SELECT record FROM astra.decisions WHERE tenant_id=$1 AND id=$2::uuid',[tenantId,decisionId]);return r.rows[0]?.record??null;}

export async function listAstraDecisions(client,tenantId,{limit=100}={}){const n=Number.isInteger(limit)?Math.max(1,Math.min(limit,200)):100;const r=await client.query('SELECT record FROM astra.decisions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2',[tenantId,n]);return r.rows.map(x=>x.record);}
