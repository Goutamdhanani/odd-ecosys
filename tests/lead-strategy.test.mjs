import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-lead-strategy-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ODD_AI_PROVIDER = 'openai-compatible';
process.env.ODD_AI_BASE_URL = 'https://ai.fixture.test/v1';
process.env.ODD_AI_MODEL = 'fixture-model';
process.env.ODD_AI_API_KEY = 'fixture-secret-never-return-this';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server, setLeadStrategyFetchForTests } = await import('../server.js');
const { validateStrategyOutput, validateDiscoverySearchInterpretation } = await import('../pipeline/lead-strategy.js');
const fetchRequests = [];
setLeadStrategyFetchForTests(async (input, options) => {
  fetchRequests.push({ url: String(input), options });
  throw new Error('Legacy provider fetch must remain unused');
});
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

function validStrategy() {
  return {
    name: 'Regional workflow automation buyers',
    icp: {
      summary: 'Regional B2B service teams with repeatable intake and customer follow-up workflows.',
      industries: ['Business services', 'Regional software providers'], company_size: ['20–200 employees'],
      geography: ['United States'], must_have_signals: ['A named operations owner', 'Public evidence of a repeatable workflow'],
      exclude_signals: ['No in-house workflow owner'],
      qualification_questions: ['Who owns the process?', 'How often does it recur?', 'What evidence confirms the current tool?'],
    },
    personas: [
      { name: 'Operations champion', buying_role: 'champion', seniority: 'Manager', job_titles: ['Operations Manager'], must_have_skills: ['Process design'], technology_signals: ['Workflow software'], pain_points: ['Manual handoffs'], buying_triggers: ['Hiring an operations lead'], search_terms: ['operations manager workflow'], confidence: 'medium' },
      { name: 'Technical evaluator', buying_role: 'evaluator', seniority: 'Lead', job_titles: ['Systems Lead'], must_have_skills: ['Systems integration'], technology_signals: ['CRM integration'], pain_points: ['Disconnected systems'], buying_triggers: ['Platform migration'], search_terms: ['systems integration lead'], confidence: 'low' },
      { name: 'Economic buyer', buying_role: 'economic buyer', seniority: 'Director', job_titles: ['Operations Director'], must_have_skills: ['Budget ownership'], technology_signals: ['Business process platform'], pain_points: ['Unmeasured operational cost'], buying_triggers: ['Annual planning'], search_terms: ['operations director process automation'], confidence: 'low' },
    ],
    search_plan: [
      { source: 'operator_csv', approach: 'Import a licensed, operator-supplied account list and review the source record.', query_terms: ['business services', 'operations manager'] },
      { source: 'osm_export', approach: 'Filter an operator-supplied regional export by supported business category; retain attribution.', query_terms: ['business services'] },
      { source: 'meta_lead_ads', approach: 'Use only the connected Page forms that your organization owns.', query_terms: ['operations workflow'] },
    ],
    scoring_rubric: [
      { criterion: 'Industry fit', weight: 30, positive_signals: ['Relevant business category'] },
      { criterion: 'Workflow evidence', weight: 30, positive_signals: ['Publicly documented recurring process'] },
      { criterion: 'Buying access', weight: 25, positive_signals: ['Relevant role is identified from a permitted source'] },
      { criterion: 'Operational readiness', weight: 15, positive_signals: ['A process owner can validate need'] },
    ],
  };
}

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { status: response.status, body: payload };
}

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('lead strategy API reports the tenant gateway and refuses generation without verified tenant budget', async () => {
  const status = await request('/api/lead-strategies');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.provider, {
    provider: 'glm-5.3-api', model: 'GLM-5.3', ready: false,
    endpointConfigured: false, apiKeyConfigured: false,
    source: 'tenant-gateway-required', connection: 'not_checked',
    note: 'Model work is unavailable here until this workflow has verified Astra tenant context, approved synthetic input, and a durable GLM usage reservation.',
  });
  assert.equal(JSON.stringify(status.body).includes(process.env.ODD_AI_API_KEY), false);
  assert.equal(status.body.settings.baseUrl, '');

  const check = await request('/api/lead-strategies/provider-check', { method: 'POST', body: {} });
  assert.equal(check.status, 200);
  assert.equal(check.body.connection, 'tenant_gateway_required');
  assert.equal(check.body.egressEnabled, false);
  assert.equal(check.body.modelAvailable, false);
  assert.deepEqual(fetchRequests, []);

  const brief = { offer: 'Workflow automation for regional business service teams', targetMarket: 'B2B service companies with repeatable customer intake', geography: 'United States' };
  const denied = await request('/api/lead-strategies', { method: 'POST', body: brief });
  assert.equal(denied.status, 503);
  assert.match(denied.body.error, /verified Astra tenant request and durable GLM budget reservation/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  assert.deepEqual(fetchRequests, [], 'generation does not use environment provider settings or call an external provider');
});

test('lead strategy output and discovery schemas still reject fabricated sources and unsupported input shapes', () => {
  const valid = validateStrategyOutput(validStrategy());
  assert.equal(valid.personas.length, 3);
  assert.equal(valid.scoring_rubric.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.ok(valid.search_plan.every(item => ['operator_csv', 'osm_export', 'meta_lead_ads', 'website_scan'].includes(item.source)));

  const fabricated = validStrategy();
  fabricated.search_plan[0].source = 'linkedin_scraper';
  assert.throws(() => validateStrategyOutput(fabricated), /unsupported lead source/i);
  const unsafeTactic = validStrategy();
  unsafeTactic.search_plan[0].approach = 'Scrape public Facebook profiles and harvest decision-maker emails.';
  assert.throws(() => validateStrategyOutput(unsafeTactic), /prohibited scraping/i);
  const badWeights = validStrategy();
  badWeights.scoring_rubric[0].weight = 99;
  assert.throws(() => validateStrategyOutput(badWeights), /weights must total 100/i);

  const acceptedSearch = validateDiscoverySearchInterpretation({
    country: 'India', state: 'Rajasthan', cities: ['Jaipur'], niches: ['handicraft exporter'],
    include_epch_directory: true, unsupported_constraints: ['At least 50 employees'], clarifying_questions: [],
  });
  assert.deepEqual(acceptedSearch.cities, ['Jaipur']);
  assert.deepEqual(acceptedSearch.unsupported_constraints, ['At least 50 employees']);
  assert.throws(() => validateDiscoverySearchInterpretation({
    country: 'United States', state: '', cities: ['Austin'], niches: ['software'],
    include_epch_directory: true, unsupported_constraints: [], clarifying_questions: [],
  }), /EPCH|directory/i, 'EPCH remains limited to eligible India handicraft searches');
  assert.throws(() => validateDiscoverySearchInterpretation({
    country: 'United States', cities: 'Austin', niches: [], include_epch_directory: false,
    unsupported_constraints: [], clarifying_questions: [],
  }), /invalid.*city|cities/i, 'discovery fields still require schema-valid types');
});

test('brief validation remains active before the unavailable tenant gateway check', async () => {
  const required = await request('/api/lead-strategies', { method: 'POST', body: { offer: '   ', targetMarket: 'B2B' } });
  assert.equal(required.status, 400);
  assert.match(required.body.error, /offer/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 0);
  assert.deepEqual(fetchRequests, []);
});
