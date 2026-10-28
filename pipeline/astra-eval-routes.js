import {
  adjudicateAstraEvaluationDataset,
  annotateAstraEvaluationDataset,
  createAstraEvaluationDataset,
  getAstraEvaluationRun,
  queueAstraEvaluationRun,
  registerAstraEvaluationCandidate,
  registerAstraEvaluationScorer,
  requestAstraEvaluationExecution,
} from './astra-evaluation.js';
import { registerAstraReleaseRoutes } from './astra-release-registry.js';
import { createAstraTenantStore } from './astra-tenant-store.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/evaluation';
const READ_ROLES = ['owner', 'admin', 'operator', 'reviewer'];
const AUTHOR_ROLES = ['owner', 'admin', 'operator'];
const OWNER_ROLES = ['owner', 'admin'];
const OWNER_ONLY = ['owner'];
let workerStore = null;

function getWorkerStore() {
  if (!workerStore) workerStore = createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  return workerStore;
}

function assertTenant(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    const error = new Error('Verified tenant membership is required.');
    error.statusCode = 403;
    error.code = 'tenant_membership_required';
    throw error;
  }
}

function route(register, method, suffix, handler, allowedRoles = READ_ROLES) {
  register({ method, path: new RegExp(`${BASE}${suffix}$`), handler, allowedRoles });
}

function safeLimit(value, fallback = 50) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : fallback;
}

/** Register tenant-scoped frozen evaluation, offline run, and release routes. */
export function registerAstraEvaluationRoutes(registerAstraApiRoute, { store: suppliedStore } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const store = suppliedStore || getWorkerStore();
  const datasetHandler = async (req, _res, context) => {
    const { actor, params, db, readJson } = context;
    assertTenant(actor, params);
    if (req.method === 'POST') return { status: 201, body: { dataset: await createAstraEvaluationDataset(db, actor, await readJson(req, 8 * 1024 * 1024)) } };
    const rows = await db.query(`SELECT d.id,d.name,d.source_manifest_sha256 AS "sourceManifestSha256",d.manifest_sha256 AS "manifestSha256",
      d.label_schema AS "labelSchema",d.split_policy AS "splitPolicy",d.status,d.created_at AS "createdAt",
      d.created_by AS "createdBy",count(e.id)::int AS "exampleCount",count(e.id) FILTER(WHERE e.split='holdout')::int AS "holdoutCount"
      FROM astra.eval_datasets d LEFT JOIN astra.eval_examples e ON (e.tenant_id,e.dataset_id)=(d.tenant_id,d.id)
      WHERE d.tenant_id=$1::uuid GROUP BY d.tenant_id,d.id ORDER BY d.created_at DESC LIMIT $2`, [actor.tenantId, safeLimit(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit'))]);
    return { items: rows.rows };
  };
  route(registerAstraApiRoute, 'GET', '/datasets', datasetHandler);
  route(registerAstraApiRoute, 'POST', '/datasets', datasetHandler, AUTHOR_ROLES);

  route(registerAstraApiRoute, 'POST', '/datasets/(?<datasetId>[0-9a-fA-F-]{36})/annotations', async (req, _res, context) => {
    const { actor, params, db, readJson } = context;
    assertTenant(actor, params);
    const body = await readJson(req, 256 * 1024);
    return { annotations: await annotateAstraEvaluationDataset(db, actor, params.datasetId, body.annotations) };
  }, ['reviewer']);
  route(registerAstraApiRoute, 'POST', '/datasets/(?<datasetId>[0-9a-fA-F-]{36})/adjudications', async (req, _res, context) => {
    const { actor, params, db, readJson } = context;
    assertTenant(actor, params);
    const body = await readJson(req, 256 * 1024);
    return { adjudications: await adjudicateAstraEvaluationDataset(db, actor, params.datasetId, body.adjudications) };
  }, OWNER_ONLY);

  const candidateHandler = async (req, _res, context) => {
    const { actor, params, db, readJson } = context;
    assertTenant(actor, params);
    if (req.method === 'POST') return { status: 201, body: { candidate: await registerAstraEvaluationCandidate(db, actor, await readJson(req, 16 * 1024)) } };
    const result = await db.query(`SELECT id,name,version,variant_id AS "variantId",strategy,allowed_labels AS "allowedLabels",
      manifest_sha256 AS "manifestSha256",created_by AS "createdBy",created_at AS "createdAt"
      FROM astra.eval_candidates WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT $2`,
    [actor.tenantId, safeLimit(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit'))]);
    return { items: result.rows, executionMode: 'deterministic_local', providerCalls: false };
  };
  route(registerAstraApiRoute, 'GET', '/candidates', candidateHandler);
  route(registerAstraApiRoute, 'POST', '/candidates', candidateHandler, AUTHOR_ROLES);

  const scorerHandler = async (req, _res, context) => {
    const { actor, params, db, readJson } = context;
    assertTenant(actor, params);
    if (req.method === 'POST') return { status: 201, body: { scorer: await registerAstraEvaluationScorer(db, actor, await readJson(req, 16 * 1024)) } };
    const result = await db.query(`SELECT id,name,version,class_labels AS "classLabels",critical_harm_labels AS "criticalHarmLabels",
      abstain_label AS "abstainLabel",manifest_sha256 AS "manifestSha256",created_by AS "createdBy",created_at AS "createdAt"
      FROM astra.eval_scorers WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT $2`,
    [actor.tenantId, safeLimit(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit'))]);
    return { items: result.rows, executionMode: 'deterministic_local', providerCalls: false };
  };
  route(registerAstraApiRoute, 'GET', '/scorers', scorerHandler);
  route(registerAstraApiRoute, 'POST', '/scorers', scorerHandler, OWNER_ROLES);

  route(registerAstraApiRoute, 'POST', '/runs', async (req, _res, context) => {
    const { actor, params, db, readJson } = context;
    assertTenant(actor, params);
    return { status: 202, body: { run: await queueAstraEvaluationRun(db, actor, await readJson(req, 32 * 1024)) } };
  }, OWNER_ROLES);
  route(registerAstraApiRoute, 'GET', '/runs', async (req, _res, context) => {
    const { actor, params, db } = context;
    assertTenant(actor, params);
    const result = await db.query(`SELECT id,dataset_id AS "datasetId",scorer_id AS "scorerId",state,
      snapshot_sha256 AS "snapshotSha256",report_sha256 AS "reportSha256",error_code AS "errorCode",
      created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt"
      FROM astra.eval_runs WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT $2`,
    [actor.tenantId, safeLimit(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit'))]);
    return { items: result.rows, releaseReady: false };
  });
  route(registerAstraApiRoute, 'GET', '/runs/(?<runId>[0-9a-fA-F-]{36})', async (_req, _res, context) => {
    const { actor, params, db } = context;
    assertTenant(actor, params);
    const run = await getAstraEvaluationRun(db, actor, params.runId);
    return run ? { run, releaseReady: false } : { status: 404, body: { error: 'Evaluation run was not found.', code: 'evaluation_run_not_found' } };
  });
  route(registerAstraApiRoute, 'POST', '/runs/(?<runId>[0-9a-fA-F-]{36})/execute', async (_req, _res, context) => {
    const { actor, params, db, afterCommit } = context;
    assertTenant(actor, params);
    const result = await db.query(`SELECT id,state FROM astra.eval_runs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, params.runId]);
    if (!result.rows[0]) return { status: 404, body: { error: 'Evaluation run was not found.', code: 'evaluation_run_not_found' } };
    if (result.rows[0].state !== 'queued') return { status: 409, body: { error: 'Only a queued run can be executed.', code: 'evaluation_run_not_queued' } };
    if (!workerConfigured) return { status: 503, body: { error: 'A dedicated Astra worker database connection is not configured.', code: 'astra_worker_unavailable' } };
    const userId = String(actor.userId);
    const tenantId = actor.tenantId;
    afterCommit(() => requestAstraEvaluationExecution({ store, tenantId, userId, runId: params.runId }));
    return { status: 202, body: { runId: params.runId, state: 'execution_requested', harness: 'astra-offline-deterministic/1.0.0',
      providerCalls: false, acceptedMetrics: false, releaseReady: false } };
  }, OWNER_ROLES);

  const release = registerAstraReleaseRoutes(registerAstraApiRoute);
  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/evaluation/datasets',
    'POST /api/astra/tenants/:tenantId/evaluation/datasets/:datasetId/annotations',
    'POST /api/astra/tenants/:tenantId/evaluation/datasets/:datasetId/adjudications',
    'GET|POST /api/astra/tenants/:tenantId/evaluation/candidates',
    'GET|POST /api/astra/tenants/:tenantId/evaluation/scorers',
    'GET|POST /api/astra/tenants/:tenantId/evaluation/runs',
    'GET /api/astra/tenants/:tenantId/evaluation/runs/:runId',
    'POST /api/astra/tenants/:tenantId/evaluation/runs/:runId/execute',
    ...release.registered,
  ], workerConfigured, releaseReady: false };
}
