import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-clone-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
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

test('campaign clone copies sequence content into a durable draft but leaves delivery state behind', async () => {
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Source sequence' } });
  assert.equal(created.status, 200);
  const sourceId = created.body.id;
  const first = await request(`/api/sending/campaigns/${sourceId}/sequence/steps`, { method: 'POST', body: {} });
  const firstStepId = first.body.steps[0].id;
  await request(`/api/sending/campaigns/${sourceId}/sequence/steps/${firstStepId}`, {
    method: 'PUT',
    body: { delayDays: 0, variants: [
      { variantKey: 'A', allocationPct: 70, subjectLine: 'Intro {{business_name}}', bodyText: 'Hello {{business_name}}.' },
      { variantKey: 'B', allocationPct: 30, subjectLine: 'A second subject', bodyText: 'A second message.' },
    ] },
  });
  await request(`/api/sending/campaigns/${sourceId}/sequence/steps`, { method: 'POST', body: { delayDays: 4 } });

  const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Source audience','source@example.test','queued')").run().lastInsertRowid);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(sourceId, leadId);
  db.prepare("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active) VALUES (1,'source@example.test','example.test','eligible',10,100,1)").run();
  db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES (?,1)').run(sourceId);
  const sentStepId = db.prepare('SELECT id FROM campaign_steps WHERE campaign_id=? AND position=1').get(sourceId).id;
  db.prepare("INSERT INTO sends(lead_id,mailbox_id,campaign_id,campaign_step_id,status,sent_at) VALUES (?,1,?,?,'sent',datetime('now'))")
    .run(leadId, sourceId, sentStepId);
  db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(sourceId);

  const cloned = await request(`/api/sending/campaigns/${sourceId}/clone`, { method: 'POST', body: { name: '  New safe draft  ' } });
  assert.equal(cloned.status, 201, JSON.stringify(cloned.body));
  assert.deepEqual({ name: cloned.body.name, status: cloned.body.status, sourceCampaignId: cloned.body.sourceCampaignId, sequenceStepCount: cloned.body.sequenceStepCount }, {
    name: 'New safe draft', status: 'draft', sourceCampaignId: sourceId, sequenceStepCount: 2,
  });
  const cloneId = cloned.body.id;

  const sequence = await request(`/api/sending/campaigns/${cloneId}/sequence`);
  assert.equal(sequence.status, 200);
  assert.deepEqual(sequence.body.steps.map(step => ({ position: step.position, delayDays: step.delay_days })), [
    { position: 1, delayDays: 0 }, { position: 2, delayDays: 4 },
  ]);
  assert.deepEqual(sequence.body.steps[0].variants.map(variant => ({
    key: variant.variantKey, allocation: variant.allocationPct, subject: variant.subjectLine, body: variant.bodyText,
  })), [
    { key: 'A', allocation: 70, subject: 'Intro {{business_name}}', body: 'Hello {{business_name}}.' },
    { key: 'B', allocation: 30, subject: 'A second subject', body: 'A second message.' },
  ]);
  assert.equal((await request(`/api/sending/campaigns/${cloneId}/audience`)).body.counts.total, 0);
  assert.deepEqual((await request(`/api/sending/campaigns/${cloneId}/senders`)).body.senderIds, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(cloneId).count, 0);
  assert.equal(db.prepare("SELECT status FROM campaigns WHERE id=?").get(cloneId).status, 'draft');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='campaign_cloned' AND json_extract(meta_json,'$.campaign_id')=? AND json_extract(meta_json,'$.source_campaign_id')=?")
    .get(cloneId, sourceId).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=?').get(sourceId).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_senders WHERE campaign_id=?').get(sourceId).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(sourceId).count, 1);

  closeDb();
  db = initDb();
  assert.equal((await request(`/api/sending/campaigns/${cloneId}/sequence`)).body.steps.length, 2, 'the new sequence persists after database reopen');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('campaign clone validates source and name without partial creation', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count;
  assert.equal((await request('/api/sending/campaigns/999999/clone', { method: 'POST', body: { name: 'Missing source' } })).status, 404);
  assert.equal((await request('/api/sending/campaigns/1/clone', { method: 'POST', body: { name: '   ' } })).status, 400);
  assert.equal((await request('/api/sending/campaigns/1/clone', { method: 'POST', body: { name: 'x'.repeat(201) } })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count, before);
});
