import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getGlmEgressGateStatus, GLM_ACTUAL_PROVIDER, GLM_ACTUAL_MODEL, GLM_ENDPOINT, GLM_MODEL, GLM_PROVIDER } from './astra-egress.js';

const MAX_MICROUSD = 9_000_000_000_000_000;
const ACTIVE_STATES = ['queued', 'running', 'uncertain'];
const RECEIPT_COLUMNS = Object.freeze(['actual_provider','actual_model','reasoning_tokens','provider_quota',
  'actual_cost_source','response_verified','accounting_status']);
const SAFE_QUOTA_HEADERS = new Set(['retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset',
  'ratelimit-limit','ratelimit-remaining','ratelimit-reset','x-quota-limit','x-quota-remaining','x-quota-reset']);

export class AstraUsageError extends Error {
  constructor(message, code = 'ai_usage_rejected', statusCode = 409) {
    super(message);
    this.name = 'AstraUsageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function integerUnits(value, field, { min = 0, max = MAX_MICROUSD } = {}) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new AstraUsageError(`${field} must be an integer within the configured limit.`, 'ai_usage_limit_invalid', 400);
  }
  return number;
}

function normalizedTasks(value) {
  if (!Array.isArray(value) || value.length > 5
    || value.some(task => !['personalization_draft', 'subject_polish', 'fact_check', 'optimizer_dev_prediction', 'business_goal_planning'].includes(task))) {
    throw new AstraUsageError('Allowed model tasks are invalid.', 'ai_tasks_invalid', 400);
  }
  return [...new Set(value)];
}

function safePolicy(row) {
  if (!row) return { enabled: false, allowedTasks: [], dailyBudgetMicrousd: 0, reservationMicrousd: 0, maxInputTokens: 0, maxOutputTokens: 0 };
  return {
    enabled: row.enabled === true,
    allowedTasks: Array.isArray(row.allowed_tasks) ? row.allowed_tasks : [],
    dailyBudgetMicrousd: Number(row.daily_budget_microusd),
    reservationMicrousd: Number(row.reservation_microusd),
    maxInputTokens: Number(row.max_input_tokens),
    maxOutputTokens: Number(row.max_output_tokens),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeProviderQuota(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AstraUsageError('Provider quota metadata is invalid.', 'ai_provider_quota_invalid', 400);
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    if (!SAFE_QUOTA_HEADERS.has(name) || typeof item !== 'string' || item.length > 100 || !/^[\w.,:/+ -]+$/.test(item)) {
      throw new AstraUsageError('Provider quota metadata is invalid.', 'ai_provider_quota_invalid', 400);
    }
    result[name] = item;
  }
  return Object.keys(result).length ? result : null;
}

export async function assertAstraReceiptTelemetryReady(db, tableName) {
  if (!['ai_usage_requests','generation_jobs'].includes(tableName)) throw new AstraUsageError('Provider receipt table is invalid.', 'ai_receipt_schema_unavailable', 503);
  const found = await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='astra' AND table_name=$1 AND column_name=ANY($2::text[])`, [tableName, RECEIPT_COLUMNS]);
  const available = new Set((found.rows || []).map(row => row.column_name));
  const missing = RECEIPT_COLUMNS.filter(column => !available.has(column));
  if (missing.length) throw new AstraUsageError('Astra provider receipt migration 034 is required before model egress.', 'ai_receipt_schema_unavailable', 503);
  return true;
}

export async function getAstraAiStatus(db, tenantId) {
  const [policyResult, globalResult, usageResult] = await Promise.all([
    db.query(`SELECT enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens
      FROM astra.ai_tenant_policies WHERE tenant_id=$1::uuid`, [tenantId]),
    db.query(`SELECT enabled,daily_budget_microusd,breaker_state,breaker_open_until,failure_count
      FROM astra.ai_global_limits WHERE singleton=true`),
    db.query(`SELECT state,COUNT(*)::bigint AS count,COALESCE(SUM(reserved_microusd),0)::bigint AS reserved_microusd
      FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      GROUP BY state`, [tenantId]),
  ]);
  const policy = safePolicy(policyResult.rows[0]);
  const global = globalResult.rows[0] || {};
  const egress = await getGlmEgressGateStatus();
  const globalOpen = global.breaker_state === 'open' && global.breaker_open_until && new Date(global.breaker_open_until).getTime() > Date.now();
  let receiptTelemetryReady = true;
  try { await assertAstraReceiptTelemetryReady(db, 'ai_usage_requests'); }
  catch { receiptTelemetryReady = false; }
  const egressBlocker = !egress.enabled ? egress.blocker
    : !global.enabled ? 'global_budget_disabled'
      : !policy.enabled ? 'tenant_policy_disabled'
        : globalOpen ? 'circuit_breaker_open'
          : !receiptTelemetryReady ? 'provider_receipt_schema_unavailable' : null;
  return {
    provider: GLM_PROVIDER, model: GLM_MODEL, endpoint: GLM_ENDPOINT,
    logical: { provider: GLM_PROVIDER, model: GLM_MODEL },
    actual: { provider: GLM_ACTUAL_PROVIDER, model: GLM_ACTUAL_MODEL, endpoint: GLM_ENDPOINT },
    receiptTelemetryReady,
    egressEnabled: egressBlocker === null,
    egressBlocker,
    policy,
    global: {
      enabled: global.enabled === true,
      dailyBudgetMicrousd: Number(global.daily_budget_microusd || 0),
      breakerState: global.breaker_state || 'closed',
      breakerOpenUntil: global.breaker_open_until || null,
      failureCount: Number(global.failure_count || 0),
    },
    usage: usageResult.rows.map(row => ({ state: row.state, count: Number(row.count), reservedMicrousd: Number(row.reserved_microusd) })),
  };
}

export async function configureAstraAiTenantPolicy(db, tenantId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraUsageError('Policy settings must be an object.', 'ai_policy_invalid', 400);
  const enabled = input.enabled === true;
  const allowedTasks = normalizedTasks(input.allowedTasks ?? []);
  const dailyBudget = integerUnits(input.dailyBudgetMicrousd ?? 0, 'dailyBudgetMicrousd');
  const reservation = integerUnits(input.reservationMicrousd ?? 0, 'reservationMicrousd');
  const maxInputTokens = integerUnits(input.maxInputTokens ?? 0, 'maxInputTokens', { max: 128_000 });
  const maxOutputTokens = integerUnits(input.maxOutputTokens ?? 0, 'maxOutputTokens', { max: 16_384 });
  if (enabled && (!allowedTasks.length || dailyBudget < 1 || reservation < 1 || maxInputTokens < 1 || maxOutputTokens < 1)) {
    throw new AstraUsageError('Enabled policy requires tasks, a daily budget, a per-call reservation and token ceilings.', 'ai_policy_incomplete', 400);
  }
  const result = await db.query(`INSERT INTO astra.ai_tenant_policies(
      tenant_id,enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens,updated_at
    ) VALUES($1::uuid,$2,$3::text[],$4::bigint,$5::bigint,$6::integer,$7::integer,now())
    ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,allowed_tasks=EXCLUDED.allowed_tasks,
      daily_budget_microusd=EXCLUDED.daily_budget_microusd,reservation_microusd=EXCLUDED.reservation_microusd,
      max_input_tokens=EXCLUDED.max_input_tokens,max_output_tokens=EXCLUDED.max_output_tokens,updated_at=now()
    RETURNING enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens`,
  [tenantId, enabled, allowedTasks, dailyBudget, reservation, maxInputTokens, maxOutputTokens]);
  return safePolicy(result.rows[0]);
}

/** Serializes reservations on the global budget row and tenant policy row. Call inside the verified tenant transaction. */
export async function reserveAstraUsage(db, {
  tenantId, task, idempotencyKey, input, maxOutputTokens, maxInputTokens,
  dataClassification = 'unknown', offerVersionId = null, requestId = randomUUID(), optimizerJobId = null,
}) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new AstraUsageError('A request idempotency key is required.', 'ai_idempotency_key_invalid', 400);
  }
  if (!['personalization_draft', 'subject_polish', 'fact_check', 'optimizer_dev_prediction', 'business_goal_planning'].includes(task)) throw new AstraUsageError('The requested model task is not allowed.', 'ai_task_forbidden', 400);
  if (task === 'optimizer_dev_prediction') {
    if (typeof optimizerJobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(optimizerJobId)) {
      throw new AstraUsageError('Optimizer predictions require a tenant-scoped running native optimizer job.', 'ai_optimizer_job_required', 403);
    }
    const job = await db.query(`SELECT state,engine FROM astra.learning_optimizer_jobs
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, optimizerJobId]);
    if (job.rows[0]?.state !== 'running' || job.rows[0]?.engine !== 'native_bounded_v1') {
      throw new AstraUsageError('Optimizer predictions require a tenant-scoped running native optimizer job.', 'ai_optimizer_job_required', 403);
    }
  } else if (optimizerJobId !== null) throw new AstraUsageError('Optimizer job bindings are valid only for optimizer predictions.', 'ai_optimizer_job_invalid', 400);
  const inputTokens = integerUnits(maxInputTokens, 'maxInputTokens', { min: 1, max: 128_000 });
  const outputTokens = integerUnits(maxOutputTokens, 'maxOutputTokens', { min: 1, max: 16_384 });
  const boundedPayload = input;
  if (!boundedPayload || typeof boundedPayload !== 'object' || Array.isArray(boundedPayload)) throw new AstraUsageError('Model input must be a minimized JSON object.', 'ai_input_invalid', 400);
  const boundedInputTokens = Buffer.byteLength(JSON.stringify(boundedPayload), 'utf8') + 1024;
  if (inputTokens < boundedInputTokens) throw new AstraUsageError('Input token ceiling is below the conservative serialized-input bound.', 'ai_input_token_bound_exceeded', 413);
  if (offerVersionId !== null && !/^[1-9][0-9]{0,18}$/.test(String(offerVersionId))) throw new AstraUsageError('Bound offer version is invalid.', 'ai_offer_binding_invalid', 400);
  if (task === 'business_goal_planning' && (typeof boundedPayload.goalRunId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(boundedPayload.goalRunId))) {
    throw new AstraUsageError('Goal planning reservations require a tenant-scoped goal run.', 'ai_goal_run_required', 400);
  }

  const duplicate = await db.query(`SELECT id,state,reserved_microusd FROM astra.ai_usage_requests
    WHERE tenant_id=$1::uuid AND idempotency_key=$2`, [tenantId, idempotencyKey]);
  if (duplicate.rows[0]) return { duplicate: true, ...duplicate.rows[0], reservedMicrousd: Number(duplicate.rows[0].reserved_microusd) };

  const globalResult = await db.query(`SELECT enabled,daily_budget_microusd,breaker_state,breaker_open_until,breaker_probe_request_id
    FROM astra.ai_global_limits WHERE singleton=true FOR UPDATE`);
  const global = globalResult.rows[0];
  const serializedDuplicate = await db.query(`SELECT id,state,reserved_microusd FROM astra.ai_usage_requests
    WHERE tenant_id=$1::uuid AND idempotency_key=$2`, [tenantId, idempotencyKey]);
  if (serializedDuplicate.rows[0]) return { duplicate: true, ...serializedDuplicate.rows[0], reservedMicrousd: Number(serializedDuplicate.rows[0].reserved_microusd) };
  if (!global || global.enabled !== true || Number(global.daily_budget_microusd) < 1) {
    throw new AstraUsageError('The global AI egress budget is disabled.', 'ai_global_budget_disabled', 503);
  }
  if (task === 'business_goal_planning') {
    const runBudget = await db.query(`SELECT count(*)::integer AS count FROM astra.ai_usage_requests
      WHERE tenant_id=$1::uuid AND task='business_goal_planning' AND input_payload->>'goalRunId'=$2
        AND state IN ('queued','running','uncertain','succeeded')`, [tenantId, boundedPayload.goalRunId]);
    if (Number(runBudget.rows[0]?.count || 0) >= 3) {
      throw new AstraUsageError('This goal run has used its three approved planning calls.', 'ai_goal_run_budget_exhausted', 429);
    }
  }
  if (global.breaker_state === 'open' && global.breaker_open_until && new Date(global.breaker_open_until).getTime() > Date.now()) {
    throw new AstraUsageError('The GLM circuit breaker is open.', 'ai_circuit_open', 503);
  }
  if (global.breaker_state === 'open') {
    await db.query(`UPDATE astra.ai_global_limits SET breaker_state='half_open',breaker_probe_request_id=NULL,updated_at=now()
      WHERE singleton=true AND breaker_state='open'`);
    global.breaker_state = 'half_open';
    global.breaker_probe_request_id = null;
  }
  if (global.breaker_state === 'half_open' && global.breaker_probe_request_id) {
    throw new AstraUsageError('A GLM circuit breaker probe is already in flight.', 'ai_circuit_probe_in_flight', 503);
  }

  const policyResult = await db.query(`SELECT enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens
    FROM astra.ai_tenant_policies WHERE tenant_id=$1::uuid FOR UPDATE`, [tenantId]);
  const policyRow = policyResult.rows[0];
  const policy = safePolicy(policyRow);
  if (!policy.enabled || !policy.allowedTasks.includes(task)) throw new AstraUsageError('Tenant AI policy does not allow this task.', 'ai_tenant_policy_denied', 403);
  if (dataClassification !== 'synthetic-fixture') throw new AstraUsageError('Only explicitly approved synthetic fixtures may be reserved for GLM.', 'ai_data_classification_denied', 403);
  if (inputTokens > policy.maxInputTokens || outputTokens > policy.maxOutputTokens) throw new AstraUsageError('The model request exceeds tenant token ceilings.', 'ai_token_limit_exceeded', 413);
  const reserve = policy.reservationMicrousd;
  if (!reserve) throw new AstraUsageError('Tenant per-call reservation is not configured.', 'ai_reservation_missing', 503);

  const daily = `created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  const [tenantSpent, globalSpent] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(reserved_microusd),0)::bigint AS used FROM astra.ai_usage_requests
      WHERE tenant_id=$1::uuid AND ${daily} AND state IN ('queued','running','uncertain','succeeded')`, [tenantId]),
    db.query('SELECT astra.ai_global_reserved_today() AS used'),
  ]);
  const reservedBigInt = BigInt(reserve);
  if (BigInt(tenantSpent.rows[0].used) + reservedBigInt > BigInt(policy.dailyBudgetMicrousd)) throw new AstraUsageError('Tenant AI daily budget is exhausted.', 'ai_tenant_budget_exhausted', 429);
  if (BigInt(globalSpent.rows[0].used) + reservedBigInt > BigInt(global.daily_budget_microusd)) throw new AstraUsageError('Global AI daily budget is exhausted.', 'ai_global_budget_exhausted', 429);

  let receiptTelemetryReady = true;
  try { await assertAstraReceiptTelemetryReady(db, 'ai_usage_requests'); }
  catch { receiptTelemetryReady = false; }
  const insertValues = [requestId, tenantId, task, dataClassification, offerVersionId === null ? null : String(offerVersionId), idempotencyKey,
    JSON.stringify(boundedPayload), createHash('sha256').update(canonicalJson(boundedPayload)).digest('hex'), inputTokens, outputTokens, reserve];
  const inserted = receiptTelemetryReady
    ? await db.query(`INSERT INTO astra.ai_usage_requests(
        id,tenant_id,task,provider,model,data_classification,offer_version_id,state,idempotency_key,input_payload,input_hash,
        max_input_tokens,max_output_tokens,reserved_microusd,actual_provider,actual_model,reasoning_tokens,provider_quota,
        actual_cost_source,response_verified,accounting_status
      ) VALUES($1::uuid,$2::uuid,$3,'glm-5.3-api','GLM-5.3',$4,$5,'queued',$6,$7::jsonb,$8,$9,$10,$11::bigint,
        NULL,NULL,NULL,NULL,NULL,false,'pending')
      RETURNING id,state,reserved_microusd`, insertValues)
    : await db.query(`INSERT INTO astra.ai_usage_requests(
        id,tenant_id,task,provider,model,data_classification,offer_version_id,state,idempotency_key,input_payload,input_hash,
        max_input_tokens,max_output_tokens,reserved_microusd
      ) VALUES($1::uuid,$2::uuid,$3,'glm-5.3-api','GLM-5.3',$4,$5,'queued',$6,$7::jsonb,$8,$9,$10,$11::bigint)
      RETURNING id,state,reserved_microusd`, insertValues);
  if (global.breaker_state === 'half_open') {
    await db.query(`UPDATE astra.ai_global_limits SET breaker_probe_request_id=$1::uuid,updated_at=now()
      WHERE singleton=true AND breaker_state='half_open' AND breaker_probe_request_id IS NULL`, [requestId]);
  }
  return { duplicate: false, ...inserted.rows[0], reservedMicrousd: Number(inserted.rows[0].reserved_microusd) };
}

export async function markAstraUsageStarted(db, tenantId, requestId) {
  const result = await db.query(`UPDATE astra.ai_usage_requests SET state='running',started_at=now()
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='queued' RETURNING id`, [tenantId, requestId]);
  return result.rowCount === 1;
}

/** Recheck kill switches, task policy and current quotas immediately before egress. */
export async function assertAstraUsageDispatchAllowed(db, tenantId, requestId, task) {
  const globalResult = await db.query(`SELECT enabled,daily_budget_microusd,breaker_state,breaker_open_until,breaker_probe_request_id
    FROM astra.ai_global_limits WHERE singleton=true FOR UPDATE`);
  const global = globalResult.rows[0];
  if (!global?.enabled) throw new AstraUsageError('Global AI egress was disabled before dispatch.', 'ai_global_budget_disabled', 503);
  if (global.breaker_state === 'open' && global.breaker_open_until && new Date(global.breaker_open_until).getTime() > Date.now()) {
    throw new AstraUsageError('The GLM circuit breaker is open.', 'ai_circuit_open', 503);
  }
  if (global.breaker_state === 'half_open' && global.breaker_probe_request_id) {
    const probeId = String(global.breaker_probe_request_id);
    if (probeId !== String(requestId)) throw new AstraUsageError('A GLM circuit breaker probe is already in flight.', 'ai_circuit_probe_in_flight', 503);
  }
  const policyResult = await db.query(`SELECT enabled,allowed_tasks,daily_budget_microusd
    FROM astra.ai_tenant_policies WHERE tenant_id=$1::uuid FOR UPDATE`, [tenantId]);
  const policy = safePolicy(policyResult.rows[0]);
  if (!policy.enabled || !policy.allowedTasks.includes(task)) throw new AstraUsageError('Tenant AI policy changed before dispatch.', 'ai_tenant_policy_denied', 403);
  const requestResult = await db.query(`SELECT reserved_microusd FROM astra.ai_usage_requests
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='queued'`, [tenantId, requestId]);
  const request = requestResult.rows[0];
  if (!request) throw new AstraUsageError('AI request is no longer queued.', 'ai_request_unavailable', 409);
  const [tenantUsed, globalUsed] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(reserved_microusd),0)::bigint AS used FROM astra.ai_usage_requests
      WHERE tenant_id=$1::uuid AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND state IN ('queued','running','uncertain','succeeded')`, [tenantId]),
    db.query('SELECT astra.ai_global_reserved_today() AS used'),
  ]);
  const reservation = BigInt(request.reserved_microusd);
  if (BigInt(tenantUsed.rows[0].used) > BigInt(policy.dailyBudgetMicrousd)) throw new AstraUsageError('Tenant AI budget changed below its current reservations.', 'ai_tenant_budget_exhausted', 429);
  if (BigInt(globalUsed.rows[0].used) > BigInt(global.daily_budget_microusd)) throw new AstraUsageError('Global AI budget changed below its current reservations.', 'ai_global_budget_exhausted', 429);
  if (reservation < 1n) throw new AstraUsageError('AI request reservation is invalid.', 'ai_reservation_missing', 503);
  return true;
}

/** Unknown billing remains reserved. Known provider costs are integer micro-USD only. */
export async function settleAstraUsage(db, tenantId, requestId, {
  status, inputTokens = null, outputTokens = null, providerRequestId = null,
  reasoningTokens = null, actualProvider = null, actualModel = null, providerQuota = null,
  responseVerified = false, actualCostMicrousd = null, actualCostSource = null, errorCode = null,
  receiptTelemetryReady = true,
}) {
  if (!['succeeded', 'failed', 'cancelled', 'uncertain'].includes(status)) throw new AstraUsageError('Invalid model usage outcome.', 'ai_usage_outcome_invalid', 400);
  const input = inputTokens === null ? null : integerUnits(inputTokens, 'inputTokens', { max: 1_000_000 });
  const output = outputTokens === null ? null : integerUnits(outputTokens, 'outputTokens', { max: 1_000_000 });
  const reasoning = reasoningTokens === null ? null : integerUnits(reasoningTokens, 'reasoningTokens', { max: 1_000_000 });
  const cost = actualCostMicrousd === null ? null : integerUnits(actualCostMicrousd, 'actualCostMicrousd');
  const quota = safeProviderQuota(providerQuota);
  const hasIdentity = actualProvider !== null || actualModel !== null;
  if (responseVerified === true && (actualProvider !== GLM_ACTUAL_PROVIDER || actualModel !== GLM_ACTUAL_MODEL)) {
    throw new AstraUsageError('A verified provider receipt must match the approved actual identity.', 'ai_provider_identity_invalid', 400);
  }
  if (responseVerified !== true && hasIdentity) throw new AstraUsageError('Unverified provider identity cannot be persisted as an actual receipt.', 'ai_provider_identity_invalid', 400);
  if (cost !== null && (responseVerified !== true || actualCostSource !== 'provider_usage.cost_microusd')) throw new AstraUsageError('Provider cost needs a verified source and micro-USD precision.', 'ai_cost_source_invalid', 400);
  if (cost === null && actualCostSource !== null) throw new AstraUsageError('An unreported provider cost cannot have a cost source.', 'ai_cost_source_invalid', 400);
  if (!receiptTelemetryReady && (responseVerified === true || hasIdentity || cost !== null)) {
    throw new AstraUsageError('Astra provider receipt migration 034 is required to persist verified provider metadata.', 'ai_receipt_schema_unavailable', 503);
  }
  const request = await db.query(`SELECT reserved_microusd FROM astra.ai_usage_requests
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND state IN ('running','queued','uncertain') FOR UPDATE`, [tenantId, requestId]);
  if (!request.rows[0]) return false;
  const reserved = Number(request.rows[0].reserved_microusd);
  if (!receiptTelemetryReady) {
    // Legacy fixture 33 has no actual-provider receipt columns. Keep these
    // injected transport outcomes uncertain and retain the reservation without
    // writing mock token, request, model, provider, quota, or cost metadata.
    const nextState = status === 'failed' || status === 'cancelled' ? status : 'uncertain';
    const retained = nextState === 'uncertain' ? reserved : 0;
    await db.query(`UPDATE astra.ai_usage_requests SET state=$3,input_tokens=NULL,output_tokens=NULL,
        provider_request_id=NULL,error_code=$4,cost_microusd=NULL,reserved_microusd=$5::bigint,completed_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, requestId, nextState,
      typeof errorCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(errorCode) ? errorCode : 'provider_receipt_migration_required', retained]);
    return { state: nextState, accountingStatus: nextState === 'uncertain' ? 'migration_required' : 'not_submitted',
      reservedMicrousd: retained, costMicrousd: null, responseVerified: false, receiptTelemetryReady: false };
  }
  // Migration 004 defines success as complete billing, independently of whether
  // the business output was accepted. Keep known receipts even on parse errors.
  const completeBilling = responseVerified === true && input !== null && output !== null && cost !== null;
  const overReservation = cost !== null && cost > reserved;
  const uncertain = !completeBilling && (status === 'uncertain' || status === 'succeeded' || responseVerified === true);
  const nextState = completeBilling ? 'succeeded' : uncertain ? 'uncertain' : status;
  const retained = uncertain || (completeBilling && (status !== 'succeeded' || overReservation))
    ? Math.max(reserved, cost || 0) : completeBilling ? cost : 0;
  const accountingStatus = completeBilling ? 'settled' : uncertain ? 'unknown' : 'not_submitted';
  await db.query(`UPDATE astra.ai_usage_requests SET state=$3,input_tokens=$4,output_tokens=$5,reasoning_tokens=$6,
      actual_provider=$7,actual_model=$8,response_verified=$9,provider_request_id=$10,error_code=$11,
      cost_microusd=$12::bigint,reserved_microusd=$13::bigint,provider_quota=$14::jsonb,
      actual_cost_source=$15,accounting_status=$16,completed_at=now()
    WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, requestId, nextState, responseVerified ? input : null,
    responseVerified ? output : null, responseVerified ? reasoning : null,
    responseVerified ? actualProvider : null, responseVerified ? actualModel : null, responseVerified,
    responseVerified && typeof providerRequestId === 'string' ? providerRequestId.slice(0, 200) : null,
    typeof errorCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(errorCode) ? errorCode : overReservation ? 'ai_actual_cost_exceeds_reservation' : null,
    cost, retained, responseVerified && quota !== null ? JSON.stringify(quota) : null, actualCostSource, accountingStatus]);
  if (status === 'failed' || status === 'uncertain' || nextState === 'uncertain' || overReservation) {
    await db.query(`UPDATE astra.ai_global_limits SET failure_count=failure_count+1,
      breaker_state=CASE WHEN failure_count+1>=3 THEN 'open' ELSE breaker_state END,
      breaker_open_until=CASE WHEN failure_count+1>=3 OR breaker_state='half_open' THEN now()+interval '60 seconds' ELSE breaker_open_until END,
      breaker_probe_request_id=CASE WHEN breaker_state='half_open' THEN NULL ELSE breaker_probe_request_id END,
      updated_at=now() WHERE singleton=true`);
  } else if (nextState === 'succeeded') {
    await db.query(`UPDATE astra.ai_global_limits SET failure_count=0,
      breaker_state=CASE WHEN breaker_state='half_open' AND breaker_probe_request_id=$1::uuid THEN 'closed' ELSE breaker_state END,
      breaker_open_until=CASE WHEN breaker_probe_request_id=$1::uuid THEN NULL ELSE breaker_open_until END,
      breaker_probe_request_id=CASE WHEN breaker_probe_request_id=$1::uuid THEN NULL ELSE breaker_probe_request_id END,
      updated_at=now() WHERE singleton=true`, [requestId]);
  }
  return { state: nextState, accountingStatus, reservedMicrousd: retained, costMicrousd: cost,
    responseVerified: responseVerified === true, receiptTelemetryReady: true };
}

/** Reconcile only with a signed provider receipt; unknown spend is never released by tenant input. */
export async function reconcileAstraUsageFromReceipt(db, tenantId, requestId, receipt, {
  secret = process.env.ASTRA_GLM_RECONCILIATION_HMAC_SECRET, now = Date.now(), maxAgeMs = 5 * 60_000,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32 || !receipt || typeof receipt !== 'object') {
    throw new AstraUsageError('Authenticated provider reconciliation is unavailable.', 'ai_reconciliation_unavailable', 503);
  }
  const cost = integerUnits(receipt.costMicrousd, 'costMicrousd');
  const inputTokens = integerUnits(receipt.inputTokens, 'inputTokens', { max: 1_000_000 });
  const outputTokens = integerUnits(receipt.outputTokens, 'outputTokens', { max: 1_000_000 });
  const atMs = Date.parse(receipt.at);
  if (!Number.isFinite(atMs) || Math.abs(now - atMs) > maxAgeMs || typeof receipt.providerRequestId !== 'string' || !receipt.providerRequestId.trim()) {
    throw new AstraUsageError('Provider reconciliation receipt is invalid or expired.', 'ai_reconciliation_invalid', 400);
  }
  const signed = `${tenantId}\n${requestId}\n${receipt.providerRequestId}\n${inputTokens}\n${outputTokens}\n${cost}\n${receipt.at}`;
  const expected = createHmac('sha256', secret).update(signed).digest();
  const supplied = Buffer.from(String(receipt.signature || ''), 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AstraUsageError('Provider reconciliation authentication failed.', 'ai_reconciliation_unauthorized', 403);
  await assertAstraReceiptTelemetryReady(db, 'ai_usage_requests');
  const row = await db.query(`SELECT reserved_microusd,state FROM astra.ai_usage_requests
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='uncertain' FOR UPDATE`, [tenantId, requestId]);
  if (!row.rows[0]) return false;
  const reserved = Number(row.rows[0].reserved_microusd);
  const state = 'succeeded';
  const accountingStatus = 'settled';
  await db.query(`UPDATE astra.ai_usage_requests SET state=$3,input_tokens=$4,output_tokens=$5,cost_microusd=$6::bigint,
    reserved_microusd=$7::bigint,provider_request_id=$8,actual_cost_source='provider_reconciliation_hmac',
    accounting_status=$9,completed_at=now()
    WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, requestId, state, inputTokens, outputTokens, cost,
    Math.max(reserved, cost), receipt.providerRequestId.slice(0, 200), accountingStatus]);
  return { state, accountingStatus, reservedMicrousd: Math.max(reserved, cost), costMicrousd: cost, inputTokens, outputTokens };
}

export function getAstraUsageReservationStates() { return [...ACTIVE_STATES]; }
