import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { decodeBase32, totpCode } from '../pipeline/totp.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-auth-mfa-'));
const clientId = '1234567890-mfa-fixture.apps.googleusercontent.com';
const password = 'fixture-owner-password-2026';
const FIXED_NOW = 1_800_000_000_000;
process.env.ODD_DB_PATH = path.join(directory, 'workspace.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-private-bootstrap-token-0123456789';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = '7a'.repeat(32);
process.env.GOOGLE_CLIENT_ID = clientId;
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'true';
process.env.PORT = '0';
delete process.env.HOST;

const keyPair = await generateKeyPair('RS256', { modulusLength: 2048 });
const publicJwk = await exportJWK(keyPair.publicKey);
Object.assign(publicJwk, { kid: 'mfa-fixture-signing-key', alg: 'RS256', use: 'sig' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') {
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
    });
  }
  return originalFetch(input, options);
};

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { createAuthManager } = await import('../pipeline/auth-manager.js');
const auth = createAuthManager(db);
const { decryptCredential } = await import('../pipeline/credential-vault.js');
const { server } = await import('../server.js');
if (!server.listening) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
const base = `http://127.0.0.1:${server.address().port}`;
const realNow = Date.now;
let activeNow = FIXED_NOW;
Date.now = () => activeNow;

after(async () => {
  Date.now = realNow;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  globalThis.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '', origin = base } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (origin) headers.origin = origin;
  const response = await originalFetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    setCookie: response.headers.get('set-cookie') || '',
    body: await response.json(),
  };
}

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'successful sign-in issues an HttpOnly workspace session');
  assert.ok(csrf, 'successful sign-in issues the matching CSRF cookie');
  return { cookie: `odd_session=${decodeURIComponent(session)}; odd_csrf=${decodeURIComponent(csrf)}`, csrf: decodeURIComponent(csrf) };
}

async function signedGoogleCredential(nonce) {
  return new SignJWT({ email: 'mfa-owner@gmail.com', email_verified: true, nonce })
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })
    .setIssuer('https://accounts.google.com')
    .setAudience(clientId)
    .setSubject('mfa-google-owner-subject')
    .setIssuedAt(Math.floor(realNow() / 1000))
    .setExpirationTime(Math.floor(realNow() / 1000) + 300)
    .sign(keyPair.privateKey);
}

test('TOTP protects password, Google and invitation sign-in; one-time recovery and Settings UI work end to end', async t => {
  const bootstrapped = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: { email: 'mfa-owner@gmail.com', password, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
  });
  assert.equal(bootstrapped.status, 201);
  const owner = authCookies(bootstrapped.setCookie);
  assert.equal((await request('/api/auth/mfa/status')).status, 401);
  assert.equal((await request('/api/auth/mfa/status', { cookie: owner.cookie })).body.enabled, false);
  assert.equal((await request('/api/auth/mfa/enroll', { method: 'POST', cookie: owner.cookie })).status, 403,
    'enrollment mutation requires both a CSRF token and same-origin request');

  const enrollment = await request('/api/auth/mfa/enroll', { method: 'POST', cookie: owner.cookie, csrf: owner.csrf });
  assert.equal(enrollment.status, 201);
  assert.match(enrollment.body.otpauthUri, /^otpauth:\/\/totp\//);
  const pending = db.prepare('SELECT mfa_pending_enc FROM auth_users WHERE email=?').get('mfa-owner@gmail.com');
  assert.match(pending.mfa_pending_enc, /^oddc1:/);
  assert.equal(decryptCredential(pending.mfa_pending_enc), enrollment.body.secret);
  assert.equal(JSON.stringify(pending).includes(enrollment.body.secret), false, 'the pending TOTP secret is encrypted in SQLite');

  const enabled = await request('/api/auth/mfa/enroll/confirm', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf, body: { code: totpCode(decodeBase32(enrollment.body.secret), FIXED_NOW - 30_000) },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recoveryCodes.length, 10);
  const originalRecoveryCodes = enabled.body.recoveryCodes;
  assert.ok(originalRecoveryCodes.every(code => /^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/.test(code)));
  assert.equal(auth.mfaStatus(auth.currentSession(owner.cookie.split(';')[0].slice('odd_session='.length))).enabled, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_mfa_recovery_codes WHERE user_id=1 AND used_at IS NULL').get().count, 10);
  assert.equal(JSON.stringify(db.prepare('SELECT code_hash FROM auth_mfa_recovery_codes').all()).includes(originalRecoveryCodes[0].replaceAll('-', '')), false,
    'recovery codes are stored only as hashes');
  const savedEnabledAt = db.prepare('SELECT mfa_enabled_at FROM auth_users WHERE id=1').get().mfa_enabled_at;
  db.prepare('UPDATE auth_users SET mfa_enabled_at=NULL WHERE id=1').run();
  const incompleteMfaLogin = await request('/api/auth/login', { method: 'POST', body: { email: 'mfa-owner@gmail.com', password } });
  assert.equal(incompleteMfaLogin.status, 503, 'inconsistent MFA state fails closed instead of issuing a password-only session');
  db.prepare('UPDATE auth_users SET mfa_enabled_at=? WHERE id=1').run(savedEnabledAt);

  const ownerActor = auth.currentSession(owner.cookie.split(';')[0].slice('odd_session='.length));
  const firstAdminInvite = auth.createInvitation({ actor: ownerActor, email: 'mfa-admin@example.test', role: 'admin', remoteAddress: '127.0.0.1' }).invitation;
  const firstAdminSignIn = await auth.acceptInvitation({
    email: firstAdminInvite.email, password: 'fixture-admin-password-2026', invitationToken: firstAdminInvite.token, remoteAddress: '127.0.0.1',
  });
  const firstAdminActor = auth.currentSession(firstAdminSignIn.sessionToken);
  const adminEnrollment = auth.beginMfaEnrollment(firstAdminActor, '127.0.0.1');
  assert.equal(auth.confirmMfaEnrollment(firstAdminActor,
    totpCode(decodeBase32(adminEnrollment.secret), FIXED_NOW - 30_000), '127.0.0.1').enabled, true);
  const adminId = firstAdminActor.id;
  const savedAdminSecret = db.prepare('SELECT mfa_secret_enc FROM auth_users WHERE id=?').get(adminId).mfa_secret_enc;
  auth.deactivateMember({ actor: ownerActor, memberId: adminId, remoteAddress: '127.0.0.1' });
  const reactivationInvite = auth.createInvitation({ actor: ownerActor, email: 'mfa-admin@example.test', role: 'admin', remoteAddress: '127.0.0.1' }).invitation;
  const reactivated = await auth.acceptInvitation({
    email: reactivationInvite.email, password: 'fixture-admin-password-2027', invitationToken: reactivationInvite.token, remoteAddress: '127.0.0.1',
  });
  assert.equal(reactivated.mfaRequired, true, 'reactivating an invited account cannot bypass its enrolled MFA');
  assert.equal(db.prepare('SELECT mfa_secret_enc FROM auth_users WHERE id=?').get(adminId).mfa_secret_enc, savedAdminSecret,
    'invitation reactivation preserves the encrypted authenticator secret');
  assert.equal((await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: reactivated.challengeToken, code: totpCode(decodeBase32(adminEnrollment.secret), FIXED_NOW) },
  })).status, 200);
  const invitationChallengeHash = createHash('sha256').update(reactivated.challengeToken).digest('hex');
  assert.equal(db.prepare('SELECT method FROM auth_mfa_challenges WHERE challenge_hash=?').get(invitationChallengeHash).method, 'invitation');

  const firstChallenge = await request('/api/auth/login', { method: 'POST', body: { email: 'mfa-owner@gmail.com', password } });
  assert.equal(firstChallenge.status, 200);
  assert.equal(firstChallenge.body.mfaRequired, true);
  assert.equal(Boolean(firstChallenge.setCookie.match(/odd_session=;[^,]*Max-Age=0/)), true, 'password success does not issue a session cookie before MFA');
  assert.equal((await request('/api/auth/status')).body.authenticated, false);
  const sourceChallengeCount = db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=1 AND revoked_at IS NULL').get().count;
  assert.equal(sourceChallengeCount, 1, 'challenge creation does not create a session');
  assert.equal((await request('/api/auth/mfa/challenge', {
    method: 'POST', origin: 'https://attacker.test', body: { challengeToken: firstChallenge.body.challengeToken, code: originalRecoveryCodes[0] },
  })).status, 403, 'challenge completion rejects cross-origin requests');

  const currentCode = totpCode(decodeBase32(enrollment.body.secret), FIXED_NOW);
  const adjacentCodes = new Set([-30_000, 0, 30_000].map(offset => totpCode(decodeBase32(enrollment.body.secret), FIXED_NOW + offset)));
  const wrongCode = ['000000', '999999', '123456'].find(code => !adjacentCodes.has(code));
  const rejectedFactor = await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: firstChallenge.body.challengeToken, code: wrongCode },
  });
  assert.equal(rejectedFactor.status, 401);
  const acceptedFactor = await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: firstChallenge.body.challengeToken, code: currentCode },
  });
  assert.equal(acceptedFactor.status, 200);
  const passwordSession = authCookies(acceptedFactor.setCookie);
  assert.equal((await request('/api/auth/status', { cookie: passwordSession.cookie })).body.authenticated, true);
  assert.equal((await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: firstChallenge.body.challengeToken, code: currentCode },
  })).status, 401, 'a completed sign-in challenge cannot be replayed');

  const replayChallenge = await request('/api/auth/login', { method: 'POST', body: { email: 'mfa-owner@gmail.com', password } });
  assert.equal(replayChallenge.body.mfaRequired, true);
  assert.equal((await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: replayChallenge.body.challengeToken, code: currentCode },
  })).status, 401, 'an accepted TOTP time step cannot be reused on a different challenge');
  const recoveryLogin = await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: replayChallenge.body.challengeToken, code: originalRecoveryCodes[0] },
  });
  assert.equal(recoveryLogin.status, 200, 'an unused one-time recovery code can complete the challenge');
  const usedRecoveryHash = createHash('sha256').update(`mfa-recovery\0${originalRecoveryCodes[0].replaceAll('-', '')}`).digest('hex');
  assert.ok(db.prepare('SELECT used_at FROM auth_mfa_recovery_codes WHERE user_id=1 AND code_hash=?').get(usedRecoveryHash)?.used_at);
  const recoveryReplay = await request('/api/auth/login', { method: 'POST', body: { email: 'mfa-owner@gmail.com', password } });
  assert.equal((await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: recoveryReplay.body.challengeToken, code: originalRecoveryCodes[0] },
  })).status, 401, 'a recovery code cannot be reused after it was consumed');

  const nonceResponse = await originalFetch(`${base}/api/auth/google/nonce`);
  const nonceBody = await nonceResponse.json();
  const nonceCookie = nonceResponse.headers.get('set-cookie').match(/odd_google_nonce=([^;,]+)/)?.[1];
  const googleCredential = await signedGoogleCredential(nonceBody.nonce);
  const googleResponse = await originalFetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: `odd_google_nonce=${nonceCookie}` },
    body: JSON.stringify({ credential: googleCredential }),
  });
  const googleChallenge = await googleResponse.json();
  assert.equal(googleResponse.status, 200);
  assert.equal(googleChallenge.mfaRequired, true, 'verified Google login also requires the second factor');
  assert.match(googleResponse.headers.get('set-cookie') || '', /odd_session=;[^,]*Max-Age=0/);
  const googleCompletion = await request('/api/auth/mfa/challenge', {
    method: 'POST', body: { challengeToken: googleChallenge.challengeToken, code: originalRecoveryCodes[1] },
  });
  assert.equal(googleCompletion.status, 200);
  assert.equal(db.prepare('SELECT method FROM auth_mfa_challenges WHERE challenge_hash=?').get(
    (await import('node:crypto')).createHash('sha256').update(googleChallenge.challengeToken).digest('hex'),
  ).method, 'google');

  if (!fs.existsSync(EDGE_PATH)) {
    t.diagnostic('Browser portion skipped: no local Edge runtime is installed.');
    assert.equal((await auth.disableMfa(auth.currentSession(owner.cookie.split(';')[0].slice('odd_session='.length)), {
      password, code: originalRecoveryCodes[4], remoteAddress: '127.0.0.1',
    })).ok, true);
  } else {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    try {
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Email address').fill('mfa-owner@gmail.com');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('heading', { name: 'Verify it’s you' }).waitFor();
      await page.getByLabel('Authenticator or recovery code').fill(totpCode(decodeBase32(enrollment.body.secret), FIXED_NOW + 30_000));
      await page.getByRole('button', { name: 'Verify and continue' }).click();
      await page.waitForURL(`${base}/`, { timeout: 10_000 });
      await page.getByRole('button', { name: 'mfa-owner@gmail.com' }).waitFor({ timeout: 10_000 });

      await page.locator('#workspace-navigation [data-view="settings"]').click();
      await page.locator('#mfa-regenerate').waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Replace recovery codes' }).click();
      const recoveryDialog = page.getByRole('dialog', { name: 'Replace recovery codes' });
      await recoveryDialog.getByLabel('Account password').fill(password);
      await recoveryDialog.getByLabel('Authenticator or recovery code').fill(originalRecoveryCodes[2]);
      await recoveryDialog.getByRole('button', { name: 'Replace codes' }).click();
      const codesDialog = page.getByRole('dialog', { name: 'Save your new recovery codes' });
      await codesDialog.waitFor({ timeout: 10_000 });
      const rotatedCodes = await codesDialog.locator('.settings-recovery-codes code').allTextContents();
      assert.equal(rotatedCodes.length, 10);
      assert.notDeepEqual(rotatedCodes, originalRecoveryCodes, 'recovery codes are replaced and shown in the settings UI');
      await codesDialog.getByRole('button', { name: 'Close dialog' }).click();
      await page.locator('#mfa-disable').waitFor();

      const oldCodeChallenge = await request('/api/auth/login', { method: 'POST', body: { email: 'mfa-owner@gmail.com', password } });
      assert.equal((await request('/api/auth/mfa/challenge', {
        method: 'POST', body: { challengeToken: oldCodeChallenge.body.challengeToken, code: originalRecoveryCodes[3] },
      })).status, 401, 'regeneration invalidates all old recovery codes');
      assert.equal((await request('/api/auth/mfa/challenge', {
        method: 'POST', body: { challengeToken: oldCodeChallenge.body.challengeToken, code: rotatedCodes[1] },
      })).status, 200);

      await page.getByRole('button', { name: 'Disable authenticator MFA' }).click();
      const disableDialog = page.getByRole('dialog', { name: 'Disable authenticator MFA' });
      await disableDialog.getByLabel('Account password').fill(password);
      await disableDialog.getByLabel('Authenticator or recovery code').fill(rotatedCodes[0]);
      await disableDialog.getByRole('button', { name: 'Disable MFA' }).click();
      await page.getByRole('heading', { name: 'Add authenticator sign-in' }).waitFor({ timeout: 10_000 });
      assert.equal((await request('/api/auth/status', { cookie: owner.cookie })).body.authenticated, true,
        'disabling MFA preserves previously issued valid sessions');
      assert.deepEqual(pageErrors, [], 'the real SPA MFA challenge and settings interactions run without browser exceptions');
    } finally {
      await context.close();
      await browser.close();
    }
  }

  const afterDisable = await request('/api/auth/mfa/status', { cookie: owner.cookie });
  assert.equal(afterDisable.body.enabled, false);
  assert.equal(db.prepare('SELECT mfa_secret_enc,mfa_pending_enc FROM auth_users WHERE email=?').get('mfa-owner@gmail.com').mfa_secret_enc, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_mfa_recovery_codes WHERE user_id=1').get().count, 0);
  const passwordOnly = await request('/api/auth/login', { method: 'POST', body: { email: 'mfa-owner@gmail.com', password } });
  assert.equal(passwordOnly.body.mfaRequired, undefined, 'password login returns to the existing session flow after MFA is disabled');
  assert.match(passwordOnly.setCookie, /odd_session=[^;,]+/);
});
