import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-create-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const openBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status,lead_count) VALUES ('Manual contacts','discovery','open',24)").run().lastInsertRowid);
const closedBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Finished cohort','discovery','closed')").run().lastInsertRowid);
const existingLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,status) VALUES (?,'Existing lead','discovered')").run(openBatchId).lastInsertRowid);
db.prepare("INSERT INTO lead_emails(lead_id,email,source,verification_status) VALUES (?, 'alias@example.test','csv_import','unknown')").run(existingLeadId);

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

test('manual contact creation persists to an open batch with unknown email evidence visible through the API', async () => {
  const created = await request('/api/leads', { method: 'POST', body: {
    batch_id: openBatchId,
    business_name: '  North Star Workshop  ',
    email: '  Owner@Example.test ',
    category: 'Fabrication',
    city: 'Pune',
    phone: '+91 (20) 5555 0101',
    website_url: 'https://northstar.example.test',
  } });

  assert.equal(created.status, 201);
  assert.equal(created.body.contact.business_name, 'North Star Workshop');
  assert.equal(created.body.contact.email, 'owner@example.test');
  assert.equal(created.body.contact.source, 'manual');
  assert.equal(created.body.contact.status, 'discovered');
  assert.equal(created.body.verificationRequired, true);
  assert.deepEqual(created.body.emailEvidence, { email: 'owner@example.test', verification_status: 'unknown' });
  assert.deepEqual(db.prepare('SELECT source,verification_status,is_primary,verified_at FROM lead_emails WHERE lead_id=?').get(created.body.contact.id), {
    source: 'manual', verification_status: 'unknown', is_primary: 1, verified_at: null,
  });
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=?').get(openBatchId).lead_count, 2);
  assert.equal(db.prepare("SELECT event_type FROM events WHERE lead_id=?").get(created.body.contact.id).event_type, 'contact_created');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(created.body.contact.id).count, 0);

  const listed = await request(`/api/leads?batch_id=${openBatchId}&search=North%20Star`);
  assert.equal(listed.body.pagination.total, 1);
  assert.equal(listed.body.leads[0].id, created.body.contact.id);
  const detail = await request(`/api/leads/${created.body.contact.id}`);
  assert.equal(detail.body.emails[0].verification_status, 'unknown');
  assert.equal(detail.body.events[0].event_type, 'contact_created');

  const withoutEmail = await request('/api/leads', { method: 'POST', body: {
    batch_id: openBatchId, business_name: 'Prospect without an address',
  } });
  assert.equal(withoutEmail.status, 201);
  assert.equal(withoutEmail.body.emailEvidence, null);
  assert.equal(withoutEmail.body.verificationRequired, false);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=?').get(openBatchId).lead_count, 3);
});

test('manual contact creation rejects duplicate/invalid email and closed or missing batches without partial writes', async () => {
  const duplicatePrimary = await request('/api/leads', { method: 'POST', body: {
    batch_id: openBatchId, business_name: 'Duplicate primary', email: 'OWNER@example.test',
  } });
  assert.equal(duplicatePrimary.status, 409);
  assert.match(duplicatePrimary.body.error, /already belongs/i);

  const duplicateAlias = await request('/api/leads', { method: 'POST', body: {
    batch_id: openBatchId, business_name: 'Duplicate alias', email: 'ALIAS@example.test',
  } });
  assert.equal(duplicateAlias.status, 409);

  const invalid = await request('/api/leads', { method: 'POST', body: {
    batch_id: openBatchId, business_name: 'Invalid email', email: 'not-an-address',
  } });
  assert.equal(invalid.status, 400);

  const closed = await request('/api/leads', { method: 'POST', body: {
    batch_id: closedBatchId, business_name: 'Closed batch contact',
  } });
  assert.equal(closed.status, 409);

  const missing = await request('/api/leads', { method: 'POST', body: {
    batch_id: 99999, business_name: 'Missing batch contact',
  } });
  assert.equal(missing.status, 404);

  const protectedField = await request('/api/leads', { method: 'POST', body: {
    batch_id: openBatchId, business_name: 'Unsafe state', status: 'sent',
  } });
  assert.equal(protectedField.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(openBatchId).count, 3);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=?').get(openBatchId).lead_count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events WHERE event_type=?').get('contact_created').count, 2);
});
