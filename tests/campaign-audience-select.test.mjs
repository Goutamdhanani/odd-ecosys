import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-audience-select-'));
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

test('campaign drafts can enroll exact contacts idempotently without changing contact or list records', async () => {
  const leadIds = [
    Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('First pick','first-pick@example.test','queued')").run().lastInsertRowid),
    Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Second pick','second-pick@example.test','queued')").run().lastInsertRowid),
    Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Not selected','not-selected@example.test','queued')").run().lastInsertRowid),
  ];
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Exact audience' } });
  const campaignId = campaign.body.id;
  const selected = await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: [leadIds[0], leadIds[1], leadIds[1]] } });
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.body, { ok: true, campaignId, added: 2, alreadyEnrolled: 0, selected: 2 });
  assert.deepEqual(db.prepare('SELECT lead_id,source_list_id FROM campaign_enrollments WHERE campaign_id=? ORDER BY lead_id').all(campaignId), [
    { lead_id: leadIds[0], source_list_id: null }, { lead_id: leadIds[1], source_list_id: null },
  ]);

  const repeated = await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: [leadIds[0], leadIds[1]] } });
  assert.deepEqual({ added: repeated.body.added, alreadyEnrolled: repeated.body.alreadyEnrolled }, { added: 0, alreadyEnrolled: 2 });
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`)).body.counts.total, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id IN (?,?)').get(leadIds[0], leadIds[1]).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_list_members WHERE lead_id IN (?,?)').get(leadIds[0], leadIds[1]).count, 0);
});

test('explicit enrollment validates the whole selection and remains locked after launch', async () => {
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'All or nothing audience' } });
  const campaignId = campaign.body.id;
  const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Valid pick','valid-pick@example.test','queued')").run().lastInsertRowid);

  const missing = await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: [leadId, 999999] } });
  assert.equal(missing.status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=?').get(campaignId).count, 0);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: Array(501).fill(leadId) } })).status, 400);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: [leadId], listId: 1 } })).status, 400);

  db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(campaignId);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { leadIds: [leadId] } })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=?').get(campaignId).count, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
