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
const { archiveBatch } = await import('../pipeline/archiver.js');

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
