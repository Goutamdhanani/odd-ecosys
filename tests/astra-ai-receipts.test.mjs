import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAstraAiRoutes } from '../pipeline/astra-ai-routes.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const otherTenantId = '00000000-0000-4000-8000-000000000003';
const receiptTypes = {
  actual_provider: 'text', actual_model: 'text', reasoning_tokens: 'integer', provider_quota: 'jsonb',
  actual_cost_source: 'text', response_verified: 'boolean', accounting_status: 'text',
};
const receiptColumns = Object.keys(receiptTypes);
const baseRow = {
  id: requestId, task: 'optimizer_dev_prediction', provider: 'glm-5.3-api', model: 'GLM-5.3',
  state: 'succeeded', data_classification: 'synthetic-fixture', reserved_microusd: '100',
  input_tokens: 5, output_tokens: 3, cost_microusd: '25', error_code: null,
  provider_request_id: 'synthetic-provider-receipt', created_at: '2026-10-27T00:00:00.000Z',
  started_at: '2026-10-27T00:00:01.000Z', completed_at: '2026-10-27T00:00:02.000Z',
};
const verifiedRow = {
  ...baseRow, actual_provider: 'freeinference', actual_model: 'glm-5.3-flash', response_verified: true,
  reasoning_tokens: 2, provider_quota: { 'x-quota-remaining': '9' },
  actual_cost_source: 'provider_usage.cost_microusd', accounting_status: 'settled',
};

function syntheticDb({ schema34 = true, row = verifiedRow, schemaError, readError } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('information_schema.columns')) {
        assert.deepEqual(params, ['ai_usage_requests', receiptColumns]);
        if (schemaError) throw schemaError;
        return { rows: schema34 ? receiptColumns.map(column_name => ({ column_name })) : [] };
      }
      assert.match(sql, /FROM astra\.ai_usage_requests WHERE tenant_id=\$1::uuid AND id=\$2::uuid/);
      assert.deepEqual(params, [tenantId, requestId]);
      if (readError) throw readError;
      if (!schema34) {
        for (const [column, type] of Object.entries(receiptTypes)) {
          assert.ok(sql.includes(`NULL::${type} AS ${column}`), `schema 33 needs a typed null for ${column}`);
        }
      } else {
        assert.ok(sql.includes(receiptColumns.join(',')), 'schema 34 reads the stored receipt columns');
      }
      const selectedRow = !schema34 && row
        ? { ...row, ...Object.fromEntries(receiptColumns.map(column => [column, null])) } : row;
      return { rows: selectedRow ? [selectedRow] : [] };
    },
  };
}

async function poll(db, { actorTenantId = tenantId } = {}) {
  const registrations = [];
  registerAstraAiRoutes(route => registrations.push(route));
  const route = registrations.find(entry => entry.method === 'GET');
  const params = route.path.exec(`/api/astra/tenants/${tenantId}/ai/requests/${requestId}`)?.groups;
  assert.ok(params, 'request polling is registered on the tenant-scoped route');
  return route.handler({ method: 'GET' }, {}, {
    params, db, actor: { tenantId: actorTenantId, userId: '1', tenantRole: 'viewer' },
    sendJson: (_res, body, statusCode) => ({ body, statusCode }),
  });
}

test('request polling preserves legacy fields and returns the stored verified receipt', async () => {
  const db = syntheticDb();
  const { body: { data }, statusCode } = await poll(db);
  assert.equal(statusCode, 200);
  const legacyKeys = ['requestId', 'task', 'provider', 'model', 'status', 'dataClassification',
    'reservationMicrousd', 'inputTokens', 'outputTokens', 'costMicrousd', 'errorCode', 'providerRequestId',
    'createdAt', 'startedAt', 'completedAt'];
  assert.deepEqual(Object.fromEntries(legacyKeys.map(key => [key, data[key]])), {
    requestId, task: baseRow.task, provider: baseRow.provider, model: baseRow.model, status: baseRow.state,
    dataClassification: baseRow.data_classification, reservationMicrousd: 100, inputTokens: 5, outputTokens: 3,
    costMicrousd: 25, errorCode: null, providerRequestId: baseRow.provider_request_id,
    createdAt: baseRow.created_at, startedAt: baseRow.started_at, completedAt: baseRow.completed_at,
  });
  assert.deepEqual(data.logical, { provider: baseRow.provider, model: baseRow.model });
  assert.deepEqual(data.actual, { provider: verifiedRow.actual_provider, model: verifiedRow.actual_model });
  assert.equal(data.actualProvider, verifiedRow.actual_provider);
  assert.equal(data.actualModel, verifiedRow.actual_model);
  assert.equal(data.responseVerified, true);
  assert.equal(data.responseStatus, 'verified');
  assert.equal(data.receiptTelemetryReady, true);
  assert.equal(data.reasoningTokens, 2);
  assert.equal(data.accountingStatus, 'settled');
  assert.deepEqual(data.providerQuota, verifiedRow.provider_quota);
  assert.equal(data.actualCostSource, 'provider_usage.cost_microusd');
  assert.equal('endpoint' in data.actual, false, 'a poll response must not fabricate an endpoint receipt');
  assert.equal(db.calls.length, 2);
});

test('a verified response without reported cost keeps cost and its source null', async () => {
  const db = syntheticDb({ row: { ...verifiedRow, state: 'uncertain', cost_microusd: null,
    actual_cost_source: null, accounting_status: 'unknown', reasoning_tokens: null, provider_quota: null } });
  const { body: { data } } = await poll(db);
  assert.equal(data.costMicrousd, null);
  assert.equal(data.actualCostSource, null);
  assert.equal(data.reasoningTokens, null);
  assert.equal(data.providerQuota, null);
  assert.equal(data.responseVerified, true);
  assert.equal(data.accountingStatus, 'unknown');
  assert.equal(data.reservationMicrousd, 100);
});

test('unverified and unknown flags never turn logical approval into actual identity', async () => {
  for (const [storedFlag, responseStatus] of [[false, 'unverified'], [null, 'unknown']]) {
    const db = syntheticDb({ row: { ...verifiedRow, response_verified: storedFlag } });
    const { body: { data } } = await poll(db);
    assert.equal(data.responseVerified, storedFlag);
    assert.equal(data.responseStatus, responseStatus);
    assert.equal(data.actual, null);
    assert.equal(data.actualProvider, null);
    assert.equal(data.actualModel, null);
    assert.deepEqual(data.logical, { provider: baseRow.provider, model: baseRow.model });
  }
});

test('verified identity uses the exact stored pair and requires both identities', async () => {
  const stored = { ...verifiedRow, actual_provider: 'recorded-provider', actual_model: 'recorded-model' };
  const { body: { data } } = await poll(syntheticDb({ row: stored }));
  assert.deepEqual(data.actual, { provider: stored.actual_provider, model: stored.actual_model });
  const { body: { data: incomplete } } = await poll(syntheticDb({ row: { ...verifiedRow, actual_model: null } }));
  assert.equal(incomplete.actual, null);
  assert.equal(incomplete.actualProvider, null);
  assert.equal(incomplete.actualModel, null);
});

test('strict schema 33 reads typed-null aliases and reports unknown receipt telemetry', async () => {
  const db = syntheticDb({ schema34: false, row: baseRow });
  const { body: { data }, statusCode } = await poll(db);
  assert.equal(statusCode, 200);
  assert.equal(data.receiptTelemetryReady, false);
  assert.equal(data.responseStatus, 'unknown');
  for (const key of ['actual', 'actualProvider', 'actualModel', 'responseVerified', 'reasoningTokens',
    'accountingStatus', 'providerQuota', 'actualCostSource']) assert.equal(data[key], null, key);
  assert.equal(data.provider, baseRow.provider);
  assert.equal(data.model, baseRow.model);
  assert.equal(data.costMicrousd, 25, 'legacy cost history remains intact');
  assert.equal(db.calls.length, 2);
});

test('a foreign actor is rejected before schema or request queries', async () => {
  const db = syntheticDb();
  await assert.rejects(poll(db, { actorTenantId: otherTenantId }), error => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, 'tenant_membership_required');
    return true;
  });
  assert.equal(db.calls.length, 0);
});

test('a real schema-query fault propagates without a legacy fallback', async () => {
  const fault = Object.assign(new Error('Synthetic database connection failure'), { code: '08006' });
  const db = syntheticDb({ schemaError: fault });
  await assert.rejects(poll(db), error => error === fault);
  assert.equal(db.calls.length, 1);
});

test('a receipt SELECT fault propagates without retrying a legacy query', async () => {
  const fault = Object.assign(new Error('Synthetic SELECT failure'), { code: '42703' });
  const db = syntheticDb({ readError: fault });
  await assert.rejects(poll(db), error => error === fault);
  assert.equal(db.calls.length, 2);
});

test('a scoped missing request keeps the existing not-found error', async () => {
  const db = syntheticDb({ row: null });
  await assert.rejects(poll(db), error => {
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, 'ai_request_not_found');
    return true;
  });
  assert.equal(db.calls.length, 2);
});
