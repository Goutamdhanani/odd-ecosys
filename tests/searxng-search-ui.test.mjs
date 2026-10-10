import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const appSource = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/observatory.css"><link rel="stylesheet" href="/css/contact-edit.css"></head><body><main id="main-content"></main><script type="module">import {renderLeads} from '/js/leads.js'; window.__workspaceRole='owner'; await renderLeads(document.querySelector('#main-content'));</script></body></html>`;
let savedConfiguration;
let searchRequest;
let importRequest;
let nextPageRequest = false;
let providerConfigured = false;

const resultJob = {
  id: 71, batch_id: 3, query: 'packaging makers Ahmedabad India', status: 'completed', result_count: 1,
  rejected_result_count: 0, page_number: 1, has_more: true, next_page_number: 2,
  pages: [{ id: 71, page_number: 1, status: 'completed', result_count: 1 }],
  results: [{ id: 711, job_id: 71, position: 1, title: 'Saffron Packaging Works', url: 'https://saffron.example.test/about',
    website_url: 'https://saffron.example.test/', canonical_domain: 'saffron.example.test',
    snippet: 'Packaging manufacturer with a public company website.', engine: 'synthetic', imported_lead_id: null }],
};
const nextPageJob = {
  id: 72, batch_id: 3, parent_job_id: 71, root_job_id: 71, query: resultJob.query, status: 'completed', result_count: 1,
  rejected_result_count: 1, page_number: 2, has_more: false, next_page_number: null,
  pages: [
    { id: 71, page_number: 1, status: 'completed', result_count: 1 },
    { id: 72, page_number: 2, status: 'completed', result_count: 1, rejected_result_count: 1 },
  ],
  results: [{ id: 712, job_id: 72, page_number: 2, position: 2, title: 'North Star Components', url: 'https://northstar.example.test/company',
    website_url: 'https://northstar.example.test/', canonical_domain: 'northstar.example.test',
    snippet: 'Electronic component manufacturer in Ahmedabad.', engine: 'synthetic', imported_lead_id: null }],
};
const websiteJob = {
  id: 88, batch_id: 3, source: 'searxng_search', status: 'completed', task_count: 1,
  progress: { total: 1, completed: 1, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 1 },
  tasks: [{ id: 90, lead_id: 91, business_name: 'Saffron Packaging Works', website_url: 'https://saffron.example.test/',
    status: 'completed', page_count: 2, emails: [{ email: 'hello@saffron.example.test', verification_status: 'unknown',
      source_url: 'https://saffron.example.test/contact', raw_excerpt: 'Public business contact: hello@saffron.example.test', evidence_type: 'mailto' }] }],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(appSource); return; }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/batches') return res.end(JSON.stringify([{ id: 3, name: 'Current lead batch', status: 'open' }]));
    if (req.method === 'GET' && url.pathname === '/api/contact-tags') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-segments') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-fields') return res.end(JSON.stringify({ fields: [] }));
    if (req.method === 'GET' && url.pathname === '/api/leads') return res.end(JSON.stringify({ leads: [], pagination: { total: 0, hasMore: false, nextCursor: null } }));
    if (req.method === 'GET' && url.pathname === '/api/leads/search-provider') {
      return res.end(JSON.stringify({ configured: providerConfigured, endpoint_url: providerConfigured ? 'https://search.example.test' : '',
        authentication: providerConfigured ? 'bearer_configured' : 'none', updated_at: null }));
    }
    if (req.method === 'PUT' && url.pathname === '/api/leads/search-provider') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      savedConfiguration = JSON.parse(Buffer.concat(chunks).toString());
      providerConfigured = true;
      return res.end(JSON.stringify({ settings: { configured: true, endpoint_url: savedConfiguration.endpoint_url,
        authentication: savedConfiguration.api_token ? 'bearer_configured' : 'none', updated_at: null } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/search-jobs') return res.end('[]');
    if (req.method === 'POST' && url.pathname === '/api/leads/search-jobs') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      searchRequest = JSON.parse(Buffer.concat(chunks).toString());
      res.statusCode = 201; return res.end(JSON.stringify(resultJob));
    }
    if (req.method === 'POST' && url.pathname === '/api/leads/search-jobs/71/next-page') {
      nextPageRequest = true;
      resultJob.pages = nextPageJob.pages;
      res.statusCode = 201; return res.end(JSON.stringify(nextPageJob));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/search-jobs/71') return res.end(JSON.stringify(resultJob));
    if (req.method === 'GET' && url.pathname === '/api/leads/search-jobs/72') return res.end(JSON.stringify(nextPageJob));
    if (req.method === 'POST' && /^\/api\/leads\/search-jobs\/(71|72)\/import$/.test(url.pathname)) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      importRequest = JSON.parse(Buffer.concat(chunks).toString());
      return res.end(JSON.stringify({ website_discovery_job: websiteJob, imported_count: 1, already_imported_count: 0 }));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/website-discovery-jobs/88') return res.end(JSON.stringify(websiteJob));
    res.statusCode = 404; return res.end(JSON.stringify({ error: 'Not found' }));
  }
  const assetPath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  const type = assetPath.endsWith('.js') ? 'text/javascript; charset=utf-8' : assetPath.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }); fs.createReadStream(assetPath).pipe(res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('Contacts search saves owner settings, displays persisted candidates, and starts selected site scan', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  savedConfiguration = null; searchRequest = null; importRequest = null; nextPageRequest = false; providerConfigured = false;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Search businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.waitFor();
    await dialog.locator('[name="search_endpoint"]').fill('https://search.example.test');
    await dialog.locator('[name="search_api_token"]').fill('synthetic-proxy-token');
    await dialog.getByRole('button', { name: 'Save connection' }).click();
    await dialog.getByText(/Configured · https:\/\/search\.example\.test/).waitFor();
    assert.deepEqual(savedConfiguration, {
      endpoint_url: 'https://search.example.test', api_token: 'synthetic-proxy-token', clear_api_token: false,
    });

    await dialog.locator('[name="search_query"]').fill('packaging makers Ahmedabad India');
    await dialog.getByRole('button', { name: 'Search public web' }).click();
    await dialog.getByText('Saffron Packaging Works', { exact: true }).waitFor();
    assert.deepEqual(searchRequest, { batch_id: 3, query: 'packaging makers Ahmedabad India' });
    await dialog.locator('[data-search-result-check][value="711"]').check();
    await dialog.getByRole('button', { name: 'Load results page 2' }).click();
    await dialog.getByText('North Star Components', { exact: true }).waitFor();
    assert.equal(nextPageRequest, true);
    await dialog.locator('[data-search-result-check]').check();
    await dialog.getByRole('button', { name: /Page 1 · completed · 1 new/ }).click();
    assert.equal(await dialog.locator('[data-search-result-check][value="711"]').isChecked(), true);
    await dialog.getByRole('button', { name: /Page 2 · completed · 1 new/ }).click();
    assert.equal(await dialog.locator('[data-search-result-check][value="712"]').isChecked(), true);
    await dialog.getByRole('button', { name: 'Add 2 selected and scan' }).waitFor();
    await dialog.getByRole('button', { name: 'Add 2 selected and scan' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #88' });
    await progress.waitFor();
    await progress.getByText('hello@saffron.example.test', { exact: true }).waitFor();
    assert.deepEqual(importRequest, { result_ids: [711, 712] });
    assert.match(await progress.innerText(), /not verified/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
