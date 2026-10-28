import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptCredential, decryptCredential, hasActiveCredentialKey } from './credential-vault.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { canonicalJson } from './astra-ledger.js';

const fail = (message, status=400, code='connector_invalid') => { throw new AstraTenantContextError(message,status,code); };
const providers = new Set(['reacher','smtp_imap','twenty']);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clean = (v,name,max=250) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\u0000-\u001f\u007f]/.test(v)) fail(`${name} is invalid.`);
  return v.trim();
};
const object = (v,name) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${name} must be an object.`);
  return v;
};
function normalizePublicConfig(provider,value) {
  const config=object(value,'publicConfig');
  const exact=(item,allowed,name)=>{
    object(item,name);if(Object.keys(item).some(key=>!allowed.includes(key)))fail(`${name} contains an unsupported field.`);return item;
  };
  const validHost=(host,name)=>{const value=clean(host,name,253).toLowerCase();if(/[/:@\s]/.test(value)||value.includes('..'))fail(`${name} must be a hostname only.`);return value;};
  const validHttps=(input,name)=>{let url;try{url=new URL(clean(input,name,1000));}catch{fail(`${name} must be a valid HTTPS URL.`);}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail(`${name} must be an HTTPS URL without credentials or query data.`);return url.toString();};
  if(provider==='reacher') {
    exact(config,['apiUrl'],'publicConfig');return {apiUrl:validHttps(config.apiUrl,'apiUrl')};
  }
  if(provider==='twenty') {
    exact(config,['baseUrl'],'publicConfig');return {baseUrl:validHttps(config.baseUrl,'baseUrl')};
  }
  exact(config,['smtp','imap'],'publicConfig');
  const normalizeMailbox=(value,name)=>{
    if(value===undefined)return {enabled:false};
    const item=exact(value,['enabled','host','port','secure'],name);
    if(typeof item.enabled!=='boolean')fail(`${name}.enabled must be a boolean.`);
    if(!item.enabled)return {enabled:false};
    const result={enabled:true,host:validHost(item.host,`${name}.host`)};
    if(item.port!==undefined){const n=Number(item.port);if(!Number.isInteger(n)||n<1||n>65535)fail(`${name}.port is invalid.`);result.port=n;}
    if(item.secure!==undefined){if(typeof item.secure!=='boolean')fail(`${name}.secure must be a boolean.`);result.secure=item.secure;}
    return result;
  };
  return {smtp:normalizeMailbox(config.smtp,'smtp'),imap:normalizeMailbox(config.imap,'imap')};
}
const privileged = actor => {
  if (!['owner','admin'].includes(actor?.tenantRole)) fail('Connector configuration requires tenant owner or admin.',403,'connector_admin_required');
};

export function connectorTransportEnabled(provider, environment='provider_observed') {
  if(!providers.has(provider)||['1','true'].includes(process.env.LOCAL_PREVIEW||'')
    ||['1','true'].includes(process.env.ASTRA_LOCAL_PREVIEW||''))return false;
  if(environment==='synthetic')return process.env.NODE_ENV==='test';
  if(environment!=='provider_observed'||process.env.ASTRA_EXTERNAL_ACTIONS_ENABLED!=='true'||process.env.ASTRA_LOCAL_PREVIEW!=='false'
    ||process.env.NODE_ENV==='test')return false;
  try {
    const registry=JSON.parse(readFileSync(path.join(ROOT,'docs/astra/commercial-gates.json'),'utf8'));
    // S01 is blocked in this checkout. Transport remains unavailable until
    // exact provider commercial, source-rights and privacy decisions are approved.
    if(registry.schemaVersion!==1||registry.status!=='APPROVED'||!Array.isArray(registry.decisions))return false;
    {
      const required=[`${provider}.commercial-use`,`${provider}.source-rights`,`${provider}.privacy-processing`];
      if(!required.every(id=>registry.decisions.some(d=>d.id===id&&d.status==='approved'&&d.enabled===true
        &&d.approvalEvidence&&/^[a-f\d]{64}$/i.test(d.approvalEvidence.documentSha256||'')
        &&Date.parse(d.approvalEvidence.expiresAt)>Date.now())))return false;
    }
    return true;
  }catch{return false;}
}

export function connectorApprovalReady(connector, provider) {
  const value=connector?.approval;
  if(!value||value.schemaVersion!==1||!Array.isArray(value.decisionReferences)||!Array.isArray(value.documents))return false;
  if(!value.attestedBy||!Number.isFinite(Date.parse(value.attestedAt)))return false;
  if(!value.documents.every(doc=>typeof doc.path==='string'&&doc.path.length<=500&&/^[a-f\d]{64}$/i.test(doc.sha256||'')
    &&Number.isFinite(Date.parse(doc.expiresAt))&&Date.parse(doc.expiresAt)>Date.now()))return false;
  try {
    const registry=JSON.parse(readFileSync(path.join(ROOT,'docs/astra/commercial-gates.json'),'utf8'));
    const required=[`${provider}.commercial-use`,`${provider}.source-rights`,`${provider}.privacy-processing`];
    return required.every(id=>{
      if(!value.decisionReferences.includes(id))return false;
      const decision=registry.decisions?.find(item=>item.id===id);
      return decision?.status==='approved'&&decision.enabled===true
        &&value.documents.some(doc=>doc.sha256.toLowerCase()===String(decision.approvalEvidence?.documentSha256||'').toLowerCase());
    });
  }catch{return false;}
}

/** Store tenant credentials only as authenticated ciphertext; public responses never include them. */
export async function configureAstraConnector(client, actor, input) {
  privileged(actor);
  const provider = input?.provider;
  if (!providers.has(provider)) fail('Connector provider is unsupported.');
  const connectorKey = clean(input.connectorKey,'connectorKey',120);
  const credentials = object(input.credentials,'credentials');
  const publicConfig = normalizePublicConfig(provider,input.publicConfig || {});
  const submittedApproval = input.approval == null ? {} : object(input.approval,'approval');
  const decisionReferences = submittedApproval.decisionReferences ?? [];
  const approvalDocuments = submittedApproval.documents ?? [];
  if(!Array.isArray(decisionReferences)||decisionReferences.length>12
    ||!Array.isArray(approvalDocuments)||approvalDocuments.length>12
    ||((decisionReferences.length || approvalDocuments.length) && (decisionReferences.length<3 || approvalDocuments.length<1))) {
    fail('Supply either no approval evidence for a blocked draft, or at least three decision references and one approval document.');
  }
  const approval={schemaVersion:1,decisionReferences:decisionReferences.map(v=>clean(v,'decisionReference',120)),
    documents:approvalDocuments.map(doc=>{
      object(doc,'approval document');const docPath=clean(doc.path,'approval document path',500);const sha256=clean(doc.sha256,'approval document hash',64).toLowerCase();
      if(!/^[a-f0-9]{64}$/.test(sha256))fail('Approval document hash must be SHA-256.');
      const expiresAt=new Date(doc.expiresAt);if(Number.isNaN(expiresAt.valueOf())||expiresAt<=new Date())fail('Approval document expiry must be in the future.');
      return {path:docPath,sha256,expiresAt:expiresAt.toISOString()};
    }),...(decisionReferences.length ? {attestedBy:String(actor.userId),attestedAt:new Date().toISOString()} : {})};
  if (!hasActiveCredentialKey()) fail('Configure ODD_CREDENTIAL_ENCRYPTION_KEY before saving connector credentials.',503,'connector_encryption_key_required');
  const secretJson = JSON.stringify(credentials);
  if (Buffer.byteLength(secretJson) > 12000) fail('Connector credentials are too large.');
  const ciphertext = encryptCredential(secretJson);
  const fingerprint = createHash('sha256').update(secretJson).digest('hex');
  const endpointHost = input.endpointHost == null ? null : clean(input.endpointHost,'endpointHost',253).toLowerCase();
  if (endpointHost && (/[/:@\s]/.test(endpointHost) || endpointHost.includes('..'))) fail('endpointHost must be a hostname only.');
  const saved = await client.query(`INSERT INTO astra.connector_configs(tenant_id,provider,connector_key,endpoint_host,public_config,credentials_ciphertext,credential_fingerprint,approval,created_by)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9)
    ON CONFLICT (tenant_id,provider,connector_key) DO UPDATE SET endpoint_host=EXCLUDED.endpoint_host,public_config=EXCLUDED.public_config,
      credentials_ciphertext=EXCLUDED.credentials_ciphertext,credential_fingerprint=EXCLUDED.credential_fingerprint,approval=EXCLUDED.approval,state='configured',updated_at=now()
    RETURNING id,provider,connector_key,endpoint_host,public_config,credential_fingerprint,approval,state,created_at,updated_at`,
  [actor.tenantId,provider,connectorKey,endpointHost,JSON.stringify(publicConfig),ciphertext,fingerprint,JSON.stringify(approval),String(actor.userId)]);
  const approvalReady = connectorApprovalReady(saved.rows[0], provider);
  return {...saved.rows[0],transportApprovalReady:connectorTransportEnabled(provider)&&approvalReady,
    approvalBlocker:approvalReady?null:'Missing or unapproved provider commercial-use, source-rights, or privacy-processing evidence; transport remains blocked.'};
}

export async function listAstraConnectors(client, tenantId) {
  const result = await client.query(`SELECT c.id,c.provider,c.connector_key,c.endpoint_host,c.public_config,c.credential_fingerprint,c.approval,c.state,c.created_at,c.updated_at,
      e.capability,e.outcome,e.source,e.provenance,e.expires_at AS evidence_expires_at
    FROM astra.connector_configs c LEFT JOIN LATERAL (SELECT capability,outcome,source,provenance,expires_at FROM astra.connector_evidence
      WHERE tenant_id=c.tenant_id AND connector_id=c.id ORDER BY created_at DESC LIMIT 50) e ON true
    WHERE c.tenant_id=$1 ORDER BY c.created_at DESC`,[tenantId]);
  return result.rows.map(row => {
    const approvalReady = connectorApprovalReady(row, row.provider);
    return {...row, transportApprovalReady:connectorTransportEnabled(row.provider)&&approvalReady,
      approvalBlocker:approvalReady?null:'Missing or unapproved provider commercial-use, source-rights, or privacy-processing evidence; transport remains blocked.'};
  });
}

export async function loadAstraConnectorCredentials(client, actor, connectorId, provider = null) {
  const result = await client.query(`SELECT id,provider,endpoint_host,public_config,credentials_ciphertext,approval,state FROM astra.connector_configs
    WHERE tenant_id=$1 AND id=$2::uuid AND ($3::text IS NULL OR provider=$3) AND state='configured'`,[actor.tenantId,connectorId,provider]);
  if (!result.rowCount) fail('Connector was not found.',404,'connector_not_found');
  let credentials;
  try { credentials = JSON.parse(decryptCredential(result.rows[0].credentials_ciphertext)); }
  catch { fail('Connector credentials could not be decrypted.',503,'connector_credentials_unavailable'); }
  return { ...result.rows[0], credentials };
}

export async function recordAstraConnectorEvidence(client, actor, connectorId, evidence) {
  if(!['owner','admin','operator','worker'].includes(actor?.tenantRole))fail('Connector capability evidence requires tenant operator access.',403,'connector_operator_required');
  const capability = clean(evidence?.capability,'capability',80);
  const outcome = evidence?.outcome;
  const source = evidence?.source;
  if (!['supported','unsupported','unknown','denied'].includes(outcome) || !['provider_probe','operator_approval','provider_receipt','manual_ingest'].includes(source)) fail('Capability evidence is invalid.');
  const expiresAt = new Date(evidence.expiresAt || Date.now()+24*60*60*1000);
  if (Number.isNaN(expiresAt.valueOf()) || expiresAt <= new Date()) fail('Capability evidence expiry must be in the future.');
  const provenance = object(evidence.provenance,'provenance');
  if (!provenance.source || !provenance.evidenceRef) fail('Capability evidence provenance requires source and evidenceRef.');
  const environment=evidence.environment;
  if(!['provider_observed','synthetic','operator_attested'].includes(environment))fail('Capability evidence environment is required.');
  if(source==='provider_probe'&&environment==='operator_attested')fail('Provider probe evidence must come from an observed or synthetic adapter execution.');
  const mailboxId=evidence.mailboxId||null;
  if(['smtp.submit','imap.read'].includes(capability)&&outcome==='supported'&&!mailboxId)fail('Mailbox capability evidence must bind to a specific tenant mailbox.');
  const result = await client.query(`INSERT INTO astra.connector_evidence(tenant_id,connector_id,mailbox_id,capability,outcome,source,environment,provenance,expires_at,created_by)
    SELECT $1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9::timestamptz,$10 WHERE EXISTS(SELECT 1 FROM astra.connector_configs WHERE tenant_id=$1 AND id=$2::uuid)
    RETURNING id,connector_id,mailbox_id,capability,outcome,source,environment,provenance,expires_at,created_at`,
  [actor.tenantId,connectorId,mailboxId,capability,outcome,source,environment,JSON.stringify(provenance),expiresAt.toISOString(),String(actor.userId)]);
  if (!result.rowCount) fail('Connector was not found.',404,'connector_not_found');
  return result.rows[0];
}

export async function bindAstraMailboxConnector(client,actor,{connectorId,mailboxId,providerMailboxId}) {
  privileged(actor);
  const providerId=clean(providerMailboxId,'providerMailboxId',500);
  const connector=await client.query(`SELECT id,provider,state FROM astra.connector_configs WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,connectorId]);
  if(!connector.rowCount||connector.rows[0].provider!=='smtp_imap'||connector.rows[0].state!=='configured')fail('SMTP/IMAP connector was not found.',404,'connector_not_found');
  const mailbox=await client.query(`SELECT id FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,mailboxId]);
  if(!mailbox.rowCount)fail('Mailbox was not found.',404,'mailbox_not_found');
  try {
    await client.query(`INSERT INTO astra.mailbox_connectors(tenant_id,mailbox_id,connector_id,provider_mailbox_id,created_by)
      VALUES ($1,$2::uuid,$3::uuid,$4,$5) ON CONFLICT (tenant_id,mailbox_id) DO NOTHING`,
    [actor.tenantId,mailboxId,connectorId,providerId,String(actor.userId)]);
    const existing=await client.query(`SELECT connector_id,provider_mailbox_id FROM astra.mailbox_connectors WHERE tenant_id=$1 AND mailbox_id=$2::uuid`,[actor.tenantId,mailboxId]);
    if(existing.rows[0]?.connector_id!==connectorId||existing.rows[0]?.provider_mailbox_id!==providerId)fail('Mailbox is already bound to a different provider identity.',409,'mailbox_connector_conflict');
    await client.query(`UPDATE astra.mailboxes SET provider='smtp_imap',provider_mailbox_id=$3,configuration_status='unknown',capability_evidence='{}'::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,mailboxId,providerId]);
  }catch(error){if(error?.code==='23505')fail('Provider mailbox identity is already linked.',409,'mailbox_connector_conflict');throw error;}
  return {mailboxId,connectorId,providerMailboxId:providerId,capabilities:{receive:'unknown',send:'unknown'}};
}

export function parseReacherResponse(response, expectedEmail, now = Date.now()) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.input !== expectedEmail) return { classification:'unknown',providerStatus:'malformed_response' };
  const allowedReachability = new Set(['safe','risky','invalid','unknown']);
  if (!allowedReachability.has(response.is_reachable) || !response.syntax || typeof response.syntax.is_valid_syntax !== 'boolean'
    || !response.mx || typeof response.mx.accepts_mail !== 'boolean' || !response.smtp || typeof response.smtp.is_deliverable !== 'boolean' || typeof response.smtp.is_catch_all !== 'boolean') {
    return { classification:'unknown',providerStatus:'malformed_response' };
  }
  // Reacher's positive result is accepted only for its explicit safe + deliverable + non-catchall response.
  const expiry = response.checked_at == null ? null : Date.parse(response.checked_at);
  if (expiry !== null && (!Number.isFinite(expiry) || now - expiry > 24*60*60*1000 || expiry > now+5*60*1000)) return { classification:'stale',providerStatus:'stale_response' };
  if (response.smtp.is_catch_all || response.risky === true) return { classification:'catch_all',providerStatus:'catch_all' };
  if (response.is_reachable === 'invalid' || response.syntax.is_valid_syntax === false || response.mx.accepts_mail === false || response.smtp.is_deliverable === false) return { classification:'invalid',providerStatus:'invalid' };
  if (response.is_reachable === 'safe' && response.smtp.is_deliverable === true && response.smtp.is_catch_all === false) return { classification:'verified',providerStatus:'safe_deliverable' };
  return { classification:'unknown',providerStatus:'inconclusive' };
}

export function credentialDigest(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

/** Bind concrete per-job adapters to the worker's transaction boundary. `prepare`
 * executes inside the claim transaction and must only read DB state; `execute`
 * runs after commit; `commit` persists the result in a fresh worker transaction. */
export function makeAstraConnectorJobAdapters(adapters={}) {
  const normalized={};
  for(const type of ['probe_mailbox','sync_mailbox','verify_candidate']) {
    const adapter=adapters[type];
    if(!adapter||typeof adapter.prepare!=='function'||typeof adapter.execute!=='function'||typeof adapter.commit!=='function')
      fail(`A complete ${type} worker adapter is required.`,503,'connector_worker_adapter_missing');
    normalized[type]=adapter;
  }
  const select=job=>{const adapter=normalized[job?.jobType];if(!adapter)fail('Connector job type is unsupported.',409,'connector_job_type_unsupported');return adapter;};
  return Object.freeze({
    prepareProvider: context=>select(context.job).prepare(context),
    executeProvider: context=>select(context.job).execute(context),
    commitResult: context=>select(context.job).commit(context),
  });
}

function connectorJobResult(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||canonicalJson(value).length>8000)fail('Connector worker result is invalid.');
  const unsafe=/secret|password|token|credential|bodytext|email|authorization/i;
  const inspect=(item,depth=0)=>{
    if(depth>5)fail('Connector worker result exceeds the supported depth.');
    if(item===null||typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item)))return;
    if(typeof item==='string'){if(item.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item))fail('Connector worker result contains unsupported text.');return;}
    if(Array.isArray(item)){if(item.length>100)fail('Connector worker result is too large.');for(const child of item)inspect(child,depth+1);return;}
    if(!item||typeof item!=='object'||Object.keys(item).length>40)fail('Connector worker result is invalid.');
    for(const [key,child] of Object.entries(item)){if(unsafe.test(key))fail('Connector worker result contains a private field.');inspect(child,depth+1);}
  };
  inspect(value);return JSON.stringify(value);
}

/**
 * Claim a durable connector job, perform provider I/O after the claim transaction
 * commits, then persist the outcome in a new worker-scoped transaction. The
 * injected callbacks are server-owned adapters, never request fields.
 */
export async function runAstraConnectorJob({withWorkerTenant,tenantId,userId,jobId,prepareProvider,executeProvider,commitResult,preview=false}={}) {
  if(typeof withWorkerTenant!=='function')fail('A worker-scoped tenant store is required.',503,'connector_worker_store_required');
  const claim=await withWorkerTenant({tenantId,userId},async(client,actor)=>{
    const found=await client.query(`SELECT j.id,j.connector_id,j.mailbox_id,j.candidate_id,j.job_type,j.payload,j.state,
        c.provider,c.endpoint_host,c.public_config,c.credentials_ciphertext,c.approval
      FROM astra.connector_jobs j JOIN astra.connector_configs c ON c.tenant_id=j.tenant_id AND c.id=j.connector_id
      WHERE j.tenant_id=$1 AND j.id=$2::uuid FOR UPDATE OF j`,[actor.tenantId,jobId]);
    if(!found.rowCount)return {missing:true};
    const row=found.rows[0];if(row.state!=='queued')return {state:row.state,id:row.id};
    const allowed=!preview&&!['1','true'].includes(process.env.LOCAL_PREVIEW||'')&&connectorTransportEnabled(row.provider)&&connectorApprovalReady(row,row.provider);
    if(!allowed) {
      await client.query(`UPDATE astra.connector_jobs SET state='blocked',diagnostic_code=$3,result='{"blocked":true}'::jsonb,updated_at=now(),completed_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,row.id,'external_actions_disabled']);
      return {blocked:true,id:row.id};
    }
    if(typeof executeProvider!=='function'||typeof commitResult!=='function') {
      await client.query(`UPDATE astra.connector_jobs SET state='blocked',diagnostic_code='connector_worker_unavailable',result='{"blocked":true}'::jsonb,updated_at=now(),completed_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,row.id]);
      return {blocked:true,id:row.id};
    }
    await client.query(`UPDATE astra.connector_jobs SET state='attempting',updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,row.id]);
    let credentials;try{credentials=JSON.parse(decryptCredential(row.credentials_ciphertext));}catch{
      await client.query(`UPDATE astra.connector_jobs SET state='blocked',diagnostic_code='connector_credentials_unavailable',result='{"blocked":true}'::jsonb,updated_at=now(),completed_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,row.id]);
      return {blocked:true,id:row.id};
    }
    const job={id:row.id,tenantId:actor.tenantId,connectorId:row.connector_id,mailboxId:row.mailbox_id,candidateId:row.candidate_id,jobType:row.job_type,payload:row.payload,provider:row.provider};
    const connector={endpointHost:row.endpoint_host,publicConfig:row.public_config,credentials,approval:row.approval};
    const workerActor={tenantId:actor.tenantId,userId:String(actor.userId),tenantRole:actor.tenantRole};
    // This callback is restricted to DB reads while the claim transaction is open.
    // It must return bounded JSON only; provider I/O belongs in executeProvider.
    let prepared=null;
    if(prepareProvider) prepared=await prepareProvider({client,actor:workerActor,job,connector});
    if(prepared!==null&&(!prepared||typeof prepared!=='object'||Array.isArray(prepared)||canonicalJson(prepared).length>12000))
      fail('Prepared connector job data is invalid.',503,'connector_job_prepare_invalid');
    return {job,connector,actor:workerActor,prepared};
  });
  if(claim.missing)return {state:'not_found'};
  if(claim.blocked)return {state:'blocked',jobId:claim.id,reason:'external_actions_disabled'};
  if(!claim.job)return {state:claim.state,jobId:claim.id};
  let outcome;
  try { outcome=await executeProvider({job:claim.job,connector:claim.connector,actor:claim.actor,prepared:claim.prepared}); }
  catch { outcome={state:'uncertain',diagnosticCode:'provider_outcome_unknown'}; }
  let serialized='{}';
  if(outcome?.state==='succeeded') {
    try {
      serialized=connectorJobResult(outcome.publicResult||outcome.result||{});
      await withWorkerTenant({tenantId,userId},async(client,actor)=>commitResult({client,actor,job:claim.job,connector:claim.connector,result:outcome.result||{}}));
    } catch { outcome={state:'uncertain',diagnosticCode:'provider_result_persistence_failed'};serialized='{}'; }
  }
  const terminal=outcome?.state==='succeeded'?'completed':outcome?.state==='failed'?'failed':outcome?.state==='blocked'?'blocked':'uncertain';
  const diagnostic=/^[a-z0-9_]{1,120}$/.test(outcome?.diagnosticCode||'')?outcome.diagnosticCode:null;
  await withWorkerTenant({tenantId,userId},async(client,actor)=>client.query(`UPDATE astra.connector_jobs SET state=$3,result=$4::jsonb,diagnostic_code=$5,updated_at=now(),completed_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid AND state='attempting'`,[actor.tenantId,claim.job.id,terminal,serialized,diagnostic]));
  return {state:terminal,jobId:claim.job.id,diagnosticCode:diagnostic};
}
