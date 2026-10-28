import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-lead-discovery-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = 'b'.repeat(64);

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Discovery coordinator fixture','discovery','open')").run().lastInsertRowid);
const { createContact } = await import('../pipeline/contact-manager.js');
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createSearxngSearchManager } = await import('../pipeline/searxng-search.js');
const { createEpchDirectoryJobs } = await import('../pipeline/epch-directory-jobs.js');
const { createLeadDiscoveryJobs } = await import('../pipeline/lead-discovery-jobs.js');

const searchCalls = [];
const siteCalls = [];
let heldQuery = null;
let releaseHeldSearch = null;
let holdRuntimeSite = false;
let releaseRuntimeSite = null;
let coordinatorClock = Date.now;
let searchClock = Date.now();
function json(data) { return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); }

async function searchFetcher(input) {
  const url = new URL(input);
  searchCalls.push(url);
  if (heldQuery && url.searchParams.get('q')?.includes(heldQuery)) {
    await new Promise(resolve => { releaseHeldSearch = resolve; });
  }
  if (/rate limit fixture/i.test(url.searchParams.get('q') || '')) {
    return new Response('Search provider asked us to slow down.', { status: 429 });
  }
  if (/provider unavailable fixture/i.test(url.searchParams.get('q') || '')) {
    return new Response('Search provider is unavailable.', { status: 503 });
  }
  if (/email record target fixture/i.test(url.searchParams.get('q') || '')) return json({ results: [
    { title: 'Collected Email Fixture', url: 'https://collected-risky.test/contact', content: 'Public business contact in Toronto' },
  ] });
  if (/fallback fixture/i.test(url.searchParams.get('q') || '')) {
    const results = [{ title: 'Fallback Fixture One', url: 'https://fallback-one.test/contact', content: 'Workshop in Kochi' }];
    if (/companies/i.test(url.searchParams.get('q') || '')) results.push({
      title: 'Fallback Fixture Two', url: 'https://fallback-two.test/contact', content: 'Workshop in Kochi',
    });
    return json({ results });
  }
  if (/directory fixture/i.test(url.searchParams.get('q') || '')) return json({ results: [
    { title: 'Toronto Commercial Cleaners | Yelp', url: 'https://www.yelp.ca/biz/toronto-commercial-cleaners', content: 'Business listing' },
    { title: 'Janitorial and Cleaning Services', url: 'https://oecm.ca/marketplace/janitorial-services', content: 'Procurement marketplace' },
    { title: 'North Shore Commercial Cleaning', url: 'https://northshore-cleaning.test/contact', content: 'Commercial cleaning in Toronto' },
  ] });
  if (/runtime fixture/i.test(url.searchParams.get('q') || '')) return json({ results: [
    { title: 'Runtime Fixture Workshop', url: 'https://runtime-business.test/contact', content: 'Machine shop in Ahmedabad' },
  ] });
  if (/dentist/i.test(url.searchParams.get('q') || '')) return json({ results: [
    { title: 'Surat Dental Studio', url: 'https://dental-one.test/contact', content: 'Dental clinic in Surat' },
    { title: 'Harbor Dental Care', url: 'https://dental-two.test/contact', content: 'Dentist in Surat' },
    { title: 'Unneeded Dental Group', url: 'https://dental-unused.test/', content: 'Extra result' },
  ] });
  return json({ results: [
    { title: 'Acme Packaging', url: 'https://acme.test/contact', content: 'Packaging supplier in Jaipur' },
    { title: 'North Star Components', url: 'https://northstar.test/company', content: 'Industrial components in Jaipur' },
    { title: 'Never Needed Supply', url: 'https://never-needed.test/', content: 'Third result must not be inspected after target' },
  ] });
}

async function siteFetcher(input) {
  const url = new URL(input);
  siteCalls.push(url.href);
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0', { headers: { 'content-type': 'text/plain' } });
  if (url.hostname === 'acme.test') return new Response('<html><body>Business contact <a href="mailto:sales@acme.test">sales@acme.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'northstar.test') return new Response('<html><body>Business contact office@northstar.test</body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'northshore-cleaning.test') return new Response('<html><body><a href="mailto:office@northshore-cleaning.test">office@northshore-cleaning.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'collected-risky.test') return new Response('<html><body><a href="mailto:info@collected-risky.test">info@collected-risky.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'never-needed.test') return new Response('<html><body>unused@never-needed.test</body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'runtime-business.test') {
    if (holdRuntimeSite) await new Promise(resolve => { releaseRuntimeSite = resolve; });
    return new Response('<html><body>Contact <a href="mailto:hello@runtime-business.test">hello@runtime-business.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  }
  if (url.hostname === 'fallback-one.test') return new Response('<html><body><a href="mailto:one@fallback-one.test">one@fallback-one.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'fallback-two.test') return new Response('<html><body><a href="mailto:two@fallback-two.test">two@fallback-two.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname === 'epch-good.test') return new Response('<html><body><a href="mailto:sales@epch-good.test">sales@epch-good.test</a></body></html>', { headers: { 'content-type': 'text/html' } });
  if (url.hostname.startsWith('dental-')) return new Response(`<html><body>Public contact <a href="mailto:clinic@${url.hostname}">clinic@${url.hostname}</a></body></html>`, { headers: { 'content-type': 'text/html' } });
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

const discovery = createWebsiteEmailDiscovery({ db, fetchImpl: siteFetcher, minimumRequestIntervalMs: 0, wait: async () => {} });
const websiteJobs = createWebsiteDiscoveryJobs({
  db,
  discovery,
  createContact,
  schedule: callback => setImmediate(callback),
  verifyCandidate: async (emailId, context) => {
    const email = db.prepare('SELECT email FROM lead_emails WHERE id=?').get(emailId);
    const status = email?.email === 'info@collected-risky.test' ? 'risky' : 'deliverable';
    const score = status === 'deliverable' ? 99 : 50;
    db.prepare(`UPDATE lead_emails SET verification_status=?,confidence_score=?,verified_at=datetime('now'),
      verification_json=? WHERE id=?`).run(status, score, JSON.stringify({ source: 'synthetic-provider', source_url: context.sourceUrl }), emailId);
    return { verification_status: status };
  },
});
const searchManager = createSearxngSearchManager({
  db,
  websiteDiscoveryJobs: websiteJobs,
  fetcher: searchFetcher,
  now: () => { searchClock += 5_100; return searchClock; },
});
searchManager.saveConfiguration({ endpoint_url: 'https://search.example.test' }, { id: 1, role: 'owner' });
const epchBaseUrl = 'https://directory.fixture.test/members';
let epchPageOverride = null;
const epchAdapter = {
  async createSession() { return { directory_url: epchBaseUrl }; },
  async fetchDirectoryPage(_session, url) {
    if (epchPageOverride) return epchPageOverride(url);
    return { records: [
      { record_key: 'epch-good-record', business_key: 'epch-good-business', business_name: 'Jaipur Craft Works',
        contact_person_name: 'Rina Sample', contact_title: 'Export Manager', category: 'Handicraft exporter', city: 'Jaipur',
        state: 'Rajasthan', country: 'India', address: '15 Test Road, Jaipur', website_url: 'https://epch-good.test/',
        emails: ['info@epch-good.test'], source_url: `${epchBaseUrl}#good`,
        raw_excerpt: 'Jaipur Craft Works · Email: info@epch-good.test', content_hash: 'e'.repeat(64) },
      { record_key: 'epch-wrong-city', business_key: 'epch-wrong-city-business', business_name: 'Wrong City Crafts',
        category: 'Handicraft exporter', city: 'Surat', state: 'Gujarat', country: 'India', website_url: 'https://wrong-city.test/',
        emails: ['no@wrong-city.test'], source_url: `${epchBaseUrl}#wrong-city`, raw_excerpt: 'Wrong City Crafts', content_hash: 'f'.repeat(64) },
      { record_key: 'epch-wrong-niche', business_key: 'epch-wrong-niche-business', business_name: 'Jaipur Machinery',
        category: 'Industrial supplier', city: 'Jaipur', state: 'Rajasthan', country: 'India', website_url: 'https://wrong-niche.test/',
        emails: ['no@wrong-niche.test'], source_url: `${epchBaseUrl}#wrong-niche`, raw_excerpt: 'Jaipur Machinery', content_hash: '1'.repeat(64) },
    ], pagination_urls: [], content_hash: '2'.repeat(64), layout_detected: true };
  },
};
const epchJobs = createEpchDirectoryJobs({ db, adapter: epchAdapter, createContact, schedule: callback => setImmediate(callback),
  verifyCandidate: async emailId => {
    db.prepare(`UPDATE lead_emails SET verification_status='deliverable',confidence_score=98,verified_at=datetime('now'),
      verification_json='{"source":"synthetic-directory-verifier"}' WHERE id=?`).run(emailId);
    return { verification_status: 'deliverable' };
  },
});
const manager = createLeadDiscoveryJobs({ db, leadSearch: searchManager, websiteDiscoveryJobs: websiteJobs,
  epchDirectoryJobs: epchJobs, now: () => coordinatorClock(), schedule: callback => setImmediate(callback) });
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
const { server, setWebsiteEmailDiscoveryTestManager, setWebsiteDiscoveryJobsTestManager,
  setEpchDirectoryJobsTestManager, setSearxngSearchFetchForTests, setLeadDiscoveryJobsTestManager } = await import('../server.js');
setWebsiteEmailDiscoveryTestManager(discovery);
setWebsiteDiscoveryJobsTestManager(websiteJobs);
setSearxngSearchFetchForTests(searchFetcher);
setEpchDirectoryJobsTestManager(epchJobs);
setLeadDiscoveryJobsTestManager(manager);
if (!server.listening) await once(server, 'listening');
const apiBase = `http://127.0.0.1:${server.address().port}`;

after(() => {
  manager.close();
  epchJobs.close();
  websiteJobs.close();
  server.closeAllConnections?.();
  server.close();
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function waitForJob(id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = manager.getJob(id);
    if (['completed','partial','blocked','failed','cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stuck = manager.getJob(id);
  if (['completed','partial','blocked','failed','cancelled'].includes(stuck?.status)) return stuck;
  throw new Error(`Lead discovery job ${id} did not finish: ${JSON.stringify({ status: stuck?.status, error_code: stuck?.error_code,
    progress: stuck?.progress, runs: stuck?.source_runs?.map(run => ({ status: run.status, error_code: run.error_code,
      search_job_id: run.search_job_id, result_count: run.result_count, imported_count: run.imported_count })) })}`);
}

async function waitForCondition(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test('criteria are persisted, location-specific, bounded, and role checked', () => {
  assert.throws(() => manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'], niches: ['Packaging'] }, { id: 2, role: 'reviewer' }),
    error => error.code === 'lead_discovery_forbidden');
  assert.throws(() => manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'], niches: ['Packaging'], max_businesses: 1001 }, { id: 2, role: 'operator' }),
    error => error.code === 'criteria_invalid');
  assert.throws(() => manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'], niches: ['Packaging'], sources: ['epch_directory'] }, { id: 2, role: 'operator' }),
    error => error.code === 'epch_filter_unsupported');
  assert.throws(() => manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'], niches: ['Packaging'], sources: ['unknown'] }, { id: 2, role: 'operator' }),
    error => error.code === 'source_invalid');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_discovery_jobs').get().count, 0);
  assert.throws(() => manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'], niches: ['Packaging'] }, null),
    error => error.code === 'lead_discovery_forbidden');
});

test('provider rate limits block the coordinator without dispatching remaining queries', async () => {
  const beforeSearches = searchCalls.length;
  const beforeWebsiteJobs = db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count;
  const job = manager.createJob({ batch_id: batchId, country: 'Canada', state: 'Ontario', cities: ['Toronto'],
    niches: ['Rate limit fixture'], target_email_count: 1, max_businesses: 5, max_pages_per_query: 1 },
  { id: 9, role: 'operator' });

  let blocked = await waitForJob(job.id);
  if (blocked.status !== 'blocked') throw new Error(`Expected provider throttle to block the run, got ${blocked.status}.`);
  blocked = manager.getJob(job.id);
  assert.equal(blocked.error_code, 'provider_rate_limited');
  assert.equal(blocked.source_runs[0].status, 'failed');
  assert.equal(blocked.source_runs[0].error_code, 'provider_rate_limited');
  assert.equal(blocked.source_runs.filter(run => run.status === 'queued').length, 2,
    'unattempted query variants remain queued for manual resume');
  assert.equal(searchCalls.length - beforeSearches, 1, 'the coordinator stops after the first 429');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count, beforeWebsiteJobs,
    'no website scans start from a failed throttled search');
});

test('provider outage blocks the coordinator instead of retrying every queued query', async () => {
  const beforeSearches = searchCalls.length;
  const job = manager.createJob({ batch_id: batchId, country: 'Canada', state: 'Ontario', cities: ['Toronto'],
    niches: ['Provider unavailable fixture'], target_email_count: 1, max_businesses: 5, max_pages_per_query: 1 },
  { id: 9, role: 'operator' });

  const blocked = await waitForJob(job.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error_code, 'provider_unavailable');
  assert.equal(blocked.source_runs[0].status, 'failed');
  assert.equal(blocked.source_runs.filter(run => run.status === 'queued').length, 2);
  assert.equal(searchCalls.length - beforeSearches, 1, 'no additional request follows the provider outage');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('one bounded coordinator run scans one site at a time and stops when the unique collected-email target is reached', async () => {
  const pageOneSearchCount = searchCalls.filter(url => url.searchParams.get('pageno') === '1').length;
  const job = manager.createJob({
    batch_id: batchId,
    country: 'India', state: 'Rajasthan', cities: ['Jaipur', 'Jodhpur'], niches: ['Packaging', 'Textile manufacturers'],
    target_email_count: 2, max_businesses: 5, max_pages_per_query: 2, max_runtime_minutes: 2,
  }, { id: 9, role: 'operator' });
  assert.equal(job.status, 'queued');
  assert.equal(job.criteria.queries.length, 12);
  assert.match(job.criteria.queries[0].query, /jaipur Rajasthan India/i);
  assert.deepEqual(job.criteria.queries.slice(0, 3).map(item => item.variant), [1, 2, 3]);
  assert.equal(job.target_email_count, 2);

  const completed = await waitForJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress.verified_deliverable, 2);
  assert.equal(completed.progress.target_email_count, 2);
  assert.equal(completed.progress.target_metric, 'unique_candidates');
  assert.equal(completed.progress.businesses_found, 3);
  assert.equal(completed.progress.businesses_inspected, 2);
  assert.equal(completed.progress.unique_candidates, 2);
  assert.equal(completed.progress.awaiting_verification, 0);
  assert.equal(completed.source_runs.filter(run => run.status === 'scanning').length, 0);
  const scopedLead = db.prepare(`SELECT l.category,l.city,l.state,l.country FROM lead_discovery_scan_handoffs h
    JOIN website_discovery_tasks t ON t.job_id=h.website_job_id JOIN leads l ON l.id=t.lead_id
    WHERE h.job_id=? ORDER BY h.id LIMIT 1`).get(job.id);
  assert.deepEqual(scopedLead, { category: 'Packaging', city: 'Jaipur', state: 'Rajasthan', country: 'India' },
    'automated search results keep the operator-selected business niche and location on the contact');
  const handoffs = db.prepare('SELECT status,search_result_id,website_job_id FROM lead_discovery_scan_handoffs WHERE job_id=? ORDER BY id').all(job.id);
  assert.equal(handoffs.length, 2, JSON.stringify(handoffs));
  assert.equal(handoffs.every(row => ['completed','cancelled'].includes(row.status)), true, JSON.stringify(handoffs));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  assert.equal(siteCalls.some(url => url.includes('never-needed.test')), false, 'the next business is not fetched after the target is met');
  assert.equal(searchCalls.filter(url => url.searchParams.get('pageno') === '1').length - pageOneSearchCount, 1);
});

test('risky email records count toward collection and remain saved for filtering', async () => {
  const beforeLeadCount = db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count;
  const beforeEmailCount = db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count;
  const beforeSearchCount = searchCalls.length;
  const job = manager.createJob({
    batch_id: batchId, country: 'Canada', state: 'Ontario', cities: ['Toronto'],
    niches: ['Email record target fixture'], target_email_count: 1, max_businesses: 4, max_pages_per_query: 1,
  }, { id: 9, role: 'operator' });

  const completed = await waitForJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress.target_metric, 'unique_candidates');
  assert.equal(completed.progress.unique_candidates, 1);
  assert.equal(completed.progress.verified_deliverable, 0);
  assert.equal(completed.progress.risky_or_unknown, 1);
  assert.equal(completed.progress.target_email_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count, beforeLeadCount + 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails').get().count, beforeEmailCount + 1);
  assert.equal(db.prepare("SELECT verification_status FROM lead_emails WHERE email='info@collected-risky.test'").get().verification_status, 'risky');
  assert.ok(db.prepare("SELECT COUNT(*) AS count FROM lead_email_source_evidence e JOIN lead_emails l ON l.id=e.lead_email_id WHERE l.email='info@collected-risky.test'").get().count >= 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  assert.equal(searchCalls.length - beforeSearchCount, 1, 'the coordinator stops scheduling new searches once it has collected one unique address');
});

test('automatic discovery skips directories and marketplaces and counts only company websites', async () => {
  const beforeSites = siteCalls.length;
  const job = manager.createJob({ batch_id: batchId, country: 'Canada', state: 'Ontario', cities: ['Toronto'],
    niches: ['Directory fixture'], target_email_count: 1, max_businesses: 5, max_pages_per_query: 1 },
  { id: 9, role: 'operator' });
  const completed = await waitForJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress.businesses_found, 1, 'directory URLs do not inflate the business count');
  assert.equal(completed.progress.businesses_inspected, 1);
  assert.equal(completed.progress.verified_deliverable, 1);
  const fetchedHosts = siteCalls.slice(beforeSites).map(value => new URL(value).hostname);
  assert.ok(fetchedHosts.includes('northshore-cleaning.test'));
  assert.equal(fetchedHosts.some(host => host.endsWith('yelp.ca') || host === 'oecm.ca'), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE website_url LIKE '%yelp.ca%' OR website_url LIKE '%oecm.ca%'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('finite search phrasing fallback skips websites already inspected for the same job', async () => {
  const beforeSites = siteCalls.length;
  const beforeSearches = searchCalls.length;
  const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Kochi'], niches: ['Fallback fixture'],
    target_email_count: 2, max_businesses: 8, max_pages_per_query: 1 }, { id: 9, role: 'operator' });
  const completed = await waitForJob(job.id);
  assert.equal(completed.status, 'completed', JSON.stringify({ status: completed.status, error_code: completed.error_code,
    progress: completed.progress, source_runs: completed.source_runs.map(run => ({ query: run.query, status: run.status, error_code: run.error_code,
      result_count: run.result_count, imported_count: run.imported_count })) }, null, 2));
  assert.equal(completed.progress.verified_deliverable, 2);
  assert.equal(completed.progress.businesses_inspected, 2);
  const runQueries = completed.source_runs.map(run => run.query);
  assert.equal(runQueries.length, 3);
  assert.match(runQueries[0], /business contact/i);
  assert.match(runQueries[1], /companies/i);
  assert.equal(searchCalls.length - beforeSearches, 2, 'fallback stops as soon as the strict target is met');
  const scannedHosts = siteCalls.slice(beforeSites).map(url => new URL(url).hostname)
    .filter(host => /^fallback-(one|two)\.test$/.test(host));
  assert.deepEqual([...new Set(scannedHosts)].sort(), ['fallback-one.test', 'fallback-two.test']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('EPCH opt-in filters exact city and niche, then verifies directory email and scans its cited website', async () => {
  const beforeWebsiteTasks = db.prepare('SELECT COUNT(*) AS count FROM website_discovery_tasks').get().count;
  const response = await fetch(`${apiBase}/api/leads/discovery-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId, country: 'India', state: 'Rajasthan', cities: ['Jaipur'],
      niches: ['Handicraft exporters'], sources: ['epch_directory'], target_email_count: 2, max_businesses: 5,
      max_pages_per_query: 2 }) });
  assert.equal(response.status, 201);
  const job = await response.json();
  assert.deepEqual(job.criteria.sources, ['epch_directory']);
  assert.deepEqual(job.criteria.epch_filter, { country: 'india', state: 'rajasthan', cities: ['jaipur'], niches: ['handicraft exporter'] });
  const completed = await waitForJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress.verified_deliverable, 2);
  assert.equal(completed.progress.unique_candidates, 2);
  assert.equal(completed.progress.businesses_found, 1);
  assert.equal(completed.progress.businesses_inspected, 1);
  assert.equal(completed.source_runs.length, 1);
  assert.equal(completed.source_runs[0].source_type, 'epch_directory');
  assert.equal(completed.source_runs[0].directory_status, 'completed');
  const directoryId = completed.source_runs[0].directory_job_id;
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM epch_directory_records WHERE job_id=?').get(directoryId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name IN ('Wrong City Crafts','Jaipur Machinery')").get().count, 0);
  assert.equal(db.prepare("SELECT verification_status FROM lead_emails WHERE email='info@epch-good.test'").get().verification_status, 'deliverable');
  assert.equal(db.prepare("SELECT verification_status FROM lead_emails WHERE email='sales@epch-good.test'").get().verification_status, 'deliverable');
  const savedHandoff = db.prepare("SELECT source_run_id,lead_id,website_job_id FROM lead_discovery_directory_scan_handoffs WHERE job_id=? AND status='completed'").get(job.id);
  assert.ok(savedHandoff);
  const savedLead = db.prepare('SELECT business_name,website_url,category,city,state,country FROM leads WHERE id=?').get(savedHandoff.lead_id);
  const duplicateDispatch = websiteJobs.createJob({ batch_id: batchId, source: 'epch_directory',
    sourceContext: { directoryJobId: completed.source_runs[0].directory_job_id,
      leadDiscoveryJobId: job.id, leadDiscoverySourceRunId: savedHandoff.source_run_id },
    businesses: [{ lead_id: savedHandoff.lead_id, ...savedLead }] });
  assert.equal(duplicateDispatch.id, savedHandoff.website_job_id, 'a repeated dispatch returns the durable child instead of starting a second scan');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM website_discovery_jobs WHERE source='epch_directory'").get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_tasks').get().count, beforeWebsiteTasks + 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('pause, resume, cancel, and restart recovery preserve durable job state', () => {
  const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Surat'], niches: ['Machine shops'], target_email_count: 9 },
    { id: 9, role: 'operator' });
  const paused = manager.control(job.id, 'pause', { id: 9, role: 'operator' });
  assert.equal(paused.status, 'paused');
  const resumed = manager.control(job.id, 'resume', { id: 9, role: 'operator' });
  assert.equal(resumed.status, 'queued');
  db.prepare("UPDATE lead_discovery_jobs SET status='running' WHERE id=?").run(job.id);
  assert.equal(manager.recover(), 1);
  assert.equal(manager.getJob(job.id).status, 'queued');
  const cancelled = manager.control(job.id, 'cancel', { id: 9, role: 'operator' });
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => manager.control(job.id, 'resume', { id: 9, role: 'operator' }), error => error.code === 'job_not_resumable');
});

test('pause during a search saves its cursor without starting websites, then resumes from that page', async () => {
  heldQuery = 'pause fixture'; releaseHeldSearch = null;
  const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Bhopal'], niches: ['Pause fixture'], target_email_count: 1 },
    { id: 9, role: 'operator' });
  await waitForCondition(() => typeof releaseHeldSearch === 'function', 'the paused search request');
  manager.control(job.id, 'pause', { id: 9, role: 'operator' });
  releaseHeldSearch(); releaseHeldSearch = null; heldQuery = null;
  await waitForCondition(() => manager.getJob(job.id).status === 'paused'
    && manager.getJob(job.id).source_runs[0].status === 'scanning', 'the paused search cursor');
  const paused = manager.getJob(job.id);
  assert.equal(paused.source_runs[0].status, 'scanning');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_discovery_scan_handoffs WHERE job_id=?').get(job.id).count, 0);
  const resumed = manager.control(job.id, 'resume', { id: 9, role: 'operator' });
  assert.equal(resumed.status, 'queued');
  const completed = await waitForJob(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress.verified_deliverable, 1);
});

test('cancel during a search prevents the returned results from starting website tasks', async () => {
  heldQuery = 'cancel fixture'; releaseHeldSearch = null;
  const before = db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count;
  const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Indore'], niches: ['Cancel fixture'], target_email_count: 1 },
    { id: 9, role: 'operator' });
  await waitForCondition(() => typeof releaseHeldSearch === 'function', 'the cancellable search request');
  const cancelled = manager.control(job.id, 'cancel', { id: 9, role: 'operator' });
  assert.equal(cancelled.status, 'cancelled');
  releaseHeldSearch(); releaseHeldSearch = null; heldQuery = null;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(manager.getJob(job.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_discovery_source_runs WHERE job_id=? AND status='exhausted'").get(job.id).count, 3);
});

test('directory source pause, resume, cancel, and cooldown stay connected to the parent run', async () => {
  const emptyPage = (url, more = false) => ({ records: [], pagination_urls: more ? [`${url}?page=2`] : [],
    content_hash: '3'.repeat(64), layout_detected: true });
  let releasePausePage;
  let pauseFetchStarted;
  const pauseStarted = new Promise(resolve => { pauseFetchStarted = resolve; });
  epchPageOverride = async url => {
    if (url.includes('page=2')) return emptyPage(url);
    pauseFetchStarted();
    await new Promise(resolve => { releasePausePage = resolve; });
    return emptyPage(url, true);
  };
  try {
    const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'],
      niches: ['Handicraft exporter'], sources: ['epch_directory'], max_pages_per_query: 2 }, { id: 9, role: 'operator' });
    await Promise.race([pauseStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Directory page did not start.')), 2000))]);
    const directoryId = manager.getJob(job.id).source_runs[0].directory_job_id;
    assert.ok(directoryId);
    assert.equal(manager.control(job.id, 'pause', { id: 9, role: 'operator' }).status, 'paused');
    assert.equal(epchJobs.getJob(directoryId).status, 'pause_requested');
    releasePausePage(); releasePausePage = null;
    await waitForCondition(() => epchJobs.getJob(directoryId).status === 'paused', 'directory pause at its page boundary');
    const resumed = manager.control(job.id, 'resume', { id: 9, role: 'operator' });
    assert.equal(resumed.status, 'queued');
    await waitForCondition(() => manager.getJob(job.id).status === 'partial', 'resumed directory run to finish');
    assert.equal(epchJobs.getJob(directoryId).status, 'completed');
    assert.equal(manager.getJob(job.id).source_runs[0].status, 'completed');
  } finally {
    releasePausePage?.();
    epchPageOverride = null;
  }

  let releaseCancelPage;
  let cancelFetchStarted;
  const cancelStarted = new Promise(resolve => { cancelFetchStarted = resolve; });
  epchPageOverride = async url => {
    cancelFetchStarted();
    await new Promise(resolve => { releaseCancelPage = resolve; });
    return { records: [{ record_key: 'cancelled-directory-record', business_key: 'cancelled-directory-business',
        business_name: 'Cancelled Directory Fixture', category: 'Handicraft exporter', city: 'Jaipur', state: 'Rajasthan', country: 'India',
        website_url: 'https://cancelled-directory.fixture.test/', emails: [], source_url: `${url}#record`,
        raw_excerpt: 'Cancelled Directory Fixture', content_hash: '4'.repeat(64) }], pagination_urls: [],
        content_hash: '5'.repeat(64), layout_detected: true };
  };
  try {
    const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'],
      niches: ['Handicraft exporter'], sources: ['epch_directory'], max_pages_per_query: 1 }, { id: 9, role: 'operator' });
    await Promise.race([cancelStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellable directory page did not start.')), 2000))]);
    const directoryId = manager.getJob(job.id).source_runs[0].directory_job_id;
    const cancelled = manager.control(job.id, 'cancel', { id: 9, role: 'operator' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(manager.getJob(job.id).source_runs[0].status, 'exhausted');
    assert.equal(epchJobs.getJob(directoryId).status, 'cancel_requested');
    releaseCancelPage(); releaseCancelPage = null;
    await waitForCondition(() => epchJobs.getJob(directoryId).status === 'cancelled', 'directory cancellation to settle');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_discovery_directory_scan_handoffs WHERE job_id=?').get(job.id).count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM website_discovery_tasks WHERE job_id IN
      (SELECT website_job_id FROM lead_discovery_directory_scan_handoffs WHERE job_id=?)`).get(job.id).count, 0);
  } finally {
    releaseCancelPage?.();
    epchPageOverride = null;
  }

  let rateRequests = 0;
  epchPageOverride = async () => {
    rateRequests += 1;
    throw Object.assign(new Error('Synthetic host cooldown.'), { code: 'source_rate_limited', statusCode: 429,
      retryAfterAt: new Date(Date.now() + 60_000).toISOString() });
  };
  try {
    const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Jaipur'],
      niches: ['Handicraft exporter'], sources: ['epch_directory'] }, { id: 9, role: 'operator' });
    await waitForCondition(() => manager.getJob(job.id).status === 'partial', 'rate-limited source run to stop');
    const stopped = manager.getJob(job.id);
    assert.equal(stopped.error_code, 'source_rate_limited');
    assert.equal(stopped.source_runs[0].status, 'failed');
    assert.ok(stopped.source_runs[0].directory_retry_after_at);
    assert.equal(rateRequests, 1, 'the coordinator does not retry while the source is cooling down');
  } finally {
    epchPageOverride = null;
  }
});

test('runtime budget stops a slow search before its returned candidates start website scans', async () => {
  heldQuery = 'runtime fixture'; releaseHeldSearch = null;
  coordinatorClock = Date.now;
  const beforeScans = db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count;
  const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Ahmedabad'], niches: ['Runtime fixture'],
    target_email_count: 2, max_businesses: 10, max_pages_per_query: 1, max_runtime_minutes: 1 }, { id: 9, role: 'operator' });
  try {
    await waitForCondition(() => typeof releaseHeldSearch === 'function', 'the slow search request');
    const startedAt = Date.parse(`${manager.getJob(job.id).started_at.replace(' ', 'T')}Z`);
    const release = releaseHeldSearch;
    releaseHeldSearch = null;
    heldQuery = null;
    coordinatorClock = () => startedAt + 2 * 60_000;
    release();
    const stopped = await waitForJob(job.id);
    assert.equal(stopped.status, 'partial');
    assert.equal(stopped.error_code, 'runtime_budget_reached');
    assert.equal(stopped.source_runs[0].status, 'exhausted');
    assert.ok(stopped.source_runs[0].search_job_id, 'the late search cursor is preserved for truthful review');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count, beforeScans);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  } finally {
    coordinatorClock = Date.now;
    releaseHeldSearch?.();
    releaseHeldSearch = null;
    heldQuery = null;
  }
});

test('runtime budget cancels the active website handoff and closes all queued query work', async () => {
  heldQuery = 'runtime fixture'; releaseHeldSearch = null;
  holdRuntimeSite = true; releaseRuntimeSite = null;
  coordinatorClock = Date.now;
  const job = manager.createJob({ batch_id: batchId, country: 'India', cities: ['Ahmedabad', 'Surat'], niches: ['Runtime fixture'],
    target_email_count: 5, max_businesses: 10, max_pages_per_query: 2, max_runtime_minutes: 1 }, { id: 9, role: 'operator' });
  try {
    await waitForCondition(() => typeof releaseHeldSearch === 'function', 'the budgeted search request');
    const release = releaseHeldSearch;
    releaseHeldSearch = null;
    heldQuery = null;
    release();
    await waitForCondition(() => typeof releaseRuntimeSite === 'function'
      && db.prepare(`SELECT 1 FROM lead_discovery_scan_handoffs WHERE job_id=? AND status='running'`).get(job.id), 'the active website scan handoff');
    coordinatorClock = () => Date.now() + 2 * 60_000;
    const partial = await waitForJob(job.id);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.error_code, 'runtime_budget_reached');
    assert.equal(partial.source_runs.every(run => run.status === 'exhausted'), true, JSON.stringify(partial.source_runs));
    const handoff = db.prepare(`SELECT status FROM lead_discovery_scan_handoffs WHERE job_id=?`).get(job.id);
    assert.equal(handoff.status, 'cancelled');
    const childId = db.prepare(`SELECT website_job_id FROM lead_discovery_scan_handoffs WHERE job_id=?`).get(job.id).website_job_id;
    assert.equal(db.prepare(`SELECT status FROM website_discovery_jobs WHERE id=?`).get(childId).status, 'cancel_requested');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  } finally {
    coordinatorClock = Date.now;
    releaseHeldSearch?.();
    releaseRuntimeSite?.();
    holdRuntimeSite = false;
    heldQuery = null;
  }
});

test('discovery API creates and serves a persisted job', async () => {
  const response = await fetch(`${apiBase}/api/leads/discovery-jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId, country: 'India', cities: ['Surat'], niches: ['Dentists'], target_email_count: 1,
      max_businesses: 3, max_pages_per_query: 1, max_runtime_minutes: 1 }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.status, 'queued');
  const completed = await waitForJob(created.id);
  assert.equal(completed.status, 'completed');
  const read = await fetch(`${apiBase}/api/leads/discovery-jobs/${created.id}`);
  assert.equal(read.status, 200);
  const saved = await read.json();
  assert.equal(saved.progress.verified_deliverable, 1);
  assert.equal(saved.progress.target_email_count, 1);
  assert.equal(saved.criteria.cities[0], 'surat');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('pausing and resuming a parent safely ignores an already-completed website child and schedules recovery', () => {
  const scheduled = [];
  const childCalls = [];
  const terminalChildJobs = {
    getJob: id => ({ id, status: 'completed' }),
    pause: id => { childCalls.push(['pause', id]); throw new Error('This discovery job is already finished.'); },
    resume: id => { childCalls.push(['resume', id]); throw new Error('This discovery job is already finished.'); },
    cancel() {},
  };
  const isolated = createLeadDiscoveryJobs({
    db,
    leadSearch: { publicStatus: () => ({ configured: true }) },
    websiteDiscoveryJobs: terminalChildJobs,
    schedule: callback => { scheduled.push(callback); return null; },
  });
  const actor = { id: 12, role: 'operator' };
  const job = isolated.createJob({ batch_id: batchId, country: 'Canada', state: 'Ontario', cities: ['Toronto'], niches: ['Commercial cleaning'],
    target_email_count: 1, max_businesses: 2, max_pages_per_query: 1, max_runtime_minutes: 1 }, actor);
  const completedChildId = Number(db.prepare(`INSERT INTO website_discovery_jobs(batch_id,status,source,task_count,finished_at)
    VALUES(?,'completed','terminal-child-fixture',0,datetime('now'))`).run(batchId).lastInsertRowid);
  db.prepare(`UPDATE lead_discovery_jobs SET status='running' WHERE id=?`).run(job.id);
  db.prepare(`UPDATE lead_discovery_source_runs SET status='scanning',website_job_id=? WHERE job_id=?`).run(completedChildId, job.id);

  const paused = isolated.control(job.id, 'pause', actor);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(childCalls, []);

  const resumed = isolated.control(job.id, 'resume', actor);
  assert.equal(resumed.status, 'queued');
  assert.deepEqual(childCalls, []);
  assert.ok(scheduled.length >= 3, 'resume schedules the parent coordinator even when the child already completed');
  isolated.close();
  db.prepare(`UPDATE lead_discovery_jobs SET status='cancelled',finished_at=datetime('now') WHERE id=?`).run(job.id);
  db.prepare(`UPDATE lead_discovery_source_runs SET status='exhausted',finished_at=datetime('now') WHERE job_id=?`).run(job.id);
});

test('parent controls tolerate a website child completing between status read and pause or resume', () => {
  const scheduled = [];
  const childCalls = [];
  const childStates = ['running','completed','paused','completed'];
  const racingChildJobs = {
    getJob: id => ({ id, status: childStates.shift() || 'completed' }),
    pause: id => { childCalls.push(['pause', id]); throw Object.assign(new Error('This discovery job is already finished.'), { statusCode: 409 }); },
    resume: id => { childCalls.push(['resume', id]); throw Object.assign(new Error('This discovery job is already finished.'), { statusCode: 409 }); },
    cancel() {},
  };
  const isolated = createLeadDiscoveryJobs({
    db,
    leadSearch: { publicStatus: () => ({ configured: true }) },
    websiteDiscoveryJobs: racingChildJobs,
    schedule: callback => { scheduled.push(callback); return null; },
  });
  const actor = { id: 12, role: 'operator' };
  const job = isolated.createJob({ batch_id: batchId, country: 'Canada', state: 'Ontario', cities: ['Ottawa'], niches: ['Managed IT services'],
    target_email_count: 1, max_businesses: 2, max_pages_per_query: 1, max_runtime_minutes: 1 }, actor);
  const childId = Number(db.prepare(`INSERT INTO website_discovery_jobs(batch_id,status,source,task_count,finished_at)
    VALUES(?,'completed','transitioning-child-fixture',0,datetime('now'))`).run(batchId).lastInsertRowid);
  db.prepare(`UPDATE lead_discovery_jobs SET status='running' WHERE id=?`).run(job.id);
  db.prepare(`UPDATE lead_discovery_source_runs SET status='scanning',website_job_id=? WHERE job_id=?`).run(childId, job.id);

  assert.equal(isolated.control(job.id, 'pause', actor).status, 'paused');
  assert.equal(isolated.control(job.id, 'resume', actor).status, 'queued');
  assert.deepEqual(childCalls, [['pause', childId], ['resume', childId]]);
  assert.ok(scheduled.length >= 3, 'parent recovery is scheduled even when child transitions throw a terminal conflict');
  isolated.close();
  db.prepare(`UPDATE lead_discovery_jobs SET status='cancelled',finished_at=datetime('now') WHERE id=?`).run(job.id);
  db.prepare(`UPDATE lead_discovery_source_runs SET status='exhausted',finished_at=datetime('now') WHERE job_id=?`).run(job.id);
});

test('database reopen restores a running discovery job and its exact query cursor', () => {
  const deferred = createLeadDiscoveryJobs({
    db,
    leadSearch: { publicStatus: () => ({ configured: true }) },
    websiteDiscoveryJobs: { getJob: () => null, pause() {}, resume() {}, cancel() {} },
    schedule: () => ({}),
  });
  const job = deferred.createJob({ batch_id: batchId, country: 'India', state: 'Gujarat', cities: ['Vadodara'], niches: ['Industrial valves'],
    target_email_count: 17, max_businesses: 80, max_pages_per_query: 4, max_runtime_minutes: 45 }, { id: 12, role: 'operator' });
  db.prepare("UPDATE lead_discovery_jobs SET status='running',started_at=datetime('now') WHERE id=?").run(job.id);
  db.prepare("UPDATE lead_discovery_source_runs SET status='searching' WHERE job_id=? AND query_index=0").run(job.id);
  deferred.close();
  manager.close();
  websiteJobs.close();
  closeDb();

  const reopenedDb = initDb();
  const recovered = createLeadDiscoveryJobs({
    db: reopenedDb,
    leadSearch: { publicStatus: () => ({ configured: true }) },
    websiteDiscoveryJobs: { getJob: () => null, pause() {}, resume() {}, cancel() {} },
    schedule: () => ({}),
  });
  const saved = recovered.getJob(job.id);
  assert.equal(saved.status, 'queued');
  assert.equal(saved.target_email_count, 17);
  assert.deepEqual(saved.criteria.cities, ['vadodara']);
  assert.match(saved.source_runs[0].query, /industrial valves business contact vadodara Gujarat India/);
  assert.equal(saved.source_runs[0].status, 'queued');
  recovered.close();
});
