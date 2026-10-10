import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-recipient-removal-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
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

test('recipient removal changes only an unsent draft snapshot and preserves the contact and saved list', async () => {
  const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Keep me','keep@example.test','queued')").run().lastInsertRowid);
  const list = await request('/api/lists', { method: 'POST', body: { name: 'Keep source list' } });
  await request(`/api/lists/${list.body.id}/members`, { method: 'POST', body: { leadIds: [leadId] } });
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Editable audience' } });
  const campaignId = campaign.body.id;
  await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId: list.body.id } });

  const removed = await request(`/api/sending/campaigns/${campaignId}/audience/${leadId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true, campaignId, leadId, removed: true });
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`)).body.counts.total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=?').get(leadId).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_list_members WHERE list_id=? AND lead_id=?').get(list.body.id, leadId).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId).count, 0);
  assert.deepEqual(JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='campaign_recipient_removed' AND lead_id=?").get(leadId).meta_json), {
    campaign_id: campaignId, source_list_id: list.body.id,
  });
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience/${leadId}`, { method: 'DELETE' })).status, 404);
});

test('recipient removal is rejected after launch or once any send record exists', async () => {
  const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Protected contact','protected@example.test','queued')").run().lastInsertRowid);
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Locked audience' } });
  const campaignId = campaign.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);

  db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(campaignId);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience/${leadId}`, { method: 'DELETE' })).status, 409);
  db.prepare("UPDATE campaigns SET status='draft' WHERE id=?").run(campaignId);
  db.prepare("INSERT INTO sends(lead_id,campaign_id,status,scheduled_at) VALUES (?,?, 'scheduled',datetime('now'))").run(leadId, campaignId);
  const blocked = await request(`/api/sending/campaigns/${campaignId}/audience/${leadId}`, { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /send history/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId).count, 1);
  assert.equal(db.prepare("SELECT status FROM sends WHERE campaign_id=?").get(campaignId).status, 'scheduled');
});
