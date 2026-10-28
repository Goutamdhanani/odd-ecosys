import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateAstraPlatformFixture } from './support/astra-platform-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = process.env.ASTRA_QA_FIXTURE_PATH;
const edgeOverride = process.env.ODD_CHROMIUM_EXECUTABLE_PATH;
const keep = new Set(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','PROGRAMFILES','PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH']);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];

test('guided customer journey persists one synthetic account from evidence through observed analytics', async t => {
  if (!fixturePath) return t.skip('Set ASTRA_QA_FIXTURE_PATH to .runner/astra-qa/r20-source-rights/pg.json for strict33 integration.');
  const fixture = await validateAstraPlatformFixture({ root, fixturePath: path.resolve(fixturePath), allowR20: true });
  const edgePath = edgeOverride || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.ok(fs.existsSync(edgePath), 'Microsoft Edge is required for the strict33 guided journey.');

  let scratch;
  let screenshotDirectory;
  let browser;
  let server;
  let closeDb = () => {};
  try {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-guided-journey-'));
  screenshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-guided-journey-shots-'));
  process.env.NODE_ENV = 'test';
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = crypto.randomBytes(32).toString('hex');
  process.env.ODD_AUTH_RECOVERY_TOKEN = crypto.randomBytes(32).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION = 'true';
  process.env.LOCAL_PREVIEW = '1'; process.env.ASTRA_TENANT_MODE = '1';
  process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_QA_FIXTURE_PATH = path.resolve(fixturePath);
  process.env.QA_EGRESS_GUARD = 'required';

  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });
  const browserTrace = [];
  globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')] = browserTrace;
  await import('./support/astra-qa-egress-guard.mjs');
  ({ server } = await import('../server.js'));
  const { initDb, closeDb: closeDatabase } = await import('../pipeline/database.js');
  closeDb = closeDatabase;
  const { createAuthManager } = await import('../pipeline/auth-manager.js');
  const authDb = initDb(); createAuthManager(authDb);
  const authSequence = 1_000_000_000 + crypto.randomBytes(4).readUInt32BE(0);
  authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
  authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(authSequence);

  const pageErrors = [];
  const routeResults = [];
    const expectedInitialTenantReads = new Set(['/research/evidence', '/research/identities', '/research/claims', '/campaigns', '/offers', '/mailboxes', '/inbox/messages', '/outcomes', '/analytics/funnel', '/crm/mappings', '/crm/outbox']);
    const initialTenantReadResults = new Map();
    let resolveInitialTenantReads;
    const initialTenantReadsComplete = new Promise(resolve => { resolveInitialTenantReads = resolve; });
    if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = await fetch(`${base}/api/auth/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `journey-${crypto.randomUUID()}@example.test`, password: `Synthetic-${crypto.randomBytes(12).toString('hex')}!`, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }) });
    assert.equal(bootstrap.status, 201, 'fresh owner is bootstrapped with enforced authentication');
    const setCookie = bootstrap.headers.get('set-cookie') || '';
    const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(session && csrf, 'bootstrap issues private session and CSRF cookies');
    const preMembership = await fetch(`${base}/growth.html`, { headers: { cookie: `odd_session=${session}; odd_csrf=${csrf}` } });
    assert.equal(preMembership.status, 200, 'guided workspace picker is available to the authenticated owner before first workspace creation');

    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'odd_session', value: session, url: base }, { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const openForm = selector => page.locator(selector).locator('xpath=..').locator('summary').click();
    let holdFirstWorkspaceEvidenceRead = true;
    let releaseWorkspaceEvidenceRead;
    let workspaceEvidenceReadStarted;
    const workspaceEvidenceReadStartedPromise = new Promise(resolve => { workspaceEvidenceReadStarted = resolve; });
    const workspaceEvidenceRead = { startedAt: null, releasedAt: null, completedAt: null, path: null };
    const workspaceTransition = { contextResponses: 0, contextDurationMs: null, evidenceReadDelayMs: null, overviewVisibleWhileReadPending: false, initialTenantReads: 0 };
    const apiRequestStartedAt = new WeakMap();
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === base && url.pathname.startsWith('/api/')) apiRequestStartedAt.set(request, Date.now());
    });
    await page.route(url => {
      const parsed = new URL(url);
      return parsed.pathname.startsWith('/api/astra/tenants/') && parsed.pathname.endsWith('/research/evidence') && parsed.searchParams.get('limit') === '100';
    }, async route => {
      if (!holdFirstWorkspaceEvidenceRead) return route.continue();
      holdFirstWorkspaceEvidenceRead = false;
      workspaceEvidenceRead.startedAt = Date.now();
      workspaceEvidenceRead.path = new URL(route.request().url()).pathname.replace(/\/api\/astra\/tenants\/[^/]+/, '/api/astra/tenants/{workspace}');
      workspaceEvidenceReadStarted();
      await new Promise(resolve => { releaseWorkspaceEvidenceRead = resolve; });
      workspaceEvidenceRead.releasedAt = Date.now();
      const response = await route.fetch();
      workspaceEvidenceRead.completedAt = Date.now();
      await route.fulfill({ response });
    });
    page.on('pageerror', error => pageErrors.push(error.name || 'PageError'));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === base && url.pathname.startsWith('/api/')) {
        const method = response.request().method();
        const normalizedPath = url.pathname.replace(/\/api\/astra\/tenants\/[^/]+/, '/api/astra/tenants/{workspace}');
        const result = { method, path: normalizedPath, status: response.status(), durationMs: Date.now() - (apiRequestStartedAt.get(response.request()) || Date.now()) };
        routeResults.push(result);
        const tenantReadPath = normalizedPath.replace('/api/astra/tenants/{workspace}', '');
        if (method === 'GET' && expectedInitialTenantReads.has(tenantReadPath)) {
          initialTenantReadResults.set(tenantReadPath, result);
          if (initialTenantReadResults.size === expectedInitialTenantReads.size) resolveInitialTenantReads();
        }
      }
    });
    await page.goto(`${base}/growth.html`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#create-workspace-form [name="name"]').fill('Synthetic guided journey');
    const workspacePromise = page.waitForResponse(r => r.url().includes('/api/astra/tenants') && r.request().method() === 'POST');
    await page.locator('#create-workspace-form button[type="submit"]').click();
    const workspaceResponse = await workspacePromise;
    assert.equal(workspaceResponse.status(), 201, 'guided Settings flow creates the account workspace');
    const workspaceId = (await workspaceResponse.json()).tenant?.id;
    assert.match(workspaceId || '', /^[0-9a-f-]{36}$/i, 'workspace response has an ID');
    const api = `/api/astra/tenants/${workspaceId}`;
    await workspaceEvidenceReadStartedPromise;
    const workspaceTitle = await page.locator('#workspace-title').innerText();
    assert.equal(workspaceTitle, 'Good to see you, Synthetic guided journey.', 'the visible workspace identity is the one just verified by context');
    let overviewVisibleBeforeReadback = false;
    const visibilityStartedAt = Date.now();
    try {
      await page.locator('#view-overview:not([hidden])').waitFor({ timeout: 750 });
      overviewVisibleBeforeReadback = true;
    } catch { /* The gate is released below so the original journey remains diagnosable. */ }
    const visibilityElapsedMs = Date.now() - visibilityStartedAt;
    const readbackPendingAtVisibilityCheck = workspaceEvidenceRead.completedAt === null;
    const contextResponseBeforeReadback = routeResults.find(item => item.method === 'GET' && item.path.endsWith('/context') && item.status === 200);
    workspaceTransition.contextResponses = routeResults.filter(item => item.method === 'GET' && item.path.endsWith('/context')).length;
    workspaceTransition.contextDurationMs = contextResponseBeforeReadback?.durationMs ?? null;
    workspaceTransition.overviewVisibleWhileReadPending = overviewVisibleBeforeReadback && readbackPendingAtVisibilityCheck;
    releaseWorkspaceEvidenceRead?.();
    let readbackTimeout;
    try {
      await Promise.race([initialTenantReadsComplete, new Promise((_, reject) => { readbackTimeout = setTimeout(() => reject(new Error(`Initial workspace readbacks did not settle: ${JSON.stringify([...initialTenantReadResults.values()])}`)), 5000); })]);
    } finally { clearTimeout(readbackTimeout); }
    await page.locator('#view-overview:not([hidden])').waitFor();
    const initialTenantReads = [...initialTenantReadResults.values()];
    workspaceTransition.evidenceReadDelayMs = workspaceEvidenceRead.completedAt - workspaceEvidenceRead.startedAt;
    workspaceTransition.initialTenantReads = initialTenantReads.length;
    assert.equal(initialTenantReads.length, 11, `all eleven initial workspace readbacks complete after the delayed evidence response; ${JSON.stringify(initialTenantReads)}`);
    assert.ok(initialTenantReads.every(item => item.status === 200), `all initial workspace readbacks returned successfully; ${JSON.stringify(initialTenantReads)}`);
    assert.equal(overviewVisibleBeforeReadback && readbackPendingAtVisibilityCheck && Boolean(contextResponseBeforeReadback) && workspaceTransition.contextResponses === 1, true,
      `verified workspace overview should be visible while its evidence readback is pending; ${JSON.stringify({ workspaceTitle, visibilityElapsedMs, readbackPendingAtVisibilityCheck, contextResponseBeforeReadback, workspaceEvidenceRead, initialTenantReads })}`);
    await page.screenshot({ path: path.join(screenshotDirectory, 'overview.png'), fullPage: true });

    const sourceHtml = '<html><head><title>Synthetic QA company</title></head><body><h1>Synthetic QA company</h1><p>This synthetic QA account is in manufacturing in IN. Synthetic site audit price is INR 200. Contact qa-flow@synthetic-mfg.example.test.</p></body></html>';
    await page.getByRole('tab', { name: 'Discover' }).click();
    await page.locator('#snapshot-form [name="sourceUrl"]').fill('https://synthetic-mfg.example.test/about');
    await page.locator('#snapshot-form [name="htmlFile"]').setInputFiles({ name: 'synthetic-about.html', mimeType: 'text/html', buffer: Buffer.from(sourceHtml) });
    await page.locator('#snapshot-form [name="rightsPolicy"]').selectOption('user_provided');
    await page.locator('#snapshot-form [name="rightsAttested"]').check(); await page.locator('#snapshot-form [name="robotsAllowed"]').check();
    const snapshotPromise = page.waitForResponse(r => r.url().includes(`${api}/research/snapshots`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save page and create report' }).click();
    const snapshotResponse = await snapshotPromise;
    assert.equal(snapshotResponse.status(), 201, 'customer supplied HTML is saved through the guided form without live URL fetch');
    const snapshotResult = (await snapshotResponse.json()).data;
    const evidenceId = snapshotResult?.evidence?.id, accountId = snapshotResult?.account?.id;
    assert.ok(evidenceId && accountId, 'snapshot response links saved evidence and account');
    await page.locator('#snapshot-result').getByText(/report/i).first().waitFor();
    await page.screenshot({ path: path.join(screenshotDirectory, 'discover-evidence.png'), fullPage: true });

    const excerpt = 'This synthetic QA account is in manufacturing in IN.';
    await openForm('#claim-form');
    await page.locator('#claim-form [name="evidenceId"]').selectOption(String(evidenceId));
    await page.locator('#claim-form [name="predicate"]').selectOption('industry');
    await page.locator('#claim-form [name="value"]').fill('manufacturing');
    await page.locator('#claim-form [name="exactExcerpt"]').fill(excerpt);
    const claimPromise = page.waitForResponse(r => r.url().includes(`${api}/research/claims`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save supported fact' }).click();
    const claimResponse = await claimPromise;
    assert.equal(claimResponse.status(), 201, 'fact is submitted from the guided evidence form');
    const claim = (await claimResponse.json()).data;
    assert.equal(claim.status, 'supported', 'exact supplied excerpt is currently supported');
    await page.locator('#claim-form [name="evidenceId"]').selectOption(String(evidenceId));
    await page.locator('#claim-form [name="predicate"]').selectOption('country');
    await page.locator('#claim-form [name="value"]').fill('IN');
    await page.locator('#claim-form [name="exactExcerpt"]').fill(excerpt);
    const countryClaimPromise = page.waitForResponse(r => r.url().includes(`${api}/research/claims`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save supported fact' }).click();
    const countryClaimResponse = await countryClaimPromise;
    assert.equal(countryClaimResponse.status(), 201);
    assert.equal((await countryClaimResponse.json()).data?.status, 'supported', 'country fact is supported by the same excerpt');
    const accountRead = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/research/identities`);
    assert.equal(accountRead.status, 200, 'same workspace identities can be read back');
    assert.ok(accountRead.body.data?.some(row => row.id === accountId), 'identity readback preserves the source-linked account ID');

    await page.getByRole('tab', { name: 'Campaigns' }).click();
    await openForm('#offer-form');
    await page.locator('#offer-form [name="name"]').fill('Synthetic site audit');
    await page.locator('#offer-form [name="service"]').fill('Synthetic site audit');
    await page.locator('#offer-form [name="scope"]').fill('One synthetic diagnostic review.');
    await page.locator('#offer-form [name="minPrice"]').fill('100'); await page.locator('#offer-form [name="maxPrice"]').fill('500');
    await page.locator('#offer-form [name="currency"]').fill('INR'); await page.locator('#offer-form [name="includedCountries"]').fill('IN');
    await page.locator('#offer-form [name="capacity"]').fill('1');
    await page.locator('#offer-form [name="proofFile"]').setInputFiles({ name: 'synthetic-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic proof bytes for disposable journey.') });
    await page.locator('#offer-form [name="rightsBasis"]').fill('Synthetic QA fixture only; supplied by the owner.');
    const offerPromise = page.waitForResponse(r => r.url().endsWith(`${api}/offers`) && r.request().method() === 'POST');
    const offerApprovalPromise = page.waitForResponse(r => r.url().includes(`${api}/offers/`) && r.url().endsWith('/approve') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save proof and approve offer' }).click();
    const offerResponse = await offerPromise;
    assert.equal(offerResponse.status(), 201, 'guided offer form creates version with uploaded proof');
    const offerBody = await offerResponse.json();
    const offerId = offerBody.offer?.id, versionId = offerBody.offer?.version?.id;
    assert.ok(offerId && versionId, 'offer version IDs are returned');
    assert.equal((await offerApprovalPromise).status(), 200, 'guided flow completes offer approval after attaching its proof');
    const offerRead = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/offers/${offerId}`);
    assert.equal(offerRead.status, 200); assert.equal(offerRead.body.offer?.versions?.[0]?.status, 'approved');

    await page.getByRole('tab', { name: 'Inbox' }).click();
    await openForm('#mailbox-form');
    await page.locator('#mailbox-form [name="displayName"]').fill('Synthetic manual inbox');
    const mailboxPromise = page.waitForResponse(r => r.url().includes(`${api}/mailboxes`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create manual inbox' }).click();
    const mailboxResponse = await mailboxPromise; assert.equal(mailboxResponse.status(), 201);
    const mailbox = (await mailboxResponse.json()).mailbox; assert.equal(mailbox?.provider, 'manual');
    await openForm('#message-import-form');
    const importForm = page.locator('#message-import-form');
    await importForm.locator('[name="mailboxId"]').selectOption(String(mailbox.id));
    await importForm.locator('[name="externalThreadId"]').fill('synthetic-thread-1');
    await importForm.locator('[name="externalMessageId"]').fill('synthetic-message-1');
    await importForm.locator('[name="sender"]').fill('qa-flow@synthetic-mfg.example.test');
    await importForm.locator('[name="recipients"]').fill('owner@synthetic-mfg.example.test');
    await importForm.locator('[name="subject"]').fill('Synthetic response'); await importForm.locator('[name="bodyText"]').fill('Please send the synthetic site audit details.');
    const importPromise = page.waitForResponse(r => r.url().includes(`${api}/inbox/messages`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Import message' }).click();
    const imported = await importPromise; assert.equal(imported.status(), 201, 'same synthetic account message is manually imported');
    const importedMessageId = (await imported.json()).message?.id; assert.ok(importedMessageId);
    const retry = await page.evaluate(async ({ url, csrf, mailboxId }) => { const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ mailboxId, externalThreadId: 'synthetic-thread-1', externalMessageId: 'synthetic-message-1', sender: 'qa-flow@synthetic-mfg.example.test', recipients: ['owner@synthetic-mfg.example.test'], subject: 'Synthetic response', bodyText: 'Please send the synthetic site audit details.' }) }); return { status: r.status, body: await r.json() }; }, { url: `${api}/inbox/messages`, csrf: decodeURIComponent(csrf), mailboxId: mailbox.id });
    assert.equal(retry.status, 200, 'identical inbox import retry is idempotent');
    const conflict = await page.evaluate(async ({ url, csrf, mailboxId }) => { const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ mailboxId, externalThreadId: 'synthetic-thread-1', externalMessageId: 'synthetic-message-1', sender: 'qa-flow@synthetic-mfg.example.test', recipients: ['owner@synthetic-mfg.example.test'], subject: 'Changed synthetic response', bodyText: 'Changed content under an already imported reference.' }) }); return r.status; }, { url: `${api}/inbox/messages`, csrf: decodeURIComponent(csrf), mailboxId: mailbox.id });
    assert.equal(conflict, 409, 'changed content under an imported message reference is rejected');
    const inboxListReadback = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/inbox/messages?limit=100`);
    assert.equal(inboxListReadback.status, 200, 'imported messages can be read from the same workspace');
    const importedReadbackRows = inboxListReadback.body.items?.filter(item => item.id === importedMessageId) || [];
    assert.equal(importedReadbackRows.length, 1, 'the exact imported message is present once in persisted inbox readback');
    const importedReadback = importedReadbackRows[0];
    assert.equal(importedReadback.mailboxId, mailbox.id, 'inbox readback retains the exact manual mailbox');
    assert.equal(importedReadback.externalMessageId, 'synthetic-message-1', 'inbox readback retains the imported message identity');
    assert.ok(importedReadback.threadId, 'persisted message readback identifies its stored thread');
    assert.equal(importedReadback.sender, 'qa-flow@synthetic-mfg.example.test');
    assert.deepEqual(importedReadback.recipients, ['owner@synthetic-mfg.example.test']);
    assert.equal(importedReadback.subject, 'Synthetic response');
    assert.equal(importedReadback.bodyText, 'Please send the synthetic site audit details.');
    const threadReadback = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/inbox/messages?threadId=${encodeURIComponent(importedReadback.threadId)}&limit=100`);
    assert.equal(threadReadback.status, 200, 'the imported message thread can be read from the same workspace');
    assert.equal(threadReadback.body.items?.length, 1, 'thread-filtered readback contains the one imported synthetic message');
    assert.equal(threadReadback.body.items?.[0]?.id, importedMessageId, 'thread readback contains the exact imported message');
    assert.equal(threadReadback.body.items?.[0]?.threadId, importedReadback.threadId, 'message remains bound to the stored thread');

    await page.getByRole('tab', { name: 'Customers' }).click();
    await openForm('#crm-mapping-form');
    await page.locator('#crm-mapping-form [name="accountId"]').selectOption(String(accountId));
    await page.locator('#crm-mapping-form [name="externalId"]').fill('synthetic-crm-company-1');
    const mappingPromise = page.waitForResponse(r => r.url().includes(`${api}/crm/mappings`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save manual mapping' }).click();
    const mappingResponse = await mappingPromise; assert.equal(mappingResponse.status(), 201, 'manual mapping is saved locally');
    const mapping = (await mappingResponse.json()).mapping; assert.equal(mapping?.entityId, accountId);
    const mappingReadback = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/crm/mappings`);
    assert.equal(mappingReadback.status, 200, 'CRM mappings can be read from the same workspace');
    const persistedMapping = mappingReadback.body.items?.find(item => item.externalId === 'synthetic-crm-company-1');
    assert.ok(persistedMapping, 'the exact manual CRM identity mapping is persisted');
    assert.equal(persistedMapping.entityType, 'company');
    assert.equal(persistedMapping.entityId, accountId, 'persisted CRM mapping remains attached to the journey account');
    assert.equal(persistedMapping.externalId, 'synthetic-crm-company-1');
    await openForm('#crm-proposal-form');
    await page.locator('#crm-proposal-form [name="accountId"]').selectOption(String(accountId));
    await page.locator('#crm-proposal-form [name="name"]').fill('Synthetic QA company');
    await page.locator('#crm-proposal-form [name="domainName"]').fill('synthetic-mfg.example.test');
    const proposalPromise = page.waitForResponse(r => r.url().includes(`${api}/crm/outbox`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save company proposal' }).click();
    const proposalResponse = await proposalPromise; assert.equal(proposalResponse.status(), 201);
    const proposal = (await proposalResponse.json()).proposal;
    assert.equal(proposal?.state, 'held', 'CRM proposal remains held with external transport disabled');
    const proposalReadback = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/crm/outbox?state=held&limit=100`);
    assert.equal(proposalReadback.status, 200, 'CRM proposals can be read from the same workspace');
    assert.equal(proposalReadback.body.transportEnabled, false, 'persisted CRM proposal readback keeps external transport disabled');
    const persistedProposal = proposalReadback.body.items?.find(item => item.id === proposal?.id);
    assert.ok(persistedProposal, 'the exact held CRM proposal is persisted');
    assert.equal(persistedProposal.entityType, 'company');
    assert.equal(persistedProposal.entityId, accountId, 'persisted CRM proposal remains attached to the journey account');
    assert.equal(persistedProposal.state, 'held');
    assert.equal(persistedProposal.payload?.name, 'Synthetic QA company');
    assert.equal(persistedProposal.payload?.domainName, 'synthetic-mfg.example.test');

    await page.getByRole('tab', { name: 'Campaigns' }).click();
    await page.locator('#campaign-form [name="name"]').fill('Synthetic guided campaign');
    await page.locator('#campaign-form [name="offerVersionId"]').selectOption(String(versionId));
    await page.locator('#campaign-form [name="mailboxId"]').selectOption(String(mailbox.id));
    await page.locator('#campaign-form [name="purpose"]').fill('synthetic_flow');
    await page.locator('#campaign-form [name="geography"]').fill('IN'); await page.locator('#campaign-form [name="spendLimit"]').fill('0');
    const campaignPromise = page.waitForResponse(r => r.url().includes(`${api}/campaigns`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create campaign draft' }).click();
    const campaignResponse = await campaignPromise; assert.equal(campaignResponse.status(), 201);
    const campaign = (await campaignResponse.json()).campaign;
    assert.ok(campaign?.id, 'campaign draft is persisted');
    await openForm('#qualification-form');
    await page.locator('#qualification-form [name="campaignId"]').selectOption(String(campaign.id));
    await page.locator('#qualification-form [name="accountId"]').selectOption(String(accountId));
    const qualificationPromise = page.waitForResponse(r => r.url().includes(`${api}/campaigns/${campaign.id}/qualification`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Run qualification' }).click();
    const qualificationResponse = await qualificationPromise; assert.equal(qualificationResponse.status(), 200);
    const qualification = (await qualificationResponse.json()).qualification;
    assert.equal(qualification?.fitCount, 1, `one positive fit is explicitly required; statuses=${JSON.stringify(qualification?.results?.map(({ status, reasons }) => ({ status, reasons })))}`);
    assert.equal(qualification?.results?.length, 1);
    assert.equal(String(qualification.results[0].accountId), String(accountId), 'fit points to the exact evidence-linked account');
    assert.equal(qualification.results[0].status, 'fit');
    assert.ok(qualification.results[0].candidateId, 'fit is joined to one literal identity candidate');
    assert.equal(qualification.results[0].emailEvidenceId, evidenceId, 'candidate evidence is the same captured page');
    assert.equal(qualification.results[0].emailSourceId, snapshotResult.evidence.sourceId, 'candidate source is the same rights-reviewed source');
    assert.ok(qualification.results[0].claimRefs?.length >= 2 && qualification.results[0].claimRefs.every(ref => ref.evidenceId === evidenceId && ref.sourceId === snapshotResult.evidence.sourceId), 'industry and country qualification proofs point to the captured source and evidence');

    await openForm('#draft-form');
    await page.locator('#campaign-select').selectOption(String(campaign.id));
    const subjectTemplate = page.locator('#draft-fact-picker input[type="checkbox"][data-placement="subject"]').first();
    await subjectTemplate.waitFor({ state: 'attached' });
    await subjectTemplate.check();
    await page.locator('#draft-template-placement').selectOption('subject');
    await page.locator('#draft-insert-facts').click();
    const bodyTemplate = page.locator('#draft-fact-picker input[type="checkbox"][data-placement="body"]').first();
    await bodyTemplate.waitFor({ state: 'attached' });
    await bodyTemplate.check();
    await page.locator('#draft-template-placement').selectOption('body');
    await page.locator('#draft-insert-facts').click();
    const draftPromise = page.waitForResponse(r => r.url().includes(`/campaigns/${campaign.id}/draft`) && r.request().method() === 'PUT');
    await page.locator('#draft-form').getByRole('button', { name: 'Save draft' }).click();
    const draftResponse = await draftPromise; assert.equal(draftResponse.status(), 200);
    const draft = (await draftResponse.json()).draft;
    assert.ok(draft?.copyHash, 'copy has a persisted version hash');
    const reviewPromise = page.waitForResponse(r => r.url().includes(`/campaigns/${campaign.id}/review`) && r.request().method() === 'GET');
    await page.locator('#campaign-review-refresh').click();
    const reviewResponse = await reviewPromise; assert.equal(reviewResponse.status(), 200, 'the current persisted copy is reviewed before approval');
    await page.locator('#campaign-review-content:not([hidden])').waitFor();
    await openForm('#approval-form');
    await page.locator('#approval-form [name="expiresAt"]').fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    const approvalPromise = page.waitForResponse(r => r.url().includes(`/campaigns/${campaign.id}/approvals`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Approve exact saved version' }).click();
    assert.equal((await approvalPromise).status(), 201, 'owner approval applies to the exact saved version');
    await openForm('#plan-form');
    const planPromise = page.waitForResponse(r => r.url().includes(`/campaigns/${campaign.id}/dispatch-plans`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Prepare offline plan' }).click();
    const planResponse = await planPromise; assert.equal(planResponse.status(), 201);
    const plan = (await planResponse.json()).plan;
    assert.equal(plan?.liveTransport, 'disabled', 'offline plan explicitly keeps live transport disabled');
    assert.ok(plan?.blockers?.length, 'policy and evidence blockers remain explicit');
    const campaignRead = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/campaigns/${campaign.id}`);
    assert.equal(campaignRead.status, 200); assert.equal(campaignRead.body.campaign?.id, campaign.id);
    assert.ok(campaignRead.body.dispatchPlans?.some(item => item.id === plan.id || item.plan?.id === plan.id), `offline plan appears in persisted campaign readback; ids=${JSON.stringify(campaignRead.body.dispatchPlans?.map(item => ({ id: item.id, planId: item.plan?.id })))}`);
    await page.screenshot({ path: path.join(screenshotDirectory, 'campaign-plan.png'), fullPage: true });

    await page.getByRole('tab', { name: 'Analytics' }).click();
    const occurred = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
    await page.locator('#outcome-form [name="accountId"]').selectOption(String(accountId));
    await page.locator('#outcome-form [name="stage"]').selectOption('meeting_held');
    await page.locator('#outcome-form [name="occurredAt"]').fill(occurred);
    const outcomePromise = page.waitForResponse(r => r.url().endsWith(`${api}/outcomes`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save outcome' }).click();
    const outcomeResponse = await outcomePromise; assert.equal(outcomeResponse.status(), 201, 'observed outcome is recorded through guided form');
    const outcomeId = (await outcomeResponse.json()).data?.id; assert.ok(outcomeId);
    await page.waitForFunction(() => document.querySelector('#outcome-form [name="stage"]')?.value === 'meeting_booked');
    for (const [stage, amount] of [['revenue_paid', '120'], ['revenue_refunded', '20']]) {
      await page.getByRole('tab', { name: 'Analytics' }).click();
      await page.locator('#view-analytics:not([hidden])').waitFor();
      await page.locator('#outcome-form [name="stage"]').selectOption(stage);
      const revenueState = await page.locator('#outcome-form').evaluate(form => ({ stage: form.elements.stage.value, viewHidden: document.querySelector('#view-analytics').hidden, amountHidden: form.elements.amount.closest('.revenue-fields').hidden, currencyHidden: form.elements.currency.closest('.revenue-fields').hidden }));
      assert.equal(revenueState.amountHidden, false, `selecting ${stage} through the guided form reveals amount/currency fields; state=${JSON.stringify(revenueState)}`);
      await page.locator('#outcome-form [name="accountId"]').selectOption(String(accountId));
      await page.locator('#outcome-form [name="amount"]').fill(amount);
      await page.locator('#outcome-form [name="currency"]').fill('INR');
      await page.locator('#outcome-form [name="occurredAt"]').fill(occurred);
      assert.equal(await page.locator('#outcome-form').evaluate(form => form.checkValidity()), true, `${stage} outcome form is valid before submission`);
      const revenuePromise = page.waitForResponse(r => r.url().endsWith(`${api}/outcomes`) && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Save outcome' }).click();
      assert.equal((await revenuePromise).status(), 201, `${stage} is captured as an observed event`);
      await page.waitForFunction(() => document.querySelector('#outcome-form [name="stage"]')?.value === 'meeting_booked');
    }
    const analyticsResponse = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `${api}/analytics/funnel`);
    assert.equal(analyticsResponse.status, 200);
    const analytics = analyticsResponse.body.data || analyticsResponse.body;
    assert.equal(analytics.eventEntityDenominator, 1, 'analytics denominator is one observed synthetic account');
    assert.deepEqual(analytics.revenue, [{ currency: 'INR', paidMinor: '12000', refundedMinor: '2000', netMinor: '10000' }], 'analytics totals observed payment and refund as net value');
    assert.match(analytics.basis || '', /observed|outcome/i, 'analytics states its observed-outcome basis');
    assert.match(analytics.attribution || '', /none_in_tenant_funnel|no attribution|no causal/i, 'analytics states that funnel attribution is not calculated');
    await page.screenshot({ path: path.join(screenshotDirectory, 'analytics.png'), fullPage: true });

    const csrfNegative = await page.evaluate(async url => { const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }); return r.status; }, `${api}/crm/mappings`);
    assert.equal(csrfNegative, 403, 'write without CSRF token is rejected');
    const nonMember = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return r.status; }, `/api/astra/tenants/${crypto.randomUUID()}/accounts`);
    assert.ok([403,404].includes(nonMember), 'authenticated account cannot read a workspace without membership');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#create-workspace-form [name="name"]').fill('Synthetic isolation workspace');
    const secondWorkspacePromise = page.waitForResponse(r => r.url().includes('/api/astra/tenants') && r.request().method() === 'POST');
    await page.locator('#create-workspace-form button[type="submit"]').click();
    const secondWorkspaceResponse = await secondWorkspacePromise; assert.equal(secondWorkspaceResponse.status(), 201);
    const secondWorkspaceId = (await secondWorkspaceResponse.json()).tenant?.id;
    assert.ok(secondWorkspaceId && secondWorkspaceId !== workspaceId, 'second disposable workspace has an independent tenant identity');
    const crossTenantOutcome = await page.evaluate(async ({ url, csrf, accountId }) => {
      const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ stage: 'meeting_held', entity: { type: 'account', id: accountId }, occurredAt: new Date().toISOString(), idempotencyKey: `cross-tenant-${crypto.randomUUID()}`, provenance: { source: 'synthetic_fixture', confidence: 'high', fieldAuthority: 'human' } }) });
      return { status: r.status, body: await r.json() };
    }, { url: `/api/astra/tenants/${secondWorkspaceId}/outcomes`, csrf: decodeURIComponent(csrf), accountId });
    assert.ok([400,404,409].includes(crossTenantOutcome.status), `outcome in workspace B cannot link to workspace A account; status=${crossTenantOutcome.status}, code=${crossTenantOutcome.body?.code || 'none'}`);
    const secondWorkspaceAnalytics = await page.evaluate(async url => { const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() }; }, `/api/astra/tenants/${secondWorkspaceId}/analytics/funnel`);
    assert.equal(secondWorkspaceAnalytics.status, 200);
    assert.equal((secondWorkspaceAnalytics.body.data || secondWorkspaceAnalytics.body).eventEntityDenominator, 0, 'foreign account outcome left workspace B analytics unchanged');
    assert.deepEqual(pageErrors, [], 'guided journey has no uncaught browser errors');
    assert.ok(browserTrace.some(entry => entry.type === 'domcontentloaded' && new URL(entry.url).hostname === '127.0.0.1'));
    assert.ok(browserTrace.every(entry => ['blocked','domcontentloaded'].includes(entry.type)), 'browser guard records only local documents and blocked external requests');
    assert.ok(routeResults.some(row => row.path.endsWith('/research/snapshots') && row.status === 201));
    assert.ok(routeResults.some(row => row.path.endsWith('/campaigns/{workspace}') && row.status === 201) || routeResults.some(row => row.path.endsWith('/campaigns') && row.status === 201));
    assert.equal(await page.locator('#crm-transport-state').innerText(), 'External CRM transport is disabled. Proposals are saved locally and may be held by policy.');
    assert.match(await page.locator('#analytics-basis').innerText(), /none_in_tenant_funnel|no attribution|no causal/i);
    assert.ok(fs.readdirSync(screenshotDirectory).length >= 4, 'screenshots are captured in a unique per-run temporary directory');
    const journeyCookie = `odd_session=${session}; odd_csrf=${csrf}`;
    const logoutResponse = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: journeyCookie, 'x-csrf-token': decodeURIComponent(csrf) },
    });
    assert.equal(logoutResponse.status, 200, 'the journey explicitly logs out its authenticated owner');
    const staleSessionResponse = await fetch(`${base}${api}/accounts`, { headers: { cookie: journeyCookie } });
    assert.equal(staleSessionResponse.status, 401, 'the revoked journey session cannot read its workspace afterward');
    t.diagnostic(`Sanitized evidence: browserErrors=${pageErrors.length}; routeResponses=${routeResults.length}; screenshots=${fs.readdirSync(screenshotDirectory).length}; workspaceTransition=${JSON.stringify(workspaceTransition)}; policy=offline`);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
      } finally {
        try {
          closeDb();
        } finally {
          if (scratch && fs.existsSync(scratch)) {
            const tempRoot = fs.realpathSync(os.tmpdir());
            const scratchStat = fs.lstatSync(scratch);
            assert.ok(scratchStat.isDirectory() && !scratchStat.isSymbolicLink(), 'test-owned auth scratch remains a real directory');
            assert.equal(fs.realpathSync(path.dirname(scratch)), tempRoot, 'test-owned auth scratch remains directly inside OS temp');
            assert.match(path.basename(scratch), /^astra-guided-journey-[a-z0-9]{6}$/i, 'test-owned auth scratch keeps its exact mkdtemp prefix');
            fs.rmSync(scratch, { recursive: true, force: true });
          }
        }
      }
    }
  }
});
