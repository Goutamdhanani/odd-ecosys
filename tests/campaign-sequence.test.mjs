import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-sequence-'));
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
  const queueMatch = method === 'POST' && route.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (queueMatch && body && !body.reviewHash) {
    const review = await fetch(`${base}/api/sending/campaigns/${queueMatch[1]}/preflight`).then(response => response.json());
    body = { ...body, reviewHash: review.reviewHash };
  }
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

test('campaign steps and A/B copy persist, reorder safely, preview enrolled contacts, and expose existing-worker execution', async () => {
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Saved sequence fixture' } });
  assert.equal(created.status, 200);
  const campaignId = created.body.id;
  db.prepare(`INSERT INTO leads(id,business_name,email,category,city,status) VALUES (991,'Mora & Co <test>','owner@example.test','Studio','Pune','queued')`).run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,991)').run(campaignId);

  const empty = await request(`/api/sending/campaigns/${campaignId}/sequence`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.executionAvailable, true);
  assert.deepEqual(empty.body.steps, []);

  const first = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, { method: 'POST', body: {} });
  assert.equal(first.status, 201);
  assert.equal(first.body.steps[0].position, 1);
  assert.equal(first.body.steps[0].delayDays, 0);
  assert.deepEqual(first.body.steps[0].variants.map(variant => [variant.variantKey, variant.allocationPct]), [['A', 50], ['B', 50]]);
  const firstId = first.body.steps[0].id;

  const second = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, { method: 'POST', body: {} });
  assert.equal(second.status, 201);
  assert.equal(second.body.steps[1].position, 2);
  assert.equal(second.body.steps[1].delayDays, 3);
  const secondId = second.body.steps[1].id;
  const invalidFollowupDelay = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${secondId}`, { method: 'PUT', body: { delayDays: 0 } });
  assert.equal(invalidFollowupDelay.status, 400);

  const edited = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstId}`, {
    method: 'PUT',
    body: { delayDays: 0, variants: [
      { variantKey: 'A', allocationPct: 60, subjectLine: 'A note for {{business_name}}', bodyText: 'Hi {{first_name|there}} at {{company}}. Reply to {{email}}.' },
      { variantKey: 'B', allocationPct: 40, subjectLine: 'Variant B for {{city}}', bodyText: 'A second note for {{first_name}}.' },
    ] },
  });
  assert.equal(edited.status, 200);
  const rejectedWeights = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstId}`, {
    method: 'PUT', body: { delayDays: 0, variants: [
      { variantKey: 'A', allocationPct: 60, subjectLine: 'Must roll back', bodyText: 'Must roll back' },
      { variantKey: 'B', allocationPct: 60, subjectLine: 'Must roll back', bodyText: 'Must roll back' },
    ] },
  });
  assert.equal(rejectedWeights.status, 400);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/sequence`)).body.steps[0].variants[0].subjectLine, 'A note for {{business_name}}');

  const invalidOrder = await request(`/api/sending/campaigns/${campaignId}/sequence/order`, { method: 'PUT', body: { stepIds: [firstId, firstId] } });
  assert.equal(invalidOrder.status, 400);
  const reordered = await request(`/api/sending/campaigns/${campaignId}/sequence/order`, { method: 'PUT', body: { stepIds: [secondId, firstId] } });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.steps.map(step => [step.id, step.position, step.delayDays]), [[secondId, 1, 0], [firstId, 2, 1]]);

  const preview = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstId}/preview`, {
    method: 'POST', body: { leadId: 991, variantKey: 'A' },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ready, true);
  assert.equal(preview.body.subject, 'A note for Mora & Co <test>');
  assert.equal(preview.body.body, 'Hi there at Mora & Co <test>. Reply to owner@example.test.');
  assert.deepEqual(preview.body.unresolvedTokens, []);
  const unresolvedPreview = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstId}/preview`, {
    method: 'POST', body: { leadId: 991, variantKey: 'B' },
  });
  assert.equal(unresolvedPreview.body.ready, false);
  assert.deepEqual(unresolvedPreview.body.unresolvedTokens, ['first_name']);
  assert.match(unresolvedPreview.body.body, /A second note for \.?/);
  const unassignedContact = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstId}/preview`, {
    method: 'POST', body: { leadId: 992, variantKey: 'A' },
  });
  assert.equal(unassignedContact.status, 404);

  const queue = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 10 } });
  assert.equal(queue.status, 409);
  assert.match(queue.body.error, /variant A needs a subject and body/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);

  closeDb();
  db = initDb();
  const reopened = await request(`/api/sending/campaigns/${campaignId}/sequence`);
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.steps.map(step => step.id), [secondId, firstId]);
  assert.equal(reopened.body.steps[1].variants[0].subjectLine, 'A note for {{business_name}}');
  db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(campaignId);
  const lockedCampaign = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${firstId}`, { method: 'DELETE' });
  assert.equal(lockedCampaign.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_step_variants WHERE step_id=?').get(firstId).count, 2);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
