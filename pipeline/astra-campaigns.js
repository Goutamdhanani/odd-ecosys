import { randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { appendEvent, canonicalJson, sha256 } from './astra-ledger.js';
import { evaluateAstraPermission } from './astra-permissions.js';
import { validateOfferVersionForUse } from './offer-contracts.js';
import { assertOfferTenantOwnership, evaluateOfferPolicy } from './offer-policy.js';
import { countryClaimToIsoCode } from './astra-country-code.js';
import { resolveCurrentResearchClaims } from './astra-current-claims.js';
import { readCurrentAstraCampaignAudience } from './astra-campaign-audience.js';
import { readAstraSourceRights } from './astra-source-rights.js';
import { ASTRA_COPY_SUBJECT, getAstraCopyTemplates, validateAstraCopyDraft, validatePersistedAstraCopy } from './astra-copy-validation.js';

const fail = (message, status = 400, code = 'campaign_invalid') => { throw new AstraTenantContextError(message, status, code); };
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = (value, field, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${field} is required and must be at most ${max} printable characters.`);
  return value.trim();
};
const asUuid = (value, name) => { if (typeof value !== 'string' || !UUID.test(value)) fail(`${name} must be a UUID.`); return value.toLowerCase(); };
const nowIso = () => new Date().toISOString();

async function emit(client, actor, eventType, campaignId, payload = {}) {
  await appendEvent(client, actor, { eventType, entity: { type: 'astra_campaign', id: campaignId }, occurredAt: nowIso(),
    idempotencyKey: `campaign:${campaignId}:${eventType}:${randomUUID()}`, payload,
    provenance: { source: 'astra.campaigns', confidence: 'high', fieldAuthority: 'system' } });
}

function getApprovedOffer(legacyDb, actor, offerVersionId) {
  if (!legacyDb || typeof legacyDb.prepare !== 'function') fail('Offer policy storage is unavailable; campaign creation is blocked.', 503, 'offer_policy_unavailable');
  const versionId = Number(offerVersionId);
  if (!Number.isSafeInteger(versionId) || versionId < 1) fail('offerVersionId is invalid.');
  const offer = validateOfferVersionForUse(legacyDb, versionId);
  if (!offer.ok) fail(`Offer cannot be used: ${offer.code}.`, 409, offer.code);
  const owned = legacyDb.prepare(`SELECT ownership.tenant_id FROM offer_versions versions
    JOIN offer_tenant_ownership ownership ON ownership.offer_id=versions.offer_id WHERE versions.id=?`).get(versionId);
  if (!owned?.tenant_id || !assertOfferTenantOwnership(legacyDb, offer.offerId, actor.tenantId)
    || String(owned.tenant_id).toLowerCase() !== String(actor.tenantId).toLowerCase()) {
    fail('Offer ownership could not be verified for this tenant.', 404, 'offer_not_found');
  }
  return offer;
}

function campaignHash(row) {
  return sha256(canonicalJson({ tenantId: row.tenant_id, campaignId: row.id, version: Number(row.version),
    offerVersionId: Number(row.offer_version_id), offerContentHash: row.offer_content_hash,
    offerContent: row.offer_content, audience: row.audience_snapshot, copyVersion: Number(row.copy_version),
    subject: row.subject, body: row.body, claimsMap: row.claims_map, mailboxId: row.mailbox_id,
    purpose: row.purpose, geography: row.geography, scheduleAt: row.schedule_at,
    spendLimitMinor: Number(row.spend_limit_minor), currency: row.currency,
    verificationPolicy: { required: true, allowedClassification: 'approved_adapter_verified', staleAfterExpiry: true } }));
}

async function currentCopyBlockers(client, actor, campaign) {
  const validation=await validatePersistedAstraCopy(client,{tenantId:actor.tenantId,campaign});
  return validation.eligible?[]:validation.reasons.map(reason=>reason==='copy_hash_integrity_failed'?reason:'copy_claim_or_source_rights_stale');
}

async function copyAppliesToDomain(client,actor,campaign,domain) {
  const validation=await validatePersistedAstraCopy(client,{tenantId:actor.tenantId,campaign});
  return validation.eligible&&Array.isArray(validation.proofs)&&validation.proofs.length>0
    &&validation.proofs.every(proof=>proof.businessDomain===String(domain).toLowerCase());
}

async function currentQualificationBlockers(client,actor,campaignId) {
  const audience=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  if(audience?.rows.some(row=>row.reasons?.some(reason=>['qualification_proof_stale','contact_source_rights_revoked'].includes(reason))))return ['qualification_proof_stale'];
  return [];
}

export async function createAstraCampaign(client, actor, legacyDb, input) {
  if (!isObject(input) || Object.keys(input).some(key => !['name','offerVersionId','mailboxId','purpose','geography','scheduleAt','spendLimitMinor','currency'].includes(key))) fail('Campaign accepts only its name, approved offer, mailbox, purpose, geography, schedule and spend bound.');
  const name = clean(input.name, 'name', 160);
  const purpose = clean(input.purpose, 'purpose', 120);
  const mailboxId = asUuid(input.mailboxId, 'mailboxId');
  const offer = getApprovedOffer(legacyDb, actor, input.offerVersionId);
  const currency = typeof input.currency === 'string' ? input.currency.toUpperCase() : '';
  const spendLimitMinor = input.spendLimitMinor;
  if (!Number.isSafeInteger(spendLimitMinor) || spendLimitMinor < 0 || spendLimitMinor > 100_000_000_000 || currency !== offer.content.price.currency) fail('Spend limit must use the approved offer currency and valid minor units.');
  if (!Array.isArray(input.geography) || input.geography.length < 1 || input.geography.length > 100 || input.geography.some(code => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))) fail('geography must contain uppercase two-letter country codes.');
  const geography = [...new Set(input.geography)].sort();
  if (geography.length !== input.geography.length || geography.some(country => !offer.content.geography.includedCountries.includes(country) || offer.content.geography.excludedCountries.includes(country))) fail('Campaign geography exceeds the approved offer geography.');
  const scheduleAt = input.scheduleAt == null ? null : new Date(input.scheduleAt);
  if (scheduleAt && (!Number.isFinite(scheduleAt.valueOf()) || scheduleAt.valueOf() <= Date.now())) fail('scheduleAt must be a future timestamp.');
  const mailbox = await client.query('SELECT id,provider,configuration_status FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid', [actor.tenantId, mailboxId]);
  if (!mailbox.rowCount) fail('Mailbox was not found for this tenant.', 404, 'mailbox_not_found');
  const id = randomUUID();
  const inserted = await client.query(`INSERT INTO astra.campaigns
    (tenant_id,id,name,offer_version_id,offer_content,offer_content_hash,mailbox_id,purpose,geography,schedule_at,spend_limit_minor,currency,created_by)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)
    RETURNING id,name,state,version,offer_version_id AS "offerVersionId",offer_content_hash AS "offerContentHash",mailbox_id AS "mailboxId",purpose,geography,schedule_at AS "scheduleAt",spend_limit_minor AS "spendLimitMinor",currency,created_at AS "createdAt"`,
  [actor.tenantId,id,name,offer.offerVersionId,JSON.stringify(offer.content),offer.contentHash,mailboxId,purpose,JSON.stringify(geography),scheduleAt?.toISOString() || null,spendLimitMinor,currency,String(actor.userId)]);
  await emit(client,actor,'campaign.created',id,{offerVersionId:offer.offerVersionId,offerContentHash:offer.contentHash});
  return inserted.rows[0];
}

export async function listAstraCampaigns(client, tenantId, { limit = 100 } = {}) {
  const bounded = Number.isInteger(limit) ? Math.max(1,Math.min(200,limit)) : 100;
  const result = await client.query(`SELECT id,name,state,version,offer_version_id AS "offerVersionId",offer_content_hash AS "offerContentHash",
    mailbox_id AS "mailboxId",purpose,geography,schedule_at AS "scheduleAt",spend_limit_minor AS "spendLimitMinor",currency,
    copy_version AS "copyVersion",created_at AS "createdAt",updated_at AS "updatedAt" FROM astra.campaigns WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,[tenantId,bounded]);
  return result.rows;
}

export async function getAstraCampaign(client, tenantId, id) {
  const result = await client.query(`SELECT id,tenant_id,name,state,version,offer_version_id,offer_content,offer_content_hash,mailbox_id,purpose,geography,schedule_at,
    spend_limit_minor,currency,copy_version,subject,body,claims_map,copy_hash,audience_snapshot,created_by,created_at,updated_at
    FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid`,[tenantId,id]);
  return result.rows[0] || null;
}

export async function getAstraCampaignComposer(client, tenantId, campaignId) {
  const campaign=await getAstraCampaign(client,tenantId,campaignId);
  if(!campaign)return null;
  const metadata=Array.isArray(campaign.claims_map)?campaign.claims_map.find(item=>item?.kind==='copy_validation'):null;
  const current=metadata?.status==='unverified'
    ? {status:'unverified',eligible:false,reasons:Array.isArray(metadata.reasons)?metadata.reasons:['copy_unverified']}
    : await validatePersistedAstraCopy(client,{tenantId,campaign});
  const validation=current.eligible?current:{status:'unverified',eligible:false,reasons:current.reasons};
  const templates=await getAstraCopyTemplates(client,{tenantId,campaign});
  return {campaignId:campaign.id,version:Number(campaign.version),copyVersion:Number(campaign.copy_version),
    subject:campaign.subject||'',body:campaign.body||'',validation,templates};
}

/** Read-only authoritative campaign review. No approval or capability is created here. */
export async function getAstraCampaignReview(client, actor, legacyDb, campaignId) {
  await client.query('SELECT id FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid FOR SHARE',[actor.tenantId,campaignId]);
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId);
  if(!campaign)return null;

  let validation;
  if(!campaign.subject||!campaign.body||!campaign.copy_hash) {
    validation={status:'unverified',eligible:false,reasons:['campaign_draft_required'],proofs:[]};
  } else {
    validation=await validatePersistedAstraCopy(client,{tenantId:actor.tenantId,campaign});
  }
  const copyBlockers=validation.eligible?[]:(validation.reasons?.length?validation.reasons:['copy_validation_unavailable']);

  let approvedOffer=null;
  let offerBlockers=[];
  try {
    approvedOffer=getApprovedOffer(legacyDb,actor,campaign.offer_version_id);
    if(approvedOffer.contentHash!==campaign.offer_content_hash)offerBlockers.push('offer_snapshot_changed');
  } catch(error) {
    offerBlockers.push(error?.code==='offer_not_found'?'offer_ownership_unverified':'approved_offer_unavailable');
  }
  const offer={versionId:Number(campaign.offer_version_id),contentHash:campaign.offer_content_hash,
    snapshot:campaign.offer_content,current:Boolean(approvedOffer&&approvedOffer.contentHash===campaign.offer_content_hash),
    blockers:offerBlockers};

  const mailboxResult=await client.query(`SELECT id,provider,configuration_status,capability_evidence
    FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,campaign.mailbox_id]);
  const mailboxRow=mailboxResult.rows[0]||null;
  const mailbox={id:mailboxRow?.id||campaign.mailbox_id,provider:mailboxRow?.provider||null,
    configurationStatus:mailboxRow?.configuration_status||'missing',capabilityEvidence:mailboxRow?.capability_evidence||{}};

  const currentAudience=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  const rows=currentAudience?.rows||[];
  const fitCount=rows.filter(row=>row.current).length;
  const audience={rows,count:rows.length,fitCount,blockedCount:rows.length-fitCount};
  const capacity=approvedOffer?.content?.capacity;
  const limits={spendLimitMinor:Number(campaign.spend_limit_minor),currency:campaign.currency,
    approvedOfferCapacity:Number.isFinite(Number(capacity))?Number(capacity):null,
    approvedPrice:approvedOffer?.content?.price||campaign.offer_content?.price||null,
    purpose:campaign.purpose,geography:campaign.geography,scheduleAt:campaign.schedule_at};

  const approvalBlockers=[...copyBlockers,...offerBlockers];
  if(fitCount===0)approvalBlockers.push('eligible_audience_empty');
  if(rows.some(row=>row.reasons?.some(reason=>['qualification_proof_stale','contact_source_rights_revoked'].includes(reason))))
    approvalBlockers.push('qualification_proof_stale');
  if(Number.isFinite(Number(capacity))&&fitCount>Number(capacity))approvalBlockers.push('offer_capacity_exceeded');
  const uniqueApprovalBlockers=[...new Set(approvalBlockers)];

  const approvalHash=campaignHash(campaign);
  const approvalRows=await client.query(`SELECT id,campaign_version AS "campaignVersion",approval_hash AS "approvalHash",
    expires_at AS "expiresAt",approved_by AS "approvedBy" FROM astra.campaign_approvals
    WHERE tenant_id=$1 AND campaign_id=$2::uuid ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,campaignId]);
  const prior=approvalRows.rows[0]||null;
  const approvalCurrent=Boolean(prior&&prior.approvalHash===approvalHash&&new Date(prior.expiresAt).valueOf()>Date.now()
    &&uniqueApprovalBlockers.length===0);
  const currentApproval=prior?{id:prior.id,campaignVersion:Number(prior.campaignVersion),expiresAt:prior.expiresAt,
    approvedBy:prior.approvedBy,current:approvalCurrent}:null;

  const deliveryBlockers=[...copyBlockers,...offerBlockers];
  if(!approvalCurrent)deliveryBlockers.push('current_approval_missing_or_expired');
  if(!mailboxRow)deliveryBlockers.push('mailbox_missing');
  if(!mailboxRow||mailboxRow.configuration_status!=='verified'||mailboxRow.provider==='manual'
    ||mailboxRow.capability_evidence?.send!=='verified')deliveryBlockers.push('mailbox_send_capability_unknown');
  if(fitCount===0)deliveryBlockers.push('eligible_audience_empty');
  if(Number.isFinite(Number(capacity))&&fitCount>Number(capacity))deliveryBlockers.push('offer_capacity_exceeded');
  // This release intentionally has no live transport adapter.
  deliveryBlockers.push('live_dispatch_disabled');
  deliveryBlockers.push('recipient_permission_and_verification_not_evaluated');

  return {campaignId:campaign.id,version:Number(campaign.version),copyVersion:Number(campaign.copy_version),
    copy:{subject:campaign.subject||'',body:campaign.body||'',validation},offer,mailbox,audience,limits,
    approval:{ready:uniqueApprovalBlockers.length===0,blockers:uniqueApprovalBlockers,current:currentApproval},
    delivery:{ready:false,recipientChecks:'not_evaluated_in_review',blockers:[...new Set(deliveryBlockers)]}};
}

export async function qualifyAstraCampaign(client, actor, legacyDb, campaignId, input) {
  await client.query('SELECT id FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE',[actor.tenantId,campaignId]);
  const campaign = await getAstraCampaign(client,actor.tenantId,campaignId);
  if (!campaign) fail('Campaign was not found.',404,'campaign_not_found');
  if (!Array.isArray(input?.accountIds) || input.accountIds.length < 1 || input.accountIds.length > 100
    || input.accountIds.some(id => typeof id !== 'string' || !UUID.test(id))) fail('accountIds must contain 1–100 research account UUIDs.');
  const offer = getApprovedOffer(legacyDb,actor,campaign.offer_version_id);
  if (offer.contentHash !== campaign.offer_content_hash) fail('The bound offer changed. Create a new campaign to rebind it.',409,'offer_snapshot_changed');
  const results = [];
  for (const accountId of [...new Set(input.accountIds.map(value => value.toLowerCase()))]) {
    const account = await client.query(`SELECT id,normalized_domain,display_domain FROM astra.research_accounts WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,accountId]);
    if (!account.rowCount) { results.push({accountId,status:'blocked',reasons:['account_not_found']}); continue; }
    const row = account.rows[0];
    const reasons = [];
    const claims = await resolveCurrentResearchClaims(client,{tenantId:actor.tenantId,subjectKey:row.normalized_domain});
    function currentPredicate(predicate, missingReason, ambiguousReason) {
      const matching=claims.filter(item=>item.predicate===predicate&&item.valid);
      const values=new Set(matching.map(item=>item.value));
      if(!matching.length){reasons.push(missingReason);return null;}
      if(values.size!==1){reasons.push(ambiguousReason);return null;}
      return matching.sort((a,b)=>a.claimId.localeCompare(b.claimId))[0];
    }
    const industryClaim = currentPredicate('industry','current_industry_evidence_missing','industry_claim_ambiguous');
    const countryClaim = currentPredicate('country','current_country_evidence_missing','country_claim_ambiguous');
    const country = countryClaim ? countryClaimToIsoCode(countryClaim.value) : null;
    if (countryClaim && !campaign.geography.includes(country)) reasons.push('campaign_geography_excluded');
    const offerPolicy = evaluateOfferPolicy(offer.content,{country,segment:industryClaim?.value});
    if (!offerPolicy.ok) reasons.push(...offerPolicy.blockers);
    const candidates = await client.query(`SELECT c.id AS candidate_id,c.normalized_value AS email,c.evidence_id,c.exact_excerpt AS candidate_excerpt,
        e.content_sha256,e.normalized_domain,e.extracted_text,e.extracted_emails,src.id AS source_id,src.source_url,src.normalized_domain AS source_domain,
        src.rights_policy,src.rights_expires_at,src.robots_allowed,src.rights_attested
      FROM astra.research_identity_candidates c JOIN astra.research_evidence e ON(e.tenant_id,e.id)=(c.tenant_id,c.evidence_id)
      JOIN astra.research_sources src ON(src.tenant_id,src.id)=(e.tenant_id,e.source_id)
      WHERE c.tenant_id=$1 AND c.account_id=$2::uuid AND c.normalized_domain=$3
      ORDER BY c.created_at DESC,c.id`,[actor.tenantId,accountId,row.normalized_domain]);
    const candidateRights = await readAstraSourceRights(client,actor.tenantId,candidates.rows.map(item=>item.source_id).filter(Boolean));
    const candidate = candidates.rows.find(item=>item.normalized_domain===row.normalized_domain&&item.source_domain===row.normalized_domain
      &&item.robots_allowed&&item.rights_attested&&['synthetic_fixture','user_provided','licensed','public_terms_permitted'].includes(item.rights_policy)
      &&candidateRights.get(String(item.source_id).toLowerCase())?.usable
      &&(!item.rights_expires_at||new Date(item.rights_expires_at).valueOf()>Date.now())
      &&item.extracted_emails?.some(email=>String(email).toLowerCase()===String(item.email).toLowerCase())
      &&item.candidate_excerpt?.includes(item.email)&&item.extracted_text?.includes(item.candidate_excerpt));
    if (!candidate) reasons.push('literal_contact_address_missing_or_source_rights_stale');
    const id = randomUUID();
    const status = reasons.length ? 'blocked' : 'fit';
    const proofRefs = [industryClaim,countryClaim].filter(Boolean).map(item => ({
      claimId:item.claimId,predicate:item.predicate,value:item.value,subjectKey:item.subjectKey,
      evidenceId:item.proof.evidenceId,contentSha256:item.proof.contentSha256,exactExcerpt:item.proof.exactExcerpt,
      sourceId:item.proof.sourceId,sourceUrl:item.proof.sourceUrl,proofDomain:item.proof.domain,
      rightsPolicy:item.proof.rightsPolicy,rightsExpiresAt:item.proof.rightsExpiresAt,
      sourceRightsStatus:item.proof.sourceRightsStatus,rightsRevokedAt:item.proof.rightsRevokedAt,
      rightsRevocationEventId:item.proof.rightsRevocationEventId,rightsRevocationReason:item.proof.rightsRevocationReason,
      expiresAt:item.expiresAt,correctionId:item.correctionId,correctionType:item.correctionType,
      correctedAt:item.proof.correctedAt,
    }));
    await client.query(`INSERT INTO astra.campaign_qualifications(tenant_id,id,campaign_id,account_id,candidate_id,status,reasons,claim_refs)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT DO NOTHING`,
    [actor.tenantId,id,campaignId,accountId,candidate?.candidate_id||null,status,JSON.stringify(reasons),JSON.stringify(proofRefs)]);
    results.push({accountId,candidateId:candidate?.candidate_id||null,domain:row.normalized_domain,email:candidate?.email||null,emailEvidenceId:candidate?.evidence_id||null,
      emailSourceId:candidate?.source_id||null,status,reasons,scoreInputs:{country:country||null,industry:industryClaim?.value||null,claimRefs:proofRefs.map(x=>x.claimId)},
      claimRefs:proofRefs,permission:'not_evaluated',mailboxVerified:false});
  }
  const currentSnapshot=Array.isArray(campaign.audience_snapshot)?campaign.audience_snapshot:[];
  const merged=new Map(currentSnapshot.map(item=>[item.accountId,item]));
  const updated=[];
  for(const result of results){
    if(!result.domain)continue;
    const item={accountId:result.accountId,candidateId:result.candidateId||null,email:result.email,domain:result.domain,status:result.status,
      reasons:result.reasons,emailEvidenceId:result.emailEvidenceId,emailSourceId:result.emailSourceId,claimRefs:result.claimRefs};
    updated.push(item);
    merged.set(result.accountId,item);
  }
  const snapshot=[...merged.values()].sort((a,b)=>String(a.accountId).localeCompare(String(b.accountId)));
  const changed=canonicalJson(JSON.parse(JSON.stringify(snapshot)))!==canonicalJson(currentSnapshot);
  const qualificationVersion=Number(campaign.version)+(changed?1:0);
  if(changed)await client.query(`UPDATE astra.campaigns SET audience_snapshot=$3::jsonb,version=version+1,updated_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,campaignId,JSON.stringify(snapshot)]);
  if(changed)await emit(client,actor,'campaign.qualified',campaignId,{qualificationVersion,accountCount:updated.length,
    fitCount:updated.filter(x=>x.status==='fit').length,changedAccountIds:updated.map(x=>x.accountId),qualifiedAccounts:updated,audienceSnapshot:snapshot});
  return {campaignId,results,fitCount:results.filter(x=>x.status==='fit').length,probability:null};
}

export async function recordAstraVerificationEvidence(client, actor, campaignId, input) {
  if (!isObject(input) || Object.keys(input).some(key=>!['candidateId','source','classification','expiresAt','evidenceId','note'].includes(key))) fail('Verification evidence accepts only candidate, source, classification, expiry and evidence reference.');
  const candidateId=asUuid(input.candidateId,'candidateId'); const evidenceId=asUuid(input.evidenceId,'evidenceId');
  const source=clean(input.source,'source',120); const note=clean(input.note,'note',1000);
  const allowed=new Set(['unknown','catch_all','stale','invalid','manual_review_pending']);
  if(!allowed.has(input.classification)) fail('No approved positive mailbox verifier is configured; positive delivery classifications cannot be entered here.',409,'verification_adapter_unavailable');
  const expiry=new Date(input.expiresAt); if(!Number.isFinite(expiry.valueOf())||expiry.valueOf()<=Date.now()) fail('expiresAt must be a future timestamp.');
  const lookup=await client.query(`SELECT c.id,c.normalized_value,e.id AS evidence_id,e.extracted_emails FROM astra.research_identity_candidates c
    JOIN astra.research_evidence e ON (e.tenant_id,e.id)=(c.tenant_id,c.evidence_id) WHERE c.tenant_id=$1 AND c.id=$2::uuid AND e.id=$3::uuid`,[actor.tenantId,candidateId,evidenceId]);
  if(!lookup.rowCount || !lookup.rows[0].extracted_emails?.some(value=>String(value).toLowerCase()===lookup.rows[0].normalized_value)) fail('Evidence must be a same-tenant captured source that literally contains this candidate address.',409,'verification_evidence_mismatch');
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId);
  const currentAudience=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  if(!currentAudience?.rows.some(item=>item.candidate_id===candidateId&&item.current)) fail('Candidate is not in the current campaign audience.',404,'campaign_candidate_not_found');
  const id=randomUUID();
  await client.query(`INSERT INTO astra.campaign_verification_records(tenant_id,id,campaign_id,candidate_id,evidence_id,source,classification,expires_at,note,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[actor.tenantId,id,campaignId,candidateId,evidenceId,source,input.classification,expiry.toISOString(),note,String(actor.userId)]);
  return {id,campaignId,candidateId,evidenceId,source,classification:input.classification,expiresAt:expiry.toISOString(),eligible:false};
}

export async function saveAstraCampaignDraft(client, actor, legacyDb, campaignId, input) {
  if(!isObject(input)||Object.keys(input).some(key=>!['expectedVersion','subject','body','claimsMap'].includes(key))
    ||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1) fail('Draft requires expectedVersion, subject, body and template mappings.');
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId); if(!campaign) fail('Campaign was not found.',404,'campaign_not_found');
  if(Number(campaign.version)!==input.expectedVersion)fail('The campaign changed since this draft was loaded.',409,'draft_version_conflict');
  const offer=getApprovedOffer(legacyDb,actor,campaign.offer_version_id);
  if(offer.contentHash!==campaign.offer_content_hash) fail('The approved offer changed; this campaign snapshot is stale.',409,'offer_snapshot_changed');
  if(typeof input.subject!=='string'||input.subject.length>100||/[\r\n\u0000-\u001f\u007f]/.test(input.subject))fail('subject must be printable single-line text of at most 100 characters.');
  const subject=input.subject;
  if(typeof input.body!=='string'||!input.body.trim()||input.body.trim().length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body))fail('body must be text of at most 4,000 printable characters.');
  const body=input.body;
  const draftValidation=await validateAstraCopyDraft(client,{tenantId:actor.tenantId,campaign,subject,body,claimsMap:input.claimsMap});
  const savedMap=[{kind:'copy_validation',schemaVersion:1,status:draftValidation.status,eligible:draftValidation.eligible,
    reasons:draftValidation.reasons,subjectHash:sha256(subject),bodyHash:sha256(body),proofs:draftValidation.proofs},...draftValidation.mappings];
  const copyHash=sha256(canonicalJson({subject,body,claimsMap:savedMap,offerVersionId:Number(campaign.offer_version_id),offerContentHash:campaign.offer_content_hash}));
  const changed=await client.query(`UPDATE astra.campaigns SET subject=$3,body=$4,claims_map=$5::jsonb,copy_hash=$6,copy_version=copy_version+1,version=version+1,updated_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid AND version=$7 RETURNING id,copy_version AS "copyVersion",copy_hash AS "copyHash",version,subject,body,claims_map AS "claimsMap",state`,[actor.tenantId,campaignId,subject,body,JSON.stringify(savedMap),copyHash,input.expectedVersion]);
  if(!changed.rowCount)fail('The campaign changed while this draft was being saved.',409,'draft_version_conflict');
  await emit(client,actor,'campaign.draft_saved',campaignId,{copyHash,copyVersion:changed.rows[0].copyVersion});
  return {...changed.rows[0],validation:{status:draftValidation.status,eligible:draftValidation.eligible,reasons:draftValidation.reasons,proofs:draftValidation.proofs}};
}

export async function approveAstraCampaign(client, actor, legacyDb, campaignId, input) {
  if(!['owner','admin'].includes(actor.tenantRole)) fail('Only tenant owners and admins can approve a campaign.',403,'campaign_approval_forbidden');
  if(!isObject(input)||Object.keys(input).some(key=>!['expectedVersion','expiresAt'].includes(key))
    ||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1) fail('Approval requires expectedVersion and expiresAt.');
  await client.query('SELECT id FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE',[actor.tenantId,campaignId]);
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId); if(!campaign) fail('Campaign was not found.',404,'campaign_not_found');
  if(Number(campaign.version)!==input.expectedVersion)fail('The campaign changed since this review was loaded.',409,'campaign_version_conflict');
  if(!campaign.subject||!campaign.body||!campaign.copy_hash) fail('A validated draft is required before approval.',409,'campaign_draft_required');
  const offer=getApprovedOffer(legacyDb,actor,campaign.offer_version_id); if(offer.contentHash!==campaign.offer_content_hash) fail('Offer changed after campaign snapshot.',409,'offer_snapshot_changed');
  const proofBlockers=[...await currentCopyBlockers(client,actor,campaign),...await currentQualificationBlockers(client,actor,campaignId)];
  if(proofBlockers.length)fail('Current research proof or copy support is stale.',409,'campaign_proof_stale');
  const currentAudience=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  const fitCount=(currentAudience?.rows||[]).filter(row=>row.current).length;
  if(!fitCount)fail('At least one currently qualified audience member is required before approval.',409,'campaign_audience_empty');
  if(fitCount>Number(offer.content.capacity))fail('The current audience exceeds approved offer capacity.',409,'offer_capacity_exceeded');
  const expiresAt=new Date(input.expiresAt); if(!Number.isFinite(expiresAt.valueOf())||expiresAt.valueOf()<=Date.now()||expiresAt.valueOf()>Date.now()+90*24*60*60*1000) fail('Approval expiry must be within the next 90 days.');
  const approvalHash=campaignHash(campaign);
  const id=randomUUID();
  await client.query(`INSERT INTO astra.campaign_approvals(tenant_id,id,campaign_id,campaign_version,approval_hash,offer_version_id,offer_content_hash,copy_hash,expires_at,approved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[actor.tenantId,id,campaignId,campaign.version,approvalHash,campaign.offer_version_id,campaign.offer_content_hash,campaign.copy_hash,expiresAt.toISOString(),String(actor.userId)]);
  await emit(client,actor,'campaign.approved',campaignId,{approvalId:id,approvalHash,expiresAt:expiresAt.toISOString()});
  return {id,campaignId,campaignVersion:Number(campaign.version),approvalHash,expiresAt:expiresAt.toISOString(),approvedBy:String(actor.userId),immutable:true};
}

export async function listAstraCampaignApprovals(client, tenantId, campaignId) {
  const campaign=await getAstraCampaign(client,tenantId,campaignId); if(!campaign)return null;
  const currentHash=campaignHash(campaign);
  const proofBlockers=[...await currentCopyBlockers(client,{tenantId},campaign),...await currentQualificationBlockers(client,{tenantId},campaignId)];
  const rows=await client.query(`SELECT id,campaign_version AS "campaignVersion",approval_hash AS "approvalHash",offer_version_id AS "offerVersionId",
    offer_content_hash AS "offerContentHash",copy_hash AS "copyHash",expires_at AS "expiresAt",approved_by AS "approvedBy",created_at AS "createdAt"
    FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid ORDER BY created_at DESC`,[tenantId,campaignId]);
  return rows.rows.map(row=>({...row,current:!proofBlockers.length&&row.approvalHash===currentHash&&new Date(row.expiresAt).valueOf()>Date.now()}));
}

export async function prepareAstraOfflineDispatchPlan(client, actor, legacyDb, campaignId, input) {
  if(!isObject(input)||Object.keys(input).some(key=>key!=='idempotencyKey')) fail('Dispatch planning accepts only an idempotencyKey.');
  const key=clean(input.idempotencyKey,'idempotencyKey',200);
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId); if(!campaign)fail('Campaign was not found.',404,'campaign_not_found');
  const prior=await client.query('SELECT id,plan_hash,plan FROM astra.campaign_dispatch_plans WHERE tenant_id=$1 AND campaign_id=$2::uuid AND idempotency_key=$3',[actor.tenantId,campaignId,key]);
  if(prior.rowCount){
    const current=await validatePersistedAstraCopy(client,{tenantId:actor.tenantId,campaign});
    return {...prior.rows[0].plan,duplicate:true,id:prior.rows[0].id,planHash:prior.rows[0].plan_hash,
      historyOnly:true,currentPlanEligible:false,currentValidation:{status:current.status,eligible:current.eligible,reasons:current.reasons},
      currentBlockers:current.eligible?[]:['copy_validation_stale']};
  }
  const offer=getApprovedOffer(legacyDb,actor,campaign.offer_version_id); const approvalHash=campaignHash(campaign);
  const approvals=await client.query(`SELECT id,approval_hash,expires_at FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid AND approval_hash=$3 AND expires_at>now() ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,campaignId,approvalHash]);
  const blockers=[]; if(!approvals.rowCount)blockers.push('current_approval_missing_or_expired');
  if(offer.contentHash!==campaign.offer_content_hash)blockers.push('offer_snapshot_changed');
  blockers.push(...await currentCopyBlockers(client,actor,campaign));
  const mailbox=(await client.query('SELECT id,provider,configuration_status,capability_evidence FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid',[actor.tenantId,campaign.mailbox_id])).rows[0];
  if(!mailbox)blockers.push('mailbox_missing');
  if(!mailbox||mailbox.configuration_status!=='verified'||mailbox.provider==='manual'||mailbox.capability_evidence?.send!=='verified')blockers.push('mailbox_send_capability_unknown');
  // This release has no transport adapter. A runtime flag cannot create one.
  blockers.push('live_dispatch_disabled');
  const currentAudience=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  const audience={rows:currentAudience?.rows||[]};
  if(audience.rows.filter(row=>row.current).length>Number(offer.content.capacity))blockers.push('offer_capacity_exceeded');
  const items=[];
  for(const recipient of audience.rows){
    const reasons=[];
    if(!recipient.current)reasons.push('qualification_blocked');
    if(recipient.reasons?.some(reason=>['qualification_proof_stale','contact_source_rights_revoked'].includes(reason)))reasons.push('qualification_proof_stale');
    if(!await copyAppliesToDomain(client,actor,campaign,recipient.normalized_domain))reasons.push('copy_claims_belong_to_another_account');
    const verification=await client.query(`SELECT classification,expires_at FROM astra.campaign_verification_records WHERE tenant_id=$1 AND campaign_id=$2::uuid AND candidate_id=$3::uuid ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,campaignId,recipient.candidate_id]);
    if(!verification.rowCount||verification.rows[0].classification!=='verified'||new Date(verification.rows[0].expires_at).valueOf()<=Date.now())reasons.push('mailbox_verification_unknown');
    const permission=await evaluateAstraPermission(client,actor,{recipient:recipient.email,domain:recipient.normalized_domain,purpose:campaign.purpose});
    if(!permission.allowed)reasons.push(permission.reason==='suppressed'?'suppressed':'permission_missing_or_expired');
    const eligibilityHash=sha256(canonicalJson({campaignId,campaignVersion:Number(campaign.version),approvalHash,offerContentHash:campaign.offer_content_hash,copyHash:campaign.copy_hash,recipient:recipient.email,claimRefs:recipient.claimRefs}));
    items.push({accountId:recipient.account_id,candidateId:recipient.candidate_id,email:recipient.email,domain:recipient.normalized_domain,eligibilityHash,permission:permission.reason,blockers:reasons});
  }
  if(items.some(item=>item.blockers.includes('qualification_proof_stale')))blockers.push('qualification_proof_stale');
  const planPayload={campaignId,campaignVersion:Number(campaign.version),approvalHash,offerContentHash:campaign.offer_content_hash,copyHash:campaign.copy_hash,mailboxId:campaign.mailbox_id,
    status:'offline_only',liveTransport:'disabled',blockers:[...new Set(blockers)],items,preparedAt:nowIso()};
  const planHash=sha256(canonicalJson(planPayload));
  const id=randomUUID();
  await client.query(`INSERT INTO astra.campaign_dispatch_plans(tenant_id,id,campaign_id,idempotency_key,plan_hash,plan,created_by)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[actor.tenantId,id,campaignId,key,planHash,JSON.stringify(planPayload),String(actor.userId)]);
  await emit(client,actor,'campaign.dispatch_plan_prepared',campaignId,{planId:id,planHash,itemCount:items.length,liveTransport:'disabled'});
  return {id,...planPayload,planHash,duplicate:false};
}

export async function listAstraDispatchPlans(client,tenantId,campaignId) {
  const result=await client.query(`SELECT p.id,p.idempotency_key AS "idempotencyKey",p.plan_hash AS "planHash",p.plan,p.created_at AS "createdAt",
      c.id AS "claimId",c.state AS "claimState",c.blockers AS "claimBlockers",c.fence AS "claimFence"
    FROM astra.campaign_dispatch_plans p LEFT JOIN astra.campaign_dispatch_claims c ON (c.tenant_id,c.plan_id)=(p.tenant_id,p.id)
    WHERE p.tenant_id=$1 AND p.campaign_id=$2::uuid ORDER BY p.created_at DESC LIMIT 50`,[tenantId,campaignId]);
  return result.rows;
}

/** Persist a single fenced claim record, then quarantine it before any transport. */
export async function claimAstraOfflineDispatchPlan(client,actor,legacyDb,campaignId,planId,input) {
  if(!isObject(input)||Object.keys(input).some(key=>key!=='idempotencyKey'))fail('Dispatch claim accepts only an idempotencyKey.');
  const key=clean(input.idempotencyKey,'idempotencyKey',200);
  const prior=await client.query(`SELECT id,idempotency_key AS "idempotencyKey",fence,claim_token AS "claimToken",state,blockers,created_at AS "createdAt"
    FROM astra.campaign_dispatch_claims WHERE tenant_id=$1 AND plan_id=$2::uuid`,[actor.tenantId,planId]);
  if(prior.rowCount){
    if(prior.rows[0].idempotencyKey!==key)fail('A dispatch plan already has a durable claim and cannot be claimed again.',409,'dispatch_plan_already_claimed');
    return {...prior.rows[0],duplicate:true};
  }
  const keyUse=await client.query(`SELECT plan_id FROM astra.campaign_dispatch_claims WHERE tenant_id=$1 AND campaign_id=$2::uuid AND idempotency_key=$3`,[actor.tenantId,campaignId,key]);
  if(keyUse.rowCount)fail('Dispatch claim idempotency key is already bound to another plan.',409,'dispatch_idempotency_conflict');
  const planResult=await client.query(`SELECT id,campaign_id,plan_hash,plan FROM astra.campaign_dispatch_plans WHERE tenant_id=$1 AND campaign_id=$2::uuid AND id=$3::uuid`,[actor.tenantId,campaignId,planId]);
  if(!planResult.rowCount)fail('Dispatch plan was not found.',404,'dispatch_plan_not_found');
  const planRow=planResult.rows[0]; const storedPlan=planRow.plan;
  const campaign=await getAstraCampaign(client,actor.tenantId,campaignId); if(!campaign)fail('Campaign was not found.',404,'campaign_not_found');
  const blockers=new Set(storedPlan.blockers||[]);
  if(campaignHash(campaign)!==storedPlan.approvalHash)blockers.add('campaign_changed_after_plan');
  if(campaign.copy_hash!==storedPlan.copyHash)blockers.add('copy_hash_changed');
  for(const blocker of await currentCopyBlockers(client,actor,campaign))blockers.add(blocker);
  try {
    const offer=getApprovedOffer(legacyDb,actor,campaign.offer_version_id);
    if(offer.contentHash!==campaign.offer_content_hash)blockers.add('offer_snapshot_changed');
  } catch { blockers.add('offer_policy_or_proof_unavailable'); }
  const approval=await client.query(`SELECT 1 FROM astra.campaign_approvals WHERE tenant_id=$1 AND campaign_id=$2::uuid AND approval_hash=$3 AND expires_at>now()`,[actor.tenantId,campaignId,campaignHash(campaign)]);
  if(!approval.rowCount)blockers.add('current_approval_missing_or_expired');
  const mailbox=(await client.query('SELECT configuration_status,capability_evidence,provider FROM astra.mailboxes WHERE tenant_id=$1 AND id=$2::uuid',[actor.tenantId,campaign.mailbox_id])).rows[0];
  if(!mailbox||mailbox.configuration_status!=='verified'||mailbox.provider==='manual'||mailbox.capability_evidence?.send!=='verified')blockers.add('mailbox_send_capability_unknown');
  // Re-run every recipient permission/suppression and verification check under
  // this claim transaction. No external verification or transport is called.
  const currentAudience=await readCurrentAstraCampaignAudience(client,actor.tenantId,campaignId);
  const audienceCount=(currentAudience?.rows||[]).filter(item=>item.current).length;
  try { const offer=getApprovedOffer(legacyDb,actor,campaign.offer_version_id); if(audienceCount>Number(offer.content.capacity))blockers.add('offer_capacity_exceeded'); }
  catch { blockers.add('offer_policy_or_proof_unavailable'); }
  for(const item of (storedPlan.items||[])){
    if(item.email){
      if(!await copyAppliesToDomain(client,actor,campaign,item.domain||''))blockers.add('copy_claims_belong_to_another_account');
      const currentQualification=(currentAudience?.rows||[]).find(row=>row.account_id===item.accountId);
      if(!currentQualification||!currentQualification.current||currentQualification.candidate_id!==item.candidateId)
        blockers.add('qualification_proof_stale');
      const permission=await evaluateAstraPermission(client,actor,{recipient:item.email,domain:item.domain||null,purpose:campaign.purpose});
      if(!permission.allowed)blockers.add(permission.reason==='suppressed'?'suppressed':'permission_missing_or_expired');
      const verification=await client.query(`SELECT classification,expires_at FROM astra.campaign_verification_records WHERE tenant_id=$1 AND campaign_id=$2::uuid AND candidate_id=$3::uuid ORDER BY created_at DESC LIMIT 1`,[actor.tenantId,campaignId,item.candidateId]);
      if(!verification.rowCount||verification.rows[0].classification!=='verified'||new Date(verification.rows[0].expires_at).valueOf()<=Date.now())blockers.add('mailbox_verification_unknown');
    } else blockers.add('literal_contact_address_missing');
  }
  blockers.add('live_dispatch_disabled');
  const list=[...blockers].sort(); const id=randomUUID(); const token=randomUUID();
  const inserted=await client.query(`INSERT INTO astra.campaign_dispatch_claims(tenant_id,id,campaign_id,plan_id,idempotency_key,fence,claim_token,state,blockers,claimed_by)
    VALUES($1,$2,$3,$4,$5,1,$6,'quarantined',$7::jsonb,$8)
    RETURNING id,idempotency_key AS "idempotencyKey",fence,claim_token AS "claimToken",state,blockers,created_at AS "createdAt"`,
  [actor.tenantId,id,campaignId,planId,key,token,JSON.stringify(list),String(actor.userId)]);
  await emit(client,actor,'campaign.dispatch_quarantined',campaignId,{planId,claimId:id,fence:1,blockers:list});
  return {...inserted.rows[0],duplicate:false,transport:'disabled'};
}
