import { seedSyntheticCampaignSendReview } from './support/reviewed-mailbox-fixture.mjs';
import './support/all-hours-send-window.js';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-smtp-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { initDb, closeDb } = await import('../pipeline/database.js');
const { sendTestEmail, testMailboxSmtp, processSendQueue, pauseMailbox } = await import('../pipeline/sending-engine.js');
const db = initDb();
beforeEach(() => {
  db.exec('DELETE FROM events; DELETE FROM sends; DELETE FROM personalizations; DELETE FROM lead_emails; DELETE FROM suppression_list; DELETE FROM leads; DELETE FROM mailboxes; DELETE FROM campaigns;');
});
after(() => { closeDb(); delete process.env.ODD_DB_PATH; rmSync(directory, { recursive: true, force: true }); });

function fixture(smtp = {}) {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (1,'Fixture','recipient@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status) VALUES (1,'recipient@example.test','deliverable')").run();
  db.prepare("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure) VALUES (1,'sender@example.test','example.test','eligible',100,?,?,?,?,0)")
    .run(smtp.host || null, smtp.port || 587, smtp.user || null, smtp.pass || null);
  seedSyntheticCampaignSendReview(db, 1);
  db.prepare("INSERT INTO campaigns(id,name) VALUES (1,'Fixture')").run();
  db.prepare("INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (1,1)").run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (1,1,'Fixture subject','Fixture body',1,1)").run();
  db.prepare("INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at) VALUES (1,1,1,1,1,?)")
    .run(new Date(Date.now() - 60000).toISOString());
}
async function localSmtp({ rejectAuth = false, rejectRecipient = false, rejectDataCode = null } = {}) {
  const messages = [];
  let connections = 0;
  const server = new SMTPServer({
    disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
    onConnect(session, callback) { connections++; callback(); },
    onAuth(auth, session, callback) {
      if (rejectAuth) { const err = new Error('Authentication refused'); err.responseCode = 535; callback(err); }
      else callback(null, { user: 'fixture' });
    },
    onRcptTo(address, session, callback) {
      if (rejectRecipient) { const err = new Error('Recipient refused'); err.responseCode = 550; callback(err); }
      else callback();
    },
    onData(stream, session, callback) {
      let message = '';
      stream.on('data', chunk => { message += chunk; });
      stream.on('end', () => {
        messages.push(message);
        if (rejectDataCode) {
          const error = new Error('Fixture provider rejected DATA');
          error.responseCode = rejectDataCode;
          callback(error);
          return;
        }
        callback(null, 'Fixture accepted');
      });
    },
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { messages, get connections() { return connections; }, port: server.server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}
test('B01: missing SMTP config fails without inserting fake events', async () => {
  fixture();
  const result = await sendTestEmail(1, 'recipient@example.test');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SMTP_NOT_CONFIGURED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});
test('B02/B17: ISO scheduled queue without SMTP fails with no sent timestamp or bounce', async () => {
  fixture();
  const result = await processSendQueue({ limit: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1, JSON.stringify({ result, events: db.prepare('SELECT event_type,meta_json FROM events').all() }));
  const send = db.prepare('SELECT * FROM sends WHERE id=1').get();
  assert.equal(send.status, 'failed');
  assert.equal(send.sent_at, null);
  assert.match(send.error_message, /not configured/);
  assert.deepEqual(db.prepare('SELECT event_type FROM events').all().map(x => x.event_type), ['send_failed']);
  assert.equal(JSON.parse(db.prepare('SELECT meta_json FROM events').get().meta_json).failure_class, 'configuration');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=1').get().status, 'queued');
});

test('holding a mailbox after a send was queued blocks it before opening SMTP', async () => {
  const sink = await localSmtp();
  try {
    fixture({ host: '127.0.0.1', port: sink.port, user: 'fixture', pass: 'fixture-only' });
    pauseMailbox(1);
    const result = await processSendQueue({ limit: 1 });
    assert.equal(result.sent, 0);
    assert.equal(result.blocked, 1);
    assert.equal(sink.connections, 0, 'the worker stops at its final readiness gate before connecting');
    assert.equal(db.prepare('SELECT status FROM sends WHERE id=1').get().status, 'cancelled');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='sent'").get().n, 0);
  } finally {
    await sink.close();
  }
});
test('B03: real local SMTP accepts message but no delivery event is fabricated', async () => {
  const smtp = await localSmtp();
  try {
    fixture({ host: '127.0.0.1', port: smtp.port, user: 'fixture', pass: 'fixture-only' });
    const result = await processSendQueue({ limit: 1 });
    assert.equal(result.sent, 1);
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /Fixture body/);
    const send = db.prepare('SELECT * FROM sends WHERE id=1').get();
    assert.equal(send.status, 'sent');
    assert.ok(send.sent_at);
    const events = db.prepare('SELECT * FROM events').all();
    assert.deepEqual(events.map(x => x.event_type), ['send_attempt_started', 'sent']);
    assert.ok(Date.parse(events[0].event_at) <= Date.parse(events[1].event_at), 'submission attempt is recorded before SMTP acceptance');
    assert.equal(JSON.parse(events[1].meta_json).smtp_acceptance, 'confirmed');
    assert.equal(JSON.parse(events[1].meta_json).delivery, 'unknown');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='delivered'").get().n, 0,
      'SMTP acceptance must not create a delivery timestamp');
  } finally { await smtp.close(); }
});
test('real SMTP test message records acceptance and reports unknown delivery', async () => {
  const smtp = await localSmtp();
  try {
    fixture({ host: '127.0.0.1', port: smtp.port, user: 'fixture', pass: 'fixture-only' });
    const result = await sendTestEmail(1, 'recipient@example.test');
    assert.equal(result.ok, true);
    assert.equal(result.delivery, 'unknown');
    assert.equal(smtp.messages.length, 1);
  } finally { await smtp.close(); }
});
test('SMTP connection test requires complete credentials and never probes with partial settings', async () => {
  const smtp = await localSmtp();
  try {
    for (const partial of [{ host: '127.0.0.1', user: 'fixture' }, { host: '127.0.0.1', pass: 'fixture-only' }]) {
      beforeFixtureReset();
      fixture({ ...partial, port: smtp.port });
      const result = await testMailboxSmtp(1);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SMTP_INCOMPLETE_CONFIG');
      assert.equal(result.configured, false);
    }
    assert.equal(smtp.connections, 0, 'partial credentials must not initiate an SMTP connection');
  } finally { await smtp.close(); }
});
test('SMTP connection test rejects malformed hosts and out-of-range ports before networking', async () => {
  const smtp = await localSmtp();
  try {
    for (const invalid of [
      { host: 'https://127.0.0.1', port: smtp.port, user: 'fixture', pass: 'fixture-only' },
      { host: '127.0.0.1', port: 70000, user: 'fixture', pass: 'fixture-only' },
    ]) {
      beforeFixtureReset();
      fixture(invalid);
      const result = await testMailboxSmtp(1);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'SMTP_INVALID_CONFIG');
      assert.equal(result.configured, false);
    }
    assert.equal(smtp.connections, 0, 'invalid settings must be rejected before network access');
  } finally { await smtp.close(); }
});
test('SMTP connection test verifies a real loopback server when settings are valid', async () => {
  const smtp = await localSmtp();
  try {
    fixture({ host: '127.0.0.1', port: smtp.port, user: 'fixture', pass: 'fixture-only' });
    const result = await testMailboxSmtp(1);
    assert.equal(result.ok, true);
    assert.equal(result.configured, true);
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.port, smtp.port);
    assert.ok(smtp.connections > 0, 'valid configuration must use the SMTP server');
  } finally { await smtp.close(); }
});
test('B01: malformed SMTP host and invalid port fail both send paths without success artifacts', async () => {
  fixture({ host: 'https://127.0.0.1', port: 587, user: 'fixture', pass: 'fixture-only' });
  const testSend = await sendTestEmail(1, 'recipient@example.test');
  assert.equal(testSend.ok, false);
  assert.equal(testSend.code, 'SMTP_INVALID_CONFIG');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);

  beforeFixtureReset();
  fixture({ host: '127.0.0.1', port: 70000, user: 'fixture', pass: 'fixture-only' });
  const queue = await processSendQueue({ limit: 1 });
  assert.equal(queue.sent, 0);
  assert.equal(queue.failed, 1);
  const send = db.prepare('SELECT status,sent_at,error_message FROM sends WHERE id=1').get();
  assert.equal(send.status, 'failed');
  assert.equal(send.sent_at, null);
  assert.match(send.error_message, /port must be an integer/i);
  const event = db.prepare('SELECT event_type,meta_json FROM events').get();
  assert.equal(event.event_type, 'send_failed');
  assert.equal(JSON.parse(event.meta_json).code, 'SMTP_INVALID_CONFIG');
});
test('SMTP authentication and recipient rejection cannot produce successful sends', async () => {
  for (const options of [{ rejectAuth: true }, { rejectRecipient: true }]) {
    beforeFixtureReset();
    const smtp = await localSmtp(options);
    try {
      fixture({ host: '127.0.0.1', port: smtp.port, user: 'fixture', pass: 'fixture-only' });
      const result = await processSendQueue({ limit: 1 });
      assert.equal(result.sent, 0);
      assert.equal(result.failed, 1);
      assert.equal(smtp.messages.length, 0);
      assert.equal(db.prepare('SELECT sent_at FROM sends WHERE id=1').get().sent_at, null);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type IN ('sent','delivered','soft_bounce')").get().n, 0);
      const failedEvent = db.prepare("SELECT event_type,meta_json FROM events WHERE event_type='send_failed'").get();
      assert.ok(failedEvent, 'known SMTP rejections are recorded as failures');
      const failure = JSON.parse(failedEvent.meta_json);
      assert.equal(failure.failure_class, options.rejectAuth ? 'authentication' : 'smtp_permanent_rejection');
    } finally { await smtp.close(); }
  }
});

test('B17: SMTP temporary and permanent DATA rejections persist provider classification without sent or bounce evidence', async () => {
  for (const [responseCode, expectedClass] of [[451, 'smtp_temporary_rejection'], [554, 'smtp_permanent_rejection']]) {
    beforeFixtureReset();
    const smtp = await localSmtp({ rejectDataCode: responseCode });
    try {
      fixture({ host: '127.0.0.1', port: smtp.port, user: 'fixture', pass: 'fixture-only' });
      const result = await processSendQueue({ limit: 1 });
      assert.equal(result.sent, 0);
      assert.equal(result.failed, 1);
      assert.equal(smtp.messages.length, 1, 'the loopback provider received the DATA content before its explicit rejection');
      const send = db.prepare('SELECT status,sent_at FROM sends WHERE id=1').get();
      assert.equal(send.status, 'failed');
      assert.equal(send.sent_at, null);
      const events = db.prepare('SELECT event_type,meta_json FROM events ORDER BY id').all();
      assert.deepEqual(events.map(event => event.event_type), ['send_attempt_started', 'send_failed']);
      const failure = JSON.parse(events[1].meta_json);
      assert.equal(failure.failure_class, expectedClass);
      assert.equal(failure.smtp_response_code, responseCode);
      assert.equal(failure.retry_policy, 'known_not_accepted');
      assert.equal(events.some(event => ['sent', 'delivered', 'soft_bounce', 'hard_bounce'].includes(event.event_type)), false);
    } finally { await smtp.close(); }
  }
});

test('pre-SMTP policy gate cancels sends after verification becomes stale or an address is suppressed', async () => {
  fixture();
  db.prepare("UPDATE lead_emails SET verification_status='unknown' WHERE lead_id=1").run();
  const unverified = await processSendQueue({ limit: 1 });
  assert.equal(unverified.sent, 0);
  assert.equal(unverified.failed, 0);
  assert.equal(unverified.blocked, 1);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=1').get().status, 'cancelled');
  assert.equal(JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='send_blocked'").get().meta_json).reason, 'verification_required');

  beforeFixtureReset();
  fixture();
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('recipient@example.test','unsubscribe_request')").run();
  const suppressed = await processSendQueue({ limit: 1 });
  assert.equal(suppressed.sent, 0);
  assert.equal(suppressed.blocked, 1);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=1').get().status, 'cancelled');
  assert.equal(JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='send_blocked'").get().meta_json).reason, 'suppressed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='send_failed'").get().n, 0);
});

function beforeFixtureReset() {
  db.exec('DELETE FROM events; DELETE FROM sends; DELETE FROM personalizations; DELETE FROM lead_emails; DELETE FROM suppression_list; DELETE FROM leads; DELETE FROM mailboxes; DELETE FROM campaigns;');
}

const partialConfigs = [
  ['host only', { host: '127.0.0.1' }],
  ['host+user without password', { host: '127.0.0.1', user: 'fixture' }],
  ['user+pass without host', { user: 'fixture', pass: 'fixture-only' }],
  ['password only', { pass: 'fixture-only' }],
];

for (const [label, smtp] of partialConfigs) {
  test(`B01: partial SMTP config (${label}) is a disconnected error with zero send records`, async () => {
    fixture(smtp);
    try {
      const result = await sendTestEmail(1, 'recipient@example.test');
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.code, 'SMTP_INCOMPLETE_CONFIG');
      assert.equal(result.mode, 'unavailable');
      assert.match(result.error, /required|present/i);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0, 'no events may be inserted');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' OR sent_at IS NOT NULL").get().n, 0, 'no send may be marked sent');
    } finally { beforeFixtureReset(); }
  });

  test(`B01: partial SMTP config (${label}) fails the queue path without success artifacts`, async () => {
    fixture(smtp);
    try {
      const result = await processSendQueue({ limit: 1 });
      assert.equal(result.sent, 0);
      assert.equal(result.failed, 1);
      const send = db.prepare('SELECT * FROM sends WHERE id=1').get();
      assert.equal(send.status, 'failed');
      assert.equal(send.sent_at, null);
      assert.deepEqual(db.prepare('SELECT event_type FROM events').all().map(x => x.event_type), ['send_failed']);
      assert.equal(JSON.parse(db.prepare('SELECT meta_json FROM events').get().meta_json).code, 'SMTP_INCOMPLETE_CONFIG');
    } finally { beforeFixtureReset(); }
  });
}

test('B01: revoked credentials (auth rejected on test send) throw without recording a sent event', async () => {
  const smtp = await localSmtp({ rejectAuth: true });
  try {
    fixture({ host: '127.0.0.1', port: smtp.port, user: 'fixture', pass: 'revoked-fixture' });
    await assert.rejects(() => sendTestEmail(1, 'recipient@example.test'));
    assert.equal(smtp.messages.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type IN ('sent','delivered')").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' OR sent_at IS NOT NULL").get().n, 0);
  } finally { await smtp.close(); }
});
