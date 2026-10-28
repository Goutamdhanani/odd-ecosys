import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { createAstraLocalSearchTransport, isAstraLocalSearchEnabled, ASTRA_LOCAL_SEARCH_ENGINE, ASTRA_LOCAL_SEARCH_ORIGIN } from '../pipeline/astra-local-search-transport.js';
import { createAstraSourceCollectionManager } from '../pipeline/astra-source-collection.js';

const JOB_ID = '08dac31d-0451-42a3-bd25-8353ad6e38c0';
const searchUrl = new URL('/search?q=dental+clinics+Bengaluru+India&format=json&engines=google+cse', ASTRA_LOCAL_SEARCH_ORIGIN);

async function withLoopbackServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try { return await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function withLocalOptIn(run) {
  const enabled = process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED;
  const remote = process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED;
  const configuredOrigin = process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN;
  process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED = 'true';
  process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'false';
  process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = ASTRA_LOCAL_SEARCH_ORIGIN;
  try { return await run(); }
  finally {
    restoreEnv('ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED', enabled);
    restoreEnv('ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED', remote);
    restoreEnv('ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN', configuredOrigin);
  }
}

function jsonServer(result, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType, ...headers });
    response.end(typeof result === 'string' ? result : JSON.stringify(result));
  };
}

function managerWithTransport(origin, withRequestAdmission = null) {
  return createAstraSourceCollectionManager({ query: async () => { throw new Error('Not used by this transport test.'); } }, {
    localSearchTransportForTests: createAstraLocalSearchTransport({ testOrigin: origin }),
    withRequestAdmission: withRequestAdmission || (async (_context, dispatch) => dispatch()),
  });
}

const searchJob = { id: JOB_ID, request: { fields: { category: 'dental clinics', city: 'Bengaluru', country: 'India' } } };

test('local transport accepts only the hard-coded endpoint, exact path and pinned engine', async () => {
  const transport = createAstraLocalSearchTransport();
  await assert.rejects(transport(new URL('/search?q=x&format=json&engines=google+cse', 'http://127.0.0.1:8082'), { method: 'GET', redirect: 'error' }), { code: 'source_search_unavailable' });
  await assert.rejects(transport(new URL('/other?q=x&format=json&engines=google+cse', ASTRA_LOCAL_SEARCH_ORIGIN), { method: 'GET', redirect: 'error' }), { code: 'source_search_unavailable' });
  await assert.rejects(transport(new URL('/search?q=x&format=json&engines=google+cse&engines=bing', ASTRA_LOCAL_SEARCH_ORIGIN), { method: 'GET', redirect: 'error' }), { code: 'source_search_unavailable' });
  assert.throws(() => createAstraLocalSearchTransport({ testOrigin: 'http://localhost:43111' }), /explicit http:\/\/127\.0\.0\.1/);
  assert.throws(() => createAstraLocalSearchTransport({ testOrigin: 'http://192.168.1.5:43111' }), /explicit http:\/\/127\.0\.0\.1/);
  assert.throws(() => createAstraSourceCollectionManager({ query: async () => ({}) }, { localSearchTransportForTests: async () => new Response('{}') }), /trusted loopback-only constructor seam/);
});

test('isolated loopback request is admitted around dispatch, pins google cse, and preserves candidate-only provenance without broad egress', async () => {
  await withLocalOptIn(async () => withLoopbackServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    assert.equal(request.method, 'GET');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('engines'), ASTRA_LOCAL_SEARCH_ENGINE);
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('q'), 'dental clinics Bengaluru India');
    jsonServer({ results: [{ title: 'Clinic', url: 'https://clinic.example/about', content: 'Synthetic local result', engine: 'google cse' }] })(request, response);
  }, async origin => {
    let admitted = 0;
    const manager = managerWithTransport(origin, async (context, dispatch) => {
      admitted++;
      assert.equal(context.operation, 'search');
      assert.equal(context.jobId, JOB_ID);
      return dispatch();
    });
    const result = await manager.searchBusinesses(searchJob);
    assert.equal(admitted, 1);
    assert.equal(process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED, 'false');
    assert.equal(result.origin, ASTRA_LOCAL_SEARCH_ORIGIN);
    assert.equal(result.provider, 'server_configured_local_searxng');
    assert.equal(result.engine, ASTRA_LOCAL_SEARCH_ENGINE);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].engine, ASTRA_LOCAL_SEARCH_ENGINE);
    assert.equal(result.candidates[0].lineage.untrustedDiscoveryCandidate, true);
    assert.equal(result.candidates[0].lineage.engineIdentitySource, 'server_pinned_request');
    assert.equal(result.candidates[0].lineage.verifiedContact, false);
  }));
});

test('local transport refuses redirects without following the target', async () => {
  await withLocalOptIn(async () => withLoopbackServer((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1:1/search' });
    response.end();
  }, async origin => {
    const transport = createAstraLocalSearchTransport({ testOrigin: origin });
    await assert.rejects(transport(searchUrl, { method: 'GET', redirect: 'error' }), { code: 'redirect_policy_blocked' });
  }));
});

test('local search fails closed for bad JSON, wrong engine, wrong content type and HTTP failure', async () => {
  await withLocalOptIn(async () => {
    await withLoopbackServer(jsonServer('{bad json'), async origin => {
      await assert.rejects(managerWithTransport(origin).searchBusinesses(searchJob), { code: 'search_response_invalid' });
    });
    await withLoopbackServer(jsonServer({ results: [{ title: 'Wrong', url: 'https://wrong.example', engine: 'bing' }] }), async origin => {
      await assert.rejects(managerWithTransport(origin).searchBusinesses(searchJob), { code: 'search_response_invalid' });
    });
    await withLoopbackServer(jsonServer({ results: [] }, { contentType: 'text/html' }), async origin => {
      await assert.rejects(managerWithTransport(origin).searchBusinesses(searchJob), { code: 'search_content_type_rejected' });
    });
    await withLoopbackServer(jsonServer({ results: [] }, { headers: { 'content-encoding': 'gzip' } }), async origin => {
      await assert.rejects(managerWithTransport(origin).searchBusinesses(searchJob), { code: 'remote_content_encoding_rejected' });
    });
    await withLoopbackServer(jsonServer({ error: 'synthetic' }, { status: 503 }), async origin => {
      await assert.rejects(managerWithTransport(origin).searchBusinesses(searchJob), { code: 'search_response_unavailable' });
    });
    await withLoopbackServer(jsonServer({ results: [] }, { status: 206 }), async origin => {
      await assert.rejects(managerWithTransport(origin).searchBusinesses(searchJob), { code: 'search_response_unavailable' });
    });
  });
});

test('local transport enforces response-byte and wall-clock time bounds', async () => {
  await withLocalOptIn(async () => {
    await withLoopbackServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': 300_000 });
      response.end('x'.repeat(300_000));
    }, async origin => {
      const transport = createAstraLocalSearchTransport({ testOrigin: origin });
      await assert.rejects(transport(searchUrl, { method: 'GET', redirect: 'error', maxBytes: 256 * 1024 }), { code: 'search_response_too_large' });
    });
    await withLoopbackServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('x'.repeat(300_000));
    }, async origin => {
      const transport = createAstraLocalSearchTransport({ testOrigin: origin });
      await assert.rejects(transport(searchUrl, { method: 'GET', redirect: 'error', maxBytes: 256 * 1024 }), { code: 'search_response_too_large' });
    });
    await withLoopbackServer((_request, response) => {
      setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"results":[]}'); }, 100);
    }, async origin => {
      const transport = createAstraLocalSearchTransport({ testOrigin: origin });
      await assert.rejects(transport(searchUrl, { method: 'GET', redirect: 'error', timeoutMs: 10 }), { code: 'search_timeout' });
    });
  });
});

test('local search opt-in rejects malformed settings and does not accept user endpoint or engine fields', async () => {
  const original = process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED;
  const originalOrigin = process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN;
  process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED = 'yes';
  try {
    const manager = createAstraSourceCollectionManager({ query: async () => { throw new Error('No database call expected.'); } });
    await assert.rejects(manager.searchBusinesses(searchJob), { code: 'source_search_unavailable' });
    let queryCount = 0;
    const inputManager = createAstraSourceCollectionManager({ query: async () => { queryCount++; throw new Error('Should not persist invalid input.'); } });
    await assert.rejects(inputManager.createSearchJob({ tenantId: 'tenant', userId: 'user' }, {
      category: 'dentists', country: 'India', endpoint: 'http://127.0.0.1:9000', engine: 'bing',
    }), /Unsupported business search fields/);
    assert.equal(queryCount, 0);
  } finally {
    restoreEnv('ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED', original);
    restoreEnv('ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN', originalOrigin);
  }
});

test('strict local capability requires exact server opt-in and exact configured origin', () => {
  assert.equal(isAstraLocalSearchEnabled({}), false);
  assert.equal(isAstraLocalSearchEnabled({ ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'false', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: ASTRA_LOCAL_SEARCH_ORIGIN }), false);
  assert.equal(isAstraLocalSearchEnabled({ ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: ASTRA_LOCAL_SEARCH_ORIGIN }), true);
  assert.throws(() => isAstraLocalSearchEnabled({ ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8082' }), /exact true opt-in and pinned loopback origin/);
  assert.throws(() => isAstraLocalSearchEnabled({ ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://localhost:8081' }), /exact true opt-in and pinned loopback origin/);
});

test('local job enqueue works with broad remote transport disabled but still requires S01 and source rights', async () => {
  const names = ['ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED', 'ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED', 'ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN', 'ASTRA_SOURCE_COLLECTION_APPROVALS_JSON'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const digest = createHash('sha256').update('synthetic local S01 fixture').digest('hex');
  const entries = [
    { status: 'approved', decisionId: 'source.searxng-instance-and-engines', reference: 'fixture://local-search/approval', evidenceSha256: digest, scope: ASTRA_LOCAL_SEARCH_ORIGIN, expiresAt: '2099-01-01T00:00:00.000Z' },
    { status: 'approved', decisionId: 'glm.input-processing-and-data-protection', reference: 'fixture://local-search/glm-input', evidenceSha256: digest, expiresAt: '2099-01-01T00:00:00.000Z' },
  ];
  process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED = 'true';
  process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'false';
  process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = ASTRA_LOCAL_SEARCH_ORIGIN;
  process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = JSON.stringify({ approvals: entries });
  try {
    const inserts = [];
    const db = { async query(_sql, values) {
      inserts.push(values);
      return { rows: [{ id: values[1], jobType: 'search', status: values[2], blockedReason: values[3] }] };
    } };
    const manager = createAstraSourceCollectionManager(db);
    const actor = { tenantId: 'tenant-fixture', userId: 'owner-fixture' };
    const sourceRights = {
      rightsPolicy: 'public_terms_permitted', rightsAttested: true, rightsEvidenceReference: 'fixture://rights/source',
      robotsAllowed: true, robotsEvidenceReference: 'fixture://rights/robots', rightsReviewedAt: new Date().toISOString(),
      rightsExpiresAt: '2099-01-01T00:00:00.000Z',
    };
    const queued = await manager.createSearchJob(actor, { category: 'dentists', country: 'India', sourceRights, approvalMode: 'server' });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.blockedReason, null);
    assert.equal(JSON.parse(inserts[0][5]).find(item => item.decisionId === 'source.searxng-instance-and-engines').reference, 'fixture://local-search/approval');
    const noRights = await manager.createSearchJob(actor, { category: 'dentists', country: 'India', approvalMode: 'server' });
    assert.equal(noRights.blockedReason, 'source_rights_unknown_or_expired');
    process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = JSON.stringify({ approvals: entries.slice(1) });
    const noS01 = await manager.createSearchJob(actor, { category: 'dentists', country: 'India', sourceRights, approvalMode: 'server' });
    assert.equal(noS01.blockedReason, 's01_approval_unknown_or_expired');
    process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = JSON.stringify({ approvals: entries });
    process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = 'http://127.0.0.1:8082';
    const wrongOrigin = await manager.createSearchJob(actor, { category: 'dentists', country: 'India', sourceRights, approvalMode: 'server' });
    assert.equal(wrongOrigin.blockedReason, 's01_approval_unknown_or_expired');
  } finally { for (const name of names) restoreEnv(name, previous[name]); }
});
