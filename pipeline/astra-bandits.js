import { createHmac, randomUUID } from 'node:crypto';
import { AstraLedgerError, canonicalJson, sha256 } from './astra-ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METRICS = new Set(['meeting.held', 'opportunity.qualified', 'opportunity.won', 'revenue.paid']);
const MAX_ARMS = 8;
const MAX_ACCOUNTS = 1000;
const MAX_WEIGHT = 100;
const MAX_EXPLORATION = 0.2;

function fail(message, status = 400, code = 'bandit_invalid') {
  throw new AstraLedgerError(message, status, code);
}
function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${field} must be a UUID.`);
  return value.toLowerCase();
}
function text(value, field, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function stableJson(value) { return canonicalJson(stable(value)); }
function dateIso(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) fail(`${field} must be a valid date.`);
  return date.toISOString();
}
function assertTenant(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    fail('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
}
function canonicalArmHash(variant) { return sha256(stableJson(variant)); }

async function safeReleaseEvidence(db, tenantId, releaseId) {
  const q = await db.query(`SELECT r.id,r.candidate_id AS "candidateId",r.manifest,r.manifest_sha256 AS "manifestSha256",
      r.status, c.manifest_sha256 AS "candidateHash",
      count(DISTINCT a.approval_role) FILTER(WHERE a.decision='approve' AND a.manifest_sha256=r.manifest_sha256)::int AS "approvalRoles",
      count(DISTINCT a.approved_by) FILTER(WHERE a.decision='approve' AND a.manifest_sha256=r.manifest_sha256)::int AS "approvers"
    FROM astra.release_artifacts r JOIN astra.eval_candidates c ON(c.tenant_id,c.id)=(r.tenant_id,r.candidate_id)
    LEFT JOIN astra.release_approvals a ON(a.tenant_id,a.release_id)=(r.tenant_id,r.id)
    WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid GROUP BY r.id,c.manifest_sha256`, [tenantId, releaseId]);
  const release = q.rows[0];
  if (!release || release.status !== 'approved_not_deployed' || release.approvalRoles !== 2 || release.approvers !== 2) {
    fail('An independently approved, non-deployed evaluation release is required.', 409, 'bandit_release_unapproved');
  }
  const launch = await db.query(`SELECT l.id,l.manifest,l.manifest_sha256 AS "manifestSha256",
      count(DISTINCT s.approval_role) FILTER(WHERE s.decision='approve' AND s.manifest_sha256=l.manifest_sha256)::int AS "approvalRoles",
      count(DISTINCT s.approved_by) FILTER(WHERE s.decision='approve' AND s.manifest_sha256=l.manifest_sha256)::int AS "approvers"
    FROM astra.launch_releases l LEFT JOIN astra.launch_release_signoffs s ON(s.tenant_id,s.release_id)=(l.tenant_id,l.id)
    WHERE l.tenant_id=$1::uuid AND l.source_release_id=$2::uuid AND l.status='approved_not_deployed'
      AND jsonb_array_length(COALESCE(l.manifest->'blockingEvidence','[]'::jsonb))=0
      AND l.manifest->'sourceRelease'->>'manifestSha256'=$3
    GROUP BY l.id ORDER BY l.created_at DESC`, [tenantId, releaseId, String(release.manifestSha256).trim()]);
  const compatible = launch.rows.find(row => row.approvalRoles === 2 && row.approvers === 2);
  if (!compatible) fail('No independently approved current-policy launch release supports this arm; manual review is required.', 409, 'bandit_policy_evidence_missing');
  const killed = await db.query(`SELECT 1 FROM astra.operational_kill_switches WHERE tenant_id=$1::uuid AND enabled=true LIMIT 1`, [tenantId]);
  if (killed.rowCount) fail('A tenant kill switch excludes this arm; manual review is required.', 409, 'bandit_policy_excluded');
  return { release, launchRelease: compatible };
}

/** Register only frozen experiment variants whose candidate hash and current approved policy release agree. */
export async function registerAstraBanditArms(db, actor, input) {
  object(input, 'body');
  const experimentId = uuid(input.experimentId, 'experimentId');
  if (!Array.isArray(input.arms) || input.arms.length < 2 || input.arms.length > MAX_ARMS) fail('arms must list between two and eight frozen experiment arms.');
  const experiment = await db.query(`SELECT id,arms,primary_metric AS "primaryMetric",primary_horizon_days AS "primaryHorizonDays",
      attribution_window_days AS "attributionWindowDays",plan,plan_sha256 AS "planHash",status
    FROM astra.experiments WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, experimentId]);
  const e = experiment.rows[0];
  if (!e) fail('Experiment was not found for this tenant.', 404, 'bandit_experiment_not_found');
  if (!METRICS.has(e.primaryMetric) || !e.plan?.stoppingRule || e.plan.stoppingRule.type !== 'fixed_sample'
      || e.plan.stoppingRule.adaptive === true || e.plan.stoppingRule.continuousPeeking === true) {
    fail('The fixed experiment plan does not support a confirmatory bandit lane.', 409, 'bandit_experiment_unsupported');
  }
  const byId = new Map((e.arms || []).map(arm => [arm.id, arm]));
  const prepared = [];
  const seen = new Set();
  for (const [i, declaration] of input.arms.entries()) {
    object(declaration, `arms[${i}]`);
    const armId = text(declaration.armId, `arms[${i}].armId`, 80);
    if (seen.has(armId)) fail('Arm declarations must be unique.');
    seen.add(armId);
    const arm = byId.get(armId);
    if (!arm || canonicalArmHash(arm.variant) !== String(arm.variantHash).toLowerCase()) fail(`Arm ${armId} is not an intact frozen experiment variant.`, 409, 'bandit_variant_mismatch');
    const releaseId = uuid(declaration.releaseId, `arms[${i}].releaseId`);
    const evidence = await safeReleaseEvidence(db, actor.tenantId, releaseId);
    const candidateRef = arm.variant?.candidateId;
    const candidateHash = arm.variant?.candidateManifestSha256;
    if ((candidateRef && String(candidateRef).toLowerCase() !== String(evidence.release.candidateId).toLowerCase())
      || (!candidateRef && candidateHash !== String(evidence.release.candidateHash).trim())
      || (!candidateRef && !candidateHash)) {
      fail(`Arm ${armId} has no exact frozen candidate-to-release binding; manual review is required.`, 409, 'bandit_release_variant_mismatch');
    }
    if (candidateRef && candidateHash && candidateHash !== String(evidence.release.candidateHash).trim()) fail(`Arm ${armId} candidate manifest hash does not match its approved release.`, 409, 'bandit_release_variant_mismatch');
    prepared.push({ armId, releaseId, arm, variantJson: stableJson(arm.variant), evidence });
  }
  if (seen.size !== byId.size) fail('Every frozen experiment arm must be explicitly registered or the fixed lane is incomplete.', 409, 'bandit_arm_set_incomplete');
  const saved = [];
  for (const row of prepared) {
    const q = await db.query(`INSERT INTO astra.bandit_arm_registry(tenant_id,experiment_id,arm_id,variant,variant_sha256,release_id,
        release_manifest_sha256,launch_release_id,launch_manifest_sha256,registered_by)
      VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6::uuid,$7,$8::uuid,$9,$10)
      ON CONFLICT(tenant_id,experiment_id,arm_id) DO NOTHING
      RETURNING arm_id AS "armId",variant_sha256 AS "variantHash",release_id AS "releaseId",launch_release_id AS "launchReleaseId",created_at AS "createdAt"`,
    [actor.tenantId, experimentId, row.armId, row.variantJson, row.arm.variantHash, row.releaseId,
      String(row.evidence.release.manifestSha256).trim(), row.evidence.launchRelease.id,
      String(row.evidence.launchRelease.manifestSha256).trim(), String(actor.userId)]);
    if (q.rowCount) saved.push(q.rows[0]);
    else {
      const existing = await db.query(`SELECT arm_id AS "armId",variant_sha256 AS "variantHash",release_id AS "releaseId",
          launch_release_id AS "launchReleaseId",created_at AS "createdAt" FROM astra.bandit_arm_registry
        WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid AND arm_id=$3`, [actor.tenantId, experimentId, row.armId]);
      const prior = existing.rows[0];
      if (!prior || prior.variantHash.trim() !== row.arm.variantHash || prior.releaseId !== row.releaseId
        || prior.launchReleaseId !== row.evidence.launchRelease.id) fail(`Arm ${row.armId} is already registered to different immutable release evidence.`, 409, 'bandit_arm_conflict');
      saved.push(prior);
    }
  }
  return { experimentId, arms: saved, liveAllocation: false, releaseReady: false };
}

export async function listAstraBanditArms(db, tenantId, { experimentId } = {}) {
  const id = experimentId == null ? null : uuid(experimentId, 'experimentId');
  const q = await db.query(`SELECT experiment_id AS "experimentId",arm_id AS "armId",variant_sha256 AS "variantHash",
      release_id AS "releaseId",release_manifest_sha256 AS "releaseManifestHash",launch_release_id AS "launchReleaseId",
      launch_manifest_sha256 AS "launchManifestHash",registered_by AS "registeredBy",created_at AS "createdAt"
    FROM astra.bandit_arm_registry WHERE tenant_id=$1::uuid AND ($2::uuid IS NULL OR experiment_id=$2::uuid)
    ORDER BY created_at,experiment_id,arm_id LIMIT 1000`, [tenantId, id]);
  return q.rows;
}

/** Fixed randomized evaluation lane. It records proposals only; it cannot assign campaign traffic. */
export async function createAstraBanditLane(db, actor, input) {
  object(input, 'body');
  const experimentId = uuid(input.experimentId, 'experimentId');
  const seed = text(input.seed, 'seed', 120);
  const explorationCap = Number(input.maxExplorationFraction);
  if (!Number.isFinite(explorationCap) || explorationCap < 0 || explorationCap > MAX_EXPLORATION) fail('maxExplorationFraction must be between 0 and 0.2.');
  const e = await db.query(`SELECT id,arms,primary_metric AS "primaryMetric",primary_horizon_days AS "primaryHorizonDays",
      attribution_window_days AS "attributionWindowDays",plan,plan_sha256 AS "planHash",status
    FROM astra.experiments WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, experimentId]);
  if (!e.rows[0]) fail('Experiment was not found for this tenant.', 404, 'bandit_experiment_not_found');
  const registered = await db.query(`SELECT arm_id AS "armId",release_id AS "releaseId" FROM astra.bandit_arm_registry
    WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid ORDER BY arm_id`, [actor.tenantId, experimentId]);
  const weights = new Map((e.rows[0].arms || []).map(a => [a.id, Number(a.weight)]));
  if (registered.rowCount !== weights.size || !registered.rows.length) fail('All experiment arms require exact approved registry evidence before a fixed lane can be prepared.', 409, 'bandit_arm_registry_incomplete');
  for (const row of registered.rows) await safeReleaseEvidence(db, actor.tenantId, row.releaseId);
  const total = registered.rows.reduce((sum, row) => sum + weights.get(row.armId), 0);
  const probabilities = Object.fromEntries(registered.rows.map(row => [row.armId, weights.get(row.armId) / total]));
  const controlId = (e.rows[0].arms || []).find(arm => arm.control === true)?.id;
  if (!controlId) fail('The frozen plan has no unique control arm; manual review is required.', 409, 'bandit_control_unknown');
  const exploration = Object.entries(probabilities).filter(([armId]) => armId !== controlId).reduce((sum, [, p]) => sum + p, 0);
  if (exploration > explorationCap + 1e-12) fail('The frozen treatment probability exceeds the declared maximum exploration cap.', 409, 'bandit_exploration_cap_exceeded');
  const plan = stable({ schemaVersion: 'astra-bandit-fixed-lane/1.0.0', experimentId, experimentPlanHash: String(e.rows[0].planHash).trim(),
    primaryMetric: e.rows[0].primaryMetric, primaryHorizonDays: e.rows[0].primaryHorizonDays,
    attributionWindowDays: e.rows[0].attributionWindowDays,
    maturityHorizonDays: Math.max(e.rows[0].primaryHorizonDays, e.rows[0].attributionWindowDays),
    seed, probabilities, maxExplorationFraction: explorationCap,
    lane: 'offline_proposal_only', sendsAllowed: false, automaticPromotion: false, releaseReady: false });
  const planJson = stableJson(plan);
  const id = randomUUID();
  const q = await db.query(`INSERT INTO astra.bandit_evaluation_lanes(tenant_id,id,experiment_id,seed,plan,plan_sha256,max_exploration_fraction,created_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8)
    RETURNING id,experiment_id AS "experimentId",plan,plan_sha256 AS "planHash",created_at AS "createdAt"`,
  [actor.tenantId, id, experimentId, seed, planJson, sha256(planJson), explorationCap, String(actor.userId)]);
  return { ...q.rows[0], liveAllocation: false, sendsAllowed: false, releaseReady: false };
}

export async function proposeAstraBanditAllocations(db, actor, laneId, input) {
  const id = uuid(laneId, 'laneId');
  object(input, 'body');
  if (!Array.isArray(input.accountIds) || input.accountIds.length < 1 || input.accountIds.length > MAX_ACCOUNTS) fail(`accountIds must contain one to ${MAX_ACCOUNTS} accounts.`);
  const ids = input.accountIds.map((value, i) => uuid(value, `accountIds[${i}]`));
  if (new Set(ids).size !== ids.length) fail('accountIds must be unique.');
  const laneQ = await db.query(`SELECT id,experiment_id AS "experimentId",seed,plan FROM astra.bandit_evaluation_lanes
    WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, id]);
  const lane = laneQ.rows[0];
  if (!lane) fail('Evaluation lane was not found for this tenant.', 404, 'bandit_lane_not_found');
  const armEvidence = await db.query(`SELECT arm_id AS "armId",release_id AS "releaseId" FROM astra.bandit_arm_registry
    WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid`, [actor.tenantId, lane.experimentId]);
  for (const arm of armEvidence.rows) await safeReleaseEvidence(db, actor.tenantId, arm.releaseId);
  const accounts = await db.query(`SELECT a.account_id AS "accountId",a.stratum,a.eligibility,a.assignment_hash AS "assignmentHash",e.plan
    FROM astra.experiment_assignments a JOIN astra.experiments e ON(e.tenant_id,e.id)=(a.tenant_id,a.experiment_id)
    WHERE a.tenant_id=$1::uuid AND a.experiment_id=$2::uuid AND a.account_id=ANY($3::uuid[])`, [actor.tenantId, lane.experimentId, ids]);
  if (accounts.rowCount !== ids.length) fail('Every proposed account must belong to the persisted fixed experiment cohort; unsupported cohorts require manual review.', 409, 'bandit_cohort_unsupported');
  const cohortById = new Map(accounts.rows.map(row => [String(row.accountId).toLowerCase(), row]));
  for (const accountId of ids) {
    const cohort = cohortById.get(accountId);
    const planned = Array.isArray(cohort.plan?.strata) ? cohort.plan.strata : [];
    if (!cohort.eligibility || typeof cohort.eligibility !== 'object'
      || (planned.length ? !planned.includes(cohort.stratum) : cohort.stratum !== 'all')) {
      fail(`Account ${accountId} is outside the frozen supported cohort; manual review is required.`, 409, 'bandit_cohort_unsupported');
    }
  }
  const probabilities = lane.plan.probabilities;
  const orderedArms = Object.keys(probabilities).sort();
  const proposals = [];
  for (const accountId of ids) {
    const digest = createHmac('sha256', lane.seed).update(`${actor.tenantId}\n${lane.id}\n${accountId}`).digest('hex');
    const point = Number(BigInt(`0x${digest}`)) / Number(BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'));
    let cumulative = 0;
    let armId = orderedArms.at(-1);
    for (const candidate of orderedArms) { cumulative += probabilities[candidate]; if (point < cumulative) { armId = candidate; break; } }
    const propensity = probabilities[armId];
    const cohort = cohortById.get(accountId);
    const q = await db.query(`INSERT INTO astra.bandit_lane_proposals(tenant_id,lane_id,experiment_id,account_id,arm_id,propensity,source_assignment_hash,allocation_hash)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8) ON CONFLICT(tenant_id,lane_id,account_id) DO NOTHING
      RETURNING account_id AS "accountId",arm_id AS "armId",propensity::text AS propensity,allocation_hash AS "allocationHash",created_at AS "createdAt"`,
    [actor.tenantId, id, lane.experimentId, accountId, armId, propensity.toFixed(11), String(cohort.assignmentHash).trim(), sha256(digest)]);
    if (q.rowCount) proposals.push(q.rows[0]);
    else {
      const replay = await db.query(`SELECT account_id AS "accountId",arm_id AS "armId",propensity::text AS propensity,
          source_assignment_hash AS "sourceAssignmentHash",allocation_hash AS "allocationHash",created_at AS "createdAt" FROM astra.bandit_lane_proposals
        WHERE tenant_id=$1::uuid AND lane_id=$2::uuid AND account_id=$3::uuid`, [actor.tenantId, id, accountId]);
      proposals.push(replay.rows[0]);
    }
  }
  return { laneId: id, proposals, proposalsOnly: true, campaignAssignmentsChanged: false, sendsAllowed: false, releaseReady: false };
}

/** Capture behavior only from the immutable S24 assignment and independently verified exposure rows. */
export async function captureAstraBanditObservations(db, actor, laneId, input) {
  const id = uuid(laneId, 'laneId');
  object(input, 'body');
  if (!Array.isArray(input.accountIds) || input.accountIds.length < 1 || input.accountIds.length > MAX_ACCOUNTS) fail(`accountIds must contain one to ${MAX_ACCOUNTS} accounts.`);
  const ids = input.accountIds.map((value, i) => uuid(value, `accountIds[${i}]`));
  if (new Set(ids).size !== ids.length) fail('accountIds must be unique.');
  const laneQ = await db.query(`SELECT experiment_id AS "experimentId",plan FROM astra.bandit_evaluation_lanes WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, id]);
  if (!laneQ.rows[0]) fail('Evaluation lane was not found for this tenant.', 404, 'bandit_lane_not_found');
  const experimentId = laneQ.rows[0].experimentId;
  const releaseEvidence = await db.query(`SELECT release_id AS "releaseId" FROM astra.bandit_arm_registry
    WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid`, [actor.tenantId, experimentId]);
  for (const arm of releaseEvidence.rows) await safeReleaseEvidence(db, actor.tenantId, arm.releaseId);
  const assignments = await db.query(`SELECT a.account_id AS "accountId",a.arm_id AS "armId",a.propensity::text AS propensity,
      a.assigned_at AS "assignedAt",x.id AS "exposureId",x.source_event_id AS "sourceEventId",x.occurred_at AS "exposedAt"
    FROM astra.experiment_assignments a JOIN astra.experiment_exposures x
      ON(x.tenant_id,x.experiment_id,x.account_id)=(a.tenant_id,a.experiment_id,a.account_id)
    WHERE a.tenant_id=$1::uuid AND a.experiment_id=$2::uuid AND a.account_id=ANY($3::uuid[])
      AND x.verification_status='verified' ORDER BY a.account_id,x.occurred_at,x.id`, [actor.tenantId, experimentId, ids]);
  const latest = new Map();
  for (const row of assignments.rows) latest.set(String(row.accountId).toLowerCase(), row);
  const registry = await db.query(`SELECT arm_id AS "armId" FROM astra.bandit_arm_registry WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid`, [actor.tenantId, experimentId]);
  const knownArms = new Set(registry.rows.map(row => row.armId));
  const saved = [];
  for (const accountId of ids) {
    const row = latest.get(accountId);
    if (!row) fail(`Account ${accountId} lacks a persisted assignment with a verified exposure.`, 409, 'bandit_observation_evidence_missing');
    if (!knownArms.has(row.armId)) fail(`Observed arm ${row.armId} is outside the registered finite arm set.`, 409, 'bandit_arm_unregistered');
    const p = Number(row.propensity), expected = Number(laneQ.rows[0].plan.probabilities[row.armId]);
    if (!Number.isFinite(p) || p <= 0 || p > 1 || !Number.isFinite(expected) || Math.abs(p - expected) > 1e-9) {
      fail('Persisted behavior propensity does not match the predeclared randomized evaluation lane.', 409, 'bandit_propensity_mismatch');
    }
    const q = await db.query(`INSERT INTO astra.bandit_observations(tenant_id,lane_id,experiment_id,account_id,arm_id,propensity,
        assignment_at,exposure_id,source_event_id,exposed_at,assignment_hash)
      SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::numeric,$7::timestamptz,$8::uuid,$9::uuid,$10::timestamptz,a.assignment_hash
      FROM astra.experiment_assignments a WHERE a.tenant_id=$1::uuid AND a.experiment_id=$3::uuid AND a.account_id=$4::uuid
      ON CONFLICT(tenant_id,lane_id,account_id) DO NOTHING
      RETURNING account_id AS "accountId",arm_id AS "armId",propensity::text AS propensity,assignment_at AS "assignedAt",exposure_id AS "exposureId",created_at AS "createdAt"`,
    [actor.tenantId, id, experimentId, accountId, row.armId, p.toFixed(11), new Date(row.assignedAt).toISOString(), row.exposureId, row.sourceEventId, new Date(row.exposedAt).toISOString()]);
    if (q.rowCount) saved.push(q.rows[0]);
    else {
      const prior = await db.query(`SELECT account_id AS "accountId",arm_id AS "armId",propensity::text AS propensity,
          assignment_at AS "assignedAt",exposure_id AS "exposureId",created_at AS "createdAt" FROM astra.bandit_observations
        WHERE tenant_id=$1::uuid AND lane_id=$2::uuid AND account_id=$3::uuid`, [actor.tenantId, id, accountId]);
      if (prior.rows[0]?.armId !== row.armId || Number(prior.rows[0]?.propensity) !== p) fail('An observation already exists with different immutable behavior evidence.', 409, 'bandit_observation_conflict');
      saved.push(prior.rows[0]);
    }
  }
  return { laneId: id, observations: saved, source: 'persisted_assignment_and_verified_exposure', liveAllocation: false, releaseReady: false };
}

function eventStage(row) { return row.payload?.stage || row.eventType; }
function deriveReward(rows, metric, assignedAt, horizonDays, attributionDays, now) {
  const maturityAt = new Date(new Date(assignedAt).valueOf() + horizonDays * 86400000);
  const attributionAt = new Date(new Date(assignedAt).valueOf() + attributionDays * 86400000);
  const afterAssignment = rows.filter(row => new Date(row.occurredAt) >= new Date(assignedAt)
    || (['outcome.corrected', 'outcome.reversed'].includes(row.eventType) && new Date(row.recordedAt) >= new Date(assignedAt)));
  const invalidated = new Set(afterAssignment.filter(row => ['outcome.corrected', 'outcome.reversed'].includes(row.eventType)).map(row => row.correctsEventId).filter(Boolean));
  const active = afterAssignment.filter(row => !invalidated.has(row.id)
    && (new Date(row.occurredAt) <= attributionAt || ['outcome.corrected', 'outcome.reversed', 'revenue.refunded'].includes(row.eventType)))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const signals = [];
  const paid = new Map(); const refunded = new Map();
  for (const row of active) {
    if (row.eventType === 'outcome.reversed') continue;
    let eventType = row.eventType; let stage = eventStage(row); let payload = row.payload || {}; let sourceId = row.id;
    if (row.eventType === 'outcome.corrected') {
      const replacementAt = new Date(payload.replacementOccurredAt || row.occurredAt);
      if (Number.isNaN(replacementAt.valueOf()) || replacementAt < new Date(assignedAt) || replacementAt > attributionAt) continue;
      eventType = payload.replacementEventType || eventType;
      stage = payload.replacement?.stage || stage;
      payload = payload.replacement || {};
    }
    if (metric === 'revenue.paid') {
      if ((stage === 'revenue_paid' || stage === 'revenue.paid' || eventType === 'revenue.paid') && Number.isSafeInteger(payload.amountMinor) && payload.currency) paid.set(payload.currency, (paid.get(payload.currency) || 0) + payload.amountMinor);
      if ((stage === 'revenue_refunded' || stage === 'revenue.refunded' || eventType === 'revenue.refunded') && Number.isSafeInteger(payload.amountMinor) && payload.currency) refunded.set(payload.currency, (refunded.get(payload.currency) || 0) + payload.amountMinor);
    } else if (stage === metric || stage?.replace('_', '.') === metric || eventType === metric) signals.push({ eventId: sourceId, reward: 1 });
    if (stage === 'label' && payload.label === metric && typeof payload.value === 'number' && Number.isFinite(payload.value)) signals.push({ eventId: sourceId, reward: payload.value });
  }
  let value = null; let eventIds = [];
  if (metric === 'revenue.paid') {
    const currencies = new Set([...paid.keys(), ...refunded.keys()]);
    if (currencies.size === 1) {
      const currency = [...currencies][0];
      value = (paid.get(currency) || 0) - (refunded.get(currency) || 0);
      eventIds = active.filter(row => ['revenue.paid', 'revenue.refunded', 'outcome.corrected', 'outcome.reversed'].includes(row.eventType)).map(row => row.id);
    }
  } else if (signals.length) {
    value = signals.reduce((sum, row) => sum + row.reward, 0);
    eventIds = signals.map(row => row.eventId);
  }
  const status = new Date(now) < maturityAt ? 'pending' : value === null ? 'censored_unknown' : 'matured_observed';
  const snapshot = { evaluatedAt: new Date(now).toISOString(), maturityAt: maturityAt.toISOString(), attributionAt: attributionAt.toISOString(),
    eventIds: [...new Set(eventIds)].sort(), reward: value, metric, status, evidence: 'canonical_tenant_ledger_events' };
  const snapshotSha256 = sha256(stableJson({ maturityAt: snapshot.maturityAt, attributionAt: snapshot.attributionAt,
    eventIds: snapshot.eventIds, reward: snapshot.reward, metric: snapshot.metric, status, evidence: snapshot.evidence }));
  snapshot.evidenceSha256 = snapshotSha256;
  if (status === 'pending') return { status, reward: null, snapshot, snapshotSha256 };
  if (status === 'censored_unknown') return { status, reward: null, snapshot, snapshotSha256 };
  return { status, reward: value, snapshot, snapshotSha256 };
}

export async function refreshAstraBanditRewards(db, actor, laneId, { now = new Date() } = {}) {
  const id = uuid(laneId, 'laneId');
  const evaluatedAt = dateIso(now, 'now');
  const lane = await db.query(`SELECT l.experiment_id AS "experimentId",e.primary_metric AS "primaryMetric",
      e.primary_horizon_days AS "primaryHorizonDays",e.attribution_window_days AS "attributionWindowDays"
    FROM astra.bandit_evaluation_lanes l JOIN astra.experiments e ON(e.tenant_id,e.id)=(l.tenant_id,l.experiment_id)
    WHERE l.tenant_id=$1::uuid AND l.id=$2::uuid`, [actor.tenantId, id]);
  if (!lane.rows[0]) fail('Evaluation lane was not found for this tenant.', 404, 'bandit_lane_not_found');
  const obs = await db.query(`SELECT account_id AS "accountId",arm_id AS "armId",assignment_at AS "assignedAt"
    FROM astra.bandit_observations WHERE tenant_id=$1::uuid AND lane_id=$2::uuid ORDER BY account_id`, [actor.tenantId, id]);
  const results = [];
  for (const row of obs.rows) {
    const events = await db.query(`SELECT id,sequence,event_type AS "eventType",entity_type AS "entityType",entity_id AS "entityId",
        occurred_at AS "occurredAt",payload,corrects_event_id AS "correctsEventId",
        recorded_at AS "recordedAt"
      FROM astra.events WHERE tenant_id=$1::uuid AND entity_type='account' AND entity_id=$2
        AND (occurred_at >= $3::timestamptz OR (event_type IN ('outcome.corrected','outcome.reversed') AND recorded_at >= $3::timestamptz))
        AND recorded_at <= $4::timestamptz ORDER BY sequence`,
    [actor.tenantId, row.accountId, new Date(row.assignedAt).toISOString(), evaluatedAt]);
    const derived = deriveReward(events.rows, lane.rows[0].primaryMetric, row.assignedAt,
      Math.max(Number(lane.rows[0].primaryHorizonDays), Number(lane.rows[0].attributionWindowDays)),
      Number(lane.rows[0].attributionWindowDays), evaluatedAt);
    const encoded = stableJson(derived.snapshot);
    const saved = await db.query(`INSERT INTO astra.bandit_reward_reviews(tenant_id,lane_id,account_id,status,reward,snapshot,snapshot_sha256,reviewed_by)
      SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8
      WHERE NOT EXISTS(SELECT 1 FROM astra.bandit_reward_reviews prior WHERE prior.tenant_id=$1::uuid AND prior.lane_id=$2::uuid
        AND prior.account_id=$3::uuid AND prior.snapshot_sha256=$7)
      RETURNING account_id AS "accountId",status,reward,snapshot_sha256 AS "snapshotHash",created_at AS "reviewedAt"`,
    [actor.tenantId, id, row.accountId, derived.status, derived.reward, encoded, derived.snapshotSha256, String(actor.userId)]);
    if (saved.rowCount) results.push(saved.rows[0]);
    else {
      const prior = await db.query(`SELECT account_id AS "accountId",status,reward,snapshot_sha256 AS "snapshotHash",created_at AS "reviewedAt"
        FROM astra.bandit_reward_reviews WHERE tenant_id=$1::uuid AND lane_id=$2::uuid AND account_id=$3::uuid
        ORDER BY created_at DESC LIMIT 1`, [actor.tenantId, id, row.accountId]);
      results.push(prior.rows[0]);
    }
  }
  return { laneId: id, reviews: results, absentOutcome: 'unknown_not_zero', releaseReady: false };
}

function estimateArm(armId, rows, clip) {
  const n = rows.length;
  const selected = rows.filter(row => row.armId === armId);
  const selectedWeights = selected.map(row => Math.min(clip, 1 / Number(row.propensity)));
  const effectiveSampleSize = selectedWeights.length ? selectedWeights.reduce((a, w) => a + w, 0) ** 2 / selectedWeights.reduce((a, w) => a + w * w, 0) : 0;
  const clipped = selected.reduce((sum, row) => sum + (1 / Number(row.propensity) > clip ? 1 : 0), 0);
  const complete = n > 0 && rows.every(row => row.status === 'matured_observed' && Number.isFinite(Number(row.reward)));
  const support = selected.length > 0 && rows.every(row => Number(row.propensity) > 0 && Number(row.propensity) <= 1);
  if (!complete || !support) return { armId, status: 'unknown', reason: !complete ? 'mature canonical rewards are incomplete; absent outcomes remain unknown' : 'overlap or observed support is insufficient', count: n, armCount: selected.length, minPropensity: rows.length ? Math.min(...rows.map(x => Number(x.propensity))) : null, weightClip: clip, clippedWeights: clipped, effectiveSampleSize: null, ips: null, snips: null, doublyRobust: null };
  const ips = selected.reduce((sum, row, i) => sum + selectedWeights[i] * Number(row.reward), 0) / n;
  const denominator = selectedWeights.reduce((a, b) => a + b, 0);
  const snips = denominator ? selected.reduce((sum, row, i) => sum + selectedWeights[i] * Number(row.reward), 0) / denominator : null;
  return { armId, status: effectiveSampleSize >= 2 ? 'diagnostic_estimate_only' : 'unknown', reason: effectiveSampleSize >= 2 ? 'IPS/SNIPS descriptive estimates; no causal/uplift claim' : 'effective sample size is insufficient', count: n, armCount: selected.length, minPropensity: Math.min(...rows.map(x => Number(x.propensity)), 1), weightClip: clip, clippedWeights: clipped, effectiveSampleSize, ips: effectiveSampleSize >= 2 ? ips : null, snips: effectiveSampleSize >= 2 ? snips : null, doublyRobust: null, doublyRobustStatus: 'unknown', doublyRobustReason: 'no independently persisted, validated per-account baseline prediction evidence is registered' };
}

/** Store a reproducible report. Unsupported data stays unknown and never becomes a zero reward. */
export async function evaluateAstraBanditLane(db, actor, laneId, { maxWeight = 20 } = {}) {
  const id = uuid(laneId, 'laneId');
  const clip = Number(maxWeight);
  if (!Number.isFinite(clip) || clip < 1 || clip > MAX_WEIGHT) fail(`maxWeight must be between 1 and ${MAX_WEIGHT}.`);
  const lane = await db.query(`SELECT l.experiment_id AS "experimentId",l.plan,e.primary_metric AS "primaryMetric"
    FROM astra.bandit_evaluation_lanes l JOIN astra.experiments e ON(e.tenant_id,e.id)=(l.tenant_id,l.experiment_id)
    WHERE l.tenant_id=$1::uuid AND l.id=$2::uuid`, [actor.tenantId, id]);
  if (!lane.rows[0]) fail('Evaluation lane was not found for this tenant.', 404, 'bandit_lane_not_found');
  const arms = await db.query(`SELECT arm_id AS "armId" FROM astra.bandit_arm_registry WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid ORDER BY arm_id`, [actor.tenantId, lane.rows[0].experimentId]);
  const releases = await db.query(`SELECT release_id AS "releaseId" FROM astra.bandit_arm_registry
    WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid`, [actor.tenantId, lane.rows[0].experimentId]);
  for (const row of releases.rows) await safeReleaseEvidence(db, actor.tenantId, row.releaseId);
  const observations = await db.query(`SELECT o.account_id AS "accountId",o.arm_id AS "armId",o.propensity::text AS propensity,
      r.status,r.reward
    FROM astra.bandit_observations o LEFT JOIN LATERAL(SELECT status,reward FROM astra.bandit_reward_reviews rr
      WHERE rr.tenant_id=o.tenant_id AND rr.lane_id=o.lane_id AND rr.account_id=o.account_id ORDER BY rr.created_at DESC LIMIT 1) r ON true
    WHERE o.tenant_id=$1::uuid AND o.lane_id=$2::uuid ORDER BY o.account_id`, [actor.tenantId, id]);
  const rows = observations.rows.map(row => ({ ...row, reward: row.reward == null ? null : Number(row.reward) }));
  const estimates = arms.rows.map(arm => estimateArm(arm.armId, rows, clip));
  const diagnostics = { observationCount: rows.length, matureCount: rows.filter(row => row.status === 'matured_observed').length,
    pendingCount: rows.filter(row => row.status === 'pending').length,
    censoredCount: rows.filter(row => row.status === 'censored_unknown' || !row.status).length,
    overlap: rows.length && arms.rows.every(arm => rows.some(row => row.armId === arm.armId && Number(row.propensity) > 0)) ? 'observed_arm_support_only' : 'unknown',
    effectiveSampleSize: rows.length && rows.every(row => Number(row.propensity) > 0 && Number(row.propensity) <= 1)
      ? (rows.reduce((sum, row) => sum + Math.min(clip, 1 / Number(row.propensity)), 0) ** 2
        / rows.reduce((sum, row) => sum + Math.min(clip, 1 / Number(row.propensity)) ** 2, 0)) : null,
    cohortDrift: 'unknown_no_predeclared_supported_cohort_evidence', randomizedConfirmation: 'not_established' };
  const report = stable({ schemaVersion: 'astra-bandit-offline-report/1.0.0', laneId: id,
    experimentId: lane.rows[0].experimentId, primaryMetric: lane.rows[0].primaryMetric, estimates, diagnostics,
    claims: { causal: false, uplift: false, productionPromotion: false }, releaseReady: false });
  const encoded = stableJson(report); const reportHash = sha256(encoded);
  const saved = await db.query(`INSERT INTO astra.bandit_evaluation_reports(tenant_id,lane_id,report,report_sha256,created_by)
    VALUES($1::uuid,$2::uuid,$3::jsonb,$4,$5) RETURNING id,report_sha256 AS "reportHash",created_at AS "createdAt"`,
  [actor.tenantId, id, encoded, reportHash, String(actor.userId)]);
  return { ...saved.rows[0], report, independentEvaluationRequired: true, releaseReady: false };
}

export async function listAstraBanditLanes(db, tenantId, { limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number.isInteger(Number(limit)) ? Number(limit) : 50));
  const q = await db.query(`SELECT id,experiment_id AS "experimentId",plan,plan_sha256 AS "planHash",
      max_exploration_fraction AS "maxExplorationFraction",created_by AS "createdBy",created_at AS "createdAt"
    FROM astra.bandit_evaluation_lanes WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT $2`, [tenantId, safeLimit]);
  return q.rows;
}
