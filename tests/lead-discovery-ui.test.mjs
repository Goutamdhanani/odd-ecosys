import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const contentType = file => file.endsWith('.js') ? 'text/javascript; charset=utf-8'
  : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
const appSource = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/observatory.css"><link rel="stylesheet" href="/css/contact-edit.css"></head><body><main id="main-content"></main><script type="module">import {renderLeads} from '/js/leads.js'; window.__workspaceRole='operator'; await renderLeads(document.querySelector('#main-content'));</script></body></html>`;
let createBody = null;
let currentJob = null;
const jobHistory = [];
let savedSearchBody = null;
const savedSearches = [];
let interpretedQuery = null;
let interpretationFixture = { interpretation: {
  country: 'India', state: 'Rajasthan', cities: ['Jaipur'], niches: ['handicraft exporter'],
  include_epch_directory: true, unsupported_constraints: ['At least 50 employees', '<img src=x onerror=alert(1)>'],
  clarifying_questions: [], review_notice: 'This is an AI interpretation, not researched company data. Review it first.',
}, provider: 'openai-compatible', model: 'fixture-model', provider_scope: 'personal' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': contentType('index.html') }); res.end(appSource); return; }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/batches') return res.end(JSON.stringify([{ id: 3, name: 'Fixture batch', status: 'open' }]));
    if (req.method === 'GET' && url.pathname === '/api/contact-tags') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-segments') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-fields') return res.end(JSON.stringify({ fields: [] }));
    if (req.method === 'GET' && url.pathname === '/api/leads') return res.end(JSON.stringify({ leads: [], pagination: { total: 0, hasMore: false, nextCursor: null } }));
    if (req.method === 'GET' && url.pathname === '/api/lead-strategies') return res.end(JSON.stringify({
      provider: { provider: 'openai-compatible', model: 'fixture-model', ready: true },
      settings: { canEdit: true, personalConfigured: true }, strategies: [],
    }));
    if (req.method === 'POST' && url.pathname === '/api/lead-strategies/discovery-search-interpretation') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      interpretedQuery = JSON.parse(Buffer.concat(chunks).toString()).query;
      return res.end(JSON.stringify(interpretationFixture));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/search-provider') return res.end(JSON.stringify({ configured: true, endpoint_url: 'https://search.fixture.test', authentication: 'none' }));
    if (req.method === 'GET' && url.pathname === '/api/leads/discovery-jobs') return res.end(JSON.stringify(jobHistory));
    if (req.method === 'GET' && url.pathname === '/api/leads/discovery-searches') return res.end(JSON.stringify(savedSearches));
    if (req.method === 'POST' && url.pathname === '/api/leads/discovery-searches') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      savedSearchBody = JSON.parse(Buffer.concat(chunks).toString());
      const { name, ...criteria } = savedSearchBody;
      const saved = { id: savedSearches.length + 1, name,
        criteria: { ...criteria, cities: criteria.cities.map(city => city.toLocaleLowerCase()),
          niches: criteria.niches.map(niche => niche.toLocaleLowerCase()) },
        created_at: '2026-10-12 00:00:00', updated_at: '2026-10-12 00:00:00' };
      savedSearches.unshift(saved);
      res.statusCode = 201;
      return res.end(JSON.stringify(saved));
    }
    const savedSearchMatch = url.pathname.match(/^\/api\/leads\/discovery-searches\/(\d+)$/);
    if (req.method === 'DELETE' && savedSearchMatch) {
      const index = savedSearches.findIndex(search => Number(search.id) === Number(savedSearchMatch[1]));
      if (index >= 0) savedSearches.splice(index, 1);
      return res.end(JSON.stringify({ deleted: index >= 0 }));
    }
    if (req.method === 'POST' && url.pathname === '/api/leads/discovery-jobs') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      createBody = JSON.parse(Buffer.concat(chunks).toString());
      currentJob = { id: 51, batch_id: 3, status: 'running', target_email_count: createBody.target_email_count,
        criteria: { ...createBody, cities: createBody.cities.map(item => item.toLowerCase()), niches: createBody.niches.map(item => item.toLowerCase()) },
        progress: { target_email_count: createBody.target_email_count, target_metric: 'unique_candidates', verified_deliverable: 4, unique_candidates: 7,
          businesses_found: 13, businesses_inspected: 9, awaiting_verification: 2, risky_or_unknown: 1, rejected_or_suppressed: 0,
          source_runs_total: 2 }, source_runs: [{ query: 'packaging business contact jaipur india', page_number: 1, status: 'scanning', result_count: 13 }] };
      jobHistory.unshift(currentJob);
      res.statusCode = 201;
      return res.end(JSON.stringify(currentJob));
    }
    const match = url.pathname.match(/^\/api\/leads\/discovery-jobs\/(\d+)(?:\/(pause|resume|cancel))?$/);
    if (match && req.method === 'GET') return res.end(JSON.stringify(currentJob));
    if (match && req.method === 'POST') {
      const [, , action] = match;
      currentJob.status = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled';
      return res.end(JSON.stringify({ job: currentJob }));
    }
    res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' }));
  }
  const assetPath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': contentType(assetPath) }); fs.createReadStream(assetPath).pipe(res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('operator can set an email-record target, retain verification filters, and control discovery', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  createBody = null; currentJob = null; jobHistory.length = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.locator('#lead-start-discovery').click();
    const dialogText = await page.locator('.studio-dialog').innerText();
    assert.match(dialogText, /every unique source-backed address is kept/i);
    assert.match(dialogText, /filter risky, unknown/i);
    await page.locator('.studio-dialog [name="country"]').fill('India');
    await page.locator('.studio-dialog [name="state"]').fill('Rajasthan');
    await page.locator('.studio-dialog [name="cities"]').fill('Jaipur\nJodhpur');
    await page.locator('.studio-dialog [name="niches"]').fill('Packaging manufacturers\nTextile exporters');
    assert.equal(await page.locator('.studio-dialog [data-lead-epch-source]').isDisabled(), true);
    await page.locator('.studio-dialog [name="niches"]').fill('Handicraft exporters');
    assert.equal(await page.locator('.studio-dialog [data-lead-epch-source]').isDisabled(), false);
    await page.locator('.studio-dialog [data-lead-epch-source]').check();
    await page.locator('.studio-dialog [name="target_email_count"]').fill('100');
    await page.locator('.studio-dialog .lead-discovery-advanced summary').click();
    assert.equal(await page.locator('.studio-dialog').getByText('Pages per search').count(), 1);
    assert.match(await page.locator('.studio-dialog').innerText(), /up to three search phrases/i);
    await page.locator('.studio-dialog [data-start-lead-discovery]').click();
    await page.locator('.lead-discovery-job').waitFor();
    assert.deepEqual(createBody.cities, ['Jaipur', 'Jodhpur']);
    assert.deepEqual(createBody.niches, ['Handicraft exporters']);
    assert.deepEqual(createBody.sources, ['searxng', 'epch_directory']);
    assert.equal(createBody.target_email_count, 100);
    assert.match(await page.locator('.lead-discovery-job').innerText(), /7 \/ 100/);
    assert.match(await page.locator('.lead-discovery-job').innerText(), /unique email records collected/i);
    assert.match(await page.locator('.lead-discovery-job').innerText(), /4 deliverable/i);
    assert.match(await page.locator('.lead-discovery-job').innerText(), /9\s+businesses checked/);
    assert.match(await page.locator('.lead-discovery-job').innerText(), /Indian handicraft exporter directory/);
    assert.match(await page.locator('.lead-discovery-job').innerText(), /No email is sent/);
    await page.locator('[data-lead-discovery-control="pause"]').click();
    await page.locator('[data-lead-discovery-control="resume"]').waitFor();
    await page.locator('[data-lead-discovery-control="resume"]').click();
    await page.locator('[data-lead-discovery-control="pause"]').waitFor();
    await page.locator('[data-lead-discovery-control="cancel"]').click();
    assert.equal(currentJob.status, 'cancelled');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('operator can save, reload, edit and run saved discovery criteria without starting on load', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  createBody = null; currentJob = null; savedSearchBody = null; savedSearches.length = 0; jobHistory.length = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.locator('#lead-start-discovery').click();
    const form = page.locator('.studio-dialog [data-lead-discovery-form]');
    await form.locator('[name="country"]').fill('India');
    await form.locator('[name="state"]').fill('Rajasthan');
    await form.locator('[name="cities"]').fill('Jaipur\nJodhpur');
    await form.locator('[name="niches"]').fill('Handicraft exporters');
    await form.locator('[data-lead-epch-source]').check();
    await form.locator('[name="target_email_count"]').fill('42');
    await form.locator('.lead-discovery-advanced summary').click();
    await form.locator('[name="max_businesses"]').fill('70');
    await form.locator('[name="max_pages_per_query"]').fill('2');
    await form.locator('[name="max_runtime_minutes"]').fill('25');
    await form.locator('[name="saved_search_name"]').fill('Jaipur handicraft exporters');
    await form.locator('[data-save-lead-discovery-search]').click();
    await page.getByText('is saved to your account.').waitFor();
    assert.equal(savedSearchBody.name, 'Jaipur handicraft exporters');
    assert.deepEqual(savedSearchBody.cities, ['Jaipur', 'Jodhpur']);
    assert.deepEqual(savedSearchBody.sources, ['searxng', 'epch_directory']);
    assert.equal('batch_id' in savedSearchBody, false, 'the account preset can be reused with another open batch');
    assert.equal(createBody, null, 'saving criteria does not launch provider work');

    await form.locator('[name="country"]').fill('Canada');
    await form.locator('[name="state"]').fill('Ontario');
    await form.locator('[name="cities"]').fill('Toronto');
    await form.locator('[name="niches"]').fill('Software companies');
    await form.locator('[name="target_email_count"]').fill('7');
    await form.locator('[name="max_businesses"]').fill('9');
    await form.locator('[name="max_pages_per_query"]').fill('1');
    await form.locator('[name="max_runtime_minutes"]').fill('3');
    await form.locator('[name="saved_search_id"]').selectOption('1');
    await form.locator('[data-load-lead-discovery-search]').click();
    assert.equal(await form.locator('[name="country"]').inputValue(), 'India');
    assert.equal(await form.locator('[name="state"]').inputValue(), 'Rajasthan');
    assert.equal(await form.locator('[name="cities"]').inputValue(), 'jaipur\njodhpur');
    assert.equal(await form.locator('[name="niches"]').inputValue(), 'handicraft exporters');
    assert.equal(await form.locator('[name="target_email_count"]').inputValue(), '42');
    assert.equal(await form.locator('[name="max_businesses"]').inputValue(), '70');
    assert.equal(await form.locator('[name="max_pages_per_query"]').inputValue(), '2');
    assert.equal(await form.locator('[name="max_runtime_minutes"]').inputValue(), '25');
    assert.equal(await form.locator('[data-lead-epch-source]').isChecked(), true);
    assert.equal(createBody, null, 'loading only restores editable form values');

    await form.locator('[name="cities"]').fill('Jaipur');
    await form.locator('[data-start-lead-discovery]').click();
    await page.locator('.lead-discovery-job').waitFor();
    assert.equal(createBody.country, 'India');
    assert.equal(createBody.state, 'Rajasthan');
    assert.deepEqual(createBody.cities, ['Jaipur']);
    assert.deepEqual(createBody.niches, ['handicraft exporters']);
    assert.equal(createBody.target_email_count, 42);
    assert.equal(createBody.max_businesses, 70);
    assert.equal(createBody.max_pages_per_query, 2);
    assert.equal(createBody.max_runtime_minutes, 25);
    assert.deepEqual(createBody.sources, ['searxng', 'epch_directory']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('plain-language AI search preview shows unsupported filters and requires review before starting', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  createBody = null; currentJob = null; interpretedQuery = null; jobHistory.length = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.locator('#lead-start-discovery').click();
    const dialog = page.locator('.studio-dialog');
    await dialog.locator('[data-ai-discovery-query]').fill('Find handicraft exporters around Jaipur with at least 50 employees');
    await dialog.locator('[data-ai-discovery-interpret]').click();
    await dialog.getByText('This search cannot filter for').waitFor();
    assert.match(await dialog.locator('[data-ai-discovery-result]').innerText(), /At least 50 employees/);
    assert.equal(await dialog.locator('[data-ai-discovery-result] img').count(), 0, 'untrusted AI suggestions are displayed as text, never executable markup');
    assert.equal(interpretedQuery, 'Find handicraft exporters around Jaipur with at least 50 employees');
    assert.equal(createBody, null, 'interpreting a request never starts a discovery job');
    await dialog.locator('[data-apply-ai-discovery]').click();
    const form = dialog.locator('[data-lead-discovery-form]');
    assert.equal(await form.locator('[name="country"]').inputValue(), 'India');
    assert.equal(await form.locator('[name="state"]').inputValue(), 'Rajasthan');
    assert.equal(await form.locator('[name="cities"]').inputValue(), 'Jaipur');
    assert.equal(await form.locator('[name="niches"]').inputValue(), 'handicraft exporter');
    assert.equal(await form.locator('[data-lead-epch-source]').isChecked(), true);
    assert.equal(createBody, null, 'applying a suggestion only fills editable fields');
    await form.locator('[data-start-lead-discovery]').click();
    await page.locator('.lead-discovery-job').waitFor();
    assert.equal(createBody.country, 'India');
    assert.deepEqual(createBody.cities, ['Jaipur']);
    assert.deepEqual(createBody.niches, ['handicraft exporter']);
    assert.deepEqual(createBody.sources, ['searxng', 'epch_directory']);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
  }
});
