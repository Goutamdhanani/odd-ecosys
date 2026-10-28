import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const LABEL = 'r20-source-rights';
const MIGRATION_FILES = Object.freeze([
  '001-tenant-foundation.up.sql', '002-ledger.up.sql', '003-workflow.up.sql', '004-gateway.up.sql',
  '005-research.up.sql', '006-inbox-permissions.up.sql', '007-campaigns.up.sql', '008-insights.up.sql',
  '009-runtime.up.sql', '010-connectors.up.sql', '011-generation.up.sql', '012-autonomy.up.sql',
  '013-evaluation.up.sql', '014-lifecycle.up.sql', '015-operations.up.sql', '016-radar.up.sql',
  '017-learning.up.sql', '018-economics-postsale.up.sql', '019-launch-controls.up.sql', '020-conformance.up.sql',
  '021-bandits.up.sql', '022-memberships.up.sql', '023-customer-approvals.up.sql', '024-domain-harness.up.sql',
  '025-source-collection.up.sql', '026-smtp-dispatch.up.sql', '027-release-evidence.up.sql', '028-benchmark.up.sql',
  '029-optimizer-execution.up.sql', '030-membership-hardening.up.sql', '031-research-idempotency.up.sql',
  '032-workspace-discovery.up.sql', '033-source-rights-revocations.up.sql',
  '034-freeinference-telemetry.up.sql', '035-x14-execution-revocation.up.sql', '036-business-goal-runs.up.sql',
  '037-business-goal-planning-usage.up.sql',
]);
const UP_HASHES = Object.freeze([
  '327e3c8e5e0dbaf083461985c44b233fc994db5c51731878f7fe8493cc82e38b',
  '6c2c20f167070bd819740a74eeb1f12d12594e1179a368e2a88f5e62f9ff3575',
  'bc17f70789c297c20130de9f5c5558221ed13f962d58bf2838ae62a49f4680c3',
  '26003482360b07d3e568c3e89096cdf4e8e0f1591716953c6be3d587c7168c91',
  '37a3e778a201140719e54253a65af9321ff2199ef7802085d62f67d6f954bb24',
  '8992d70731aced726405af3bbf14e39b1fba7a604b70d285b3b0c82e36bd73d4',
  '1fb9211bd8d5b81f4b20b4e2b09862fcc0c7b99164ab0ffedf3a87f84c1c59bf',
  '689a812409610822331ea21721b12e735b2c5ae9e1016f3dc1bbb9691e062815',
  'aff468c35dd05484ee849e8aa881084ddb175b20f45902d8a2bbcc948653a958',
  '2b218fcb2f834f7aa797b2a680268789412959dbf0cf274083543bc1e26e04c8',
  '71bc191858ff99ef3a40d4c65fbc37239c6dfb54b2d0e70a088feb5346dfc53e',
  'f7cbe26de1e4811fb00ca19fd8bffe8f79edc19ffc224cb4c912355516d5503f',
  'c43b3a94188cbd39e972434454303796057a1e0f18417eeef8117657b0b3d1e5',
  '858ba8944ef6a64247858b33029c7f8ef9b11adbec82d26cd471ba1e5757b509',
  '30dafb540b05ee76c1c48b967e67bfa6692b65ba7a66b04a232c1e9842fb268b',
  '466b31b11c8b8e0eab3c30c43443a26489eae460dccd4be4e27db969e09438a1',
  '4efb51a12b2a92cb375de90273f909f4a5e303e13a67806454056d5bbc297857',
  '8f512e5b7820974fe183049b361bc594db01db96b17c6847a44e72d1a388f1b9',
  '7d8cfc7a6e3fc7999b7de4abedb40e4c80785797729e49869a0c9fabfe62738a',
  '0ac13d1977a943379969c1bc550526484593149e5439222dd4f8dc4430c5974f',
  'a2992ff62387fce066c77b00e2f60c852271e72c71bb7fc853d18974698ee8b3',
  '8913c0c497e45ec75b8ab393e92947187308062bb52c436988d1235aa96e7faf',
  'bad23d26f2082b947ef285924caa97996b23fd3ea60754b840a30d2ce93b00bd',
  '2694bd7dd63667f3ca3d360c1fedd223562ba2d379c0a6292ab208acfdff18fd',
  '1f9ea957db2faf1b65060b31b89af2aa49490aab8f9836b1c1c72c3ab838f076',
  'dc84e1a720e213f1e37367298f58ae04682fefb9470d2839debbc4b37a1a3383',
  '1ccd7dd355d86aa249182f01510eba07122f2838b05a5a273f4ec697e3a18ad1',
  '7f7a383dac89e51eec75496107664eb49003e1f0089fca7377236f095539ec3a',
  'ac9078cf8691c0812eec1e73bc2ab654cab1ae9304dfae4e46a4bc0c7f55cb29',
  'b6a5029c6c2cdd6c9b4c675553c6e8d8142d6d4ae3cac787db29c7b97eb43246',
  'd6601d42cd01f2c7e2d690bc03b660cfab2f828ad5f8516d0eb17d781263d76c',
  '547fec6287dc993097ff1e6faa999e925f1b1361b34d4c472f0624e0f0e6dd44',
  '3f03c37ad0950260fa30f900de48061da45165a814e2ffce420ac13678850288',
  '3f4dee260d8273bd4c92f758931c19cf9ae3ba9ee9f5a876c2202317d6a7e1b8',
  'd26216389dabe498970555c6fbc138fe5ebf6f187e9889f79f665f6a436c3b07',
  '0f789671a0c62e8258c89c1ef39d5a7ee8aba508d19e327ebb348e624cba18cf',
  '6ebce2d1a11c87029660bb0ab04552f2221d6adaf8dbe4bdd4a1a3d270996680',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Accept only the one canonical, loopback, synthetic 37-migration fixture. */
export async function validateAstraR20Fixture({ root, fixturePath }) {
  const repo = await realpath(root);
  const qaRoot = await realpath(path.join(repo, '.runner', 'astra-qa'));
  const canonical = await realpath(fixturePath);
  const relative = path.relative(qaRoot, canonical);
  assert.equal(path.isAbsolute(relative), false, 'fixture must be contained in the repository QA root');
  assert.equal(relative.split(path.sep).join('/'), `${LABEL}/pg.json`, 'only the canonical R20 named fixture is accepted');

  const fixture = JSON.parse(await readFile(canonical, 'utf8'));
  const fixtureKeys = Object.keys(fixture);
  assert.deepEqual(fixtureKeys.filter(key => key !== 'clockAlignmentMode').sort(), [
    'binary', 'clusterFixture', 'connectionString', 'contextSecret', 'databaseName', 'label', 'libraryPath',
    'mode', 'migrations', 'parentPreviewFixture', 'port', 'previewClockOffsetSeconds', 'realData', 'workerConnectionString',
  ].sort(), 'fixture must contain only the expected validator inputs');
  if (Object.hasOwn(fixture, 'clockAlignmentMode')) {
    assert.equal(fixture.clockAlignmentMode, 'monitored-disposable-process-only', 'clock alignment is diagnostic metadata with one known value');
  }
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.label, LABEL);
  assert.equal(fixture.realData, false);
  assert.ok(Number.isSafeInteger(fixture.previewClockOffsetSeconds)
    && fixture.previewClockOffsetSeconds >= -86400 && fixture.previewClockOffsetSeconds <= 86400,
  'clock offset metadata must be a safe integer from -86400 to 86400 seconds');
  assert.match(fixture.clusterFixture || '', /^\/var\/tmp\/odd-astra-qa-pg-[A-Za-z0-9_-]+$/, 'database must belong to the dedicated disposable QA cluster');
  assert.match(fixture.parentPreviewFixture || '', /^\/var\/tmp\/odd-astra-preview-pg-[A-Za-z0-9_-]+$/, 'parent must be the recognized synthetic preview cluster');
  assert.equal(fixture.binary, '/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin', 'migration binary must be the recognized synthetic PostgreSQL build');
  assert.match(fixture.libraryPath || '', /^\/var\/tmp\/odd-astra-preview-pg16-tools\/root\/usr\/lib\/[A-Za-z0-9_./-]+$/, 'library path must remain within the synthetic PostgreSQL bundle');
  assert.equal(fixture.libraryPath.includes('..'), false, 'library path cannot traverse outside the bundle');
  assert.ok(Number.isInteger(fixture.port) && fixture.port >= 1 && fixture.port <= 65535, 'fixture port must be explicit and valid');
  assert.match(fixture.databaseName || '', /^odd_astra_qa_r20_source_rights_[a-f0-9]{8}$/, 'fixture must use a freshly generated R20 database name');
  assert.ok(typeof fixture.contextSecret === 'string' && fixture.contextSecret.length >= 32);
  assert.equal(Array.isArray(fixture.migrations), true);
  assert.equal(fixture.migrations.length, UP_HASHES.length);
  const roleNames = [];
  const connectionParts = [];
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const url = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(hostname), 'fixture database must be loopback-only');
    assert.ok(url.username && url.password, 'fixture roles require credentials');
    assert.equal(url.port, String(fixture.port), 'connection port must match fixture metadata');
    assert.equal(decodeURIComponent(url.pathname.slice(1)), fixture.databaseName, 'connection database must match fixture metadata');
    assert.equal(url.search, '', 'connection URL must not include extra configuration');
    assert.equal(url.hash, '', 'connection URL must not include a fragment');
    roleNames.push(decodeURIComponent(url.username));
    connectionParts.push({ port: url.port, database: decodeURIComponent(url.pathname.slice(1)) });
  }
  assert.notEqual(roleNames[0], roleNames[1], 'application and worker roles must be distinct');
  const suffix = fixture.databaseName.match(/^odd_astra_qa_r20_source_rights_([a-f0-9]{8})$/)?.[1];
  assert.ok(suffix, 'fixture suffix is required');
  assert.equal(roleNames[0], `astra_qa_app_r20_source_rights_${suffix}`, 'first role must be the exact R20 application role');
  assert.equal(roleNames[1], `astra_qa_worker_r20_source_rights_${suffix}`, 'second role must be the exact R20 worker role');
  assert.deepEqual(connectionParts[0], connectionParts[1], 'app and worker URLs must target the same fixture endpoint');

  const migrationDir = path.join(repo, 'migrations', 'astra');
  for (let index = 0; index < UP_HASHES.length; index += 1) {
    const file = fixture.migrations[index]?.file;
    assert.equal(file, MIGRATION_FILES[index], `migration ${index + 1} must appear in canonical order`);
    assert.equal(String(fixture.migrations[index]?.sha256 || '').toLowerCase(), UP_HASHES[index], `migration ${index + 1} fixture hash must be pinned`);
    const migrationPath = path.resolve(migrationDir, file);
    assert.equal(path.dirname(migrationPath), migrationDir, 'migration path must stay in the Astra migration directory');
    assert.equal(hash(await readFile(migrationPath)), UP_HASHES[index], `migration ${index + 1} source hash drifted`);
  }
  return fixture;
}

export const astraR20UpHashes = UP_HASHES;
