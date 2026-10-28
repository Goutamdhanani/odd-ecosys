import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAstraProspectingService } from '../pipeline/astra-prospecting.js';
import { registerAstraProspectingRoutes } from '../pipeline/astra-prospecting-routes.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const contactId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actor = { tenantId, userId: 'verified-user', tenantRole: 'owner' };
const routePath = suffix => `/api/astra/tenants/${tenantId}/prospecting${suffix}`;

function routesFor(service) {
  const routes = [];
  registerAstraProspectingRoutes(route => routes.push(route), { service });
  return routes;
}

function findRoute(routes, method, pathname) {
  const route = routes.find(item => item.method === method && item.path.test(pathname));
  assert.ok(route, `${method} ${pathname} should be registered`);
  return { route, params: route.path.exec(pathname).groups };
}

test('authenticated readback and campaign-proof routes pass the exact verified request database', async () => {
  const db = { verifiedRequestDb: true };
  const calls = [];
  const service = {
    async get(...args) { calls.push(['get', ...args]); return { job: { id: jobId } }; },
    async contacts(...args) { calls.push(['contacts', ...args]); return []; },
    async prepareCampaignProof(input) { calls.push(['prepareCampaignProof', input]); return { ready: false }; },
  };
  const routes = routesFor(service);
  const context = { actor, db, readJson: async () => ({}) };

  let selected = findRoute(routes, 'GET', routePath(`/jobs/${jobId}`));
  await selected.route.handler({}, null, { ...context, params: { ...selected.params } });
  selected = findRoute(routes, 'GET', routePath('/contacts'));
  await selected.route.handler({}, null, { ...context, params: { ...selected.params } });
  selected = findRoute(routes, 'POST', routePath(`/contacts/${contactId}/campaign-proof`));
  await selected.route.handler({}, null, { ...context, params: { ...selected.params } });

  assert.equal(calls[0][0], 'get');
  assert.equal(calls[0][4], db, 'GET job must receive the exact request transaction');
  assert.equal(calls[1][0], 'contacts');
  assert.equal(calls[1][3], db, 'GET contacts must receive the exact request transaction');
  assert.equal(calls[2][0], 'prepareCampaignProof');
  assert.equal(calls[2][1].db, db, 'campaign preparation must receive the exact request transaction');
  assert.equal(calls[2][1].actor, actor, 'campaign preparation must receive the verified actor');
});

test('campaign-proof body cannot supply actor, tenant, or database context', async () => {
  const db = { verifiedRequestDb: true };
  let calls = 0;
  const service = { async prepareCampaignProof() { calls++; } };
  const routes = routesFor(service);
  const selected = findRoute(routes, 'POST', routePath(`/contacts/${contactId}/campaign-proof`));

  for (const body of [
    { actor: { tenantId: 'attacker-tenant', tenantRole: 'owner' } },
    { tenantId: 'attacker-tenant' },
    { db: { query: async () => {} } },
  ]) {
    const result = await selected.route.handler({}, null, {
      actor, db, params: { ...selected.params }, readJson: async () => body,
    });
    assert.equal(result.status, 400);
  }
  assert.equal(calls, 0);
});

test('tenant mismatch is rejected before invoking read or preparation services', async t => {
  const calls = [];
  const service = {
    async get(...args) { calls.push(['get', ...args]); return {}; },
    async contacts(...args) { calls.push(['contacts', ...args]); return []; },
    async prepareCampaignProof(...args) { calls.push(['prepare', ...args]); return {}; },
  };
  const routes = routesFor(service);
  const mismatch = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const cases = [
    ['GET', `/api/astra/tenants/${mismatch}/prospecting/jobs/${jobId}`],
    ['GET', `/api/astra/tenants/${mismatch}/prospecting/contacts`],
    ['POST', `/api/astra/tenants/${mismatch}/prospecting/contacts/${contactId}/campaign-proof`],
  ];
  for (const [method, pathname] of cases) await t.test(`${method} ${pathname.split('/').slice(-1)[0]}`, async () => {
    const selected = findRoute(routes, method, pathname);
    const result = await selected.route.handler({}, null, {
      actor, db: {}, params: { ...selected.params }, readJson: async () => ({}),
    });
    assert.equal(result.status, 403);
    assert.equal(calls.length, 0);
  });
});

test('service readback forwards request db to source prospect description', async () => {
  const requestDb = { verifiedRequestDb: true };
  let described;
  const row = {
    id: contactId, jobId,
    contact: { name: 'Northwind', research: { opportunities: [{ sourceEvidenceId: 'evidence-a' }] }, emailCandidates: [], phoneCandidates: [] },
    qualification: { status: 'qualified' },
  };
  const persistence = {
    async connect() {},
    async health() { return { ready: true }; },
    forTenant() { return { contacts: { async list() { return [row]; } } }; },
  };
  const env = {
    ASTRA_PERSISTENCE_BACKEND: 'mongodb', ASTRA_INTEGRATION_MODE: 'prospecting-test',
    MONGODB_URI: 'mongodb://synthetic.invalid', MONGODB_DATABASE: 'prospecting_test',
    ASTRA_MONGODB_TEST_DATABASES: 'prospecting_test',
  };
  const service = createAstraProspectingService({
    env,
    persistenceFactory: () => persistence,
    sourceWorkflow: { async describeCrmProspect(input) { described = input; return { displayName: 'Northwind', emails: [] }; } },
  });
  try {
    const result = await service.contacts(tenantId, actor.userId, requestDb);
    assert.equal(result.length, 1);
    assert.equal(described.db, requestDb);
    assert.equal(described.tenantId, tenantId);
  } finally {
    await service.close();
  }
});

