import { createHash, randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { createAstraReplyTask } from './astra-reply-tasks.js';
import { getAstraCampaign, saveAstraCampaignDraft } from './astra-campaigns.js';
import { validateOfferVersionForUse } from './offer-contracts.js';
import { evaluateOfferModelEgress } from './offer-policy.js';
import { getAstraGlmTaskSpec, runAstraGenerationTask } from './astra-glm-gateway.js';
import { GLM_ACTUAL_MODEL, GLM_ACTUAL_PROVIDER, GLM_ENDPOINT, GLM_MODEL, GLM_PROVIDER, minimizeGlmInput } from './astra-egress.js';
import { assertAstraReceiptTelemetryReady } from './astra-usage.js';
import { readCurrentAstraCampaignAudience } from './astra-campaign-audience.js';
import { resolveCurrentResearchClaims } from './astra-current-claims.js';

const fail = (message, statusCode = 400, code = 'generation_invalid') => {
  throw new AstraTenantContextError(message, statusCode, code);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_MAP_VERSION = 1;
const MAX_CLAIMS = 30;
const ACTIVE = "state IN ('queued','running','uncertain','completed')";

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function iso(value) { return value instanceof Date ? value.toISOString() : value == null ? null : new Date(value).toISOString(); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function assertActor(actor, tenantId) {
  if (!actor?.tenantId || actor.tenantId.toLowerCase() !== String(tenantId).toLowerCase()
    || !/^[1-9][0-9]{0,39}$/.test(String(actor.userId || ''))
    || !['owner','admin','operator','reviewer'].includes(actor.tenantRole)) {
    fail('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
}
function idempotency(value, task, subjectId) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('An 8–120 character idempotency key is required.', 400, 'generation_idempotency_invalid');
  }
  return `${task}:${subjectId}:${value.trim()}`;
}
function boundedBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'idempotencyKey')) fail('Generation accepts only an idempotencyKey.');
}
function placeholder(index, kind = 'FACT') { return `{{${kind}_${index}}}`; }
function placeholderDigest(task,mapping) {
  const values=Object.keys(mapping).filter(key=>key!=='__campaignVersion').sort().map(key=>{
    const item=mapping[key];
    return task==='campaign_generation'
      ? {key,valueHash:sha256(item.value),claimId:item.claimId||null,kind:item.kind}
      : {key,valueHash:sha256(item)};
  });
  if(task==='campaign_generation'&&Number.isSafeInteger(mapping.__campaignVersion))values.push({campaignVersion:mapping.__campaignVersion});
  return sha256(canonical(values));
}

function currentOffer(legacyDb, actor, campaign) {
  if (!legacyDb) fail('Offer policy storage is unavailable; generation is blocked.', 503, 'offer_policy_unavailable');
  const offer = validateOfferVersionForUse(legacyDb, Number(campaign.offer_version_id));
  const ownership = legacyDb.prepare(`SELECT ownership.tenant_id FROM offer_versions versions
    JOIN offer_tenant_ownership ownership ON ownership.offer_id=versions.offer_id WHERE versions.id=?`).get(Number(campaign.offer_version_id));
  if (!offer.ok || offer.contentHash !== campaign.offer_content_hash
    || String(ownership?.tenant_id || '').toLowerCase() !== String(actor.tenantId).toLowerCase()) {
    fail('The campaign offer is no longer approved for this tenant.', 409, 'offer_snapshot_changed');
  }
  const egress = evaluateOfferModelEgress(offer.content, 'glm-5.3-api');
  if (!egress.ok) fail(`Offer egress is blocked: ${egress.blockers[0]}.`, 403, 'offer_policy_denied');
  return offer;
}

export async function currentAstraCampaignClaims(client, tenantId, campaignId) {
  const audience=await readCurrentAstraCampaignAudience(client,tenantId,campaignId);
  const claimRefs=(audience?.rows||[]).filter(row=>row.current).flatMap(row=>row.claim_refs||[]);
  const ids=[...new Set(claimRefs.map(ref=>ref.claimId).filter(Boolean))];
  if (!ids.length) return [];
  const current=await resolveCurrentResearchClaims(client,{tenantId,claimIds:ids});
  return current.filter(ref=>ref.valid).map(ref=>({id:ref.claimId,evidence_id:ref.proof.evidenceId,
    content_sha256:ref.proof.contentSha256,claim_value:ref.value,predicate:ref.predicate,expires_at:ref.expiresAt,
    rights_expires_at:ref.proof.rightsExpiresAt})).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,MAX_CLAIMS);
}

async function campaignRequest(client, actor, legacyDb, campaignId) {
  if (!UUID.test(String(campaignId))) fail('campaignId is invalid.');
  const campaign = await getAstraCampaign(client, actor.tenantId, campaignId);
  if (!campaign) fail('Campaign was not found.', 404, 'campaign_not_found');
  if (campaign.state !== 'draft') fail('AI campaign generation is available only for draft campaigns.', 409, 'campaign_not_editable');
  const offer = currentOffer(legacyDb, actor, campaign);
  const rows = await currentAstraCampaignClaims(client,actor.tenantId,campaign.id);
  if (!rows.length) fail('Current supported campaign claims are required before generation.', 409, 'campaign_claims_missing');
  const mapping = {};
  const claimMetadata = [];
  const claimInputs = rows.map((row, index) => {
    const key = placeholder(index + 1);
    const value = row.claim_value;
    mapping[key] = { value, claimId: row.id, kind: 'claim' };
    claimMetadata.push({ claimId: row.id, evidenceId: row.evidence_id, evidenceHash: row.content_sha256,
      claimHash: sha256(String(value)), predicate: row.predicate, expiresAt: iso(row.expires_at),
      sourceRightsExpiresAt: iso(row.rights_expires_at) });
    return { claimId: row.id, predicate: row.predicate, supportedFact: key };
  });
  const content = offer.content;
  const approvedOffer = {};
  const offerValues = { service:content.service,scope:content.scope,capacity:content.capacity,
    geography:content.geography,
    priceMin:content.price ? `${content.price.currency} ${(content.price.minMinor/100).toFixed(2)}` : undefined,
    priceMax:content.price ? `${content.price.currency} ${(content.price.maxMinor/100).toFixed(2)}` : undefined };
  for (const [field,value] of Object.entries(offerValues)) {
    if (value === undefined || value === null) continue;
    const key = placeholder(Object.keys(mapping).length + 1, 'OFFER');
    mapping[key] = { value: typeof value === 'object' ? JSON.stringify(value) : String(value), kind: 'offer' };
    approvedOffer[field] = key;
  }
  // This snapshot is stored with the private placeholder map and included in
  // its integrity hash; it is never sent to the provider as prompt input.
  mapping.__campaignVersion=Number(campaign.version);
  const input = { purpose: campaign.purpose, approvedOffer, claims: claimInputs,
    instruction: 'Draft a single email using only supplied fact placeholders and approved offer placeholders. Return the exact placeholders in copy and map each sentence to its supplied claim IDs. Do not add unsupported claims, prices, promises, recipient selection, or actions.' };
  const safeInput = minimizeGlmInput(input, 'private');
  const inputHash = sha256(canonical(safeInput));
  const provenance = claimMetadata.sort((a,b) => a.claimId.localeCompare(b.claimId));
  const evidenceHash = sha256(canonical({ campaignId: campaign.id, copyVersion: Number(campaign.copy_version),
    offerVersionId: Number(campaign.offer_version_id), offerHash: campaign.offer_content_hash, claims: provenance }));
  const placeholderHash = placeholderDigest('campaign_generation',mapping);
  return { campaign, offer, provenance, mapping, safeInput, inputHash, evidenceHash, placeholderHash };
}

function piiPlaceholders(text) {
  const map = {};
  let index = 0;
  const redacted = String(text).slice(0, 12000)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, value => { const key = placeholder(++index, 'PRIVATE'); map[key] = value; return key; })
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, value => { const key = placeholder(++index, 'PRIVATE'); map[key] = value; return key; })
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, value => { const key = placeholder(++index, 'PRIVATE'); map[key] = value; return key; });
  return { redacted, map };
}

async function replyRequest(client, actor, messageId) {
  if (!UUID.test(String(messageId))) fail('messageId is invalid.');
  // Existing deterministic classification and opt-out suppression always run first.
  const deterministic = await createAstraReplyTask(client, actor, messageId);
  if (deterministic.stop) return { deterministic, job: null };
  const row = (await client.query(`SELECT id,subject,body_text,content_hash FROM astra.inbox_messages
    WHERE tenant_id=$1 AND id=$2::uuid`, [actor.tenantId, messageId])).rows[0];
  if (!row) fail('Message was not found.', 404, 'message_not_found');
  const subject = piiPlaceholders(row.subject || '');
  const content = piiPlaceholders(row.body_text || '');
  const mapping = { ...subject.map, ...content.map };
  const input = { deterministicIntent: deterministic.classification,
    subject: subject.redacted, replyText: content.redacted,
    instruction: 'Classify this reply and propose a next action or response for human review only. Never execute a task, suppress, unsuppress, send, or change campaign status.' };
  const safeInput = minimizeGlmInput(input, 'private');
  const inputHash = sha256(canonical(safeInput));
  return { deterministic, row, mapping, safeInput, inputHash,
    evidenceHash: sha256(canonical({ messageId: row.id, contentHash: row.content_hash, deterministic: deterministic.classification })),
    placeholderHash: placeholderDigest('reply_classification',mapping) };
}

async function reserveJob(client, { tenantId, actor, task, idempotencyKey: key, campaign, reply, provenance, mapping,
  safeInput, inputHash, evidenceHash, placeholderHash }) {
  let telemetryReady = true;
  try { await assertAstraReceiptTelemetryReady(client, 'generation_jobs'); }
  catch { telemetryReady = false; }
  const duplicate = await client.query(`SELECT id,state,reserved_microusd FROM astra.generation_jobs
    WHERE tenant_id=$1 AND idempotency_key=$2`, [tenantId, key]);
  if (duplicate.rowCount) return { ...duplicate.rows[0], requestId:duplicate.rows[0].id, duplicate: true, reservedMicrousd: Number(duplicate.rows[0].reserved_microusd) };
  const globalResult = await client.query(`SELECT enabled,daily_budget_microusd,breaker_state,breaker_open_until
    FROM astra.ai_global_limits WHERE singleton=true FOR UPDATE`);
  const policyResult = await client.query(`SELECT enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens
    FROM astra.generation_tenant_policies WHERE tenant_id=$1 FOR UPDATE`, [tenantId]);
  const serializedDuplicate = await client.query(`SELECT id,state,reserved_microusd FROM astra.generation_jobs
    WHERE tenant_id=$1 AND idempotency_key=$2`, [tenantId, key]);
  if (serializedDuplicate.rowCount) return { ...serializedDuplicate.rows[0], requestId:serializedDuplicate.rows[0].id, duplicate: true, reservedMicrousd: Number(serializedDuplicate.rows[0].reserved_microusd) };
  const policy = policyResult.rows[0];
  const global = globalResult.rows[0];
  if (!policy?.enabled || !policy.allowed_tasks?.includes(task)) fail('Tenant generation policy does not allow this task.', 403, 'generation_policy_denied');
  if (!global?.enabled || Number(global.daily_budget_microusd) < 1) fail('The global GLM budget is disabled.', 503, 'generation_global_budget_disabled');
  if (global.breaker_state === 'open' && new Date(global.breaker_open_until || 0).getTime() > Date.now()) fail('The GLM circuit breaker is open.', 503, 'generation_circuit_open');
  const spec = getAstraGlmTaskSpec(task);
  const inputBound = Buffer.byteLength(JSON.stringify(safeInput), 'utf8') + 1024;
  const inputLimit = Number(policy.max_input_tokens);
  const outputLimit = Math.min(Number(policy.max_output_tokens), spec.maxOutputTokens);
  if (inputBound > inputLimit || outputLimit < 1) fail('Generation exceeds the tenant token ceiling.', 413, 'generation_token_limit');
  const dailyLimit = `created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const [tenantUsage, generationUsage, globalUsage] = await Promise.all([
    client.query(`SELECT COALESCE(SUM(reserved_microusd),0)::bigint AS used FROM astra.generation_jobs
      WHERE tenant_id=$1 AND ${dailyLimit} AND ${ACTIVE}`, [tenantId]),
    client.query('SELECT astra.ai_global_reserved_today() AS used'),
    client.query('SELECT astra.generation_reserved_today() AS used'),
  ]);
  const reserve = BigInt(policy.reservation_microusd);
  if (reserve < 1n || BigInt(tenantUsage.rows[0].used) + reserve > BigInt(policy.daily_budget_microusd)) fail('Tenant generation budget is exhausted.', 429, 'generation_tenant_budget_exhausted');
  if (BigInt(globalUsage.rows[0].used) + BigInt(generationUsage.rows[0].used) + reserve > BigInt(global.daily_budget_microusd)) fail('Global GLM budget is exhausted.', 429, 'generation_global_budget_exhausted');
  const jobId = randomUUID();
  const insertValues = [tenantId,jobId,task,campaign?.id || null,reply?.id || null,
    campaign ? Number(campaign.copy_version) : null,campaign ? Number(campaign.offer_version_id) : null,
    campaign?.offer_content_hash || null,reply?.content_hash || null,JSON.stringify(provenance || []),evidenceHash,
    CLAIM_MAP_VERSION,placeholderHash,JSON.stringify(mapping),JSON.stringify(safeInput),inputHash,key,String(reserve),String(actor.userId)];
  const inserted = telemetryReady
    ? await client.query(`INSERT INTO astra.generation_jobs(
        tenant_id,id,task,campaign_id,reply_message_id,campaign_copy_version,offer_version_id,offer_content_hash,
        reply_content_hash,claim_provenance,evidence_hash,placeholder_version,placeholder_hash,placeholder_map,
        input_payload,input_hash,idempotency_key,reserved_microusd,actual_provider,actual_model,reasoning_tokens,
        provider_quota,actual_cost_source,response_verified,accounting_status,created_by)
      VALUES($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,
        NULL,NULL,NULL,NULL,NULL,false,'pending',$19)
      RETURNING id,state,reserved_microusd`, insertValues)
    : await client.query(`INSERT INTO astra.generation_jobs(
        tenant_id,id,task,campaign_id,reply_message_id,campaign_copy_version,offer_version_id,offer_content_hash,
        reply_content_hash,claim_provenance,evidence_hash,placeholder_version,placeholder_hash,placeholder_map,
        input_payload,input_hash,idempotency_key,reserved_microusd,created_by)
      VALUES($1,$2,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19)
      RETURNING id,state,reserved_microusd`, insertValues);
  return { ...inserted.rows[0], requestId:inserted.rows[0].id, duplicate: false, reservedMicrousd: Number(inserted.rows[0].reserved_microusd) };
}

export async function createAstraCampaignGenerationJob(client, actor, legacyDb, campaignId, input) {
  assertActor(actor, actor.tenantId); boundedBody(input);
  const request = await campaignRequest(client, actor, legacyDb, campaignId);
  const key = idempotency(input.idempotencyKey, 'campaign_generation', campaignId.toLowerCase());
  return reserveJob(client, { tenantId: actor.tenantId, actor, task: 'campaign_generation', idempotencyKey: key,
    campaign: request.campaign, provenance: request.provenance, mapping: request.mapping,
    safeInput: request.safeInput, inputHash: request.inputHash, evidenceHash: request.evidenceHash, placeholderHash: request.placeholderHash });
}

export async function createAstraReplyGenerationJob(client, actor, messageId, input) {
  assertActor(actor, actor.tenantId);
  const request = await replyRequest(client, actor, messageId);
  if (request.deterministic.stop) return { deterministic: request.deterministic, job: null };
  try {
    boundedBody(input);
    const key = idempotency(input.idempotencyKey, 'reply_classification', messageId.toLowerCase());
    const job = await reserveJob(client, { tenantId: actor.tenantId, actor, task: 'reply_classification', idempotencyKey: key,
      reply: request.row, mapping: request.mapping, provenance: [], safeInput: request.safeInput,
      inputHash: request.inputHash, evidenceHash: request.evidenceHash, placeholderHash: request.placeholderHash });
    return { deterministic: request.deterministic, job };
  } catch (error) {
    // Preserve the deterministic task and any existing suppression in the same
    // commit even when model policy or reservation rejects optional enrichment.
    if (error instanceof AstraTenantContextError) {
      return { deterministic:request.deterministic,job:null,generationUnavailable:error.code || 'generation_unavailable' };
    }
    throw error;
  }
}

export async function getAstraGenerationJob(client, tenantId, jobId) {
  if (!UUID.test(String(jobId))) fail('jobId is invalid.');
  let telemetryReady = true;
  try { await assertAstraReceiptTelemetryReady(client, 'generation_jobs'); }
  catch { telemetryReady = false; }
  const telemetryColumns = telemetryReady
    ? 'actual_provider,actual_model,reasoning_tokens,provider_quota,actual_cost_source,response_verified,accounting_status'
    : 'NULL::text AS actual_provider,NULL::text AS actual_model,NULL::integer AS reasoning_tokens,NULL::jsonb AS provider_quota,NULL::text AS actual_cost_source,NULL::boolean AS response_verified,NULL::text AS accounting_status';
  const result = await client.query(`SELECT id,task,campaign_id,reply_message_id,campaign_copy_version,offer_version_id,
      offer_content_hash,evidence_hash,placeholder_version,placeholder_hash,state,reserved_microusd,input_tokens,
      output_tokens,actual_cost_microusd,provider_request_id,result_payload,error_code,created_by,created_at,started_at,completed_at,${telemetryColumns}
    FROM astra.generation_jobs WHERE tenant_id=$1 AND id=$2::uuid`, [tenantId,jobId]);
  const row = result.rows[0];
  if (!row) return null;
  return { id:row.id,requestId:row.id,task:row.task,campaignId:row.campaign_id,replyMessageId:row.reply_message_id,
    campaignCopyVersion:row.campaign_copy_version === null ? null : Number(row.campaign_copy_version),
    offerVersionId:row.offer_version_id === null ? null : Number(row.offer_version_id), offerContentHash:row.offer_content_hash,
    evidenceHash:row.evidence_hash,placeholderVersion:Number(row.placeholder_version),placeholderHash:row.placeholder_hash,
    status:row.state,logical:{provider:GLM_PROVIDER,model:GLM_MODEL},
    actual:row.response_verified ? {provider:row.actual_provider,model:row.actual_model,endpoint:GLM_ENDPOINT} : null,
    responseStatus:row.response_verified ? 'verified' : 'unknown',
    accountingStatus:telemetryReady ? row.accounting_status : 'migration_required',receiptTelemetryReady:telemetryReady,
    actualProvider:row.actual_provider,actualModel:row.actual_model,reasoningTokens:row.reasoning_tokens,
    providerQuota:row.provider_quota,actualCostSource:row.actual_cost_source,responseVerified:row.response_verified === true,
    reservationMicrousd:Number(row.reserved_microusd),inputTokens:row.input_tokens,
    outputTokens:row.output_tokens,actualCostMicrousd:row.actual_cost_microusd === null ? null : Number(row.actual_cost_microusd),
    providerRequestId:row.provider_request_id,result:row.result_payload,errorCode:row.error_code,
    createdBy:row.created_by,createdAt:row.created_at,startedAt:row.started_at,completedAt:row.completed_at };
}

export async function cancelAstraGenerationJob(client, tenantId, jobId) {
  const result = await client.query(`UPDATE astra.generation_jobs SET state='cancelled',reserved_microusd=0,
      error_code='cancelled_before_dispatch',completed_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid AND state='queued' RETURNING id,state`, [tenantId,jobId]);
  if (!result.rowCount) fail('Only queued generation jobs can be cancelled.', 409, 'generation_job_not_cancellable');
  return { id:result.rows[0].id,status:result.rows[0].state };
}

async function currentCampaignEvidence(client, legacyDb, actor, job) {
  const campaign = await getAstraCampaign(client, actor.tenantId, job.campaign_id);
  if (!campaign || campaign.state !== 'draft' || Number(campaign.copy_version) !== Number(job.campaign_copy_version)
    || Number(campaign.offer_version_id) !== Number(job.offer_version_id) || campaign.offer_content_hash !== job.offer_content_hash) return false;
  let offer;
  try { offer = currentOffer(legacyDb, actor, campaign); } catch { return false; }
  const rows = await currentAstraCampaignClaims(client,actor.tenantId,campaign.id);
  const now = Date.now();
  const claims = rows.map(row => ({ claimId:row.id,evidenceId:row.evidence_id,evidenceHash:row.content_sha256,
    claimHash:sha256(String(row.claim_value)),predicate:row.predicate,expiresAt:iso(row.expires_at),
    sourceRightsExpiresAt:iso(row.rights_expires_at) })).sort((a,b)=>a.claimId.localeCompare(b.claimId));
  if (claims.some(row => new Date(row.expiresAt).valueOf() <= now
    || (row.sourceRightsExpiresAt && new Date(row.sourceRightsExpiresAt).valueOf() <= now))) return false;
  const hash = sha256(canonical({ campaignId:campaign.id,copyVersion:Number(campaign.copy_version),
    offerVersionId:Number(campaign.offer_version_id),offerHash:offer.contentHash,claims }));
  return hash === job.evidence_hash;
}

async function lockCampaignForGeneration(client, tenantId, job) {
  if (job.task !== 'campaign_generation') return true;
  const locked=await client.query(`SELECT id FROM astra.campaigns WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE`,
    [tenantId,job.campaign_id]);
  return locked.rowCount===1;
}

async function currentReplyEvidence(client, actor, job) {
  const row=(await client.query(`SELECT id,content_hash FROM astra.inbox_messages WHERE tenant_id=$1 AND id=$2::uuid`,
    [actor.tenantId,job.reply_message_id])).rows[0];
  if (!row || row.content_hash!==job.reply_content_hash) return false;
  // The current deterministic classifier and any resulting suppression run
  // again immediately before model work.
  const deterministic=await createAstraReplyTask(client,actor,row.id);
  return !deterministic.stop;
}

function expandPlaceholders(value, mapping) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(?:FACT|OFFER)_\d+\}\}/g, token => {
    const item = mapping[token];
    if (!item || typeof item.value !== 'string') fail('Generation referenced an unbound placeholder.', 502, 'generation_placeholder_invalid');
    return item.value;
  });
}

export function expandCampaignDraft(result, mapping) {
  const claimsMap = result.claimsMap.map(item => ({
    sentence: expandPlaceholders(item.sentence, mapping),
    claimIds: item.claimIds,
  }));
  const expectedVersion=Number(mapping?.__campaignVersion);
  return { ...(Number.isSafeInteger(expectedVersion)?{expectedVersion}:{}),
    subject:expandPlaceholders(result.subject,mapping),body:expandPlaceholders(result.body,mapping),claimsMap };
}

function unverifiedCampaignProposal(result,mapping) {
  return {...expandCampaignDraft(result,mapping),validation:{status:'unverified',eligible:false,
    reasons:['generated_copy_requires_source_template_review']}};
}

function blockedBeforeTransport(error) {
  return ['glm_local_preview_egress_denied','glm_egress_disabled','glm_credentials_unavailable','glm_approval_unavailable',
    'glm_approval_denied','glm_data_classification_denied','glm_input_minimization_required','glm_input_invalid',
    'glm_task_forbidden','offer_policy_denied','glm_receipt_schema_unavailable','ai_receipt_schema_unavailable'].includes(error?.code);
}

async function persistGenerationOutcome(db, tenantId, requestId, { job, state, errorCode = null, receipt = null, resultPayload = null, clearReservation = false }) {
  const receiptTelemetryReady = job?.receiptTelemetryReady !== false;
  const responseVerified = receipt?.responseVerified === true
    && receipt.actualProvider === GLM_ACTUAL_PROVIDER && receipt.actualModel === GLM_ACTUAL_MODEL;
  const actualCostMicrousd = Number.isSafeInteger(receipt?.actualCostMicrousd) && receipt.actualCostMicrousd >= 0
    && receipt.actualCostSource === 'provider_usage.cost_microusd' && responseVerified ? receipt.actualCostMicrousd : null;
  const inputTokens = responseVerified && Number.isSafeInteger(receipt.inputTokens) && receipt.inputTokens >= 0 ? receipt.inputTokens : null;
  const outputTokens = responseVerified && Number.isSafeInteger(receipt.outputTokens) && receipt.outputTokens >= 0 ? receipt.outputTokens : null;
  const reasoningTokens = responseVerified && Number.isSafeInteger(receipt.reasoningTokens) && receipt.reasoningTokens >= 0 ? receipt.reasoningTokens : null;
  const providerQuota = responseVerified && receipt.providerQuota && typeof receipt.providerQuota === 'object'
    ? JSON.stringify(receipt.providerQuota) : null;
  const actualCostSource = actualCostMicrousd === null ? null : 'provider_usage.cost_microusd';
  const originalReservation = Number(job.reserved_microusd);
  const reservedMicrousd = clearReservation ? 0
    : actualCostMicrousd === null ? originalReservation
      : state === 'completed' && actualCostMicrousd <= originalReservation ? actualCostMicrousd
        : Math.max(originalReservation, actualCostMicrousd);
  const accountingStatus = actualCostMicrousd !== null && actualCostMicrousd <= originalReservation ? 'settled'
    : state === 'blocked' || state === 'failed' || state === 'cancelled' ? 'not_submitted' : 'unknown';
  const safeErrorCode = typeof errorCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(errorCode) ? errorCode : null;
  if (!receiptTelemetryReady) {
    if (responseVerified || actualCostMicrousd !== null) throw new AstraTenantContextError(
      'Astra provider receipt migration 034 is required to persist verified provider metadata.', 503, 'generation_receipt_schema_unavailable');
    const legacyState = state === 'blocked' || state === 'failed' || state === 'cancelled' ? state : 'uncertain';
    const legacyReservation = clearReservation || legacyState !== 'uncertain' ? 0 : originalReservation;
    await db.query(`UPDATE astra.generation_jobs SET state=$3,reserved_microusd=$4,input_tokens=NULL,output_tokens=NULL,
        actual_cost_microusd=NULL,provider_request_id=NULL,result_payload=NULL,error_code=$5,completed_at=now()
      WHERE tenant_id=$1 AND id=$2::uuid`, [tenantId,requestId,legacyState,legacyReservation,
      safeErrorCode || 'generation_provider_receipt_migration_required']);
    return { accountingStatus:legacyState === 'uncertain' ? 'migration_required' : 'not_submitted',
      reservedMicrousd:legacyReservation,actualCostMicrousd:null,responseVerified:false,receiptTelemetryReady:false };
  }
  await db.query(`UPDATE astra.generation_jobs SET state=$3,reserved_microusd=$4,input_tokens=$5,output_tokens=$6,
      actual_cost_microusd=$7::bigint,provider_request_id=$8,result_payload=$9::jsonb,error_code=$10,
      actual_provider=$11,actual_model=$12,reasoning_tokens=$13,provider_quota=$14::jsonb,
      actual_cost_source=$15,response_verified=$16,accounting_status=$17,completed_at=now()
    WHERE tenant_id=$1 AND id=$2::uuid`, [tenantId,requestId,state,reservedMicrousd,inputTokens,outputTokens,
    actualCostMicrousd, responseVerified && typeof receipt.providerRequestId === 'string' ? receipt.providerRequestId.slice(0,200) : null,
    resultPayload === null ? null : JSON.stringify(resultPayload),safeErrorCode,
    responseVerified ? receipt.actualProvider : null,responseVerified ? receipt.actualModel : null,reasoningTokens,providerQuota,
    actualCostSource,responseVerified,accountingStatus]);
  return { accountingStatus, reservedMicrousd, actualCostMicrousd, responseVerified };
}

/** Run one reserved job only when explicitly invoked by a worker or operator. */
export async function runAstraGenerationJob({ tenantStore, tenantId, userId, requestId, legacyDb = null, transport, signal }) {
  if (!tenantStore || typeof tenantStore.withTenant !== 'function') throw new TypeError('A verified tenant store is required.');
  if (!UUID.test(String(requestId))) fail('requestId is invalid.');
  const nativeTransport = transport === undefined;
  const queued = await tenantStore.withTenant({ tenantId,userId }, async (db,membership) => {
    const found = await db.query(`SELECT * FROM astra.generation_jobs WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE`,[tenantId,requestId]);
    const job = found.rows[0];
    if (!job || job.state !== 'queued') fail('Generation job is unavailable.',404,'generation_job_unavailable');
    let receiptTelemetryReady = true;
    try { await assertAstraReceiptTelemetryReady(db, 'generation_jobs'); }
    catch (error) {
      if (error?.code !== 'ai_receipt_schema_unavailable') throw error;
      receiptTelemetryReady = false;
      if (nativeTransport) {
        await db.query(`UPDATE astra.generation_jobs SET state='blocked',reserved_microusd=0,
          error_code='generation_receipt_schema_unavailable',completed_at=now()
          WHERE tenant_id=$1 AND id=$2::uuid AND state='queued'`,[tenantId,requestId]);
        return { schemaUnavailable:true };
      }
    }
    const actor = { tenantId:membership.tenantId,userId:membership.userId,tenantRole:membership.tenantRole };
    const evidenceCurrent = job.task === 'campaign_generation'
      ? await lockCampaignForGeneration(db,tenantId,job) && await currentCampaignEvidence(db,legacyDb,actor,job)
      : await currentReplyEvidence(db,actor,job);
    if (!evidenceCurrent) {
      await persistGenerationOutcome(db,tenantId,requestId,{job:{...job,receiptTelemetryReady},state:'blocked',errorCode:'generation_evidence_stale',clearReservation:true});
      return { stale:true };
    }
    const safe = minimizeGlmInput(job.input_payload, job.task === 'campaign_generation' || job.task === 'reply_classification' ? 'private' : 'synthetic-fixture');
    if (sha256(canonical(safe)) !== job.input_hash) {
      await persistGenerationOutcome(db,tenantId,requestId,{job:{...job,receiptTelemetryReady},state:'blocked',errorCode:'generation_input_integrity_failed',clearReservation:true});
      return { stale:true };
    }
    if (placeholderDigest(job.task,job.placeholder_map)!==job.placeholder_hash) {
      await persistGenerationOutcome(db,tenantId,requestId,{job:{...job,receiptTelemetryReady},state:'blocked',errorCode:'generation_placeholder_integrity_failed',clearReservation:true});
      return { stale:true };
    }
    if (receiptTelemetryReady) {
      await db.query(`UPDATE astra.generation_jobs SET state='running',accounting_status='pending',started_at=now() WHERE tenant_id=$1 AND id=$2::uuid AND state='queued'`,[tenantId,requestId]);
    } else {
      await db.query(`UPDATE astra.generation_jobs SET state='running',started_at=now() WHERE tenant_id=$1 AND id=$2::uuid AND state='queued'`,[tenantId,requestId]);
    }
    return { job:{...job,receiptTelemetryReady},safe,actor,receiptTelemetryReady };
  });
  if (queued.stale) return { id:requestId,status:'blocked',errorCode:'generation_evidence_stale' };
  if (queued.schemaUnavailable) return { id:requestId,status:'blocked',errorCode:'generation_receipt_schema_unavailable',setupBlocker:'astra_migration_034_required' };

  let result;
  let wasSent = false;
  const invokeTransport = typeof transport === 'function' ? async (...args) => {
    wasSent = true;
    return transport(...args);
  } : undefined;
  try {
    // assertGlmEgressApproved executes before transport; local preview and the
    // current synthetic-only register therefore stop all real campaign/reply inputs.
    result = await runAstraGenerationTask({ task:queued.job.task,input:queued.safe,dataClassification:'private',transport:invokeTransport,signal,
      onDispatch:() => { wasSent = true; } });
  } catch (error) {
    const receipt = error?.providerReceipt || null;
    const safeState = blockedBeforeTransport(error) ? 'blocked'
      : !wasSent && ['glm_cancelled','glm_deadline_or_cancelled'].includes(error?.code) ? 'cancelled'
        : wasSent && !nativeTransport ? 'uncertain'
          : error?.uncertain === false ? 'failed' : (wasSent ? 'uncertain' : 'failed');
    await tenantStore.withTenant({ tenantId,userId }, async db => {
      const locked = await db.query(`SELECT reserved_microusd FROM astra.generation_jobs WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE`,[tenantId,requestId]);
      if (!locked.rows[0]) return;
      await persistGenerationOutcome(db,tenantId,requestId,{job:{...locked.rows[0],receiptTelemetryReady:queued.receiptTelemetryReady},state:safeState,errorCode:error?.code || 'generation_failed',receipt,clearReservation:safeState==='blocked' || safeState==='failed' || safeState==='cancelled'});
    });
    return { id:requestId,status:safeState,errorCode:error?.code || 'generation_failed',
      responseStatus:receipt?.responseVerified ? 'verified' : 'unknown',
      actual:receipt?.responseVerified ? {provider:receipt.actualProvider,model:receipt.actualModel,endpoint:GLM_ENDPOINT} : null,
      accountingStatus:receipt?.actualCostMicrousd !== null && receipt?.actualCostMicrousd !== undefined ? 'settled' : safeState==='uncertain' ? 'unknown' : 'not_submitted' };
  }

  return tenantStore.withTenant({ tenantId,userId }, async (db,membership) => {
    const found = await db.query(`SELECT * FROM astra.generation_jobs WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE`,[tenantId,requestId]);
    const job = { ...found.rows[0], receiptTelemetryReady:queued.receiptTelemetryReady };
    if (!job || job.state !== 'running') fail('Generation result cannot be applied to a changed job.',409,'generation_job_stale');
    const actor = { tenantId:membership.tenantId,userId:membership.userId,tenantRole:membership.tenantRole };
    if (!result.usage.responseVerified) {
      const persisted = await persistGenerationOutcome(db,tenantId,requestId,{job,state:'uncertain',
        errorCode:'generation_injected_transport_unverified',receipt:result.usage});
      return { id:requestId,status:'uncertain',logical:result.logical,actual:null,responseStatus:'unverified',
        accountingStatus:persisted.accountingStatus,errorCode:'generation_injected_transport_unverified' };
    }
    if (result.usage.actualCostMicrousd === null || result.usage.actualCostMicrousd > Number(job.reserved_microusd)) {
      const proposal = job.task === 'reply_classification'
        ? { ...result.data,reviewRequired:true,automaticActionTaken:false }
        : { campaignDraft:unverifiedCampaignProposal(result.data,job.placeholder_map),reviewRequired:true,approved:false };
      const persisted = await persistGenerationOutcome(db,tenantId,requestId,{job,state:'uncertain',
        errorCode:result.usage.actualCostMicrousd === null ? 'generation_provider_cost_unreported' : 'generation_actual_cost_exceeds_reservation',receipt:result.usage,
        resultPayload:{...proposal,accountingStatus:'unknown'}});
      return { id:requestId,status:'uncertain',logical:result.logical,actual:result.actual,responseStatus:'verified',
        accountingStatus:persisted.accountingStatus,errorCode:result.usage.actualCostMicrousd === null ? 'generation_provider_cost_unreported' : 'generation_actual_cost_exceeds_reservation',result:proposal,
        usage:{...result.usage,status:'uncertain',accountingStatus:persisted.accountingStatus} };
    }
    let applied = null;
    const evidenceCurrent = job.task === 'campaign_generation'
      ? await lockCampaignForGeneration(db,tenantId,job) && await currentCampaignEvidence(db,legacyDb,actor,job)
      : await currentReplyEvidence(db,actor,job);
    if (job.task === 'campaign_generation') {
      if (!evidenceCurrent) {
        const persisted = await persistGenerationOutcome(db,tenantId,requestId,{job,state:'uncertain',errorCode:'generation_result_stale',receipt:result.usage});
        return { id:requestId,status:'uncertain',logical:result.logical,actual:result.actual,responseStatus:'verified',
          accountingStatus:persisted.accountingStatus,errorCode:'generation_result_stale',actualCostMicrousd:result.usage.actualCostMicrousd };
      }
      try {
        applied = await saveAstraCampaignDraft(db,actor,legacyDb,job.campaign_id,expandCampaignDraft(result.data,job.placeholder_map));
      } catch (error) {
        const persisted = await persistGenerationOutcome(db,tenantId,requestId,{job,state:'uncertain',errorCode:'generation_draft_rejected',receipt:result.usage});
        return { id:requestId,status:'uncertain',logical:result.logical,actual:result.actual,responseStatus:'verified',
          accountingStatus:persisted.accountingStatus,errorCode:'generation_draft_rejected',validationCode:error?.code || 'draft_rejected' };
      }
    }
    if (job.task === 'reply_classification' && !evidenceCurrent) {
      const persisted = await persistGenerationOutcome(db,tenantId,requestId,{job,state:'uncertain',errorCode:'reply_evidence_stale',receipt:result.usage});
      return { id:requestId,status:'uncertain',logical:result.logical,actual:result.actual,responseStatus:'verified',
        accountingStatus:persisted.accountingStatus,errorCode:'reply_evidence_stale',actualCostMicrousd:result.usage.actualCostMicrousd };
    }
    const resultPayload = job.task === 'reply_classification'
      ? { ...result.data,reviewRequired:true,automaticActionTaken:false }
      : { campaignDraft:applied,reviewRequired:true,approved:false };
    const persisted = await persistGenerationOutcome(db,tenantId,requestId,{job,state:'completed',receipt:result.usage,resultPayload});
    return { id:requestId,status:'completed',logical:result.logical,actual:result.actual,responseStatus:'verified',
      accountingStatus:persisted.accountingStatus,result:resultPayload,usage:{...result.usage,accountingStatus:persisted.accountingStatus} };
  });
}

export function generationProviderContract() {
  return Object.freeze({ provider:GLM_PROVIDER,model:GLM_MODEL,endpoint:GLM_ENDPOINT,reasoning:'reasoning_tokens_if_reported',
    actualProvider:GLM_ACTUAL_PROVIDER,actualModel:GLM_ACTUAL_MODEL,
    logical:{provider:GLM_PROVIDER,model:GLM_MODEL},
    actual:{provider:GLM_ACTUAL_PROVIDER,model:GLM_ACTUAL_MODEL,endpoint:GLM_ENDPOINT},
    tasks:['campaign_generation','reply_classification'],
    capabilities:{structuredOutput:true,streaming:false,toolCalls:false,reasoningEffort:false},
    receiptTelemetryMigration:34,fallbacks:[],workerAutostart:false,
    localPreviewEgress:false,replyActions:'human_review_only' });
}
