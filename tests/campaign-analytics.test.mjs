import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-analytics-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { getVariantStats } = await import('../pipeline/ab-testing.js');
const { renderABPanel } = await import('../js/campaigns.js');
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

async function request(route, { method = 'GET' } = {}) {
  const response = await fetch(`${base}${route}`, { method });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  return { status: response.status, body };
}

db.prepare("INSERT INTO campaigns(id,name,status) VALUES (1,'Analytics sequence','active')").run();
db.prepare('INSERT INTO campaign_steps(id,campaign_id,position,delay_days) VALUES (101,1,1,0),(102,1,2,3)').run();
db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (3001,'Assigned contact','assigned@example.test','queued')").run();
db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (1,3001)').run();
db.prepare("INSERT INTO campaign_step_variants(step_id,variant_key,allocation_pct,subject_line,body_text) VALUES (101,'A',50,'A subject','A body'),(101,'B',50,'B subject','B body'),(102,'A',100,'Next subject','Next body')").run();
for (const [id, variant] of [[1010, 'A'], [1020, 'B']]) {
  for (let index = 0; index < 10; index++) {
    const sendId = id + index;
    db.prepare(`INSERT INTO sends(id,campaign_id,campaign_step_id,variant,status,sent_at)
      VALUES(?,1,101,?,'sent',datetime('now'))`).run(sendId, variant);
    if (variant === 'A' || index === 0) {
      const sentiment = variant === 'A' ? 'interested' : 'not_interested';
      db.prepare(`INSERT INTO events(send_id,event_type,event_at,meta_json)
        VALUES(?, 'replied',datetime('now'),?)`).run(sendId, JSON.stringify({ sentiment }));
    }
  }
}
db.prepare("INSERT INTO sends(id,campaign_id,campaign_step_id,variant,status,sent_at) VALUES (2001,1,102,'A','sent',datetime('now')),(2002,1,102,'B','sent',datetime('now'))").run();
db.prepare("INSERT INTO events(send_id,event_type,event_at,meta_json) VALUES (1010,'opened',datetime('now'),'{}'),(1010,'opened',datetime('now'),'{}'),(1010,'clicked',datetime('now'),'{}'),(1010,'clicked',datetime('now'),'{}')").run();

test('sequence A/B reports are scoped by step and count distinct accepted sends and engagement', async () => {
  const first = getVariantStats(1);
  assert.equal(first.selectedStepId, 101, 'default sequence report is step 1, not a mixture of different copy');
  assert.deepEqual(first.sequenceSteps.map(step => [step.id, step.position]), [[101, 1], [102, 2]]);
  const a = first.variants.find(variant => variant.variant === 'A');
  const b = first.variants.find(variant => variant.variant === 'B');
  assert.equal(a.sent, 10);
  assert.equal(a.opened, 1, 'duplicate open events for one send count once');
  assert.equal(a.clicked, 1, 'duplicate clicks for one send count once');
  assert.equal(a.replied, 10, 'reply denominator uses unique SMTP-accepted send IDs');
  assert.equal(a.positive, 10);
  assert.equal(b.sent, 10);
  assert.equal(b.replied, 1);
  assert.equal(b.positive, 0, 'not_interested text is not positive evidence');
  assert.equal(first.winner, null, 'small-sample differences cannot declare a winner');
  assert.equal(first.comparisons[0].sampleMet, false);

  const second = await request('/api/sending/campaigns/1/variants?stepId=102');
  assert.equal(second.status, 200);
  assert.equal(second.body.selectedStepId, 102);
  assert.equal(second.body.variants.length, 2);
  assert.deepEqual(second.body.variants.map(variant => variant.sent), [1, 1]);
  assert.equal((await request('/api/sending/campaigns/1/variants?stepId=999')).status, 404);
  assert.equal((await request('/api/sending/ab/assign/1')).status, 400, 'random unscoped assignments are rejected');
  const [assignment1, assignment2] = await Promise.all([
    request('/api/sending/ab/assign/1?leadId=3001&stepId=101'),
    request('/api/sending/ab/assign/1?leadId=3001&stepId=101'),
  ]);
  assert.equal(assignment1.status, 200);
  assert.equal(assignment1.body.variant, assignment2.body.variant, 'same enrolled contact and step always receive the same variant');

  const html = renderABPanel(first, []);
  assert.match(html, /data-ab-step/);
  assert.match(html, /minimum sample not met/i);
  assert.doesNotMatch(html, /Statistical winner/);
});

test('winner review returns read-only recommendations and never records a fake promotion', async () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='ab_winner_declared'").get().count;
  const review = await request('/api/sending/ab/auto-promote', { method: 'POST' });
  assert.equal(review.status, 200);
  assert.equal(review.body.applied, false);
  assert.deepEqual(review.body.recommendations, [], 'the sample minimum has not been met');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='ab_winner_declared'").get().count, before,
    'reviewing statistical candidates does not fabricate a promotion event');
});
