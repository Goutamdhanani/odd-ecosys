import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-segments-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
db.exec(`
  INSERT INTO batches(id,name,phase,status) VALUES (1,'Segment fixture','test','open');
  INSERT INTO leads(id,batch_id,business_name,email,status,city) VALUES
    (21,1,'Qualified Contact','qualified@example.test','queued','Pune'),
    (22,1,'Unverified Contact','unverified@example.test','discovered','Pune'),
    (23,1,'Other Contact','other@example.test','queued','Mumbai');
  INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES
    (21,'qualified@example.test','fixture','deliverable',1),
    (22,'unverified@example.test','fixture','unknown',1),
    (23,'other@example.test','fixture','deliverable',1);
  INSERT INTO contact_tags(id,name) VALUES (1,'Priority');
  INSERT INTO lead_contact_tags(lead_id,tag_id) VALUES (21,1),(22,1);
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

test('saved contact segments validate and persist reusable filters without changing contacts', async () => {
  const filters = { status: 'queued', batch_id: '1', tag_id: '1', email_status: 'deliverable', search: 'Contact' };
  const created = await request('/api/contact-segments', { method: 'POST', body: { name: 'Ready contacts', filters } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Ready contacts');
  assert.deepEqual(created.body.filters, filters);

  const duplicate = await request('/api/contact-segments', { method: 'POST', body: { name: 'ready contacts', filters } });
  assert.equal(duplicate.status, 409);
  const invalid = await request('/api/contact-segments', {
    method: 'POST', body: { name: 'Unsafe filters', filters: { status: "queued' OR 1=1 --" } },
  });
  assert.equal(invalid.status, 400);
  const unsupported = await request('/api/contact-segments', {
    method: 'POST', body: { name: 'Unsupported filter', filters: { raw_sql: 'SELECT 1' } },
  });
  assert.equal(unsupported.status, 400);

  const leadsBefore = db.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
  const params = new URLSearchParams(created.body.filters);
  const applied = await request(`/api/leads?${params}`);
  assert.deepEqual(applied.body.leads.map(row => row.id), [21]);

  const updated = await request(`/api/contact-segments/${created.body.id}`, {
    method: 'PATCH', body: { name: 'Needs review', filters: { email_status: 'unknown', search: 'Unverified' } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Needs review');
  assert.deepEqual(updated.body.filters, { email_status: 'unknown', search: 'Unverified' });

  closeDb();
  db = initDb();
  const persisted = await request('/api/contact-segments');
  assert.deepEqual(persisted.body.map(row => ({ id: row.id, name: row.name, filters: row.filters })), [
    { id: created.body.id, name: 'Needs review', filters: { email_status: 'unknown', search: 'Unverified' } },
  ]);
  const appliedAfterReopen = await request(`/api/leads?${new URLSearchParams(persisted.body[0].filters)}`);
  assert.deepEqual(appliedAfterReopen.body.leads.map(row => row.id), [22]);

  assert.deepEqual((await request(`/api/contact-segments/${created.body.id}`, { method: 'DELETE' })).body, { ok: true, deleted: true });
  assert.deepEqual((await request('/api/contact-segments')).body, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, leadsBefore, 'segment deletion leaves contact data unchanged');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
