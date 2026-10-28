import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-drafts-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Draft audience contact','draft@example.test','queued')").run().lastInsertRowid);
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
  const queueMatch = method === 'POST' && route.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (queueMatch && body && !body.reviewHash) {
    const review = await fetch(`${base}/api/sending/campaigns/${queueMatch[1]}/preflight`).then(response => response.json());
    body = { ...body, reviewHash: review.reviewHash };
  }
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('draft edit, archive, restore, and queue gates preserve recipient snapshots and send history', async () => {
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: ' First campaign ' } });
  assert.equal(created.status, 200);
  const campaignId = created.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);

  const renamed = await request(`/api/sending/campaigns/${campaignId}`, { method: 'PATCH', body: { name: 'Revised campaign' } });
  assert.equal(renamed.status, 200);
  assert.deepEqual({ name: renamed.body.name, changed: renamed.body.changed }, { name: 'Revised campaign', changed: true });
  assert.equal((await request(`/api/sending/campaigns/${campaignId}`, { method: 'PATCH', body: { name: '   ' } })).status, 400);

  const archived = await request(`/api/sending/campaigns/${campaignId}/archive`, { method: 'POST' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'archived');
  assert.deepEqual((await request('/api/sending/campaigns')).body.map(item => item.id).includes(campaignId), false);
  const archivedView = await request('/api/sending/campaigns?status=archived');
  assert.equal(archivedView.status, 200);
  assert.equal(archivedView.body.find(item => item.id === campaignId).name, 'Revised campaign');
  const audience = await request(`/api/sending/campaigns/${campaignId}/audience`);
  assert.equal(audience.body.counts.total, 1, 'archive retains the campaign audience');
  assert.equal(audience.body.campaign.status, 'archived');
  assert.equal((await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 10 } })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);

  const restored = await request(`/api/sending/campaigns/${campaignId}/restore`, { method: 'POST' });
  assert.equal(restored.body.status, 'draft');
  assert.equal((await request('/api/sending/campaigns')).body.find(item => item.id === campaignId).name, 'Revised campaign');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId).count, 1);

  const withHistory = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Locked draft with history' } });
  const lockedId = withHistory.body.id;
  db.prepare("INSERT INTO sends(lead_id,campaign_id,status) VALUES (?,?,'failed')").run(leadId, lockedId);
  assert.equal((await request(`/api/sending/campaigns/${lockedId}`, { method: 'PATCH', body: { name: 'Must stay locked' } })).status, 409);
  assert.equal((await request(`/api/sending/campaigns/${lockedId}/archive`, { method: 'POST' })).status, 409);
  assert.equal(db.prepare('SELECT name FROM campaigns WHERE id=?').get(lockedId).name, 'Locked draft with history');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type IN ('campaign_renamed','campaign_archived','campaign_restored')").get().count, 3);
});
