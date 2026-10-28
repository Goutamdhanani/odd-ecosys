import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign as signDetached } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from '../pipeline/astra-ledger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.resolve(root, '.runner/astra-qa');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;

test('offline customer approvals verify frozen Ed25519 proof and honor live consent revocation', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the prepared disposable synthetic fixture at .runner/astra-qa/<label>/pg.json.',
}, async () => {
  const [canonicalQaRoot, canonicalFixturePath] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relativeFixture = path.relative(canonicalQaRoot, canonicalFixturePath);
  const fixtureParts = relativeFixture.split(path.sep);
  assert.equal(path.isAbsolute(relativeFixture), false, 'fixture must remain below this repository QA root');
  assert.equal(fixtureParts.length, 2, 'fixture path must be .runner/astra-qa/<label>/pg.json');
  assert.ok(fixtureParts[0] && fixtureParts[0] !== '..', 'fixture label is required');
  assert.equal(fixtureParts[1], 'pg.json');
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: canonicalFixturePath, allowR20: true, labels: 'legacy31-or-r18', migrations: 'legacy31-or-r18' });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.label, fixtureParts[0]);
  assert.equal(fixture.realData, false);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol), 'fixture must use PostgreSQL');
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname), 'fixture database must be loopback-only');
  }

  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-customer-approvals-'));
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.NODE_ENV = 'test';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_TENANT_MODE = '1';
  process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.LOCAL_PREVIEW = '1';
  process.env.ASTRA_LIVE_ACTIONS = 'disabled';
  process.env.ASTRA_GLOBAL_PROVIDER_DECISION = 'unapproved';

  let server;
  let closeDb;
  let setupStore;
  const checks = [];
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    ({ closeDb } = await import('../pipeline/database.js'));
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: await response.json() };
    }
    const authDb = (await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `customer-proof-${randomBytes(5).toString('hex')}@example.test`, password: 'Synthetic-customer-pass-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body?.error);
    const sessionId = bootstrap.setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrfCookie = bootstrap.setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sessionId && csrfCookie, 'synthetic owner receives a session');
    const owner = { cookie: `odd_session=${sessionId}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    const tenantResponse = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic customer approvals' } });
    assert.equal(tenantResponse.status, 201, tenantResponse.body?.error);
    const tenantId = tenantResponse.body.tenant.id;
    const otherTenantResponse = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic isolated approvals' } });
    assert.equal(otherTenantResponse.status, 201, otherTenantResponse.body?.error);
    const otherTenantId = otherTenantResponse.body.tenant.id;

    const { initDb } = await import('../pipeline/database.js');
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    const { createAstraTenantStore } = await import('../pipeline/astra-tenant-store.js');
    const auth = createAuthManager(initDb());
    const reviewerEmail = `customer-reviewer-${randomBytes(5).toString('hex')}@example.test`;
    const platformInvite = auth.createInvitation({ actor: { id: Number(bootstrap.body.user.id), role: 'owner' }, email: reviewerEmail, role: 'reviewer', remoteAddress: '127.0.0.1' }).invitation;
    const reviewerAuth = await auth.acceptInvitation({ email: reviewerEmail, password: 'Synthetic-reviewer-pass-9!', invitationToken: platformInvite.token, remoteAddress: '127.0.0.1' });
    const reviewer = { cookie: `odd_session=${reviewerAuth.sessionToken}; odd_csrf=${reviewerAuth.csrfToken}`, csrf: reviewerAuth.csrfToken };
    const tenantInvite = await request(`/api/astra/tenants/${tenantId}/memberships/invitations`, { method: 'POST', ...owner, body: { email: reviewerEmail, role: 'reviewer' } });
    assert.equal(tenantInvite.status, 201, tenantInvite.body?.error);
    const acceptedReviewer = await request('/api/astra/invitations/accept', { method: 'POST', ...reviewer, body: { token: tenantInvite.body.token } });
    assert.equal(acceptedReviewer.status, 200, acceptedReviewer.body?.error);

    const accountId = randomUUID();
    // Research identities have no create endpoint; this is only the synthetic FK foundation for the public post-sale APIs below.
    setupStore = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
    await setupStore.withTenant({ tenantId, userId: String(bootstrap.body.user.id) }, db => db.query(
      'INSERT INTO astra.research_accounts(tenant_id,id,normalized_domain,display_domain) VALUES($1::uuid,$2::uuid,$3,$4)',
      [tenantId, accountId, `${accountId}.synthetic.example.test`, `${accountId}.synthetic.example.test`],
    ));
    async function event(stage, suffix, extra = {}) {
      const result = await request(`/api/astra/tenants/${tenantId}/events`, { method: 'POST', ...owner, body: {
        eventType: stage === 'opportunity_won' ? 'opportunity.won' : 'revenue.paid', schemaVersion: 1,
        entity: { type: 'account', id: accountId }, occurredAt: new Date().toISOString(), idempotencyKey: `customer-proof-${suffix}`,
        payload: { stage, ...extra }, provenance: { source: 'twenty', confidence: 'high', fieldAuthority: 'crm', sourceId: 'synthetic-account', externalEventId: `synthetic-${suffix}` },
      } });
      assert.equal(result.status, 201, result.body?.error);
    }
    await event('opportunity_won', 'won');
    await event('revenue_paid', 'paid', { amountMinor: 100, currency: 'USD' });
    const projectResponse = await request(`/api/astra/tenants/${tenantId}/post-sale/projects`, { method: 'POST', ...owner, body: { accountId, name: 'Synthetic customer proof project' } });
    assert.equal(projectResponse.status, 201);
    const projectId = projectResponse.body.project.id;
    const evidenceResponse = await request(`/api/astra/tenants/${tenantId}/post-sale/projects/${projectId}/evidence`, { method: 'POST', ...owner, body: {
      kind: 'baseline', sourceRef: 'synthetic://customer-proof/evidence', sourceRights: { basis: 'customer_provided', reference: 'synthetic QA evidence' }, snapshot: { finding: 'synthetic only' },
    } });
    assert.equal(evidenceResponse.status, 201, evidenceResponse.body?.error);
    const caseResponse = await request(`/api/astra/tenants/${tenantId}/post-sale/projects/${projectId}/case-studies`, { method: 'POST', ...owner, body: {
      content: { title: 'Synthetic case study', result: 'No real customer data.' }, evidenceIds: [evidenceResponse.body.evidence.id],
    } });
    assert.equal(caseResponse.status, 201, caseResponse.body?.error);
    const caseStudyId = caseResponse.body.caseStudy.id;

    async function enrollAndConfirm() {
      const pair = generateKeyPairSync('ed25519');
      const enrolled = await request(`/api/astra/tenants/${tenantId}/customer-approvals/keys`, { method: 'POST', ...owner, body: {
        projectId, publicKey: { pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        identityRightsEvidence: { identity: Buffer.from('synthetic identity evidence').toString('base64'), rights: Buffer.from('synthetic rights evidence').toString('base64') },
      } });
      assert.equal(enrolled.status, 201, enrolled.body?.error);
      const keyId = enrolled.body.key.id;
      const selfConfirm = await request(`/api/astra/tenants/${tenantId}/customer-approvals/keys/${keyId}/confirm`, { method: 'POST', ...owner, body: {} });
      assert.equal(selfConfirm.status, 403, 'enrolling owner cannot self-confirm as a reviewer');
      const confirmed = await request(`/api/astra/tenants/${tenantId}/customer-approvals/keys/${keyId}/confirm`, { method: 'POST', ...reviewer, body: {} });
      assert.equal(confirmed.status, 200, confirmed.body?.error);
      return { keyId, pair };
    }
    async function challenge(keyId, action = 'approve', cookie = owner, expiresInSeconds = 900) {
      return request(`/api/astra/tenants/${tenantId}/customer-approvals/challenges`, { method: 'POST', ...cookie, body: { caseStudyId, customerKeyId: keyId, action, expiresInSeconds } });
    }
    function detached(pair, challengeText) { return signDetached(null, Buffer.from(challengeText, 'utf8'), pair.privateKey).toString('base64'); }
    async function submit(challengeId, signature, tenant = tenantId) {
      return request(`/api/astra/tenants/${tenant}/customer-approvals/challenges/${challengeId}/signature`, { method: 'POST', ...owner, body: { signature } });
    }
    function assertNoAuthorityFlags(receipt) {
      assert.equal(receipt.publishable, false);
      assert.equal(receipt.contactPermission, false);
      if (Object.hasOwn(receipt, 'releaseReady')) assert.equal(receipt.releaseReady, false);
    }

    const pendingPair = generateKeyPairSync('ed25519');
    const pendingEnrollment = await request(`/api/astra/tenants/${tenantId}/customer-approvals/keys`, { method: 'POST', ...owner, body: {
      projectId, publicKey: { pem: pendingPair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      identityRightsEvidence: { identity: Buffer.from('pending identity fixture').toString('base64'), rights: Buffer.from('pending rights fixture').toString('base64') },
    } });
    assert.equal(pendingEnrollment.status, 201, pendingEnrollment.body?.error);
    const pendingChallenge = await challenge(pendingEnrollment.body.key.id);
    assert.equal(pendingChallenge.status, 409, 'pending enrollment cannot issue a challenge');
    const { keyId, pair } = await enrollAndConfirm();
    const undersizedLifetime = await challenge(keyId, 'approve', owner, 59);
    assert.equal(undersizedLifetime.status, 400, 'challenge lifetime remains bounded');
    const reviewerChallenge = await challenge(keyId, 'approve', reviewer);
    assert.equal(reviewerChallenge.status, 403, 'reviewer cannot act as the project operator');
    checks.push('pending key and unauthorized reviewer cannot issue an approval challenge');

    const approvedChallenge = await challenge(keyId);
    assert.equal(approvedChallenge.status, 201, approvedChallenge.body?.error);
    const approved = approvedChallenge.body.challenge;
    const goodSignature = detached(pair, approved.challenge);
    const badSignature = Buffer.alloc(64, 37).toString('base64');
    const invalid = await submit(approved.id, badSignature);
    assert.equal(invalid.status, 403);
    const wrongKey = generateKeyPairSync('ed25519');
    const wrongKeyProof = await submit(approved.id, detached(wrongKey, approved.challenge));
    assert.equal(wrongKeyProof.status, 403);
    const alteredPayload = JSON.parse(approved.challenge);
    alteredPayload.caseStudyContent = { title: 'Different synthetic case study' };
    alteredPayload.caseStudyContentSha256 = sha256(canonicalJson(alteredPayload.caseStudyContent));
    alteredPayload.caseStudyVersion += 1;
    const alteredProof = await submit(approved.id, detached(pair, canonicalJson(alteredPayload)));
    assert.equal(alteredProof.status, 403, 'a valid key cannot substitute changed case content or version');
    const tenantHidden = await submit(approved.id, goodSignature, otherTenantId);
    assert.equal(tenantHidden.status, 404, 'another tenant cannot find the issued challenge');
    const concurrent = await Promise.all([submit(approved.id, goodSignature), submit(approved.id, goodSignature)]);
    assert.deepEqual(concurrent.map(row => row.status), [201, 201]);
    assert.equal(concurrent[0].body.receipt.id, concurrent[1].body.receipt.id, 'concurrent exact proof creates one immutable receipt');
    assert.equal(concurrent.filter(row => row.body.receipt.duplicate === true).length, 1);
    assert.equal(concurrent[0].body.receipt.verification, 'ed25519_signature_verified_against_human_reviewed_key');
    assertNoAuthorityFlags(concurrent[0].body.receipt);
    const approvedStatus = await request(`/api/astra/tenants/${tenantId}/post-sale/case-studies/${caseStudyId}/customer-approval`, { cookie: owner.cookie });
    assert.equal(approvedStatus.body.state, 'verified');
    assert.equal(approvedStatus.body.verified, true);
    assert.equal(approvedStatus.body.projectConsentActive, true);
    assert.equal(approvedStatus.body.publishable, false);
    assert.equal(approvedStatus.body.contactPermission, false);
    assert.equal(approvedStatus.body.releaseReady, false);
    const mismatchedReplay = await submit(approved.id, Buffer.alloc(64, 38).toString('base64'));
    assert.equal(mismatchedReplay.status, 409, 'a different signature cannot replay a consumed challenge');
    const hiddenCaseStudy = await request(`/api/astra/tenants/${otherTenantId}/post-sale/case-studies/${caseStudyId}/customer-approval`, { cookie: owner.cookie });
    assert.equal(hiddenCaseStudy.status, 404);
    checks.push('actual API accepts detached Ed25519 proof, serializes exact-proof replay, and hides cross-tenant objects');

    const keyRevoke = await request(`/api/astra/tenants/${tenantId}/customer-approvals/keys/${keyId}/revoke`, { method: 'POST', ...owner, body: { reason: 'Synthetic key revocation check' } });
    assert.equal(keyRevoke.status, 200, keyRevoke.body?.error);
    const revokedKeyChallenge = await challenge(keyId);
    assert.equal(revokedKeyChallenge.status, 409, 'revoked key cannot issue a challenge');
    const keyRevokedStatus = await request(`/api/astra/tenants/${tenantId}/post-sale/case-studies/${caseStudyId}/customer-approval`, { cookie: owner.cookie });
    assert.equal(keyRevokedStatus.body.state, 'revoked');
    assert.equal(keyRevokedStatus.body.verified, false);
    checks.push('key revocation removes current verification eligibility');

    const { keyId: secondKeyId, pair: secondPair } = await enrollAndConfirm();
    const rejectChallengeResponse = await challenge(secondKeyId, 'reject');
    assert.equal(rejectChallengeResponse.status, 201, rejectChallengeResponse.body?.error);
    const rejectChallenge = rejectChallengeResponse.body.challenge;
    const rejectProof = await submit(rejectChallenge.id, detached(secondPair, rejectChallenge.challenge));
    assert.equal(rejectProof.status, 201, rejectProof.body?.error);
    assert.equal(rejectProof.body.receipt.action, 'reject');
    assertNoAuthorityFlags(rejectProof.body.receipt);
    checks.push('reject proofs remain available through the actual signature route');

    const staleChallengeResponse = await challenge(secondKeyId);
    assert.equal(staleChallengeResponse.status, 201, staleChallengeResponse.body?.error);
    const staleChallenge = staleChallengeResponse.body.challenge;
    const staleSignature = detached(secondPair, staleChallenge.challenge);
    const consentRevoke = await request(`/api/astra/tenants/${tenantId}/post-sale/projects/${projectId}/customer-consent/revoke`, { method: 'POST', ...owner, body: { reason: 'Synthetic consent revocation check' } });
    assert.equal(consentRevoke.status, 200, consentRevoke.body?.error);
    const staleSubmit = await submit(staleChallenge.id, staleSignature);
    assert.equal(staleSubmit.status, 409, 'a previously issued signature cannot be accepted after project consent revocation');
    const afterRevokeChallenge = await challenge(secondKeyId);
    assert.equal(afterRevokeChallenge.status, 409, 'revoked project consent blocks new challenges');
    const historicalReplay = await submit(approved.id, goodSignature);
    assert.equal(historicalReplay.status, 201, 'same proof may return its immutable historical receipt');
    assert.equal(historicalReplay.body.receipt.id, concurrent[0].body.receipt.id);
    assert.equal(historicalReplay.body.receipt.duplicate, true);
    assertNoAuthorityFlags(historicalReplay.body.receipt);
    const currentStatus = await request(`/api/astra/tenants/${tenantId}/post-sale/case-studies/${caseStudyId}/customer-approval`, { cookie: owner.cookie });
    assert.equal(currentStatus.status, 200);
    assert.equal(currentStatus.body.state, 'revoked');
    assert.equal(currentStatus.body.verified, false);
    assert.equal(currentStatus.body.projectConsentActive, false);
    assert.equal(currentStatus.body.publishable, false);
    assert.equal(currentStatus.body.contactPermission, false);
    assert.equal(currentStatus.body.releaseReady, false);
    checks.push('consent revocation blocks stale/new proofs, preserves historical replay, and dominates current eligibility status');

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, migrations: fixture.migrations.length, realData: false, checks }, null, 2)}\n`);
  } finally {
    await setupStore?.close().catch(() => {});
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
