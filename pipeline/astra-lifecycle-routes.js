import {
  cancelAstraLifecycleRequest, createAstraExportRequest, createAstraLifecycleRequest,
  getAstraExportArtifact, inventoryAstraTenant, listAstraExportRequests, listAstraLifecycleRequests,
  planAstraLifecycleRequest, runAstraExportWorker,
} from './astra-lifecycle.js';
import { createAstraTenantStore } from './astra-tenant-store.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/lifecycle';
const READ = ['owner','admin','operator','reviewer'];
const WRITE = ['owner','admin','operator'];
const ADMIN = ['owner','admin'];
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
function limitFrom(req, fallback = 50) { return new URL(req.url || '/', 'http://astra.local').searchParams.get('limit') || fallback; }

/** Register tenant-scoped export, deletion-plan, and retention lifecycle routes. */
export function registerAstraLifecycleRoutes(registerAstraApiRoute, { store: suppliedStore } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const store = suppliedStore || getWorkerStore();
  route(registerAstraApiRoute, 'GET', '/exports', async (req, _res, { actor, params, db }) => {
    assertTenant(actor, params); return { items: await listAstraExportRequests(db, actor, { limit: limitFrom(req) }), downloadRole: 'owner_or_admin' };
  });
  route(registerAstraApiRoute, 'POST', '/exports', async (req, _res, { actor, params, db, readJson, afterCommit }) => {
    assertTenant(actor, params);
    if (!workerConfigured) { const error = new Error('Dedicated Astra worker database connection is not configured.'); error.statusCode = 503; error.code = 'astra_worker_unavailable'; throw error; }
    const request = await createAstraExportRequest(db, actor, await readJson(req, 16 * 1024));
    const tenantId = actor.tenantId; const userId = String(actor.userId);
    afterCommit(() => runAstraExportWorker({ store, tenantId, userId, exportId: request.id }));
    return { status: 202, body: { export: request, execution: 'queued_for_dedicated_worker' } };
  }, WRITE);
  route(registerAstraApiRoute, 'GET', '/exports/(?<exportId>[0-9a-fA-F-]{36})/download', async (_req, _res, { actor, params, db, sendJson }) => {
    assertTenant(actor, params);
    const artifact = await getAstraExportArtifact(db, actor, params.exportId);
    // The native Astra registrar buffers JSON until its tenant transaction
    // commits. Return the stored artifact as base64 JSON so the route never
    // writes to the socket while RLS context is still inside the transaction.
    sendJson({ filename: artifact.filename, contentType: artifact.contentType, contentBase64: artifact.content.toString('base64'),
      sha256: artifact.sha256, byteLength: artifact.byteLength }, 200, { 'X-Content-SHA256': artifact.sha256 });
  }, ADMIN);
  route(registerAstraApiRoute, 'GET', '/inventory', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    return { inventory: await inventoryAstraTenant(db, actor.tenantId) };
  });
  route(registerAstraApiRoute, 'GET', '/requests', async (req, _res, { actor, params, db }) => {
    assertTenant(actor, params); return { items: await listAstraLifecycleRequests(db, actor, { limit: limitFrom(req) }) };
  });
  route(registerAstraApiRoute, 'POST', '/requests', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params); return { status: 201, body: { request: await createAstraLifecycleRequest(db, actor, await readJson(req, 256 * 1024)) } };
  }, ADMIN);
  route(registerAstraApiRoute, 'POST', '/requests/(?<requestId>[0-9a-fA-F-]{36})/cancel', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params); return { request: await cancelAstraLifecycleRequest(db, actor, params.requestId) };
  }, ADMIN);
  route(registerAstraApiRoute, 'POST', '/requests/(?<requestId>[0-9a-fA-F-]{36})/plan', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params); return { request: await planAstraLifecycleRequest(db, actor, params.requestId) };
  }, ADMIN);
  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/lifecycle/exports',
    'GET /api/astra/tenants/:tenantId/lifecycle/exports/:exportId/download',
    'GET /api/astra/tenants/:tenantId/lifecycle/inventory',
    'GET|POST /api/astra/tenants/:tenantId/lifecycle/requests',
    'POST /api/astra/tenants/:tenantId/lifecycle/requests/:requestId/cancel',
    'POST /api/astra/tenants/:tenantId/lifecycle/requests/:requestId/plan',
  ], workerConfigured, destructiveExecution: false };
}
