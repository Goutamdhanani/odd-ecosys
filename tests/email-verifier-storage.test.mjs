import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verification-storage-'));
const databasePath = path.join(directory, 'legacy.db');
process.env.ODD_DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
const { closeDb, initDb } = database;
const initialDb = initDb();
const batchId = Number(initialDb.prepare("INSERT INTO batches(name,phase) VALUES ('Verification storage fixture','verify')").run().lastInsertRowid);
const leadId = Number(initialDb.prepare(`
  INSERT INTO leads(batch_id,business_name,email,status)
  VALUES (?,'Synthetic Example','owner@example.test','discovered')
`).run(batchId).lastInsertRowid);
const currentEmailId = Number(initialDb.prepare(`
  INSERT INTO lead_emails(lead_id,email,source,verification_status)
  VALUES (?, 'owner@example.test', 'csv_import', 'unknown')
`).run(leadId).lastInsertRowid);
const aliasEmailId = Number(initialDb.prepare(`
  INSERT INTO lead_emails(lead_id,email,source,verification_status)
  VALUES (?, 'sales@example.test', 'csv_import', 'unknown')
`).run(leadId).lastInsertRowid);
closeDb();

// Rebuild only the verification table to match the legacy schema found in old databases.
// The test retains IDs, sources, and verification status to exercise an in-place migration.
const legacyDb = new Database(databasePath);
legacyDb.pragma('foreign_keys = OFF');
legacyDb.exec(`
  CREATE TABLE lead_emails_legacy (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    email TEXT NOT NULL,
    source TEXT,
    verification_status TEXT,
    is_catch_all INTEGER DEFAULT 0,
    is_role_account INTEGER DEFAULT 0,
    verified_at TEXT
  );
  INSERT INTO lead_emails_legacy (id,lead_id,email,source,verification_status,is_catch_all,is_role_account,verified_at)
    SELECT id,lead_id,email,source,verification_status,is_catch_all,is_role_account,verified_at FROM lead_emails;
  DROP TABLE lead_emails;
  ALTER TABLE lead_emails_legacy RENAME TO lead_emails;
  DELETE FROM schema_migrations;
  INSERT INTO verification_jobs(id,batch_id,status,total,processed,deliverable,risky,undeliverable) VALUES(700,1,'completed',4,4,1,2,1);
`);
legacyDb.close();

const db = initDb();
const { formatVerificationCsvRow, getVerificationDistribution, getVerificationExport, getVerificationResults, getVerificationStatus, reverifyEmailById, verifyBatch, verifyEmail } = await import('../pipeline/email-verifier.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

test('legacy verification storage migrates without losing rows and persists batch/reverification evidence', async () => {
  const columns = new Set(db.prepare('PRAGMA table_info(lead_emails)').all().map(column => column.name));
  assert.ok(columns.has('is_primary'));
  assert.ok(columns.has('confidence_score'));
  const verificationJobColumns = new Set(db.prepare('PRAGMA table_info(verification_jobs)').all().map(column => column.name));
  assert.ok(verificationJobColumns.has('unknown'));
  assert.ok(verificationJobColumns.has('suppressed'));
  assert.ok(verificationJobColumns.has('current_email'));
  assert.ok(verificationJobColumns.has('current_email_row_id'));
  assert.deepEqual(db.prepare('SELECT id,total,processed,deliverable,risky,undeliverable,unknown,suppressed FROM verification_jobs WHERE id=700').get(),
    { id: 700, total: 4, processed: 4, deliverable: 1, risky: 2, undeliverable: 1, unknown: 0, suppressed: 0 },
    'adding independent counters preserves old completed job evidence');
  assert.equal(db.prepare('SELECT source FROM lead_emails WHERE id=?').get(currentEmailId).source, 'csv_import');
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE id=?').get(aliasEmailId).verification_status, 'unknown');

  const run = await verifyBatch(batchId, {
    verifyEmailImpl: async email => ({
      email,
      valid: true,
      verification_status: 'deliverable',
      score: 96,
      is_catch_all: false,
      is_role_account: false,
      is_free_provider: false,
      is_disposable: false,
      mx_host: 'mx.example.test',
      checks: { smtp: true },
      reasons: [],
    }),
    sleepImpl: async () => {},
  });

  assert.deepEqual({ total: run.total, processed: run.processed, deliverable: run.deliverable }, { total: 2, processed: 2, deliverable: 2 });
  assert.equal(getVerificationStatus().active, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=? AND email=?').get(leadId, 'owner@example.test').count, 1);
  assert.deepEqual(db.prepare('SELECT id,is_primary,verification_status,confidence_score,source,mx_host FROM lead_emails WHERE lead_id=? ORDER BY id').all(leadId), [
    { id: currentEmailId, is_primary: 0, verification_status: 'deliverable', confidence_score: 96, source: 'csv_import', mx_host: 'mx.example.test' },
    { id: aliasEmailId, is_primary: 0, verification_status: 'deliverable', confidence_score: 96, source: 'csv_import', mx_host: 'mx.example.test' },
  ]);

  const saved = getVerificationResults(batchId, { limit: 10 });
  assert.equal(saved.total, 2);
  assert.equal(saved.results.find(row => row.id === currentEmailId).verification_status, 'deliverable');
  assert.equal(saved.results.find(row => row.id === aliasEmailId).verification_status, 'deliverable');
  assert.deepEqual(getVerificationDistribution(batchId), [
    { verification_status: 'deliverable', count: 2 },
  ]);
  assert.equal(JSON.parse(db.prepare('SELECT verification_json FROM lead_emails WHERE id=?').get(currentEmailId).verification_json).checks.smtp, true);

  const apiResultsResponse = await fetch(`${base}/api/verify/results/${batchId}`);
  assert.equal(apiResultsResponse.status, 200);
  const apiResults = await apiResultsResponse.json();
  assert.equal(apiResults.total, 2);
  assert.equal(apiResults.results.find(row => row.id === currentEmailId).confidence_score, 96);
  db.prepare('UPDATE lead_emails SET confidence_score=20, verification_json=? WHERE id=?')
    .run(JSON.stringify({ verification_status: 'unknown' }), aliasEmailId);
  const legacyScoreResponse = await fetch(`${base}/api/verify/results/${batchId}`);
  const legacyScoreResults = await legacyScoreResponse.json();
  assert.equal(legacyScoreResults.results.find(row => row.id === aliasEmailId).confidence_score, null,
    'legacy guessed column values are hidden when saved verifier evidence has no score');
  const apiDistributionResponse = await fetch(`${base}/api/verify/distribution?batch_id=${batchId}`);
  assert.deepEqual(await apiDistributionResponse.json(), [
    { verification_status: 'deliverable', count: 2 },
  ]);

  const revised = await reverifyEmailById(currentEmailId, {
    verifyEmailImpl: async email => ({
      email,
      valid: false,
      verification_status: 'risky',
      score: 61,
      is_catch_all: true,
      is_role_account: false,
      is_free_provider: true,
      is_disposable: false,
      mx_host: 'mx2.example.test',
      checks: { smtp: null },
      reasons: ['smtp_unconfirmed'],
    }),
  });
  assert.equal(revised.verification_status, 'risky');
  assert.deepEqual(db.prepare('SELECT is_primary,verification_status,confidence_score,source,mx_host FROM lead_emails WHERE id=?').get(currentEmailId), {
    is_primary: 0,
    verification_status: 'risky',
    confidence_score: 61,
    source: 'csv_import',
    mx_host: 'mx2.example.test',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=? AND email=?').get(leadId, 'owner@example.test').count, 1);
  assert.equal(db.prepare('SELECT is_primary FROM lead_emails WHERE id=?').get(aliasEmailId).is_primary, 0,
    'batch verification preserves the saved alias and primary-address designation');

  for (const unsupportedScore of [undefined, -1, 101, Number.NaN, '96']) {
    await reverifyEmailById(currentEmailId, {
      verifyEmailImpl: async email => ({
        email,
        valid: false,
        verification_status: 'unknown',
        ...(unsupportedScore === undefined ? {} : { score: unsupportedScore }),
        checks: { smtp: null },
      }),
    });
    assert.equal(db.prepare('SELECT confidence_score FROM lead_emails WHERE id=?').get(currentEmailId).confidence_score, null);
    const unscoredResponse = await fetch(`${base}/api/verify/results/${batchId}`);
    const unscoredResults = await unscoredResponse.json();
    assert.equal(unscoredResults.results.find(row => row.id === currentEmailId).confidence_score, null);
  }
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // Exercise the production syntax/capability path through the durable worker and HTTP result API.
  const idnBatchId = Number(db.prepare("INSERT INTO batches(name,phase) VALUES ('IDN verifier fixture','verify')").run().lastInsertRowid);
  const idnAddress = 'δοκιμή@παράδειγμα.δοκιμή';
  const idnLeadId = Number(db.prepare(`
    INSERT INTO leads(batch_id,business_name,email,status)
    VALUES (?,'Internationalized Synthetic Contact',?,'discovered')
  `).run(idnBatchId, idnAddress).lastInsertRowid);
  const idnEmailId = Number(db.prepare(`
    INSERT INTO lead_emails(lead_id,email,source,verification_status)
    VALUES (?,?, 'csv_import', 'unknown')
  `).run(idnLeadId, idnAddress).lastInsertRowid);
  const idnRun = await verifyBatch(idnBatchId, { sleepImpl: async () => {} });
  assert.deepEqual({ processed: idnRun.processed, risky: idnRun.risky, undeliverable: idnRun.undeliverable }, {
    processed: 1, risky: 0, undeliverable: 0,
  });
  const storedIdn = db.prepare('SELECT email,source,verification_status,verification_json,mx_host FROM lead_emails WHERE id=?').get(idnEmailId);
  assert.equal(storedIdn.email, idnAddress, 'the saved contact address remains the original U-label form');
  assert.equal(storedIdn.source, 'csv_import');
  assert.equal(storedIdn.verification_status, 'unknown');
  assert.equal(storedIdn.mx_host, null);
  const idnEvidence = JSON.parse(storedIdn.verification_json);
  assert.equal(idnEvidence.email, 'δοκιμή@xn--hxajbheg2az3al.xn--jxalpdlp');
  assert.equal(idnEvidence.reacher.syntax.originalEmail, idnAddress);
  assert.equal(idnEvidence.engine, 'smtp_utf8_capability_gate');
  assert.equal(idnEvidence.checks.mx, null);
  assert.equal(idnEvidence.checks.smtp, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(idnLeadId).count, 1);

  const idnApiResponse = await fetch(`${base}/api/verify/results/${idnBatchId}`);
  assert.equal(idnApiResponse.status, 200);
  const idnApi = await idnApiResponse.json();
  const idnApiRow = idnApi.results.find(row => row.id === idnEmailId);
  assert.equal(idnApiRow.email, idnAddress);
  assert.equal(JSON.parse(idnApiRow.verification_json).checks.smtp, null);

  const singleResponse = await fetch(`${base}/api/verify/single`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: idnAddress }),
  });
  assert.equal(singleResponse.status, 200);
  const single = (await singleResponse.json()).result;
  assert.equal(single.email, 'δοκιμή@xn--hxajbheg2az3al.xn--jxalpdlp');
  assert.equal(single.verification_status, 'unknown');
  assert.equal(single.checks.mx, null);
  assert.equal(single.checks.smtp, null);

  const uncertainAddress = 'Owner@dns-timeout.example';
  const uncertainBatchId = Number(db.prepare("INSERT INTO batches(name,phase) VALUES ('Uncertain DNS verifier fixture','verify')").run().lastInsertRowid);
  const uncertainLeadId = Number(db.prepare(`
    INSERT INTO leads(batch_id,business_name,email,status)
    VALUES (?,'DNS Timeout Synthetic Contact',?,'discovered')
  `).run(uncertainBatchId, uncertainAddress).lastInsertRowid);
  const uncertainEmailId = Number(db.prepare(`
    INSERT INTO lead_emails(lead_id,email,source,verification_status)
    VALUES (?,?, 'csv_import', 'unknown')
  `).run(uncertainLeadId, uncertainAddress).lastInsertRowid);
  await verifyBatch(uncertainBatchId, {
    verifyEmailImpl: address => verifyEmail(address, {
      resolveMxImpl: async () => { throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEOUT' }); },
      resolve4Impl: async () => { throw new Error('address fallback must not run after an MX timeout'); },
      resolve6Impl: async () => { throw new Error('address fallback must not run after an MX timeout'); },
      checkDisifyImpl: async () => { throw new Error('disposable lookup must not run after an MX timeout'); },
      smtpProbeImpl: async () => { throw new Error('SMTP probe must not run after an MX timeout'); },
    }),
    sleepImpl: async () => {},
  });
  const storedUncertain = db.prepare('SELECT verification_status,verification_json,mx_host FROM lead_emails WHERE id=?').get(uncertainEmailId);
  const uncertainEvidence = JSON.parse(storedUncertain.verification_json);
  assert.equal(storedUncertain.verification_status, 'unknown');
  assert.equal(storedUncertain.mx_host, null);
  assert.equal(uncertainEvidence.checks.mx, null);
  assert.equal(uncertainEvidence.checks.smtp, null);
  assert.equal(uncertainEvidence.reacher.mx.reason, 'dns_mx_lookup_failed:ETIMEOUT');
  assert.equal(uncertainEvidence.reacher.smtp.is_deliverable, null);
  const uncertainApiResponse = await fetch(`${base}/api/verify/results/${uncertainBatchId}`);
  const uncertainApi = await uncertainApiResponse.json();
  const uncertainApiRow = uncertainApi.results.find(row => row.id === uncertainEmailId);
  assert.equal(uncertainApiRow.verification_status, 'unknown');
  assert.equal(JSON.parse(uncertainApiRow.verification_json).reacher.mx.reason, 'dns_mx_lookup_failed:ETIMEOUT');
});

test('legacy free-provider Risky labels project to Unknown across filters, counts, API, and export without rewriting evidence', async () => {
  const sharedModuleResponse = await fetch(`${base}/shared/verification-classification.js`);
  assert.equal(sharedModuleResponse.status, 200, 'the browser can load the shared classification rule');
  assert.match(await sharedModuleResponse.text(), /deriveVerificationClassification/);

  const legacyBatchId = Number(db.prepare("INSERT INTO batches(name,phase) VALUES ('Legacy verifier result fixture','verify')").run().lastInsertRowid);
  const legacyResult = {
    email: 'goutamdhanani@gmail.com',
    verification_status: 'risky',
    engine: 'local_dns',
    general: { domain: 'gmail.com', reason: 'Google mail route · mailbox unconfirmed' },
    attributes: { free: true, role: false, disposable: false, accept_all: null },
    is_free_provider: true,
    is_role_account: false,
    is_disposable: false,
    is_catch_all: null,
    mx_host: 'gmail-smtp-in.l.google.com',
    checks: { regex: true, mx: true, disposable: true, smtp: null },
    verification_evidence: {
      syntax_status: 'valid',
      dns_status: 'mail_route_present',
      provider: 'Google',
      smtp_status: 'not_attempted',
      mailbox_status: 'unconfirmed',
      disposable_status: 'not_in_checked_list',
      disposable_evidence_source: 'local_known_domain_list',
      role_account: false,
      disposable: false,
      verifier_engine: 'local_dns',
      provider_verdict: null,
    },
  };
  const legacyLeadId = Number(db.prepare(`
    INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,'Owner Gmail fixture',?,'discovered')
  `).run(legacyBatchId, legacyResult.email).lastInsertRowid);
  const legacyJson = JSON.stringify(legacyResult);
  const legacyEmailId = Number(db.prepare(`
    INSERT INTO lead_emails(lead_id,email,source,verification_status,is_free_provider,is_role_account,is_disposable,is_catch_all,mx_host,verification_json)
    VALUES (?,?, 'csv_import','risky',1,0,0,0,?,?)
  `).run(legacyLeadId, legacyResult.email, legacyResult.mx_host, legacyJson).lastInsertRowid);

  const explicitRiskLeadId = Number(db.prepare(`
    INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,'Explicit risk fixture','risky@gmail.com','discovered')
  `).run(legacyBatchId).lastInsertRowid);
  db.prepare(`
    INSERT INTO lead_emails(lead_id,email,source,verification_status,is_free_provider,is_role_account,is_disposable,is_catch_all,mx_host,verification_json)
    VALUES (?,'risky@gmail.com','csv_import','risky',1,0,0,0,'gmail-smtp-in.l.google.com',?)
  `).run(explicitRiskLeadId, JSON.stringify({
    ...legacyResult,
    email: 'risky@gmail.com',
    verification_evidence: { ...legacyResult.verification_evidence, provider_verdict: 'risky' },
    reacher: { is_reachable: 'risky' },
  }));

  const all = getVerificationResults(legacyBatchId, { limit: 10 });
  assert.equal(all.total, 2);
  assert.equal(all.results.find(row => row.id === legacyEmailId).verification_status, 'unknown');
  assert.equal(all.results.find(row => row.id === legacyEmailId).stored_verification_status, 'risky');
  assert.equal(all.results.find(row => row.id === legacyEmailId).classification_adjustment, 'legacy_free_provider_risky');
  assert.equal(getVerificationResults(legacyBatchId, { status: 'unknown', limit: 10 }).total, 1);
  assert.equal(getVerificationResults(legacyBatchId, { status: 'risky', limit: 10 }).total, 1,
    'an explicit provider-risk result remains in the Risky filter');
  assert.deepEqual(getVerificationDistribution(legacyBatchId), [
    { verification_status: 'risky', count: 1 },
    { verification_status: 'unknown', count: 1 },
  ]);

  const apiResponse = await fetch(`${base}/api/verify/results/${legacyBatchId}?status=unknown`);
  assert.equal(apiResponse.status, 200);
  const apiResults = await apiResponse.json();
  assert.equal(apiResults.total, 1);
  assert.equal(apiResults.results[0].email, legacyResult.email);
  assert.equal(apiResults.results[0].verification_status, 'unknown');

  const exportedUnknown = [...getVerificationExport(legacyBatchId, { status: 'unknown' }).rows];
  assert.equal(exportedUnknown.length, 1);
  assert.equal(exportedUnknown[0].verification_status, 'unknown');
  assert.match(formatVerificationCsvRow(exportedUnknown[0]), /"unknown"/);

  const after = db.prepare('SELECT source,verification_status,verification_json FROM lead_emails WHERE id=?').get(legacyEmailId);
  assert.deepEqual(after, { source: 'csv_import', verification_status: 'risky', verification_json: legacyJson },
    'classification correction is read-only and retains the original record and evidence');
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});
