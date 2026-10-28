import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verification-jobs-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const { cancelVerification, getVerificationStatus, recoverInterruptedVerificationJobs, verifyBatch } = await import('../pipeline/email-verifier.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function makeBatch(name) {
  const result = db.prepare("INSERT INTO batches(name,phase,status) VALUES (?,'verification','open')").run(name);
  return Number(result.lastInsertRowid);
}

function addLead(id, batchId, email) {
  db.prepare("INSERT INTO leads(id,batch_id,business_name,email,status) VALUES (?,?,?,?,'discovered')")
    .run(id, batchId, `Synthetic ${id}`, email);
}

function verifierResult(email) {
  return {
    email, valid: true, verification_status: 'deliverable', score: 94,
    is_catch_all: false, is_role_account: false, is_free_provider: false, is_disposable: false,
    mx_host: 'mx.example.test', checks: { smtp: null }, reasons: [],
  };
}

async function request(route, { method = 'GET' } = {}) {
  const response = await fetch(`${base}${route}`, { method });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  return { status: response.status, body };
}

test('verification progress and cancellation persist, report actual evidence counts, and recover safely after restart', async () => {
  const batchId = makeBatch('cancel fixture');
  addLead(801, batchId, 'one@example.test');
  addLead(802, batchId, 'two@example.test');
  addLead(803, batchId, 'three@example.test');
  let announceStarted;
  const started = new Promise(resolve => { announceStarted = resolve; });
  let releaseVerifier;
  const gate = new Promise(resolve => { releaseVerifier = resolve; });

  const run = verifyBatch(batchId, {
    verifyEmailImpl: async email => { announceStarted(email); await gate; return verifierResult(email); },
    sleepImpl: async () => {},
  });
  assert.equal(await started, 'one@example.test');

  const running = await request(`/api/verify/status?batch_id=${batchId}`);
  assert.equal(running.status, 200);
  assert.equal(running.body.active, true);
  assert.equal(running.body.status, 'running');
  assert.equal(running.body.total, 3);
  assert.equal(running.body.processed, 0);
  assert.equal(running.body.currentEmail, 'one@example.test');
  await assert.rejects(() => verifyBatch(batchId, { verifyEmailImpl: async () => verifierResult('duplicate@example.test') }), error => error.statusCode === 409);

  const cancellation = await request(`/api/verify/batch/${batchId}/cancel`, { method: 'POST' });
  assert.equal(cancellation.status, 200);
  assert.equal(cancellation.body.status, 'cancel_requested');
  assert.equal(cancellation.body.changed, true);
  const requested = await request(`/api/verify/status?batch_id=${batchId}`);
  assert.equal(requested.body.status, 'cancel_requested');
  assert.equal(requested.body.active, true);

  releaseVerifier();
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.total, 3);
  assert.equal(result.processed, 1);
  assert.equal(result.deliverable, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id IN (801,802,803)').get().count, 1);

  const persisted = await request(`/api/verify/status?batch_id=${batchId}`);
  assert.equal(persisted.body.status, 'cancelled');
  assert.equal(persisted.body.active, false);
  assert.equal(persisted.body.processed, 1);
  assert.equal(persisted.body.deliverable, 1);

  closeDb();
  db = initDb();
  assert.equal(getVerificationStatus(batchId).status, 'cancelled');
  assert.equal(getVerificationStatus(batchId).processed, 1);

  const interruptedEmailId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,is_primary)
    VALUES (802,'retry@example.test','unknown',1)`).run().lastInsertRowid);
  const interrupted = db.prepare(`INSERT INTO verification_jobs(batch_id,status,total,processed,deliverable,current_lead_id,
    current_email,current_email_row_id,started_at)
    VALUES (?,'running',3,1,1,802,'retry@example.test',?,datetime('now'))`).run(batchId, interruptedEmailId);
  const recovery = recoverInterruptedVerificationJobs();
  assert.deepEqual(recovery, [{ id: Number(interrupted.lastInsertRowid), status: 'interrupted' }]);
  const interruptedStatus = getVerificationStatus(batchId);
  assert.equal(interruptedStatus.status, 'interrupted');
  assert.equal(interruptedStatus.processed, 1);
  assert.equal(interruptedStatus.errorCode, 'worker_restarted');
  assert.equal(interruptedStatus.currentEmail, null);
  assert.equal(interruptedStatus.currentEmailRowId, null);
  assert.deepEqual(db.prepare('SELECT current_lead_id,current_email,current_email_row_id FROM verification_jobs WHERE id=?').get(Number(interrupted.lastInsertRowid)), {
    current_lead_id: null, current_email: null, current_email_row_id: null,
  }, 'restart recovery removes the stale in-flight address pointer without retrying it');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id IN (802,803) AND verification_status!='unknown'").get().count, 0,
    'restart recovery does not automatically repeat provider checks or synthesize results');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE id=? AND verification_status='unknown'").get(interruptedEmailId).count, 1,
    'the saved in-flight address remains intact for an explicit retry');

  const pendingCancel = db.prepare(`INSERT INTO verification_jobs(batch_id,status,total,started_at)
    VALUES (?,'cancel_requested',3,datetime('now'))`).run(batchId);
  assert.deepEqual(recoverInterruptedVerificationJobs(), [{ id: Number(pendingCancel.lastInsertRowid), status: 'cancelled' }]);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('verification provider failures persist a bounded error and leave unverified contacts untouched', async () => {
  const batchId = makeBatch('failure fixture');
  addLead(811, batchId, 'failure@example.test');
  await assert.rejects(() => verifyBatch(batchId, {
    verifyEmailImpl: async () => { throw new Error('synthetic provider unavailable'); },
    sleepImpl: async () => {},
  }), /synthetic provider unavailable/);
  const status = getVerificationStatus(batchId);
  assert.equal(status.status, 'failed');
  assert.equal(status.errorMessage, 'synthetic provider unavailable');
  assert.equal(status.processed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=811').get().count, 0);
});

test('unknown verification outcomes have their own counter and never inflate undeliverable totals', async () => {
  const batchId = makeBatch('unknown outcome fixture');
  addLead(821, batchId, 'unknown@example.test');
  addLead(822, batchId, 'no-route@example.test');
  const result = await verifyBatch(batchId, {
    verifyEmailImpl: async email => ({
      email,
      verification_status: email.startsWith('unknown@') ? 'unknown' : 'undeliverable',
      verification_evidence: { schema_version: 1, syntax_status: 'valid', dns_status: email.startsWith('unknown@') ? 'temporary_failure' : 'null_mx',
        provider: 'Other', smtp_status: 'not_attempted', mailbox_status: 'unconfirmed' },
      checks: { regex: true, mx: null, smtp: null },
    }),
    sleepImpl: async () => {},
  });
  assert.deepEqual({ processed: result.processed, unknown: result.unknown, undeliverable: result.undeliverable },
    { processed: 2, unknown: 1, undeliverable: 1 });
  assert.equal(getVerificationStatus(batchId).unknown, 1);
  assert.equal(getVerificationStatus(batchId).undeliverable, 1);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=821').get().status, 'discovered');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=822').get().status, 'discovered');
});

test('batch verification checks every saved alias and email-only contact without changing address identity or contact status', async () => {
  const batchId = makeBatch('saved alias batch fixture');
  const aliasOnlyLead = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,'Alias only',NULL,'disqualified')")
    .run(batchId).lastInsertRowid);
  const ownerId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary)
    VALUES (?, 'owner@example.test','source-a','unknown',1)`).run(aliasOnlyLead).lastInsertRowid);
  const aliasId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary)
    VALUES (?, 'sales@example.test','source-b','unknown',0)`).run(aliasOnlyLead).lastInsertRowid);
  const legacyLead = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,'Legacy only','legacy@example.test','archived')")
    .run(batchId).lastInsertRowid);
  const verified = [];
  const result = await verifyBatch(batchId, {
    verifyEmailImpl: async email => { verified.push(email); return verifierResult(email); },
    sleepImpl: async () => {},
  });

  assert.deepEqual(verified, ['owner@example.test', 'sales@example.test', 'legacy@example.test']);
  assert.equal(result.total, 3);
  assert.equal(result.processed, 3);
  assert.deepEqual(db.prepare('SELECT id,email,is_primary,verification_status,source FROM lead_emails WHERE lead_id=? ORDER BY id').all(aliasOnlyLead), [
    { id: ownerId, email: 'owner@example.test', is_primary: 1, verification_status: 'deliverable', source: 'source-a' },
    { id: aliasId, email: 'sales@example.test', is_primary: 0, verification_status: 'deliverable', source: 'source-b' },
  ]);
  const legacyEmail = db.prepare('SELECT email,is_primary,verification_status,verified_at FROM lead_emails WHERE lead_id=?').get(legacyLead);
  assert.deepEqual({ email: legacyEmail.email, is_primary: legacyEmail.is_primary, verification_status: legacyEmail.verification_status }, {
    email: 'legacy@example.test', is_primary: 1, verification_status: 'deliverable',
  });
  assert.equal(typeof legacyEmail.verified_at, 'string');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(aliasOnlyLead).status, 'disqualified');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(legacyLead).status, 'archived');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(legacyLead).count, 1,
    'legacy contact.email is materialized once and no duplicate is created');
});

test('persisted verification progress identifies the alias currently being checked and clears it on completion', async () => {
  const batchId = makeBatch('alias progress fixture');
  const leadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,'Alias progress','owner@example.test','discovered')")
    .run(batchId).lastInsertRowid);
  db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,is_primary) VALUES (?,'owner@example.test','unknown',1)")
    .run(leadId);
  const aliasId = Number(db.prepare("INSERT INTO lead_emails(lead_id,email,verification_status,is_primary) VALUES (?,'sales@example.test','unknown',0)")
    .run(leadId).lastInsertRowid);
  let announceAlias;
  const aliasStarted = new Promise(resolve => { announceAlias = resolve; });
  let releaseAlias;
  const aliasGate = new Promise(resolve => { releaseAlias = resolve; });

  const run = verifyBatch(batchId, {
    verifyEmailImpl: async email => {
      if (email === 'sales@example.test') {
        announceAlias();
        await aliasGate;
      }
      return verifierResult(email);
    },
    sleepImpl: async () => {},
  });
  await aliasStarted;

  const running = await request(`/api/verify/status?batch_id=${batchId}`);
  assert.equal(running.status, 200);
  assert.equal(running.body.currentEmail, 'sales@example.test');
  assert.equal(running.body.currentEmailRowId, aliasId);
  assert.deepEqual(db.prepare('SELECT current_email,current_email_row_id FROM verification_jobs WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId), {
    current_email: 'sales@example.test', current_email_row_id: aliasId,
  });

  releaseAlias();
  const completed = await run;
  assert.equal(completed.status, 'completed');
  assert.equal(getVerificationStatus(batchId).currentEmail, null);
  assert.equal(getVerificationStatus(batchId).currentEmailRowId, null);
  assert.deepEqual(db.prepare('SELECT current_email,current_email_row_id FROM verification_jobs WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId), {
    current_email: null, current_email_row_id: null,
  });
});

test('suppressed legacy-only addresses are recorded without a verifier call or fabricated check timestamp', async () => {
  const batchId = makeBatch('suppressed legacy fixture');
  const leadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,'Opted out','opted-out@example.test','discovered')")
    .run(batchId).lastInsertRowid);
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES ('opted-out@example.test','synthetic opt out')").run();
  const result = await verifyBatch(batchId, {
    verifyEmailImpl: async () => { throw new Error('suppressed address must not be checked'); },
    sleepImpl: async () => {},
  });
  assert.equal(result.processed, 1);
  assert.equal(result.suppressed, 1);
  assert.deepEqual(db.prepare('SELECT email,is_primary,verification_status,verified_at,verification_json FROM lead_emails WHERE lead_id=?').get(leadId), {
    email: 'opted-out@example.test', is_primary: 1, verification_status: 'unknown', verified_at: null, verification_json: null,
  });
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(leadId).status, 'discovered');
});
