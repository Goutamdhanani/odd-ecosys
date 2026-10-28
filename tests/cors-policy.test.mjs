import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-cors-policy-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'cors-fixture-bootstrap-token-long-enough';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('CORS fixture','verification','open')").run().lastInsertRowid);
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

async function request(route, { method = 'GET', body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, text: await response.text() };
}

test('authenticated same-origin API and verification export work without wildcard CORS grants', async () => {
  const bootstrap = await request('/api/auth/bootstrap', {
    method: 'POST',
    origin: base,
    body: { email: 'owner@example.test', password: 'Fixture-only-owner-password-8!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
  });
  assert.equal(bootstrap.response.status, 201);
  const setCookie = bootstrap.response.headers.get('set-cookie') || '';
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session);
  assert.ok(csrf);
  const cookie = `odd_session=${session}; odd_csrf=${csrf}`;

  const sameOriginApi = await request('/api/batches', { cookie, origin: base });
  assert.equal(sameOriginApi.response.status, 200);
  assert.equal(sameOriginApi.response.headers.get('access-control-allow-origin'), null);

  const sameOriginExport = await request(`/api/verify/results/${batchId}/export`, { cookie, origin: base });
  assert.equal(sameOriginExport.response.status, 200);
  assert.match(sameOriginExport.response.headers.get('content-type') || '', /text\/csv/);
  assert.equal(sameOriginExport.response.headers.get('access-control-allow-origin'), null);
  assert.match(sameOriginExport.text, /contact_id,email_id,business_name,email/);

  const crossOriginPreflight = await request('/api/batches', {
    method: 'OPTIONS',
    cookie,
    origin: 'https://attacker.example',
  });
  assert.equal(crossOriginPreflight.response.status, 204);
  assert.equal(crossOriginPreflight.response.headers.get('access-control-allow-origin'), null);

  const anonymousCrossOriginRead = await request('/api/batches', { origin: 'https://attacker.example' });
  assert.equal(anonymousCrossOriginRead.response.status, 401);
  assert.equal(anonymousCrossOriginRead.response.headers.get('access-control-allow-origin'), null);
});
