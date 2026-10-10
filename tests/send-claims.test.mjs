import './support/all-hours-send-window.js';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-send-claims-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { initDb, closeDb } = await import('../pipeline/database.js');
const { processSendQueue, recoverInterruptedSends, queueSends, getCampaignPreflight, getMailboxFleet } = await import('../pipeline/sending-engine.js');
const { getCampaignAudience, getCampaignRecipientPolicy } = await import('../pipeline/campaign-audience.js');
const db = initDb();

const received = [];
let dropSmtpReply = false;
let smtp;
smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture auth rejected'));
    callback(null, { user: 'fixture' });
  },
  onData(stream, _session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => {
      received.push(raw);
      if (dropSmtpReply) {
        for (const connection of smtp.connections) connection._socket.destroy();
        return;
      }
      setTimeout(() => callback(null, 'Atomic claim SMTP accepted'), 100);
    });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

beforeEach(() => {
  db.exec('DELETE FROM events; DELETE FROM sends; DELETE FROM personalizations; DELETE FROM campaign_enrollments; DELETE FROM campaign_senders; DELETE FROM lead_emails; DELETE FROM leads; DELETE FROM mailboxes; DELETE FROM campaigns;');
  received.length = 0;
  dropSmtpReply = false;
});

after(async () => {
  await new Promise(resolve => smtp.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function seed({ sendStatus = 'scheduled', host = '127.0.0.1', port = smtp.server.address().port } = {}) {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (1,'Claim Fixture','claim@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (1,'claim@example.test','deliverable')").run();
  db.prepare("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure) VALUES (1,'sender@example.test','example.test','eligible',50,100,1,?,?, 'fixture','fixture-only',0)")
    .run(host, port);
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (1,'Claim Fixture','active')").run();
  db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES (1,1)').run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (1,1)').run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (1,1,'Claim subject','Claim fixture body',1,1)").run();
  db.prepare('INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at,status) VALUES (1,1,1,1,1,?,?)')
    .run(new Date(Date.now() - 60_000).toISOString(), sendStatus);
  if (sendStatus === 'processing') {
    db.prepare(`INSERT INTO send_capacity_reservations(send_id,mailbox_id,domain,capacity_day,state)
      VALUES(1,1,'example.test',date('now'),'reserved')`).run();
  }
}

test('parallel queue calls submit a claimed send only once to the real loopback SMTP sink', async () => {
  seed();
  const outcomes = await Promise.all([processSendQueue({ limit: 1 }), processSendQueue({ limit: 1 })]);
  assert.equal(received.length, 1);
  assert.match(received[0], /Claim fixture body/);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=1').get().status, 'sent');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='sent'").get().count, 1);
  assert.equal(outcomes.filter(result => result.alreadyProcessing).length, 1);
  assert.equal(outcomes.find(result => !result.alreadyProcessing).sent, 1);
});

test('worker restart quarantines an unfinished SMTP claim and queueing cannot resend it', async () => {
  seed({ sendStatus: 'processing' });
  const recovered = recoverInterruptedSends();
  assert.deepEqual(recovered, { recovered: 1, sendIds: [1] });
  assert.equal(db.prepare('SELECT status,sent_at FROM sends WHERE id=1').get().status, 'uncertain');
  assert.equal(db.prepare('SELECT sent_at FROM sends WHERE id=1').get().sent_at, null);
  assert.equal(db.prepare('SELECT state FROM send_capacity_reservations WHERE send_id=1').get().state, 'uncertain',
    'a restarted in-flight submission keeps its daily capacity reserved until evidence-based reconciliation');
  assert.equal(getMailboxFleet()[0].today_reserved, 1);
  assert.equal(getCampaignRecipientPolicy(1, 1).eligibility, 'submission_uncertain');
  const audience = getCampaignAudience(1);
  assert.equal(audience.counts.byReason.submission_uncertain, 1);
  assert.equal(audience.counts.eligible || 0, 0);
  assert.equal((await queueSends(1, { limit: 1, reviewHash: getCampaignPreflight(1).reviewHash })).queued, 0);
  assert.equal((await processSendQueue({ limit: 1 })).processed, 0);
  assert.equal(received.length, 0);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=1').get().status, 'uncertain');
  const evidence = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='send_submission_uncertain'").get().meta_json);
  assert.equal(evidence.retry_policy, 'quarantined_no_automatic_resend');
  assert.equal(recoverInterruptedSends().recovered, 0, 'recovery is idempotent');
});

test('SMTP sink receives DATA but drops its final reply: outcome is quarantined and never resubmitted', async () => {
  seed();
  dropSmtpReply = true;
  const result = await processSendQueue({ limit: 1 });
  assert.equal(received.length, 1, 'the sink observed the submitted message before the connection closed');
  assert.match(received[0], /Claim fixture body/);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0, JSON.stringify(result));
  assert.equal(result.uncertain, 1);
  assert.equal(db.prepare('SELECT status,sent_at FROM sends WHERE id=1').get().status, 'uncertain');
  assert.equal(db.prepare('SELECT state FROM send_capacity_reservations WHERE send_id=1').get().state, 'uncertain');
  assert.equal(getCampaignRecipientPolicy(1, 1).eligibility, 'submission_uncertain');
  assert.equal((await queueSends(1, { limit: 1, reviewHash: getCampaignPreflight(1).reviewHash })).queued, 0);
  assert.equal((await processSendQueue({ limit: 1 })).processed, 0);
  assert.equal(received.length, 1, 'no automatic retry is allowed without reconciliation evidence');
  const evidence = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='send_submission_uncertain'").get().meta_json);
  assert.equal(evidence.retry_policy, 'quarantined_no_automatic_resend');
});
