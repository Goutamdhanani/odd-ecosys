import test from 'node:test';
import assert from 'node:assert/strict';
import { createAstraProspectingResearch, prepareProspectingResearchInput } from '../pipeline/astra-prospecting-research.js';

const quote = 'Our dental clinic in Bengaluru, India provides family dental care with online appointment requests.';
const input = { job: { id: 'job-fixture', tenantId: 'tenant-fixture', payload: { category: 'dental clinic', country: 'India', city: 'Bengaluru', goal: 'Improve website enquiries' } },
  page: { sourceUrl: 'https://synthetic-business.example.test/', visibleText: quote, metaDescription: '', ctas: [] },
  evidenceId: 'evidence-fixture', sourceEvidence: { id: 'source-evidence-fixture', sourceRightsUsable: true, contentSha256: 'a'.repeat(64) }, beforeRequest: async () => {} };
function adapter(opportunity = { title: 'Review appointment requests', rationale: 'Review how the existing appointment process supports family enquiries.', evidenceExcerpt: quote }) {
  return createAstraProspectingResearch({ env: { ASTRA_PROSPECTING_RESEARCH_ENABLED: 'true' }, runTask: async options => {
    await options.onDispatch();
    return { responseStatus: 'verified', actual: { provider: 'freeinference', model: 'glm-5.3-flash' },
      usage: { inputTokens: 10, outputTokens: 20, actualCostMicrousd: null }, data: { opportunities: [opportunity] } };
  } });
}
test('connected research returns grounded proposals with actual identity and unknown cost preserved', async () => {
  const checkpoints = [];
  const result = await adapter().analyze({ ...input, onCheckpoint: async receipt => checkpoints.push(receipt) });
  assert.equal(result.status, 'completed'); assert.equal(result.responseVerified, true);
  assert.equal(result.actualModel, 'glm-5.3-flash'); assert.equal(result.usage.actualCostMicrousd, null);
  assert.equal(result.opportunities[0].evidenceExcerpt, quote); assert.equal(checkpoints.length, 1);
});
test('AI fabricated excerpts or unsupported numbers never qualify as research', async () => {
  for (const opportunity of [
    { title: 'Invented', rationale: 'A review proposal.', evidenceExcerpt: 'This site is broken.' },
    { title: 'Invented lift', rationale: 'This will improve sales by 50 percent.', evidenceExcerpt: quote },
  ]) {
    const result = await adapter(opportunity).analyze(input);
    assert.equal(result.status, 'uncertain'); assert.deepEqual(result.opportunities, []);
  }
});
test('disabled or rights-blocked AI makes no request, and public evidence is minimized', async () => {
  let calls = 0;
  const service = createAstraProspectingResearch({ env: {}, runTask: () => { calls++; } });
  assert.equal((await service.analyze(input)).status, 'blocked'); assert.equal(calls, 0);
  const safe = prepareProspectingResearchInput({ ...input, page: { ...input.page, visibleText: quote + ' Email owner@example.test. Call +91 1234567890.' } });
  assert.doesNotMatch(JSON.stringify(safe), /owner@|1234567890/);
  const blocked = await adapter().analyze({ ...input, sourceEvidence: { ...input.sourceEvidence, sourceRightsUsable: false } });
  assert.equal(blocked.status, 'blocked');
});
