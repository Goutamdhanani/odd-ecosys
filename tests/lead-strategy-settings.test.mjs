import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
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
setLeadStrategyFetchForTests(async (input, options) => {
  providerCalls.push({ url: String(input), options });
  return new Response(JSON.stringify({ data: [{ id: 'freeinference-model-v2' }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
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

test('AI provider model saves durably, retains encrypted credentials, and confirms the selected model', async () => {
  const initial = await request('/api/lead-strategies');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.settings.canEdit, true);
  assert.equal(initial.body.settings.source, 'default');

  const secret = 'synthetic-provider-secret-do-not-return';
  const saved = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT',
    body: {
      provider: 'freeinference', baseUrl: 'https://api.fixture.test/v1',
      model: 'freeinference-model-v1', apiKey: secret, clearApiKey: false,
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.model, 'freeinference-model-v1');
  assert.equal(saved.body.settings.apiKeyConfigured, true);
  assert.equal(saved.body.provider.ready, true);
  assert.equal(JSON.stringify(saved.body).includes(secret), false, 'API responses never echo the provider credential');
  assert.equal(Object.hasOwn(saved.body.settings, 'apiKey'), false);

  const storedBeforeEdit = getDb().prepare('SELECT provider,base_url,model_id,api_key_enc FROM ai_provider_settings WHERE id=1').get();
  assert.equal(storedBeforeEdit.model_id, 'freeinference-model-v1');
  assert.notEqual(storedBeforeEdit.api_key_enc, secret);
  assert.match(storedBeforeEdit.api_key_enc, /^oddc1:/, 'the test key encrypts the provider credential at rest');

  const edited = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT',
    body: {
      provider: 'freeinference', baseUrl: 'https://api.fixture.test/v1',
      model: 'freeinference-model-v2', apiKey: '', clearApiKey: false,
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.settings.model, 'freeinference-model-v2');
  assert.equal(edited.body.settings.apiKeyConfigured, true, 'saving a model change with a blank key retains the encrypted key');
  assert.equal(getDb().prepare('SELECT api_key_enc FROM ai_provider_settings WHERE id=1').get().api_key_enc, storedBeforeEdit.api_key_enc);

  const reloaded = await request('/api/lead-strategies');
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.settings.model, 'freeinference-model-v2', 'a later settings read returns the saved model');
  assert.equal(reloaded.body.provider.model, 'freeinference-model-v2');
  assert.equal(JSON.stringify(reloaded.body).includes(secret), false);

  const checked = await request('/api/lead-strategies/provider-check', { method: 'POST', body: {} });
  assert.deepEqual(checked.body, {
    connection: 'connected', connected: true, modelAvailable: true,
    provider: 'freeinference', model: 'freeinference-model-v2',
  });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, 'https://api.fixture.test/v1/models');
  assert.equal(providerCalls[0].options.headers.authorization, `Bearer ${secret}`);

  const { createLeadStrategyManager } = await import('../pipeline/lead-strategy.js');
  const manager = createLeadStrategyManager({ db: getDb(), fetchImpl: async () => { throw new Error('Unexpected provider call'); } });
  assert.throws(() => manager.saveSettings({
    provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'local-model',
  }, { id: 7, role: 'reviewer' }), error => error.statusCode === 403,
  'non-admin workspace roles cannot save model settings');

  const cleared = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT',
    body: {
      provider: 'ollama', baseUrl: 'http://127.0.0.1:11434',
      model: 'freeinference-model-v2', apiKey: '', clearApiKey: true,
    },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.settings.apiKeyConfigured, false, 'the explicit remove-key option clears the credential');
  assert.equal(getDb().prepare('SELECT api_key_enc FROM ai_provider_settings WHERE id=1').get().api_key_enc, null);

  delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
  const missingEncryptionKey = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT',
    body: {
      provider: 'freeinference', baseUrl: 'https://api.fixture.test/v1',
      model: 'freeinference-model-v2', apiKey: 'not-persisted-without-key', clearApiKey: false,
    },
  });
  assert.equal(missingEncryptionKey.status, 503);
  assert.match(missingEncryptionKey.body.error, /ODD_CREDENTIAL_ENCRYPTION_KEY/);
  assert.equal(getDb().prepare('SELECT provider,model_id,api_key_enc FROM ai_provider_settings WHERE id=1').get().provider, 'ollama', 'failed encryption does not partially save provider/model settings');
  assert.equal(getDb().prepare('SELECT api_key_enc FROM ai_provider_settings WHERE id=1').get().api_key_enc, null);

  process.env.ODD_AI_PROVIDER = 'openai-compatible';
  process.env.ODD_AI_BASE_URL = 'https://managed.fixture.test/v1';
  process.env.ODD_AI_MODEL = 'managed-model';
  process.env.ODD_AI_API_KEY = 'managed-test-secret';
  const managed = await request('/api/lead-strategies');
  assert.equal(managed.body.settings.source, 'environment');
  assert.equal(managed.body.settings.canEdit, false, 'service-environment settings remain read-only in the workspace UI');
  const denied = await request('/api/lead-strategies/provider-settings', {
    method: 'PUT',
    body: { provider: 'openai-compatible', baseUrl: 'https://elsewhere.fixture.test/v1', model: 'unexpected', apiKey: '', clearApiKey: false },
  });
  assert.equal(denied.status, 409, 'the API also refuses workspace writes when environment settings own the provider');
  assert.equal(JSON.stringify(denied.body).includes('managed-test-secret'), false);
});
