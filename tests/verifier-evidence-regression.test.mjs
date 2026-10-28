import { after, test } from 'node:test';
import dns from 'node:dns';
import { reacherContractFixture } from './support/reacher-contract-fixture.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import Database from 'better-sqlite3';

// Everything mutable is disposable. The only provider is this loopback HTTP fixture.
const directory = mkdtempSync(path.join(tmpdir(), 'odd-verifier-evidence-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-verifier-bootstrap-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const originalMx = dns.promises.resolveMx;
dns.promises.resolveMx = async domain => {
  if (domain === 'no-mail.test') throw Object.assign(new Error('synthetic missing domain'),{code:'ENOTFOUND'});
  assert.ok(['example.test','gmail.com'].includes(domain));
  return [{exchange:domain==='gmail.com'?'gmail-smtp-in.l.google.com':'mx.example.test',priority:10}];
};
let providerResult;
let authenticatedCookies;
let healthCode = 200;
const provider = createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(healthCode,{'content-type':'application/json'}); return res.end(JSON.stringify({version:'0.9.1'})); }
  let body = '';
  for await (const chunk of req) body += chunk;
  const { to_email } = JSON.parse(body);
  if (!to_email) {res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:'to_email field is required.'}));}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(providerResult?.(to_email) ?? observed(to_email)));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
process.env.REACHER_API_URL = `http://127.0.0.1:${provider.address().port}/v0/check_email`;

const { buildAuditResult, verifyEmail, verifyBatch, getVerificationStatus } = await import('../pipeline/email-verifier.js');
const { initDb, closeDb } = await import('../pipeline/database.js');
let db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => provider.close(resolve));
  dns.promises.resolveMx=originalMx;
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function observed(email = 'owner@example.test', changes = {}) {
  return {
    input: email, is_reachable: 'safe',
    syntax: { is_valid_syntax: true },
    mx: { accepts_mail: true, records: ['mx.example.test'] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: true, is_deliverable: true, is_catch_all: false, has_full_inbox:false, is_disabled:false },
    ...changes,
  };
}

test('missing, partial, temporary and contradictory evidence never becomes rejection or acceptance', () => {
  for (const raw of [null, {}, [], { syntax: {} }, { syntax: { is_valid_syntax: true }, mx: { error: 'timeout' } }]) {
    const result = buildAuditResult('owner@example.test', raw);
    assert.equal(result.verification_status, 'unknown');
    assert.equal(result.score, null);
    assert.notEqual(result.checks.mx, false);
    assert.equal(result.checks.disposable, true, 'the pinned offline dataset supplies an actual no-match observation');
  }
  for (const smtp of [
    { can_connect_smtp: false, is_deliverable: true, is_catch_all: false },
    { can_connect_smtp: false, is_deliverable: false, is_catch_all: false },
    { code: 451, is_deliverable: true, is_catch_all: false },
    { code: 451, is_disabled: true, is_catch_all: false },
    { code: 550, is_deliverable: true, is_catch_all: false },
    { code: 250, is_deliverable: false, is_catch_all: false },
    { code: 550, recipient_accepted: true, is_catch_all: false },
    { code: 250, is_disabled: true, is_catch_all: false },
    { code: 250, is_disabled: true, recipient_accepted: true, is_catch_all: false },
    { code: '550', is_deliverable: true, is_catch_all: false },
    { code: '550', recipient_accepted: true, is_catch_all: false },
    { code: 'garbage', is_deliverable: true, is_catch_all: false },
  ]) {
    const result = buildAuditResult('owner@example.test', observed(undefined, { smtp }));
    assert.equal(result.verification_status, 'unknown', JSON.stringify(smtp));
    assert.equal(result.checks.smtp, null);
    assert.equal(result.evidence.mailbox_status, 'unconfirmed');
    assert.notEqual(result.evidence.smtp_status, 'recipient_accepted');
    assert.notEqual(result.evidence.smtp_status, 'recipient_rejected');
  }
});

test('explicit rejection, catch-all, full inbox and role policy keep distinct meanings', () => {
  const cases = [
    [{ is_deliverable: false, can_connect_smtp: true, is_catch_all: false }, 'unknown'],
    [{ is_deliverable: true, can_connect_smtp: true, is_catch_all: true }, 'risky'],
    [{ is_deliverable: false, has_full_inbox: true, can_connect_smtp: true }, 'risky'],
    [{ is_deliverable: true, can_connect_smtp: true, is_catch_all: false }, 'unknown'],
    [{ code: '250', is_deliverable: true, can_connect_smtp: true, is_catch_all: false }, 'unknown'],
    [{ recipient_accepted: true, code: 250, can_connect_smtp: true }, 'unknown'],
  ];
  for (const [smtp, status] of cases) {
    const result = buildAuditResult('owner@example.test', observed(undefined, { smtp }));
    assert.equal(result.verification_status, status);
    assert.equal(result.evidence.smtp_status, 'unknown', 'provider booleans lack a protocol-specific local SMTP response');
    assert.notEqual(result.evidence.mailbox_status, 'confirmed');
  }
  const role = observed('sales@example.test', { misc: { is_disposable: false, is_role_account: true } });
  assert.equal(buildAuditResult('sales@example.test', role).verification_status, 'risky');
  assert.equal(buildAuditResult('sales@example.test', role, { suppress_role_accounts: true }).general.reason, 'Role account excluded by workspace policy');
});

test('malformed or mismatched provider results fall back to actual local evidence', async () => {
  for (const raw of [
    {}, [], null,
    observed('different@example.test'),
    observed(undefined, { mx: { accepts_mail: true, records: 'mx.example.test' } }),
    observed(undefined, { smtp: [] }),
  ]) {
    let dnsCalls = 0;
    const result = await verifyEmail('owner@example.test', {
      isReacherAvailableImpl: async () => true,
      reacherFetchImpl: reacherContractFixture(raw),
      resolveMxImpl: async () => { dnsCalls++; return [{ exchange: 'mx.example.test', priority: 10 }]; },
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      smtpProbeImpl: async () => ({ can_connect_smtp: false, is_deliverable: null }),
    });
    assert.equal(dnsCalls, 1);
    assert.equal(result.engine, 'local_dns', 'an invalid provider cannot enable direct SMTP implicitly');
    assert.equal(result.verification_status, 'unknown');
    assert.equal(result.checks.mx, true);
    assert.equal(result.checks.smtp, null);
  }
});

test('Gmail recognition survives unavailable SMTP without a false risk or deliverable claim', async () => {
  const result = await verifyEmail('goutamdhanani@gmail.com', {
    isReacherAvailableImpl: async () => false,
    resolveMxImpl: async () => [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }],
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
    smtpProbeImpl: async () => ({ can_connect_smtp: false, is_deliverable: null }),
  });
  assert.equal(result.mail_server.smtp_provider, 'Google');
  assert.equal(result.is_free_provider, true);
  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.evidence.mail_route, 'present');
  assert.equal(result.evidence.mailbox_status, 'unconfirmed');
});

test('normal owner login, quick verification, durable batch counts, Contacts and CSV use actual stored evidence', async () => {
  assert.equal((await fetch(`${base}/api/verify/status`)).status, 401);
  const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'verifier-owner@example.test', password: 'Fixture-verifier-password-8!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
  });
  assert.equal(bootstrap.status, 201);
  const cookies = bootstrap.headers.get('set-cookie');
  const session = cookies.match(/(?:^|,\s*)odd_session=([^;,]+)/)[1];
  const csrf = cookies.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)[1];
  authenticatedCookies = { session, csrf };
  const headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': decodeURIComponent(csrf), origin: base };
  providerResult = email => observed(email, email.startsWith('unknown') ? { mx: { error: 'dns timeout' }, smtp: {} }
    : email.startsWith('reject') ? { smtp: { can_connect_smtp: true, is_deliverable: false, is_catch_all: false } }
      : email.startsWith('role') ? { misc: { is_disposable: false, is_role_account: true } } : {});
  const quick = await fetch(`${base}/api/verify/single`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'unknown@example.test' }),
  });
  assert.equal(quick.status, 200);
  assert.equal((await quick.json()).result.verification_status, 'unknown');
  const batch = Number(db.prepare("INSERT INTO batches(name,phase) VALUES ('Verifier HTTP acceptance','verify')").run().lastInsertRowid);
  for (const name of ['unknown', 'accept', 'role', 'reject']) {
    const address = `${name}@${name === 'reject' ? 'no-mail.test' : 'example.test'}`;
    const id = Number(db.prepare("INSERT INTO leads(batch_id,business_name,email,status) VALUES (?,?,?,'discovered')").run(batch, `Fixture ${name}`, address).lastInsertRowid);
    db.prepare("INSERT INTO lead_emails(lead_id,email,source) VALUES (?,?,'fixture_observation')").run(id, address);
  }
  const sendsBefore = db.prepare('SELECT COUNT(*) AS n FROM sends').get().n;
  const progress = [];
  const run = await verifyBatch(batch, { sleepImpl: async () => {}, onProgress: state => progress.push(state) });
  assert.deepEqual([run.processed, run.deliverable, run.risky, run.undeliverable, run.unknown], [4, 0, 1, 1, 2]);
  assert.equal(progress.length, 4);
  const list = await (await fetch(`${base}/api/verify/results/${batch}`, { headers })).json();
  assert.equal(list.total, 4);
  assert.equal(list.results.find(row => row.email.startsWith('unknown')).verification_status, 'unknown');
  assert.equal(db.prepare("SELECT status FROM leads WHERE email='unknown@example.test'").get().status, 'discovered', 'per-address verification preserves the contact lifecycle');
  assert.equal(db.prepare("SELECT source FROM lead_emails WHERE email='unknown@example.test'").get().source, 'fixture_observation');
  const contacts = await fetch(`${base}/api/leads?search=Fixture`, { headers });
  assert.equal(contacts.status, 200);
  assert.match(await contacts.text(), /unknown@example.test/);
  const csv = await fetch(`${base}/api/verify/results/${batch}/export`, { headers });
  assert.equal(csv.status, 200);
  const exported = parse(await csv.text(), { bom: true, columns: true });
  assert.equal(exported.length, 4);
  assert.equal(exported.find(row => row.email === 'unknown@example.test').status, 'unknown');
  const persisted = getVerificationStatus(batch);
  assert.deepEqual([persisted.status, persisted.processed, persisted.unknown, persisted.undeliverable], ['completed', 4, 2, 1]);
  const reopened = new Database(process.env.ODD_DB_PATH, { readonly: true });
  assert.equal(reopened.prepare('SELECT processed-deliverable-risky-undeliverable AS unknown FROM verification_jobs WHERE id=?').get(run.jobId).unknown, 2);
  reopened.close();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, sendsBefore);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const batches = await (await fetch(`${base}/api/batches`, { headers })).json();
  assert.equal((Array.isArray(batches) ? batches : batches.batches).find(row => row.id === batch).lead_count, 4, 'current counts do not depend on cached lead_count writes');
});

test('browser renders saved results, inconclusive explanations and flags after reload', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await context.addCookies([
      { name: 'odd_session', value: authenticatedCookies.session, url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: authenticatedCookies.csrf, url: base, sameSite: 'Strict' },
    ]);
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#verification`, { waitUntil: 'domcontentloaded' });
    await page.locator('#verify-quick-input').waitFor();
    assert.match(await page.locator('#verify-batch-select').innerText(), /4 leads/);
    await page.locator('.verify-row').filter({ hasText: 'unknown@example.test' }).waitFor();
    await page.locator('.verify-row').filter({ hasText: 'role@example.test' }).locator('.flag-tag.role').waitFor();
    await page.locator('#verify-quick-input').fill('unknown@example.test');
    await page.locator('#verify-quick-btn').click();
    await page.getByText('This address has not been rejected.', { exact: false }).waitFor();
    assert.match(await page.locator('#verify-quick-result').innerText(), /INBOX UNCONFIRMED/);
    assert.equal(await page.locator('#verify-quick-result .status-badge').getAttribute('aria-label'), 'Verification status: unknown');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.verify-row').filter({ hasText: 'unknown@example.test' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.verify-card-count')].length === 4
      && [...document.querySelectorAll('.verify-card-count')].map(node => node.textContent).sort().join(',') === '0,1,1,2');
    assert.match(await page.locator('.verify-row').filter({ hasText: 'unknown@example.test' }).innerText(), /just now/);
    await page.getByRole('button', { name: 'Verification history for unknown@example.test', exact: true }).click();
    await page.locator('dialog[open] details summary').waitFor();
    assert.match(await page.locator('dialog[open]').innerText(), /fixture_observation/);
    await page.locator('dialog[open] details summary').click();
    await page.locator('dialog[open]').getByText('This address has not been rejected.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'orchestration/evidence/v1-verifier-browser-20261019.png', fullPage: true });
    await context.close();
  } finally { await browser.close(); }
});
