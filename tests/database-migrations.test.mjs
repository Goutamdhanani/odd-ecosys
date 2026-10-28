import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-db-migrations-'));
const databasePath = path.join(directory, 'legacy.db');
process.env.ODD_DB_PATH = databasePath;
const { closeDb, initDb } = await import('../pipeline/database.js');

after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

test('versioned migrations roll back atomically, preserve legacy relationships, and resume idempotently', () => {
  let db = initDb();
  const batchId = Number(db.prepare("INSERT INTO batches(name,phase) VALUES ('Migration fixture','test')").run().lastInsertRowid);
  const leadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,email,status,source_details,source_url)
    VALUES (?,'Migration contact','migration@example.test','queued','source note','https://source.example.test')`).run(batchId).lastInsertRowid);
  db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,source)
    VALUES (?,'migration@example.test','risky','fixture source')`).run(leadId);
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,active)
    VALUES (701,'migration-sender@example.test','example.test','eligible',25,1)`).run();
  db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_by,reviewed_at)
    VALUES (701,'approved','smtp-and-inbox-activity-v1','{"legacy":"kept"}',17,'2026-10-01T12:00:00.000Z')`).run();
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES ('Migration campaign','active')").run().lastInsertRowid);
  db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,campaign_id,status,sent_at)
    VALUES (702,?,701,?,'sent','2026-10-02T12:00:00.000Z')`).run(leadId, campaignId);
  db.prepare(`INSERT INTO events(lead_id,send_id,event_type,meta_json)
    VALUES (?,702,'sent','{"transport":"fixture"}')`).run(leadId);
  db.prepare(`INSERT INTO imap_sync_mailbox_state(mailbox_id,last_success_at,last_fetched)
    VALUES (701,'2026-10-03T12:00:00.000Z',4)`).run();
  closeDb();

  // Model a pre-ledger snapshot that lacks columns added by earlier releases.
  // A trigger injects a deterministic failure only after the migration has
  // issued its ALTER TABLE statements, testing SQLite's DDL rollback behavior.
  db = new Database(databasePath);
  db.exec(`
    ALTER TABLE imap_sync_mailbox_state DROP COLUMN last_fetched;
    DELETE FROM schema_migrations;
    CREATE TRIGGER fail_first_schema_version BEFORE INSERT ON schema_migrations
      WHEN NEW.version=1 BEGIN SELECT RAISE(ABORT,'fixture migration interruption'); END;
  `);
  db.close();

  assert.throws(() => initDb(), /fixture migration interruption/);
  closeDb();
  db = new Database(databasePath);
  assert.equal(columns(db, 'imap_sync_mailbox_state').has('last_fetched'), false,
    'an ALTER TABLE earlier in the failed version was rolled back');
  assert.ok(columns(db, 'leads').has('source_url'), 'existing schema and data are untouched by the failed version');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 0,
    'a failed version is not marked applied');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE id=702 AND status=\'sent\'').get().count, 1,
    'the existing send record remains intact after the failure');
  db.exec('DROP TRIGGER fail_first_schema_version');
  db.close();

  db = initDb();
  assert.deepEqual(db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(columns(db, 'batch_archive_snapshots').has('payload_json'));
  assert.ok(columns(db, 'imap_sync_mailbox_state').has('last_fetched'));
  assert.ok(columns(db, 'leads').has('source_url'));
  assert.deepEqual(db.prepare('SELECT batch_id,business_name,source_details,source_url FROM leads WHERE id=?').get(leadId), {
    batch_id: batchId,
    business_name: 'Migration contact',
    source_details: 'source note',
    source_url: 'https://source.example.test',
  });
  assert.equal(db.prepare('SELECT email,verification_status FROM lead_emails WHERE lead_id=?').get(leadId).email, 'migration@example.test');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE send_id=702 AND event_type='sent'").get().count, 1);
  assert.equal(db.prepare('SELECT last_fetched FROM imap_sync_mailbox_state WHERE mailbox_id=701').get().last_fetched, null);

  const mailbox = db.prepare('SELECT warmup_status,daily_limit FROM mailboxes WHERE id=701').get();
  assert.deepEqual(mailbox, { warmup_status: 'warming', daily_limit: 0 }, 'the legacy age-based approval remains safely blocked');
  assert.equal(db.prepare("SELECT evidence_json FROM mailbox_warmup_review_history WHERE mailbox_id=701 AND policy_version='smtp-and-inbox-activity-v1'").get().evidence_json, '{"legacy":"kept"}');
  assert.equal(db.prepare("SELECT decision FROM mailbox_warmup_reviews WHERE mailbox_id=701").get().decision, 'held');
  assert.equal(db.prepare('SELECT campaign_id,lead_id FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId).campaign_id, campaignId);
  assert.equal(db.prepare('SELECT campaign_id,mailbox_id FROM campaign_senders WHERE campaign_id=? AND mailbox_id=701').get(campaignId).mailbox_id, 701);
  closeDb();

  db = initDb();
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8],
    'repeat startup does not replay completed migrations');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mailbox_warmup_review_history WHERE mailbox_id=701').get().count, 2,
    'repeat startup does not duplicate review history');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId).count, 1);
  closeDb();
});

test('startup refuses a database schema version newer than this application', () => {
  let db = initDb();
  closeDb();
  db = new Database(databasePath);
  db.prepare("INSERT INTO schema_migrations(version,name) VALUES(99,'future fixture')").run();
  db.close();

  assert.throws(() => initDb(), /schema version 99 is newer than this application supports/);
  closeDb();
  db = new Database(databasePath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE id=702').get().count, 1,
    'unsupported-version refusal preserves existing application data');
  db.prepare('DELETE FROM schema_migrations WHERE version=99').run();
  db.prepare("UPDATE schema_migrations SET name='unexpected migration name' WHERE version=1").run();
  db.close();

  assert.throws(() => initDb(), /recorded as unexpected migration name, expected legacy-columns-and-send-constraints/);
  closeDb();
  db = new Database(databasePath);
  db.prepare("UPDATE schema_migrations SET name='legacy-columns-and-send-constraints' WHERE version=1").run();
  db.close();
});

test('base schema creation rolls back when a pre-existing object conflicts', () => {
  const conflictPath = path.join(directory, 'schema-conflict.db');
  const databaseModuleUrl = new URL('../pipeline/database.js', import.meta.url).href;
  const script = `
    import Database from 'better-sqlite3';
    const dbPath = process.env.ODD_DB_PATH;
    const seed = new Database(dbPath);
    seed.exec('CREATE VIEW leads AS SELECT 1 AS id');
    seed.close();
    const { initDb, closeDb } = await import(${JSON.stringify(databaseModuleUrl)});
    let failure;
    try { initDb(); } catch (error) { failure = error; }
    closeDb();
    const check = new Database(dbPath);
    const ledger = check.prepare("SELECT type FROM sqlite_master WHERE name='schema_migrations'").get();
    const batches = check.prepare("SELECT type FROM sqlite_master WHERE name='batches'").get();
    const leads = check.prepare("SELECT type FROM sqlite_master WHERE name='leads'").get();
    check.close();
    if (!failure || ledger || batches || leads?.type !== 'view') {
      console.error(JSON.stringify({ failure: failure?.message, ledger, leads, batches }));
      process.exitCode = 1;
    } else {
      console.log('base schema transaction rolled back');
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ODD_DB_PATH: conflictPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /base schema transaction rolled back/);
});

test('spend admission migration rolls back all new financial tables and resumes without changing legacy records or workspace identity', () => {
  const fixturePath = path.join(directory, 'spend-migration.db');
  const databaseModuleUrl = new URL('../pipeline/database.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import Database from 'better-sqlite3';
    const {initDb,closeDb}=await import(${JSON.stringify(databaseModuleUrl)});
    let db=initDb();
    db.prepare("INSERT INTO leads(business_name,status) VALUES('Synthetic preserved migration contact','verified')").run();
    closeDb();
    db=new Database(process.env.ODD_DB_PATH);
    db.exec("DELETE FROM schema_migrations WHERE version>=7; DROP TABLE ai_spend_intents; DROP TABLE ai_spend_current_policy; DROP TABLE ai_spend_approvals; DROP TABLE ai_spend_workspace;");
    db.exec("CREATE TRIGGER fail_spend_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=7 BEGIN SELECT RAISE(ABORT,'synthetic spend migration failure'); END;");
    db.close();
    assert.throws(()=>initDb(),/synthetic spend migration failure/); closeDb();
    db=new Database(process.env.ODD_DB_PATH);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'ai_spend_%'").get().n,0);
    assert.equal(db.prepare('SELECT MAX(version) n FROM schema_migrations').get().n,6);
    assert.equal(db.prepare('SELECT business_name FROM leads').get().business_name,'Synthetic preserved migration contact');
    db.exec('DROP TRIGGER fail_spend_migration'); db.close();
    db=initDb();
    const identity=db.prepare('SELECT identity FROM ai_spend_workspace').get().identity;
    assert.equal(db.prepare('SELECT MAX(version) n FROM schema_migrations').get().n,8);
    closeDb(); db=initDb();
    assert.equal(db.prepare('SELECT identity FROM ai_spend_workspace').get().identity,identity);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_spend_approvals').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_spend_intents').get().n,0);
    closeDb(); console.log('spend migration rollback and stable identity verified');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, ODD_DB_PATH: fixturePath }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /spend migration rollback and stable identity verified/);
});
