import { after, test } from 'node:test';
import { reacherContractFixture } from './support/reacher-contract-fixture.mjs';
import assert from 'node:assert/strict';
import { parse as parseCsv } from 'csv-parse/sync';
import dns from 'node:dns';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-verifier-offline-integration-'));
process.env.NODE_ENV = 'test';
process.env.ODD_DB_PATH = path.join(fixtureDirectory, 'disposable-test.db');
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'offline-fixture-bootstrap-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_GOOGLE_LOGIN_ENABLED = 'false';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.REACHER_API_URL = 'http://localhost:8080/v0/check_email';
delete process.env.ODD_PUBLIC_BASE_URL;
delete process.env.APP_URL;

const transportAttempts = [];
const browserDeniedOrigins = [];
let allowedOrigin = null;
let browser;
let server;
let closeDb;
let db;
const realNet = { connect: net.connect, createConnection: net.createConnection };

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url); }
  catch {
    transportAttempts.push({ kind: 'invalid-fetch-target' });
    throw new Error('Blocked non-URL fetch target in offline integration fixture.');
  }
  if (allowedOrigin && url.origin === allowedOrigin) return realFetch(input, init);
  const host = url.hostname.toLowerCase();
  const kind = host === 'disify.com' ? 'disify' : host === 'localhost' && url.port === '8080' ? 'reacher' : 'external-fetch';
  transportAttempts.push({ kind });
  throw new Error(`Blocked ${kind} fetch in offline integration fixture.`);
};

const denyTransport = kind => (..._args) => {
  transportAttempts.push({ kind });
  throw new Error(`Blocked ${kind} in offline integration fixture.`);
};
function guardedNetConnect(kind, real) {
  return function (...args) {
    const options = args[0] && typeof args[0] === 'object'
      ? args[0]
      : { port: args[0], host: args[1] };
    const exactLoopback = allowedOrigin && options.host === '127.0.0.1'
      && Number(options.port) === server?.address()?.port;
    if (exactLoopback) return Reflect.apply(real, this, args);
    transportAttempts.push({ kind });
    throw new Error(`Blocked ${kind} outside the exact test API loopback.`);
  };
}
net.createConnection = guardedNetConnect('net.createConnection', realNet.createConnection);
net.connect = guardedNetConnect('net.connect', realNet.connect);
for (const [module, names] of [
  [tls, ['connect']],
  [http, ['request', 'get']],
  [https, ['request', 'get']],
]) {
  for (const name of names) module[name] = denyTransport(`${module === net ? 'net' : module === tls ? 'tls' : module === http ? 'http' : 'https'}.${name}`);
}
const realDnsLookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  // Node uses the callback lookup API while binding the local test server. The
  // literal loopback address is allowed; hostname lookups remain denied.
  if (hostname === '127.0.0.1') return Reflect.apply(realDnsLookup, this, [hostname, ...args]);
  transportAttempts.push({ kind: 'dns.callback.lookup' });
  throw new Error('Blocked non-loopback DNS lookup in offline integration fixture.');
};
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'reverse']) {
  dns.promises[name] = denyTransport(`dns.${name}`);
  if (name !== 'lookup') dns[name] = denyTransport(`dns.callback.${name}`);
}
dgram.Socket.prototype.send = denyTransport('udp.send');
syncBuiltinESMExports();

const { initDb } = await import('../pipeline/database.js');
({ closeDb } = await import('../pipeline/database.js'));
db = initDb();
const { verifyEmail } = await import('../pipeline/email-verifier.js');
({ server } = await import('../server.js'));
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
allowedOrigin = new URL(base).origin;

after(async () => {
  await browser?.close().catch(() => {});
  if (server?.listening) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  closeDb?.();
  // Keep the isolated synthetic database and browser export for durable test evidence.
});

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'bootstrap must issue an owner session cookie');
  assert.ok(csrf, 'bootstrap must issue a CSRF cookie');
  return {
    cookie: `odd_session=${decodeURIComponent(session)}; odd_csrf=${decodeURIComponent(csrf)}`,
    csrf: decodeURIComponent(csrf),
  };
}

async function request(route, { method = 'GET', body, session, csrf, origin = allowedOrigin } = {}) {
  const headers = { origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session) headers.cookie = session.cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await globalThis.fetch(`${base}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    setCookie: response.headers.get('set-cookie') || '',
    body: contentType.includes('json') ? await response.json() : await response.text(),
  };
}

function evidenceOf(result) {
  return result?.classification_evidence && typeof result.classification_evidence === 'object'
    ? result.classification_evidence : null;
}

test('offline evidence is attached to SMTPUTF8, DNS-unknown and Reacher results without clearing provider warnings', async () => {
  const reacherRaw = {
    input: 'synthetic-free-001@gmail.com', is_reachable:'unknown',
    syntax: { is_valid_syntax: true },
    mx: { accepts_mail: true, records: ['gmail-smtp-in.l.google.com'], implicit_mx_record: false },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: false, is_deliverable: null, is_catch_all: false, has_full_inbox:false, is_disabled:false },
  };
  const reacherResult = await verifyEmail('synthetic-free-001@gmail.com', {
    isReacherAvailableImpl: async () => true,
    reacherFetchImpl: reacherContractFixture(reacherRaw),
    resolveMxImpl: async () => [{exchange:'gmail-smtp-in.l.google.com',priority:10}],
  });
  assert.equal(reacherResult.is_free_provider, true);
  assert.equal(reacherResult.is_disposable, false);
  assert.equal(reacherResult.verification_status, 'unknown');
  assert.equal(evidenceOf(reacherResult)?.match, false);
  assert.equal(reacherResult.reacher.misc.is_disposable, false, 'retain the raw provider no-match observation');

  const warningRaw = {
    input: 'synthetic-warning-001@example.test', is_reachable:'unknown',
    syntax: { is_valid_syntax: true },
    mx: { accepts_mail: true, records: ['mx.example.test'], implicit_mx_record: false },
    misc: { is_disposable: true, is_role_account: false },
    smtp: { can_connect_smtp: false, is_deliverable: null, is_catch_all: false, has_full_inbox:false, is_disabled:false },
  };
  const providerWarning = await verifyEmail('synthetic-warning-001@example.test', {
    isReacherAvailableImpl: async () => true,
    reacherFetchImpl: reacherContractFixture(warningRaw),
    resolveMxImpl: async () => [{exchange:'mx.example.test',priority:10}],
  });
  assert.equal(providerWarning.is_disposable, true, 'local no-match must not clear a provider warning');
  assert.equal(evidenceOf(providerWarning)?.match, false);
  assert.equal(providerWarning.reacher.misc.is_disposable, true);
  assert.equal(providerWarning.verification_status, 'risky', 'provider disposable warning does not assert a protocol rejection');

  const dnsUnknown = await verifyEmail('synthetic-free-001@gmail.com', {
    isReacherAvailableImpl: async () => false,
    resolveMxImpl: async () => { throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEOUT' }); },
    resolve4Impl: async () => { throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEOUT' }); },
    resolve6Impl: async () => { throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEOUT' }); },
  });
  assert.equal(dnsUnknown.verification_status, 'unknown');
  assert.equal(dnsUnknown.is_free_provider, true);
  assert.equal(evidenceOf(dnsUnknown)?.match, false);
  assert.equal(dnsUnknown.checks.smtp, null);

  const smtpUtf8 = await verifyEmail('müller@example.test', { isReacherAvailableImpl: async () => {
    assert.fail('SMTPUTF8 capability gate must return before backend health check');
  } });
  assert.equal(smtpUtf8.verification_status, 'unknown');
  assert.equal(smtpUtf8.checks.smtp, null);
  assert.equal(evidenceOf(smtpUtf8)?.dataset_available, true);
  assert.equal(evidenceOf(smtpUtf8)?.match, false);
});

test('offline verification persists synthetic local classifications through owner API, history, contacts, export and Edge', async t => {
  const violations = [];
  const checks = {};
  const countEvents = kind => transportAttempts.filter(event => event.kind === kind).length;
  const eventsBefore = () => transportAttempts.length;
  const syntheticDisposable = 'synthetic-retry-001@1secmail.com';
  const syntheticGmail = 'synthetic-free-001@gmail.com';
  const password = 'Offline-fixture-owner-password-2026!';

  const anonymous = await request('/api/verify/single', { method: 'POST', body: { email: syntheticDisposable } });
  checks.anonymousVerifyDenied = anonymous.status === 401;
  if (!checks.anonymousVerifyDenied) violations.push('anonymous verification was not denied');

  const bootstrapped = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: { email: 'offline-owner@example.test', password, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN },
  });
  checks.ownerBootstrap = bootstrapped.status === 201;
  if (!checks.ownerBootstrap) violations.push('normal owner bootstrap failed');
  const session = authCookies(bootstrapped.setCookie);

  const noCsrf = await request('/api/batches', {
    method: 'POST', session, body: { name: 'Must remain blocked', phase: 'verification' },
  });
  checks.csrfEnforced = noCsrf.status === 403;
  if (!checks.csrfEnforced) violations.push('authenticated mutation without CSRF was not denied');

  const batchResponse = await request('/api/batches', {
    method: 'POST', session, csrf: session.csrf,
    body: { name: 'Synthetic offline verification fixture', phase: 'verification' },
  });
  checks.batchCreatedWithSessionAndCsrf = batchResponse.status === 201;
  if (!checks.batchCreatedWithSessionAndCsrf) violations.push('owner session and CSRF could not create a fixture batch');
  const batchId = batchResponse.body.id;

  const contactResponse = await request('/api/leads', {
    method: 'POST', session, csrf: session.csrf,
    body: { batch_id: batchId, business_name: 'Synthetic offline disposable fixture', email: syntheticDisposable },
  });
  checks.contactCreatedWithSessionAndCsrf = contactResponse.status === 201;
  if (!checks.contactCreatedWithSessionAndCsrf) violations.push('owner session and CSRF could not create a synthetic contact');
  const leadId = contactResponse.body?.contact?.id;
  const emailRow = leadId
    ? db.prepare('SELECT id,source,verification_status FROM lead_emails WHERE lead_id=? AND email=?').get(leadId, syntheticDisposable)
    : null;
  checks.syntheticAddressLabel = emailRow?.source === 'manual';
  if (!checks.syntheticAddressLabel) violations.push('the test contact is not marked as synthetic manual fixture data');

  const preSingleEvents = eventsBefore();
  const disposableSingle = await request('/api/verify/single', {
    method: 'POST', session, csrf: session.csrf, body: { email: syntheticDisposable },
  });
  const singleResult = disposableSingle.body?.result;
  checks.singleLocalMatch = disposableSingle.status === 200
    && singleResult?.is_disposable === true && evidenceOf(singleResult)?.match === true
    && evidenceOf(singleResult)?.matched_domain === '1secmail.com';
  if (!checks.singleLocalMatch) violations.push('single verification did not return the pinned local disposable match');
  checks.disposableSingleAvoidedExternalWork = transportAttempts.slice(preSingleEvents).every(event => event.kind !== 'disify'
    && event.kind !== 'reacher' && event.kind !== 'external-fetch' && event.kind !== 'invalid-fetch-target'
    && !/^(dns|net|tls|http|https|udp)\./.test(event.kind));
  if (!checks.disposableSingleAvoidedExternalWork) violations.push('known local disposable verification attempted a guarded external lookup or connection');
  checks.singleDidNotClaimMailbox = singleResult?.verification_status === 'undeliverable'
    && singleResult?.general?.reason === 'Disposable Domain'
    && singleResult?.checks?.mx === null
    && singleResult?.checks?.smtp === null
    && singleResult?.evidence?.mailbox_status === 'unconfirmed'
    && !singleResult?.reasons?.includes('smtp_recipient_rejected');
  if (!checks.singleDidNotClaimMailbox) violations.push('disposable classification was presented as positive mailbox proof');

  const gmailEventsStart = eventsBefore();
  const gmailSingle = await request('/api/verify/single', {
    method: 'POST', session, csrf: session.csrf, body: { email: syntheticGmail },
  });
  const gmailResult = gmailSingle.body?.result;
  checks.gmailIsFreeButMailboxUnknown = gmailSingle.status === 200
    && gmailResult?.is_free_provider === true && gmailResult?.is_disposable === null
    && evidenceOf(gmailResult)?.match === false && gmailResult?.verification_status === 'unknown'
    && gmailResult?.checks?.smtp === null;
  if (!checks.gmailIsFreeButMailboxUnknown) violations.push('synthetic Gmail result did not remain unknown while showing its local free-provider/no-match signals');
  checks.gmailMadeNoDisifyRequest = transportAttempts.slice(gmailEventsStart).every(event => event.kind !== 'disify');
  if (!checks.gmailMadeNoDisifyRequest) violations.push('synthetic Gmail verification attempted Disify');

  const retryResponses = [];
  for (let retry = 0; retry < 2; retry++) {
    retryResponses.push(await request(`/api/verify/email/${emailRow?.id}`, {
      method: 'POST', session, csrf: session.csrf,
    }));
  }
  checks.twoAuthenticatedRetries = retryResponses.every(response => response.status === 200);
  if (!checks.twoAuthenticatedRetries) violations.push('both saved-address retry requests did not succeed');
  checks.retriesKeepLocalEvidence = retryResponses.every(response => response.body?.result?.is_disposable === true
    && evidenceOf(response.body?.result)?.match === true
    && response.body?.result?.verification_status !== 'deliverable'
    && response.body?.result?.checks?.smtp === null);
  if (!checks.retriesKeepLocalEvidence) violations.push('saved-address retries did not keep local evidence and unknown mailbox status');
  checks.retriesMadeNoDisifyRequest = transportAttempts.every(event => event.kind !== 'disify');
  if (!checks.retriesMadeNoDisifyRequest) violations.push('a saved-address retry attempted Disify');

  const stored = db.prepare('SELECT source,verification_status,is_disposable,verification_json FROM lead_emails WHERE id=?').get(emailRow?.id);
  let storedResult = null;
  try { storedResult = JSON.parse(stored?.verification_json || 'null'); } catch { /* surfaced by assertions below */ }
  checks.savedJsonHasEvidence = stored?.source === 'manual' && stored?.is_disposable === 1
    && storedResult?.classification_evidence?.match === true
    && storedResult?.classification_evidence?.dataset_commit === '3ebb7fef055e3757dfc9bb46b1297ee2b0d11fe7';
  if (!checks.savedJsonHasEvidence) violations.push('current verification_json does not persist the pinned classification evidence');
  checks.noMailboxValidityClaimStored = stored?.verification_status !== 'deliverable'
    && storedResult?.checks?.smtp === null;
  if (!checks.noMailboxValidityClaimStored) violations.push('saved offline result implies mailbox acceptance');

  const historyResponse = await request(`/api/verify/email/${emailRow?.id}/history`, { session });
  const history = historyResponse.body?.results || [];
  checks.historyRetainsBothRetries = historyResponse.status === 200 && history.length >= 2
    && history.slice(0, 2).every(row => row.result?.classification_evidence?.match === true);
  if (!checks.historyRetainsBothRetries) violations.push('verification history does not retain both retry evidence records');

  const contactsResponse = await request(`/api/leads?batch_id=${batchId}&search=Synthetic%20offline%20disposable`, { session });
  checks.contactsApiKeepsContact = contactsResponse.status === 200
    && contactsResponse.body?.pagination?.total === 1
    && contactsResponse.body?.leads?.[0]?.id === leadId;
  if (!checks.contactsApiKeepsContact) violations.push('the authenticated contacts API did not retain the synthetic contact');

  const resultResponse = await request(`/api/verify/results/${batchId}`, { session });
  const apiRow = resultResponse.body?.results?.find(row => row.id === emailRow?.id);
  checks.resultApiKeepsEvidence = resultResponse.status === 200
    && JSON.parse(apiRow?.verification_json || 'null')?.classification_evidence?.match === true;
  if (!checks.resultApiKeepsEvidence) violations.push('the authenticated verification-results API did not return stored evidence');

  const exportResponse = await request(`/api/verify/results/${batchId}/export`, { session });
  let exportRows = [];
  try { exportRows = parseCsv(exportResponse.body, { bom: true, columns: true }); } catch { /* surfaced by assertions below */ }
  const exported = exportRows.find(row => row.email_id === String(emailRow?.id));
  let exportedChecks = {};
  try { exportedChecks = JSON.parse(exported?.checks_json || '{}'); } catch { /* surfaced by assertions below */ }
  checks.exportKeepsOfflineEvidence = exportResponse.status === 200
    && exported?.email === syntheticDisposable
    && exportedChecks?.classification_evidence?.match === true;
  if (!checks.exportKeepsOfflineEvidence) violations.push('verification export does not carry the stored offline evidence');

  assert.ok(fs.existsSync(EDGE_PATH), `installed Edge is required for this proof: ${EDGE_PATH}`);
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  const page = await context.newPage();
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if (origin === allowedOrigin) return route.continue();
    browserDeniedOrigins.push(origin);
    return route.abort();
  });
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="email"]').fill('offline-owner@example.test');
  await page.locator('[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'offline-owner@example.test' }).waitFor({ timeout: 10000 });
  checks.edgeOwnerLogin = await page.evaluate(async () => (await fetch('/api/auth/status', { credentials: 'same-origin' })).json())
    .then(status => status.authenticated === true && status.user?.role === 'owner');
  if (!checks.edgeOwnerLogin) violations.push('Edge did not establish an authenticated owner session');

  await page.evaluate(() => window.__nav('leads'));
  await page.locator('.lead-row').filter({ hasText: 'Synthetic offline disposable fixture' }).waitFor({ timeout: 10000 });
  const leadRowText = await page.locator('.lead-row').filter({ hasText: 'Synthetic offline disposable fixture' }).innerText();
  checks.edgeContactsShowsSyntheticContact = leadRowText.includes(syntheticDisposable);
  if (!checks.edgeContactsShowsSyntheticContact) violations.push('Edge Contacts view did not show the saved synthetic contact');

  await page.evaluate(() => window.__nav('verification'));
  await page.locator('#verify-results .verify-row').filter({ hasText: syntheticDisposable }).waitFor({ timeout: 10000 });
  const evidenceInSavedRow = await page.locator('#verify-results').innerText();
  checks.edgeSavedResultShowsEvidence = evidenceInSavedRow.includes('Offline disposable-domain evidence:')
    && evidenceInSavedRow.includes('Disposable-domain match: 1secmail.com.');
  if (!checks.edgeSavedResultShowsEvidence) violations.push('Edge verification results do not show the saved pinned domain match');

  await page.locator('#verify-quick-input').fill(syntheticGmail);
  await page.locator('#verify-quick-btn').click();
  await page.locator('#verify-quick-result [data-classification-evidence]').waitFor({ timeout: 10000 }).catch(() => {});
  const quickText = await page.locator('#verify-quick-result').innerText();
  checks.edgeGmailRemainsUnknown = quickText.includes('No match in this pinned snapshot')
    && quickText.includes('does not guarantee')
    && quickText.includes('UNKNOWN')
    && !/Mailbox:\s*confirmed|recipient accepted/i.test(quickText);
  if (!checks.edgeGmailRemainsUnknown) violations.push('Edge quick result does not distinguish Gmail no-match from mailbox verification');

  const historyButton = page.getByRole('button', { name: `Verification history for ${syntheticDisposable}` });
  await historyButton.click();
  await page.locator('[data-history-entries] details summary').first().click();
  await page.locator('[data-history-entries] [data-classification-evidence]').first().waitFor({ timeout: 10000 }).catch(() => {});
  const historyText = await page.locator('[data-history-entries]').innerText();
  checks.edgeHistoryShowsEvidence = historyText.includes('Offline disposable-domain evidence:')
    && historyText.includes('Disposable-domain match: 1secmail.com.');
  if (!checks.edgeHistoryShowsEvidence) violations.push('Edge history dialog does not display the saved classification evidence');
  await page.keyboard.press('Escape');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#verify-export-btn').click();
  const download = await downloadPromise;
  const exportPath = path.join(fixtureDirectory, download.suggestedFilename());
  await download.saveAs(exportPath);
  const edgeExportRows = parseCsv(fs.readFileSync(exportPath, 'utf8'), { bom: true, columns: true });
  const edgeExported = edgeExportRows.find(row => row.email_id === String(emailRow?.id));
  let edgeChecks = {};
  try { edgeChecks = JSON.parse(edgeExported?.checks_json || '{}'); } catch { /* surfaced below */ }
  checks.edgeExportShowsEvidence = edgeChecks?.classification_evidence?.match === true;
  if (!checks.edgeExportShowsEvidence) violations.push('Edge-exported CSV omitted the pinned evidence saved by the API');

  const counts = {
    disify: countEvents('disify'),
    reacherDenied: countEvents('reacher'),
    dnsDenied: transportAttempts.filter(event => event.kind.startsWith('dns.')).length,
    socketTlsUdpDenied: transportAttempts.filter(event => /^(net|tls|udp)\./.test(event.kind)).length,
    httpRequestDenied: transportAttempts.filter(event => /^(http|https)\./.test(event.kind)).length,
    browserExternalOriginsDenied: browserDeniedOrigins.length,
    fixtureDirectory,
  };
  t.diagnostic(`strict offline integration guard counts: ${JSON.stringify(counts)}`);
  t.diagnostic(`blocked browser origins: ${JSON.stringify([...new Set(browserDeniedOrigins)])}`);
  t.diagnostic(`contract checks: ${JSON.stringify(checks)}`);
  t.diagnostic(`failed contract assertions: ${JSON.stringify(violations)}`);
  assert.deepEqual(violations, [], 'Stage B offline verification integration contract must hold');
  assert.equal(counts.disify, 0, 'production flow must never call Disify');
  assert.equal(counts.socketTlsUdpDenied, 0, 'no socket, TLS or UDP connection may be attempted');
  assert.equal(counts.httpRequestDenied, 0, 'no non-fetch HTTP(S) transport may be attempted');
  assert.deepEqual([...new Set(browserDeniedOrigins)], ['https://fonts.googleapis.com'],
    'the only browser external origin is the Google Fonts stylesheet, which Playwright aborts before egress');
});
