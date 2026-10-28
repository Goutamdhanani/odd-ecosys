import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const R18_LABELS = new Set(['r18-suite', 'r18-customer-qa', 'r18-foundation']);
const LEGACY_LABELS = new Set([
  'p2-astra-ui-r7','p2-suite-r7','p2-migrations-r5','p2-provenance-r2','p2-suite-r4','p2-experiment-fix',
  'p2-provenance-fix-01','p2-suite-r3','p2-outcome-fix','p2-lifecycle-fix','p2-domain-fix-01','p2-rollback-fix',
  'p2-flow-r2','p2-unit-20261024','p2-routes-r5','p2-flow-20261024','p2-suite-r2','p2-suite-r7',
  'p2-customer-fix','p2-suite-r5','p2-astra-ui-r7','p2-suite-r6','p2-trust-r3','p2-bandits-fix',
  'p2-tenant-20261024','p2-coverage-r6','p2-tenant-r2','p2-benchmark-fix','p2-migrations-final',
  'p2-migrations-cycle-r5','p2-ops-r2','p2-member-fix-01','p2-workflow-fix'
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Validate a repository-owned synthetic fixture without ever exposing its private JSON. */
export async function validateAstraQaFixture({ root, fixturePath, labels = 'r18-suite', migrations = 32 }) {
  const repo = await realpath(root);
  const qaRoot = await realpath(path.join(repo, '.runner', 'astra-qa'));
  const canonical = await realpath(fixturePath);
  const relative = path.relative(qaRoot, canonical);
  const parts = relative.split(path.sep);
  assert.ok(!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..', 'fixture must stay under repository QA root');
  assert.equal(parts.length, 2, 'fixture must be below one QA label directory');
  assert.equal(parts[1], 'pg.json', 'fixture name must be pg.json');
  const label = parts[0];
  const allowed = labels === 'legacy31-or-r18' ? new Set([...LEGACY_LABELS, ...R18_LABELS]) : new Set(Array.isArray(labels) ? labels : [labels]);
  assert.ok(allowed.has(label), 'fixture label is not approved for this test');
  const expectedMigrations = migrations === 'legacy31-or-r18' ? (R18_LABELS.has(label) ? 32 : 31) : migrations;
  const fixture = JSON.parse(await readFile(canonical, 'utf8'));
  assert.equal(fixture.mode, 'disposable-synthetic-qa', 'fixture mode must be synthetic QA');
  assert.equal(fixture.label, label, 'fixture label must match its directory');
  assert.equal(fixture.realData, false, 'fixture must explicitly deny real data');
  assert.equal(Array.isArray(fixture.migrations), true, 'migration manifest required');
  assert.equal(fixture.migrations.length, expectedMigrations, 'fixture migration count is not approved');
  assert.ok(typeof fixture.contextSecret === 'string' && fixture.contextSecret.length >= 32, 'private test context is required');
  assert.ok(fixture.connectionString && fixture.workerConnectionString, 'application and worker connection strings are required');
  const roles = [];
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const url = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'fixture must use PostgreSQL');
    const rawHostname = url.hostname.toLowerCase();
    const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname;
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(hostname), 'fixture host must be loopback');
    assert.ok(url.username && url.password, 'fixture role credentials are required');
    roles.push(decodeURIComponent(url.username));
  }
  assert.notEqual(roles[0], roles[1], 'app and worker roles must be distinct');
  assert.match(roles[0], /app/i, 'first PostgreSQL identity must be the application role');
  assert.match(roles[1], /worker/i, 'second PostgreSQL identity must be the worker role');
  const migrationDir = path.join(repo, 'migrations', 'astra');
  for (let index = 0; index < expectedMigrations; index += 1) {
    const entry = fixture.migrations[index];
    assert.equal(entry?.file, `${String(index + 1).padStart(3, '0')}-${entry?.file?.slice(4).replace(/\.up\.sql$/, '')}.up.sql`, 'migration order/name must be canonical');
    assert.match(entry.sha256 || '', /^[a-f0-9]{64}$/i, 'recorded migration hash required');
    const migrationPath = path.resolve(migrationDir, entry.file);
    assert.equal(path.dirname(migrationPath), migrationDir, 'migration path must stay in repository migrations');
    assert.equal(sha(await readFile(migrationPath)), entry.sha256.toLowerCase(), 'recorded immutable migration hash mismatch');
  }
  if (R18_LABELS.has(label)) {
    assert.equal(fixture.migrations[31].file, '032-workspace-discovery.up.sql', 'R18 fixture must end at migration 032');
    assert.equal(fixture.migrations[31].sha256.toLowerCase(), '547fec6287dc993097ff1e6faa999e925f1b1361b34d4c472f0624e0f0e6dd44', 'R18 migration 032 UP hash is pinned');
  }
  return fixture;
}

export const r18QaLabels = Object.freeze([...R18_LABELS]);
