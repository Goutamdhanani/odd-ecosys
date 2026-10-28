import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-sequence-migration-'));
const dbPath = path.join(directory, 'legacy.db');
process.env.ODD_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, mailbox_id INTEGER,
    campaign_id INTEGER, personalization_id INTEGER, variant TEXT,
    scheduled_at TEXT, sent_at TEXT, status TEXT DEFAULT 'scheduled'
  );
  CREATE TABLE sends_archive (
    id INTEGER PRIMARY KEY, lead_id INTEGER, mailbox_id INTEGER,
    campaign_id INTEGER, personalization_id INTEGER, variant TEXT,
    scheduled_at TEXT, sent_at TEXT, status TEXT
  );
  CREATE TABLE campaign_enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
    source_list_id INTEGER, status TEXT NOT NULL DEFAULT 'active', enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(campaign_id, lead_id)
  );
`);
legacy.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,personalization_id,variant,scheduled_at,sent_at,status)
  VALUES (99,1,NULL,1,NULL,'A',datetime('now'),NULL,'scheduled')`).run();
legacy.close();

const { closeDb, initDb } = await import('../pipeline/database.js');
let db;
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('existing send tables migrate sequence snapshots before the per-step uniqueness index is created', () => {
  db = initDb();
  const sends = db.prepare('PRAGMA table_info(sends)').all().map(column => column.name);
  const archive = db.prepare('PRAGMA table_info(sends_archive)').all().map(column => column.name);
  const enrollments = db.prepare('PRAGMA table_info(campaign_enrollments)').all().map(column => column.name);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_launches'").get());
  assert.ok(sends.includes('campaign_launch_id'), 'legacy sends should gain a nullable link to immutable launch evidence');
  assert.ok(archive.includes('campaign_launch_id'), 'legacy archive should preserve campaign launch evidence');
  assert.equal(db.prepare('SELECT campaign_launch_id FROM sends WHERE id=99').get()?.campaign_launch_id ?? null, null,
    'pre-feature send history must remain unlinked rather than receive fabricated launch evidence');
  for (const column of ['campaign_step_id', 'subject_snapshot', 'body_snapshot', 'in_reply_to_message_id']) {
    assert.ok(sends.includes(column), `legacy sends should gain ${column}`);
    assert.ok(archive.includes(column), `legacy send archive should gain ${column}`);
  }
  assert.ok(enrollments.includes('defer_until'), 'legacy enrollments should gain a date-based OOO hold');
  assert.ok(enrollments.includes('defer_manual_review'), 'legacy enrollments should gain a manual OOO review hold');
  db.prepare('INSERT OR IGNORE INTO campaign_enrollments(campaign_id,lead_id) VALUES(1,1)').run();
  assert.equal(db.prepare('SELECT defer_manual_review FROM campaign_enrollments WHERE campaign_id=1 AND lead_id=1').get().defer_manual_review, 0);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sends_campaign_step_lead'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='campaign_launches_no_update'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='campaign_launches_no_delete'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='sends_launch_snapshot_immutable'").get());
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
