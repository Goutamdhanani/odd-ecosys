import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-lead-saved-search-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'saved-search-fixture-bootstrap-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
const authModule = await import('../pipeline/auth-manager.js');
const db = database.initDb();
const auth = authModule.createAuthManager(db);
const { server } = await import('../server.js');
if (!server.listening) await Promise.race([
  once(server, 'listening'),
  once(server, 'error').then(([error]) => Promise.reject(error)),
]);
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), setCookie: response.headers.get('set-cookie') || '' };
}

function browserSession(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session);
  assert.ok(csrf);
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

test('authenticated saved-search API scopes list and delete to the signed-in owner and enforces CSRF', async () => {
  assert.equal((await request('/api/leads/discovery-searches')).status, 401);
  const bootstrapped = await request('/api/auth/bootstrap', { method: 'POST', body: {
    email: 'search-owner@example.test', password: 'Fixture-owner-password-9!',
    bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
  } });
  assert.equal(bootstrapped.status, 201);
  const ownerSession = browserSession(bootstrapped.setCookie);
  const criteria = { country: 'India', state: 'Rajasthan', cities: ['Jaipur'], niches: ['Handicraft exporters'],
    sources: ['searxng', 'epch_directory'], target_email_count: 12, max_businesses: 40,
    max_pages_per_query: 2, max_runtime_minutes: 15 };
  const noCsrf = await request('/api/leads/discovery-searches', { method: 'POST', cookie: ownerSession.cookie,
    body: { name: 'Jaipur exporters', ...criteria } });
  assert.equal(noCsrf.status, 403);

  const created = await request('/api/leads/discovery-searches', { method: 'POST', cookie: ownerSession.cookie,
    csrf: ownerSession.csrf, body: { name: 'Jaipur exporters', ...criteria } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.criteria.cities, ['jaipur']);
  assert.equal('batch_id' in created.body.criteria, false);
  const duplicate = await request('/api/leads/discovery-searches', { method: 'POST', cookie: ownerSession.cookie,
    csrf: ownerSession.csrf, body: { name: 'JAIPUR EXPORTERS', ...criteria } });
  assert.equal(duplicate.status, 409);
  const listed = await request('/api/leads/discovery-searches', { cookie: ownerSession.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, created.body.id);

  const invitation = auth.createInvitation({ actor: { id: 1, role: 'owner' }, email: 'search-operator@example.test',
    role: 'operator', remoteAddress: '127.0.0.1' }).invitation;
  const accepted = await auth.acceptInvitation({ email: invitation.email, password: 'Fixture-operator-password-8!',
    invitationToken: invitation.token, remoteAddress: '127.0.0.1' });
  const operatorSession = { cookie: `odd_session=${accepted.sessionToken}; odd_csrf=${accepted.csrfToken}`,
    csrf: accepted.csrfToken };
  const operatorList = await request('/api/leads/discovery-searches', { cookie: operatorSession.cookie });
  assert.equal(operatorList.status, 200);
  assert.deepEqual(operatorList.body, [], 'another account receives only its own saved searches');
  const crossAccountDelete = await request(`/api/leads/discovery-searches/${created.body.id}`, {
    method: 'DELETE', cookie: operatorSession.cookie, csrf: operatorSession.csrf,
  });
  assert.equal(crossAccountDelete.status, 404, 'the API does not reveal or delete another account’s saved search');
  const deleted = await request(`/api/leads/discovery-searches/${created.body.id}`, {
    method: 'DELETE', cookie: ownerSession.cookie, csrf: ownerSession.csrf,
  });
  assert.equal(deleted.status, 200);
  assert.equal((await request('/api/leads/discovery-searches', { cookie: ownerSession.cookie })).body.length, 0);
});
