import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-launch-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-launch-bootstrap-token-123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
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
      callback(null, 'Launch snapshot fixture accepted');
    });
  },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });

db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (990,'Launch snapshot fixture','test','open')").run();
db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,
  smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
  VALUES (990,'launch-sender@example.test','example.test','eligible',100,100,1,'127.0.0.1',?,?, 'fixture-only',0)`)
  .run(smtp.server.address().port, 'fixture');
db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_at)
  VALUES (990,'approved','smtp-imap-source-evidence-v2','{"fixture":"pre_reviewed_sender"}',datetime('now'))`).run();

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
let ownerSession = null;
const worker = await import('../pipeline/sending-engine.js');

after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => smtp.close(resolve))]);
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function sessionFrom(setCookie) {
  const cookie = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(cookie && csrf, 'authenticated session cookies are set');
  return { cookie: `odd_session=${cookie}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

async function request(route, { method = 'GET', body, session = ownerSession } = {}) {
  const queueMatch = method === 'POST' && route.match(/^\/api\/sending\/queue\/(\d+)$/);
  if (queueMatch && body && !body.reviewHash) {
    const reviewResponse = await fetch(`${base}/api/sending/campaigns/${queueMatch[1]}/preflight`, {
      headers: session?.cookie ? { cookie: session.cookie } : {},
    });
    const review = await reviewResponse.json();
    body = { ...body, reviewHash: review.reviewHash };
  }
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(session?.cookie ? { cookie: session.cookie } : {}),
      ...(session?.csrf ? { 'x-csrf-token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: payload };
}

const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', session: null, body: {
  email: 'launch-owner@example.test', password: 'Fixture-launch-owner-password-9!',
  bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
} });
assert.equal(bootstrap.status, 201, JSON.stringify(bootstrap.body));
ownerSession = sessionFrom(bootstrap.setCookie);

function addContact(id, email) {
  db.prepare(`INSERT INTO leads(id,batch_id,business_name,category,email,status)
    VALUES (?,990,?,'Test category',?,'queued')`).run(id, `Snapshot contact ${id}`, email);
  db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,verified_at)
    VALUES (?,?,'deliverable',datetime('now'))`).run(id, email);
  const result = db.prepare(`INSERT INTO personalizations(lead_id,subject_variant,subject_line,body_variant,body_text,
    guardrail_passed,fact_check_passed,approved)
    VALUES (?,'A',?,'A',?,1,1,1)`).run(id, `Approved subject ${id}`, `Approved body ${id}`);
  return Number(result.lastInsertRowid);
}

async function createCampaign(name, leadIds, { sequence = false } = {}) {
  const created = await request('/api/sending/campaigns', { method: 'POST', body: { name } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const campaignId = created.body.id;
  for (const leadId of leadIds) db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);
  const selected = await request(`/api/sending/campaigns/${campaignId}/senders`, {
    method: 'PUT', body: { mailboxIds: [990] },
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  let stepId = null;
  if (sequence) {
    const createdStep = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, { method: 'POST', body: {} });
    assert.equal(createdStep.status, 201, JSON.stringify(createdStep.body));
    stepId = createdStep.body.steps[0].id;
    const updated = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${stepId}`, {
      method: 'PUT', body: { variants: [
        { variantKey: 'A', allocationPct: 100, subjectLine: 'Hello {{business_name}}', bodyText: 'Reviewed sequence body for {{business_name}}.' },
        { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
      ] },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
  }
  return { campaignId, stepId };
}

async function sendDueRows() {
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE status='scheduled'").run();
  return worker.processSendQueue({ limit: 20 });
}

test('first queue persists an immutable launch snapshot, binds exact copy, and blocks later config drift before SMTP', async () => {
  const sequenceContact1 = 9901;
  const sequenceContact2 = 9902;
  addContact(sequenceContact1, 'first-sequence@example.test');
  addContact(sequenceContact2, 'second-sequence@example.test');
  const sequence = await createCampaign('Immutable sequence', [sequenceContact1, sequenceContact2], { sequence: true });

  const dryRun = await request(`/api/sending/queue/${sequence.campaignId}`, {
    method: 'POST', body: { limit: 1, dryRun: true },
  });
  assert.equal(dryRun.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_launches WHERE campaign_id=?').get(sequence.campaignId).count, 0,
    'dry-run must not create a durable launch');

  const queued = await request(`/api/sending/queue/${sequence.campaignId}`, { method: 'POST', body: { limit: 1 } });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(queued.body.queued, 1);
  const launch = db.prepare('SELECT * FROM campaign_launches WHERE campaign_id=?').get(sequence.campaignId);
  assert.ok(launch);
  assert.equal(launch.version, 1);
  assert.equal(launch.snapshot_hash, createHash('sha256').update(launch.snapshot_json).digest('hex'));
  const snapshot = JSON.parse(launch.snapshot_json);
  assert.equal(Object.hasOwn(snapshot, 'offer'), false, 'legacy NULL bindings keep the historical snapshot shape');
  assert.equal(snapshot.audience.length, 2);
  assert.deepEqual(snapshot.senderMailboxIds, [990]);
  assert.equal(snapshot.senderIdentities[0].email, 'launch-sender@example.test');
  assert.equal(snapshot.steps.length, 1);
  assert.equal(snapshot.steps[0].variants[0].body, 'Reviewed sequence body for {{business_name}}.');

  const firstSend = db.prepare('SELECT * FROM sends WHERE campaign_id=?').get(sequence.campaignId);
  assert.equal(firstSend.campaign_launch_id, launch.id);
  assert.equal(firstSend.subject_snapshot, 'Hello Snapshot contact 9901');
  assert.equal(firstSend.body_snapshot, 'Reviewed sequence body for Snapshot contact 9901.');
  const list = await request('/api/sending/campaigns');
  const listed = list.body.find(campaign => campaign.id === sequence.campaignId);
  assert.equal(listed.launch_snapshot.snapshotHash, launch.snapshot_hash);
  assert.equal(listed.launch_snapshot.recipientCount, 2);
  assert.equal(listed.launch_snapshot.senderCount, 1);

  assert.throws(() => db.prepare('UPDATE campaign_launches SET snapshot_json=? WHERE id=?').run('{}', launch.id), /immutable/i);
  assert.throws(() => db.prepare('DELETE FROM campaign_launches WHERE id=?').run(launch.id), /immutable/i);
  assert.throws(() => db.prepare('UPDATE sends SET body_snapshot=? WHERE id=?').run('Changed after review', firstSend.id), /immutable/i);
  assert.throws(() => db.prepare('UPDATE sends SET campaign_launch_id=NULL WHERE id=?').run(firstSend.id), /immutable/i);
  assert.throws(() => db.prepare('UPDATE sends SET mailbox_id=NULL WHERE id=?').run(firstSend.id), /immutable/i);
  assert.doesNotMatch(launch.snapshot_json, /fixture-only|smtp_pass/i, 'SMTP credentials are never copied into launch evidence');
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}`, { method: 'PATCH', body: { name: 'Changed' } })).status, 409);
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}/senders`, { method: 'PUT', body: { mailboxIds: [] } })).status, 409);
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}/audience`, { method: 'POST', body: { leadIds: [9903] } })).status, 409);
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}/audience/${sequenceContact2}`, { method: 'DELETE' })).status, 409);
  assert.equal((await request(`/api/sending/campaigns/${sequence.campaignId}/sequence/steps/${sequence.stepId}`, {
    method: 'PUT', body: { variants: [{ variantKey: 'A', allocationPct: 100, subjectLine: 'Changed', bodyText: 'Changed' }] },
  })).status, 409);
  assert.equal((await request('/api/sending/mailboxes/990', { method: 'PATCH', body: { from_name: 'Changed identity' } })).status, 409,
    'the selected sender identity cannot change underneath a launched campaign');
  assert.equal((await request('/api/sending/mailboxes/990', { method: 'DELETE' })).status, 409,
    'a launched sender is retired rather than deleted so campaign evidence remains intact');

  const sent = await sendDueRows();
  assert.equal(sent.sent, 1, JSON.stringify(sent));
  assert.equal(accepted.length, 1, 'the local SMTP sink observed one accepted DATA submission');
  assert.deepEqual(accepted[0].recipients, ['first-sequence@example.test']);
  assert.match(accepted[0].raw, /Subject: Hello Snapshot contact 9901/i);
  assert.match(accepted[0].raw, /Reviewed sequence body for Snapshot contact 9901\./);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(firstSend.id).status, 'sent');

  const driftLead1 = 9911;
  const driftLead2 = 9912;
  const driftPersonalizationId = addContact(driftLead1, 'drift-first@example.test');
  addContact(driftLead2, 'drift-second@example.test');
  const generic = await createCampaign('Copy drift fixture', [driftLead1, driftLead2]);
  const genericQueue = await request(`/api/sending/queue/${generic.campaignId}`, { method: 'POST', body: { limit: 1 } });
  assert.equal(genericQueue.status, 200, JSON.stringify(genericQueue.body));
  assert.equal(genericQueue.body.queued, 1);
  const driftSend = db.prepare('SELECT * FROM sends WHERE campaign_id=?').get(generic.campaignId);
  assert.ok(driftSend.campaign_launch_id);
  assert.equal(driftSend.subject_snapshot, 'Approved subject 9911');
  assert.equal(driftSend.body_snapshot, 'Approved body 9911');

  db.prepare('UPDATE personalizations SET body_text=? WHERE id=?').run('Unreviewed changed content', driftPersonalizationId);
  const secondQueue = await request(`/api/sending/queue/${generic.campaignId}`, { method: 'POST', body: { limit: 1 } });
  assert.equal(secondQueue.status, 409, 'queue refuses new recipients once any launched config digest changes');
  const blocked = await sendDueRows();
  assert.equal(blocked.blocked, 1, JSON.stringify(blocked));
  assert.equal(accepted.length, 1, 'snapshot mismatch is stopped before transport; the sink sees no changed-copy message');
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(driftSend.id).status, 'cancelled');
  const mismatchEvent = db.prepare(`SELECT meta_json FROM events WHERE send_id=?
    AND event_type='campaign_launch_configuration_mismatch'`).get(driftSend.id);
  assert.ok(mismatchEvent);
  assert.equal(JSON.parse(mismatchEvent.meta_json).stage, 'pre_smtp_launch_snapshot_gate');

  const legacyOffer = await request('/api/offers', { method: 'POST', body: { name: 'Unowned legacy offer', content: {
    service: 'Synthetic audit', scope: 'One synthetic review.', price: { minMinor: 10000, maxMinor: 20000, currency: 'USD' },
    proofAssets: [{ proofId: 'legacy-proof', reference: 'fixture://no-upload', contentHash: 'c'.repeat(64),
      observedAt: '2026-10-01T00:00:00Z', expiresAt: '2035-01-01T00:00:00Z', rightsBasis: 'Synthetic fixture only' }],
    audienceExclusions: [], geography: { includedCountries: ['US'] }, capacity: 1,
    egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] },
  } } });
  assert.equal(legacyOffer.status, 201, JSON.stringify(legacyOffer.body));
  const legacyApproval = await request(`/api/offers/${legacyOffer.body.id}/versions/${legacyOffer.body.version.id}/approve`, { method: 'POST', body: {} });
  assert.equal(legacyApproval.status, 404, 'an unmigrated legacy offer without trusted tenant UUID ownership remains denied');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM offer_tenant_ownership WHERE offer_id=?').get(legacyOffer.body.id).count, 0);
});
