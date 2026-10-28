import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-combined-migration-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.sqlite');
const { initDb, closeDb } = await import('../pipeline/database.js');
after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);

test('an accepted version-seven database receives combined fields atomically without replaying old migrations', () => {
  let db = initDb();
  db.prepare("INSERT INTO leads(id,business_name,status) VALUES(41,'Synthetic preserved contact','verified')").run();
  const identity = db.prepare('SELECT identity FROM ai_spend_workspace').get().identity;
  closeDb();
  db = new Database(process.env.ODD_DB_PATH);
  db.exec(`DELETE FROM schema_migrations WHERE version=8;
    ALTER TABLE verification_jobs DROP COLUMN current_email;
    ALTER TABLE lead_search_jobs DROP COLUMN seed_lead_id;
    CREATE TRIGGER fail_combined_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=8
      BEGIN SELECT RAISE(ABORT,'synthetic combined migration interruption'); END;`);
  db.close();
  assert.throws(() => initDb(), /synthetic combined migration interruption/);
  closeDb();
  db = new Database(process.env.ODD_DB_PATH);
  assert.equal(hasColumn(db, 'verification_jobs', 'current_email'), false);
  assert.equal(hasColumn(db, 'lead_search_jobs', 'seed_lead_id'), false);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 7);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=41').get().status, 'verified');
  db.exec('DROP TRIGGER fail_combined_migration');
  db.close();
  db = initDb();
  assert.equal(hasColumn(db, 'verification_jobs', 'current_email'), true);
  assert.equal(hasColumn(db, 'lead_search_jobs', 'seed_lead_id'), true);
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 8);
  assert.equal(db.prepare('SELECT identity FROM ai_spend_workspace').get().identity, identity);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  closeDb();
  db = initDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=8').get().n, 1);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=41').get().status, 'verified');
});
