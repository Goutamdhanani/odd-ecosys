import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-request-body-limits-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;
delete process.env.ODD_AUTH_ENFORCE_TESTS;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Body limit fixture','discovery','open')").run().lastInsertRowid);
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('unbounded-default JSON routes accept normal input and reject bodies over 1 MiB with 413', async () => {
  const created = await fetch(`${base}/api/lists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Small request' }),
  });
  assert.equal(created.status, 201);

  const tooLarge = await fetch(`${base}/api/lists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Oversized request', padding: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.match((await tooLarge.json()).error, /body is too large/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM contact_lists WHERE name='Oversized request'").get().count, 0,
    'oversized input must not reach the list mutation');
});

test('CSV preview keeps its explicit larger payload allowance', async () => {
  const csv = `business_name,email,notes\nPreview Studio,preview@example.test,${'x'.repeat(1_100_000)}`;
  const response = await fetch(`${base}/api/leads/import/preview-sample`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId, csv, columnMap: { business_name: 'business_name', email: 'email' } }),
  });
  assert.equal(response.status, 200, 'the explicit CSV endpoint limit must override the conservative JSON default');
  const result = await response.json();
  assert.equal(result.batchId, batchId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count, 0,
    'preview must remain read-only even for a larger request');
});
