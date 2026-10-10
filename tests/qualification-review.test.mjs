import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQualificationReviewManager } from '../pipeline/qualification-review.js';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-qualification-review-'));
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

test('review manager queues current low-confidence evidence and appends reasoned overrides without changing raw leads', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE batches(id INTEGER PRIMARY KEY,name TEXT);
      CREATE TABLE leads(id INTEGER PRIMARY KEY,batch_id INTEGER,business_name TEXT,website_url TEXT,site_status TEXT,
        site_score INTEGER,confidence INTEGER,site_reasons TEXT,site_reasons_json TEXT,site_checked_at TEXT);`);
    db.prepare('INSERT INTO batches(id,name) VALUES (1,\'Batch one\'),(2,\'Batch two\')').run();
    const evidence = JSON.stringify({ signals: { ssl_valid: false }, reasons: ['no_ssl'], scoring: { version: 1, applicable: true } });
    const insert = db.prepare(`INSERT INTO leads(id,batch_id,business_name,website_url,site_status,site_score,confidence,site_reasons,site_reasons_json,site_checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run(1, 1, 'Low confidence modern result', 'https://one.example.test', 'MODERN', 80, 35, 'no_ssl', evidence, '2026-10-09 10:00:00');
    insert.run(2, 1, 'Zero confidence result', 'https://two.example.test', 'CHECK_FAILED', null, 0, 'render failed', evidence, '2026-10-09 10:00:00');
    insert.run(3, 1, 'Above threshold', 'https://three.example.test', 'OUTDATED', 20, 71, 'low score', evidence, '2026-10-09 10:00:00');
    insert.run(4, 2, 'Other batch result', 'https://four.example.test', 'MODERN', 90, 10, 'modern', evidence, '2026-10-09 10:00:00');
    insert.run(5, 1, 'No confidence', 'https://five.example.test', 'DEAD_SITE', null, null, 'timeout', evidence, '2026-10-09 10:00:00');

    const reviews = createQualificationReviewManager(db);
    const firstPage = reviews.getReviewQueue({ batchId: 1, limit: 1, offset: 0 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.results[0].id, 2, 'zero confidence is included and sorted first');
    const secondPage = reviews.getReviewQueue({ batchId: 1, limit: 1, offset: 1 });
    assert.equal(secondPage.results[0].id, 1);

    const original = db.prepare('SELECT site_status,site_score,confidence,site_reasons_json FROM leads WHERE id=1').get();
    assert.throws(() => reviews.recordReview({ leadId: 1, decision: 'override', siteStatus: 'OUTDATED', reason: 'short', actor: { id: 9, role: 'reviewer' } }), /8 to 500/);
    assert.throws(() => reviews.recordReview({ leadId: 1, decision: 'override', siteStatus: 'UNKNOWN', reason: 'Evidence clearly supports this.', actor: { id: 9, role: 'reviewer' } }), /valid site classification/);
    assert.throws(() => reviews.recordReview({ leadId: 1, decision: 'override', siteStatus: 'MODERN', reason: 'Evidence clearly supports this.', actor: { id: 9, role: 'reviewer' } }), /confirm decision/);
    assert.throws(() => reviews.recordReview({ leadId: 1, decision: 'override', siteStatus: 'OUTDATED', reason: 'Evidence clearly supports this.', actor: { id: 10, role: 'guest' } }), /cannot review/);

    const override = reviews.recordReview({
      leadId: 1, decision: 'override', siteStatus: 'OUTDATED', reason: 'The saved TLS and viewport signals contradict this category.',
      actor: { id: 9, role: 'reviewer' },
    });
    assert.equal(override.originalSiteStatus, 'MODERN');
    assert.equal(override.effectiveSiteStatus, 'OUTDATED');
    assert.equal(override.reviewedByRole, 'reviewer');
    assert.equal(override.evidenceMatchesCurrent, true);
    assert.deepEqual(reviews.getReviewQueue({ batchId: 1 }).results.map(row => row.id), [2], 'reviewed evidence leaves the unreviewed queue');
    assert.equal(reviews.getCurrentReview(1).effectiveSiteStatus, 'OUTDATED');
    assert.deepEqual(db.prepare('SELECT site_status,site_score,confidence,site_reasons_json FROM leads WHERE id=1').get(), original,
      'a human override never rewrites the automated qualification fields or evidence');

    db.prepare(`UPDATE leads SET site_score=82,site_reasons_json=?,site_checked_at='2026-10-09 10:01:00' WHERE id=1`)
      .run(JSON.stringify({ signals: { ssl_valid: true }, reasons: [], scoring: { version: 1, applicable: true } }));
    assert.equal(reviews.getCurrentReview(1), null, 'a new audit invalidates the current review marker but keeps its history');
    assert.deepEqual(reviews.getReviewQueue({ batchId: 1 }).results.map(row => row.id), [2, 1]);

    const confirmation = reviews.recordReview({
      leadId: 1, decision: 'confirm', reason: 'The new audit supports its automated classification.',
      actor: { id: 9, role: 'reviewer' },
    });
    assert.equal(confirmation.effectiveSiteStatus, 'MODERN');
    assert.deepEqual(reviews.getReviewHistory(1).map(row => row.decision), ['confirm', 'override']);
    assert.equal(reviews.getReviewHistory(1)[1].evidenceMatchesCurrent, false);
    assert.equal(reviews.getReviewHistory(1)[0].evidenceMatchesCurrent, true);
    assert.throws(() => reviews.getReviewQueue({ batchId: 1, maxConfidence: 101 }), /0 to 100/);
  } finally {
    db.close();
  }
});

process.env.ODD_DB_PATH = path.join(directory, 'http-fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'qualification-review-bootstrap-fixture-123456';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
const db = database.initDb();
const batch = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Evidence review fixture','qualification','open')").run();
const { getQualificationScoringManager } = await import('../pipeline/qualification-scoring.js');
const scoringProfile = getQualificationScoringManager(db).getProfile();
const signalSet = {
  ssl_valid: false, viewport_meta: true, copyright_recent: false, has_analytics: false,
  modern_cms: false, responsive_images: false, fast_load: true, structured_data: false,
  custom_domain_email: false, social_links: false, last_modified_recent: null, https_redirect: false,
};
const leadIds = [];
for (const [name, siteStatus, score, confidence] of [
  ['API review fixture', 'MODERN', 78, 40],
  ['Browser review fixture', 'MODERN', 75, 65],
]) {
  const evidence = JSON.stringify({
    signals: signalSet,
    reasons: ['synthetic_low_confidence_fixture'],
    scoring: {
      version: scoringProfile.version,
      configHash: scoringProfile.configHash,
      applicable: true,
      rawScore: 40,
      maxScore: 100,
      unresolvedSignals: ['last_modified_recent'],
      thresholds: scoringProfile.config.thresholds,
    },
  });
  const result = db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status,site_status,site_score,confidence,site_reasons,
    site_reasons_json,site_checked_at)
    VALUES (?,?,'https://review-fixture.example.test/','site_checked',?,?,?,'synthetic low confidence evidence',?,datetime('now'))`)
    .run(batch.lastInsertRowid, name, siteStatus, score, confidence, evidence);
  leadIds.push(Number(result.lastInsertRowid));
}
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
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
  assert.ok(session, 'workspace sign-in issues a session cookie');
  assert.ok(csrf, 'workspace sign-in issues a CSRF cookie');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

test('reviewer can audit a low-confidence override in the API and browser without changing raw classification or send state', async t => {
  const bootstrapped = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: {
      email: 'review-owner@example.test', password: 'review-owner-password-fixture-2026',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(bootstrapped.status, 201);
  const owner = authCookies(bootstrapped.setCookie);
  const invitation = await request('/api/workspace/invitations', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { email: 'evidence-reviewer@example.test', role: 'reviewer' },
  });
  assert.equal(invitation.status, 201);
  const accepted = await request('/api/auth/invitations/accept', {
    method: 'POST',
    body: { email: 'evidence-reviewer@example.test', password: 'reviewer-password-fixture-2026', invitationToken: invitation.body.invitation.token },
  });
  assert.equal(accepted.status, 201);
  const reviewer = authCookies(accepted.setCookie);

  const initialQueue = await request(`/api/qualify/review-queue?batch_id=${batch.lastInsertRowid}&max_confidence=70`, { cookie: reviewer.cookie });
  assert.equal(initialQueue.status, 200);
  assert.equal(initialQueue.body.total, 2);
  assert.deepEqual(initialQueue.body.results.map(row => row.confidence), [40, 65]);
  const rawBefore = db.prepare('SELECT site_status,site_score,confidence,status,site_reasons_json FROM leads WHERE id=?').get(leadIds[0]);
  const missingCsrf = await request(`/api/qualify/review/${leadIds[0]}`, {
    method: 'POST', cookie: reviewer.cookie,
    body: { decision: 'override', siteStatus: 'OUTDATED', reason: 'Synthetic evidence supports it.' },
  });
  assert.equal(missingCsrf.status, 403);
  const apiReview = await request(`/api/qualify/review/${leadIds[0]}`, {
    method: 'POST', cookie: reviewer.cookie, csrf: reviewer.csrf,
    body: { decision: 'override', siteStatus: 'OUTDATED', reason: 'Synthetic evidence supports manual reclassification.' },
  });
  assert.equal(apiReview.status, 201);
  assert.equal(apiReview.body.review.effectiveSiteStatus, 'OUTDATED');
  assert.equal(apiReview.body.sendingEligibilityChanged, false);
  assert.deepEqual(db.prepare('SELECT site_status,site_score,confidence,status,site_reasons_json FROM leads WHERE id=?').get(leadIds[0]), rawBefore);
  const rawResults = await request(`/api/qualify/results/${batch.lastInsertRowid}`, { cookie: reviewer.cookie });
  const apiRow = rawResults.body.results.find(row => row.id === leadIds[0]);
  assert.equal(apiRow.site_status, 'MODERN', 'the automated classification remains the primary evidence');
  assert.equal(apiRow.human_review.effectiveSiteStatus, 'OUTDATED', 'the separately audited decision is visible beside the raw classification');
  assert.equal(apiRow.status, 'site_checked', 'the review does not change lead status or eligibility');
  const history = await request(`/api/qualify/lead/${leadIds[0]}/review-history`, { cookie: reviewer.cookie });
  assert.equal(history.body.reviews.length, 1);
  assert.match(history.body.reviews[0].reason, /manual reclassification/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type='qualification_review_override'").get().count, 1);
  assert.deepEqual((await request(`/api/qualify/review-queue?batch_id=${batch.lastInsertRowid}`, { cookie: reviewer.cookie })).body.results.map(row => row.id), [leadIds[1]]);

  if (!existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    const session = reviewer.cookie.match(/odd_session=([^;]+)/)?.[1];
    const csrf = reviewer.cookie.match(/odd_csrf=([^;]+)/)?.[1];
    await context.addCookies([
      { name: 'odd_session', value: decodeURIComponent(session), url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base, sameSite: 'Strict' },
    ]);
    await page.goto(`${base}/#qualification`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Know who’s worth a closer look.' }).waitFor({ timeout: 10_000 });
    const reviewItem = page.locator('.qual-review-row').filter({ hasText: 'Browser review fixture' });
    await reviewItem.waitFor({ timeout: 10_000 });
    await reviewItem.getByRole('button', { name: 'Review evidence' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review Browser review fixture' });
    await dialog.waitFor();
    await dialog.getByLabel('Decision').selectOption('override');
    await dialog.getByLabel('Reviewed classification').selectOption('OUTDATED');
    await dialog.getByLabel('Reason for this review').fill('The stored synthetic site signals support an outdated classification.');
    await dialog.getByRole('button', { name: 'Save review decision' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByText('No unreviewed low-confidence site audits are waiting in this batch.').waitFor();
    const browserRow = page.locator('.lead-row').filter({ hasText: 'Browser review fixture' });
    await browserRow.waitFor();
    assert.match(await browserRow.innerText(), /Modern Site[\s\S]*Human override · OUTDATED/);
    await browserRow.click();
    await page.getByText(/human review · MODERN → OUTDATED/i).waitFor();
    await page.getByRole('button', { name: 'View review history' }).click();
    await page.locator('.qual-review-history').getByText('The stored synthetic site signals support an outdated classification.', { exact: true }).waitFor();
    assert.deepEqual(pageErrors, [], 'the reviewer UI opens evidence, records an override and displays its audit without browser errors');
  } finally {
    await context.close();
    await browser.close();
  }
});
