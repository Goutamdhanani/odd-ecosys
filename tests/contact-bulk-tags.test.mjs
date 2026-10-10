import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-bulk-tags-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,?)').run(501, 'Suppressed reply', 'reply@example.test', 'replied');
db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,?)').run(502, 'Verified contact', 'verified@example.test', 'awaiting_approval');
db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,?)').run(503, 'Other contact', 'other@example.test', 'discovered');
db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,is_primary,verified_at)
  VALUES (502,'verified@example.test','deliverable',1,'2026-10-09 10:00:00')`).run();
db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('reply@example.test','operator suppression')").run();
const campaignId = Number(db.prepare("INSERT INTO campaigns(name) VALUES ('Lifecycle preservation fixture')").run().lastInsertRowid);
db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id,status) VALUES (?,501,?)').run(campaignId, 'stopped');
db.prepare('INSERT INTO sends(lead_id,campaign_id,status) VALUES (501,?,?)').run(campaignId, 'accepted');

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

test('bulk tag assignment is additive, idempotent, atomic, and preserves contact lifecycle data', async () => {
  const activeTag = await request('/api/contact-tags', { method: 'POST', body: { name: 'Bulk active' } });
  const archivedTag = await request('/api/contact-tags', { method: 'POST', body: { name: 'Retained archived' } });
  assert.equal(activeTag.status, 201);
  assert.equal(archivedTag.status, 201);
  await request('/api/leads/501/tags', { method: 'PUT', body: { tagIds: [archivedTag.body.id] } });
  await request(`/api/contact-tags/${archivedTag.body.id}`, { method: 'DELETE' });

  const lifecycleBefore = {
    lead501: db.prepare('SELECT email,status FROM leads WHERE id=501').get(),
    lead502: db.prepare('SELECT email,status FROM leads WHERE id=502').get(),
    verification: db.prepare('SELECT email,verification_status,is_primary,verified_at FROM lead_emails WHERE lead_id=502').all(),
    suppression: db.prepare("SELECT email,reason FROM suppression_list WHERE email='reply@example.test'").get(),
    enrollment: db.prepare('SELECT campaign_id,lead_id,status FROM campaign_enrollments WHERE lead_id=501').all(),
    sends: db.prepare('SELECT campaign_id,lead_id,status FROM sends WHERE lead_id=501').all(),
  };

  const assigned = await request('/api/leads/bulk/tags', {
    method: 'PUT', body: { leadIds: [501, 502, 502], tagIds: [activeTag.body.id, activeTag.body.id] },
  });
  assert.equal(assigned.status, 200, assigned.body.error);
  assert.deepEqual(assigned.body, {
    selected: 2, changedContacts: 2, assignmentsAdded: 2, tagIds: [activeTag.body.id],
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_contact_tags WHERE tag_id=? AND lead_id IN (501,502)').get(activeTag.body.id).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_contact_tags WHERE lead_id=501 AND tag_id=?').get(archivedTag.body.id).count, 1,
    'existing archived membership remains stored while active tags are added');

  const repeated = await request('/api/leads/bulk/tags', {
    method: 'PUT', body: { leadIds: [501, 502], tagIds: [activeTag.body.id] },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.changedContacts, 0);
  assert.equal(repeated.body.assignmentsAdded, 0);

  const failedSnapshots = () => ({
    contact501Tags: db.prepare('SELECT tag_id FROM lead_contact_tags WHERE lead_id=501 ORDER BY tag_id').all(),
    contact502Tags: db.prepare('SELECT tag_id FROM lead_contact_tags WHERE lead_id=502 ORDER BY tag_id').all(),
  });
  const beforeRejectedAssignments = failedSnapshots();
  const staleContact = await request('/api/leads/bulk/tags', {
    method: 'PUT', body: { leadIds: [501, 999999], tagIds: [activeTag.body.id] },
  });
  assert.equal(staleContact.status, 409);
  assert.deepEqual(failedSnapshots(), beforeRejectedAssignments, 'a stale id rejects the whole selected set');

  const archivedAssignment = await request('/api/leads/bulk/tags', {
    method: 'PUT', body: { leadIds: [501, 502], tagIds: [activeTag.body.id, archivedTag.body.id] },
  });
  assert.equal(archivedAssignment.status, 409);
  assert.deepEqual(failedSnapshots(), beforeRejectedAssignments, 'an archived tag rejects the whole assignment');

  const missingTag = await request('/api/leads/bulk/tags', {
    method: 'PUT', body: { leadIds: [501, 502], tagIds: [activeTag.body.id, 999999] },
  });
  assert.equal(missingTag.status, 409);
  assert.deepEqual(failedSnapshots(), beforeRejectedAssignments);
  assert.equal((await request('/api/leads/bulk/tags', { method: 'PUT', body: { leadIds: [], tagIds: [activeTag.body.id] } })).status, 400);
  assert.equal((await request('/api/leads/bulk/tags', { method: 'PUT', body: { leadIds: [501], tagIds: [] } })).status, 400);
  assert.equal((await request('/api/leads/bulk/tags', { method: 'PUT', body: { leadIds: Array(501).fill(501), tagIds: [activeTag.body.id] } })).status, 400);

  assert.deepEqual({
    lead501: db.prepare('SELECT email,status FROM leads WHERE id=501').get(),
    lead502: db.prepare('SELECT email,status FROM leads WHERE id=502').get(),
    verification: db.prepare('SELECT email,verification_status,is_primary,verified_at FROM lead_emails WHERE lead_id=502').all(),
    suppression: db.prepare("SELECT email,reason FROM suppression_list WHERE email='reply@example.test'").get(),
    enrollment: db.prepare('SELECT campaign_id,lead_id,status FROM campaign_enrollments WHERE lead_id=501').all(),
    sends: db.prepare('SELECT campaign_id,lead_id,status FROM sends WHERE lead_id=501').all(),
  }, lifecycleBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE lead_id IN (501,502) AND event_type='contact_tags_updated'").get().count, 3,
    'audit events are recorded only for actual tag changes');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
