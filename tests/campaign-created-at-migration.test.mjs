import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-created-at-'));
const dbPath = path.join(directory, 'legacy.db');
process.env.ODD_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sequence_step INTEGER DEFAULT 1,
    template_ref TEXT
  );
  INSERT INTO campaigns(id,name) VALUES (41,'Historical campaign');
  CREATE TABLE leads_archive (
    id INTEGER PRIMARY KEY, batch_id INTEGER, business_name TEXT, category TEXT, address TEXT,
    city TEXT, state TEXT, country TEXT, phone TEXT, website_url TEXT, facebook_url TEXT,
    email TEXT, source TEXT, site_status TEXT, site_score INTEGER, site_reasons TEXT,
    fb_active INTEGER, status TEXT, disqualification_reason TEXT, rating REAL, reviews INTEGER,
    latitude REAL, longitude REAL, place_id TEXT, normalized_domain TEXT, normalized_phone TEXT,
    discovered_at TEXT, updated_at TEXT
  );
  INSERT INTO leads_archive(id,batch_id,business_name,status) VALUES (41,4,'Archived legacy contact','won');
  CREATE TABLE sends_archive (
    id INTEGER PRIMARY KEY, lead_id INTEGER, mailbox_id INTEGER, campaign_id INTEGER,
    personalization_id INTEGER, variant TEXT, subject_snapshot TEXT, body_snapshot TEXT,
    in_reply_to_message_id TEXT, scheduled_at TEXT, sent_at TEXT, status TEXT
  );
  INSERT INTO sends_archive(id,lead_id,status) VALUES (41,41,'sent');
`);
legacy.close();

const database = await import('../pipeline/database.js');
after(() => {
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('campaign timestamp migration preserves unknown history and timestamps future rows', () => {
  let db = database.initDb();
  const columns = db.prepare('PRAGMA table_info(campaigns)').all().map(column => column.name);
  assert.ok(columns.includes('created_at'), 'legacy campaign table gains the timestamp column');
  assert.ok(columns.includes('track_clicks'), 'legacy campaign table gains the opt-in click tracking setting');
  assert.equal(db.prepare('SELECT track_clicks FROM campaigns WHERE id=41').get().track_clicks, 0,
    'legacy campaigns remain opted out by default');
  assert.deepEqual(db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all(), [
    { version: 1, name: 'legacy-columns-and-send-constraints' },
    { version: 2, name: 'warmup-source-evidence-eligibility-lock' },
    { version: 3, name: 'campaign-enrollment-and-sender-preservation' },
    { version: 4, name: 'restorable-batch-archive-snapshots' },
    { version: 5, name: 'email-verification-audit-history' },
    { version: 6, name: 'native-warmup-account-observations' },
    { version: 7, name: 'bedrock-subject-polish-spend-admission' },
    { version: 8, name: 'combined-discovery-verification-reconciliation' },
  ], 'the completed reconciliation is recorded as a schema version');
  assert.equal(db.prepare('SELECT created_at FROM campaigns WHERE id=41').get().created_at, null,
    'migration does not invent a creation time for old campaigns');
  const leadArchiveColumns = new Set(db.prepare('PRAGMA table_info(leads_archive)').all().map(column => column.name));
  for (const column of ['contact_person_name', 'screenshot_path', 'site_checked_at', 'confidence',
    'site_reasons_json', 'crm_remote_id', 'crm_synced_at', 'crm_sync_status']) {
    assert.ok(leadArchiveColumns.has(column), `legacy contact archive gains ${column}`);
  }
  assert.ok(db.prepare('PRAGMA table_info(sends_archive)').all().some(column => column.name === 'error_message'),
    'legacy send archive gains the SMTP outcome field');
  assert.equal(db.prepare('SELECT business_name FROM leads_archive WHERE id=41').get().business_name,
    'Archived legacy contact', 'archive migration leaves existing snapshots intact');
  assert.equal(db.prepare('SELECT status FROM sends_archive WHERE id=41').get().status, 'sent',
    'send archive migration leaves existing transport records intact');

  const newId = Number(db.prepare('INSERT INTO campaigns(name) VALUES (?)').run('New campaign').lastInsertRowid);
  assert.equal(db.prepare('SELECT track_clicks FROM campaigns WHERE id=?').get(newId).track_clicks, 0,
    'new campaigns also keep click tracking off by default');
  const createdAt = db.prepare('SELECT created_at FROM campaigns WHERE id=?').get(newId).created_at;
  assert.equal(typeof createdAt, 'string');
  assert.ok(Number.isFinite(Date.parse(createdAt)), 'new legacy-database rows receive a parseable creation time');

  database.closeDb();
  db = database.initDb();
  assert.equal(db.prepare('SELECT created_at FROM campaigns WHERE id=41').get().created_at, null,
    'reopening keeps historical timestamps unknown');
  assert.equal(db.prepare('SELECT created_at FROM campaigns WHERE id=?').get(newId).created_at, createdAt,
    'reopening preserves the timestamp for new campaigns');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=1').get().count, 1,
    'reopening does not duplicate the migration record');
  assert.equal(db.prepare('SELECT business_name FROM leads_archive WHERE id=41').get().business_name,
    'Archived legacy contact', 'reopen retains the migrated contact snapshot');
});

test('a failed migration rolls back its schema changes and reports the actual failure', () => {
  const brokenPath = path.join(directory, 'rollback.db');
  const broken = new Database(brokenPath);
  broken.exec(`
    CREATE TABLE campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sequence_step INTEGER DEFAULT 1,
      template_ref TEXT
    );
    INSERT INTO campaigns(name) VALUES ('Legacy campaign');
    CREATE TABLE sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      campaign_step_id INTEGER,
      status TEXT
    );
    INSERT INTO sends(lead_id,campaign_step_id,status) VALUES (5,7,'scheduled'),(5,7,'sent');
  `);
  broken.close();

  const moduleUrl = pathToFileURL(path.resolve('pipeline/database.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { initDb } from ${JSON.stringify(moduleUrl)}; initDb();`], {
    encoding: 'utf8',
    env: { ...process.env, ODD_DB_PATH: brokenPath, NODE_ENV: 'test' },
  });
  assert.notEqual(child.status, 0, 'a failed schema migration must stop startup');
  assert.match(child.stderr, /UNIQUE constraint failed/i, 'the underlying migration failure is visible');

  const check = new Database(brokenPath, { readonly: true });
  try {
    assert.equal(check.prepare('PRAGMA table_info(campaigns)').all().some(column => column.name === 'created_at'), false,
      'the earlier timestamp ALTER is rolled back with the later failed index migration');
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0,
      'the version ledger remains empty instead of claiming a partial migration');
  } finally { check.close(); }
});
