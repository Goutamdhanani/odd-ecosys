import './support/all-hours-send-window.js';
import { seedSyntheticCampaignSendReview } from './support/reviewed-mailbox-fixture.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-preflight-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = '4'.repeat(64);
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const accepted = [];
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
      callback(null, 'Preflight fixture accepted by SMTP sink');
    });
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
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => smtp.close(resolve))]);
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

function addContact(id, email, { verified = true, approved = true } = {}) {
  db.prepare("INSERT INTO leads(id,business_name,email,status) VALUES (?,?,?,'queued')").run(id, `Preflight contact ${id}`, email);
  if (verified) db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?, 'deliverable',datetime('now'))").run(id, email);
  db.prepare('INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (?,?,?, ?,1)')
    .run(id, `Reviewed subject ${id}`, `Reviewed body for ${id}`, approved ? 1 : 0);
}

// These campaign fixtures exercise pre-reviewed senders; the warm-up migration
// now correctly locks legacy eligible mailboxes without a current review.
function seedReviewedSender(mailboxId) {
  seedSyntheticCampaignSendReview(db, mailboxId);
}

test('preflight reviews each enrolled contact, rejects stale review, then launches only reviewed recipients to the loopback sink', async () => {
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'preflight-sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  seedReviewedSender(1);
  addContact(201, 'eligible-one@example.test');
  addContact(202, 'eligible-two@example.test');
  addContact(203, 'blocked@example.test');
  addContact(204, 'deferred@example.test');
  addContact(205, 'unverified@example.test', { verified: false });
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('blocked@example.test','fixture suppression')").run();

  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Preflight test campaign' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const campaignId = created.body.id;
  const enroll = db.prepare(`INSERT INTO campaign_enrollments(campaign_id,lead_id,status,defer_until)
    VALUES (?,?,?,?)`);
  enroll.run(campaignId, 201, 'active', null);
  enroll.run(campaignId, 202, 'active', null);
  enroll.run(campaignId, 203, 'active', null);
  enroll.run(campaignId, 204, 'active', new Date(Date.now() + 86400000).toISOString());
  enroll.run(campaignId, 205, 'active', null);
  const sender = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [1] } });
  assert.equal(sender.status, 200, JSON.stringify(sender.body));

  const reviewed = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.ready, true);
  assert.deepEqual(reviewed.body.counts, {
    total: 5, eligible: 2, blocked: 2, deferred: 1,
    byReason: { eligible: 2, suppressed: 1, out_of_office_deferred: 1, verification_required: 1 },
  });
  assert.equal(reviewed.body.recipients.length, 5, 'preflight returns every enrolled recipient, not a preview page');
  assert.equal(reviewed.body.recipients.find(item => item.contactId === 203).reason, 'suppressed');
  assert.equal(reviewed.body.recipients.find(item => item.contactId === 204).status, 'deferred');
  assert.equal(reviewed.body.recipients.find(item => item.contactId === 205).reason, 'verification_required');

  const withoutReview = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 5 } });
  assert.equal(withoutReview.status, 428);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);

  db.prepare('UPDATE personalizations SET approved=0 WHERE lead_id=202').run();
  const stale = await request(`/api/sending/queue/${campaignId}`, {
    method: 'POST', body: { limit: 5, reviewHash: reviewed.body.reviewHash },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error, /changed after review/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);
  assert.equal(accepted.length, 0, 'stale preflight cannot reach SMTP');

  const current = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(current.body.counts.eligible, 1);
  assert.equal(current.body.counts.blocked, 3);
  assert.equal(current.body.recipients.find(item => item.contactId === 202).reason, 'approval_required');
  const queued = await request(`/api/sending/queue/${campaignId}`, {
    method: 'POST', body: { limit: 5, reviewHash: current.body.reviewHash },
  });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(queued.body.queued, 1);
  assert.deepEqual(queued.body.queuedList.map(item => item.email), ['eligible-one@example.test']);

  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE campaign_id=?").run(campaignId);
  assert.equal((await request('/api/sending/process', { method: 'POST', body: { limit: 5 } })).status, 200);
  const deadline = Date.now() + 8000;
  let state;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    state = (await request('/api/sending/status')).body;
  } while (Date.now() < deadline && (state.active || accepted.length === 0));
  assert.equal(state.active, false);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].recipients, ['eligible-one@example.test']);
  assert.match(accepted[0].raw, /Reviewed body for 201/);
  const send = db.prepare('SELECT id,status FROM sends WHERE campaign_id=?').get(campaignId);
  assert.equal(send.status, 'sent');
  const evidence = JSON.parse(db.prepare("SELECT meta_json FROM events WHERE send_id=? AND event_type='sent'").get(send.id).meta_json);
  assert.match(evidence.response, /Preflight fixture accepted by SMTP sink/);
});

test('missing sender is an actionable blocker and concurrent dispatch with one review cannot duplicate a send', async () => {
  const sinkBaseline = accepted.length;
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (2,'race-sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  seedReviewedSender(2);
  addContact(301, 'race-contact@example.test');
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Concurrent preflight campaign' } });
  assert.equal(created.status, 200);
  const campaignId = created.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,301)').run(campaignId);

  const missingSender = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(missingSender.body.ready, false);
  assert.ok(missingSender.body.blockers.some(blocker => blocker.code === 'sender_not_assigned'));
  assert.deepEqual(missingSender.body.recipients.map(recipient => [recipient.status, recipient.reason]), [['blocked', 'sender_not_assigned']]);

  const selected = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [2] } });
  assert.equal(selected.status, 200);
  const review = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(review.body.ready, true);
  const dispatches = await Promise.all([1, 2].map(() => request(`/api/sending/queue/${campaignId}`, {
    method: 'POST', body: { limit: 1, reviewHash: review.body.reviewHash },
  })));
  assert.deepEqual(dispatches.map(result => result.status).sort(), [200, 409]);
  assert.equal(dispatches.find(result => result.status === 200).body.queued, 1);
  assert.match(dispatches.find(result => result.status === 409).body.error, /changed after review/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 1);
  assert.equal(accepted.length, sinkBaseline, 'queueing to the schedule does not falsely claim SMTP acceptance');
});

test('preflight returns the complete audience when it exceeds the campaign table page size', async () => {
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Large preflight audience' } });
  assert.equal(campaign.status, 200);
  const campaignId = campaign.body.id;
  const lead = db.prepare("INSERT INTO leads(business_name,email,status) VALUES (? ,?,'queued')");
  const enroll = db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)');
  for (let index = 0; index < 205; index += 1) {
    const email = `large-${index}@example.test`;
    const inserted = lead.run(`Large audience contact ${index}`, email);
    enroll.run(campaignId, Number(inserted.lastInsertRowid));
  }
  const review = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(review.status, 200);
  assert.equal(review.body.counts.total, 205);
  assert.equal(review.body.recipients.length, 205);
  assert.equal(new Set(review.body.recipients.map(recipient => recipient.contactId)).size, 205);
  assert.ok(review.body.recipients.every(recipient => recipient.status === 'blocked' && recipient.reason === 'verification_required'));
});

test('missing production compliance configuration is shown in preflight and blocks queueing', async () => {
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (3,'compliance-sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  engine.updateMailbox(3, { smtp_pass: 'fixture-only' });
  seedReviewedSender(3);
  db.prepare('UPDATE mailboxes SET daily_limit=100 WHERE id=3').run();
  addContact(999991, 'compliance-contact@example.test');
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Compliance-gated campaign' } });
  assert.equal(created.status, 200);
  const campaignId = created.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,999991)').run(campaignId);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [3] } })).status, 200);

  const oldEnv = {
    nodeEnv: process.env.NODE_ENV,
    appUrl: process.env.APP_URL,
    publicUrl: process.env.ODD_PUBLIC_BASE_URL,
    physicalAddress: process.env.COMPANY_PHYSICAL_ADDRESS,
  };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    delete process.env.ODD_PUBLIC_BASE_URL;
    delete process.env.COMPANY_PHYSICAL_ADDRESS;
    const review = engine.getCampaignPreflight(campaignId);
    assert.equal(review.ready, false);
    assert.deepEqual(review.blockers.map(blocker => blocker.code).filter(code => code.includes('unsubscribe') || code.includes('address')).sort(), [
      'https_unsubscribe_endpoint_not_configured',
      'physical_mailing_address_not_configured',
    ]);
    await assert.rejects(engine.queueSends(campaignId, { limit: 1, reviewHash: review.reviewHash }), error => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /public HTTPS application origin/i);
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);

    process.env.APP_URL = 'https://mail.one.example.test';
    process.env.COMPANY_PHYSICAL_ADDRESS = '17 Harbor Road, Bay City, ZZ 00001';
    const compliantReview = engine.getCampaignPreflight(campaignId);
    assert.equal(compliantReview.ready, true);
    process.env.COMPANY_PHYSICAL_ADDRESS = '18 Harbor Road, Bay City, ZZ 00001';
    await assert.rejects(engine.queueSends(campaignId, { limit: 1, reviewHash: compliantReview.reviewHash }), error => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /changed after review/i);
      return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0);
  } finally {
    process.env.NODE_ENV = oldEnv.nodeEnv;
    if (oldEnv.appUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = oldEnv.appUrl;
    if (oldEnv.publicUrl === undefined) delete process.env.ODD_PUBLIC_BASE_URL; else process.env.ODD_PUBLIC_BASE_URL = oldEnv.publicUrl;
    if (oldEnv.physicalAddress === undefined) delete process.env.COMPANY_PHYSICAL_ADDRESS; else process.env.COMPANY_PHYSICAL_ADDRESS = oldEnv.physicalAddress;
  }
});
