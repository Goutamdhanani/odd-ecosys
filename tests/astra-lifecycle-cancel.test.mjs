import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
// Exact combined guard bytes after R1-F2: numeric destinations cannot bypass custom-lookup checks.
const egressGuardSha256 = 'fbd64f3a7a018f1f5f38241d639265adc37c4ee5b1468759c327d3470ea6e83e';

test('prepared lifecycle cancellation keeps privacy suppression digests under app role', {
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

  // Parse fixture only after its canonical location is bounded. Never print fixture contents.
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: canonicalFixturePath, allowR20: true, labels: 'legacy31-or-r18', migrations: 'legacy31-or-r18' });
  assert.equal(fixture.mode, 'disposable-synthetic-qa');
  assert.equal(fixture.label, fixtureParts[0]);
  assert.equal(fixture.realData, false);
  for (const connectionString of [fixture.connectionString, fixture.workerConnectionString]) {
    const connection = new URL(connectionString);
    assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol));
    assert.ok(['localhost', '127.0.0.1', '::1'].includes(connection.hostname), 'PostgreSQL fixture must be loopback-only');
  }
  assert.equal(typeof fixture.contextSecret, 'string');
  const guardPath = path.join(root, 'tests/support/astra-qa-egress-guard.mjs');
  assert.equal(createHash('sha256').update(await readFile(guardPath)).digest('hex'), egressGuardSha256,
    'public QA egress guard must match the reviewed SHA-256');

  const safeEnv = new Set(['PATH','SystemRoot','WINDIR','TEMP','TMP','PATHEXT','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-lifecycle-cancel-'));
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
  let store;
  const checks = [];
  try {
    await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
    ({ server } = await import('../server.js'));
    ({ closeDb } = await import('../pipeline/database.js'));
    const { createAstraTenantStore } = await import('../pipeline/astra-tenant-store.js');
    const { initDb } = await import('../pipeline/database.js');
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
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
      assert.ok(sid && csrfCookie, 'synthetic user receives an authenticated session');
      return { cookie: `odd_session=${sid}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    }

    const authDb = (await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `lifecycle-owner-${randomBytes(5).toString('hex')}@example.test`, password: 'Synthetic-lifecycle-owner-pass-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body?.error);
    const owner = session(bootstrap.setCookie);
    const userId = String(bootstrap.body.user.id);
    const tenantResult = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic lifecycle cancellation tenant' } });
    assert.equal(tenantResult.status, 201, tenantResult.body?.error);
    const tenantId = tenantResult.body.tenant.id;
    const otherTenantResult = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic unrelated lifecycle tenant' } });
    assert.equal(otherTenantResult.status, 201, otherTenantResult.body?.error);
    const otherTenantId = otherTenantResult.body.tenant.id;
    const basePath = `/api/astra/tenants/${tenantId}/lifecycle/requests`;
    const digest = createHash('sha256').update(`synthetic-lifecycle-optout-${randomBytes(18).toString('hex')}`).digest('hex');
    const targetId = randomUUID();
    const prepared = await request(basePath, { method: 'POST', ...owner, body: {
      type: 'deletion', targets: [{ table: 'suppression_decisions', id: targetId }], suppressionDigests: [digest],
    } });
    assert.equal(prepared.status, 201, prepared.body?.error);
    const requestId = prepared.body.request.id;
    assert.equal(prepared.body.request.status, 'prepared');
    checks.push('prepared deletion request created through authenticated tenant API with synthetic SHA-256 digest');

    const suppressionValue = `blocked-${randomBytes(6).toString('hex')}@example.test`;
    const suppression = await request(`/api/astra/tenants/${tenantId}/suppressions`, { method: 'POST', ...owner, body: {
      scope: 'recipient', value: suppressionValue, reason: 'synthetic opt-out', evidence: { source: 'synthetic QA cancellation regression' },
    } });
    assert.equal(suppression.status, 201, suppression.body?.error);
    const denied = await request(`/api/astra/tenants/${tenantId}/permissions/evaluate`, { method: 'POST', ...owner, body: {
      recipient: suppressionValue, purpose: 'synthetic_lifecycle_test',
    } });
    assert.equal(denied.status, 200, denied.body?.error);
    assert.equal(denied.body.evaluation.allowed, false);
    assert.equal(denied.body.evaluation.reason, 'suppressed');
    checks.push('existing opt-out remains effective through the permission API');

    const cancelled = await request(`${basePath}/${requestId}/cancel`, { method: 'POST', ...owner, body: {} });
    assert.equal(cancelled.status, 200, cancelled.body?.error);
    assert.equal(cancelled.body.request.status, 'cancelled');
    const retained = await store.withTenant({ tenantId, userId }, async db => {
      const result = await db.query(`SELECT digest,reason_code,source_request_id FROM astra.lifecycle_suppression_retention
        WHERE tenant_id=$1::uuid AND digest=$2`, [tenantId, digest]);
      return result.rows[0] || null;
    });
    assert.equal(retained?.digest, digest);
    assert.equal(retained?.reason_code, 'deletion_request');
    assert.equal(retained?.source_request_id, requestId);
    const guardCount = await store.withTenant({ tenantId, userId }, async db => {
      const result = await db.query(`SELECT count(*)::int AS count FROM astra.lifecycle_tombstone_guards
        WHERE tenant_id=$1::uuid AND request_id=$2::uuid`, [tenantId, requestId]);
      return result.rows[0].count;
    });
    assert.equal(guardCount, 0, 'the cancelled request clears only its own resurrection guards');
    checks.push('cancelled request keeps its tenant-scoped privacy digest while clearing its own tombstone guard');

    let deleteSqlState = null;
    await store.withTenant({ tenantId, userId }, async db => {
      await db.query('SAVEPOINT lifecycle_retention_delete_probe');
      try {
        await db.query(`DELETE FROM astra.lifecycle_suppression_retention WHERE tenant_id=$1::uuid AND digest=$2`, [tenantId, digest]);
      } catch (error) {
        deleteSqlState = error?.code || null;
        await db.query('ROLLBACK TO SAVEPOINT lifecycle_retention_delete_probe');
      }
      await db.query('RELEASE SAVEPOINT lifecycle_retention_delete_probe');
    });
    assert.equal(deleteSqlState, '42501', 'app-role direct retention DELETE remains forbidden');
    checks.push('direct retention DELETE remains denied with SQLSTATE 42501 under authenticated app-role tenant context');

    const planned = await request(basePath, { method: 'POST', ...owner, body: {
      type: 'deletion', targets: [{ table: 'suppression_decisions', id: randomUUID() }],
    } });
    assert.equal(planned.status, 201, planned.body?.error);
    const planId = planned.body.request.id;
    const plan = await request(`${basePath}/${planId}/plan`, { method: 'POST', ...owner, body: {} });
    assert.equal(plan.status, 200, plan.body?.error);
    assert.equal(plan.body.request.status, 'plan_ready');
    const cancelPlan = await request(`${basePath}/${planId}/cancel`, { method: 'POST', ...owner, body: {} });
    assert.equal(cancelPlan.status, 409);
    checks.push('plan_ready lifecycle request remains non-cancellable');

    const bindingRequest = await request(basePath, { method: 'POST', ...owner, body: {
      type: 'deletion', targets: [{ table: 'suppression_decisions', id: randomUUID() }],
    } });
    assert.equal(bindingRequest.status, 201, bindingRequest.body?.error);
    const bindingId = bindingRequest.body.request.id;
    const otherCancel = await request(`/api/astra/tenants/${otherTenantId}/lifecycle/requests/${bindingId}/cancel`, { method: 'POST', ...owner, body: {} });
    assert.equal(otherCancel.status, 409, 'a request ID from another tenant is not cancellable in this tenant context');
    const bindingState = await store.withTenant({ tenantId, userId }, async db => {
      const result = await db.query('SELECT status FROM astra.lifecycle_requests WHERE tenant_id=$1::uuid AND id=$2::uuid', [tenantId, bindingId]);
      return result.rows[0]?.status;
    });
    assert.equal(bindingState, 'prepared', 'mismatched tenant path does not mutate the request');
    const rightfulCancel = await request(`${basePath}/${bindingId}/cancel`, { method: 'POST', ...owner, body: {} });
    assert.equal(rightfulCancel.status, 200, rightfulCancel.body?.error);
    const auth = createAuthManager(initDb());
    const reviewerEmail = `lifecycle-outsider-${randomBytes(5).toString('hex')}@example.test`;
    const globalInvite = auth.createInvitation({ actor: { id: Number(bootstrap.body.user.id), role: 'owner' },
      email: reviewerEmail, role: 'reviewer', remoteAddress: '127.0.0.1' }).invitation;
    const reviewerAuth = await auth.acceptInvitation({ email: reviewerEmail, password: 'Synthetic-lifecycle-reviewer-pass-9!',
      invitationToken: globalInvite.token, remoteAddress: '127.0.0.1' });
    const outsider = { cookie: `odd_session=${reviewerAuth.sessionToken}; odd_csrf=${reviewerAuth.csrfToken}`, csrf: reviewerAuth.csrfToken };
    const tenantInvite = await request(`/api/astra/tenants/${otherTenantId}/memberships/invitations`, { method: 'POST', ...owner,
      body: { email: reviewerEmail, role: 'admin' } });
    assert.equal(tenantInvite.status, 201, tenantInvite.body?.error);
    const accepted = await request('/api/astra/invitations/accept', { method: 'POST', ...outsider, body: { token: tenantInvite.body.token } });
    assert.equal(accepted.status, 200, accepted.body?.error);
    const foreignCancel = await request(`${basePath}/${requestId}/cancel`, { method: 'POST', ...outsider, body: {} });
    assert.equal(foreignCancel.status, 404, 'authenticated nonmember cannot discover or cancel the request');
    checks.push('mismatched tenant/request binding leaves the request prepared and authenticated nonmember receives 404');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (store) await store.close();
    if (closeDb) closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(checks.length, 6);
});
