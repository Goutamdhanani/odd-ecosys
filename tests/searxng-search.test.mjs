import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-searxng-search-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'synthetic-searxng-bootstrap-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('SearXNG test batch','discovery','open')").run().lastInsertRowid);
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createContact } = await import('../pipeline/contact-manager.js');
const emailVerifier = await import('../pipeline/email-verifier.js');
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
  const query = url.searchParams.get('q') || '';
  if (query.includes('lookalike-fixture-one')) return response({ results: [
    { title: 'Seed One Own Site', url: 'https://seed-one.test/', content: 'The source company website must be filtered.' },
    { title: 'Maple Ontario Supply', url: 'https://maple-lookalike.test/company', content: 'A distinct public company site.' },
  ] });
  if (query.includes('lookalike-fixture-two')) return response({ results: [
    { title: 'Seed Two Own Site', url: 'https://seed-two.test/', content: 'The second source company website must be filtered.' },
    { title: 'Toronto Ontario Components', url: 'https://toronto-lookalike.test/company', content: 'A distinct public company site.' },
  ] });
  if (String(input).includes('not-json')) return response('<html>JSON disabled</html>', 200, 'text/html');
  if (String(input).includes('provider-403')) return response('forbidden', 403, 'text/plain');
  if (/upstream throttle fixture/i.test(url.searchParams.get('q') || '')) return response({ results: [],
    unresponsive_engines: [['google cse', 'Suspended: Too many requests']] });
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
const manager = createSearxngSearchManager({ db, websiteDiscoveryJobs: websiteJobs, fetcher: searchFetcher, now: () => { const value = nowMs; nowMs += 5_100; return value; } });
setWebsiteEmailDiscoveryTestManager(discovery);
setWebsiteDiscoveryJobsTestManager(websiteJobs);
setSearxngSearchFetchForTests(searchFetcher);
if (!server.listening) await once(server, 'listening');
const apiBase = `http://127.0.0.1:${server.address().port}`;
const bootstrapResponse = await fetch(`${apiBase}/api/auth/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'searxng-owner@example.test',
    password: 'Synthetic-searxng-password-9!',
    bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
  }),
});
if (bootstrapResponse.status !== 201) throw new Error(`Could not create the disposable SearXNG API user: ${bootstrapResponse.status}`);
const bootstrapCookies = bootstrapResponse.headers.get('set-cookie') || '';
const sessionToken = bootstrapCookies.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
const csrfToken = bootstrapCookies.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
if (!sessionToken || !csrfToken) throw new Error('The disposable SearXNG API user did not receive a session.');
const apiCookie = `odd_session=${decodeURIComponent(sessionToken)}; odd_csrf=${decodeURIComponent(csrfToken)}`;
const apiCsrf = decodeURIComponent(csrfToken);

after(() => {
  websiteJobs.close();
  server.closeAllConnections?.();
  server.close();
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function jsonRequest(route, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  headers.cookie = apiCookie;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = apiCsrf;
  const responseResult = await fetch(`${apiBase}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: responseResult.status, body: await responseResult.json() };
}

async function waitForDiscoveryJob(id, { verificationComplete = false } = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = websiteJobs.getJob(id);
    if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)
      && (!verificationComplete || (!Number(job.progress?.verification?.waiting || 0)
        && !Number(job.progress?.verification?.running || 0)))) return job;
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
    local_endpoint_enabled: false,
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

test('SearXNG upstream CAPTCHA and rate-limit notices become a provider throttle error', async () => {
  const before = searchCalls.length;
  const job = await manager.search({ batch_id: batchId, query: 'upstream throttle fixture' });
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'provider_rate_limited');
  assert.equal(searchCalls.length - before, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count, 0);
});

test('opt-in local mode accepts only loopback HTTP and completes a bounded local JSON connection check', async () => {
  const { createServer } = await import('node:http');
  const localServer = createServer((req, res) => {
    if (!req.url?.startsWith('/search?')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ results: [
      { title: 'Ontario small business association', url: 'https://ontario-business.example.test/', content: 'Public local fixture' },
    ] }));
  });
  localServer.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const previousSetting = db.prepare('SELECT * FROM lead_search_provider_settings WHERE id=1').get();
  const previousLocalBase = process.env.ODD_SEARXNG_LOCAL_BASE_URL;
  process.env.ODD_SEARXNG_LOCAL_BASE_URL = `http://127.0.0.1:${localServer.address().port}`;
  const localManager = createSearxngSearchManager({ db, websiteDiscoveryJobs: websiteJobs, now: () => nowMs += 5_100 });
  try {
    const endpoint_url = `http://127.0.0.1:${localServer.address().port}`;
    const status = localManager.saveConfiguration({ endpoint_url }, { id: 1, role: 'owner' });
    assert.equal(status.endpoint_url, endpoint_url);
    assert.equal(status.local_endpoint_enabled, true);
    const tested = await localManager.testConnection();
    assert.equal(tested.ok, true);
    assert.equal(tested.accepted_results, 1);
    assert.throws(() => localManager.saveConfiguration({ endpoint_url: `http://localhost:${localServer.address().port}` }, { id: 1, role: 'owner' }),
      error => error.code === 'provider_endpoint_invalid');
    assert.throws(() => localManager.saveConfiguration({ endpoint_url: 'http://127.0.0.2:8080' }, { id: 1, role: 'owner' }),
      error => error.code === 'provider_endpoint_invalid');
  } finally {
    if (previousLocalBase === undefined) delete process.env.ODD_SEARXNG_LOCAL_BASE_URL;
    else process.env.ODD_SEARXNG_LOCAL_BASE_URL = previousLocalBase;
    if (previousSetting) {
      db.prepare(`INSERT INTO lead_search_provider_settings(id,endpoint_url,api_token_enc,last_request_at_ms,updated_by,updated_at)
        VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET endpoint_url=excluded.endpoint_url,api_token_enc=excluded.api_token_enc,
        last_request_at_ms=excluded.last_request_at_ms,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(previousSetting.endpoint_url, previousSetting.api_token_enc, previousSetting.last_request_at_ms,
          previousSetting.updated_by, previousSetting.updated_at);
    } else db.prepare('DELETE FROM lead_search_provider_settings WHERE id=1').run();
    localServer.closeAllConnections?.();
    await new Promise(resolve => localServer.close(resolve));
  }
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
  const completed = await waitForDiscoveryJob(imported.website_discovery_job.id, { verificationComplete: true });
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

test('bulk company search imports selected matches once and keeps each company search as evidence', async t => {
  const targetBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Bulk search fixture','discovery','open')").run().lastInsertRowid);
  const packagingSearch = await manager.search({ batch_id: targetBatchId, query: 'Saffron Packaging Works Jaipur official website' });
  const componentsSearch = await manager.search({ batch_id: targetBatchId, query: 'North Star Components India official website' });
  const acmeFirst = packagingSearch.results.find(result => result.canonical_domain === 'acme.test');
  const acmeRepeated = componentsSearch.results.find(result => result.canonical_domain === 'acme.test');
  const components = componentsSearch.results.find(result => result.canonical_domain === 'northstar.test');
  const verifierCalls = [];
  const verifierAwareJobs = createWebsiteDiscoveryJobs({
    db, discovery, createContact, schedule: callback => setImmediate(callback),
    verifyCandidate: (emailId, context) => emailVerifier.reverifyEmailById(emailId, {
      verifyEmailImpl: async email => {
        verifierCalls.push({ email, sourceUrl: context.sourceUrl });
        return { verification_status: 'deliverable', score: 91, is_catch_all: false, is_role_account: false,
          is_free_provider: false, is_disposable: false, mx_host: `mx.${email.split('@')[1]}` };
      },
    }),
  });
  t.after(() => verifierAwareJobs.close());
  const verifierAwareManager = createSearxngSearchManager({
    db, websiteDiscoveryJobs: verifierAwareJobs, fetcher: searchFetcher,
    now: () => { const value = nowMs; nowMs += 5_100; return value; },
  });
  const imported = verifierAwareManager.importSelectedResults({ groups: [
    { search_job_id: packagingSearch.id, result_ids: [acmeFirst.id] },
    { search_job_id: componentsSearch.id, result_ids: [acmeRepeated.id, components.id] },
  ] });
  assert.equal(imported.imported_count, 2);
  assert.equal(imported.duplicate_domain_count, 1);
  assert.equal(imported.website_discovery_job.task_count, 2);
  const completed = await waitForDiscoveryJob(imported.website_discovery_job.id);
  assert.equal(completed.tasks.length, 2);
  assert.equal(completed.progress.found_emails, 2);
  const uniqueEmails = [...new Set(completed.tasks.flatMap(task => task.emails.map(row => row.email.toLowerCase())))].sort();
  assert.deepEqual(uniqueEmails, ['office@northstar.test', 'sales@www.acme.test']);
  const checkResults = db.prepare('SELECT normalized_email,status,verification_status FROM website_discovery_email_checks WHERE job_id=? ORDER BY normalized_email').all(imported.website_discovery_job.id);
  assert.deepEqual(checkResults.map(row => [row.normalized_email, row.status, row.verification_status]), [
    ['office@northstar.test', 'completed', 'deliverable'], ['sales@www.acme.test', 'completed', 'deliverable'],
  ]);
  assert.equal(new Set(verifierCalls.map(row => row.email)).size, 2);
  assert.ok(verifierCalls.every(row => row.sourceUrl.startsWith('https://')));
  const leads = db.prepare('SELECT id,normalized_domain,source_details FROM leads WHERE batch_id=? ORDER BY normalized_domain').all(targetBatchId);
  assert.equal(leads.length, 2);
  assert.match(leads.find(lead => lead.normalized_domain === 'acme.test').source_details, /Saffron Packaging Works Jaipur official website/);
  assert.match(leads.find(lead => lead.normalized_domain === 'northstar.test').source_details, /North Star Components India official website/);
  const evidence = db.prepare("SELECT l.normalized_domain,e.raw_excerpt,e.source_key FROM lead_profile_source_evidence e JOIN leads l ON l.id=e.lead_id WHERE l.batch_id=? AND e.evidence_type='search_result'").all(targetBatchId);
  assert.match(evidence.find(row => row.normalized_domain === 'acme.test').raw_excerpt, /Saffron Packaging Works Jaipur official website/);
  assert.match(evidence.find(row => row.normalized_domain === 'northstar.test').raw_excerpt, /North Star Components India official website/);
  assert.equal(evidence.find(row => row.normalized_domain === 'acme.test').source_key, `searxng_search_${packagingSearch.id}_${acmeFirst.id}`);
  assert.equal(evidence.find(row => row.normalized_domain === 'northstar.test').source_key, `searxng_search_${componentsSearch.id}_${components.id}`);
  assert.equal(manager.getJob(componentsSearch.id).results.find(result => result.id === acmeRepeated.id).imported_lead_id,
    manager.getJob(packagingSearch.id).results.find(result => result.id === acmeFirst.id).imported_lead_id);
  const replay = verifierAwareManager.importSelectedResults({ groups: [
    { search_job_id: packagingSearch.id, result_ids: [acmeFirst.id] },
    { search_job_id: componentsSearch.id, result_ids: [acmeRepeated.id, components.id] },
  ] });
  assert.equal(replay.website_discovery_job, null);
  assert.equal(replay.already_imported_count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('similar-company search preserves its source contact across pages and excludes that contact domain', async () => {
  const targetBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Similar company fixture','discovery','open')").run().lastInsertRowid);
  const sourceContact = createContact({ batch_id: targetBatchId, business_name: 'Acme Packaging',
    category: 'Packaging manufacturer', city: 'Jaipur', state: 'Rajasthan', country: 'India',
    website_url: 'https://www.acme.test/' });
  const seedLeadId = Number(sourceContact.contact.id);
  const otherBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Other seed batch','discovery','open')").run().lastInsertRowid);
  const otherContact = createContact({ batch_id: otherBatchId, business_name: 'Other Fixture Company', website_url: 'https://other-seed.test/' });
  await assert.rejects(manager.search({ batch_id: targetBatchId, query: 'similar company fixture', seed_lead_id: otherContact.contact.id }),
    error => error.code === 'search_seed_batch_mismatch');
  await assert.rejects(manager.search({ batch_id: targetBatchId, query: 'similar company fixture', seed_lead_id: 999999 }),
    error => error.code === 'search_seed_missing');

  const job = await manager.search({ batch_id: targetBatchId, query: 'similar companies to Acme Packaging Jaipur India', seed_lead_id: seedLeadId });
  assert.equal(job.seed_lead_id, seedLeadId);
  assert.deepEqual(job.results.map(result => result.canonical_domain), ['northstar.test']);
  assert.equal(job.rejected_result_count, 5, 'the search source company is excluded and remains visible in the skipped count');
  const nextPage = await manager.loadNextPage(job.id);
  assert.equal(nextPage.seed_lead_id, seedLeadId);
  assert.deepEqual(nextPage.results.map(result => result.canonical_domain), ['mapleindustrial.test']);
  assert.equal(manager.getJob(nextPage.id).seed_lead_id, seedLeadId);

  const imported = manager.importResults(job.id, { result_ids: [job.results[0].id] });
  const scanned = await waitForDiscoveryJob(imported.website_discovery_job.id);
  assert.equal(scanned.tasks[0].canonical_url, 'https://northstar.test/');
  const importedLead = db.prepare('SELECT id,source_details FROM leads WHERE batch_id=? AND normalized_domain=?').get(targetBatchId, 'northstar.test');
  assert.match(importedLead.source_details, new RegExp(`similar-company search from contact #${seedLeadId}`));
  const event = db.prepare("SELECT meta_json FROM events WHERE lead_id=? AND event_type='contact_created' ORDER BY id DESC LIMIT 1").get(importedLead.id);
  assert.equal(JSON.parse(event.meta_json).seed_lead_id, seedLeadId);
  const evidence = db.prepare("SELECT raw_excerpt FROM lead_profile_source_evidence WHERE lead_id=? AND evidence_type='search_result'").get(importedLead.id);
  assert.match(evidence.raw_excerpt, new RegExp(`Similar-company seed contact: #${seedLeadId}`));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('bulk website import rejects invalid, cross-batch and over-limit selections before creating scans', async () => {
  assert.throws(() => manager.importSelectedResults({ groups: [] }), error => error.code === 'search_selection_invalid');
  const firstBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Bulk A','discovery','open')").run().lastInsertRowid);
  const otherBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Bulk B','discovery','open')").run().lastInsertRowid);
  const first = await manager.search({ batch_id: firstBatch, query: 'first company website' });
  const second = await manager.search({ batch_id: otherBatch, query: 'second company website' });
  const firstId = first.results[0].id;
  const secondId = second.results[0].id;
  assert.throws(() => manager.importSelectedResults({ groups: [
    { search_job_id: first.id, result_ids: [firstId] },
    { search_job_id: second.id, result_ids: [secondId] },
  ] }), error => error.code === 'search_batch_mismatch');
  assert.throws(() => manager.importSelectedResults({ groups: [
    { search_job_id: first.id, result_ids: Array.from({ length: 31 }, (_, index) => index + 1) },
  ] }), error => error.code === 'search_selection_invalid');
  const sameBatchSecond = await manager.search({ batch_id: firstBatch, query: 'different company website' });
  assert.throws(() => manager.importSelectedResults({ groups: [
    { search_job_id: first.id, result_ids: [sameBatchSecond.results[0].id] },
  ] }), error => error.code === 'search_selection_invalid');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id IN (?,?)').get(firstBatch, otherBatch).count, 0);
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
    now: () => { const value = nowMs; nowMs += 5_100; return value; },
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
  const anonymousImport = await fetch(`${apiBase}/api/leads/search-jobs/import-selected`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groups: [] }),
  });
  assert.equal(anonymousImport.status, 401, 'bulk import requires a signed-in workspace user');
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

  const routeSeed = createContact({ batch_id: batchId, business_name: 'Acme Packaging Seed', category: 'Packaging manufacturer',
    city: 'Jaipur', country: 'India', website_url: 'https://www.acme.test/' });
  const seedOtherBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Seed API mismatch fixture','discovery','open')").run().lastInsertRowid);
  const seedOtherBatchContact = createContact({ batch_id: seedOtherBatchId, business_name: 'Other API Seed', website_url: 'https://other-api-seed.test/' });
  const invalidSeedSearch = await jsonRequest('/api/leads/search-jobs', {
    method: 'POST', body: { batch_id: batchId, query: 'similar companies to other api seed', seed_lead_id: seedOtherBatchContact.contact.id },
  });
  assert.equal(invalidSeedSearch.status, 422);
  assert.equal(invalidSeedSearch.body.code, 'search_seed_batch_mismatch');
  const search = await jsonRequest('/api/leads/search-jobs', {
    method: 'POST', body: { batch_id: batchId, query: 'similar companies to Acme Packaging Seed Jaipur India', seed_lead_id: routeSeed.contact.id },
  });
  assert.equal(search.status, 201, JSON.stringify(search.body));
  assert.equal(search.body.seed_lead_id, routeSeed.contact.id);
  assert.equal(search.body.status, 'completed');
  assert.equal(search.body.results.length, 1);
  assert.equal(search.body.results[0].canonical_domain, 'northstar.test');
  assert.equal(search.body.has_more, true);
  await new Promise(resolve => setTimeout(resolve, 5_100));
  const nextPage = await jsonRequest(`/api/leads/search-jobs/${search.body.id}/next-page`, { method: 'POST', body: {} });
  assert.equal(nextPage.status, 201);
  assert.equal(nextPage.body.page_number, 2);
  assert.equal(nextPage.body.result_count, 1);
  assert.equal(nextPage.body.results[0].canonical_domain, 'mapleindustrial.test');
  assert.equal(nextPage.body.seed_lead_id, routeSeed.contact.id);
  assert.equal(nextPage.body.pages.length, 2);
  await new Promise(resolve => setTimeout(resolve, 5_100));
  const duplicateNextPage = await jsonRequest(`/api/leads/search-jobs/${search.body.id}/next-page`, { method: 'POST', body: {} });
  assert.equal(duplicateNextPage.status, 201);
  assert.equal(duplicateNextPage.body.id, nextPage.body.id);
  assert.equal(searchCalls.at(-1).url.searchParams.get('pageno'), '2', 'a repeated click returns the saved child page without a duplicate provider call');
  const history = await jsonRequest(`/api/leads/search-jobs/${search.body.id}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.query, 'similar companies to Acme Packaging Seed Jaipur India');

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
  assert.equal(rootSummary.result_count_saved, 2);
  assert.equal(rootSummary.imported_count, 2);

  const bulkBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Bulk route fixture','discovery','open')").run().lastInsertRowid);
  const packaging = await manager.search({ batch_id: bulkBatchId, query: 'Saffron Packaging Works Jaipur official website' });
  const components = await manager.search({ batch_id: bulkBatchId, query: 'North Star Components India official website' });
  const bulkImport = await jsonRequest('/api/leads/search-jobs/import-selected', {
    method: 'POST', body: { groups: [
      { search_job_id: packaging.id, result_ids: [packaging.results.find(row => row.canonical_domain === 'acme.test').id] },
      { search_job_id: components.id, result_ids: [components.results.find(row => row.canonical_domain === 'northstar.test').id] },
    ] },
  });
  assert.equal(bulkImport.status, 200);
  assert.equal(bulkImport.body.imported_count, 2);
  assert.equal(bulkImport.body.website_discovery_job.task_count, 2);
  const bulkScan = await waitForDiscoveryJob(bulkImport.body.website_discovery_job.id);
  assert.equal(bulkScan.status, 'completed');
  const bulkLeads = db.prepare('SELECT normalized_domain,source_details FROM leads WHERE batch_id=? ORDER BY normalized_domain').all(bulkBatchId);
  assert.equal(bulkLeads.length, 2);
  assert.match(bulkLeads.find(row => row.normalized_domain === 'acme.test').source_details, /Saffron Packaging Works Jaipur official website/);
  assert.match(bulkLeads.find(row => row.normalized_domain === 'northstar.test').source_details, /North Star Components India official website/);
  assert.equal((await jsonRequest(`/api/leads/search-jobs/${packaging.id}`)).body.results[0].imported_lead_id,
    bulkImport.body.website_discovery_job.tasks.find(task => task.canonical_url.includes('acme.test')).lead_id);

  const lookalikeBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Lookalike API fixture','discovery','open')").run().lastInsertRowid);
  const lookalikeSeedOne = createContact({ batch_id: lookalikeBatchId, business_name: 'Seed One Company', website_url: 'https://seed-one.test/' });
  const lookalikeSeedTwo = createContact({ batch_id: lookalikeBatchId, business_name: 'Seed Two Company', website_url: 'https://seed-two.test/' });
  // Earlier service-level assertions use a synthetic clock. Rebase the persisted
  // limiter timestamp before exercising HTTP routes, which use the real clock.
  db.prepare('UPDATE lead_search_provider_settings SET last_request_at_ms=? WHERE id=1').run(Date.now() - 5_100);
  const lookalikeOne = await jsonRequest('/api/leads/search-jobs', {
    method: 'POST', body: { batch_id: lookalikeBatchId, query: 'lookalike-fixture-one Ontario official website', seed_lead_id: lookalikeSeedOne.contact.id },
  });
  await new Promise(resolve => setTimeout(resolve, 5_100));
  const lookalikeTwo = await jsonRequest('/api/leads/search-jobs', {
    method: 'POST', body: { batch_id: lookalikeBatchId, query: 'lookalike-fixture-two Ontario official website', seed_lead_id: lookalikeSeedTwo.contact.id },
  });
  assert.equal(lookalikeOne.status, 201);
  assert.equal(lookalikeTwo.status, 201);
  assert.equal(lookalikeOne.body.seed_lead_id, lookalikeSeedOne.contact.id);
  assert.equal(lookalikeTwo.body.seed_lead_id, lookalikeSeedTwo.contact.id);
  assert.deepEqual(lookalikeOne.body.results.map(row => row.canonical_domain), ['maple-lookalike.test']);
  assert.deepEqual(lookalikeTwo.body.results.map(row => row.canonical_domain), ['toronto-lookalike.test']);
  assert.equal(db.prepare('SELECT seed_lead_id FROM lead_search_jobs WHERE id=?').get(lookalikeOne.body.id).seed_lead_id, lookalikeSeedOne.contact.id);
  assert.equal(db.prepare('SELECT seed_lead_id FROM lead_search_jobs WHERE id=?').get(lookalikeTwo.body.id).seed_lead_id, lookalikeSeedTwo.contact.id);
  const lookalikeImport = await jsonRequest('/api/leads/search-jobs/import-selected', {
    method: 'POST', body: { groups: [
      { search_job_id: lookalikeOne.body.id, result_ids: [lookalikeOne.body.results[0].id] },
      { search_job_id: lookalikeTwo.body.id, result_ids: [lookalikeTwo.body.results[0].id] },
    ] },
  });
  assert.equal(lookalikeImport.status, 200);
  assert.equal(lookalikeImport.body.imported_count, 2);
  assert.equal(lookalikeImport.body.website_discovery_job.task_count, 2);
  const lookalikeScan = await waitForDiscoveryJob(lookalikeImport.body.website_discovery_job.id);
  assert.ok(['completed', 'partial'].includes(lookalikeScan.status));
  const savedLookalikeLeads = db.prepare(`SELECT normalized_domain,source_details FROM leads
    WHERE batch_id=? AND normalized_domain IN ('maple-lookalike.test','toronto-lookalike.test') ORDER BY normalized_domain`).all(lookalikeBatchId);
  assert.equal(savedLookalikeLeads.length, 2);
  assert.match(savedLookalikeLeads.find(row => row.normalized_domain === 'maple-lookalike.test').source_details, /lookalike-fixture-one/);
  assert.match(savedLookalikeLeads.find(row => row.normalized_domain === 'toronto-lookalike.test').source_details, /lookalike-fixture-two/);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});
