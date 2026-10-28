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
let seedSearchRequest;
let importRequest;
const bulkSearchRequests = [];
const bulkSearchRequestTimes = [];
let bulkImportRequest;
const bulkSearchJobs = new Map();
let nextPageRequest = false;
let providerConfigured = false;
let showSeedContact = false;
let businessSearchTemplates = [];
let templateCreateRequest = null;
let templateUpdateRequest = null;
let templateDeleteRequest = null;
let nextTemplateId = 602;
let showLookalikeContacts = false;
let mixedLookalikeBatch = false;
const lookalikeSearchRequests = [];
const lookalikeSearchRequestTimes = [];
const lookalikeSearchJobs = new Map();
const seedContact = {
  id: 1, batch_id: 3, business_name: 'Acme Packaging Seed', category: 'Packaging manufacturer',
  city: 'Jaipur', state: 'Rajasthan', country: 'India', website_url: 'https://www.acme.test/',
  source: 'manual', tags: [], emails: [], profile_source_evidence: [],
};
const lookalikeContacts = [
  seedContact,
  { id: 2, batch_id: 3, business_name: 'Maple Components Seed', category: 'Electronic components',
    city: 'Toronto', state: 'Ontario', country: 'Canada', website_url: 'https://maple.test/', source: 'manual', tags: [], emails: [], profile_source_evidence: [] },
  ...Array.from({ length: 4 }, (_, index) => ({ id: index + 3, batch_id: 3, business_name: `Ontario Seed Company ${index + 3}`,
    category: 'Industrial supplier', city: 'Toronto', state: 'Ontario', country: 'Canada', website_url: `https://seed-${index + 3}.test/`, source: 'manual', tags: [], emails: [], profile_source_evidence: [] })),
];

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
const similarCompanySearchJob = {
  id: 75, batch_id: 3, seed_lead_id: 1, query: 'similar companies to Acme Packaging Seed Packaging manufacturer Jaipur Rajasthan India official website',
  status: 'completed', result_count: 1, rejected_result_count: 1, page_number: 1, has_more: false,
  results: [{ id: 7501, job_id: 75, position: 1, title: 'North Star Components', url: 'https://northstar.example.test/company',
    website_url: 'https://northstar.example.test/', canonical_domain: 'northstar.example.test',
    snippet: 'Company result from the synthetic search source.', engine: 'synthetic', imported_lead_id: null }],
};
const websiteJob = {
  id: 88, batch_id: 3, source: 'searxng_search', status: 'completed', task_count: 1,
  progress: { total: 1, completed: 1, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 1 },
  tasks: [{ id: 90, lead_id: 91, business_name: 'Saffron Packaging Works', website_url: 'https://saffron.example.test/',
    status: 'completed', page_count: 2, emails: [{ email: 'hello@saffron.example.test', verification_status: 'unknown',
      source_url: 'https://saffron.example.test/contact', raw_excerpt: 'Public business contact: hello@saffron.example.test', evidence_type: 'mailto' }] }],
};
const bulkWebsiteJob = {
  id: 89, batch_id: 3, source: 'searxng_search', status: 'completed', task_count: 1,
  progress: { total: 1, completed: 1, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 1 },
  tasks: [{ id: 92, lead_id: 93, business_name: 'Saffron Packaging Works', website_url: 'https://saffron.example.test/',
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
    if (req.method === 'GET' && url.pathname === '/api/leads/1' && showSeedContact) return res.end(JSON.stringify(seedContact));
    const requestedLeadId = url.pathname.match(/^\/api\/leads\/(\d+)$/);
    if (req.method === 'GET' && requestedLeadId && showLookalikeContacts) {
      const contact = lookalikeContacts.find(lead => Number(lead.id) === Number(requestedLeadId[1]));
      if (contact) return res.end(JSON.stringify(mixedLookalikeBatch && Number(contact.id) === 2 ? { ...contact, batch_id: 4 } : contact));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads') {
      const leads = showLookalikeContacts ? lookalikeContacts : showSeedContact ? [seedContact] : [];
      return res.end(JSON.stringify({ leads, pagination: { total: leads.length, hasMore: false, nextCursor: null } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/search-provider') {
      return res.end(JSON.stringify({ configured: providerConfigured, endpoint_url: providerConfigured ? 'https://search.example.test' : '',
        authentication: providerConfigured ? 'bearer_configured' : 'none', updated_at: null }));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/business-search-templates') return res.end(JSON.stringify(businessSearchTemplates));
    if (req.method === 'POST' && url.pathname === '/api/leads/business-search-templates') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      templateCreateRequest = JSON.parse(Buffer.concat(chunks).toString());
      const saved = { id: nextTemplateId++, ...templateCreateRequest, created_at: '2026-10-12', updated_at: '2026-10-12' };
      businessSearchTemplates.unshift(saved);
      res.statusCode = 201; return res.end(JSON.stringify(saved));
    }
    const searchTemplateMatch = url.pathname.match(/^\/api\/leads\/business-search-templates\/(\d+)$/);
    if (searchTemplateMatch && req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      templateUpdateRequest = { id: Number(searchTemplateMatch[1]), ...JSON.parse(Buffer.concat(chunks).toString()) };
      const index = businessSearchTemplates.findIndex(item => Number(item.id) === templateUpdateRequest.id);
      if (index < 0) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Not found' })); }
      businessSearchTemplates[index] = { ...businessSearchTemplates[index], ...templateUpdateRequest };
      return res.end(JSON.stringify(businessSearchTemplates[index]));
    }
    if (searchTemplateMatch && req.method === 'DELETE') {
      templateDeleteRequest = Number(searchTemplateMatch[1]);
      businessSearchTemplates = businessSearchTemplates.filter(item => Number(item.id) !== templateDeleteRequest);
      return res.end(JSON.stringify({ deleted: true, id: templateDeleteRequest }));
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
      const request = JSON.parse(Buffer.concat(chunks).toString());
      if (request.seed_lead_id) {
        if (showLookalikeContacts) {
          lookalikeSearchRequests.push(request);
          lookalikeSearchRequestTimes.push(Date.now());
          const seed = lookalikeContacts.find(lead => Number(lead.id) === Number(request.seed_lead_id));
          const index = lookalikeSearchRequests.length;
          const jobId = 75 + index;
          const results = Number(seed?.id) === 1
            ? [{ id: 7601, job_id: jobId, position: 1, title: 'North Star Components', url: 'https://northstar.example.test/company', website_url: 'https://northstar.example.test/', canonical_domain: 'northstar.example.test', snippet: 'Electronic components company.', engine: 'synthetic', imported_lead_id: null }]
            : [
                { id: 7701, job_id: jobId, position: 1, title: 'North Star Components', url: 'https://northstar.example.test/company', website_url: 'https://northstar.example.test/', canonical_domain: 'northstar.example.test', snippet: 'Repeated candidate from another source.', engine: 'synthetic', imported_lead_id: null },
                { id: 7702, job_id: jobId, position: 2, title: 'Acme Packaging', url: 'https://acme.example.test/company', website_url: 'https://acme.example.test/', canonical_domain: 'acme.example.test', snippet: 'Packaging company in Ontario.', engine: 'synthetic', imported_lead_id: null },
              ];
          const job = { id: jobId, batch_id: 3, seed_lead_id: Number(seed?.id), query: request.query, status: 'completed', result_count: results.length, rejected_result_count: 0, page_number: 1, has_more: false, results };
          lookalikeSearchJobs.set(jobId, job);
          res.statusCode = 201; return res.end(JSON.stringify(job));
        }
        seedSearchRequest = request;
        res.statusCode = 201; return res.end(JSON.stringify(similarCompanySearchJob));
      }
      if (request.query.endsWith(' official website')) {
        bulkSearchRequests.push(request);
        bulkSearchRequestTimes.push(Date.now());
        const index = bulkSearchRequests.length;
        const noMatch = request.query.startsWith('Rare Export House');
        const saffron = request.query.startsWith('Saffron Packaging Works');
        const name = noMatch ? 'Rare Export House' : saffron ? 'Saffron Packaging Works' : 'North Star Components';
        const domain = noMatch ? 'rare.example.test' : saffron ? 'saffron.example.test' : 'northstar.example.test';
        const job = {
          id: 72 + index, batch_id: 3, query: request.query, status: 'completed', result_count: noMatch ? 0 : 1,
          rejected_result_count: 0, page_number: 1, has_more: false,
          results: noMatch ? [] : [{ id: 7300 + index, job_id: 72 + index, position: 1,
            title: name, url: `https://${domain}/company`, website_url: `https://${domain}/`,
            canonical_domain: domain, snippet: 'Public company website match.', engine: 'synthetic', imported_lead_id: null }],
        };
        bulkSearchJobs.set(job.id, job);
        res.statusCode = 201; return res.end(JSON.stringify(job));
      }
      searchRequest = request;
      res.statusCode = 201; return res.end(JSON.stringify(resultJob));
    }
    if (req.method === 'POST' && url.pathname === '/api/leads/search-jobs/import-selected') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      bulkImportRequest = JSON.parse(Buffer.concat(chunks).toString());
      res.statusCode = 200;
      return res.end(JSON.stringify({ website_discovery_job: bulkWebsiteJob, imported_count: 1, already_imported_count: 0, duplicate_domain_count: 0 }));
    }
    if (req.method === 'POST' && url.pathname === '/api/leads/search-jobs/71/next-page') {
      nextPageRequest = true;
      resultJob.pages = nextPageJob.pages;
      res.statusCode = 201; return res.end(JSON.stringify(nextPageJob));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/search-jobs/71') return res.end(JSON.stringify(resultJob));
    if (req.method === 'GET' && url.pathname === '/api/leads/search-jobs/72') return res.end(JSON.stringify(nextPageJob));
    if (req.method === 'GET' && url.pathname === '/api/leads/search-jobs/75') return res.end(JSON.stringify(similarCompanySearchJob));
    const lookalikeJob = url.pathname.match(/^\/api\/leads\/search-jobs\/(7[67])$/);
    if (req.method === 'GET' && lookalikeJob) return res.end(JSON.stringify(lookalikeSearchJobs.get(Number(lookalikeJob[1]))));
    const bulkJobMatch = url.pathname.match(/^\/api\/leads\/search-jobs\/(7[34])$/);
    if (req.method === 'GET' && bulkJobMatch) return res.end(JSON.stringify(bulkSearchJobs.get(Number(bulkJobMatch[1]))));
    if (req.method === 'POST' && /^\/api\/leads\/search-jobs\/(71|72|75)\/import$/.test(url.pathname)) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      importRequest = JSON.parse(Buffer.concat(chunks).toString());
      return res.end(JSON.stringify({ website_discovery_job: websiteJob, imported_count: 1, already_imported_count: 0 }));
    }
    if (req.method === 'GET' && url.pathname === '/api/leads/website-discovery-jobs/88') return res.end(JSON.stringify(websiteJob));
    if (req.method === 'GET' && url.pathname === '/api/leads/website-discovery-jobs/89') return res.end(JSON.stringify(bulkWebsiteJob));
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
    assert.match(await progress.innerText(), /Not checked yet/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('bulk company search lets the user review matches and imports only checked websites', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  bulkSearchRequests.splice(0); bulkSearchRequestTimes.splice(0); bulkSearchJobs.clear(); bulkImportRequest = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Search businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.locator('.business-search-bulk > summary').click();
    await dialog.locator('[data-bulk-company-names]').fill('Saffron Packaging Works\nNorth Star Components');
    await dialog.getByRole('button', { name: 'Search these companies' }).click();
    await dialog.getByText('Review possible company websites').waitFor();
    await dialog.getByRole('heading', { name: 'Saffron Packaging Works' }).waitFor();
    await dialog.getByRole('heading', { name: 'North Star Components' }).waitFor();
    assert.deepEqual(bulkSearchRequests.map(request => request.query), [
      'Saffron Packaging Works official website', 'North Star Components official website',
    ]);
    assert.ok(bulkSearchRequestTimes[1] - bulkSearchRequestTimes[0] >= 5_000,
      'bulk searches respect the server’s five-second minimum request gap');
    await dialog.locator('[data-bulk-search-result][value="73:7301"]').check();
    assert.equal(await dialog.locator('[data-import-bulk-search-results]').isEnabled(), true);
    await dialog.getByRole('button', { name: 'Add 1 selected websites and scan' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #89' });
    await progress.waitFor();
    await progress.getByText('hello@saffron.example.test', { exact: true }).waitFor();
    assert.deepEqual(bulkImportRequest, { groups: [{ search_job_id: 73, result_ids: [7301] }] });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('bulk company search keeps empty results visible and continues to later companies', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  bulkSearchRequests.splice(0); bulkSearchRequestTimes.splice(0); bulkSearchJobs.clear(); bulkImportRequest = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Search businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.locator('.business-search-bulk > summary').click();
    await dialog.locator('[data-bulk-company-names]').fill('Company One\nCompany Two\nCompany Three\nCompany Four\nCompany Five\nCompany Six');
    await dialog.getByRole('button', { name: 'Search these companies' }).click();
    await dialog.getByText('Enter 1 to 5 company names. Each name must be 3 to 120 characters.').waitFor();
    assert.equal(bulkSearchRequests.length, 0, 'invalid company counts are rejected before provider work');
    await dialog.locator('[data-bulk-company-names]').fill('Rare Export House\nSaffron Packaging Works');
    await dialog.getByRole('button', { name: 'Search these companies' }).click();
    await dialog.getByRole('heading', { name: 'Saffron Packaging Works' }).waitFor();
    await dialog.getByText('No new website matches were found.', { exact: true }).waitFor();
    assert.deepEqual(bulkSearchRequests.map(request => request.query), [
      'Rare Export House official website', 'Saffron Packaging Works official website',
    ]);
    assert.ok(bulkSearchRequestTimes[1] - bulkSearchRequestTimes[0] >= 5_000,
      'a no-result response does not bypass provider pacing');
    await dialog.locator('[data-bulk-search-result][value="74:7302"]').check();
    await dialog.getByRole('button', { name: 'Add 1 selected websites and scan' }).click();
    await page.getByRole('dialog', { name: 'Discovery job #89' }).waitFor();
    assert.deepEqual(bulkImportRequest, { groups: [{ search_job_id: 74, result_ids: [7302] }] });
  } finally {
    await browser.close();
  }
});

test('bulk company search stop control does not dispatch the next request during pacing', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  bulkSearchRequests.splice(0); bulkSearchRequestTimes.splice(0); bulkSearchJobs.clear(); bulkImportRequest = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Search businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.locator('.business-search-bulk > summary').click();
    await dialog.locator('[data-bulk-company-names]').fill('Saffron Packaging Works\nNorth Star Components\nMaple Industrial Supply');
    await dialog.getByRole('button', { name: 'Search these companies' }).click();
    await dialog.getByRole('button', { name: 'Stop after this search' }).click();
    await dialog.getByRole('heading', { name: 'Saffron Packaging Works' }).waitFor();
    await dialog.getByText(/Stopped after the current search/).waitFor();
    assert.equal(bulkSearchRequests.length, 1);
    assert.equal(bulkSearchRequests[0].query, 'Saffron Packaging Works official website');
  } finally {
    await browser.close();
  }
});

test('contact detail starts an editable similar-company search tied to its seed contact', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  showSeedContact = true; seedSearchRequest = null; importRequest = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__leadDetail === 'function');
    await page.evaluate(() => window.__leadDetail(1));
    const drawer = page.locator('#lead-detail-drawer');
    await drawer.getByRole('button', { name: 'Find similar companies' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    const query = 'similar companies to Acme Packaging Seed Packaging manufacturer Jaipur Rajasthan India official website';
    assert.equal(await dialog.locator('[name="search_query"]').inputValue(), query);
    await dialog.getByText('source company’s own website is excluded.').waitFor();
    await dialog.getByRole('button', { name: 'Search public web' }).click();
    await dialog.getByText('North Star Components', { exact: true }).waitFor();
    assert.deepEqual(seedSearchRequest, { batch_id: 3, query, seed_lead_id: 1 });
    assert.equal(await dialog.locator('[data-search-result-check]').count(), 1, 'the source company domain is absent from review candidates');
    assert.equal(importRequest, null, 'searching does not add the candidate to Contacts');
    await dialog.locator('[data-search-result-check]').check();
    await dialog.getByRole('button', { name: 'Add 1 selected and scan' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #88' });
    await progress.waitFor();
    await progress.getByText('hello@saffron.example.test', { exact: true }).waitFor();
    assert.deepEqual(importRequest, { result_ids: [7501] }, 'only the explicitly selected website reaches the guarded scan');
    assert.deepEqual(pageErrors, []);
  } finally {
    showSeedContact = false;
    await browser.close();
  }
});

test('lookalike search runs edited per-contact queries, hides repeated domains, and imports only checked websites', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  showLookalikeContacts = true; mixedLookalikeBatch = false;
  lookalikeSearchRequests.splice(0); lookalikeSearchRequestTimes.splice(0); lookalikeSearchJobs.clear(); bulkImportRequest = null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.lead-select-contact[data-lead-id="1"]').check();
    await page.locator('.lead-select-contact[data-lead-id="2"]').check();
    const start = page.getByRole('button', { name: 'Find lookalikes' });
    assert.equal(await start.isEnabled(), true);
    await start.click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('[data-lookalike-query]').count(), 2);
    assert.equal(await dialog.locator('[name="batch_id"]').inputValue(), '3');
    const firstQuery = 'Packaging companies near Jaipur India official website';
    await dialog.locator('[data-lookalike-query="1"]').fill(firstQuery);
    await dialog.getByRole('button', { name: 'Search these profiles' }).click();
    await dialog.getByText(/All 2 lookalike searches finished/).waitFor();
    assert.deepEqual(lookalikeSearchRequests, [
      { batch_id: 3, query: firstQuery, seed_lead_id: 1 },
      { batch_id: 3, query: 'similar companies to Maple Components Seed Electronic components Toronto Ontario Canada official website', seed_lead_id: 2 },
    ]);
    assert.ok(lookalikeSearchRequestTimes[1] - lookalikeSearchRequestTimes[0] >= 5_000,
      'lookalike searches respect the server’s five-second minimum request gap');
    assert.equal(await dialog.locator('[data-lookalike-search-result]').count(), 2,
      'the duplicate North Star domain appears once across both source groups');
    assert.match(await dialog.locator('.business-search-bulk-review').innerText(), /1 repeated website hidden/);
    await dialog.locator('[data-lookalike-search-result][value="77:7702"]').check();
    await dialog.getByRole('button', { name: 'Add 1 selected websites and scan' }).click();
    const progress = page.getByRole('dialog', { name: 'Discovery job #89' });
    await progress.waitFor();
    assert.deepEqual(bulkImportRequest, { groups: [{ search_job_id: 77, result_ids: [7702] }] },
      'only the explicitly selected candidate is sent to the existing guarded import flow');
    assert.deepEqual(pageErrors, []);
  } finally {
    showLookalikeContacts = false;
    await browser.close();
  }
});

test('lookalike selection rejects mixed batches and caps source companies at five', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  showLookalikeContacts = true; mixedLookalikeBatch = true;
  lookalikeSearchRequests.splice(0); lookalikeSearchRequestTimes.splice(0); lookalikeSearchJobs.clear();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.lead-select-contact[data-lead-id="1"]').check();
    await page.locator('.lead-select-contact[data-lead-id="2"]').check();
    await page.getByRole('button', { name: 'Find lookalikes' }).click();
    await page.getByText('Choose source companies from the same batch.', { exact: true }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(lookalikeSearchRequests.length, 0);
  } finally {
    await browser.close();
  }

  mixedLookalikeBatch = false;
  const limitedBrowser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const limitedPage = await limitedBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await limitedPage.goto(base, { waitUntil: 'domcontentloaded' });
    for (let id = 1; id <= 6; id += 1) await limitedPage.locator(`.lead-select-contact[data-lead-id="${id}"]`).check();
    assert.equal(await limitedPage.getByRole('button', { name: 'Find lookalikes' }).isDisabled(), true);
    assert.equal(await limitedPage.locator('#lead-lookalike-selection-note').innerText(), 'Choose no more than 5 source companies.');
  } finally {
    showLookalikeContacts = false;
    await limitedBrowser.close();
  }
});

test('lookalike stop during pacing prevents the next saved search request', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  showLookalikeContacts = true; mixedLookalikeBatch = false;
  lookalikeSearchRequests.splice(0); lookalikeSearchRequestTimes.splice(0); lookalikeSearchJobs.clear();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.lead-select-contact[data-lead-id="1"]').check();
    await page.locator('.lead-select-contact[data-lead-id="2"]').check();
    await page.getByRole('button', { name: 'Find lookalikes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Search these profiles' }).click();
    await page.waitForFunction(() => document.querySelector('[data-lookalike-search-status]')?.textContent.includes('Waiting before search 2 of 2'));
    await dialog.getByRole('button', { name: 'Stop after this search' }).click();
    await page.waitForFunction(() => document.querySelector('[data-lookalike-search-status]')?.textContent.startsWith('Stopped after the current search'));
    assert.equal(lookalikeSearchRequests.length, 1);
    assert.equal(lookalikeSearchRequests[0].seed_lead_id, 1);
  } finally {
    showLookalikeContacts = false;
    await browser.close();
  }
});

test('company-search templates fill an editable query and account actions save, update and delete without auto-search', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  businessSearchTemplates = [{ id: 601, name: 'Category by city',
    query_template: '{category} companies like {company} near {city}, {region}, {country}', created_at: '2026-10-12', updated_at: '2026-10-12' }];
  templateCreateRequest = null; templateUpdateRequest = null; templateDeleteRequest = null; nextTemplateId = 602;
  searchRequest = null; seedSearchRequest = null; showSeedContact = true;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__leadDetail === 'function');
    await page.evaluate(() => window.__leadDetail(1));
    const drawer = page.locator('#lead-detail-drawer');
    await drawer.getByRole('button', { name: 'Find similar companies' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    const templates = dialog.locator('.business-search-templates');
    await templates.locator('summary').click();
    await templates.locator('[data-search-template-select]').selectOption('601');
    await templates.getByRole('button', { name: 'Fill in pattern' }).click();
    assert.equal(await templates.locator('[data-search-template-value="company"]').inputValue(), 'Acme Packaging Seed');
    assert.equal(await templates.locator('[data-search-template-value="category"]').inputValue(), 'Packaging manufacturer');
    assert.equal(await templates.locator('[data-search-template-value="city"]').inputValue(), 'Jaipur');
    assert.equal(await templates.locator('[data-search-template-value="region"]').inputValue(), 'Rajasthan');
    assert.equal(await templates.locator('[data-search-template-value="country"]').inputValue(), 'India');
    await templates.locator('[data-search-template-value="city"]').fill('');
    await templates.getByRole('button', { name: 'Fill search box' }).click();
    await templates.getByText('Enter city to finish this search pattern.', { exact: true }).waitFor();
    assert.equal(await dialog.locator('[name="search_query"]').inputValue(), 'similar companies to Acme Packaging Seed Packaging manufacturer Jaipur Rajasthan India official website');
    await templates.locator('[data-search-template-value="city"]').fill('Jaipur');
    await templates.locator('[data-search-template-value="company"]').fill('Acme {city} Packaging Seed');
    await templates.getByRole('button', { name: 'Fill search box' }).click();
    assert.equal(await dialog.locator('[name="search_query"]').inputValue(),
      'Packaging manufacturer companies like Acme {city} Packaging Seed near Jaipur, Rajasthan, India',
    'placeholder text inside a field value must remain literal');
    await templates.getByRole('button', { name: 'Fill in pattern' }).click();
    await templates.getByRole('button', { name: 'Fill search box' }).click();
    const query = 'Packaging manufacturer companies like Acme Packaging Seed near Jaipur, Rajasthan, India';
    assert.equal(await dialog.locator('[name="search_query"]').inputValue(), query);
    assert.equal(searchRequest, null, 'choosing and filling a pattern never starts provider work');

    await templates.locator('[data-search-template-name]').fill('Supplier by region');
    await templates.locator('[data-search-template-pattern]').fill('{category} suppliers near {region}');
    await templates.getByRole('button', { name: 'Save new' }).click();
    await page.waitForTimeout(300);
    assert.equal(await templates.locator('[data-search-template-status]').innerText(), '“Supplier by region” is saved to your account. Filling it will not start a search.',
      `template save status; request=${JSON.stringify(templateCreateRequest)}; errors=${JSON.stringify(pageErrors)}`);
    assert.deepEqual(templateCreateRequest, { name: 'Supplier by region', query_template: '{category} suppliers near {region}' });
    await templates.locator('[data-search-template-pattern]').fill('{category} manufacturers near {city}, {region}');
    await templates.getByRole('button', { name: 'Update selected' }).click();
    await page.getByText('“Supplier by region” was updated.', { exact: true }).waitFor();
    assert.deepEqual(templateUpdateRequest, { id: 602, name: 'Supplier by region', query_template: '{category} manufacturers near {city}, {region}' });
    await templates.getByRole('button', { name: 'Delete selected' }).click({ timeout: 2000 });
    await page.waitForTimeout(250);
    const confirmState = await page.locator('dialog').evaluateAll(nodes => nodes.map(node => ({ role: node.getAttribute('role'), className: node.className, text: node.innerText })))
    const confirm = page.locator('dialog.studio-confirm-dialog');
    assert.equal(await confirm.count(), 1, `confirmation should open; dialogs=${JSON.stringify(confirmState)}; errors=${JSON.stringify(pageErrors)}`);
    await confirm.locator('button[type="submit"]').click();
    await page.getByText('“Supplier by region” was deleted.', { exact: true }).waitFor();
    assert.equal(templateDeleteRequest, 602);
    assert.equal(searchRequest, null, 'template CRUD never creates a search job');

    await dialog.getByRole('button', { name: 'Search public web' }).click();
    await dialog.getByText('North Star Components', { exact: true }).waitFor();
    assert.deepEqual(seedSearchRequest, { batch_id: 3, query, seed_lead_id: 1 });
    assert.deepEqual(pageErrors, []);
  } finally {
    showSeedContact = false;
    businessSearchTemplates = [];
    await browser.close();
  }
});
