import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-static-allowlist-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'static-fixture-bootstrap-token-long-enough';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
initDb();
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

test('only SPA documents and approved static roots are served; authenticated source/config files remain private', async () => {
  const anonymousRoot = await fetch(base, { redirect: 'manual' });
  assert.equal(anonymousRoot.status, 302);
  assert.equal(anonymousRoot.headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/login`)).status, 200);
  assert.equal((await fetch(`${base}/js/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/css/auth.css`)).status, 200);
  assert.equal((await fetch(`${base}/assets/odd-ecosys-emblem.png`)).status, 200);

  const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({
      email: 'owner@example.test',
      password: 'Fixture-only-owner-password-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    }),
  });
  assert.equal(bootstrap.status, 201);
  const cookies = bootstrap.headers.get('set-cookie') || '';
  const session = cookies.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  assert.ok(session);
  const cookie = `odd_session=${session}`;

  const workspace = await fetch(base, { headers: { cookie } });
  assert.equal(workspace.status, 200);
  assert.match(await workspace.text(), /oddecosys/i);

  for (const privatePath of [
    '/server.js',
    '/pipeline/database.js',
    '/config/personalization.json',
    '/orchestration/state.json',
    '/package.json',
    '/.env',
    '/%2e%2e/package.json',
  ]) {
    const response = await fetch(`${base}${privatePath}`, { headers: { cookie } });
    assert.equal(response.status, 404, `${privatePath} must not be downloadable by an authenticated workspace member`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), 'Not found');
  }

  const anonymousSource = await fetch(`${base}/pipeline/database.js`, { redirect: 'manual' });
  assert.equal(anonymousSource.status, 404, 'private source paths should not be advertised through a login redirect');
});
