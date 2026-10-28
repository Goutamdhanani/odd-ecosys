import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FREEINFERENCE_ENDPOINTS } from '../pipeline/astra-freeinference-client.js';
import { GLM_ACTUAL_MODEL, GLM_ACTUAL_PROVIDER, GLM_ENDPOINT, GLM_MODEL, GLM_PROVIDER } from '../pipeline/astra-egress.js';
import { executeAstraGlmRequest, getAstraGlmTaskSpec, runAstraGenerationTask } from '../pipeline/astra-glm-gateway.js';
import { generationProviderContract, getAstraGenerationJob } from '../pipeline/astra-generation.js';

const originalFetch = globalThis.fetch;
const requiredReceiptColumns = ['actual_provider','actual_model','reasoning_tokens','provider_quota',
  'actual_cost_source','response_verified','accounting_status'];
let nextCompletion = null;
const fetchCalls = [];

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function syntheticRegistry() {
  const ids = ['SYNTHETIC-ONLY-APPROVAL-A', 'SYNTHETIC-ONLY-APPROVAL-B'];
  return {
    schemaVersion: 1,
    runtimeGate: { syntheticFixtureOnly: true, acceptedDataClassification: 'synthetic-fixture', requiredDecisionIds: ids },
    decisions: ids.map(id => ({ id, status: 'approved', enabled: true, approvalEvidence: {
      approvedBy: 'synthetic unit fixture only', documentPath: 'tests/fixtures/synthetic-gate-only', documentSha256: 'a'.repeat(64),
      approvedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
    } })),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function makeNativeCompletion(body) {
  const completion = nextCompletion || {};
  return json({
    id: completion.id || `synthetic-${fetchCalls.filter(call => call.method === 'POST').length}`,
    model: completion.model || body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: completion.content || '{"prediction":"yes"}' }, finish_reason: 'stop' }],
    usage: completion.usage || { prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } },
  }, { headers: { 'x-ratelimit-remaining': '6', 'x-secret-like': 'never-persist-this' } });
}

test.before(() => {
  // This is an isolated synthetic test process. The shell runner strips all real keys first.
  delete process.env.ASTRA_GLM_API_KEY;
  process.env.FREEINFERENCE_API_KEY = 'synthetic-only-test-key';
  process.env.ASTRA_GLM_LOCAL_PREVIEW = 'false';
  process.env.ASTRA_GLM_EGRESS_ENABLED = 'true';
  globalThis.fetch = async (url, init = {}) => {
    if (url !== FREEINFERENCE_ENDPOINTS.models && url !== FREEINFERENCE_ENDPOINTS.chatCompletions) {
      throw new Error('Synthetic native-egress guard rejected an unexpected URL.');
    }
    fetchCalls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url === FREEINFERENCE_ENDPOINTS.models) {
      return json({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }] });
    }
    return makeNativeCompletion(JSON.parse(init.body));
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FREEINFERENCE_API_KEY;
  delete process.env.ASTRA_GLM_LOCAL_PREVIEW;
  delete process.env.ASTRA_GLM_EGRESS_ENABLED;
  delete process.env.ASTRA_GLM_API_KEY;
});

class SyntheticUsageDb {
  constructor({ requestId, tenantId, input, task = 'optimizer_dev_prediction', receiptColumns = requiredReceiptColumns }) {
    this.request = {
      id: requestId, task, data_classification: 'synthetic-fixture', state: 'queued', input_payload: input,
      input_hash: createHash('sha256').update(canonical(input)).digest('hex'), max_input_tokens: 4096,
      max_output_tokens: 100, offer_version_id: null, reserved_microusd: '100',
    };
    this.tenantId = tenantId;
    this.receiptColumns = receiptColumns;
    this.persisted = null;
    this.sql = [];
  }

  async query(sql, params = []) {
    this.sql.push({ sql, params });
    if (sql.includes('information_schema.columns')) return { rows: this.receiptColumns.map(column_name => ({ column_name })) };
    if (sql.includes('SELECT id,task,data_classification,state,input_payload')) return { rows: [{ ...this.request }], rowCount: 1 };
    if (sql.includes('FROM astra.ai_global_limits WHERE singleton=true FOR UPDATE')) return { rows: [{ enabled: true,
      daily_budget_microusd: '1000', breaker_state: 'closed', breaker_open_until: null, breaker_probe_request_id: null }] };
    if (sql.includes('FROM astra.ai_tenant_policies WHERE tenant_id=$1::uuid FOR UPDATE')) return { rows: [{ enabled: true,
      allowed_tasks: ['optimizer_dev_prediction'], daily_budget_microusd: '500', reservation_microusd: '100',
      max_input_tokens: 4096, max_output_tokens: 200 }] };
    if (sql.startsWith('SELECT reserved_microusd FROM astra.ai_usage_requests')) return { rows: [{ reserved_microusd: '100' }], rowCount: 1 };
    if (sql.includes('SELECT COALESCE(SUM(reserved_microusd),0)::bigint AS used FROM astra.ai_usage_requests')) return { rows: [{ used: '0' }] };
    if (sql.includes('SELECT astra.ai_global_reserved_today() AS used')) return { rows: [{ used: '0' }] };
    if (sql.includes("UPDATE astra.ai_usage_requests SET state='running'")) {
      this.request.state = 'running';
      return { rows: [{ id: this.request.id }], rowCount: 1 };
    }
    if (sql.includes("UPDATE astra.ai_usage_requests SET state='failed',reserved_microusd=0")) {
      this.request.state = 'failed';
      this.request.reserved_microusd = '0';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE astra.ai_usage_requests SET state=$3,input_tokens=NULL,output_tokens=NULL')) {
      this.persisted = { state: params[2], inputTokens: null, outputTokens: null, reasoningTokens: null,
        actualProvider: null, actualModel: null, responseVerified: false, providerRequestId: null,
        errorCode: params[3], actualCostMicrousd: null, reservedMicrousd: params[4], providerQuota: null,
        actualCostSource: null, accountingStatus: 'migration_required' };
      this.request.state = params[2];
      this.request.reserved_microusd = String(params[4]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE astra.ai_usage_requests SET state=$3,input_tokens=$4')) {
      this.persisted = { state: params[2], inputTokens: params[3], outputTokens: params[4], reasoningTokens: params[5],
        actualProvider: params[6], actualModel: params[7], responseVerified: params[8], providerRequestId: params[9],
        errorCode: params[10], actualCostMicrousd: params[11], reservedMicrousd: params[12], providerQuota: params[13],
        actualCostSource: params[14], accountingStatus: params[15] };
      this.request.state = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE astra.ai_global_limits SET failure_count=')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected synthetic database query: ${sql.slice(0, 90)}`);
  }
}

async function executeSyntheticOptimizerRequest(input, { receiptColumns = requiredReceiptColumns } = {}) {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const tenantId = '00000000-0000-4000-8000-000000000002';
  const db = new SyntheticUsageDb({ requestId, tenantId, input, receiptColumns });
  const tenantStore = { withTenant: async (_context, callback) => callback(db) };
  const result = await executeAstraGlmRequest({ tenantStore, tenantId, userId: '1', requestId,
    registryReader: async () => syntheticRegistry() });
  return { result, db };
}

test('canonical optimizer and generation paths share exact native model with separate identity and accounting receipts', async () => {
  const input = { candidateText: 'safe-guideline', featurePacket: { featureA: 1 }, declaredLabels: ['yes', 'no'] };
  nextCompletion = { id: 'synthetic-optimizer-no-cost', content: '{"prediction":"yes"}', usage: {
    prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 },
  } };
  const noCost = await executeSyntheticOptimizerRequest(input);
  assert.deepEqual(noCost.result.logical, { provider: GLM_PROVIDER, model: GLM_MODEL });
  assert.deepEqual(noCost.result.actual, { provider: GLM_ACTUAL_PROVIDER, model: GLM_ACTUAL_MODEL, endpoint: GLM_ENDPOINT });
  assert.equal(noCost.result.responseStatus, 'verified');
  assert.equal(noCost.result.accountingStatus, 'unknown');
  assert.equal(noCost.result.usage.status, 'uncertain');
  assert.equal(noCost.result.data.prediction, 'yes');
  assert.equal(noCost.result.usage.actualCostMicrousd, null);
  assert.equal(noCost.db.persisted.responseVerified, true);
  assert.equal(noCost.db.persisted.actualProvider, 'freeinference');
  assert.equal(noCost.db.persisted.actualModel, 'glm-5.3-flash');
  assert.equal(noCost.db.persisted.reasoningTokens, 1);
  assert.equal(noCost.db.persisted.actualCostMicrousd, null);
  assert.equal(noCost.db.persisted.reservedMicrousd, 100);
  assert.equal(noCost.db.persisted.accountingStatus, 'unknown');
  assert.equal(JSON.stringify(noCost.db.persisted.providerQuota).includes('never-persist-this'), false);

  nextCompletion = { id: 'synthetic-optimizer-cost', content: '{"prediction":"yes"}', usage: {
    prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 }, cost_microusd: 25,
  } };
  const reportedCost = await executeSyntheticOptimizerRequest(input);
  assert.equal(reportedCost.result.usage.status, 'succeeded');
  assert.equal(reportedCost.result.accountingStatus, 'settled');
  assert.equal(reportedCost.db.persisted.actualCostMicrousd, 25);
  assert.equal(reportedCost.db.persisted.actualCostSource, 'provider_usage.cost_microusd');
  assert.equal(reportedCost.db.persisted.reservedMicrousd, 25);

  nextCompletion = { id: 'synthetic-generation-no-cost', content: '{"subject_line":"Reviewed subject"}', usage: {
    prompt_tokens: 9, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 },
  } };
  const generation = await runAstraGenerationTask({ task: 'subject_polish', dataClassification: 'synthetic-fixture',
    input: { draftSubject: 'Synthetic subject' }, registryReader: async () => syntheticRegistry() });
  assert.deepEqual(generation.logical, { provider: GLM_PROVIDER, model: GLM_MODEL });
  assert.deepEqual(generation.actual, { provider: GLM_ACTUAL_PROVIDER, model: GLM_ACTUAL_MODEL, endpoint: GLM_ENDPOINT });
  assert.equal(generation.responseStatus, 'verified');
  assert.equal(generation.accountingStatus, 'unknown');
  assert.equal(generation.data.subject_line, 'Reviewed subject');

  const getCalls = fetchCalls.filter(call => call.method === 'GET');
  const postCalls = fetchCalls.filter(call => call.method === 'POST');
  assert.equal(getCalls.length, 1, 'one lazy catalog selection is shared across canonical roles');
  assert.equal(postCalls.length, 3);
  for (const call of postCalls) {
    assert.equal(call.body.model, 'glm-5.3-flash');
    assert.equal(call.body.stream, false);
    assert.equal(call.body.response_format.type, 'json_object');
    assert.equal(Object.hasOwn(call.body, 'thinking'), false);
  }
});

test('native dispatch fails before any provider call when receipt migration 034 is absent', async () => {
  const input = { candidateText: 'safe-guideline', featurePacket: { featureA: 1 }, declaredLabels: ['yes', 'no'] };
  const beforeCalls = fetchCalls.length;
  const blocked = await executeSyntheticOptimizerRequest(input, { receiptColumns: [] }).catch(error => error);
  assert.equal(blocked.code, 'glm_receipt_schema_unavailable');
  assert.equal(fetchCalls.length, beforeCalls, 'missing receipt columns prevent both catalog GET and inference POST');
});

test('verified response usage survives structured-output rejection without retry', async () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const tenantId = '00000000-0000-4000-8000-000000000002';
  const input = { candidateText: 'safe-guideline', featurePacket: { featureA: 1 }, declaredLabels: ['yes', 'no'] };
  const db = new SyntheticUsageDb({ requestId, tenantId, input });
  const tenantStore = { withTenant: async (_context, callback) => callback(db) };
  nextCompletion = { id: 'synthetic-invalid-json-shape', content: '{"prediction":"yes","extra":"reject"}', usage: {
    prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 }, cost_microusd: 25,
  } };
  const beforePosts = fetchCalls.filter(call => call.method === 'POST').length;
  await assert.rejects(executeAstraGlmRequest({ tenantStore, tenantId, userId: '1', requestId,
    registryReader: async () => syntheticRegistry() }), error => error.code === 'glm_output_schema_mismatch');
  const afterPosts = fetchCalls.filter(call => call.method === 'POST').length;
  assert.equal(afterPosts - beforePosts, 1, 'a malformed structured result is never retried');
  assert.equal(db.persisted.state, 'succeeded', 'complete billing is terminal even when business output is rejected');
  assert.equal(db.persisted.errorCode, 'glm_output_schema_mismatch');
  assert.equal(db.persisted.responseVerified, true);
  assert.equal(db.persisted.actualProvider, 'freeinference');
  assert.equal(db.persisted.actualModel, GLM_ACTUAL_MODEL);
  assert.equal(db.persisted.inputTokens, 5);
  assert.equal(db.persisted.outputTokens, 3);
  assert.equal(db.persisted.reasoningTokens, 1);
  assert.equal(db.persisted.actualCostMicrousd, 25);
  assert.equal(db.persisted.actualCostSource, 'provider_usage.cost_microusd');
  assert.equal(db.persisted.accountingStatus, 'settled');
});

test('fixture 33 keeps queued generation reads and injected legacy transports unverified', async () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  const tenantId = '00000000-0000-4000-8000-000000000002';
  const input = { candidateText: 'safe-guideline', featurePacket: { featureA: 1 }, declaredLabels: ['yes', 'no'] };
  const db = new SyntheticUsageDb({ requestId, tenantId, input, receiptColumns: [] });
  const tenantStore = { withTenant: async (_context, callback) => callback(db) };
  let injectedCalls = 0;
  const result = await executeAstraGlmRequest({ tenantStore, tenantId, userId: '1', requestId,
    registryReader: async () => syntheticRegistry(), transport: async () => {
      injectedCalls += 1;
      return { id: 'synthetic-unverified', provider: 'freeinference', model: GLM_ACTUAL_MODEL,
        actualProvider: 'freeinference', actualModel: GLM_ACTUAL_MODEL, endpoint: GLM_ENDPOINT,
        choices: [{ message: { content: '{"prediction":"yes"}' } }],
        usage: { prompt_tokens: 9, completion_tokens: 3, cost_microusd: 1, actual_cost_source: 'provider_usage.cost_microusd' } };
    } });
  assert.equal(injectedCalls, 1);
  assert.equal(result.responseStatus, 'unverified');
  assert.equal(result.actual, null);
  assert.equal(result.usage.status, 'uncertain');
  assert.equal(result.usage.actualCostMicrousd, null);
  assert.equal(db.persisted.state, 'uncertain');
  assert.equal(db.persisted.actualProvider, null);
  assert.equal(db.persisted.actualModel, null);
  assert.equal(db.persisted.actualCostMicrousd, null);
  assert.equal(Number(db.persisted.reservedMicrousd), 100);

  const legacyReads = [];
  const legacyDb = { async query(sql) {
    legacyReads.push(sql);
    if (sql.includes('information_schema.columns')) return { rows: [] };
    if (sql.includes('FROM astra.generation_jobs WHERE tenant_id=$1 AND id=$2::uuid')) return { rows: [{
      id: requestId, task: 'campaign_generation', campaign_id: '00000000-0000-4000-8000-000000000003',
      reply_message_id: null, campaign_copy_version: 2, offer_version_id: 4, offer_content_hash: 'a'.repeat(64),
      evidence_hash: 'b'.repeat(64), placeholder_version: 1, placeholder_hash: 'c'.repeat(64), state: 'queued',
      reserved_microusd: '100', input_tokens: null, output_tokens: null, actual_cost_microusd: null,
      provider_request_id: null, result_payload: null, error_code: null, created_by: '1', created_at: new Date(),
      started_at: null, completed_at: null, actual_provider: null, actual_model: null, reasoning_tokens: null,
      provider_quota: null, actual_cost_source: null, response_verified: null, accounting_status: null,
    }], rowCount: 1 };
    throw new Error(`Unexpected fixture-33 read: ${sql.slice(0, 80)}`);
  } };
  const job = await getAstraGenerationJob(legacyDb, tenantId, requestId);
  assert.equal(job.status, 'queued');
  assert.equal(job.receiptTelemetryReady, false);
  assert.equal(job.actual, null);
  assert.equal(job.responseStatus, 'unknown');
  assert.equal(job.accountingStatus, 'migration_required');
  assert.ok(legacyReads.some(sql => sql.includes('NULL::text AS actual_provider')));
});

test('exact client target, capability contract, and pre-dispatch guards remain explicit', async () => {
  assert.equal(GLM_ENDPOINT, FREEINFERENCE_ENDPOINTS.chatCompletions);
  const spec = getAstraGlmTaskSpec('campaign_generation');
  assert.deepEqual(spec.logical, { provider: GLM_PROVIDER, model: GLM_MODEL });
  assert.deepEqual(spec.actual, { provider: GLM_ACTUAL_PROVIDER, model: GLM_ACTUAL_MODEL, endpoint: GLM_ENDPOINT });
  assert.deepEqual(spec.capabilities, { structuredOutput: true, streaming: false, toolCalls: false, reasoningEffort: false });
  assert.deepEqual(generationProviderContract().actual, spec.actual);
  assert.equal(generationProviderContract().capabilities.streaming, false);

  const callsBefore = fetchCalls.length;
  delete process.env.FREEINFERENCE_API_KEY;
  process.env.ASTRA_GLM_API_KEY = 'synthetic-old-key-must-not-fallback';
  let transportCalled = false;
  await assert.rejects(runAstraGenerationTask({ task: 'subject_polish', dataClassification: 'synthetic-fixture',
    input: { draftSubject: 'synthetic' }, registryReader: async () => syntheticRegistry(),
    transport: async () => { transportCalled = true; throw new Error('unexpected'); } }), error => error.code === 'glm_credentials_unavailable');
  assert.equal(transportCalled, false);
  assert.equal(fetchCalls.length, callsBefore);
  delete process.env.ASTRA_GLM_API_KEY;
  process.env.FREEINFERENCE_API_KEY = 'synthetic-only-test-key';

  process.env.ASTRA_GLM_LOCAL_PREVIEW = 'true';
  await assert.rejects(runAstraGenerationTask({ task: 'subject_polish', dataClassification: 'synthetic-fixture',
    input: { draftSubject: 'synthetic' }, registryReader: async () => syntheticRegistry(),
    transport: async () => { transportCalled = true; throw new Error('unexpected'); } }), error => error.code === 'glm_local_preview_egress_denied');
  assert.equal(transportCalled, false);
  process.env.ASTRA_GLM_LOCAL_PREVIEW = 'false';
});

test('migration 034 is additive and leaves all historical Astra migrations untouched', async () => {
  const up = await readFile(new URL('../migrations/astra/034-freeinference-telemetry.up.sql', import.meta.url), 'utf8');
  const down = await readFile(new URL('../migrations/astra/034-freeinference-telemetry.down.sql', import.meta.url), 'utf8');
  for (const table of ['astra.ai_usage_requests', 'astra.generation_jobs']) {
    assert.match(up, new RegExp(`ALTER TABLE ${table.replace('.', '\\.')}\\s+ADD COLUMN actual_provider`));
    for (const column of requiredReceiptColumns) assert.ok(up.includes(`ADD COLUMN ${column}`), `missing additive column ${column}`);
  }
  assert.doesNotMatch(up, /\b(UPDATE|DELETE FROM|DROP COLUMN|TRUNCATE)\b/i);
  assert.match(up, /CHECK \(actual_model IS NULL OR actual_model = 'glm-5\.3-flash'\)/);
  assert.match(up, /CHECK \(actual_provider IS NULL OR actual_provider = 'freeinference'\)/);
  assert.equal((up.match(/response_verified IS TRUE AND actual_provider IS NOT DISTINCT FROM 'freeinference'\s+AND actual_model IS NOT DISTINCT FROM 'glm-5\.3-flash'/g) || []).length, 2,
    'both receipt constraints must reject a verified response with either identity field NULL');
  assert.doesNotMatch(up, /jsonb_object_length/, 'quota keys are bounded by the allowlist without unsupported PostgreSQL functions');
  for (const column of requiredReceiptColumns) assert.ok(down.includes(`DROP COLUMN IF EXISTS ${column}`), `missing rollback for ${column}`);
});
