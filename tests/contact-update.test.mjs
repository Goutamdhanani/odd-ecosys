import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-update-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
db.exec(`
  INSERT INTO leads(id,business_name,email,category,city,status) VALUES
    (11,'Old Bakery','old@example.test','Bakery','Old City','queued'),
    (12,'Other Studio','other@example.test','Design','Other City','discovered');
  INSERT INTO lead_emails(lead_id,email,source,verification_status) VALUES
    (11,'old@example.test','fixture','deliverable');
  INSERT INTO campaigns(id,name) VALUES (1,'Contact update fixture');
  INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (1,11);
  INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES
    (21,11,'Approved before contact edit','Body with old facts',1,1);
  UPDATE personalizations SET fact_check_passed=1 WHERE id=21;
  INSERT INTO sends(id,lead_id,campaign_id,personalization_id,scheduled_at,status)
    VALUES (31,11,1,21,datetime('now','+1 day'),'scheduled');
  INSERT INTO sends(id,lead_id,campaign_id,personalization_id,scheduled_at,status)
    VALUES (32,11,1,21,datetime('now'),'scheduled');
`);
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
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

test('contact edits persist, retain old verification, add unknown new email, and cancel stale queued work', async () => {
  await request('/api/leads/11'); // Initialize the test server before creating an in-flight fixture row.
  db.prepare("UPDATE sends SET status='processing' WHERE id=32").run();
  const updated = await request('/api/leads/11', { method: 'PATCH', body: {
    business_name: 'New Bakery Name', email: 'New@Example.test', city: 'Pune', website_url: 'https://bakery.example.test/about',
  } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.changedFields.sort(), ['business_name', 'city', 'email', 'website_url'].sort());
  assert.equal(updated.body.reviewRequired, true);
  assert.equal(updated.body.verificationRequired, true);
  assert.equal(updated.body.cancelledSends, 1);
  assert.equal(updated.body.inFlightSends, 1);
  assert.equal(updated.body.contact.business_name, 'New Bakery Name');
  assert.equal(updated.body.contact.email, 'new@example.test');

  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE email=?').get('old@example.test').verification_status, 'deliverable');
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE email=?').get('new@example.test').verification_status, 'unknown');
  assert.equal(db.prepare('SELECT status,sent_at FROM sends WHERE id=31').get().status, 'cancelled');
  assert.equal(db.prepare('SELECT sent_at FROM sends WHERE id=31').get().sent_at, null);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=32').get().status, 'processing', 'contact edits do not rewrite a send that may already be at SMTP');
  assert.equal(db.prepare('SELECT approved,guardrail_passed FROM personalizations WHERE id=21').get().approved, 0);
  assert.equal(db.prepare('SELECT guardrail_passed FROM personalizations WHERE id=21').get().guardrail_passed, 0);
  assert.equal(db.prepare('SELECT fact_check_passed FROM personalizations WHERE id=21').get().fact_check_passed, 0);
  assert.equal(db.prepare("SELECT json_extract(meta_json,'$.reason') AS reason FROM events WHERE event_type='send_blocked'").get().reason, 'contact_updated_reapproval_required');
  const audit = db.prepare("SELECT meta_json FROM events WHERE event_type='contact_updated'").get();
  assert.deepEqual(JSON.parse(audit.meta_json).changedFields.sort(), ['business_name', 'city', 'email', 'website_url'].sort());
  assert.equal((await request('/api/leads/11')).body.email, 'new@example.test');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('contact updates validate editable fields and never allow lifecycle/suppression fields to be overwritten', async () => {
  const invalidEmail = await request('/api/leads/11', { method: 'PATCH', body: { email: 'not-an-address' } });
  assert.equal(invalidEmail.status, 400);
  assert.match(invalidEmail.body.error, /valid email/i);
  const invalidUrl = await request('/api/leads/11', { method: 'PATCH', body: { website_url: 'javascript:alert(1)' } });
  assert.equal(invalidUrl.status, 400);
  assert.match(invalidUrl.body.error, /http or https/i);
  const protectedFields = await request('/api/leads/11', { method: 'PATCH', body: { status: 'won', batch_id: 999 } });
  assert.equal(protectedFields.status, 400);
  assert.match(protectedFields.body.error, /unsupported contact field/i);
  const duplicateEmail = await request('/api/leads/11', { method: 'PATCH', body: { email: 'other@example.test' } });
  assert.equal(duplicateEmail.status, 409);
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=11').get().email, 'new@example.test');
  assert.equal((await request('/api/leads/999', { method: 'PATCH', body: { city: 'Pune' } })).status, 404);

  const before = db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='contact_updated'").get().n;
  const noOp = await request('/api/leads/11', { method: 'PATCH', body: { business_name: 'New Bakery Name' } });
  assert.equal(noOp.body.reviewRequired, false);
  assert.deepEqual(noOp.body.changedFields, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='contact_updated'").get().n, before);
});
