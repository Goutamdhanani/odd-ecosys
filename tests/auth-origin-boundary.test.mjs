import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-auth-origin-'));
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_DB_PATH = path.join(directory, 'workspace.db');
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'origin-fixture-bootstrap-token-0123456789';
process.env.ODD_AUTH_RECOVERY_TOKEN = 'origin-fixture-recovery-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'true';
process.env.GOOGLE_CLIENT_ID = '1234567890-origin-fixture.apps.googleusercontent.com';
delete process.env.ODD_PUBLIC_BASE_URL;
delete process.env.APP_URL;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const identity = { email: 'browser-owner@example.test', password: 'Browser-fixture-password-2026!' };
let browserOwnerCookies = null;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function post(route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const responseBody = await response.json();
  return { status: response.status, body: responseBody, setCookie: response.headers.get('set-cookie') || '' };
}

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'successful sign-in issues a session cookie');
  assert.ok(csrf, 'successful sign-in issues a CSRF cookie');
  return { cookie: `odd_session=${decodeURIComponent(session)}; odd_csrf=${decodeURIComponent(csrf)}`, csrf: decodeURIComponent(csrf) };
}

function authState() {
  return {
    users: db.prepare('SELECT id,email,password_hash FROM auth_users ORDER BY id').all(),
    sessions: db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get().count,
    loginAttempts: db.prepare('SELECT COUNT(*) AS count FROM auth_login_attempts').get().count,
    invitations: db.prepare('SELECT COUNT(*) AS count FROM auth_invitations').get().count,
    acceptedInvitations: db.prepare('SELECT COUNT(*) AS count FROM auth_invitations WHERE accepted_at IS NOT NULL').get().count,
    recoveryEvents: db.prepare("SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type LIKE '%recovery%'").get().count,
  };
}

test('installed Edge completes local password setup, login and logout, then proves cross-origin form state is rejected', async () => {
  assert.ok(fs.existsSync(EDGE_PATH), `installed Edge is required for this proof: ${EDGE_PATH}`);
  const { chromium } = await import('playwright');
  const attacker = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    const prefix = `${JSON.stringify({ email: 'browser-owner@example.test', password: 'Browser-fixture-password-2026!' }).slice(0, -1)},"formPadding":"`;
    res.end(`<form id="attack" method="POST" enctype="text/plain" action="${base}/api/auth/login">
      <input type="hidden" name='${prefix}' value='"}'>
    </form><script>document.querySelector('#attack').submit()</script>`);
  });
  attacker.listen(0, '127.0.0.1');
  await once(attacker, 'listening');
  const attackerBase = `http://127.0.0.1:${attacker.address().port}`;
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let observedFormRequest = null;
  const formRequest = new Promise(resolve => page.on('request', request => {
    if (request.url() === `${base}/api/auth/login` && request.method() === 'POST' && request.frame().url().startsWith(attackerBase)) {
      observedFormRequest = request;
      resolve(request);
    }
  }));
  const formResponse = new Promise(resolve => page.on('response', response => {
    if (observedFormRequest && response.request() === observedFormRequest) resolve(response);
  }));
  try {
    await context.route('**/*', route => {
      const origin = new URL(route.request().url()).origin;
      return origin === base || origin === attackerBase ? route.continue() : route.abort();
    });
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create your workspace account' }).waitFor();
    await page.locator('[name="email"]').fill('browser-owner@example.test');
    await page.locator('[name="bootstrapToken"]').fill(process.env.ODD_AUTH_BOOTSTRAP_TOKEN);
    await page.locator('[name="password"]').fill('Browser-fixture-password-2026!');
    await page.locator('[name="confirmPassword"]').fill('Browser-fixture-password-2026!');
    const activeBeforeBrowserLogin = authState().sessions;
    await page.getByRole('button', { name: 'Create local account' }).click();
    await page.getByRole('button', { name: 'browser-owner@example.test' }).waitFor({ timeout: 10000 });
    const afterBrowserLogin = authState();
    assert.equal(afterBrowserLogin.users.length, 1);
    assert.equal(afterBrowserLogin.sessions, activeBeforeBrowserLogin + 1);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('heading', { name: 'Sign in to your workspace' }).waitFor();
    assert.equal(authState().sessions, activeBeforeBrowserLogin, 'browser logout revokes its current session');
    await page.locator('[name="email"]').fill('browser-owner@example.test');
    await page.locator('[name="password"]').fill('Browser-fixture-password-2026!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'browser-owner@example.test' }).waitFor({ timeout: 10000 });
    const afterLogin = authState();
    assert.equal(afterLogin.sessions, activeBeforeBrowserLogin + 1, 'the browser UI returns to one valid session after sign-in');
    const loginStatus = await page.evaluate(async () => (await fetch('/api/auth/status', { credentials: 'same-origin' })).json());
    assert.equal(loginStatus.authenticated, true, 'same-origin UI login retains the normal session cookie');
    const cookiesBeforeForm = await context.cookies(base);
    const sessionCookieBeforeForm = cookiesBeforeForm.find(cookie => cookie.name === 'odd_session')?.value;
    assert.ok(sessionCookieBeforeForm, 'Edge holds the authenticated session cookie before the cross-origin form');
    browserOwnerCookies = {
      cookie: cookiesBeforeForm.filter(cookie => ['odd_session', 'odd_csrf'].includes(cookie.name))
        .map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join('; '),
      csrf: cookiesBeforeForm.find(cookie => cookie.name === 'odd_csrf')?.value,
    };
    assert.ok(browserOwnerCookies.csrf, 'Edge holds its CSRF cookie after same-origin setup/login');

    await page.goto(attackerBase, { waitUntil: 'domcontentloaded' });
    const browserFormRequest = await Promise.race([
      formRequest,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Edge did not submit the cross-origin form')), 8000)),
    ]);
    assert.equal(browserFormRequest.headers()['content-type'], 'text/plain');
    assert.equal(browserFormRequest.headers().origin, attackerBase);
    const formPayload = JSON.parse(browserFormRequest.postData());
    assert.equal(formPayload.email, 'browser-owner@example.test');
    assert.equal(formPayload.password, 'Browser-fixture-password-2026!');
    const rejectedFormResponse = await formResponse;
    assert.equal(rejectedFormResponse.status(), 403, 'the cross-origin form is rejected before credential handling');
    const sessionCookieAfterForm = (await context.cookies(base)).find(cookie => cookie.name === 'odd_session')?.value;
    assert.equal(sessionCookieAfterForm, sessionCookieBeforeForm, 'Edge retains only its pre-existing session cookie');
    const afterForm = authState();
    assert.equal(afterForm.sessions, afterLogin.sessions, 'cross-origin browser form creates no new session');
    assert.equal(afterForm.users[0].password_hash, afterLogin.users[0].password_hash, 'cross-origin form cannot mutate credentials');
    assert.equal((await fetch(`${base}/api/auth/status`).then(response => response.json())).authenticated, false,
      'the rejected form does not authenticate the attacker origin');

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'browser-owner@example.test' }).waitFor({ timeout: 10000 });
    assert.equal((await page.evaluate(async () => (await fetch('/api/auth/status')).json())).authenticated, true,
      'the existing same-origin browser session remains valid after the rejected cross-origin form');
    console.log(`EDGE_FORM_AFTER_RESULT=${JSON.stringify({ status: rejectedFormResponse.status(), sessionsBefore: afterLogin.sessions,
      sessionsAfter: afterForm.sessions, sessionCookieUnchanged: sessionCookieAfterForm === sessionCookieBeforeForm,
      browserAuthenticatedAfterForm: true, externalRequestsAllowed: 0 })}`);
  } finally {
    await context.close();
    await browser.close();
    attacker.closeAllConnections?.();
    await new Promise(resolve => attacker.close(resolve));
  }
});

test('credential and session mutations reject foreign or browser-cross-site requests before state changes', async () => {
  await fetch(`${base}/api/auth/status`);
  const before = authState();
  const rejected = [
    ['foreign', { origin: 'https://unrelated.example.test' }],
    ['null', { origin: 'null' }],
    ['malformed', { origin: 'http://[invalid' }],
    ['userinfo', { origin: `http://user@127.0.0.1:${server.address().port}` }],
    ['path', { origin: `${base}/unexpected` }],
    ['query', { origin: `${base}?unexpected=1` }],
    ['fragment', { origin: `${base}#unexpected` }],
    ['multiple origins', { origin: `${base}, https://unrelated.example.test` }],
    ['same host wrong scheme', { origin: `https://127.0.0.1:${server.address().port}` }],
    ['same host wrong port', { origin: 'http://127.0.0.1:1' }],
    ['cross-site metadata', { 'sec-fetch-site': 'cross-site' }],
    ['same-site metadata without Origin', { 'sec-fetch-site': 'same-site' }],
  ];
  for (const [label, headers] of rejected) {
    const result = await post('/api/auth/bootstrap', { ...identity, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }, headers);
    assert.equal(result.status, 403, `${label} bootstrap must be rejected`);
    assert.doesNotMatch(result.setCookie, /odd_session=[^;]+/);
    assert.deepEqual(authState(), before, `${label} bootstrap leaves all auth state unchanged`);
  }

  const machineBootstrap = await post('/api/auth/bootstrap', identity);
  assert.equal(machineBootstrap.status, 403, 'a no-Origin machine JSON client reaches the setup-token check');
  const afterInvalidToken = authState();
  assert.deepEqual(afterInvalidToken.users, before.users, 'a missing setup token cannot create or replace the first user');
  assert.equal(afterInvalidToken.sessions, before.sessions, 'a missing setup token cannot issue another session');
  const ownerCookies = browserOwnerCookies;
  assert.ok(ownerCookies?.cookie && ownerCookies.csrf, 'the actual browser setup/login flow provided owner cookies');
  assert.equal((await fetch(`${base}/api/batches`, { headers: { cookie: ownerCookies.cookie } })).status, 200,
    'the Edge-issued browser session reaches an authenticated route');

  const stable = authState();
  for (const [label, headers] of rejected) {
    const result = await post('/api/auth/login', identity, headers);
    assert.equal(result.status, 403, `${label} login must be rejected`);
    assert.doesNotMatch(result.setCookie, /odd_session=[^;]+/);
    assert.deepEqual(authState(), stable, `${label} login does not run credential work or issue a session`);
  }

  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded']) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': contentType, origin: base },
      body: JSON.stringify(identity),
    });
    assert.equal(response.status, 415, `${contentType} cannot be used for JSON credentials`);
    await response.arrayBuffer();
    assert.deepEqual(authState(), stable, `${contentType} login leaves auth state unchanged`);
  }
  const charset = await post('/api/auth/login', identity, { origin: base, 'content-type': 'application/json; charset=utf-8' });
  assert.equal(charset.status, 200, 'the supported UTF-8 JSON charset remains accepted');
  assert.match(charset.setCookie, /odd_session=/);
  const machineLogin = await post('/api/auth/login', identity);
  assert.equal(machineLogin.status, 200, 'a JSON machine client with no Origin or browser fetch site still signs in');
  assert.match(machineLogin.setCookie, /odd_session=/);
  assert.equal((await fetch(`${base}/api/auth/status`, { headers: { cookie: authCookies(machineLogin.setCookie).cookie } }).then(r => r.json())).authenticated, true);

  const current = authState();
  const invitationToken = 'origin-valid-invitation-token-0123456789abcdef';
  db.prepare(`INSERT INTO auth_invitations(email,token_hash,role,invited_by,created_at,expires_at)
    VALUES (?,?,?,?,?,?)`).run('origin-invitee@example.test', createHash('sha256').update(invitationToken).digest('hex'),
    'operator', current.users[0].id, Date.now(), Date.now() + 60_000);
  const withInvitation = authState();
  for (const routeBody of [
    ['/api/auth/recover', { ...identity, recoveryToken: process.env.ODD_AUTH_RECOVERY_TOKEN }],
    ['/api/auth/invitations/accept', { email: 'origin-invitee@example.test', password: identity.password, invitationToken }],
    ['/api/auth/bootstrap', { ...identity, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }],
  ]) {
    const [route, body] = routeBody;
    const result = await post(route, body, { origin: 'https://unrelated.example.test' });
    assert.equal(result.status, 403, `${route} rejects a foreign origin`);
    assert.deepEqual(authState(), withInvitation, `${route} does not mutate authentication state`);
  }
  const foreignLogout = await post('/api/auth/logout', {}, {
    origin: 'https://unrelated.example.test', cookie: ownerCookies.cookie, 'x-csrf-token': ownerCookies.csrf,
  });
  assert.equal(foreignLogout.status, 403, 'foreign-origin logout cannot revoke a session');
  assert.equal((await fetch(`${base}/api/auth/status`, { headers: { cookie: ownerCookies.cookie } }).then(r => r.json())).authenticated, true);

  const googleNonce = await fetch(`${base}/api/auth/google/nonce`);
  assert.equal(googleNonce.status, 200);
  const nonceCookies = googleNonce.headers.get('set-cookie') || '';
  const nonceBefore = db.prepare('SELECT COUNT(*) AS count FROM auth_google_nonces WHERE consumed_at IS NULL').get().count;
  const rejectedGoogle = await post('/api/auth/google', { credential: 'synthetic-not-a-token' }, {
    origin: 'https://unrelated.example.test', cookie: nonceCookies.split(';')[0],
  });
  assert.equal(rejectedGoogle.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_google_nonces WHERE consumed_at IS NULL').get().count, nonceBefore,
    'foreign-origin Google callbacks do not consume a valid nonce');
  assert.deepEqual(authState(), withInvitation, 'foreign-origin Google callbacks do not issue sessions or mutate users');

  process.env.ODD_PUBLIC_BASE_URL = 'https://workspace.example.test';
  const proxied = await post('/api/auth/login', identity, { origin: 'https://workspace.example.test' });
  assert.equal(proxied.status, 200, 'the explicit HTTPS public base supports a reverse proxy');
  const spoofedForwarding = await post('/api/auth/login', identity, {
    origin: 'https://spoofed.example.test', 'x-forwarded-host': 'spoofed.example.test',
  });
  assert.equal(spoofedForwarding.status, 403, 'forwarded headers cannot select the trusted origin');
  process.env.ODD_PUBLIC_BASE_URL = 'not a valid origin';
  assert.equal((await post('/api/auth/login', identity, { origin: 'https://workspace.example.test' })).status, 403,
    'malformed explicit public-origin configuration fails closed');
  delete process.env.ODD_PUBLIC_BASE_URL;
  process.env.APP_URL = 'https://app-url.example.test';
  assert.equal((await post('/api/auth/login', identity, { origin: 'https://app-url.example.test' })).status, 200,
    'the existing APP_URL setting also supports an explicitly configured HTTPS proxy origin');
  delete process.env.APP_URL;
});

