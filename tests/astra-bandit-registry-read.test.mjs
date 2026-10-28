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

test('bandit arm registry reads use registered_by with owner and reviewer tenant access', {
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

  const safeEnv = new Set(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!safeEnv.has(key)) delete process.env[key];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'astra-bandit-read-'));
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
      const contentType = response.headers.get('content-type') || '';
      return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: contentType.includes('json') ? await response.json() : await response.text() };
    }
    function session(setCookie) {
      const sid = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
      const csrfCookie = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
      assert.ok(sid && csrfCookie, 'synthetic user receives a session');
      return { cookie: `odd_session=${sid}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
    }

    const authDb = (await import('../pipeline/database.js')).initDb();
    authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
    authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(1_000_000_000 + randomBytes(4).readUInt32BE(0));
    const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
      email: `bandit-owner-${randomBytes(5).toString('hex')}@example.test`,
      password: 'Synthetic-bandit-owner-pass-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    } });
    assert.equal(bootstrap.status, 201, bootstrap.body?.error);
    const owner = session(bootstrap.setCookie);
    const tenantResult = await request('/api/astra/tenants', { method: 'POST', ...owner, body: { name: 'Synthetic bandit registry tenant' } });
    assert.equal(tenantResult.status, 201, tenantResult.body?.error);
    const tenantId = tenantResult.body.tenant.id;

    const foreignEmail = `bandit-foreign-${randomBytes(5).toString('hex')}@example.test`;
    const { initDb } = await import('../pipeline/database.js');
    const { createAuthManager } = await import('../pipeline/auth-manager.js');
    const auth = createAuthManager(initDb());
    const invite = auth.createInvitation({ actor: { id: Number(bootstrap.body.user.id), role: 'owner' }, email: foreignEmail, role: 'reviewer', remoteAddress: '127.0.0.1' }).invitation;
    const foreignAuth = await auth.acceptInvitation({ email: foreignEmail, password: 'Synthetic-bandit-foreign-pass-9!', invitationToken: invite.token, remoteAddress: '127.0.0.1' });
    const foreign = { cookie: `odd_session=${foreignAuth.sessionToken}; odd_csrf=${foreignAuth.csrfToken}`, csrf: foreignAuth.csrfToken };

    const reviewerEmail = `bandit-reviewer-${randomBytes(5).toString('hex')}@example.test`;
    const reviewerInvite = auth.createInvitation({ actor: { id: Number(bootstrap.body.user.id), role: 'owner' }, email: reviewerEmail, role: 'reviewer', remoteAddress: '127.0.0.1' }).invitation;
    const reviewerAuth = await auth.acceptInvitation({ email: reviewerEmail, password: 'Synthetic-bandit-reviewer-pass-9!', invitationToken: reviewerInvite.token, remoteAddress: '127.0.0.1' });
    const reviewer = { cookie: `odd_session=${reviewerAuth.sessionToken}; odd_csrf=${reviewerAuth.csrfToken}`, csrf: reviewerAuth.csrfToken };
    const membershipInvite = await request(`/api/astra/tenants/${tenantId}/memberships/invitations`, { method: 'POST', ...owner, body: { email: reviewerEmail, role: 'reviewer' } });
    assert.equal(membershipInvite.status, 201, membershipInvite.body?.error);
    const accepted = await request('/api/astra/invitations/accept', { method: 'POST', ...reviewer, body: { token: membershipInvite.body.token } });
    assert.equal(accepted.status, 200, accepted.body?.error);

    const route = `/api/astra/tenants/${tenantId}/bandits/arms`;
    const ownerRead = await request(route, { cookie: owner.cookie });
    assert.equal(ownerRead.status, 200, ownerRead.body?.error);
    assert.deepEqual(ownerRead.body.items, []);
    assert.equal(ownerRead.body.liveAllocation, false);
    assert.equal(ownerRead.body.releaseReady, false);

    const reviewerRead = await request(route, { cookie: reviewer.cookie });
    assert.equal(reviewerRead.status, 200, reviewerRead.body?.error);
    assert.deepEqual(reviewerRead.body.items, []);
    assert.equal(reviewerRead.body.liveAllocation, false);
    assert.equal(reviewerRead.body.releaseReady, false);

    const foreignRead = await request(route, { cookie: foreign.cookie });
    assert.equal(foreignRead.status, 404);
    assert.equal(foreignRead.body?.error, 'Tenant was not found.');

    const reviewerWrite = await request(route, { method: 'POST', ...reviewer, body: {} });
    assert.equal(reviewerWrite.status, 403);
    assert.equal(reviewerWrite.body?.error, 'Tenant role does not allow this action.');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (closeDb) await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
});
