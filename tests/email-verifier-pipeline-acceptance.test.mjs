import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verifier-acceptance-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const {
  buildSuppressedVerificationResult,
  getVerificationEvidenceDistribution,
  getVerificationStatus,
  reverifyEmailById,
  verifyBatch,
  verifyEmail,
} = await import('../pipeline/email-verifier.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Verifier synthetic acceptance','verification','open')").run().lastInsertRowid);
const emailIds = [];
for (let index = 1; index <= 100; index++) {
  const email = `person${String(index).padStart(3, '0')}@synthetic-customer.test`;
  const leadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,email,status)
    VALUES (? ,? ,?,'discovered')`).run(batchId, `Synthetic Business ${index}`, email).lastInsertRowid);
  const emailId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary)
    VALUES (?,?,'website','unknown',1)`).run(leadId, email).lastInsertRowid);
  emailIds.push(emailId);
  db.prepare(`INSERT INTO lead_email_source_evidence(lead_email_id,source_url,evidence_type)
    VALUES (?,?,'website_html')`).run(emailId, `https://synthetic-customer.test/contact/${index}`);
}
const suppressedEmail = 'person100@synthetic-customer.test';
db.prepare("INSERT INTO suppression_list(email,reason) VALUES (?,'synthetic opt-out fixture')").run(suppressedEmail);

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('100 source-backed addresses persist independent verifier evidence while suppression and unknown stay separate', async () => {
  let resolverCalls = 0;
  let smtpCalls = 0;
  const resolveMx = async () => { resolverCalls++; return [{ priority: 10, exchange: 'mx.synthetic-customer.test' }]; };
  const result = await verifyBatch(batchId, {
    verifyEmailImpl: async email => {
      return verifyEmail(email, {
        mode: 'syntax_dns',
        resolveMxImpl: resolveMx,
        checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
        smtpProbeImpl: async () => { smtpCalls++; throw new Error('SMTP must be disabled in this fixture'); },
      });
    },
    sleepImpl: async () => {},
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.total, 100);
  assert.equal(result.processed, 100);
  assert.equal(result.risky, 0);
  assert.equal(result.unknown, 99);
  assert.equal(result.deliverable, 0);
  assert.equal(result.undeliverable, 0);
  assert.equal(result.suppressed, 1);
  assert.equal(smtpCalls, 0);
  assert.equal(resolverCalls, 1, 'the DNS result is cached across the 99 addresses in the same domain');

  const suppressedRow = db.prepare('SELECT verification_status,verified_at FROM lead_emails WHERE id=?').get(emailIds[99]);
  assert.equal(suppressedRow.verification_status, 'unknown', 'suppression does not overwrite prior verification evidence');
  assert.equal(suppressedRow.verified_at, null);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=(SELECT lead_id FROM lead_emails WHERE id=?)').get(emailIds[99]).status, 'discovered');
  assert.equal(getVerificationStatus(batchId).suppressed, 1);
  assert.equal(getVerificationStatus(batchId).unknown, 99);

  const summary = getVerificationEvidenceDistribution(batchId);
  assert.deepEqual({
    total: summary.counts.emailRecords,
    sourceBacked: summary.counts.sourceBacked,
    suppressed: summary.counts.suppressed,
    route: summary.counts.mailRoutePresent,
    unconfirmed: summary.counts.mailboxUnconfirmed,
    confirmed: summary.counts.mailboxConfirmed,
  }, { total: 100, sourceBacked: 100, suppressed: 1, route: 99, unconfirmed: 99, confirmed: 0 });

  const distributionResponse = await fetch(`${base}/api/verify/evidence-distribution?batch_id=${batchId}`);
  assert.equal(distributionResponse.status, 200);
  const apiSummary = await distributionResponse.json();
  assert.equal(apiSummary.counts.mailboxConfirmed, 0);
  assert.equal(apiSummary.counts.mailboxUnconfirmed, 99);
  assert.match(apiSummary.mailboxConfirmationPolicy, /do not/i);

  const singleResponse = await fetch(`${base}/api/verify/single`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: suppressedEmail }),
  });
  assert.equal(singleResponse.status, 200);
  const single = (await singleResponse.json()).result;
  assert.equal(single.engine, 'local_policy_gate');
  assert.equal(single.verification_status, 'unknown');
  assert.equal(single.verification_evidence.suppression_status, 'suppressed');
  assert.equal(single.verification_evidence.dns_status, 'unknown');

  let repeatedChecks = 0;
  const reverify = await reverifyEmailById(emailIds[99], { verifyEmailImpl: async () => { repeatedChecks++; throw new Error('suppressed check must not call verifier'); } });
  assert.equal(reverify.verification_evidence.suppression_status, 'suppressed');
  assert.equal(repeatedChecks, 0);
  assert.equal(typeof buildSuppressedVerificationResult(suppressedEmail).verification_evidence.checked_at, 'string');
});

test('verification job migration adds independent unknown and suppressed counters without losing jobs', () => {
  const columns = new Set(db.prepare('PRAGMA table_info(verification_jobs)').all().map(column => column.name));
  assert.ok(columns.has('unknown'));
  assert.ok(columns.has('suppressed'));
  const saved = db.prepare('SELECT total,processed,deliverable,risky,unknown,undeliverable,suppressed FROM verification_jobs WHERE batch_id=?').get(batchId);
  assert.deepEqual(saved, { total: 100, processed: 100, deliverable: 0, risky: 0, unknown: 99, undeliverable: 0, suppressed: 1 });
});
