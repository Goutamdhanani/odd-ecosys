import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-launch-archive-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { archiveBatch, restoreBatch } = await import('../pipeline/archiver.js');

after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('archiving a sent contact preserves launch version and exact per-send copy evidence', () => {
  db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (992,'Archive fixture','test','open')").run();
  db.prepare("INSERT INTO leads(id,batch_id,business_name,email,status) VALUES (992,992,'Archived snapshot contact','archived@example.test','sent')").run();
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (992,'Archived launch','completed')").run();
  const snapshotJson = JSON.stringify({ schemaVersion: 1, audience: [{ leadId: 992 }], senderMailboxIds: [1], steps: [] });
  const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex');
  const launch = db.prepare('INSERT INTO campaign_launches(id,campaign_id,version,snapshot_json,snapshot_hash) VALUES (992,992,1,?,?)')
    .run(snapshotJson, snapshotHash);
  assert.equal(Number(launch.lastInsertRowid), 992);
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,campaign_launch_id,variant,
    subject_snapshot,body_snapshot,in_reply_to_message_id,scheduled_at,sent_at,status)
    VALUES (992,992,NULL,992,992,'A','Frozen subject','Frozen body',NULL,datetime('now'),datetime('now'),'sent')`).run();

  const result = archiveBatch(992);
  assert.equal(result.archivedSends, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE id=992').get().count, 0);
  const archived = db.prepare('SELECT * FROM sends_archive WHERE id=992').get();
  assert.equal(archived.campaign_launch_id, 992);
  assert.equal(archived.subject_snapshot, 'Frozen subject');
  assert.equal(archived.body_snapshot, 'Frozen body');
  assert.equal(db.prepare('SELECT snapshot_hash FROM campaign_launches WHERE id=992').get().snapshot_hash, snapshotHash);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('batch archive retains active contacts, active enrollments, and uncertain sends', () => {
  db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (993,'Mixed lifecycle fixture','test','open')").run();
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (993,'Active sequence','active')").run();
  db.prepare(`INSERT INTO leads(id,batch_id,business_name,email,status) VALUES
    (993,993,'Active enrollment','active@example.test','sent'),
    (994,993,'Uncertain transport','uncertain@example.test','lost'),
    (995,993,'Still discovered','discovered@example.test','discovered'),
    (996,993,'Completed record','completed@example.test','won'),
    (997,993,'Unrecognized transport state','reconciling@example.test','lost')`).run();
  db.prepare("INSERT INTO campaign_enrollments(campaign_id,lead_id,status) VALUES (993,993,'active')").run();
  db.prepare("INSERT INTO sends(id,lead_id,campaign_id,status) VALUES (993,993,993,'scheduled'),(994,994,993,'uncertain'),(996,996,993,'sent'),(997,997,993,'reconciling')").run();

  assert.throws(() => archiveBatch(993), /not in terminal states.*discovered/i);
  assert.deepEqual(db.prepare('SELECT id FROM leads WHERE batch_id=993 ORDER BY id').all().map(row => row.id), [993, 994, 995, 996, 997]);
  assert.deepEqual(db.prepare('SELECT id,status FROM sends WHERE lead_id IN (993,994,997) ORDER BY id').all(), [
    { id: 993, status: 'scheduled' },
    { id: 994, status: 'uncertain' },
    { id: 997, status: 'reconciling' },
  ]);
  assert.equal(db.prepare('SELECT id FROM sends WHERE id=996').get()?.id, 996);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends_archive WHERE id=996').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM batches WHERE id=993').get().status, 'open');
  assert.throws(() => archiveBatch(993), /not in terminal states/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id IN (993,994,997)').get().count, 3,
    'repeated archive cannot consume active or uncertain send records');
  db.prepare("UPDATE leads SET status='lost' WHERE id=995").run();
  assert.throws(() => archiveBatch(993), /still active in campaign/i);
  db.prepare("UPDATE campaign_enrollments SET status='completed' WHERE lead_id=993").run();
  assert.throws(() => archiveBatch(993), /send #993 is scheduled/i);
  db.prepare("UPDATE sends SET status='cancelled' WHERE id=993").run();
  assert.throws(() => archiveBatch(993), /send #994 is uncertain/i);
  db.prepare("UPDATE sends SET status='cancelled' WHERE id=994").run();
  assert.throws(() => archiveBatch(993), /send #997 is reconciling/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batch_archive_snapshots WHERE batch_id=993').get().n, 0);
});

test('batch archive preserves linked evidence, non-FK events, and fields missing from archive schemas', () => {
  db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (994,'Related record fixture','test','open')").run();
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (994,'Completed sequence','completed')").run();
  db.prepare(`INSERT INTO leads(id,batch_id,business_name,status,screenshot_path) VALUES
    (998,994,'Email evidence','won',NULL),
    (999,994,'Completed enrollment','lost',NULL),
    (1000,994,'Custom field','disqualified',NULL),
    (1001,994,'List membership','sent',NULL),
    (1002,994,'Source provenance','won',NULL),
    (1003,994,'Send event','sent',NULL),
    (1004,994,'Uncopied lead field','won','private/screenshots/1004.png'),
    (1005,994,'Uncopied send field','lost',NULL),
    (1006,994,'Unrelated completed contact','won',NULL),
    (1008,994,'Custom foreign key','won',NULL),
    (1009,994,'JSON relation','won',NULL)`).run();
  db.prepare(`UPDATE leads SET contact_person_name='Jordan Example',confidence=82,
    site_reasons_json='["field-preservation"]',crm_remote_id='crm-1004',crm_synced_at='2026-10-12T00:00:00Z',
    crm_sync_status='synced' WHERE id=1004`).run();

  const leadEmailId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status)
    VALUES (998,'evidence@example.test','website','unknown')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO lead_email_source_evidence(lead_email_id,source_url,evidence_type)
    VALUES (?,'https://example.test/contact','website_html')`).run(leadEmailId);
  db.prepare("INSERT INTO events(id,lead_id,event_type,meta_json) VALUES (998,998,'reply','{}')").run();
  db.prepare("INSERT INTO campaign_enrollments(campaign_id,lead_id,status) VALUES (994,999,'completed')").run();
  db.prepare("INSERT INTO contact_field_definitions(id,name,field_key,field_type) VALUES (994,'Archive note','archive_note','text')").run();
  db.prepare("INSERT INTO lead_custom_field_values(lead_id,field_id,value_json) VALUES (1000,994,'\"keep me\"')").run();
  db.prepare("INSERT INTO contact_lists(id,name) VALUES (994,'Archive review list')").run();
  db.prepare("INSERT INTO contact_list_members(list_id,lead_id) VALUES (994,1001)").run();
  db.prepare("INSERT INTO lead_source_records(provider,external_id,lead_id,page_id,form_id) VALUES ('meta_lead_ads','archive-fixture-1002',1002,'page-fixture','form-fixture')").run();
  db.prepare("INSERT INTO sends(id,lead_id,status) VALUES (1003,1003,'sent'),(1005,1005,'sent')").run();
  db.prepare("INSERT INTO events(id,send_id,event_type,meta_json) VALUES (1003,1003,'delivered','{}')").run();
  db.prepare("UPDATE sends SET error_message='accepted by remote SMTP server' WHERE id=1005").run();
  db.exec('CREATE TABLE archive_relation_fk_probe (lead_reference INTEGER REFERENCES leads(id) ON DELETE CASCADE)');
  db.prepare('INSERT INTO archive_relation_fk_probe(lead_reference) VALUES (1008)').run();
  db.exec('CREATE TABLE archive_relation_json_probe (related_lead_ids_json TEXT)');
  db.prepare('INSERT INTO archive_relation_json_probe(related_lead_ids_json) VALUES (?)').run('[1009]');

  assert.throws(() => archiveBatch(994), /archive_relation_json_probe.*live reference/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE batch_id=994').get().n, 11);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batch_archive_snapshots WHERE batch_id=994').get().n, 0);
  assert.equal(db.prepare('SELECT related_lead_ids_json FROM archive_relation_json_probe').get().related_lead_ids_json, '[1009]');
  db.prepare('UPDATE archive_relation_json_probe SET related_lead_ids_json=?').run('[1009');
  assert.throws(() => archiveBatch(994), /malformed reference JSON/i);
  db.prepare('UPDATE archive_relation_json_probe SET related_lead_ids_json=?').run('[1009]');
  // Resolve only the synthetic undeclared relation after proving it blocks the
  // entire archive. Declared/legacy relations must all round-trip below.
  db.prepare('DELETE FROM archive_relation_json_probe').run();
  const result = archiveBatch(994);
  assert.equal(result.archivedLeads, 11);
  assert.equal(result.archivedSends, 2);
  assert.equal(db.prepare('SELECT id FROM leads_archive WHERE id=1006').get()?.id, 1006);
  assert.deepEqual(db.prepare('SELECT id FROM leads WHERE batch_id=994 ORDER BY id').all(), []);
  assert.equal(db.prepare('SELECT screenshot_path FROM leads_archive WHERE id=1004').get().screenshot_path,
    'private/screenshots/1004.png');
  assert.deepEqual(db.prepare(`SELECT contact_person_name,confidence,site_reasons_json,crm_remote_id,crm_synced_at,crm_sync_status
    FROM leads_archive WHERE id=1004`).get(), {
    contact_person_name: 'Jordan Example', confidence: 82, site_reasons_json: '["field-preservation"]',
    crm_remote_id: 'crm-1004', crm_synced_at: '2026-10-12T00:00:00Z', crm_sync_status: 'synced',
  });
  assert.equal(db.prepare('SELECT error_message FROM sends_archive WHERE id=1005').get().error_message,
    'accepted by remote SMTP server');
  assert.throws(() => archiveBatch(994), /active archive snapshot/i);
  const restored = restoreBatch(994);
  assert.equal(restored.restoredLeads, 11);
  assert.equal(restored.restoredSends, 2);
  assert.deepEqual(db.prepare('SELECT id FROM leads WHERE batch_id=994 ORDER BY id').all().map(row => row.id),
    [998, 999, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1008, 1009]);
  assert.equal(db.prepare('SELECT source_url FROM lead_email_source_evidence WHERE lead_email_id=?').get(leadEmailId).source_url,
    'https://example.test/contact');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events WHERE lead_id=998').get().count, 1);
  assert.equal(db.prepare("SELECT status FROM campaign_enrollments WHERE lead_id=999").get().status, 'completed');
  assert.equal(db.prepare('SELECT value_json FROM lead_custom_field_values WHERE lead_id=1000').get().value_json, '"keep me"');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_list_members WHERE lead_id=1001').get().count, 1);
  assert.equal(db.prepare('SELECT external_id FROM lead_source_records WHERE lead_id=1002').get().external_id, 'archive-fixture-1002');
  assert.equal(db.prepare('SELECT send_id FROM events WHERE id=1003').get().send_id, 1003,
    'a send with retained event history is never deleted');
  assert.equal(db.prepare('SELECT screenshot_path FROM leads WHERE id=1004').get().screenshot_path,
    'private/screenshots/1004.png');
  assert.deepEqual(db.prepare(`SELECT contact_person_name,confidence,site_reasons_json,crm_remote_id,crm_synced_at,crm_sync_status
    FROM leads WHERE id=1004`).get(), {
    contact_person_name: 'Jordan Example', confidence: 82, site_reasons_json: '["field-preservation"]',
    crm_remote_id: 'crm-1004', crm_synced_at: '2026-10-12T00:00:00Z', crm_sync_status: 'synced',
  });
  assert.equal(db.prepare('SELECT error_message FROM sends WHERE id=1005').get().error_message,
    'accepted by remote SMTP server');
  assert.equal(db.prepare('SELECT lead_reference FROM archive_relation_fk_probe').get().lead_reference, 1008);
  assert.deepEqual(db.prepare('SELECT * FROM archive_relation_json_probe').all(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batch_archive_snapshots WHERE batch_id=994 AND restored_at IS NOT NULL').get().n, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_email_source_evidence WHERE lead_email_id=?').get(leadEmailId).count, 1);
});

test('batch archive retains a sent record and contact while delayed delivery evidence references the send', () => {
  db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (996,'Delivery report archive fixture','test','open')").run();
  db.prepare("INSERT INTO campaigns(id,name,status) VALUES (996,'Delivery report campaign','completed')").run();
  db.prepare("INSERT INTO leads(id,batch_id,business_name,email,status) VALUES (1010,996,'Reported delivery','report@example.test','sent')").run();
  db.prepare("INSERT INTO mailboxes(id,email,domain) VALUES (996,'archive-sender@example.test','example.test')").run();
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,status,sent_at)
    VALUES (1010,1010,996,996,'sent',datetime('now'))`).run();
  db.prepare(`INSERT INTO delivery_reports(send_id,mailbox_id,source_uid_validity,source_uid,
      smtp_message_id,report_message_id,report_sender,recipient,action,status_code,diagnostic,
      authentication_status,fingerprint)
    VALUES (1010,996,'17',2,'<archive-message@example.test>','<dsn@example.test>','mailer-daemon@example.test',
      'report@example.test','delivered','2.0.0','','unverified',?)`).run('c'.repeat(64));

  assert.throws(() => archiveBatch(996), /delivery_reports.*delayed evidence/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads_archive WHERE id=1010').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends_archive WHERE id=1010').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batch_archive_snapshots WHERE batch_id=996').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM batches WHERE id=996').get().status, 'open');
  assert.equal(db.prepare('SELECT id FROM leads WHERE id=1010').get()?.id, 1010);
  assert.equal(db.prepare('SELECT id FROM sends WHERE id=1010').get()?.id, 1010);
  assert.equal(db.prepare('SELECT send_id FROM delivery_reports WHERE fingerprint=?').get('c'.repeat(64)).send_id, 1010);
});

test('archive transaction rolls back snapshots and closure if deleting a lead fails', () => {
  db.prepare("INSERT INTO batches(id,name,phase,status) VALUES (995,'Rollback fixture','test','open')").run();
  db.prepare("INSERT INTO leads(id,batch_id,business_name,status) VALUES (1007,995,'Rollback contact','won')").run();
  db.exec(`CREATE TRIGGER reject_archive_delete BEFORE DELETE ON leads WHEN OLD.id=1007
    BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END`);

  assert.throws(() => archiveBatch(995), /fixture delete failure/);
  assert.equal(db.prepare('SELECT id FROM leads WHERE id=1007').get()?.id, 1007);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads_archive WHERE id=1007').get().count, 0);
  assert.equal(db.prepare('SELECT status FROM batches WHERE id=995').get().status, 'open');
  db.exec('DROP TRIGGER reject_archive_delete');
});
