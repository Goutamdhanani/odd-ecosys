import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-send-control-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-private-bootstrap-token-0123456789';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
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
    stream.on('end', () => { acceptedMessages.push(raw); callback(null, 'Synthetic sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

const { server } = await import('../server.js');
const engine = await import('../pipeline/sending-engine.js');
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

function parseSession(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'owner session cookie is present');
  assert.ok(csrf, 'owner CSRF cookie is present');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

async function request(route, { method = 'GET', body, auth = null } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    headers.cookie = auth.cookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = auth.csrf;
  }
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(),
    setCookie: response.headers.get('set-cookie') || '',
  };
}

test('workspace-wide send pause is authorized, durable, blocks queue/worker, and resumes through the existing worker', async () => {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (51,'Control Fixture','recipient@synthetic.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (51,'recipient@synthetic.test','deliverable',datetime('now'))").run();
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (52,'Capacity Fixture','second@synthetic.test','queued')").run();
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (52,'second@synthetic.test','deliverable',datetime('now'))").run();
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'sender@synthetic.test','synthetic.test','eligible',1,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (501,51,'Control subject','Control sink body',1,1)").run();
  db.prepare("INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (502,52,'Capacity subject','Second capacity body',1,1)").run();

  assert.equal((await request('/api/sending/control')).status, 401, 'anonymous users cannot inspect workspace controls');
  const bootstrapped = await request('/api/auth/bootstrap', {
    method: 'POST', body: {
      email: 'owner@synthetic.test', password: 'Fixture-only-password-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(bootstrapped.status, 201);
  const owner = parseSession(bootstrapped.setCookie);
  assert.equal((await request('/api/sending/control', { auth: owner })).body.paused, false);
  const defaultSchedule = await request('/api/sending/schedule', { auth: owner });
  assert.equal(defaultSchedule.status, 200);
  assert.equal(defaultSchedule.body.source, 'configuration');
  assert.equal(defaultSchedule.body.schedule.timezone, 'UTC');
  assert.equal((await request('/api/sending/control', { method: 'PUT', auth: owner, body: { paused: true, reason: '   ' } })).status, 400);
  const invitation = await request('/api/workspace/invitations', {
    method: 'POST', auth: owner, body: { email: 'operator@synthetic.test', role: 'operator' },
  });
  assert.equal(invitation.status, 201);
  const operatorAccount = await request('/api/auth/invitations/accept', {
    method: 'POST', body: {
      email: 'operator@synthetic.test', password: 'Fixture-only-operator-9!',
      invitationToken: invitation.body.invitation.token,
    },
  });
  assert.equal(operatorAccount.status, 201);
  const operator = parseSession(operatorAccount.setCookie);
  assert.equal((await request('/api/sending/control', {
    method: 'PUT', auth: operator, body: { paused: true, reason: 'Operator must not toggle global switch' },
  })).status, 403);
  assert.equal((await request('/api/sending/schedule', {
    method: 'PUT', auth: operator, body: {
      timezone: 'UTC', startHour: 8, endHour: 17, weekdaysOnly: true,
      minIntervalMs: 30000, maxIntervalMs: 60000,
    },
  })).status, 403);

  const list = await request('/api/lists', { method: 'POST', auth: owner, body: { name: 'Send control fixture' } });
  assert.equal(list.status, 201);
  assert.equal((await request(`/api/lists/${list.body.id}/members`, { method: 'POST', auth: owner, body: { leadIds: [51, 52] } })).body.added, 2);
  const campaign = await request('/api/sending/campaigns', { method: 'POST', auth: owner, body: { name: 'Send control fixture' } });
  assert.equal(campaign.status, 200);
  assert.ok(Number.isSafeInteger(campaign.body.id));
  assert.equal((await request(`/api/sending/campaigns/${campaign.body.id}/audience`, { method: 'POST', auth: owner, body: { listId: list.body.id } })).body.added, 2);
  assert.equal((await request(`/api/sending/campaigns/${campaign.body.id}/senders`, { method: 'PUT', auth: owner, body: { mailboxIds: [1] } })).body.readyCount, 1);
  const originalReview = await request(`/api/sending/campaigns/${campaign.body.id}/preflight`, { auth: owner });
  assert.equal(originalReview.body.ready, true, JSON.stringify(originalReview.body.blockers));
  const invalidSchedule = await request('/api/sending/schedule', {
    method: 'PUT', auth: owner, body: {
      timezone: 'Not/A_Timezone', startHour: 0, endHour: 24, weekdaysOnly: false,
      minIntervalMs: 5000, maxIntervalMs: 8000,
    },
  });
  assert.equal(invalidSchedule.status, 400);
  const savedSchedule = await request('/api/sending/schedule', {
    method: 'PUT', auth: owner, body: {
      timezone: 'UTC', startHour: 0, endHour: 24, weekdaysOnly: false,
      minIntervalMs: 5000, maxIntervalMs: 8000,
    },
  });
  assert.equal(savedSchedule.status, 200);
  assert.equal(savedSchedule.body.source, 'workspace');
  assert.equal(savedSchedule.body.schedule.minIntervalMs, 5000);
  assert.equal(savedSchedule.body.schedule.maxIntervalMs, 8000);
  assert.equal(savedSchedule.body.history[0].actorRole, 'owner');
  const review = await request(`/api/sending/campaigns/${campaign.body.id}/preflight`, { auth: owner });
  assert.equal(review.body.ready, true, JSON.stringify(review.body.blockers));
  assert.notEqual(review.body.reviewHash, originalReview.body.reviewHash,
    'saving the workspace schedule invalidates a review prepared under the previous policy');
  const queued = await request(`/api/sending/queue/${campaign.body.id}`, {
    method: 'POST', auth: owner, body: { limit: 2, reviewHash: review.body.reviewHash },
  });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 2);
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE campaign_id=?").run(campaign.body.id);

  const paused = await request('/api/sending/control', {
    method: 'PUT', auth: owner, body: { paused: true, reason: 'Investigating test activity' },
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.paused, true);
  assert.equal(paused.body.history[0].actorRole, 'owner');
  const blockedReview = await request(`/api/sending/campaigns/${campaign.body.id}/preflight`, { auth: owner });
  assert.equal(blockedReview.body.ready, false);
  assert.equal(blockedReview.body.blockers[0].code, 'workspace_send_paused');
  assert.notEqual(blockedReview.body.reviewHash, review.body.reviewHash);
  const blockedQueue = await request(`/api/sending/queue/${campaign.body.id}`, {
    method: 'POST', auth: owner, body: { limit: 1, reviewHash: blockedReview.body.reviewHash },
  });
  assert.equal(blockedQueue.status, 409);
  assert.match(blockedQueue.body.error, /sending is paused/i);

  const workerRun = await engine.processSendQueue({ limit: 10 });
  assert.equal(workerRun.sendPaused, true);
  assert.equal(acceptedMessages.length, 0, 'the paused worker did not open SMTP DATA for a recipient');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sends WHERE campaign_id=? AND status='scheduled'").get(campaign.body.id).count, 2);

  closeDb();
  db = initDb();
  const persisted = engine.getSendControlState();
  assert.equal(persisted.paused, true, 'the pause state survives reopening the SQLite database');
  const persistedSchedule = engine.getSendingScheduleSettings();
  assert.equal(persistedSchedule.source, 'workspace');
  assert.equal(persistedSchedule.schedule.timezone, 'UTC');
  assert.equal(persistedSchedule.schedule.minIntervalMs, 5000);
  assert.equal(persistedSchedule.history[0].actorRole, 'owner');
  assert.equal((await engine.processSendQueue({ limit: 10 })).sendPaused, true);
  assert.equal(acceptedMessages.length, 0, 'worker restart did not replay or submit the scheduled row');

  const resumed = engine.setSendControlState({ paused: false, reason: 'Resumed after isolated safety check', actor: { id: 1, role: 'owner' } });
  assert.equal(resumed.paused, false);
  const sent = await engine.processSendQueue({ limit: 10 });
  assert.equal(sent.sent, 1);
  assert.equal(sent.deferred, 1, 'the second row was held when the mailbox daily cap was consumed');
  assert.equal(acceptedMessages.length, 1, 'the existing worker delivered exactly one message to the local sink after resume');
  assert.match(acceptedMessages[0], /Control sink body/);
  const accepted = db.prepare("SELECT meta_json FROM events WHERE event_type='sent' ORDER BY id DESC LIMIT 1").get();
  assert.match(JSON.parse(accepted.meta_json).response, /Synthetic sink accepted/);
  const deferred = db.prepare("SELECT meta_json FROM events WHERE event_type='send_deferred' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(deferred.meta_json).reason, 'sender_pacing_interval');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM send_capacity_reservations WHERE state='accepted'").get().count, 1);
  assert.equal(engine.getMailboxFleet()[0].today_sent, 1);
  assert.equal(engine.getMailboxFleet()[0].today_reserved, 0);
  assert.equal(engine.getSendControlState().history.length, 2);
});

test('send control UI assets are served by the application', async () => {
  const page = await request('/');
  const script = await request('/js/settings.js');
  const mailboxScript = await request('/js/mailboxes.js');
  const styles = await request('/css/settings.css');
  assert.equal(page.status, 200, 'private workspace root redirects an unauthenticated browser to the local sign-in page');
  assert.match(page.body, /src="js\/app\.js"/);
  assert.equal(script.status, 200);
  assert.equal(styles.status, 200);
  assert.match(script.body, /Pause all campaign sending/);
  assert.match(script.body, /Allowed send window and pacing/);
  assert.match(script.body, /send-schedule-min/);
  assert.match(script.body, /credentialStorage/);
  assert.equal(mailboxScript.status, 200);
  assert.match(mailboxScript.body, /Configure its private credential key before saving a password/);
  assert.match(mailboxScript.body, /catch \(error\)/);
  assert.match(styles.body, /settings-control-card/);
  assert.match(styles.body, /settings-schedule-form/);
});
