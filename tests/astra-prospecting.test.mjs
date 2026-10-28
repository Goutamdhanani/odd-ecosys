import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAstraProspectingService, normalizeProspectingRequest, runAstraProspectingOnce as runProspecting } from '../pipeline/astra-prospecting.js';
import { registerAstraProspectingRoutes } from '../pipeline/astra-prospecting-routes.js';
import { runAstraSourceCollectionOnce } from '../pipeline/astra-source-collection.js';
import { inspectXrayPage } from '../pipeline/astra-xray.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const JOB = '11111111-1111-4111-8111-111111111111';
// Explicit synthetic research/CRM adapters keep the existing source recovery
// regressions independent of provider setup. Production has no implicit mock.
function runAstraProspectingOnce(options) {
  const researchWorkflow = { async analyze({ page }) {
    const evidenceExcerpt = String(page.visibleText).split(/(?<=[.!?])\s+/).find(line => /Acme Design Studio in Toronto, Canada, is hiring/.test(line));
    return { status: 'completed', responseVerified: true, actualProvider: 'synthetic-fixture', actualModel: 'synthetic-fixture-model',
      usage: { actualCostMicrousd: null }, opportunities: evidenceExcerpt ? [{ title: 'Synthetic fixture opportunity', rationale: 'Synthetic fixture source statement.', evidenceExcerpt }] : [] };
  } };
  return runProspecting({ ...options, researchWorkflow,
    sourceWorkflow: { ...options.sourceWorkflow, resolveCrmAccount: async () => ({ accountId: '33333333-3333-4333-8333-333333333333', savedAt: '2026-10-27T00:00:00.000Z' }) } });
}
function makePersistence(payload, { checkpointError, evidenceError, afterCheckpoint } = {}) {
  const data = { job: { id: JOB, tenantId: TENANT, payload, state: 'running', version: 1, checkpoint: {} }, evidence: [], outcomes: [], contacts: [], calls: [] };
  let checkpointFailures = checkpointError?.count || 0, evidenceFailures = evidenceError?.count || 0;
  let claimFence = 0;
  const tenant = {
    jobs: {
      async claim() { data.calls.push('claim'); claimFence += 1; data.job = { ...data.job, state: 'running', version: data.job.version + 1 }; return { job: data.job, lease: { owner: 'test-worker', fence: claimFence, until: new Date(Date.now() + 30_000), version: data.job.version } }; },
      async checkpoint(_id, input) {
        data.calls.push(`checkpoint:${input.idempotencyKey}`);
        if (checkpointFailures > 0) { checkpointFailures -= 1; throw Object.assign(new Error('mock commit uncertainty'), { code: 'uncertain_commit', commitState: 'unknown', reconciliationRequired: true }); }
        if (data.job.state !== 'running') throw Object.assign(new Error('job is no longer running'), { code: 'invalid_transition' });
        data.job = { ...data.job, checkpoint: input.checkpoint, version: data.job.version + 1 };
        await afterCheckpoint?.(data, input);
        return { job: data.job };
      },
      async get() { return data.job; },
      async list() { return [data.job]; },
      async events() { return []; },
      async transition(_id, input) {
        data.calls.push(`transition:${input.action}`);
        const states = { complete: 'completed', fail: 'failed', pause: 'paused', resume: 'queued', cancel: 'cancelled' };
        data.job = { ...data.job, state: states[input.action], version: data.job.version + 1, reason: input.reason || data.job.reason }; return { job: data.job };
      },
    },
    evidence: {
      async record(input) {
        data.calls.push(`evidence:${input.idempotencyKey}`);
        if (evidenceFailures > 0) { evidenceFailures -= 1; throw Object.assign(new Error('mock commit uncertainty'), { code: 'uncertain_commit', commitState: 'unknown', reconciliationRequired: true }); }
        const old = data.evidence.find(item => item.idempotencyKey === input.idempotencyKey);
        if (old) return { evidence: old, replayed: true };
        const row = { id: `${String(data.evidence.length + 1).padStart(8, '0')}-1111-4111-8111-111111111111`, jobId: input.jobId, idempotencyKey: input.idempotencyKey, evidence: input.evidence, createdAt: new Date().toISOString() };
        data.evidence.push(row); return { evidence: row, replayed: false };
      },
      async listForJob() { return data.evidence; },
    },
    outcomes: {
      async append(input) {
        data.calls.push(`outcome:${input.idempotencyKey}`);
        const old = data.outcomes.find(item => item.idempotencyKey === input.idempotencyKey);
        if (old) return { outcome: old, replayed: true };
        data.outcomes.push(input); return { outcome: input, replayed: false };
      },
      async listForJob() { return data.outcomes; },
    },
    contacts: {
      async qualify(input) {
        const old = data.contacts.find(item => item.idempotencyKey === input.idempotencyKey);
        if (old) return { contact: old, replayed: true };
        const duplicate = data.contacts.find(item => item.identityKey === input.identityKey);
        if (duplicate) throw Object.assign(new Error('duplicate'), { code: 'identity_conflict' });
        const row = { id: '33333333-3333-4333-8333-333333333333', ...input, createdAt: new Date().toISOString() };
        data.contacts.push(row); return { contact: row, replayed: false };
      },
      async list() { return data.contacts; },
    },
  };
  return { data, persistence: { backend: 'mongodb', forTenant(context) { assert.equal(context.tenantId, data.job.tenantId); return tenant; } } };
}

function request() {
  return {
    category: 'design studios', country: 'Canada', city: 'Toronto', goal: 'Find studios with an explicit hiring or expansion signal', targetCount: 5,
    sourceRights: { rightsEvidenceReference: 'terms page reviewed', robotsEvidenceReference: 'robots rules reviewed', rightsExpiresAt: new Date(Date.now() + 86400000).toISOString(), rightsAttested: true, robotsAllowed: true },
  };
}

function site(html, sourceUrl, candidate) {
  const content = Buffer.from(html);
  const contentSha256 = createHash('sha256').update(content).digest('hex');
  return { page: inspectXrayPage({ html: content, sourceUrl, normalizedDomain: candidate.canonicalDomain }), content, contentSha256 };
}

function mockSqlSourceJob() {
  const hash = 'a'.repeat(64), runs = [], claims = [];
  const job = { id: JOB, jobType: 'search', request: { fields: { category: 'design studios', country: 'Canada', city: 'Toronto' } },
    approvalReferences: [
      { decisionId: 'source.searxng-instance-and-engines', reference: 'fixture://search', evidenceSha256: hash },
      { decisionId: 'glm.input-processing-and-data-protection', reference: 'fixture://glm', evidenceSha256: hash },
    ], rightsRecord: { rightsPolicy: 'public_terms_permitted', rightsAttested: true, rightsEvidenceReference: 'fixture://terms', robotsAllowed: true,
      robotsEvidenceReference: 'fixture://robots', rightsReviewedAt: new Date().toISOString(), rightsExpiresAt: '2099-01-01T00:00:00.000Z' },
    createdBy: 'fixture-owner', status: 'queued', latestRunId: null };
  const db = { async query(sql, params = []) {
    if (sql.includes('FROM astra.source_collection_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE')) {
      claims.push(params[1]);
      return { rowCount: 1, rows: [{ ...job }] };
    }
    if (sql.includes('INSERT INTO astra.source_collection_runs')) {
      const run = { id: params[1], jobId: params[2], status: 'started', provenance: JSON.parse(params[3]) };
      runs.push(run); return { rowCount: 1, rows: [] };
    }
    if (sql.includes("UPDATE astra.source_collection_jobs SET status='running'")) {
      job.status = 'running'; job.latestRunId = params[3]; job.startedAt = params[2]; return { rowCount: 1, rows: [] };
    }
    if (sql.includes("UPDATE astra.source_collection_runs SET status='failed'")) {
      const run = runs.find(item => item.id === params[1] && item.jobId === params[2] && item.status === 'started');
      if (!run) return { rowCount: 0, rows: [] };
      run.status = 'failed'; run.outcome = JSON.parse(params[3]); return { rowCount: 1, rows: [{ id: run.id }] };
    }
    if (sql.includes("UPDATE astra.source_collection_jobs SET status='failed'")) {
      if (job.status !== 'running' || job.latestRunId !== params[2]) return { rowCount: 0, rows: [] };
      job.status = 'failed'; job.finishedAt = params[4]; job.errorCode = params[3];
      return { rowCount: 1, rows: [{ id: job.id }] };
    }
    if (sql.includes('UPDATE astra.source_collection_runs SET status=$4')) {
      const run = runs.find(item => item.id === params[1] && item.jobId === params[2] && item.status === 'started');
      if (!run) return { rowCount: 0, rows: [] };
      run.status = params[3]; run.outcome = JSON.parse(params[4]); return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE astra.source_collection_jobs SET status=$3')) {
      job.status = params[2]; job.errorCode = params[4]; job.blockedReason = params[3]; job.finishedAt = params[8];
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected mock SQL: ${sql}`);
  } };
  return { job, runs, claims, store: { async withWorkerTenant(_actor, callback) { return callback(db); } } };
}

async function withSourceCollectorEnvironment(callback) {
  const keys = ['ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED', 'ASTRA_SOURCE_COLLECTION_APPROVALS_JSON', 'ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'true';
  process.env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN = 'https://search.example';
  process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = JSON.stringify({ approvals: [
    { status: 'approved', decisionId: 'source.searxng-instance-and-engines', reference: 'fixture://search', evidenceSha256: 'a'.repeat(64), scope: 'https://search.example', expiresAt: '2099-01-01T00:00:00.000Z' },
    { status: 'approved', decisionId: 'glm.input-processing-and-data-protection', reference: 'fixture://glm', evidenceSha256: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
  ] });
  try { await callback(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('post-admission pause records immutable retry-safe terminal provenance without requeueing the bound SQL job', async () => {
  await withSourceCollectorEnvironment(async () => {
    const fixture = mockSqlSourceJob(); let waits = 0, reservations = 0, dispatches = 0;
    const args = { store: fixture.store, tenantId: TENANT, userId: 'fixture-owner', jobId: JOB,
      beforeRequest: async () => { waits += 1; if (waits <= 2) throw Object.assign(new Error('parent paused after admission wait'), { code: 'job_paused' }); },
      reserveRequest: async () => { reservations += 1; },
      withRequestAdmission: async (_context, dispatch) => {
        await args.beforeRequest(); // deterministic post-wait fence check; no reservation or dispatch follows
        dispatches += 1; return dispatch();
      } };
    const deferred = await runAstraSourceCollectionOnce(args);
    assert.equal(deferred.status, 'failed', JSON.stringify(deferred));
    assert.equal(deferred.deferred, true);
    assert.equal(fixture.job.status, 'failed');
    assert.equal(fixture.runs[0].status, 'failed', 'the stopped attempt remains durable history');
    assert.equal(fixture.runs[0].outcome.status, 'deferred');
    assert.equal(fixture.runs[0].outcome.transportAttempted, false);
    assert.equal(fixture.runs[0].outcome.requestReservationAttempted, false);
    assert.equal(reservations, 0);
    assert.equal(dispatches, 0);

    const resumed = await runAstraSourceCollectionOnce(args);
    assert.equal(resumed.status, 'failed');
    assert.deepEqual(fixture.claims, [JOB, JOB], 'a lookup may inspect the original id, but the terminal job cannot create another run');
    assert.equal(fixture.runs.length, 1, 'no second source run is fabricated for the old job');
    assert.equal(reservations, 0, 'a pause still consumes no durable source-request reservation');
    assert.equal(dispatches, 0, 'a pause still reaches no transport dispatch');
  });
});

test('cancellation stays terminal and cannot use the safe pre-dispatch deferral path', async () => {
  await withSourceCollectorEnvironment(async () => {
    const fixture = mockSqlSourceJob(); let reservations = 0, dispatches = 0;
    const beforeRequest = async () => { throw Object.assign(new Error('cancelled'), { code: 'job_cancelled' }); };
    const result = await runAstraSourceCollectionOnce({ store: fixture.store, tenantId: TENANT, userId: 'fixture-owner', jobId: JOB,
      beforeRequest,
      reserveRequest: async () => { reservations += 1; },
      withRequestAdmission: async (_context, dispatch) => { await beforeRequest(); dispatches += 1; return dispatch(); } });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'job_cancelled');
    assert.equal(fixture.job.status, 'failed');
    assert.equal(reservations, 0);
    assert.equal(dispatches, 0);
    const second = await runAstraSourceCollectionOnce({ store: fixture.store, tenantId: TENANT, userId: 'fixture-owner', jobId: JOB });
    assert.equal(second.status, 'failed');
    assert.equal(fixture.runs.length, 1);
  });
});

test('uncertain reservation and post-dispatch errors fail closed without requeueing the source job', async () => {
  await withSourceCollectorEnvironment(async () => {
    for (const mode of ['uncertain-reservation', 'post-dispatch']) {
      const fixture = mockSqlSourceJob(); let dispatches = 0;
      const result = await runAstraSourceCollectionOnce({ store: fixture.store, tenantId: TENANT, userId: 'fixture-owner', jobId: JOB,
        beforeRequest: async () => {},
        reserveRequest: async () => { if (mode === 'uncertain-reservation') throw Object.assign(new Error('reservation commit unknown'), { code: 'prospecting_reconciliation_required' }); },
        withRequestAdmission: async (context, dispatch) => {
          await context.reserveRequest({ operation: context.operation, sourceJobId: JOB });
          if (mode === 'uncertain-reservation') throw Object.assign(new Error('reservation outcome uncertain'), { code: 'prospecting_reconciliation_required' });
          dispatches += 1;
          throw Object.assign(new Error('transport outcome uncertain after dispatch entry'), { transportAttempted: true });
        } });
      assert.equal(result.status, 'failed', mode);
      assert.equal(fixture.job.status, 'failed', mode);
      assert.equal(fixture.runs[0].status, 'failed', mode);
      if (mode === 'uncertain-reservation') assert.equal(fixture.runs[0].outcome.transportAttempted, false);
      else assert.equal(fixture.runs[0].outcome.transportAttempted, true);
      const second = await runAstraSourceCollectionOnce({ store: fixture.store, tenantId: TENANT, userId: 'fixture-owner', jobId: JOB });
      assert.equal(second.status, 'failed', `${mode} must not become replayable`);
      assert.equal(fixture.runs.length, 1, `${mode} must not create a replay run`);
      assert.equal(dispatches, mode === 'post-dispatch' ? 1 : 0);
    }
  });
});

function mockWorkflow(rows) {
  const jobs = new Map(); let next = 0; const network = [], http = [], fetchCreates = [];
  const searchId = 'search-job';
  jobs.set(searchId, { id: searchId, jobType: 'search', status: 'queued' });
  return {
    network, http, fetchCreates,
    async createSearchJob({ job }) { assert.equal(job.payload.category, 'design studios'); return jobs.get(searchId); },
    async createFetchJob({ candidate }) { const id = `fetch-${++next}`; fetchCreates.push(id); jobs.set(id, { id, jobType: 'fetch', status: 'queued', candidate, evidenceId: `44444444-4444-4444-8444-${String(next).padStart(12, '0')}` }); return jobs.get(id); },
    async readJob({ jobId }) { return jobs.get(jobId) || null; },
    async runJob({ jobId, signal, beforeRequest, reserveRequest }) {
      assert.equal(Boolean(signal?.aborted), false, 'mock collection only runs while the job is active');
      network.push(jobId);
      const current = jobs.get(jobId);
      if (current.status !== 'queued') return current;
      if (current.jobType === 'search') {
        await beforeRequest?.(); await reserveRequest?.({ operation: 'search', sourceJobId: jobId }); http.push({ operation: 'search', jobId });
      } else {
        for (const operation of ['robots', 'page']) {
          await beforeRequest?.(); await reserveRequest?.({ operation, sourceJobId: jobId }); http.push({ operation, jobId });
        }
      }
      if (current.jobType === 'search') {
        current.status = 'completed'; current.candidates = rows; current.latestRun = { provenance: { origin: 'https://search.test', querySha256: 'a'.repeat(64), runId: 'run-1' } };
      } else current.status = 'completed';
      return current;
    },
    async readWebsite({ sourceJob, candidate }) {
      const captured = sourceJob.candidate.site;
      const hash = createHash('sha256').update(captured.content).digest('hex');
      return { page: captured.page, sourceEvidence: { sourceId: `55555555-5555-4555-8555-${String(sourceJob.id.endsWith('1') ? 1 : 2).padStart(12, '0')}`, sourceRightsUsable: true, contentSha256: hash, capturedAt: new Date().toISOString(), extractorVersion: 'mock-test-html/1', rightsPolicy: 'public_terms_permitted', rightsExpiresAt: request().sourceRights.rightsExpiresAt, sourceRightsStatus: 'permitted' }, snapshotVerified: hash === captured.contentSha256, candidate };
    },
  };
}

const candidates = () => {
  const studio = { title: 'Toronto design studios hiring', sourceUrl: 'https://acme-design.example/', canonicalDomain: 'acme-design.example', snippet: 'Toronto Canada design studio hiring. hello@example.com', engine: 'web', createdAt: new Date().toISOString() };
  studio.site = site('<html><head><title>Acme Design Studio</title></head><body><h1>Acme Design Studio</h1><p>Acme Design Studio in Toronto, Canada, is hiring new designers this month. Email hello@acme-design.example</p><a href="mailto:hello@acme-design.example">Email</a><a href="tel:+14165550123">Call</a></body></html>', studio.sourceUrl, studio);
  const directory = { title: 'Toronto design studios hiring directory', sourceUrl: 'https://directory.example/', canonicalDomain: 'directory.example', snippet: 'Toronto Canada design studios are hiring', engine: 'web', createdAt: new Date().toISOString() };
  directory.site = site('<html><head><title>Toronto Studio Directory</title></head><body><h1>Toronto Design Directory</h1><p>Canada design studios are hiring. Directory listing.</p></body></html>', directory.sourceUrl, directory);
  return [studio, directory];
};

test('prospecting input is bounded, public-only, and requires current source review', () => {
  const normalized = normalizeProspectingRequest(request());
  assert.equal(normalized.targetCount, 5);
  assert.equal(normalized.budgets.maxProviderRequests, 10);
  assert.equal(normalized.budgets.maxPublicPages, 10);
  assert.equal(normalized.budgets.maxSearchRequests, 1);
  assert.throws(() => normalizeProspectingRequest({ ...request(), targetCount: 11 }), /between 1 and 10/);
  assert.throws(() => normalizeProspectingRequest({ ...request(), city: 'person@example.com' }), /public business category/);
  assert.throws(() => normalizeProspectingRequest({ ...request(), sourceRights: { ...request().sourceRights, robotsAllowed: false } }), /Confirm permitted public use/);
});

test('mock workflow collects business sites, measures site evidence, quarantines a directory, and keeps contact/campaign stages held', async () => {
  const payload = normalizeProspectingRequest(request());
  const { persistence, data } = makePersistence(payload);
  const sourceWorkflow = mockWorkflow(candidates());
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'test-user', workerId: 'test-worker', sourceWorkflow });
  assert.equal(result.status, 'completed', `${JSON.stringify(result)} calls=${JSON.stringify(data.calls)}`);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.collectedCount, 2);
  assert.equal(result.qualifiedCount, 1, JSON.stringify({ outcomes: data.outcomes.map(row => row.outcome), evidence: data.evidence.map(row => row.evidence.measuredSignals) }));
  assert.equal(result.quarantinedCount, 1);
  assert.equal(sourceWorkflow.network.length, 3, 'one search and two bounded mock website fetches');
  assert.deepEqual(sourceWorkflow.http.map(item => item.operation), ['search', 'robots', 'page', 'robots', 'page'], 'the mock collector reserves each HTTP operation independently');
  assert.deepEqual(data.job.checkpoint.sourceRequestCounts, { search: 1, robots: 2, page: 2 });
  assert.equal(data.job.checkpoint.sourceRequestReservations.length, 5);
  assert.equal(data.contacts.length, 1);
  assert.equal(data.contacts[0].qualification.status, 'qualified');
  assert.equal(data.contacts[0].qualification.decision, 'website_evidence_rules_v1');
  assert.equal(data.contacts[0].contact.email, null);
  assert.deepEqual(data.contacts[0].contact.emailCandidates.map(item => item.verificationStatus), ['unknown']);
  assert.equal(data.evidence.filter(item => item.evidence.kind === 'public_search_result').length, 2);
  const siteEvidence = data.evidence.filter(item => item.evidence.kind === 'business_website_page');
  assert.equal(siteEvidence.length, 2);
  assert.equal(siteEvidence.find(item => item.evidence.canonicalDomain === 'directory.example').evidence.businessIdentityMatchesDomain, false);
  assert.equal(data.outcomes.filter(item => item.outcome.type === 'prospecting.evidence_qualified').length, 1);
  assert.equal(data.outcomes.find(item => item.outcome.type === 'campaign.preparation_blocked').outcome.code, 'BLOCKED_NEEDS_APPROVED_OFFER');
  assert.equal(data.outcomes.find(item => item.outcome.type === 'prospecting.pipeline_completed').outcome.campaignPreparation, 'BLOCKED_NEEDS_APPROVED_OFFER');
  assert.equal(data.job.state, 'completed');
});

test('pause after a page reservation resumes that exact queued fetch instead of self-deduping', async () => {
  let pausedOnce = false;
  const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }), {
    async afterCheckpoint(jobData, input) {
      if (!pausedOnce && input.checkpoint.pageReservations?.some(item => item.fetchJobId)) {
        pausedOnce = true;
        jobData.job = { ...jobData.job, state: 'paused', version: jobData.job.version + 1 };
      }
    },
  });
  const sourceWorkflow = mockWorkflow(candidates().slice(0, 1));
  const first = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', workerId: 'worker-1', sourceWorkflow });
  assert.equal(first.status, 'paused');
  const savedReservation = data.job.checkpoint.pageReservations[0];
  assert.equal(savedReservation.fetchJobId, 'fetch-1');
  assert.deepEqual(sourceWorkflow.network, ['search-job']);
  data.job = { ...data.job, state: 'queued', version: data.job.version + 1 };
  const resumed = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', workerId: 'worker-2', sourceWorkflow });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(sourceWorkflow.network, ['search-job', 'fetch-1']);
  assert.equal(sourceWorkflow.http.some(item => item.jobId === savedReservation.fetchJobId && item.operation === 'page'), true);
  assert.equal(data.outcomes.some(row => row.outcome.reasons?.includes('duplicate_canonical_domain_candidate')), false);
  assert.deepEqual(data.job.checkpoint.sourceRequestCounts, { search: 1, robots: 1, page: 1 });
});

test('in-memory Mongo handover keeps running search and fetch attempts pending until one durable outcome is consumed', async () => {
  const candidate = candidates()[0];
  const sanitizedSnippet = candidate.snippet.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted email]');
  const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
  data.job.checkpoint = { searchJobId: 'search-job', phase: 'search_setup', processedCandidateDomains: ['acme-design.example'],
    pageReservations: [{ candidateKey: createHash('sha256').update(JSON.stringify({ sourceUrl: candidate.sourceUrl,
      contentSha256: createHash('sha256').update(JSON.stringify({ title: candidate.title, sourceUrl: candidate.sourceUrl,
        snippet: sanitizedSnippet, engine: candidate.engine || '' })).digest('hex') })).digest('hex'),
      url: candidate.sourceUrl, fetchJobId: '33333333-3333-4333-8333-333333333333', status: 'reserved', requestReserved: true }] };
  const searchJob = { id: 'search-job', jobType: 'search', status: 'completed', candidates: [candidate] };
  const fetchJob = { id: '33333333-3333-4333-8333-333333333333', jobType: 'fetch', status: 'running', candidate };
  const successor = { id: null, jobType: 'fetch', status: 'queued', candidate,
    evidenceId: '55555555-5555-4555-8555-555555555555' };
  let searchReads = 0, fetchReads = 0, successorCreates = 0, httpRequests = 0;
  const workflow = {
    async createSearchJob() { assert.fail('saved running search must be reused'); },
    async createFetchJob() { assert.fail('saved running fetch must be reused'); },
    async readJob({ jobId }) { if (jobId === searchJob.id) { searchReads += 1; return searchJob; }
      if (jobId === fetchJob.id) { fetchReads += 1; return fetchJob; } return successor; },
    async createRetrySuccessor(input) {
      successorCreates += 1;
      data.calls.push(`successor:${input.predecessorJobId}:${fetchJob.latestRun?.outcome?.retrySafe}`);
      successor.id = input.successorJobId;
      return successor;
    },
    async runJob({ jobId }) { assert.equal(jobId, successor.id); httpRequests += 1; successor.status = 'completed'; return successor; },
    async readWebsite({ sourceJob }) { assert.equal(sourceJob.id, successor.id); return workflow.readWebsiteResult; },
  };
  workflow.readWebsiteResult = await mockWorkflow([candidate]).readWebsite({ sourceJob: { id: 'fetch-1', candidate }, candidate });

  // The second parent sees the source lease in flight. It waits without running
  // the SQL job, then returns a visible, durable pending status at the bound.
  let firstWaits = 0;
  const waiting = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow: workflow,
    sourceWaitMs: 1, wait: async () => { firstWaits += 1; } });
  assert.equal(waiting.status, 'waiting_for_source', JSON.stringify({ waiting, calls: data.calls }));
  assert.equal(data.job.state, 'running');
  assert.equal(data.job.checkpoint.pageReservations[0].fetchJobId, fetchJob.id);
  assert.equal(data.job.checkpoint.pageReservations[0].requestReserved, true);
  assert.equal(data.job.checkpoint.pendingSourceJobId, fetchJob.id);
  assert.equal(httpRequests, 0);
  assert.ok(firstWaits <= 1, 'an already exhausted bounded wait performs no more than one bounded poll');

  // The original source worker safely records terminal no-reservation proof;
  // a fresh parent fence consumes it once through the deterministic successor.
  fetchJob.status = 'failed';
  fetchJob.latestRun = { id: '55555555-5555-4555-8555-555555555555', outcome: { status: 'deferred', retrySafe: true, errorCode: 'lease_lost',
    transportAttempted: false, dnsAttempted: false, requestReservationAttempted: false } };
  const resumed = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow: workflow });
  assert.equal(resumed.status, 'completed', JSON.stringify({ resumed, calls: data.calls }));
  assert.equal(successorCreates, 1);
  assert.equal(httpRequests, 1, 'the successor performs exactly one mock HTTP path');
  assert.equal(data.job.checkpoint.pageReservations[0].predecessorFetchJobId, fetchJob.id);
  assert.equal(data.job.checkpoint.pageReservations[0].fetchJobId, successor.id);
  assert.equal(searchReads, 2, 'the same completed candidate list is read without rerunning the pending search');
  assert.equal(fetchReads, 2 + firstWaits,
    'the fetch is read on each parent fence plus each actual bounded poll; an elapsed deadline may skip that poll');
});

test('in-memory Mongo consumes a fetch that completes during bounded waiting without repeating HTTP', async () => {
  const candidate = candidates()[0];
  const { persistence } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
  const sourceWorkflow = mockWorkflow([candidate]);
  const runQueued = sourceWorkflow.runJob.bind(sourceWorkflow);
  await runQueued({ jobId: 'search-job' });
  sourceWorkflow.runJob = async ({ jobId }) => {
    assert.equal(jobId, 'fetch-1');
    sourceWorkflow.network.push(jobId);
    const job = await sourceWorkflow.readJob({ jobId });
    job.status = 'running';
    return job;
  };
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow,
    sourceWaitMs: 1000, wait: async () => { const fetch = await sourceWorkflow.readJob({ jobId: 'fetch-1' }); fetch.status = 'completed'; } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(sourceWorkflow.network, ['search-job', 'fetch-1']);
  assert.deepEqual(sourceWorkflow.http.map(item => item.operation), ['search'],
    'the running fetch is not redispatched when its original worker completes');
  assert.equal(sourceWorkflow.fetchCreates.length, 1);
});

test('in-memory Mongo running search waits for completion and pause or cancel interrupts source polling', async () => {
  const searchCandidate = candidates()[0];
  const searchFixture = mockWorkflow([searchCandidate]);
  const searchPending = await searchFixture.readJob({ jobId: 'search-job' });
  searchPending.status = 'running';
  searchPending.candidates = [searchCandidate];
  const searchMongo = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
  let sourcePolls = 0;
  const searchResumed = await runAstraProspectingOnce({ persistence: searchMongo.persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow: searchFixture,
    sourceWaitMs: 1000, wait: async () => { sourcePolls += 1; searchPending.status = 'completed'; } });
  assert.equal(searchResumed.status, 'completed', JSON.stringify(searchResumed));
  assert.equal(sourcePolls, 1);
  assert.deepEqual(searchFixture.network, ['fetch-1'], 'the pending search is consumed after completion without duplicate provider dispatch');
  assert.deepEqual(searchFixture.http.map(item => item.operation), ['robots', 'page']);

  for (const terminalState of ['paused', 'cancelled', 'version-stale']) {
    const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
    const search = { id: 'search-pending', jobType: 'search', status: 'running' };
    data.job.checkpoint = { searchJobId: search.id };
    const workflow = { async createSearchJob() { assert.fail('saved search must be reused'); }, async createFetchJob() { assert.fail(); },
      async readJob() { return search; }, async runJob() { assert.fail('a running search is never reclaimed by the parent'); },
      async readWebsite() { assert.fail(); } };
    let reads = 0;
    const pending = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow: workflow,
      sourceWaitMs: 0, wait: async () => { reads += 1; } });
    assert.equal(pending.status, 'waiting_for_source', JSON.stringify({ pending, calls: data.calls, checkpoint: data.job.checkpoint }));
    assert.equal(data.job.state, 'running');
    assert.equal(data.job.checkpoint.pendingSourceJobId, search.id);
    assert.equal(reads, 0);

    const next = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
    next.data.job.checkpoint = { searchJobId: search.id };
    const controlled = { ...workflow, async readJob() { return search; } };
    const interrupted = await runAstraProspectingOnce({ persistence: next.persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow: controlled,
      sourceWaitMs: 1000, wait: async () => { next.data.job = { ...next.data.job,
        state: terminalState === 'version-stale' ? 'running' : terminalState, version: next.data.job.version + 1 }; } });
    assert.equal(interrupted.status, terminalState === 'version-stale' ? 'stale' : terminalState,
      `${terminalState} must remain an honored customer control or fence`);
    assert.equal(next.data.job.state, terminalState === 'version-stale' ? 'running' : terminalState);
  }
});

test('resume with an incomplete source-job creation intent holds instead of creating an untracked duplicate', async () => {
  let pausedOnce = false;
  const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }), {
    async afterCheckpoint(jobData, input) {
      if (!pausedOnce && input.checkpoint.pageReservations?.some(item => !item.fetchJobId)) {
        pausedOnce = true;
        jobData.job = { ...jobData.job, state: 'paused', version: jobData.job.version + 1 };
      }
    },
  });
  const sourceWorkflow = mockWorkflow(candidates().slice(0, 1));
  const first = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', workerId: 'worker-1', sourceWorkflow });
  assert.equal(first.status, 'paused');
  assert.deepEqual(sourceWorkflow.fetchCreates, [], 'intent is durable before source-job creation');
  data.job = { ...data.job, state: 'queued', version: data.job.version + 1 };
  const resumed = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', workerId: 'worker-2', sourceWorkflow });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(sourceWorkflow.fetchCreates, [], 'resume holds uncertain intent instead of creating another source job');
  assert.ok(data.outcomes.some(row => row.outcome.reasons?.includes('website_fetch_outcome_unknown_after_restart')));
});

test('uncertain successor commit keeps the Mongo parent intent but never starts HTTP or creates a new source job', async () => {
  const candidate = { title: 'Synthetic design studio', sourceUrl: 'https://synthetic.example/about',
    canonicalDomain: 'synthetic.example', snippet: 'Synthetic studio', engine: 'fixture' };
  const sourceHash = createHash('sha256').update(JSON.stringify({ title: candidate.title, sourceUrl: candidate.sourceUrl,
    snippet: candidate.snippet || '', engine: candidate.engine || '' })).digest('hex');
  const candidateKey = createHash('sha256').update(JSON.stringify({ sourceUrl: candidate.sourceUrl, contentSha256: sourceHash })).digest('hex');
  const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
  data.job.checkpoint = { searchJobId: 'search-fixture', processedCandidateDomains: ['synthetic.example'],
    pageReservations: [{ candidateKey, url: candidate.sourceUrl, fetchJobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'reserved', requestReserved: true }] };
  const oldSource = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', jobType: 'fetch', status: 'failed', errorCode: 'job_paused', latestRun: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outcome: { status: 'deferred', retrySafe: true, errorCode: 'job_paused',
      transportAttempted: false, dnsAttempted: false, requestReservationAttempted: false },
  } };
  let successorWrites = 0, dispatches = 0;
  const sourceWorkflow = {
    async createSearchJob() { assert.fail('saved search must be used'); },
    async createFetchJob() { assert.fail('intent recovery cannot create a new unrelated source job'); },
    async readJob({ jobId }) { return jobId === 'search-fixture' ? { id: jobId, jobType: 'search', status: 'completed', candidates: [candidate] } : oldSource; },
    async createRetrySuccessor(input) {
      assert.equal(input.predecessorJobId, oldSource.id);
      successorWrites += 1;
      throw Object.assign(new Error('successor transaction acknowledgment unknown'), {
        code: 'uncertain_commit', commitState: 'unknown', reconciliationRequired: true,
      });
    },
    async runJob() { dispatches += 1; assert.fail('no request may follow unresolved successor persistence'); },
    async readWebsite() { assert.fail('no page was fetched'); },
  };
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow });
  assert.equal(result.status, 'uncertain', JSON.stringify({ result, candidateKey, checkpoint: data.job.checkpoint, calls: data.calls }));
  assert.equal(result.reconciliationRequired, true);
  assert.equal(successorWrites, 2, 'commit uncertainty is reconciled with one stable deterministic identity then bounded');
  assert.equal(dispatches, 0);
  assert.equal(data.job.state, 'running');
  assert.equal(data.job.checkpoint.pageReservations[0].retryIntent.predecessorJobId, oldSource.id);
  assert.equal(data.job.checkpoint.pageReservations[0].retryIntent.successorJobId.length, 36);
  assert.equal(data.calls.some(call => String(call).startsWith('transition:fail')), false);
});

test('an existing per-request reservation blocks duplicate dispatch and stops later collection work', async () => {
  const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
  const sourceWorkflow = mockWorkflow(candidates().slice(0, 1));
  sourceWorkflow.runJob = async ({ jobId, beforeRequest, reserveRequest }) => {
    await beforeRequest();
    await reserveRequest({ operation: 'search', sourceJobId: jobId });
    sourceWorkflow.http.push({ operation: 'search', jobId });
    await reserveRequest({ operation: 'search', sourceJobId: jobId });
  };
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'owner', sourceWorkflow });
  assert.equal(result.status, 'failed');
  assert.equal(result.job.reason.code, 'source_request_outcome_uncertain');
  assert.deepEqual(sourceWorkflow.http.map(item => item.operation), ['search'], 'the duplicate request and all later site collection were blocked');
  assert.equal(data.job.checkpoint.sourceRequestCounts.search, 1);
  assert.equal(data.job.state, 'failed');
});

test('negated and market-level opportunity statements remain quarantined', async t => {
  for (const [name, paragraph] of [
    ['negated', 'Acme Design Studio in Toronto, Canada, is not hiring right now.'],
    ['third-party', 'Acme Design Studio in Toronto, Canada notes that other design studios are hiring this month.'],
    ['market-level', 'Acme Design Studio in Toronto, Canada sees the market shift; design studios are hiring this month.'],
    ['heading-only identity', 'Toronto, Canada design studios are hiring this month.'],
  ]) {
    await t.test(name, async () => {
      const rows = candidates().slice(0, 1);
      const candidate = rows[0];
      candidate.site = site(`<html><head><title>Acme Design Studio</title></head><body><h1>Acme Design Studio</h1><p>${paragraph}</p></body></html>`, candidate.sourceUrl, candidate);
      const { persistence, data } = makePersistence(normalizeProspectingRequest({ ...request(), targetCount: 1 }));
      const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'test-user', sourceWorkflow: mockWorkflow(rows) });
      assert.equal(result.status, 'completed');
      assert.equal(data.contacts.length, 0, 'unrelated or negated signals cannot create a qualified business');
      const evidence = data.evidence.find(row => row.evidence.kind === 'business_website_page');
      assert.equal(evidence.evidence.measuredSignals.opportunity, null);
      assert.ok(data.outcomes.some(row => row.outcome.type === 'prospecting.quarantined'));
    });
  }
});

test('unresolved checkpoint commit stops before search dispatch and leaves the job state untouched', async () => {
  const { persistence, data } = makePersistence(normalizeProspectingRequest(request()), { checkpointError: { count: 2 } });
  let searchCreates = 0;
  const workflow = mockWorkflow(candidates()); workflow.createSearchJob = async () => { searchCreates += 1; throw new Error('must not dispatch after unresolved write'); };
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'test-user', sourceWorkflow: workflow });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.commitState, 'unknown');
  assert.equal(data.job.state, 'running');
  assert.equal(searchCreates, 0);
  assert.equal(data.outcomes.some(row => row.outcome.type === 'prospecting.failed'), false);
  assert.equal(data.calls.some(call => call === 'transition:fail'), false);
});

test('uncertain evidence write is reconciled with the exact idempotency key before continuing', async () => {
  const { persistence, data } = makePersistence(normalizeProspectingRequest(request()), { evidenceError: { count: 1 } });
  const sourceWorkflow = mockWorkflow(candidates());
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'test-user', sourceWorkflow });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const attempts = data.calls.filter(call => call.startsWith('evidence:1:search-candidate:'));
  assert.equal(attempts.length, 3, 'first candidate write is retried once, then the second candidate is written once');
  assert.equal(attempts[0], attempts[1], 'same repository method and idempotency key used for reconciliation');
  assert.notEqual(attempts[1], attempts[2]);
  assert.equal(data.evidence.length, 4);
  assert.equal(data.outcomes.some(row => row.outcome.type === 'prospecting.failed'), false);
});

test('claim callback registers pause control before the first checkpoint and collection', async () => {
  const { persistence, data } = makePersistence(normalizeProspectingRequest(request()));
  const controller = new AbortController(); let sourceCalls = 0;
  const workflow = mockWorkflow(candidates()); workflow.createSearchJob = async () => { sourceCalls += 1; throw new Error('collection must not begin'); };
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'test-user', sourceWorkflow: workflow, signal: controller.signal, onClaim() {
    data.job = { ...data.job, state: 'paused', version: data.job.version + 1 }; controller.abort();
  } });
  assert.equal(result.status, 'paused');
  assert.equal(sourceCalls, 0);
  assert.equal(workflow.network.length, 0);
});

test('persisted ten-page reservation budget survives a later worker claim without resetting', async () => {
  const { persistence, data } = makePersistence(normalizeProspectingRequest(request()));
  data.job.checkpoint = { pageReservations: Array.from({ length: 10 }, (_, index) => ({ candidateKey: `reserved-${index}`, fetchJobId: `fetch-${index}`, status: 'reserved' })) };
  const workflow = mockWorkflow(candidates().slice(0, 1));
  const result = await runAstraProspectingOnce({ persistence, tenantId: TENANT, userId: 'test-user', sourceWorkflow: workflow });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(workflow.network, ['search-job'], 'only the search stage ran; existing page reservations exhausted the saved budget');
  assert.equal(data.job.checkpoint.pageReservations.length, 10);
  assert.equal(data.contacts.length, 0);
  assert.equal(data.outcomes.some(item => item.outcome.reasons?.includes('public_page_budget_exhausted')), true);
});

test('disabled integration reports a blocker without constructing MongoDB', async () => {
  let constructed = false;
  const service = createAstraProspectingService({ env: {}, persistenceFactory() { constructed = true; throw new Error('must not be called'); } });
  const status = await service.status();
  assert.equal(status.ready, false);
  assert.match(status.reason, /coordinator approval/);
  await assert.rejects(service.create({ tenantId: TENANT, payload: request(), idempotencyKey: 'test' }), /coordinator approval/);
  assert.equal(constructed, false);
});

test('prospecting readiness accepts only the exact local-search opt-in and origin while retaining coordinator, Mongo and worker gates', async () => {
  const baseEnv = {
    ASTRA_LIVE_PROSPECTING_GO: 'true', ASTRA_PERSISTENCE_BACKEND: 'mongodb', ASTRA_INTEGRATION_MODE: 'prospecting-test',
    MONGODB_URI: 'mongodb://mock.invalid', MONGODB_DATABASE: 'astra_test_mock', ASTRA_MONGODB_TEST_DATABASES: 'astra_test_mock',
    ASTRA_WORKER_DATABASE_URL: 'postgres://mock.invalid', ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED: 'false',
  };
  const closedWorkflow = { async close() {} };
  const exactLocal = createAstraProspectingService({ env: { ...baseEnv,
    ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8081' },
  sourceWorkflow: closedWorkflow, persistenceFactory: () => { throw new Error('readiness must not connect to Mongo'); } });
  const ready = await exactLocal.status();
  assert.equal(ready.ready, true);
  assert.equal(ready.storageState, 'not_checked');
  assert.equal(ready.releaseReady, false);

  for (const invalid of [
    { ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'yes', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8081' },
    { ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8082', ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED: 'true' },
    { ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://localhost:8081', ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED: 'true' },
    { ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'false', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8081', ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED: 'true' },
  ]) {
    const service = createAstraProspectingService({ env: { ...baseEnv, ...invalid }, sourceWorkflow: closedWorkflow,
      persistenceFactory: () => { throw new Error('invalid local settings must fail before Mongo construction'); } });
    const status = await service.status();
    assert.equal(status.ready, false);
    assert.match(status.reason, /local search opt-in or pinned origin is invalid|approved public search service is not configured/);
  }

  const missingWorker = createAstraProspectingService({ env: { ...baseEnv,
    ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'http://127.0.0.1:8081',
    ASTRA_WORKER_DATABASE_URL: '' }, sourceWorkflow: closedWorkflow });
  const workerStatus = await missingWorker.status();
  assert.equal(workerStatus.ready, false);
  assert.match(workerStatus.reason, /dedicated source worker/);
});

test('late-committed Mongo create is replayed with the same request key and returns the queued job', async () => {
  const calls = []; let committed = false;
  const env = { ASTRA_LIVE_PROSPECTING_GO: 'true', ASTRA_PERSISTENCE_BACKEND: 'mongodb', ASTRA_INTEGRATION_MODE: 'prospecting-test',
    MONGODB_URI: 'mongodb://mock.invalid', MONGODB_DATABASE: 'astra_test_mock', ASTRA_MONGODB_TEST_DATABASES: 'astra_test_mock',
    ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED: 'true', ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN: 'https://search.example', ASTRA_WORKER_DATABASE_URL: 'postgres://mock.invalid' };
  const persistence = { backend: 'mongodb', async connect() {}, async health() { return { ready: true }; }, forTenant() { return { jobs: { async create(input) {
    calls.push(input);
    if (!committed) { committed = true; throw Object.assign(new Error('sanitized'), { code: 'transaction_commit_late', commitState: 'committed', reconciliationRequired: true }); }
    return { job: { id: JOB, state: 'queued' }, replayed: true };
  } } }; }, async close() {} };
  const service = createAstraProspectingService({ env, persistenceFactory: () => persistence });
  const result = await service.create({ tenantId: TENANT, payload: normalizeProspectingRequest(request()), idempotencyKey: 'late-create-stable-key' });
  assert.equal(result.job.state, 'queued');
  assert.equal(result.replayed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey);
  assert.deepEqual(calls[0], calls[1]);
});

test('prospecting route gives reads to reviewers, only owners may start, and controls retain writer roles', () => {
  const routes = []; registerAstraProspectingRoutes(route => routes.push(route), { service: { status: async () => ({ ready: false, reason: 'blocked' }) } });
  assert.ok(routes.some(route => route.method === 'GET' && route.path.test(`/api/astra/tenants/${TENANT}/prospecting/status`) && route.allowedRoles.includes('reviewer')));
  assert.ok(routes.some(route => route.method === 'POST' && route.path.test(`/api/astra/tenants/${TENANT}/prospecting/jobs`) && route.allowedRoles.join(',') === 'owner'));
  const controls = routes.find(route => route.method === 'POST' && route.path.source.includes('actions'));
  assert.deepEqual(controls.allowedRoles, ['owner', 'admin', 'operator']);
});

test('route rejects operator start and schedules same-key replay for a committed queued job after commit', async () => {
  const calls = [];
  const service = { async create(input) { calls.push(['create', input]); return { job: { id: JOB, state: 'queued' }, replayed: true }; }, async runOnce(input) { calls.push(['run', input]); } };
  const routes = []; registerAstraProspectingRoutes(route => routes.push(route), { service });
  const start = routes.find(route => route.method === 'POST' && route.path.test(`/api/astra/tenants/${TENANT}/prospecting/jobs`));
  const context = { params: { tenantId: TENANT }, readJson: async () => request(), afterCommit: callback => { context.callback = callback; } };
  for (const tenantRole of ['admin', 'operator']) {
    const denied = await start.handler({ headers: { 'idempotency-key': 'same-key' } }, null, { ...context, actor: { tenantId: TENANT, userId: 'u1', tenantRole } });
    assert.equal(denied.status, 403, `${tenantRole} cannot start prospecting`);
  }
  assert.equal(calls.length, 0);
  const owner = await start.handler({ headers: { 'idempotency-key': 'same-key' } }, null, { ...context, actor: { tenantId: TENANT, userId: 'owner1', tenantRole: 'owner' } });
  assert.equal(owner.status, 202);
  assert.equal(owner.body.replayed, true);
  assert.equal(typeof context.callback, 'function');
  await context.callback();
  assert.deepEqual(calls[1], ['run', { tenantId: TENANT, userId: 'owner1', jobId: JOB }]);
});

test('route exposes unknown Mongo commit state without scheduling another worker', async () => {
  const service = { async create() { throw Object.assign(new Error('private'), { name: 'AstraProspectingError', statusCode: 503, code: 'prospecting_reconciliation_required', publicMessage: 'A database write may have completed. Refresh before continuing.', reconciliationRequired: true, commitState: 'unknown' }); }, async runOnce() { assert.fail('unknown create is not dispatched'); } };
  const routes = []; registerAstraProspectingRoutes(route => routes.push(route), { service });
  const start = routes.find(route => route.method === 'POST' && route.path.test(`/api/astra/tenants/${TENANT}/prospecting/jobs`));
  let scheduled = false;
  const response = await start.handler({ headers: { 'idempotency-key': 'same-key' } }, null, { actor: { tenantId: TENANT, userId: 'owner1', tenantRole: 'owner' }, params: { tenantId: TENANT }, readJson: async () => request(), afterCommit: () => { scheduled = true; } });
  assert.equal(response.status, 503);
  assert.equal(response.body.reconciliationRequired, true);
  assert.equal(response.body.commitState, 'unknown');
  assert.doesNotMatch(response.body.error, /private/);
  assert.equal(scheduled, false);
});

