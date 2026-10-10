import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-send-window-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_SEND_WINDOW_TIMEZONE = 'America/Chicago';
process.env.ODD_SEND_WINDOW_START_HOUR = '8';
process.env.ODD_SEND_WINDOW_END_HOUR = '17';
process.env.ODD_SEND_WINDOW_WEEKDAYS_ONLY = 'true';

const { getSendWindowState, isWithinSendWindow, nextAllowedSendTime } = await import('../pipeline/sending-schedule.js');
const windowConfig = JSON.parse(readFileSync(new URL('../config/sending-engine.json', import.meta.url), 'utf8')).send_window;
const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const accepted = [];
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, callback) {
    if (auth.username !== 'fixture' || auth.password !== 'fixture-only') return callback(new Error('Fixture auth rejected'));
    callback(null, { user: 'fixture' });
  },
  onData(stream, _session, callback) {
    let raw = '';
    stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => { accepted.push(raw); callback(null, 'Send window sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
const engine = await import('../pipeline/sending-engine.js');

after(async () => {
  await new Promise(resolve => smtp.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('send-window calculation honors IANA timezone, weekday policy, boundary hours, and DST', () => {
  const mondayAtEightChicago = new Date('2026-10-12T13:00:00.000Z');
  assert.equal(isWithinSendWindow(mondayAtEightChicago, windowConfig), true);
  assert.equal(isWithinSendWindow(new Date('2026-10-12T22:00:00.000Z'), windowConfig), false, 'the end hour is exclusive');
  assert.equal(nextAllowedSendTime(new Date('2026-10-12T22:00:00.000Z'), windowConfig).toISOString(), '2026-10-13T13:00:00.000Z');
  assert.equal(nextAllowedSendTime(new Date('2026-10-10T15:00:00.000Z'), windowConfig).toISOString(), '2026-10-12T13:00:00.000Z', 'weekends roll to Monday morning');
  assert.equal(nextAllowedSendTime(new Date('2026-03-08T15:00:00.000Z'), windowConfig).toISOString(), '2026-03-09T13:00:00.000Z', 'DST transitions preserve the configured local start hour');
});

test('the existing send worker submits only inside its configured window and persists the next due time otherwise', async () => {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (801,'Window contact','window@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (801,'window@example.test','deliverable',datetime('now'))").run();
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (801,'window-sender@example.test','example.test','eligible',50,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (801,'Window fixture','active')").run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (801,801)').run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (801,801,'Window subject','Window fixture body',1,1)").run();
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at,status)
    VALUES (801,801,801,801,801,datetime('now','-1 minute'),'scheduled')`).run();

  const outcome = await engine.processSendQueue({ limit: 1 });
  const send = db.prepare('SELECT status,scheduled_at,sent_at FROM sends WHERE id=801').get();
  if (send.status === 'sent') {
    assert.equal(outcome.sent, 1);
    assert.equal(accepted.length, 1);
    assert.match(accepted[0], /Window fixture body/);
    assert.equal(isWithinSendWindow(new Date(`${send.sent_at.replace(' ', 'T')}Z`), windowConfig), true);
    const event = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE send_id=801 AND event_type='sent'").get().meta_json);
    assert.match(event.response, /Send window sink accepted/);
  } else {
    assert.equal(send.status, 'scheduled');
    assert.equal(outcome.deferred, 1);
    assert.equal(accepted.length, 0);
    const event = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE send_id=801 AND event_type='send_deferred'").get().meta_json);
    assert.equal(event.reason, 'outside_configured_send_window');
    assert.equal(new Date(event.nextDueAt).toISOString(), send.scheduled_at);
    assert.equal(isWithinSendWindow(new Date(event.nextDueAt), windowConfig), true);
  }

  const currentWindow = getSendWindowState(new Date(), windowConfig);
  assert.equal(Boolean(currentWindow.open), send.status === 'sent');
});
