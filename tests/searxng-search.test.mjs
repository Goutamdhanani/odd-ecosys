import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-searxng-search-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('SearXNG test batch','discovery','open')").run().lastInsertRowid);
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createContact } = await import('../pipeline/contact-manager.js');
const { createSearxngSearchManager, SearxngSearchError } = await import('../pipeline/searxng-search.js');
const { setWebsiteEmailDiscoveryTestManager, setWebsiteDiscoveryJobsTestManager, setSearxngSearchFetchForTests, server } = await import('../server.js');

const searchCalls = [];
const siteCalls = [];
let nowMs = 1_800_000_000_000;
function response(payload, status = 200, contentType = 'application/json; charset=utf-8') {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': contentType } });
}

async function searchFetcher(input, options) {
  const url = new URL(input);
  searchCalls.push({ url, headers: new Headers(options.headers) });
  if (String(input).includes('not-json')) return response('<html>JSON disabled</html>', 200, 'text/html');
  if (String(input).includes('provider-403')) return response('forbidden', 403, 'text/plain');
  if (url.searchParams.get('pageno') === '2') return response({ results: [
    { title: 'Repeated Acme', url: 'https://acme.test/contact', content: 'already returned on page one' },
    { title: 'Maple Industrial Supply', url: 'https://mapleindustrial.test/company', content: 'Industrial supplier in Jaipur.', engine: 'fixture' },
  ] });
  if (url.searchParams.get('pageno') === '3') return response({ results: [] });
  return response({ results: [
    { title: 'Acme Packaging', url: 'https://www.acme.test/contact?tracking=drop#top', content: 'Packaging manufacturer in Jaipur. Contact details listed on company site.', engine: 'fixture' },
    { title: 'Duplicate Acme listing', url: 'https://acme.test/about', content: 'duplicate domain' },
    { title: 'Facebook company profile', url: 'https://www.facebook.com/acme', content: 'social page' },
    { title: 'Unsafe protocol', url: 'javascript:alert(1)', content: 'should be rejected' },
    { title: '', url: 'https://empty-title.test/', content: 'no title' },
    { title: 'North Star Components', url: 'https://northstar.test/company', content: '<script>untrusted summary</script> Electronics supplier.' },
  ] });
}

async function siteFetcher(input) {
  const url = new URL(input);
  siteCalls.push(url.href);
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0', { headers: { 'content-type': 'text/plain' } });
  if (url.hostname.endsWith('acme.test')) return new Response(`<html><body>Public business contact: <a href="mailto:sales@${url.hostname}">sales@${url.hostname}</a></body></html>`, { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'northstar.test') return new Response('<html><body>North Star Components. Email office@northstar.test</body></html>', { headers: { 'content-type': 'text/html' } });
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

const discovery = createWebsiteEmailDiscovery({ db, fetchImpl: siteFetcher, minimumRequestIntervalMs: 0, wait: async () => {} });
const websiteJobs = createWebsiteDiscoveryJobs({ db, discovery, createContact, schedule: callback => setImmediate(callback) });
const manager = createSearxngSearchManager({ db, websiteDiscoveryJobs: websiteJobs, fetcher: searchFetcher, now: () => { const value = nowMs; nowMs += 1_100; return value; } });
setWebsiteEmailDiscoveryTestManager(discovery);
setWebsiteDiscoveryJobsTestManager(websiteJobs);
setSearxngSearchFetchForTests(searchFetcher);
if (!server.listening) await once(server, 'listening');
const apiBase = `http://127.0.0.1:${server.address().port}`;

after(() => {
  websiteJobs.close();
  server.closeAllConnections?.();
  server.close();
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function jsonRequest(route, { method = 'GET', body } = {}) {
  const responseResult = await fetch(`${apiBase}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: responseResult.status, body: await responseResult.json() };
}

async function waitForDiscoveryJob(id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = websiteJobs.getJob(id);
    if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Website job ${id} did not settle.`);
}

test('SearXNG endpoint is owner-configured, HTTPS-only, and its optional proxy token stays encrypted', () => {
  assert.throws(() => manager.saveConfiguration({ endpoint_url: 'https://search.example.test' }, { id: 8, role: 'operator' }),
    error => error instanceof SearxngSearchError && error.code === 'provider_admin_required');
  for (const endpoint_url of ['http://search.example.test', 'https://user:pass@search.example.test', 'https://127.0.0.1']) {
    assert.throws(() => manager.saveConfiguration({ endpoint_url }, { id: 1, role: 'owner' }), error => error.code === 'provider_endpoint_invalid');
  }
  const status = manager.saveConfiguration({ endpoint_url: 'https://search.example.test/searxng/', api_token: 'synthetic-secret' }, { id: 1, role: 'owner' });
  assert.deepEqual(status, {
    configured: true,
    endpoint_url: 'https://search.example.test/searxng',
    authentication: 'bearer_configured',
    updated_at: status.updated_at,
  });
  const saved = db.prepare('SELECT endpoint_url,api_token_enc FROM lead_search_provider_settings WHERE id=1').get();
  assert.equal(saved.endpoint_url, 'https://search.example.test/searxng');
  assert.ok(saved.api_token_enc.startsWith('oddc1:'));
  assert.equal(saved.api_token_enc.includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(status).includes('synthetic-secret'), false);
  manager.saveConfiguration({ endpoint_url: 'https://other-search.example.test' }, { id: 1, role: 'owner' });
  assert.equal(db.prepare('SELECT api_token_enc FROM lead_search_provider_settings WHERE id=1').get().api_token_enc, null,
    'changing the endpoint cannot forward the previous instance bearer token');
});

test('one bounded business query persists filtered SearXNG results and imports selected websites through the existing scan', async () => {
  manager.saveConfiguration({ endpoint_url: 'https://search.example.test/searxng', api_token: 'query-secret' }, { id: 1, role: 'owner' });
  const beforeLeads = db.prepare('SELECT COUNT(*) AS count FROM leads').get().count;
  const job = await manager.search({ batch_id: batchId, query: 'packaging manufacturers Jaipur India' });
  assert.equal(job.status, 'completed');
  assert.equal(job.result_count, 2);
  assert.equal(job.rejected_result_count, 4);
  assert.equal(job.has_more, true);
  assert.equal(job.next_page_number, 2);
  assert.equal(job.results.length, 2);
  assert.equal(job.results[0].title, 'Acme Packaging');
  assert.equal(job.results[0].url, 'https://www.acme.test/contact');
  assert.equal(job.results[0].website_url, 'https://www.acme.test/');
  assert.equal(job.results[0].canonical_domain, 'acme.test');
  assert.equal(job.results[0].imported_lead_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, beforeLeads, 'search alone does not create CRM contacts');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  const call = searchCalls.at(-1);
  assert.equal(call.url.pathname, '/searxng/search');
  assert.equal(call.url.searchParams.get('q'), 'packaging manufacturers Jaipur India');
  assert.equal(call.url.searchParams.get('format'), 'json');
  assert.equal(call.url.searchParams.get('pageno'), '1');
  assert.equal(call.url.searchParams.get('safesearch'), '1');
  assert.equal(call.headers.get('authorization'), 'Bearer query-secret');

  const selectedId = job.results.find(result => result.canonical_domain === 'acme.test').id;
  const imported = manager.importResults(job.id, { result_ids: [selectedId] });
  assert.equal(imported.imported_count, 1);
  assert.equal(imported.website_discovery_job.source, 'searxng_search');
  assert.equal(imported.website_discovery_job.tasks[0].business_name, 'Acme Packaging');
  const completed = await waitForDiscoveryJob(imported.website_discovery_job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress.found_emails, 1, JSON.stringify({ completed, siteCalls }));
  assert.equal(completed.tasks[0].emails[0].email, 'sales@www.acme.test');
  assert.equal(completed.tasks[0].emails[0].verification_status, 'unknown');
  assert.ok(siteCalls.some(url => url === 'https://www.acme.test/robots.txt'));
  assert.ok(siteCalls.some(url => url === 'https://www.acme.test/'));
  const lead = db.prepare('SELECT source,source_url,source_details,consent_recorded_at FROM leads WHERE id=?').get(completed.tasks[0].lead_id);
  assert.equal(lead.source, 'searxng_search');
  assert.equal(lead.source_url, 'https://www.acme.test/contact');
  assert.match(lead.source_details, /packaging manufacturers Jaipur India/);
  assert.equal(lead.consent_recorded_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_profile_source_evidence WHERE lead_id=? AND evidence_type='search_result'").get(completed.tasks[0].lead_id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  const pageTwo = await manager.loadNextPage(job.id);
  assert.equal(pageTwo.page_number, 2);
  assert.equal(pageTwo.status, 'completed');
  assert.equal(pageTwo.result_count, 1);
  assert.equal(pageTwo.rejected_result_count, 1, 'a company repeated on an earlier page is suppressed');
  assert.equal(pageTwo.results[0].canonical_domain, 'mapleindustrial.test');
  assert.equal(pageTwo.has_more, true);
  assert.deepEqual(pageTwo.pages.map(page => page.page_number), [1, 2]);
  const beforeIdempotentNext = searchCalls.length;
  const samePage = await manager.loadNextPage(job.id);
  assert.equal(samePage.id, pageTwo.id);
  assert.equal(searchCalls.length, beforeIdempotentNext, 'retrying the previous-page action does not issue the same provider page twice');
  const finalPage = await manager.loadNextPage(pageTwo.id);
  assert.equal(finalPage.page_number, 3);
  assert.equal(finalPage.result_count, 0);
  assert.equal(finalPage.has_more, false);
  assert.equal(finalPage.next_page_number, null);
  const northStarId = job.results.find(result => result.canonical_domain === 'northstar.test').id;
  const crossPageImport = manager.importResults(pageTwo.id, { result_ids: [northStarId, pageTwo.results[0].id] });
  assert.equal(crossPageImport.imported_count, 2);
  assert.equal(crossPageImport.website_discovery_job.task_count, 2);
  assert.equal(crossPageImport.website_discovery_job.source, 'searxng_search');
  const crossPageScan = await waitForDiscoveryJob(crossPageImport.website_discovery_job.id);
  assert.equal(crossPageScan.progress.found_emails, 1);
  assert.equal(crossPageScan.tasks.find(task => task.canonical_url === 'https://northstar.test/').emails[0].email, 'office@northstar.test');
  assert.equal(crossPageScan.tasks.find(task => task.canonical_url === 'https://northstar.test/').emails[0].verification_status, 'unknown');
  const rootHistory = manager.listJobs({ batch_id: batchId }).find(row => Number(row.id) === Number(job.id));
  assert.equal(rootHistory.page_count, 3);
  assert.equal(rootHistory.result_count_saved, 3);
  assert.equal(rootHistory.imported_count, 3);
  assert.ok(manager.listJobs().some(row => Number(row.id) === Number(job.id)), 'unfiltered history returns one row per search session');
  assert.equal(manager.getJob(pageTwo.id).results[0].imported_lead_id, crossPageImport.website_discovery_job.tasks.find(task => task.canonical_url === 'https://mapleindustrial.test/').lead_id);
  const repeated = manager.importResults(job.id, { result_ids: [selectedId] });
  assert.equal(repeated.website_discovery_job, null);
  assert.equal(repeated.imported_count, 0);
  assert.equal(repeated.already_imported_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, beforeLeads + 3);
  assert.equal(JSON.stringify(manager.getJob(job.id)).includes('query-secret'), false);
});

test('search rejects invalid query and a closed batch before network work', async () => {
  const oldCalls = searchCalls.length;
  await assert.rejects(manager.search({ batch_id: batchId, query: 'x' }), error => error.code === 'search_query_invalid');
  const closedId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Closed','discovery','closed')").run().lastInsertRowid);
  await assert.rejects(manager.search({ batch_id: closedId, query: 'manufacturers Jaipur' }), error => error.code === 'batch_closed');
  assert.equal(searchCalls.length, oldCalls);
  assert.throws(() => manager.importResults(999, { result_ids: [1] }), error => error.code === 'search_job_missing');
});

test('provider failures remain truthful and interrupted runs do not auto-retry', async () => {
  const failing = createSearxngSearchManager({
    db, websiteDiscoveryJobs: websiteJobs, fetcher: async input => String(input).includes('format=json')
      ? response('denied', 403, 'text/plain') : searchFetcher(input, {}),
    now: () => { const value = nowMs; nowMs += 1_100; return value; },
  });
  failing.saveConfiguration({ endpoint_url: 'https://provider-403.example.test' }, { id: 1, role: 'admin' });
  const beforeCalls = searchCalls.length;
  const failed = await failing.search({ batch_id: batchId, query: 'electrical parts Jaipur' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'provider_json_unavailable');
  assert.equal(failed.results.length, 0);
  assert.equal(searchCalls.length, beforeCalls, 'the isolated failing client never falls through to the other provider fixture');
  const running = db.prepare(`INSERT INTO lead_search_jobs(batch_id,provider,query,status) VALUES(?,'searxng','crash fixture','running')`).run(batchId);
  assert.equal(failing.recover(), 1);
  const interrupted = failing.getJob(Number(running.lastInsertRowid));
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.error_code, 'process_interrupted');
});

test('authenticated application routes save, search, paginate, retrieve and import SearXNG candidates', async () => {
  const initial = await jsonRequest('/api/leads/search-provider');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.configured, true);
  assert.equal(JSON.stringify(initial.body).includes('query-secret'), false);

  const settings = await jsonRequest('/api/leads/search-provider', {
    method: 'PUT', body: { endpoint_url: 'https://search.example.test/proxy', api_token: 'api-route-secret' },
  });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.settings.authentication, 'bearer_configured');
  assert.equal(JSON.stringify(settings.body).includes('api-route-secret'), false);
  assert.ok(db.prepare('SELECT api_token_enc FROM lead_search_provider_settings WHERE id=1').get().api_token_enc.startsWith('oddc1:'));

  const search = await jsonRequest('/api/leads/search-jobs', {
    method: 'POST', body: { batch_id: batchId, query: 'commercial lighting suppliers Pune' },
  });
  assert.equal(search.status, 201);
  assert.equal(search.body.status, 'completed');
  assert.equal(search.body.results.length, 2);
  assert.equal(search.body.has_more, true);
  await new Promise(resolve => setTimeout(resolve, 1_050));
  const nextPage = await jsonRequest(`/api/leads/search-jobs/${search.body.id}/next-page`, { method: 'POST', body: {} });
  assert.equal(nextPage.status, 201);
  assert.equal(nextPage.body.page_number, 2);
  assert.equal(nextPage.body.result_count, 1);
  assert.equal(nextPage.body.results[0].canonical_domain, 'mapleindustrial.test');
  assert.equal(nextPage.body.pages.length, 2);
  await new Promise(resolve => setTimeout(resolve, 1_050));
  const duplicateNextPage = await jsonRequest(`/api/leads/search-jobs/${search.body.id}/next-page`, { method: 'POST', body: {} });
  assert.equal(duplicateNextPage.status, 201);
  assert.equal(duplicateNextPage.body.id, nextPage.body.id);
  assert.equal(searchCalls.at(-1).url.searchParams.get('pageno'), '2', 'a repeated click returns the saved child page without a duplicate provider call');
  const history = await jsonRequest(`/api/leads/search-jobs/${search.body.id}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.query, 'commercial lighting suppliers Pune');

  const imported = await jsonRequest(`/api/leads/search-jobs/${search.body.id}/import`, {
    method: 'POST', body: { result_ids: [search.body.results[0].id, nextPage.body.results[0].id] },
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported_count, 2);
  assert.equal(imported.body.website_discovery_job.source, 'searxng_search');
  const saved = await jsonRequest(`/api/leads/search-jobs/${search.body.id}`);
  assert.equal(saved.body.results[0].imported_lead_id, imported.body.website_discovery_job.tasks[0].lead_id);
  const savedPageTwo = await jsonRequest(`/api/leads/search-jobs/${nextPage.body.id}`);
  assert.equal(savedPageTwo.body.results[0].imported_lead_id, imported.body.website_discovery_job.tasks[1].lead_id);
  const historyList = await jsonRequest(`/api/leads/search-jobs?batch_id=${batchId}`);
  const rootSummary = historyList.body.find(row => Number(row.id) === Number(search.body.id));
  assert.equal(rootSummary.page_count, 2);
  assert.equal(rootSummary.result_count_saved, 3);
  assert.equal(rootSummary.imported_count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});
