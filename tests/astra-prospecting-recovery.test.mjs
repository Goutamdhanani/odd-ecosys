import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';
import { createAstraTenantStore } from '../pipeline/astra-tenant-store.js';
import { createAstraSourceCollectionManager, deriveAstraSourceSuccessorId, runAstraSourceCollectionOnce } from '../pipeline/astra-source-collection.js';
import { normalizeProspectingRequest, runAstraProspectingOnce } from '../pipeline/astra-prospecting.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;

test('strict37 recovery creates one trusted tenant-scoped successor from a terminal no-transport attempt', {
  skip: fixtureInput ? false : 'Set ASTRA_QA_FIXTURE_PATH to the canonical strict37 disposable fixture.',
}, async () => {
  const fixture = await validateAstraR20Fixture({ root, fixturePath: path.resolve(fixtureInput) });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.realData, false);
  assert.equal(fixture.migrations.length, 37);
  const safeEnv = new Set(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'ASTRA_QA_FIXTURE_PATH']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  await import('./support/astra-qa-egress-guard.mjs');

  process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED = 'true';
  process.env.ASTRA_SOURCE_COLLECTION_APPROVALS_JSON = JSON.stringify({ approvals: [
    { status: 'approved', decisionId: 'source.public-websites', reference: 'fixture://synthetic-public-site',
      evidenceSha256: 'b'.repeat(64), scope: 'synthetic.example', expiresAt: '2099-01-01T00:00:00.000Z' },
    { status: 'approved', decisionId: 'glm.input-processing-and-data-protection', reference: 'fixture://synthetic-data-processing',
      evidenceSha256: 'c'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
  ] });

  const appStore = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
  const workerStore = createAstraTenantStore({ connectionString: fixture.workerConnectionString, contextSecret: fixture.contextSecret });
  const userId = `9${randomUUID().replace(/\D/g, '')}`;
  const foreignUserId = `8${randomUUID().replace(/\D/g, '')}`;
  const logicalJobId = randomUUID();
  const candidate = { title: 'Synthetic design studio', sourceUrl: 'https://synthetic.example/about', canonicalDomain: 'synthetic.example', snippet: 'Synthetic studio', engine: 'fixture' };
  const candidateDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const candidateHash = candidateDigest({ title: candidate.title, sourceUrl: candidate.sourceUrl, snippet: candidate.snippet, engine: candidate.engine });
  const candidateKey = candidateDigest({ sourceUrl: candidate.sourceUrl, contentSha256: candidateHash });
  const now = new Date().toISOString();
  const sourceRights = { rightsPolicy: 'public_terms_permitted', rightsAttested: true,
    rightsEvidenceReference: 'fixture://terms-reviewed', robotsAllowed: true, robotsEvidenceReference: 'fixture://robots-reviewed',
    rightsReviewedAt: now, rightsExpiresAt: '2099-01-01T00:00:00.000Z' };
  let tenant, foreignTenant, original, terminal, successorId;
  const actorFor = tenantId => ({ tenantId, userId });
  try {
    tenant = await appStore.createTenant({ name: `Synthetic prospecting recovery ${randomUUID()}`, userId });
    foreignTenant = await appStore.createTenant({ name: `Synthetic foreign recovery ${randomUUID()}`, userId: foreignUserId });
    const actor = actorFor(tenant.tenantId);
    original = await appStore.withTenant(actor, db => createAstraSourceCollectionManager(db).createFetchJob(actor, {
      sourceUrl: candidate.sourceUrl, sourceRights, approvalMode: 'server',
    }));
    let dispatches = 0, reservations = 0;
    terminal = await runAstraSourceCollectionOnce({ store: workerStore, tenantId: tenant.tenantId, userId, jobId: original.id,
      beforeRequest: async () => {}, reserveRequest: async () => { reservations += 1; },
      withRequestAdmission: async context => {
        await context.beforeRequest(); // models completion of the shared-lock wait
        throw Object.assign(new Error('synthetic parent pause after admission'), { code: 'job_paused' });
      } });
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.deferred, true);
    assert.equal(dispatches, 0);
    assert.equal(reservations, 0);
    const readJob = jobId => workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).getJob(tenant.tenantId, jobId));
    const prior = await readJob(original.id);
    assert.equal(prior.status, 'failed');
    assert.equal(prior.latestRun.outcome.status, 'deferred');
    assert.equal(prior.latestRun.outcome.retrySafe, true);
    assert.equal(prior.latestRun.outcome.transportAttempted, false);
    assert.equal(prior.latestRun.outcome.dnsAttempted, false);
    assert.equal(prior.latestRun.outcome.requestReservationAttempted, false);

    successorId = deriveAstraSourceSuccessorId({ tenantId: tenant.tenantId, sourceJobId: original.id,
      sourceRunId: prior.latestRun.id, logicalJobId, candidateKey });
    const create = () => workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).createRetrySuccessor({
      tenantId: tenant.tenantId, logicalJobId, candidateKey, sourceJobId: original.id,
      sourceRunId: prior.latestRun.id, successorJobId: successorId,
    }));
    const created = await create();
    const replay = await create();
    assert.equal(created.id, successorId);
    assert.equal(created.status, 'queued');
    assert.equal(created.retryLineage.logicalJobId, logicalJobId);
    assert.equal(created.retryLineage.candidateKey, candidateKey);
    assert.equal(replay.id, successorId);
    assert.equal(replay.replayed, true, 'lost acknowledgement resolves to the same immutable successor');
    const jobs = await workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).listJobs(tenant.tenantId, { limit: 100 }));
    assert.equal(jobs.filter(row => row.id === original.id || row.id === successorId).length, 2,
      'one old terminal job and one queued successor remain; duplicate creation adds no SQL attempt');
    assert.equal((await readJob(original.id)).latestRun.id, prior.latestRun.id,
      'the original run binding and provenance remain immutable');

    // Exercise the actual parent worker's crash/restart checkpoint protocol.
    // The parent remains one Mongo-style job while the native PostgreSQL source
    // pointer advances from the failed attempt to its queued successor.
    let parentVersion = 1, parentFence = 0, runJobCalls = 0;
    const parentJob = { id: logicalJobId, tenantId: tenant.tenantId, userId, state: 'queued', version: parentVersion,
      payload: normalizeProspectingRequest({ category: 'design studios', country: 'Canada', city: 'Toronto',
        goal: 'Find studios with a current expansion signal', targetCount: 1,
        sourceRights: { rightsEvidenceReference: 'terms reviewed', robotsEvidenceReference: 'robots reviewed',
          rightsExpiresAt: '2099-01-01T00:00:00.000Z', rightsAttested: true, robotsAllowed: true } }),
      checkpoint: { searchJobId: 'search-synthetic', phase: 'website_collection', processedCandidateDomains: ['synthetic.example'],
        pageReservations: [{ candidateKey, url: candidate.sourceUrl, fetchJobId: original.id, status: 'reserved', requestReserved: true }] } };
    const parentPersistence = { backend: 'mongodb', forTenant() {
      return {
        jobs: {
          async claim() { parentFence += 1; parentJob.state = 'running'; parentJob.version = ++parentVersion; return { job: { ...parentJob, checkpoint: { ...parentJob.checkpoint } }, lease: { owner: 'fixture', fence: parentFence, version: parentJob.version } }; },
          async checkpoint(_id, input) {
            parentJob.checkpoint = input.checkpoint; parentJob.version = ++parentVersion;
            if (parentJob.checkpoint.pageReservations?.some(item => item.fetchJobId === successorId)) parentAbort?.abort();
            return { job: { ...parentJob, checkpoint: { ...parentJob.checkpoint } } };
          },
          async get() { return { ...parentJob, checkpoint: { ...parentJob.checkpoint } }; },
          async transition(_id, input) { parentJob.state = input.action === 'complete' ? 'completed' : input.action === 'pause' ? 'paused' : 'failed'; parentJob.version = ++parentVersion; return { job: { ...parentJob } }; },
        },
        evidence: { async record(input) { return { evidence: { id: randomUUID(), ...input } }; } },
        outcomes: { async append(input) { return { outcome: input }; } },
        contacts: { async qualify() { assert.fail('A paused retry must not qualify a contact.'); } },
      };
    } };
    const sourceWorkflow = {
      async createSearchJob() { assert.fail("The same parent's saved search job must be reused."); },
      async createFetchJob() { assert.fail('A retry successor must not be replaced by an unrelated fetch job.'); },
      async readJob({ jobId }) { return jobId === 'search-synthetic' ? { id: jobId, jobType: 'search', status: 'completed', candidates: [candidate] } : readJob(jobId); },
      async createRetrySuccessor(input) { return workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).createRetrySuccessor({
        tenantId: tenant.tenantId, logicalJobId: input.logicalJobId, candidateKey: input.candidateKey,
        sourceJobId: input.predecessorJobId, sourceRunId: input.predecessorRunId, successorJobId: input.successorJobId,
      })); },
      async runJob() { runJobCalls += 1; assert.fail('The parent pause must happen before source admission or transport.'); },
      async readWebsite() { assert.fail('No page was fetched.'); },
    };
    const parentAbort = new AbortController();
    const firstResume = await runAstraProspectingOnce({ persistence: parentPersistence, tenantId: tenant.tenantId, userId,
      workerId: 'native-recovery-parent-worker-1', sourceWorkflow, signal: parentAbort.signal,
      onClaim: ({ job }) => assert.equal(job.id, logicalJobId),
    });
    assert.equal(firstResume.status, 'stale');
    assert.equal(parentJob.id, logicalJobId);
    assert.equal(parentJob.checkpoint.pageReservations[0].fetchJobId, successorId);
    assert.equal(parentJob.checkpoint.pageReservations[0].predecessorFetchJobId, original.id);
    assert.equal((await readJob(successorId)).status, 'queued');
    assert.equal(runJobCalls, 0);
    parentJob.state = 'paused';
    parentJob.state = 'queued'; // synthetic operator resume of the same logical job
    const resumeAbort = new AbortController();
    const secondResume = await runAstraProspectingOnce({ persistence: parentPersistence, tenantId: tenant.tenantId, userId,
      workerId: 'native-recovery-parent-worker-2', sourceWorkflow, signal: resumeAbort.signal,
      onClaim: ({ job }) => { assert.equal(job.id, logicalJobId); resumeAbort.abort(); },
    });
    assert.equal(secondResume.status, 'stale');
    assert.equal((await readJob(successorId)).status, 'queued', 'resuming the same parent preserves the queued successor without a second source job');
    assert.equal(runJobCalls, 0);

    // Native strict33 SQL state: a real claimed source row stays running while
    // a second in-memory Mongo parent lease records a durable wait checkpoint.
    const inFlight = await appStore.withTenant(actor, db => createAstraSourceCollectionManager(db).createFetchJob(actor, {
      sourceUrl: candidate.sourceUrl, sourceRights, approvalMode: 'server',
    }));
    await workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).claim(tenant.tenantId, inFlight.id));
    let waitingParentVersion = 1;
    const waitingParent = { id: randomUUID(), tenantId: tenant.tenantId, userId,
      state: 'queued', version: waitingParentVersion,
      payload: normalizeProspectingRequest({ category: 'design studios', country: 'Canada', city: 'Toronto',
        goal: 'Find studios with a current expansion signal', targetCount: 1,
        sourceRights: { rightsEvidenceReference: 'terms reviewed', robotsEvidenceReference: 'robots reviewed',
          rightsExpiresAt: '2099-01-01T00:00:00.000Z', rightsAttested: true, robotsAllowed: true } }),
      checkpoint: { searchJobId: 'search-synthetic', phase: 'website_collection', processedCandidateDomains: ['synthetic.example'],
        pageReservations: [{ candidateKey, url: candidate.sourceUrl, fetchJobId: inFlight.id, status: 'reserved', requestReserved: true }] } };
    const waitingPersistence = { backend: 'mongodb', forTenant() { return { jobs: {
      async claim() { waitingParent.state = 'running'; waitingParent.version = ++waitingParentVersion;
        return { job: { ...waitingParent, checkpoint: { ...waitingParent.checkpoint } }, lease: { fence: 1, version: waitingParent.version, until: new Date(Date.now() + 30_000) } }; },
      async checkpoint(_id, input) { waitingParent.checkpoint = input.checkpoint; waitingParent.version = ++waitingParentVersion;
        return { job: { ...waitingParent, checkpoint: { ...waitingParent.checkpoint } } }; },
      async get() { return { ...waitingParent, checkpoint: { ...waitingParent.checkpoint } }; },
      async transition() { assert.fail('An in-flight source attempt must not terminally transition the parent.'); },
    }, evidence: { async record(input) { return { evidence: { id: randomUUID(), ...input } }; } },
    outcomes: { async append(input) { return { outcome: input }; } }, contacts: { async qualify() { assert.fail(); } } }; } };
    const waitingWorkflow = { async createSearchJob() { assert.fail('saved search is reused'); },
      async createFetchJob() { assert.fail('the in-flight SQL fetch is reused'); },
      async readJob({ jobId }) { if (jobId === 'search-synthetic') return { id: jobId, jobType: 'search', status: 'completed', candidates: [candidate] };
        return readJob(jobId); }, async runJob() { assert.fail('a running SQL source job is never reclaimed by the parent'); },
      async readWebsite() { assert.fail('in-flight source content is not readable yet'); } };
    const waitingResult = await runAstraProspectingOnce({ persistence: waitingPersistence, tenantId: tenant.tenantId, userId,
      workerId: 'native-inflight-parent-worker', sourceWorkflow: waitingWorkflow, sourceWaitMs: 0 });
    assert.equal(waitingResult.status, 'waiting_for_source');
    assert.equal(waitingParent.state, 'running');
    assert.equal(waitingParent.checkpoint.pageReservations[0].fetchJobId, inFlight.id);
    const stillRunning = await readJob(inFlight.id);
    assert.equal(stillRunning.status, 'running');
    assert.equal(stillRunning.latestRun.status, 'started');
    assert.equal(waitingResult.job.version, waitingParent.version);

    await assert.rejects(() => workerStore.withWorkerTenant({ tenantId: foreignTenant.tenantId, userId: foreignUserId }, db =>
      createAstraSourceCollectionManager(db).createRetrySuccessor({ tenantId: foreignTenant.tenantId, logicalJobId,
        candidateKey, sourceJobId: original.id, sourceRunId: prior.latestRun.id,
        successorJobId: deriveAstraSourceSuccessorId({ tenantId: foreignTenant.tenantId, sourceJobId: original.id,
          sourceRunId: prior.latestRun.id, logicalJobId, candidateKey }) })), error => error.code === 'source_successor_unavailable');
    await assert.rejects(() => workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).createRetrySuccessor({
      tenantId: tenant.tenantId, logicalJobId, candidateKey, sourceJobId: original.id,
      sourceRunId: prior.latestRun.id, successorJobId: randomUUID(),
    })), error => error.code === 'source_successor_invalid');

    for (const kind of ['cancelled', 'ambiguous-reservation', 'post-transport']) {
      const blockedJob = await appStore.withTenant(actor, db => createAstraSourceCollectionManager(db).createFetchJob(actor, {
        sourceUrl: `https://synthetic.example/${kind}`, sourceRights, approvalMode: 'server',
      }));
      const claim = await workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).claim(tenant.tenantId, blockedJob.id));
      const provenance = kind === 'cancelled'
        ? { transportAttempted: false, dnsAttempted: false, failureClass: 'job_cancelled' }
        : kind === 'ambiguous-reservation'
          ? { transportAttempted: false, dnsAttempted: false, requestReservationAttempted: true, failureClass: 'prospecting_reconciliation_required' }
          : { transportAttempted: true, dnsAttempted: true, requestReservationAttempted: true, failureClass: 'source_response_unavailable' };
      await workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).finish(tenant.tenantId, claim, {
        status: 'failed', errorCode: provenance.failureClass, provenance,
      }));
      const terminalJob = await workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).getJob(tenant.tenantId, blockedJob.id));
      const terminalRun = terminalJob.latestRun;
      const terminalSuccessorId = deriveAstraSourceSuccessorId({ tenantId: tenant.tenantId, sourceJobId: blockedJob.id,
        sourceRunId: terminalRun.id, logicalJobId, candidateKey: 'd'.repeat(64) });
      await assert.rejects(() => workerStore.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).createRetrySuccessor({
        tenantId: tenant.tenantId, logicalJobId, candidateKey: 'd'.repeat(64), sourceJobId: blockedJob.id,
        sourceRunId: terminalRun.id, successorJobId: terminalSuccessorId,
      })), error => error.code === 'source_request_outcome_uncertain', `${kind} cannot be replayed`);
    }
  } finally {
    await Promise.all([appStore.close(), workerStore.close()]);
  }
});
