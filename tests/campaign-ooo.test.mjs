import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-ooo-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
let db = database.initDb();
const accepted = [];
let holdSmtpFor = null;
let notifySmtpEntered = null;
let releaseSmtpMessage = null;
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture auth rejected'));
    callback(null, { user: 'fixture' });
  },
  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => {
      accepted.push({ raw, recipients: session.envelope.rcptTo.map(item => item.address) });
      if (session.envelope.rcptTo.some(item => item.address === holdSmtpFor)) {
        notifySmtpEntered?.();
        releaseSmtpMessage = () => callback(null, 'OOO fixture accepted after controlled hold');
        return;
      }
      callback(null, 'OOO fixture accepted by SMTP sink');
    });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const worker = await import('../pipeline/sending-engine.js');
const { parseOutOfOfficeReturnDate } = await import('../pipeline/reply-tracker.js');

after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => smtp.close(resolve))]);
  database.closeDb();
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
  let payload = {};
  try { payload = await response.json(); } catch { /* preserve status for non-JSON errors */ }
  return { status: response.status, body: payload };
}

function dateAfter(days) {
  const date = new Date(Date.now() + days * 86400000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addContact(id, email) {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,'queued')").run(id, `OOO Contact ${id}`, email);
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?,'deliverable',datetime('now'))").run(id, email);
  db.prepare('INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (?,?,?,1,1)')
    .run(id, `Approved OOO copy ${id}`, `Approved OOO message ${id}`);
}

async function createSequence(id, email, stepCount = 2) {
  addContact(id, email);
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: `OOO sequence ${id}` } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const campaignId = created.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, id);
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'ooo-sender@example.test','example.test','eligible',50,100,1,'127.0.0.1',?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET smtp_host=excluded.smtp_host,smtp_port=excluded.smtp_port,smtp_user=excluded.smtp_user,
      smtp_pass=excluded.smtp_pass,warmup_status='eligible',daily_limit=50,active=1,health_score=100`)
    .run(smtp.server.address().port, 'fixture', 'fixture-only');
  const sender = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [1] } });
  assert.equal(sender.status, 200, JSON.stringify(sender.body));
  const steps = [];
  for (let position = 0; position < stepCount; position++) {
    const step = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, { method: 'POST', body: position ? { delayDays: 1 } : {} });
    assert.equal(step.status, 201, JSON.stringify(step.body));
    const stepId = step.body.steps.at(-1).id;
    steps.push(stepId);
    const copy = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${stepId}`, {
      method: 'PUT', body: { variants: [
        { variantKey: 'A', allocationPct: 100, subjectLine: `Step ${position + 1} for {{business_name}}`, bodyText: `Message ${position + 1} for {{business_name}}.` },
        { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
      ] },
    });
    assert.equal(copy.status, 200, JSON.stringify(copy.body));
  }
  const queued = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 10 } });
  assert.equal(queued.body.queued, 1, JSON.stringify(queued.body));
  const first = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=?').get(campaignId, id);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(first.id);
  const outcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(outcome.sent, 1, JSON.stringify(outcome));
  assert.equal(accepted.at(-1).recipients[0], email, 'SMTP sink accepted the first step');
  const sentEvent = db.prepare("SELECT meta_json FROM events WHERE send_id=? AND event_type='sent'").get(first.id);
  assert.ok(sentEvent);
  const messageId = JSON.parse(sentEvent.meta_json).messageId;
  const followup = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?').get(campaignId, id, steps[1]);
  assert.equal(followup.status, 'scheduled');
  return { campaignId, id, email, first, messageId, followup, steps };
}

function reopenDatabase() {
  database.closeDb();
  db = database.initDb();
}

test('OOO date parsing accepts explicit future dates and refuses vague, invalid, or past dates', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  assert.equal(parseOutOfOfficeReturnDate('Out of office; returning on 2026-10-18.', now), '2026-10-18');
  assert.equal(parseOutOfOfficeReturnDate('I will be back October 20, 2026.', now), '2026-10-20');
  assert.equal(parseOutOfOfficeReturnDate('I return on 10/22/2026.', now), '2026-10-22');
  assert.equal(parseOutOfOfficeReturnDate('Out of office; back next week.', now), null);
  assert.equal(parseOutOfOfficeReturnDate('Returning February 30, 2027.', now), null);
  assert.equal(parseOutOfOfficeReturnDate('I returned on 2026-10-08.', now), null);
});

test('dated OOO replies persist a hold across restart and the worker never submits during it', async () => {
  const sequence = await createSequence(821, 'dated-ooo@recipient.test');
  const returnDate = dateAfter(5);
  const beforeReply = accepted.length;
  const reply = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: sequence.email, toMailboxEmail: 'ooo-sender@example.test',
    subject: 'Automatic reply: out of office', body: `I am out of office and returning on ${returnDate}.`,
    messageId: '<dated-ooo-reply@recipient.test>', inReplyTo: sequence.messageId,
  } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.sentiment, 'out_of_office');
  const expectedDefer = db.prepare("SELECT datetime(?, '+1 day') AS value").get(returnDate).value;
  let enrollment = db.prepare('SELECT status,defer_until,defer_manual_review FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
    .get(sequence.campaignId, sequence.id);
  assert.equal(enrollment.status, 'active', 'an OOO auto-reply defers rather than permanently stopping the sequence');
  assert.equal(enrollment.defer_until, expectedDefer);
  assert.equal(enrollment.defer_manual_review, 0);
  assert.equal(db.prepare('SELECT scheduled_at FROM sends WHERE id=?').get(sequence.followup.id).scheduled_at, expectedDefer);
  let audience = await request(`/api/sending/campaigns/${sequence.campaignId}/audience`);
  assert.equal(audience.body.items[0].eligibility, 'out_of_office_deferred');
  assert.equal(audience.body.counts.deferred, 1);
  reopenDatabase();
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(sequence.followup.id);
  const held = await worker.processSendQueue({ limit: 10 });
  assert.equal(held.deferred, 1, JSON.stringify(held));
  assert.equal(db.prepare('SELECT status,scheduled_at FROM sends WHERE id=?').get(sequence.followup.id).status, 'scheduled');
  assert.equal(db.prepare('SELECT scheduled_at FROM sends WHERE id=?').get(sequence.followup.id).scheduled_at, expectedDefer);
  assert.equal(accepted.length, beforeReply, 'no follow-up DATA reached the SMTP sink during the OOO hold');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE send_id=? AND event_type='send_deferred'").get(sequence.followup.id).n, 1);
  enrollment = db.prepare('SELECT status,defer_until FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(sequence.campaignId, sequence.id);
  assert.equal(enrollment.status, 'active');
  assert.equal(enrollment.defer_until, expectedDefer);
});

test('OOO replies without a usable date require operator reactivation before the existing worker can send', async () => {
  const sequence = await createSequence(822, 'manual-ooo@recipient.test');
  const beforeReply = accepted.length;
  const reply = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: sequence.email, toMailboxEmail: 'ooo-sender@example.test',
    subject: 'Out of office', body: 'I am out of office and will return sometime soon.',
    messageId: '<manual-ooo-reply@recipient.test>', inReplyTo: sequence.messageId,
  } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.sentiment, 'out_of_office');
  assert.equal(db.prepare('SELECT scheduled_at FROM sends WHERE id=?').get(sequence.followup.id).scheduled_at, null);
  const waiting = db.prepare('SELECT status,defer_manual_review FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
    .get(sequence.campaignId, sequence.id);
  assert.deepEqual(waiting, { status: 'active', defer_manual_review: 1 });
  let audience = await request(`/api/sending/campaigns/${sequence.campaignId}/audience`);
  assert.equal(audience.body.items[0].eligibility, 'out_of_office_review');
  assert.equal((await worker.processSendQueue({ limit: 10 })).processed, 0);
  assert.equal(accepted.length, beforeReply, 'a parked follow-up must not reach SMTP');
  reopenDatabase();
  const resumed = await request(`/api/sending/campaigns/${sequence.campaignId}/audience/${sequence.id}/reactivate`, { method: 'POST' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(db.prepare('SELECT defer_manual_review FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
    .get(sequence.campaignId, sequence.id).defer_manual_review, 0);
  assert.ok(Date.parse(db.prepare('SELECT scheduled_at FROM sends WHERE id=?').get(sequence.followup.id).scheduled_at) <= Date.now());
  const sent = await worker.processSendQueue({ limit: 10 });
  assert.equal(sent.sent, 1, JSON.stringify(sent));
  assert.equal(accepted.length, beforeReply + 1, 'operator reactivation reaches the actual loopback SMTP sink');
  assert.equal(accepted.at(-1).recipients[0], sequence.email);
  audience = await request(`/api/sending/campaigns/${sequence.campaignId}/audience`);
  assert.equal(audience.body.items[0].eligibility, 'completed');
});

test('OOO during an in-flight accepted step holds the newly created next step instead of stopping the sequence', async () => {
  const sequence = await createSequence(823, 'inflight-ooo@recipient.test', 3);
  const beforeFollowup = accepted.length;
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(sequence.followup.id);
  holdSmtpFor = sequence.email;
  const entered = new Promise(resolve => { notifySmtpEntered = resolve; });
  const processing = worker.processSendQueue({ limit: 10 });
  await entered;
  const reply = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: sequence.email, toMailboxEmail: 'ooo-sender@example.test',
    subject: 'Out of office', body: 'I am out of office and will return sometime soon.',
    messageId: '<inflight-ooo-reply@recipient.test>', inReplyTo: sequence.messageId,
  } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.sentiment, 'out_of_office');
  assert.equal(db.prepare('SELECT status,defer_manual_review FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
    .get(sequence.campaignId, sequence.id).status, 'active');
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(sequence.followup.id).status, 'processing', 'an in-flight SMTP submission is not falsified as cancelled');
  releaseSmtpMessage();
  const acceptedOutcome = await processing;
  holdSmtpFor = null;
  notifySmtpEntered = null;
  releaseSmtpMessage = null;
  assert.equal(acceptedOutcome.sent, 1, JSON.stringify(acceptedOutcome));
  assert.equal(accepted.length, beforeFollowup + 1, 'the actual in-flight follow-up reached the loopback sink');
  const nextStep = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?')
    .get(sequence.campaignId, sequence.id, sequence.steps[2]);
  assert.ok(nextStep);
  assert.equal(nextStep.status, 'scheduled');
  assert.equal(nextStep.scheduled_at, null, 'a step created after an in-flight OOO reply inherits the manual hold');
  assert.equal(db.prepare('SELECT defer_manual_review FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
    .get(sequence.campaignId, sequence.id).defer_manual_review, 1);
  const resumed = await request(`/api/sending/campaigns/${sequence.campaignId}/audience/${sequence.id}/reactivate`, { method: 'POST' });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal((await worker.processSendQueue({ limit: 10 })).sent, 1);
  assert.equal(accepted.length, beforeFollowup + 2, 'operator review releases the inherited hold through the real worker');
});
