import { createHash } from 'node:crypto';
import { AstraLedgerError } from './astra-ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPONENT_SLOTS = ['harness', 'decision', 'skill', 'metric'];

export class AstraReleaseRegistryError extends AstraLedgerError {
  constructor(message, statusCode = 400, code = 'release_registry_invalid') {
    super(message, statusCode, code);
  }
}

function fail(message, statusCode = 400, code = 'release_registry_invalid') {
  throw new AstraReleaseRegistryError(message, statusCode, code);
}

function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function stableJson(value) { return JSON.stringify(stable(value)); }
function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex'); }
function text(value, field, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}
function assertActor(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) fail('Verified tenant membership is required.', 403, 'tenant_membership_required');
}

function normalizeSlots(value) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) fail('componentSlots must be an object.');
  const slots = {};
  for (const name of COMPONENT_SLOTS) {
    const slot = value?.[name] ?? {};
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) fail(`componentSlots.${name} must be an object.`);
    const version = slot.version == null ? null : text(slot.version, `componentSlots.${name}.version`, 120);
    const registered = slot.registered === true;
    if (registered && !version) fail(`componentSlots.${name} cannot be registered without a version.`);
    slots[name] = { version, registered, registration: registered ? 'registered_by_external_owner' : 'unregistered' };
  }
  return slots;
}

export async function createAstraReleaseArtifact(db, actor, input) {
  if (!actor || !['owner', 'admin'].includes(actor.tenantRole || actor.role)) fail('Owner or admin membership is required.', 403, 'tenant_role_forbidden');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Release artifact body must be an object.');
  const name = text(input.name, 'name', 160);
  const version = text(input.version, 'version', 80);
  const candidateId = String(input.candidateId || '').toLowerCase();
  const evaluationRunId = String(input.evaluationRunId || '').toLowerCase();
  const priorStableReleaseId = input.priorStableReleaseId == null ? null : String(input.priorStableReleaseId).toLowerCase();
  if (!UUID.test(candidateId) || !UUID.test(evaluationRunId)) fail('candidateId and evaluationRunId must be UUIDs.');
  if (priorStableReleaseId !== null && !UUID.test(priorStableReleaseId)) fail('priorStableReleaseId must be a UUID when supplied.');
  const slots = normalizeSlots(input.componentSlots);
  const refs = await db.query(`SELECT c.id AS candidate_id,c.version AS candidate_version,c.manifest_sha256 AS candidate_hash,c.created_by AS candidate_owner,
      r.id AS run_id,r.report_sha256,r.snapshot,r.snapshot_sha256,r.report,r.state AS run_state,
      s.id AS scorer_id,s.version AS scorer_version,s.manifest_sha256 AS scorer_hash,s.created_by AS scorer_owner
    FROM astra.eval_candidates c
    JOIN astra.eval_runs r ON r.tenant_id=c.tenant_id
    JOIN astra.eval_run_results rr ON (rr.tenant_id,rr.run_id,rr.candidate_id)=(r.tenant_id,r.id,c.id)
    JOIN astra.eval_scorers s ON (s.tenant_id,s.id)=(r.tenant_id,r.scorer_id)
    WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid AND r.id=$3::uuid AND r.state='completed'`, [actor.tenantId, candidateId, evaluationRunId]);
  const row = refs.rows[0];
  if (!row || row.candidate_hash.trim() !== row.report?.variants?.find(variant => variant.candidateId === candidateId)?.candidateManifestSha256) {
    fail('Release must reference a completed evaluation of this exact candidate manifest.', 409, 'release_evaluation_mismatch');
  }
  if (row.report_sha256 === null || !/^[a-f0-9]{64}$/.test(row.report_sha256.trim())) fail('Evaluation report has no durable content hash.', 409, 'release_evaluation_missing');
  if (String(actor.userId) === row.candidate_owner || String(actor.userId) === row.scorer_owner) fail('Artifact author must be independent from candidate and scorer owners.', 403, 'release_author_separation_required');
  let priorStable = null;
  if (priorStableReleaseId) {
    const previous = await db.query(`SELECT id,manifest_sha256,status FROM astra.release_artifacts WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, priorStableReleaseId]);
    if (!previous.rows[0] || previous.rows[0].status !== 'approved_not_deployed') fail('Prior stable pointer must reference an approved artifact in this tenant.', 409, 'release_prior_stable_unavailable');
    priorStable = { id: priorStableReleaseId, manifestSha256: previous.rows[0].manifest_sha256.trim(), status: 'approved_not_deployed' };
  }
  const manifest = {
    schemaVersion: 'astra-release-manifest/1.0.0', name, version,
    candidate: { id: candidateId, version: row.candidate_version, manifestSha256: row.candidate_hash.trim() },
    evaluation: { runId: evaluationRunId, reportSha256: row.report_sha256.trim(), snapshotSha256: row.snapshot_sha256.trim() },
    scorer: { id: row.scorer_id, version: row.scorer_version, manifestSha256: row.scorer_hash.trim() },
    componentSlots: slots,
    priorStablePointer: priorStable,
    rollout: { status: 'not_deployed', live: false, automaticPromotion: false },
    releaseReady: false,
  };
  const manifestJson = stableJson(manifest);
  const result = await db.query(`INSERT INTO astra.release_artifacts(tenant_id,name,version,candidate_id,evaluation_run_id,prior_stable_release_id,manifest,manifest_sha256,created_by,status)
    VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::jsonb,$8,$9,'pending_approval')
    RETURNING id,name,version,candidate_id AS "candidateId",evaluation_run_id AS "evaluationRunId",
      manifest_sha256 AS "manifestSha256",status,created_at AS "createdAt"`,
  [actor.tenantId, name, version, candidateId, evaluationRunId, priorStableReleaseId, manifestJson, digest(manifest), String(actor.userId)]);
  return { ...result.rows[0], manifest, releaseReady: false, live: false };
}

export async function recordAstraReleaseApproval(db, actor, releaseId, { decision, reasonCode } = {}) {
  if (!actor || !['owner', 'reviewer'].includes(actor.tenantRole || actor.role)) fail('An owner or reviewer membership is required.', 403, 'tenant_role_forbidden');
  if (!UUID.test(String(releaseId))) fail('releaseId must be a UUID.');
  if (!['approve', 'reject'].includes(decision)) fail('decision must be approve or reject.');
  const reason = text(reasonCode, 'reasonCode', 80);
  const role = actor.tenantRole || actor.role;
  const result = await db.query(`SELECT id,manifest_sha256,created_by,status,candidate_id FROM astra.release_artifacts
    WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [actor.tenantId, releaseId]);
  const release = result.rows[0];
  if (!release) fail('Release artifact was not found for this tenant.', 404, 'release_not_found');
  if (release.status !== 'pending_approval') fail('Only a pending artifact can receive signoff.', 409, 'release_not_pending');
  if (String(actor.userId) === release.created_by) fail('Artifact author cannot approve their own release.', 403, 'release_author_separation_required');
  const governance = await db.query(`SELECT c.created_by AS candidate_owner,s.created_by AS scorer_owner,d.created_by AS dataset_owner
    FROM astra.eval_candidates c
    JOIN astra.eval_runs r ON r.tenant_id=c.tenant_id
    JOIN astra.eval_scorers s ON (s.tenant_id,s.id)=(r.tenant_id,r.scorer_id)
    JOIN astra.eval_datasets d ON (d.tenant_id,d.id)=(r.tenant_id,r.dataset_id)
    WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid AND r.id=$3::uuid`, [actor.tenantId, release.candidate_id, release.evaluation_run_id]);
  const owners = governance.rows[0];
  if (!owners || [owners.candidate_owner, owners.scorer_owner, owners.dataset_owner].includes(String(actor.userId))) fail('Evaluation component authors cannot sign off their release.', 403, 'release_component_author_separation_required');
  const approval = await db.query(`INSERT INTO astra.release_approvals(tenant_id,release_id,approval_role,decision,reason_code,manifest_sha256,approved_by)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7)
    ON CONFLICT(tenant_id,release_id,approval_role) DO NOTHING
    RETURNING id,approval_role AS "approvalRole",decision,reason_code AS "reasonCode",manifest_sha256 AS "manifestSha256",approved_by AS "approvedBy",created_at AS "createdAt"`,
  [actor.tenantId, releaseId, role, decision, reason, release.manifest_sha256.trim(), String(actor.userId)]);
  if (!approval.rows[0]) fail(`A ${role} signoff already exists for this artifact.`, 409, 'release_signoff_exists');
  const approvals = await db.query(`SELECT approval_role,decision,approved_by FROM astra.release_approvals
    WHERE tenant_id=$1::uuid AND release_id=$2::uuid`, [actor.tenantId, releaseId]);
  const owner = approvals.rows.find(item => item.approval_role === 'owner');
  const reviewer = approvals.rows.find(item => item.approval_role === 'reviewer');
  if (owner?.decision === 'reject' || reviewer?.decision === 'reject') {
    await db.query(`UPDATE astra.release_artifacts SET status='rejected' WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, releaseId]);
  } else if (owner?.decision === 'approve' && reviewer?.decision === 'approve') {
    if (owner.approved_by === reviewer.approved_by) fail('Owner and reviewer signoffs must come from different users.', 409, 'release_signoff_independence_required');
    await db.query(`UPDATE astra.release_artifacts SET status='approved_not_deployed' WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, releaseId]);
  }
  return { approval: approval.rows[0], status: owner?.decision === 'reject' || reviewer?.decision === 'reject' ? 'rejected'
    : owner?.decision === 'approve' && reviewer?.decision === 'approve' ? 'approved_not_deployed' : 'pending_approval',
  live: false, releaseReady: false };
}

export async function recordAstraReleaseRollback(db, actor, { fromReleaseId, targetReleaseId, reasonCode } = {}) {
  if (!actor || !['owner'].includes(actor.tenantRole || actor.role)) fail('Owner membership is required.', 403, 'tenant_role_forbidden');
  const fromId = String(fromReleaseId || '').toLowerCase();
  const targetId = String(targetReleaseId || '').toLowerCase();
  if (!UUID.test(fromId) || !UUID.test(targetId) || fromId === targetId) fail('Rollback requires distinct source and target release UUIDs.');
  const reason = text(reasonCode, 'reasonCode', 80);
  const result = await db.query(`SELECT id,status,manifest_sha256,prior_stable_release_id AS prior_stable_id FROM astra.release_artifacts
    WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [actor.tenantId, [fromId, targetId]]);
  if (result.rows.length !== 2 || result.rows.find(item => item.id === targetId)?.status !== 'approved_not_deployed') fail('Rollback target must be an independently approved artifact for this tenant.', 409, 'rollback_target_unavailable');
  const byId = new Map(result.rows.map(row => [row.id, row]));
  if (byId.get(fromId).status !== 'approved_not_deployed' || byId.get(fromId).prior_stable_id !== targetId) fail('Rollback must point an approved release to its recorded prior stable artifact.', 409, 'rollback_pointer_mismatch');
  const rollbackManifest = { schemaVersion: 'astra-release-rollback/1.0.0', fromReleaseId: fromId, targetReleaseId: targetId,
    fromManifestSha256: byId.get(fromId).manifest_sha256.trim(), targetManifestSha256: byId.get(targetId).manifest_sha256.trim(),
    requestedBy: String(actor.userId), reasonCode: reason, effect: 'recorded_pointer_only_no_live_deployment', releaseReady: false };
  const created = await db.query(`INSERT INTO astra.release_rollbacks(tenant_id,from_release_id,target_release_id,manifest,manifest_sha256,requested_by,status)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,'recorded_not_deployed')
    RETURNING id,from_release_id AS "fromReleaseId",target_release_id AS "targetReleaseId",manifest_sha256 AS "manifestSha256",status,created_at AS "createdAt"`,
  [actor.tenantId, fromId, targetId, stableJson(rollbackManifest), digest(rollbackManifest), String(actor.userId)]);
  return { ...created.rows[0], manifest: rollbackManifest, live: false, releaseReady: false };
}

export function registerAstraReleaseRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const base = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/evaluation';
  const register = (method, suffix, handler, allowedRoles) => registerAstraApiRoute({
    method, path: new RegExp(`${base}${suffix}$`), handler, allowedRoles,
  });
  register('GET', '/releases', async (_req, _res, { actor, params, db }) => {
    assertActor(actor, params);
    const releases = await db.query(`SELECT id,name,version,candidate_id AS "candidateId",evaluation_run_id AS "evaluationRunId",
      manifest,manifest_sha256 AS "manifestSha256",status,created_by AS "createdBy",created_at AS "createdAt"
      FROM astra.release_artifacts WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT 100`, [actor.tenantId]);
    return { items: releases.rows, releaseReady: false, liveRelease: null };
  }, ['owner', 'admin', 'operator', 'reviewer']);
  register('POST', '/releases', async (req, _res, { actor, params, db, readJson }) => {
    assertActor(actor, params);
    return { status: 201, body: { release: await createAstraReleaseArtifact(db, actor, await readJson(req, 32 * 1024)) } };
  }, ['owner', 'admin']);
  register('POST', '/releases/(?<releaseId>[0-9a-fA-F-]{36})/signoff', async (req, _res, { actor, params, db, readJson }) => {
    assertActor(actor, params);
    return { approval: await recordAstraReleaseApproval(db, actor, params.releaseId, await readJson(req, 4096)) };
  }, ['owner', 'reviewer']);
  register('POST', '/releases/rollback', async (req, _res, { actor, params, db, readJson }) => {
    assertActor(actor, params);
    return { status: 201, body: { rollback: await recordAstraReleaseRollback(db, actor, await readJson(req, 4096)) } };
  }, ['owner']);
  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/evaluation/releases',
    'POST /api/astra/tenants/:tenantId/evaluation/releases/:releaseId/signoff',
    'POST /api/astra/tenants/:tenantId/evaluation/releases/rollback',
  ] };
}
