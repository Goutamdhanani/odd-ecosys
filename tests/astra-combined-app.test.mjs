import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH;

test('combined application: real auth, durable goal planning block, isolation and customer browser reload', {
  skip: fixturePath ? false : 'Requires the explicitly selected disposable R20 fixture.',
  timeout: 90_000,
}, async () => {
  const fixture = await validateAstraR20Fixture({ root, fixturePath: path.resolve(fixturePath) });
  const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'PROGRAMFILES',
    'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-combined-app-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', LOCAL_PREVIEW: '1',
    ODD_DB_PATH: path.join(scratch, 'auth.sqlite'), ODD_AUTH_ENFORCE_TESTS: 'true',
    ODD_AUTH_BOOTSTRAP_TOKEN: randomBytes(32).toString('hex'), ODD_AUTH_COOKIE_SECURE: 'false',
    ODD_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ASTRA_TENANT_MODE: '1', ASTRA_LEGACY_OFFER_BRIDGE: '1',
    ASTRA_DATABASE_URL: fixture.connectionString, ASTRA_WORKER_DATABASE_URL: fixture.workerConnectionString,
    ASTRA_CONTEXT_SECRET: fixture.contextSecret,
  });
  await import('./support/astra-qa-egress-guard.mjs');
  const { server } = await import('../server.js');
  const { initDb, closeDb } = await import('../pipeline/database.js');
  // Separate disposable auth files must not reuse the same PostgreSQL principal.
  const authDb = initDb();
  authDb.prepare("DELETE FROM sqlite_sequence WHERE name='auth_users'").run();
  authDb.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)')
    .run('auth_users', 6_000_000_000 + randomBytes(4).readUInt32BE(0));
  const observations = [];
  let browser;
  let activePage;
  try {
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('listening', resolve); server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/auth/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `combined-${randomUUID()}@example.test`, password: `Synthetic-${randomBytes(16).toString('hex')}!`,
        bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
    });
    assert.equal(response.status, 201);
    const cookieHeader = response.headers.get('set-cookie') || '';
    const session = cookieHeader.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrf = cookieHeader.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(session && csrf);
    const request = async (resource, method = 'GET', body, key) => {
      const result = await fetch(`${base}${resource}`, { method,
        headers: { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': decodeURIComponent(csrf),
          ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
      return { status: result.status, body: await result.json() };
    };
    const createdTenant = await request('/api/astra/tenants', 'POST', { name: `Combined app ${randomUUID().slice(0, 8)}` });
    assert.equal(createdTenant.status, 201);
    const tenantId = createdTenant.body.tenant?.id || createdTenant.body.tenant?.tenantId || createdTenant.body.tenantId;
    assert.ok(tenantId, 'tenant creation returns the real saved tenant identity');
    const prefix = `/api/astra/tenants/${tenantId}/business-goals`;
    const brief = 'I sell website redesign to dental clinics in Bengaluru, India.';
    const key = `combined-${randomUUID()}`;
    const created = await request(prefix, 'POST', { brief }, key);
    assert.equal(created.status, 201);
    const id = created.body.goal?.id;
    assert.ok(id);
    let saved;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      saved = await request(`${prefix}/${id}`);
      if (saved.body.goal?.status === 'blocked') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(saved.status, 200);
    assert.equal(saved.body.goal.id, id);
    assert.equal(saved.body.goal.status, 'blocked', 'initial planning is attempted after commit and truthfully blocks without authority');
    assert.ok(saved.body.goal.stateRevision >= 2);
    assert.ok(saved.body.goal.blockedReasons.length > 0);
    assert.equal(saved.body.goal.plan, null);
    observations.push({ id: 'initial_planning_and_readback', status: 'PASS', actual: { status: saved.body.goal.status,
      stateRevision: saved.body.goal.stateRevision, reasonCodes: saved.body.goal.blockedReasons.map(x => x.code) } });
    const replay = await request(prefix, 'POST', { brief }, key);
    assert.equal(replay.body.goal.id, id);
    const collision = await request(prefix, 'POST', { brief: 'A different synthetic business brief.' }, key);
    assert.equal(collision.status, 409);
    const stale = await request(`${prefix}/${id}/answers`, 'POST', { expectedVersion: 1, answers: [] });
    assert.equal(stale.status, 409);
    const missingVersion = await request(`${prefix}/${id}/answers`, 'POST', { answers: [] });
    assert.equal(missingVersion.status, 409);
    assert.equal(missingVersion.body.code, 'business_goal_version_required');
    const foreign = await request(`/api/astra/tenants/${randomUUID()}/business-goals/${id}`);
    assert.ok([403, 404].includes(foreign.status));
    observations.push({ id: 'idempotency_version_and_tenant_guards', status: 'PASS' });

    const { chromium } = await import('playwright');
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    assert.ok(fs.existsSync(edge));
    const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
    installLoopbackBrowserGuard({ chromium });
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edge });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'odd_session', value: session, url: base },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base }]);
    const page = await context.newPage();
    activePage = page;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/growth.html#discover`);
    await page.locator('#workspace-select').selectOption(tenantId);
    await page.locator('[data-view="discover"]').click();
    await page.locator('#goal-form').waitFor({ state: 'visible' });
    await page.locator('#goal-form [name="brief"]').fill('I sell bookkeeping services to retailers in Pune, India.');
    await page.locator('#goal-form [type="submit"]').click();
    await page.waitForFunction(() => /blocked|paused|not enabled|not configured/i.test(document.querySelector('#goal-status')?.textContent || ''), null, { timeout: 15_000 });
    const listed = await request(prefix);
    assert.ok(listed.body.items.length >= 2, 'browser action persisted a second goal through actual application handlers');
    await page.reload();
    await page.locator('#workspace-select').selectOption(tenantId);
    await page.locator('[data-view="discover"]').click();
    await page.waitForFunction(() => document.body.innerText.includes('bookkeeping'), null, { timeout: 15_000 });
    assert.deepEqual(errors, []);
    observations.push({ id: 'real_browser_create_block_and_reload', status: 'PASS', routeMocks: false, providerCalls: 0 });
    const dir = path.join(root, 'docs/product/astra-combined-main-20261028');
    fs.writeFileSync(path.join(dir, 'APP_CHECKS.json'), JSON.stringify({ observations,
      environment: 'disposable synthetic PostgreSQL + temporary SQLite + actual app + headless Edge',
      liveProviderCalls: 0, outreach: 'disabled', releaseReady: false }, null, 2));
  } catch (error) {
    const dir = path.join(root, '.runner');
    fs.writeFileSync(path.join(dir, 'combined-app-failure.json'), JSON.stringify({
      error: error.message, observations,
      page: activePage ? await activePage.locator('body').innerText().catch(() => '') : null,
    }, null, 2));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    closeDb();
  }
});
