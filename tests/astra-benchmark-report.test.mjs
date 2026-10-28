import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.resolve(root, '.runner/astra-qa');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;

test('benchmark report persists honest insufficient-data results through tenant APIs', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to .runner/astra-qa/<label>/pg.json for a disposable synthetic fixture.',
}, async () => {
  assert.ok(fixturePath, 'fixture path is required');
  const [canonicalQaRoot, canonicalFixturePath] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relativeFixture = path.relative(canonicalQaRoot, canonicalFixturePath);
  const fixtureParts = relativeFixture.split(path.sep);
  assert.equal(path.isAbsolute(relativeFixture), false, 'fixture must stay below the repository QA fixture root');
  assert.equal(fixtureParts.length, 2, 'fixture must be .runner/astra-qa/<label>/pg.json');
  assert.equal(fixtureParts[1], 'pg.json');
  assert.ok(fixtureParts[0] && fixtureParts[0] !== '..', 'fixture label is required');

  // The fixture is parsed only after the canonical path is bounded. Never print fixture contents.
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: canonicalFixturePath, allowR20: true, labels: 'legacy31-or-r18', migrations: 'legacy31-or-r18' });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.label, fixtureParts[0]);
  assert.equal(fixture.realData, false);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol), 'fixture must use PostgreSQL');
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname), 'fixture must use loopback PostgreSQL');
  }
  assert.ok(fixture.contextSecret, 'fixture context secret is required');

  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-benchmark-report-'));
  Object.assign(process.env, {
    ODD_DB_PATH: path.join(scratch, 'auth.sqlite'), NODE_ENV: 'test', ODD_AUTH_ENFORCE_TESTS: 'true',
    ODD_AUTH_BOOTSTRAP_TOKEN: randomBytes(24).toString('hex'), ODD_AUTH_COOKIE_SECURE: 'false',
    ODD_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'), PORT: '0', HOST: '127.0.0.1',
    ASTRA_DATABASE_URL: fixture.connectionString, ASTRA_WORKER_DATABASE_URL: fixture.workerConnectionString,
    ASTRA_CONTEXT_SECRET: fixture.contextSecret, ASTRA_TENANT_MODE: '1', ASTRA_LEGACY_OFFER_BRIDGE: '1',
    LOCAL_PREVIEW: '1', ASTRA_LIVE_ACTIONS: 'disabled', ASTRA_GLOBAL_PROVIDER_DECISION: 'unapproved',
  });

  let server;
  let closeDb;
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
      const headers = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-csrf-token'] = csrf;
      const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: await response.json() };
    }
    function session(setCookie) {
      const sid = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
      const csrfCookie = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
      assert.ok(sid && csrfCookie, 'synthetic app user receives a session');
      return { cookie: `odd_session=${sid}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    }

    const authDb = (await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `benchmark-owner-${randomBytes(5).toString('hex')}@example.test`, password: 'Synthetic-benchmark-owner-pass-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body?.error);
    const owner = session(bootstrap.setCookie);
    const tenantResponse = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic benchmark report tenant' } });
    assert.equal(tenantResponse.status, 201, tenantResponse.body?.error);
    const tenantId = tenantResponse.body.tenant.id;
    const otherTenantResponse = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic isolated benchmark tenant' } });
    assert.equal(otherTenantResponse.status, 201, otherTenantResponse.body?.error);
    const otherTenantId = otherTenantResponse.body.tenant.id;
    const basePath = `/api/astra/tenants/${tenantId}/economics/benchmarks`;

    const suppliedSource = await request(basePath, { method: 'POST', ...owner, body: {
      targetAccounts: 500, evidenceAgeDays: 90, accounts: ['synthetic-account-must-not-be-accepted'],
    } });
    assert.equal(suppliedSource.status, 400, 'caller-supplied account/source records are outside the bounded schema');
    const belowMinimum = await request(basePath, { method: 'POST', ...owner, body: { targetAccounts: 499, evidenceAgeDays: 90 } });
    assert.equal(belowMinimum.status, 400, 'target account count stays within the 500 minimum');
    const unchanged = await request(basePath, { cookie: owner.cookie });
    assert.deepEqual(unchanged.body.benchmarks, [], 'rejected source fields and bounds do not persist cohorts');
    checks.push('cohort creation rejects caller-supplied source records and out-of-range target counts');

    const prepared = await request(basePath, { method: 'POST', ...owner, body: { targetAccounts: 500, evidenceAgeDays: 90 } });
    assert.equal(prepared.status, 201, prepared.body?.error);
    const benchmarkId = prepared.body.cohort.id;
    assert.equal(prepared.body.cohort.targetAccounts, 500);
    assert.equal(prepared.body.cohort.permittedAccounts, 0);
    assert.equal(prepared.body.cohort.shortfall, 500);
    checks.push('prepared valid 500-account target with zero permitted synthetic source records');

    const before = await request(`${basePath}/${benchmarkId}`, { cookie: owner.cookie });
    assert.equal(before.status, 200);
    assert.equal(before.body.cohort.memberRecords, 0);
    assert.equal(before.body.report, null);
    assert.deepEqual(before.body.quotes, []);
    const hiddenBefore = await request(`/api/astra/tenants/${otherTenantId}/economics/benchmarks/${benchmarkId}`, { cookie: owner.cookie });
    assert.equal(hiddenBefore.status, 404, 'another tenant cannot read this benchmark cohort');
    checks.push('benchmark cohort is tenant-scoped before reporting');

    const reviewerEmail = `benchmark-reviewer-${randomBytes(5).toString('hex')}@example.test`;
    const { initDb } = await import('../pipeline/database.js');
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    const auth = createAuthManager(initDb());
    const globalInvite = auth.createInvitation({ actor: { id: Number(bootstrap.body.user.id), role: 'owner' },
      email: reviewerEmail, role: 'reviewer', remoteAddress: '127.0.0.1' }).invitation;
    const reviewerAuth = await auth.acceptInvitation({ email: reviewerEmail, password: 'Synthetic-benchmark-reviewer-pass-9!',
      invitationToken: globalInvite.token, remoteAddress: '127.0.0.1' });
    const reviewer = { cookie: `odd_session=${reviewerAuth.sessionToken}; odd_csrf=${reviewerAuth.csrfToken}`, csrf: reviewerAuth.csrfToken };
    const invite = await request(`/api/astra/tenants/${tenantId}/memberships/invitations`, { method: 'POST', ...owner,
      body: { email: reviewerEmail, role: 'reviewer' } });
    assert.equal(invite.status, 201, invite.body?.error);
    const accepted = await request('/api/astra/invitations/accept', { method: 'POST', ...reviewer, body: { token: invite.body.token } });
    assert.equal(accepted.status, 200, accepted.body?.error);
    const reviewerWrite = await request(`${basePath}/${benchmarkId}/report`, { method: 'POST', ...reviewer, body: {} });
    assert.equal(reviewerWrite.status, 403, reviewerWrite.body?.error);
    checks.push('reviewer role cannot submit a benchmark report');

    const created = await request(`${basePath}/${benchmarkId}/report`, { method: 'POST', ...owner, body: {} });
    assert.equal(created.status, 201, created.body?.error);
    const report = created.body.report;
    assert.ok(report.id);
    assert.match(report.reportSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.status, 'insufficient_data');
    assert.equal(report.releaseReady, false);
    assert.equal(report.benchmarkExecuted, false);
    assert.equal(report.samples.permittedAccounts, 0);
    assert.equal(report.samples.targetAccounts, 500);
    assert.equal(report.samples.workflows, 0);
    assert.equal(report.samples.uniqueAccountsWithWorkflow, 0);
    assert.equal(report.samples.actualCost, 0);
    assert.equal(report.samples.matureCanonicalOutcomeAccounts, 0);
    assert.equal(report.samples.vendorQuotes, 0);
    assert.equal(report.samples.reviewedVendorQuotes, 0);
    assert.equal(report.metrics.actualCostMicrousd.p50, null);
    assert.equal(report.metrics.actualCostMicrousd.p95, null);
    assert.equal(report.metrics.actualCostMicrousd.max, null);
    assert.equal(report.quota.provisionalDailyCeilingMicrousd, null);
    assert.equal(report.quota.enabled, false);
    assert.equal(report.quotes.callerPriceIsNotVerifiedFact, true);
    assert.deepEqual(report.quotes.reviewed, []);
    assert.equal(report.exclusions.unknownCost, 0);
    assert.equal(report.exclusions.unknownQueueTiming, 0);
    assert.equal(report.exclusions.unknownRuntime, 0);
    assert.equal(report.exclusions.providerOrRemoteWork, 'disabled; benchmark flag cannot enable it');
    for (const reason of ['permitted_account_shortfall','fewer_than_500_distinct_accounts_with_persisted_workflow_observations',
      'no_actual_cost_observations','no_mature_canonical_outcomes_for_cohort_accounts','no_owner_and_independent_reviewed_quote_reference']) {
      assert.ok(report.missing.includes(reason), `report records ${reason}`);
    }
    checks.push('report persists honest insufficient-data metrics without synthetic actuals, quote, outcome, or provider claims');

    const after = await request(`${basePath}/${benchmarkId}`, { cookie: owner.cookie });
    assert.equal(after.status, 200);
    assert.equal(after.body.report.reportSha256, report.reportSha256);
    assert.equal(after.body.report.id, report.id);
    assert.equal(after.body.cohort.memberRecords, 0);
    assert.deepEqual(after.body.quotes, []);
    const hiddenAfter = await request(`/api/astra/tenants/${otherTenantId}/economics/benchmarks/${benchmarkId}`, { cookie: owner.cookie });
    assert.equal(hiddenAfter.status, 404, 'another tenant cannot read the persisted report');
    checks.push('GET retrieves the immutable report and cross-tenant reads remain hidden');

    process.stdout.write(`${JSON.stringify({ fixtureMode: fixture.mode, migrations: fixture.migrations.length, realData: false, checks }, null, 2)}\n`);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
