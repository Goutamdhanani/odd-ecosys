import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-google-existing-owner-'));
const clientId = '1234567890-existing-owner.apps.googleusercontent.com';
process.env.ODD_DB_PATH = path.join(directory, 'workspace.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.GOOGLE_CLIENT_ID = clientId;
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'synthetic-bootstrap-token-with-more-than-32-characters';
process.env.PORT = '0';
delete process.env.HOST;

const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
const publicJwk = Object.assign(await exportJWK(pair.publicKey), { kid: 'existing-owner-key', alg: 'RS256', use: 'sig' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') {
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
    });
  }
  return originalFetch(input, options);
};

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { createAuthManager } = await import('../pipeline/auth-manager.js');
createAuthManager(db);
const inserted = db.prepare(`INSERT INTO auth_users(email,password_salt,password_hash,role)
  VALUES('goutamdhanani@gmail.com','synthetic-salt','synthetic-password-hash','owner')`).run();
const ownerId = Number(inserted.lastInsertRowid);
const { server } = await import('../server.js');
if (!server.listening) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
  });
}
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
  const rawCookie = response.headers.get('set-cookie') || '';
  const cookie = rawCookie.match(/(?:^|,\s*)odd_google_nonce=([^;,]+)/)?.[1];
  assert.equal(response.status, 200);
  assert.ok(cookie);
  return { nonce: body.nonce, cookie: `odd_google_nonce=${cookie}` };
}

async function signIn(email, subject, nonceCookie) {
  const { nonce } = nonceCookie;
  const token = await new SignJWT({ email_verified: true, email, nonce })
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })
    .setIssuer('https://accounts.google.com')
    .setAudience(clientId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
  return originalFetch(`${base}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie: nonceCookie.cookie },
    body: JSON.stringify({ credential: token }),
  });
}

test('existing .com owner links verified Google login; .con cannot create an account or reopen setup', async () => {
  const before = await originalFetch(`${base}/api/auth/status`).then(response => response.json());
  assert.equal(before.setupRequired, false);
  assert.equal(before.setupAvailable, false);
  assert.equal(before.googleLoginAvailable, true);

  const ownerNonce = await issueNonce();
  const ownerResponse = await signIn('goutamdhanani@gmail.com', 'existing-goutam-owner', ownerNonce);
  assert.equal(ownerResponse.status, 200);
  const ownerCookies = ownerResponse.headers.get('set-cookie') || '';
  const session = ownerCookies.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  assert.ok(session);
  const owner = db.prepare('SELECT id,email,role,google_sub,is_active FROM auth_users WHERE id=?').get(ownerId);
  assert.deepEqual(owner, {
    id: ownerId, email: 'goutamdhanani@gmail.com', role: 'owner',
    google_sub: 'existing-goutam-owner', is_active: 1,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 1);

  const typoNonce = await issueNonce();
  const typo = await signIn('goutamdhanani@gmail.con', 'goutam-typo-owner', typoNonce);
  assert.equal(typo.status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_users WHERE email='goutamdhanani@gmail.con'").get().count, 0);

  const bootstrapResponse = await originalFetch(`${base}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'other@example.com', password: 'synthetic-long-password-123', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
  });
  assert.equal(bootstrapResponse.status, 409, 'valid setup token cannot create a second owner after account setup');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});
