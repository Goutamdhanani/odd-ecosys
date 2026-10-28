import {
  registerAstraBanditArms, listAstraBanditArms, createAstraBanditLane, proposeAstraBanditAllocations,
  captureAstraBanditObservations, refreshAstraBanditRewards, evaluateAstraBanditLane, listAstraBanditLanes,
} from './astra-bandits.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})';
const READ = ['owner', 'admin', 'operator', 'reviewer'];
const AUTHOR = ['owner', 'admin'];
const RECORDER = ['owner', 'admin', 'operator'];

function route(register, method, suffix, handler, allowedRoles = READ) {
  register({ method, path: new RegExp(`${BASE}${suffix}$`), handler, allowedRoles });
}

export function registerAstraBanditRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  route(registerAstraApiRoute, 'GET', '/bandits/arms', async (_req, _res, { actor, params, db, sendJson }) => {
    assertTenant(actor, params);
    return sendJson(_res, { items: await listAstraBanditArms(db, actor.tenantId), liveAllocation: false, releaseReady: false }, 200);
  });
  route(registerAstraApiRoute, 'POST', '/bandits/arms', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params);
    return { status: 201, body: { registry: await registerAstraBanditArms(db, actor, await readJson(req, 64 * 1024)), releaseReady: false } };
  }, AUTHOR);
  route(registerAstraApiRoute, 'GET', '/bandits/lanes', async (_req, _res, { actor, params, db, sendJson }) => {
    assertTenant(actor, params);
    return sendJson(_res, { items: await listAstraBanditLanes(db, actor.tenantId), liveAllocation: false, releaseReady: false }, 200);
  });
  route(registerAstraApiRoute, 'POST', '/bandits/lanes', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params);
    return { status: 201, body: { lane: await createAstraBanditLane(db, actor, await readJson(req, 16 * 1024)), releaseReady: false } };
  }, AUTHOR);
  route(registerAstraApiRoute, 'POST', '/bandits/lanes/(?<laneId>[0-9a-fA-F-]{36})/proposals', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params);
    return { status: 201, body: await proposeAstraBanditAllocations(db, actor, params.laneId, await readJson(req, 64 * 1024)) };
  }, AUTHOR);
  route(registerAstraApiRoute, 'POST', '/bandits/lanes/(?<laneId>[0-9a-fA-F-]{36})/observations', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params);
    return { status: 201, body: await captureAstraBanditObservations(db, actor, params.laneId, await readJson(req, 64 * 1024)) };
  }, RECORDER);
  route(registerAstraApiRoute, 'POST', '/bandits/lanes/(?<laneId>[0-9a-fA-F-]{36})/rewards/refresh', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 4096);
    if (Object.keys(body || {}).some(key => key !== 'now')) throw Object.assign(new Error('Only the optional evaluation time is accepted.'), { statusCode: 400 });
    return { status: 201, body: await refreshAstraBanditRewards(db, actor, params.laneId, body || {}) };
  }, RECORDER);
  route(registerAstraApiRoute, 'POST', '/bandits/lanes/(?<laneId>[0-9a-fA-F-]{36})/evaluate', async (req, _res, { actor, params, db, readJson }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 4096);
    if (Object.keys(body || {}).some(key => key !== 'maxWeight')) throw Object.assign(new Error('Only a bounded maxWeight is accepted.'), { statusCode: 400 });
    return { status: 201, body: await evaluateAstraBanditLane(db, actor, params.laneId, body || {}) };
  }, AUTHOR);
  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/bandits/arms',
    'GET|POST /api/astra/tenants/:tenantId/bandits/lanes',
    'POST /api/astra/tenants/:tenantId/bandits/lanes/:laneId/proposals',
    'POST /api/astra/tenants/:tenantId/bandits/lanes/:laneId/observations',
    'POST /api/astra/tenants/:tenantId/bandits/lanes/:laneId/rewards/refresh',
    'POST /api/astra/tenants/:tenantId/bandits/lanes/:laneId/evaluate',
  ], liveAllocation: false, sendsAllowed: false, releaseReady: false };
}

function assertTenant(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    throw Object.assign(new Error('Verified tenant membership is required.'), { statusCode: 403, code: 'tenant_membership_required' });
  }
}
