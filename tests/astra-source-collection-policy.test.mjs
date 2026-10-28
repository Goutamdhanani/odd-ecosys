import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASTRA_LOCAL_SEARCH_ENGINE, ASTRA_LOCAL_SEARCH_ORIGIN, createAstraLocalSearchTransport } from '../pipeline/astra-local-search-transport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;
const now = new Date();
const sourceHash = createHash('sha256').update('synthetic R18 collection policy approval').digest('hex');
const glmHash = createHash('sha256').update('synthetic R18 GLM input approval').digest('hex');
const rights = {
  rightsPolicy: 'public_terms_permitted', rightsAttested: true,
  rightsEvidenceReference: 'fixture://rights/source-terms', robotsAllowed: true,
  robotsEvidenceReference: 'fixture://rights/robots', rightsReviewedAt: now.toISOString(),
  rightsExpiresAt: '2099-01-01T00:00:00.000Z',
};
const actorName = `9${randomUUID().replace(/\D/g, '')}`;

function registry(entries) {
  return JSON.stringify({ approvals: entries });
}
function approval(decisionId, reference, hash, scope, expiresAt = '2099-01-01T00:00:00.000Z') {
  return { status: 'approved', decisionId, reference, evidenceSha256: hash, scope, expiresAt };
}
function fetchRegistry(scope, options = {}) {
  const website = options.website === false ? [] : [approval('source.public-websites', 'fixture://approval/website', sourceHash,
    options.websiteScope ?? scope, options.websiteExpiry)];
  const glm = options.glm === false ? [] : [approval('glm.input-processing-and-data-protection', 'fixture://approval/glm', glmHash, undefined,
    options.glmExpiry)];
  return registry([...website, ...glm, ...(options.duplicateWebsite ? [website[0]] : [])].filter(Boolean));
}
function rightsInput() { return structuredClone(rights); }

test('R18 collection approvals bind enqueue to exact scope, persist trusted refs, and keep worker and transport gates closed', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the prepared R18 disposable synthetic fixture.',
}, async () => {
  const fixture = await validateAstraPlatformFixture({ root, fixturePath, allowR20: true, labels: 'r18-suite', migrations: 32 });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.ok(['r18-suite', 'r20-source-rights'].includes(fixture.label));
  assert.equal(fixture.realData, false);
  assert.equal(fixture.migrations.length, fixture.label === 'r20-source-rights' ? 37 : 32);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol));
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname));
  }

  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
  const { createAstraTenantStore } = await import('../pipeline/astra-tenant-store.js');
  const { createAstraSourceCollectionManager, runAstraSourceCollectionOnce } = await import('../pipeline/astra-source-collection.js');
  const { registerAstraSourceCollectionRoutes } = await import('../pipeline/astra-source-collection-routes.js');
  const appStore = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
  const workerStore = createAstraTenantStore({ connectionString: fixture.workerConnectionString, contextSecret: fixture.contextSecret });
  const tenant = await appStore.createTenant({ name: 'Synthetic collection policy verification', userId: actorName });
  const actor = { tenantId: tenant.tenantId, userId: actorName, role: 'owner' };
  const checks = [];
  let workerJobId;
  let duplicateWorkerJobId;
  let localSearchJobId;
  let localSearchNoAdmissionJobId;
  try {
    await appStore.withTenant(actor, async db => {
      const manager = createAstraSourceCollectionManager(db, { now: () => now, workerAvailable: true });
      const domain = 'policy-exact.example.test';
      process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'true';
      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain);
      const exact = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/about`, sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(exact.status, 'queued', 'exact server approval is present at fetch enqueue');
      const persisted = await db.query('SELECT request,approval_references AS "approvalReferences",rights_record AS "rightsRecord" FROM astra.source_collection_jobs WHERE tenant_id=$1 AND id=$2', [tenant.tenantId, exact.id]);
      assert.equal(persisted.rows[0].request.normalizedDomain, domain);
      assert.deepEqual(persisted.rows[0].approvalReferences.map(ref => ref.decisionId).sort(), ['glm.input-processing-and-data-protection', 'source.public-websites']);
      assert.equal(persisted.rows[0].approvalReferences.find(ref => ref.decisionId === 'source.public-websites').reference, 'fixture://approval/website');
      assert.equal(persisted.rows[0].rightsRecord.rightsExpiresAt, rights.rightsExpiresAt, 'user-provided rights expiry is preserved');
      checks.push('exact scoped S01 approval passes enqueue and references/rights persist in job row');

      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain, { website: false });
      const missing = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/missing`, sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(missing.status, 'blocked'); assert.equal(missing.blockedReason, 's01_approval_unknown_or_expired');
      checks.push('missing required approval fails closed');

      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain, { websiteExpiry: '2000-01-01T00:00:00.000Z' });
      const expired = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/expired`, sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(expired.status, 'blocked'); assert.equal(expired.blockedReason, 's01_approval_unknown_or_expired');
      checks.push('expired approval fails closed');

      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain, { duplicateWebsite: true });
      const ambiguous = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/ambiguous`, sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(ambiguous.status, 'blocked'); assert.equal(ambiguous.blockedReason, 's01_approval_unknown_or_expired');
      checks.push('ambiguous current approval fails closed');

      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain, { websiteScope: 'other.example.test' });
      const foreign = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/foreign`, sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(foreign.status, 'blocked'); assert.equal(foreign.blockedReason, 's01_approval_unknown_or_expired');
      checks.push('foreign-domain approval fails closed');

      process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = 'https://search.fixture.test';
      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = registry([
        approval('source.searxng-instance-and-engines', 'fixture://approval/search', sourceHash, 'https://search.fixture.test'),
        approval('glm.input-processing-and-data-protection', 'fixture://approval/glm-search', glmHash, undefined),
      ]);
      const search = await manager.createSearchJob(actor, { category: 'manufacturing', country: 'India', sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(search.status, 'queued');
      const persistedSearch = await db.query('SELECT approval_references AS "approvalReferences" FROM astra.source_collection_jobs WHERE tenant_id=$1 AND id=$2', [tenant.tenantId, search.id]);
      assert.deepEqual(persistedSearch.rows[0].approvalReferences.map(ref => ref.decisionId).sort(), ['glm.input-processing-and-data-protection', 'source.searxng-instance-and-engines']);
      checks.push('server search approval resolves against exact configured origin and persists refs');

      process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED = 'true';
      process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'false';
      process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = ASTRA_LOCAL_SEARCH_ORIGIN;
      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = registry([
        approval('source.searxng-instance-and-engines', 'fixture://approval/local-search', sourceHash, ASTRA_LOCAL_SEARCH_ORIGIN),
        approval('glm.input-processing-and-data-protection', 'fixture://approval/glm-local-search', glmHash, undefined),
      ]);
      const localSearch = await manager.createSearchJob(actor, { category: 'manufacturing', country: 'India', sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(localSearch.status, 'queued', 'local search opt-in does not require the broad public website/search egress flag');
      localSearchJobId = localSearch.id;
      const localWithoutAdmission = await manager.createSearchJob(actor, { category: 'manufacturing', country: 'India', sourceRights: rightsInput(), approvalMode: 'server' });
      localSearchNoAdmissionJobId = localWithoutAdmission.id;
      checks.push('local search enqueue is separately opted in and still S01/source-rights gated while broad egress is false');

      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry('local-only-website.example.test');
      const websiteWhileLocalOnly = await manager.createFetchJob(actor, { sourceUrl: 'https://local-only-website.example.test/about', sourceRights: rightsInput(), approvalMode: 'server' });
      assert.equal(websiteWhileLocalOnly.status, 'blocked');
      assert.equal(websiteWhileLocalOnly.blockedReason, 'remote_transport_disabled', 'local search does not enable public website fetch');
      checks.push('website fetch remains blocked by broad egress policy under local-only search opt-in');

      process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'true';
      const legacyRefs = [
        { decisionId: 'source.public-websites', reference: 'fixture://approval/website', evidenceSha256: sourceHash },
        { decisionId: 'glm.input-processing-and-data-protection', reference: 'fixture://approval/glm', evidenceSha256: glmHash },
      ];
      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain);
      const legacy = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/legacy`, sourceRights: rightsInput(), approvalReferences: legacyRefs });
      assert.equal(legacy.status, 'queued');
      await assert.rejects(() => manager.createFetchJob(actor, { sourceUrl: `https://${domain}/conflict`, sourceRights: rightsInput(), approvalMode: 'server', approvalReferences: [] }),
        error => error.code === 'source_approval_mode_conflict');
      checks.push('legacy explicit-reference API remains compatible; server mode rejects client refs');

      const unavailable = await createAstraSourceCollectionManager(db, { now: () => now, workerAvailable: false })
        .createFetchJob(actor, { sourceUrl: `https://${domain}/no-worker`, sourceRights: rightsInput(), approvalReferences: legacyRefs });
      assert.equal(unavailable.status, 'blocked'); assert.equal(unavailable.blockedReason, 'worker_unavailable');
      const registered = [];
      registerAstraSourceCollectionRoutes(route => registered.push(route));
      const routePost = registered.find(route => route.method === 'POST' && route.path.test(`/api/astra/tenants/${tenant.tenantId}/collection/fetch`));
      const scheduled = [];
      const routeResult = await routePost.handler({ url: '/' }, null, {
        actor, params: { tenantId: tenant.tenantId }, db,
        readJson: async () => ({ sourceUrl: `https://${domain}/route-no-worker`, sourceRights: rightsInput(), approvalReferences: legacyRefs }),
        afterCommit: callback => scheduled.push(callback),
      });
      assert.equal(routeResult.body.job.status, 'blocked');
      assert.equal(routeResult.body.job.blockedReason, 'worker_unavailable');
      assert.equal(scheduled.length, 0, 'route does not schedule when worker configuration is absent');
      checks.push('worker-unavailable enqueue remains blocked and route schedules no one-shot work');

      process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'true';
      process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry(domain);
      const queuedBeforeDisable = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/disable-before-run`, sourceRights: rightsInput(), approvalReferences: legacyRefs });
      assert.equal(queuedBeforeDisable.status, 'queued');
      workerJobId = queuedBeforeDisable.id;
      const queuedBeforeDuplicate = await manager.createFetchJob(actor, { sourceUrl: `https://${domain}/duplicate-after-enqueue`, sourceRights: rightsInput(), approvalReferences: legacyRefs });
      assert.equal(queuedBeforeDuplicate.status, 'queued');
      duplicateWorkerJobId = queuedBeforeDuplicate.id;
    });
    process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'false';
    process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry('policy-exact.example.test');
    const workerResult = await runAstraSourceCollectionOnce({ store: workerStore, tenantId: tenant.tenantId, userId: actorName, jobId: workerJobId });
    assert.equal(workerResult.status, 'blocked');
    assert.equal(workerResult.blockedReason, 'remote_transport_disabled');
    process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = fetchRegistry('policy-exact.example.test', { duplicateWebsite: true });
    const duplicateWorkerResult = await runAstraSourceCollectionOnce({ store: workerStore, tenantId: tenant.tenantId, userId: actorName, jobId: duplicateWorkerJobId });
    assert.equal(duplicateWorkerResult.status, 'blocked');
    assert.equal(duplicateWorkerResult.blockedReason, 's01_approval_unknown_or_expired', 'worker rejects newly ambiguous current registry before the remote gate');
    await appStore.withTenant(actor, async db => {
      const stopped = await createAstraSourceCollectionManager(db).getJob(tenant.tenantId, workerJobId);
      assert.equal(stopped.latestRun.outcome.transportAttempted, false);
      assert.equal(stopped.latestRun.outcome.dnsAttempted, false);
      const duplicateStopped = await createAstraSourceCollectionManager(db).getJob(tenant.tenantId, duplicateWorkerJobId);
      assert.equal(duplicateStopped.latestRun.outcome.transportAttempted, false);
      assert.equal(duplicateStopped.latestRun.outcome.dnsAttempted, false);
    });
    checks.push('remote-disabled worker recheck blocks before DNS or transport');
    checks.push('duplicate current approval added after enqueue fails S01 before DNS or transport');

    process.env.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED = 'true';
    process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'false';
    process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = ASTRA_LOCAL_SEARCH_ORIGIN;
    process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = registry([
      approval('source.searxng-instance-and-engines', 'fixture://approval/local-search', sourceHash, ASTRA_LOCAL_SEARCH_ORIGIN),
      approval('glm.input-processing-and-data-protection', 'fixture://approval/glm-local-search', glmHash, undefined),
    ]);
    const noAdmission = await runAstraSourceCollectionOnce({ store: workerStore, tenantId: tenant.tenantId, userId: actorName, jobId: localSearchNoAdmissionJobId });
    assert.equal(noAdmission.status, 'failed');
    assert.equal(noAdmission.errorCode, 'source_request_admission_unavailable');
    await appStore.withTenant(actor, async db => {
      const blockedLocal = await createAstraSourceCollectionManager(db).getJob(tenant.tenantId, localSearchNoAdmissionJobId);
      assert.equal(blockedLocal.status, 'failed');
      assert.equal(blockedLocal.blockedReason, null);
      assert.equal(blockedLocal.errorCode, 'source_request_admission_unavailable');
      assert.equal(blockedLocal.latestRun.outcome.transportAttempted, false);
      assert.equal(blockedLocal.latestRun.outcome.dnsAttempted, false);
    });
    checks.push('local worker without trusted request-admission wrapper is blocked before dispatch');

    const localServer = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      assert.equal(request.method, 'GET');
      assert.equal(url.pathname, '/search');
      assert.equal(url.searchParams.get('engines'), ASTRA_LOCAL_SEARCH_ENGINE);
      assert.equal(url.searchParams.get('format'), 'json');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [{ title: 'Synthetic dental clinic', url: 'https://synthetic-clinic.example/about', content: 'Fixture candidate only', engine: ASTRA_LOCAL_SEARCH_ENGINE }] }));
    });
    await new Promise((resolve, reject) => { localServer.once('error', reject); localServer.listen(0, '127.0.0.1', resolve); });
    try {
      const admissions = [];
      const localRun = await runAstraSourceCollectionOnce({ store: workerStore, tenantId: tenant.tenantId, userId: actorName, jobId: localSearchJobId,
        localSearchTransportForTests: createAstraLocalSearchTransport({ testOrigin: `http://127.0.0.1:${localServer.address().port}` }),
        beforeRequest: async () => { admissions.push('before'); },
        reserveRequest: async context => { admissions.push(`reserved:${context.operation}`); },
        withRequestAdmission: async (context, dispatch) => {
          admissions.push(`admitted:${context.operation}`);
          await context.beforeRequest();
          await context.reserveRequest({ operation: context.operation, sourceJobId: context.jobId });
          const response = await dispatch();
          admissions.push('dispatched');
          return response;
        },
      });
      assert.equal(localRun.status, 'completed', JSON.stringify(localRun));
      assert.deepEqual(admissions, ['admitted:search', 'before', 'reserved:search', 'dispatched']);
      await appStore.withTenant(actor, async db => {
        const completed = await createAstraSourceCollectionManager(db).getJob(tenant.tenantId, localSearchJobId);
        assert.equal(completed.status, 'completed');
        assert.equal(completed.latestRun.outcome.provider, 'server_configured_local_searxng');
        assert.equal(completed.latestRun.outcome.origin, ASTRA_LOCAL_SEARCH_ORIGIN);
        assert.equal(completed.latestRun.outcome.engine, ASTRA_LOCAL_SEARCH_ENGINE);
        assert.equal(completed.latestRun.outcome.dnsAttempted, false, 'literal loopback dispatch performs no DNS resolution');
        assert.equal(completed.candidates.length, 1);
        assert.equal(completed.candidates[0].engine, ASTRA_LOCAL_SEARCH_ENGINE);
        assert.equal(completed.candidates[0].verified, false);
        assert.equal(completed.candidates[0].candidateOnly, true);
      });
      checks.push('canonical synthetic tenant job completes through admitted isolated loopback transport with actual provider/engine provenance and candidate-only result');
    } finally { await new Promise(resolve => localServer.close(resolve)); }
    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, label: fixture.label, migrations: fixture.migrations.length, realData: false, checks }, null, 2)}\n`);
  } finally {
    await Promise.all([appStore.close(), workerStore.close()]);
  }
});
