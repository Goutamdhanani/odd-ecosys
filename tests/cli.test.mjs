import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-cli-'));
const dbPath = path.join(directory, 'fixture.db');
const packageManifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
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
test('pipeline package scripts point to supported CLI commands', () => {
  const expected = {
    'pipeline:discover': 'node pipeline/cli.js discover',
    'pipeline:import': 'node pipeline/cli.js import',
    'pipeline:seed': 'node pipeline/cli.js seed',
    'pipeline:batches': 'node pipeline/cli.js batch-status',
    'pipeline:stats': 'node pipeline/cli.js stats',
    'pipeline:template': 'node pipeline/cli.js template',
    'pipeline:help': 'node pipeline/cli.js help',
  };
  const actual = Object.fromEntries(Object.entries(packageManifest.scripts).filter(([name]) => name.startsWith('pipeline:')));
  assert.deepEqual(actual, expected);
});
test('invalid command arguments fail before creating a database', () => {
  const cases = [
    [['import'], /--csv required/],
    [['discover', '--niche', 'dentists'], /--niche and --geo required/],
    [['reply'], /--from email required/],
    [['suppress'], /--email required/],
    [['archive-batch'], /--batch-id must be a positive integer/],
    [['archive-batch', '--batch-id', 'nope'], /--batch-id must be a positive integer/],
    [['template'], /--output required/],
  ];
  cases.forEach(([args, expectedError], index) => {
    const isolatedPath = path.join(directory, `invalid-${index}.db`);
    const result = cli(args, { ODD_DB_PATH: isolatedPath });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, expectedError);
    assert.equal(existsSync(isolatedPath), false, `${args[0]} should reject before DB initialization`);
  });
});
test('lead discovery refuses the unofficial Google Maps scraper without creating a database', () => {
  const discoveryDbPath = path.join(directory, 'discovery-safety.db');
  const result = cli(['discover', '--niche', 'dentists', '--geo', 'Pune'], { ODD_DB_PATH: discoveryDbPath });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Automated Google Maps scraping is disabled/);
  assert.match(result.stderr, /authorized to use/);
  assert.equal(existsSync(discoveryDbPath), false);
});
test('legacy scraper exports fail closed before attempting Docker or writing results', async () => {
  const {
    GOOGLE_MAPS_SCRAPER_DISABLED,
    runScraper,
    scrapeGoogleMapsNative,
    scrapeWebQueryLeads,
    scrapeFacebookLeads,
    scrapeLeadsMultiMethod,
    ensureDockerImage,
    isDockerAvailable,
  } = await import('../pipeline/scraper.js');
  await assert.rejects(runScraper(path.join(directory, 'unused-query.txt')), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
  await assert.rejects(scrapeGoogleMapsNative('dentists in Ontario'), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
  await assert.rejects(scrapeWebQueryLeads('dentists', 'Ontario'), /Search-engine result scraping is disabled/);
  await assert.rejects(scrapeFacebookLeads('dentists', 'Ontario'), /Automated Facebook scraping is disabled/);
  await assert.rejects(scrapeLeadsMultiMethod({ niche: 'dentists', geography: 'Ontario' }), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
  await assert.rejects(ensureDockerImage(), new RegExp(GOOGLE_MAPS_SCRAPER_DISABLED));
  assert.equal(await isDockerAvailable(), false);
  assert.equal(existsSync(path.join(directory, 'unused-query.txt')), false);
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
