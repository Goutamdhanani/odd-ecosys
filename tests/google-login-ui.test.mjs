import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-google-login-ui-'));
const clientId = '1234567890-ui-fixture.apps.googleusercontent.com';
process.env.ODD_DB_PATH = path.join(directory, 'workspace.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.GOOGLE_CLIENT_ID = clientId;
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'true';
delete process.env.ODD_AUTH_BOOTSTRAP_TOKEN;
process.env.PORT = '0';
delete process.env.HOST;

const keyPair = await generateKeyPair('RS256', { modulusLength: 2048 });
const publicJwk = await exportJWK(keyPair.publicKey);
Object.assign(publicJwk, { kid: 'ui-fixture-key', alg: 'RS256', use: 'sig' });
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
const { server } = await import('../server.js');
if (!server.listening) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  globalThis.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('real browser shows Google-first owner setup and completes the app login callback with a verified synthetic token', async t => {
  if (!fs.existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const screenshotPath = path.join(directory, 'google-first-owner.png');
  try {
    await context.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (target.origin === base) return route.continue();
      if (target.href === 'https://accounts.google.com/gsi/client') {
        return route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: `(() => { let callback; window.google = { accounts: { id: {
            initialize(config) { callback = config.callback; window.__gsiNonce = config.nonce; },
            renderButton(container) { const button = document.createElement('button'); button.id = 'fixture-google-button'; button.textContent = 'Continue with Google'; button.type = 'button'; button.addEventListener('click', () => { window.__googleButtonClicked = true; }); container.append(button); },
            deliverCredential(credential) { callback({ credential }); }
          } } }; })();`,
        });
      }
      return route.abort();
    });

    const page = await context.newPage();
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create your workspace account' }).waitFor();
    await page.locator('.auth-setup-help').waitFor();
    assert.equal(await page.locator('#google-signin-button').count(), 0, 'unconfigured first-owner setup cannot be claimed through Google');
    assert.equal(await page.locator('#auth-form').count(), 0);
    process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'private-browser-google-setup-token-0123456789';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
    assert.equal(await page.locator('#auth-form').count(), 1);
    assert.match(await page.locator('.auth-description').innerText(), /private setup token/);
    assert.equal(await page.locator('.auth-brand img').evaluate(image => image.naturalWidth), 1254,
      'the supplied transparent emblem loads into the sign-in screen');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    assert.equal(fs.readFileSync(screenshotPath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    const nonce = await page.evaluate(() => window.__gsiNonce);
    assert.equal(typeof nonce, 'string');
    const token = await new SignJWT({ email: 'browser-owner@gmail.com', email_verified: true, nonce })
      .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })
      .setIssuer('https://accounts.google.com')
      .setAudience(clientId)
      .setSubject('browser-owner-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keyPair.privateKey);
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    assert.equal(await page.evaluate(() => window.__googleButtonClicked), true);
    await page.evaluate(credential => window.google.accounts.id.deliverCredential(credential), token);
    await page.waitForFunction(() => document.querySelector('[data-google-message]')?.textContent.includes('Enter the private setup token above'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_users').get().count, 0);
    assert.equal(await page.locator('[name="bootstrapToken"]').evaluate(field => document.activeElement === field), true);
    await page.locator('[name="bootstrapToken"]').fill(process.env.ODD_AUTH_BOOTSTRAP_TOKEN);
    assert.equal(await page.locator('#auth-form').evaluate(form => new FormData(form).get('bootstrapToken')), process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
      'the one shared setup-token field also belongs to the password setup form');
    await page.evaluate(credential => window.google.accounts.id.deliverCredential(credential), token);
    await page.waitForURL(`${base}/`, { timeout: 8000 });
    await page.getByRole('button', { name: 'browser-owner@gmail.com' }).waitFor({ timeout: 8000 });
    assert.deepEqual(db.prepare('SELECT email,role,google_sub FROM auth_users').all(), [
      { email: 'browser-owner@gmail.com', role: 'owner', google_sub: 'browser-owner-subject' },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get().count, 1);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('a stale first-account setup page refreshes into sign-in when the workspace is already configured', async t => {
  if (!fs.existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let statusRequests = 0;
  let setupAttempts = 0;
  const pageErrors = [];
  try {
    await context.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (target.origin === base && target.pathname === '/api/auth/status') {
        statusRequests += 1;
        const status = statusRequests === 1
          ? { authenticated: false, setupRequired: true, setupAvailable: true, recoveryAvailable: false, googleLoginAvailable: false, googleClientId: null }
          : { authenticated: false, setupRequired: false, setupAvailable: false, recoveryAvailable: false, googleLoginAvailable: true, googleClientId: clientId };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
      }
      if (target.origin === base && target.pathname === '/api/auth/bootstrap') {
        setupAttempts += 1;
        assert.equal(route.request().postDataJSON().bootstrapToken, 'local-test-token-that-is-at-least-32');
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'First-account setup is already complete.' }) });
      }
      if (target.origin === base) return route.continue();
      if (target.href === 'https://accounts.google.com/gsi/client') {
        return route.fulfill({
          status: 200,
          contentType: 'text/javascript',
          body: `(() => { window.google = { accounts: { id: {
            initialize() {}, renderButton(container) { const button = document.createElement('button'); button.textContent = 'Continue with Google'; button.type = 'button'; container.append(button); }
          } } }; })();`,
        });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create your workspace account' }).waitFor();
    await page.locator('[name="email"]').fill('goutamdhanani@gmail.com');
    await page.locator('[name="bootstrapToken"]').fill('local-test-token-that-is-at-least-32');
    await page.locator('[name="password"]').fill('A-long-test-only-password-92');
    await page.locator('[name="confirmPassword"]').fill('A-long-test-only-password-92');
    await page.getByRole('button', { name: 'Create local account' }).click();
    await page.getByRole('heading', { name: 'Sign in to your workspace' }).waitFor();
    assert.equal(statusRequests, 2);
    assert.equal(setupAttempts, 1);
    assert.equal(await page.locator('[name="bootstrapToken"]').count(), 0);
    assert.equal(await page.locator('[name="email"]').inputValue(), 'goutamdhanani@gmail.com');
    assert.match(await page.locator('.auth-error').innerText(), /already has an account/);
    await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
