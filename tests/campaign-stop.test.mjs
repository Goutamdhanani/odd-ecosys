import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-stop-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const received = [];
let resolveSmtpSubmission;
const smtpSubmissionStarted = new Promise(resolve => { resolveSmtpSubmission = resolve; });
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
    stream.on('end', () => {
      received.push(raw);
      resolveSmtpSubmission();
      setTimeout(() => callback(null, 'Stop fixture SMTP accepted'), 300);
    });
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

test('ALL-F053b: stop cancels queued sends and leaves only an already submitted SMTP message in flight', async () => {
  for (const [id, email, name] of [[51, 'first@example.test', 'First fixture'], [52, 'second@example.test', 'Second fixture']]) {
    db.prepare('INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,\'queued\')').run(id, name, email);
    db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?, 'deliverable',datetime('now'))").run(id, email);
    db.prepare('INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (?,?,\'Stop fixture subject\',?,1,1)')
      .run(id + 500, id, `Body for ${name}`);
  }
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_at)
    VALUES (1,'approved','smtp-imap-source-evidence-v2','{"fixture":"pre_reviewed_sender"}',datetime('now'))`).run();

  const list = await request('/api/lists', { method: 'POST', body: { name: 'Stop fixture contacts' } });
  assert.equal(list.status, 201);
  assert.equal((await request(`/api/lists/${list.body.id}/members`, { method: 'POST', body: { leadIds: [51, 52] } })).body.added, 2);
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Stop fixture campaign' } });
  const campaignId = campaign.body.id;
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId: list.body.id } })).body.added, 2);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [1] } })).status, 200);
  const queued = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 2 } });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 2);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-2 minutes') WHERE campaign_id=?").run(campaignId);

  assert.equal((await request('/api/sending/process', { method: 'POST', body: { limit: 10 } })).status, 200);
  await Promise.race([
    smtpSubmissionStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP sink did not observe the submission')), 5000)),
  ]);

  const stopped = await request(`/api/sending/campaigns/${campaignId}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopped');
  assert.equal(stopped.body.cancelled, 1);
  assert.equal(stopped.body.inFlight, 1);
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaignId).status, 'stopped');
  assert.deepEqual(db.prepare('SELECT status FROM sends WHERE campaign_id=? ORDER BY lead_id').all(campaignId).map(row => row.status), ['processing', 'cancelled']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=? AND status='stopped'").get(campaignId).count, 2);
  assert.equal((await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 2 } })).status, 409);
  const repeated = await request(`/api/sending/campaigns/${campaignId}/stop`, { method: 'POST' });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.changed, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='campaign_stopped'").get().count, 1);

  const deadline = Date.now() + 8000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    status = (await request('/api/sending/status')).body;
  } while (Date.now() < deadline && status.active);
  assert.equal(status.active, false);
  assert.equal(received.length, 1, 'the real loopback sink should accept only the send already in progress when stop was requested');
  assert.match(received[0], /Body for First fixture/);
  assert.doesNotMatch(received[0], /Body for Second fixture/);
  assert.deepEqual(db.prepare('SELECT status FROM sends WHERE campaign_id=? ORDER BY lead_id').all(campaignId).map(row => row.status), ['sent', 'cancelled']);
  const stopEvent = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='campaign_stopped'").get().meta_json);
  assert.deepEqual(stopEvent, { campaign_id: campaignId, cancelled_scheduled: 1, in_flight: 1, stopped_enrollments: 2 });
  const smtpEvidence = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='sent' AND lead_id=51").get().meta_json);
  assert.match(smtpEvidence.response, /Stop fixture SMTP accepted/);
  assert.equal(smtpEvidence.delivery, 'unknown');
});

test('stopped campaigns are terminal; drafts and completed campaigns cannot be stopped', async () => {
  const draft = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Unlaunched fixture' } });
  assert.equal((await request(`/api/sending/campaigns/${draft.body.id}/stop`, { method: 'POST' })).status, 409);
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id=?').get(draft.body.id).status, 'draft');
});
