import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-archiver-lifecycle-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.HOST;
const { closeDb, initDb } = await import('../pipeline/database.js');
let db = initDb();
const { archiveBatch, restoreBatch } = await import('../pipeline/archiver.js');
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

function seed({ batchId, leadId, status = 'discovered' }) {
  db.prepare('INSERT OR IGNORE INTO batches(id,name,phase,status) VALUES(?,?,?,?)').run(batchId, `Batch ${batchId}`, 'test', 'open');
  db.prepare('INSERT INTO leads(id,batch_id,business_name,email,status) VALUES(?,?,?,?,?)')
    .run(leadId, batchId, `Contact ${leadId}`, `contact${leadId}@example.test`, status);
}

test('archiving fails before mutation when a batch has non-terminal contacts', () => {
  seed({ batchId: 810, leadId: 810, status: 'discovered' });
  seed({ batchId: 810, leadId: 811, status: 'disqualified' });

  assert.throws(() => archiveBatch(810), /1 contact\(s\).*not in terminal states/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=810').get().count, 2);
  assert.equal(db.prepare("SELECT status FROM batches WHERE id=810").get().status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads_archive WHERE batch_id=810').get().count, 0);
});

test('a terminal contact cannot be archived while its campaign enrollment is active', () => {
  seed({ batchId: 820, leadId: 820, status: 'sent' });
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES(820,'Active fixture','active')").run();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id,status) VALUES(820,820,\'active\')').run();

  assert.throws(() => archiveBatch(820), /still active in campaign #820/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=820').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE lead_id=820').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads_archive WHERE id=820').get().count, 0);
});

test('an uncertain or in-flight send blocks archival and remains untouched', () => {
  seed({ batchId: 830, leadId: 830, status: 'sent' });
  db.prepare("INSERT INTO sends(id,lead_id,status) VALUES(830,830,'uncertain')").run();

  assert.throws(() => archiveBatch(830), /send #830 is uncertain/i);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id=830').get().status, 'uncertain');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=830').get().count, 1);
  assert.equal(db.prepare("SELECT status FROM batches WHERE id=830").get().status, 'open');
});

test('a terminal batch with no active campaign work archives and closes transactionally', () => {
  seed({ batchId: 840, leadId: 840, status: 'disqualified' });

  const result = archiveBatch(840);
  assert.deepEqual({ archivedLeads: result.archivedLeads, archivedSends: result.archivedSends }, { archivedLeads: 1, archivedSends: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=840').get().count, 0);
  assert.equal(db.prepare('SELECT business_name,status FROM leads_archive WHERE id=840').get().status, 'disqualified');
  assert.equal(db.prepare("SELECT status FROM batches WHERE id=840").get().status, 'closed');
});

test('archive snapshot survives restart and restores linked email evidence, personalization, sends, and events', () => {
  seed({ batchId: 850, leadId: 850, status: 'sent' });
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES(850,'Completed archive fixture','completed')").run();
  db.prepare("INSERT INTO campaign_enrollments(campaign_id,lead_id,status) VALUES(850,850,'completed')").run();
  db.prepare(`INSERT INTO lead_emails(id,lead_id,email,source,verification_status,is_primary,verified_at,verification_json)
    VALUES(850,850,'history@example.test','website','risky',1,'2026-10-14T00:00:00.000Z','{"syntax":true,"mx":true}')`).run();
  db.prepare(`INSERT INTO lead_email_source_evidence(id,lead_email_id,source_url,evidence_type)
    VALUES(850,850,'https://example.test/contact','website_html')`).run();
  db.prepare(`INSERT INTO email_verification_history(id,email_id,email,verification_status,verification_json,verified_at)
    VALUES(850,850,'history@example.test','unknown','{"prior":"kept"}','2026-10-13 00:00:00')`).run();
  db.prepare(`INSERT INTO lead_email_contact_point_evidence(id,evidence_id,contact_type,contact_name,contact_title)
    VALUES(850,850,'sales','A. Contact','Director')`).run();
  db.prepare(`INSERT INTO personalizations(id,lead_id,subject_line,body_text,approved,guardrail_passed)
    VALUES(850,850,'Archive subject','Archive body',1,1)`).run();
  db.prepare(`INSERT INTO sends(id,lead_id,campaign_id,personalization_id,status,sent_at,subject_snapshot,body_snapshot)
    VALUES(850,850,850,850,'sent','2026-10-14 00:00:00','Frozen subject','Frozen body')`).run();
  db.prepare(`INSERT INTO events(id,send_id,lead_id,event_type,event_at,meta_json)
    VALUES(850,850,850,'sent','2026-10-14 00:00:01','{"delivery":"unknown"}')`).run();

  const archived = archiveBatch(850);
  assert.equal(archived.archivedLeads, 1);
  assert.equal(archived.archivedSends, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_email_source_evidence WHERE id=850').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events WHERE id=850').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_verification_history WHERE email_id=850').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM batch_archive_snapshots WHERE batch_id=850 AND restored_at IS NULL').get().count, 1);

  closeDb();
  db = initDb();
  const restored = restoreBatch(850);
  assert.deepEqual({ restoredLeads: restored.restoredLeads, restoredSends: restored.restoredSends }, { restoredLeads: 1, restoredSends: 1 });
  assert.deepEqual(db.prepare('SELECT email,verification_status,verification_json FROM lead_emails WHERE id=850').get(), {
    email: 'history@example.test', verification_status: 'risky', verification_json: '{"syntax":true,"mx":true}',
  });
  assert.deepEqual(db.prepare('SELECT id,email_id,verification_status,verification_json,verified_at FROM email_verification_history WHERE id=850').get(), {
    id: 850, email_id: 850, verification_status: 'unknown', verification_json: '{"prior":"kept"}', verified_at: '2026-10-13 00:00:00',
  });
  assert.deepEqual(db.prepare('SELECT source_url,evidence_type FROM lead_email_source_evidence WHERE id=850').get(), {
    source_url: 'https://example.test/contact', evidence_type: 'website_html',
  });
  assert.equal(db.prepare('SELECT contact_name FROM lead_email_contact_point_evidence WHERE id=850').get().contact_name, 'A. Contact');
  assert.equal(db.prepare('SELECT subject_line FROM personalizations WHERE id=850').get().subject_line, 'Archive subject');
  assert.equal(db.prepare('SELECT subject_snapshot FROM sends WHERE id=850').get().subject_snapshot, 'Frozen subject');
  assert.equal(db.prepare('SELECT meta_json FROM events WHERE id=850').get().meta_json, '{"delivery":"unknown"}');
  assert.equal(db.prepare("SELECT status FROM campaign_enrollments WHERE campaign_id=850 AND lead_id=850").get().status, 'completed');
  assert.equal(db.prepare("SELECT status FROM batches WHERE id=850").get().status, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads_archive WHERE id=850').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM batch_archive_snapshots WHERE batch_id=850 AND restored_at IS NOT NULL').get().count, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => restoreBatch(850), /no restorable archive snapshot/i);
});

test('archive and restore are available through the existing batch API and shown as restorable', async () => {
  seed({ batchId: 860, leadId: 860, status: 'disqualified' });
  const archivedResponse = await fetch(`${base}/api/batches/860/archive`, { method: 'POST' });
  assert.equal(archivedResponse.status, 200);
  assert.deepEqual(await archivedResponse.json().then(({ ok, batchId, archivedLeads }) => ({ ok, batchId, archivedLeads })), {
    ok: true, batchId: 860, archivedLeads: 1,
  });

  const statsResponse = await fetch(`${base}/api/stats/archive`);
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  assert.ok(stats.restorableBatchIds.includes(860));

  const restoredResponse = await fetch(`${base}/api/batches/860/restore`, { method: 'POST' });
  assert.equal(restoredResponse.status, 200);
  assert.deepEqual(await restoredResponse.json().then(({ ok, batchId, restoredLeads }) => ({ ok, batchId, restoredLeads })), {
    ok: true, batchId: 860, restoredLeads: 1,
  });
  assert.equal(db.prepare('SELECT business_name FROM leads WHERE id=860').get().business_name, 'Contact 860');
});

test('the archive API returns an actionable conflict and preserves a non-terminal batch', async () => {
  seed({ batchId: 870, leadId: 870, status: 'discovered' });
  const response = await fetch(`${base}/api/batches/870/archive`, { method: 'POST' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not in terminal states/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=870').get().count, 1);
  assert.equal(db.prepare("SELECT status FROM batches WHERE id=870").get().status, 'open');
});

test('archive copy, snapshot, row deletion, and batch close roll back together on an injected failure', () => {
  seed({ batchId: 880, leadId: 880, status: 'disqualified' });
  db.exec(`CREATE TRIGGER fixture_archive_delete_failure BEFORE DELETE ON leads WHEN OLD.id=880
    BEGIN SELECT RAISE(ABORT,'fixture archive rollback'); END`);
  assert.throws(() => archiveBatch(880), /fixture archive rollback/);
  db.exec('DROP TRIGGER fixture_archive_delete_failure');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=880').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads_archive WHERE id=880').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM batch_archive_snapshots WHERE batch_id=880').get().count, 0);
  assert.equal(db.prepare("SELECT status FROM batches WHERE id=880").get().status, 'open');
});
