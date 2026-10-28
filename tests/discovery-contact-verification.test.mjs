import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-discovered-email-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { initDb, closeDb } = await import('../pipeline/database.js');
const { verifyBatch } = await import('../pipeline/email-verifier.js');
const db = initDb();
after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

function seed(name, addresses, primary = null) {
  const batch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES (?,'discovery','open')").run(name).lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,?,?,'discovered')").run(batch, name, primary).lastInsertRowid);
  for (const email of addresses) {
    const emailId = Number(db.prepare("INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary) VALUES (?,?,'website_scan','unknown',0)").run(id, email).lastInsertRowid);
    db.prepare("INSERT INTO lead_email_source_evidence(lead_email_id,source_url,evidence_type) VALUES (?,?,'mailto')").run(emailId, `https://source.example.test/contact/${emailId}`);
  }
  return { batch, id };
}
const calls = [];
const evidence = status => ({ verification_status: status, checks: { smtp: status === 'deliverable' ? true : null }, score: null });
const options = status => ({ sleepImpl: async () => {}, verifyEmailImpl: async email => { calls.push(email); return evidence(status); } });

function snapshot(contact) {
  return {
    lead: db.prepare('SELECT * FROM leads WHERE id=?').get(contact.id),
    addresses: db.prepare('SELECT id,email,source,is_primary FROM lead_emails WHERE lead_id=? ORDER BY id').all(contact.id),
    sources: db.prepare(`SELECT e.* FROM lead_email_source_evidence e
      JOIN lead_emails le ON le.id=e.lead_email_id WHERE le.lead_id=? ORDER BY e.id`).all(contact.id),
  };
}

function assertPreserved(contact, before) {
  assert.deepEqual(db.prepare('SELECT * FROM leads WHERE id=?').get(contact.id), before.lead,
    'verification does not select a sending address or change the contact lifecycle');
  for (const address of before.addresses) {
    assert.deepEqual(db.prepare('SELECT id,email,source,is_primary FROM lead_emails WHERE id=?').get(address.id), address,
      'each saved row keeps its identity, original spelling, source and primary selection');
    const history = db.prepare('SELECT email,verification_status FROM email_verification_history WHERE email_id=?').all(address.id);
    assert.equal(history.length, 1, 'each saved address receives exactly one audit');
    assert.equal(history[0].email, address.email, 'audit is associated with the original saved spelling');
  }
  assert.deepEqual(db.prepare(`SELECT e.* FROM lead_email_source_evidence e
    JOIN lead_emails le ON le.id=e.lead_email_id WHERE le.lead_id=? ORDER BY e.id`).all(contact.id), before.sources);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0, 'verification queues and sends no messages');
}

test('batch verification checks every observed address independently without selecting an unconfirmed address', async () => {
  const contact = seed('Observed only unknown', ['taylor@source.example.test', 'other@source.example.test']);
  const before = snapshot(contact);
  const run = await verifyBatch(contact.batch, options('unknown'));
  assert.equal(run.total, 2);
  assert.equal(run.processed, 2, 'neither saved address may disappear from the verification input');
  assert.equal(run.unknown, 2);
  assert.deepEqual(calls, ['taylor@source.example.test', 'other@source.example.test']);
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(contact.id).email, null);
  assert.equal(db.prepare('SELECT SUM(is_primary) AS n FROM lead_emails WHERE lead_id=?').get(contact.id).n, 0);
  assert.deepEqual(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=? ORDER BY id').all(contact.id),
    [{ verification_status: 'unknown' }, { verification_status: 'unknown' }]);
  assertPreserved(contact, before);
});

test('positive verification records the observed result without implicitly selecting a sending address', async () => {
  const contact = seed('Observed positive', ['confirmed@source.example.test']);
  const before = snapshot(contact);
  const run = await verifyBatch(contact.batch, options('deliverable'));
  assert.equal(run.processed, 1);
  assert.equal(run.deliverable, 1);
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(contact.id).email, null);
  assert.deepEqual(db.prepare('SELECT verification_status,is_primary FROM lead_emails WHERE lead_id=?').get(contact.id),
    { verification_status: 'deliverable', is_primary: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_email_source_evidence e JOIN lead_emails le ON le.id=e.lead_email_id WHERE le.lead_id=?').get(contact.id).n, 1);
  assertPreserved(contact, before);
});

test('missing-primary results never select an address and checking an existing primary also audits its saved alias', async () => {
  const missing = seed('Observed purported positive', ['purported@source.example.test']);
  const missingBefore = snapshot(missing);
  await verifyBatch(missing.batch, { sleepImpl: async () => {}, verifyEmailImpl: async () => ({ verification_status: 'deliverable', checks: { smtp: null } }) });
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(missing.id).email, null);
  assertPreserved(missing, missingBefore);
  const existing = seed('Existing primary', ['stored-alias@source.example.test'], 'current@source.example.test');
  const existingBefore = snapshot(existing);
  const checked = [];
  const run = await verifyBatch(existing.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => { checked.push(email); return evidence('unknown'); } });
  assert.deepEqual(checked, ['current@source.example.test', 'stored-alias@source.example.test']);
  assert.equal(run.processed, 2);
  assert.equal(run.unknown, 2);
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(existing.id).email, 'current@source.example.test');
  assert.deepEqual(db.prepare('SELECT email,is_primary,verification_status FROM lead_emails WHERE lead_id=? ORDER BY is_primary DESC').all(existing.id),
    [{ email: 'current@source.example.test', is_primary: 1, verification_status: 'unknown' },
      { email: 'stored-alias@source.example.test', is_primary: 0, verification_status: 'unknown' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_history h JOIN lead_emails le ON le.id=h.email_id WHERE le.lead_id=?').get(existing.id).n, 2);
  assertPreserved(existing, existingBefore);
});

test('rejected and positive observed addresses retain both audits without implicitly selecting the positive alias', async () => {
  const contact = seed('Observed alias recovery', ['reject@source.example.test', 'recover@source.example.test']);
  const before = snapshot(contact);
  const checked = [];
  const run = await verifyBatch(contact.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => {
    checked.push(email);
    return evidence(email.startsWith('reject') ? 'undeliverable' : 'deliverable');
  } });
  assert.deepEqual(checked, ['reject@source.example.test', 'recover@source.example.test']);
  assert.equal(run.processed, 2);
  assert.equal(run.undeliverable, 1);
  assert.equal(run.deliverable, 1);
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(contact.id).email, null);
  const rows = db.prepare('SELECT id,email,verification_status,is_primary FROM lead_emails WHERE lead_id=? ORDER BY id').all(contact.id);
  assert.deepEqual(rows.map(row => [row.verification_status, row.is_primary]), [['undeliverable', 0], ['deliverable', 0]]);
  for (const row of rows) {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_history WHERE email_id=?').get(row.id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_email_source_evidence WHERE lead_email_id=?').get(row.id).n, 1);
  }
  assertPreserved(contact, before);
});

test('legacy whitespace and case variants each retain their original row, spelling, source and independent history', async () => {
  const contact = seed('Legacy padded observed', ['  padded@source.example.test  ', 'PADDED@source.example.test']);
  const before = snapshot(contact);
  const checked = [];
  const run = await verifyBatch(contact.batch, { sleepImpl: async () => {}, verifyEmailImpl: async email => {
    checked.push(email); return evidence('deliverable');
  } });
  assert.equal(run.processed, 2);
  assert.equal(run.deliverable, 2);
  assert.deepEqual(checked, ['padded@source.example.test', 'PADDED@source.example.test']);
  const afterRows = db.prepare('SELECT id,source,verification_status,is_primary FROM lead_emails WHERE lead_id=? ORDER BY id').all(contact.id);
  assert.deepEqual(afterRows.map(({ id, source }) => ({ id, source })), before.addresses.map(({ id, source }) => ({ id, source })));
  assert.equal(afterRows[0].verification_status, 'deliverable');
  assert.equal(afterRows[0].is_primary, 0);
  assert.equal(afterRows[1].verification_status, 'deliverable');
  assert.equal(afterRows[1].is_primary, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_history WHERE email_id=?').get(before.addresses[0].id).n, 1);
  for (const row of before.addresses) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_email_source_evidence WHERE lead_email_id=?').get(row.id).n, 1);
  assertPreserved(contact, before);
});
