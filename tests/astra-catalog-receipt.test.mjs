import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createFreeInferenceClient } from '../pipeline/astra-freeinference-client.js';

test('saved account selection reuses only a current credential-bound exact model receipt', async () => {
  const before = process.env.FREEINFERENCE_API_KEY;
  const key = 'synthetic-only-catalog-receipt-key';
  process.env.FREEINFERENCE_API_KEY = key;
  try {
    const fields = { model: 'glm-5.3-flash', verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const sign = value => ({ ...value, accountBinding: createHmac('sha256', key).update(JSON.stringify(value)).digest('hex') });
    const receipt = sign(fields);
    let calls = 0;
    const client = createFreeInferenceClient({ approvedModel: fields.model, catalogReceipt: receipt, fetchImpl: async () => { calls++; throw new Error('No catalog request should run'); } });
    assert.equal(await client.discoverModels(), 'glm-5.3-flash'); assert.equal(calls, 0);
    for (const invalid of [
      { ...receipt, model: 'glm-5.3' }, { ...receipt, accountBinding: '0'.repeat(64) },
      sign({ ...fields, expiresAt: 'invalid' }), sign({ ...fields, expiresAt: new Date(Date.now() - 500).toISOString() }),
    ]) assert.throws(() => createFreeInferenceClient({ approvedModel: fields.model, catalogReceipt: invalid }), error => error.code === 'invalid_catalog_receipt');
    process.env.FREEINFERENCE_API_KEY = 'different-synthetic-account';
    assert.throws(() => createFreeInferenceClient({ approvedModel: fields.model, catalogReceipt: receipt }), error => error.code === 'invalid_catalog_receipt');
  } finally {
    if (before === undefined) delete process.env.FREEINFERENCE_API_KEY;
    else process.env.FREEINFERENCE_API_KEY = before;
  }
});
