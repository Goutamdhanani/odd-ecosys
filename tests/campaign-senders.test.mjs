import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-senders-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const received = [[], []];
function makeSink(index) {
  return new SMTPServer({
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture auth rejected'));
      callback(null, { user: 'fixture' });
    },
    onData(stream, _session, callback) {
      let raw = '';
      stream.on('data', chunk => { raw += chunk; });
      stream.on('end', () => { received[index].push(raw); callback(null, `Selected sink ${index + 1} accepted`); });
    },
  });
}
const sinks = [makeSink(0), makeSink(1)];
for (const smtp of sinks) await new Promise((resolve, reject) => {
  smtp.once('error', reject);
  smtp.listen(0, '127.0.0.1', resolve);
});

db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (901,'Explicit sender fixture','chosen@example.test','queued')").run();
db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (901,'chosen@example.test','deliverable',datetime('now'))").run();
db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (901,901,'Sender pool subject','Only the selected sender should send this.',1,1)").run();
const insertMailbox = db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
  smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure) VALUES (?,?,?,'eligible',100,100,1,?,?,?,'fixture-only',0)`);
insertMailbox.run(1, 'selected@example.test', 'example.test', '127.0.0.1', sinks[0].server.address().port, 'fixture');
insertMailbox.run(2, 'unselected@example.test', 'example.test', '127.0.0.1', sinks[1].server.address().port, 'fixture');
db.prepare("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active) VALUES (3,'warming@example.test','example.test','warming',0,100,1)").run();
const approvedReview = db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_by,reviewed_at)
  VALUES (?,'approved','smtp-imap-source-evidence-v2',?,NULL,datetime('now'))`);
const reviewEvidence = JSON.stringify({
  fixture: 'synthetic pre-reviewed campaign sender; loopback SMTP only',
  outbound: { source: 'accepted_sends', count: 1, latestAt: '2026-10-24T10:00:00.000Z' },
  replies: { source: 'attributed_inbound_reply_events', count: 0, latestAt: null },
  inbox: { source: 'imap_sync_mailbox_state', lastCheckedAt: '2026-10-24T10:05:00.000Z', fetched: 1, imported: 1, alreadyRecorded: 0, skipped: 0 },
});
approvedReview.run(1, reviewEvidence);
approvedReview.run(2, reviewEvidence);
db.prepare("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active) VALUES (4,'unreviewed@example.test','example.test','eligible',100,100,1)").run();
db.prepare("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active) VALUES (5,'held@example.test','example.test','eligible',100,100,1)").run();
db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_by,reviewed_at)
  VALUES (5,'held','smtp-imap-source-evidence-v2',?,NULL,datetime('now'))`).run(reviewEvidence);

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    ...sinks.map(smtp => new Promise(resolve => smtp.close(resolve))),
  ]);
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

test('campaign sender pools persist, reject unavailable mailboxes, and never fall back to unselected senders', async () => {
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Explicit sender campaign' } });
  const campaignId = campaign.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,901)').run(campaignId);

  const empty = await request(`/api/sending/campaigns/${campaignId}/senders`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.senderIds, []);
  assert.equal(empty.body.locked, false);
  assert.equal(empty.body.mailboxes.find(mailbox => mailbox.id === 3).readiness, 'warmup_warming');
  assert.equal(empty.body.mailboxes.find(mailbox => mailbox.id === 4).readiness, 'warmup_review_required');
  assert.equal(empty.body.mailboxes.find(mailbox => mailbox.id === 5).readiness, 'warmup_review_required');
  assert.doesNotMatch(JSON.stringify(empty.body), /fixture-only|smtp_pass|smtp_user/);
  const unconfiguredQueue = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 10 } });
  assert.equal(unconfiguredQueue.status, 409);
  assert.match(unconfiguredQueue.body.error, /choose at least one eligible sender/i);

  const unavailableSelection = await request(`/api/sending/campaigns/${campaignId}/senders`, {
    method: 'PUT', body: { mailboxIds: [1, 3] },
  });
  assert.equal(unavailableSelection.status, 409);
  assert.deepEqual((await request(`/api/sending/campaigns/${campaignId}/senders`)).body.senderIds, [], 'invalid update is atomic');
  for (const mailboxId of [4, 5]) {
    const unreviewedSelection = await request(`/api/sending/campaigns/${campaignId}/senders`, {
      method: 'PUT', body: { mailboxIds: [mailboxId] },
    });
    assert.equal(unreviewedSelection.status, 409, `mailbox ${mailboxId} must not be selectable without a current approved send review`);
    assert.deepEqual((await request(`/api/sending/campaigns/${campaignId}/senders`)).body.senderIds, [], 'invalid review selection is atomic');
  }

  const configured = await request(`/api/sending/campaigns/${campaignId}/senders`, {
    method: 'PUT', body: { mailboxIds: [1, 1] },
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.body.senderIds, [1]);
  assert.equal(configured.body.readyCount, 1);

  const queued = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 10 } });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 1, JSON.stringify(queued.body));
  assert.equal(queued.body.queuedList[0].mailboxId, 1);
  assert.equal(db.prepare('SELECT mailbox_id FROM sends WHERE campaign_id=?').get(campaignId).mailbox_id, 1);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-2 minutes') WHERE campaign_id=?").run(campaignId);
  assert.equal((await request('/api/sending/process', { method: 'POST', body: { limit: 10 } })).status, 200);

  const deadline = Date.now() + 8000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    status = (await request('/api/sending/status')).body;
  } while (Date.now() < deadline && (status.active || received[0].length === 0));
  assert.equal(status.active, false);
  assert.equal(received[0].length, 1, 'the selected loopback sink accepted the campaign message');
  assert.equal(received[1].length, 0, 'the unselected but eligible mailbox must never receive fallback traffic');

  const stats = await request('/api/sending/campaigns');
  const record = stats.body.find(item => item.id === campaignId);
  assert.equal(record.sender_count, 1);
  assert.equal(record.sender_ready_count, 1);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [2] } })).status, 409);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  db.prepare('DELETE FROM campaign_senders WHERE campaign_id=?').run(campaignId);
  db.prepare('DELETE FROM schema_migrations').run();
  closeDb();
  db = initDb();
  assert.deepEqual(db.prepare('SELECT mailbox_id FROM campaign_senders WHERE campaign_id=?').all(campaignId).map(row => row.mailbox_id), [1], 'legacy sender choices are backfilled from actual send records');
});
