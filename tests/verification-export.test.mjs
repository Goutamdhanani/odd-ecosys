import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verification-export-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Export fixture','verification','open')").run().lastInsertRowid);
for (let id = 1; id <= 225; id++) {
  const business = id === 1 ? '=SUM(1,2)' : `Synthetic ${id}`;
  const email = id === 1 ? '=HYPERLINK("https://invalid.test")' : `person${id}@example.test`;
  const leadId = Number(db.prepare("INSERT INTO leads(id,batch_id,business_name,email,status) VALUES (?,? ,?,?,'discovered')").run(10000 + id, batchId, business, email).lastInsertRowid);
  const status = id === 225 ? null : id % 2 === 0 ? 'deliverable' : 'risky';
  const evidence = id === 1
    ? JSON.stringify({ engine: 'fixture', checks: { smtp: null }, reasons: ['=bad()'] })
    : JSON.stringify({ engine: 'fixture', checks: { regex: true }, reasons: [] });
  db.prepare('INSERT INTO lead_emails(lead_id,email,is_primary,verification_status,verification_json,verified_at,mx_host) VALUES (?,?,1,?,?,datetime(\'now\'),?)')
    .run(leadId, email, status, evidence, id === 1 ? 'mx,one.example.test' : 'mx.example.test');
  if (id === 1) db.prepare('INSERT INTO lead_emails(lead_id,email,is_primary,verification_status,verification_json) VALUES (?,?,0,?,?)')
    .run(leadId, 'alias@example.test', 'unknown', JSON.stringify({ checks: { smtp: null }, reason: '<unsafe text>' }));
}

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

async function fetchCsv(route) {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

test('verification CSV streams all stored primary and alias results with real evidence, safely quoted and formula-neutralized', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count;
  const response = await fetchCsv(`/api/verify/results/${batchId}/export`);
  const afterCount = db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="verification-batch-${batchId}.csv"`);
  assert.equal(afterCount, before, 'export must not mutate verification rows');

  const records = parse(response.text, { bom: true, columns: true });
  assert.equal(records.length, before);
  assert.deepEqual(Object.keys(records[0]), ['contact_id','email_id','business_name','email','status','verified_at','mx_host','engine','checks_json','reasons']);
  assert.equal(records.find(row => row.contact_id === '10001').business_name, "'=SUM(1,2)");
  assert.equal(records.find(row => row.contact_id === '10001' && row.email_id === '1').email, "'=HYPERLINK(\"https://invalid.test\")");
  assert.equal(records.find(row => row.contact_id === '10001' && row.email_id === '1').mx_host, 'mx,one.example.test');
  assert.equal(records.find(row => row.contact_id === '10001' && row.email_id === '1').reasons, '["=bad()"]');
  assert.ok(records.some(row => row.status === 'unknown'));
  assert.ok(records.some(row => row.status === 'risky' && row.engine === 'fixture'));
  assert.ok(records.every(row => !Object.hasOwn(row, 'score')), 'un-calibrated confidence scores are excluded');
});

test('status-filtered, invalid and missing-batch exports return accurate results and errors', async () => {
  const unknown = await fetchCsv(`/api/verify/results/${batchId}/export?status=unknown`);
  assert.equal(unknown.status, 200);
  const rows = parse(unknown.text, { bom: true, columns: true });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'unknown'));

  const invalid = await fetch(`${base}/api/verify/results/${batchId}/export?status=bogus`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /status must be/i);

  const missing = await fetch(`${base}/api/verify/results/999999/export`);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /batch not found/i);
});
