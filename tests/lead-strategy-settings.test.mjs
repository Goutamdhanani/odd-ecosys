import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-ai-provider-settings-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.sqlite');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'd'.repeat(64);
for (const key of [
  'ODD_AI_PROVIDER', 'ODD_AI_BASE_URL', 'ODD_AI_MODEL', 'ODD_AI_API_KEY', 'ODD_AI_TIMEOUT_MS',
  'ODD_OLLAMA_BASE_URL', 'ODD_OLLAMA_MODEL', 'FREEINFERENCE_API_BASE_URL', 'FREEINFERENCE_MODEL',
  'FREEINFERENCE_API_KEY', 'ODD_AUTH_ENFORCE_TESTS',
]) delete process.env[key];

const { closeDb, getDb } = await import('../pipeline/database.js');
const { server, setLeadStrategyFetchForTests } = await import('../server.js');
const providerCalls = [];
setLeadStrategyFetchForTests(async input => {
  providerCalls.push(String(input));
  throw new Error('Legacy strategy workflow must not call a provider');
});
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

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
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('legacy provider configuration and settings writes stay disabled with no secret persistence', async () => {
  // Even service-level legacy environment values must not become an endpoint
  // or credential source for this workflow.
  process.env.ODD_AI_PROVIDER = 'openai-compatible';
  process.env.ODD_AI_BASE_URL = 'https://managed.fixture.test/v1';
  process.env.ODD_AI_MODEL = 'managed-model';
  process.env.ODD_AI_API_KEY = 'managed-test-secret';

  const initial = await request('/api/lead-strategies');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.provider.provider, 'glm-5.3-api');
  assert.equal(initial.body.provider.ready, false);
  assert.equal(initial.body.provider.endpointConfigured, false);
  assert.equal(initial.body.provider.apiKeyConfigured, false);
  assert.equal(initial.body.provider.source, 'tenant-gateway-required');
  assert.equal(initial.body.settings.baseUrl, '');
  assert.equal(JSON.stringify(initial.body).includes('managed-test-secret'), false);

  const secret = 'synthetic-provider-secret-do-not-return';
  const denied = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT',
    body: { provider: 'freeinference', baseUrl: 'https://api.fixture.test/v1', model: 'fixture-model', apiKey: secret },
  });
  assert.equal(denied.status, 409);
  assert.match(denied.body.error, /legacy provider settings are disabled/i);
  assert.doesNotMatch(JSON.stringify(denied.body), /synthetic-provider-secret/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM ai_provider_settings').get().count, 0,
    'denied writes do not save endpoint, model, or encrypted key');

  const checked = await request('/api/lead-strategies/provider-check', { method: 'POST', body: {} });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.connection, 'tenant_gateway_required');
  assert.equal(checked.body.egressEnabled, false);
  assert.deepEqual(providerCalls, [], 'status and provider check issue no network request');
  const valid = await request('/api/lead-strategies', {
    method: 'POST', body: { offer: 'Workflow tools', targetMarket: 'B2B service teams' },
  });
  assert.equal(valid.status, 503);
  assert.match(valid.body.error, /verified Astra tenant request and durable GLM budget reservation/i);
  const invalidBrief = await request('/api/lead-strategies', { method: 'POST', body: { offer: '   ', targetMarket: 'B2B' } });
  assert.equal(invalidBrief.status, 400, 'input validation remains available before the gateway check');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM lead_strategy_profiles').get().count, 0,
    'a denied generation stores no copy');
  assert.deepEqual(providerCalls, []);
});
