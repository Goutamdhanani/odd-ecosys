import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-website-discovery-jobs-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
delete process.env.ODD_AUTH_ENFORCE_TESTS;
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { closeDb, initDb, getDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Website discovery fixtures','discovery','open')").run().lastInsertRowid);
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createContact } = await import('../pipeline/contact-manager.js');
const { setWebsiteEmailDiscoveryTestManager, setWebsiteDiscoveryJobsTestManager, server } = await import('../server.js');

let holdSlowRobots = false;
let releaseSlowRobots;
let slowStartedResolve;
let slowGate = Promise.resolve();
let slowStarted = Promise.resolve();
let failRetryRobotsOnce = true;
let refreshAcmeMode = 'original';
let cooldownMode = 'limited';
let cooldownNow = Date.now();
const fetchCalls = [];
const fetchMethods = [];

function response(body, status = 200, contentType = 'text/html; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function fixtureFetch(input, options = {}) {
  const url = new URL(input);
  fetchCalls.push(url.href);
  fetchMethods.push({ url: url.href, method: options.method || 'GET' });
  if (url.pathname === '/robots.txt') {
    if (url.hostname === 'cooldown-robots.example.test') {
      return new Response('Slow down', { status: 429, headers: { 'content-type': 'text/plain', 'retry-after': '180' } });
    }
    if (url.hostname === 'blocked.example.test') return response('User-agent: *\nDisallow: /', 200, 'text/plain');
    if (url.hostname === 'retry.example.test' && failRetryRobotsOnce) {
      failRetryRobotsOnce = false;
      throw new Error('synthetic connection interruption');
    }
    if (url.hostname.startsWith('slow') && holdSlowRobots) {
      slowStartedResolve();
      await slowGate;
    }
    return response('User-agent: *\nAllow: /\nCrawl-delay: 0', 200, 'text/plain');
  }
  if (url.hostname.startsWith('cooldown-') || url.hostname === 'cooldown.example.test') {
    if (url.pathname === '/') {
      return response(`<html><body>Business enquiries: sales@${url.hostname} <a href="/contact">Contact the sales team</a></body></html>`);
    }
    if (url.pathname === '/contact' && cooldownMode === 'limited') {
      const retryAfter = url.hostname === 'cooldown.example.test' ? '120'
        : url.hostname === 'cooldown-date.example.test' ? new Date(cooldownNow + 90_000).toUTCString()
          : 'not-a-date';
      return new Response('Slow down', { status: 429, headers: { 'content-type': 'text/plain', 'retry-after': retryAfter } });
    }
    if (url.pathname === '/contact' && cooldownMode === 'healthy') {
      return response(`<html><body>Contact our sales team at sales@${url.hostname}</body></html>`);
    }
    return response('missing', 404, 'text/plain');
  }
  if (url.hostname === 'free.example.test') {
    if (url.pathname !== '/') return response('missing', 404, 'text/plain');
    return response('<html><body><footer><a href="mailto:person@gmail.com,office@outlook.com?subject=Contact">Email our team</a></footer></body></html>');
  }
  if (url.hostname === 'acme.example.test' && refreshAcmeMode === 'removed') {
    return response('<html><body>North Star Workshop contact information is available through our office.</body></html>');
  }
  if (url.hostname === 'acme.example.test' && refreshAcmeMode === 'conflict') {
    return url.pathname === '/contact'
      ? response('<html><body>Business enquiries: sales@acme.example.test</body></html>')
      : response('<html><body>Contact information is available through our office.</body></html>');
  }
  if (url.hostname === 'acme.example.test' && url.pathname === '/') {
    return response(`<html><body><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Organization', name: 'North Star Workshop',
      contactPoint: { '@type': 'ContactPoint', contactType: 'sales', name: 'Maya Singh',
        jobTitle: 'Regional Sales Manager', email: 'sales@acme.example.test' },
    })}</script><footer>Business enquiries: <a href="mailto:sales@acme.example.test">sales@acme.example.test</a></footer></body></html>`);
  }
  if (url.hostname === 'vcard-job.example.test' && url.pathname === '/') {
    return response('<html><body><a href="/business-contact.vcf">Business contact card</a></body></html>');
  }
  if (url.hostname === 'vcard-job.example.test' && url.pathname === '/business-contact.vcf') {
    return response('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Samira Rao\r\nORG:VCard Job Business\r\nTITLE:Export Partnerships Lead\r\nEMAIL;TYPE=WORK:samira@vcard-job.example.test\r\nEND:VCARD\r\n', 200, 'text/vcard');
  }
  if (url.hostname === 'tel-job.example.test' && url.pathname === '/') {
    return response('<html><body><a href="tel:+44 20 7946 0958">Call the London office</a></body></html>');
  }
  if (url.hostname === 'facebook-job.example.test' && url.pathname === '/') {
    return response('<html><body><a href="https://www.facebook.com/facebook-job-business?utm_source=website">Facebook</a></body></html>');
  }
  if (url.hostname === 'microdata-job.example.test' && url.pathname === '/') {
    return response(`<html><body><div itemscope itemtype="https://schema.org/Organization">
      <meta itemprop="name" content="Microdata Job Business">
      <div itemprop="contactPoint" itemscope itemtype="https://schema.org/ContactPoint">
        <meta itemprop="contactType" content="sales"><meta itemprop="name" content="Arjun Mehta">
        <meta itemprop="jobTitle" content="Export Sales Manager"><meta itemprop="email" content="arjun@microdata-job.example.test">
      </div></div></body></html>`);
  }
  if (url.hostname === 'hcard-job.example.test' && url.pathname === '/') {
    return response(`<html><body><div class="h-card"><span class="p-name">H-Card Job Business</span>
      <span class="p-tel">+1 212 555 0165</span>
      <span class="p-category">Metal fabrication</span>
      <div class="p-adr h-adr"><span class="p-street-address">5 Foundry Road</span><span class="p-locality">Pune</span>
        <span class="p-region">Maharashtra</span><span class="p-country-name">India</span></div>
      <span class="u-email">contact@hcard-job.example.test</span></div>
      <div class="h-card"><span class="p-name">Sam Lee</span><span class="p-org">H-Card Job Business</span>
      <span class="p-job-title">Commercial Director</span><span class="p-tel">+44 20 7946 0134</span>
      <span class="u-email">sam@hcard-job.example.test</span></div>
    </body></html>`);
  }
  if (url.hostname === 'person-job.example.test' && url.pathname === '/') {
    return response(`<html><body>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'Organization', name: 'Person Job Business',
        url: 'https://person-job.example.test', member: { '@id': '#member-1' }, contactPoint: { '@id': '#sales-1', '@type': 'ContactPoint' },
      })}</script>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@graph': [
        { '@id': '#member-1', '@type': 'Person', name: 'Nikhil Das', jobTitle: 'Operations Lead', email: 'nikhil@person-job.example.test' },
        { '@id': '#sales-1', '@type': 'ContactPoint', contactType: 'sales', name: 'Aarya Nair',
          jobTitle: 'Sales Lead', email: 'sales@person-job.example.test' },
      ],
      })}</script>
    </body></html>`);
  }
  if (url.hostname === 'rdfa-job.example.test' && url.pathname === '/') {
    return response(`<html><body><div typeof="https://schema.org/Organization">
      <span property="schema:name">RDFa Job Business</span>
      <section property="schema:contactPoint" typeof="https://schema.org/ContactPoint">
        <meta property="schema:contactType" content="support"><meta property="schema:name" content="Help Desk">
        <meta property="schema:jobTitle" content="Customer Support Manager">
        <meta property="schema:email" content="help@rdfa-job.example.test">
      </section></div></body></html>`);
  }
  if (url.hostname === 'meta-job.example.test' && url.pathname === '/') {
    return response(`<html><head><meta name="company-email" content="office@meta-job.example.test">
      <meta name="keywords" content="decoy@meta-job.example.test"></head><body>
      <div data-email="attribute-decoy@meta-job.example.test"></div></body></html>`);
  }
  if (url.hostname === 'meta-job.example.test') return response('missing', 404, 'text/plain');
  if (url.hostname === 'mailto-job.example.test' && url.pathname === '/') {
    return response(`<html><head><link rel="support" href="mailto:help@mailto-job.example.test"></head><body>
      <map name="contacts"><area href="mailto:office@mailto-job.example.test?subject=Office" alt="Office"></map>
      <form action="mailto:sales@mailto-job.example.test?subject=Sales"></form></body></html>`);
  }
  if (url.hostname === 'mailto-job.example.test') return response('missing', 404, 'text/plain');
  if (url.hostname === 'area-job.example.test' && url.pathname === '/') {
    return response(`<html><body><map name="company"><area href="/firm/relations" alt="Contact the export sales team"></map>
      <a href="/blog/announcements">Announcements</a></body></html>`);
  }
  if (url.hostname === 'area-job.example.test' && url.pathname === '/firm/relations') {
    return response('<main>Export sales: exports@area-job.example.test</main>');
  }
  if (url.hostname === 'area-job.example.test') return response('missing', 404, 'text/plain');
  if (url.hostname === 'accessible-job.example.test' && url.pathname === '/') {
    return response('<html><body><img src="/brand.svg" alt="Customer support help@accessible-job.example.test"></body></html>');
  }
  if (url.hostname === 'accessible-job.example.test') return response('missing', 404, 'text/plain');
  if (url.hostname === 'contact-attribute-job.example.test' && url.pathname === '/') {
    return response(`<html><body><button data-business-email="sales@contact-attribute-job.example.test">Sales</button>
      <div data-email="decoy@contact-attribute-job.example.test"></div></body></html>`);
  }
  if (url.hostname === 'contact-attribute-job.example.test') return response('missing', 404, 'text/plain');
  if (url.hostname === 'form-job.example.test' && url.pathname === '/') {
    return response('<html><body><form id="contact-form" action="/submit"><label>Your message<textarea name="message"></textarea></label><button type="submit">Send</button></form></body></html>');
  }
  if (url.hostname === 'form-job.example.test') return response('missing', 404, 'text/plain');
  if (url.hostname === 'budget.example.test') {
    if (url.pathname === '/') {
      const links = Array.from({ length: 8 }, (_, index) => `<a href="/contact-${String(index + 1).padStart(2, '0')}">Contact ${index + 1}</a>`).join('');
      return response(`<html><body>${links}</body></html>`);
    }
    if (/^\/contact-\d{2}$/.test(url.pathname)) {
      return response(`<html><body>Sales: sales@budget.example.test</body></html>`);
    }
    if (['/contact', '/contact-us', '/about', '/about-us'].includes(url.pathname)) {
      return response(`<html><body>Office: hello@budget.example.test</body></html>`);
    }
    return response('missing', 404, 'text/plain');
  }
  const address = `sales@${url.hostname}`;
  return response(`<html><body><footer>Business enquiries: <a href="mailto:${address}">${address}</a></footer></body></html>`);
}

const discovery = createWebsiteEmailDiscovery({ db, fetchImpl: fixtureFetch, minimumRequestIntervalMs: 0, wait: async () => {} });
const jobs = createWebsiteDiscoveryJobs({ db, discovery, createContact, schedule: callback => setImmediate(callback) });
setWebsiteEmailDiscoveryTestManager(discovery);
setWebsiteDiscoveryJobsTestManager(jobs);
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  jobs.close();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function jsonRequest(route, { method = 'GET', body } = {}) {
  const responseResult = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const contentType = responseResult.headers.get('content-type') || '';
  return { status: responseResult.status, body: contentType.includes('json') ? await responseResult.json() : await responseResult.text(), headers: responseResult.headers };
}

async function waitForJob(id, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await jsonRequest(`/api/leads/website-discovery-jobs/${id}`);
    if (expected.includes(result.body.status)) return result.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Website discovery job ${id} did not reach ${expected.join('/')}.`);
}

test('HTTP job creates businesses, de-duplicates sites, stores source excerpts and exports actual evidence', async () => {
  const beforeLeads = db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count;
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST',
    body: {
      batch_id: batchId,
      businesses: [
        { business_name: 'North Star Workshop', website_url: 'https://Acme.example.test/contact', category: 'Manufacturing', city: 'Jaipur', country: 'India' },
        { business_name: 'Duplicate spelling', website_url: 'https://acme.example.test/' },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task_count, 1);
  assert.equal(created.body.duplicate_count, 1);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.progress, { total: 1, completed: 1, blocked: 0, failed: 0, skipped: 0, queued: 0, running: 0, found_emails: 1 });
  assert.equal(job.tasks.length, 1);
  assert.equal(job.tasks[0].business_name, 'North Star Workshop');
  assert.equal(job.tasks[0].website_url, 'https://acme.example.test/');
  assert.equal(job.tasks[0].emails.length, 5, 'the same address keeps separate page evidence without duplicating the address row');
  assert.ok(job.tasks[0].emails.every(item => item.email === 'sales@acme.example.test'));
  assert.ok(job.tasks[0].emails.every(item => item.verification_status === 'unknown'));
  assert.ok(job.tasks[0].emails.every(item => item.raw_excerpt.includes('Business enquiries')));
  assert.ok(job.tasks[0].emails.every(item => /^[a-f0-9]{64}$/.test(item.content_hash)));
  const structuredEvidence = job.tasks[0].emails.find(item => item.contact_points?.length);
  assert.deepEqual(structuredEvidence.contact_points, [{
    contact_type: 'sales', contact_name: 'Maya Singh', contact_title: 'Regional Sales Manager',
  }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(job.tasks[0].lead_id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  const lead = db.prepare('SELECT source,source_url,consent_recorded_at FROM leads WHERE id=?').get(job.tasks[0].lead_id);
  assert.equal(lead.source, 'website_discovery');
  assert.equal(lead.source_url, 'https://acme.example.test/');
  assert.equal(lead.consent_recorded_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count, beforeLeads + 1);

  refreshAcmeMode = 'removed';
  const refresh = await discovery.scanLead(job.tasks[0].lead_id, { refresh: true });
  assert.equal(refresh.scan.status, 'completed');
  const refreshedJob = jobs.getJob(created.body.id);
  assert.equal(refreshedJob.tasks[0].latest_refresh.status, 'completed');
  assert.ok(refreshedJob.tasks[0].emails.length > 0);
  assert.ok(refreshedJob.tasks[0].emails.every(item => item.refresh_state === 'not_present'));

  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(exported.body, /sales@acme\.example\.test/);
  assert.match(exported.body, /Business enquiries/);
  assert.match(exported.body, /website-html-v18/);
  assert.match(exported.body, /contact_type/);
  assert.match(exported.body, /Regional Sales Manager/);
  assert.match(exported.body.split('\r\n')[0], /source_refresh_state.*source_refresh_generation.*latest_refresh_status.*latest_refresh_generation/);
  assert.match(exported.body, /not_present/);
  assert.match(exported.body.split('\r\n')[0], /source_refresh_history.*source_conflict/);
  assert.match(exported.body, /prior_content_hash/);

  refreshAcmeMode = 'conflict';
  await discovery.scanLead(job.tasks[0].lead_id, { refresh: true });
  const conflictJob = jobs.getJob(created.body.id);
  assert.ok(conflictJob.tasks[0].emails.some(item => item.source_conflict?.present_sources?.length && item.source_conflict?.absent_sources?.length));
  const conflictExport = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.match(conflictExport.body, /"yes"/);
  refreshAcmeMode = 'original';

  const callsBeforeDuplicateJob = fetchCalls.length;
  const duplicateJob = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'North Star Workshop', website_url: 'https://acme.example.test' }] },
  });
  assert.equal(duplicateJob.status, 201);
  const skipped = await waitForJob(duplicateJob.body.id, ['completed', 'partial']);
  assert.equal(skipped.tasks[0].status, 'skipped', 'a previously scanned website does not get crawled twice');
  assert.equal(fetchCalls.length, callsBeforeDuplicateJob);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(batchId).count, beforeLeads + 1);
});

test('contact-form-only outcomes persist through job review and appended CSV without a submission', async () => {
  const before = fetchCalls.length;
  const methodBefore = fetchMethods.length;
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Form Only Job', website_url: 'https://form-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(job.tasks[0].scan_error_code, 'contact_form_only');
  assert.equal(job.tasks[0].emails.length, 0);
  assert.equal(job.tasks[0].contact_forms.length, 1);
  assert.equal(job.tasks[0].contact_forms[0].source_url, 'https://form-job.example.test/');
  assert.equal(job.tasks[0].contact_forms[0].evidence_type, 'website_contact_form');
  assert.equal(job.tasks[0].contact_forms[0].extractor_version, 'website-contact-form-v1');
  assert.match(job.tasks[0].contact_forms[0].content_hash, /^[a-f0-9]{64}$/);
  assert.equal(job.tasks[0].contact_forms[0].raw_excerpt,
    'Public contact/enquiry form observed. No fields were submitted or values collected.');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
  const exportResult = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exportResult.status, 200);
  assert.match(exportResult.body.split('\r\n')[0], /contact_form_available.*contact_form_source_urls.*contact_form_evidence.*contact_form_content_hashes.*contact_form_extractor_versions.*contact_form_observed_at/);
  assert.match(exportResult.body, /"yes","https:\/\/form-job\.example\.test\/","Public contact\/enquiry form observed\. No fields were submitted or values collected\./);
  const requests = fetchCalls.slice(before).filter(value => new URL(value).hostname === 'form-job.example.test');
  assert.ok(requests.some(value => new URL(value).pathname === '/robots.txt'));
  assert.ok(!requests.some(value => new URL(value).pathname === '/submit'), 'form actions are not followed');
  assert.equal(fetchMethods.slice(methodBefore).some(value => value.method.toUpperCase() !== 'GET'), false, 'the scanner uses GET-only requests');
});
test('explicit contact scans stay in the selected batch and use the lead’s current saved site', async () => {
  const createdContact = createContact({
    batch_id: batchId,
    business_name: 'Lead Target Workshop',
    website_url: 'https://lead-target.example.test/',
  });
  const leadId = Number(createdContact.contact.id);
  const jobsBefore = db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count;
  const otherBatchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Foreign website scan fixture','discovery','open')").run().lastInsertRowid);

  const invalidLeadId = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ lead_id: String(leadId), business_name: 'Lead Target Workshop', website_url: 'https://lead-target.example.test' }] },
  });
  assert.equal(invalidLeadId.status, 422);
  assert.equal(invalidLeadId.body.code, 'lead_id_invalid');

  const staleSite = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ lead_id: leadId, business_name: 'Lead Target Workshop', website_url: 'https://different.example.test' }] },
  });
  assert.equal(staleSite.status, 409);
  assert.equal(staleSite.body.code, 'lead_website_changed');

  const foreignBatch = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: otherBatchId, businesses: [{ lead_id: leadId, business_name: 'Lead Target Workshop', website_url: 'https://lead-target.example.test' }] },
  });
  assert.equal(foreignBatch.status, 409);
  assert.equal(foreignBatch.body.code, 'lead_not_in_batch');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_jobs').get().count, jobsBefore,
    'invalid target requests roll back without leaving empty jobs');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE batch_id=?').get(otherBatchId).count, 0);

  const queued = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ lead_id: leadId, business_name: 'Lead Target Workshop', website_url: 'https://lead-target.example.test' }] },
  });
  assert.equal(queued.status, 201);
  const job = await waitForJob(queued.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(job.tasks[0].lead_id, leadId);
  assert.equal(job.tasks[0].business_name, 'Lead Target Workshop');
  assert.equal(job.tasks[0].website_url, 'https://lead-target.example.test/');
  assert.ok(job.tasks[0].emails.some(item => item.email === 'sales@lead-target.example.test'));
  assert.ok(job.tasks[0].emails.every(item => item.verification_status === 'unknown'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=?').get(leadId).count, 1,
    'an explicit contact scan never creates a second business');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(leadId).count, 0);
});

test('robots denial is recorded as a partial job and never fetched through', async () => {
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Blocked business', website_url: 'https://blocked.example.test' }] },
  });
  const job = await waitForJob(result.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'partial');
  assert.equal(job.tasks[0].status, 'blocked');
  assert.equal(job.tasks[0].error_code, 'robots_disallowed');
  assert.deepEqual(fetchCalls.filter(value => new URL(value).hostname === 'blocked.example.test').map(value => new URL(value).pathname), ['/robots.txt']);
});

test('vCard contact relationships persist through a durable job and evidence CSV', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'VCard Job Business', website_url: 'https://vcard-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  const email = job.tasks[0].emails.find(item => item.email === 'samira@vcard-job.example.test');
  assert.equal(email.verification_status, 'unknown');
  assert.deepEqual(email.contact_points, [{ contact_type: null, contact_name: 'Samira Rao', contact_title: 'Export Partnerships Lead' }]);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.match(exported.body, /"contact_type","contact_name","contact_title"/);
  assert.match(exported.body, /Export Partnerships Lead/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
});

test('public phone evidence appears in durable discovery progress and the appended CSV column', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Telephone Job Business', website_url: 'https://tel-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(job.tasks[0].phone, '+44 20 7946 0958');
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /"business_phone"/);
  assert.match(exported.body, /\+44 20 7946 0958/);
});

test('explicit Facebook page evidence appears in durable job review and appended CSV', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Facebook Job Business', website_url: 'https://facebook-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(job.tasks[0].facebook_url, 'https://www.facebook.com/facebook-job-business');
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /"facebook_profile_url"/);
  assert.match(exported.body, /https:\/\/www\.facebook\.com\/facebook-job-business/);
});

test('Microdata ContactPoint details flow into durable discovery progress and evidence CSV', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Microdata Job Business', website_url: 'https://microdata-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  const email = job.tasks[0].emails.find(item => item.email === 'arjun@microdata-job.example.test');
  assert.equal(email.verification_status, 'unknown');
  assert.deepEqual(email.contact_points, [{ contact_type: 'sales', contact_name: 'Arjun Mehta', contact_title: 'Export Sales Manager' }]);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /Export Sales Manager/);
  assert.match(exported.body, /website_microdata/);
});

test('h-card contact evidence flows into durable discovery progress and appended CSV fields', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'H-Card Job Business', website_url: 'https://hcard-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  const email = job.tasks[0].emails.find(item => item.email === 'sam@hcard-job.example.test');
  assert.equal(job.tasks[0].phone, '+1 212 555 0165');
  assert.equal(job.tasks[0].category, 'Metal fabrication');
  assert.equal(job.tasks[0].city, 'Pune');
  assert.equal(job.tasks[0].state, 'Maharashtra');
  assert.equal(job.tasks[0].address, '5 Foundry Road, Pune, Maharashtra, India');
  assert.equal(email.verification_status, 'unknown');
  assert.deepEqual(email.contact_points, [{ contact_type: null, contact_name: 'Sam Lee', contact_title: 'Commercial Director' }]);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /website-html-v18/);
  assert.match(exported.body, /Sam Lee/);
  assert.match(exported.body, /Commercial Director/);
  assert.match(exported.body, /\+1 212 555 0165/);
  assert.match(exported.body, /Metal fabrication/);
  assert.match(exported.body, /5 Foundry Road, Pune, Maharashtra, India/);
});

test('linked Schema.org Person evidence appears in durable job review and CSV', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Person Job Business', website_url: 'https://person-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  const email = job.tasks[0].emails.find(item => item.email === 'nikhil@person-job.example.test');
  assert.equal(email.verification_status, 'unknown');
  assert.deepEqual(email.contact_points, [{ contact_type: 'member', contact_name: 'Nikhil Das', contact_title: 'Operations Lead' }]);
  const sales = job.tasks[0].emails.find(item => item.email === 'sales@person-job.example.test');
  assert.equal(sales.verification_status, 'unknown');
  assert.deepEqual(sales.contact_points, [{ contact_type: 'sales', contact_name: 'Aarya Nair', contact_title: 'Sales Lead' }]);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /website-html-v18/);
  assert.match(exported.body, /Nikhil Das/);
  assert.match(exported.body, /Operations Lead/);
  assert.match(exported.body, /Aarya Nair/);
  assert.match(exported.body, /Sales Lead/);
});

test('RDFa ContactPoint evidence appears in durable job review and CSV', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'RDFa Job Business', website_url: 'https://rdfa-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  const email = job.tasks[0].emails.find(item => item.email === 'help@rdfa-job.example.test');
  assert.equal(email.verification_status, 'unknown');
  assert.deepEqual(email.contact_points, [{ contact_type: 'support', contact_name: 'Help Desk', contact_title: 'Customer Support Manager' }]);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /website-html-v18/);
  assert.match(exported.body, /Help Desk/);
  assert.match(exported.body, /Customer Support Manager/);
});

test('semantic meta email evidence survives durable job review and CSV export', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Metadata Job Business', website_url: 'https://meta-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.tasks[0].emails.map(item => item.email), ['office@meta-job.example.test']);
  assert.equal(job.tasks[0].emails[0].verification_status, 'unknown');
  assert.equal(job.tasks[0].emails[0].evidence_type, 'website_meta_email');
  assert.match(job.tasks[0].emails[0].raw_excerpt, /name="company-email"/i);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /website_meta_email/);
  assert.match(exported.body, /office@meta-job.example.test/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
});

test('non-anchor mailto contacts persist through durable review and CSV without a form submission', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Mailto Job Business', website_url: 'https://mailto-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.tasks[0].emails.map(item => item.email).sort(), [
    'help@mailto-job.example.test', 'office@mailto-job.example.test', 'sales@mailto-job.example.test',
  ]);
  assert.ok(job.tasks[0].emails.every(item => item.verification_status === 'unknown' && item.evidence_type === 'mailto'));
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /help@mailto-job.example.test/);
  assert.match(exported.body, /sales@mailto-job.example.test/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
  assert.equal(fetchCalls.some(value => value.startsWith('mailto:')), false);
});

test('image-map contact paths flow into durable discovery review and CSV', async () => {
  const requestStart = fetchCalls.length;
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Area Job Business', website_url: 'https://area-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.tasks[0].emails.map(item => item.email), ['exports@area-job.example.test']);
  assert.equal(job.tasks[0].emails[0].source_url, 'https://area-job.example.test/firm/relations');
  assert.equal(job.tasks[0].emails[0].verification_status, 'unknown');
  assert.ok(fetchCalls.includes('https://area-job.example.test/firm/relations'));
  assert.ok(fetchCalls.slice(requestStart).every(value => new URL(value).hostname === 'area-job.example.test'));
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /exports@area-job.example.test/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
});

test('accessible contact labels reach durable discovery review and CSV', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Accessible Job Business', website_url: 'https://accessible-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.tasks[0].emails.map(item => item.email), ['help@accessible-job.example.test']);
  assert.equal(job.tasks[0].emails[0].evidence_type, 'website_accessible_text');
  assert.equal(job.tasks[0].emails[0].verification_status, 'unknown');
  assert.match(job.tasks[0].emails[0].raw_excerpt, /alt: Customer support/);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /website_accessible_text/);
  assert.match(exported.body, /help@accessible-job.example.test/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
});

test('contact email data attributes persist through job review and CSV without a send side effect', async () => {
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Contact Attribute Job Business', website_url: 'https://contact-attribute-job.example.test' }] },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.tasks[0].emails.map(item => item.email), ['sales@contact-attribute-job.example.test']);
  assert.equal(job.tasks[0].emails[0].evidence_type, 'website_contact_attribute');
  assert.equal(job.tasks[0].emails[0].verification_status, 'unknown');
  assert.match(job.tasks[0].emails[0].raw_excerpt, /data-business-email:/);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body, /website_contact_attribute/);
  assert.match(exported.body, /sales@contact-attribute-job.example.test/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(job.tasks[0].lead_id).count, 0);
});

test('public free-provider business emails and multiple mailto recipients are retained as unverified', async () => {
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Free mailbox exporter', website_url: 'https://free.example.test' }] },
  });
  const job = await waitForJob(result.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(job.progress.found_emails, 2);
  assert.deepEqual(job.tasks[0].emails.map(item => item.email).sort(), ['office@outlook.com', 'person@gmail.com']);
  assert.ok(job.tasks[0].emails.every(item => item.is_free_provider === 1));
  assert.ok(job.tasks[0].emails.every(item => item.verification_status === 'unknown'));
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=? AND is_free_provider=1 AND verification_status='unknown'`)
    .get(job.tasks[0].lead_id).count, 2);
});

test('cancel preserves the in-flight company and cancels later sites before network access', async () => {
  let markStarted;
  let release;
  slowStarted = new Promise(resolve => { markStarted = resolve; });
  slowGate = new Promise(resolve => { release = resolve; });
  slowStartedResolve = markStarted;
  releaseSlowRobots = release;
  holdSlowRobots = true;
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [
      { business_name: 'Slow business', website_url: 'https://slow.example.test' },
      { business_name: 'Later business', website_url: 'https://later.example.test' },
    ] },
  });
  await Promise.race([slowStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Worker did not start the slow site.')), 2000))]);
  const cancelling = await jsonRequest(`/api/leads/website-discovery-jobs/${result.body.id}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelling.body.job.status, 'cancel_requested');
  releaseSlowRobots();
  holdSlowRobots = false;
  const job = await waitForJob(result.body.id, ['cancelled']);
  assert.deepEqual(job.tasks.map(task => task.status), ['completed', 'cancelled']);
  assert.equal(fetchCalls.some(value => new URL(value).hostname === 'later.example.test'), false);
});

test('pause stops at the current site boundary and resume continues the saved queue', async () => {
  let markStarted;
  let release;
  slowStarted = new Promise(resolve => { markStarted = resolve; });
  slowGate = new Promise(resolve => { release = resolve; });
  slowStartedResolve = markStarted;
  holdSlowRobots = true;
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [
      { business_name: 'Paused first site', website_url: 'https://slow-pause.example.test' },
      { business_name: 'Paused second site', website_url: 'https://after-pause.example.test' },
    ] },
  });
  await Promise.race([slowStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Worker did not start the paused site.')), 2000))]);
  const paused = await jsonRequest(`/api/leads/website-discovery-jobs/${result.body.id}/pause`, { method: 'POST', body: {} });
  assert.equal(paused.body.job.status, 'pause_requested');
  release();
  holdSlowRobots = false;
  const saved = await waitForJob(result.body.id, ['paused']);
  assert.deepEqual(saved.tasks.map(task => task.status), ['completed', 'queued']);
  assert.equal(fetchCalls.some(value => new URL(value).hostname === 'after-pause.example.test'), false);
  const resumed = await jsonRequest(`/api/leads/website-discovery-jobs/${result.body.id}/resume`, { method: 'POST', body: {} });
  assert.equal(resumed.body.job.status, 'queued');
  const done = await waitForJob(result.body.id, ['completed', 'partial']);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.tasks.map(task => task.status), ['completed', 'completed']);
  assert.ok(fetchCalls.some(value => new URL(value).hostname === 'after-pause.example.test'));
});

test('only a failed site request with no extracted page can be explicitly retried', async () => {
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Intermittent site', website_url: 'https://retry.example.test' }] },
  });
  const failed = await waitForJob(result.body.id, ['partial']);
  assert.equal(failed.tasks[0].status, 'failed');
  assert.equal(failed.tasks[0].retryable, true);
  assert.equal(failed.tasks[0].scan_error_code, 'website_request_failed');
  const retried = await jsonRequest(`/api/leads/website-discovery-jobs/${result.body.id}/retry`, {
    method: 'POST', body: { task_id: failed.tasks[0].id },
  });
  assert.equal(retried.status, 200);
  const complete = await waitForJob(result.body.id, ['completed', 'partial']);
  assert.equal(complete.status, 'completed');
  assert.equal(complete.tasks[0].attempt_count, 2);
  assert.equal(complete.tasks[0].scan_status, 'completed');
  assert.equal(complete.tasks[0].emails[0].verification_status, 'unknown');
});

test('website crawl request budget preserves partial evidence and only continues after an explicit action', async () => {
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Budget Works', website_url: 'https://budget.example.test' }] },
  });
  const limited = await waitForJob(result.body.id, ['partial']);
  const task = limited.tasks[0];
  assert.equal(task.status, 'failed');
  assert.equal(task.scan_status, 'failed');
  assert.equal(task.scan_error_code, 'scan_request_budget_reached');
  assert.equal(task.retryable, true);
  assert.equal(task.page_count, 12);
  assert.ok(JSON.parse(task.scan_pending_paths_json).length > 0);
  assert.ok(task.emails.some(item => item.email === 'sales@budget.example.test'));
  assert.ok(task.emails.every(item => item.verification_status === 'unknown'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(task.lead_id).count, 0);
  const pagesBeforeContinue = fetchCalls.filter(value => new URL(value).hostname === 'budget.example.test' && new URL(value).pathname !== '/robots.txt');
  assert.equal(pagesBeforeContinue.length, 12, 'one scan invocation never exceeds its page request budget');

  const continued = await jsonRequest(`/api/leads/website-discovery-jobs/${result.body.id}/retry`, {
    method: 'POST', body: { task_id: task.id },
  });
  assert.equal(continued.status, 200);
  const completed = await waitForJob(result.body.id, ['completed', 'partial']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.tasks[0].scan_status, 'completed');
  assert.deepEqual(JSON.parse(completed.tasks[0].scan_pending_paths_json), []);
  const pagesAfterContinue = fetchCalls.filter(value => new URL(value).hostname === 'budget.example.test' && new URL(value).pathname !== '/robots.txt');
  assert.equal(pagesAfterContinue.length, 13);
  assert.equal(new Set(pagesAfterContinue.map(value => new URL(value).pathname)).size, 13, 'continued work does not refetch saved page paths');
  assert.equal(completed.tasks[0].attempt_count, 2);
  assert.ok(completed.tasks[0].emails.every(item => item.verification_status === 'unknown'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(task.lead_id).count, 0);
});

test('an interrupted scan resumes from persisted page progress after manager restart', async () => {
  const leadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status,source)
    VALUES(?,?,'https://resume.example.test/','discovered','website_discovery')`).run(batchId, 'Resumable business').lastInsertRowid);
  const emailId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary)
    VALUES(?,?,'website_scan','unknown',0)`).run(leadId, 'sales@resume.example.test').lastInsertRowid);
  db.prepare(`INSERT INTO lead_email_source_evidence(lead_email_id,source_url,evidence_type,raw_excerpt,content_hash,extractor_version)
    VALUES(?,'https://resume.example.test/','mailto','sales@resume.example.test','${'a'.repeat(64)}','website-html-v2')`).run(emailId);
  db.prepare(`INSERT INTO lead_website_email_scans(lead_id,status,page_count,found_count,attempt_count,visited_paths_json,error_code)
    VALUES(?,'interrupted',1,1,1,'["/"]','worker_interrupted')`).run(leadId);
  const restarted = createWebsiteEmailDiscovery({ db, fetchImpl: fixtureFetch, minimumRequestIntervalMs: 0, wait: async () => {} });
  const restartedJobs = createWebsiteDiscoveryJobs({ db, discovery: restarted, createContact, schedule: callback => setImmediate(callback) });
  setWebsiteEmailDiscoveryTestManager(restarted);
  setWebsiteDiscoveryJobsTestManager(restartedJobs);
  const before = fetchCalls.length;
  const result = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses: [{ business_name: 'Resumable business', website_url: 'https://resume.example.test' }] },
  });
  const job = await waitForJob(result.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(db.prepare('SELECT status FROM lead_website_email_scans WHERE lead_id=?').get(leadId).status, 'completed');
  assert.equal(fetchCalls.slice(before).some(value => new URL(value).hostname === 'resume.example.test' && new URL(value).pathname === '/'), false);
  assert.ok(fetchCalls.slice(before).some(value => new URL(value).hostname === 'resume.example.test' && new URL(value).pathname === '/contact'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(leadId).count, 1);
  restartedJobs.close();
  setWebsiteEmailDiscoveryTestManager(discovery);
  setWebsiteDiscoveryJobsTestManager(jobs);
});

test('429 Retry-After cooldowns block shared hosts across jobs and survive restart until explicit recovery', async () => {
  cooldownNow = Date.now();
  cooldownMode = 'limited';
  const insertLead = db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status,source)
    VALUES(?,?,?,'discovered','website_discovery')`);
  const lead = (name, website) => Number(insertLead.run(batchId, name, website).lastInsertRowid);
  const firstLeadId = lead('Shared cooldown first site', 'https://cooldown.example.test/');
  const dateLeadId = lead('Date cooldown site', 'https://cooldown-date.example.test/');
  const malformedLeadId = lead('Malformed cooldown site', 'https://cooldown-invalid.example.test/');
  const robotsLeadId = lead('Robots cooldown site', 'https://cooldown-robots.example.test/');
  const secondLeadId = lead('Shared cooldown second site', 'https://cooldown.example.test/');
  const fakeNow = () => cooldownNow;
  const rateLimitedDiscovery = createWebsiteEmailDiscovery({
    db, fetchImpl: fixtureFetch, now: fakeNow, minimumRequestIntervalMs: 0, wait: async () => {},
  });
  const rateLimitedJobs = createWebsiteDiscoveryJobs({
    db, discovery: rateLimitedDiscovery, createContact, now: fakeNow, schedule: callback => setImmediate(callback),
  });
  let activeJobs = rateLimitedJobs;
  setWebsiteEmailDiscoveryTestManager(rateLimitedDiscovery);
  setWebsiteDiscoveryJobsTestManager(rateLimitedJobs);
  try {
    const before = fetchCalls.length;
    const created = await jsonRequest('/api/leads/website-discovery-jobs', {
      method: 'POST', body: { batch_id: batchId, businesses: [
        { lead_id: firstLeadId, business_name: 'Shared cooldown first site', website_url: 'https://cooldown.example.test/' },
        { lead_id: dateLeadId, business_name: 'Date cooldown site', website_url: 'https://cooldown-date.example.test/' },
        { lead_id: malformedLeadId, business_name: 'Malformed cooldown site', website_url: 'https://cooldown-invalid.example.test/' },
        { lead_id: robotsLeadId, business_name: 'Robots cooldown site', website_url: 'https://cooldown-robots.example.test/' },
      ] },
    });
    assert.equal(created.status, 201);
    const limited = await waitForJob(created.body.id, ['partial']);
    assert.equal(limited.tasks.length, 4);
    const byName = name => limited.tasks.find(task => task.business_name === name);
    const first = byName('Shared cooldown first site');
    const dateTask = byName('Date cooldown site');
    const malformed = byName('Malformed cooldown site');
    const robots = byName('Robots cooldown site');
    for (const task of [first, dateTask, malformed, robots]) {
      assert.equal(task.status, 'blocked', task.business_name);
      assert.equal(task.retryable, false, 'a task cannot be retried while its host cooldown is active');
      assert.ok(task.retry_after_at, 'the job review exposes a persisted retry time');
    }
    assert.equal(first.scan_error_code, 'site_rate_limited');
    assert.equal(dateTask.scan_error_code, 'site_rate_limited');
    assert.equal(malformed.scan_error_code, 'site_rate_limited');
    assert.equal(robots.scan_error_code, 'robots_rate_limited');
    assert.equal(Date.parse(first.retry_after_at), cooldownNow + 120_000, 'integer Retry-After seconds are honored');
    assert.ok(Date.parse(dateTask.retry_after_at) >= cooldownNow + 89_000
      && Date.parse(dateTask.retry_after_at) <= cooldownNow + 90_000, 'HTTP-date Retry-After is honored');
    assert.equal(Date.parse(malformed.retry_after_at), cooldownNow + 60_000,
      'malformed Retry-After falls back to the conservative first-attempt delay');
    assert.equal(Date.parse(robots.retry_after_at), cooldownNow + 180_000,
      'robots.txt rate limits persist their Retry-After deadline');

    const hostCalls = fetchCalls.slice(before).map(value => new URL(value))
      .filter(url => url.hostname === 'cooldown.example.test');
    assert.equal(hostCalls.filter(url => url.pathname === '/robots.txt').length, 1);
    assert.equal(hostCalls.filter(url => url.pathname === '/contact').length, 1,
      'the first 429 ends further requests in that scan');
    assert.ok(first.emails.some(item => item.email === 'sales@cooldown.example.test'),
      'email evidence collected before the 429 remains available');
    assert.ok(first.emails.every(item => item.verification_status === 'unknown'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(first.lead_id).count, 0);

    const secondCreated = await jsonRequest('/api/leads/website-discovery-jobs', {
      method: 'POST', body: { batch_id: batchId, businesses: [
        { lead_id: secondLeadId, business_name: 'Shared cooldown second site', website_url: 'https://cooldown.example.test/' },
      ] },
    });
    assert.equal(secondCreated.status, 201);
    const secondJob = await waitForJob(secondCreated.body.id, ['partial']);
    const second = secondJob.tasks[0];
    assert.equal(second.status, 'blocked');
    assert.equal(second.scan_error_code, 'site_rate_limited');
    assert.equal(second.retry_after_at, first.retry_after_at, 'a later job on the host inherits the saved cooldown');
    assert.equal(fetchCalls.slice(before).map(value => new URL(value))
      .filter(url => url.hostname === 'cooldown.example.test').length, hostCalls.length,
    'the next job makes no network request to the cooling host');

    const earlyRetry = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/retry`, {
      method: 'POST', body: { task_id: first.id },
    });
    assert.equal(earlyRetry.status, 429);
    assert.equal(earlyRetry.body.code, 'site_cooldown_active');

    rateLimitedJobs.close();
    const restartedDiscovery = createWebsiteEmailDiscovery({
      db, fetchImpl: fixtureFetch, now: fakeNow, minimumRequestIntervalMs: 0, wait: async () => {},
    });
    const restartedJobs = createWebsiteDiscoveryJobs({
      db, discovery: restartedDiscovery, createContact, now: fakeNow, schedule: callback => setImmediate(callback),
    });
    activeJobs = restartedJobs;
    setWebsiteEmailDiscoveryTestManager(restartedDiscovery);
    setWebsiteDiscoveryJobsTestManager(restartedJobs);
    const callsBeforeRestartRead = fetchCalls.length;
    const afterRestart = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}`);
    assert.equal(afterRestart.body.tasks.find(task => task.id === first.id).retry_after_at, first.retry_after_at);
    assert.equal(afterRestart.body.tasks.find(task => task.id === first.id).retryable, false);
    assert.equal(fetchCalls.length, callsBeforeRestartRead, 'manager restart does not automatically retry blocked sites');
    const restartedSecondJob = await jsonRequest(`/api/leads/website-discovery-jobs/${secondCreated.body.id}`);
    assert.equal(restartedSecondJob.body.tasks[0].retry_after_at, first.retry_after_at);
    assert.equal(restartedSecondJob.body.tasks[0].retryable, false);

    cooldownNow += 121_000;
    cooldownMode = 'healthy';
    const afterExpiry = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}`);
    assert.equal(afterExpiry.body.tasks.find(task => task.id === first.id).retryable, true);
    assert.equal(fetchCalls.length, callsBeforeRestartRead, 'expiry alone does not initiate a network request');
    const evidenceBefore = db.prepare(`SELECT le.id AS email_id,ev.content_hash,ev.raw_excerpt
      FROM lead_emails le JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
      WHERE le.lead_id=? AND le.email='sales@cooldown.example.test'`).get(first.lead_id);
    assert.ok(evidenceBefore);
    const recovery = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/retry`, {
      method: 'POST', body: { task_id: first.id },
    });
    assert.equal(recovery.status, 200);
    let recovered;
    for (let attempt = 0; attempt < 200; attempt++) {
      recovered = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}`);
      const task = recovered.body.tasks.find(item => item.id === first.id);
      if (task.scan_status === 'completed' && task.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const recoveredTask = recovered.body.tasks.find(task => task.id === first.id);
    assert.equal(recoveredTask.scan_status, 'completed');
    assert.equal(recoveredTask.status, 'completed');
    assert.equal(recoveredTask.attempt_count, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=? AND email='sales@cooldown.example.test'`).get(first.lead_id).count, 1);
    const evidenceAfter = db.prepare(`SELECT le.id AS email_id,ev.content_hash,ev.raw_excerpt
      FROM lead_emails le JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
      WHERE le.lead_id=? AND le.email='sales@cooldown.example.test'`).get(first.lead_id);
    assert.equal(evidenceAfter.email_id, evidenceBefore.email_id, 'explicit recovery preserves the saved email record');
    assert.equal(evidenceAfter.content_hash, evidenceBefore.content_hash, 'existing evidence content remains intact');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(first.lead_id).count, 0);
  } catch (error) {
    throw error;
  } finally {
    activeJobs.close();
    setWebsiteEmailDiscoveryTestManager(discovery);
    setWebsiteDiscoveryJobsTestManager(jobs);
  }
});

test('website discovery accepts more than 100 seeds, paginates review, and exports every result', async () => {
  const businesses = Array.from({ length: 105 }, (_, index) => ({
    business_name: `Scale Seed ${index + 1}`,
    website_url: `https://scale-${index + 1}.example.test/`,
  }));
  // Seed durable completed scan evidence so this is a fast, deterministic test
  // of large-job persistence and review paging rather than 105 network walks.
  for (let index = 0; index < businesses.length; index++) {
    const business = businesses[index];
    const leadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status,source)
      VALUES(?,?,?,'discovered','website_discovery')`).run(batchId, business.business_name, business.website_url).lastInsertRowid);
    const email = `sales@scale-${index + 1}.example.test`;
    const emailId = Number(db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary)
      VALUES(?,?,'website_scan','unknown',0)`).run(leadId, email).lastInsertRowid);
    db.prepare(`INSERT INTO lead_email_source_evidence(lead_email_id,source_url,evidence_type,raw_excerpt,content_hash,extractor_version)
      VALUES(?,?,'website_html',?,?, 'website-html-v21')`)
      .run(emailId, business.website_url, `Business enquiries: ${email}`, String(index.toString(16).padStart(64, '0')));
    db.prepare(`INSERT INTO lead_website_email_scans(lead_id,status,page_count,found_count,attempt_count,visited_paths_json)
      VALUES(?,'completed',1,1,1,'["/"]')`).run(leadId);
  }
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task_count, 105);

  const job = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}`);
  assert.equal(job.status, 200);
  const firstPage = job.body;
  assert.equal(firstPage.status, 'completed');
  assert.equal(firstPage.task_pagination.total, 105);
  assert.equal(firstPage.task_pagination.offset, 0);
  assert.equal(firstPage.task_pagination.limit, 100);
  assert.equal(firstPage.task_pagination.hasMore, true);
  assert.equal(firstPage.tasks.length, 100);
  assert.equal(new Set(firstPage.tasks.map(task => task.id)).size, 100);
  assert.equal(firstPage.progress.total, 105);
  assert.equal(firstPage.progress.skipped, 105);
  assert.equal(firstPage.progress.found_emails, 105, 'address totals are global, not limited to the first result page');
  assert.equal(firstPage.tasks[0].emails[0].verification_status, 'unknown');

  const secondPage = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}?offset=100&limit=100`);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.task_pagination.offset, 100);
  assert.equal(secondPage.body.task_pagination.total, 105);
  assert.equal(secondPage.body.task_pagination.hasMore, false);
  assert.equal(secondPage.body.tasks.length, 5);
  assert.equal(new Set(secondPage.body.tasks.map(task => task.id)).size, 5);
  assert.equal(secondPage.body.tasks[0].business_name, 'Scale Seed 101');
  assert.equal(secondPage.body.tasks.at(-1).business_name, 'Scale Seed 105');
  assert.equal(new Set([...firstPage.tasks, ...secondPage.body.tasks].map(task => task.id)).size, 105,
    'the two pages contain every persisted task exactly once');
  assert.equal(secondPage.body.progress.found_emails, 105);

  const persisted = db.prepare('SELECT COUNT(*) AS count FROM website_discovery_tasks WHERE job_id=?').get(created.body.id);
  assert.equal(persisted.count, 105);
  const exported = await jsonRequest(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(exported.status, 200);
  for (let index = 1; index <= 105; index++) assert.ok(exported.body.includes(`Scale Seed ${index}"`), `CSV omitted seed ${index}`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM sends
    WHERE lead_id IN (SELECT lead_id FROM website_discovery_tasks WHERE job_id=?)`).get(created.body.id).count, 0);
});

test('one website discovery job scans multiple existing leads and saves evidence to the selected companies', async () => {
  const businesses = [
    { business_name: 'Bulk Scan One', website_url: 'https://bulk-one.example.test/' },
    { business_name: 'Bulk Scan Two', website_url: 'https://bulk-two.example.test/' },
  ].map(business => ({
    ...business,
    lead_id: Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status,source)
      VALUES(?,?,?,'discovered','epch_directory')`).run(batchId, business.business_name, business.website_url).lastInsertRowid),
  }));
  const created = await jsonRequest('/api/leads/website-discovery-jobs', {
    method: 'POST', body: { batch_id: batchId, businesses },
  });
  assert.equal(created.status, 201);
  const job = await waitForJob(created.body.id, ['completed', 'partial']);
  assert.equal(job.status, 'completed');
  assert.equal(job.task_count, 2);
  assert.deepEqual(job.tasks.map(task => [task.lead_id, task.business_name]), businesses.map(item => [item.lead_id, item.business_name]));
  for (let index = 0; index < businesses.length; index++) {
    const task = job.tasks[index];
    assert.equal(task.emails[0].email, `sales@bulk-${index === 0 ? 'one' : 'two'}.example.test`);
    assert.equal(task.emails[0].verification_status, 'unknown');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(businesses[index].lead_id).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(businesses[index].lead_id).count, 0);
  }
});

