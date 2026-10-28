import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAstraProspectingService, normalizeProspectingRequest, runAstraProspectingOnce } from '../pipeline/astra-prospecting.js';
import { inspectXrayPage } from '../pipeline/astra-xray.js';

const tenantId = '22222222-2222-4222-8222-222222222222';
const jobId = '11111111-1111-4111-8111-111111111111';
const accountId = '33333333-3333-4333-8333-333333333333';
const sourceEvidenceId = '44444444-4444-4444-8444-444444444444';
const quote = 'Our design studio in Toronto, Canada offers portfolio reviews through an online form.';

function fixture({ text = quote, providerLimit = 10 } = {}) {
  const payload = normalizeProspectingRequest({ category: 'design studios', country: 'Canada', city: 'Toronto',
    goal: 'Find businesses that could improve website enquiries', targetCount: 1,
    sourceRights: { rightsAttested: true, robotsAllowed: true, rightsEvidenceReference: 'synthetic fixture public rights',
      robotsEvidenceReference: 'synthetic fixture robots review', rightsExpiresAt: '2099-01-01T00:00:00.000Z' } });
  payload.budgets.maxProviderRequests = providerLimit;
  const candidate = { title: 'Acme Design Studio', sourceUrl: 'https://acme-design.example/', canonicalDomain: 'acme-design.example', snippet: 'Business website', engine: 'synthetic' };
  const html = `<title>Acme Design Studio</title><h1>Acme Design Studio</h1><p>${text}</p>`;
  const contentSha256 = createHash('sha256').update(html).digest('hex');
  const page = inspectXrayPage({ html, sourceUrl: candidate.sourceUrl, normalizedDomain: candidate.canonicalDomain });
  const data = { job: { id: jobId, tenantId, state: 'queued', version: 1, payload, checkpoint: {} },
    evidence: [], outcomes: [], contacts: [], claims: [], aiCalls: 0, crmReads: 0, failResultCheckpoint: false };
  let fence = 0;
  const tenant = {
    jobs: {
      async claim(input) { data.claims.push(input); if (input.jobId && input.jobId !== jobId) return null;
        data.job.state = 'running'; data.job.version++; return { job: structuredClone(data.job), lease: { fence: ++fence, until: new Date(Date.now() + 300_000) } }; },
      async get() { return structuredClone(data.job); },
      async checkpoint(_id, input) {
        if (data.failResultCheckpoint && input.idempotencyKey.includes(':research-result-')) {
          throw Object.assign(new Error('Synthetic unknown commit'), { code: 'uncertain_commit', reconciliationRequired: true });
        }
        assert.equal(input.expectedVersion, data.job.version);
        data.job.checkpoint = structuredClone(input.checkpoint); data.job.version++;
        return { job: structuredClone(data.job) };
      },
      async transition(_id, input) { data.job.state = input.action === 'complete' ? 'completed' : 'failed'; data.job.version++; return { job: structuredClone(data.job) }; },
    },
    evidence: { async record(input) { const old = data.evidence.find(item => item.sourceKey === input.sourceKey); if (old) return { evidence: old };
      const saved = { id: `evidence-${data.evidence.length + 1}`, ...input }; data.evidence.push(saved); return { evidence: saved }; } },
    outcomes: { async append(input) { data.outcomes.push(structuredClone(input)); return { outcome: input }; } },
    contacts: { async qualify(input) { assert.equal(input.qualification.crm.accountId, accountId);
      const row = { id: 'synthetic-contact', ...input }; data.contacts.push(row); return { contact: row }; } },
  };
  const sourceWorkflow = {
    async createSearchJob() { return { id: 'synthetic-search', status: 'completed', candidates: [candidate] }; },
    async createFetchJob() { return { id: 'synthetic-fetch', status: 'completed', evidenceId: sourceEvidenceId }; },
    async readJob({ jobId: sourceId }) { return sourceId === 'synthetic-search'
      ? { id: sourceId, status: 'completed', candidates: [candidate] } : { id: sourceId, status: 'completed', evidenceId: sourceEvidenceId }; },
    async runJob() { assert.fail('Synthetic snapshots require no source network requests'); },
    async readWebsite() { return { page, snapshotVerified: true, sourceEvidence: { sourceRightsUsable: true, sourceRightsStatus: 'permitted',
      contentSha256, capturedAt: '2026-10-27T00:00:00.000Z', sourceId: 'synthetic-source', rightsPolicy: 'synthetic_fixture' } }; },
    async resolveCrmAccount(input) { data.crmReads++; assert.equal(input.tenantId, tenantId); assert.equal(input.sourceEvidenceId, sourceEvidenceId);
      assert.equal(input.normalizedDomain, candidate.canonicalDomain); return { accountId, savedAt: '2026-10-27T00:00:00.000Z' }; },
  };
  const persistence = { backend: 'mongodb', forTenant(actor) { assert.equal(actor.tenantId, tenantId); return tenant; } };
  const researchWorkflow = { async analyze({ page: sourcePage, beforeRequest, onCheckpoint }) {
    data.aiCalls++;
    assert.equal(data.job.checkpoint.providerRequestsReserved, 1, 'Mongo request budget is durable before adapter entry');
    assert.equal(data.job.checkpoint.researchReservations[0].state, 'reserved_before_dispatch');
    await beforeRequest();
    await onCheckpoint({ state: 'post_sending', responseVerified: null });
    assert.equal(data.job.checkpoint.researchReservations[0].state, 'in_flight');
    assert.ok(sourcePage.visibleText.includes(text));
    return { status: 'completed', responseVerified: true, actualProvider: 'synthetic-fixture', actualModel: 'synthetic-fixture-model',
      usage: { inputTokens: 50, outputTokens: 20, reasoningTokens: 3, actualCostMicrousd: null },
      opportunities: [{ title: 'Improve enquiry conversion', rationale: 'The website describes a form-based portfolio review journey.', evidenceExcerpt: text }] };
  } };
  return { data, payload, sourceWorkflow, persistence, researchWorkflow,
    run: research => runAstraProspectingOnce({ persistence, tenantId, userId: 'fixture-owner', jobId, sourceWorkflow, researchWorkflow: research }) };
}

test('one journey researches a normal service website and saves its workspace prospect without a hiring signal', async () => {
  const f = fixture(); const result = await f.run(f.researchWorkflow);
  assert.equal(result.status, 'completed'); assert.equal(result.qualifiedCount, 1);
  assert.equal(f.data.aiCalls, 1); assert.equal(f.data.crmReads, 1);
  const saved = f.data.contacts[0];
  assert.equal(saved.qualification.signals.opportunity, null, 'an artificial hiring/expansion sentence is unnecessary');
  assert.equal(saved.qualification.score, 100);
  assert.equal(saved.qualification.scoreBreakdown.reduce((sum, item) => sum + item.points, 0), 100);
  assert.deepEqual(saved.qualification.reasons, []);
  assert.equal(saved.contact.crm.accountId, accountId); assert.equal(saved.contact.crm.kind, 'workspace_prospect');
  assert.equal(saved.contact.research.actualModel, 'synthetic-fixture-model');
  assert.equal(saved.contact.research.usage.actualCostMicrousd, null);
  assert.equal(saved.contact.research.opportunities[0].evidenceExcerpt, quote);
  assert.equal(saved.contact.research.opportunities[0].sourceEvidenceId, sourceEvidenceId);
  assert.equal(saved.contact.verified, false); assert.equal(saved.contact.email, null);
  assert.equal(f.data.claims[0].jobId, jobId);
  assert.ok(f.data.outcomes.some(row => row.outcome.type === 'prospecting.evidence_qualified' && row.outcome.crm.accountId === accountId));
});

test('absent AI adapter leaves the discovered website visible and held', async () => {
  const f = fixture(); const result = await f.run(null);
  assert.equal(result.qualifiedCount, 0); assert.equal(f.data.contacts.length, 0); assert.equal(f.data.crmReads, 0);
  const held = f.data.outcomes.find(row => row.outcome.type === 'prospecting.quarantined').outcome;
  assert.equal(held.research.status, 'blocked'); assert.equal(held.qualification.score, 70);
  assert.equal(held.crm, null); assert.equal(f.data.evidence.length, 2);
});

test('AI cannot fill in missing category or geography from the discovery request', async () => {
  const f = fixture({ text: 'We provide creative services to businesses.' });
  const result = await f.run(f.researchWorkflow);
  assert.equal(result.qualifiedCount, 0); assert.equal(f.data.aiCalls, 0);
  const held = f.data.outcomes.find(row => row.outcome.type === 'prospecting.quarantined').outcome;
  assert.ok(held.qualification.reasons.includes('category_not_supported_by_site'));
  assert.ok(held.qualification.reasons.includes('country_and_city_not_supported_by_site'));
});

test('invented opportunity excerpts and unavailable workspace accounts cannot qualify a business', async () => {
  const f = fixture();
  const result = await f.run({ async analyze() { return { status: 'completed', responseVerified: true, actualProvider: 'synthetic-fixture',
    actualModel: 'synthetic-fixture-model', opportunities: [{ title: 'Invented need', rationale: 'Synthetic unsupported statement', evidenceExcerpt: 'This is not on the captured website.' }] }; } });
  assert.equal(result.qualifiedCount, 0); assert.equal(f.data.crmReads, 0);
  const missing = fixture(); missing.sourceWorkflow.resolveCrmAccount = async () => null;
  assert.equal((await missing.run(missing.researchWorkflow)).qualifiedCount, 0);
  assert.equal(missing.data.contacts.length, 0);
  assert.ok(missing.data.outcomes.some(row => row.outcome.reasons?.includes('crm_account_unavailable')));
});

test('saved provider limit and uncertain result acknowledgement prevent redispatch on recovery', async () => {
  const budget = fixture({ providerLimit: 0 });
  assert.equal((await budget.run(budget.researchWorkflow)).qualifiedCount, 0); assert.equal(budget.data.aiCalls, 0);
  const f = fixture(); f.data.failResultCheckpoint = true;
  assert.equal((await f.run(f.researchWorkflow)).status, 'uncertain'); assert.equal(f.data.aiCalls, 1);
  assert.equal(f.data.job.checkpoint.researchReservations[0].state, 'in_flight');
  f.data.failResultCheckpoint = false;
  const recovered = await f.run(f.researchWorkflow);
  assert.equal(recovered.qualifiedCount, 0); assert.equal(f.data.aiCalls, 1, 'unknown provider result is never requested again');
  assert.ok(f.data.outcomes.some(row => row.outcome.research?.code === 'ai_request_outcome_uncertain'));
});

test('Mongo can save a queued job while source execution is blocked and records the blocked attempt', async () => {
  const f = fixture(); const saved = [];
  const persistence = { ...f.persistence, async connect() {}, async health() { return { ready: true }; },
    forTenant() { return { jobs: { async create(input) { saved.push(input); return { job: { id: jobId, state: 'queued' } }; }, async get() { return { id: jobId, state: 'queued' }; } },
      outcomes: { async append(input) { saved.push(input); return {}; } } }; } };
  const service = createAstraProspectingService({ env: { ASTRA_PERSISTENCE_BACKEND: 'mongodb', ASTRA_INTEGRATION_MODE: 'prospecting-test',
    MONGODB_URI: 'mongodb://synthetic.invalid', MONGODB_DATABASE: 'astra_test_fixture', ASTRA_MONGODB_TEST_DATABASES: 'astra_test_fixture' },
    persistenceFactory: () => persistence, sourceWorkflow: {}, researchWorkflow: f.researchWorkflow });
  const created = await service.create({ tenantId, payload: f.payload, idempotencyKey: 'synthetic-queued-key' });
  assert.equal(created.job.state, 'queued'); assert.equal(created.executionReady, false);
  assert.equal((await service.runOnce({ tenantId, userId: 'fixture-owner', jobId })).status, 'blocked');
  assert.equal(saved[1].outcome.type, 'prospecting.blocked'); assert.equal(f.data.aiCalls, 0);
});
