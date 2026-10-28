import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.join(root, '.runner', 'astra-qa');
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const externalRequests = [];

test('customer source-rights UI reads and revokes persisted rights with retry and workspace guards', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to .runner/astra-qa/r20-source-rights/pg.json for the fresh synthetic 33-migration fixture.',
}, async t => {
  assert.ok(fixturePath);
  const [canonicalQaRoot, canonicalFixture] = await Promise.all([realpath(qaRoot), realpath(fixturePath)]);
  const relative = path.relative(canonicalQaRoot, canonicalFixture);
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative.split(path.sep).join('/'), 'r20-source-rights/pg.json', 'only the canonical R20 fixture is accepted');
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonicalFixture });
  if (!(await stat(edgePath).then(() => true, () => false))) return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.');

  const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'astra-r20-source-rights-ui-'));
  process.env.ODD_DB_PATH = path.join(scratch, 'auth.sqlite');
  process.env.NODE_ENV = 'test';
  process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
  process.env.ODD_AUTH_BOOTSTRAP_TOKEN = randomBytes(24).toString('hex');
  process.env.ODD_AUTH_COOKIE_SECURE = 'false';
  process.env.ODD_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
  process.env.ASTRA_DATABASE_URL = fixture.connectionString;
  process.env.ASTRA_WORKER_DATABASE_URL = fixture.workerConnectionString;
  process.env.ASTRA_CONTEXT_SECRET = fixture.contextSecret;
  process.env.ASTRA_TENANT_MODE = '1'; process.env.ASTRA_LEGACY_OFFER_BRIDGE = '1';
  process.env.LOCAL_PREVIEW = '1'; process.env.ASTRA_LIVE_ACTIONS = 'disabled';
  process.env.ASTRA_GLOBAL_PROVIDER_DECISION = 'unapproved';

  let appServer, uiServer, browser, closeDb;
  const appCalls = [];
  let holdNextRightsRead = false, releaseRightsRead = null, rightsReadHeld = null, signalRightsReadHeld = null;
  let holdNextRevocationResponse = false, releaseRevocation = null, revocationHeld = null, signalRevocationHeld = null;
  let failNextRevocationResponse = false;
  let conflictNextRevocation = false;
  t.after(async () => {
    await browser?.close();
    if (uiServer?.listening) await new Promise(resolve => uiServer.close(resolve));
    if (appServer?.listening) await new Promise(resolve => appServer.close(resolve));
    closeDb?.();
    await rm(scratch, { recursive: true, force: true });
  });

  await import('./support/astra-qa-egress-guard.mjs');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });
  globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')] = externalRequests;
  ({ server: appServer } = await import('../server.js'));
  const database = await import('../pipeline/database.js');
  closeDb = database.closeDb;
  const authDb = database.initDb();
  const { createAuthManager } = await import('../pipeline/auth-manager.js');
  const auth = createAuthManager(authDb);
  const isolatedAuthSequence = 1_000_000_000 + randomBytes(4).readUInt32BE(0);
  authDb.prepare("DELETE FROM sqlite_sequence WHERE name = 'auth_users'").run();
  authDb.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('auth_users', ?)").run(isolatedAuthSequence);
  if (!appServer.listening) await new Promise((resolve, reject) => { appServer.once('error', reject); appServer.once('listening', resolve); });
  const appPort = appServer.address().port;
  const appBase = `http://127.0.0.1:${appPort}`;

  async function api(route, { method = 'GET', cookie = '', csrf = '', body } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${appBase}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let json = {}; try { json = await response.json(); } catch { /* assertions report the status */ }
    return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: json };
  }
  const bootstrap = await api('/api/auth/bootstrap', { method: 'POST', body: {
    email: `source-rights-ui-${randomBytes(5).toString('hex')}@example.test`, password: 'Synthetic-source-rights-ui-9!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
  } });
  assert.equal(bootstrap.status, 201, bootstrap.body.error);
  const ownerId = Number(bootstrap.body.user.id);
  const sessionFrom = response => {
    const header = response.setCookie;
    const sid = header.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrfCookie = header.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(sid && csrfCookie, 'bootstrap returns session and CSRF cookies');
    const csrf = decodeURIComponent(csrfCookie);
    return { sid, csrf, cookie: `odd_session=${sid}; odd_csrf=${csrfCookie}` };
  };
  const owner = sessionFrom(bootstrap);
  const workspaces = [];
  const captures = [];
  for (const name of ['North Studio', 'South Studio']) {
    const created = await api('/api/astra/tenants', { method: 'POST', ...owner, body: { name } });
    assert.equal(created.status, 201, created.body.error);
    const tenantId = created.body.tenant.id;
    const captured = await api(`/api/astra/tenants/${tenantId}/research/snapshots`, { method: 'POST', ...owner, body: {
      sourceUrl: `https://${name.startsWith('North') ? 'north' : 'south'}-${randomBytes(4).toString('hex')}.example.test/about`,
      rightsPolicy: 'user_provided', rightsAttested: true, robotsAllowed: true,
      html: '<!doctype html><title>Synthetic customer page</title><h1>Synthetic source</h1>', mediaType: 'text/html; charset=utf-8',
    } });
    assert.equal(captured.status, 201, captured.body.error);
    workspaces.push({ id: tenantId, name });
    captures.push(captured.body.data.evidence);
  }
  const conflictCaptureResult = await api(`/api/astra/tenants/${workspaces[0].id}/research/snapshots`, { method: 'POST', ...owner, body: {
    sourceUrl: `https://conflict-${randomBytes(4).toString('hex')}.example.test/about`, rightsPolicy: 'user_provided', rightsAttested: true, robotsAllowed: true,
    html: '<!doctype html><title>Conflict source</title><h1>Conflict source</h1>', mediaType: 'text/html; charset=utf-8',
  } });
  assert.equal(conflictCaptureResult.status, 201, conflictCaptureResult.body.error);
  const conflictCapture = conflictCaptureResult.body.data.evidence;
  assert.notEqual(conflictCapture.sourceId, captures[0].sourceId, 'separate synthetic captures get separate source identities');
  const reviewerEmail = `source-rights-reviewer-${randomBytes(5).toString('hex')}@example.test`;
  const globalInvite = auth.createInvitation({ actor: { id: ownerId, role: 'owner' }, email: reviewerEmail, role: 'reviewer' }).invitation;
  const accepted = await auth.acceptInvitation({ email: reviewerEmail, password: 'Synthetic-reviewer-pass-9!', invitationToken: globalInvite.token, remoteAddress: '127.0.0.1' });
  const reviewerUserId = String(authDb.prepare('SELECT id FROM auth_users WHERE email = ?').get(reviewerEmail).id);
  const reviewerMembership = await api(`/api/astra/tenants/${workspaces[1].id}/memberships/invitations`, { method: 'POST', ...owner, body: { email: reviewerEmail, role: 'reviewer' } });
  assert.equal(reviewerMembership.status, 201, reviewerMembership.body.error);
  const reviewerJoin = await api('/api/astra/invitations/accept', { method: 'POST', cookie: `odd_session=${accepted.sessionToken}; odd_csrf=${accepted.csrfToken}`, csrf: accepted.csrfToken, body: { token: reviewerMembership.body.token } });
  assert.equal(reviewerJoin.status, 200, reviewerJoin.body.error);
  const reviewer = { cookie: `odd_session=${accepted.sessionToken}; odd_csrf=${accepted.csrfToken}`, csrf: accepted.csrfToken };

  uiServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const assets = new Map([
      ['/growth.html', ['growth.html', 'text/html; charset=utf-8']],
      ['/css/main.css', ['css/main.css', 'text/css; charset=utf-8']],
      ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css; charset=utf-8']],
      ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript; charset=utf-8']],
      ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript; charset=utf-8']],
    ]);
    if (assets.has(pathname)) {
      const [file, type] = assets.get(pathname);
      try { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(await readFile(path.join(root, file))); }
      catch { res.writeHead(404).end(); }
      return;
    }
    if (!pathname.startsWith('/api/')) { res.writeHead(404).end('not found'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const call = { method: req.method, path: pathname, body: body.length ? JSON.parse(body.toString('utf8')) : null };
    appCalls.push(call);
    const isRevocation = req.method === 'POST' && /\/research\/sources\/[^/]+\/rights-revocations$/.test(pathname);
    if (isRevocation && conflictNextRevocation) {
      conflictNextRevocation = false;
      const sourceId = pathname.match(/\/sources\/([^/]+)\/rights-revocations$/)?.[1];
      const existing = await api(`/api/astra/tenants/${workspaces[0].id}/research/sources/${sourceId}/rights-revocations`, {
        method: 'POST', ...owner, body: { reason: 'An earlier authorized stop request.', idempotencyKey: call.body.idempotencyKey },
      });
      assert.equal(existing.status, 201, `${existing.body.error} (synthetic source ${sourceId}, key ${call.body.idempotencyKey})`);
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: appPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${appPort}`, ...(body.length ? { 'content-length': body.length } : {}) } }, upstreamResponse => {
      const responseChunks = [];
      upstreamResponse.on('data', chunk => responseChunks.push(chunk));
      upstreamResponse.on('end', async () => {
        const responseBody = Buffer.concat(responseChunks);
        const isRightsRead = req.method === 'GET' && /\/research\/sources\/[^/]+\/rights$/.test(pathname);
        if (isRightsRead && holdNextRightsRead) {
          holdNextRightsRead = false;
          rightsReadHeld = new Promise(resolve => { releaseRightsRead = resolve; });
          signalRightsReadHeld?.(); signalRightsReadHeld = null;
          await rightsReadHeld;
        }
        if (isRevocation && holdNextRevocationResponse) {
          holdNextRevocationResponse = false;
          revocationHeld = new Promise(resolve => { releaseRevocation = resolve; });
          signalRevocationHeld?.(); signalRevocationHeld = null;
          await revocationHeld;
        }
        if (isRevocation && failNextRevocationResponse) {
          failNextRevocationResponse = false;
          res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Synthetic response interruption after the server committed the revocation.' }));
          return;
        }
        res.writeHead(upstreamResponse.statusCode || 500, upstreamResponse.headers);
        res.end(responseBody);
      });
    });
    upstream.on('error', error => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); });
    upstream.end(body);
  });
  await new Promise((resolve, reject) => { uiServer.once('error', reject); uiServer.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await browserContext.addCookies([
    { name: 'odd_session', value: owner.sid, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: 'odd_csrf', value: owner.csrf, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  const page = await browserContext.newPage();
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.goto(`http://127.0.0.1:${uiServer.address().port}/growth.html`);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  const panel = page.locator('#source-rights-panel');
  assert.equal(await panel.isVisible(), true, 'owners can open the source-rights action');
  await panel.locator('details.task-disclosure').evaluate(details => { details.open = true; });
  const sourceSelect = page.locator('#source-rights-form [name="sourceId"]');
  const source = captures[0];
  const sourceOption = sourceSelect.locator('option').filter({ hasText: source.sourceUrl });
  await sourceOption.waitFor({ state: 'attached' });
  const readableLabel = await sourceOption.innerText();
  assert.match(readableLabel, /North Studio|north-[a-f0-9]+\.example\.test/);
  assert.match(readableLabel, /https:\/\//);
  assert.match(readableLabel, /captured/i);
  assert.doesNotMatch(readableLabel, new RegExp(source.sourceId, 'i'), 'the source UUID is never the customer-facing choice');
  await sourceSelect.selectOption(source.sourceId);
  await page.locator('#source-rights-result[data-state="permitted"]').waitFor();
  assert.match(await page.locator('#source-rights-result').innerText(), /Current saved status: permitted/);

  await page.getByLabel('Reason to stop future use').fill('The source owner withdrew permission.');
  failNextRevocationResponse = true;
  await page.getByRole('button', { name: 'Stop future use' }).click();
  await page.locator('#source-rights-result[data-state="error"]').waitFor();
  const firstAttempt = appCalls.find(call => call.method === 'POST' && call.path.endsWith('/rights-revocations'));
  assert.deepEqual(Object.keys(firstAttempt.body).sort(), ['idempotencyKey', 'reason']);
  assert.equal(firstAttempt.body.reason, 'The source owner withdrew permission.');
  assert.equal('actorId' in firstAttempt.body, false);
  assert.equal('tenantId' in firstAttempt.body, false);

  await page.getByRole('button', { name: 'Stop future use' }).click();
  await page.locator('#source-rights-result[data-state="revoked"]').waitFor();
  assert.match(await page.locator('#source-rights-result').innerText(), /Future use of this captured source is blocked/);
  assert.match(await page.locator('#source-rights-result').innerText(), /capture and history are retained/);
  assert.equal(await page.locator('#source-rights-form [name="reason"]').inputValue(), '', 'the reason draft clears only after persisted revocation is confirmed');
  const attempts = appCalls.filter(call => call.method === 'POST' && call.path.endsWith('/rights-revocations'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.idempotencyKey, attempts[1].body.idempotencyKey, 'an uncertain response retries with the same idempotency key');
  const finalRights = await api(`/api/astra/tenants/${workspaces[0].id}/research/sources/${source.sourceId}/rights`, { cookie: owner.cookie });
  assert.equal(finalRights.status, 200);
  assert.equal(finalRights.body.data.effectiveRightsStatus, 'revoked', 'the UI result matches persisted rights readback');
  const historicalContent = await api(`/api/astra/tenants/${workspaces[0].id}/research/evidence/${source.id}/content`, { cookie: owner.cookie });
  assert.equal(historicalContent.status, 200, 'the old captured content remains available as retained history');

  await page.locator('#view-discover [data-refresh]').click();
  const conflictOption = sourceSelect.locator('option').filter({ hasText: conflictCapture.sourceUrl });
  await conflictOption.waitFor({ state: 'attached' });
  await sourceSelect.selectOption(conflictCapture.sourceId);
  await page.locator('#source-rights-result[data-state="permitted"]').waitFor();
  await page.getByLabel('Reason to stop future use').fill('The team needs to stop using this source.');
  conflictNextRevocation = true;
  await page.getByRole('button', { name: 'Stop future use' }).click();
  await page.locator('#source-rights-result[data-state="revoked"]').waitFor();
  assert.match(await page.locator('#source-rights-result').innerText(), /retry key conflicted/i);
  assert.match(await page.locator('#source-rights-result').innerText(), /prior request already stopped future use/i);
  assert.equal(await page.locator('#source-rights-form [name="reason"]').inputValue(), '', 'a reread confirming an earlier permanent revocation clears the unsaved reason draft');
  assert.equal((await api(`/api/astra/tenants/${workspaces[0].id}/research/sources/${conflictCapture.sourceId}/rights`, { cookie: owner.cookie })).body.data.effectiveRightsStatus, 'revoked', 'conflict recovery rereads the persisted status');

  const workspacePicker = page.getByLabel('Choose workspace');
  await workspacePicker.selectOption(workspaces[1].id);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  assert.equal(await sourceSelect.inputValue(), '', 'switching workspaces clears the source choice synchronously');
  assert.equal(await page.locator('#source-rights-form [name="reason"]').inputValue(), '', 'switching workspaces clears the tenant reason draft synchronously');
  assert.doesNotMatch(await page.locator('#source-rights-result').innerText(), /The source owner withdrew permission/);

  let announceRightsRead;
  const rightsReadStarted = new Promise(resolve => { announceRightsRead = resolve; });
  signalRightsReadHeld = announceRightsRead;
  holdNextRightsRead = true;
  await sourceSelect.selectOption(captures[1].sourceId);
  await rightsReadStarted;
  await page.locator('#source-rights-form [name="reason"]').fill('Draft for the south workspace.');
  await workspacePicker.selectOption(workspaces[0].id);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  assert.equal(await sourceSelect.inputValue(), '', 'a held rights read does not retain a tenant selection after switching');
  assert.equal(await page.locator('#source-rights-form [name="reason"]').inputValue(), '', 'the next tenant never sees a draft from the previous tenant');
  releaseRightsRead?.(); rightsReadHeld = null;
  await page.waitForTimeout(150);
  assert.doesNotMatch(await page.locator('#source-rights-result').innerText(), /south-[a-f0-9]+\.example\.test/);
  assert.doesNotMatch(await page.locator('#source-rights-result').innerText(), /Draft for the south workspace/);

  await workspacePicker.selectOption(workspaces[1].id);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await sourceSelect.selectOption(captures[1].sourceId);
  await page.locator('#source-rights-result[data-state="permitted"]').waitFor();
  await page.getByLabel('Reason to stop future use').fill('South workspace stop draft.');
  let announceRevocation;
  const revocationResponseHeld = new Promise(resolve => { announceRevocation = resolve; });
  signalRevocationHeld = announceRevocation;
  holdNextRevocationResponse = true;
  const southRightsReadCount = () => appCalls.filter(call => call.method === 'GET' && call.path.includes(`/tenants/${workspaces[1].id}/research/sources/`)).length;
  const readsBeforeStaleWrite = southRightsReadCount();
  await page.getByRole('button', { name: 'Stop future use' }).click();
  await revocationResponseHeld;
  assert.equal(appCalls.filter(call => call.method === 'POST' && call.path.includes(`/tenants/${workspaces[1].id}/research/sources/`) && call.path.endsWith('/rights-revocations')).length, 1);
  await workspacePicker.selectOption(workspaces[0].id);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  assert.equal(await page.locator('#source-rights-form [name="reason"]').inputValue(), '', 'tenant drafts clear before the held write response returns');
  assert.equal(await sourceSelect.inputValue(), '', 'the next workspace has no selected source while the response is held');
  const readsBeforeRelease = southRightsReadCount();
  releaseRevocation?.(); revocationHeld = null;
  await page.waitForTimeout(200);
  assert.equal(southRightsReadCount(), readsBeforeRelease, 'a stale POST completion cannot trigger a follow-up rights GET for the prior workspace');
  assert.equal(readsBeforeRelease, readsBeforeStaleWrite, 'the held write did not trigger a follow-up rights read before or after the workspace switch');
  assert.equal(await page.locator('#notice').innerText(), '', 'a stale write completion cannot paint a notice in the next workspace');
  const southRevoked = await api(`/api/astra/tenants/${workspaces[1].id}/research/sources/${captures[1].sourceId}/rights`, { cookie: owner.cookie });
  assert.equal(southRevoked.body.data.effectiveRightsStatus, 'revoked', 'the held response followed a real server-side revocation');

  const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await reviewerContext.addCookies([
    { name: 'odd_session', value: accepted.sessionToken, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: 'odd_csrf', value: accepted.csrfToken, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  const reviewerPage = await reviewerContext.newPage();
  await reviewerPage.goto(`http://127.0.0.1:${uiServer.address().port}/growth.html`);
  await reviewerPage.getByLabel('Choose workspace').selectOption(workspaces[1].id);
  await reviewerPage.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  assert.equal(await reviewerPage.locator('#source-rights-panel').evaluate(node => node.hidden), true, 'reviewers cannot see the source-rights write UI');
  assert.equal(await reviewerPage.locator('#source-rights-form').evaluate(form => form.parentElement.hidden), true, 'reviewers do not see an empty source-rights task disclosure');
  assert.ok(reviewerUserId, 'reviewer user was created in the isolated auth store');
  assert.deepEqual(pageErrors, [], 'source-rights browser flows produce no uncaught errors');
  assert.equal(externalRequests.some(entry => entry.type === 'blocked'), false, 'no external browser requests were attempted');
  await reviewerContext.close();

  const roleDenied = await api(`/api/astra/tenants/${workspaces[1].id}/research/sources/${captures[1].sourceId}/rights-revocations`, {
    method: 'POST', ...reviewer, body: { reason: 'Reviewer must be denied.', idempotencyKey: `reviewer-${randomUUID()}` },
  });
  assert.equal(roleDenied.status, 403, 'the server independently denies a reviewer source-rights write');
  assert.equal(appCalls.some(call => call.path.includes('rights-revocations') && call.body?.reason === 'Reviewer must be denied.'), false, 'direct API role denial stays outside the customer browser flow log');
});
