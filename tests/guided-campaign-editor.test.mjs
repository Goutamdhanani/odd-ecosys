import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';

// Disposable, retained fixtures; only this exact API listener may receive traffic.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-guided-editor-'));
const evidenceDirectory = path.resolve('orchestration/evidence/GUIDED-CAMPAIGN-001-R2-EDITOR');
fs.mkdirSync(evidenceDirectory, { recursive: true });
const runName = process.env.ODD_EDITOR_EVIDENCE_RUN || `run-${Date.now()}`;
const outcomes = { directory, runName, checks: [], backendDenied: [], browserDenied: [], pageErrors: [] };
Object.assign(process.env, {
  NODE_ENV: 'test', ODD_DB_PATH: path.join(directory, 'editor.db'), PORT: '0', HOST: '127.0.0.1',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'guided-editor-synthetic-owner-bootstrap-20261022',
  ODD_CREDENTIAL_ENCRYPTION_KEY: '8'.repeat(64), ODD_PERSONALIZATION_BEDROCK_ENABLED: 'false',
});
delete process.env.ODD_PUBLIC_BASE_URL; delete process.env.APP_URL;
let apiPort = -1;
const denied = destination => {
  outcomes.backendDenied.push(destination);
  return Object.assign(new Error(`Editor fixture denied network: ${destination}`), { code: 'EDITOR_EGRESS_BLOCKED' });
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async input => { throw denied(`backend fetch ${String(input)}`); };
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' };
  if (Number(options.port) !== apiPort || !['127.0.0.1', '::ffff:127.0.0.1'].includes(options.host)) throw denied(`socket ${String(options.host)}:${String(options.port)}`);
  return Reflect.apply(nativeConnect, this, args);
};
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'resolveNs', 'resolveCname', 'reverse']) {
  if (typeof dns[name] === 'function') dns[name] = (...args) => {
    const callback = args.at(-1);
    if (name === 'lookup' && args[0] === '127.0.0.1') return queueMicrotask(() => callback(null, '127.0.0.1', 4));
    const error = denied(`DNS ${name}`);
    if (typeof callback === 'function') queueMicrotask(() => callback(error)); else throw error;
  };
  if (typeof dnsPromises[name] === 'function') dnsPromises[name] = async () => { throw denied(`DNS promise ${name}`); };
}
syncBuiltinESMExports();
const database = await import('../pipeline/database.js');
const db = database.initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
apiPort = server.address().port;
const base = `http://127.0.0.1:${apiPort}`;
let headers = {};
async function api(route, method = 'GET', value) {
  const response = await nativeFetch(`${base}${route}`, {
    method, headers: { ...headers, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const boot = await api('/api/auth/bootstrap', 'POST', {
  email: 'editor-owner@example.test', password: 'Editor-local-fixture-password-20261022!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
});
assert.equal(boot.status, 201);
const cookie = boot.headers.get('set-cookie');
const session = cookie.match(/odd_session=([^;,]+)/)[1];
const csrf = cookie.match(/odd_csrf=([^;,]+)/)[1];
headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
await context.route('**/*', route => {
  if (new URL(route.request().url()).origin === base) return route.continue();
  outcomes.browserDenied.push(route.request().url()); return route.abort();
});
await context.addCookies([
  { name: 'odd_session', value: session, url: base, httpOnly: true, sameSite: 'Strict' },
  { name: 'odd_csrf', value: csrf, url: base, sameSite: 'Strict' },
]);
// Optional before-source replay serves the immutable R1 JS without mutating any source path.
if (process.env.ODD_EDITOR_FROZEN_R1 === 'true') {
  const frozen = JSON.parse(fs.readFileSync('.superpowers/sdd/af17c7fad1785d7e/after-ui-r1.json', 'utf8'));
  await context.route('**/js/campaign-workspace.js', route => route.fulfill({ contentType: 'application/javascript', body: frozen.files['js/campaign-workspace.js'].text }));
}
const body = {
  subjectLine: 'A note for Editor Workshop',
  bodyText: 'Hello Editor Workshop, I am writing to ask whether a short conversation about your current outreach process would be useful. We can compare the steps your team uses today and discuss a practical way to reduce repeated work. Would you like to review a brief outline next week?',
  expectedLatestPersonalizationId: null, expectedLatestCopyHash: null,
};
let fixtureNumber = 0;
function fixture() {
  const number = ++fixtureNumber;
  const email = `editor-${number}@example.test`;
  const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES (?,?,'verified')").run('Editor Workshop', email).lastInsertRowid);
  db.prepare("INSERT INTO lead_emails(lead_id,email,is_primary,verification_status) VALUES (?,?,1,'deliverable')").run(leadId, email);
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES (?,'draft')").run(`Editor fixture ${number}`).lastInsertRowid);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);
  return { leadId, campaignId, email, route: `/api/sending/campaigns/${campaignId}/audience/${leadId}/draft` };
}
async function firstCopy(f, subjectLine = 'Initial saved version') {
  const result = await api(f.route, 'POST', { ...body, subjectLine });
  assert.equal(result.status, 201, JSON.stringify(result)); return result.body;
}
const card = (page, f) => page.locator(`[data-cw-contact="${f.leadId}"]`);
async function openReview(f) {
  const page = await context.newPage();
  page.on('pageerror', error => outcomes.pageErrors.push(error.message));
  await page.goto(`${base}/?campaign=${f.campaignId}&step=review#campaigns`, { waitUntil: 'domcontentloaded' });
  await card(page, f).waitFor(); return page;
}
async function refresh(page, f) {
  await page.evaluate(() => window.__refreshCampaignWorkspace()); await card(page, f).waitFor();
}
async function save(page, f) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === f.route && value.request().method() === 'POST');
  await card(page, f).locator('[data-cw-save-copy]').click();
  const result = await response; const payload = await result.json();
  if (result.status() === 201) await card(page, f).getByText(`Version #${payload.personalizationId} · not approved`, { exact: true }).waitFor();
  return { status: result.status(), body: payload, request: result.request().postDataJSON() };
}
function proof(name, value) { outcomes.checks.push({ name, ...value }); console.log('EDITOR_PROOF ' + JSON.stringify(outcomes.checks.at(-1))); }
async function withPage(f, callback) { const page = await openReview(f); try { await callback(page); } finally { page.removeAllListeners('dialog'); await page.close({ runBeforeUnload: false }); } }

test('saving and approving A preserves B, including B original token', async () => {
  const a = fixture(), b = fixture();
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(a.campaignId, b.leadId);
  await firstCopy(a); const oldB = await firstCopy(b);
  await withPage(a, async page => {
    const pending = 'Pending correction for contact B';
    await card(page, b).locator('[data-cw-subject]').fill(pending);
    await card(page, a).locator('[data-cw-subject]').fill('Saved correction for contact A');
    assert.equal((await save(page, a)).status, 201);
    assert.equal(await card(page, b).locator('[data-cw-subject]').inputValue(), pending);
    await card(page, a).locator('[data-cw-approve]').click();
    await card(page, a).getByText(/Version #\d+ · approved/, { exact: true }).waitFor();
    assert.equal(await card(page, b).locator('[data-cw-subject]').inputValue(), pending);
    const savedB = await save(page, { ...b, route: `/api/sending/campaigns/${a.campaignId}/audience/${b.leadId}/draft` });
    assert.equal(savedB.status, 201); assert.equal(savedB.request.expectedLatestPersonalizationId, oldB.personalizationId);
    proof('other-card-save-and-approval', { pending, submittedBaseline: savedB.request.expectedLatestPersonalizationId });
  });
});

test('step return and a failed refresh/retry keep subject and body', async () => {
  const f = fixture(); await firstCopy(f);
  await withPage(f, async page => {
    const subject = 'Pending edit before checking sequence', text = body.bodyText + ' Please keep this pending sentence.';
    await card(page, f).locator('[data-cw-subject]').fill(subject); await card(page, f).locator('[data-cw-body]').fill(text);
    await page.locator('[data-cw-step="sequence"]').click(); await page.locator('[data-cw-sequence]').waitFor();
    await page.locator('[data-cw-step="review"]').click(); await card(page, f).waitFor();
    assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), subject);
    const audienceRoute = `${base}/api/sending/campaigns/${f.campaignId}/audience?*`;
    await page.route(audienceRoute, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary fixture failure"}' }));
    await page.evaluate(() => window.__refreshCampaignWorkspace()); await page.getByRole('heading', { name: 'Campaign state could not load' }).waitFor();
    await page.unroute(audienceRoute); await page.locator('[data-cw-retry]').click(); await card(page, f).waitFor();
    assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), subject);
    assert.equal(await card(page, f).locator('[data-cw-body]').inputValue(), text);
    proof('step-failure-retry', { subject, bodyPreserved: true });
  });
});

test('the same contact keeps separate unsaved text in two campaigns', async () => {
  const a = fixture(); await firstCopy(a);
  const other = fixture(); db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(other.campaignId, a.leadId);
  await withPage(a, async page => {
    await card(page, a).locator('[data-cw-subject]').fill('Pending campaign A text');
    await page.evaluate(async campaignId => (await import('/js/campaign-workspace.js')).openCampaignWorkspace(campaignId, 'review'), other.campaignId);
    await card(page, other).waitFor();
    assert.equal(await card(page, a).locator('[data-cw-subject]').inputValue(), 'Initial saved version');
    await card(page, a).locator('[data-cw-subject]').fill('Pending campaign B text');
    await page.evaluate(async campaignId => (await import('/js/campaign-workspace.js')).openCampaignWorkspace(campaignId, 'review'), a.campaignId);
    await page.getByRole('heading', { name: `Editor fixture ${fixtureNumber - 1}`, exact: true }).waitFor();
    assert.equal(await card(page, a).locator('[data-cw-subject]').inputValue(), 'Pending campaign A text');
    await page.evaluate(async campaignId => (await import('/js/campaign-workspace.js')).openCampaignWorkspace(campaignId, 'review'), other.campaignId);
    await card(page, other).waitFor();
    assert.equal(await card(page, a).locator('[data-cw-subject]').inputValue(), 'Pending campaign B text');
    proof('same-contact-two-campaigns', { campaignA: a.campaignId, campaignB: other.campaignId, leadId: a.leadId });
  });
});

test('newer append plus on-screen approval cannot silently rebase pending text', async () => {
  const f = fixture(); const first = await firstCopy(f, 'Original displayed version');
  await withPage(f, async page => {
    const pending = 'Local correction based on old version';
    await card(page, f).locator('[data-cw-subject]').fill(pending);
    const newer = await api(f.route, 'POST', { ...body, subjectLine: 'Newer version from another editor', expectedLatestPersonalizationId: first.personalizationId, expectedLatestCopyHash: first.latestCopyHash });
    assert.equal(newer.status, 201);
    await card(page, f).locator('[data-cw-approve]').click();
    await card(page, f).getByText(`Version #${newer.body.personalizationId} · not approved`, { exact: true }).waitFor();
    assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), pending);
    const rejected = await save(page, f);
    assert.equal(rejected.status, 409); assert.equal(rejected.request.expectedLatestPersonalizationId, first.personalizationId);
    await card(page, f).locator('[data-cw-discard]').waitFor();
    assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), pending);
    assert.match(await card(page, f).innerText(), /Newer version from another editor/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM personalizations WHERE lead_id=?').get(f.leadId).n, 2);
    await page.screenshot({ path: path.join(evidenceDirectory, `${runName}-conflict.png`), fullPage: true });
    await card(page, f).locator('[data-cw-discard]').click(); await card(page, f).waitFor();
    assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), 'Newer version from another editor');
    proof('append-conflict', { saveStatus: rejected.status, originalId: first.personalizationId, newerId: newer.body.personalizationId, discardedOnlyByExplicitAction: true });
  });
});

test('same-row approval/hash drift refreshed by another card retains the original hash', async () => {
  const a = fixture(), b = fixture(); await firstCopy(b); const first = await firstCopy(a);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(a.campaignId, b.leadId);
  await withPage(a, async page => {
    await card(page, a).locator('[data-cw-subject]').fill('Pending text before same-row approval');
    const approve = await api(`/api/personalize/approve/${first.personalizationId}`, 'POST', {});
    assert.equal(approve.status, 200);
    await card(page, b).locator('[data-cw-approve]').click();
    await card(page, a).getByText(`Version #${first.personalizationId} · approved`, { exact: true }).waitFor();
    const rejected = await save(page, a);
    assert.equal(rejected.status, 409); assert.equal(rejected.request.expectedLatestCopyHash, first.latestCopyHash);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM personalizations WHERE lead_id=?').get(a.leadId).n, 1);
    proof('same-row-hash-conflict', { saveStatus: rejected.status, originalHash: rejected.request.expectedLatestCopyHash });
  });
});

test('typing during a save is retained and the next explicit save uses its confirmed baseline', async () => {
  const a = fixture(), b = fixture(); await firstCopy(a); await firstCopy(b);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(a.campaignId, b.leadId);
  await withPage(a, async page => {
    let release, started; const held = new Promise(resolve => { release = resolve; }); const reached = new Promise(resolve => { started = resolve; });
    await page.route(`${base}${a.route}`, async route => { started(); await held; await route.continue(); });
    try {
      await card(page, a).locator('[data-cw-subject]').fill('Submitted first correction');
      const responsePromise = page.waitForResponse(value => new URL(value.url()).pathname === a.route);
      await card(page, a).locator('[data-cw-save-copy]').click(); await reached;
      await card(page, a).locator('[data-cw-subject]').fill('New typing while first correction saves');
      await card(page, b).locator('[data-cw-subject]').fill('Other contact pending during save');
      release(); const response = await responsePromise; assert.equal(response.status(), 201); const result = await response.json();
      await card(page, a).getByText(`Version #${result.personalizationId} · not approved`, { exact: true }).waitFor();
      assert.equal(await card(page, a).locator('[data-cw-subject]').inputValue(), 'New typing while first correction saves');
      assert.equal(await card(page, b).locator('[data-cw-subject]').inputValue(), 'Other contact pending during save');
      await page.unroute(`${base}${a.route}`);
      const second = await save(page, a); assert.equal(second.status, 201); assert.equal(second.request.expectedLatestPersonalizationId, result.personalizationId);
      proof('in-flight-new-typing', { firstSavedId: result.personalizationId, secondBaseline: second.request.expectedLatestPersonalizationId, otherCardPreserved: true });
    } finally { release(); await page.unroute(`${base}${a.route}`); }
  });
});

test('changing selection during fingerprint calculation prevents the old save mutation', async () => {
  const a = fixture(), b = fixture(); await firstCopy(a); await firstCopy(b);
  await withPage(a, async page => {
    await card(page, a).locator('[data-cw-subject]').fill('Pending old selection text');
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args) => { window.__editorHashStarted = true; await new Promise(resolve => { window.__releaseEditorHash = resolve; }); return digest(...args); };
    });
    const requests = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/draft')) requests.push(request.url()); });
    await card(page, a).locator('[data-cw-save-copy]').click(); await page.waitForFunction(() => window.__editorHashStarted === true);
    await page.evaluate(async campaignId => (await import('/js/campaign-workspace.js')).openCampaignWorkspace(campaignId, 'review'), b.campaignId);
    await card(page, b).waitFor(); await page.evaluate(() => window.__releaseEditorHash());
    await page.waitForTimeout(150);
    assert.deepEqual(requests, []); assert.equal(db.prepare('SELECT COUNT(*) n FROM personalizations WHERE lead_id=?').get(a.leadId).n, 1);
    proof('pre-dispatch-selection-guard', { staleSavePosts: requests.length });
  });
});

test('saved guardrail guidance survives refresh, step return and browser reload', async () => {
  const f = fixture();
  await withPage(f, async page => {
    await card(page, f).locator('[data-cw-subject]').fill('Short copy review');
    await card(page, f).locator('[data-cw-body]').fill('Editor Workshop short.');
    const result = await save(page, f); assert.equal(result.status, 201); assert.equal(result.body.guardrailPassed, false);
    assert.match(await card(page, f).innerText(), /message is too short|body too short/i);
    await refresh(page, f); assert.match(await card(page, f).innerText(), /message is too short|body too short/i);
    await page.locator('[data-cw-step="sequence"]').click(); await page.locator('[data-cw-sequence]').waitFor();
    await page.locator('[data-cw-step="review"]').click(); await card(page, f).waitFor();
    assert.match(await card(page, f).innerText(), /message is too short|body too short/i);
    db.prepare("UPDATE personalizations SET fact_check_status='failed' WHERE id=?").run(result.body.personalizationId);
    await page.reload({ waitUntil: 'domcontentloaded' }); await card(page, f).waitFor();
    assert.match(await card(page, f).innerText(), /Fact check: failed/);
    assert.match(await card(page, f).innerText(), /message is too short|body too short/i);
    await page.screenshot({ path: path.join(evidenceDirectory, `${runName}-guardrail.png`), fullPage: true });
    proof('persisted-guardrail-guidance', { failures: result.body.guardrailFailures, reloadedFactCheck: 'failed' });
  });
});

test('refresh during a pending save preserves newer typing even when it reverts to the old saved text', async () => {
  const f = fixture(); await firstCopy(f);
  await withPage(f, async page => {
    let release, started; const held = new Promise(resolve => { release = resolve; }); const reached = new Promise(resolve => { started = resolve; });
    await page.route(`${base}${f.route}`, async route => { started(); await held; await route.continue(); });
    try {
      await card(page, f).locator('[data-cw-subject]').fill('Submitted while refresh remains available');
      const responsePromise = page.waitForResponse(value => new URL(value.url()).pathname === f.route);
      await card(page, f).locator('[data-cw-save-copy]').click(); await reached;
      await refresh(page, f);
      assert.equal(await card(page, f).locator('[data-cw-save-copy]').isDisabled(), true);
      await card(page, f).locator('[data-cw-subject]').fill('Initial saved version');
      release(); const response = await responsePromise; assert.equal(response.status(), 201); const result = await response.json();
      await card(page, f).getByText(`Version #${result.personalizationId} · not approved`, { exact: true }).waitFor();
      assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), 'Initial saved version');
      await page.unroute(`${base}${f.route}`);
      const next = await save(page, f); assert.equal(next.status, 201); assert.equal(next.request.expectedLatestPersonalizationId, result.personalizationId);
      proof('refresh-in-flight-reverted-text', { confirmedBaseline: result.personalizationId, nextBaseline: next.request.expectedLatestPersonalizationId });
    } finally { release(); await page.unroute(`${base}${f.route}`); }
  });
});

test('unfamiliar warning text is escaped and activity progress uses saved campaign state', async () => {
  const f = fixture(); await firstCopy(f);
  await withPage(f, async page => {
    const unknown = '<img src=x onerror="window.__editorWarningExecuted=true">';
    const audience = (await api(`/api/sending/campaigns/${f.campaignId}/audience?limit=200&offset=0`)).body;
    audience.items[0].guardrail_failures = [unknown];
    const audienceRoute = `${base}/api/sending/campaigns/${f.campaignId}/audience?*`;
    await page.route(audienceRoute, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(audience) }));
    await refresh(page, f);
    assert.match(await card(page, f).innerText(), /Review the saved guardrail warning:/);
    assert.ok((await card(page, f).innerText()).includes(unknown));
    assert.equal(await card(page, f).locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__editorWarningExecuted), undefined);
    assert.equal(await page.locator('[data-cw-step="activity"]').evaluate(node => node.classList.contains('is-done')), false);
    await page.unroute(audienceRoute);
    db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(f.campaignId);
    await refresh(page, f);
    assert.equal(await page.locator('[data-cw-next]').textContent(), 'Open activity ');
    await page.locator('[data-cw-next]').click(); await page.locator('[data-cw-timeline]').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('step'), 'activity');
    proof('escaped-warning-and-activity', { warningRenderedAsText: true, activityMarkedComplete: false, launchedNextStep: 'activity' });
  });
});

test('a same-campaign refresh cancels a pending fingerprint without leaving Save disabled', async () => {
  const f = fixture(); const first = await firstCopy(f);
  await withPage(f, async page => {
    await card(page, f).locator('[data-cw-subject]').fill('Pending text before fingerprint refresh');
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = async (...args) => {
        crypto.subtle.digest = digest; window.__editorHashStarted = true;
        await new Promise(resolve => { window.__releaseEditorHash = resolve; }); return digest(...args);
      };
    });
    const posts = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === f.route) posts.push(request.url()); });
    await card(page, f).locator('[data-cw-save-copy]').click(); await page.waitForFunction(() => window.__editorHashStarted === true);
    await refresh(page, f); await page.evaluate(() => window.__releaseEditorHash());
    await page.waitForFunction(leadId => !document.querySelector(`[data-cw-contact="${leadId}"] [data-cw-save-copy]`).disabled, f.leadId);
    assert.deepEqual(posts, []);
    assert.equal(await card(page, f).locator('[data-cw-subject]').inputValue(), 'Pending text before fingerprint refresh');
    const result = await save(page, f); assert.equal(result.status, 201); assert.equal(result.request.expectedLatestPersonalizationId, first.personalizationId);
    proof('fingerprint-refresh-cancel-and-retry', { cancelledPosts: 0, explicitRetryStatus: result.status });
  });
});

after(async () => {
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
  outcomes.aiUsage = db.prepare('SELECT COUNT(*) n FROM ai_usage_events').get().n;
  outcomes.sends = db.prepare('SELECT COUNT(*) n FROM sends').get().n;
  outcomes.sourceHashes = Object.fromEntries(['js/campaign-workspace.js', 'tests/guided-campaign-editor.test.mjs', 'pipeline/campaign-audience.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  database.closeDb();
  fs.writeFileSync(path.join(evidenceDirectory, `${runName}.json`), JSON.stringify(outcomes, null, 2));
  console.log('EDITOR_NETWORK ' + JSON.stringify(outcomes));
  assert.equal(outcomes.aiUsage, 0); assert.equal(outcomes.sends, 0); assert.deepEqual(outcomes.pageErrors, []);
});
