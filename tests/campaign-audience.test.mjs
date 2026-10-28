import './support/all-hours-send-window.js';
import { seedSyntheticCampaignSendReview } from './support/reviewed-mailbox-fixture.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-audience-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { initDb, closeDb } = await import('../pipeline/database.js');
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
    stream.on('end', () => { received.push(raw); callback(null, 'Fixture SMTP sink accepted'); });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
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
  return { status: response.status, body: await response.json() };
}

function addContact(id, email, status = 'queued') {
  db.prepare('INSERT INTO leads(id,business_name,email,city,status) VALUES (?,?,?,?,?)')
    .run(id, `Synthetic Contact ${id}`, email, 'Test City', status);
  if (email) db.prepare('INSERT INTO lead_emails(lead_id,email,verification_status,verified_at) VALUES (?,?,?,datetime(\'now\'))')
    .run(id, email, email.includes('unknown') ? 'unknown' : 'deliverable');
}

function addPersonalization(id, leadId, { approved = 1, guardrail = 1, subject = `Subject ${leadId}`, body = `Synthetic campaign body for ${leadId}` } = {}) {
  db.prepare(`INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed,generated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))`).run(id, leadId, subject, body, approved, guardrail);
}

test('saved lists become immutable campaign recipient snapshots with visible, evidence-based eligibility', async () => {
  addContact(101, 'ready-one@example.test');
  addContact(102, 'ready-two@example.test');
  addContact(103, 'blocked@example.test');
  addContact(104, 'unknown@example.test');
  addContact(105, null);
  addContact(106, 'review@example.test');
  addContact(107, 'added-later@example.test');
  for (const [id, leadId] of [[1001, 101], [1002, 102], [1003, 103], [1004, 104]]) addPersonalization(id, leadId);
  addPersonalization(1005, 106, { approved: 1 });
  addPersonalization(1006, 106, { approved: 0 }); // Newest copy needs approval; old approval must not be reused.
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('blocked@example.test','unsubscribe_request')").run();

  const list = await request('/api/lists', { method: 'POST', body: { name: 'Launch contacts' } });
  assert.equal(list.status, 201);
  const listId = list.body.id;
  const addedToList = await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [101, 102, 103, 104, 105, 106] } });
  assert.equal(addedToList.body.added, 6);

  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Product launch' } });
  assert.equal(created.status, 200);
  const campaignId = created.body.id;
  const enrollment = await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId } });
  assert.equal(enrollment.status, 200);
  assert.equal(enrollment.body.added, 6);
  const repeated = await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId } });
  assert.equal(repeated.body.added, 0);
  assert.equal(repeated.body.alreadyEnrolled, 6);

  const audience = await request(`/api/sending/campaigns/${campaignId}/audience?limit=20`);
  assert.equal(audience.status, 200);
  assert.equal(audience.body.counts.total, 6);
  assert.equal(audience.body.counts.eligible, 2);
  assert.equal(audience.body.counts.byReason.suppressed, 1);
  assert.equal(audience.body.counts.byReason.verification_required, 1);
  assert.equal(audience.body.counts.byReason.missing_email, 1);
  assert.equal(audience.body.counts.byReason.approval_required, 1);
  const reviewContact = audience.body.items.find(item => item.lead_id === 106);
  assert.equal(reviewContact.eligibility, 'approval_required');
  assert.equal(reviewContact.personalization_id, 1006);

  const lateListMember = await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [107] } });
  assert.equal(lateListMember.body.added, 1);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`)).body.counts.total, 6, 'later list edits must not silently change campaign membership');

  const otherCampaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Separate campaign' } });
  assert.equal((await request(`/api/sending/campaigns/${otherCampaign.body.id}/audience`)).body.counts.total, 0, 'campaigns must not inherit contacts without explicit enrollment');
  db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(campaignId);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId } })).status, 409, 'launched campaigns must not accept audience changes');
  db.prepare("UPDATE campaigns SET status='draft' WHERE id=?").run(campaignId);
});

test('queue and SMTP worker send only verified approved recipients and recheck suppression before transport', async () => {
  addContact(201, 'smtp-ready-one@example.test');
  addContact(202, 'smtp-ready-two@example.test');
  addContact(203, 'smtp-suppressed@example.test');
  addContact(204, 'smtp-unknown@example.test');
  addContact(205, null);
  addContact(206, 'smtp-review@example.test');
  for (const [id, leadId] of [[2001, 201], [2002, 202], [2003, 203], [2004, 204]]) addPersonalization(id, leadId);
  addPersonalization(2005, 206, { approved: 1 });
  addPersonalization(2006, 206, { approved: 0 });
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('smtp-suppressed@example.test','unsubscribe_request')").run();

  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES (1,'sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`)
    .run(smtp.server.address().port);
  seedSyntheticCampaignSendReview(db, 1, {
      outbound: { source: 'accepted_sends', count: 1, latestAt: '2026-10-24T10:00:00.000Z' },
      replies: { source: 'attributed_inbound_reply_events', count: 0, latestAt: null },
      inbox: { source: 'imap_sync_mailbox_state', lastCheckedAt: '2026-10-24T10:05:00.000Z', fetched: 1, imported: 1, alreadyRecorded: 0, skipped: 0 },
    });
  const list = await request('/api/lists', { method: 'POST', body: { name: 'SMTP acceptance fixtures' } });
  const listId = list.body.id;
  await request(`/api/lists/${listId}/members`, { method: 'POST', body: { leadIds: [201, 202, 203, 204, 205, 206] } });
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Loopback proof only' } });
  const campaignId = campaign.body.id;
  await request(`/api/sending/campaigns/${campaignId}/audience`, { method: 'POST', body: { listId } });
  const senderSelection = await request(`/api/sending/campaigns/${campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [1] } });
  assert.equal(senderSelection.status, 200);
  assert.equal(senderSelection.body.senderIds[0], 1);

  const preview = await request(`/api/sending/campaigns/${campaignId}/audience?limit=20`);
  assert.equal(preview.body.counts.eligible, 2);
  assert.equal(preview.body.counts.byReason.suppressed, 1);
  assert.equal(preview.body.counts.byReason.verification_required, 1);
  assert.equal(preview.body.counts.byReason.missing_email, 1);
  assert.equal(preview.body.counts.byReason.approval_required, 1);

  const queued = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 20 } });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, 2);
  assert.equal(queued.body.queuedList.length, 2);
  const duplicateQueue = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 20 } });
  assert.equal(duplicateQueue.body.queued, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends WHERE campaign_id=?').get(campaignId).n, 2);

  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-2 minutes') WHERE campaign_id=?").run(campaignId);
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('smtp-ready-two@example.test','unsubscribe_request')").run();
  const started = await request('/api/sending/process', { method: 'POST', body: { limit: 20 } });
  assert.equal(started.status, 200);

  const deadline = Date.now() + 10000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 75));
    status = (await request('/api/sending/status')).body;
  } while (Date.now() < deadline && (status.active || received.length === 0));

  assert.equal(status.active, false);
  assert.equal(received.length, 1, 'only the recipient accepted by the actual loopback SMTP sink should be present');
  assert.match(received[0], /Synthetic campaign body for 201/);
  const sends = db.prepare('SELECT lead_id,status,error_message FROM sends WHERE campaign_id=? ORDER BY lead_id').all(campaignId);
  assert.deepEqual(sends.map(row => [row.lead_id, row.status]), [[201, 'sent'], [202, 'cancelled']]);
  const accepted = db.prepare("SELECT meta_json FROM events WHERE event_type='sent' AND lead_id=201").get();
  assert.ok(accepted);
  const transportEvidence = JSON.parse(accepted.meta_json);
  assert.ok(transportEvidence.messageId);
  assert.match(transportEvidence.response, /Fixture SMTP sink accepted/);
  assert.equal(JSON.parse(db.prepare("SELECT meta_json FROM events WHERE event_type='send_blocked' AND lead_id=202").get().meta_json).reason, 'suppressed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='send_failed'").get().n, 0);

  const afterSend = await request(`/api/sending/campaigns/${campaignId}/audience?limit=20`);
  assert.equal(afterSend.body.counts.alreadySent, 1);
  assert.equal(afterSend.body.counts.byReason.suppressed, 2);
  assert.equal((await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 20 } })).body.queued, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('uncertain SMTP submissions expose safe review evidence and remain quarantined without a provider trace adapter', async () => {
  addContact(301, 'uncertain-review@example.test');
  addPersonalization(3001, 301);
  const campaign = await request('/api/sending/campaigns', { method: 'POST', body: { name: 'Quarantine review fixture' } });
  const campaignId = campaign.body.id;
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, 301);
  db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES (?,1)').run(campaignId);
  db.prepare(`INSERT INTO sends(id,lead_id,campaign_id,status,error_message)
    VALUES (3001,?,?, 'uncertain',?)`)
    .run(301, campaignId, 'Connection lost during SMTP DATA; token=private-test-token');
  db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
    VALUES (?,?, 'send_submission_uncertain',datetime('now'),?)`)
    .run(3001, 301, JSON.stringify({
      code: 'ECONNECTION',
      error: 'Connection lost while waiting for the final SMTP response; token=private-test-token',
      stage: 'DATA',
      retry_policy: 'quarantined_no_automatic_resend',
    }));
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('uncertain-review@example.test','unsubscribe_request')").run();

  const audience = await request(`/api/sending/campaigns/${campaignId}/audience`);
  assert.equal(audience.status, 200);
  const recipient = audience.body.items.find(item => item.lead_id === 301);
  assert.equal(recipient.eligibility, 'submission_uncertain');
  assert.deepEqual(recipient.uncertainty, {
    sendId: 3001,
    recordedAt: recipient.uncertainty.recordedAt,
    code: 'ECONNECTION',
    stage: 'DATA',
    reason: 'Connection lost while waiting for the final SMTP response; token=[redacted]',
    evidenceSource: 'local_smtp_worker',
    providerEvidence: 'unavailable',
    blockedReason: 'No provider message-trace adapter is configured, so SMTP acceptance cannot be confirmed. This recipient remains quarantined and must not be resent.',
  });
  assert.ok(recipient.uncertainty.recordedAt);
  assert.doesNotMatch(JSON.stringify(recipient), /private-test-token/);

  const queue = await request(`/api/sending/queue/${campaignId}`, { method: 'POST', body: { limit: 20 } });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.queued, 0);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=3001').get().status, 'uncertain');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=? AND lead_id=301').get(campaignId).count, 1);
});
