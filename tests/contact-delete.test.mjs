import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-contact-delete-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
db.exec(`
  INSERT INTO batches(id,name,phase,status,lead_count) VALUES (1,'Delete fixture','test','open',3);
  INSERT INTO leads(id,batch_id,business_name,email,status) VALUES
    (11,1,'Unused Contact','unused@example.test','discovered'),
    (12,1,'Sent Contact','sent@example.test','sent'),
    (13,1,'Archived Send Contact','archived@example.test','sent');
  INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES
    (11,'unused@example.test','fixture','unknown',1),
    (12,'sent@example.test','fixture','deliverable',1),
    (13,'archived@example.test','fixture','deliverable',1);
  INSERT INTO contact_lists(id,name) VALUES (1,'Delete fixture list');
  INSERT INTO contact_list_members(list_id,lead_id) VALUES (1,11);
  INSERT INTO contact_tags(id,name) VALUES (1,'Delete fixture tag');
  INSERT INTO lead_contact_tags(lead_id,tag_id) VALUES (11,1);
  INSERT INTO campaigns(id,name) VALUES (1,'Delete fixture campaign');
  INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (1,11);
  INSERT INTO personalizations(id,lead_id,subject_line,body_text) VALUES (1,11,'Draft subject','Draft body');
  INSERT INTO verification_jobs(id,batch_id,status,total,processed,current_lead_id) VALUES (1,1,'completed',1,1,11);
  INSERT INTO events(id,lead_id,event_type,meta_json) VALUES (1,11,'contact_created','{"email":"unused@example.test"}');
  INSERT INTO reply_inbox_state(event_id,read_at) VALUES (1,NULL);
  INSERT INTO unsubscribe_tokens(token_hash,email,lead_id) VALUES ('fixture-token-hash','unused@example.test',11);
  INSERT INTO suppression_list(email,reason) VALUES
    ('blocked@example.test','unsubscribe'),
    ('unused@example.test','unsubscribe');
  INSERT INTO sends(id,lead_id,status) VALUES (21,12,'accepted');
  INSERT INTO sends_archive(id,lead_id,status) VALUES (31,13,'accepted');
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

async function request(route, method = 'GET') {
  const response = await fetch(`${base}${route}`, { method });
  return { status: response.status, body: await response.json() };
}

test('contact deletion removes unused personal data and memberships but preserves suppression and batch integrity', async () => {
  const response = await request('/api/leads/11', 'DELETE');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    contactId: 11, batchId: 1, deleted: true, suppressionHistoryPreserved: true,
  });
  assert.equal(db.prepare('SELECT 1 FROM leads WHERE id=11').get(), undefined);
  for (const table of ['lead_emails', 'personalizations', 'contact_list_members', 'lead_contact_tags', 'campaign_enrollments', 'events', 'unsubscribe_tokens']) {
    const column = table === 'contact_list_members' ? 'lead_id' : table === 'lead_contact_tags' ? 'lead_id'
      : table === 'campaign_enrollments' ? 'lead_id' : table === 'events' ? 'lead_id' : table === 'unsubscribe_tokens' ? 'lead_id' : 'lead_id';
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=11`).get().count, 0, `${table} no longer references the deleted contact`);
  }
  assert.equal(db.prepare('SELECT current_lead_id FROM verification_jobs WHERE id=1').get().current_lead_id, null);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=1').get().lead_count, 2);
  assert.equal(db.prepare("SELECT reason FROM suppression_list WHERE email='unused@example.test'").get().reason, 'unsubscribe');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM suppression_list').get().count, 2);
  assert.equal((await request('/api/leads/11')).status, 404);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('contacts with current or archived send history are protected from permanent deletion', async () => {
  for (const id of [12, 13]) {
    const before = db.prepare('SELECT business_name,email FROM leads WHERE id=?').get(id);
    const response = await request(`/api/leads/${id}`, 'DELETE');
    assert.equal(response.status, 409);
    assert.match(response.body.error, /send history/i);
    assert.deepEqual(db.prepare('SELECT business_name,email FROM leads WHERE id=?').get(id), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(id).count, 1);
  }
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('missing contacts return 404 and do not affect batch counts', async () => {
  const response = await request('/api/leads/999', 'DELETE');
  assert.equal(response.status, 404);
  assert.equal(db.prepare('SELECT lead_count FROM batches WHERE id=1').get().lead_count, 2);
});
