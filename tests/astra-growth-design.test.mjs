import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const demoWorkspaceId = 'a1000000-0000-4000-8000-000000000001';
const handoffWorkspaceId = 'b2000000-0000-4000-8000-000000000002';
let browser, server;
let contextFailureMode = false;
let claimResourceFailure = false;
let operatorWorkspaceCapability = false;
after(async () => { await browser?.close(); if (server?.listening) await new Promise(resolve => server.close(resolve)); });

test('growth design stays usable across widths with keyboard sections, clear task disclosures and presentation-only Pro mode', async t => {
  const { stat } = await import('node:fs/promises');
  if (!(await stat(edgePath).then(() => true, () => false))) return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.');
  const { chromium } = await import('playwright');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = data => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (url.pathname === '/api/astra/workspaces') { reply({ workspaces: [{ id: demoWorkspaceId, name: 'Design fixture A', role: 'owner', status: 'active' }, ...(operatorWorkspaceCapability ? [{ id: handoffWorkspaceId, name: 'Design fixture B', role: 'owner', status: 'active' }] : [])], capabilities: { operatorWorkspace: operatorWorkspaceCapability } }); return; }
    const contextMatch = url.pathname.match(/^\/api\/astra\/tenants\/([0-9a-f-]+)\/context$/i);
    if (contextMatch) { const id = contextMatch[1]; reply({ tenant: { id: contextFailureMode ? 'c3000000-0000-4000-8000-000000000003' : id, name: id === handoffWorkspaceId ? 'Design fixture B' : 'Design fixture A', status: 'active' } }); return; }
    const tenantPath = url.pathname.match(/^\/api\/astra\/tenants\/([0-9a-f-]+)\//i);
    if (tenantPath && url.pathname.endsWith('/research/claims') && claimResourceFailure) { res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Evidence notes are temporarily unavailable.' })); return; }
    if (tenantPath) { reply({ data: [], items: [], offers: [] }); return; }
    if (url.pathname === '/astra.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><title>Advanced workspace test</title><body><output id="selected-workspace"></output><script>document.querySelector("#selected-workspace").textContent = localStorage.getItem("odd-astra-tenant-id") || "";</script></body>'); return; }
    const files = new Map([['/growth.html', ['growth.html', 'text/html; charset=utf-8']], ['/css/main.css', ['css/main.css', 'text/css; charset=utf-8']], ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css; charset=utf-8']], ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript; charset=utf-8']], ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript; charset=utf-8']]]);
    const asset = files.get(url.pathname);
    if (!asset) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' }).end(await fs.readFile(path.join(root, asset[0])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const screenshotDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'astra-growth-design-'));
  console.log(`Growth design screenshots: ${screenshotDirectory}`);
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/growth.html#inbox`);
  await page.locator('#view-inbox:not([hidden])').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#search-result, #snapshot-result, #claim-result, #offer-result, #qualification-result, #inbox-write-result, #campaign-detail')].every(box => box.textContent !== 'Loading this workspace…'));
  for (const [selector, expected] of [['#search-result', 'No search request yet.'], ['#snapshot-result', 'Your report will appear here after the page is saved.'], ['#claim-result', 'Choose a saved page and run this task to see a result.'], ['#offer-result', 'Run offer setup to see its result.'], ['#qualification-result', 'Run qualification to see its result.'], ['#inbox-write-result', 'Create a manual inbox, then import a message using its external message and thread references.'], ['#campaign-detail', 'Select a campaign to view its saved state and offline plans.']]) {
    assert.equal(await page.locator(selector).innerText(), expected, `${selector} settles to its truthful idle prompt after the workspace load`);
  }
  assert.equal(await page.locator('.section-nav').getAttribute('aria-orientation'), 'vertical');
  assert.equal(await page.getByRole('tab').count(), 7);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Overview', 'Discover', 'Campaigns', 'Inbox', 'Customers', 'Analytics', 'Settings']);
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.screenshot({ path: path.join(screenshotDirectory, 'overview-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 820 });
  await page.waitForTimeout(40);
  const overviewMobileWidth = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(overviewMobileWidth.scrollWidth <= overviewMobileWidth.width + 1, `Overview actions fit 375px: ${JSON.stringify(overviewMobileWidth)}`);
  await page.screenshot({ path: path.join(screenshotDirectory, 'overview-375.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(40);
  assert.match(await page.locator('#view-overview').innerText(), /manual message import/i);
  assert.match(await page.locator('#view-overview').innerText(), /Inbox sync is not available/i);
  await page.getByRole('button', { name: 'Discover a business' }).click();
  await page.locator('#view-discover:not([hidden])').waitFor();
  assert.equal(await page.locator('.section-nav [aria-selected="true"]').getAttribute('data-view'), 'discover', 'the existing Discover dashboard action still opens Discover');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Open inbox' }).click();
  await page.locator('#view-inbox:not([hidden])').waitFor();
  assert.equal(await page.locator('.section-nav [aria-selected="true"]').getAttribute('data-view'), 'inbox', 'the companion Overview action opens Inbox');
  const primaryTask = page.locator('#view-inbox #inbox-list');
  assert.equal(await primaryTask.isVisible(), true, 'messages stay primary and visible without Pro');
  const importTask = page.locator('#view-inbox details').filter({ hasText: 'Import a message' });
  assert.equal(await importTask.getAttribute('open'), null, 'supporting workflow begins discoverable but collapsed');
  await importTask.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await importTask.getAttribute('open'), '', 'keyboard opens the named task');
  await page.keyboard.press('Enter');
  assert.equal(await importTask.getAttribute('open'), null, 'same summary provides close behavior');

  const proButton = page.getByRole('button', { name: 'Enable Pro mode' });
  await proButton.click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('pro-mode')), true);
  assert.equal(await page.getByRole('button', { name: 'Disable Pro mode' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#mailbox-form').isVisible(), false, 'Pro does not hide or unlock any controls; collapsed tasks stay collapsed');
  assert.equal(await page.locator('#advanced-link').isVisible(), false, 'advanced link remains hidden without server authorization');
  await page.getByRole('tab', { name: 'Settings' }).click();
  assert.equal(await page.locator('.pro-technical').isVisible(), true, 'Pro exposes read-only technical workspace context');
  assert.equal(await page.locator('#pro-workspace-id').innerText(), demoWorkspaceId, 'Pro displays the real-shaped active workspace context');
  await page.getByRole('button', { name: 'Disable Pro mode' }).click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('pro-mode')), false);
  assert.equal(await page.locator('.pro-technical').isVisible(), false, 'turning Pro off hides the technical context again');

  await page.getByRole('tab', { name: 'Campaigns' }).click();
  assert.match(await page.locator('#prereq-offer-status').innerText(), /No approved offer is saved yet/);
  assert.match(await page.locator('#campaign-prerequisites').innerText(), /Manual mailbox/);
  assert.match(await page.locator('#prereq-mailbox-status').innerText(), /No manual inbox is saved/);
  await page.screenshot({ path: path.join(screenshotDirectory, 'growth-campaigns-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 820 });
  await page.waitForTimeout(40);
  await page.locator('#tab-campaigns').evaluate(node => node.click());
  const campaignWidth = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(campaignWidth.scrollWidth <= campaignWidth.width + 1, `campaign prerequisite guide fits 375px: ${JSON.stringify(campaignWidth)}`);
  await page.screenshot({ path: path.join(screenshotDirectory, 'growth-campaigns-375.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Create offer' }).click();
  assert.equal(await page.locator('#offer-form').locator('xpath=..').getAttribute('open'), '', 'offer guidance opens the existing offer task');
  await page.getByRole('button', { name: 'Set up manual inbox' }).click();
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-view'), 'inbox');
  assert.equal(await page.locator('#mailbox-form').locator('xpath=..').getAttribute('open'), '', 'mailbox guidance navigates to Inbox and opens its existing manual mailbox task');

  await page.getByRole('tab', { name: 'Inbox' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.section-nav [aria-selected="true"]').getAttribute('data-view'), 'customers');
  assert.equal(new URL(page.url()).hash, '#customers', 'tab changes have a stable deep link');
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const width of [1440, 768, 682, 375, 320]) {
    await page.setViewportSize({ width, height: width === 375 ? 820 : 950 });
    await page.waitForTimeout(30);
    const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, orientation: document.querySelector('.section-nav').getAttribute('aria-orientation'), nav: document.querySelector('.section-nav').getBoundingClientRect().toJSON(), content: document.querySelector('.workspace-content').getBoundingClientRect().toJSON() }));
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `${width}px layout has no page-level horizontal overflow: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.orientation, width > 860 ? 'vertical' : 'horizontal');
    if (width > 860) assert.ok(metrics.content.left >= metrics.nav.right - 1, `${width}px content clears the vertical rail`);
    if (width === 375 || width === 682) {
      const activeBounds = await page.locator('.section-nav [role="tab"][aria-selected="true"]').evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
      const navBounds = await page.locator('.section-nav').evaluate(node => ({ left: node.getBoundingClientRect().left + node.clientLeft, right: node.getBoundingClientRect().left + node.clientLeft + node.clientWidth }));
      assert.ok(activeBounds.left >= navBounds.left - 1 && activeBounds.right <= navBounds.right + 1, `${width}px active tab is fully visible in horizontal navigation: ${JSON.stringify({ activeBounds, navBounds })}`);
    }
    await page.screenshot({ path: path.join(screenshotDirectory, `growth-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 820 });
  const pageScrollBeforeTabChange = await page.evaluate(() => scrollY);
  await page.locator('#tab-settings').evaluate(node => node.click());
  await page.locator('#view-settings:not([hidden])').waitFor();
  const settingsBounds = await page.locator('#tab-settings').evaluate(node => ({ tab: node.getBoundingClientRect().toJSON(), nav: node.parentElement.getBoundingClientRect().toJSON(), clientLeft: node.parentElement.clientLeft, clientWidth: node.parentElement.clientWidth }));
  assert.ok(settingsBounds.tab.left >= settingsBounds.nav.left + settingsBounds.clientLeft - 1 && settingsBounds.tab.right <= settingsBounds.nav.left + settingsBounds.clientLeft + settingsBounds.clientWidth + 1, 'a section click brings its selected tab fully into the horizontal rail');
  assert.equal(await page.evaluate(() => scrollY), pageScrollBeforeTabChange, 'section navigation scrolls the rail without moving the document');
  await page.evaluate(() => { location.hash = '#discover'; });
  await page.locator('#view-discover:not([hidden])').waitFor();
  const discoverBounds = await page.locator('#tab-discover').evaluate(node => ({ tab: node.getBoundingClientRect().toJSON(), nav: node.parentElement.getBoundingClientRect().toJSON(), clientLeft: node.parentElement.clientLeft, clientWidth: node.parentElement.clientWidth }));
  assert.ok(discoverBounds.tab.left >= discoverBounds.nav.left + discoverBounds.clientLeft - 1 && discoverBounds.tab.right <= discoverBounds.nav.left + discoverBounds.clientLeft + discoverBounds.clientWidth + 1, 'a deep link brings its selected tab fully into the horizontal rail');
  assert.equal(await page.evaluate(() => scrollY), pageScrollBeforeTabChange, 'deep-link selection does not scroll the document');
  await page.screenshot({ path: path.join(screenshotDirectory, 'growth-375-settings.png'), fullPage: true });
  await page.screenshot({ path: path.join(screenshotDirectory, 'growth-375-discover.png'), fullPage: true });
  assert.deepEqual(await page.evaluate(() => ({ current: location.hash, active: document.querySelector('[role="tab"][aria-selected="true"]').dataset.view })), { current: '#discover', active: 'discover' });
  assert.equal(await page.locator('.pro-only').count(), 2, 'Pro adds a presentation hint and read-only technical context and relies on the existing authorized link');

  // An explicit refresh must leave user-visible work and pending/error statuses alone.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.locator('#snapshot-result').evaluate(box => { box.className = 'result-box'; box.textContent = 'Saved report result remains available.'; });
  await page.locator('#search-result').evaluate(box => { box.className = 'result-box'; box.textContent = 'Submitting a workspace search…'; });
  await page.locator('[data-refresh]').first().click();
  await page.waitForFunction(() => !document.querySelector('#evidence-list').textContent.includes('Refreshing…'));
  assert.equal(await page.locator('#snapshot-result').innerText(), 'Saved report result remains available.');
  assert.equal(await page.locator('#search-result').innerText(), 'Submitting a workspace search…');

  // Advanced workspace handoff updates the legacy storage contract only after the
  // existing server capability, role and Pro-mode gates have all passed.
  operatorWorkspaceCapability = true;
  const handoffContext = await browser.newContext({ viewport: { width: 900, height: 800 } });
  await handoffContext.addInitScript(({ staleId, currentId }) => { localStorage.setItem('odd-growth-pro-mode', 'on'); if (location.pathname === '/growth.html' && sessionStorage.getItem('tenant-handoff-seeded') !== 'yes') { localStorage.setItem('odd-astra-tenant-id', staleId); sessionStorage.setItem('odd-growth-workspace', currentId); sessionStorage.setItem('tenant-handoff-seeded', 'yes'); } }, { staleId: demoWorkspaceId, currentId: handoffWorkspaceId });
  const handoffPage = await handoffContext.newPage();
  await handoffPage.goto(`http://127.0.0.1:${server.address().port}/growth.html#overview`);
  await handoffPage.locator('#advanced-link:not([hidden])').waitFor();
  await handoffPage.locator('#advanced-link').click({ button: 'right' });
  assert.equal(await handoffPage.evaluate(() => localStorage.getItem('odd-astra-tenant-id')), handoffWorkspaceId, 'native link context-menu activation synchronizes the selected workspace before a new-tab choice');
  const [advancedPage] = await Promise.all([
    handoffContext.waitForEvent('page'),
    handoffPage.locator('#advanced-link').click({ button: 'middle' }),
  ]);
  await advancedPage.locator('#selected-workspace').waitFor();
  assert.equal(await advancedPage.locator('#selected-workspace').innerText(), handoffWorkspaceId, 'middle-click opens Advanced on selected B instead of stale A');
  await handoffContext.close();

  const deniedContext = await browser.newContext({ viewport: { width: 900, height: 800 } });
  await deniedContext.addInitScript(({ staleId, currentId }) => {
    localStorage.setItem('odd-growth-pro-mode', 'on');
    localStorage.setItem('odd-astra-tenant-id', staleId);
    sessionStorage.setItem('odd-growth-workspace', currentId);
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === 'odd-astra-tenant-id') throw new Error('storage unavailable'); return originalSetItem.call(this, key, value); };
  }, { staleId: demoWorkspaceId, currentId: handoffWorkspaceId });
  const deniedPage = await deniedContext.newPage();
  await deniedPage.goto(`http://127.0.0.1:${server.address().port}/growth.html#overview`);
  await deniedPage.locator('#advanced-link:not([hidden])').waitFor();
  await deniedPage.locator('#advanced-link').click({ button: 'middle' });
  assert.match(deniedPage.url(), /growth\.html#overview$/, 'storage denial cancels middle-click instead of opening a stale workspace in a new tab');
  await deniedPage.locator('#advanced-link').click();
  assert.match(deniedPage.url(), /growth\.html#overview$/, 'storage denial cancels the handoff instead of opening a stale workspace');
  assert.match(await deniedPage.locator('#notice').innerText(), /could not be handed off safely/i);
  assert.equal(await deniedPage.evaluate(() => localStorage.getItem('odd-astra-tenant-id')), demoWorkspaceId);
  await deniedContext.close();

  claimResourceFailure = true;
  const resourceFailureContext = await browser.newContext();
  const resourceFailurePage = await resourceFailureContext.newPage();
  await resourceFailurePage.goto(`http://127.0.0.1:${server.address().port}/growth.html#discover`);
  await resourceFailurePage.waitForFunction(() => !document.querySelector('#claim-result').textContent.includes('Loading this workspace…'));
  assert.match(await resourceFailurePage.locator('#claim-result').innerText(), /Evidence notes: Evidence notes are temporarily unavailable/i, 'failed resources settle to their actual error instead of a ready-looking empty state');
  await resourceFailureContext.close();
  claimResourceFailure = false;

  contextFailureMode = true;
  const contextFailureContext = await browser.newContext();
  const contextFailurePage = await contextFailureContext.newPage();
  await contextFailurePage.goto(`http://127.0.0.1:${server.address().port}/growth.html#discover`);
  await contextFailurePage.waitForFunction(() => document.querySelector('#session-state').textContent === 'Workspace could not be verified');
  assert.match(await contextFailurePage.locator('#search-result').innerText(), /could not be verified/i, 'context verification failure stays visible and does not leave a loading status');
  assert.doesNotMatch(await contextFailurePage.locator('#search-result').innerText(), /Loading this workspace/i);
  await contextFailureContext.close();
  contextFailureMode = false;
  await context.close();
});
