import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCampaignLoadCurrent } from '../js/astra-campaign-draft.js';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';

test('late campaign A composer response cannot replace the completed campaign B selection', () => {
  const requestA = { tenantId: 'tenant-a', epoch: 11, campaignId: 'campaign-a' };
  const requestB = { tenantId: 'tenant-a', epoch: 12, campaignId: 'campaign-b' };
  let visibleCampaign = 'campaign-b';
  if (isCampaignLoadCurrent(requestA, requestB, visibleCampaign, requestA.campaignId)) visibleCampaign = requestA.campaignId;
  assert.equal(isCampaignLoadCurrent(requestB, requestB, visibleCampaign, requestB.campaignId), true);
  assert.equal(visibleCampaign, 'campaign-b', 'a delayed earlier composer response is discarded after B owns the selection');
});

// Keep the ordinary Node test process isolated from inherited app credentials.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateManifestPath = path.join(root, 'docs', 'product', 'astra-combined-main-20261028', 'review', 'CANDIDATE_FINAL.json');
assert.ok(fs.existsSync(candidateManifestPath), 'the combined candidate manifest is frozen before running the workbench browser journey');
const candidateManifest = JSON.parse(fs.readFileSync(candidateManifestPath, 'utf8'));
const candidateProductHashes = new Map(candidateManifest.files.map(item => [item.path, item.sha256]));
const sha256File = relativePath => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
assert.equal(candidateManifest.plan, 'astra-combined-main-20261028', 'workbench test is bound to the frozen combined candidate, not the historical R15 runtime');
for (const relativePath of ['astra.html', 'js/astra-workbench.js']) {
  assert.equal(sha256File(relativePath), candidateProductHashes.get(relativePath), `${relativePath} matches the frozen combined candidate manifest before the test`);
}
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH;
const edgeOverride = process.env.ODD_CHROMIUM_EXECUTABLE_PATH;
const keep = new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','PROGRAMFILES','PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH']);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];

const resolvedFixturePath = fixturePath ? path.resolve(fixturePath) : null;
let fixture;
if (fixturePath) {
  fixture = await validateAstraPlatformFixture({ root, fixturePath: resolvedFixturePath, allowR20: true,
    labels: ['p2-astra-ui-r7', 'p2-suite-r7', 'r18-suite', 'r18-customer-qa', 'r18-foundation'], migrations: 'legacy31-or-r18' });
}

test('Astra workbench completes the synthetic offline journey in Edge', async t => {
  if (!fixture) return t.skip('Set ASTRA_QA_FIXTURE_PATH to the dedicated p2-astra-ui-r7 fixture to run this integration test.');
  const defaultEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edgePath = edgeOverride || defaultEdge;
  assert.ok(fs.existsSync(edgePath), 'Microsoft Edge is required when a disposable Astra QA fixture is configured.');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-ui-r7-'));
  process.env.NODE_ENV = 'test';
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = crypto.randomBytes(32).toString('hex');
  process.env.ODD_AUTH_RECOVERY_TOKEN = crypto.randomBytes(32).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION = 'true';
  process.env.LOCAL_PREVIEW = '1';
  process.env.ASTRA_TENANT_MODE = '1';
  process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_QA_FIXTURE_PATH = resolvedFixturePath;
  process.env.QA_EGRESS_GUARD = 'required';

  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });
  const browserTrace = [];
  globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')] = browserTrace;
  await import('./support/astra-qa-egress-guard.mjs');
  const { server } = await import('../server.js');
  const { closeDb, initDb } = await import('../pipeline/database.js');
  const { createAuthManager } = await import('../pipeline/auth-manager.js');
  const authDb = initDb();
  createAuthManager(authDb);
  const isolatedAuthSequence = 1_000_000_000 + crypto.randomBytes(4).readUInt32BE(0);
  authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
  authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(isolatedAuthSequence);

  let browser;
  let portServer;
  const pageErrors = [];
  const dialogs = [];
  const routeResults = [];
  try {
    if (!server.listening) await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    portServer = server;
    const base = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `astra-ui-${crypto.randomUUID()}@example.test`, password: `Synthetic-${crypto.randomBytes(12).toString('hex')}!`, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
    });
    assert.equal(bootstrap.status, 201, 'synthetic authenticated owner bootstrap succeeds');
    const setCookie = bootstrap.headers.get('set-cookie') || '';
    const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(session && csrf, 'bootstrap issued the private browser session');
    const preMembershipGate = await fetch(`${base}/astra.html`, { headers: { cookie: `odd_session=${session}; odd_csrf=${csrf}` } });
    assert.equal(preMembershipGate.status, 403, 'advanced workbench is denied before the user has a workspace membership');

    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([
      { name: 'odd_session', value: session, url: base },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base },
    ]);
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.name || 'PageError'));
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    const automationStatusRequests = [];
    const automationStatusResponses = new Map();
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && /\/api\/astra\/tenants\/[^/]+\/automation\/status$/.test(url.pathname)) {
        automationStatusRequests.push(request);
      }
    });
    page.on('response', response => {
      const request = response.request();
      const url = new URL(response.url());
      if (request.method() === 'GET' && /\/api\/astra\/tenants\/[^/]+\/automation\/status$/.test(url.pathname)) {
        const requestSequence = automationStatusRequests.indexOf(request);
        automationStatusResponses.set(request, response.json().then(payload => ({ requestSequence, status: response.status(),
          states: payload.data?.states || [], recent: (payload.data?.recent || []).map(row => ({ id: row.id, state: row.state })) }))
          .catch(() => ({ requestSequence, status: response.status(), body: 'unavailable' })));
      }
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === base && url.pathname.startsWith('/api/')) routeResults.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    });
    await page.goto(`${base}/growth.html`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#create-workspace-form').waitFor({ state: 'visible' });
    const blockedRequest = await page.evaluate(async () => {
      try { await fetch('https://fonts.googleapis.com/css2?family=Inter'); return false; }
      catch { return true; }
    });
    assert.equal(blockedRequest, true, 'external Google Fonts request is denied by the browser guard before transport');
    assert.ok(browserTrace.some(entry => entry.type === 'blocked' && entry.host === 'fonts.googleapis.com'), 'guard records the blocked font host');
    assert.ok(browserTrace.some(entry => entry.type === 'domcontentloaded' && new URL(entry.url).hostname === '127.0.0.1'), 'local app document reaches DOMContentLoaded');
    await page.locator('#create-workspace-form [name="name"]').fill('Synthetic Astra UI journey');
    const tenantResponsePromise = page.waitForResponse(response => response.url().includes('/api/astra/tenants') && response.request().method() === 'POST');
    await page.locator('#create-workspace-form button[type="submit"]').click();
    const tenantResponse = await tenantResponsePromise;
    assert.equal(tenantResponse.status(), 201, 'workbench creates a tenant through the authenticated API');
    const tenantBody = await tenantResponse.json();
    const tenantId = tenantBody.tenant?.id;
    assert.match(tenantId || '', /^[0-9a-f-]{36}$/i, 'tenant creation response contains a UUID');
    await page.goto(`${base}/astra.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('#tenant-id').fill(tenantId);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await page.locator('#snapshot-form').waitFor({ state: 'visible' });
    const api = `/api/astra/tenants/${tenantId}`;

    const sourceHtml = '<html><head><title>Synthetic QA company</title></head><body><h1>Synthetic QA company</h1><p>This synthetic QA account is in manufacturing in IN. Synthetic site audit price is INR 200. Contact qa-flow@synthetic-mfg.example.test.</p></body></html>';
    await page.locator('#snapshot-form [name="sourceUrl"]').fill('https://synthetic-mfg.example.test/about');
    await page.locator('#snapshot-form [name="html"]').fill(sourceHtml);
    await page.locator('#snapshot-form [name="rightsAttested"]').check();
    await page.locator('#snapshot-form [name="robotsAllowed"]').check();
    const snapshotResponsePromise = page.waitForResponse(response => response.url().includes(`${api}/research/snapshots`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Capture immutable snapshot' }).click();
    const snapshotResponse = await snapshotResponsePromise;
    assert.equal(snapshotResponse.status(), 201, 'supplied source snapshot is persisted from the workbench');
    const snapshot = await snapshotResponse.json();
    const evidenceId = snapshot.data?.evidence?.id;
    const accountId = snapshot.data?.account?.id;
    assert.ok(evidenceId && accountId, 'snapshot yields persisted evidence and research account');
    const evidenceReadResponsePromise = page.waitForResponse(response => response.url().includes(`${api}/research/evidence/${evidenceId}`) && response.request().method() === 'GET');
    await page.locator('#evidence-list [data-action="inspect-evidence"]').first().click();
    await page.locator('#research-selected').getByText(/Research account ID/).waitFor();
    const evidenceReadResponse = await evidenceReadResponsePromise;
    assert.equal(evidenceReadResponse.status(), 200, 'workbench inspects the saved evidence through the API');

    // Queue explicit research and request one manual worker pass only when the live status says it is available.
    const researchQueue = page.locator('#research-queue-form button[type="submit"]');
    assert.equal(await researchQueue.isDisabled(), false, 'current worker status enables bounded offline research');
    await page.locator('#evidence-list input[name="selectedEvidence"]').first().check();
    const queuePromise = page.waitForResponse(response => response.url().includes(`${api}/automation/research`) && response.request().method() === 'POST');
    await researchQueue.click();
    const queueResponse = await queuePromise;
    assert.equal(queueResponse.status(), 201, 'manual research queue request is accepted');
    const queuedResearch = await queueResponse.json();
    const researchWorkflowId = queuedResearch.data?.id;
    assert.ok(researchWorkflowId, 'research queue response returns its durable workflow ID');
    await page.locator('#automation-form [name="confirm"]').check();
    assert.equal(await page.locator('#automation-form button[type="submit"]').isDisabled(), false, 'dedicated worker is configured for explicit run-once');
    const runPromise = page.waitForResponse(response => response.url().includes(`${api}/automation/run-once`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Request run once' }).click();
    const runResponse = await runPromise;
    assert.equal(runResponse.status(), 202, 'explicit one-shot research run is accepted');
    const completionDeadline = Date.now() + 20000;
    let completedWorkflowStatus = null;
    while (!completedWorkflowStatus && Date.now() < completionDeadline) {
      const statusSnapshot = await page.evaluate(async statusUrl => {
        const response = await fetch(statusUrl, { credentials: 'same-origin' });
        return { ok: response.ok, status: response.status, payload: response.ok ? await response.json() : null };
      }, `${api}/automation/status`);
      assert.equal(statusSnapshot.ok, true, `the completion poll receives HTTP 200, got ${statusSnapshot.status}`);
      completedWorkflowStatus = statusSnapshot.payload.data?.recent?.find(row => row.id === researchWorkflowId && row.state === 'completed') || null;
      if (!completedWorkflowStatus) await page.waitForTimeout(200);
    }
    assert.ok(completedWorkflowStatus, `the exact tenant workflow reaches completed before refresh; statusTrace=${JSON.stringify(await Promise.all(automationStatusResponses.values()))}`);
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    const statusRequestsBeforeRefresh = automationStatusRequests.length;
    const automationRefreshRequestPromise = page.waitForRequest(request => request.url() === `${base}${api}/automation/status`
      && request.method() === 'GET');
    await page.locator('[data-refresh="automation"]').click();
    const automationRefreshRequest = await automationRefreshRequestPromise;
    assert.ok(automationStatusRequests.indexOf(automationRefreshRequest) >= statusRequestsBeforeRefresh,
      'refresh response is paired with the exact tenant-scoped status request initiated after the Refresh click');
    const automationRefreshResponse = await automationRefreshRequest.response();
    assert.ok(automationRefreshResponse, 'the exact Refresh status request receives a response');
    assert.equal(automationRefreshResponse.status(), 200, 'workbench refreshes the dedicated worker status');
    const automationRefreshBody = await automationRefreshResponse.json();
    const automationStatusTrace = await Promise.all(automationStatusResponses.values());
    const completedStatusObservation = automationStatusTrace.find(row => row.requestSequence < statusRequestsBeforeRefresh
      && row.recent?.some(item => item.id === researchWorkflowId && item.state === 'completed'));
    assert.ok(completedStatusObservation,
      `the awaited status poll observes this workflow completed before the explicit refresh; targetId=${researchWorkflowId}, statusTrace=${JSON.stringify(automationStatusTrace)}`);
    assert.ok(automationRefreshBody.data?.recent?.some(row => row.id === researchWorkflowId && row.state === 'completed'),
      `workbench refresh response confirms the explicitly run research task completed; requestSequence=${automationStatusRequests.indexOf(automationRefreshRequest)}, targetId=${researchWorkflowId}, statusTrace=${JSON.stringify(automationStatusTrace)}`);
    const renderedAutomationStatus = await page.locator('#automation-status').evaluate(element => {
      try {
        const status = JSON.parse(element.textContent || '{}');
        return { workerConfigured: status.workerConfigured, automaticStart: status.automaticStart };
      } catch { return {}; }
    });
    assert.ok(renderedAutomationStatus.workerConfigured === true && renderedAutomationStatus.automaticStart === false,
      'workbench reports a configured manual-only worker');

    await page.locator('#claim-form [name="subjectKey"]').fill('synthetic-mfg.example.test');
    await page.locator('#claim-form [name="predicate"]').fill('industry');
    await page.locator('#claim-form [name="value"]').fill('manufacturing');
    await page.locator('#claim-form [name="exactExcerpt"]').fill('This synthetic QA account is in manufacturing in IN.');
    const claimPromise = page.waitForResponse(response => response.url().includes(`${api}/research/claims`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Submit evidenced claim' }).click();
    const claimResponse = await claimPromise;
    assert.equal(claimResponse.status(), 201, 'evidence-backed claim is saved from the workbench');
    const claimBody = await claimResponse.json();
    const claimId = claimBody.data?.id;
    assert.equal(claimBody.data?.status, 'supported', 'claim status comes from current exact source evidence');
    await page.locator('#claim-form [name="subjectKey"]').fill('synthetic-mfg.example.test');
    await page.locator('#claim-form [name="predicate"]').fill('country');
    await page.locator('#claim-form [name="value"]').fill('IN');
    await page.locator('#claim-form [name="exactExcerpt"]').fill('This synthetic QA account is in manufacturing in IN.');
    const countryClaimPromise = page.waitForResponse(response => response.url().includes(`${api}/research/claims`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Submit evidenced claim' }).click();
    const countryClaimResponse = await countryClaimPromise;
    assert.equal(countryClaimResponse.status(), 201, 'a country claim supports the fact in the campaign subject');
    const countryClaim = await countryClaimResponse.json();
    const countryClaimId = countryClaim.data?.id;
    assert.equal(countryClaim.data?.status, 'supported', 'country claim is source backed');

    // Create an offer, attach real synthetic bytes through the upload form, and approve it as this tenant owner.
    const proofBytes = Buffer.from('Synthetic Astra UI proof bytes for this disposable test.');
    const proofHash = crypto.createHash('sha256').update(proofBytes).digest('hex');
    const offerContent = { service: 'Synthetic site audit', scope: 'One synthetic diagnostic review.', price: { minMinor: 10000, maxMinor: 50000, currency: 'INR' }, proofAssets: [{ proofId: 'qa-proof', reference: 'fixture://uploaded-proof', contentHash: proofHash, observedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: '2035-01-01T00:00:00.000Z', rightsBasis: 'Synthetic QA fixture only' }], audienceExclusions: ['existing customer'], geography: { includedCountries: ['IN'], excludedCountries: [] }, capacity: 1, egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] } };
    await page.locator('#offer-form [name="name"]').fill('Synthetic QA offer');
    await page.locator('#offer-form [name="content"]').fill(JSON.stringify(offerContent));
    const offerPromise = page.waitForResponse(response => response.url().includes(`${api}/offers`) && response.request().method() === 'POST' && !response.url().includes('/proofs'));
    await page.getByRole('button', { name: 'Create offer and version 1' }).click();
    const offerResponse = await offerPromise;
    assert.equal(offerResponse.status(), 201, 'owner creates a versioned offer from the workbench');
    const offerBody = await offerResponse.json();
    const offerId = offerBody.offer?.id;
    const versionId = offerBody.offer?.version?.id;
    assert.ok(offerId && versionId, 'offer creation returns owned UUID resources');
    await page.locator('#proof-form [name="offerId"]').fill(String(offerId));
    await page.locator('#proof-form [name="versionId"]').fill(String(versionId));
    await page.locator('#proof-form [name="proofId"]').fill('qa-proof');
    const expiryValue = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const expiryInput = page.locator('#proof-form [name="expiresAt"]');
    await expiryInput.fill('2000-01-01T00:00');
    assert.equal(await page.locator('#proof-form [name="expiresAt"]').getAttribute('type'), 'datetime-local', 'proof expiry is an explicit local date-time input');
    await page.locator('#proof-form [name="proofFile"]').setInputFiles({ name: 'synthetic-proof.txt', mimeType: 'text/plain', buffer: proofBytes });
    await page.getByRole('button', { name: 'Upload and attach proof' }).click();
    await page.waitForFunction(() => /valid future proof expiry/i.test(document.querySelector('#notice')?.textContent || ''), undefined, { timeout: 5000, polling: 100 });
    await expiryInput.fill(expiryValue);
    const proofPromise = page.waitForResponse(response => response.url().includes(`${api}/offers/${offerId}/versions/${versionId}/proofs`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Upload and attach proof' }).click();
    const proofResponse = await proofPromise;
    assert.equal(proofResponse.status(), 201, 'proof upload is accepted through the actual workbench form');
    const proofBody = await proofResponse.json();
    assert.equal(proofBody.proof?.contentHash, proofHash, 'server hash matches the actual uploaded bytes');
    const submittedProofRequest = proofResponse.request().postDataJSON();
    assert.ok(Number.isFinite(Date.parse(submittedProofRequest.expiresAt)) && Date.parse(submittedProofRequest.expiresAt) > Date.now(),
      'workbench serializes the user-selected future expiry to ISO for the API request');
    const offerListResponsePromise = page.waitForResponse(response => response.url().endsWith(`${api}/offers`) && response.request().method() === 'GET');
    await page.locator('[data-refresh="offers"]').click();
    const offerListResponse = await offerListResponsePromise;
    assert.equal(offerListResponse.status(), 200, 'workbench refreshes the updated offers list after upload');
    const approveOfferButton = page.locator('#offers-list [data-action="approve-offer"]').first();
    await approveOfferButton.waitFor({ state: 'visible' });
    const approvalPath = `${api}/offers/${offerId}/versions/${versionId}/approve`;
    const offerApprovalPromise = page.waitForResponse(response => response.url().endsWith(approvalPath) && response.request().method() === 'POST');
    await approveOfferButton.click();
    assert.equal((await offerApprovalPromise).status(), 200, 'workbench approval action is persisted through the tenant API');
    await page.getByText(/Offer version approved/).waitFor();
    const offerRead = await page.request.get(`${base}${api}/offers/${offerId}`);
    assert.equal(offerRead.status(), 200, 'approved offer state can be read back');
    const approvedOffer = await offerRead.json();
    assert.equal(approvedOffer.offer?.versions?.[0]?.status, 'approved');

    // Ingest a supplied opt-out, allow deterministic review, and prepare a CRM proposal in held state.
    await page.locator('#mailbox-form [name="displayName"]').fill('Synthetic manual mailbox');
    const mailboxPromise = page.waitForResponse(response => response.url().includes(`${api}/mailboxes`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create manual mailbox' }).click();
    const mailboxResponse = await mailboxPromise;
    assert.equal(mailboxResponse.status(), 201, 'manual mailbox is created without provider connection');
    const mailboxBody = await mailboxResponse.json();
    const mailboxId = mailboxBody.mailbox?.id;
    await page.locator('#message-form [name="mailboxId"]').fill(String(mailboxId));
    await page.locator('#message-form [name="externalThreadId"]').fill('synthetic-optout-thread');
    await page.locator('#message-form [name="externalMessageId"]').fill('synthetic-optout-message');
    await page.locator('#message-form [name="sender"]').fill('qa-optout@synthetic-mfg.example.test');
    await page.locator('#message-form [name="recipients"]').fill('qa-flow@synthetic-mfg.example.test');
    await page.locator('#message-form [name="subject"]').fill('Synthetic opt out');
    await page.locator('#message-form [name="bodyText"]').fill('Please do not contact me again.');
    const inboxPromise = page.waitForResponse(response => response.url().includes(`${api}/inbox/messages`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Ingest supplied message' }).click();
    assert.equal((await inboxPromise).status(), 201, 'supplied message is manually ingested');
    const taskButton = page.locator('#messages-list [data-action="create-reply-task"]');
    const replyTaskPromise = page.waitForResponse(response => response.url().includes(`${api}/reply-tasks`) && response.request().method() === 'POST');
    await taskButton.first().click();
    const replyTaskResponse = await replyTaskPromise;
    assert.equal(replyTaskResponse.status(), 201, 'manual reply task is created from the ingested message');
    await page.locator('#reply-tasks-list').getByText(/opt_out/i).waitFor();
    assert.match(await page.locator('#reply-tasks-list').innerText(), /opt.out/i, 'deterministic reply task recognizes opt-out');
    const approveReply = page.locator('#reply-tasks-list [data-action="review-reply"][data-decision="approved"]');
    const replyReviewPromise = page.waitForResponse(response => response.url().includes('/reply-tasks/') && response.url().endsWith('/review') && response.request().method() === 'POST');
    await approveReply.click();
    assert.equal((await replyReviewPromise).status(), 200, 'human review accepts the opt-out and does not send a reply');
    const permissionRefresh = page.waitForResponse(response => response.url().includes(`${api}/suppressions`) && response.request().method() === 'GET');
    await page.locator('[data-refresh="permissions"]').click();
    assert.equal((await permissionRefresh).status(), 200, 'suppression state is refreshed through the workbench');
    assert.match(await page.locator('#suppressions-list').innerText(), /qa-optout@synthetic-mfg\.example\.test/i, 'reviewed opt-out appears in tenant suppressions');
    await page.locator('#outbox-form [name="entityId"]').fill(String(accountId));
    await page.locator('#outbox-form [name="idempotencyKey"]').fill('astra-ui-r7-held-proposal');
    await page.locator('#outbox-form [name="payload"]').fill(JSON.stringify({ name: 'Synthetic QA company', domainName: 'synthetic-mfg.example.test' }));
    await page.locator('#outbox-form [name="fieldAuthority"]').fill(JSON.stringify({ name: 'source', domainName: 'source' }));
    await page.locator('#outbox-form [name="provenance"]').fill(JSON.stringify({ source: 'synthetic_fixture' }));
    const crmPromise = page.waitForResponse(response => response.url().includes(`${api}/crm/outbox`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Queue company proposal' }).click();
    const crmResponse = await crmPromise;
    assert.equal(crmResponse.status(), 201, 'CRM proposal is prepared through the workbench');
    const crmBody = await crmResponse.json();
    assert.equal(crmBody.proposal?.state, 'held', 'CRM proposal remains held');
    assert.equal(crmBody.transportEnabled, false, 'CRM transport remains disabled');

    // Campaign setup, qualification, hand-authored claim-bound copy, approval, offline plan and quarantine.
    await page.locator('#campaign-form [name="name"]').fill('Synthetic offline campaign');
    await page.locator('#campaign-form [name="offerVersionId"]').fill(String(versionId));
    await page.locator('#campaign-form [name="mailboxId"]').fill(String(mailboxId));
    await page.locator('#campaign-form [name="purpose"]').fill('synthetic_flow');
    await page.locator('#campaign-form [name="geography"]').fill('IN');
    await page.locator('#campaign-form [name="spendLimitMinor"]').fill('0');
    await page.locator('#campaign-form [name="currency"]').fill('INR');
    const campaignPromise = page.waitForResponse(response => response.url().includes(`${api}/campaigns`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create gated campaign record' }).click();
    const campaignResponse = await campaignPromise;
    assert.equal(campaignResponse.status(), 201, 'gated campaign record is created');
    const campaignBody = await campaignResponse.json();
    const campaignId = campaignBody.campaign?.id;
    assert.ok(campaignId, 'campaign ID returned from server');
    await page.locator('#qualification-form [name="accountIds"]').fill(String(accountId));
    const composerPromise = page.waitForResponse(async response => {
      if (!response.url().endsWith(`${api}/campaigns/${campaignId}/composer`) || response.request().method() !== 'GET' || response.status() !== 200) return false;
      const payload = await response.json();
      return payload.composer?.templates?.some(template => template.placement === 'body' && template.claimId === claimId) === true;
    });
    const qualificationPromise = page.waitForResponse(response => response.url().includes(`${api}/campaigns/${campaignId}/qualification`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Qualify accounts against current evidence' }).click();
    const qualificationResponse = await qualificationPromise;
    assert.equal(qualificationResponse.status(), 200, 'qualification is evaluated from the current evidence chain');
    const qualification = await qualificationResponse.json();
    assert.equal(qualification.qualification?.results?.length, 1, 'one supplied account was evaluated');

    const composerResponse = await composerPromise;
    const composer = (await composerResponse.json()).composer;
    const sourceTemplate = composer.templates.find(template => template.placement === 'body' && template.claimId === claimId);
    assert.ok(sourceTemplate?.source?.url && sourceTemplate.source.exactExcerpt, 'composer supplies a current literal source-attributed copy template');
    assert.ok(Number.isSafeInteger(composer.version) && composer.version >= 1, 'composer exposes the campaign version used for copy CAS');
    await page.locator('#draft-form [name="subject"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#draft-form [name="subject"]').inputValue(), 'Research note', 'workbench chooses the server-supported fixed subject template');
    const draftBody = page.locator('#draft-form [name="body"]');
    await draftBody.fill('Unsupported operator edit.');
    await page.locator('#draft-validation').getByText(/Unverified/i).waitFor();
    assert.equal(await page.locator('#draft-form [type="submit"]').isDisabled(), true, 'unsupported copy remains unverified and cannot be saved');
    const bodyTemplates = composer.templates.filter(template => template.placement === 'body');
    const selectedTemplateIndex = bodyTemplates.findIndex(template => template.templateId === sourceTemplate.templateId);
    assert.ok(selectedTemplateIndex >= 0, 'the exact composer template is present in the rendered selector');
    await draftBody.fill('');
    await page.locator('#draft-template-list button[data-action="insert-copy-template"]').nth(selectedTemplateIndex).click();
    assert.equal(await draftBody.inputValue(), sourceTemplate.renderedText, 'operator inserts the exact server-provided source sentence');
    const draftSaveButton = page.locator('#draft-form [type="submit"]');
    await draftSaveButton.waitFor({ state: 'visible' });
    assert.equal(await draftSaveButton.isDisabled(), false, 'current exact template-backed draft can be saved');
    const draftPromise = page.waitForResponse(response => response.url().includes(`${api}/campaigns/${campaignId}/draft`) && response.request().method() === 'PUT');
    await draftSaveButton.click();
    const draftResponse = await draftPromise;
    const draftResult = await draftResponse.json();
    assert.equal(draftResponse.status(), 200, `composer-backed copy is validated against its exact source claim (safe error code ${draftResult.code || 'none'})`);
    const submittedDraft = draftResponse.request().postDataJSON();
    assert.equal(submittedDraft.expectedVersion, composer.version, 'workbench saves with the exact version loaded from the composer');
    assert.deepEqual(submittedDraft.claimsMap, [{ sentence: sourceTemplate.renderedText, claimIds: [sourceTemplate.claimId], templateId: sourceTemplate.templateId }], 'workbench submits only exact current server-template mappings');
    const draft = draftResult;
    assert.ok(draft.draft?.copyHash, 'versioned draft receives a server copy hash');
    await page.locator('#approval-form [name="expiresAt"]').fill(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16));
    const approvalPromise = page.waitForResponse(response => response.url().includes(`${api}/campaigns/${campaignId}/approvals`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Approve immutable campaign version' }).click();
    const approvalResponse = await approvalPromise;
    assert.equal(approvalResponse.status(), 201, 'tenant owner approves the immutable campaign version');
    assert.equal(approvalResponse.request().postDataJSON().expectedVersion, draft.draft.version, 'approval uses the newly saved current campaign version');
    await page.locator('#plan-form [name="idempotencyKey"]').fill('astra-ui-r7-offline-plan');
    const planPromise = page.waitForResponse(response => response.url().includes(`${api}/campaigns/${campaignId}/dispatch-plans`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Prepare offline-only plan' }).click();
    const planResponse = await planPromise;
    assert.equal(planResponse.status(), 201, 'offline dispatch plan is persisted');
    const planBody = await planResponse.json();
    assert.equal(planBody.plan?.liveTransport, 'disabled', 'offline plan explicitly reports disabled transport');
    const planId = planBody.plan?.id;
    await page.locator('#plan-claim-form [name="planId"]').fill(String(planId));
    await page.locator('#plan-claim-form [name="idempotencyKey"]').fill('astra-ui-r7-quarantine');
    const quarantinePromise = page.waitForResponse(response => response.url().includes(`${api}/campaigns/${campaignId}/dispatch-plans/${planId}/claim`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Claim & quarantine plan' }).click();
    const quarantineResponse = await quarantinePromise;
    assert.equal(quarantineResponse.status(), 201, 'claim is durably quarantined instead of dispatched');
    const quarantine = await quarantineResponse.json();
    assert.equal(quarantine.claim?.state, 'quarantined', 'claim remains quarantined');

    // Human outcome, refund and correction; the UI exposes the corrected projection in analytics.
    await page.locator('#outcome-form [name="stage"]').selectOption('meeting_held');
    await page.locator('#outcome-form [name="entityType"]').selectOption('account');
    await page.locator('#outcome-form [name="entityId"]').fill(String(accountId));
    await page.locator('#outcome-form [name="source"]').fill('synthetic_fixture');
    await page.locator('#outcome-form [name="confidence"]').selectOption('medium');
    await page.locator('#outcome-form [name="fieldAuthority"]').selectOption('human');
    const outcomePromise = page.waitForResponse(response => response.url().endsWith(`${api}/outcomes`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Record outcome' }).click();
    const outcomeResponse = await outcomePromise;
    assert.equal(outcomeResponse.status(), 201, 'human outcome is recorded from the workbench');
    const outcomeBody = await outcomeResponse.json();
    const outcomeId = outcomeBody.data?.id;
    for (const stage of ['revenue_paid', 'revenue_refunded']) {
      await page.locator('#outcome-form [name="stage"]').selectOption(stage);
      await page.locator('#outcome-form [name="amountMinor"]').fill(stage === 'revenue_paid' ? '12000' : '2000');
      await page.locator('#outcome-form [name="currency"]').fill('INR');
      await page.locator('#outcome-form [name="invoiceRef"]').fill('synthetic-invoice-r7');
      const revenuePromise = page.waitForResponse(response => response.url().endsWith(`${api}/outcomes`) && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Record outcome' }).click();
      assert.equal((await revenuePromise).status(), 201, `${stage} is recorded through the workbench`);
    }
    // The current workbench has no correction form, so exercise the authenticated correction API in the same browser session.
    const correctionResponse = await page.evaluate(async ({ correctionUrl, correctedEventId, accountId }) => {
      const csrf = decodeURIComponent(document.cookie.split('; ').find(value => value.startsWith('odd_csrf='))?.slice('odd_csrf='.length) || '');
      const response = await fetch(correctionUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ action: 'correct', correctsEventId: correctedEventId, occurredAt: new Date().toISOString(), idempotencyKey: 'astra-ui-r7-correction', replacement: { stage: 'meeting_cancelled', entity: { type: 'account', id: accountId }, occurredAt: new Date().toISOString() }, provenance: { source: 'synthetic_fixture', confidence: 'high', fieldAuthority: 'human' } }) });
      const body = await response.json();
      return { status: response.status, latestStage: body.data?.projection?.latestStage };
    }, { correctionUrl: `${api}/outcomes/corrections`, correctedEventId: outcomeId, accountId });
    assert.equal(correctionResponse.status, 201, 'human correction is persisted against its original outcome');
    assert.equal(correctionResponse.latestStage, 'meeting_cancelled', 'corrected projection uses the replacement stage');
    const analyticsRefresh = page.waitForResponse(response => response.url().includes(`${api}/analytics/funnel`) && response.request().method() === 'GET');
    await page.locator('[data-refresh="insights"]').click();
    assert.equal((await analyticsRefresh).status(), 200, 'analytics is refreshed through the workbench');
    const analytics = JSON.parse(await page.locator('#analytics-result').innerText());

    assert.deepEqual(pageErrors, [], 'browser has no uncaught page errors');
    assert.deepEqual(dialogs, [], 'the journey does not open unexpected native dialogs');
    assert.ok(browserTrace.every(entry => entry.type === 'blocked' || entry.type === 'domcontentloaded'), 'browser trace contains only explicit external denials and local document events');
    assert.ok(routeResults.some(row => row.path.endsWith('/research/snapshots') && row.status === 201));
    assert.ok(routeResults.some(row => row.path.endsWith('/campaigns') && row.status === 201));
    assert.equal(analytics.basis, 'correction_aware_astra_outcome_projection', 'analytics identifies its correction-aware projection basis');
    assert.equal(analytics.eventEntityDenominator, 1, 'analytics counts the one synthetic outcome entity');
    assert.deepEqual(analytics.revenue, [{ currency: 'INR', paidMinor: '12000', refundedMinor: '2000', netMinor: '10000' }],
      'analytics renders persisted payment, refund and net revenue after correction');
    assert.match(await page.locator('#automation-status').innerText(), /"releaseReady": false/, 'product release readiness remains false');
    for (const relativePath of ['astra.html', 'js/astra-workbench.js']) {
      assert.equal(sha256File(relativePath), candidateProductHashes.get(relativePath), `${relativePath} remains unchanged during the focused combined-candidate browser run`);
    }
  } catch (error) {
    const safeRows = routeResults.slice(-20).map(row => `${row.method} ${row.path} ${row.status}`).join('; ');
    const noticeState = browser ? await browser.contexts()[0]?.pages()[0]?.locator('#notice').getAttribute('class').catch(() => '') : '';
    error.message = `${error.message}\nSafe DOM notice state: ${noticeState || 'unavailable'}\nRecent API routes: ${safeRows}`;
    throw error;
  } finally {
    await browser?.close();
    delete globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')];
    if (portServer?.listening) await new Promise(resolve => portServer.close(resolve));
    closeDb();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
