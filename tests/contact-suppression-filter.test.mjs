import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-suppression-filter-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Suppression filter','discovery','open')").run().lastInsertRowid);
db.exec(`
  INSERT INTO leads(id,batch_id,business_name,email,status) VALUES
    (61,${batchId},'Alias blocked','clear@example.test','discovered'),
    (62,${batchId},'Primary blocked','PRIMARY@example.test','disqualified'),
    (63,${batchId},'Clean contact',NULL,'discovered');
  INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES
    (61,'clear@example.test','fixture','deliverable',1),
    (61,'BLOCKED@EXAMPLE.TEST','fixture','risky',0),
    (62,'primary@example.test','fixture','deliverable',1);
  INSERT INTO suppression_list(email,reason) VALUES
    ('blocked@example.test','unsubscribe'),
    ('primary@example.test','complaint');
`);
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

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('Contacts list flags primary and alias suppressions and filters with accurate totals', async () => {
  const all = await request('/api/leads?limit=20');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.leads.map(lead => [lead.id, lead.has_suppressed_email]), [[63, 0], [62, 1], [61, 1]]);

  const suppressed = await request('/api/leads?suppression_status=suppressed&sort_by=business_name&sort_order=asc');
  assert.equal(suppressed.status, 200);
  assert.deepEqual(suppressed.body.leads.map(lead => lead.id), [61, 62]);
  assert.equal(suppressed.body.pagination.total, 2);
  const clean = await request('/api/leads?suppression_status=not_suppressed');
  assert.equal(clean.status, 200);
  assert.deepEqual(clean.body.leads.map(lead => lead.id), [63]);
  assert.equal(clean.body.pagination.total, 1);

  const first = await request('/api/leads?limit=1&sort_by=business_name&sort_order=asc&suppression_status=suppressed');
  const next = await request(`/api/leads?limit=1&sort_by=business_name&sort_order=asc&suppression_status=suppressed&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`);
  assert.deepEqual([...first.body.leads, ...next.body.leads].map(lead => lead.id), [61, 62]);
  assert.equal(next.body.pagination.total, 2);
  const invalid = await request('/api/leads?suppression_status=maybe');
  assert.equal(invalid.status, 400);
});

test('suppression filter persists in saved segments and reads do not alter suppression history', async () => {
  const before = db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all();
  const saved = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Suppressed recipients', filters: { suppression_status: 'suppressed', status: 'disqualified' },
  } });
  assert.equal(saved.status, 201, saved.body.error);
  assert.deepEqual(saved.body.filters, { status: 'disqualified', suppression_status: 'suppressed' });
  const invalid = await request('/api/contact-segments', { method: 'POST', body: {
    name: 'Unknown suppression filter', filters: { suppression_status: 'maybe' },
  } });
  assert.equal(invalid.status, 400);

  closeDb();
  db = initDb();
  const segments = await request('/api/contact-segments');
  const restored = segments.body.find(segment => segment.id === saved.body.id);
  assert.deepEqual(restored.filters, { status: 'disqualified', suppression_status: 'suppressed' });
  const applied = await request(`/api/leads?${new URLSearchParams(restored.filters)}`);
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body.leads.map(lead => lead.id), [62]);
  assert.deepEqual(db.prepare('SELECT email,reason,added_at FROM suppression_list ORDER BY email').all(), before);
});
