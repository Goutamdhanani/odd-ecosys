import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLeadStrategyManager } from '../pipeline/lead-strategy.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-personal-ai-settings-'));
const databasePath = path.join(directory, 'personal-ai.sqlite');
for (const name of [
  'ODD_AI_PROVIDER', 'ODD_AI_BASE_URL', 'ODD_AI_MODEL', 'ODD_AI_API_KEY', 'ODD_AI_TIMEOUT_MS',
  'ODD_OLLAMA_BASE_URL', 'ODD_OLLAMA_MODEL', 'FREEINFERENCE_API_BASE_URL', 'FREEINFERENCE_MODEL', 'FREEINFERENCE_API_KEY',
]) delete process.env[name];

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE auth_users (id INTEGER PRIMARY KEY)');
db.prepare('INSERT INTO auth_users(id) VALUES (?), (?), (?)').run(1, 2, 3);
const providerCalls = [];
const manager = createLeadStrategyManager({
  db,
  fetchImpl: async url => { providerCalls.push(String(url)); throw new Error('unexpected legacy provider call'); },
});
const owner = { id: 1, role: 'owner' };
const operatorOne = { id: 2, role: 'operator' };
const operatorTwo = { id: 3, role: 'operator' };

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test('legacy personal and workspace setting writes fail closed without persistence or provider checks', async () => {
  for (const [input, actor] of [
    [{ scope: 'workspace', provider: 'openai-compatible', baseUrl: 'https://shared.example/v1', model: 'shared', apiKey: 'synthetic-workspace-secret' }, owner],
    [{ scope: 'personal', provider: 'openai-compatible', baseUrl: 'https://one.example/v1', model: 'private-one', apiKey: 'synthetic-personal-secret-one' }, operatorOne],
    [{ scope: 'personal', provider: 'freeinference', baseUrl: 'https://two.example/v1', model: 'private-two', apiKey: 'synthetic-personal-secret-two' }, operatorTwo],
  ]) {
    assert.throws(() => manager.saveSettings(input, actor), error =>
      error.code === 'ai_legacy_provider_settings_disabled' && error.statusCode === 409);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_provider_settings').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_user_provider_settings').get().count, 0);

  assert.deepEqual(await manager.checkProvider(operatorOne, 'personal'), {
    connection: 'tenant_gateway_required', connected: false, modelAvailable: false,
    provider: 'glm-5.3-api', model: 'GLM-5.3', egressEnabled: false,
    note: 'The legacy strategy workflow cannot check providers directly.',
  });
  assert.deepEqual(providerCalls, []);
  for (const actor of [owner, operatorOne, operatorTwo]) {
    const settings = manager.getSettings(actor);
    assert.equal(settings.provider, 'glm-5.3-api');
    assert.equal(settings.baseUrl, '');
    assert.equal(settings.model, 'GLM-5.3');
    assert.equal(settings.personalConfigured, false);
  }
});

test('personal settings metadata is scoped to the authenticated user and never reveals stored secrets', () => {
  // A legacy row may exist from an earlier version. It is not an authorized
  // provider target, and one operator's row must not appear as another's.
  db.prepare(`INSERT INTO ai_user_provider_settings(user_id,provider,base_url,model_id,api_key_enc)
    VALUES(2,'openai-compatible','https://one-legacy.example/v1','legacy-one','oddc1:synthetic-secret-one'),
          (3,'ollama','http://127.0.0.1:11434','legacy-two',NULL)`).run();

  const first = manager.getSettings(operatorOne);
  const second = manager.getSettings(operatorTwo);
  assert.equal(first.personalConfigured, true);
  assert.equal(first.personalApiKeyConfigured, true);
  assert.equal(second.personalConfigured, true);
  assert.equal(second.personalApiKeyConfigured, false);
  assert.equal(first.baseUrl, '');
  assert.equal(second.baseUrl, '');
  assert.equal(first.model, 'GLM-5.3');
  assert.equal(second.model, 'GLM-5.3');
  assert.doesNotMatch(JSON.stringify(first), /one-legacy|synthetic-secret-one|legacy-one/);
  assert.doesNotMatch(JSON.stringify(second), /one-legacy|synthetic-secret-one|legacy-one/);
  assert.equal(providerCalls.length, 0);
});
