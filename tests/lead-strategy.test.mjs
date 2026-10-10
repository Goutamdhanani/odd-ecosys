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
const fetchRequests = [];
let nextCompletion;
let nextStatus = 200;
let nextModels = ['fixture-model'];
setLeadStrategyFetchForTests(async (input, options) => {
  fetchRequests.push({ url: String(input), options });
  if (options.method === 'GET') {
    return new Response(JSON.stringify({ data: nextModels.map(id => ({ id })) }), { status: nextStatus, headers: { 'content-type': 'application/json' } });
  }
  const content = typeof nextCompletion === 'string' ? nextCompletion : JSON.stringify(nextCompletion);
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 240 },
    provider_private_data: process.env.ODD_AI_API_KEY,
  }), { status: nextStatus, headers: { 'content-type': 'application/json' } });
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
      industries: ['Business services', 'Regional software providers'],
      company_size: ['20–200 employees'],
      geography: ['United States'],
      must_have_signals: ['A named operations owner', 'Public evidence of a repeatable workflow'],
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

test('AI lead targeting produces and durably saves validated ICP, several role/skill personas, and allowed discovery plans', async () => {
  nextCompletion = validStrategy();
  const status = await request('/api/lead-strategies');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.provider, {
    provider: 'openai-compatible', model: 'fixture-model', ready: true,
    endpointConfigured: true, apiKeyConfigured: true, connection: 'not_checked',
    source: 'environment',
    note: 'Configuration is present; explicitly check model availability before generating a strategy.',
  });
  assert.equal(JSON.stringify(status.body).includes(process.env.ODD_AI_API_KEY), false, 'provider credentials never leave server memory');

  const checked = await request('/api/lead-strategies/provider-check', { method: 'POST', body: {} });
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.body, { connection: 'connected', connected: true, modelAvailable: true, provider: 'openai-compatible', model: 'fixture-model' });
  assert.equal(fetchRequests[0].url, 'https://ai.fixture.test/v1/models');
  assert.equal(fetchRequests[0].options.headers.authorization, `Bearer ${process.env.ODD_AI_API_KEY}`);
  nextModels = [];
  const missingModel = await request('/api/lead-strategies/provider-check', { method: 'POST', body: {} });
  assert.equal(missingModel.body.connected, true);
  assert.equal(missingModel.body.modelAvailable, false, 'endpoint reachability alone does not enable a missing model');
  nextModels = ['fixture-model'];

  const brief = {
    offer: 'Workflow automation for regional business service teams',
    targetMarket: 'B2B service companies with repeatable customer intake',
    geography: 'United States', companySize: '20–200 employees',
    buyerHint: 'operations leaders and systems evaluators',
    evidence: 'We have a documented case study; do not claim results beyond it.', exclusions: 'Solo businesses',
  };
  const created = await request('/api/lead-strategies', { method: 'POST', body: brief });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.provider, 'openai-compatible');
  assert.equal(created.body.model_id, 'fixture-model');
  assert.deepEqual(created.body.brief, brief);
  assert.equal(created.body.result.personas.length, 3);
  assert.deepEqual(created.body.result.personas.map(persona => persona.must_have_skills[0]), ['Process design', 'Systems integration', 'Budget ownership']);
  assert.equal(created.body.result.scoring_rubric.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.match(created.body.result.hypotheses_notice, /hypotheses/);
  assert.equal(created.body.input_tokens, 120);
  assert.equal(created.body.output_tokens, 240);
  const generationRequest = fetchRequests.find(call => call.options.method === 'POST');
  assert.equal(generationRequest.url, 'https://ai.fixture.test/v1/chat/completions');
  assert.equal(generationRequest.options.headers.authorization, `Bearer ${process.env.ODD_AI_API_KEY}`);
  const sent = JSON.parse(generationRequest.options.body);
  assert.equal(sent.model, 'fixture-model');
  assert.match(sent.messages[1].content, /Never suggest scraping Facebook\/LinkedIn\/social profiles/);
  assert.match(sent.messages[1].content, /operator-supplied OpenStreetMap exports/i);

  const reloaded = await request(`/api/lead-strategies/${created.body.id}`);
  assert.equal(reloaded.status, 200);
  assert.deepEqual(reloaded.body.result, created.body.result, 'profile is read back from durable SQLite state');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 1);
  assert.equal(db.prepare('SELECT provider,model_id,input_tokens,output_tokens FROM lead_strategy_profiles').get().provider, 'openai-compatible');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 0, 'strategy generation creates no leads');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0, 'strategy generation queues no email');
});

test('invalid or fabricated-source model output is rejected and never persisted', async () => {
  const malformed = validStrategy();
  malformed.scoring_rubric[0].weight = 99;
  nextCompletion = malformed;
  const response = await request('/api/lead-strategies', {
    method: 'POST', body: { offer: 'A real software service', targetMarket: 'B2B operations teams' },
  });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /weights must total 100/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 1);

  const fabricated = validStrategy();
  fabricated.search_plan[0].source = 'linkedin_scraper';
  nextCompletion = fabricated;
  const unsafeSource = await request('/api/lead-strategies', {
    method: 'POST', body: { offer: 'A real software service', targetMarket: 'B2B operations teams' },
  });
  assert.equal(unsafeSource.status, 502);
  assert.match(unsafeSource.body.error, /unsupported lead source/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 1);

  const unsafeTactic = validStrategy();
  unsafeTactic.search_plan[0].approach = 'Scrape public Facebook profiles and harvest decision-maker emails.';
  nextCompletion = unsafeTactic;
  const prohibited = await request('/api/lead-strategies', {
    method: 'POST', body: { offer: 'A real software service', targetMarket: 'B2B operations teams' },
  });
  assert.equal(prohibited.status, 502);
  assert.match(prohibited.body.error, /prohibited scraping/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 1);
});

test('brief bounds, missing provider setup, unencrypted remote HTTP and provider errors fail closed', async () => {
  nextCompletion = validStrategy();
  const required = await request('/api/lead-strategies', { method: 'POST', body: { offer: '   ', targetMarket: 'B2B' } });
  assert.equal(required.status, 400);

  process.env.ODD_AI_PROVIDER = 'freeinference';
  delete process.env.ODD_AI_BASE_URL;
  delete process.env.FREEINFERENCE_API_BASE_URL;
  delete process.env.ODD_AI_MODEL;
  delete process.env.FREEINFERENCE_MODEL;
  delete process.env.ODD_AI_API_KEY;
  delete process.env.FREEINFERENCE_API_KEY;
  assert.equal((await request('/api/lead-strategies')).body.provider.ready, false);
  const unconfigured = await request('/api/lead-strategies', { method: 'POST', body: { offer: 'Service', targetMarket: 'B2B' } });
  assert.equal(unconfigured.status, 503);
  assert.match(unconfigured.body.error, /provider is not configured/i);

  process.env.ODD_AI_BASE_URL = 'http://remote-ai.example.test/v1';
  process.env.ODD_AI_MODEL = 'fixture-model';
  process.env.ODD_AI_API_KEY = 'remote-test-key';
  const callsBeforeInsecure = fetchRequests.length;
  const insecure = await request('/api/lead-strategies', { method: 'POST', body: { offer: 'Service', targetMarket: 'B2B' } });
  assert.equal(insecure.status, 503);
  assert.match(insecure.body.error, /must use HTTPS/);
  assert.equal(fetchRequests.length, callsBeforeInsecure, 'insecure endpoint fails before a network request');

  process.env.ODD_AI_BASE_URL = 'https://ai.fixture.test/v1';
  process.env.ODD_AI_API_KEY = 'second-fixture-secret';
  nextStatus = 401;
  const rejected = await request('/api/lead-strategies', { method: 'POST', body: { offer: 'Service', targetMarket: 'B2B' } });
  assert.equal(rejected.status, 502);
  assert.doesNotMatch(JSON.stringify(rejected.body), /secret|provider_private_data|credential/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 1);

  delete process.env.ODD_AI_PROVIDER;
  delete process.env.ODD_AI_MODEL;
  delete process.env.ODD_AI_API_KEY;
  process.env.FREEINFERENCE_API_BASE_URL = 'https://api.freeinference.example/v1';
  process.env.FREEINFERENCE_MODEL = 'glm-5.3-flash';
  const noKey = (await request('/api/lead-strategies')).body.provider;
  assert.equal(noKey.provider, 'freeinference', 'FreeInference is selected by its local endpoint configuration when no provider override is set');
  assert.equal(noKey.model, 'glm-5.3-flash');
  assert.equal(noKey.ready, false, 'FreeInference is never marked ready without its API key');
  assert.equal(noKey.apiKeyConfigured, false);
  process.env.FREEINFERENCE_API_KEY = 'freeinference-test-key';
  const configured = (await request('/api/lead-strategies')).body.provider;
  assert.equal(configured.ready, true);
  assert.equal(configured.apiKeyConfigured, true);
  assert.equal(JSON.stringify(configured).includes(process.env.FREEINFERENCE_API_KEY), false);
});
