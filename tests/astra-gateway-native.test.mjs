import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { validateAstraGatewayR34Fixture } from './support/astra-gateway-r34-fixture.mjs';
import { createAstraTenantStore } from '../pipeline/astra-tenant-store.js';
import { settleAstraUsage, reconcileAstraUsageFromReceipt } from '../pipeline/astra-usage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = process.env.ASTRA_GATEWAY_R34_FIXTURE_PATH;
const approved034Sha256 = '3f4dee260d8273bd4c92f758931c19cf9ae3ba9ee9f5a876c2202317d6a7e1b8';

test('real synthetic PG34 persists billing, malformed-output receipts, overruns, reconciliation and tenant isolation', {
  skip: !fixturePath ? 'Requires the dedicated synthetic gateway-telemetry-r34 fixture' : false,
}, async t => {
  const fixture = await validateAstraGatewayR34Fixture({ root, fixturePath: path.resolve(fixturePath), approved034Sha256 });
  const store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
  const userId = String(1_000_000 + randomBytes(4).readUInt32BE(0));
  const first = await store.createTenant({ name: 'Synthetic gateway integration', userId });
  const second = await store.createTenant({ name: 'Synthetic gateway foreign scope', userId });
  const context = { tenantId: first.tenantId, userId };
  let retainedRequestId;
  try {
    async function seed(db) {
      const requestId = randomUUID();
      await db.query(`INSERT INTO astra.ai_usage_requests
        (tenant_id,id,task,provider,model,data_classification,state,idempotency_key,input_payload,max_input_tokens,max_output_tokens,reserved_microusd)
        VALUES($1,$2,'subject_polish','glm-5.3-api','GLM-5.3','synthetic-fixture','running',$3,'{}',2048,100,100)`,
      [first.tenantId, requestId, randomUUID()]);
      return requestId;
    }
    const receipt = { responseVerified: true, actualProvider: 'freeinference', actualModel: 'glm-5.3-flash',
      inputTokens: 10, outputTokens: 20, reasoningTokens: 2, providerRequestId: 'synthetic-native-pg-only' };
    for (const scenario of [
      { name: 'unknown provider cost stays null and reserved', input: { status: 'succeeded', ...receipt }, state: 'uncertain', accounting: 'unknown', reserved: 100, cost: null },
      { name: 'complete billing settles once', input: { status: 'succeeded', ...receipt, actualCostMicrousd: 25, actualCostSource: 'provider_usage.cost_microusd' }, state: 'succeeded', accounting: 'settled', reserved: 25, cost: 25 },
      { name: 'rejected business output retains known billing and error', input: { status: 'uncertain', ...receipt, actualCostMicrousd: 25, actualCostSource: 'provider_usage.cost_microusd', errorCode: 'glm_output_schema_mismatch' }, state: 'succeeded', accounting: 'settled', reserved: 100, cost: 25 },
      { name: 'overrun records known cost without releasing its reservation', input: { status: 'succeeded', ...receipt, actualCostMicrousd: 150, actualCostSource: 'provider_usage.cost_microusd' }, state: 'succeeded', accounting: 'settled', reserved: 150, cost: 150 },
    ]) await t.test(scenario.name, () => store.withTenant(context, async db => {
      const requestId = await seed(db);
      retainedRequestId = requestId;
      await settleAstraUsage(db, first.tenantId, requestId, scenario.input);
      const row = (await db.query(`SELECT state,accounting_status,reserved_microusd,cost_microusd,error_code,
        actual_provider,actual_model,response_verified FROM astra.ai_usage_requests WHERE tenant_id=$1 AND id=$2`,
      [first.tenantId, requestId])).rows[0];
      assert.equal(row.state, scenario.state);
      assert.equal(row.accounting_status, scenario.accounting);
      assert.equal(Number(row.reserved_microusd), scenario.reserved);
      assert.equal(row.cost_microusd === null ? null : Number(row.cost_microusd), scenario.cost);
      assert.equal(row.response_verified, true);
      assert.equal(row.actual_provider, 'freeinference');
      assert.equal(row.actual_model, 'glm-5.3-flash');
      if (scenario.input.errorCode) assert.equal(row.error_code, scenario.input.errorCode);
      if (scenario.state === 'succeeded') assert.equal(await settleAstraUsage(db, first.tenantId, requestId, scenario.input), false,
        'settled request cannot settle again');
    }));
    await t.test('signed overrun reconciliation preserves a complete terminal receipt', () => store.withTenant(context, async db => {
      const requestId = await seed(db);
      await db.query("UPDATE astra.ai_usage_requests SET state='uncertain' WHERE tenant_id=$1 AND id=$2", [first.tenantId, requestId]);
      const secret = randomBytes(32).toString('hex');
      const at = new Date().toISOString();
      const receipt = { providerRequestId: 'synthetic-signed-reconciliation', inputTokens: 10, outputTokens: 20, costMicrousd: 150, at };
      receipt.signature = createHmac('sha256', secret).update(`${first.tenantId}\n${requestId}\n${receipt.providerRequestId}\n10\n20\n150\n${at}`).digest('hex');
      const result = await reconcileAstraUsageFromReceipt(db, first.tenantId, requestId, receipt, { secret });
      assert.equal(result.state, 'succeeded');
      assert.equal(result.accountingStatus, 'settled');
      assert.equal(result.reservedMicrousd, 150);
    }));
    await t.test('foreign workspace cannot read or settle the saved usage', () => store.withTenant({ tenantId: second.tenantId, userId }, async db => {
      assert.equal((await db.query('SELECT id FROM astra.ai_usage_requests WHERE tenant_id=$1 AND id=$2', [first.tenantId, retainedRequestId])).rows.length, 0);
      assert.equal(await settleAstraUsage(db, first.tenantId, retainedRequestId, { status: 'failed' }), false);
    }));
    await t.test('verified receipt with null identity is rejected by PostgreSQL', () => store.withTenant(context, async db => {
      const requestId = await seed(db);
      await db.query('SAVEPOINT invalid_receipt');
      await assert.rejects(db.query('UPDATE astra.ai_usage_requests SET response_verified=true WHERE tenant_id=$1 AND id=$2', [first.tenantId, requestId]), error => error.code === '23514');
      await db.query('ROLLBACK TO SAVEPOINT invalid_receipt');
    }));
  } finally { await store.close(); }
});
