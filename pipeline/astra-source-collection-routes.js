import { createAstraSourceCollectionManager, runAstraSourceCollectionOnce } from './astra-source-collection.js';
import { createAstraTenantStore } from './astra-tenant-store.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/collection';
const READ = ['owner', 'admin', 'operator', 'reviewer'];
const WRITE = ['owner', 'admin', 'operator'];
const RUN = ['operator'];
let workerStore = null;

function getWorkerStore() {
  if (!workerStore) workerStore = createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  return workerStore;
}
function route(register, method, suffix, handler, allowedRoles = READ) {
  register({ method, path: new RegExp(`${BASE}${suffix}$`), handler, allowedRoles });
}
function assertTenant(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    const error = new Error('Verified tenant membership is required.'); error.statusCode = 403; error.code = 'tenant_membership_required'; throw error;
  }
}
function listLimit(req) {
  const value = Number(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit'));
  return Number.isInteger(value) ? Math.max(1, Math.min(100, value)) : 50;
}
function scheduleRun(afterCommit, store, actor, jobId) {
  const tenantId = actor.tenantId, userId = String(actor.userId);
  afterCommit(() => runAstraSourceCollectionOnce({ store, tenantId, userId, jobId }));
}

/** Register tenant source fetch/search requests and explicit one-shot worker entrypoints. */
export function registerAstraSourceCollectionRoutes(registerAstraApiRoute, { store: suppliedStore = null } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const store = suppliedStore || (workerConfigured ? getWorkerStore() : null);

  route(registerAstraApiRoute, 'GET', '/jobs', async (req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    return { jobs: await createAstraSourceCollectionManager(db).listJobs(actor.tenantId, { limit: listLimit(req) }) };
  });
  route(registerAstraApiRoute, 'GET', '/jobs/(?<jobId>[0-9a-fA-F-]{36})', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    const job = await createAstraSourceCollectionManager(db).getJob(actor.tenantId, params.jobId);
    if (!job) { const error = new Error('Source collection job was not found.'); error.statusCode = 404; error.code = 'source_collection_job_missing'; throw error; }
    return { job };
  });
  route(registerAstraApiRoute, 'POST', '/fetch', async (req, _res, { actor, params, db, readJson, afterCommit }) => {
    assertTenant(actor, params);
    const job = await createAstraSourceCollectionManager(db, { workerAvailable: workerConfigured }).createFetchJob(actor, await readJson(req, 24 * 1024));
    if (job.status === 'queued' && workerConfigured) scheduleRun(afterCommit, store, actor, job.id);
    return { status: 202, body: { job, execution: workerConfigured ? 'explicit_one_shot_after_commit' : 'worker_unavailable', remoteTransportDefault: 'disabled', releaseReady: false } };
  }, WRITE);
  route(registerAstraApiRoute, 'POST', '/search', async (req, _res, { actor, params, db, readJson, afterCommit }) => {
    assertTenant(actor, params);
    const job = await createAstraSourceCollectionManager(db, { workerAvailable: workerConfigured }).createSearchJob(actor, await readJson(req, 24 * 1024));
    if (job.status === 'queued' && workerConfigured) scheduleRun(afterCommit, store, actor, job.id);
    return { status: 202, body: { job, execution: workerConfigured ? 'explicit_one_shot_after_commit' : 'worker_unavailable', remoteTransportDefault: 'disabled', releaseReady: false } };
  }, WRITE);
  route(registerAstraApiRoute, 'POST', '/jobs/(?<jobId>[0-9a-fA-F-]{36})/run-once', async (_req, _res, { actor, params, db, afterCommit }) => {
    assertTenant(actor, params);
    const manager = createAstraSourceCollectionManager(db);
    const job = await manager.getJob(actor.tenantId, params.jobId);
    if (!job) { const error = new Error('Source collection job was not found.'); error.statusCode = 404; error.code = 'source_collection_job_missing'; throw error; }
    if (job.status !== 'queued') return { job, execution: 'not_queued', releaseReady: false };
    if (!workerConfigured) { const error = new Error('Dedicated Astra worker database connection is not configured.'); error.statusCode = 503; error.code = 'astra_worker_unavailable'; throw error; }
    scheduleRun(afterCommit, store, actor, params.jobId);
    return { status: 202, body: { jobId: params.jobId, execution: 'explicit_one_shot_after_commit', remoteTransportDefault: 'disabled', releaseReady: false } };
  }, RUN);

  return { registered: [
    'GET /api/astra/tenants/:tenantId/collection/jobs',
    'GET /api/astra/tenants/:tenantId/collection/jobs/:jobId',
    'POST /api/astra/tenants/:tenantId/collection/fetch',
    'POST /api/astra/tenants/:tenantId/collection/search',
    'POST /api/astra/tenants/:tenantId/collection/jobs/:jobId/run-once',
  ], workerConfigured, remoteTransportEnabled: process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED === 'true',
  execution: 'explicit_one_shot_after_commit', autoStart: false, releaseReady: false };
}
