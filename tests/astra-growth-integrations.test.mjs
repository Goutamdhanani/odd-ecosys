import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ids = { a: '10000000-0000-4000-8000-000000000001', b: '20000000-0000-4000-8000-000000000002' };
let browser;
let server;
let releaseA;
let bAiCalls = 0;
const methods = [];

after(async () => {
  releaseA?.();
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test('Settings reports saved workspace availability and tenant-safe AI task status', async t => {
  try { await fs.access(edgePath); } catch { return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.'); }
  const { chromium } = await import('playwright');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method;
    methods.push(method);
    const reply = (status, value, type = 'application/json') => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    if (url.pathname === '/api/astra/workspaces') return reply(200, { workspaces: [{ id: ids.a, name: 'North Studio', role: 'owner' }, { id: ids.b, name: 'South Studio', role: 'owner' }] });
    const context = url.pathname.match(/^\/api\/astra\/tenants\/([^/]+)\/context$/);
    if (context) return reply(200, { tenant: { id: context[1], name: context[1] === ids.a ? 'North Studio' : 'South Studio', status: 'active' } });
    const tenant = url.pathname.match(/^\/api\/astra\/tenants\/([^/]+)/)?.[1];
    if (url.pathname.endsWith('/ai')) {
      if (method !== 'GET') return reply(405, { error: 'GET only' });
      if (tenant === ids.a) {
        await new Promise(resolve => { releaseA = resolve; });
        return reply(200, { data: { egressEnabled: true, actualModel: 'private-model-name' } });
      }
      bAiCalls++;
      if (bAiCalls === 1) return reply(200, { data: { egressEnabled: false, egressBlocker: 'local_preview_egress_denied', actualModel: 'private-model-name', budget: 999 } });
      if (bAiCalls === 2) return reply(200, { data: { egressEnabled: true, actualModel: 'private-model-name' } });
      if (bAiCalls === 3) return reply(200, { data: { egressEnabled: 'true', egressBlocker: 'global_budget_disabled' } });
      return reply(503, { error: 'synthetic unavailable' });
    }
    if (url.pathname.endsWith('/prospecting/status')) return reply(200, { prospecting: { ready: false, reason: 'Waiting for coordinator approval.' } });
    if (url.pathname.endsWith('/research/evidence')) return reply(200, { data: [{ id: '30000000-0000-4000-8000-000000000003', sourceUrl: 'https://studio.example/about', documentTitle: 'Studio page' }] });
    if (url.pathname.endsWith('/research/identities')) return reply(200, { data: [{ id: '40000000-0000-4000-8000-000000000004', displayDomain: 'studio.example' }] });
    if (url.pathname.endsWith('/research/claims')) return reply(200, { data: [] });
    if (url.pathname.endsWith('/campaigns')) return reply(200, { items: [] });
    if (url.pathname.endsWith('/offers')) return reply(200, { offers: [] });
    if (url.pathname.endsWith('/mailboxes')) return reply(200, { items: [{ id: '50000000-0000-4000-8000-000000000005', provider: 'manual', displayName: 'Manual inbox' }] });
    if (url.pathname.endsWith('/inbox/messages')) return reply(200, { items: [] });
    if (url.pathname.endsWith('/outcomes')) return reply(200, { data: [] });
    if (url.pathname.endsWith('/analytics/funnel')) return reply(200, { data: {} });
    if (url.pathname.endsWith('/crm/mappings') || url.pathname.endsWith('/crm/outbox')) return reply(200, { items: [] });
    if (url.pathname === '/growth.html') return reply(200, await fs.readFile(path.join(root, 'growth.html'), 'utf8'), 'text/html; charset=utf-8');
    const files = new Map([
      ['/css/main.css', ['css/main.css', 'text/css']],
      ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css']],
      ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript']],
      ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript']],
    ]);
    const file = files.get(url.pathname);
    if (file) return reply(200, await fs.readFile(path.join(root, file[0]), 'utf8'), file[1]);
    return reply(200, { data: [], items: [], offers: [], jobs: [], contacts: [] });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${server.address().port}/growth.html`);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  const delayedAiRequest = page.waitForRequest(request => request.url().includes(`/tenants/${ids.a}/ai`));
  await page.getByRole('tab', { name: 'Settings' }).click();
  await delayedAiRequest;
  assert.equal(await page.locator(`#view-settings #settings-ai-state`).innerText(), 'Checking');

  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.locator('#settings-ai-state[data-state="paused"]').waitFor();
  await page.getByRole('heading', { name: 'Availability' }).waitFor();
  assert.equal(await page.locator('#settings-ai-state').innerText(), 'Paused');
  assert.match(await page.locator('#settings-ai-detail').innerText(), /not enabled in this local workspace/i);
  assert.doesNotMatch(await page.locator('#view-settings').innerText(), /local_preview_egress_denied|private-model-name|999/);
  await page.getByText('Manual imports only', { exact: true }).waitFor();
  await page.getByText(/1 business and 1 saved page are available/).waitFor();
  assert.match(await page.locator('#settings-research-detail').innerText(), /analyze a supplied page/i);
  assert.doesNotMatch(await page.locator('#settings-research-detail').innerText(), /coordinator/i);

  releaseA?.();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#settings-ai-state').innerText(), 'Paused', 'late status from the previous workspace cannot overwrite the current workspace');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  assert.equal(bAiCalls, 1, 'reopening Settings reuses the current workspace status');

  await page.getByRole('button', { name: 'Refresh availability' }).click();
  await page.locator('#settings-ai-state[data-state="available"]').waitFor();
  assert.match(await page.locator('#settings-ai-detail').innerText(), /does not test live provider connectivity/i);
  assert.equal(bAiCalls, 2, 'explicit refresh performs one new AI status GET');
  await page.getByRole('button', { name: 'Refresh availability' }).click();
  await page.locator('#settings-ai-state[data-state="unavailable"]').waitFor();
  assert.match(await page.locator('#settings-ai-detail').innerText(), /could not be confirmed/i, 'malformed status is unavailable, not paused');
  assert.equal(bAiCalls, 3);
  await page.getByRole('button', { name: 'Refresh availability' }).click();
  await page.locator('#settings-ai-detail').getByText(/could not be loaded/i).waitFor();
  assert.equal(await page.locator('#settings-ai-state').innerText(), 'Unavailable', 'failed read is unavailable, not paused');
  assert.equal(bAiCalls, 4);
  assert.ok(methods.every(value => value === 'GET'), 'Settings availability and its refresh issue GET requests only');
});
