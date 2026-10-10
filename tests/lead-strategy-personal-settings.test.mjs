import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLeadStrategyManager } from '../pipeline/lead-strategy.js';
import { decryptCredential } from '../pipeline/credential-vault.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-personal-ai-settings-'));
const databasePath = path.join(directory, 'personal-ai.sqlite');
const key = '4f'.repeat(32);
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = key;
for (const name of [
  'ODD_AI_PROVIDER', 'ODD_AI_BASE_URL', 'ODD_AI_MODEL', 'ODD_AI_API_KEY', 'ODD_AI_TIMEOUT_MS',
  'ODD_OLLAMA_BASE_URL', 'ODD_OLLAMA_MODEL', 'FREEINFERENCE_API_BASE_URL', 'FREEINFERENCE_MODEL', 'FREEINFERENCE_API_KEY',
]) delete process.env[name];

let db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE auth_users (id INTEGER PRIMARY KEY)');
db.prepare('INSERT INTO auth_users(id) VALUES (?), (?), (?)').run(1, 2, 3);
const providerCalls = [];
const makeManager = () => createLeadStrategyManager({
  db,
  fetchImpl: async (url, options) => {
    providerCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: [{ id: 'private-model-1' }, { id: 'private-model-2' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  },
});
let manager = makeManager();
const owner = { id: 1, role: 'owner' };
const operatorOne = { id: 2, role: 'operator' };
const operatorTwo = { id: 3, role: 'operator' };

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.ODD_CREDENTIAL_ENCRYPTION_KEY;
});

test('each operator can persist an isolated encrypted provider override and return to workspace fallback', async () => {
  const sharedKey = 'synthetic-workspace-provider-key';
  manager.saveSettings({
    scope: 'workspace', provider: 'openai-compatible', baseUrl: 'https://shared.example/v1',
    model: 'shared-model', apiKey: sharedKey,
  }, owner);

  const firstKey = 'synthetic-private-provider-key-one';
  const first = manager.saveSettings({
    scope: 'personal', provider: 'openai-compatible', baseUrl: 'https://one.example/v1',
    model: 'private-model-1', apiKey: firstKey,
  }, operatorOne);
  assert.equal(first.scope, 'personal');
  assert.equal(first.source, 'personal');
  assert.equal(first.model, 'private-model-1');
  assert.equal(first.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-private-provider-key-one/);

  const secondKey = 'synthetic-private-provider-key-two';
  const second = manager.saveSettings({
    scope: 'personal', provider: 'freeinference', baseUrl: 'https://two.example/v1',
    model: 'private-model-2', apiKey: secondKey,
  }, operatorTwo);
  assert.equal(second.baseUrl, 'https://two.example/v1');
  assert.equal(manager.getSettings(operatorOne).baseUrl, 'https://one.example/v1');
  assert.equal(manager.getSettings(operatorTwo).baseUrl, 'https://two.example/v1');

  const rows = db.prepare('SELECT user_id,provider,base_url,model_id,api_key_enc FROM ai_user_provider_settings ORDER BY user_id').all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].api_key_enc, firstKey);
  assert.match(rows[0].api_key_enc, /^oddc1:/);
  assert.equal(decryptCredential(rows[0].api_key_enc), firstKey);
  assert.equal(decryptCredential(rows[1].api_key_enc), secondKey);
  assert.equal(db.prepare('SELECT api_key_enc FROM ai_provider_settings WHERE id=1').get().api_key_enc.startsWith('oddc1:'), true);

  const checked = await manager.checkProvider(operatorOne);
  assert.equal(checked.modelAvailable, true);
  assert.equal(providerCalls.at(-1).url, 'https://one.example/v1/models');
  assert.equal(providerCalls.at(-1).options.headers.authorization, `Bearer ${firstKey}`);

  assert.throws(() => manager.saveSettings({
    scope: 'workspace', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'shared-next',
  }, operatorOne), error => error.statusCode === 403);

  db.close();
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  manager = makeManager();
  assert.equal(manager.getSettings(operatorOne).model, 'private-model-1', 'personal provider persists across database reopen');
  assert.equal(manager.getSettings(operatorTwo).model, 'private-model-2');
  assert.equal(manager.clearPersonalSettings(operatorOne).source, 'workspace');
  assert.equal(manager.getSettings(operatorOne).baseUrl, 'https://shared.example/v1');
  assert.equal(manager.getSettings(operatorTwo).baseUrl, 'https://two.example/v1', 'clearing one account does not change another');
});

test('personal provider overrides service defaults only for its account; other users retain the environment fallback', () => {
  process.env.ODD_AI_PROVIDER = 'openai-compatible';
  process.env.ODD_AI_BASE_URL = 'https://service.example/v1';
  process.env.ODD_AI_MODEL = 'service-model';
  process.env.ODD_AI_API_KEY = 'synthetic-service-key';

  assert.equal(manager.getSettings(operatorTwo).source, 'personal');
  const other = manager.getSettings({ id: 1, role: 'owner' });
  assert.equal(other.source, 'environment');
  assert.equal(other.baseUrl, 'https://service.example/v1');
  assert.equal(other.model, 'service-model');
  assert.equal(JSON.stringify(other).includes('synthetic-service-key'), false);

  delete process.env.ODD_AI_PROVIDER;
  delete process.env.ODD_AI_BASE_URL;
  delete process.env.ODD_AI_MODEL;
  delete process.env.ODD_AI_API_KEY;
});
