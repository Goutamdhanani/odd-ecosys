import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-google-auth-'));
const clientId = '1234567890-fixture.apps.googleusercontent.com';
process.env.ODD_DB_PATH = path.join(directory, 'google-auth.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.GOOGLE_CLIENT_ID = clientId;
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'true';
delete process.env.ODD_AUTH_BOOTSTRAP_TOKEN;
process.env.PORT = '0';
delete process.env.HOST;

const keys = await generateKeyPair('RS256', { modulusLength: 2048 });
const publicJwk = await exportJWK(keys.publicKey);
publicJwk.kid = 'fixture-google-signing-key';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';
const originalFetch = globalThis.fetch;
let jwksRequests = 0;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') {
    jwksRequests += 1;
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
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
});

async function issueNonce() {
  const response = await originalFetch(`${base}/api/auth/google/nonce`);
  const body = await response.json();
  const setCookie = response.headers.get('set-cookie') || '';
  const nonceCookie = setCookie.match(/(?:^|,\s*)odd_google_nonce=([^;,]+)/)?.[1];
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.ok(nonceCookie);
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  return { nonce: body.nonce, cookie: `odd_google_nonce=${nonceCookie}`, setCookie };
}

async function signedCredential({ email, subject, nonce, claims = {}, issuer = 'https://accounts.google.com', audience = clientId, expiration = '5m' }) {
  return new SignJWT({ email_verified: true, ...claims, email, nonce })
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(keys.privateKey);
}

async function postCredential(credential, cookie, origin = base) {
  const response = await originalFetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ credential }),
  });
  return {
    status: response.status,
    body: await response.json(),
    setCookie: response.headers.get('set-cookie') || '',
  };
}

function sessionCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'successful provider sign-in issues the standard workspace session cookie');
  assert.ok(csrf, 'successful provider sign-in issues the standard CSRF cookie');
  return `odd_session=${decodeURIComponent(session)}; odd_csrf=${decodeURIComponent(csrf)}`;
}

test('Google-first owner setup, verified member linking, one-time nonce and auth boundaries work end to end', async () => {
  const beforeSetup = await originalFetch(`${base}/api/auth/status`).then(response => response.json());
  assert.equal(beforeSetup.setupRequired, true);
  assert.equal(beforeSetup.setupAvailable, false, 'no private bootstrap token is needed when the verified first-owner Google flow is used');
  assert.equal(beforeSetup.googleLoginAvailable, true);
  assert.equal(beforeSetup.googleClientId, clientId);

  const untrustedEmailNonce = await issueNonce();
  const untrustedEmail = await postCredential(
    await signedCredential({ email: 'owner@external-mail.test', subject: 'untrusted-email-subject', nonce: untrustedEmailNonce.nonce }),
    untrustedEmailNonce.cookie,
  );
  assert.equal(untrustedEmail.status, 401, 'a merely verified third-party email cannot claim or link a workspace account');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 0);

  const ownerNonce = await issueNonce();
  const ownerCredential = await signedCredential({ email: 'owner@gmail.com', subject: 'google-owner-subject', nonce: ownerNonce.nonce });
  const ownerLogin = await postCredential(ownerCredential, ownerNonce.cookie);
  assert.equal(ownerLogin.status, 200);
  const ownerCookie = sessionCookies(ownerLogin.setCookie);
  assert.match(ownerLogin.setCookie, /odd_google_nonce=; Path=\/api\/auth\/google; Max-Age=0/);
  assert.deepEqual(db.prepare('SELECT email,role,google_sub FROM auth_users').all(), [
    { email: 'owner@gmail.com', role: 'owner', google_sub: 'google-owner-subject' },
  ]);
  assert.equal((await originalFetch(`${base}/api/auth/status`, { headers: { cookie: ownerCookie } }).then(response => response.json())).authenticated, true);

  const replay = await postCredential(ownerCredential, ownerNonce.cookie);
  assert.equal(replay.status, 401, 'a second request cannot reuse the consumed nonce');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get().count, 1);

  const raceNonce = await issueNonce();
  const raceCredential = await signedCredential({ email: 'owner@gmail.com', subject: 'google-owner-subject', nonce: raceNonce.nonce });
  const racedCallbacks = await Promise.all([
    postCredential(raceCredential, raceNonce.cookie),
    postCredential(raceCredential, raceNonce.cookie),
  ]);
  assert.deepEqual(racedCallbacks.map(result => result.status).sort(), [200, 401],
    'the nonce is consumed atomically so concurrent credential replays cannot both establish sessions');

  const crossSiteNonce = await issueNonce();
  const crossSite = await postCredential(
    await signedCredential({ email: 'owner@gmail.com', subject: 'google-owner-subject', nonce: crossSiteNonce.nonce }),
    crossSiteNonce.cookie,
    'https://attacker.example',
  );
  assert.equal(crossSite.status, 403);

  const memberNonce = await issueNonce();
  const ownerToken = decodeURIComponent(ownerCookie.match(/odd_session=([^;]+)/)[1]);
  const ownerSession = auth.currentSession(ownerToken);
  const invitation = auth.createInvitation({ actor: ownerSession, email: 'member@oddwebs.shop', role: 'operator', remoteAddress: '127.0.0.1' });
  await auth.acceptInvitation({
    email: 'member@oddwebs.shop', password: 'fixture-member-password-123',
    invitationToken: invitation.invitation.token, remoteAddress: '127.0.0.1',
  });
  const memberCredential = await signedCredential({
    email: 'member@oddwebs.shop', subject: 'google-member-subject', nonce: memberNonce.nonce, claims: { hd: 'oddwebs.shop' },
  });
  const memberLogin = await postCredential(memberCredential, memberNonce.cookie);
  assert.equal(memberLogin.status, 200, 'an invited active member can link the matching authoritative verified Google email');
  assert.equal(db.prepare('SELECT google_sub FROM auth_users WHERE email=?').get('member@oddwebs.shop').google_sub, 'google-member-subject');
  assert.equal(auth.currentSession(sessionCookies(memberLogin.setCookie).match(/odd_session=([^;]+)/)[1]).role, 'operator');

  const relinkNonce = await issueNonce();
  const relink = await postCredential(
    await signedCredential({ email: 'member@oddwebs.shop', subject: 'different-google-subject', nonce: relinkNonce.nonce, claims: { hd: 'oddwebs.shop' } }),
    relinkNonce.cookie,
  );
  assert.equal(relink.status, 401, 'a linked member cannot replace their Google subject by matching email alone');

  const unknownNonce = await issueNonce();
  const unknown = await postCredential(
    await signedCredential({ email: 'unknown@gmail.com', subject: 'uninvited-google-subject', nonce: unknownNonce.nonce }),
    unknownNonce.cookie,
  );
  assert.equal(unknown.status, 401, 'Google sign-in cannot provision an additional uninvited workspace member');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 2);

  const invalidNonce = await issueNonce();
  const wrongAudience = await postCredential(
    await signedCredential({ email: 'owner@gmail.com', subject: 'google-owner-subject', nonce: invalidNonce.nonce, audience: 'different-client.apps.googleusercontent.com' }),
    invalidNonce.cookie,
  );
  assert.equal(wrongAudience.status, 401, 'a correctly signed token for another client is rejected');

  const unverifiedNonce = await issueNonce();
  const unverified = await postCredential(
    await signedCredential({ email: 'unverified@gmail.com', subject: 'unverified-subject', nonce: unverifiedNonce.nonce, claims: { email_verified: false } }),
    unverifiedNonce.cookie,
  );
  assert.equal(unverified.status, 401, 'unverified Google email claims are rejected');

  const badIssuerNonce = await issueNonce();
  const badIssuer = await postCredential(
    await signedCredential({ email: 'wrong-issuer@gmail.com', subject: 'wrong-issuer-subject', nonce: badIssuerNonce.nonce, issuer: 'https://accounts.evil.example' }),
    badIssuerNonce.cookie,
  );
  assert.equal(badIssuer.status, 401, 'a non-Google issuer is rejected');

  const expiredNonce = await issueNonce();
  const expired = await postCredential(
    await signedCredential({ email: 'expired@gmail.com', subject: 'expired-subject', nonce: expiredNonce.nonce, expiration: new Date(Date.now() - 60_000) }),
    expiredNonce.cookie,
  );
  assert.equal(expired.status, 401, 'expired credentials are rejected');

  const mismatchedNonce = await issueNonce();
  const nonceMismatch = await postCredential(
    await signedCredential({ email: 'owner@gmail.com', subject: 'google-owner-subject', nonce: 'different-one-time-nonce-value-1234567890' }),
    mismatchedNonce.cookie,
  );
  assert.equal(nonceMismatch.status, 401, 'the signed credential must contain the browser nonce bound to its one-time cookie');

  const rateLimitedNonce = await issueNonce();
  const rateLimited = await postCredential(
    await signedCredential({ email: 'owner@gmail.com', subject: 'google-owner-subject', nonce: rateLimitedNonce.nonce }),
    rateLimitedNonce.cookie,
  );
  assert.equal(rateLimited.status, 429, 'repeated invalid provider credentials are throttled by source address');
  assert.ok(jwksRequests >= 1, 'signature verification used the injected synthetic Google signing-key response');
  const savedNonce = db.prepare('SELECT nonce_hash,consumed_at FROM auth_google_nonces ORDER BY expires_at LIMIT 1').get();
  assert.equal(savedNonce.nonce_hash.length, 64, 'the database stores only a nonce digest, never the browser nonce or ID token');
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type LIKE \'google_%\'').get().count >= 4);
});

