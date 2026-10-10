import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-lead-search-'));
process.env.ODD_DB_PATH = path.join(directory, 'search.db');
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'synthetic-lead-search-bootstrap-token-0123456789';
process.env.ODD_AUTH_RECOVERY_TOKEN = 'synthetic-lead-search-recovery-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Lead search fixtures','discovery','open')").run().lastInsertRowid);
function seedLead({ name, city = '', category = '', address = '', state = '', country = '', phone = '', website = '', email = '', source = 'manual', sourceDetails = '', sourceUrl = '', status = 'discovered' }) {
  return Number(db.prepare(`INSERT INTO leads(
    batch_id,business_name,category,address,city,state,country,phone,website_url,email,source,source_details,source_url,
    normalized_domain,normalized_phone,status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    batchId, name, category, address, city, state, country, phone, website, email, source, sourceDetails, sourceUrl,
    website ? new URL(website).hostname : null,
    phone ? phone.replace(/\D/g, '') : null,
    status,
  ).lastInsertRowid);
}

const sourcedLeadId = seedLead({
  name: 'Alpha Precision Works', category: 'Industrial Instruments', address: '12 Gauge Road', city: 'Pune',
  state: 'Maharashtra', country: 'India', phone: '+91 98220 12345', website: 'https://alpha-search.example.test',
  email: 'research@alpha-search.example.test', source: 'openstreetmap',
  sourceDetails: 'OpenStreetMap · ODbL · feature 7 · source timestamp: 2026-10-09T08:00:00Z',
  sourceUrl: 'https://www.openstreetmap.org/relation/7654321',
});
const percentLeadId = seedLead({ name: 'Needle%Works', city: 'Pune' });
seedLead({ name: 'NeedleXWorks', city: 'Pune' });
const underscoreLeadId = seedLead({ name: 'Unit_One Services', city: 'Mumbai' });
seedLead({ name: 'UnitXOne Services', city: 'Mumbai' });
const slashLeadId = seedLead({ name: 'Backslash\\Works', city: 'Delhi' });
seedLead({ name: 'BackslashWorks', city: 'Delhi' });

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'lead-search@example.test', password: 'Synthetic-search-password-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
});
if (bootstrap.status !== 201) throw new Error(`Could not create the disposable lead-search user: ${bootstrap.status}`);
const setCookie = bootstrap.headers.get('set-cookie') || '';
const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
if (!session || !csrf) throw new Error('The disposable auth flow did not issue a session.');

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function search(value, extra = {}) {
  const params = new URLSearchParams({ search: value, ...extra });
  const response = await fetch(`${base}/api/leads?${params}`, { headers: { cookie: `odd_session=${session}` } });
  assert.equal(response.status, 200);
  return response.json();
}

test('Leads quick search finds sourced contacts by category, full address, geography, phone, site and provenance', async () => {
  for (const term of [
    'Industrial Instruments', '12 Gauge Road', 'Maharashtra', 'India', '+91 98220 12345',
    'alpha-search.example.test', 'OpenStreetMap', 'relation/7654321',
  ]) {
    const result = await search(term);
    assert.equal(result.pagination.total, 1, `search for ${term} should return one matching sourced contact`);
    assert.equal(result.leads[0].id, sourcedLeadId, `search for ${term} should return the OSM contact`);
  }
  const intersected = await search('Industrial Instruments', { batch_id: String(batchId), status: 'discovered', limit: '1' });
  assert.deepEqual(intersected.leads.map(lead => lead.id), [sourcedLeadId], 'existing filters and pagination still intersect with quick search');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
});

test('Quick search treats SQL LIKE metacharacters as literal user text', async () => {
  assert.deepEqual((await search('%')).leads.map(lead => lead.id), [percentLeadId]);
  assert.deepEqual((await search('_')).leads.map(lead => lead.id), [underscoreLeadId]);
  assert.deepEqual((await search('\\')).leads.map(lead => lead.id), [slashLeadId]);
});

test('Leads screen searches source provenance through the real browser input', async t => {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!process.env.ODD_CHROMIUM_EXECUTABLE_PATH && !existsSync(edgePath)) return t.skip('No local Edge runtime is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    executablePath: process.env.ODD_CHROMIUM_EXECUTABLE_PATH || edgePath,
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  const apiResponses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === base && url.pathname.startsWith('/api/')) apiResponses.push(`${response.status()} ${url.pathname}`);
  });
  try {
    await page.context().addCookies([
      { name: 'odd_session', value: session, url: base },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base },
    ]);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.__nav === 'function');
    await page.evaluate(() => window.__nav('leads'));
    const searchInput = page.locator('#lead-search');
    await searchInput.waitFor({ timeout: 10000 }).catch(async () => {
      const screen = await page.locator('#main-content').innerText().catch(() => page.locator('body').innerText());
      throw new Error(`Leads screen did not render. pageErrors=${errors.join('; ')} api=${apiResponses.join(', ')} screen=${screen.slice(0, 800)}`);
    });
    assert.equal(await searchInput.getAttribute('maxlength'), '120');
    await searchInput.fill('relation/7654321');
    await page.getByText('Alpha Precision Works', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.leads-table tbody tr.lead-row').length === 1, undefined, { timeout: 10000 });
    const visibleLeadRows = await page.locator('.leads-table tbody tr.lead-row').count();
    assert.equal(visibleLeadRows, 1, 'source object URL query shows only the matching prospect');
    const sourceLink = page.getByRole('link', { name: 'OpenStreetMap ↗' });
    assert.equal(await sourceLink.getAttribute('href'), 'https://www.openstreetmap.org/relation/7654321');
    assert.equal(await sourceLink.getAttribute('target'), '_blank');
    assert.match(await sourceLink.getAttribute('title'), /ODbL.*2026-10-09T08:00:00Z/);
    assert.match(await sourceLink.getAttribute('rel'), /noopener/);
    assert.equal(errors.length, 0, `browser should not throw: ${errors.join('; ')}`);
  } finally {
    await browser.close();
  }
});
