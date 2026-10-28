import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const LABEL = 'gateway-telemetry-r34';
const TARGET = '.runner/astra-qa/gateway-telemetry-r34/pg.json';
const APPROVAL = '.superpowers/astra-gateway-fixture/ROOT_MIGRATION_APPROVAL.json';
const MANIFEST = 'orchestration/astra-phase2-source-r20a.json';
const MANIFEST_SHA256 = '62e439258b020610142460bb210e888f0d37c93dc0e0968d857eb19e1849d7c1';
const BIN = '/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/postgresql/16/bin';
const LIB = '/var/tmp/odd-astra-preview-pg16-tools/root/usr/lib/x86_64-linux-gnu';
const RESERVED_PORTS = new Set([56645, 51643, 3212, 8081]);
const ACL_HELPER = '.superpowers/astra-gateway-fixture/private-acl.ps1';
const ACL_HELPER_SHA256 = '2cddcdc81c7deb8ce227e040531bbdaf4ed6dba9487b9b9258ab75ad0bb73b39';
const CLUSTER_INSPECTOR = '.superpowers/astra-gateway-fixture/inspect_cluster.py';
const CLUSTER_INSPECTOR_SHA256 = 'd9307a82387395d1579f21667737370efd42758f720a3f2a4a78d0cc28c2f98a';
const UP_HASHES = Object.freeze([
  ['001-tenant-foundation.up.sql', '327e3c8e5e0dbaf083461985c44b233fc994db5c51731878f7fe8493cc82e38b'],
  ['002-ledger.up.sql', '6c2c20f167070bd819740a74eeb1f12d12594e1179a368e2a88f5e62f9ff3575'],
  ['003-workflow.up.sql', 'bc17f70789c297c20130de9f5c5558221ed13f962d58bf2838ae62a49f4680c3'],
  ['004-gateway.up.sql', '26003482360b07d3e568c3e89096cdf4e8e0f1591716953c6be3d587c7168c91'],
  ['005-research.up.sql', '37a3e778a201140719e54253a65af9321ff2199ef7802085d62f67d6f954bb24'],
  ['006-inbox-permissions.up.sql', '8992d70731aced726405af3bbf14e39b1fba7a604b70d285b3b0c82e36bd73d4'],
  ['007-campaigns.up.sql', '1fb9211bd8d5b81f4b20b4e2b09862fcc0c7b99164ab0ffedf3a87f84c1c59bf'],
  ['008-insights.up.sql', '689a812409610822331ea21721b12e735b2c5ae9e1016f3dc1bbb9691e062815'],
  ['009-runtime.up.sql', 'aff468c35dd05484ee849e8aa881084ddb175b20f45902d8a2bbcc948653a958'],
  ['010-connectors.up.sql', '2b218fcb2f834f7aa797b2a680268789412959dbf0cf274083543bc1e26e04c8'],
  ['011-generation.up.sql', '71bc191858ff99ef3a40d4c65fbc37239c6dfb54b2d0e70a088feb5346dfc53e'],
  ['012-autonomy.up.sql', 'f7cbe26de1e4811fb00ca19fd8bffe8f79edc19ffc224cb4c912355516d5503f'],
  ['013-evaluation.up.sql', 'c43b3a94188cbd39e972434454303796057a1e0f18417eeef8117657b0b3d1e5'],
  ['014-lifecycle.up.sql', '858ba8944ef6a64247858b33029c7f8ef9b11adbec82d26cd471ba1e5757b509'],
  ['015-operations.up.sql', '30dafb540b05ee76c1c48b967e67bfa6692b65ba7a66b04a232c1e9842fb268b'],
  ['016-radar.up.sql', '466b31b11c8b8e0eab3c30c43443a26489eae460dccd4be4e27db969e09438a1'],
  ['017-learning.up.sql', '4efb51a12b2a92cb375de90273f909f4a5e303e13a67806454056d5bbc297857'],
  ['018-economics-postsale.up.sql', '8f512e5b7820974fe183049b361bc594db01db96b17c6847a44e72d1a388f1b9'],
  ['019-launch-controls.up.sql', '7d8cfc7a6e3fc7999b7de4abedb40e4c80785797729e49869a0c9fabfe62738a'],
  ['020-conformance.up.sql', '0ac13d1977a943379969c1bc550526484593149e5439222dd4f8dc4430c5974f'],
  ['021-bandits.up.sql', 'a2992ff62387fce066c77b00e2f60c852271e72c71bb7fc853d18974698ee8b3'],
  ['022-memberships.up.sql', '8913c0c497e45ec75b8ab393e92947187308062bb52c436988d1235aa96e7faf'],
  ['023-customer-approvals.up.sql', 'bad23d26f2082b947ef285924caa97996b23fd3ea60754b840a30d2ce93b00bd'],
  ['024-domain-harness.up.sql', '2694bd7dd63667f3ca3d360c1fedd223562ba2d379c0a6292ab208acfdff18fd'],
  ['025-source-collection.up.sql', '1f9ea957db2faf1b65060b31b89af2aa49490aab8f9836b1c1c72c3ab838f076'],
  ['026-smtp-dispatch.up.sql', 'dc84e1a720e213f1e37367298f58ae04682fefb9470d2839debbc4b37a1a3383'],
  ['027-release-evidence.up.sql', '1ccd7dd355d86aa249182f01510eba07122f2838b05a5a273f4ec697e3a18ad1'],
  ['028-benchmark.up.sql', '7f7a383dac89e51eec75496107664eb49003e1f0089fca7377236f095539ec3a'],
  ['029-optimizer-execution.up.sql', 'ac9078cf8691c0812eec1e73bc2ab654cab1ae9304dfae4e46a4bc0c7f55cb29'],
  ['030-membership-hardening.up.sql', 'b6a5029c6c2cdd6c9b4c675553c6e8d8142d6d4ae3cac787db29c7b97eb43246'],
  ['031-research-idempotency.up.sql', 'd6601d42cd01f2c7e2d690bc03b660cfab2f828ad5f8516d0eb17d781263d76c'],
  ['032-workspace-discovery.up.sql', '547fec6287dc993097ff1e6faa999e925f1b1361b34d4c472f0624e0f0e6dd44'],
  ['033-source-rights-revocations.up.sql', '3f03c37ad0950260fa30f900de48061da45165a814e2ffce420ac13678850288'],
]);
const MIGRATION_034 = '034-freeinference-telemetry.up.sql';
const EXPECTED_KEYS = [
  'binary', 'clusterFixture', 'connectionString', 'contextSecret', 'databaseName', 'expectedMigrations',
  'label', 'libraryPath', 'migrations', 'mode', 'port', 'realData', 'roleChecks', 'serviceState', 'state', 'workerConnectionString',
].sort();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const normalized = value => {
  const result = path.normalize(process.platform === 'win32' ? value.replace(/^\\\\\?\\/, '') : value);
  return process.platform === 'win32' ? result.toLowerCase() : result;
};

/** Pure check over an ancestor walk; entries stop at the nearest missing component. */
export function validatePathEvidence({ target, entries, allowMissing = false, expectedType = undefined }) {
  assert.ok(Array.isArray(entries) && entries.length > 0, 'path ancestor evidence is required');
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.missing) {
      assert.equal(allowMissing, true, 'missing path component is not allowed');
      assert.equal(index, entries.length - 1, 'ancestor walk must stop at the nearest missing component');
      assert.equal(path.relative(entry.path, target).startsWith('..'), false, 'missing path must be below its nearest existing ancestor');
      continue;
    }
    assert.equal(entry.isLink, false, 'path component must not be a symlink or junction');
    assert.equal(normalized(entry.realPath), normalized(entry.path), 'path component must resolve to its canonical location');
    if (index < entries.length - 1) assert.equal(entry.isDirectory, true, 'path ancestor must be a directory');
  }
  const finalEntry = entries.at(-1);
  if (!finalEntry.missing) assert.equal(normalized(finalEntry.path), normalized(target), 'path walk must reach its exact target');
  if (!finalEntry.missing && expectedType === 'file') assert.equal(finalEntry.isFile, true, 'path target must be a regular file');
  if (!finalEntry.missing && expectedType === 'directory') assert.equal(finalEntry.isDirectory, true, 'path target must be a directory');
  return true;
}

async function collectPathEvidence(target, allowMissing = false) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  const entries = [];
  let current = root;
  const rootInfo = await lstat(current);
  entries.push({ path: current, realPath: await realpath(current), isLink: rootInfo.isSymbolicLink(), isDirectory: rootInfo.isDirectory() });
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') {
        entries.push({ path: current, missing: true });
        break;
      }
      throw error;
    }
    entries.push({ path: current, realPath: await realpath(current), isLink: info.isSymbolicLink(),
      isDirectory: info.isDirectory(), isFile: info.isFile() });
  }
  validatePathEvidence({ target: absolute, entries, allowMissing });
  return entries;
}

async function canonicalContainedPath(root, relative, { allowMissing = false, expectedType = undefined } = {}) {
  const repo = path.resolve(root);
  const target = path.resolve(repo, relative);
  const repoEntries = await collectPathEvidence(repo);
  validatePathEvidence({ target: repo, entries: repoEntries });
  const rel = path.relative(repo, target);
  assert.equal(path.isAbsolute(rel), false, 'path must be repository relative');
  assert.ok(rel !== '..' && !rel.startsWith(`..${path.sep}`), 'path must remain inside the repository');
  const targetEntries = await collectPathEvidence(target, allowMissing);
  validatePathEvidence({ target, entries: targetEntries, allowMissing, expectedType });
  return target;
}

export function validatePrivateProtectionReport(report) {
  assert.ok(report && typeof report === 'object', 'private ACL report is required');
  assert.deepEqual(Object.keys(report).sort(), ['noInheritance', 'ok', 'ownerOnly', 'protected', 'ruleCount', 'systemOnly'].sort(),
    'private ACL report must contain only safe status fields');
  assert.equal(report.ok, true, 'private ACL must be enforced');
  assert.equal(report.protected, true, 'private DACL must block inheritance');
  assert.equal(report.ownerOnly, true, 'private ACL must be restricted to the current owner');
  assert.equal(report.systemOnly, true, 'private ACL must retain SYSTEM access');
  assert.equal(report.noInheritance, true, 'private ACL must contain no inherited entries');
  assert.equal(report.ruleCount, 2, 'private DACL must contain exactly owner and SYSTEM entries');
  return true;
}

export function validatePosixPrivateProtection({ mode, uid, expectedUid, expectedMode = 0o700 }) {
  assert.equal(uid, expectedUid, 'private POSIX object must belong to the current owner');
  assert.equal(mode, expectedMode, 'private POSIX permissions must be exact');
  return true;
}

export function validateAcceptedHost(hostname, literalHost = hostname) {
  assert.equal(hostname, '127.0.0.1', 'fixture URL must use the emitted literal loopback address');
  assert.equal(literalHost, '127.0.0.1', 'fixture URL authority must contain the exact literal host');
  return true;
}

export function validateClusterInspection(report) {
  assert.deepEqual(Object.keys(report || {}).sort(), [
    'canonical', 'clusterOwnerUid', 'dataOwnerUid', 'noSymlinks', 'ok', 'pgVersion16',
  ].sort(), 'cluster inspector must return only safe status fields');
  assert.equal(report.ok, true, 'cluster metadata must resolve to a real fixture');
  assert.equal(report.canonical, true, 'cluster path must be canonical under /var/tmp');
  assert.equal(report.noSymlinks, true, 'cluster path components must not contain links');
  assert.equal(report.clusterOwnerUid, 65534, 'cluster must be owned by nobody');
  assert.equal(report.dataOwnerUid, 65534, 'PGDATA must be owned by nobody');
  assert.equal(report.pgVersion16, true, 'cluster must contain PostgreSQL 16 data');
  return true;
}

function commandPath(pathname) {
  if (process.platform === 'win32') return pathname;
  return execFileSync('wslpath', ['-w', pathname], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
}

async function inspectWindowsAcl(repo, target, kind) {
  const helper = await canonicalContainedPath(repo, ACL_HELPER, { expectedType: 'file' });
  const bytes = await readFile(helper);
  assert.equal(hash(bytes), ACL_HELPER_SHA256, 'trusted ACL helper changed');
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', commandPath(helper),
    '-Operation', kind === 'directory' ? 'InspectDirectory' : 'InspectFile', '-Path', commandPath(target),
  ], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const report = JSON.parse(output);
  validatePrivateProtectionReport(report);
}

function drvfsPath(repo) {
  if (process.platform === 'win32') return true;
  if (process.platform !== 'linux') return false;
  try {
    const mounts = readFileSync('/proc/mounts', 'utf8');
    const escaped = path.resolve(repo).replaceAll(' ', '\\040');
    const candidates = mounts.split('\n').map(line => line.split(' ')).filter(parts => parts.length >= 3
      && (escaped === parts[1] || escaped.startsWith(parts[1].replaceAll('\\040', ' ') + '/')))
      .sort((a, b) => b[1].length - a[1].length);
    return ['9p', 'drvfs', 'ntfs', 'ntfs3', 'fuseblk'].includes(candidates[0]?.[2]);
  } catch {
    return false;
  }
}

async function enforcePrivateMetadata(repo, directory, file) {
  if (drvfsPath(repo)) {
    await inspectWindowsAcl(repo, directory, 'directory');
    await inspectWindowsAcl(repo, file, 'file');
    return;
  }
  const owner = process.geteuid?.();
  assert.equal(typeof owner, 'number', 'POSIX owner identity must be available');
  for (const [target, expectedMode] of [[directory, 0o700], [file, 0o600]]) {
    const info = await lstat(target);
    assert.equal(info.isSymbolicLink(), false, 'private object must not be a link');
    validatePosixPrivateProtection({ mode: info.mode & 0o7777, uid: info.uid, expectedUid: owner, expectedMode });
  }
}

async function inspectClusterReadonly(repo, clusterPath) {
  assert.match(clusterPath || '', /^\/var\/tmp\/odd-astra-gateway34-[A-Za-z0-9_-]+$/);
  const helper = await canonicalContainedPath(repo, CLUSTER_INSPECTOR, { expectedType: 'file' });
  const bytes = await readFile(helper);
  assert.equal(hash(bytes), CLUSTER_INSPECTOR_SHA256, 'trusted cluster inspector changed');
  let executable = 'python3';
  let args = [helper, clusterPath];
  if (process.platform === 'win32') {
    executable = 'wsl.exe';
    const wslHelper = process.platform === 'win32'
      ? '/mnt/c/Users/pooja/.codex/worktrees/astra-foundation/odd-ecosys/.superpowers/astra-gateway-fixture/inspect_cluster.py'
      : helper;
    args = ['-d', 'Ubuntu-24.04', '--', 'python3', wslHelper, clusterPath];
  }
  const output = execFileSync(executable, args, { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  validateClusterInspection(JSON.parse(output));
}

function verifyMigrationList(value, approved034Sha256) {
  assert.equal(Array.isArray(value), true, 'migration manifest must be explicit');
  assert.equal(value.length, 34, 'fixture must contain exactly migrations 001 through 034');
  for (let index = 0; index < UP_HASHES.length; index += 1) {
    assert.deepEqual(value[index], { file: UP_HASHES[index][0], sha256: UP_HASHES[index][1] },
      `migration ${index + 1} must match the accepted R20 fixture pin`);
  }
  assert.deepEqual(value[33], { file: MIGRATION_034, sha256: approved034Sha256 },
    'migration 034 must match the independently approved digest');
}

/** Accept only the root-approved canonical 34-migration synthetic fixture. */
export async function validateAstraGatewayR34Fixture({ root, fixturePath, approved034Sha256 }) {
  assert.match(String(approved034Sha256 || ''), /^[a-f0-9]{64}$/i, 'root-approved migration 034 digest is required');
  const requestedRepo = path.resolve(root);
  const repo = await realpath(requestedRepo);
  assert.equal(normalized(repo), normalized(requestedRepo), 'workspace path must be canonical, without aliases');
  await collectPathEvidence(repo);
  const expectedFixture = path.resolve(repo, TARGET);
  assert.equal(path.resolve(fixturePath), expectedFixture, 'only the canonical gateway fixture path is accepted');
  const canonical = await canonicalContainedPath(repo, TARGET, { expectedType: 'file' });
  assert.equal(normalized(await realpath(canonical)), normalized(expectedFixture), 'fixture path must resolve to its canonical location');
  const fixtureDirectory = path.dirname(canonical);
  await enforcePrivateMetadata(repo, fixtureDirectory, canonical);

  const approvalPath = await canonicalContainedPath(repo, APPROVAL, { expectedType: 'file' });
  const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  assert.deepEqual(Object.keys(approval).sort(), [
    'decision', 'independentReviewPath', 'independentReviewSha256', 'migrationPath', 'sha256',
  ].sort(), 'migration approval must use the reviewed schema');
  assert.equal(approval.decision, 'APPROVED_FOR_SYNTHETIC_FIXTURE_ONLY');
  assert.equal(approval.migrationPath, `migrations/astra/${MIGRATION_034}`);
  assert.equal(String(approval.sha256).toLowerCase(), approved034Sha256.toLowerCase());
  assert.match(approval.independentReviewSha256 || '', /^[a-f0-9]{64}$/i);
  assert.equal(typeof approval.independentReviewPath, 'string');
  assert.ok(approval.independentReviewPath.startsWith('.superpowers/'));
  assert.notEqual(approval.independentReviewPath, APPROVAL, 'approval cannot review itself');
  const reviewPath = await canonicalContainedPath(repo, approval.independentReviewPath, { expectedType: 'file' });
  assert.equal(hash(await readFile(reviewPath)), approval.independentReviewSha256.toLowerCase(),
    'independent migration review artifact changed');

  const manifestPath = await canonicalContainedPath(repo, MANIFEST, { expectedType: 'file' });
  assert.equal(hash(await readFile(manifestPath)), MANIFEST_SHA256, 'accepted R20 manifest changed');
  const acceptedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(acceptedManifest.candidateId, 'astra-r20a-6440a954f59ed529');
  const manifestPins = new Map((acceptedManifest.files || []).map(item => [item.path, item.sha256]));

  const fixture = JSON.parse(await readFile(canonical, 'utf8'));
  assert.deepEqual(Object.keys(fixture).sort(), EXPECTED_KEYS, 'fixture must contain only approved metadata fields');
  assert.equal(fixture.label, LABEL);
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.realData, false);
  assert.equal(fixture.state, 'READY');
  assert.equal(fixture.serviceState, 'STOPPED', 'provisioning must leave the database stopped for bounded supervision');
  assert.equal(fixture.binary, BIN);
  assert.equal(fixture.libraryPath, LIB);
  assert.match(fixture.clusterFixture || '', /^\/var\/tmp\/odd-astra-gateway34-[A-Za-z0-9_-]+$/);
  await inspectClusterReadonly(repo, fixture.clusterFixture);
  assert.ok(Number.isInteger(fixture.port) && fixture.port >= 1024 && fixture.port <= 65535);
  assert.equal(RESERVED_PORTS.has(fixture.port), false, 'fixture port must be isolated from protected services');
  assert.match(fixture.databaseName || '', /^odd_astra_gateway34_[a-f0-9]{8}$/);
  assert.match(fixture.contextSecret || '', /^[a-f0-9]{64}$/);

  const databaseSuffix = fixture.databaseName.slice('odd_astra_gateway34_'.length);
  const expectedRoles = [
    `astra_qa_app_gateway34_${databaseSuffix}`,
    `astra_qa_worker_gateway34_${databaseSuffix}`,
  ];
  const endpoints = [];
  const passwords = [];
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    let url;
    try {
      url = new URL(connectionString);
    } catch {
      assert.ok(false, 'fixture connection URL is invalid');
    }
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    const hostname = url.hostname.toLowerCase();
    const authority = String(connectionString).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1];
    assert.ok(authority, 'fixture connection URL must have an authority');
    const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
    const literalHost = hostAndPort.slice(0, hostAndPort.lastIndexOf(':'));
    validateAcceptedHost(hostname, literalHost);
    assert.equal(url.port, String(fixture.port));
    assert.equal(url.pathname.slice(1), fixture.databaseName);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.ok(url.password && /^[a-f0-9]{64}$/i.test(url.password),
      'fixture credentials must be private strong random values');
    endpoints.push({ port: url.port, database: url.pathname.slice(1) });
    passwords.push(url.password);
  }
  assert.deepEqual(endpoints[0], endpoints[1], 'app and worker must target the same fixture endpoint');
  assert.notEqual(passwords[0], passwords[1], 'app and worker credentials must differ');

  const parsedRoleNames = [
    new URL(fixture.connectionString).username,
    new URL(fixture.workerConnectionString).username,
  ];
  assert.deepEqual(parsedRoleNames, expectedRoles, 'connection URLs must identify the designated app and worker roles');
  assert.deepEqual(Object.keys(fixture.roleChecks || {}).sort(), expectedRoles.sort(), 'role verification must cover app and worker');
  const leastPrivilege = { superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false, login: true };
  for (const role of parsedRoleNames) {
    assert.deepEqual(fixture.roleChecks[role], leastPrivilege, 'fixture role flags must be least privilege');
  }

  verifyMigrationList(fixture.migrations, approved034Sha256.toLowerCase());
  verifyMigrationList(fixture.expectedMigrations, approved034Sha256.toLowerCase());
  for (const [filename, expectedHash] of UP_HASHES) {
    const relative = `migrations/astra/${filename}`;
    assert.equal(manifestPins.get(relative), expectedHash, `accepted manifest must pin ${filename}`);
    const migrationPath = await canonicalContainedPath(repo, `migrations/astra/${filename}`, { expectedType: 'file' });
    assert.equal(hash(await readFile(migrationPath)), expectedHash, `${filename} source hash changed`);
  }
  const migration034Path = await canonicalContainedPath(repo, `migrations/astra/${MIGRATION_034}`, { expectedType: 'file' });
  assert.equal(hash(await readFile(migration034Path)), approved034Sha256.toLowerCase(),
    'migration 034 source must match independent approval');
  return fixture;
}

export const astraGatewayR34UpHashes = Object.freeze(UP_HASHES.map(([, digest]) => digest));
