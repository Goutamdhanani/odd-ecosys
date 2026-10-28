import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CommercialGateDeniedError,
  evaluateCommercialGate,
  readCommercialGateRegistry,
  runIfCommercialGateApproved,
  TARGET,
} from '../tools/astra/commercial-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('S01-B01 locks exact dependency pins and records license unknowns without root-MIT inheritance', async () => {
  const registry = await readCommercialGateRegistry();
  const lockBytes = await readFile(path.join(ROOT, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const manifest = registry.dependencyLicenseManifest;

  assert.equal(registry.status, 'BLOCKED_EXTERNAL_UNKNOWN');
  assert.equal(registry.acceptanceStatus, 'NOT_ACCEPTED');
  assert.equal(registry.provenance.approvalEvidenceCount, 0);
  assert.equal(registry.provenance.approvalsWereNotInferred, true);
  assert.equal(registry.runtimeGate.syntheticFixtureOnly, true);
  assert.equal(registry.runtimeGate.acceptedDataClassification, 'synthetic-fixture');
  assert.equal(manifest.lockfileSha256, sha256(lockBytes));
  assert.equal(manifest.generatedOn, '2026-10-27');
  assert.equal(manifest.lockedPackagePathCount, 163);
  assert.equal(manifest.lockfileVersion, 3);
  assert.equal(manifest.rootPackage.declaredLicense, 'MIT');
  assert.match(manifest.rootPackage.note, /does not override/i);
  assert.equal(manifest.packagePaths.filter(pkg => pkg.directAtRoot).length, 16);
  assert.equal(manifest.directDependencyCount, 16);
  assert.equal(manifest.currentInstalledPackageMetadataCount, 152);
  assert.equal(manifest.currentMissingPackageMetadataCount, 11);
  assert.equal(manifest.currentPackagesWithoutLicenseTextCount, 13);
  assert.equal(manifest.auditObservation.observedOn, '2026-10-27');
  assert.equal(manifest.auditObservation.worktree, 'C:/Users/pooja/.codex/worktrees/astra-foundation/odd-ecosys');
  assert.equal(manifest.historicalAuditObservation.lockfileSha256, '8dbd87c0fc8e92ca65ed04ffac614b6c86aaa52364c766d1d3ca4d4cc9571738');
  assert.equal(manifest.historicalAuditObservation.lockedPackagePathCount, 151);
  assert.equal(manifest.historicalAuditObservation.retainedAsHistoricalOnly, true);

  for (const [sourcePath, expectedHash] of Object.entries(registry.provenance.sourceEvidenceSha256)) {
    const sourceBytes = await readFile(path.join(ROOT, sourcePath));
    assert.equal(sha256(sourceBytes), expectedHash, `${sourcePath} source-evidence fingerprint`);
  }
  const localSearch = registry.observedSourceIntegrations.find(row => row.id === 'local-search');
  assert.deepEqual(localSearch, {
    id: 'local-search',
    source: 'server-owned local SearXNG search using the pinned google cse engine',
    endpoint: 'http://127.0.0.1:8081/search',
    path: 'pipeline/astra-local-search-transport.js',
    observation: 'The application pins a default-disabled local-only request to the google cse engine; operator identity, engine fan-out, query handling and source reuse rights remain unverified. Fixture acceptance did not contact the service or grant source rights.',
  });
  const localSearchRights = registry.decisions.find(decision => decision.id === 'source.searxng-instance-and-engines');
  assert.equal(localSearchRights?.status, 'unknown');
  assert.equal(localSearchRights?.enabled, false);
  assert.equal(registry.provenance.sourceEvidenceSha256['pipeline/astra-local-search-transport.js'],
    sha256(await readFile(path.join(ROOT, 'pipeline/astra-local-search-transport.js'))));

  const lockedPaths = Object.entries(lock.packages)
    .filter(([lockPath, pkg]) => lockPath.startsWith('node_modules/') && pkg.version)
    .map(([lockPath]) => lockPath.replaceAll('\\', '/'))
    .sort();
  const manifestPaths = manifest.packagePaths.map(pkg => pkg.lockPath).sort();
  assert.deepEqual(manifestPaths, lockedPaths, 'manifest covers every locked package path, including nested duplicates and optional packages');

  const rootPackage = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const directSpecs = new Map();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(rootPackage[section] ?? {})) directSpecs.set(name, { spec, section });
  }
  const directPaths = manifest.packagePaths.filter(pkg => pkg.directAtRoot);
  assert.deepEqual(directPaths.map(pkg => `node_modules/${pkg.name}`).sort(), [...directSpecs.keys()].map(name => `node_modules/${name}`).sort(), 'root direct dependencies map one-to-one to exact root lock paths');
  for (const pkg of manifest.packagePaths) {
    const declared = pkg.directAtRoot ? directSpecs.get(pkg.name) : undefined;
    assert.equal(pkg.rootDeclaredSpec, declared?.spec, `${pkg.lockPath} root declaration spec attribution`);
    assert.equal(pkg.rootDeclaredSection, declared?.section, `${pkg.lockPath} root declaration section attribution`);
  }

  for (const pkg of manifest.packagePaths) {
    const pinned = lock.packages[pkg.lockPath];
    assert.equal(pkg.version, pinned.version, `${pkg.lockPath} is exact-lockfile pinned`);
    assert.equal(pkg.integrity, pinned.integrity ?? null, `${pkg.lockPath} retains lock integrity`);
    if (pkg.installedOnCurrentHost) {
      const packagePath = path.join(ROOT, pkg.lockPath, 'package.json');
      const packageBytes = await readFile(packagePath);
      const metadata = JSON.parse(packageBytes);
      assert.equal(pkg.packageJsonSha256, sha256(packageBytes), `${pkg.lockPath} package metadata hash`);
      assert.equal(pkg.licenseDeclaration, metadata.license ?? 'UNKNOWN', `${pkg.lockPath} installed declared license`);
      for (const file of pkg.licenseFiles) {
        const licenseBytes = await readFile(path.join(ROOT, file.path));
        assert.equal(file.sha256, sha256(licenseBytes), `${file.path} selected license text hash`);
        assert.equal(file.bytes, licenseBytes.length, `${file.path} selected license text length`);
      }
    } else {
      assert.equal(pkg.licenseDeclaration, 'UNKNOWN', `${pkg.lockPath} absent optional package remains unknown`);
      assert.equal(pkg.licenseReviewStatus, 'unknown_not_installed_on_current_host');
    }
  }

  const mailcheck = manifest.packagePaths.find(pkg => pkg.lockPath === 'node_modules/mailcheck');
  assert.equal(mailcheck.installedOnCurrentHost, true);
  assert.equal(mailcheck.licenseDeclaration, 'UNKNOWN');
  assert.equal(mailcheck.licenseReviewStatus, 'unknown_expression');
  assert.equal(mailcheck.licenseFiles.length, 1, 'a LICENSE file hash does not silently substitute for missing package metadata');

  const mailsplit = manifest.packagePaths.find(pkg => pkg.lockPath === 'node_modules/@zone-eu/mailsplit');
  assert.equal(mailsplit.licenseDeclaration, '(MIT OR EUPL-1.1+)');
  assert.equal(mailsplit.licenseReviewStatus, 'needs_human_license_review');

  assert.equal(manifest.packagePaths.filter(pkg => !pkg.installedOnCurrentHost).length, 11);
  assert.equal(manifest.packagePaths.filter(pkg => pkg.installedOnCurrentHost && pkg.licenseFiles.length === 0).length, 13);
  const historicalArchive = JSON.parse(await readFile(path.join(ROOT, '.superpowers/astra-live/metadata/license-refresh/historical-dependency-license-manifest.json'), 'utf8'));
  assert.equal(historicalArchive.retainedAsHistoricalOnly, true);
  assert.equal(historicalArchive.manifest.lockfileSha256, '8dbd87c0fc8e92ca65ed04ffac614b6c86aaa52364c766d1d3ca4d4cc9571738');
  assert.equal(historicalArchive.manifest.lockedPackagePathCount, 151);
  assert.equal(historicalArchive.manifest.auditObservation.host, 'a4a4 Windows checkout');
  assert.ok(registry.decisions.every(decision => decision.status === 'unknown' && decision.enabled === false));
  assert.ok(registry.decisions.every(decision => !decision.approvalEvidence));
  assert.deepEqual(registry.target, {
    ...registry.target,
    requiredProvider: TARGET.provider,
    requiredModel: TARGET.model,
  });
  assert.equal(registry.oauthFinding.currentGoogleFlow.accessTokenRequested, false);
  assert.deepEqual(registry.oauthFinding.currentGoogleFlow.gmailScopesRequested, []);
  assert.equal(registry.oauthFinding.futureMailboxOAuth.enabled, false);
});

test('S01-B02 denied or unsupported registry never invokes the supplied inference callback', async () => {
  const registry = await readCommercialGateRegistry();
  const request = {
    gateId: 'glm-api-inference',
    provider: TARGET.provider,
    model: TARGET.model,
    dataClassification: 'private-personal-data',
    now: new Date('2026-10-24T00:00:00.000Z'),
  };
  let callbackCalls = 0;
  const wouldInferFixtureOnly = () => { callbackCalls += 1; return 'fixture'; };

  const verdict = evaluateCommercialGate(registry, request);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'data_classification_not_allowed');
  await assert.rejects(
    runIfCommercialGateApproved(registry, request, wouldInferFixtureOnly),
    error => error instanceof CommercialGateDeniedError && error.code === 'commercial_gate_denied',
  );
  await assert.rejects(
    runIfCommercialGateApproved(registry, { ...request, dataClassification: 'synthetic-fixture' }, wouldInferFixtureOnly),
    error => error instanceof CommercialGateDeniedError && error.reason === 'approval_missing_expired_or_unsupported',
  );
  await assert.rejects(
    runIfCommercialGateApproved(registry, { ...request, provider: 'ollama', dataClassification: 'synthetic-fixture' }, wouldInferFixtureOnly),
    error => error instanceof CommercialGateDeniedError && error.reason === 'unsupported_provider_or_model',
  );

  assert.equal(callbackCalls, 0, 'fixture callback was not run; this case made no network/private inference call');
});
