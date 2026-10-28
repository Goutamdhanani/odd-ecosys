import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-auth-session-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-private-bootstrap-token-0123456789';
process.env.ODD_AUTH_RECOVERY_TOKEN = 'fixture-private-recovery-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'true';
process.env.GOOGLE_CLIENT_ID = '714630939237-1be5d3rv8rephvtugp6one5aispfqecg.apps.googleusercontent.com';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '', redirect = 'follow' } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect,
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookie: response.headers.get('set-cookie') || '',
    body: contentType.includes('json') ? await response.json() : await response.text(),
  };
}

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'server must issue a session cookie');
  assert.ok(csrf, 'server must issue a CSRF cookie');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

test('first-admin bootstrap, authenticated API, CSRF, rate limit, session expiry and logout work end to end', async () => {
  const status = await request('/api/auth/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, {
    authenticated: false, user: null, setupRequired: true, setupAvailable: true, recoveryAvailable: false,
    googleLoginAvailable: true,
    googleClientId: '714630939237-1be5d3rv8rephvtugp6one5aispfqecg.apps.googleusercontent.com',
  });
  const configuredToken = process.env.ODD_AUTH_BOOTSTRAP_TOKEN;
  delete process.env.ODD_AUTH_BOOTSTRAP_TOKEN;
  assert.equal((await request('/api/auth/status')).body.setupAvailable, false);
  assert.equal((await request('/api/auth/bootstrap', { method: 'POST', body: { email: 'admin@example.test', password: 'long-enough-fixture-password' } })).status, 503);
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = configuredToken;

  const anonymousApi = await request('/api/batches');
  assert.equal(anonymousApi.status, 401);
  const anonymousRoot = await request('/', { redirect: 'manual' });
  assert.equal(anonymousRoot.status, 302);
  assert.equal(anonymousRoot.location, '/login');
  const loginShell = await request('/login');
  assert.equal(loginShell.status, 200);
  assert.match(loginShell.body, /src="js\/app\.js"/);
  const loginApp = await request('/js/app.js');
  assert.equal(loginApp.status, 200);
  assert.match(loginApp.body, /id="auth-form"/);
  assert.equal((await request('/css/auth.css')).status, 200, 'the login shell may load its static assets');
  const sharedClassification = await request('/shared/verification-classification.js');
  assert.equal(sharedClassification.status, 200, 'the UI classification module must load before authentication');
  assert.match(sharedClassification.body, /deriveVerificationClassification/);
  assert.equal((await request('/shared/auth-manager.js', { redirect: 'manual' })).status, 404,
    'source files outside the public static allowlist remain unavailable');
  const emblem = await fetch(`${base}/assets/odd-ecosys-emblem.png`);
  assert.equal(emblem.status, 200, 'the supplied product emblem is served from the app');
  assert.match(emblem.headers.get('content-type') || '', /image\/png/);
  assert.ok((await emblem.arrayBuffer()).byteLength > 100_000);

  const invalidToken = await request('/api/auth/bootstrap', {
    method: 'POST', body: { email: 'admin@example.test', password: 'long-enough-fixture-password', bootstrapToken: 'wrong-token' },
  });
  assert.equal(invalidToken.status, 403);
  for (let index = 0; index < 4; index++) {
    assert.equal((await request('/api/auth/bootstrap', {
      method: 'POST', body: { email: 'admin@example.test', password: 'long-enough-fixture-password', bootstrapToken: 'wrong-token' },
    })).status, 403);
  }
  assert.equal((await request('/api/auth/bootstrap', {
    method: 'POST', body: { email: 'admin@example.test', password: 'long-enough-fixture-password', bootstrapToken: 'wrong-token' },
  })).status, 429);
  db.prepare("DELETE FROM auth_login_attempts WHERE attempt_key=(SELECT attempt_key FROM auth_login_attempts LIMIT 1)").run();
  const weakPassword = await request('/api/auth/bootstrap', {
    method: 'POST', body: { email: 'admin@example.test', password: 'short', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
  });
  assert.equal(weakPassword.status, 400);

  const password = 'Fixture-only-password-9!';
  const bootstrapAttempts = await Promise.all([
    request('/api/auth/bootstrap', {
      method: 'POST', body: { email: ' Admin@Example.Test ', password, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
    }),
    request('/api/auth/bootstrap', {
      method: 'POST', body: { email: 'admin@example.test', password, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
    }),
  ]);
  const created = bootstrapAttempts.find(result => result.status === 201);
  const racedBootstrap = bootstrapAttempts.find(result => result.status === 409);
  assert.ok(created, 'exactly one concurrent first-account request must win');
  assert.ok(racedBootstrap, 'the other concurrent first-account request must be denied');
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { ok: true, user: { id: 1, email: 'admin@example.test', role: 'owner' } });
  const bootstrapSession = authCookies(created.setCookie);
  const user = db.prepare('SELECT email,password_salt,password_hash FROM auth_users').get();
  assert.equal(user.email, 'admin@example.test');
  assert.equal(user.password_salt.length, 32);
  assert.equal(user.password_hash.length, 64);
  assert.notEqual(user.password_hash, password);
  assert.equal((await request('/api/auth/status')).body.setupRequired, false);
  assert.equal((await request('/api/auth/status')).body.recoveryAvailable, true);
  assert.equal((await request('/', { cookie: bootstrapSession.cookie, redirect: 'manual' })).status, 200);
  assert.equal((await request('/api/batches', { cookie: bootstrapSession.cookie })).status, 200);

  const csrfDenied = await request('/api/batches', {
    method: 'POST', cookie: bootstrapSession.cookie, body: { name: 'Must not be created' },
  });
  assert.equal(csrfDenied.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM batches').get().count, 0);
  const wrongCsrf = await request('/api/batches', {
    method: 'POST', cookie: bootstrapSession.cookie, csrf: 'wrong-token', body: { name: 'Still blocked' },
  });
  assert.equal(wrongCsrf.status, 403);
  const createdBatch = await request('/api/batches', {
    method: 'POST', cookie: bootstrapSession.cookie, csrf: bootstrapSession.csrf, body: { name: 'Private fixture', phase: 'discovery' },
  });
  assert.equal(createdBatch.status, 201);
  assert.equal(createdBatch.body.name, 'Private fixture');

  for (let index = 0; index < 5; index++) {
    const denied = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password: 'incorrect fixture password' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error, 'Email or password was not accepted.');
  }
  const throttled = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password } });
  assert.equal(throttled.status, 429);
  db.prepare('UPDATE auth_login_attempts SET failures=0,locked_until=0').run();

  const badPassword = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password: 'incorrect fixture password' } });
  assert.equal(badPassword.status, 401);
  process.env.ODD_AUTH_COOKIE_SECURE = 'true';
  const loggedIn = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password } });
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.setCookie, /Secure/i);
  const activeSession = authCookies(loggedIn.setCookie);
  assert.equal((await request('/api/batches', { cookie: activeSession.cookie })).status, 200);
  assert.equal((await request('/api/auth/events')).status, 401);
  const audit = await request('/api/auth/events?limit=2', { cookie: activeSession.cookie });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.events[0].event_type, 'sign_in');
  assert.equal('source_hash' in audit.body.events[0], false);

  const recoveryPassword = 'Recovered-fixture-password-4!';
  for (let index = 0; index < 5; index++) {
    assert.equal((await request('/api/auth/recover', {
      method: 'POST', body: { email: user.email, password: recoveryPassword, recoveryToken: 'wrong-recovery-token' },
    })).status, 403);
  }
  assert.equal((await request('/api/auth/recover', {
    method: 'POST', body: { email: user.email, password: recoveryPassword, recoveryToken: process.env.ODD_AUTH_RECOVERY_TOKEN },
  })).status, 429);
  db.prepare('DELETE FROM auth_login_attempts').run();

  const missingAccountRecovery = await request('/api/auth/recover', {
    method: 'POST', body: { email: 'nobody@example.test', password: recoveryPassword, recoveryToken: process.env.ODD_AUTH_RECOVERY_TOKEN },
  });
  const reset = await request('/api/auth/recover', {
    method: 'POST', body: { email: user.email, password: recoveryPassword, recoveryToken: process.env.ODD_AUTH_RECOVERY_TOKEN },
  });
  assert.equal(missingAccountRecovery.status, 200);
  assert.deepEqual(reset.body, missingAccountRecovery.body, 'recovery response must not reveal whether the email exists');
  assert.equal((await request('/api/batches', { cookie: activeSession.cookie })).status, 401);
  assert.equal((await request('/api/batches', { cookie: bootstrapSession.cookie })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: user.email, password } })).status, 401);
  const recoveredLogin = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password: recoveryPassword } });
  assert.equal(recoveredLogin.status, 200);
  const recoveredSession = authCookies(recoveredLogin.setCookie);
  assert.equal((await request('/api/auth/events', { cookie: recoveredSession.cookie })).body.events[0].event_type, 'sign_in');
  assert.ok((await request('/api/auth/events', { cookie: recoveredSession.cookie })).body.events.some(event => event.event_type === 'password_recovered'));

  const logoutWithoutCsrf = await request('/api/auth/logout', { method: 'POST', cookie: recoveredSession.cookie });
  assert.equal(logoutWithoutCsrf.status, 403);
  const logout = await request('/api/auth/logout', { method: 'POST', cookie: recoveredSession.cookie, csrf: recoveredSession.csrf });
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/batches', { cookie: recoveredSession.cookie })).status, 401);

  const secondLogin = await request('/api/auth/login', { method: 'POST', body: { email: user.email, password: recoveryPassword } });
  assert.equal(secondLogin.status, 200);
  const expiringSession = authCookies(secondLogin.setCookie);
  const sessionToken = decodeURIComponent(expiringSession.cookie.match(/odd_session=([^;]+)/)[1]);
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  db.prepare('UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?').run(tokenHash);
  assert.equal((await request('/api/batches', { cookie: expiringSession.cookie })).status, 401);
  assert.equal((await request('/api/auth/status', { cookie: expiringSession.cookie })).body.authenticated, false);

  const secondBootstrap = await request('/api/auth/bootstrap', {
    method: 'POST', body: { email: 'intruder@example.test', password, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
  });
  assert.equal(secondBootstrap.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 1);
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type=?').get('password_recovered').count >= 1);
});
