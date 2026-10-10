import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-unsubscribe-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.APP_URL = 'https://mail.oddwebs.shop';
process.env.COMPANY_PHYSICAL_ADDRESS = '100 Test Loopback Lane, Testville, ZZ 00001';
delete process.env.COMPLIANCE_SECRET;
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
    stream.on('end', () => { received.push(raw); callback(null, 'Unsubscribe SMTP sink accepted'); });
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

async function request(route, { method = 'GET', body, contentType = 'application/json' } = {}) {
  const queueMatch = method === 'POST' && route.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (queueMatch && body) {
    const payload = typeof body === 'string' ? JSON.parse(body) : { ...body };
    if (!payload.reviewHash) {
      const review = await fetch(`${base}/api/sending/campaigns/${queueMatch[1]}/preflight`).then(response => response.json());
      payload.reviewHash = review.reviewHash;
    }
    body = JSON.stringify(payload);
  }
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': contentType }, body }),
  });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}

test('one-click headers use a stored random token and GET never suppresses a recipient', async () => {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (71,'Unsubscribe Contact','recipient@example.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (71,'recipient@example.test','deliverable',datetime('now'))").run();
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (71,'Unsubscribe fixture','draft')").run();
  db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES (71,1)').run();
  db.prepare("INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (71,71)").run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (71,71,'Unsubscribe subject','Unsubscribe fixture body',1,1)").run();

  const queued = await request('/api/sending/queue/71', { method: 'POST', body: JSON.stringify({ limit: 1 }) });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 1);
  const sendId = queued.body.queuedList[0].sendId;
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-2 minutes') WHERE id=?").run(sendId);
  assert.equal((await request('/api/sending/process', { method: 'POST', body: JSON.stringify({ limit: 1 }) })).status, 200);

  const deadline = Date.now() + 8000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    status = (await request('/api/sending/status')).body;
  } while (Date.now() < deadline && (status.active || received.length === 0));
  assert.equal(status.active, false);
  assert.equal(received.length, 1);
  const normalizedHeaders = received[0].split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[\t ]+/g, ' ');
  const listHeader = normalizedHeaders.split(/\r?\n/).find(line => /^List-Unsubscribe:/i.test(line));
  assert.ok(listHeader);
  const token = listHeader.match(/<https:\/\/mail\.oddwebs\.shop\/api\/unsubscribe\?token=([A-Za-z0-9_-]+)>/i)?.[1];
  assert.ok(token, `mail must carry a real HTTPS one-click endpoint; observed header: ${listHeader}`);
  assert.match(normalizedHeaders, /List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click/i);
  assert.match(received[0], /100 Test Loopback Lane, Testville, ZZ 00001/);
  assert.ok(received[0].includes(token), 'the message body carries the same stored one-click token as its List-Unsubscribe header');

  const savedToken = db.prepare('SELECT token_hash,email,lead_id,send_id,used_at FROM unsubscribe_tokens').get();
  assert.equal(savedToken.email, 'recipient@example.test');
  assert.equal(savedToken.lead_id, 71);
  assert.equal(savedToken.send_id, sendId);
  assert.equal(savedToken.token_hash.length, 64);
  assert.notEqual(savedToken.token_hash, token);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM suppression_list').get().count, 0);

  const confirmationPage = await request(`/api/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal(confirmationPage.status, 200);
  assert.match(confirmationPage.body, /Confirm once/);
  assert.match(confirmationPage.body, /method="post"/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM suppression_list').get().count, 0, 'link scanners issuing GET must not unsubscribe people');

  const wrongBody = await request(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST', body: 'List-Unsubscribe=wrong', contentType: 'application/x-www-form-urlencoded',
  });
  assert.equal(wrongBody.status, 400);
  const unsupportedBody = await request(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST', body: JSON.stringify({ 'List-Unsubscribe': 'One-Click' }),
  });
  assert.equal(unsupportedBody.status, 415);

  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (72,'Future follow-up','active')").run();
  db.prepare("INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (72,71)").run();
  db.prepare("INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,scheduled_at,status) VALUES (720,71,1,72,71,datetime('now','+1 day'),'scheduled')").run();

  const unsubscribed = await request(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST', body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded',
  });
  assert.equal(unsubscribed.status, 200);
  assert.deepEqual(unsubscribed.body, { ok: true, status: 'unsubscribed' });
  assert.equal(db.prepare('SELECT reason FROM suppression_list WHERE email=?').get('recipient@example.test').reason, 'one_click_unsubscribe');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=71').get().status, 'disqualified');
  assert.deepEqual(db.prepare('SELECT campaign_id,status FROM campaign_enrollments WHERE lead_id=71 ORDER BY campaign_id').all(), [
    { campaign_id: 71, status: 'stopped' },
    { campaign_id: 72, status: 'stopped' },
  ]);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=720').get().status, 'cancelled');
  assert.equal((await request('/api/sending/campaigns/72/audience')).body.counts.byReason.stopped, 1);
  assert.equal(db.prepare('SELECT used_at FROM unsubscribe_tokens').get().used_at !== null, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='unsubscribed'").get().count, 1);

  const repeated = await request(`/api/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST', body: 'List-Unsubscribe=One-Click', contentType: 'application/x-www-form-urlencoded',
  });
  assert.deepEqual(repeated.body, { ok: true, status: 'already_unsubscribed' });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='unsubscribed'").get().count, 1);
});
