import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-lifecycle-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const received = [];
const smtp = new SMTPServer({
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
    stream.on('end', () => { received.push(raw); callback(null, 'Lifecycle SMTP sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => smtp.close(resolve)),
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

test('pause retains scheduled sends and blocks queue/SMTP until resume', async () => {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (41,'Lifecycle Fixture','recipient@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (41,'recipient@example.test','deliverable',datetime('now'))").run();
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_at)
    VALUES (1,'approved','smtp-imap-source-evidence-v2','{"fixture":"pre_reviewed_sender"}',datetime('now'))`).run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (401,41,'Lifecycle subject','Lifecycle SMTP body',1,1)").run();

  const list = await request('/api/lists', { method: 'POST', body: { name: 'Lifecycle fixture contacts' } });
  assert.equal((await request(`/api/lists/${list.body.id}/members`, { method: 'POST', body: { leadIds: [41] } })).body.added, 1);
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Lifecycle fixture campaign' } });
  const campaignId = campaign.body.id;
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId: list.body.id } })).body.added, 1);
  const senders = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [1] } });
  assert.equal(senders.status, 200);
  assert.equal(senders.body.readyCount, 1);

  const queued = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 1 } });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 1, JSON.stringify(queued.body));
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaignId).status, 'active');
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-2 minutes') WHERE campaign_id=?").run(campaignId);

  const paused = await request(`/api/sending/campaigns/${campaignId}/pause`, { method: 'POST' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');
  assert.equal(paused.body.pendingRetained, 1);
  assert.equal((await request('/api/sending/campaigns')).body.find(row => row.id === campaignId).status, 'paused');
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`)).body.campaign.status, 'paused');

  const queueWhilePaused = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 1 } });
  assert.equal(queueWhilePaused.status, 409);
  assert.match(queueWhilePaused.body.error, /paused/i);
  assert.equal((await request('/api/sending/process', { method: 'POST', body: { limit: 10 } })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(received.length, 0, 'a paused campaign must not submit queued messages to SMTP');
  assert.equal(db.prepare('SELECT status FROM sends WHERE campaign_id=?').get(campaignId).status, 'scheduled');

  const resumed = await request(`/api/sending/campaigns/${campaignId}/resume`, { method: 'POST' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'active');
  assert.equal((await request('/api/sending/process', { method: 'POST', body: { limit: 10 } })).status, 200);

  const deadline = Date.now() + 8000;
  let sendingStatus;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    sendingStatus = (await request('/api/sending/status')).body;
  } while (Date.now() < deadline && (sendingStatus.active || received.length === 0));

  assert.equal(sendingStatus.active, false);
  assert.equal(received.length, 1);
  assert.match(received[0], /Lifecycle SMTP body/);
  const send = db.prepare('SELECT status FROM sends WHERE campaign_id=?').get(campaignId);
  assert.equal(send.status, 'sent');
  const accepted = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='sent' AND lead_id=41").get().meta_json);
  assert.match(accepted.response, /Lifecycle SMTP sink accepted/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='campaign_paused'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='campaign_resumed'").get().count, 1);

  db.prepare("UPDATE campaigns SET status='completed' WHERE id=?").run(campaignId);
  const terminalQueue = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 1 } });
  assert.equal(terminalQueue.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 1);
});

test('empty draft campaigns cannot be paused or resumed before launch', async () => {
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Unlaunched draft' } });
  assert.equal((await request(`/api/sending/campaigns/${campaign.body.id}/pause`, { method: 'POST' })).status, 409);
  assert.equal((await request(`/api/sending/campaigns/${campaign.body.id}/resume`, { method: 'POST' })).status, 409);
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaign.body.id).status, 'draft');
});
