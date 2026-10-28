import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-business-search-templates-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'synthetic-business-templates-bootstrap-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
const db = database.initDb();
const authModule = await import('../pipeline/auth-manager.js');
const auth = authModule.createAuthManager(db);
const { createBusinessSearchTemplates } = await import('../pipeline/business-search-templates.js');
const { server } = await import('../server.js');
if (!server.listening) await Promise.race([
  once(server, 'listening'), once(server, 'error').then(([error]) => Promise.reject(error)),
]);
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
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

function sessionFromCookieHeader(value) {
  const session = value.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = value.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session);
  assert.ok(csrf);
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

test('business-search-template API validates patterns and isolates durable records by account', async () => {
  assert.equal((await request('/api/leads/business-search-templates')).status, 401);
  const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', body: {
    email: 'template-owner@example.test', password: 'Synthetic-template-owner-8!',
    bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
  } });
  assert.equal(bootstrap.status, 201);
  const owner = sessionFromCookieHeader(bootstrap.setCookie);
  const noCsrf = await request('/api/leads/business-search-templates', { method: 'POST', cookie: owner.cookie,
    body: { name: 'Packaging', query_template: '{category} in {city}, {country} official website' } });
  assert.equal(noCsrf.status, 403);

  for (const query_template of [
    'packaging manufacturers Jaipur India',
    '{category} companies near {unknown}',
    '{category companies in {city}',
    '{category} '.repeat(40) + '{city}',
  ]) {
    const invalid = await request('/api/leads/business-search-templates', { method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
      body: { name: 'Invalid', query_template } });
    assert.equal(invalid.status, 400, `reject malformed template: ${query_template.slice(0, 45)}`);
  }

  const created = await request('/api/leads/business-search-templates', { method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { name: 'Packaging by location', query_template: '{category} companies in {city}, {region}, {country} official website', api_token: 'must-never-be-saved' } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.query_template, '{category} companies in {city}, {region}, {country} official website');
  assert.equal(JSON.stringify(created.body).includes('must-never-be-saved'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_business_search_templates').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_search_jobs').get().count, 0, 'saving a pattern does not start search work');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const duplicate = await request('/api/leads/business-search-templates', { method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { name: 'PACKAGING BY LOCATION', query_template: '{company} in {city}' } });
  assert.equal(duplicate.status, 409);
  const listed = await request('/api/leads/business-search-templates', { cookie: owner.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, created.body.id);

  const invitation = auth.createInvitation({ actor: { id: 1, role: 'owner' }, email: 'template-operator@example.test',
    role: 'operator', remoteAddress: '127.0.0.1' }).invitation;
  const accepted = await auth.acceptInvitation({ email: invitation.email, password: 'Synthetic-template-operator-7!',
    invitationToken: invitation.token, remoteAddress: '127.0.0.1' });
  const operator = { cookie: `odd_session=${accepted.sessionToken}; odd_csrf=${accepted.csrfToken}`, csrf: accepted.csrfToken };
  const operatorList = await request('/api/leads/business-search-templates', { cookie: operator.cookie });
  assert.deepEqual(operatorList.body, []);
  const crossAccountUpdate = await request(`/api/leads/business-search-templates/${created.body.id}`, { method: 'PUT', cookie: operator.cookie,
    csrf: operator.csrf, body: { name: 'Stolen', query_template: '{company} in {city}' } });
  assert.equal(crossAccountUpdate.status, 404);
  const crossAccountDelete = await request(`/api/leads/business-search-templates/${created.body.id}`, { method: 'DELETE', cookie: operator.cookie, csrf: operator.csrf });
  assert.equal(crossAccountDelete.status, 404);

  const updated = await request(`/api/leads/business-search-templates/${created.body.id}`, { method: 'PUT', cookie: owner.cookie,
    csrf: owner.csrf, body: { name: 'Packaging near city', query_template: '{category} manufacturers near {city}, {country} official website' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Packaging near city');
  assert.equal(updated.body.query_template, '{category} manufacturers near {city}, {country} official website');

  database.closeDb();
  const reopened = database.initDb();
  const manager = createBusinessSearchTemplates({ db: reopened });
  assert.deepEqual(manager.list({ id: 1, role: 'owner' }).map(row => ({ name: row.name, query_template: row.query_template })), [{
    name: 'Packaging near city', query_template: '{category} manufacturers near {city}, {country} official website',
  }]);
  assert.deepEqual(manager.list({ id: 2, role: 'operator' }), []);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const deleted = manager.remove(created.body.id, { id: 1, role: 'owner' });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(manager.list({ id: 1, role: 'owner' }), []);
});
