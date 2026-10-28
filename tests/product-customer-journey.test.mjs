import { seedSyntheticCampaignSendReview } from './support/reviewed-mailbox-fixture.mjs';
// A controlled customer journey, not evidence of public delivery or live lead collection.
import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';
import { parse } from 'csv-parse/sync';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-product-journey-'));
Object.assign(process.env, {
  ODD_DB_PATH: path.join(directory, 'journey.db'), NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'disposable-product-audit-owner-token-123456789',
  ODD_REPLY_INGEST_TOKEN: 'disposable-product-audit-inbound-token-123456789',
  ODD_CREDENTIAL_ENCRYPTION_KEY: '6'.repeat(64), ODD_PERSONALIZATION_BEDROCK_ENABLED: 'false',
  ODD_DISIFY_DOMAIN_CHECK: 'false',
});
const nativeResolveMx = dns.promises.resolveMx;
dns.promises.resolveMx = async domain => {
  assert.ok(['journey-buyer.test', 'unconfirmed-buyer.test'].includes(domain), 'only explicit synthetic recipient DNS may be resolved');
  return [{ priority: 10, exchange: `mx.${domain}` }];
};
const verifierCalls = [];
const provider = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/version') return res.end(JSON.stringify({ version: '0.9.1' }));
  if (req.method !== 'POST') return res.end('{}');
  let body = ''; for await (const chunk of req) body += chunk;
  const { to_email } = JSON.parse(body);
  if (!to_email) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'to_email field is required.' })); }
  verifierCalls.push(to_email);
  const accepted = to_email === 'person@journey-buyer.test';
  res.end(JSON.stringify({ input: to_email, is_reachable: accepted ? 'safe' : 'unknown', syntax: { is_valid_syntax: true },
    mx: { accepts_mail: true, records: ['mx.journey-buyer.test'] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: accepted, is_deliverable: accepted ? true : null, is_catch_all: false, has_full_inbox: false, is_disabled: false },
  }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
process.env.REACHER_API_URL = `http://127.0.0.1:${provider.address().port}/v0/check_email`;

const acceptedMessages = [];
const sink = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, done) {
    done(auth.username === 'journey' && auth.password === 'fixture-only' ? null : new Error('Fixture auth rejected'), { user: 'journey' });
  },
  onData(stream, session, done) {
    let raw = ''; stream.on('data', chunk => { raw += chunk; });
    stream.on('end', () => {
      acceptedMessages.push({ raw, recipients: session.envelope.rcptTo.map(item => item.address) });
      done(null, 'Product journey sink accepted DATA');
    });
  },
});
await new Promise((resolve, reject) => { sink.once('error', reject); sink.listen(0, '127.0.0.1', resolve); });
const database = await import('../pipeline/database.js');
let db = database.initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const base = `http://127.0.0.1:${server.address().port}`;
let headers = {};
after(async () => {
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => sink.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  database.closeDb();
  dns.promises.resolveMx = nativeResolveMx;
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});
async function request(route, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(base + route, { method, headers: { ...headers, ...extraHeaders,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let payload; try { payload = JSON.parse(text); } catch { payload = text; }
  return { status: response.status, body: payload, headers: response.headers };
}
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`Timed out waiting for ${label}`);
}

test('authenticated import → verify → list → sequence → accepted SMTP → reply stop → reload/export', async t => {
  const evidence = { startedAt: new Date().toISOString(), synthetic: true, externalMessages: 0, prerequisites: [
    'Controlled Reacher responses; no claim about any real recipient.',
    'A pre-reviewed sandbox sender and manually reviewed copy are fixture prerequisites; not live warm-up or AI proof.',
    'Unencrypted SMTP is restricted to the loopback sink in the disposable test.',
  ] };
  const anonymous = await request('/api/leads'); assert.equal(anonymous.status, 401);
  const boot = await request('/api/auth/bootstrap', 'POST', { email: 'journey-owner@example.test',
    password: 'Disposable-customer-journey-password-19!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN });
  assert.equal(boot.status, 201, JSON.stringify(boot.body));
  const session = boot.headers.get('set-cookie').match(/odd_session=([^;,]+)/)[1];
  const csrf = boot.headers.get('set-cookie').match(/odd_csrf=([^;,]+)/)[1];
  headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };
  const batch = await request('/api/batches', 'POST', { name: 'Product audit synthetic batch', phase: 'discovery' });
  assert.equal(batch.status, 201); const batchId = batch.body.id;
  const csv = 'business_name,email,city\nJourney Buyer,person@journey-buyer.test,Toronto\nUnconfirmed Buyer,person@unconfirmed-buyer.test,Ottawa\nDuplicate Buyer,PERSON@journey-buyer.test,Toronto\nInvalid Buyer,broken-address,Toronto\n';
  const imported = await request('/api/leads/import', 'POST', { batch_id: batchId, csv });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.counts, { parsed: 4, inserted: 2, duplicates: 1, invalid: 1 });
  assert.equal(verifierCalls.length, 0, 'import never performs network verification');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  const contacts = db.prepare('SELECT id,business_name,email FROM leads ORDER BY id').all();
  const buyer = contacts.find(row => row.business_name === 'Journey Buyer');
  const unknown = contacts.find(row => row.business_name === 'Unconfirmed Buyer');
  assert.ok(buyer && unknown);
  const verified = await request(`/api/verify/batch/${batchId}`, 'POST', {});
  assert.equal(verified.status, 202, JSON.stringify(verified.body));
  await until(async () => !(await request('/api/verify/status')).body.active, 'saved verification results');
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(buyer.id).verification_status, 'unknown',
    'a provider SMTP boolean never establishes mailbox confirmation');
  assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(unknown.id).verification_status, 'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_verification_history').get().n, 2);
  assert.deepEqual(verifierCalls.slice().sort(), [buyer.email, unknown.email].sort(), 'the typed loopback verifier checked both saved addresses');
  // Keep the real verification evidence unknown. The downstream sending path
  // has a separate, explicitly synthetic saved-evidence prerequisite.
  db.prepare("UPDATE lead_emails SET verification_status='deliverable',verification_json=? WHERE lead_id=?")
    .run(JSON.stringify({ engine: 'synthetic_independent_verification', verification_status: 'deliverable', synthetic: true }), buyer.id);
  evidence.prerequisites.push('Independent synthetic saved-email eligibility; the provider response remains unconfirmed.');
  const list = await request('/api/lists', 'POST', { name: 'Product audit audience' });
  assert.equal(list.status, 201);
  const members = await request(`/api/lists/${list.body.id}/members`, 'POST', { leadIds: contacts.map(row => row.id) });
  assert.equal(members.body.added, 2);
  const campaign = await request('/api/sending/campaigns', 'POST', { name: 'Product audit sequence' });
  assert.equal(campaign.status, 200); const campaignId = campaign.body.id;
  const enrolled = await request(`/api/sending/campaigns/${campaignId}/audience`, 'POST', { listId: list.body.id });
  assert.equal(enrolled.body.added, 2);
  const repeated = await request(`/api/sending/campaigns/${campaignId}/audience`, 'POST', { listId: list.body.id });
  assert.equal(repeated.body.added, 0); assert.equal(repeated.body.alreadyEnrolled, 2);
  // Existing manually reviewed copy is an explicit fixture precondition. Actual AI integration is tested separately.
  const copy = db.prepare('INSERT INTO personalizations(lead_id,subject_line,body_text,approved,guardrail_passed) VALUES (?,?,?,0,1)');
  for (const contact of contacts) {
    const copyId = copy.run(contact.id, `Reviewed introduction for ${contact.business_name}`, 'Manually reviewed fixture copy.').lastInsertRowid;
    assert.equal((await request(`/api/personalize/approve/${copyId}`, 'POST', {})).status, 200);
  }
  // This test is not an authorization shortcut: only the disposable database receives the pre-reviewed sender fixture.
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES(1,'journey-sender@example.test','example.test','eligible',50,100,1,'127.0.0.1',?,'journey','fixture-only',0)`).run(sink.server.address().port);
  seedSyntheticCampaignSendReview(db, 1);
  assert.equal((await request(`/api/sending/campaigns/${campaignId}/senders`, 'PUT', { mailboxIds: [1] })).status, 200);
  const stepIds = [];
  for (let position = 0; position < 2; position++) {
    const step = await request(`/api/sending/campaigns/${campaignId}/sequence/steps`, 'POST', position ? { delayDays: 1 } : {});
    assert.equal(step.status, 201); const stepId = step.body.steps.at(-1).id; stepIds.push(stepId);
    const saved = await request(`/api/sending/campaigns/${campaignId}/sequence/steps/${stepId}`, 'PUT', { variants: [
      { variantKey: 'A', allocationPct: 100, subjectLine: `Step ${position + 1} for {{business_name}}`, bodyText: `Hello {{business_name}}, controlled journey step ${position + 1}.` },
      { variantKey: 'B', allocationPct: 0, subjectLine: '', bodyText: '' },
    ] }); assert.equal(saved.status, 200);
  }
  const preflight = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  assert.equal(preflight.body.counts.total, 2); assert.equal(preflight.body.counts.eligible, 1);
  assert.equal(preflight.body.counts.blocked, 1, 'an unconfirmed mailbox stays visible but cannot send');
  const queued = await request(`/api/sending/queue/${campaignId}`, 'POST', { limit: 10, reviewHash: preflight.body.reviewHash });
  assert.equal(queued.status, 200, JSON.stringify(queued.body)); assert.equal(queued.body.queued, 1);
  const nextReview = await request(`/api/sending/campaigns/${campaignId}/preflight`);
  const duplicate = await request(`/api/sending/queue/${campaignId}`, 'POST', { limit: 10, reviewHash: nextReview.body.reviewHash });
  assert.equal(duplicate.body.queued, 0);
  // Only advance the synthetic clock for the already reviewed loopback send.
  db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE campaign_id=?").run(campaignId);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const browserErrors = []; const dialogs = []; const serverErrors = [];
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('response', response => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addCookies([{ name: 'odd_session', value: session, url: base, httpOnly: true, sameSite: 'Strict' }, { name: 'odd_csrf', value: csrf, url: base, sameSite: 'Strict' }]);
  try {
    await page.goto(base + '/#campaigns', { waitUntil: 'domcontentloaded' });
    const card = page.locator('.campaign-card').filter({ hasText: 'Product audit sequence' });
    await card.getByRole('button', { name: '▶ Process Queue' }).click();
    await until(() => db.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id=? AND status='sent'").get(campaignId).n === 1, 'SMTP acceptance persisted from browser action');
    assert.equal(acceptedMessages.length, 1);
    assert.deepEqual(acceptedMessages[0].recipients, ['person@journey-buyer.test']);
    assert.match(acceptedMessages[0].raw, /Step 1 for Journey Buyer/);
    assert.match(acceptedMessages[0].raw, /Hello Journey Buyer, controlled journey step 1\./);
    const sent = db.prepare("SELECT id,meta_json FROM events WHERE event_type='sent'").get();
    const transport = JSON.parse(sent.meta_json);
    assert.match(transport.response, /^250\b/); assert.match(transport.response, /Product journey sink accepted DATA/);
    assert.equal(transport.delivery, 'unknown', 'SMTP acceptance never fabricates public delivery');
    const followup = db.prepare('SELECT id,status FROM sends WHERE campaign_step_id=?').get(stepIds[1]);
    assert.equal(followup.status, 'scheduled');
    const reply = await request('/api/replies/ingest', 'POST', { fromEmail: buyer.email, toMailboxEmail: 'journey-sender@example.test',
      subject: 'Re: Step 1 for Journey Buyer', body: 'Interested, please send the details for review.',
      messageId: '<product-audit-reply@journey-buyer.test>', inReplyTo: transport.messageId },
      { authorization: `Bearer ${process.env.ODD_REPLY_INGEST_TOKEN}` });
    assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.leadId, buyer.id);
    assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled');
    db.prepare("UPDATE sends SET scheduled_at=datetime('now','-1 minute') WHERE id=?").run(followup.id);
    // A fresh worker has its own module state and SQLite connection. Do not close
    // the running web server's connection to simulate a restart.
    const restartedWorker = await new Promise((resolve, reject) => {
      let outcome;
      const worker = new Worker(new URL('./support/send-worker.mjs', import.meta.url), {
        workerData: { databasePath: process.env.ODD_DB_PATH, domainLimit: 50 },
        execArgv: ['--import', new URL('./support/loopback-only.mjs', import.meta.url).href],
      });
      worker.on('message', value => { outcome = value; }); worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve(outcome) : reject(new Error(`Restarted worker exited ${code}`)));
    });
    assert.equal(restartedWorker.processed, 0, JSON.stringify(restartedWorker));
    const reopened = new Database(process.env.ODD_DB_PATH, { readonly: true, fileMustExist: true });
    try { assert.equal(reopened.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled'); }
    finally { reopened.close(); }
    assert.equal(acceptedMessages.length, 1, 'restart and duplicate processing cannot submit a stopped follow-up');
    await page.goto(base + '/#inbox', { waitUntil: 'domcontentloaded' });
    const row = page.locator('[data-inbox-reply]').filter({ hasText: 'Journey Buyer' });
    await row.click();
    await page.locator('[data-inbox-thread]').getByText('Interested, please send the details for review.', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' }); await row.waitFor();
    assert.equal((await request('/api/stats/funnel')).body.queued, 1, 'contact workflow stages differ from send queue rows');
    assert.equal((await request('/api/sending/stats')).body.scheduled, 0);
    await page.locator('#sidebar-status').getByText('0 scheduled · workspace online', { exact: true }).waitFor({ timeout: 3000 });
    if (process.env.ODD_PRODUCT_AUDIT_EVIDENCE_DIR) {
      mkdirSync(process.env.ODD_PRODUCT_AUDIT_EVIDENCE_DIR, { recursive: true });
      await row.click();
      await page.screenshot({ path: path.join(process.env.ODD_PRODUCT_AUDIT_EVIDENCE_DIR, 'journey-inbox-desktop.png'), fullPage: false });
    }
    const listExport = await request(`/api/lists/${list.body.id}/export`);
    assert.equal(listExport.status, 200); const exportedContacts = parse(listExport.body, { columns: true, bom: true });
    assert.equal(exportedContacts.length, 2); assert.ok(exportedContacts.some(row => row.email === buyer.email));
    const verifyExport = await request(`/api/verify/results/${batchId}/export`);
    const exportedChecks = parse(verifyExport.body, { columns: true, bom: true });
    assert.deepEqual(exportedChecks.map(row => row.status).sort(), ['deliverable', 'unknown']);
    const audience = await request(`/api/sending/campaigns/${campaignId}/audience`);
    assert.equal(audience.body.counts.total, 2); assert.equal(audience.body.counts.acceptedSends, 1);
    assert.equal(audience.body.counts.byReason.stopped, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 2, 'blocked recipients are preserved');
    await page.route('**/api/sending/stats', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scheduled: null }) }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#sidebar-status').getByText('Send queue unavailable', { exact: true }).waitFor({ timeout: 3000 });
    await page.unroute('**/api/sending/stats');
    assert.deepEqual(browserErrors, []); assert.deepEqual(dialogs, []); assert.deepEqual(serverErrors, []);
    Object.assign(evidence, { endedAt: new Date().toISOString(), imported: imported.body.counts,
      savedContacts: 2, verification: { deliverable: 1, unknown: 1 },
      queuedFirstSteps: 1, duplicateQueued: 0, smtpAccepted: 1, smtpResponse: transport.response,
      publicDelivery: 'not_tested', followupStatusAfterReplyAndReopen: 'cancelled',
      listExportRows: exportedContacts.length, verificationExportRows: exportedChecks.length,
      sidebarScheduled: 0, unknownQueueDataShownAsUnavailable: true,
      browserErrors, browserDialogs: dialogs, serverErrors });
    if (process.env.ODD_PRODUCT_AUDIT_EVIDENCE_DIR) writeFileSync(path.join(process.env.ODD_PRODUCT_AUDIT_EVIDENCE_DIR, 'journey-outcomes.json'), JSON.stringify(evidence, null, 2));
    t.diagnostic(JSON.stringify(evidence));
  } finally { await context.close(); await browser.close(); }
});
