import { createAstraTenantStore } from './astra-tenant-store.js';
import { getAstraConformanceManifest, getAstraConformanceRun, queueAstraConformanceRun, requestAstraConformanceExecution } from './astra-conformance.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/conformance';
const READ_ROLES = ['owner', 'admin', 'operator', 'reviewer'];
let workerStore = null;

function getWorkerStore() {
  if (!workerStore) workerStore = createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  return workerStore;
}

function assertTenant(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    const error = new Error('Verified tenant membership is required.');
    error.name = 'AstraConformanceError'; error.statusCode = 403; error.code = 'tenant_membership_required'; throw error;
  }
}

function assertOperator(actor, params) {
  assertTenant(actor, params);
  if ((actor.tenantRole || actor.role) !== 'operator') {
    const error = new Error('An authenticated tenant operator is required.');
    error.name = 'AstraConformanceError'; error.statusCode = 403; error.code = 'conformance_operator_required'; throw error;
  }
}

function route(register, method, suffix, handler, allowedRoles = READ_ROLES) {
  register({ method, path: new RegExp(`${BASE}${suffix}$`), handler, allowedRoles });
}

/** Register read-only manifest/status routes and explicit operator run controls. */
export function registerAstraConformanceRoutes(registerAstraApiRoute, { store: suppliedStore } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const store = suppliedStore || (workerConfigured ? getWorkerStore() : null);

  route(registerAstraApiRoute, 'GET', '/manifest', async (_req, _res, { actor, params }) => {
    assertTenant(actor, params);
    return getAstraConformanceManifest();
  });

  route(registerAstraApiRoute, 'POST', '/runs', async (req, _res, { actor, params, db, readJson }) => {
    assertOperator(actor, params);
    const result = await queueAstraConformanceRun(db, actor, await readJson(req, 16 * 1024));
    return { status: result.duplicate ? 200 : 201, body: { ...result, execution: 'explicit_only', releaseReady: false } };
  }, ['operator']);

  route(registerAstraApiRoute, 'POST', '/runs/(?<runId>[0-9a-fA-F-]{36})/execute', async (_req, _res, { actor, params, db, afterCommit }) => {
    assertOperator(actor, params);
    const result = await db.query(`SELECT id,state FROM astra.conformance_runs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, params.runId]);
    if (!result.rows[0]) return { status: 404, body: { error: 'Conformance run was not found.', code: 'conformance_run_not_found' } };
    if (result.rows[0].state !== 'queued') return { status: 409, body: { error: 'Only a queued conformance run can be executed.', code: 'conformance_run_not_queued' } };
    if (!workerConfigured || !store) return { status: 503, body: { error: 'A dedicated Astra worker database connection is not configured.', code: 'astra_worker_unavailable' } };
    const tenantId = actor.tenantId, userId = String(actor.userId), runId = params.runId;
    afterCommit(() => requestAstraConformanceExecution({ store, tenantId, userId, runId }));
    return { status: 202, body: { runId, state: 'execution_requested', execution: 'one_shot', providerCalls: false, accepted: false, releaseReady: false } };
  }, ['operator']);

  route(registerAstraApiRoute, 'GET', '/runs/(?<runId>[0-9a-fA-F-]{36})/status', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    const run = await getAstraConformanceRun(db, actor, params.runId);
    return run ? { run } : { status: 404, body: { error: 'Conformance run was not found.', code: 'conformance_run_not_found' } };
  });

  return { registered: [
    'GET /api/astra/tenants/:tenantId/conformance/manifest',
    'POST /api/astra/tenants/:tenantId/conformance/runs',
    'POST /api/astra/tenants/:tenantId/conformance/runs/:runId/execute',
    'GET /api/astra/tenants/:tenantId/conformance/runs/:runId/status',
  ], workerConfigured, releaseReady: false };
}
