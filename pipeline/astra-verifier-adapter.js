import { createHash } from 'node:crypto';
import { parseReacherResponse, loadAstraConnectorCredentials, recordAstraConnectorEvidence, connectorTransportEnabled, connectorApprovalReady } from './astra-connectors.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { validateUrl } from './ssrf-guard.js';
import { canonicalJson } from './astra-ledger.js';
import https from 'node:https';
import net from 'node:net';
import { readCurrentAstraCampaignAudience } from './astra-campaign-audience.js';

const fail=(message,status=400,code='verification_adapter_invalid')=>{throw new AstraTenantContextError(message,status,code);};
const hash=value=>createHash('sha256').update(value).digest('hex');

export async function currentAstraVerificationCampaignMemberships(client,tenantId,candidateId,addressSha256) {
  const campaigns=await client.query(`SELECT id FROM astra.campaigns WHERE tenant_id=$1
    AND audience_snapshot @> $2::jsonb`,[tenantId,JSON.stringify([{candidateId}])]);
  const memberships=[];
  for (const campaign of campaigns.rows) {
    const audience=await readCurrentAstraCampaignAudience(client,tenantId,campaign.id);
    const member=audience?.rows.find(row=>row.candidate_id===candidateId&&row.current);
    if (member && hash(String(member.normalized_value).toLowerCase())===addressSha256) memberships.push(campaign.id);
  }
  return memberships;
}

function postPinnedJson(urlText, address, headers, payload) {
  const url=new URL(urlText);const family=net.isIP(address);
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:url.hostname,servername:url.hostname,port:url.port||443,path:`${url.pathname}${url.search}`,method:'POST',headers:{...headers,'content-type':'application/json','content-length':Buffer.byteLength(payload)},rejectUnauthorized:true,agent:false,lookup:(_host,options,cb)=>options?.all?cb(null,[{address,family}]):cb(null,address,family)},res=>{
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy(new Error('response too large'));else chunks.push(chunk);});
      res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error('provider rejected request'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('malformed provider response'));}});
    });req.setTimeout(10000,()=>req.destroy(new Error('timeout')));req.once('error',reject);req.end(payload);
  });
}
export async function callAstraReacher({endpointUrl,credentials,email}) {
  const url=new URL('/v1/check_email',endpointUrl);const safe=await validateUrl(url.href);if(!safe.safe||!safe.resolvedIp)throw new Error('destination denied');
  return postPinnedJson(url.href,safe.resolvedIp,credentials.apiSecret?{'x-reacher-secret':credentials.apiSecret}:{},JSON.stringify({to_email:email}));
}

// These three functions are the connector_jobs adapter contract. Only execute
// performs I/O; prepare and commit are called inside separate worker DB txns.
export async function prepareAstraReacherJob({client,actor,job,connector}) {
  if(job?.jobType!=='verify_candidate'||!job.candidateId)fail('Reacher job identity is invalid.');
  const found=await client.query(`SELECT id,evidence_id,normalized_value FROM astra.research_identity_candidates WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,job.candidateId]);
  if(!found.rowCount)fail('Candidate was not found.',404,'candidate_not_found');
  const email=String(found.rows[0].normalized_value).trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Candidate address is invalid.',409,'candidate_address_invalid');
  const url=new URL(connector.publicConfig?.apiUrl);const destination=await validateUrl(url.href);
  if(url.protocol!=='https:'||!destination.safe||!destination.resolvedIp)fail('Reacher provider destination is blocked.',403,'reacher_destination_denied');
  return {candidateId:found.rows[0].id,evidenceId:found.rows[0].evidence_id,email,endpointUrl:url.href,addressSha256:hash(email)};
}

export async function executeAstraReacherJob({job,connector,prepared,providerCall=callAstraReacher,now=Date.now,environment='provider_observed'}) {
  if(job?.jobType!=='verify_candidate'||typeof providerCall!=='function')return {state:'failed',diagnosticCode:'reacher_job_invalid'};
  try {
    const raw=await providerCall({endpointUrl:prepared.endpointUrl,endpointHost:connector.endpointHost,publicConfig:connector.publicConfig,credentials:connector.credentials,email:prepared.email,redirect:'error'});
    let parsed=parseReacherResponse(raw,prepared.email,now());
    if(environment==='synthetic'&&parsed.classification==='verified')parsed={classification:'unknown',providerStatus:'synthetic_fixture_not_trusted'};
    const expiresAt=new Date(now()+(parsed.classification==='verified'?86400000:7200000)).toISOString();
    const receiptSha256=hash(canonicalJson({provider:'reacher',candidateId:prepared.candidateId,emailSha256:prepared.addressSha256,classification:parsed.classification,providerStatus:parsed.providerStatus,response:raw}));
    return {state:'succeeded',result:{candidateId:prepared.candidateId,evidenceId:prepared.evidenceId,classification:parsed.classification,providerStatus:parsed.providerStatus,addressSha256:prepared.addressSha256,receiptSha256,expiresAt,environment}};
  } catch{return {state:'uncertain',diagnosticCode:'reacher_provider_outcome_unknown'};}
}

export async function commitAstraReacherJob({client,actor,job,connector,result}) {
  if(job?.jobType!=='verify_candidate'||result?.candidateId!==job.candidateId||result.environment!=='provider_observed'&&result.environment!=='synthetic')fail('Reacher result binding is invalid.',409,'verification_receipt_conflict');
  const inserted=await client.query(`INSERT INTO astra.verification_adapter_receipts(tenant_id,candidate_id,connector_id,provider,address_sha256,receipt_sha256,classification,environment,provider_status,expires_at,created_by)
    VALUES ($1,$2::uuid,$3::uuid,'reacher',$4,$5,$6,$7,$8,$9::timestamptz,$10) ON CONFLICT (tenant_id,provider,receipt_sha256) DO NOTHING RETURNING id`,
  [actor.tenantId,result.candidateId,job.connectorId,result.addressSha256,result.receiptSha256,result.classification,result.environment,result.providerStatus,result.expiresAt,String(actor.userId)]);
  let receiptId=inserted.rows[0]?.id;
  if(!receiptId){const old=await client.query(`SELECT id,candidate_id,address_sha256,classification,environment FROM astra.verification_adapter_receipts WHERE tenant_id=$1 AND provider='reacher' AND receipt_sha256=$2`,[actor.tenantId,result.receiptSha256]);
    if(!old.rowCount||old.rows[0].candidate_id!==result.candidateId||old.rows[0].address_sha256!==result.addressSha256||old.rows[0].classification!==result.classification||old.rows[0].environment!==result.environment)fail('Provider receipt conflicts with an earlier record.',409,'verification_receipt_conflict');receiptId=old.rows[0].id;}
  await recordAstraConnectorEvidence(client,actor,job.connectorId,{capability:'email.verification',outcome:result.classification==='verified'?'supported':result.classification==='invalid'?'unsupported':'unknown',source:'provider_receipt',environment:result.environment,provenance:{source:'reacher',evidenceRef:receiptId,receiptSha256:result.receiptSha256},expiresAt:result.expiresAt});
  if(result.classification==='verified'&&result.environment==='provider_observed'){
    const memberships=await currentAstraVerificationCampaignMemberships(client,actor.tenantId,result.candidateId,result.addressSha256);
    for(const campaignId of memberships)await client.query(`INSERT INTO astra.campaign_verification_records(tenant_id,campaign_id,candidate_id,evidence_id,source,classification,expires_at,note,created_by,adapter_receipt_id,address_sha256)
      VALUES ($1,$2::uuid,$3::uuid,$4::uuid,'reacher','verified',$5::timestamptz,'Approved Reacher receipt bound to this candidate address.',$6,$7::uuid,$8) ON CONFLICT DO NOTHING`,
    [actor.tenantId,campaignId,result.candidateId,result.evidenceId,result.expiresAt,String(actor.userId),receiptId,result.addressSha256]);
  }
  return {receiptId,classification:result.classification,environment:result.environment,trusted:result.environment==='provider_observed'&&result.classification==='verified'};
}

/** Adapter accepts a deliberately injected provider call; no implicit network client is created. */
export async function verifyAstraCandidateWithReacher(client, actor, candidateId, { providerCall=callAstraReacher, now = Date.now(), preview = false, environment = 'synthetic' } = {}) {
  if (preview || ['1','true'].includes(process.env.LOCAL_PREVIEW||'') || ['1','true'].includes(process.env.ASTRA_LOCAL_PREVIEW||'')) fail('Provider verification is unavailable in local preview.',409,'local_preview_external_action_denied');
  if (!connectorTransportEnabled('reacher',environment)) fail('External provider actions are disabled.',409,'external_actions_disabled');
  if (typeof providerCall !== 'function') fail('An approved Reacher transport adapter is required.',503,'verification_transport_unavailable');
  const candidateResult = await client.query(`SELECT id,evidence_id,normalized_value FROM astra.research_identity_candidates WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,candidateId]);
  const candidate = candidateResult.rows[0];
  if (!candidate) fail('Candidate was not found.',404,'candidate_not_found');
  const email = String(candidate.normalized_value).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Candidate address is invalid.',409,'candidate_address_invalid');
  const connectors = await client.query(`SELECT id FROM astra.connector_configs WHERE tenant_id=$1 AND provider='reacher' AND state='configured' ORDER BY updated_at DESC`,[actor.tenantId]);
  if (connectors.rowCount !== 1) fail('Exactly one configured Reacher connector is required.',409,'reacher_connector_ambiguous');
  const connector = await loadAstraConnectorCredentials(client,actor,connectors.rows[0].id,'reacher');
  if(!['provider_observed','synthetic'].includes(environment))fail('Verification adapter environment is invalid.');
  if(environment==='provider_observed'&&!connectorApprovalReady(connector,'reacher'))fail('Provider commercial, source-rights, and privacy approvals are not established.',403,'connector_approval_required');
  const endpoint=connector.public_config?.apiUrl;
  let endpointUrl;try{endpointUrl=new URL(endpoint);}catch{fail('Reacher connector URL is invalid.',400,'reacher_endpoint_invalid');}
  if(endpointUrl.protocol!=='https:')fail('Reacher provider requires HTTPS.',403,'reacher_tls_required');
  const destination=await validateUrl(endpointUrl.href);
  if(!destination.safe)fail('Reacher provider destination is blocked.',403,'reacher_destination_denied');
  let raw;
  try { raw=await providerCall({ endpointUrl:endpointUrl.href, endpointHost:connector.endpoint_host, publicConfig:connector.public_config, credentials:connector.credentials, email, redirect:'error' }); }
  catch { fail('Reacher provider request failed.',502,'verification_provider_failed'); }
  const providerResult=parseReacherResponse(raw,email,now);
  const parsed=environment==='synthetic'&&providerResult.classification==='verified'
    ?{classification:'unknown',providerStatus:'synthetic_fixture_not_trusted'}:providerResult;
  const addressSha=hash(email);
  const expiresAt=new Date(now + (parsed.classification==='verified' ? 24*60*60*1000 : 2*60*60*1000));
  const receiptSha=hash(canonicalJson({provider:'reacher',candidateId,emailSha256:addressSha,classification:parsed.classification,providerStatus:parsed.providerStatus,response:raw}));
  const receipt=await client.query(`INSERT INTO astra.verification_adapter_receipts(tenant_id,candidate_id,connector_id,provider,address_sha256,receipt_sha256,classification,environment,provider_status,expires_at,created_by)
    VALUES ($1,$2::uuid,$3::uuid,'reacher',$4,$5,$6,$7,$8,$9::timestamptz,$10)
    ON CONFLICT (tenant_id,provider,receipt_sha256) DO NOTHING RETURNING id`,
  [actor.tenantId,candidate.id,connector.id,addressSha,receiptSha,parsed.classification,environment,parsed.providerStatus,expiresAt.toISOString(),String(actor.userId)]);
  let receiptId=receipt.rows[0]?.id;
  if (!receiptId) {
    const old=await client.query(`SELECT id,candidate_id,address_sha256,classification FROM astra.verification_adapter_receipts WHERE tenant_id=$1 AND provider='reacher' AND receipt_sha256=$2`,[actor.tenantId,receiptSha]);
    if (!old.rowCount || old.rows[0].candidate_id!==candidate.id || old.rows[0].address_sha256!==addressSha || old.rows[0].classification!==parsed.classification) fail('Provider receipt conflicts with an earlier record.',409,'verification_receipt_conflict');
    receiptId=old.rows[0].id;
  }
  await recordAstraConnectorEvidence(client,actor,connector.id,{ capability:'email.verification',outcome:parsed.classification==='verified'?'supported':parsed.classification==='invalid'?'unsupported':'unknown',source:'provider_receipt',environment,provenance:{source:'reacher',evidenceRef:receiptId,receiptSha256:receiptSha},expiresAt:expiresAt.toISOString() });
  if (parsed.classification==='verified') {
    const memberships=await currentAstraVerificationCampaignMemberships(client,actor.tenantId,candidate.id,addressSha);
    for (const campaignId of memberships) {
      await client.query(`INSERT INTO astra.campaign_verification_records(tenant_id,campaign_id,candidate_id,evidence_id,source,classification,expires_at,note,created_by,adapter_receipt_id,address_sha256)
        VALUES ($1,$2::uuid,$3::uuid,$4::uuid,'reacher','verified',$5::timestamptz,'Approved Reacher adapter receipt; exact address and response are bound by immutable receipt.',$6,$7::uuid,$8)
        ON CONFLICT DO NOTHING`,[actor.tenantId,campaignId,candidate.id,candidate.evidence_id,expiresAt.toISOString(),String(actor.userId),receiptId,addressSha]);
    }
  }
  return { candidateId:candidate.id,classification:parsed.classification,providerStatus:parsed.providerStatus,receiptId,receiptSha256:receiptSha,addressSha256:addressSha,expiresAt:expiresAt.toISOString(),environment,trusted:environment==='provider_observed'&&parsed.classification==='verified' };
}
