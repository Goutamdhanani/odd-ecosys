import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-local-discovery-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'local-discovery-fixture-private-token-123456';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
let searchCalls = 0;
let cookies;
const originalMx = dns.promises.resolveMx;
dns.promises.resolveMx = async domain => {
  assert.equal(domain, 'ontario-fixture.test', 'only the synthetic company may reach the DNS fixture');
  return [{ exchange: 'mx.ontario-fixture.test', priority: 10 }];
};
const provider = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/searchbox/search?')) {
    searchCalls++;
    const url = new URL(req.url, 'http://fixture');
    assert.equal(url.searchParams.get('format'), 'json');
    return res.end(JSON.stringify({ results: [
      { title: 'Ontario Fixture Studio', url: 'https://ontario-fixture.test/contact', content: 'Public business website.', engine: 'controlled-fixture' },
      { title: 'Duplicate studio', url: 'https://ontario-fixture.test/about' },
      { title: 'Private network', url: 'http://127.0.0.1:9000/' },
    ] }));
  }
  if (req.url === '/version') return res.end(JSON.stringify({ version: '0.9.1' }));
  if (req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { to_email } = JSON.parse(body);
    if (!to_email) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'to_email field is required.' })); }
    // Controlled provider evidence, never a claim about a real mailbox.
    return res.end(JSON.stringify({ input: to_email, is_reachable: 'unknown', syntax: { is_valid_syntax: true },
      mx: { accepts_mail: true, records: ['mx.ontario-fixture.test'] },
      misc: { is_disposable: false, is_role_account: false },
      smtp: { can_connect_smtp: false, is_deliverable: null, is_catch_all: null } }));
  }
  res.end('{}');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
process.env.ODD_SEARXNG_LOCAL_BASE_URL = `http://127.0.0.1:${provider.address().port}/searchbox`;
process.env.REACHER_API_URL = `http://127.0.0.1:${provider.address().port}/v0/check_email`;
const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createContact } = await import('../pipeline/contact-manager.js');
const { createSearxngSearchManager } = await import('../pipeline/searxng-search.js');
const siteCalls = [];
const discovery = createWebsiteEmailDiscovery({ db, minimumRequestIntervalMs: 0, wait: async () => {}, fetchImpl: async input => {
  const url = new URL(input); siteCalls.push(url.href);
  assert.equal(url.hostname, 'ontario-fixture.test');
  return url.pathname === '/robots.txt'
    ? new Response('User-agent: *\nAllow: /', { headers: { 'content-type': 'text/plain' } })
    : new Response('<html><body><a href="mailto:taylor@ontario-fixture.test">Business contact</a></body></html>', { headers: { 'content-type': 'text/html' } });
} });
const jobs = createWebsiteDiscoveryJobs({ db, discovery, createContact, schedule: callback => setImmediate(callback) });
const { server, setWebsiteEmailDiscoveryTestManager, setWebsiteDiscoveryJobsTestManager } = await import('../server.js');
setWebsiteEmailDiscoveryTestManager(discovery);
setWebsiteDiscoveryJobsTestManager(jobs);
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let headers = {};
let batch;
let discoveryJobId;
let leadId;
after(async () => {
  dns.promises.resolveMx = originalMx;
  jobs.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => provider.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});
async function request(route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}

test('authenticated owner saves local search and collects an observed address into Contacts with source evidence', async () => {
  assert.equal((await request('/api/leads/search-provider')).status, 401);
  const response = await fetch(`${base}/api/auth/bootstrap`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'local-owner@example.test', password: 'Fixture-owner-password-91!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }) });
  assert.equal(response.status, 201);
  const cookieHeader = response.headers.get('set-cookie');
  cookies = { session: cookieHeader.match(/odd_session=([^;,]+)/)[1], csrf: cookieHeader.match(/odd_csrf=([^;,]+)/)[1] };
  headers = { origin: base, cookie: `odd_session=${cookies.session}; odd_csrf=${cookies.csrf}`, 'x-csrf-token': cookies.csrf };
  const initial = await request('/api/leads/search-provider');
  assert.equal(initial.body.local_endpoint_url, process.env.ODD_SEARXNG_LOCAL_BASE_URL);
  const settings = await request('/api/leads/search-provider', 'PUT', { endpoint_url: initial.body.local_endpoint_url });
  assert.equal(settings.status, 200, JSON.stringify(settings));
  assert.equal(settings.body.settings.configured, true);
  const wrongPort = await request('/api/leads/search-provider', 'PUT', { endpoint_url: 'http://127.0.0.1:9999' });
  assert.equal(wrongPort.status, 422);
  batch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Controlled Ontario workflow','discovery','open')").run().lastInsertRowid);
  const searched = await request('/api/leads/search-jobs', 'POST', { batch_id: batch, query: 'Ontario business studios' });
  assert.equal(searched.status, 201, JSON.stringify(searched));
  assert.equal(searchCalls, 1, 'the real HTTP search transport reaches the loopback fixture');
  assert.equal(searched.body.result_count, 1);
  assert.equal(searched.body.rejected_result_count, 2);
  const imported = await request(`/api/leads/search-jobs/${searched.body.id}/import`, 'POST', { result_ids: [searched.body.results[0].id] });
  assert.equal(imported.status, 200, JSON.stringify(imported));
  discoveryJobId = imported.body.website_discovery_job.id;
  for (let attempt = 0; attempt < 200 && jobs.getJob(discoveryJobId).status !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const saved = jobs.getJob(discoveryJobId);
  assert.equal(saved.status, 'completed', JSON.stringify(saved));
  assert.equal(saved.progress.found_emails, 1);
  assert.equal(saved.tasks[0].emails[0].email, 'taylor@ontario-fixture.test');
  leadId = saved.tasks[0].lead_id;
  assert.ok(siteCalls.includes('https://ontario-fixture.test/robots.txt'));
  const contacts = await request('/api/leads?search=Ontario');
  assert.equal(contacts.status, 200);
  assert.equal(contacts.body.leads[0].id, leadId);
  assert.equal(contacts.body.leads[0].email, null, 'collection never silently selects a sending address');
  assert.equal(contacts.body.leads[0].observed_email, 'taylor@ontario-fixture.test');
  assert.equal(contacts.body.leads[0].observed_email_count, 1);
  const detail = await request(`/api/leads/${leadId}`);
  assert.equal(detail.body.emails[0].email, 'taylor@ontario-fixture.test');
  assert.ok(detail.body.emails[0].source_evidence.length > 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM lead_profile_source_evidence WHERE lead_id=? AND evidence_type='search_result'").get(leadId).n > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
});

test('verification preserves source observations, inconclusive evidence, CSV export and durable saved state', async () => {
  const sources = () => db.prepare('SELECT e.* FROM lead_email_source_evidence e JOIN lead_emails le ON le.id=e.lead_email_id WHERE le.lead_id=?').all(leadId);
  const sourcesBefore = sources();
  const verified = await request(`/api/verify/batch/${batch}`, 'POST', {});
  assert.equal(verified.status, 202, JSON.stringify(verified));
  for (let attempt = 0; attempt < 200; attempt++) {
    if (db.prepare('SELECT status FROM verification_jobs WHERE batch_id=? ORDER BY id DESC').get(batch)?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const job = db.prepare('SELECT status,processed,deliverable,risky,undeliverable FROM verification_jobs WHERE batch_id=? ORDER BY id DESC').get(batch);
  assert.deepEqual(job, { status: 'completed', processed: 1, deliverable: 0, risky: 0, undeliverable: 0 });
  assert.deepEqual(sources(), sourcesBefore);
  const row = db.prepare('SELECT * FROM lead_emails WHERE lead_id=?').get(leadId);
  assert.equal(row.verification_status, 'unknown');
  assert.equal(db.prepare('SELECT email FROM leads WHERE id=?').get(leadId).email, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_history WHERE email_id=?').get(row.id).n, 1);
  const exported = await fetch(`${base}/api/leads/website-discovery-jobs/${discoveryJobId}/export`, { headers });
  assert.equal(exported.status, 200);
  const csv = parse(await exported.text(), { bom: true, columns: true });
  assert.equal(csv.length, sourcesBefore.length, 'export retains every source observation for the one unique email');
  assert.equal(new Set(csv.map(item => item.email)).size, 1);
  assert.equal(csv[0].email, row.email);
  assert.equal(csv[0].verification_status, 'unknown');
  assert.match(csv[0].source_url, /^https:\/\/ontario-fixture\.test\//);
  const reopened = new Database(process.env.ODD_DB_PATH, { readonly: true });
  assert.equal(reopened.prepare('SELECT verification_status FROM lead_emails WHERE id=?').get(row.id).verification_status, 'unknown');
  assert.equal(reopened.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(discoveryJobId).status, 'completed');
  reopened.close();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
});

test('Contacts browser exposes approved local connection and persisted result after reload', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'odd_session', value: cookies.session, url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: cookies.csrf, url: base, sameSite: 'Strict' },
    ]);
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#leads`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Ontario Fixture Studio', { exact: true }).first().waitFor();
    await page.getByText('taylor@ontario-fixture.test', { exact: true }).first().waitFor();
    await page.getByText('Saved address · no primary selected', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Search businesses' }).click();
    const dialog = page.getByRole('dialog', { name: 'Search for businesses' });
    await dialog.getByText(/Your server allows local search/).waitFor();
    assert.equal(await dialog.locator('[name="search_endpoint"]').inputValue(), process.env.ODD_SEARXNG_LOCAL_BASE_URL);
    await page.keyboard.press('Escape');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Ontario Fixture Studio', { exact: true }).first().waitFor();
    await page.getByText('taylor@ontario-fixture.test', { exact: true }).first().waitFor();
    const byEmail = await request('/api/leads?search=taylor%40ontario-fixture.test');
    assert.equal(byEmail.body.pagination.total, 1);
    assert.equal(byEmail.body.leads[0].id, leadId);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('removing operator trust blocks persisted local settings without making requests or sticking busy state', async () => {
  const previous = process.env.ODD_SEARXNG_LOCAL_BASE_URL;
  delete process.env.ODD_SEARXNG_LOCAL_BASE_URL;
  try {
    const manager = createSearxngSearchManager({ db, websiteDiscoveryJobs: jobs });
    const before = searchCalls;
    for (let i = 0; i < 2; i++) await assert.rejects(manager.testConnection(), error => error.code === 'provider_endpoint_invalid');
    assert.equal(searchCalls, before);
    manager.saveConfiguration({ endpoint_url: 'https://search.example.test' }, { role: 'owner', id: 1 });
  } finally { process.env.ODD_SEARXNG_LOCAL_BASE_URL = previous; }
});
