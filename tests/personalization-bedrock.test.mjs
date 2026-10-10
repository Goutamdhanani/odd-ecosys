import { test } from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-bedrock-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const {
  acceptPolishedDraft,
  callBedrock,
  getPersonalizationProviderStatus,
  getPersonalizationStatus,
} = await import('../pipeline/personalizer.js');

after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

test('B06: default Bedrock configuration is visible as disabled and unverified', () => {
  const status = getPersonalizationProviderStatus();
  assert.equal(status.bedrock.status, 'disabled');
  assert.equal(status.bedrock.enabled, false);
  assert.equal(status.bedrock.modelId, 'us.anthropic.claude-sonnet-5');
  assert.equal(status.bedrock.credentials, 'not_checked');
  assert.deepEqual(getPersonalizationStatus().providers, status);
});

test('B06: enabled provider status never claims credential validation before a request', () => {
  const status = getPersonalizationProviderStatus({ bedrock: {
    enabled: true, region: 'us-east-1', polish_model: 'us.anthropic.claude-sonnet-5',
  } });
  assert.equal(status.bedrock.status, 'enabled_unverified');
  assert.equal(status.bedrock.credentials, 'not_checked');
});

test('B06: official SDK adapter builds one bounded InvokeModel request and accepts its response', async () => {
  let clientOptions;
  let commandInput;
  let sendOptions;
  let destroyed = false;
  class FixtureClient {
    constructor(options) { clientOptions = options; }
    async send(command, options) {
      commandInput = command.input;
      sendOptions = options;
      return { $metadata: { requestId: 'synthetic-bedrock-request' }, body: new TextEncoder().encode(JSON.stringify({
        id: 'synthetic-message',
        content: [{ type: 'text', text: 'A quick idea for your site' }],
        usage: { input_tokens: 12, output_tokens: 7 },
      })) };
    }
    destroy() { destroyed = true; }
  }
  class FixtureCommand {
    constructor(input) { this.input = input; }
  }
  const modelId = 'us.anthropic.claude-sonnet-5';
  const result = await callBedrock(
    { subject_line: 'Original subject', body_text: 'Original body' },
    { business_name: 'Acme' },
    { bedrock: { enabled: true, region: 'us-east-1', polish_model: modelId, timeout_ms: 5000 }, guardrails: { max_subject_chars: 60 } },
    { BedrockRuntimeClient: FixtureClient, InvokeModelCommand: FixtureCommand },
  );

  assert.equal(clientOptions.region, 'us-east-1');
  assert.equal(clientOptions.maxAttempts, 1, 'a transient retry must not silently create additional billed inference calls');
  assert.equal(commandInput.modelId, modelId);
  assert.equal(commandInput.contentType, 'application/json');
  assert.equal(commandInput.accept, 'application/json');
  const requestBody = JSON.parse(commandInput.body);
  assert.equal(requestBody.anthropic_version, 'bedrock-2023-05-31');
  assert.equal(requestBody.max_tokens, 100);
  assert.match(requestBody.messages[0].content, /Original subject/);
  assert.match(requestBody.messages[0].content, /Acme/);
  assert.ok(sendOptions.abortSignal instanceof AbortSignal);
  assert.equal(result.subject_line, 'A quick idea for your site');
  assert.equal(result.polished, true);
  assert.equal(result.model_used, `bedrock:${modelId}`);
  assert.equal(destroyed, true);
  const usage = db.prepare('SELECT provider,operation,model_id,status,input_tokens,output_tokens,provider_request_id,rate_card_id,cost_usd FROM ai_usage_events').get();
  assert.deepEqual(usage, {
    provider: 'bedrock', operation: 'subject_polish', model_id: modelId,
    status: 'succeeded', input_tokens: 12, output_tokens: 7,
    provider_request_id: 'synthetic-bedrock-request', rate_card_id: null, cost_usd: null,
  });
});

test('B06: disabled and malformed Bedrock calls fail without constructing a client', async () => {
  let constructed = false;
  class FixtureClient { constructor() { constructed = true; } }
  class FixtureCommand {}
  await assert.rejects(
    callBedrock({}, {}, { bedrock: { enabled: false } }, { BedrockRuntimeClient: FixtureClient, InvokeModelCommand: FixtureCommand }),
    error => error.code === 'BEDROCK_DISABLED',
  );
  assert.equal(constructed, false);
});

test('B06: Bedrock output must fit existing subject limits and polished output must pass copy guardrails', async () => {
  class FixtureClient { async send() { return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: 'free offer just for you' }] })) }; } destroy() {} }
  class FixtureCommand { constructor(input) { this.input = input; } }
  await assert.rejects(
    callBedrock({ subject_line: 'Original subject', body_text: 'Original body' }, {}, {
      bedrock: { enabled: true, region: 'us-east-1', polish_model: 'fixture', timeout_ms: 5000 },
      guardrails: { max_subject_chars: 10 },
    }, { BedrockRuntimeClient: FixtureClient, InvokeModelCommand: FixtureCommand }),
    error => error.code === 'BEDROCK_INVALID_SUBJECT',
  );

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
