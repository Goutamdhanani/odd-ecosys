import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { evaluateAstraPermission } from './astra-permissions.js';
import { claimAstraExecutionTicket, hasCurrentAstraCopyProof, recordAstraExecutionAttempt, resolveCurrentAstraGeographyProof } from './astra-autonomy.js';
import { getAstraCampaign } from './astra-campaigns.js';
import { validateOfferVersionForUse } from './offer-contracts.js';
import { assertOfferTenantOwnership, evaluateOfferPolicy } from './offer-policy.js';
import { connectorTransportEnabled } from './astra-connectors.js';
import { prepareAstraOfflineDispatchPlan, listAstraDispatchPlans, claimAstraOfflineDispatchPlan } from './astra-campaigns.js';
import { assertAstraDispatchEnabled } from './astra-operations.js';
import { assertAstraLaunchDispatchCompatible } from './astra-launch-controls.js';
import { recordAstraTelemetry } from './astra-telemetry.js';
import { createAstraSmtpDispatchAdapter } from './astra-smtp-dispatch.js';
import { findCurrentAstraCampaignAudienceMember, readCurrentAstraCampaignAudience } from './astra-campaign-audience.js';

export { prepareAstraOfflineDispatchPlan, listAstraDispatchPlans, claimAstraOfflineDispatchPlan };

const fail=(m,s=409,c='dispatch_blocked')=>{const e=new Error(m);e.name='AstraTenantContextError';e.statusCode=s;e.code=c;throw e;};
const hash=value=>sha256(canonicalJson(value));
const recipientHash=email=>sha256(String(email).trim().toLowerCase());
const hmac=(secret,value)=>createHmac('sha256',secret).update(value).digest('hex');
const isLocalPreview=()=>['1','true','yes'].includes(String(process.env.LOCAL_PREVIEW||'').toLowerCase())||['1','true','yes'].includes(String(process.env.ASTRA_LOCAL_PREVIEW||'').toLowerCase())||['1','true','yes'].includes(String(process.env.ASTRA_PREVIEW||'').toLowerCase());
function globalProviderAuthority(){
  if(!connectorTransportEnabled('smtp_imap','provider_observed')||process.env.ASTRA_GLOBAL_PROVIDER_DECISION!=='approved'||process.env.ASTRA_LIVE_ACTIONS!=='enabled'||isLocalPreview())return false;
  const expires=Date.parse(process.env.ASTRA_GLOBAL_PROVIDER_DECISION_EXPIRES_AT||'');return Number.isFinite(expires)&&expires>Date.now();
}

function campaignSnapshotHash(c){return hash({tenantId:c.tenant_id,campaignId:c.id,version:Number(c.version),offerVersionId:Number(c.offer_version_id),offerContentHash:c.offer_content_hash,offerContent:c.offer_content,audience:c.audience_snapshot,copyVersion:Number(c.copy_version),subject:c.subject,body:c.body,claimsMap:c.claims_map,mailboxId:c.mailbox_id,purpose:c.purpose,geography:c.geography,scheduleAt:c.schedule_at,spendLimitMinor:Number(c.spend_limit_minor),currency:c.currency,verificationPolicy:{required:true,allowedClassification:'approved_adapter_verified',staleAfterExpiry:true}});}

async function currentAuthorization(client,tenantId,ticket){
  const r=await client.query(`SELECT a.id,a.version,a.envelope,a.envelope_hash,a.expires_at,p.envelope_hash AS approved_hash
    FROM astra.campaign_authorizations a JOIN astra.authorization_approvals p ON(p.tenant_id,p.authorization_id)=(a.tenant_id,a.id)
    WHERE a.tenant_id=$1 AND a.id=$2::uuid AND a.campaign_id=$3::uuid AND a.version=$4
      AND NOT EXISTS(SELECT 1 FROM astra.authorization_revocations x WHERE x.tenant_id=a.tenant_id AND x.authorization_id=a.id)`,[tenantId,ticket.authorization_id,ticket.campaign_id,ticket.authorization_version]);
  const a=r.rows[0];if(!a||a.envelope_hash!==ticket.envelope_hash||a.approved_hash!==ticket.envelope_hash||new Date(a.expires_at).valueOf()<=Date.now())fail('Authorization is absent, revoked, expired, or changed.',409,'authorization_stale');
  if(hash({version:Number(a.version),envelope:a.envelope})!==a.envelope_hash)fail('Authorization envelope hash is invalid.',409,'authorization_hash_invalid');
  return a;
}

async function assertTransportEligibility(client,actor,ticket,legacyDb){
  await assertAstraLaunchDispatchCompatible(client, actor.tenantId, ticket);
  const campaign=await getAstraCampaign(client,actor.tenantId,ticket.campaign_id);if(!campaign)fail('Campaign not found.',404,'campaign_not_found');
  if(Number(campaign.version)!==Number(ticket.campaign_version)||campaign.state==='paused'||campaign.state==='stopped')fail('Campaign is paused, stopped, or changed.',409,'campaign_scope_changed');
  if(campaign.schedule_at&&new Date(campaign.schedule_at).valueOf()>Date.now())fail('Campaign schedule has not opened.',409,'schedule_not_open');
  const auth=await currentAuthorization(client,actor.tenantId,ticket);const env=auth.envelope;
  if(env.mode==='draft')fail('Draft mode cannot send.',409,'draft_mode');
  if(env.mode==='exception_review'){
    if(!ticket.intent.exceptionApprovalId)fail('Exception review is required.',409,'exception_review_required');
    const ih=hash(Object.fromEntries(Object.entries(ticket.intent).filter(([key])=>key!=='exceptionApprovalId')));
    const approval=await client.query(`SELECT 1 FROM astra.authorization_exception_requests q JOIN astra.authorization_exception_approvals p ON(p.tenant_id,p.request_id)=(q.tenant_id,q.id)
      WHERE q.tenant_id=$1 AND q.id=$2::uuid AND q.authorization_id=$3::uuid AND q.campaign_id=$4::uuid AND q.recipient_id=$5::uuid AND q.intent_hash=$6 AND p.intent_hash=q.intent_hash`,
    [actor.tenantId,ticket.intent.exceptionApprovalId,ticket.authorization_id,campaign.id,ticket.recipient_id,ih]);
    if(!approval.rowCount)fail('Owner-approved exact exception review is no longer valid.',409,'exception_review_required');
  }
  if(env.mailboxId!==campaign.mailbox_id||env.purpose!==campaign.purpose||env.offer.contentHash!==campaign.offer_content_hash||Number(env.offer.versionId)!==Number(campaign.offer_version_id)||Number(env.campaignVersion)!==Number(campaign.version))fail('Envelope no longer matches campaign scope.',409,'envelope_scope_changed');
  if(ticket.intentHash!==ticket.intent_hash||hash(ticket.intent)!==ticket.intent_hash||ticket.intent.campaignId!==campaign.id||ticket.intent.recipientId!==ticket.recipient_id||ticket.intent.action!=='email.send')fail('Ticket intent is invalid.',409,'intent_hash_invalid');
  if(ticket.recipient_hash!==recipientHash(ticket.intent.email||''))fail('Ticket recipient binding is invalid.',409,'recipient_hash_invalid');
  if(ticket.intent.copyHash!==campaign.copy_hash||ticket.intent.subjectHash!==sha256(campaign.subject||'')||ticket.intent.bodyHash!==sha256(campaign.body||''))fail('Approved copy changed after ticket issue.',409,'copy_changed');
  const recipient=await findCurrentAstraCampaignAudienceMember(client,actor.tenantId,campaign.id,ticket.recipient_id);
  if(!recipient)fail('Recipient is not currently qualified.',409,'qualification_blocked');
  recipient.email=recipient.normalized_value;
  if(recipient.email.toLowerCase()!==(ticket.intent.email||'').toLowerCase()||!recipient.normalized_domain)fail('Recipient address changed.',409,'recipient_changed');
  if(env.audience.kind==='account_ids'&&!env.audience.accountIds.includes(recipient.account_id))fail('Recipient is outside the envelope audience.',409,'recipient_out_of_scope');
  const country=String(ticket.intent.countryCode||'').toUpperCase();
  const geo=await resolveCurrentAstraGeographyProof(client,{tenantId:actor.tenantId,claimId:ticket.intent.geographyClaimId,
    domain:recipient.normalized_domain,country,allowedCountries:env.geography});
  if(!geo)fail('A current source-backed country proof is required for envelope geography.',409,'geography_unknown_or_out_of_scope');
  const permission=await evaluateAstraPermission(client,actor,{recipient:recipient.email,domain:recipient.normalized_domain,account:recipient.account_id,purpose:env.purpose});if(!permission.allowed)fail(`Permission or suppression blocks dispatch: ${permission.reason}.`,409,'permission_denied');
  const verify=await client.query(`SELECT v.adapter_receipt_id,v.address_sha256,v.expires_at,r.receipt_sha256,r.classification AS receipt_classification,r.address_sha256 AS receipt_address,r.expires_at AS receipt_expires
    FROM astra.campaign_verification_records v JOIN astra.verification_adapter_receipts r ON(r.tenant_id,r.id,r.candidate_id)=(v.tenant_id,v.adapter_receipt_id,v.candidate_id)
    WHERE v.tenant_id=$1 AND v.campaign_id=$2::uuid AND v.candidate_id=$3::uuid AND v.classification='verified'
      AND v.expires_at>now() AND r.classification='verified' AND r.environment='provider_observed' AND r.expires_at>now() ORDER BY v.created_at DESC LIMIT 1`,[actor.tenantId,campaign.id,ticket.recipient_id]);
  if(!verify.rowCount||verify.rows[0].address_sha256!==recipientHash(recipient.email)||verify.rows[0].receipt_address!==recipientHash(recipient.email))fail('Current provider verification receipt is unavailable for this exact address.',409,'verification_receipt_required');
  if(!campaign.copy_hash||!campaign.subject||!campaign.body)fail('Validated campaign copy is unavailable.',409,'validated_copy_missing');
  if(!await hasCurrentAstraCopyProof(client,{tenantId:actor.tenantId,campaign}))fail('Current copy claims or source rights failed revalidation.',409,'copy_claims_stale');
  if(!legacyDb||typeof legacyDb.prepare!=='function')fail('Offer policy storage is unavailable.',503,'offer_policy_unavailable');
  const offer=validateOfferVersionForUse(legacyDb,Number(campaign.offer_version_id));if(!offer.ok||offer.contentHash!==campaign.offer_content_hash||!assertOfferTenantOwnership(legacyDb,offer.offerId,actor.tenantId))fail('Approved offer proof changed or is unavailable.',409,'offer_snapshot_changed');
  const offerPolicy=evaluateOfferPolicy(offer.content);if(!offerPolicy.ok)fail('Approved offer policy failed revalidation.',409,'offer_policy_blocked');
  const fitted=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaign.id);
  const fittedCount=fitted?.rows.filter(row=>row.current).length||0;
  if(fittedCount>Number(offer.content.capacity)||fittedCount>Number(env.capacity))fail('Offer or authorization capacity is exhausted.',409,'capacity_exceeded');
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`astra-offer:${actor.tenantId}:${campaign.offer_version_id}`]);
  const offerUsage=await client.query(`SELECT count(*)::int AS count FROM astra.execution_tickets t JOIN astra.campaigns c ON(c.tenant_id,c.id)=(t.tenant_id,t.campaign_id)
    WHERE t.tenant_id=$1 AND c.offer_version_id=$2 AND t.id<>$3::uuid AND t.state IN ('issued','claimed','succeeded','uncertain') AND (t.state IN ('succeeded','uncertain') OR t.expires_at>now())`,[actor.tenantId,campaign.offer_version_id,ticket.id]);
  if(Number(offerUsage.rows[0].count)>=Number(offer.content.capacity))fail('Approved offer capacity is reserved or consumed.',409,'offer_capacity_exhausted');
  const spend=Number(ticket.intent.estimatedSpendMinor);if(!Number.isSafeInteger(spend)||spend<0||env.budget.currency!==campaign.currency||spend>Number(env.budget.maxSpendMinor)||spend>Number(campaign.spend_limit_minor))fail('Message is outside authorized spend.',409,'spend_limit_exceeded');
  const utcHour=new Date().getUTCHours();if(utcHour<env.schedule.startHourUtc||utcHour>=env.schedule.endHourUtc)fail('Current time is outside the authorized UTC send window.',409,'schedule_not_open');
  const step=Number(ticket.intent.sequenceStep);if(!Number.isInteger(step)||step<0||step>=env.sequence.maxMessages)fail('Message sequence step is outside authorized scope.',409,'sequence_scope_invalid');
  const sequence=await client.query(`SELECT max((intent->>'sequenceStep')::int) AS last_step,max(created_at) AS last_at,bool_or(state='uncertain') AS uncertain,bool_or(state IN ('issued','claimed')) AS in_flight
    FROM astra.execution_tickets WHERE tenant_id=$1 AND campaign_id=$2::uuid AND recipient_id=$3::uuid AND id<>$4::uuid AND state IN ('issued','claimed','succeeded','uncertain')`,[actor.tenantId,campaign.id,ticket.recipient_id,ticket.id]);
  const seq=sequence.rows[0],expectedStep=seq.last_step==null?0:Number(seq.last_step)+1;if(seq.in_flight||seq.uncertain||step!==expectedStep||(seq.last_at&&Date.now()-new Date(seq.last_at).valueOf()<Number(env.sequence.cooldownHours)*3600000))fail('Recipient sequence is pending, uncertain, out of order, or cooling down.',409,'sequence_not_ready');
  const used=await client.query(`SELECT COALESCE(sum((t.intent->>'estimatedSpendMinor')::bigint),0)::bigint AS spent,count(*)::int AS sent_today FROM astra.execution_tickets t
    WHERE t.tenant_id=$1 AND t.campaign_id=$2::uuid AND t.id<>$3::uuid AND t.state IN ('claimed','succeeded','uncertain') AND t.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[actor.tenantId,campaign.id,ticket.id]);
  if(Number(used.rows[0].spent)+spend>Number(env.budget.maxSpendMinor)||Number(used.rows[0].sent_today)>=Number(env.schedule.maxPerDay))fail('Campaign budget or schedule capacity is exhausted.',409,'campaign_budget_exhausted');
  const binding=await client.query(`SELECT b.connector_id,c.state,
      astra.connector_configuration_hash(c.provider,c.endpoint_host,c.public_config,c.credential_fingerprint) AS configuration_hash
    FROM astra.mailbox_connectors b JOIN astra.connector_configs c ON(c.tenant_id,c.id)=(b.tenant_id,b.connector_id)
    WHERE b.tenant_id=$1 AND b.mailbox_id=$2::uuid AND c.provider='smtp_imap'`,[actor.tenantId,campaign.mailbox_id]);if(!binding.rowCount||binding.rows[0].state!=='configured')fail('Mailbox connector binding is unavailable.',409,'mailbox_connector_unavailable');
  const capability=await client.query(`SELECT e.id,e.provenance,e.configuration_hash FROM astra.connector_evidence e
    WHERE e.tenant_id=$1 AND e.connector_id=$2::uuid AND e.mailbox_id=$3::uuid AND e.capability='smtp.submit'
      AND e.outcome='supported' AND e.environment='provider_observed' AND e.source='provider_probe'
      AND e.configuration_hash=$4 AND e.expires_at>now() ORDER BY e.created_at DESC LIMIT 1`,
    [actor.tenantId,binding.rows[0].connector_id,campaign.mailbox_id,binding.rows[0].configuration_hash]);
  const proof=capability.rows[0]?.provenance;if(!capability.rowCount||typeof proof?.evidenceRef!=='string'||!proof.evidenceRef||typeof proof.adapterVersion!=='string')fail('A current SMTP submit capability probe is required.',409,'mailbox_send_capability_unknown');
  return {campaign,recipient,envelope:env,connectorId:binding.rows[0].connector_id,configurationHash:binding.rows[0].configuration_hash,
    capabilityId:capability.rows[0].id,verificationReceiptId:verify.rows[0].adapter_receipt_id,verificationReceiptHash:verify.rows[0].receipt_sha256};
}

async function withWorkerTransaction(store,identity,fn){
  if(!store||typeof store.withWorkerTenant!=='function')fail('A verified worker tenant store is required.',503,'worker_store_unavailable');
  if(!identity?.tenantId||!identity?.userId)fail('Worker identity is incomplete.',403,'dispatch_forbidden');
  const tenantId=String(identity.tenantId).toLowerCase(),userId=String(identity.userId);
  return store.withWorkerTenant({tenantId,userId},async(client,membership)=>{
    if(String(membership?.tenantId).toLowerCase()!==tenantId||String(membership?.userId)!==userId)fail('Verified worker tenant context does not match the dispatch request.',403,'dispatch_forbidden');
    // This authority exists only inside the verified astra_worker transaction;
    // a caller-provided `tenantRole: worker` is never treated as proof.
    const actor=Object.freeze({...membership,role:'worker',tenantRole:'worker'});
    return fn(client,actor);
  });
}

/**
 * Worker-only side-effect path. Ticket claim and all policy checks commit before
 * the adapter call; provider I/O never runs inside a database transaction.
 * Unclear provider outcomes are terminal `uncertain` and are never retried.
 */
export async function dispatchAstraExecutionTicket(store,identity,ticketId,{transport,legacyDb}={}){
  if(!identity?.tenantId||!identity?.userId)fail('Only a verified worker identity may dispatch an execution ticket.',403,'dispatch_forbidden');
  if(!globalProviderAuthority())fail('Current global provider decision does not authorize live actions.',409,'live_actions_disabled');
  // The real mailbox adapter is server-owned. The optional injected interface
  // remains available to trusted worker composition, but callers never choose
  // an endpoint or credential through this function.
  const adapter=transport||createAstraSmtpDispatchAdapter();
  const preparedAdapter=typeof adapter.prepareSubmit==='function'&&typeof adapter.submitPrepared==='function';
  if(!preparedAdapter&&typeof adapter.submitMessage!=='function')fail('A configured mailbox transport adapter is required.',503,'transport_unavailable');
  const claimed=await withWorkerTransaction(store,identity,async(client,actor)=>{
    const r=await client.query(`SELECT id,campaign_id,recipient_id,action,intent_hash,intent,recipient_hash,campaign_version,authorization_id,authorization_version,envelope_hash,decision_id,reason,expires_at,ticket_hash,signature,state,fence,lease_token,lease_until,revoked_at FROM astra.execution_tickets WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,ticketId]);
    const t=r.rows[0];if(!t)fail('Ticket not found.',404,'ticket_not_found');
    await assertAstraDispatchEnabled(client,actor.tenantId,t.campaign_id);
    const payload={schemaVersion:1,tenantId:actor.tenantId,campaignId:t.campaign_id,recipientId:t.recipient_id,recipientHash:t.recipient_hash,action:t.action,intentHash:t.intent_hash,campaignVersion:Number(t.campaign_version),authorizationId:t.authorization_id,authorizationVersion:Number(t.authorization_version),envelopeHash:t.envelope_hash,decisionId:t.decision_id,reason:t.reason,expiresAt:new Date(t.expires_at).toISOString()};
    const secret=process.env.ASTRA_EXECUTION_TICKET_SECRET;if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32||hash(payload)!==t.ticket_hash)fail('Ticket signature is invalid.',409,'ticket_signature_invalid');
    const expected=Buffer.from(hmac(secret,t.ticket_hash),'hex');let supplied;try{supplied=Buffer.from(t.signature,'hex');}catch{supplied=Buffer.alloc(0);}if(supplied.length!==expected.length||!timingSafeEqual(expected,supplied))fail('Ticket signature is invalid.',409,'ticket_signature_invalid');
    const decision=await client.query(`SELECT action,policy_status FROM astra.decisions WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,t.decision_id]);if(!decision.rowCount||decision.rows[0].action!=='ACT'||decision.rows[0].policy_status!=='allowed')fail('Ticket decision is no longer authorized.',409,'decision_not_authorized');
    await recordAstraTelemetry(client,actor,{kind:'decision.recorded',decisionId:t.decision_id,payload:{outcome:'ACT'}});
    const lease=await claimAstraExecutionTicket(client,actor,t.id);
    return {...t,...lease,intentHash:t.intent_hash};
  });
  let preflight;
  try{preflight=await withWorkerTransaction(store,identity,async(client,actor)=>{await assertAstraDispatchEnabled(client,actor.tenantId,claimed.campaign_id);return {...(await assertTransportEligibility(client,actor,claimed,legacyDb)),dispatchActor:actor};});}
  catch(error){await withWorkerTransaction(store,identity,async(client,actor)=>{
    const result=await recordAstraExecutionAttempt(client,actor,{ticketId:claimed.id,fence:claimed.fence,leaseToken:claimed.lease_token,outcome:'rejected',errorCode:error.code||'dispatch_guard_rejected'});
    await recordAstraTelemetry(client,actor,{kind:'dispatcher.blocked',canonicalFactId:result.id,payload:{state:'rejected',errorCode:String(error.code||'dispatch_guard_rejected').slice(0,80)}});
  });throw error;}
  try{
    preflight=await withWorkerTransaction(store,identity,async(client,actor)=>{
      await assertAstraDispatchEnabled(client,actor.tenantId,claimed.campaign_id);
      const eligible=await assertTransportEligibility(client,actor,claimed,legacyDb);
      const value={...eligible,dispatchActor:actor};
      // Credential/config/proof reads are performed inside the signed worker
      // transaction. The returned prepared value contains no client/transaction.
      if(preparedAdapter)value.preparedAdapter=await adapter.prepareSubmit({client,actor,ticket:claimed,
        connectorId:eligible.connectorId,capabilityEvidenceId:eligible.capabilityId,
        configurationHash:eligible.configurationHash,message:{mailboxId:eligible.campaign.mailbox_id,to:eligible.recipient.email,
          subject:eligible.campaign.subject,text:eligible.campaign.body,ticketId:claimed.id}});
      return value;
    });
    if(!globalProviderAuthority())fail('Current global provider decision does not authorize live actions.',409,'live_actions_disabled');
  }catch(error){
    await withWorkerTransaction(store,identity,async(client,actor)=>{
      const result=await recordAstraExecutionAttempt(client,actor,{ticketId:claimed.id,fence:claimed.fence,leaseToken:claimed.lease_token,outcome:'rejected',errorCode:error.code||'dispatch_guard_rejected'});
      await recordAstraTelemetry(client,actor,{kind:'dispatcher.blocked',canonicalFactId:result.id,payload:{state:'rejected',errorCode:String(error.code||'dispatch_guard_rejected').slice(0,80)}});
    });
    throw error;
  }
  let outcome='uncertain',receipt=null,errorCode=null;
  try{
    // The final persisted checks committed before entering this adapter call.
    const message={mailboxId:preflight.campaign.mailbox_id,to:preflight.recipient.email,subject:preflight.campaign.subject,text:preflight.campaign.body,
      clientIdempotencyKey:`astra-ticket-${claimed.id}`,ticketId:claimed.id,verificationReceiptId:preflight.verificationReceiptId,verificationReceiptHash:preflight.verificationReceiptHash};
    const response=preparedAdapter
      ? await adapter.submitPrepared({prepared:preflight.preparedAdapter,ticket:claimed,message:preflight.preparedAdapter.message})
      : await adapter.submitMessage({actor:preflight.dispatchActor,connectorId:preflight.connectorId,capabilityEvidenceId:preflight.capabilityId,purpose:preflight.envelope.purpose,message});
    if(response?.state==='accepted'&&response.providerReceipt?.kind==='smtp_final_response'
      &&response.providerReceipt.schemaVersion===1&&typeof response.providerReceipt.smtpResponse==='string'
      &&Number.isInteger(response.providerReceipt.responseCode)&&response.providerReceipt.responseCode>=200&&response.providerReceipt.responseCode<300
      &&response.providerReceipt.acceptedCount===1&&response.providerReceipt.rejectedCount===0
      &&response.providerReceipt.recipientSha256===recipientHash(preflight.recipient.email)
      &&response.providerReceipt.subjectSha256===sha256(preflight.campaign.subject||'')
      &&response.providerReceipt.textSha256===sha256(String(preflight.campaign.body||'').replace(/\r?\n/g,'\r\n'))
      &&response.providerReceipt.ticketId===claimed.id&&response.providerReceipt.mailboxId===preflight.campaign.mailbox_id
      &&response.providerReceipt.configurationHash===preflight.configurationHash) {outcome='accepted';receipt=response.providerReceipt;}
    else if(response?.state==='failed') {outcome='rejected';errorCode=typeof response.diagnosticCode==='string'?response.diagnosticCode:'provider_rejected';}
    else {outcome='uncertain';errorCode='provider_acknowledgement_unknown';}
  }catch(error){outcome='uncertain';errorCode=typeof error?.code==='string'?error.code.slice(0,100):'provider_submission_uncertain';}
  const result=await withWorkerTransaction(store,identity,async(client,actor)=>{
    const outcomeFact=await recordAstraExecutionAttempt(client,actor,{ticketId:claimed.id,fence:claimed.fence,leaseToken:claimed.lease_token,outcome,providerReceipt:receipt,errorCode});
    await recordAstraTelemetry(client,actor,{kind:'dispatcher.outcome',canonicalFactId:outcomeFact.id,payload:{state:outcomeFact.state,outcome}});
    return outcomeFact;
  });
  return {ticketId:claimed.id,state:result.state,outcome,providerReceipt:receipt,errorCode,mayRetry:false};
}

/** Recover an expired in-flight lease as uncertain; never resubmit from a checkpoint. */
export async function reconcileExpiredAstraExecutionTickets(store,identity,{limit=100}={}){
  if(!identity?.tenantId||!identity?.userId)fail('Only a verified worker identity may reconcile execution tickets.',403,'dispatch_forbidden');
  const bounded=Number.isInteger(limit)?Math.max(1,Math.min(100,limit)):100;
  return withWorkerTransaction(store,identity,async(client,actor)=>{
    const rows=await client.query(`WITH expired AS (
      SELECT tenant_id,id,fence FROM astra.execution_tickets WHERE tenant_id=$1 AND state='claimed' AND lease_until<=now() ORDER BY lease_until LIMIT $2 FOR UPDATE SKIP LOCKED
    ) UPDATE astra.execution_tickets t SET state='uncertain',completed_at=now(),lease_token=NULL,lease_until=NULL,claimed_by=NULL,error_code='worker_lease_expired_submission_unknown'
      FROM expired x WHERE (t.tenant_id,t.id)=(x.tenant_id,x.id)
      RETURNING t.id,t.fence,t.campaign_id,t.recipient_id,t.action,t.intent_hash,t.state,t.completed_at`,[actor.tenantId,bounded]);
    for(const row of rows.rows){
      await client.query(`INSERT INTO astra.execution_attempts(tenant_id,id,ticket_id,fence,client_idempotency_key,outcome,error_code,created_by)
        VALUES($1,$2,$3,$4,$5,'uncertain','worker_lease_expired_submission_unknown',$6) ON CONFLICT(tenant_id,ticket_id,fence) DO NOTHING`,
      [actor.tenantId,randomUUID(),row.id,row.fence,`astra-ticket-${row.id}`,String(actor.userId)]);
      await recordAstraTelemetry(client,actor,{kind:'dispatcher.outcome',canonicalFactId:row.id,payload:{state:'uncertain',outcome:'uncertain'}});
    }
    return {reconciled:rows.rowCount,items:rows.rows.map(row=>({ticketId:row.id,state:'uncertain',mayRetry:false}))};
  });
}

