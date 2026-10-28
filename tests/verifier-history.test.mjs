import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-verifier-history-'));
const databasePath = path.join(directory, 'fixture.db');
process.env.ODD_DB_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;
const { initDb, closeDb } = await import('../pipeline/database.js');
let db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase) VALUES ('History fixture','verify')").run().lastInsertRowid);
const leadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email) VALUES (?,'History fixture','owner@example.test')").run(batchId).lastInsertRowid);
const original = '{"email":"owner@example.test","verification_status":"deliverable","checks":{"smtp":true},"legacy":"retained"}';
const emailId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,is_primary,verification_status,verification_json,verified_at)
  VALUES (?,'owner@example.test','website_observation',1,'deliverable',?,'2026-10-01 00:00:00')`).run(leadId, original).lastInsertRowid);
closeDb();
const legacy = new Database(databasePath);
legacy.exec('DROP TABLE email_verification_history; DELETE FROM schema_migrations WHERE version>=5');
legacy.close();
db = initDb();
const { getVerificationHistory, reverifyEmailById } = await import('../pipeline/email-verifier.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise(resolve => server.close(resolve)); closeDb(); rmSync(directory, { recursive: true, force: true }); });

test('versioned migration backfills exact prior evidence and repeated startup preserves one copy', () => {
  const history = getVerificationHistory(emailId);
  assert.equal(history.results.length, 1);
  assert.equal(history.results[0].verification_json, original);
  assert.equal(history.results[0].verified_at, '2026-10-01 00:00:00');
  assert.equal(history.contact.source, 'website_observation');
  initDb();
  assert.equal(getVerificationHistory(emailId).results.length, 1);
});

test('rechecking retains every audit, original contact/source identity and transaction rollback', async () => {
  for (const status of ['unknown', 'risky', 'unknown']) {
    await reverifyEmailById(emailId, { verifyEmailImpl: async email => ({ email, verification_status: status, checks: { smtp: null } }) });
  }
  const history = getVerificationHistory(emailId);
  assert.deepEqual(history.results.map(row => row.verification_status), ['unknown', 'risky', 'unknown', 'deliverable']);
  assert.equal(history.results.at(-1).verification_json, original);
  assert.equal(history.contact.lead_id, leadId);
  assert.equal(history.contact.source, 'website_observation');
  assert.equal(db.prepare('SELECT is_primary FROM lead_emails WHERE id=?').get(emailId).is_primary, 1);
  const before = db.prepare('SELECT * FROM lead_emails WHERE id=?').get(emailId);
  db.exec(`CREATE TRIGGER reject_history_fixture BEFORE INSERT ON email_verification_history BEGIN SELECT RAISE(ABORT,'injected history failure'); END`);
  await assert.rejects(() => reverifyEmailById(emailId, { verifyEmailImpl: async email => ({ email, verification_status: 'undeliverable', checks: { smtp: false } }) }), /injected history failure/);
  db.exec('DROP TRIGGER reject_history_fixture');
  assert.deepEqual(db.prepare('SELECT * FROM lead_emails WHERE id=?').get(emailId), before);
  assert.equal(getVerificationHistory(emailId).results.length, 4);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
});

test('history API is cursor paginated, validates inputs and survives an independent process reopen', async () => {
  let cursor;
  const collected = [];
  do {
    const response = await fetch(`${base}/api/verify/email/${emailId}/history?limit=1${cursor ? `&before=${cursor}` : ''}`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.contact.source, 'website_observation');
    assert.equal(page.results.length, 1);
    collected.push(page.results[0].id);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(collected).size, 4);
  assert.equal((await fetch(`${base}/api/verify/email/${emailId}/history?limit=101`)).status, 400);
  assert.equal((await fetch(`${base}/api/verify/email/${emailId}/history?before=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/verify/email/999999/history`)).status, 404);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {initDb,closeDb}=await import('./pipeline/database.js');
    const {getVerificationHistory}=await import('./pipeline/email-verifier.js');
    initDb(); const h=getVerificationHistory(${emailId});
    if(h.results.length!==4 || h.results.at(-1).result.legacy!=='retained') process.exitCode=1;
    closeDb();
  `], { cwd: process.cwd(), env: { ...process.env, ODD_DB_PATH: databasePath }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test('relative times interpret SQLite timestamps as UTC in different local timezones', () => {
  for (const timezone of ['Asia/Kolkata', 'America/Toronto', 'UTC']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {relTime} from './js/api.js';
      Date.now=()=>Date.parse('2026-10-19T08:00:00Z');
      assert.equal(relTime('2026-10-19 07:59:50'),'just now');
      assert.equal(relTime('2026-10-19 07:58:00'),'2m ago');
      assert.equal(relTime('2026-10-19T13:28:00+05:30'),'2m ago');
      assert.equal(relTime('bad date'),'—');
    `], { cwd: process.cwd(), env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, `${timezone}: ${child.stderr || child.stdout}`);
  }
});
