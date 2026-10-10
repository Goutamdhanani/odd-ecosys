import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-sequence-execution-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const acceptedMessages = [];
let dropFinalResponseFor = null;
let smtp;
smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture auth rejected'));
    callback(null, { user: 'fixture' });
  },
  onData(stream, session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => {
      acceptedMessages.push({ raw, recipients: session.envelope.rcptTo.map(item => item.address) });
      if (session.envelope.rcptTo.some(item => item.address === dropFinalResponseFor)) {
        for (const connection of smtp.connections) connection._socket.destroy();
        return;
      }
      callback(null, 'Sequence fixture accepted by SMTP sink');
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
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

const worker = await import('../pipeline/sending-engine.js');

function addVerifiedContact(id, email) {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,'queued')").run(id, `Sequence contact ${id}`, email);
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?,'deliverable',datetime('now'))").run(id, email);
  db.prepare('INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (?,?,?,1,1)')
    .run(id, `Approved gate ${id}`, `Approved personalization gate ${id}`);
}

async function createSequence({ leadId, email, name, steps = 2 }) {
  addVerifiedContact(leadId, email);
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name } });
  assert.equal(campaign.status, 200);
  const campaignId = campaign.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
      smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'sequence-sender@example.test','example.test','eligible',50,100,1,'127.0.0.1',?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET smtp_host=excluded.smtp_host,smtp_port=excluded.smtp_port,
      smtp_user=excluded.smtp_user,smtp_pass=excluded.smtp_pass,warmup_status='eligible',daily_limit=50,active=1,health_score=100`)
    .run(smtp.server.address().port, 'fixture', 'fixture-only');
  const selected = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [1] } });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));

  const createdSteps = [];
  for (let position = 0; position < steps; position++) {
    const created = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, {
      method: 'POST', body: position ? { delayDays: 1 } : {},
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const step = created.body.steps.at(-1);
    createdSteps.push(step.id);
    const updated = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${step.id}`, {
      method: 'PUT', body: { variants: [
        { variantKey: 'A', allocationPct: 100, subjectLine: `Step ${position + 1} for {{business_name}}`, bodyText: `Body ${position + 1} for {{business_name}}.` },
        { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
      ] },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
  }
  return { campaignId, leadId, email, stepIds: createdSteps };
}

async function queueAndAcceptFirst(sequence, afterQueue = null) {
  const review = await request(`/api/sending/campaigns/${sequence.campaignId}/preflight`);
  const queue = await request(`/api/sending/queue/${sequence.campaignId}`, {
    method: 'POST', body: { limit: 10, reviewHash: review.body.reviewHash },
  });
  const afterQueueReview = await request(`/api/sending/campaigns/${sequence.campaignId}/preflight`);
  const duplicateDispatch = await request(`/api/sending/queue/${sequence.campaignId}`, {
    method: 'POST', body: { limit: 10, reviewHash: afterQueueReview.body.reviewHash },
  });
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.equal(duplicateDispatch.status, 200, JSON.stringify(duplicateDispatch.body));
  assert.equal(queue.body.queued + duplicateDispatch.body.queued, 1, 'duplicate queue dispatches must produce one first-step send');
  const first = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=?').get(sequence.campaignId, sequence.leadId);
  assert.equal(first.campaign_step_id, sequence.stepIds[0]);
  assert.equal(first.variant, 'A');
  assert.equal(first.subject_snapshot, `Step 1 for Sequence contact ${sequence.leadId}`);
  assert.equal(first.body_snapshot, `Body 1 for Sequence contact ${sequence.leadId}.`);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(first.id);
  await afterQueue?.();
  const outcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(outcome.sent, 1, JSON.stringify(outcome));
  assert.equal(acceptedMessages.length > 0, true, 'the loopback SMTP sink must observe the DATA payload');
  assert.match(acceptedMessages.at(-1).raw, new RegExp(`Body 1 for Sequence contact ${sequence.leadId}\\.`));
  const sentEvent = db.prepare("SELECT meta_json FROM events WHERE send_id=? AND event_type='sent'").get(first.id);
  assert.ok(sentEvent, 'SMTP acceptance must be persisted as a sent event');
  const evidence = JSON.parse(sentEvent.meta_json);
  assert.equal(evidence.delivery, 'unknown');
  assert.match(evidence.messageId, /^<[^<>\s\r\n]+>$/);
  return { first: db.prepare('SELECT * FROM sends WHERE id=?').get(first.id), evidence };
}

function reopenDatabase() {
  closeDb();
  db = initDb();
}

test('API queues step 1, SMTP acceptance persists the due follow-up, and restart preserves threading and completion', async () => {
  const sinkBaseline = acceptedMessages.length;
  const sequence = await createSequence({ leadId: 811, email: 'first@recipient.test', name: 'Two-step sequence' });
  const { first, evidence } = await queueAndAcceptFirst(sequence);
  let followup = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?')
    .get(sequence.campaignId, sequence.leadId, sequence.stepIds[1]);
  assert.ok(followup, 'a next step is created only after the sink accepts the preceding message');
  assert.equal(followup.status, 'scheduled');
  assert.equal(followup.campaign_launch_id, first.campaign_launch_id, 'the persisted follow-up retains the immutable launch binding');
  assert.equal(followup.mailbox_id, first.mailbox_id);
  assert.equal(followup.subject_snapshot, `Step 2 for Sequence contact ${sequence.leadId}`);
  assert.equal(followup.in_reply_to_message_id, evidence.messageId);
  assert.ok(Date.parse(followup.scheduled_at) >= Date.parse(first.sent_at) + 23 * 60 * 60 * 1000,
    `follow-up should respect the 1-day delay (stored ${followup.scheduled_at}, accepted ${first.sent_at})`);
  const audience = await request(`/api/sending/campaigns/${sequence.campaignId}/audience`);
  assert.equal(audience.body.counts.sequenceRunning, 1);
  assert.equal(audience.body.counts.acceptedSends, 1);
  assert.equal(audience.body.items[0].next_sequence_position, 2);
  assert.ok(audience.body.items[0].next_sequence_at);

  reopenDatabase();
  followup = db.prepare('SELECT * FROM sends WHERE id=?').get(followup.id);
  assert.equal(followup.status, 'scheduled', 'future step survives database close/reopen');
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
  const secondOutcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(secondOutcome.sent, 1, JSON.stringify(secondOutcome));
  assert.equal(acceptedMessages.length, sinkBaseline + 2, 'the sink accepted the follow-up after restart');
  assert.match(acceptedMessages[1].raw, /In-Reply-To:\s*<[^>]+>/i);
  assert.match(acceptedMessages[1].raw, new RegExp(`Body 2 for Sequence contact ${sequence.leadId}\\.`));
  assert.equal(db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(sequence.campaignId, sequence.leadId).status, 'completed');
  assert.equal(db.prepare('SELECT status FROM campaigns WHERE id=?').get(sequence.campaignId).status, 'completed');
  const completedAudience = await request(`/api/sending/campaigns/${sequence.campaignId}/audience`);
  assert.equal(completedAudience.body.counts.byReason.completed, 1);
  assert.equal(completedAudience.body.counts.acceptedSends, 2);
});

test('an attributed reply cancels persisted follow-ups and remains stopped across worker restart', async () => {
  const sinkBaseline = acceptedMessages.length;
  const sequence = await createSequence({ leadId: 812, email: 'reply@recipient.test', name: 'Reply stop sequence' });
  const { first, evidence } = await queueAndAcceptFirst(sequence);
  const followup = db.prepare('SELECT id,status FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?')
    .get(sequence.campaignId, sequence.leadId, sequence.stepIds[1]);
  assert.equal(followup.status, 'scheduled');
  reopenDatabase();
  const reply = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: sequence.email, toMailboxEmail: 'sequence-sender@example.test',
    subject: 'Re: your note', body: 'Interested, please send more info.',
    messageId: '<reply-812@recipient.test>', inReplyTo: evidence.messageId,
  } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.sendId, first.id);
  assert.equal(reply.body.sentiment, 'interested');
  assert.equal(db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(sequence.campaignId, sequence.leadId).status, 'stopped');
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled');
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
  const outcome = await worker.processSendQueue({ limit: 10 });
  assert.equal(outcome.processed, 0);
  assert.equal(acceptedMessages.length, sinkBaseline + 1, 'a reply blocks all later SMTP submissions');
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}/audience`)).body.counts.byReason.stopped, 1);
});

test('a reply from a unique stored contact alias is attributed and cancels the real sequence follow-up', async () => {
  const sinkBaseline = acceptedMessages.length;
  const sequence = await createSequence({ leadId: 815, email: 'primary-alias-contact@recipient.test', name: 'Alias reply stop sequence' });
  const alias = 'reply-alias@recipient.test';
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?,'deliverable',datetime('now'))")
    .run(sequence.leadId, alias);
  const { first, evidence } = await queueAndAcceptFirst(sequence);
  const followup = db.prepare('SELECT id,status FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?')
    .get(sequence.campaignId, sequence.leadId, sequence.stepIds[1]);
  const reply = await request('/api/replies/ingest', { method: 'POST', body: {
    fromEmail: alias, toMailboxEmail: 'sequence-sender@example.test', subject: 'Re: your note',
    body: 'Interested, please send more information.', messageId: '<alias-reply-815@recipient.test>', inReplyTo: evidence.messageId,
  } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.leadId, sequence.leadId);
  assert.equal(reply.body.sendId, first.id);
  assert.equal(reply.body.sendAttribution, 'in_reply_to');
  assert.equal(reply.body.sentiment, 'interested');
  assert.equal(db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
    .get(sequence.campaignId, sequence.leadId).status, 'stopped');
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled');
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
  assert.equal((await worker.processSendQueue({ limit: 10 })).processed, 0);
  assert.equal(acceptedMessages.length, sinkBaseline + 1, 'the alias reply prevents an additional SMTP submission');
});

test('an inbound reply stops its sequence before the optional AI classifier resolves', async () => {
  const sinkBaseline = acceptedMessages.length;
  const sequence = await createSequence({ leadId: 816, email: 'classifier-pending@recipient.test', name: 'Immediate reply stop' });
  const { evidence } = await queueAndAcceptFirst(sequence);
  const followup = db.prepare('SELECT id FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?')
    .get(sequence.campaignId, sequence.leadId, sequence.stepIds[1]);
  const originalFetch = globalThis.fetch;
  let markClassifierStarted;
  const classifierStarted = new Promise(resolve => { markClassifierStarted = resolve; });
  let releaseClassifier;
  let pendingReply;
  globalThis.fetch = (input, options) => {
    if (String(input).includes('/api/generate')) {
      markClassifierStarted();
      return new Promise(resolve => { releaseClassifier = resolve; });
    }
    return originalFetch(input, options);
  };
  try {
    pendingReply = request('/api/replies/ingest', { method: 'POST', body: {
      fromEmail: sequence.email, toMailboxEmail: 'sequence-sender@example.test',
      subject: 'Re: your note', body: 'Thank you for the details. I will consider it.',
      messageId: '<classifier-pending-reply@recipient.test>', inReplyTo: evidence.messageId,
    } });
    const started = await Promise.race([classifierStarted.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
    assert.equal(started, true, 'the unknown reply should enter the AI-classification path');
    assert.equal(db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
      .get(sequence.campaignId, sequence.leadId).status, 'stopped', 'reply persistence and stop happen before awaiting Ollama');
    assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled');
    assert.equal(acceptedMessages.length, sinkBaseline + 1, 'no follow-up is submitted while AI classification is pending');
    releaseClassifier(new Response('', { status: 503 }));
    const result = await pendingReply;
    assert.equal(result.status, 200);
    assert.equal(result.body.sentiment, 'unclassified', 'AI unavailability must not undo the immediate stop');
    const replyEvent = db.prepare("SELECT meta_json FROM events WHERE event_type='replied' AND lead_id=?").get(sequence.leadId);
    assert.equal(JSON.parse(replyEvent.meta_json).classificationState, 'complete');
  } finally {
    releaseClassifier?.(new Response('', { status: 503 }));
    globalThis.fetch = originalFetch;
    if (pendingReply) await pendingReply.catch(() => {});
  }
});

test('a due follow-up defers at sender capacity and rechecks current verification before submission', async () => {
  const sinkBaseline = acceptedMessages.length;
  const sequence = await createSequence({ leadId: 814, email: 'safety@recipient.test', name: 'Follow-up safety gates' });
  const { first } = await queueAndAcceptFirst(sequence, async () => {
    db.prepare("UPDATE sends SET sent_at=datetime('now','-1 day') WHERE mailbox_id=1 AND status='sent' AND campaign_id!=?").run(sequence.campaignId);
    db.prepare('UPDATE mailboxes SET daily_limit=1 WHERE id=1').run();
  });
  const followup = db.prepare('SELECT id,status FROM sends WHERE campaign_id=? AND lead_id=? AND campaign_step_id=?')
    .get(sequence.campaignId, sequence.leadId, sequence.stepIds[1]);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
  const deferred = await worker.processSendQueue({ limit: 10 });
  assert.equal(deferred.deferred, 1, JSON.stringify(deferred));
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'scheduled');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE send_id=? AND event_type='send_deferred'").get(followup.id).count, 1);
  assert.equal(acceptedMessages.length, sinkBaseline + 1);

  db.prepare('UPDATE mailboxes SET daily_limit=50 WHERE id=1').run();
  db.prepare("UPDATE lead_emails SET verification_status='unknown' WHERE lead_id=?").run(sequence.leadId);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
  const blocked = await worker.processSendQueue({ limit: 10 });
  assert.equal(blocked.blocked, 1, JSON.stringify(blocked));
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled');
  assert.equal(JSON.parse(db.prepare("SELECT meta_json FROM events WHERE send_id=? AND event_type='send_blocked'").get(followup.id).meta_json).reason, 'verification_required');
  assert.equal(db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(sequence.campaignId, sequence.leadId).status, 'stopped');
  assert.equal(acceptedMessages.length, sinkBaseline + 1, 'neither capacity deferral nor a stale verification may produce SMTP acceptance');
  assert.ok(first.sent_at);
});

test('SMTP DATA without a final response is quarantined and does not schedule or resend a sequence step', async () => {
  const sinkBaseline = acceptedMessages.length;
  const sequence = await createSequence({ leadId: 813, email: 'ambiguous@recipient.test', name: 'Ambiguous sequence', steps: 2 });
  const queue = await request(`/api/sending/queue/${sequence.campaignId}`, { method: 'POST', body: { limit: 10 } });
  assert.equal(queue.body.queued, 1);
  const first = db.prepare('SELECT * FROM sends WHERE campaign_id=? AND lead_id=?').get(sequence.campaignId, sequence.leadId);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(first.id);
  dropFinalResponseFor = sequence.email;
  const outcome = await worker.processSendQueue({ limit: 10 });
  dropFinalResponseFor = null;
  assert.equal(outcome.uncertain, 1, JSON.stringify(outcome));
  assert.equal(acceptedMessages.length, sinkBaseline + 1, 'the sink observed DATA before withholding its final SMTP reply');
  assert.equal(db.prepare('SELECT status,sent_at FROM sends WHERE id=?').get(first.id).status, 'uncertain');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=? AND campaign_step_id=?').get(sequence.campaignId, sequence.stepIds[1]).count, 0,
    'an uncertain SMTP submission must not advance the sequence');
  assert.equal((await request(`/api/sending/queue/${sequence.campaignId}`, { method: 'POST', body: { limit: 10 } })).body.queued, 0);
  assert.equal((await worker.processSendQueue({ limit: 10 })).processed, 0);
  assert.equal(acceptedMessages.length, sinkBaseline + 1, 'uncertain submissions are never automatically retried');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE send_id=? AND event_type='send_submission_uncertain'").get(first.id).count, 1);
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}/audience`)).body.counts.byReason.submission_uncertain, 1);
});
