import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'odd-static-privacy-'));
const canaryDirectory = `.runner/astra-static-privacy-${randomBytes(8).toString('hex')}`;
const canaryPath = path.join(root, canaryDirectory, 'canary.txt');
const canaryValue = `synthetic-static-privacy-canary-${randomBytes(16).toString('hex')}`;
mkdirSync(path.dirname(canaryPath), { recursive: true });
writeFileSync(canaryPath, canaryValue, { flag: 'wx' });

process.env.ODD_DB_PATH = path.join(dbDirectory, 'fixture.sqlite');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = `synthetic-bootstrap-${randomBytes(24).toString('hex')}`;
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ASTRA_TENANT_MODE = '0';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(dbDirectory, { recursive: true, force: true });
  // This is the exact test-owned directory; no other .runner data is enumerated or removed.
  rmSync(path.dirname(canaryPath), { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '', redirect = 'manual' } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, redirect, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

function rawRequest(requestPath, { method = 'GET', cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method,
      headers: cookie ? { cookie } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('static reads stay within the public browser surface for anonymous, owner, and low-role sessions', async () => {
  const ownerCreated = await request('/api/auth/bootstrap', { method: 'POST', body: {
    email: 'static-owner@example.test', password: 'Synthetic-owner-password-92!',
    bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
  } });
  assert.equal(ownerCreated.status, 201);
  const owner = authCookies(ownerCreated.setCookie);

  const invitationResponse = await request('/api/workspace/invitations', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { email: 'static-reviewer@example.test', role: 'reviewer' },
  });
  assert.equal(invitationResponse.status, 201);
  const invitation = invitationResponse.body.invitation;
  const reviewerCreated = await request('/api/auth/invitations/accept', { method: 'POST', body: {
    email: invitation.email, password: 'Synthetic-reviewer-password-17!', invitationToken: invitation.token,
  } });
  assert.equal(reviewerCreated.status, 201);
  const reviewer = authCookies(reviewerCreated.setCookie);
  const reviewerRow = db.prepare('SELECT role FROM auth_users WHERE email=?').get(invitation.email);
  assert.equal(reviewerRow.role, 'reviewer');

  const canaryRoute = `/${canaryDirectory}/canary.txt`;
  const canaryResponse = await request(canaryRoute, { cookie: owner.cookie });
  assert.equal(canaryResponse.status, 404, 'authenticated users must not read files outside the public surface');
  assert.notEqual(canaryResponse.body, canaryValue);
  assert.equal((await request(canaryRoute)).status, 404, 'private paths return non-disclosing 404 for anonymous users');
  for (const cookie of [owner.cookie, reviewer.cookie]) {
    for (const privatePath of [canaryRoute, '/server.js', '/pipeline/auth-manager.js', '/orchestration/astra-r20-static-privacy-plan.json']) {
      assert.equal((await request(privatePath, { cookie })).status, 404, `${privatePath} must be unavailable to authenticated users`);
    }
    assert.equal((await request(canaryRoute, { method: 'HEAD', cookie })).status, 404);
  }

  for (const encodedPath of [
    '/css%2f..%2fserver.js',
    '/css%5c..%5cserver.js',
    '/css/%2e%2e/server.js',
    '/assets/%2e%2e/pipeline/auth-manager.js',
    '/css/./main.css',
  ]) {
    assert.equal((await rawRequest(encodedPath, { cookie: owner.cookie })).status, 404, `${encodedPath} must not resolve to a public or private file`);
    assert.equal((await rawRequest(encodedPath, { method: 'HEAD', cookie: owner.cookie })).status, 404,
      `HEAD ${encodedPath} must not resolve to a public or private file`);
  }

  assert.equal((await request('/login')).status, 200);
  assert.equal((await request('/')).status, 302, 'the root workspace remains behind sign-in');
  assert.equal((await request('/', { cookie: owner.cookie })).status, 200);
  assert.equal((await request('/index.html', { cookie: owner.cookie })).status, 200);
  const loginApp = await request('/js/app.js');
  assert.equal(loginApp.status, 200);
  assert.match(loginApp.body, /id="auth-form"/);
  assert.equal((await request('/css/auth.css')).status, 200);
  assert.equal((await request('/shared/verification-classification.js')).status, 200);
  assert.equal((await request('/shared/auth-manager.js')).status, 404,
    'the explicitly public classifier must not make other shared modules public');
  assert.equal((await request('/growth.html', { cookie: owner.cookie })).status, 200);
  assert.equal((await request('/astra.html', { cookie: owner.cookie })).status, 403,
    'the Astra page retains its tenant membership gate');
  assert.equal((await request('/css/main.css', { method: 'HEAD' })).status, 200);
  assert.equal((await request('/assets/odd-ecosys-emblem.png')).status, 200);
});
