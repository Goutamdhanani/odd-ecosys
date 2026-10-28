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
setLeadStrategyFetchForTests(async (url) => {
  providerCalls.push(String(url));
  throw new Error('Legacy AI provider transport must remain unused');
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

test('authenticated operators cannot save legacy personal or workspace providers or trigger direct model calls', async () => {
  const owner = await bootstrapOwner();
  const operatorOne = await createOperator(owner, 'one@personal-ai.test');
  const operatorTwo = await createOperator(owner, 'two@personal-ai.test');
  const secretOne = 'synthetic-personal-ai-secret-one';
  const secretTwo = 'synthetic-personal-ai-secret-two';

  const ownerStatus = await request('/api/lead-strategies', { session: owner });
  const firstStatus = await request('/api/lead-strategies', { session: operatorOne });
  const secondStatus = await request('/api/lead-strategies', { session: operatorTwo });
  for (const response of [ownerStatus, firstStatus, secondStatus]) {
    assert.equal(response.status, 200);
    assert.equal(response.body.provider.provider, 'glm-5.3-api');
    assert.equal(response.body.provider.ready, false);
    assert.equal(response.body.provider.source, 'tenant-gateway-required');
    assert.equal(response.body.settings.baseUrl, '');
    assert.equal(response.body.settings.model, 'GLM-5.3');
  }
  assert.equal(firstStatus.body.settings.personalConfigured, false);
  assert.equal(secondStatus.body.settings.personalConfigured, false);
  assert.equal(JSON.stringify([ownerStatus.body, firstStatus.body, secondStatus.body]).includes(secretOne), false);
  assert.equal(JSON.stringify([ownerStatus.body, firstStatus.body, secondStatus.body]).includes(secretTwo), false);

  for (const [session, secret, endpoint] of [
    [operatorOne, secretOne, 'https://one-ai.test/v1'],
    [operatorTwo, secretTwo, 'http://127.0.0.1:11434'],
  ]) {
    const denied = await request('/api/lead-strategies/provider-settings', {
      method: 'PUT', session,
      body: { scope: 'personal', provider: 'openai-compatible', baseUrl: endpoint, model: 'synthetic-model', apiKey: secret },
    });
    assert.equal(denied.status, 409);
    assert.match(denied.body.error, /legacy provider settings are disabled/i);
    assert.doesNotMatch(JSON.stringify(denied.body), /synthetic-personal-ai-secret/);
  }
  const workspaceDenied = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT', session: owner,
    body: { scope: 'workspace', provider: 'openai-compatible', baseUrl: 'https://shared-ai.test/v1', model: 'shared', apiKey: 'synthetic-workspace-secret' },
  });
  assert.equal(workspaceDenied.status, 409);
  assert.match(workspaceDenied.body.error, /legacy provider settings are disabled/i);
  assert.doesNotMatch(JSON.stringify(workspaceDenied.body), /synthetic-workspace-secret/);

  const check = await request('/api/lead-strategies/provider-check', { method: 'POST', session: operatorOne, body: { scope: 'personal' } });
  assert.equal(check.status, 200);
  assert.equal(check.body.connection, 'tenant_gateway_required');
  assert.equal(check.body.egressEnabled, false);
  assert.equal(check.body.modelAvailable, false);
  assert.deepEqual(providerCalls, [], 'provider check never contacts a configured legacy endpoint');

  const generated = await request('/api/lead-strategies', {
    method: 'POST', session: operatorOne,
    body: { offer: 'Workflow tools', targetMarket: 'B2B service teams', geography: 'United States' },
  });
  assert.equal(generated.status, 503);
  assert.match(generated.body.error, /verified Astra tenant request and durable GLM budget reservation/i);
  const interpreted = await request('/api/lead-strategies/discovery-search-interpretation', {
    method: 'POST', session: operatorOne, body: { query: 'Software companies in Toronto' },
  });
  assert.equal(interpreted.status, 503);
  assert.match(interpreted.body.error, /verified Astra tenant request and durable GLM budget reservation/i);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 0,
    'denied model operations save no strategy copies');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM ai_provider_settings').get().count, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM ai_user_provider_settings').get().count, 0,
    'denied settings operations persist no provider endpoint or secret');
  assert.deepEqual(providerCalls, []);
  assert.equal((await request('/api/lead-strategies/discovery-search-interpretation', {
    method: 'POST', body: { query: 'Find software companies' },
  })).status, 401, 'search interpretation stays authenticated');
});
