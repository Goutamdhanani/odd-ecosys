import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-qualification-scoring-api-'));
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'qualification-scoring-bootstrap-fixture-123456';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { getQualificationScoringManager } = await import('../pipeline/qualification-scoring.js');
const initialProfile = getQualificationScoringManager(db).getProfile();
const batch = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Scoring replay fixture','qualification','open')").run();
const lead = db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status,site_status,site_score,confidence,site_reasons,
  site_reasons_json,site_checked_at)
  VALUES (?,?,?,'site_checked','OUTDATED',50,90,'fixture evidence',?,datetime('now'))`).run(
  batch.lastInsertRowid,
  'Synthetic scoring evidence',
  'https://example.invalid',
  JSON.stringify({
    signals: {
      ssl_valid: false, viewport_meta: true, copyright_recent: true, has_analytics: true,
      modern_cms: false, responsive_images: false, fast_load: true, structured_data: false,
      custom_domain_email: false, social_links: false, last_modified_recent: null, https_redirect: true,
    },
    reasons: ['synthetic_fixture'],
    scoring: { version: 1, configHash: initialProfile.configHash, applicable: true },
  }),
);
const addUnscoredLead = db.prepare(`INSERT INTO leads(batch_id,business_name,status,site_status,confidence,site_reasons_json)
  VALUES (?,?,'site_checked','NO_SITE',100,?)`);
for (let index = 1; index <= 101; index += 1) {
  addUnscoredLead.run(batch.lastInsertRowid, `Synthetic pagination fixture ${index}`, JSON.stringify({
    signals: {}, scoring: { version: 1, applicable: false },
  }));
}
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    setCookie: response.headers.get('set-cookie') || '',
    body: contentType.includes('json') ? await response.json() : await response.text(),
  };
}

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'owner bootstrap issues a session cookie');
  assert.ok(csrf, 'owner bootstrap issues a CSRF cookie');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

test('scoring profile API versions rules and replays saved lead evidence without mutating it', async t => {
  const bootstrapped = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: {
      email: 'scoring-owner@example.test',
      password: 'fixture-password-long-enough-2026',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(bootstrapped.status, 201);
  const owner = authCookies(bootstrapped.setCookie);

  const activeV1 = await request('/api/qualify/scoring', { cookie: owner.cookie });
  assert.equal(activeV1.status, 200);
  assert.equal(activeV1.body.active.version, 1);
  assert.match(activeV1.body.active.configHash, /^[a-f0-9]{64}$/);

  const unchangedLead = db.prepare('SELECT site_score,site_status,confidence,site_reasons_json FROM leads WHERE id=?').get(lead.lastInsertRowid);
  const forbiddenCsrf = await request('/api/qualify/scoring', {
    method: 'PUT', cookie: owner.cookie,
    body: { config: activeV1.body.active.config, changeNote: 'missing CSRF' },
  });
  assert.equal(forbiddenCsrf.status, 403);

  const configV2 = structuredClone(activeV1.body.active.config);
  configV2.signal_weights.modern_cms = configV2.signal_weights.modern_cms + 10;
  const invitation = await request('/api/workspace/invitations', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { email: 'scoring-operator@example.test', role: 'operator' },
  });
  assert.equal(invitation.status, 201);
  const acceptedInvitation = await request('/api/auth/invitations/accept', {
    method: 'POST',
    body: { email: 'scoring-operator@example.test', password: 'operator-fixture-password-2026', invitationToken: invitation.body.invitation.token },
  });
  assert.equal(acceptedInvitation.status, 201);
  const operator = authCookies(acceptedInvitation.setCookie);
  const forbiddenRole = await request('/api/qualify/scoring', {
    method: 'PUT', cookie: operator.cookie, csrf: operator.csrf,
    body: { config: configV2, changeNote: 'Operators cannot edit scoring' },
  });
  assert.equal(forbiddenRole.status, 403);
  const changed = await request('/api/qualify/scoring', {
    method: 'PUT', cookie: owner.cookie, csrf: owner.csrf,
    body: { config: configV2, changeNote: 'Fixture calibration' },
  });
  assert.equal(changed.status, 201);
  assert.equal(changed.body.active.version, 2);
  assert.notEqual(changed.body.active.configHash, activeV1.body.active.configHash);
  assert.deepEqual(changed.body.history.map(item => item.version), [2, 1]);

  const noOp = await request('/api/qualify/scoring', {
    method: 'PUT', cookie: owner.cookie, csrf: owner.csrf,
    body: { config: configV2, changeNote: 'Duplicate profile' },
  });
  assert.equal(noOp.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM qualification_scoring_profiles').get().count, 2);

  const replayV1 = await request(`/api/qualify/lead/${lead.lastInsertRowid}/scoring-replay?version=1`, { cookie: owner.cookie });
  assert.equal(replayV1.status, 200);
  assert.equal(replayV1.body.profile.version, 1);
  assert.equal(replayV1.body.replayed.scoring.version, 1);
  assert.equal(replayV1.body.replayed.site_score, 50);
  assert.equal(replayV1.body.replayed.site_status, 'OUTDATED');
  assert.equal(replayV1.body.replayed.confidence, unchangedLead.confidence);
  assert.equal(replayV1.body.recorded.configHash, initialProfile.configHash);

  const replayV2 = await request(`/api/qualify/lead/${lead.lastInsertRowid}/scoring-replay`, { cookie: owner.cookie });
  assert.equal(replayV2.status, 200);
  assert.equal(replayV2.body.profile.version, 2);
  assert.equal(replayV2.body.replayed.scoring.configHash, changed.body.active.configHash);
  assert.equal(replayV2.body.replayed.site_score, 45);
  assert.deepEqual(replayV1.body.signals, replayV2.body.signals, 'both versions consume the same saved signal evidence');

  const results = await request(`/api/qualify/results/${batch.lastInsertRowid}`, { cookie: owner.cookie });
  assert.equal(results.status, 200);
  assert.equal(results.body.total, 102);
  assert.equal(results.body.results.length, 100, 'results use a bounded 100-row page');
  assert.equal(results.body.results[0].site_evidence.scoring.version, 1);
  assert.equal(results.body.results[0].site_evidence.signals.fast_load, true);
  const distribution = await request(`/api/leads/site-status-distribution?batch_id=${batch.lastInsertRowid}`, { cookie: owner.cookie });
  assert.equal(distribution.body.find(item => item.site_status === 'NO_SITE').count, 101);
  assert.equal(distribution.body.find(item => item.site_status === 'OUTDATED').count, 1);
  assert.deepEqual(db.prepare('SELECT site_score,site_status,confidence,site_reasons_json FROM leads WHERE id=?').get(lead.lastInsertRowid), unchangedLead,
    'profile edits and replay do not rescore or rewrite the stored qualification result');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type='qualification_scoring_profile_created'").get().count, 1);

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
    const leadRow = page.locator('.lead-row').filter({ hasText: 'Synthetic scoring evidence' });
    await leadRow.waitFor({ timeout: 10_000 });
    assert.match(await leadRow.innerText(), /50\/100/);
    assert.equal(await leadRow.getByLabel('TLS signal: Not detected').count(), 1,
      'the score table uses the saved TLS observation instead of inferring from site classification');
    assert.match(await page.locator('.qual-status-card').filter({ hasText: 'No Site' }).innerText(), /101/,
      'status cards use the batch aggregate rather than the visible result page');
    assert.match(await page.locator('.qual-pagination').innerText(), /Page 1 of 2/);
    await leadRow.click();
    const signalPanel = page.getByRole('region', { name: 'Saved technical site signals' });
    await signalPanel.waitFor();
    const tlsEvidence = signalPanel.locator('.qual-signal-row').filter({ hasText: 'Valid TLS certificate' });
    assert.match(await tlsEvidence.innerText(), /Not detected/);
    const viewportEvidence = signalPanel.locator('.qual-signal-row').filter({ hasText: 'Mobile viewport metadata' });
    assert.match(await viewportEvidence.innerText(), /Detected/);
    const lastModifiedEvidence = signalPanel.locator('.qual-signal-row').filter({ hasText: 'Recently modified' });
    assert.match(await lastModifiedEvidence.innerText(), /Not observed/);
    assert.doesNotMatch(await signalPanel.innerText(), /(?:^|\n)Valid TLS(?:\n|$)|Missing Meta|Recent Posts|No Posts Found/,
      'the row does not infer protocol, viewport or social activity from the overall site classification');
    await page.getByRole('button', { name: 'Replay saved signals with current profile' }).click();
    await page.getByText(/Profile v2 → OUTDATED, 45\/100/).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Page 2 of 2').waitFor();
    assert.equal(await page.locator('.data-table tbody .lead-row').count(), 2, 'the next bounded page displays the remaining two leads');
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByText('Page 1 of 2').waitFor();
    await page.getByText('Outdated Site (1)').click();
    await page.getByText(/Showing 1–1 of 1 matching leads/).waitFor();
    await page.getByText('All Leads (102)').click();
    await leadRow.waitFor();
    await page.locator('#workspace-navigation [data-view="settings"]').click();
    await page.getByRole('heading', { name: 'Website scoring · version 2' }).waitFor({ timeout: 10_000 });
    await page.locator('#qualification-scoring-form [name="weight:modern_cms"]').fill('25');
    await page.locator('#qualification-scoring-form [name="changeNote"]').fill('Browser-verified profile edit');
    await page.getByRole('button', { name: 'Save as new version' }).click();
    await page.getByRole('heading', { name: 'Website scoring · version 3' }).waitFor({ timeout: 10_000 });
    await page.getByText('Browser-verified profile edit').waitFor();
    const savedV3 = await request('/api/qualify/scoring', { cookie: owner.cookie });
    assert.equal(savedV3.body.active.config.signal_weights.modern_cms, 25, 'Settings persists scoring changes through the authenticated profile API');
    assert.deepEqual(pageErrors, [], 'the live Qualification view renders profile and signal evidence without browser exceptions');
  } finally {
    await context.close();
    await browser.close();
  }
});
