import { createAstraRadarManager, runAstraRadarOnce } from './astra-radar.js';
import { createAstraTenantStore } from './astra-tenant-store.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/radar';
const READ = ['owner','admin','operator','reviewer'];
const WRITE = ['owner','admin','operator'];
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
function limitFrom(req) {
  const value = Number(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit'));
  return Number.isInteger(value) ? Math.max(1, Math.min(100, value)) : 50;
}

/** Register tenant-scoped watch management and durable signal APIs. */
export function registerAstraRadarRoutes(registerAstraApiRoute, { store: suppliedStore } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const store = suppliedStore || getWorkerStore();
  route(registerAstraApiRoute, 'GET', '/watches', async (req, _res, { actor, params, db }) => {
    assertTenant(actor, params); return { watches: await createAstraRadarManager(db).listWatches(actor, { limit: limitFrom(req) }) };
  });
  route(registerAstraApiRoute, 'POST', '/watches', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params); return { status: 201, body: { watch: await createAstraRadarManager(db).createWatch(actor, await readJson(req, 16 * 1024)) } };
  }, WRITE);
  route(registerAstraApiRoute, 'POST', '/watches/(?<watchId>[0-9a-fA-F-]{36})/(?<action>pause|resume)', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params); return { watch: await createAstraRadarManager(db).setWatchState(actor, params.watchId, params.action) };
  }, WRITE);
  route(registerAstraApiRoute, 'POST', '/watches/(?<watchId>[0-9a-fA-F-]{36})/refresh', async (_req, _res, { actor, params, db, afterCommit }) => {
    assertTenant(actor, params);
    if (!workerConfigured) { const error = new Error('Dedicated Astra worker database connection is not configured.'); error.statusCode = 503; error.code = 'astra_worker_unavailable'; throw error; }
    const request = await createAstraRadarManager(db).requestRefresh(actor, params.watchId);
    const { tenantId } = actor, userId = String(actor.userId), watchId = params.watchId;
    afterCommit(() => runAstraRadarOnce({ store, tenantId, userId, watchId }));
    return { status: 202, body: { refresh: request } };
  }, WRITE);
  route(registerAstraApiRoute, 'POST', '/refresh', async (req, _res, { actor, params, db, afterCommit, readJson }) => {
    assertTenant(actor, params);
    if (!workerConfigured) { const error = new Error('Dedicated Astra worker database connection is not configured.'); error.statusCode = 503; error.code = 'astra_worker_unavailable'; throw error; }
    const body = await readJson(req, 16 * 1024);
    const request = body.watchId
      ? await createAstraRadarManager(db).requestRefresh(actor, body.watchId)
      : { tenantId: actor.tenantId, queued: true, execution: 'explicit_one_shot_worker', networkFetch: false };
    const { tenantId } = actor, userId = String(actor.userId), watchId = body.watchId || null;
    afterCommit(() => runAstraRadarOnce({ store, tenantId, userId, watchId }));
    return { status: 202, body: { refresh: request } };
  }, WRITE);
  route(registerAstraApiRoute, 'POST', '/watches/(?<watchId>[0-9a-fA-F-]{36})/observations', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params); return { status: 201, body: { observation: await createAstraRadarManager(db).recordSourceObservation(actor, params.watchId, await readJson(req, 16 * 1024)) } };
  }, WRITE);
  route(registerAstraApiRoute, 'GET', '/signals', async (req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    const includeExpired = new URL(req.url || '/', 'http://astra.local').searchParams.get('includeExpired') === 'true';
    return { signals: await createAstraRadarManager(db).listSignals(actor, { limit: limitFrom(req), includeExpired }) };
  });
  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/radar/watches',
    'POST /api/astra/tenants/:tenantId/radar/watches/:watchId/pause',
    'POST /api/astra/tenants/:tenantId/radar/watches/:watchId/resume',
    'POST /api/astra/tenants/:tenantId/radar/watches/:watchId/refresh',
    'POST /api/astra/tenants/:tenantId/radar/refresh',
    'POST /api/astra/tenants/:tenantId/radar/watches/:watchId/observations',
    'GET /api/astra/tenants/:tenantId/radar/signals',
  ], workerConfigured, execution: 'explicit_one_shot_after_commit', networkFetch: false };
}
