import { AstraLedgerError } from './astra-ledger.js';

const STAGE_ALIASES = Object.freeze({
  meeting_booked: 'meeting.booked', meeting_held: 'meeting.held', meeting_cancelled: 'meeting.cancelled',
  opportunity_created: 'opportunity.created', opportunity_qualified: 'opportunity.qualified',
  opportunity_won: 'opportunity.won', opportunity_lost: 'opportunity.lost',
  revenue_paid: 'revenue.paid', revenue_refunded: 'revenue.refunded',
});
const FUNNEL_STAGES = Object.freeze(['meeting.booked','meeting.held','opportunity.created','opportunity.qualified',
  'opportunity.won','opportunity.lost','revenue.paid','revenue.refunded']);

function fail(message, status = 400, code = 'astra_analytics_invalid') {
  throw new AstraLedgerError(message, status, code);
}
function normalizeDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) fail(`${field} must be a valid date.`);
  return parsed.toISOString();
}
function normalizeWindow(input = {}) {
  const from = normalizeDate(input.from, 'from');
  const to = normalizeDate(input.to, 'to');
  if (from && to && Date.parse(from) > Date.parse(to)) fail('from must not be later than to.');
  return { from, to };
}
function list(value) { return Array.isArray(value) ? value : []; }
function canonicalStage(value) { return STAGE_ALIASES[value] || value; }
function inRange(value, { from, to }) {
  const time = Date.parse(value);
  return Number.isFinite(time) && (!from || time >= Date.parse(from)) && (!to || time <= Date.parse(to));
}
function keyOf(type, id) { return `${type}\n${id}`; }

function moneyAdd(map, currency, field, amount) {
  if (!currency || !Number.isSafeInteger(amount) || amount < 0) return;
  const current = map.get(currency) || { paidMinor: 0n, refundedMinor: 0n, netMinor: 0n };
  current[field] += BigInt(amount);
  current.netMinor = current.paidMinor - current.refundedMinor;
  map.set(currency, current);
}

function projectFunnel(rows, window) {
  const stageEntities = new Map(FUNNEL_STAGES.map(stage => [stage, new Set()]));
  const totalEntities = new Set();
  const money = new Map();
  for (const row of rows) {
    for (const milestone of list(row.state?.milestones)) {
      if (!inRange(milestone.occurredAt, window)) continue;
      const stage = canonicalStage(milestone.stage);
      if (stageEntities.has(stage)) {
        totalEntities.add(keyOf(row.entityType, row.entityId));
        stageEntities.get(stage).add(keyOf(row.entityType, row.entityId));
      }
      const payload = milestone.payload || {};
      if (stage === 'revenue.paid') moneyAdd(money, payload.currency, 'paidMinor', payload.amountMinor);
      if (stage === 'revenue.refunded') moneyAdd(money, payload.currency, 'refundedMinor', payload.amountMinor);
    }
  }
  return {
    entityDenominator: totalEntities.size,
    eventAccountsAreDirectEntities: false,
    outcomes: Object.fromEntries(FUNNEL_STAGES.map(stage => [stage, stageEntities.get(stage).size])),
    revenue: [...money.keys()].sort().map(currency => Object.fromEntries(Object.entries({ currency, ...money.get(currency) })
      .map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]))),
  };
}

async function tenantUsage(db, tenantId) {
  const result = await db.query(`SELECT state,COUNT(*)::integer AS requests,
      COUNT(*) FILTER (WHERE cost_microusd IS NULL AND state IN ('running','uncertain','failed'))::integer AS "unknownCostRequests",
      COALESCE(SUM(cost_microusd),0)::text AS "knownCostMicrousd",
      COALESCE(SUM(reserved_microusd) FILTER (WHERE state IN ('queued','running','uncertain')),0)::text AS "openReservedMicrousd"
    FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid GROUP BY state ORDER BY state`, [tenantId]);
  const totals = { requests: 0, unknownCostRequests: 0, knownCostMicrousd: 0n, openReservedMicrousd: 0n, byState: {} };
  for (const row of result.rows) {
    const requests = Number(row.requests);
    totals.requests += requests;
    totals.unknownCostRequests += Number(row.unknownCostRequests);
    totals.knownCostMicrousd += BigInt(row.knownCostMicrousd);
    totals.openReservedMicrousd += BigInt(row.openReservedMicrousd);
    totals.byState[row.state] = requests;
  }
  return {
    scope: 'tenant', requests: totals.requests, byState: totals.byState,
    unknownCostRequests: totals.unknownCostRequests,
    knownCostMicrousd: totals.knownCostMicrousd.toString(),
    knownCostComplete: totals.unknownCostRequests === 0,
    openReservedMicrousd: totals.openReservedMicrousd.toString(),
    experimentCostAttribution: 'unavailable_without_experiment_usage_link',
  };
}

export async function getAstraFunnelAnalytics(db, tenantId, options = {}) {
  const window = normalizeWindow(options);
  const projections = await db.query(`SELECT entity_type AS "entityType",entity_id AS "entityId",state
    FROM astra.outcome_projection WHERE tenant_id=$1::uuid ORDER BY latest_sequence`, [tenantId]);
  const assigned = await db.query(`SELECT COUNT(*)::integer AS count FROM astra.experiment_assignments WHERE tenant_id=$1::uuid`, [tenantId]);
  const declared = await db.query(`SELECT verification_status AS status,COUNT(*)::integer AS count
    FROM astra.experiment_exposures WHERE tenant_id=$1::uuid GROUP BY verification_status ORDER BY verification_status`, [tenantId]);
  const exposureStatus = { declared: 0, verified: 0, unsupported: 0 };
  for (const row of declared.rows) {
    const count = Number(row.count);
    exposureStatus.declared += count;
    if (row.status === 'verified' || row.status === 'unsupported') exposureStatus[row.status] += count;
  }
  const eventWindow = projectFunnel(projections.rows, window);
  return {
    window,
    basis: 'correction_aware_astra_outcome_projection',
    eventEntityDenominator: eventWindow.entityDenominator,
    eventEntityTypeDenominator: 'distinct event entity type and id; contacts are not assumed to be accounts',
    funnel: eventWindow.outcomes,
    revenue: eventWindow.revenue,
    assignments: { tenantWideCount: Number(assigned.rows[0]?.count || 0), separateFromExposures: true },
    exposures: { ...exposureStatus, verifiedOnlyCountsAsObservedExposure: true },
    usage: await tenantUsage(db, tenantId),
    attribution: 'none_in_tenant_funnel; see per-experiment exact account matching',
    causalLift: 'not_computed',
  };
}

function wilson(successes, observations, z = 1.959963984540054) {
  if (!observations) return null;
  const p = successes / observations;
  const z2 = z * z;
  const denom = 1 + z2 / observations;
  const center = (p + z2 / (2 * observations)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) / observations) + z2 / (4 * observations * observations)) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), level: 0.95, method: 'Wilson score, descriptive' };
}

function matchedPrimaryOutcome(projection, metric, assignedAt, attributionDays) {
  const start = Date.parse(assignedAt);
  const end = start + attributionDays * 86400000;
  const milestones = list(projection?.milestones);
  return milestones.some(milestone => {
    const stage = canonicalStage(milestone.stage);
    const at = Date.parse(milestone.occurredAt);
    return stage === metric && Number.isFinite(at) && at >= start && at <= end;
  });
}

export async function getAstraExperimentAnalysis(db, tenantId, experimentId, { now = new Date() } = {}) {
  const experimentResult = await db.query(`SELECT id,name,hypothesis,arms,primary_metric AS "primaryMetric",
      primary_horizon_days AS "primaryHorizonDays",attribution_window_days AS "attributionWindowDays",
      stopping_rule AS "stoppingRule",max_accounts AS "maxAccounts",max_cost_microusd::text AS "maxCostMicrousd",
      plan_sha256 AS "planSha256",plan->'costGuard' AS "costGuard",status,created_at AS "createdAt"
    FROM astra.experiments WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, experimentId]);
  const experiment = experimentResult.rows[0];
  if (!experiment) fail('Experiment was not found for this tenant.', 404, 'experiment_not_found');
  const assignmentRows = await db.query(`SELECT a.account_id AS "accountId",a.arm_id AS "armId",a.propensity::text AS propensity,
      a.stratum,a.assigned_at AS "assignedAt",p.state AS projection
    FROM astra.experiment_assignments a LEFT JOIN astra.outcome_projection p
      ON p.tenant_id=a.tenant_id AND p.entity_type='account' AND p.entity_id=a.account_id::text
    WHERE a.tenant_id=$1::uuid AND a.experiment_id=$2::uuid ORDER BY a.assigned_at,a.account_id`, [tenantId, experimentId]);
  const exposures = await db.query(`SELECT a.arm_id AS "armId",x.verification_status AS status,COUNT(*)::integer AS count
    FROM astra.experiment_exposures x JOIN astra.experiment_assignments a
      ON (a.tenant_id,a.experiment_id,a.account_id)=(x.tenant_id,x.experiment_id,x.account_id)
    WHERE x.tenant_id=$1::uuid AND x.experiment_id=$2::uuid GROUP BY a.arm_id,x.verification_status ORDER BY a.arm_id,x.verification_status`,
  [tenantId, experimentId]);
  const exposureByArm = Object.fromEntries(experiment.arms.map(arm => [arm.id, { declared: 0, verified: 0, unsupported: 0 }]));
  for (const row of exposures.rows) {
    const count = Number(row.count);
    const armExposure = exposureByArm[row.armId];
    if (!armExposure) continue;
    armExposure.declared += count;
    if (row.status === 'verified' || row.status === 'unsupported') armExposure[row.status] += count;
  }
  const assignedAt = now instanceof Date ? now.valueOf() : new Date(now).valueOf();
  const maturityDays = Math.max(Number(experiment.primaryHorizonDays), Number(experiment.attributionWindowDays));
  const maturityMs = maturityDays * 86400000;
  const arms = experiment.arms.map(arm => {
    const cohort = assignmentRows.rows.filter(row => row.armId === arm.id);
    const matured = cohort.filter(row => Date.parse(row.assignedAt) + maturityMs <= assignedAt);
    const pending = cohort.length - matured.length;
    const successes = matured.filter(row => matchedPrimaryOutcome(row.projection, experiment.primaryMetric,
      row.assignedAt, Number(experiment.attributionWindowDays))).length;
    return {
      id: arm.id, label: arm.label, variant: arm.variant, variantHash: arm.variantHash,
      control: Boolean(arm.control), plannedWeight: Number(arm.weight),
      assignedAccounts: cohort.length, maturedDenominator: matured.length, pendingOutcomes: pending,
      primaryMetric: experiment.primaryMetric, matchedAccountOutcomes: successes,
      maturationDays: maturityDays,
      rate: matured.length ? successes / matured.length : null,
      interval95: wilson(successes, matured.length),
      exposures: exposureByArm[arm.id] || { declared: 0, verified: 0, unsupported: 0 },
    };
  });
  const strata = {};
  for (const row of assignmentRows.rows) strata[row.stratum] = (strata[row.stratum] || 0) + 1;
  return {
    experiment: { id: experiment.id, name: experiment.name, hypothesis: experiment.hypothesis, status: experiment.status,
      planSha256: experiment.planSha256, primaryMetric: experiment.primaryMetric,
      primaryHorizonDays: experiment.primaryHorizonDays, attributionWindowDays: experiment.attributionWindowDays,
      maturationDays: maturityDays,
      maxAccounts: experiment.maxAccounts, stoppingRule: experiment.stoppingRule, costGuard: experiment.costGuard },
    denominator: { assignedAccounts: assignmentRows.rowCount, distinctCanonicalAccountUnit: true,
      maturedAccounts: arms.reduce((sum, arm) => sum + arm.maturedDenominator, 0),
      pendingAccounts: arms.reduce((sum, arm) => sum + arm.pendingOutcomes, 0) },
    strata, arms,
    attribution: 'exact_canonical_account_id; outcome occurred between assignment and predeclared attribution-window end; correction-aware projection',
    causalLift: 'not_computed',
    uncertainty: 'Per-arm descriptive Wilson intervals retain raw denominators and do not claim statistical significance or causal lift.',
    cost: { configuredGuardMicrousd: String(experiment.maxCostMicrousd),
      estimatedMicrousdPerAccount: String(experiment.costGuard?.estimatedMicrousdPerAccount ?? ''),
      status: 'estimated_guard_only_actual_experiment_usage_unlinked', actualCostMicrousd: null },
    exposureEvidence: 'Operator declarations are separate from assignments. Current ledger has no send-exposure event contract; unsupported declarations do not count as verified exposures.',
  };
}
