import { createAstraTenantStore } from './astra-tenant-store.js';
import {
  AstraTenantContextError,
  tenantAstraActor,
  trustedAstraPrincipal,
} from './astra-tenant-context.js';

const routes = [];
let defaultStore = null;

function responseError(res, message, status) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
  });
  res.end(JSON.stringify({ error: message }));
}

function publicError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 400 && statusCode < 500) {
    // Only expose 4xx messages from domain errors whose public text is authored
    // for operators. SQL/driver errors and all 5xx details stay redacted.
    const trustedMessage = ['AstraTenantContextError', 'AstraTenantStoreError', 'AstraLedgerError', 'AstraWorkflowError', 'AstraResearchError', 'AstraRuntimeError', 'AstraGlmGatewayError', 'AstraOperationsError', 'AstraLifecycleError', 'AstraRadarError', 'AstraEconomicsError', 'AstraPostSaleError', 'AstraLaunchError'].includes(error?.name);
    return { statusCode, message: error.publicMessage || (trustedMessage ? error.message : 'Request was rejected.') };
  }
  return { statusCode: 503, message: 'Tenant request could not be completed.' };
}

function sendJsonTo(res, data, status = 200, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function readJsonFrom(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new AstraTenantContextError('Request body is too large.', 413, 'request_too_large'));
        return;
      }
      if (total === 0) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('JSON body must be an object.');
        }
        resolve(value);
      } catch {
        reject(new AstraTenantContextError('Request body must be a JSON object.', 400, 'invalid_json'));
      }
    });
    req.on('error', () => reject(new AstraTenantContextError('Request body could not be read.', 400, 'request_read_failed')));
  });
}

function validateRoute({ method, path, handler, requiredRoles, allowedRoles }) {
  const verb = String(method || '').trim().toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) {
    throw new TypeError('Astra API routes require an explicit supported HTTP method.');
  }
  const source = path instanceof RegExp ? path.source.replaceAll('\\/', '/') : '';
  if (!(path instanceof RegExp) || path.global || path.sticky || !source.startsWith('^/api/astra/tenants/')) {
    throw new TypeError('Astra tenant API routes require a non-global anchored tenant path RegExp.');
  }
  if (!path.source.includes('tenantId')) {
    throw new TypeError('Astra tenant API route patterns must capture a named tenantId group.');
  }
  if (typeof handler !== 'function') throw new TypeError('Astra API route requires a handler.');
  if (requiredRoles !== undefined && allowedRoles !== undefined) {
    throw new TypeError('Specify allowedRoles or requiredRoles, not both.');
  }
  const configuredRoles = allowedRoles === undefined ? requiredRoles : allowedRoles;
  // Default permissions are tenant-local: reviewers are read-only and tenant
  // writers must hold an owner/admin/operator membership. The global session
  // role is intentionally never consulted for these routes.
  const roles = configuredRoles === undefined
    ? (verb === 'GET' ? ['owner', 'admin', 'operator', 'reviewer'] : ['owner', 'admin', 'operator'])
    : [...new Set(configuredRoles)];
  if (roles && (roles.length === 0 || roles.some(role => !['owner', 'admin', 'operator', 'reviewer'].includes(role)))) {
    throw new TypeError('Astra API route roles must be known tenant membership roles.');
  }
  return { method: verb, path, handler, allowedRoles: roles };
}

/**
 * Register an API route that always runs under verified membership and RLS.
 * Route modules import this function and register their paths when loaded by
 * the host server. Every pattern must capture `tenantId` from the URL path.
 */
export function registerAstraApiRoute(definition) {
  const route = validateRoute(definition);
  const key = `${route.method} ${route.path.source}`;
  if (routes.some(existing => `${existing.method} ${existing.path.source}` === key)) {
    throw new Error(`Duplicate Astra API route registration: ${key}`);
  }
  routes.push(route);
  return () => {
    const index = routes.indexOf(route);
    if (index !== -1) routes.splice(index, 1);
  };
}

/** Roll back only registrations made by a failed module assembly attempt. */
export function registerAstraApiRoutesAtomically(registerModules) {
  if (typeof registerModules !== 'function') throw new TypeError('Route registration callback is required.');
  const firstNewRoute = routes.length;
  try {
    const result = registerModules(registerAstraApiRoute);
    if (result && typeof result.then === 'function') {
      throw new TypeError('Astra route module registration must be synchronous.');
    }
    return result;
  } catch (error) {
    routes.splice(firstNewRoute);
    throw error;
  }
}

function getDefaultStore() {
  if (!defaultStore) defaultStore = createAstraTenantStore();
  return defaultStore;
}

async function handleTenantCreation({ req, res, session, store }) {
  const principal = trustedAstraPrincipal(session);
  let pending = null;
  const sendJson = (_res, body, status = 200, headers = {}) => { pending = { body, status, headers }; };
  try {
    const body = await readJsonFrom(req);
    const result = await store.createTenant({ name: body.name, userId: principal.userId });
    sendJson(res, { tenant: { id: result.tenantId, role: result.tenantRole } }, 201);
    sendJsonTo(res, pending.body, pending.status, pending.headers);
  } catch (error) {
    const safe = publicError(error);
    responseError(res, safe.message, safe.statusCode);
  }
}

async function handleInvitationAcceptance({ req, res, session, store }) {
  const principal = trustedAstraPrincipal(session);
  try {
    const body = await readJsonFrom(req);
    const result = await store.acceptInvitation({ token: body.token, userId: principal.userId, email: principal.email });
    // The store returns only after its single-use proof and membership write
    // have committed. No session/global workspace role is consulted here.
    sendJsonTo(res, { membership: { tenantId: result.tenantId, role: result.tenantRole } }, 200);
  } catch (error) {
    const safe = publicError(error);
    responseError(res, safe.message, safe.statusCode);
  }
}

async function handleTenantContext({ req, res, session, tenantId, store }) {
  const principal = trustedAstraPrincipal(session);
  let pending = null;
  try {
    await store.withTenant({ tenantId, userId: principal.userId }, async (db, membership) => {
      const result = await db.query('SELECT id, name, status, created_at FROM astra.tenants WHERE id = $1::uuid', [membership.tenantId]);
      const tenant = result.rows[0];
      if (!tenant) throw new AstraTenantContextError('Tenant was not found.', 404, 'tenant_not_found');
      pending = {
        body: { tenant: { id: tenant.id, name: tenant.name, status: tenant.status, role: membership.tenantRole } },
        status: 200,
        headers: {},
      };
    });
    sendJsonTo(res, pending.body, pending.status, pending.headers);
  } catch (error) {
    const safe = publicError(error);
    responseError(res, safe.message, safe.statusCode);
  }
}

async function handleWorkspaceDiscovery({ res, session, store }) {
  try {
    const principal = trustedAstraPrincipal(session);
    const workspaces = await store.listMyWorkspaces({ userId: principal.userId });
    const operatorWorkspace = workspaces.some(workspace => ['owner', 'admin', 'operator'].includes(workspace.role));
    sendJsonTo(res, {
      workspaces,
      capabilities: { customerConsole: true, operatorWorkspace },
      releaseReady: false,
    });
  } catch (error) {
    const safe = publicError(error);
    responseError(res, safe.message, safe.statusCode);
  }
}

/** Check the advanced page gate using live tenant memberships, never the global auth role. */
export async function canAccessOperatorWorkspace({ session, store = getDefaultStore() }) {
  const principal = trustedAstraPrincipal(session);
  const workspaces = await store.listMyWorkspaces({ userId: principal.userId });
  return workspaces.some(workspace => ['owner', 'admin', 'operator'].includes(workspace.role));
}

/** Handle the opt-in Astra API namespace after the host verifies session/CSRF. */
export async function handleAstraApiRequest({ req, res, pathname, session, store = getDefaultStore(), legacyDb = undefined }) {
  if (!session) {
    responseError(res, 'Sign-in required.', 401);
    return true;
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'POST' && pathname === '/api/astra/invitations/accept') {
    await handleInvitationAcceptance({ req, res, session, store });
    return true;
  }
  if (method === 'POST' && pathname === '/api/astra/tenants') {
    await handleTenantCreation({ req, res, session, store });
    return true;
  }

  if (method === 'GET' && pathname === '/api/astra/workspaces') {
    await handleWorkspaceDiscovery({ res, session, store });
    return true;
  }

  if (method === 'GET') {
    const contextMatch = pathname.match(/^\/api\/astra\/tenants\/(?<tenantId>[^/]+)\/context$/);
    if (contextMatch) {
      await handleTenantContext({ req, res, session, tenantId: contextMatch.groups.tenantId, store });
      return true;
    }
  }

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.path.exec(pathname);
    if (!match) continue;
    const tenantId = match.groups?.tenantId;
    const principal = trustedAstraPrincipal(session);
    let pending = null;
    const afterCommitCallbacks = [];
    try {
      await store.withTenant({ tenantId, userId: principal.userId }, async (db, membership) => {
        const actor = tenantAstraActor(principal, membership.tenantId, membership.tenantRole);
        if (!route.allowedRoles.includes(actor.tenantRole)) {
          throw new AstraTenantContextError('Tenant role does not allow this action.', 403, 'tenant_role_forbidden');
        }
        const routeSendJson = (responseOrBody, bodyOrStatus, statusOrBody = 200, headers = {}) => {
          if (pending !== null) throw new Error('Astra route attempted to send more than one JSON response.');
          // Accept the existing host order (res, body, status) and the early
          // worker adapter order (res, status, body) during this integration.
          if (responseOrBody && typeof responseOrBody.writeHead === 'function') {
            if (typeof bodyOrStatus === 'number') pending = { body: statusOrBody, status: bodyOrStatus, headers };
            else pending = { body: bodyOrStatus, status: typeof statusOrBody === 'number' ? statusOrBody : 200, headers: statusOrBody && typeof statusOrBody === 'object' ? statusOrBody : headers };
          } else {
            if (typeof responseOrBody === 'number') pending = { body: bodyOrStatus, status: responseOrBody, headers };
            else pending = { body: responseOrBody, status: typeof bodyOrStatus === 'number' ? bodyOrStatus : 200, headers: bodyOrStatus && typeof bodyOrStatus === 'object' ? bodyOrStatus : headers };
          }
        };
        const routeResult = await route.handler(req, res, {
          pathname,
          params: match.groups || {},
          actor,
          db,
          legacyDb,
          afterCommit: callback => {
            if (typeof callback !== 'function') throw new TypeError('afterCommit requires a callback.');
            afterCommitCallbacks.push(callback);
          },
          readJson: (requestOrMaxBytes, maxBytes) => readJsonFrom(req,
            requestOrMaxBytes === req ? maxBytes : requestOrMaxBytes),
          sendJson: routeSendJson,
        });
        if (routeResult !== undefined && pending === null) {
          pending = { body: routeResult.body ?? routeResult, status: routeResult.status || 200, headers: routeResult.headers || {} };
        }
      });
      if (pending) sendJsonTo(res, pending.body, pending.status, pending.headers);
      else if (!res.writableEnded) sendJsonTo(res, null, 204);
      // TenantStore resolves only after COMMIT. Run follow-up work in a new
      // turn so the response and the original transaction are both finished.
      for (const callback of afterCommitCallbacks) {
        setImmediate(() => { try { Promise.resolve(callback()).catch(() => {}); } catch { /* a worker failure does not change the committed API response */ } });
      }
    } catch (error) {
      const safe = publicError(error);
      responseError(res, safe.message, safe.statusCode);
    }
    return true;
  }

  responseError(res, 'Tenant route was not found.', 404);
  return true;
}

export function getRegisteredAstraApiRoutes() {
  return routes.map(({ method, path, allowedRoles }) => ({ method, path: path.source, allowedRoles }));
}

export function resetAstraApiRegistryForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Astra API registry reset is only available in test mode.');
  routes.length = 0;
}
