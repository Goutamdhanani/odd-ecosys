import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const inventory = JSON.parse(readFileSync(path.join(root, 'docs/astra/s00-side-effect-inventory.json'), 'utf8'));
const historicalInventory = JSON.parse(readFileSync(path.join(root, '.superpowers/astra-live/metadata/before/s00-side-effect-inventory.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
function walk(relative) {
  return readdirSync(path.join(root, relative)).flatMap(name => {
    const child = path.join(relative, name);
    return statSync(path.join(root, child)).isDirectory() ? walk(child) : child.endsWith('.js') ? [child.replaceAll('\\', '/')] : [];
  });
}
const sideEffectPattern = /fetch|SMTP|IMAP|DNS|resolveMx|resolve4|resolve6|createConnection|createWriteStream|writeFile|spawn\(|http\.request\s*\(/i;
const clientNetworkPattern = /fetch\s*\(|XMLHttpRequest|WebSocket/;
function inventoryDifference(discovered, mapped) {
  const expected = new Set(mapped);
  return discovered.filter(file => !expected.has(file)).sort();
}

test('S00-B02: current detector adds real boundaries while preserving the original 48 paths and negative probe', () => {
  const discovered = walk('pipeline').filter(file => sideEffectPattern.test(readFileSync(path.join(root, file), 'utf8')));
  discovered.push(...walk('js').filter(file => clientNetworkPattern.test(readFileSync(path.join(root, file), 'utf8'))));
  discovered.push('server.js');
  const mapped = inventory.boundaries.map(row => row.path).sort();
  assert.deepEqual(inventoryDifference(discovered, mapped), [], 'adding an unreviewed boundary module must fail this inventory test');
  assert.deepEqual(inventoryDifference([...discovered, 'pipeline/new-provider-adapter.js'], mapped),
    ['pipeline/new-provider-adapter.js'], 'negative probe: a newly added boundary is detected without writing source');
  assert.equal(inventory.sourceFiles, inventory.boundaries.length);
  assert.equal(inventory.sourceFiles, discovered.length, 'the inventory count follows the current discovered boundary set');
  assert.equal(historicalInventory.sourceFiles, 48, 'the preserved before inventory records the original 48-boundary baseline');
  assert.equal(historicalInventory.boundaries.length, 48);
  assert.equal(inventory.historicalStaticDetectorBaseline.sourceFiles, 48);
  assert.equal(inventory.historicalStaticDetectorBaseline.preservedPathCount, 48);
  assert.equal(inventory.historicalStaticDetectorBaseline.inventorySha256, sha256(readFileSync(path.join(root,
    '.superpowers/astra-live/metadata/before/s00-side-effect-inventory.json'))));
  const historicalByPath = new Map(historicalInventory.boundaries.map(row => [row.path, row]));
  const currentByPath = new Map(inventory.boundaries.map(row => [row.path, row]));
  assert.deepEqual([...currentByPath.keys()].filter(file => historicalByPath.has(file)).sort(), [...historicalByPath.keys()].sort(),
    'all original static boundary paths remain present');
  assert.deepEqual([...currentByPath.keys()].filter(file => !historicalByPath.has(file)).sort(),
    ['pipeline/astra-freeinference-client.js', 'pipeline/astra-prospecting.js', 'pipeline/astra-local-search-transport.js'].sort(),
    'current detector findings include the reviewed provider, prospecting, and exact local-search transport boundaries');
  for (const [file, historical] of historicalByPath) {
    const current = currentByPath.get(file);
    const oldShape = structuredClone(historical); delete oldShape.sha256;
    const newShape = structuredClone(current); delete newShape.sha256; delete newShape.previousSha256;
    if (file === 'pipeline/astra-source-collection.js') {
      assert.deepEqual(newShape.testFiles.slice(0, oldShape.testFiles.length), oldShape.testFiles,
        'the current source-collection boundary retains every historical behavior-test mapping');
      assert.deepEqual(newShape.testFiles.slice(oldShape.testFiles.length), [
        'tests/astra-source-collection-policy.test.mjs',
        'tests/astra-local-search-transport.test.mjs',
      ], 'the local-search integration tests are added without replacing historical mappings');
      newShape.testFiles = oldShape.testFiles;
    }
    assert.deepEqual(newShape, oldShape, `${file} preserves its original effect, guards, and test mapping`);
    const actual = sha256(readFileSync(path.join(root, file)));
    assert.equal(current.sha256, actual, `${file} is fingerprinted to current bytes`);
    if (historical.sha256 !== actual) assert.equal(current.previousSha256, historical.sha256, `${file} retains its replaced historical hash`);
    else assert.equal(current.previousSha256, undefined, `${file} has no spurious prior hash`);
  }
  assert.ok(Array.isArray(inventory.retiredBoundaries), 'retired boundaries remain available as historical review evidence');
  assert.ok(inventory.retiredBoundaries.some(row => row.path === 'pipeline/personalizer.js'),
    'a formerly mapped provider boundary that no longer matches static markers remains visible in history');
  for (const row of inventory.boundaries) {
    assert.ok(row.effect, `${row.path} needs a plain-language side-effect description`);
    assert.ok(row.testFiles.length > 0, `${row.path} needs at least one existing behavior test`);
    if (row.path.startsWith('pipeline/astra-') || row.path === 'js/astra-workbench.js') {
      assert.ok(row.guardAndDestination?.guard && row.guardAndDestination?.destination && row.guardAndDestination?.authorization,
        `${row.path} needs its observed guard, destination, and approval status recorded`);
    }
    assert.equal(sha256(readFileSync(path.join(root, row.path))), row.sha256, `${row.path} changed and needs boundary inventory review`);
    for (const testFile of row.testFiles) assert.ok(readFileSync(path.join(root, testFile)), `${row.path} references a missing test ${testFile}`);
  }
  const providerBoundary = currentByPath.get('pipeline/astra-freeinference-client.js');
  assert.match(providerBoundary.guardAndDestination.guard, /FREEINFERENCE_API_KEY/);
  assert.match(providerBoundary.guardAndDestination.guard, /redirect:error/);
  assert.match(providerBoundary.guardAndDestination.destination, /freeinference\.org\/v1\/models/);
  assert.match(providerBoundary.guardAndDestination.authorization, /does not approve commercial use/);
  const prospectingBoundary = currentByPath.get('pipeline/astra-prospecting.js');
  assert.match(prospectingBoundary.effect, /never performs direct HTTP itself/);
  assert.match(prospectingBoundary.guardAndDestination.guard, /ASTRA_LIVE_PROSPECTING_GO=true/);
  assert.match(prospectingBoundary.guardAndDestination.guard, /owner-only start/);
  assert.match(prospectingBoundary.guardAndDestination.authorization, /does not activate prospecting/);
  const localSearchBoundary = currentByPath.get('pipeline/astra-local-search-transport.js');
  assert.ok(localSearchBoundary, 'the direct HTTP adapter is separately inventoried');
  assert.equal(localSearchBoundary.sha256, sha256(readFileSync(path.join(root, localSearchBoundary.path))));
  assert.deepEqual(localSearchBoundary.testFiles, [
    'tests/astra-local-search-transport.test.mjs',
    'tests/astra-source-collection-policy.test.mjs',
  ]);
  assert.match(localSearchBoundary.guardAndDestination.guard, /ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED=true/);
  assert.match(localSearchBoundary.guardAndDestination.guard, /S01/);
  assert.match(localSearchBoundary.guardAndDestination.guard, /request-admission/i);
  assert.match(localSearchBoundary.guardAndDestination.destination, /http:\/\/127\.0\.0\.1:8081\/search/);
  assert.match(localSearchBoundary.guardAndDestination.destination, /google cse/);
  const localSearchLimit = localSearchBoundary.guardAndDestination.authorization;
  assert.match(localSearchLimit, /synthetic loopback fixture acceptance did not contact the local service/i);
  assert.match(localSearchLimit, /actual-product-transport-probe\.json/);
  assert.match(localSearchLimit, /actual-service-evidence\/REPORT\.md/);
  assert.match(localSearchLimit, /one actual query, HTTP 200, 20 results, 1,394 ms/);
  assert.match(localSearchLimit, /does not establish S01\/source-policy execution/);
  assert.match(localSearchLimit, /source rights or terms/);
  assert.match(localSearchLimit, /engine-internal fan-out/);
  assert.doesNotMatch(localSearchLimit, /real service was not contacted/i,
    'the fixture call limitation must not be stated as a global no-service-call claim');
});

test('S00-B02 supplemental: current-proof database readers are separately mapped to hashes, tenant guards and behavior tests', () => {
  const expectedReads = {
    'pipeline/astra-current-claims.js': [
      'astra.research_claims',
      'astra.research_claim_corrections',
      'astra.research_evidence',
      'astra.research_sources',
    ],
    'pipeline/astra-campaign-audience.js': [
      'astra.campaigns',
      'astra.research_identity_candidates',
      'astra.research_evidence',
      'astra.research_sources',
      'astra.research_claims',
      'astra.research_claim_corrections',
    ],
    'pipeline/astra-mongo-store.js': [
      'prospecting_jobs', 'prospecting_events', 'prospecting_outcomes',
      'prospecting_source_evidence', 'prospecting_qualified_contacts', 'prospecting_idempotency_receipts',
    ],
    'pipeline/astra-source-collection.js': [
      'astra.source_collection_jobs', 'astra.source_collection_runs', 'astra.source_collection_candidates',
      'astra.source_collection_observations', 'astra.research_evidence', 'astra.research_sources',
      'astra.research_blobs', 'astra.research_accounts', 'astra.research_identity_candidates',
    ],
  };
  const rows = inventory.supplementalDatabaseReads;
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map(row => row.path).sort(), Object.keys(expectedReads).sort());
  for (const row of rows) {
    assert.deepEqual(row.reads, expectedReads[row.path], `${row.path} records the exact current database-read boundary`);
    assert.equal(sha256(readFileSync(path.join(root, row.path))), row.sha256, `${row.path} changed and needs supplemental inventory review`);
    assert.ok(row.effect, `${row.path} needs a plain-language read effect`);
    assert.ok(row.guardAndDestination?.guard && row.guardAndDestination?.destination && row.guardAndDestination?.authorization,
      `${row.path} needs its observed guard, destination and authorization status recorded`);
    if (['pipeline/astra-current-claims.js', 'pipeline/astra-campaign-audience.js'].includes(row.path)) {
      assert.ok(row.testFiles.includes('tests/astra-qualification-lineage.test.mjs'));
      assert.ok(row.testFiles.includes('tests/astra-audience-consumers.test.mjs'));
      assert.ok(row.testFiles.includes('tests/astra-source-rights-consumers.test.mjs'));
    } else {
      assert.deepEqual(row.testFiles, row.path === 'pipeline/astra-mongo-store.js'
        ? ['tests/astra-mongo-store.test.mjs', 'tests/astra-prospecting.test.mjs', 'tests/astra-prospecting-recovery.test.mjs']
        : ['tests/astra-prospecting.test.mjs', 'tests/astra-prospecting-source-gate.test.mjs', 'tests/astra-prospecting-recovery.test.mjs']);
    }
    for (const testFile of row.testFiles) assert.ok(readFileSync(path.join(root, testFile)), `${row.path} references a missing test ${testFile}`);
  }
});

test('S00-B02 supplemental writes: source-rights revocation is a tenant-RLS append-only database boundary', () => {
  const rows = inventory.supplementalDatabaseWrites;
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map(row => row.path), ['pipeline/astra-mongo-store.js', 'pipeline/astra-source-collection.js', 'pipeline/astra-source-rights.js']);
  const row = rows.find(item => item.path === 'pipeline/astra-source-rights.js');
  assert.equal(sha256(readFileSync(path.join(root, row.path))), row.sha256,
    'source-rights service changed and needs supplemental write-boundary review');
  assert.deepEqual(row.writes, ['astra.research_source_rights_revocations']);
  assert.deepEqual(row.tableAccess, {
    app: ['SELECT', 'INSERT'], worker: ['SELECT'], tenantRls: true, forcedRls: true, appendOnly: true,
  });
  const migrationPath = 'migrations/astra/033-source-rights-revocations.up.sql';
  const migrationBytes = readFileSync(path.join(root, migrationPath));
  const sourceDelta = JSON.parse(readFileSync(path.join(root, 'docs/astra/s00-source-delta.json'), 'utf8'));
  const pinnedMigration = sourceDelta.r20SupplementalAuthorization.sourceFingerprints.find(item => item.path === migrationPath);
  assert.ok(pinnedMigration, 'R20 source metadata pins the migration that establishes the table RLS policy');
  assert.equal(sha256(migrationBytes), pinnedMigration.sha256, 'the asserted RLS directive comes from the pinned migration bytes');
  assert.match(migrationBytes.toString('utf8'), /ALTER\s+TABLE\s+astra\.research_source_rights_revocations\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\s*;/i);
  assert.ok(row.effect && /append-only/i.test(row.effect));
  assert.match(row.effect, /later of the database statement time and supplied audit time/i,
    'expiry uses the later database or supplied audit clock and cannot be revived by a backdated audit');
  assert.deepEqual(row.testFiles, [
    'tests/astra-source-rights.test.mjs',
    'tests/astra-source-rights-consumers.test.mjs',
    'tests/astra-source-rights-ui.test.mjs',
  ]);
  assert.ok(row.guardAndDestination?.guard && row.guardAndDestination?.destination && row.guardAndDestination?.authorization,
    'the supplemental write boundary records actual actor, tenant, destination and authorization guards');
  assert.match(row.guardAndDestination.guard, /owner\/admin/i);
  assert.match(row.guardAndDestination.destination, /app role.*SELECT and INSERT.*worker role.*SELECT/i);
  assert.match(row.guardAndDestination.destination, /tenant-RLS/i);
  assert.match(row.guardAndDestination.destination, /FORCE ROW LEVEL SECURITY/i);
  assert.match(row.guardAndDestination.authorization, /does not authorize provider inference/);
  for (const testFile of row.testFiles) assert.ok(readFileSync(path.join(root, testFile)), `${row.path} references a missing behavior test ${testFile}`);
});

test('S00-B02 supplemental live database writes: Mongo and source collection writes retain tenant and activation guards', () => {
  const rows = new Map(inventory.supplementalDatabaseWrites.map(row => [row.path, row]));
  const mongo = rows.get('pipeline/astra-mongo-store.js');
  assert.ok(mongo);
  assert.equal(mongo.sha256, sha256(readFileSync(path.join(root, mongo.path))));
  assert.deepEqual(mongo.writes, [
    'prospecting_jobs', 'prospecting_events', 'prospecting_outcomes',
    'prospecting_source_evidence', 'prospecting_qualified_contacts', 'prospecting_idempotency_receipts',
  ]);
  assert.match(mongo.guardAndDestination.guard, /tenantId/);
  assert.match(mongo.guardAndDestination.guard, /transaction/);
  assert.match(mongo.guardAndDestination.guard, /lease\/fence\/version/);
  assert.match(mongo.guardAndDestination.authorization, /No Atlas access or production\/customer data permission/);
  assert.deepEqual(mongo.testFiles, ['tests/astra-mongo-store.test.mjs', 'tests/astra-prospecting.test.mjs', 'tests/astra-prospecting-recovery.test.mjs']);

  const source = rows.get('pipeline/astra-source-collection.js');
  assert.ok(source);
  assert.equal(source.sha256, sha256(readFileSync(path.join(root, source.path))));
  assert.deepEqual(source.writes, [
    'astra.source_collection_jobs', 'astra.source_collection_runs', 'astra.source_collection_candidates',
    'astra.source_collection_observations', 'astra.research_sources', 'astra.research_blobs',
    'astra.research_evidence', 'astra.research_accounts', 'astra.research_identity_candidates',
  ]);
  assert.match(source.guardAndDestination.guard, /tenant_id/);
  assert.match(source.guardAndDestination.guard, /source-rights/);
  assert.match(source.guardAndDestination.guard, /robots/);
  assert.match(source.guardAndDestination.authorization, /does not confer rights/);
  assert.deepEqual(source.testFiles, ['tests/astra-prospecting.test.mjs', 'tests/astra-prospecting-source-gate.test.mjs', 'tests/astra-prospecting-recovery.test.mjs']);
  for (const row of [mongo, source]) {
    assert.ok(row.effect && row.guardAndDestination?.guard && row.guardAndDestination?.destination && row.guardAndDestination?.authorization);
    for (const testFile of row.testFiles) assert.ok(readFileSync(path.join(root, testFile)), `missing behavior test ${testFile}`);
  }
});


test('S00-B02 supplemental outcome ownership guards: account references are validated before outcome writes', () => {
  const rows = inventory.supplementalOutcomeOwnershipGuards;
  assert.ok(Array.isArray(rows));
  assert.deepEqual(rows.map(row => row.path), ['pipeline/astra-outcomes.js', 'pipeline/astra-ledger-routes.js']);
  const expectedHashes = {
    'pipeline/astra-outcomes.js': 'f56ee094dd96e0688184a9cbd75a8fdc9446e13f975a9da10ab4005bc5a1d20c',
    'pipeline/astra-ledger-routes.js': 'e952710c56f91c04b9c879bc870862353bb09eb46f126b4ef137f74f90876ed5',
  };
  for (const row of rows) {
    assert.equal(row.sha256, expectedHashes[row.path]);
    assert.equal(sha256(readFileSync(path.join(root, row.path))), row.sha256, `${row.path} changed and needs ownership-guard inventory review`);
    assert.ok(row.guard && /tenant/i.test(row.guard) && /before/i.test(row.guard));
    assert.ok(row.destination && /outcome|ledger/i.test(row.destination));
    assert.ok(row.authorization && /does not grant|no provider|no provider or release/i.test(row.authorization));
    assert.deepEqual(row.testFiles, row.path === 'pipeline/astra-outcomes.js'
      ? ['tests/astra-outcome-ownership.test.mjs', 'tests/astra-outcomes-corrections.test.mjs']
      : ['tests/astra-outcome-ownership.test.mjs']);
    for (const testFile of row.testFiles) assert.ok(readFileSync(path.join(root, testFile)), `missing behavior test ${testFile}`);
  }
  assert.match(rows[0].guard, /resolved under the actor tenant/);
  assert.match(rows[1].guard, /before appendEvent, outbox insertion, or projection rebuild/);
});
