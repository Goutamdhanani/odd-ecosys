import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-cli-'));
const dbPath = path.join(directory, 'fixture.db');
after(() => rmSync(directory, { recursive: true, force: true }));
function cli(args, overrides = {}) {
  return spawnSync(process.execPath, ['pipeline/cli.js', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_ENV: 'test', ODD_DB_PATH: dbPath, ...overrides },
  });
}

test('B10: CLI help loads all ESM imports and does not create a database', () => {
  const result = cli(['help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ODD-ECOSYS Pipeline CLI/);
  assert.equal(existsSync(dbPath), false);
});
test('unknown commands and missing arguments exit unsuccessfully', () => {
  assert.equal(cli(['typo']).status, 1);
  assert.equal(cli(['import']).status, 1);
  assert.equal(cli(['template']).status, 1);
});
test('fixture seed is refused outside test environment without creating a DB', () => {
  const unsafePath = path.join(directory, 'must-not-create.db');
  const result = cli(['seed'], { NODE_ENV: 'production', ODD_DB_PATH: unsafePath });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Seed requires/);
  assert.equal(existsSync(unsafePath), false);
});
test('B11: template command produces parseable CSV', () => {
  const output = path.join(directory, 'template.csv');
  const result = cli(['template', '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /^business_name,category,/);
});
test('B11: CSV import persists a real batch; status and stats read the isolated DB', () => {
  const csv = path.join(directory, 'input.csv');
  writeFileSync(csv, 'business_name,email,website\nFixture Company,fixture@example.test,https://example.test\n');
  const result = cli(['import', '--csv', csv, '--batch-name', 'Fixture cohort', '--skip-enrichment']);
  assert.equal(result.status, 0, result.stderr);
  const db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 1);
    assert.equal(db.prepare('SELECT name FROM batches').get().name, 'Fixture cohort');
  } finally { db.close(); }
  const status = cli(['batch-status', '--batch-id', '1']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Fixture cohort/);
  assert.equal(cli(['stats']).status, 0);
  assert.equal(cli(['batch-status', '--batch-id', '99999']).status, 1);
});
test('B11: seed works only in an explicit separate fixture DB', () => {
  const seedPath = path.join(directory, 'seed.db');
  const result = cli(['seed'], { ODD_DB_PATH: seedPath });
  assert.equal(result.status, 0, result.stderr);
  const db = new Database(seedPath, { readonly: true });
  try { assert.ok(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n > 0); }
  finally { db.close(); }
});
