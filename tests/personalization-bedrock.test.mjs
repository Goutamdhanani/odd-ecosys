import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-bedrock-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { acceptPolishedDraft, callBedrock, getPersonalizationProviderStatus, getPersonalizationStatus } =
  await import('../pipeline/personalizer.js');

after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

test('personalization status exposes only the disabled tenant GLM gateway contract', () => {
  const status = getPersonalizationProviderStatus({ bedrock: {
    enabled: true, region: 'us-east-1', polish_model: 'synthetic-bedrock-model',
  } });
  assert.deepEqual(status, {
    provider: 'glm-5.3-api', model: 'GLM-5.3', status: 'tenant_gateway_required',
    egressEnabled: false, credentials: 'not_checked',
  });
  assert.deepEqual(getPersonalizationStatus().providers, status);
});

test('legacy Bedrock adapter fails closed before constructing or calling an SDK client', async () => {
  let constructed = 0;
  let sent = 0;
  class FixtureClient {
    constructor() { constructed++; }
    async send() { sent++; throw new Error('must not be called'); }
    destroy() {}
  }
  class FixtureCommand {}
  await assert.rejects(
    callBedrock({ subject_line: 'Original subject', body_text: 'Original body' }, { business_name: 'Synthetic Co' },
      { bedrock: { enabled: true } }, { BedrockRuntimeClient: FixtureClient, InvokeModelCommand: FixtureCommand }),
    error => error.code === 'glm_tenant_context_required' && error.statusCode === 503,
  );
  assert.equal(constructed, 0);
  assert.equal(sent, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_usage_events').get().count, 0,
    'a denied legacy call creates no provider usage record');
});

test('copy guardrails still reject unsafe polished subjects and retain the original draft', () => {
  const original = {
    subject_line: 'A practical idea for Acme',
    body_text: '{{business_name}}, your local customer feedback suggests a clear opportunity to make the current site easier to use. We can share a short example and a few simple options if that would be useful to your team. Would a brief overview help?',
  };
  const rejected = acceptPolishedDraft(original, {
    ...original, subject_line: 'Free offer just for you', polished: true, polished_by: 'bedrock:fixture',
  }, { business_name: 'Acme' });
  assert.equal(rejected.subject_line, original.subject_line);
  assert.equal(rejected.polished, false);
  assert.equal(rejected.polished_by, 'rejected_guardrails');
});
