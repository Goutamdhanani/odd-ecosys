import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-sender-pacing-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_SEND_WINDOW_TIMEZONE = 'UTC';
process.env.ODD_SEND_WINDOW_START_HOUR = '0';
process.env.ODD_SEND_WINDOW_END_HOUR = '24';
process.env.ODD_SEND_WINDOW_WEEKDAYS_ONLY = 'false';

const database = await import('../pipeline/database.js');
let db = database.initDb();
const acceptedMessages = [];
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
    stream.on('end', () => { acceptedMessages.push(raw); callback(null, 'Pacing sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
const engine = await import('../pipeline/sending-engine.js');

after(async () => {
  await new Promise(resolve => smtp.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('overdue sends are pace-limited by durable per-mailbox next-due state, including after restart', async () => {
  for (const [id, email, personalizationId] of [
    [301, 'first@pacing.synthetic.test', 801],
    [302, 'second@pacing.synthetic.test', 802],
  ]) {
    db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,'queued')").run(id, `Pacing contact ${id}`, email);
    db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?,'deliverable',datetime('now'))").run(id, email);
    db.prepare(`INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed)
      VALUES(?,?,?, ?,1,1)`).run(personalizationId, id, `Subject ${id}`, `Body ${id}`);
  }
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES(1,'sender@pacing.synthetic.test','pacing.synthetic.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES(11,'Pacing fixture','draft')").run();
  db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES(11,1)').run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES(11,301),(11,302)').run();

  const review = engine.getCampaignPreflight(11);
  assert.equal(review.ready, true, JSON.stringify(review.blockers));
  const queued = await engine.queueSends(11, { limit: 2, reviewHash: review.reviewHash });
  assert.equal(queued.queued, 2);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE campaign_id=11").run();

  const processed = await engine.processSendQueue({ limit: 10 });
  assert.equal(processed.sent, 1);
  assert.equal(processed.deferred, 1);
  assert.equal(acceptedMessages.length, 1, 'an overdue backlog did not bypass the configured pacing interval');
  const deferral = db.prepare("SELECT send_id,meta_json FROM events WHERE event_type='send_deferred'").get();
  assert.equal(JSON.parse(deferral.meta_json).reason, 'sender_pacing_interval');
  const pace = db.prepare(`SELECT p.next_allowed_at,s.scheduled_at,
      (julianday(p.next_allowed_at)-julianday('now'))*86400 AS seconds_remaining
    FROM mailbox_send_pacing p JOIN sends s ON s.id=? WHERE p.mailbox_id=1`).get(deferral.send_id);
  assert.equal(pace.scheduled_at, pace.next_allowed_at);
  assert.ok(pace.seconds_remaining >= 25, `minimum configured interval should remain durable, got ${pace.seconds_remaining}s`);

  database.closeDb();
  db = database.initDb();
  assert.equal(db.prepare('SELECT next_allowed_at FROM mailbox_send_pacing WHERE mailbox_id=1').get().next_allowed_at, pace.next_allowed_at);
  assert.equal((await engine.processSendQueue({ limit: 10 })).processed, 0, 'a restart must not make the held send due early');
  assert.equal(acceptedMessages.length, 1);
});
