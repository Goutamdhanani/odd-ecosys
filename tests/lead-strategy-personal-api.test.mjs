import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-personal-ai-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'personal-ai-bootstrap-token-for-tests-012345';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = '5a'.repeat(32);
process.env.PORT = '0';
delete process.env.HOST;
for (const name of [
  'ODD_AI_PROVIDER', 'ODD_AI_BASE_URL', 'ODD_AI_MODEL', 'ODD_AI_API_KEY', 'ODD_AI_TIMEOUT_MS',
  'ODD_OLLAMA_BASE_URL', 'ODD_OLLAMA_MODEL', 'FREEINFERENCE_API_BASE_URL', 'FREEINFERENCE_MODEL', 'FREEINFERENCE_API_KEY',
]) delete process.env[name];

const { closeDb, getDb } = await import('../pipeline/database.js');
const { server, setLeadStrategyFetchForTests } = await import('../server.js');
const providerCalls = [];
const strategyFixture = {
  name: 'Synthetic operator strategy',
  icp: {
    summary: 'B2B service teams with a documented recurring intake workflow.',
    industries: ['Business services'], company_size: ['20–200 employees'], geography: ['United States'],
    must_have_signals: ['A named operations owner'], exclude_signals: ['No workflow owner'],
    qualification_questions: ['Who owns the workflow?', 'What evidence confirms the need?', 'How often does it recur?'],
  },
  personas: [
    { name: 'Operations lead', buying_role: 'champion', seniority: 'Manager', job_titles: ['Operations Manager'], must_have_skills: ['Process design'], technology_signals: ['Workflow software'], pain_points: ['Manual handoffs'], buying_triggers: ['New operations hire'], search_terms: ['operations manager'], confidence: 'medium' },
    { name: 'Technical evaluator', buying_role: 'evaluator', seniority: 'Lead', job_titles: ['Systems Lead'], must_have_skills: ['Systems integration'], technology_signals: ['CRM integration'], pain_points: ['Disconnected systems'], buying_triggers: ['Platform migration'], search_terms: ['systems lead'], confidence: 'low' },
    { name: 'Economic buyer', buying_role: 'economic buyer', seniority: 'Director', job_titles: ['Operations Director'], must_have_skills: ['Budget ownership'], technology_signals: ['Process platform'], pain_points: ['Unmeasured cost'], buying_triggers: ['Annual planning'], search_terms: ['operations director'], confidence: 'low' },
  ],
  search_plan: [
    { source: 'operator_csv', approach: 'Review a licensed operator-supplied account list.', query_terms: ['business services'] },
    { source: 'osm_export', approach: 'Filter an operator-supplied regional export and retain attribution.', query_terms: ['business services'] },
  ],
  scoring_rubric: [
    { criterion: 'Industry fit', weight: 30, positive_signals: ['Relevant category'] },
    { criterion: 'Workflow evidence', weight: 30, positive_signals: ['Published workflow'] },
    { criterion: 'Role match', weight: 25, positive_signals: ['Relevant title'] },
    { criterion: 'Readiness', weight: 15, positive_signals: ['Owner can validate'] },
  ],
};
setLeadStrategyFetchForTests(async (url, options) => {
  providerCalls.push({ url: String(url), options });
  const payload = options.method === 'GET'
    ? { data: [{ id: 'operator-model' }] }
    : { choices: [{ message: { content: JSON.stringify(strategyFixture) } }], usage: { prompt_tokens: 42, completion_tokens: 84 } };
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
});
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, session } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session?.cookie) headers.cookie = session.cookie;
  if (session?.csrf) headers['x-csrf-token'] = session.csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  return { status: response.status, body: payload, setCookie: response.headers.get('set-cookie') || '' };
}

function sessionFromCookie(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session);
  assert.ok(csrf);
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

async function bootstrapOwner() {
  await request('/api/auth/status');
  const response = await request('/api/auth/bootstrap', {
    method: 'POST', body: {
      email: 'owner@personal-ai.test', password: 'Owner-personal-ai-password-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return sessionFromCookie(response.setCookie);
}

async function createOperator(owner, email) {
  const invitation = await request('/api/workspace/invitations', {
    method: 'POST', session: owner, body: { email, role: 'operator' },
  });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const accepted = await request('/api/auth/invitations/accept', {
    method: 'POST', body: { email, password: 'Operator-personal-ai-password-8!', invitationToken: invitation.body.invitation.token },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  return sessionFromCookie(accepted.setCookie);
}

test('authenticated operators save independent AI keys, use their own provider, and reset to the shared workspace provider', async () => {
  const owner = await bootstrapOwner();
  const sharedKey = 'synthetic-shared-ai-key';
  const shared = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT', session: owner,
    body: { scope: 'workspace', provider: 'openai-compatible', baseUrl: 'https://shared-ai.test/v1', model: 'shared-model', apiKey: sharedKey },
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));

  const operatorOne = await createOperator(owner, 'one@personal-ai.test');
  const operatorTwo = await createOperator(owner, 'two@personal-ai.test');
  const personalKeyOne = 'synthetic-personal-ai-key-one';
  const firstSave = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT', session: operatorOne,
    body: { scope: 'personal', provider: 'openai-compatible', baseUrl: 'https://one-ai.test/v1', model: 'operator-model', apiKey: personalKeyOne },
  });
  assert.equal(firstSave.status, 200, JSON.stringify(firstSave.body));
  assert.equal(firstSave.body.settings.source, 'personal');
  assert.equal(firstSave.body.settings.model, 'operator-model');
  assert.equal(JSON.stringify(firstSave.body).includes(personalKeyOne), false);

  const secondKey = 'synthetic-personal-ai-key-two';
  const secondSave = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT', session: operatorTwo,
    body: { scope: 'personal', provider: 'openai-compatible', baseUrl: 'https://two-ai.test/v1', model: 'other-operator-model', apiKey: secondKey },
  });
  assert.equal(secondSave.status, 200, JSON.stringify(secondSave.body));

  const firstRead = await request('/api/lead-strategies', { session: operatorOne });
  const secondRead = await request('/api/lead-strategies', { session: operatorTwo });
  assert.equal(firstRead.body.settings.baseUrl, 'https://one-ai.test/v1');
  assert.equal(secondRead.body.settings.baseUrl, 'https://two-ai.test/v1');
  assert.equal(JSON.stringify(firstRead.body).includes(secondKey), false);
  assert.equal(JSON.stringify(secondRead.body).includes(personalKeyOne), false);

  const checked = await request('/api/lead-strategies/provider-check', {
    method: 'POST', session: operatorOne, body: { scope: 'personal' },
  });
  assert.deepEqual(checked.body, {
    connection: 'connected', connected: true, modelAvailable: true,
    provider: 'openai-compatible', model: 'operator-model',
  });
  assert.equal(providerCalls.at(-1).url, 'https://one-ai.test/v1/models');
  assert.equal(providerCalls.at(-1).options.headers.authorization, `Bearer ${personalKeyOne}`);

  const generated = await request('/api/lead-strategies', {
    method: 'POST', session: operatorOne,
    body: { offer: 'Workflow tools', targetMarket: 'B2B service teams', geography: 'United States' },
  });
  assert.equal(generated.status, 201, JSON.stringify(generated.body));
  assert.equal(generated.body.model_id, 'operator-model');
  assert.equal(generated.body.created_by, 2);
  assert.equal(providerCalls.at(-1).url, 'https://one-ai.test/v1/chat/completions');
  assert.equal(providerCalls.at(-1).options.headers.authorization, `Bearer ${personalKeyOne}`,
    'strategy generation uses the current operator’s personal key');
  assert.equal(JSON.stringify(generated.body).includes(personalKeyOne), false);
  const secondGenerated = await request('/api/lead-strategies', {
    method: 'POST', session: operatorTwo,
    body: { offer: 'Workflow tools', targetMarket: 'B2B service teams', geography: 'United States' },
  });
  assert.equal(secondGenerated.status, 201, JSON.stringify(secondGenerated.body));
  assert.equal(secondGenerated.body.model_id, 'other-operator-model');
  assert.equal(secondGenerated.body.created_by, 3);
  assert.equal(providerCalls.at(-1).url, 'https://two-ai.test/v1/chat/completions');
  assert.equal(providerCalls.at(-1).options.headers.authorization, `Bearer ${secondKey}`,
    'another operator’s generation uses only that operator’s personal key');
  assert.equal(JSON.stringify(secondGenerated.body).includes(secondKey), false);

  const workspaceWriteDenied = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT', session: operatorOne,
    body: { scope: 'workspace', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'unauthorized-model' },
  });
  assert.equal(workspaceWriteDenied.status, 403);

  const clear = await request('/api/lead-strategies/provider-settings', { method: 'DELETE', session: operatorOne });
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  assert.equal(clear.body.settings.source, 'workspace');
  assert.equal(clear.body.settings.baseUrl, 'https://shared-ai.test/v1');
  const afterClear = await request('/api/lead-strategies', { session: operatorOne });
  assert.equal(afterClear.body.settings.model, 'shared-model');
  assert.equal((await request('/api/lead-strategies', { session: operatorTwo })).body.settings.model, 'other-operator-model');

  const rows = getDb().prepare('SELECT user_id,api_key_enc FROM ai_user_provider_settings ORDER BY user_id').all();
  assert.equal(rows.length, 1, 'clearing one account removes only that account row');
  assert.match(rows[0].api_key_enc, /^oddc1:/);
  assert.ok(getDb().prepare("SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type LIKE 'ai_%provider_settings%' ").get().count >= 4);
});
