import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-epch-directory-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
delete process.env.ODD_AUTH_ENFORCE_TESTS;
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { closeDb, initDb, getDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('EPCH fixtures','discovery','open')").run().lastInsertRowid);
db.prepare("INSERT INTO suppression_list(email,reason) VALUES('held@example.test','operator suppression')").run();
const { createEpchDirectoryJobs } = await import('../pipeline/epch-directory-jobs.js');
const { EpchDirectoryError, createEpchMemberDirectoryAdapter, parseEpchDirectoryPage } = await import('../pipeline/epch-member-directory.js');
const { createEepcCbamDirectoryAdapter, EEPC_CBAM_EXTRACTOR_VERSION, EEPC_CBAM_SOURCE_URL, parseEepcCbamDirectoryPage } = await import('../pipeline/eepc-cbam-directory.js');
const { createContact } = await import('../pipeline/contact-manager.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { setEpchDirectoryJobsTestManager, setWebsiteDiscoveryJobsTestManager, setWebsiteEmailDiscoveryTestManager, server } = await import('../server.js');

const sourceUrl = 'https://epch.in/get_data.php?token=fixture';
const cbamHtml = `<p>Do not import this unrelated address: decoy@example.test</p>
  <table><thead><tr><th>Organization Name</th><th>Contact Person</th><th>Designation</th><th>E-mail</th><th>Quick Links</th></tr></thead><tbody>
  <tr><td>CBAM Advisory Co</td><td>Priya Nair</td><td>Managing Director</td><td>priya@cbam-advisory.example</td><td><a href="https://cbam-advisory.example.test/" target="_blank">Visit Website</a></td></tr>
  <tr><td>Suppressed Advisory Co</td><td>Ravi Shah</td><td>Consultant</td><td>held@example.test</td><td><a href="https://suppressed-advisory.example.test/">Website</a></td></tr>
  </tbody></table>`;
const record = (overrides = {}) => ({
  record_key: 'record-001', business_key: 'business-001', business_name: 'Kite & Loom Exports',
  contact_person_name: 'Anita Rao', address: '18 Sample Road, Jaipur, Rajasthan', city: 'Jaipur', state: 'Rajasthan', country: 'India',
  category: 'Handicraft exporter', products: 'Textiles', emails: ['team@gmail.com', 'held@example.test'],
  website_url: 'https://kite-loom.example.test/',
  source_url: `${sourceUrl}#record-001`, source_page_url: sourceUrl,
  raw_excerpt: 'Kite & Loom Exports · Email: team@gmail.com, held@example.test · Website: https://kite-loom.example.test/ · Contact Person: Anita Rao · Products: Textiles',
  content_hash: 'a'.repeat(64), ...overrides,
});

let adapterCalls = [];
let failSessionOnce = false;
let paginateDirectory = false;
let nextPageRecord = null;
const adapter = {
  async createSession() {
    if (failSessionOnce) { failSessionOnce = false; throw new EpchDirectoryError('Synthetic robots transport failure.', 'robots_unavailable', 503); }
    return { directory_url: sourceUrl };
  },
  async fetchDirectoryPage(_session, url) {
    adapterCalls.push(url);
    const pageTwo = url.includes('page=2');
    const pageRecord = nextPageRecord || (pageTwo ? record({
      record_key: 'record-api-page-2', business_key: 'business-api-page-2', business_name: 'Page Two Crafts',
      emails: ['two@paging-api.test'], source_url: `${url}#record-2`,
      raw_excerpt: 'Page Two Crafts · Email: two@paging-api.test',
    }) : record());
    return {
      records: [pageRecord],
      pagination_urls: paginateDirectory && !pageTwo ? [`${sourceUrl}&page=2`] : [],
      content_hash: (pageTwo ? 'c' : 'b').repeat(64),
      layout_detected: true,
    };
  },
};
const cbamRequests = [];
const cbamAdapter = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
  const url = new URL(input);
  cbamRequests.push(url.href);
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0', { status: 200, headers: { 'content-type': 'text/plain' } });
  return new Response(cbamHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
} });
const jobs = createEpchDirectoryJobs({ db, adapter, adapters: {
  eepc_cbam: { adapter: cbamAdapter, sourceUrl: EEPC_CBAM_SOURCE_URL, label: 'EEPC CBAM advisory directory',
    evidenceType: 'eepc_cbam_directory', extractorVersion: EEPC_CBAM_EXTRACTOR_VERSION },
}, createContact, schedule: callback => setImmediate(callback) });
setEpchDirectoryJobsTestManager(jobs);
const websiteFetches = [];
const websiteDiscovery = createWebsiteEmailDiscovery({
  db,
  minimumRequestIntervalMs: 0,
  wait: async () => {},
  fetchImpl: async input => {
    const url = new URL(input);
    websiteFetches.push(url.href);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/') return new Response('<html><body><footer><a href="mailto:sales@kite-loom.example.test">sales@kite-loom.example.test</a></footer></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  },
});
const websiteJobs = createWebsiteDiscoveryJobs({ db, discovery: websiteDiscovery, createContact, schedule: callback => setImmediate(callback) });
setWebsiteEmailDiscoveryTestManager(websiteDiscovery);
setWebsiteDiscoveryJobsTestManager(websiteJobs);
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  jobs.close();
  websiteJobs.close();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function jsonRequest(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, body: contentType.includes('json') ? await response.json() : await response.text(), headers: response.headers };
}

async function waitForJob(id, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await jsonRequest(`/api/leads/directory-jobs/${id}`);
    if (expected.includes(response.body.status)) return response.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`EPCH job ${id} did not reach ${expected.join('/')}.`);
}

async function waitForLocalDirectoryJob(manager, id, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = manager.getJob(id);
    if (expected.includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Directory job ${id} did not reach ${expected.join('/')}.`);
}

async function waitForWebsiteJob(id, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await jsonRequest(`/api/leads/website-discovery-jobs/${id}`);
    if (expected.includes(response.body.status)) return response.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Website discovery job ${id} did not reach ${expected.join('/')}.`);
}

test('source parser keeps labeled evidence, public email and pagination without guessing consent', async () => {
  const html = `<div class="member-card"><h3>Kite &amp; Loom Exports</h3><p>Contact Person: Anita Rao</p><p>Address: 18 Sample Road, Jaipur, Rajasthan</p><p>Email: team@gmail.com</p><p>Products: Textiles</p></div><div class="member-card"><h3>New Craft House</h3><p>Address: Moradabad, Uttar Pradesh</p><p>Products: Brassware</p></div><nav class="pagination"><a href="?token=fixture&amp;page=1">1</a><a href="?token=fixture&amp;page=2">2</a><a rel="next" href="?token=fixture&amp;page=2">Next</a></nav>`;
  const parsed = await parseEpchDirectoryPage(html, sourceUrl);
  assert.equal(parsed.layout_detected, true);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].business_name, 'Kite & Loom Exports');
  assert.equal(parsed.records[0].contact_person_name, 'Anita Rao');
  assert.equal(parsed.records[0].website_url, null);
  assert.deepEqual(parsed.records[0].emails, ['team@gmail.com']);
  assert.match(parsed.records[0].raw_excerpt, /team@gmail\.com/);
  assert.equal(parsed.records[0].country, 'India');
  assert.equal(parsed.records[1].business_name, 'New Craft House');
  assert.deepEqual(parsed.records[1].emails, []);
  assert.deepEqual(parsed.pagination_urls, ['https://epch.in/get_data.php?token=fixture&page=2']);
});

test('source parser retains only one explicitly labeled public company website per row', async () => {
  const html = `<div class="member-card"><h3>Anchor Website Ltd</h3><p>Website: <a href="https://anchor.example.test/about">Visit the company site</a></p><p>Address: Jaipur, Rajasthan</p></div>
    <div class="member-card"><h3>Text Website Ltd</h3><p>Address: Pune, Maharashtra</p><p>Website: www.text-site.example.test/catalog</p></div>
    <div class="member-card"><h3>Unlabeled Link Ltd</h3><a href="https://social.example.test/company">Social profile</a><p>Address: India</p></div>
    <div class="member-card"><h3>Directory Link Ltd</h3><p>Website: <a href="https://epch.in/member">Member page</a></p><p>Address: India</p></div>
    <div class="member-card"><h3>Ambiguous Website Ltd</h3><p>Website: https://one.example.test or https://two.example.test</p><p>Address: India</p></div>
    <div class="member-card"><h3>Unsafe Website Ltd</h3><p>Website: <a href="javascript:alert(1)">Open site</a></p><p>Address: India</p></div>`;
  const parsed = await parseEpchDirectoryPage(html, sourceUrl);
  const byName = new Map(parsed.records.map(item => [item.business_name, item]));
  assert.equal(byName.get('Anchor Website Ltd').website_url, 'https://anchor.example.test/');
  assert.equal(byName.get('Text Website Ltd').website_url, 'https://www.text-site.example.test/');
  assert.equal(byName.get('Unlabeled Link Ltd').website_url, null, 'a social link without a Website label is not treated as the company site');
  assert.equal(byName.get('Directory Link Ltd').website_url, null, 'same-origin directory navigation is excluded');
  assert.equal(byName.get('Ambiguous Website Ltd').website_url, null, 'multiple explicit targets are not guessed between');
  assert.equal(byName.get('Unsafe Website Ltd').website_url, null, 'non-HTTP schemes are excluded');
  assert.match(byName.get('Anchor Website Ltd').raw_excerpt, /Website: https:\/\/anchor\.example\.test\//);
});

test('EEPC parser extracts only visible named columns and handles tables without tbody', async () => {
  const parsed = await parseEepcCbamDirectoryPage(cbamHtml, EEPC_CBAM_SOURCE_URL);
  assert.equal(parsed.layout_detected, true);
  assert.equal(parsed.records.length, 2);
  const advisory = parsed.records[0];
  assert.equal(advisory.business_name, 'CBAM Advisory Co');
  assert.equal(advisory.contact_person_name, 'Priya Nair');
  assert.equal(advisory.contact_title, 'Managing Director');
  assert.equal(advisory.contact_type, 'business_contact');
  assert.deepEqual(advisory.emails, ['priya@cbam-advisory.example']);
  assert.equal(advisory.website_url, 'https://cbam-advisory.example.test/');
  assert.match(advisory.source_url, /^https:\/\/cbam\.eepcindia\.org\/#record-/);
  assert.equal(advisory.content_hash.length, 64);
  assert.match(advisory.raw_excerpt, /Priya Nair/);
  assert.match(advisory.raw_excerpt, /Managing Director/);
  assert.equal(parsed.records.some(item => item.emails.includes('decoy@example.test')), false,
    'addresses outside the recognized table are not imported');
  assert.deepEqual(parsed.records[1].emails, ['held@example.test']);

  const noTbody = `<table><tr><th>Organization Name</th><th>Contact Person</th><th>Designation</th><th>Email</th><th>Quick Links</th></tr>
    <tr><td>Direct Row Co</td><td>Lee Das</td><td>Director</td><td>lee@direct-row.example</td><td></td></tr></table>`;
  const noTbodyResult = await parseEepcCbamDirectoryPage(noTbody, EEPC_CBAM_SOURCE_URL);
  assert.equal(noTbodyResult.records.length, 1);
  assert.equal(noTbodyResult.records[0].business_name, 'Direct Row Co');
});

test('EEPC parser excludes hidden rows and treats changed table headings as layout drift', async () => {
  const hidden = cbamHtml.replace('</tbody>', '<tr hidden><td>Invisible Co</td><td>Secret Person</td><td>CEO</td><td>hidden@example.test</td><td></td></tr></tbody>');
  const parsed = await parseEepcCbamDirectoryPage(hidden, EEPC_CBAM_SOURCE_URL);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records.some(item => item.business_name === 'Invisible Co'), false);

  const hiddenCell = cbamHtml.replace('<td>priya@cbam-advisory.example</td>', '<td><span style="display:none">hidden@example.test</span></td>');
  const cellResult = await parseEepcCbamDirectoryPage(hiddenCell, EEPC_CBAM_SOURCE_URL);
  assert.deepEqual(cellResult.records[0].emails, [], 'email text hidden inside a displayed row is excluded');

  const drift = await parseEepcCbamDirectoryPage('<table><tr><th>Provider</th><th>Representative</th><th>Role</th><th>Mailbox</th></tr><tr><td>Unknown</td><td>Test</td><td>Lead</td><td>x@example.test</td></tr></table>', EEPC_CBAM_SOURCE_URL);
  assert.equal(drift.layout_detected, false);
  assert.deepEqual(drift.records, []);
});

test('EEPC adapter checks robots first, limits page access to the approved origin, and fails closed on drift', async () => {
  const requests = [];
  const response = (body, status = 200, type = 'text/html') => new Response(body, { status, headers: { 'content-type': type } });
  const allowed = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input); requests.push(url.href);
    if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /', 200, 'text/plain');
    return response(cbamHtml);
  } });
  const session = await allowed.createSession();
  const page = await allowed.fetchDirectoryPage(session, session.directory_url);
  assert.equal(page.records.length, 2);
  assert.deepEqual(requests, ['https://cbam.eepcindia.org/robots.txt', EEPC_CBAM_SOURCE_URL]);
  await assert.rejects(allowed.fetchDirectoryPage(session, 'https://other.example.test/'), error => error.code === 'pagination_origin_changed');

  const deniedRequests = [];
  const denied = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input); deniedRequests.push(url.pathname);
    return response('User-agent: *\nDisallow: /', 200, url.pathname === '/robots.txt' ? 'text/plain' : 'text/html');
  } });
  await assert.rejects(denied.createSession(), error => error.code === 'robots_disallowed');
  assert.deepEqual(deniedRequests, ['/robots.txt']);

  const driftAdapter = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /', 200, 'text/plain');
    return response('<table><tr><th>Provider</th><th>Mailbox</th></tr><tr><td>Unknown</td><td>x@example.test</td></tr></table>');
  } });
  const driftSession = await driftAdapter.createSession();
  await assert.rejects(driftAdapter.fetchDirectoryPage(driftSession, driftSession.directory_url), error => error.code === 'directory_layout_changed');
});

test('EPCH and EEPC adapters preserve Retry-After on robots and data-page 429 responses', async () => {
  const response = (body, status = 200, type = 'text/html', extraHeaders = {}) => new Response(body, {
    status, headers: { 'content-type': type, ...extraHeaders },
  });
  const eepcRobots = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async () =>
    response('throttled', 429, 'text/plain', { 'retry-after': '120' }) });
  await assert.rejects(eepcRobots.createSession(), error => error.code === 'source_rate_limited'
    && error.statusCode === 429 && error.retryAfter === '120');

  const eepcPage = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    if (new URL(input).pathname === '/robots.txt') return response('User-agent: *\nAllow: /', 200, 'text/plain');
    return response('throttled', 429, 'text/plain', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
  } });
  const eepcSession = await eepcPage.createSession();
  await assert.rejects(eepcPage.fetchDirectoryPage(eepcSession, eepcSession.directory_url), error => error.code === 'source_rate_limited'
    && error.statusCode === 429 && error.retryAfter === 'Wed, 21 Oct 2026 07:28:00 GMT');

  const epchRobots = createEpchMemberDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async () =>
    response('throttled', 429, 'text/plain', { 'retry-after': '45' }) });
  await assert.rejects(epchRobots.createSession(), error => error.code === 'source_rate_limited'
    && error.statusCode === 429 && error.retryAfter === '45');

  const epchPage = createEpchMemberDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /member\nAllow: /data', 200, 'text/plain');
    if (url.pathname === '/member') return response('<iframe src="/data"></iframe>');
    return response('throttled', 429, 'text/plain', { 'retry-after': 'malformed' });
  } });
  const epchSession = await epchPage.createSession();
  await assert.rejects(epchPage.fetchDirectoryPage(epchSession, epchSession.directory_url), error => error.code === 'source_rate_limited'
    && error.statusCode === 429 && error.retryAfter === 'malformed');

  const epchMemberPage = createEpchMemberDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /member', 200, 'text/plain');
    return response('slow down', 429, 'text/html', { 'retry-after': '30' });
  } });
  await assert.rejects(epchMemberPage.createSession(), error => error.code === 'source_rate_limited'
    && error.statusCode === 429 && error.retryAfter === '30');

  const epchDeniedMemberPage = createEpchMemberDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /member', 200, 'text/plain');
    return response('denied', 403, 'text/html');
  } });
  await assert.rejects(epchDeniedMemberPage.createSession(), error => error.code === 'source_access_denied'
    && error.statusCode === 403 && !error.retryAfter);
});

test('HTTP import persists associated businesses, unknown email evidence, suppression and export', async () => {
  const created = await jsonRequest('/api/leads/directory-jobs', { method: 'POST', body: { batch_id: batchId } });
  assert.equal(created.status, 201);
  assert.equal(created.body.page_limit, 5, 'jobs default to a conservative five-page cap');
  const completed = await waitForJob(created.body.id, ['completed', 'failed']);
  assert.equal(completed.status, 'completed');
  assert.equal(adapterCalls.length, 1);
  assert.equal(completed.businesses_created, 1);
  assert.equal(completed.emails_created, 1);
  assert.equal(completed.suppressed_emails_skipped, 1);
  assert.equal(completed.records[0].business_name, 'Kite & Loom Exports');
  assert.deepEqual(completed.records[0].emails, ['team@gmail.com']);
  assert.equal(completed.records[0].website_url, 'https://kite-loom.example.test/');
  assert.match(completed.records[0].raw_excerpt, /team@gmail\.com/);
  assert.doesNotMatch(completed.records[0].raw_excerpt, /held@example\.test/);

  const lead = db.prepare('SELECT * FROM leads WHERE batch_id=? AND business_name=?').get(batchId, 'Kite & Loom Exports');
  assert.ok(lead);
  assert.equal(lead.contact_person_name, 'Anita Rao');
  assert.equal(lead.website_url, 'https://kite-loom.example.test/');
  assert.equal(lead.source, 'epch_member_directory');
  const email = db.prepare('SELECT * FROM lead_emails WHERE lead_id=?').get(lead.id);
  assert.equal(email.email, 'team@gmail.com');
  assert.equal(email.verification_status, 'unknown');
  assert.equal(email.is_free_provider, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE email='held@example.test'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_email_source_evidence WHERE lead_email_id=?').get(email.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_profile_source_evidence WHERE lead_id=?').get(lead.id).count, 1);

  const leadResponse = await jsonRequest(`/api/leads/${lead.id}`);
  assert.equal(leadResponse.status, 200);
  assert.equal(leadResponse.body.emails[0].verification_status, 'unknown');
  assert.equal(leadResponse.body.profile_source_evidence[0].evidence_type, 'epch_member_directory');
  assert.match(leadResponse.body.profile_source_evidence[0].raw_excerpt, /team@gmail\.com/);

  const exported = await jsonRequest(`/api/leads/directory-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /team@gmail\.com/);
  assert.match(exported.body, /unknown/);
  assert.match(exported.body, /website_url/);
  assert.match(exported.body, /https:\/\/kite-loom\.example\.test\//);
  assert.doesNotMatch(exported.body, /held@example\.test/);

  const downstreamCreated = await jsonRequest('/api/leads/website-discovery-jobs', { method: 'POST', body: {
    batch_id: batchId,
    businesses: [{ business_name: lead.business_name, website_url: lead.website_url }],
  } });
  assert.equal(downstreamCreated.status, 201);
  const downstream = await waitForWebsiteJob(downstreamCreated.body.id, ['completed', 'partial']);
  assert.equal(downstream.tasks[0].lead_id, lead.id, 'website discovery reuses the imported directory lead');
  assert.equal(downstream.tasks[0].website_url, lead.website_url);
  assert.equal(downstream.tasks[0].status, 'completed');
  assert.ok(downstream.tasks[0].emails.some(item => item.email === 'sales@kite-loom.example.test'));
  assert.ok(websiteFetches.includes('https://kite-loom.example.test/robots.txt'));
  assert.ok(downstream.tasks[0].emails.every(item => item.verification_status === 'unknown'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('EPCH import fills a blank company website but preserves an operator-entered URL', async () => {
  const preserveBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('EPCH operator site fixture','discovery','open')").run().lastInsertRowid);
  const created = createContact({
    batch_id: preserveBatch, business_name: 'Kite & Loom Exports', address: '18 Sample Road, Jaipur, Rajasthan',
    country: 'India', website_url: 'https://operator-selected.example.test/',
  });
  const leadId = Number(created.contact.id);
  const priorDomain = db.prepare('SELECT normalized_domain FROM leads WHERE id=?').get(leadId).normalized_domain;
  nextPageRecord = record({
    record_key: 'record-operator-site', business_key: 'business-operator-site',
    website_url: 'https://directory-published.example.test/',
    raw_excerpt: 'Kite & Loom Exports · Email: team@gmail.com, held@example.test · Website: https://directory-published.example.test/ · Products: Textiles',
  });
  try {
    const queued = await jsonRequest('/api/leads/directory-jobs', { method: 'POST', body: { batch_id: preserveBatch } });
    assert.equal(queued.status, 201);
    await waitForJob(queued.body.id, ['completed', 'failed']);
    const lead = db.prepare('SELECT website_url,normalized_domain FROM leads WHERE id=?').get(leadId);
    assert.equal(lead.website_url, 'https://operator-selected.example.test/');
    assert.equal(lead.normalized_domain, priorDomain);
    const review = await jsonRequest(`/api/leads/directory-jobs/${queued.body.id}`);
    assert.match(review.body.records[0].raw_excerpt, /Website: https:\/\/directory-published\.example\.test\//,
      'source evidence retains the published site even when the lead keeps the operator site');
    assert.equal(review.body.records[0].website_url, 'https://operator-selected.example.test/');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  } finally {
    nextPageRecord = null;
  }
});

test('page caps validate at the API and page-limited jobs continue only by explicit five-page steps', async () => {
  const priorJobs = jobs.listJobs({ batch_id: batchId, limit: 50 }).length;
  for (const pageLimit of [0, 1.5, 51, '2']) {
    const invalid = await jsonRequest('/api/leads/directory-jobs', {
      method: 'POST', body: { batch_id: batchId, page_limit: pageLimit },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'invalid_page_limit');
  }
  assert.equal(jobs.listJobs({ batch_id: batchId, limit: 50 }).length, priorJobs,
    'invalid caps do not create scheduled jobs');

  paginateDirectory = true;
  const created = await jsonRequest('/api/leads/directory-jobs', {
    method: 'POST', body: { batch_id: batchId, page_limit: 1 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.page_limit, 1);
  const capped = await waitForJob(created.body.id, ['partial', 'failed']);
  assert.equal(capped.status, 'partial');
  assert.equal(capped.error_code, 'page_limit_reached');
  assert.equal(capped.pages_completed, 1);
  assert.equal(capped.can_extend_pages, true);
  assert.deepEqual(adapterCalls.slice(-1), [sourceUrl]);

  const continued = await jsonRequest(`/api/leads/directory-jobs/${created.body.id}/resume`, { method: 'POST' });
  assert.equal(continued.status, 200);
  assert.equal(continued.body.job.page_limit, 6, 'one explicit continuation grants only five more pages');
  const completed = await waitForJob(created.body.id, ['completed', 'failed']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.pages_completed, 2);
  assert.equal(completed.can_extend_pages, false);
  assert.deepEqual(adapterCalls.slice(-2), [sourceUrl, `${sourceUrl}&page=2`]);
  assert.deepEqual(completed.records.map(item => item.emails).flat().sort(), ['team@gmail.com', 'two@paging-api.test']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  paginateDirectory = false;
});

test('transient robots transport failures require explicit retry and then resume safely', async () => {
  failSessionOnce = true;
  const created = await jsonRequest('/api/leads/directory-jobs', { method: 'POST', body: { batch_id: batchId } });
  assert.equal(created.status, 201);
  const failed = await waitForJob(created.body.id, ['failed']);
  assert.equal(failed.error_code, 'robots_unavailable');
  assert.equal(failed.attempt_count, 1);
  const retried = await jsonRequest(`/api/leads/directory-jobs/${created.body.id}/retry`, { method: 'POST' });
  assert.equal(retried.status, 200);
  const completed = await waitForJob(created.body.id, ['completed', 'failed']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempt_count, 2);
  assert.equal(completed.pages_completed, 1);
});

test('EEPC CBAM import persists source/contact evidence, suppresses safely, deduplicates, and recovers on the same worker', async () => {
  const websiteFetchCount = websiteFetches.length;
  const created = await jsonRequest('/api/leads/directory-jobs', {
    method: 'POST', body: { batch_id: batchId, source_id: 'eepc_cbam' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.source_id, 'eepc_cbam');
  assert.equal(created.body.source_name, 'EEPC CBAM advisory directory');
  const completed = await waitForJob(created.body.id, ['completed', 'failed']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.businesses_created, 2);
  assert.equal(completed.emails_created, 1);
  assert.equal(completed.suppressed_emails_skipped, 1);
  assert.equal(completed.records.find(item => item.business_name === 'CBAM Advisory Co').contact_title, 'Managing Director');
  assert.deepEqual(completed.records.find(item => item.business_name === 'CBAM Advisory Co').emails, ['priya@cbam-advisory.example']);
  assert.deepEqual(completed.records.find(item => item.business_name === 'Suppressed Advisory Co').emails, []);
  assert.deepEqual(cbamRequests.slice(-2), ['https://cbam.eepcindia.org/robots.txt', EEPC_CBAM_SOURCE_URL]);
  assert.equal(websiteFetches.length, websiteFetchCount, 'directory import never scans the listed organizations’ websites');

  const lead = db.prepare('SELECT * FROM leads WHERE batch_id=? AND business_name=?').get(batchId, 'CBAM Advisory Co');
  assert.ok(lead);
  assert.equal(lead.source, 'eepc_cbam_directory');
  assert.equal(lead.contact_person_name, 'Priya Nair');
  assert.equal(lead.website_url, 'https://cbam-advisory.example.test/');
  const email = db.prepare('SELECT * FROM lead_emails WHERE lead_id=?').get(lead.id);
  assert.equal(email.email, 'priya@cbam-advisory.example');
  assert.equal(email.source, 'eepc_cbam_directory');
  assert.equal(email.verification_status, 'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_email_source_evidence WHERE lead_email_id=? AND evidence_type=? AND extractor_version=?')
    .get(email.id, 'eepc_cbam_directory', EEPC_CBAM_EXTRACTOR_VERSION).count, 1);
  const contactPoint = db.prepare(`SELECT cp.* FROM lead_email_contact_point_evidence cp
    JOIN lead_email_source_evidence evidence ON evidence.id=cp.evidence_id
    WHERE evidence.lead_email_id=?`).get(email.id);
  assert.equal(contactPoint.contact_name, 'Priya Nair');
  assert.equal(contactPoint.contact_title, 'Managing Director');
  assert.equal(contactPoint.contact_type, 'business_contact');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE email='held@example.test'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const leadResponse = await jsonRequest(`/api/leads/${lead.id}`);
  assert.equal(leadResponse.status, 200);
  assert.equal(leadResponse.body.emails[0].verification_status, 'unknown');
  assert.equal(leadResponse.body.emails[0].source_evidence[0].evidence_type, 'eepc_cbam_directory');
  assert.equal(leadResponse.body.emails[0].source_evidence[0].contact_points[0].contact_title, 'Managing Director');
  const exported = await jsonRequest(`/api/leads/directory-jobs/${created.body.id}/export`);
  assert.match(exported.body, /"contact_title","source_id"/);
  assert.match(exported.body, /"Managing Director","eepc_cbam"/);
  assert.doesNotMatch(exported.body, /held@example\.test/);

  const second = await jsonRequest('/api/leads/directory-jobs', {
    method: 'POST', body: { batch_id: batchId, source_id: 'eepc_cbam' },
  });
  const deduplicated = await waitForJob(second.body.id, ['completed', 'failed']);
  assert.equal(deduplicated.status, 'completed');
  assert.equal(deduplicated.businesses_created, 0);
  assert.equal(deduplicated.emails_created, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND source='eepc_cbam_directory'").get(batchId).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const recoveryId = Number(db.prepare(`INSERT INTO epch_directory_jobs(batch_id,source_id,source_url,status,page_limit,next_page_url)
    VALUES(?,'eepc_cbam',?,'running',5,?)`).run(batchId, EEPC_CBAM_SOURCE_URL, EEPC_CBAM_SOURCE_URL).lastInsertRowid);
  db.prepare(`INSERT INTO epch_directory_pages(job_id,page_url,page_number,status) VALUES(?,?,1,'running')`)
    .run(recoveryId, EEPC_CBAM_SOURCE_URL);
  const recoveredManager = createEpchDirectoryJobs({ db, adapter, adapters: {
    eepc_cbam: { adapter: cbamAdapter, sourceUrl: EEPC_CBAM_SOURCE_URL, label: 'EEPC CBAM advisory directory',
      evidenceType: 'eepc_cbam_directory', extractorVersion: EEPC_CBAM_EXTRACTOR_VERSION },
  }, createContact, schedule: callback => setImmediate(callback) });
  assert.equal(recoveredManager.recover(), 1);
  const recovered = await new Promise((resolve, reject) => {
    const check = () => {
      const current = recoveredManager.getJob(recoveryId);
      if (['completed', 'failed'].includes(current.status)) {
        if (current.status !== 'completed') reject(new Error(`EEPC recovery failed: ${current.error_code}`));
        else resolve(current);
      } else setTimeout(check, 10);
    };
    check();
  });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.businesses_created, 0);
  assert.equal(recovered.emails_created, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  recoveredManager.close();
});

test('directory import rejects unknown source IDs before creating jobs', async () => {
  const before = jobs.listJobs({ batch_id: batchId, limit: 50 }).length;
  const response = await jsonRequest('/api/leads/directory-jobs', {
    method: 'POST', body: { batch_id: batchId, source_id: 'unapproved_directory' },
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, 'directory_source_unsupported');
  assert.equal(jobs.listJobs({ batch_id: batchId, limit: 50 }).length, before);
});

test('EEPC layout drift becomes a failed import instead of a successful empty result', async () => {
  const driftBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('EEPC layout drift fixture','discovery','open')").run().lastInsertRowid);
  const driftAdapter = createEepcCbamDirectoryAdapter({ minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response('<table><tr><th>Provider</th><th>Mailbox</th></tr><tr><td>Unknown</td><td>x@example.test</td></tr></table>',
      { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  const manager = createEpchDirectoryJobs({ db, adapter, adapters: {
    eepc_cbam: { adapter: driftAdapter, sourceUrl: EEPC_CBAM_SOURCE_URL, label: 'EEPC CBAM advisory directory',
      evidenceType: 'eepc_cbam_directory', extractorVersion: EEPC_CBAM_EXTRACTOR_VERSION },
  }, createContact, schedule: callback => setImmediate(callback) });
  const queued = manager.createJob({ batch_id: driftBatch, source_id: 'eepc_cbam' });
  const failed = await new Promise((resolve, reject) => {
    const check = () => {
      const current = manager.getJob(queued.id);
      if (['completed', 'failed'].includes(current.status)) {
        if (current.status !== 'failed') reject(new Error('A layout-changed source must not complete as a zero-result import.'));
        else resolve(current);
      } else setTimeout(check, 10);
    };
    check();
  });
  assert.equal(failed.error_code, 'directory_layout_changed');
  assert.equal(failed.pages_completed, 0);
  assert.equal(failed.records_seen, 0);
  assert.deepEqual(failed.records, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(driftBatch).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  manager.close();
});

test('directory 429 saves a shared host cooldown across jobs and restart, then recovers only on explicit retry', async () => {
  const cooldownBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Directory 429 cooldown fixture','discovery','open')").run().lastInsertRowid);
  let logicalNow = Date.now();
  let throttled = true;
  const cooldownHtml = cbamHtml.replace('priya@cbam-advisory.example', 'cooldown@cbam-advisory.example');
  const requests = [];
  const rateLimitedAdapter = createEepcCbamDirectoryAdapter({ now: () => logicalNow, minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
    const url = new URL(input);
    requests.push(url.href);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (throttled) return new Response('slow down', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '90' } });
    return new Response(cooldownHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  let aliasSessionCalls = 0;
  const aliasAdapter = {
    async createSession() { aliasSessionCalls += 1; return { directory_url: EEPC_CBAM_SOURCE_URL }; },
    async fetchDirectoryPage() { throw new Error('The shared cooldown should prevent alias-source page access.'); },
  };
  const adapterOptions = { db, adapter, adapters: {
    eepc_cbam: { adapter: rateLimitedAdapter, sourceUrl: EEPC_CBAM_SOURCE_URL, label: 'EEPC CBAM advisory directory',
      evidenceType: 'eepc_cbam_directory', extractorVersion: EEPC_CBAM_EXTRACTOR_VERSION },
    eepc_alias: { adapter: aliasAdapter, sourceUrl: EEPC_CBAM_SOURCE_URL, label: 'EEPC alias fixture',
      evidenceType: 'eepc_cbam_directory', extractorVersion: EEPC_CBAM_EXTRACTOR_VERSION },
  }, createContact, now: () => logicalNow, schedule: callback => setImmediate(callback) };
  const manager = createEpchDirectoryJobs(adapterOptions);
  const first = manager.createJob({ batch_id: cooldownBatch, source_id: 'eepc_cbam' });
  const failed = await waitForLocalDirectoryJob(manager, first.id, ['failed', 'partial']);
  assert.equal(failed.error_code, 'source_rate_limited');
  assert.equal(failed.retry_after_at, new Date(logicalNow + 90_000).toISOString());
  assert.deepEqual(requests, ['https://cbam.eepcindia.org/robots.txt', EEPC_CBAM_SOURCE_URL]);
  const saved = db.prepare("SELECT not_before,reason FROM website_host_cooldowns WHERE hostname='cbam.eepcindia.org'").get();
  assert.equal(saved.not_before, failed.retry_after_at);
  assert.equal(saved.reason, 'directory_source_rate_limited');
  assert.throws(() => manager.retry(first.id), error => error.code === 'directory_source_cooldown_active' && error.statusCode === 429);
  assert.equal(requests.length, 2, 'early retry makes no source request');

  const alias = manager.createJob({ batch_id: cooldownBatch, source_id: 'eepc_alias' });
  const aliasBlocked = await waitForLocalDirectoryJob(manager, alias.id, ['failed', 'partial']);
  assert.equal(aliasBlocked.error_code, 'source_rate_limited');
  assert.equal(aliasBlocked.retry_after_at, failed.retry_after_at);
  assert.equal(aliasSessionCalls, 0, 'a second adapter on the same host is blocked before its session request');
  assert.equal(requests.length, 2);
  manager.close();

  const restarted = createEpchDirectoryJobs(adapterOptions);
  assert.equal(restarted.recover(), 0, 'restart does not automatically retry failed jobs');
  const afterRestart = restarted.createJob({ batch_id: cooldownBatch, source_id: 'eepc_alias' });
  const afterRestartBlocked = await waitForLocalDirectoryJob(restarted, afterRestart.id, ['failed', 'partial']);
  assert.equal(afterRestartBlocked.retry_after_at, failed.retry_after_at);
  assert.equal(aliasSessionCalls, 0);
  assert.equal(requests.length, 2, 'persisted cooldown stops requests after worker restart');

  logicalNow = Date.parse(failed.retry_after_at) + 1;
  throttled = false;
  assert.equal(requests.length, 2, 'deadline expiry alone makes no request');
  restarted.retry(first.id);
  const recovered = await waitForLocalDirectoryJob(restarted, first.id, ['completed', 'failed', 'partial']);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.retry_after_at, null);
  assert.equal(recovered.emails_created, 1);
  const lead = db.prepare("SELECT id FROM leads WHERE batch_id=? AND business_name='CBAM Advisory Co'").get(cooldownBatch);
  assert.ok(lead);
  assert.equal(db.prepare("SELECT verification_status FROM lead_emails WHERE lead_id=? AND email='cooldown@cbam-advisory.example'").get(lead.id).verification_status, 'unknown');
  assert.deepEqual(requests.slice(-2), ['https://cbam.eepcindia.org/robots.txt', EEPC_CBAM_SOURCE_URL]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  restarted.close();
});

test('adapter discovers its frame, obeys robots, and stops before data on unavailable rules', async () => {
  const requests = [];
  const response = (body, status = 200, type = 'text/html') => new Response(body, { status, headers: { 'content-type': type } });
  const allowed = createEpchMemberDirectoryAdapter({
    minimumRequestIntervalMs: 0,
    wait: async () => {},
    fetchImpl: async input => {
      const url = new URL(input); requests.push(url.href);
      if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /member\nAllow: /get_data.php', 200, 'text/plain');
      if (url.pathname === '/member') return response('<iframe src="/get_data.php?token=fixture"></iframe>');
      return response('<div class="member-card"><h3>Frame Company</h3><p>Email: contact@example.test</p><p>Address: India</p></div>');
    },
  });
  const session = await allowed.createSession();
  assert.equal(new URL(session.directory_url).pathname, '/get_data.php');
  const page = await allowed.fetchDirectoryPage(session, session.directory_url);
  assert.equal(page.records[0].business_name, 'Frame Company');
  assert.deepEqual(requests.map(url => new URL(url).pathname), ['/robots.txt', '/member', '/get_data.php']);

  const deniedRequests = [];
  const denied = createEpchMemberDirectoryAdapter({
    minimumRequestIntervalMs: 0,
    wait: async () => {},
    fetchImpl: async input => {
      const url = new URL(input); deniedRequests.push(url.pathname);
      if (url.pathname === '/robots.txt') return response('User-agent: *\nDisallow: /', 200, 'text/plain');
      return response('<iframe src="/get_data.php"></iframe>');
    },
  });
  await assert.rejects(denied.createSession(), error => error.code === 'robots_disallowed');
  assert.deepEqual(deniedRequests, ['/robots.txt']);

  const unavailable = createEpchMemberDirectoryAdapter({
    minimumRequestIntervalMs: 0,
    wait: async () => {},
    fetchImpl: async () => { throw new Error('robots fetch unavailable'); },
  });
  await assert.rejects(unavailable.createSession(), error => error.code === 'robots_unavailable');
});

test('page import and progress commit atomically and are idempotent on worker recovery', async () => {
  const recoverBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('EPCH restart fixture','discovery','open')").run().lastInsertRowid);
  const jobId = Number(db.prepare(`INSERT INTO epch_directory_jobs(batch_id,status,page_limit,next_page_url)
    VALUES(?,'running',50,?)`).run(recoverBatch, sourceUrl).lastInsertRowid);
  const pageId = Number(db.prepare(`INSERT INTO epch_directory_pages(job_id,page_url,page_number,status)
    VALUES(?,?,1,'running')`).run(jobId, sourceUrl).lastInsertRowid);
  const initialCalls = adapterCalls.length;
  const restartAdapter = {
    async createSession() { return { directory_url: sourceUrl }; },
    async fetchDirectoryPage() { adapterCalls.push('restart'); return { records: [record({
      record_key: 'record-restart', business_key: 'business-restart', business_name: 'Restart Fixtures Ltd',
      emails: ['restart@recover.test'], raw_excerpt: 'Restart Fixtures Ltd · Email: restart@recover.test',
    })], pagination_urls: [], content_hash: 'b'.repeat(64), layout_detected: true }; },
  };
  const restarted = createEpchDirectoryJobs({ db, adapter: restartAdapter, createContact, schedule: callback => setImmediate(callback) });
  assert.equal(restarted.recover(), 1);
  const recovered = await new Promise((resolve, reject) => {
    const check = async () => {
      const job = restarted.getJob(jobId);
      if (job.status === 'completed' || job.status === 'failed') {
        if (job.status !== 'completed') reject(new Error(`Recovery failed: ${job.error_code}`));
        else resolve(job);
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.businesses_created, 1);
  assert.equal(recovered.emails_created, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(recoverBatch).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(recovered.records[0].lead_id).count, 1);
  assert.equal(db.prepare('SELECT status FROM epch_directory_pages WHERE id=?').get(pageId).status, 'completed');
  assert.equal(adapterCalls.length, initialCalls + 1);
  restarted.close();
});

test('a page cap still stops after an in-flight pause request at the same boundary', async () => {
  const batch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('EPCH capped pause fixture','discovery','open')").run().lastInsertRowid);
  const firstUrl = 'https://epch.in/members.php?token=capped-pause';
  const secondUrl = `${firstUrl}&page=2`;
  let releasePage;
  let pageStartedResolve;
  const pageStarted = new Promise(resolve => { pageStartedResolve = resolve; });
  const pageGate = new Promise(resolve => { releasePage = resolve; });
  const requested = [];
  const capped = createEpchDirectoryJobs({
    db, createContact, schedule: callback => setImmediate(callback),
    adapter: {
      async createSession() { return { directory_url: firstUrl }; },
      async fetchDirectoryPage(_session, url) {
        requested.push(url);
        pageStartedResolve();
        await pageGate;
        return { records: [record({ record_key: 'record-capped-pause', business_key: 'business-capped-pause' })],
          pagination_urls: [secondUrl], content_hash: 'd'.repeat(64), layout_detected: true };
      },
    },
  });
  const job = capped.createJob({ batch_id: batch, page_limit: 1 });
  await pageStarted;
  capped.pause(job.id);
  releasePage();
  let stopped;
  for (let i = 0; i < 200; i += 1) {
    stopped = capped.getJob(job.id);
    if (stopped.status === 'partial' || stopped.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(stopped.status, 'partial');
  assert.equal(stopped.error_code, 'page_limit_reached');
  assert.equal(stopped.can_extend_pages, true);
  assert.deepEqual(requested, [firstUrl], 'the cap prevents page two even when pause races with completion');
  capped.close();
});

test('multi-page collection pauses at a page boundary and resumes from the saved cursor', async () => {
  const batch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('EPCH pagination fixture','discovery','open')").run().lastInsertRowid);
  const firstUrl = 'https://epch.in/members.php?token=paging';
  const secondUrl = `${firstUrl}&page=2`;
  let releaseFirstPage;
  let pageStarted;
  const started = new Promise(resolve => { pageStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirstPage = resolve; });
  let firstFetch = true;
  const requested = [];
  const paginated = createEpchDirectoryJobs({
    db,
    createContact,
    schedule: callback => setImmediate(callback),
    adapter: {
      async createSession() { return { directory_url: firstUrl }; },
      async fetchDirectoryPage(_session, url) {
        requested.push(url);
        if (url === firstUrl && firstFetch) { firstFetch = false; pageStarted(); await gate; }
        const second = url === secondUrl;
        const item = record({
          record_key: second ? 'record-page-2' : 'record-page-1',
          business_key: second ? 'business-page-2' : 'business-page-1',
          business_name: second ? 'Page Two Crafts' : 'Page One Crafts',
          emails: [second ? 'two@paging.test' : 'one@paging.test'],
          raw_excerpt: second ? 'Page Two Crafts · Email: two@paging.test' : 'Page One Crafts · Email: one@paging.test',
          source_url: `${url}#record`,
        });
        return { records: [item], pagination_urls: second ? [] : [secondUrl], content_hash: second ? '2'.repeat(64) : '1'.repeat(64), layout_detected: true };
      },
    },
  });
  const job = paginated.createJob({ batch_id: batch });
  await started;
  paginated.pause(job.id);
  releaseFirstPage();
  let paused;
  for (let i = 0; i < 200; i += 1) {
    paused = paginated.getJob(job.id);
    if (paused.status === 'paused') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pages_completed, 1);
  assert.equal(paused.next_page_url, secondUrl);
  assert.deepEqual(requested, [firstUrl]);
  paginated.resume(job.id);
  let completed;
  for (let i = 0; i < 200; i += 1) {
    completed = paginated.getJob(job.id);
    if (completed.status === 'completed' || completed.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.pages_completed, 2);
  assert.deepEqual(requested, [firstUrl, secondUrl]);
  assert.equal(completed.records.length, 2);
  assert.deepEqual(completed.pages.map(page => page.status), ['completed', 'completed']);
  paginated.close();
});
