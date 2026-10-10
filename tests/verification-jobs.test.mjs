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

  const interrupted = db.prepare(`INSERT INTO verification_jobs(batch_id,status,total,processed,deliverable,started_at)
    VALUES (?,'running',3,1,1,datetime('now'))`).run(batchId);
  const recovery = recoverInterruptedVerificationJobs();
  assert.deepEqual(recovery, [{ id: Number(interrupted.lastInsertRowid), status: 'interrupted' }]);
  const interruptedStatus = getVerificationStatus(batchId);
  assert.equal(interruptedStatus.status, 'interrupted');
  assert.equal(interruptedStatus.processed, 1);
  assert.equal(interruptedStatus.errorCode, 'worker_restarted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id IN (802,803)').get().count, 0, 'restart recovery does not automatically repeat provider checks or synthesize results');

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
