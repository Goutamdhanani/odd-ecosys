import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-qualification-source-access-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'qualification-access-bootstrap-fixture-123456';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
const db = database.initDb();
const { getQualificationScoringManager } = await import('../pipeline/qualification-scoring.js');
const { checkFacebookLiveness, qualifyBatch, qualifyLead } = await import('../pipeline/qualifier.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session);
  assert.ok(csrf);
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

async function request(route, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.csrf) headers['x-csrf-token'] = auth.csrf;
  const response = await fetch(`${base}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let payload = {};
  try { payload = await response.json(); } catch { /* retain empty response */ }
  return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: payload };
}

function response(status, body = '') {
  return {
    url: 'https://restricted-source.example.test/',
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

test('restricted and unavailable sources remain unknown, with exact evidence preserved through API and UI', async t => {
  const ownerResponse = await request('/api/auth/bootstrap', {
    method: 'POST', body: {
      email: 'source-owner@example.test', password: 'source-owner-password-fixture-2026',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(ownerResponse.status, 201);
  const owner = authCookies(ownerResponse.setCookie);
  assert.equal((await request('/api/qualify/status', { auth: owner })).status, 200, 'initialize recovery before the synthetic run');

  const facebookURL = 'https://facebook.example.test/page';
  for (const [status, expectedValue, expectedReason] of [
    [200, 1, null], [302, 1, null], [404, 0, null], [410, 0, null], [403, null, 'facebook_access_restricted_http_403'],
    [429, null, 'facebook_rate_limited_http_429'], [503, null, 'facebook_response_unknown_http_503'],
  ]) {
    const result = await checkFacebookLiveness(facebookURL, { fetchPage: async () => response(status) });
    assert.equal(result.value, expectedValue, `Facebook HTTP ${status} should map to a tri-state availability result`);
    assert.equal(result.reason, expectedReason);
  }
  const failedFacebookRequest = await checkFacebookLiveness(facebookURL, { fetchPage: async () => { throw new Error('fixture timeout'); } });
  assert.deepEqual(failedFacebookRequest, { value: null, reason: 'facebook_network_unavailable' });

  const batch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Restricted source fixture','qualification','open')").run().lastInsertRowid);
  const lead = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,facebook_url,status)
    VALUES (?,'Restricted source lead','https://restricted-source.example.test/','https://facebook.example.test/page','discovered')`)
    .run(batch).lastInsertRowid);
  const sendCountBefore = db.prepare('SELECT COUNT(*) AS count FROM sends').get().count;
  const profile = getQualificationScoringManager(db).getProfile();
  const summary = await qualifyBatch(batch, {
    concurrency: 1,
    qualifyLeadImpl: (row, { scoringProfile }) => qualifyLead(row, {
      scoringProfile,
      fetchPage: async () => response(403),
      checkFacebook: async () => ({ value: null, reason: 'facebook_access_restricted_http_403' }),
      takeScreenshot: async () => null,
    }),
  });
  assert.equal(summary.status, 'completed');
  assert.equal(summary.processed, 1);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(lead).status, 'site_checked', '403 is not treated as a modern-site rejection');
  assert.equal(db.prepare('SELECT site_status FROM leads WHERE id=?').get(lead).site_status, 'CHECK_FAILED');
  assert.equal(db.prepare('SELECT site_score FROM leads WHERE id=?').get(lead).site_score, null);
  assert.equal(db.prepare('SELECT fb_active FROM leads WHERE id=?').get(lead).fb_active, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, sendCountBefore, 'source restrictions cannot change send records');

  const apiResults = await request(`/api/qualify/results/${batch}`, { auth: owner });
  assert.equal(apiResults.status, 200);
  const saved = apiResults.body.results.find(row => row.id === lead);
  assert.equal(saved.site_status, 'CHECK_FAILED');
  assert.equal(saved.status, 'site_checked');
  assert.ok(saved.site_reasons.includes('source_access_unknown_http_403'));
  assert.ok(saved.site_reasons.includes('facebook_check_unknown:facebook_access_restricted_http_403'));
  assert.equal(saved.site_evidence.signals.source_access, 'unknown');
  assert.equal(saved.site_evidence.signals.facebook_access, 'unknown');
  assert.equal(saved.site_evidence.signals.facebook_check_reason, 'facebook_access_restricted_http_403');
  assert.equal(saved.site_evidence.scoring.applicable, false, 'restricted source content cannot produce a site score');

  const notFound = await qualifyLead({ id: 9101, business_name: 'Missing fixture', website_url: 'https://missing.example.test/' }, {
    scoringProfile: profile, fetchPage: async () => response(404), checkFacebook: async () => null, takeScreenshot: async () => null,
  });
  assert.equal(notFound.site_status, 'DEAD_SITE', 'only explicit 404/410 responses establish a missing page');
  assert.equal(notFound.site_reasons[0], 'http_404');
  const gone = await qualifyLead({ id: 9104, business_name: 'Gone fixture', website_url: 'https://gone.example.test/' }, {
    scoringProfile: profile, fetchPage: async () => response(410), checkFacebook: async () => null, takeScreenshot: async () => null,
  });
  assert.equal(gone.site_status, 'DEAD_SITE');
  assert.equal(gone.site_reasons[0], 'http_410');
  const rateLimited = await qualifyLead({ id: 9102, business_name: 'Rate limited fixture', website_url: 'https://limited.example.test/' }, {
    scoringProfile: profile, fetchPage: async () => response(429), checkFacebook: async () => null, takeScreenshot: async () => null,
  });
  assert.equal(rateLimited.site_status, 'CHECK_FAILED');
  assert.equal(rateLimited.site_score, null);
  assert.equal(rateLimited.site_reasons[0], 'source_access_unknown_http_429');
  const timedOut = await qualifyLead({ id: 9103, business_name: 'Timeout fixture', website_url: 'https://timeout.example.test/' }, {
    scoringProfile: profile, fetchPage: async () => { throw new Error('fixture network timeout'); },
    checkFacebook: async () => null, takeScreenshot: async () => null,
  });
  assert.equal(timedOut.site_status, 'CHECK_FAILED');
  assert.ok(timedOut.site_reasons.includes('site_fetch_unknown'));

  if (!existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    const session = owner.cookie.match(/odd_session=([^;]+)/)?.[1];
    const csrf = owner.cookie.match(/odd_csrf=([^;]+)/)?.[1];
    await context.addCookies([
      { name: 'odd_session', value: decodeURIComponent(session), url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base, sameSite: 'Strict' },
    ]);
    await page.goto(`${base}/#qualification`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Know who’s worth a closer look.' }).waitFor({ timeout: 10_000 });
    await page.locator('.lead-status-badge').filter({ hasText: 'Check Failed' }).waitFor();
    await page.getByLabel('Facebook page availability unknown').waitFor();
    const row = page.locator('.lead-row').filter({ hasText: 'Restricted source lead' });
    await row.click();
    const expandedEvidence = await page.locator('.lead-row.expanded + tr').innerText();
    assert.match(expandedEvidence, /Website denied automated access \(HTTP 403\)/);
    assert.match(expandedEvidence, /Facebook denied automated access \(HTTP 403\)/);
    assert.deepEqual(pageErrors, [], 'the access-restriction explanation renders without browser errors');
  } finally {
    await context.close();
    await browser.close();
  }
});
