import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { evaluateAstraPermission } from './astra-permissions.js';
import { getAstraCampaign } from './astra-campaigns.js';
import { getAstraDecision } from './astra-decisions.js';
import { validateOfferVersionForUse } from './offer-contracts.js';
import { assertOfferTenantOwnership, evaluateOfferPolicy } from './offer-policy.js';
import { findCurrentAstraCampaignAudienceMember, readCurrentAstraCampaignAudience } from './astra-campaign-audience.js';
import { resolveCurrentResearchClaims } from './astra-current-claims.js';
import { validatePersistedAstraCopy } from './astra-copy-validation.js';

const fail=(m,s=400,c='autonomy_invalid')=>{throw new AstraTenantContextError(m,s,c);};
const isObj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const isObject=isObj;
const own=(a)=>['owner','admin'].includes(a?.tenantRole);
const clean=(v,n,max=500)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))fail(`${n} is required and must be bounded printable text.`);return v.trim();};
const uuid=(v,n)=>{if(typeof v!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))fail(`${n} must be a UUID.`);return v.toLowerCase();};
const hash=o=>sha256(canonicalJson(o));
const iso=(v,n)=>{const d=new Date(v);if(!Number.isFinite(d.valueOf()))fail(`${n} must be a date.`);return d.toISOString();};
const keys=(v,allowed,n)=>{if(!isObj(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail(`${n} contains unsupported fields.`);};

/** Resolve the separate geography intent to its exact currently effective proof. */
export async function resolveCurrentAstraGeographyProof(client,{tenantId,claimId,domain,country,allowedCountries}) {
  const normalizedCountry=String(country||'').trim().toUpperCase();
  if (!tenantId || !Array.isArray(allowedCountries) || !allowedCountries.includes(normalizedCountry)
    || typeof domain!=='string' || !domain.trim()) return null;
  const [claim]=await resolveCurrentResearchClaims(client,{tenantId,claimIds:[uuid(claimId,'geographyClaimId')]});
  return claim?.valid && claim.predicate==='geography.country'
    && claim.subjectKey===domain.trim().toLowerCase()
    && String(claim.value).trim().toUpperCase()===normalizedCountry
    ? claim : null;
}

/** Require persisted source-attributed template proof and current full-copy validation. */
export async function hasCurrentAstraCopyProof(client,{tenantId,campaign,claimsMap}) {
  const candidate=campaign||{claims_map:claimsMap};
  return (await validatePersistedAstraCopy(client,{tenantId,campaign:candidate})).eligible===true;
}

function normalizeEnvelope(input,actor,campaign){
  const allowed=['mode','audience','offer','modelPolicy','mailboxId','sequence','copyConstraints','geography','purpose','schedule','budget','capacity','expiresAt','versionPins'];keys(input,allowed,'Authorization envelope');
  const mode=input.mode;if(!['draft','routine_auto','exception_review'].includes(mode))fail('mode must be draft, routine_auto or exception_review.');
  if(input.mailboxId!==campaign.mailbox_id)fail('Envelope mailbox must match the campaign snapshot.');
  const audience=input.audience;if(!isObj(audience)||!['all_qualified','account_ids'].includes(audience.kind)||(audience.kind==='account_ids'&&(!Array.isArray(audience.accountIds)||audience.accountIds.length>500)))fail('audience scope is invalid.');
  const pins=input.versionPins;if(!isObj(pins)||['decision','policy','model','copy','sequence'].some(k=>typeof pins[k]!=='string'||!pins[k].trim()))fail('versionPins must bind decision, policy, model, copy and sequence versions.');
  const env={schemaVersion:1,tenantId:actor.tenantId,campaignId:campaign.id,campaignVersion:Number(campaign.version),mode,
    audience:{kind:audience.kind,accountIds:audience.kind==='account_ids'?[...new Set(audience.accountIds.map(x=>uuid(x,'audience.accountId')))].sort():[]},
    offer:{versionId:Number(campaign.offer_version_id),contentHash:campaign.offer_content_hash},modelPolicy:clean(input.modelPolicy,'modelPolicy',160),mailboxId:campaign.mailbox_id,
    sequence:input.sequence,copyConstraints:input.copyConstraints,geography:[...new Set((Array.isArray(input.geography)?input.geography:[]).map(x=>clean(x,'geography',2)))].sort(),
    purpose:clean(input.purpose,'purpose',120),schedule:input.schedule,budget:input.budget,capacity:input.capacity,expiresAt:iso(input.expiresAt,'expiresAt'),versionPins:pins};
  if(env.purpose!==campaign.purpose||env.offer.versionId!==Number(campaign.offer_version_id)||env.offer.contentHash!==campaign.offer_content_hash)fail('Envelope purpose and offer must match the campaign snapshot.');
  if(env.geography.length<1||env.geography.some(x=>! /^[A-Z]{2}$/.test(x)||!(campaign.geography||[]).includes(x)))fail('Envelope geography exceeds campaign scope.');
  if(!isObj(env.sequence)||!Number.isInteger(env.sequence.maxMessages)||env.sequence.maxMessages<1||env.sequence.maxMessages>20||!Number.isInteger(env.sequence.cooldownHours)||env.sequence.cooldownHours<0||env.sequence.cooldownHours>8760)fail('Sequence scope needs bounded maxMessages and cooldownHours.');
  if(!isObj(env.copyConstraints)||!Array.isArray(env.copyConstraints.prohibitedClaims)||!Array.isArray(env.copyConstraints.requiredDisclosures))fail('copyConstraints requires prohibitedClaims and requiredDisclosures arrays.');
  if(!isObj(env.schedule)||!Number.isInteger(env.schedule.maxPerDay)||env.schedule.maxPerDay<1||env.schedule.maxPerDay>10000||!Number.isInteger(env.schedule.startHourUtc)||!Number.isInteger(env.schedule.endHourUtc)||env.schedule.startHourUtc<0||env.schedule.endHourUtc>24||env.schedule.startHourUtc>=env.schedule.endHourUtc)fail('Schedule must provide bounded UTC window and daily send limit.');
  if(!isObj(env.budget)||!Number.isSafeInteger(env.budget.maxSpendMinor)||env.budget.maxSpendMinor<0||env.budget.maxSpendMinor>Number(campaign.spend_limit_minor)||env.budget.currency!==campaign.currency)fail('Budget must fit the campaign spend and currency bounds.');
  if(!Number.isInteger(env.capacity)||env.capacity<1||env.capacity>Number(campaign.offer_content?.capacity||0))fail('Capacity must fit approved offer capacity.');
  const maxExpiry=Date.now()+90*86400000;if(new Date(env.expiresAt).valueOf()<=Date.now()||new Date(env.expiresAt).valueOf()>maxExpiry)fail('Envelope expiry must be within 90 days.');
  if(!env.sequence.version||!env.copyConstraints.version||env.copyConstraints.approvedCopyHash!==campaign.copy_hash)fail('Sequence and copy constraints must be pinned to the validated copy.');
  if(pins.sequence!==String(env.sequence.version)||pins.copy!==String(campaign.copy_version))fail('Envelope sequence and copy version pins must match the campaign snapshots.');
  if(Buffer.byteLength(canonicalJson(env),'utf8')>24000)fail('Authorization envelope is too large.');
  return env;
}

export async function createAstraAuthorizationEnvelope(client,actor,campaignId,input){
  if(!own(actor))fail('Only an owner or admin can define campaign autonomy.',403,'authorization_forbidden');
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId);if(!campaign)fail('Campaign not found.',404,'campaign_not_found');
  const env=normalizeEnvelope(input,actor,campaign);const latest=await client.query('SELECT COALESCE(max(version),0)::int AS version FROM astra.campaign_authorizations WHERE tenant_id=$1 AND campaign_id=$2::uuid',[actor.tenantId,campaignId]);
  const version=Number(latest.rows[0].version)+1;const envelopeHash=hash({version,envelope:env});const id=randomUUID();
  await client.query(`INSERT INTO astra.campaign_authorizations(tenant_id,id,campaign_id,version,envelope,envelope_hash,mode,expires_at,created_by)
   VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,[actor.tenantId,id,campaignId,version,JSON.stringify(env),envelopeHash,env.mode,env.expiresAt,String(actor.userId)]);
  return {id,campaignId,version,envelope:env,envelopeHash,state:'pending_approval',immutable:true};
}

export async function approveAstraAuthorizationEnvelope(client,actor,campaignId,version,input={}){
  if(actor?.tenantRole!=='owner')fail('Only the tenant owner can approve campaign autonomy.',403,'authorization_forbidden');
  if(!isObj(input)||Object.keys(input).length)fail('Approval does not accept client-supplied hashes or scope.');
  const r=await client.query(`SELECT a.id,a.envelope,a.envelope_hash,a.mode,a.expires_at,
    EXISTS(SELECT 1 FROM astra.authorization_approvals p WHERE p.tenant_id=a.tenant_id AND p.authorization_id=a.id AND p.envelope_hash=a.envelope_hash) AS approved,
    EXISTS(SELECT 1 FROM astra.authorization_revocations x WHERE x.tenant_id=a.tenant_id AND x.authorization_id=a.id) AS revoked
    FROM astra.campaign_authorizations a WHERE a.tenant_id=$1 AND a.campaign_id=$2::uuid AND a.version=$3`,[actor.tenantId,campaignId,version]);if(!r.rowCount)fail('Authorization envelope not found.',404,'authorization_not_found');
  const row=r.rows[0];if(row.revoked)fail('Authorization envelope has been revoked.',409,'authorization_revoked');if(row.approved)return {id:row.id,campaignId,version,envelopeHash:row.envelope_hash,state:'approved',duplicate:true};
  if(new Date(row.expires_at).valueOf()<=Date.now())fail('Authorization envelope expired.',409,'authorization_expired');
  await client.query(`INSERT INTO astra.authorization_approvals(tenant_id,id,authorization_id,envelope_hash,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,authorization_id) DO NOTHING`,[actor.tenantId,randomUUID(),row.id,row.envelope_hash,String(actor.userId)]);
  return {id:row.id,campaignId,version,envelopeHash:row.envelope_hash,state:'approved',approvedBy:String(actor.userId),mode:row.mode};
}

export async function revokeAstraAuthorizationEnvelope(client,actor,campaignId,version,input){
  if(!own(actor))fail('Only an owner or admin can revoke campaign autonomy.',403,'authorization_forbidden');
  if(!isObj(input)||Object.keys(input).some(k=>k!=='reason'))fail('Revocation accepts only a reason.');const reason=clean(input.reason,'reason',240);
  const r=await client.query(`SELECT id,envelope_hash FROM astra.campaign_authorizations WHERE tenant_id=$1 AND campaign_id=$2::uuid AND version=$3`,[actor.tenantId,campaignId,version]);if(!r.rowCount)fail('Authorization envelope not found.',404,'authorization_not_found');
  await client.query(`INSERT INTO astra.authorization_revocations(tenant_id,id,authorization_id,envelope_hash,reason,revoked_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,authorization_id) DO NOTHING`,[actor.tenantId,randomUUID(),r.rows[0].id,r.rows[0].envelope_hash,reason,String(actor.userId)]);
  return {id:r.rows[0].id,campaignId,version,envelopeHash:r.rows[0].envelope_hash,revoked:true};
}

export async function listAstraAuthorizationEnvelopes(client,tenantId,campaignId){const r=await client.query(`SELECT a.id,a.campaign_id AS "campaignId",a.version,a.envelope,a.envelope_hash AS "envelopeHash",a.mode,a.expires_at AS "expiresAt",p.approved_by AS "approvedBy",p.created_at AS "approvedAt",x.reason AS "revocationReason",x.created_at AS "revokedAt",a.created_at AS "createdAt" FROM astra.campaign_authorizations a LEFT JOIN astra.authorization_approvals p ON(p.tenant_id,p.authorization_id)=(a.tenant_id,a.id) LEFT JOIN astra.authorization_revocations x ON(x.tenant_id,x.authorization_id)=(a.tenant_id,a.id) WHERE a.tenant_id=$1 AND a.campaign_id=$2::uuid ORDER BY a.version DESC`,[tenantId,campaignId]);return r.rows;}

export async function requestAstraExceptionReview(client,actor,campaignId,input){
  if(!isObject(input)||Object.keys(input).some(k=>!['recipientId','intent'].includes(k)))fail('Exception request accepts only recipientId and intent.');
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId);if(!campaign)fail('Campaign not found.',404,'campaign_not_found');
  const auth=await client.query(`SELECT a.id,a.envelope,a.envelope_hash FROM astra.campaign_authorizations a JOIN astra.authorization_approvals p ON(p.tenant_id,p.authorization_id)=(a.tenant_id,a.id)
    WHERE a.tenant_id=$1 AND a.campaign_id=$2::uuid AND a.mode='exception_review' AND a.expires_at>now() AND NOT EXISTS(SELECT 1 FROM astra.authorization_revocations x WHERE x.tenant_id=a.tenant_id AND x.authorization_id=a.id) ORDER BY a.version DESC LIMIT 1`,[actor.tenantId,campaignId]);
  if(!auth.rowCount)fail('Current approved exception-review envelope is unavailable.',409,'authorization_unavailable');
  const recipientId=uuid(input.recipientId,'recipientId');const intent=input.intent;
  const allowed=['campaignId','recipientId','action','email','countryCode','geographyClaimId','copyHash','subjectHash','bodyHash','estimatedSpendMinor','sequenceStep','exceptionApprovalId'];
  if(!isObject(intent)||Object.keys(intent).some(k=>!allowed.includes(k))||intent.exceptionApprovalId!=null||intent.campaignId!==campaignId||intent.recipientId!==recipientId||intent.action!=='email.send'||intent.copyHash!==campaign.copy_hash||intent.subjectHash!==sha256(campaign.subject||'')||intent.bodyHash!==sha256(campaign.body||''))fail('Exception request must bind current campaign, recipient and exact copy.',400,'exception_intent_invalid');
  const stored=await findCurrentAstraCampaignAudienceMember(client,actor.tenantId,campaignId,recipientId);
  if(!stored||String(stored.normalized_value).toLowerCase()!==String(intent.email||'').toLowerCase())fail('Exception recipient does not match the current qualified identity.',409,'recipient_changed');
  const intentHash=hash(intent);const id=randomUUID();
  await client.query(`INSERT INTO astra.authorization_exception_requests(tenant_id,id,authorization_id,campaign_id,recipient_id,intent_hash,intent,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,authorization_id,recipient_id,intent_hash) DO NOTHING`,[actor.tenantId,id,auth.rows[0].id,campaignId,recipientId,intentHash,JSON.stringify(intent),String(actor.userId)]);
  const r=await client.query(`SELECT id,intent_hash AS "intentHash",created_at AS "createdAt" FROM astra.authorization_exception_requests WHERE tenant_id=$1 AND authorization_id=$2 AND recipient_id=$3::uuid AND intent_hash=$4`,[actor.tenantId,auth.rows[0].id,recipientId,intentHash]);
  return {...r.rows[0],campaignId,authorizationHash:auth.rows[0].envelope_hash,state:'pending_review'};
}

export async function listAstraExceptionReviews(client,tenantId,campaignId){const r=await client.query(`SELECT q.id,q.recipient_id AS "recipientId",q.intent_hash AS "intentHash",q.intent,p.approved_by AS "approvedBy",p.created_at AS "approvedAt",q.created_at AS "requestedAt" FROM astra.authorization_exception_requests q LEFT JOIN astra.authorization_exception_approvals p ON(p.tenant_id,p.request_id)=(q.tenant_id,q.id) WHERE q.tenant_id=$1 AND q.campaign_id=$2::uuid ORDER BY q.created_at DESC LIMIT 200`,[tenantId,campaignId]);return r.rows;}

export async function approveAstraExceptionReview(client,actor,campaignId,requestId,input={}){
  if(actor?.tenantRole!=='owner')fail('Only the tenant owner can approve an exception.',403,'authorization_forbidden');if(!isObject(input)||Object.keys(input).length)fail('Exception approval accepts no client-provided hash.');
  const r=await client.query(`SELECT q.id,q.authorization_id,q.intent_hash FROM astra.authorization_exception_requests q JOIN astra.campaign_authorizations a ON(a.tenant_id,a.id)=(q.tenant_id,q.authorization_id) JOIN astra.authorization_approvals p ON(p.tenant_id,p.authorization_id,p.envelope_hash)=(a.tenant_id,a.id,a.envelope_hash)
    WHERE q.tenant_id=$1 AND q.campaign_id=$2::uuid AND q.id=$3::uuid AND a.mode='exception_review' AND a.expires_at>now()
    AND NOT EXISTS(SELECT 1 FROM astra.authorization_revocations x WHERE x.tenant_id=a.tenant_id AND x.authorization_id=a.id)`,[actor.tenantId,campaignId,requestId]);
  if(!r.rowCount)fail('Current exception request was not found.',404,'exception_request_not_found');
  await client.query(`INSERT INTO astra.authorization_exception_approvals(tenant_id,id,request_id,intent_hash,approved_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,request_id) DO NOTHING`,[actor.tenantId,randomUUID(),r.rows[0].id,r.rows[0].intent_hash,String(actor.userId)]);
  return {requestId:r.rows[0].id,intentHash:r.rows[0].intent_hash,approvedBy:String(actor.userId),state:'approved'};
}

export async function bindAstraMailboxConnector(client,actor,mailboxId,connectorId){
  if(!own(actor))fail('Only an owner or admin can bind a mailbox connector.',403,'connector_binding_forbidden');
  const mailbox=uuid(mailboxId,'mailboxId'),connector=uuid(connectorId,'connectorId');
  const valid=await client.query(`SELECT m.provider_mailbox_id FROM astra.mailboxes m JOIN astra.connector_configs c ON c.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.id=$2::uuid AND c.id=$3::uuid AND c.provider='smtp_imap' AND c.state='configured'`,[actor.tenantId,mailbox,connector]);
  if(!valid.rowCount||!valid.rows[0].provider_mailbox_id)fail('Configured SMTP/IMAP connector and provider mailbox identity are required.',404,'connector_binding_invalid');
  const current=await client.query('SELECT connector_id,provider_mailbox_id FROM astra.mailbox_connectors WHERE tenant_id=$1 AND mailbox_id=$2::uuid',[actor.tenantId,mailbox]);
  if(current.rowCount){if(current.rows[0].connector_id===connector&&current.rows[0].provider_mailbox_id===valid.rows[0].provider_mailbox_id)return {mailboxId:mailbox,connectorId:connector,duplicate:true};
    await client.query('UPDATE astra.mailbox_connectors SET connector_id=$3,provider_mailbox_id=$4 WHERE tenant_id=$1 AND mailbox_id=$2::uuid',[actor.tenantId,mailbox,connector,valid.rows[0].provider_mailbox_id]);
    return {mailboxId:mailbox,connectorId:connector,duplicate:false};}
  await client.query(`INSERT INTO astra.mailbox_connectors(tenant_id,mailbox_id,connector_id,provider_mailbox_id,created_by) VALUES($1,$2,$3,$4,$5)`,[actor.tenantId,mailbox,connector,valid.rows[0].provider_mailbox_id,String(actor.userId)]);
  return {mailboxId:mailbox,connectorId:connector,duplicate:false};
}

/**
 * Emergency-stop check (X14): when the tenant active launch pointer binds this
 * campaign to a revoked release, no new execution intent may be minted. A
 * tenant with no pointer is unaffected; full release activation stays behind
 * the existing server-flag gates in astra-launch-controls.
 */
export async function assertCampaignLaunchNotStopped(client,tenantId,campaignId){
  if(!tenantId||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(campaignId)))fail('A valid campaign is required to check launch state.');
  const r=await client.query(`SELECT p.campaign_id,r.status FROM astra.launch_active_pointers p JOIN astra.launch_releases r ON (r.tenant_id,r.id)=(p.tenant_id,p.release_id)
    WHERE p.tenant_id=$1::uuid AND p.campaign_id=$2::uuid AND r.status='revoked'`,[tenantId,campaignId]);
  if(r.rowCount)fail('The active launch release for this campaign has been revoked; new execution intents are stopped.',409,'launch_release_revoked');
  return {stopped:false};
}

/** Internal service-only ticket mint. Never registered as an end-user route. */
export async function issueAstraExecutionTicket(client,actor,{campaignId,recipient,action,intent,decisionId,reason,expiresAt,legacyDb}){
  if(!actor||!['worker','owner'].includes(actor.tenantRole))fail('Trusted worker context required to mint an execution ticket.',403,'ticket_mint_forbidden');
  if(action!=='email.send')fail('Ticket action is unsupported.');const campaign=await getAstraCampaign(client,actor.tenantId,campaignId);if(!campaign)fail('Campaign not found.',404,'campaign_not_found');
  await client.query('SELECT id FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE',[actor.tenantId,campaignId]);
  await assertCampaignLaunchNotStopped(client,actor.tenantId,campaignId);
  const decision=await getAstraDecision(client,actor.tenantId,uuid(decisionId,'decisionId'));if(!decision||decision.action!=='ACT'||decision.policyStatus!=='allowed')fail('Decision is not an allowed ACT.',409,'decision_not_authorized');
  const auth=await client.query(`SELECT a.id,a.version,a.envelope,a.envelope_hash FROM astra.campaign_authorizations a JOIN astra.authorization_approvals p ON(p.tenant_id,p.authorization_id,p.envelope_hash)=(a.tenant_id,a.id,a.envelope_hash) WHERE a.tenant_id=$1 AND a.campaign_id=$2::uuid AND a.expires_at>now() AND NOT EXISTS(SELECT 1 FROM astra.authorization_revocations x WHERE x.tenant_id=a.tenant_id AND x.authorization_id=a.id) ORDER BY a.version DESC LIMIT 1`,[actor.tenantId,campaignId]);if(!auth.rowCount)fail('Current approved authorization envelope is unavailable.',409,'authorization_unavailable');
  const e=auth.rows[0],env=e.envelope;if(env.mode==='draft')fail('Draft mode cannot authorize execution.',409,'draft_mode');
  if(Number(env.campaignVersion)!==Number(campaign.version)||hash({version:Number(e.version),envelope:env})!==e.envelope_hash)fail('Authorization envelope no longer matches the campaign.',409,'authorization_stale');
  if(campaign.state==='paused'||campaign.state==='stopped')fail('Paused or stopped campaigns cannot mint execution tickets.',409,'campaign_not_runnable');
  const recipientId=uuid(recipient?.recipientId,'recipientId');const email=clean(recipient?.email,'recipient.email',320).toLowerCase();const intentObj={...intent};
  const intentKeys=['campaignId','recipientId','action','email','countryCode','geographyClaimId','copyHash','subjectHash','bodyHash','estimatedSpendMinor','sequenceStep','exceptionApprovalId'];
  if(!isObj(intentObj)||Object.keys(intentObj).some(k=>!intentKeys.includes(k))||intentObj.campaignId!==campaignId||intentObj.recipientId!==recipientId||intentObj.action!==action||intentObj.email?.toLowerCase()!==email||intentObj.copyHash!==campaign.copy_hash||intentObj.subjectHash!==sha256(campaign.subject||'')||intentObj.bodyHash!==sha256(campaign.body||''))fail('Intent must exactly bind the campaign, recipient, action and approved copy.',409,'intent_scope_mismatch');
  if(env.audience.kind==='account_ids'&&!env.audience.accountIds.includes(recipient.accountId))fail('Recipient is outside the authorized audience.',409,'recipient_out_of_scope');
  if(env.mode==='exception_review'){
    const exception=await client.query(`SELECT q.intent_hash FROM astra.authorization_exception_requests q JOIN astra.authorization_exception_approvals p ON(p.tenant_id,p.request_id)=(q.tenant_id,q.id)
      WHERE q.tenant_id=$1 AND q.id=$2::uuid AND q.authorization_id=$3::uuid AND q.campaign_id=$4::uuid AND q.recipient_id=$5::uuid AND q.intent_hash=$6`,
    [actor.tenantId,uuid(intentObj.exceptionApprovalId,'exceptionApprovalId'),e.id,campaignId,recipientId,hash(Object.fromEntries(Object.entries(intentObj).filter(([key])=>key!=='exceptionApprovalId')))]);
    if(!exception.rowCount)fail('An owner-approved exact exception review is required.',409,'exception_review_required');
  }
  const qualified=await findCurrentAstraCampaignAudienceMember(client,actor.tenantId,campaignId,recipientId);
  if(!qualified||qualified.normalized_value.toLowerCase()!==email||qualified.account_id!==recipient.accountId)fail('Recipient qualification or identity is not current.',409,'qualification_blocked');
  const country=String(intentObj.countryCode||'').toUpperCase();
  const geo=await resolveCurrentAstraGeographyProof(client,{tenantId:actor.tenantId,claimId:intentObj.geographyClaimId,
    domain:qualified.normalized_domain,country,allowedCountries:env.geography});
  if(!geo)fail('A current source-backed country proof is required for envelope geography.',409,'geography_unknown_or_out_of_scope');
  if(!await evaluateAstraPermission(client,actor,{recipient:email,domain:qualified.normalized_domain,account:qualified.account_id,purpose:env.purpose}).then(x=>x.allowed))fail('Permission or suppression blocks this recipient.',409,'permission_denied');
  const emailHash=createHash('sha256').update(email).digest('hex');
  const verification=await client.query(`SELECT v.adapter_receipt_id,v.address_sha256,r.address_sha256 AS receipt_address,r.classification,r.expires_at
    FROM astra.campaign_verification_records v JOIN astra.verification_adapter_receipts r ON(r.tenant_id,r.id,r.candidate_id)=(v.tenant_id,v.adapter_receipt_id,v.candidate_id)
    WHERE v.tenant_id=$1 AND v.campaign_id=$2::uuid AND v.candidate_id=$3::uuid AND v.classification='verified' AND v.expires_at>now()
      AND r.classification='verified' AND r.environment='provider_observed' AND r.expires_at>now() ORDER BY v.created_at DESC LIMIT 1`,[actor.tenantId,campaignId,recipientId]);
  if(!verification.rowCount||verification.rows[0].address_sha256!==emailHash||verification.rows[0].receipt_address!==emailHash)fail('Current positive provider verification receipt is required.',409,'verification_receipt_required');
  if(!campaign.copy_hash||intentObj.copyHash!==campaign.copy_hash||intentObj.subjectHash!==sha256(campaign.subject||'')||intentObj.bodyHash!==sha256(campaign.body||''))fail('Intent must bind current validated copy.',409,'copy_changed');
  if(!await hasCurrentAstraCopyProof(client,{tenantId:actor.tenantId,campaign}))fail('Current copy claim and source proof is missing or stale.',409,'copy_claims_stale');
  if(!legacyDb||typeof legacyDb.prepare!=='function')fail('Offer proof storage is unavailable.',503,'offer_policy_unavailable');
  const offer=validateOfferVersionForUse(legacyDb,Number(campaign.offer_version_id));if(!offer.ok||offer.contentHash!==campaign.offer_content_hash||!assertOfferTenantOwnership(legacyDb,offer.offerId,actor.tenantId)||!evaluateOfferPolicy(offer.content).ok)fail('Approved offer proof or policy is unavailable.',409,'offer_snapshot_changed');
  const capacity=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  if((capacity?.rows.filter(row=>row.current).length||0)>Math.min(Number(env.capacity),Number(offer.content.capacity)))fail('Campaign or approved offer capacity is exhausted.',409,'capacity_exceeded');
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`astra-offer:${actor.tenantId}:${campaign.offer_version_id}`]);
  const reserved=await client.query(`SELECT count(*)::int AS count FROM astra.execution_tickets t JOIN astra.campaigns c ON(c.tenant_id,c.id)=(t.tenant_id,t.campaign_id)
    WHERE t.tenant_id=$1 AND c.offer_version_id=$2 AND t.state IN ('issued','claimed','succeeded','uncertain') AND (t.state IN ('succeeded','uncertain') OR t.expires_at>now())`,[actor.tenantId,campaign.offer_version_id]);
  if(Number(reserved.rows[0].count)>=Number(offer.content.capacity))fail('Approved offer capacity is reserved or consumed.',409,'offer_capacity_exhausted');
  if(!Number.isSafeInteger(intentObj.estimatedSpendMinor)||intentObj.estimatedSpendMinor<0||intentObj.estimatedSpendMinor>Number(env.budget.maxSpendMinor)||env.budget.currency!==campaign.currency)fail('Intent is outside the approved budget.',409,'spend_limit_exceeded');
  if(!Number.isInteger(intentObj.sequenceStep)||intentObj.sequenceStep<0||intentObj.sequenceStep>=env.sequence.maxMessages)fail('Sequence step is outside the authorized sequence.',409,'sequence_scope_invalid');
  const sequence=await client.query(`SELECT max((intent->>'sequenceStep')::int) AS last_step,max(created_at) AS last_at,bool_or(state='uncertain') AS uncertain,bool_or(state IN ('issued','claimed')) AS in_flight
    FROM astra.execution_tickets WHERE tenant_id=$1 AND campaign_id=$2::uuid AND recipient_id=$3::uuid AND state IN ('issued','claimed','succeeded','uncertain')`,[actor.tenantId,campaignId,recipientId]);
  const seq=sequence.rows[0];const expectedStep=seq.last_step==null?0:Number(seq.last_step)+1;
  if(seq.in_flight||seq.uncertain||intentObj.sequenceStep!==expectedStep||(seq.last_at&&Date.now()-new Date(seq.last_at).valueOf()<Number(env.sequence.cooldownHours)*3600000))fail('Recipient sequence is pending, uncertain, out of order, or cooling down.',409,'sequence_not_ready');
  const budget=await client.query(`SELECT COALESCE(sum((intent->>'estimatedSpendMinor')::bigint),0)::bigint AS spent,count(*)::int AS daily_count FROM astra.execution_tickets
    WHERE tenant_id=$1 AND campaign_id=$2::uuid AND state IN ('issued','claimed','succeeded','uncertain') AND expires_at>now() AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[actor.tenantId,campaignId]);
  if(Number(budget.rows[0].spent)+intentObj.estimatedSpendMinor>Number(env.budget.maxSpendMinor)||Number(budget.rows[0].daily_count)>=Number(env.schedule.maxPerDay))fail('Campaign budget or schedule capacity is exhausted.',409,'campaign_budget_exhausted');
  if(campaign.schedule_at&&new Date(campaign.schedule_at).valueOf()>Date.now())fail('Campaign is not yet in its approved send window.',409,'schedule_not_open');
  const utcHour=new Date().getUTCHours();if(utcHour<env.schedule.startHourUtc||utcHour>=env.schedule.endHourUtc)fail('Current time is outside the authorized UTC send window.',409,'schedule_not_open');
  const connector=await client.query(`SELECT b.connector_id,c.state FROM astra.mailbox_connectors b JOIN astra.connector_configs c ON(c.tenant_id,c.id)=(b.tenant_id,b.connector_id)
    WHERE b.tenant_id=$1 AND b.mailbox_id=$2::uuid AND c.provider='smtp_imap'`,[actor.tenantId,campaign.mailbox_id]);
  if(!connector.rowCount||connector.rows[0].state!=='configured')fail('An explicit configured mailbox connector binding is required.',409,'mailbox_connector_unavailable');
    const evidence=await client.query(`SELECT provenance FROM astra.connector_evidence WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid AND capability='smtp.submit' AND outcome='supported' AND environment='provider_observed' AND source='provider_probe' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,connector.rows[0].connector_id,campaign.mailbox_id]);
  const provenance=evidence.rows[0]?.provenance;if(!evidence.rowCount||typeof provenance?.evidenceRef!=='string'||typeof provenance?.adapterVersion!=='string')fail('Current SMTP submit capability proof is required.',409,'mailbox_send_capability_unknown');
  const exp=iso(expiresAt??new Date(Date.now()+5*60000).toISOString(),'expiresAt');if(new Date(exp).valueOf()>Math.min(Date.now()+10*60000,new Date(env.expiresAt).valueOf()))fail('Ticket expiry exceeds its authorization window.',400,'ticket_expiry_invalid');
  const priorTicket=await client.query(`SELECT id,state FROM astra.execution_tickets WHERE tenant_id=$1 AND campaign_id=$2::uuid AND recipient_id=$3::uuid AND action=$4 AND intent_hash=$5`,[actor.tenantId,campaignId,recipientId,action,hash(intentObj)]);
  if(priorTicket.rowCount)fail('This exact intent already has a durable ticket and cannot be reissued.',409,'ticket_already_issued');
  const payload={schemaVersion:1,tenantId:actor.tenantId,campaignId,recipientId,recipientHash:createHash('sha256').update(email).digest('hex'),action,intentHash:hash(intentObj),campaignVersion:Number(campaign.version),authorizationId:e.id,authorizationVersion:e.version,envelopeHash:e.envelope_hash,decisionId:decision.id,reason:clean(reason,'reason',240),expiresAt:exp};
  const ticketId=randomUUID();const ticketHash=hash(payload);const secret=process.env.ASTRA_EXECUTION_TICKET_SECRET;
  if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32)fail('Ticket signing is not configured.',503,'ticket_signing_unavailable');
  const signature=createHmac('sha256',secret).update(ticketHash).digest('hex');
  await client.query(`INSERT INTO astra.execution_tickets(tenant_id,id,campaign_id,recipient_id,action,intent_hash,intent,recipient_hash,campaign_version,authorization_id,authorization_version,envelope_hash,decision_id,reason,expires_at,ticket_hash,signature,state,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'issued',$18)`,[actor.tenantId,ticketId,campaignId,recipientId,action,payload.intentHash,JSON.stringify(intentObj),payload.recipientHash,payload.campaignVersion,e.id,e.version,e.envelope_hash,decision.id,payload.reason,exp,ticketHash,signature,String(actor.userId)]);
  return {ticketId,payload,ticketHash,signature};
}

export function verifyAstraExecutionTicket(ticket,secret=process.env.ASTRA_EXECUTION_TICKET_SECRET){
  if(!isObj(ticket)||!isObj(ticket.payload)||typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32)return false;
  const expected=hash(ticket.payload);if(expected!==ticket.ticketHash)return false;const signature=createHmac('sha256',secret).update(expected).digest('hex');
  try{return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(ticket.signature,'hex'));}catch{return false;}
}

/** Atomic single-use ticket claim with lease fencing; caller must commit before invoking transport. */
export async function claimAstraExecutionTicket(client,actor,ticketId,leaseMs=30000){
  const id=uuid(ticketId,'ticketId');const ms=Number.isInteger(leaseMs)?Math.max(1000,Math.min(60000,leaseMs)):30000;
  const r=await client.query(`UPDATE astra.execution_tickets SET state='claimed',fence=fence+1,lease_token=gen_random_uuid(),lease_until=now()+($3::int*interval '1 millisecond'),claimed_by=$4
    WHERE tenant_id=$1 AND id=$2::uuid AND state='issued' AND expires_at>now() AND revoked_at IS NULL
    RETURNING id,campaign_id,recipient_id,action,intent_hash,campaign_version,authorization_id,authorization_version,envelope_hash,decision_id,reason,expires_at,ticket_hash,signature,fence,lease_token,lease_until`,[actor.tenantId,id,ms,String(actor.userId)]);
  if(!r.rowCount)fail('Ticket is expired, revoked, or already consumed.',409,'ticket_unavailable');return r.rows[0];
}

export async function recordAstraExecutionAttempt(client,actor,{ticketId,fence,leaseToken,outcome,providerReceipt=null,errorCode=null}){
  if(!['accepted','uncertain','rejected'].includes(outcome))fail('Transport outcome is unsupported.');
  const id=uuid(ticketId,'ticketId');const clientIdempotency=`astra-ticket-${id}`;
  const updated=await client.query(`UPDATE astra.execution_tickets SET state=$5,completed_at=now(),provider_receipt=$6::jsonb,error_code=$7,lease_token=NULL,lease_until=NULL,claimed_by=NULL
    WHERE tenant_id=$1 AND id=$2::uuid AND fence=$3 AND lease_token=$4::uuid AND state='claimed' AND lease_until>now()
    RETURNING id,campaign_id,recipient_id,action,intent_hash,fence,state,completed_at`,[actor.tenantId,id,fence,leaseToken,outcome==='accepted'?'succeeded':outcome==='uncertain'?'uncertain':'failed',providerReceipt==null?null:JSON.stringify(providerReceipt),errorCode]);
  if(!updated.rowCount)fail('Ticket lease fence is stale; result cannot be committed.',409,'ticket_fence_lost');
  await client.query(`INSERT INTO astra.execution_attempts(tenant_id,id,ticket_id,fence,client_idempotency_key,outcome,provider_receipt,error_code,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[actor.tenantId,randomUUID(),id,fence,clientIdempotency,outcome,providerReceipt==null?null:JSON.stringify(providerReceipt),errorCode,String(actor.userId)]);
  return updated.rows[0];
}

export async function invalidateAstraCampaignTickets(client,actor,campaignId,reason='scope_changed'){
  const r=await client.query(`SELECT astra.revoke_issued_execution_tickets($1::uuid,$2::uuid,$3) AS count`,[actor.tenantId,campaignId,clean(reason,'reason',120)]);return Number(r.rows[0].count);
}
