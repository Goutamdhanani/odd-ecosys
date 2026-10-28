import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ASTRA_EVENT_TYPES, AstraLedgerError } from './astra-ledger.js';

const METRICS = new Set(['meeting.held', 'opportunity.qualified', 'opportunity.won', 'revenue.paid']);
const EXPOSURE_TYPES = new Set(['send_submitted', 'control_eligible', 'other_known']);
// This event is deliberately not part of the current S04 ledger enum. The
// branch remains dormant until a separately reviewed immutable send adapter
// emits it with an explicit account and exposure declaration.
const VERIFIED_EXPOSURE_EVENT_TYPES = new Set(['campaign.exposure_verified']);

function fail(message, status = 400, code = 'astra_experiment_invalid') {
  throw new AstraLedgerError(message, status, code);
}
function text(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
function integer(value, field, { min = 1, max = 1000000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${field} must be an integer between ${min} and ${max}.`);
  return value;
}
function object(value, field, maxBytes = 16 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) fail(`${field} is too large.`);
  return encoded;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function normalizeExperiment(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Experiment body must be an object.');
  const name = text(input.name, 'name', 160);
  const hypothesis = text(input.hypothesis, 'hypothesis', 2000);
  const arms = input.arms;
  if (!Array.isArray(arms) || arms.length < 2 || arms.length > 8) fail('arms must contain between two and eight frozen variants.');
  const seen = new Set();
  let controls = 0;
  const normalizedArms = arms.map((arm, index) => {
    if (!arm || typeof arm !== 'object' || Array.isArray(arm)) fail(`arms[${index}] must be an object.`);
    const id = text(arm.id, `arms[${index}].id`, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || seen.has(id)) fail('Arm ids must be unique stable identifiers.');
    seen.add(id);
    const label = text(arm.label ?? id, `arms[${index}].label`, 120);
    const variantJson = object(arm.variant, `arms[${index}].variant`, 12 * 1024);
    const variantHash = text(arm.variantHash, `arms[${index}].variantHash`, 64);
    if (!/^[a-f0-9]{64}$/i.test(variantHash)) fail(`arms[${index}].variantHash must be a SHA-256 hex digest.`);
    if (sha256(variantJson) !== variantHash.toLowerCase()) fail(`arms[${index}].variantHash must match canonical JSON for variant.`);
    const weight = integer(arm.weight ?? 1, `arms[${index}].weight`, { min: 1, max: 100000 });
    const control = arm.control === true;
    if (control) controls += 1;
    return { id, label, variant: JSON.parse(variantJson), variantHash: variantHash.toLowerCase(), weight, control };
  });
  if (controls !== 1) fail('Exactly one frozen control arm is required.');
  const primaryMetric = text(input.primaryMetric, 'primaryMetric', 80);
  if (!METRICS.has(primaryMetric)) fail('primaryMetric must be a supported canonical outcome stage.');
  const primaryHorizonDays = integer(input.primaryHorizonDays, 'primaryHorizonDays', { max: 365 });
  const attributionWindowDays = integer(input.attributionWindowDays, 'attributionWindowDays', { max: 365 });
  const maxAccounts = integer(input.maxAccounts, 'maxAccounts', { min: 2, max: 1000000 });
  const stoppingRule = input.stoppingRule;
  if (!stoppingRule || typeof stoppingRule !== 'object' || Array.isArray(stoppingRule)
    || stoppingRule.type !== 'fixed_sample' || stoppingRule.adaptive === true || stoppingRule.continuousPeeking === true) {
    fail('stoppingRule must predeclare a fixed_sample rule with adaptive and continuousPeeking disabled.');
  }
  const minimumMatureAccounts = integer(stoppingRule.minimumMatureAccounts, 'stoppingRule.minimumMatureAccounts', { min: 0, max: maxAccounts });
  const costGuard = input.costGuard;
  if (!costGuard || typeof costGuard !== 'object' || Array.isArray(costGuard)) fail('costGuard must be an object.');
  const maxCostMicrousd = integer(costGuard.maxCostMicrousd, 'costGuard.maxCostMicrousd', { min: 1, max: 9000000000000000 });
  const estimatedMicrousdPerAccount = integer(costGuard.estimatedMicrousdPerAccount, 'costGuard.estimatedMicrousdPerAccount', { min: 1, max: 9000000000000000 });
  const effectiveAccounts = Math.min(maxAccounts, Math.floor(maxCostMicrousd / estimatedMicrousdPerAccount));
  if (effectiveAccounts < 2) fail('The cost guard cannot fund two assigned accounts at the declared per-account estimate.');
  const eligibilityRules = object(input.eligibilityRules, 'eligibilityRules');
  const strata = input.strata === undefined ? [] : input.strata;
  if (!Array.isArray(strata) || strata.some(value => typeof value !== 'string' || !value.trim() || value.length > 120)) {
    fail('strata must be a list of short predeclared field names.');
  }
  const plan = {
    name, hypothesis, unit: 'account', arms: normalizedArms, primaryMetric, primaryHorizonDays,
    attributionWindowDays, stoppingRule: { type: 'fixed_sample', minimumMatureAccounts, adaptive: false, continuousPeeking: false },
    maxAccounts, costGuard: { maxCostMicrousd, estimatedMicrousdPerAccount, enforceableAccountCap: effectiveAccounts },
    eligibilityRules: JSON.parse(eligibilityRules), strata: [...new Set(strata.map(value => value.trim()))].sort(),
  };
  const planJson = stableJson(plan);
  return { ...plan, planJson, planSha256: sha256(planJson), actorId: String(actor.userId), allocationKey: randomBytes(32) };
}

export async function createAstraExperiment(db, actor, input) {
  const plan = normalizeExperiment(input, actor);
  const result = await db.query(`INSERT INTO astra.experiments(
    tenant_id,name,hypothesis,unit,arms,primary_metric,primary_horizon_days,attribution_window_days,
    stopping_rule,max_accounts,max_cost_microusd,strata,plan,plan_sha256,allocation_key,created_by
  ) VALUES($1::uuid,$2,$3,'account',$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10::bigint,$11::jsonb,$12::jsonb,$13,$14,$15)
  RETURNING id,tenant_id AS "tenantId",name,hypothesis,unit,arms,primary_metric AS "primaryMetric",
    primary_horizon_days AS "primaryHorizonDays",attribution_window_days AS "attributionWindowDays",
    stopping_rule AS "stoppingRule",max_accounts AS "maxAccounts",max_cost_microusd AS "maxCostMicrousd",
    strata,plan_sha256 AS "planSha256",status,created_at AS "createdAt"`, [actor.tenantId, plan.name, plan.hypothesis,
    JSON.stringify(plan.arms), plan.primaryMetric, plan.primaryHorizonDays, plan.attributionWindowDays,
    JSON.stringify(plan.stoppingRule), plan.maxAccounts, plan.costGuard.maxCostMicrousd,
    JSON.stringify(plan.strata), plan.planJson, plan.planSha256, plan.allocationKey, plan.actorId]);
  return result.rows[0];
}

export async function listAstraExperiments(db, tenantId, { limit = 50 } = {}) {
  const safeLimit = limit == null || limit === '' ? 50
    : Math.max(1, Math.min(100, Number.isInteger(Number(limit)) ? Number(limit) : 50));
  const result = await db.query(`SELECT e.id,e.name,e.hypothesis,e.unit,e.arms,e.primary_metric AS "primaryMetric",
    e.primary_horizon_days AS "primaryHorizonDays",e.attribution_window_days AS "attributionWindowDays",
    e.stopping_rule AS "stoppingRule",e.max_accounts AS "maxAccounts",e.max_cost_microusd::text AS "maxCostMicrousd",
    e.strata,e.plan_sha256 AS "planSha256",e.status,e.created_at AS "createdAt",
    COUNT(a.account_id)::integer AS "assignedAccounts"
    FROM astra.experiments e LEFT JOIN astra.experiment_assignments a
      ON (a.tenant_id,a.experiment_id)=(e.tenant_id,e.id)
    WHERE e.tenant_id=$1::uuid GROUP BY e.tenant_id,e.id ORDER BY e.created_at DESC LIMIT $2`, [tenantId, safeLimit]);
  return result.rows;
}

function chooseArm(key, tenantId, experimentId, accountId, stratum, totalWeight) {
  const digest = createHmac('sha256', key).update(`${tenantId}\n${experimentId}\n${stratum}\n${accountId}`).digest('hex');
  return { digest, point: Number(BigInt(`0x${digest}`) % BigInt(totalWeight)) };
}

export async function assignAstraExperimentAccounts(db, actor, experimentId, entries) {
  const id = text(String(experimentId), 'experimentId', 36);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 500) fail('accounts must contain between one and 500 account declarations.');
  const normalized = [];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`accounts[${index}] must be an object.`);
    const accountId = text(String(entry.accountId || ''), `accounts[${index}].accountId`, 36).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(accountId)) fail(`accounts[${index}].accountId must be a UUID.`);
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    if (entry.eligible !== true) fail(`accounts[${index}] must explicitly declare eligible=true.`);
    const stratum = entry.stratum === undefined ? 'all' : text(entry.stratum, `accounts[${index}].stratum`, 120);
    const eligibility = object(entry.eligibility, `accounts[${index}].eligibility`, 8 * 1024);
    const sourceEventId = entry.eligibility?.sourceEventId == null ? null : text(String(entry.eligibility.sourceEventId), `accounts[${index}].eligibility.sourceEventId`, 36);
    if (typeof entry.eligibility?.source !== 'string' || !entry.eligibility.source.trim()
      || !entry.eligibility?.observedAt || Number.isNaN(Date.parse(entry.eligibility.observedAt))) {
      fail(`accounts[${index}].eligibility requires a source and observedAt fact.`);
    }
    normalized.push({ accountId, stratum, eligibility, sourceEventId });
  }
  if (!normalized.length) fail('No unique accounts were supplied.');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [`${actor.tenantId}:${id}`]);
  const expResult = await db.query(`SELECT id,name,arms,plan,allocation_key,max_accounts,max_cost_microusd,status
    FROM astra.experiments WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, id]);
  const experiment = expResult.rows[0];
  if (!experiment) fail('Experiment was not found for this tenant.', 404, 'experiment_not_found');
  if (experiment.status !== 'planned') fail('Experiment is not accepting fixed assignments.', 409, 'experiment_not_open');
  const existingCount = await db.query(`SELECT COUNT(*)::integer AS count FROM astra.experiment_assignments
    WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid`, [actor.tenantId, id]);
  const existing = Number(existingCount.rows[0].count);
  const plan = experiment.plan;
  const costCapacity = Math.floor(Number(experiment.max_cost_microusd) / Number(plan.costGuard.estimatedMicrousdPerAccount));
  const hardCap = Math.min(Number(experiment.max_accounts), costCapacity);
  const existingSubmitted = await db.query(`SELECT account_id::text AS id FROM astra.experiment_assignments
    WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid AND account_id=ANY($3::uuid[])`,
  [actor.tenantId, id, normalized.map(row => row.accountId)]);
  const existingIds = new Set(existingSubmitted.rows.map(row => String(row.id).toLowerCase()));
  const newCount = normalized.filter(row => !existingIds.has(row.accountId)).length;
  if (existing + newCount > hardCap) fail('The predeclared account or estimated-cost cap would be exceeded.', 409, 'experiment_limit_reached');
  const validAccounts = await db.query(`SELECT id FROM astra.research_accounts WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
    [actor.tenantId, normalized.map(row => row.accountId)]);
  const validIds = new Set(validAccounts.rows.map(row => String(row.id).toLowerCase()));
  const missing = normalized.find(row => !validIds.has(row.accountId));
  if (missing) fail('Every assigned account must be a canonical account in this tenant.', 404, 'experiment_account_missing');
  const plannedStrata = Array.isArray(plan.strata) ? plan.strata : [];
  for (const row of normalized) {
    if ((plannedStrata.length && !plannedStrata.includes(row.stratum)) || (!plannedStrata.length && row.stratum !== 'all')) {
      fail(`Stratum '${row.stratum}' was not predeclared in the frozen experiment plan.`, 409, 'experiment_stratum_unplanned');
    }
  }
  const arms = experiment.arms;
  const totalWeight = arms.reduce((sum, arm) => sum + Number(arm.weight), 0);
  const assignments = [];
  for (const row of normalized) {
    const previous = await db.query(`SELECT arm_id AS "armId",propensity,stratum,eligibility,assigned_at AS "assignedAt"
      FROM astra.experiment_assignments WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid AND account_id=$3::uuid`,
    [actor.tenantId, id, row.accountId]);
    if (previous.rowCount) {
      const saved = previous.rows[0];
      if (saved.stratum !== row.stratum || stableJson(saved.eligibility) !== row.eligibility) {
        fail('An account assignment already exists with different eligibility facts.', 409, 'experiment_assignment_conflict');
      }
      assignments.push({ accountId: row.accountId, ...saved, duplicate: true });
      continue;
    }
    if (row.sourceEventId) {
      const source = await db.query(`SELECT 1 FROM astra.events WHERE tenant_id=$1::uuid AND id=$2::uuid
        AND entity_type='account' AND entity_id=$3`, [actor.tenantId, row.sourceEventId, row.accountId]);
      if (!source.rowCount) fail('Eligibility source event must belong to the same canonical account.', 404, 'experiment_eligibility_source_missing');
    }
    const chosen = chooseArm(experiment.allocation_key, actor.tenantId, id, row.accountId, row.stratum, totalWeight);
    let offset = 0;
    let selected = arms[0];
    for (const arm of arms) {
      offset += Number(arm.weight);
      if (chosen.point < offset) { selected = arm; break; }
    }
    const propensity = Number(selected.weight) / totalWeight;
    const saved = await db.query(`INSERT INTO astra.experiment_assignments(
        tenant_id,experiment_id,account_id,arm_id,propensity,stratum,eligibility,assignment_hash
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::numeric,$6,$7::jsonb,$8)
      ON CONFLICT(tenant_id,experiment_id,account_id) DO NOTHING
      RETURNING arm_id AS "armId",propensity,stratum,eligibility,assigned_at AS "assignedAt"`,
    [actor.tenantId, id, row.accountId, selected.id, propensity.toFixed(11), row.stratum, row.eligibility, sha256(chosen.digest)]);
    if (saved.rowCount) assignments.push({ accountId: row.accountId, ...saved.rows[0], duplicate: false });
    else {
      const replay = await db.query(`SELECT arm_id AS "armId",propensity,stratum,eligibility,assigned_at AS "assignedAt"
        FROM astra.experiment_assignments WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid AND account_id=$3::uuid`,
      [actor.tenantId, id, row.accountId]);
      if (replay.rows[0].stratum !== row.stratum || stableJson(replay.rows[0].eligibility) !== row.eligibility) {
        fail('A concurrent assignment used different eligibility facts.', 409, 'experiment_assignment_conflict');
      }
      assignments.push({ accountId: row.accountId, ...replay.rows[0], duplicate: true });
    }
  }
  return { experimentId: id, assignments };
}

export async function listAstraExperimentAssignments(db, tenantId, experimentId, { limit = 200 } = {}) {
  const safeLimit = limit == null || limit === '' ? 200
    : Math.max(1, Math.min(500, Number.isInteger(Number(limit)) ? Number(limit) : 200));
  const result = await db.query(`SELECT a.account_id AS "accountId",a.arm_id AS "armId",a.propensity::text AS propensity,
    a.stratum,a.eligibility,a.assignment_hash AS "assignmentHash",a.assigned_at AS "assignedAt"
    FROM astra.experiment_assignments a JOIN astra.experiments e
      ON (e.tenant_id,e.id)=(a.tenant_id,a.experiment_id)
    WHERE a.tenant_id=$1::uuid AND a.experiment_id=$2::uuid ORDER BY a.assigned_at,a.account_id LIMIT $3`,
  [tenantId, experimentId, safeLimit]);
  return result.rows;
}

export async function declareAstraExperimentExposure(db, actor, experimentId, input) {
  const id = text(String(experimentId), 'experimentId', 36);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Exposure declaration must be an object.');
  const accountId = text(String(input.accountId || ''), 'accountId', 36).toLowerCase();
  const sourceEventId = text(String(input.sourceEventId || ''), 'sourceEventId', 36);
  const exposureType = text(input.exposureType, 'exposureType', 40);
  if (!EXPOSURE_TYPES.has(exposureType)) fail('exposureType is unsupported.');
  const occurredAt = new Date(input.occurredAt);
  if (!input.occurredAt || Number.isNaN(occurredAt.valueOf())) fail('occurredAt must be a valid date.');
  if (!input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) fail('evidence must be an object.');
  const evidence = { declaration: 'operator_declared', confidence: 'unknown', details: input.evidence };
  const encoded = object(evidence, 'evidence', 8 * 1024);
  const source = await db.query(`SELECT event_type AS "eventType",entity_type AS "entityType",entity_id AS "entityId",
    occurred_at AS "occurredAt",payload FROM astra.events WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, sourceEventId]);
  if (!source.rowCount) fail('The cited immutable source event was not found for this tenant.', 404, 'exposure_source_missing');
  const event = source.rows[0];
  if (event.entityType !== 'account' || String(event.entityId).toLowerCase() !== accountId) {
    fail('A cited event must identify the same canonical account; cross-entity references are not allowed.', 409, 'exposure_entity_mismatch');
  }
  // The current ledger has no send/exposure event contract. A valid account
  // outcome event is only a trace reference; it does not prove message delivery.
  const proofMatches = VERIFIED_EXPOSURE_EVENT_TYPES.has(event.eventType)
    && event.payload?.exposureType === exposureType && event.payload?.confirmed === true;
  const verificationStatus = proofMatches ? 'verified' : 'unsupported';
  const result = await db.query(`INSERT INTO astra.experiment_exposures(
      tenant_id,experiment_id,account_id,source_event_id,exposure_type,occurred_at,evidence,actor_id,verification_status
    ) SELECT $1::uuid,a.experiment_id,a.account_id,$4::uuid,$5,$6::timestamptz,$7::jsonb,$8,$9
      FROM astra.experiment_assignments a JOIN astra.experiments e
        ON (e.tenant_id,e.id)=(a.tenant_id,a.experiment_id)
      WHERE a.tenant_id=$1::uuid AND a.experiment_id=$2::uuid AND a.account_id=$3::uuid
        AND $6::timestamptz>=a.assigned_at AND $6::timestamptz<=a.assigned_at+make_interval(days=>e.attribution_window_days)
    ON CONFLICT(tenant_id,experiment_id,account_id,source_event_id) DO NOTHING
    RETURNING id,exposure_type AS "exposureType",occurred_at AS "occurredAt",verification_status AS "verificationStatus",created_at AS "createdAt"`,
  [actor.tenantId, id, accountId, sourceEventId, exposureType, occurredAt.toISOString(), encoded, String(actor.userId), verificationStatus]);
  if (result.rowCount) return { ...result.rows[0], duplicate: false, provenance: 'operator_declared' };
  const prior = await db.query(`SELECT x.id,x.exposure_type AS "exposureType",x.occurred_at AS "occurredAt",
      x.verification_status AS "verificationStatus",x.created_at AS "createdAt"
    FROM astra.experiment_exposures x WHERE x.tenant_id=$1::uuid AND x.experiment_id=$2::uuid
      AND x.account_id=$3::uuid AND x.source_event_id=$4::uuid`, [actor.tenantId, id, accountId, sourceEventId]);
  if (prior.rowCount) return { ...prior.rows[0], duplicate: true, provenance: 'operator_declared' };
  fail('Exposure requires an existing account assignment and must occur inside its fixed attribution window.', 409, 'exposure_assignment_missing');
}

export function getAstraExperimentVerifiedExposureEventTypes() {
  return ASTRA_EVENT_TYPES.filter(eventType => VERIFIED_EXPOSURE_EVENT_TYPES.has(eventType));
}
