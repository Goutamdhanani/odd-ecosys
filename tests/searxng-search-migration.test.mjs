import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-searxng-seed-migration-'));
process.env.ODD_DB_PATH = path.join(directory, 'legacy-search.db');
process.env.NODE_ENV = 'test';

const { closeDb, initDb } = await import('../pipeline/database.js');

after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('existing search history is preserved while the seed-contact column is migrated in place', () => {
  const legacy = initDb();
  const batchId = Number(legacy.prepare("INSERT INTO batches(name,phase,status) VALUES ('Legacy search','discovery','open')").run().lastInsertRowid);
  const jobId = Number(legacy.prepare("INSERT INTO lead_search_jobs(batch_id,provider,query,status) VALUES(?,'searxng','legacy saved query','completed')")
    .run(batchId).lastInsertRowid);
  assert.ok(legacy.prepare('PRAGMA table_info(lead_search_jobs)').all().some(column => column.name === 'seed_lead_id'));

  legacy.exec('ALTER TABLE lead_search_jobs DROP COLUMN seed_lead_id; DELETE FROM schema_migrations WHERE version=8');
  closeDb();
  const upgraded = initDb();

  const columns = upgraded.prepare('PRAGMA table_info(lead_search_jobs)').all();
  assert.ok(columns.some(column => column.name === 'seed_lead_id'), 'migration adds the nullable provenance field');
  assert.deepEqual(upgraded.prepare('SELECT id,batch_id,query,status,seed_lead_id FROM lead_search_jobs WHERE id=?').get(jobId), {
    id: jobId, batch_id: batchId, query: 'legacy saved query', status: 'completed', seed_lead_id: null,
  });
});
