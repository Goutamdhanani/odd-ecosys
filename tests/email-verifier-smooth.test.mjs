import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verifier-alias-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
const { initDb, closeDb } = await import('../pipeline/database.js');
const { buildAuditResult, verifyBatch, getVerificationResults, cancelVerification } = await import('../pipeline/email-verifier.js');
const db = initDb();
after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

function result(email, status = 'deliverable') {
  const audit = buildAuditResult(email, {
    syntax: { is_valid_syntax: status !== 'undeliverable' },
    mx: { accepts_mail: true, records: ['mx.fixture.test'] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: status !== 'unknown', is_deliverable: status === 'deliverable' ? true : null, is_catch_all: false },
  });
  // Explicit synthetic verifier output exercises persistence without promoting
  // real provider labels or RCPT acceptance to mailbox proof.
  return { ...audit, engine: 'synthetic_fixture', verification_status: status,
    checks: { ...audit.checks, smtp: status === 'deliverable' ? true : null } };
}
function fixture(name, primary, alias) {
  const batch = Number(db.prepare("INSERT INTO batches(name,phase) VALUES (?,'verify')").run(name).lastInsertRowid);
  const lead = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,?,?,'site_checked')").run(batch, name, primary).lastInsertRowid);
  const aliasId = Number(db.prepare("INSERT INTO lead_emails(lead_id,email,source,is_primary) VALUES (?,?,'website_observation',0)").run(lead, alias).lastInsertRowid);
  return { batch, lead, aliasId };
}

test('each saved address is checked independently without selecting an observed alias, retaining both audits', async () => {
  const { batch, lead, aliasId } = fixture('Alias recovery', 'invalid-primary', 'alex@fixture.test');
  const checked = [];
  const progress = [];
  const run = await verifyBatch(batch, {
    sleepImpl: async () => {}, onProgress: state => progress.push(state),
    verifyEmailImpl: async email => { checked.push(email); return result(email, email === 'invalid-primary' ? 'undeliverable' : 'deliverable'); },
  });
  assert.deepEqual(checked, ['invalid-primary', 'alex@fixture.test']);
  assert.deepEqual([run.processed, run.deliverable, run.undeliverable], [2, 1, 1]);
  assert.equal(progress.length, 2);
  assert.deepEqual(db.prepare('SELECT email,status FROM leads WHERE id=?').get(lead), { email: 'invalid-primary', status: 'site_checked' });
  const rows = getVerificationResults(batch).results;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === aliasId).source, 'website_observation');
  assert.equal(rows.find(row => row.id === aliasId).is_primary, 0);
  assert.equal(rows.find(row => row.email === 'invalid-primary').is_primary, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_history WHERE email_id IN (SELECT id FROM lead_emails WHERE lead_id=?)').get(lead).n, 2);
});

test('unconfirmed aliases are retained without silent promotion or disqualification', async () => {
  const { batch, lead, aliasId } = fixture('Unconfirmed fallback', 'another-invalid-primary', 'unconfirmed@fixture.test');
  await verifyBatch(batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => result(email, email.includes('invalid') ? 'undeliverable' : 'unknown') });
  const contact = db.prepare('SELECT email,status FROM leads WHERE id=?').get(lead);
  assert.equal(contact.email, 'another-invalid-primary');
  assert.equal(contact.status, 'site_checked');
  assert.equal(db.prepare('SELECT verification_status,is_primary,source FROM lead_emails WHERE id=?').get(aliasId).verification_status, 'unknown');
});

test('per-address checks include saved aliases, and cancellation preserves only the completed check', async () => {
  const accepted = fixture('Accepted primary', 'accepted@fixture.test', 'unused@fixture.test');
  const checked = [];
  await verifyBatch(accepted.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => { checked.push(email); return result(email); } });
  assert.deepEqual(checked, ['accepted@fixture.test', 'unused@fixture.test']);
  assert.notEqual(db.prepare('SELECT verified_at FROM lead_emails WHERE id=?').get(accepted.aliasId).verified_at, null);
  const cancelled = fixture('Cancelled alias fallback', 'cancel-invalid', 'later@fixture.test');
  const run = await verifyBatch(cancelled.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => {
    cancelVerification(cancelled.batch); return result(email, 'undeliverable');
  } });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.processed, 1);
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=? AND email=?').get(cancelled.lead, 'cancel-invalid').verification_status, 'undeliverable');
  assert.equal(db.prepare('SELECT verified_at FROM lead_emails WHERE id=?').get(cancelled.aliasId).verified_at, null);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(cancelled.lead).status, 'site_checked');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
});

test('unknown and rejected records preserve the contact lifecycle and never implicitly promote aliases', async () => {
  const unknown = fixture('Unknown primary', 'unknown-primary@fixture.test', 'untouched@fixture.test');
  const checked = [];
  const inconclusive = await verifyBatch(unknown.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => { checked.push(email); return result(email, 'unknown'); } });
  assert.deepEqual(checked, ['unknown-primary@fixture.test', 'untouched@fixture.test']);
  assert.equal(inconclusive.unknown, 2);
  assert.notEqual(db.prepare('SELECT verified_at FROM lead_emails WHERE id=?').get(unknown.aliasId).verified_at, null);

  const rejected = fixture('All rejected', 'bad-primary', 'bad-alias');
  await verifyBatch(rejected.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => result(email, 'undeliverable') });
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(rejected.lead).status, 'site_checked');

  const unsupported = fixture('Unsupported positive', 'bad-original', 'reported@fixture.test');
  await verifyBatch(unsupported.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => email === 'bad-original'
    ? result(email, 'undeliverable') : { ...result(email), checks: { smtp: null } } });
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(unsupported.lead).email, 'bad-original');
  assert.equal(db.prepare('SELECT is_primary FROM lead_emails WHERE id=?').get(unsupported.aliasId).is_primary, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
