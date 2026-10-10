import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-pagination-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Stable pages','discovery','open')").run().lastInsertRowid);
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

async function get(route) {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() };
}

test('contact cursor pagination remains deterministic across tied timestamps and concurrent inserts', async () => {
  const insert = db.prepare('INSERT INTO leads(batch_id,business_name,discovered_at) VALUES(?,?,?)');
  const tiedTimestamp = '2026-10-09 10:00:00';
  const originalIds = ['First', 'Second', 'Third'].map(name => Number(insert.run(batchId, name, tiedTimestamp).lastInsertRowid));

  const first = await get(`/api/leads?batch_id=${batchId}&limit=2`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.leads.map(lead => lead.id), originalIds.slice().reverse().slice(0, 2),
    'equal discovery timestamps use descending contact id as a stable tie-break');
  assert.equal(first.body.pagination.total, 3);
  assert.equal(first.body.pagination.hasMore, true);
  assert.ok(first.body.pagination.nextCursor);

  // A newly discovered contact sorts before the saved cursor. Keyset pagination
  // still returns every older row exactly once on the next page.
  const insertedBetweenPages = Number(insert.run(batchId, 'Inserted between pages', '2026-10-09 11:00:00').lastInsertRowid);
  const cursor = encodeURIComponent(first.body.pagination.nextCursor);
  const second = await get(`/api/leads?batch_id=${batchId}&limit=2&cursor=${cursor}`);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.leads.map(lead => lead.id), [originalIds[0]]);
  assert.equal(second.body.pagination.total, 4, 'filtered total reflects the new contact even though it does not shift this page');
  assert.equal(second.body.pagination.hasMore, false);
  assert.equal(second.body.pagination.nextCursor, null);
  assert.equal(second.body.leads.some(lead => lead.id === insertedBetweenPages), false);

  const allPagedIds = [...first.body.leads, ...second.body.leads].map(lead => lead.id);
  assert.equal(new Set(allPagedIds).size, allPagedIds.length, 'adjacent pages have no duplicates');

  const offsetPage = await get(`/api/leads?batch_id=${batchId}&limit=2&offset=2`);
  assert.equal(offsetPage.status, 200, 'legacy offset callers remain supported');
  assert.deepEqual(offsetPage.body.leads.map(lead => lead.id), [originalIds[1], originalIds[0]]);
  assert.equal((await get(`/api/leads?batch_id=${batchId}&limit=501`)).status, 400);
  assert.equal((await get(`/api/leads?batch_id=${batchId}&limit=2&cursor=not-a-cursor`)).status, 400);

  const legacyBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Legacy page rows','discovery','open')").run().lastInsertRowid);
  const legacyInsert = db.prepare('INSERT INTO leads(batch_id,business_name,discovered_at) VALUES(?,?,?)');
  const legacyIds = [
    Number(legacyInsert.run(legacyBatchId, 'Has date', '2025-01-01 00:00:00').lastInsertRowid),
    Number(legacyInsert.run(legacyBatchId, 'Missing date one', null).lastInsertRowid),
    Number(legacyInsert.run(legacyBatchId, 'Missing date two', null).lastInsertRowid),
  ];
  const legacyFirst = await get(`/api/leads?batch_id=${legacyBatchId}&limit=2`);
  assert.deepEqual(legacyFirst.body.leads.map(lead => lead.id), [legacyIds[0], legacyIds[2]]);
  assert.equal(legacyFirst.body.pagination.hasMore, true);
  const legacySecond = await get(`/api/leads?batch_id=${legacyBatchId}&limit=2&cursor=${encodeURIComponent(legacyFirst.body.pagination.nextCursor)}`);
  assert.deepEqual(legacySecond.body.leads.map(lead => lead.id), [legacyIds[1]]);
  assert.equal(legacySecond.body.pagination.hasMore, false);
});
