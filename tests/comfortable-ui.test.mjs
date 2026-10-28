import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-comfort-ui-'));
Object.assign(process.env, {
  ODD_DB_PATH: path.join(directory, 'ui.db'), NODE_ENV: 'test',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'synthetic-comfort-bootstrap-token-20261019',
  ODD_PERSONALIZATION_BEDROCK_ENABLED: 'false', HOST: '127.0.0.1', PORT: '0',
});
const { closeDb } = await import('../pipeline/database.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('readable workspace controls, zoom reflow, mobile setup scrolling and reduced motion', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath:
    process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.route('**/api/personalize/ollama-test*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"connected":false,"available":false}',
  }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const screenshot = async name => {
    if (!process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) return;
    mkdirSync(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, name), fullPage: false, animations: 'disabled' });
  };
  const sizes = selector => page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({
    text: (node.textContent || node.getAttribute('aria-label') || node.tagName).trim().slice(0, 60),
    font: parseFloat(getComputedStyle(node).fontSize), height: node.getBoundingClientRect().height,
  })));
  const floor = (values, field, minimum) => {
    assert.ok(values.length, 'the size check must inspect rendered controls');
    assert.deepEqual(values.filter(value => value[field] < minimum - .1), [], `${field} must be at least ${minimum}px`);
  };
  try {
    await page.goto(`${base}/login`);
    await page.locator('form.auth-form').waitFor();
    floor(await sizes('.auth-form input'), 'font', 16);
    floor(await sizes('.auth-form label'), 'font', 14);
    floor(await sizes('.auth-submit'), 'height', 44);
    await page.setViewportSize({ width: 390, height: 360 });
    const submit = page.locator('.auth-submit');
    await submit.scrollIntoViewIfNeeded();
    const box = await submit.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 360, 'setup submit stays reachable on short mobile screens');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot('comfortable-setup-390.png');
    const response = await fetch(`${base}/api/auth/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'comfort@example.test', password: 'Synthetic-comfort-password-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
    });
    assert.equal(response.status, 201);
    const header = response.headers.get('set-cookie');
    await context.addCookies(['odd_session', 'odd_csrf'].map(name => ({
      name, value: decodeURIComponent(header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`))[1]),
      domain: '127.0.0.1', path: '/', sameSite: 'Strict', httpOnly: name === 'odd_session',
    })));
    for (const width of [1440, 1024, 768, 720, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 640 : 900 });
      await page.goto(`${base}/#dashboard`);
      await page.locator('#workspace-navigation').waitFor();
      await page.waitForFunction(() => document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false');
      if (width <= 700) await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
      floor(await sizes('.nav-item'), 'font', 14);
      floor(await sizes('.nav-item'), 'height', 44);
      floor(await sizes('.metric-top,.metric-note,.hero-copy p'), 'font', 13);
      floor(await sizes('.btn,.icon-btn,.auth-logout'), 'height', 44);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('#main-content');
        return { document: document.documentElement.scrollWidth > innerWidth + 1, main: main.scrollWidth > main.clientWidth + 1 };
      });
      assert.deepEqual(overflow, { document: false, main: false }, `workspace reflows at ${width}px (720px also covers 200% zoom of 1440px)`);
      await screenshot(`comfortable-dashboard-${width}.png`);
    }
    await page.setViewportSize({ width: 390, height: 360 });
    await page.goto(`${base}/#campaigns`);
    await page.waitForFunction(() => document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false');
    await page.evaluate(async () => (await import('/js/ui.js')).notify('Latest actionable error', 'error'));
    const action = await page.locator('[data-campaign-create]').boundingBox();
    const toast = await page.locator('.studio-toast').boundingBox();
    assert.ok(action.y + action.height <= toast.y || action.y >= toast.y + toast.height,
      `notification must not cover the primary campaign action: ${JSON.stringify({ action, toast })}`);
    await screenshot('comfortable-campaign-notification-390.png');
    await page.locator('.studio-toast-dismiss').click();
    for (const width of [320, 390, 720]) {
      await page.setViewportSize({ width, height: 360 });
      await page.goto(`${base}/#settings`);
      await page.waitForFunction(() => document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('#main-content').evaluate(node => node.scrollWidth > node.clientWidth + 1), false,
        `Settings must reflow at ${width}px without losing controls sideways`);
      await screenshot(`comfortable-settings-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#leads`);
    await page.waitForFunction(() => document.querySelector('#main-content')?.getAttribute('aria-busy') === 'false');
    floor(await sizes('#main-content input:not([type=checkbox]),#main-content select'), 'font', 16);
    floor(await sizes('#main-content input:not([type=checkbox]),#main-content select'), 'height', 44);
    floor(await sizes('th'), 'font', 13);
    await screenshot('comfortable-contacts-1440.png');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.nav-item').first().evaluate(node => getComputedStyle(node).transitionDuration), '0s');
    assert.equal(await page.locator('.page-view').evaluate(node => getComputedStyle(node).transform), 'none', 'route containers must not trap fixed dialogs');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
