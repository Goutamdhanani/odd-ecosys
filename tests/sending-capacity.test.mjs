import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-domain-capacity-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_SEND_MAX_DAILY_PER_DOMAIN = '1';

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
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
    stream.on('end', () => { acceptedMessages.push(raw); callback(null, 'Domain-capacity sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
const engine = await import('../pipeline/sending-engine.js');

after(async () => {
  await new Promise(resolve => smtp.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('domain daily capacity is reserved atomically before SMTP and defers excess work until the next UTC day', async () => {
  for (const [id, name, email, personalizationId] of [
    [201, 'Domain fixture one', 'one@shared.synthetic.test', 701],
    [202, 'Domain fixture two', 'two@shared.synthetic.test', 702],
  ]) {
    db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,'queued')").run(id, name, email);
    db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?,'deliverable',datetime('now'))").run(id, email);
    db.prepare(`INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed)
      VALUES(?,?,?, ?,1,1)`).run(personalizationId, id, `Subject ${id}`, `Body ${id}`);
  }
  for (const mailboxId of [1, 2]) {
    db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
      smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
      VALUES(?,?,'shared.synthetic.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
      .run(mailboxId, `sender${mailboxId}@shared.synthetic.test`, smtp.server.address().port);
  }
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES(9,'Domain quota fixture','draft')").run();
  db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES(9,1),(9,2)').run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES(9,201),(9,202)').run();

  const review = engine.getCampaignPreflight(9);
  assert.equal(review.ready, true, JSON.stringify(review.blockers));
  assert.equal(review.senders.length, 2);
  assert.deepEqual(review.senders.map(sender => sender.domainRemaining), [1, 1]);
  const queued = await engine.queueSends(9, { limit: 2, reviewHash: review.reviewHash });
  assert.equal(queued.queued, 2);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE campaign_id=9").run();

  const runIndependentWorker = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./support/send-worker.mjs', import.meta.url), {
      workerData: { databasePath: process.env.ODD_DB_PATH, domainLimit: 1 },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`send worker thread exited ${code}`)); });
  });
  const results = await Promise.all([runIndependentWorker(), runIndependentWorker()]);
  assert.equal(results.reduce((sum, result) => sum + (result.sent || 0), 0), 1, JSON.stringify(results));
  assert.equal(results.reduce((sum, result) => sum + (result.deferred || 0), 0), 1, JSON.stringify(results));
  assert.equal(acceptedMessages.length, 1, 'the local sink captured no more than the configured shared-domain cap');
  assert.match(acceptedMessages[0], /Body 20[12]/);
  const deferred = db.prepare("SELECT meta_json FROM events WHERE event_type='send_deferred'").get();
  assert.equal(JSON.parse(deferred.meta_json).reason, 'domain_daily_limit_reached');
  assert.ok(db.prepare("SELECT 1 FROM sends WHERE status='scheduled' AND julianday(scheduled_at)>julianday('now','+12 hours')").get(),
    'the unsubmitted row is durably due on the next UTC day');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM send_capacity_reservations WHERE state='accepted'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM send_capacity_reservations WHERE state IN ('reserved','uncertain')").get().count, 0);
});
