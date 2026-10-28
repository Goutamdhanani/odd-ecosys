import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { validateAstraQaFixture } from './support/astra-r18-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const snapshot = JSON.parse(readFileSync(path.join(root, 'docs/astra/source-snapshot.json'), 'utf8'));
const delta = JSON.parse(readFileSync(path.join(root, 'docs/astra/s00-source-delta.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');const preExistingDeltaPaths = [
  'package-lock.json',
  'package.json',
  'pipeline/auth-manager.js',
  'pipeline/database.js',
  'pipeline/lead-strategy.js',
  'pipeline/personalizer.js',
  'pipeline/reply-tracker.js',
  'pipeline/sending-engine.js',
  'orchestration/OWNERSHIP.md',
  'server.js',
  'tests/ai-usage.test.mjs',
  'tests/campaign-launch-snapshot.test.mjs',
  'tests/campaign-lifecycle.test.mjs',
  'tests/unsubscribe-api.test.mjs',
];
const authorizedTestOnlyDeltaPaths = [
  'tests/ui-feedback.test.mjs',
  'tests/website-discovery-jobs.test.mjs',
  'tests/lead-strategy-ui.test.mjs',
  'tests/website-discovery-ui.test.mjs',
];
const liveIntegration = delta.liveIntegrationSupplementalAuthorization;
const liveIntegrationPins = liveIntegration?.sourceFingerprints || [];
const liveIntegrationPinsByPath = new Map(liveIntegrationPins.map(row => [row.path, row]));
const fixtureRepairDeltaPaths = [
  '.gitignore',
  'tests/campaign-audience.test.mjs',
  'tests/campaign-senders.test.mjs',
  'tests/campaign-stop.test.mjs',
  'tests/sender-rotation.test.mjs',
  'tests/lead-strategy-personal-api.test.mjs',
  'tests/lead-strategy-personal-settings.test.mjs',
  'tests/lead-strategy-settings.test.mjs',
  'tests/lead-strategy.test.mjs',
  'tests/personalization-bedrock.test.mjs',
  'tests/personalizer-factcheck.test.mjs',
  'tests/sending-api.test.mjs',
  'tests/campaign-sequence-execution.test.mjs',
];

function compare(rootPath, expected) {
  return Object.entries(expected).flatMap(([relative, expectedHash]) => {
    const actual = sha256(readFileSync(path.join(rootPath, relative)));
    return actual === expectedHash ? [] : [{ path: relative, expected: expectedHash, actual }];
  });
}

test('R20 supplemental provenance fingerprints only released current sources and keeps R18/R19 history', () => {
  const r20 = delta.r20SupplementalAuthorization;
  assert.equal(r20?.sourceRoot, 'C:/Users/pooja/.codex/worktrees/astra-foundation/odd-ecosys');
  assert.equal(r20?.predecessor, 'astra-r19-5da52dcb18e51f40');
  assert.equal(r20?.baseHead, snapshot.head);
  assert.equal(r20?.selectedSnapshotUnchanged, true);
  assert.deepEqual(r20?.selectedSourceCounts, { files: 228, enumeratedDeltas: 31, unchanged: 197 });
  assert.equal(r20?.releaseReady, false);
  assert.ok(Array.isArray(r20?.sourceFingerprints) && r20.sourceFingerprints.length === 47, 'preserve the 46 existing R20 fingerprint paths and add the reviewed R20a X-Ray test fingerprint');
  const beforeDelta = JSON.parse(readFileSync(path.join(root,
    '.superpowers/r20a/metadata-integration/before-20261026-143753/docs__astra__s00-source-delta.json'), 'utf8'));
  const previousPins = beforeDelta.r20SupplementalAuthorization.sourceFingerprints;
  const currentPinsByPath = new Map(r20.sourceFingerprints.map(row => [row.path, row]));
  assert.deepEqual(previousPins.map(row => row.path).sort(),
    [...currentPinsByPath.keys()].filter(file => file !== 'tests/astra-xray.test.mjs').sort(),
  'all 46 original R20 supplemental fingerprint paths are retained; R20a adds one new test pin');
  for (const previous of previousPins) {
    const current = currentPinsByPath.get(previous.path);
    assert.deepEqual(current.authorization, previous.authorization, `${previous.path} preserves its original R20 authorization`);
    assert.deepEqual((current.additionalAuthorizationEvidence || []).slice(0,
      (previous.additionalAuthorizationEvidence || []).length), previous.additionalAuthorizationEvidence || [],
    `${previous.path} retains every previously recorded additive authorization`);
  }
  const changedPriorPinPaths = previousPins.filter(previous =>
    currentPinsByPath.get(previous.path).sha256 !== previous.sha256).map(row => row.path).sort();
  assert.deepEqual(changedPriorPinPaths, [
    'js/astra-growth.js',
    'pipeline/astra-research.js',
    'pipeline/astra-source-rights.js',
    'tests/astra-growth-journey.test.mjs',
    'tests/astra-source-rights.test.mjs',
  ].sort(), 'only released R20a correction paths refresh existing pins');

  const ownershipDelta = delta.deltas.find(row => row.path === 'orchestration/OWNERSHIP.md');
  assert.equal(ownershipDelta.currentSha256, sha256(readFileSync(path.join(root, 'orchestration/OWNERSHIP.md'))));
  assert.ok(ownershipDelta.additionalAuthorizationEvidence.some(item =>
    item.artifact === 'orchestration/astra-r20-metadata-integration-plan.json'
    && item.worker === '/root/r20_metadata_integration'
    && item.independentAcceptance === false),
  'R20 source/inventory integration is supplemental to prior R18/R19 ownership authorizations');
  assert.ok(ownershipDelta.additionalAuthorizationEvidence.some(item =>
    item.artifact === 'orchestration/astra-r20-final-metadata-refresh-plan.json'
    && item.worker === '/root/r20_metadata_refresh1'
    && item.independentAcceptance === false),
  'final metadata refresh is additive provenance, not acceptance of product or release gates');

  const seen = new Set();
  for (const row of r20.sourceFingerprints) {
    assert.ok(!seen.has(row.path), `${row.path} has one canonical current fingerprint`);
    seen.add(row.path);
    const currentPin = liveIntegrationPinsByPath.get(row.path);
    const actual = sha256(readFileSync(path.join(root, row.path)));
    assert.equal(actual, currentPin?.sha256 ?? row.sha256, `${row.path} matches its latest separately classified source fingerprint`);
    if (currentPin) assert.equal(currentPin.supersedesHistoricalR20FingerprintSha256, row.sha256,
      `${row.path} retains its original R20 hash as historical provenance`);
    assert.ok(row.authorization?.artifact && row.authorization?.worker && row.authorization?.reviewEvidence,
      `${row.path} has explicit R20 scope and review provenance`);
    assert.equal(row.authorization.independentAcceptance, true, `${row.path} is included only after scoped independent acceptance`);
  }
  assert.equal(liveIntegration?.sourceRoot, 'C:/Users/pooja/.codex/worktrees/astra-foundation/odd-ecosys');
  assert.equal(liveIntegration?.predecessor, 'astra-r20a-6440a954f59ed529');
  assert.equal(liveIntegration?.baseHead, snapshot.head);
  assert.deepEqual(liveIntegration?.preservesHistoricalSourceCounts, { files: 228, enumeratedDeltas: 31, unchanged: 197 });
  assert.equal(liveIntegration?.historicalR20SupplementalAuthorizationPreserved, true);
  assert.equal(liveIntegration?.historicalStaticBoundaryCount, 48);
  assert.equal(liveIntegration?.releaseReady, false);
  const expectedLivePinPaths = [
    '.superpowers/astra-live/validation/register-evidence.mjs',
    '.superpowers/astra-live/validation/test-register-hardening.mjs',
    'growth.html', 'js/astra-growth.js', 'package-lock.json', 'package.json', 'pipeline/astra-freeinference-client.js',
    'pipeline/astra-mongo-store.js', 'pipeline/astra-persistence.js', 'pipeline/astra-prospecting-routes.js',
    'pipeline/astra-prospecting.js', 'pipeline/astra-source-collection.js', 'server.js',
    'tests/astra-freeinference-client.test.mjs', 'tests/astra-growth-ui.test.mjs', 'tests/astra-mongo-store.test.mjs',
    'pipeline/astra-local-search-transport.js',
    'tests/astra-local-search-transport.test.mjs', 'tests/astra-source-collection-policy.test.mjs',
    'tests/astra-prospecting-recovery.test.mjs', 'tests/astra-prospecting-source-gate.test.mjs', 'tests/astra-prospecting.test.mjs',
    'tools/astra/live-provider-probe.mjs', 'tools/astra/run-prospecting-once.mjs',
  ];
  assert.equal(liveIntegrationPins.length, expectedLivePinPaths.length);
  assert.deepEqual(liveIntegrationPins.map(row => row.path).sort(), expectedLivePinPaths.sort());
  assert.equal(liveIntegrationPinsByPath.size, liveIntegrationPins.length, 'current live integration pins have unique paths');
  for (const row of liveIntegrationPins) {
    assert.equal(sha256(readFileSync(path.join(root, row.path))), row.sha256, `${row.path} matches its live integration fingerprint`);
    assert.equal(row.bytes, readFileSync(path.join(root, row.path)).length);
    assert.ok(row.authorization?.artifact && row.authorization?.worker && typeof row.authorization.independentAcceptance === 'boolean',
      `${row.path} records its exact owner scope separately from review status`);
    assert.ok(row.authorization?.reviewEvidence && readFileSync(path.join(root, row.authorization.reviewEvidence)),
      `${row.path} records existing review evidence`);
  }
  const localSearchReview = '.superpowers/astra-local-search-review/REPORT.md';
  const localSearchPins = {
    'pipeline/astra-source-collection.js': 'b62a7636b5c0fb539b6a3e555afd1aa83d80a55fddc82270d640c1635942bdc5',
    'pipeline/astra-local-search-transport.js': '0b185b0caf20dc575bc9901d0d03e697c9fb609cf18e6f1194c5a0c3810b0b2e',
    'pipeline/astra-prospecting.js': 'f498faa652900c128a47afc3927314c69989c1691954536af4db6b519d861a7c',
    'tests/astra-local-search-transport.test.mjs': 'c0095e09f2e94037c12fc4fa6e1e84c71804508a25f5326f460e74ae9ce43340',
    'tests/astra-source-collection-policy.test.mjs': 'cea5d0ed4277ed937e04afca9a7e87faf6c7e8c8e760d311c9c4543f02a499f7',
    'tests/astra-prospecting.test.mjs': '099c50c2c43c2ddf6772ca29d3d5e8b6670e91acb238798a2be5bbf438d2a393',
  };
  const priorLive = JSON.parse(readFileSync(path.join(root,
    '.superpowers/astra-local-search-metadata/before/s00-source-delta.json'), 'utf8'))
    .liveIntegrationSupplementalAuthorization;
  const currentLive = delta.liveIntegrationSupplementalAuthorization;
  for (const [file, expectedHash] of Object.entries(localSearchPins)) {
    const pin = liveIntegrationPinsByPath.get(file);
    assert.equal(pin?.sha256, expectedHash, `${file} matches the accepted connector receipt`);
    assert.equal(pin?.bytes, readFileSync(path.join(root, file)).length);
    const attributions = [...(pin?.additionalAuthorizationEvidence || []), pin?.authorization].filter(Boolean);
    assert.ok(attributions.some(item => item.artifact === '.superpowers/astra-local-search-connector/PLAN.md'
      && item.worker === '/root/live_local_search_connector'
      && item.independentAcceptance === true
      && item.reviewEvidence === localSearchReview), `${file} records the accepted connector attribution`);
  }
  const acceptedReview = readFileSync(path.join(root, localSearchReview), 'utf8');
  assert.match(acceptedReview, /SPEC verdict: PASS/);
  assert.match(acceptedReview, /QUALITY verdict: PASS/);
  assert.deepEqual(currentLive.sourcePinRefreshHistory.slice(0, priorLive.sourcePinRefreshHistory.length),
    priorLive.sourcePinRefreshHistory, 'the prior Mongo R2 refresh history remains unchanged');
  assert.equal(currentLive.sourcePinRefreshHistory.length, priorLive.sourcePinRefreshHistory.length + 1);
  const refresh = currentLive.sourcePinRefreshHistory.at(-1);
  assert.equal(refresh.authorization.artifact, '.superpowers/astra-local-search-connector/PLAN.md');
  assert.equal(refresh.authorization.worker, '/root/live_local_search_connector');
  assert.equal(refresh.authorization.independentAcceptance, true);
  assert.equal(refresh.authorization.reviewEvidence, localSearchReview);
  assert.deepEqual(refresh.files.map(row => row.path).sort(), Object.keys(localSearchPins).sort());
  assert.match(refresh.limitation, /real local SearXNG service.*unverified/i);
  for (const prior of priorLive.sourceFingerprints) {
    const current = liveIntegrationPinsByPath.get(prior.path);
    if (!Object.hasOwn(localSearchPins, prior.path)) assert.deepEqual(current, prior, `${prior.path} prior pin remains unchanged`);
    else {
      assert.deepEqual(current.authorization, prior.authorization, `${prior.path} keeps its prior owner attribution`);
      assert.deepEqual((current.additionalAuthorizationEvidence || []).slice(0,
        (prior.additionalAuthorizationEvidence || []).length), prior.additionalAuthorizationEvidence || [],
      `${prior.path} preserves earlier additive attribution`);
      assert.ok(current.additionalAuthorizationEvidence?.some(item => item.reviewEvidence === localSearchReview));
    }
  }
  assert.equal(liveIntegrationPinsByPath.get('pipeline/astra-prospecting.js')?.authorization.independentAcceptance, true,
    'only the bounded round-five prospecting repair is marked independently accepted');
  assert.equal(liveIntegrationPinsByPath.get('tests/astra-prospecting-recovery.test.mjs')?.authorization.independentAcceptance, false,
    'the failed native repeat remains unaccepted in this review turn');
  assert.equal(liveIntegration.reviewState.prospecting.focusedPassed, 30);
  assert.equal(liveIntegration.reviewState.prospecting.focusedExitCode, 0);
  assert.equal(liveIntegration.reviewState.prospecting.nativeExitCode, 1);
  assert.match(liveIntegration.reviewState.prospecting.nativeDisposition, /ECONNREFUSED/);
  assert.equal(liveIntegration.reviewState.externalServices.providerCallsByThisIntegration, 0);
  assert.equal(liveIntegration.reviewState.externalServices.atlasCallsByThisIntegration, 0);
  assert.equal(liveIntegration.reviewState.externalServices.publicSourceRequestsByThisIntegration, 0);
  assert.equal(liveIntegration.reviewState.externalServices.messagesSentByThisIntegration, 0);
  const finalOutcomePins = {
    'pipeline/astra-outcomes.js': 'f56ee094dd96e0688184a9cbd75a8fdc9446e13f975a9da10ab4005bc5a1d20c',
    'pipeline/astra-ledger-routes.js': 'e952710c56f91c04b9c879bc870862353bb09eb46f126b4ef137f74f90876ed5',
    'tests/astra-outcome-ownership.test.mjs': '2b287b337d57613d5457ab8f48822ae1e8d6506b498c2b9ded54d98208d756d0',
    'tests/astra-growth-journey.test.mjs': '3f8b1b0a50069db013a04e592a2d7eb35f2c4d3fb77149cb703ed372b6aabce1',
  };
  for (const [file, expected] of Object.entries(finalOutcomePins)) assert.equal(r20.sourceFingerprints.find(row => row.path === file)?.sha256, expected, `${file} has the independently accepted final fingerprint`);
  const correctionPin = r20.sourceFingerprints.find(row => row.path === 'tests/astra-outcomes-corrections.test.mjs');
  assert.equal(correctionPin?.sha256, 'db31998d4abacb9923a385f9edc73bfff411432b335077d38f7a43790dfc6c38');
  assert.ok(correctionPin?.additionalAuthorizationEvidence?.some(item => item.artifact === 'orchestration/astra-r20-outcome-ownership-fix-plan.json'
    && item.independentAcceptance === true
    && item.reviewEvidence === '.superpowers/r20/review-outcome-ownership/REPORT.md'));
  const journeyPin = r20.sourceFingerprints.find(row => row.path === 'tests/astra-growth-journey.test.mjs');
  assert.ok(journeyPin?.additionalAuthorizationEvidence?.some(item => item.artifact === 'orchestration/astra-r20-guided-journey-qa-plan.json'
    && item.worker === '/root/r20_journey_readback1'
    && item.independentAcceptance === true
    && item.reviewEvidence?.includes('.superpowers/r20/review-guided-journey/readback-extension/')),
  'the readback extension needs independent acceptance before the final test fingerprint is released');
  assert.ok(journeyPin?.additionalAuthorizationEvidence?.some(item =>
    item.artifact === 'orchestration/astra-r20a-credential-cleanup-plan.json'
    && item.worker === '/root/r20a_credential_cleanup1'
    && item.independentAcceptance === true
    && item.reviewEvidence === '.superpowers/r20a/review-credential-cleanup/REPORT.md'),
  'the accepted credential-cleanup correction adds provenance without replacing earlier journey reviews');
  const credentialRuling = JSON.parse(readFileSync(path.join(root, 'orchestration/astra-r20a-credential-ruling.json'), 'utf8'));
  assert.equal(credentialRuling.journeyBeforeEvidence.expectedAcceptedSha256,
    '5911776fff4917d1199ffe3fda446ba06a490e813ec14d201681a7665d3038e5');
  assert.equal(credentialRuling.journeyBeforeEvidence.initialCaptureWasOlderR20, true,
    'the prior mistaken older-R20 capture is disclosed, not represented as contemporaneous');
  for (const required of ['growth.html', 'css/astra-growth.css', 'js/astra-growth.js', 'server.js', '.env.example', 'docs/astra/INTEGRATION_SETUP.md', ...Object.keys(finalOutcomePins)]) {
    assert.ok(seen.has(required), `${required} has an explicit current R20 fingerprint`);
  }
  const r20aCorrectionPins = {
    'pipeline/astra-source-rights.js': {
      sha256: 'ba42cf67ec21aa08341305a53b7af7570ab3f48541afcfa689dec828d4e39de7',
      artifact: 'orchestration/astra-r20a-qa-corrections-plan.json',
      worker: '/root/r20a_expiry_fix1',
      reviewEvidence: '.superpowers/r20a/review-expiry/REVIEW.md',
    },
    'pipeline/astra-research.js': {
      sha256: 'd483f7a1b2185805bdf5a1d6a601b6908d1f3af948bed31169439c028f3c80f7',
      artifact: 'orchestration/astra-r20a-qa-corrections-plan.json',
      worker: '/root/r20a_expiry_fix1',
      reviewEvidence: '.superpowers/r20a/review-expiry/REVIEW.md',
    },
    'tests/astra-source-rights.test.mjs': {
      sha256: '92621cbdbb17e4eaf5d39f6492bfd38c08ac8f59f7aea5662e28fcdf6f612f2a',
      artifact: 'orchestration/astra-r20a-qa-corrections-plan.json',
      worker: '/root/r20a_expiry_fix1',
      reviewEvidence: '.superpowers/r20a/review-expiry/REVIEW.md',
    },
    'tests/astra-xray.test.mjs': {
      sha256: 'aebaadf6b844d39d0bdf032e317629baa634b2598e3c13dc007c8ddfd824a4c6',
      artifact: 'orchestration/astra-r20a-qa-corrections-plan.json',
      worker: '/root/r20a_expiry_fix1',
      reviewEvidence: '.superpowers/r20a/review-expiry/REVIEW.md',
    },
    'js/astra-growth.js': {
      sha256: '6ee6a6304e9e9e58dfa46693b4cf2fc25f038295b246ca98d17cf1d3340f150c',
      artifact: 'orchestration/astra-r20a-qa-corrections-plan.json',
      worker: '/root/r20a_workspace_fix1',
      reviewEvidence: '.superpowers/r20a/review-workspace/REPORT.md',
    },
    'tests/astra-growth-journey.test.mjs': {
      sha256: '3f8b1b0a50069db013a04e592a2d7eb35f2c4d3fb77149cb703ed372b6aabce1',
      artifact: 'orchestration/astra-r20a-qa-corrections-plan.json',
      worker: '/root/r20a_workspace_fix1',
      reviewEvidence: '.superpowers/r20a/review-workspace/REPORT.md',
    },
  };
  for (const [file, expected] of Object.entries(r20aCorrectionPins)) {
    const pin = r20.sourceFingerprints.find(row => row.path === file);
    assert.equal(pin?.sha256, expected.sha256, `${file} has its accepted R20a fingerprint`);
    const authorizations = [...(pin?.additionalAuthorizationEvidence || []), pin?.authorization].filter(Boolean);
    assert.ok(authorizations.some(item =>
      item.artifact === expected.artifact
      && item.worker === expected.worker
      && item.independentAcceptance === true
      && item.reviewEvidence === expected.reviewEvidence),
    `${file} retains its original R20 authorization and adds the R20a correction review`);
  }
  const originalPreR20CommercialPath = '.superpowers/r19/integration/before/docs/astra/commercial-gates.json';
  const acceptedBeforeCommercialPath = '.superpowers/r20a/metadata-integration/before-20261026-143753/docs__astra__commercial-gates.json';
  const commercial = JSON.parse(readFileSync(path.join(root, 'docs/astra/commercial-gates.json'), 'utf8'));
  const acceptedBeforeCommercial = JSON.parse(readFileSync(path.join(root, acceptedBeforeCommercialPath), 'utf8'));
  const originalPreR20Commercial = JSON.parse(readFileSync(path.join(root, originalPreR20CommercialPath), 'utf8'));
  const currentInventoryHash = sha256(readFileSync(path.join(root, 'docs/astra/s00-side-effect-inventory.json')));
  assert.equal(commercial.provenance.sourceEvidenceSha256['docs/astra/s00-side-effect-inventory.json'], currentInventoryHash);
  const localSearchIntegration = commercial.observedSourceIntegrations.find(row => row.id === 'local-search');
  assert.ok(localSearchIntegration, 'commercial provenance records the factual local-search integration');
  assert.equal(commercial.provenance.sourceEvidenceSha256['pipeline/astra-local-search-transport.js'],
    sha256(readFileSync(path.join(root, 'pipeline/astra-local-search-transport.js'))));
  assert.match(localSearchIntegration.endpoint, /^http:\/\/127\.0\.0\.1:8081\/search$/);
  assert.match(localSearchIntegration.observation, /google cse/i);
  assert.match(localSearchIntegration.observation, /rights.*unverified|unverified.*rights/i);
  const searchRightsDecision = commercial.decisions.find(row => row.id === 'source.searxng-instance-and-engines');
  assert.equal(searchRightsDecision?.status, 'unknown');
  assert.equal(searchRightsDecision?.enabled, false);
  const withoutAuthorizedCommercialProvenance = value => {
    const clone = structuredClone(value);
    delete clone.provenance.sourceEvidenceSha256['docs/astra/s00-side-effect-inventory.json'];
    delete clone.provenance.sourceEvidenceSha256['pipeline/astra-local-search-transport.js'];
    clone.observedSourceIntegrations = clone.observedSourceIntegrations.filter(row => row.id !== 'local-search');
    delete clone.dependencyLicenseManifest;
    return clone;
  };
  assert.deepEqual(withoutAuthorizedCommercialProvenance(commercial), withoutAuthorizedCommercialProvenance(acceptedBeforeCommercial),
    'all commercial decision fields outside the authorized dependency manifest and inventory fingerprint match the accepted before-copy');
  assert.deepEqual(withoutAuthorizedCommercialProvenance(commercial), withoutAuthorizedCommercialProvenance(originalPreR20Commercial),
    'all commercial decision fields outside the authorized dependency manifest and inventory fingerprint match the original pre-R20 registry');
  assert.equal(delta.sourceFileCount, 228);
  assert.equal(delta.deltaCount, 31);
  assert.equal(delta.unchangedCount, 197);
});

test('S00-01: all 228 selected-source files match the explicit baseline or enumerated delta', () => {
  assert.equal(snapshot.head, 'f30490bd892dd651fd2fb276b09b510379e27c0d');
  assert.equal(Object.keys(snapshot.files).length, 228);
  assert.equal(delta.unchangedCount, Object.keys(snapshot.files).length - delta.deltas.length);
  assert.equal(delta.sourceHead, snapshot.head);
  assert.equal(delta.overlayManifestSha256, snapshot.overlayManifestSha256);
  assert.equal(delta.unresolvedSourceDivergences?.length ?? 0, 0,
    `unattributed, unauthorized source drift remains: ${(delta.unresolvedSourceDivergences || []).map(row => row.path).join(', ')}`);

  const deltaByPath = new Map(delta.deltas.map(row => [row.path, row]));
  const expected = Object.fromEntries(Object.entries(snapshot.files).map(([relative, entry]) => {
    const livePin = liveIntegrationPinsByPath.get(relative);
    const row = deltaByPath.get(relative);
    if (row) {
      assert.equal(row.baseSha256, entry.sha256, `${relative} delta starts from the selected-source hash`);
      assert.ok(typeof row.explanation === 'string' && row.explanation.length > 20, `${relative} has an explicit reason`);
      return [relative, livePin?.sha256 ?? row.currentSha256];
    }
    return [relative, livePin?.sha256 ?? entry.sha256];
  }));
  const expectedDeltaPaths = [...preExistingDeltaPaths, ...fixtureRepairDeltaPaths, ...authorizedTestOnlyDeltaPaths].sort();
  assert.deepEqual([...deltaByPath.keys()].sort(), expectedDeltaPaths,
    'only the original deltas and explicitly authorized fixture repair paths are listed');
  for (const relative of fixtureRepairDeltaPaths) {
    assert.equal(deltaByPath.get(relative)?.authorizationEvidence?.independentAcceptance, false,
      `${relative} records provenance without implying independent acceptance`);
  }
  const ownershipDelta = deltaByPath.get('orchestration/OWNERSHIP.md');
  assert.equal(ownershipDelta?.authorizationEvidence?.artifact, 'orchestration/astra-r18-integration-plan.json');
  assert.equal(ownershipDelta?.authorizationEvidence?.worker, '/root/r18_integration');
  assert.equal(ownershipDelta?.authorizationEvidence?.independentAcceptance, false);
  assert.ok(ownershipDelta?.additionalAuthorizationEvidence?.some(item =>
    item.kind === 'coordinator_scope_authorization'
    && item.artifact === 'orchestration/astra-r19-integration-plan.json'
    && item.worker === '/root/r19_integration'
    && item.baselineEvidence === 'docs/astra/source-snapshot.json'
    && item.independentAcceptance === false),
  'R19 source integration has supplemental provenance authorization without replacing the historical R18 authorization');
  const serverDelta = deltaByPath.get('server.js');
  assert.ok(serverDelta?.additionalAuthorizationEvidence?.some(item =>
    item.artifact === 'orchestration/astra-r18-integration-plan.json'
    && item.worker === '/root/r18_integration'
    && item.independentAcceptance === false),
  'R18 authenticated workspace/page gate source change has explicit supplemental authorization');
  for (const relative of authorizedTestOnlyDeltaPaths) {
    const row = deltaByPath.get(relative);
    if (relative === 'tests/ui-feedback.test.mjs') {
      assert.equal(row?.authorizationEvidence?.artifact, 'orchestration/astra-ui-feedback-test-ruling.json');
      assert.equal(row?.authorizationEvidence?.baselineManifest, 'orchestration/astra-phase2-source-r4.json');
      assert.equal(row?.authorizationEvidence?.baselineSha256, snapshot.files[relative].sha256);
      assert.equal(row?.authorizationEvidence?.workerReport, '.superpowers/phase2/fixes/ui-feedback-r5/implementer-report.md');
    } else if (relative === 'tests/website-discovery-jobs.test.mjs') {
      assert.equal(row?.authorizationEvidence?.artifact, 'orchestration/astra-test-determinism-r7-ruling.json');
      assert.equal(row?.authorizationEvidence?.authorizedPurpose,
        'test-only source-evidence preservation and recovery determinism proof');
      assert.equal(row?.authorizationEvidence?.independentAcceptance, false);
      assert.ok(row?.additionalAuthorizationEvidence?.some(item =>
        item.artifact === 'orchestration/astra-discovery-selection-r16-ruling.json'
        && item.worker === '/root/discovery_selection_r16'
        && item.independentAcceptance === false),
      'the linked-Person source-selection repair has explicit test-only authorization');
    } else if (relative === 'tests/lead-strategy-ui.test.mjs') {
      assert.equal(row?.authorizationEvidence?.artifact, 'orchestration/astra-lead-ui-determinism-r8-ruling.json');
      assert.equal(row?.authorizationEvidence?.baselineManifest, 'orchestration/astra-phase2-source-r7.json');
      assert.equal(row?.authorizationEvidence?.baselineSha256, snapshot.files[relative].sha256);
      assert.equal(row?.authorizationEvidence?.workerReport, '.superpowers/phase2/fixes/fullsuite-harness-r8/REPORT.md');
      assert.equal(row?.authorizationEvidence?.authorizedPurpose,
        'test-only deterministic observation of existing provider-check pending state using a controlled synthetic response');
    } else {
      assert.equal(row?.authorizationEvidence?.artifact, 'orchestration/astra-discovery-ui-sync-r12-ruling.json');
      assert.equal(row?.authorizationEvidence?.baselineManifest, 'orchestration/astra-phase2-source-r11.json');
      assert.equal(row?.authorizationEvidence?.baselineSha256, snapshot.files[relative].sha256);
      assert.equal(row?.authorizationEvidence?.workerReport,
        '.superpowers/phase2/fixes/discovery-ui-sync-r12/REPORT.md');
      assert.equal(row?.authorizationEvidence?.authorizedPurpose,
        'Await the exact synthetic retry API response before asserting server-side counters, preserving explicit-action-only and exactly-once behavior.');
      assert.ok(row?.additionalAuthorizationEvidence?.some(item =>
        item.artifact === 'orchestration/astra-discovery-bulk-sync-r17-ruling.json'
        && item.baselineManifest === 'orchestration/astra-phase2-source-r16.json'
        && item.baselineSha256 === '3a8b3bd1060bc4dbde81668f06811932e43aadaa4093ac9beb6ef8b350e0c2cb'
        && item.worker === '/root/credential_finish_r14'
        && item.workerReport === '.superpowers/phase2/fixes/discovery-bulk-sync-r17/REPORT.md'
        && item.independentAcceptance === false),
      'bulk request synchronization has separate test-only R17 authorization');
    }
    assert.equal(row?.authorizationEvidence?.independentAcceptance, false);
  }
  assert.deepEqual(compare(root, expected), [], 'no unrecorded source divergence is allowed');
});

test('S00-01 negative probe: drift is detected on a disposable copy, never on the selected source', () => {
  const disposable = mkdtempSync(path.join(tmpdir(), 'astra-source-fidelity-probe-'));
  try {
    const relative = 'server.js';
    const original = readFileSync(path.join(root, relative));
    writeFileSync(path.join(disposable, relative), original);
    const expected = { [relative]: sha256(original) };
    assert.deepEqual(compare(disposable, expected), []);
    writeFileSync(path.join(disposable, relative), Buffer.concat([original, Buffer.from('\n// disposable drift probe\n')]));
    assert.deepEqual(compare(disposable, expected).map(row => row.path), [relative]);
  } finally {
    rmSync(disposable, { recursive: true, force: true });
  }
});

test('R18 fixture validator accepts only exact synthetic32 metadata and recorded migration hashes', async () => {
  const disposable = mkdtempSync(path.join(tmpdir(), 'astra-r18-fixture-validator-'));
  const migrationsRoot = path.join(disposable, 'migrations', 'astra');
  const fixtureDir = path.join(disposable, '.runner', 'astra-qa', 'r18-suite');
  mkdirSync(migrationsRoot, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  try {
    const migrationEntries = [];
    const names = readdirSync(path.join(root, 'migrations', 'astra'))
      .filter(name => /^0(?:0[1-9]|[12]\d|3[0-2])-.+\.up\.sql$/.test(name))
      .sort();
    assert.equal(names.length, 32);
    for (const name of names) {
      const bytes = readFileSync(path.join(root, 'migrations', 'astra', name));
      copyFileSync(path.join(root, 'migrations', 'astra', name), path.join(migrationsRoot, name));
      migrationEntries.push({ file: name, sha256: sha256(bytes) });
    }
    const fixturePath = path.join(fixtureDir, 'pg.json');
    const fixture = {
      mode: 'disposable-synthetic-qa', label: 'r18-suite', realData: false,
      connectionString: 'postgres://astra_qa_app_test:synthetic@127.0.0.1:5432/astra_test',
      workerConnectionString: 'postgres://astra_qa_worker_test:synthetic@127.0.0.1:5432/astra_test',
      contextSecret: 'a'.repeat(64), migrations: migrationEntries,
    };
    writeFileSync(fixturePath, JSON.stringify(fixture));
    await assert.doesNotReject(validateAstraQaFixture({ root: disposable, fixturePath, labels: 'r18-suite', migrations: 32 }));

    // URL.hostname retains brackets for IPv6 literals. Validation is metadata-only; no database is opened.
    const ipv6 = structuredClone(fixture);
    ipv6.connectionString = 'postgres://astra_qa_app_test:synthetic@[::1]:5432/astra_test';
    ipv6.workerConnectionString = 'postgres://astra_qa_worker_test:synthetic@[::1]:5432/astra_test';
    writeFileSync(fixturePath, JSON.stringify(ipv6));
    await assert.doesNotReject(validateAstraQaFixture({ root: disposable, fixturePath, labels: 'r18-suite', migrations: 32 }));

    const remote = structuredClone(ipv6);
    remote.connectionString = 'postgres://astra_qa_app_test:synthetic@203.0.113.8:5432/astra_test';
    writeFileSync(fixturePath, JSON.stringify(remote));
    await assert.rejects(validateAstraQaFixture({ root: disposable, fixturePath, labels: 'r18-suite', migrations: 32 }), /fixture host must be loopback/);

    const changed = structuredClone(fixture);
    changed.migrations[0].sha256 = `${changed.migrations[0].sha256[0] === '0' ? '1' : '0'}${changed.migrations[0].sha256.slice(1)}`;
    writeFileSync(fixturePath, JSON.stringify(changed));
    await assert.rejects(validateAstraQaFixture({ root: disposable, fixturePath, labels: 'r18-suite', migrations: 32 }), /recorded immutable migration hash mismatch/);
  } finally {
    rmSync(disposable, { recursive: true, force: true });
  }
});
