import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { SMTPServer } from 'smtp-server';
import { Worker } from 'node:worker_threads';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-guided-campaign-'));
Object.assign(process.env, {
  ODD_DB_PATH: path.join(directory, 'workspace.db'), NODE_ENV: 'test', PORT: '0', HOST: '127.0.0.1',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'guided-campaign-synthetic-owner-token-2026',
  ODD_REPLY_INGEST_TOKEN: 'guided-campaign-synthetic-reply-token-2026',
  ODD_CREDENTIAL_ENCRYPTION_KEY: '8'.repeat(64), ODD_PERSONALIZATION_BEDROCK_ENABLED: 'false',
});
delete process.env.ODD_PUBLIC_BASE_URL; delete process.env.APP_URL;
const allowedPorts = new Set();
const local = host => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
const blocked = host => { const error = Object.assign(new Error(`Guided journey blocked non-fixture network destination: ${host}`), { code: 'GUIDED_JOURNEY_EGRESS_BLOCKED' }); outcomes.blockedNodeEgress.push(host); return error; };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!local(url.hostname) || !allowedPorts.has(port)) return Promise.reject(blocked(`${url.hostname}:${port}`));
  return nativeFetch(input, options);
};
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first
    : typeof first === 'number' ? { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }
      : { path: first };
  if (!options.path) {
    const host = options.host || 'localhost';
    if (!local(host) || !allowedPorts.has(Number(options.port))) throw blocked(`${host}:${options.port}`);
  }
  return Reflect.apply(nativeConnect, this, args);
};
const nativeLookup = dns.lookup;
dns.lookup = function(hostname, ...args) {
  if (!local(hostname)) throw blocked(hostname);
  return Reflect.apply(nativeLookup, this, [hostname, ...args]);
};
const originalResolveMx = dns.promises.resolveMx;
dns.promises.resolveMx = async domain => {
  assert.equal(domain, 'recipient.test', 'only synthetic recipient DNS is resolved');
  return [{ exchange: 'mx.synthetic.test', priority: 10 }];
};
syncBuiltinESMExports();

const reacherCalls = [];
const reacherRequestEvidence = [];
const reacher = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let email = ''; try { email = JSON.parse(raw).to_email || ''; } catch { /* malformed requests remain non-deliverable */ }
  reacherRequestEvidence.push({ method: req.method, path: req.url, keys: (() => { try { return Object.keys(JSON.parse(raw)); } catch { return []; } })() });
  if (email) reacherCalls.push(email);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/version') return res.end(JSON.stringify({version:'0.9.1'}));
  if (!email) { res.statusCode=400; return res.end(JSON.stringify({error:'to_email field is required.'})); }
  res.end(JSON.stringify({ input: email, is_reachable:'safe', syntax: { is_valid_syntax: true }, mx: { accepts_mail: true, records: ['mx.synthetic.test'] },
    misc: { is_disposable: false, is_role_account: false }, smtp: { can_connect_smtp: true, is_deliverable: true, is_catch_all: false, has_full_inbox:false, is_disabled:false } }));
});
await new Promise((resolve, reject) => { reacher.once('error', reject); reacher.listen(0, '127.0.0.1', resolve); });
allowedPorts.add(reacher.address().port);
process.env.REACHER_API_URL = `http://127.0.0.1:${reacher.address().port}/v0/check_email`;

const acceptedMessages = [];
const smtp = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
  onAuth(auth, _session, done) { done(auth.username === 'fixture' && auth.password === 'fixture-only' ? null : new Error('fixture credentials rejected'), { user: 'fixture' }); },
  onData(stream, session, done) { let raw = ''; stream.on('data', chunk => { raw += chunk; }); stream.on('end', () => { acceptedMessages.push({ raw, recipients: session.envelope.rcptTo.map(row => row.address) }); done(null, 'GUIDED-CAMPAIGN-001 loopback sink accepted DATA'); }); },
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
allowedPorts.add(smtp.server.address().port);

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
allowedPorts.add(server.address().port);
let headers = {};
const outcomes = { browserExternalRequests: [], blockedNodeEgress: [], apiFailures: [], screenshots: [], synthetic: true,
  constraints: ['Normal owner session and CSRF', 'Disposable SQLite only', 'Only this test Reacher, app HTTP and SMTP sink ports are allowed',
    'AI provider probe is denied by the egress guard; Bedrock is explicitly disabled', 'No external recipient, provider, paid request or live database'] };

after(async () => {
  dns.promises.resolveMx = originalResolveMx;
  server.closeAllConnections?.();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => smtp.close(resolve)), new Promise(resolve => reacher.close(resolve))]);
  closeDb(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function request(route, method = 'GET', body, extra = {}) {
  const response = await nativeFetch(base + route, { method, headers: { ...headers, ...extra,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let payload; try { payload = JSON.parse(text); } catch { payload = text; }
  if (response.status >= 500) outcomes.apiFailures.push({ route, status: response.status, payload });
  return { status: response.status, body: payload, headers: response.headers };
}
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`Timed out waiting for ${label}`);
}

test('real Edge creates and resumes a saved campaign through reviewed loopback SMTP acceptance and reply stop', async t => {
  assert.ok(fs.existsSync(EDGE_PATH), `Installed Edge is required: ${EDGE_PATH}`);
  const boot = await request('/api/auth/bootstrap', 'POST', { email: 'guided-owner@example.test', password: 'Disposable-guided-owner-password-2026!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN });
  assert.equal(boot.status, 201, JSON.stringify(boot.body));
  const session = boot.headers.get('set-cookie').match(/odd_session=([^;,]+)/)[1];
  const csrf = boot.headers.get('set-cookie').match(/odd_csrf=([^;,]+)/)[1];
  headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };
  assert.equal((await request('/api/auth/status')).body.user.role, 'owner');

  const batch = await request('/api/batches', 'POST', { name: 'GUIDED-CAMPAIGN-001 synthetic import', phase: 'discovery' });
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  const imported = await request('/api/leads/import', 'POST', { batch_id: batch.body.id,
    csv: 'business_name,email,city\nGuided Journey Buyer,journey@recipient.test,Test City\n' });
  assert.equal(imported.status, 200, JSON.stringify(imported.body)); assert.equal(imported.body.counts.inserted, 1);
  const lead = (await request('/api/leads?search=Guided%20Journey%20Buyer')).body.leads[0];
  const unknownImport = await request('/api/leads/import', 'POST', { batch_id: batch.body.id,
    csv: 'business_name,email,city\nUnverified Journey Contact,unverified@recipient.test,Test City\n' });
  assert.equal(unknownImport.status, 200, JSON.stringify(unknownImport.body)); assert.equal(unknownImport.body.counts.inserted, 1);
  const unknownLead = (await request('/api/leads?search=Unverified%20Journey%20Contact')).body.leads[0];
  const list = await request('/api/lists', 'POST', { name: 'GUIDED-CAMPAIGN-001 real API audience' });
  assert.equal(list.status, 201, JSON.stringify(list.body));
  const member = await request(`/api/lists/${list.body.id}/members`, 'POST', { leadIds: [lead.id, unknownLead.id] });
  assert.equal(member.status, 200, JSON.stringify(member.body)); assert.equal(member.body.added, 2);

  // The only fixture-only sender mutation is a pre-reviewed loopback mailbox.
  db.prepare(`INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,health_score,active,smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure)
    VALUES(1,'guided-sender@example.test','example.test','eligible',50,100,1,'127.0.0.1',?,'fixture','fixture-only',0)`).run(smtp.server.address().port);
  db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_at)
    VALUES(1,'approved','smtp-imap-source-evidence-v2','{"fixture":"pre_reviewed_loopback_only_sender"}',datetime('now'))`).run();

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  const page = await context.newPage(); const pageErrors = []; const serverErrors = []; const draftResponses = []; const apiClientErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${pathname}`);
    if (response.status() >= 400) apiClientErrors.push({ status: response.status(), pathname });
  });
  page.on('response', async response => {
    if (new URL(response.url()).pathname.includes('/draft')) {
      let payload = null; try { payload = await response.json(); } catch { /* retain status even for non-JSON responses */ }
      draftResponses.push({ status: response.status(), payload });
    }
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    outcomes.browserExternalRequests.push(url.origin); return route.abort();
  });
  await context.addCookies([{ name: 'odd_session', value: session, url: base, httpOnly: true, sameSite: 'Strict' }, { name: 'odd_csrf', value: csrf, url: base, sameSite: 'Strict' }]);
  try {
    await page.goto(`${base}/#campaigns`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-campaign-create]').waitFor();
    await page.locator('[data-campaign-create]').click();
    await page.locator('.studio-prompt-dialog [name="value"]').fill('GUIDED-CAMPAIGN-001 real journey');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await page.locator('[data-campaign-workspace]').getByRole('heading', { name: 'GUIDED-CAMPAIGN-001 real journey' }).waitFor({ timeout: 20000 });
    assert.equal(await page.locator('[data-campaign-overview]').isVisible(), false, 'opening a campaign hides the overview so the workspace is the primary view');
    assert.equal(await page.locator('[data-campaign-workspace]').isVisible(), true);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[data-campaign-workspace]'))), true, 'opening focuses the workspace for keyboard users');
    const campaignId = Number(new URL(page.url()).searchParams.get('campaign'));
    assert.ok(Number.isSafeInteger(campaignId) && campaignId > 0); outcomes.campaignId = campaignId;

    await page.locator(`[data-cw-audience="${campaignId}"]`).click();
    await page.locator('[data-audience-add]').click();
    await page.locator('#campaign-list-select').selectOption(String(list.body.id));
    await page.getByRole('button', { name: 'Enroll contacts' }).click();
    await until(() => db.prepare('SELECT COUNT(*) AS n FROM campaign_enrollments WHERE campaign_id=?').get(campaignId).n === 2, 'saved list enrollment persisted');
    outcomes.enrolled = db.prepare('SELECT COUNT(*) AS n FROM campaign_enrollments WHERE campaign_id=?').get(campaignId).n;

    await page.locator('[data-cw-step="review"]').click();
    const reviewCard = page.locator('[data-cw-contact]').filter({ hasText: 'journey@recipient.test' });
    assert.match(await page.locator(`[data-cw-contact="${unknownLead.id}"]`).innerText(), /Needs email verification/);
    assert.equal(await page.locator('[data-cw-step="review"]').evaluate(node => node.classList.contains('is-done')), false, 'unverified recipient keeps the review step incomplete');
    await reviewCard.locator('[data-cw-verify]').click();
    await page.getByText('Reverification requested for the saved primary email.').waitFor({ timeout: 10000 }).catch(() => {});
    await until(() => {
      const saved = db.prepare("SELECT verification_status,verification_json FROM lead_emails WHERE lead_id=? AND is_primary=1").get(lead.id);
      return saved?.verification_status === 'unknown' && JSON.parse(saved.verification_json || '{}').engine === 'reacher_api';
    }, 'controlled saved-email evidence remains unconfirmed');
    assert.deepEqual(reacherCalls, ['journey@recipient.test']);
    outcomes.reacherRequests = reacherRequestEvidence;
    outcomes.verification = 'Reacher safe response remains unconfirmed; an independent synthetic verification fixture supplies sending eligibility below';
    // This disposable test now separates the evidence policy from downstream
    // sending. A provider label never promotes a real address to deliverable.
    db.prepare("UPDATE lead_emails SET verification_status='deliverable',verification_json=? WHERE lead_id=? AND is_primary=1")
      .run(JSON.stringify({engine:'synthetic_independent_verification',verification_status:'deliverable',synthetic:true}),lead.id);
    await page.evaluate(() => window.__refreshCampaignWorkspace());
    await reviewCard.locator('[data-cw-subject]').waitFor();

    const subject = 'A practical question about your outreach workflow';
    const body = 'Hello Guided Journey Buyer, I am reaching out to ask how your team currently handles new business conversations. If this is relevant, I can share a short outline for a simple review of the process and the steps that take the most time. Would a brief conversation next week be useful? If another person owns this area, please point me in the right direction. Thanks for considering it, and no worries if now is not the right time.';
    await reviewCard.locator('[data-cw-subject]').fill(subject);
    await reviewCard.locator('[data-cw-body]').fill(body);
    await reviewCard.getByRole('button', { name: 'Save new version' }).click();
    await until(async () => db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(lead.id).n === 1 || Boolean((await reviewCard.locator('[data-cw-copy-status]').textContent().catch(() => '')).trim()), 'first manual copy append response', 15000);
    const appendedCount = db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(lead.id).n;
    assert.equal(appendedCount, 1, `First manual copy was rejected. API=${JSON.stringify(draftResponses)} clientErrors=${JSON.stringify(apiClientErrors)} UI=${await reviewCard.locator('[data-cw-copy-status]').textContent()}`);
    let personalization = db.prepare('SELECT * FROM personalizations WHERE lead_id=? ORDER BY id DESC').get(lead.id);
    assert.equal(personalization.model_used, 'manual'); assert.equal(personalization.approved, 0); assert.equal(personalization.fact_check_status, 'unavailable');
    outcomes.firstManualCopy = { id: personalization.id, guardrailPassed: personalization.guardrail_passed === 1, approvedBeforeReview: false };
    assert.equal(personalization.guardrail_passed, 1, `Guardrails blocked fixture copy: ${personalization.subject_line}`);
    await reviewCard.getByRole('button', { name: 'Approve this version' }).click();
    await until(() => db.prepare('SELECT approved FROM personalizations WHERE id=?').get(personalization.id).approved === 1, 'separate explicit copy approval');
    outcomes.copyApprovedSeparately = true;

    await page.locator('[data-cw-step="sequence"]').click();
    await page.locator('[data-cw-sequence]').click();
    await page.locator('[data-sequence-add]').waitFor({ timeout: 10000 });
    await page.locator('[data-sequence-add]').click();
    let step = page.locator('[data-sequence-step]').first();
    await step.locator('[data-sequence-variant="A"] [data-sequence-allocation]').fill('100');
    await step.locator('[data-sequence-variant="A"] [data-sequence-subject]').fill('Following up about {{business_name}}');
    await step.locator('[data-sequence-variant="A"] [data-sequence-body]').fill('Hello {{business_name}}, this is a short follow-up to my earlier note. If it helps, I can send a compact checklist for reviewing the current process. Please let me know whether that would be useful.');
    await step.locator('[data-sequence-variant="B"] [data-sequence-allocation]').fill('0');
    await step.locator('[data-sequence-save]').click();
    await page.locator('[data-sequence-step]').count().then(async count => { if (count < 2) { await page.locator('[data-sequence-add]').click(); } });
    await until(async () => await page.locator('[data-sequence-step]').count() >= 2 || apiClientErrors.length > 0, 'second sequence step editor or API response', 12000);
    assert.ok(await page.locator('[data-sequence-step]').count() >= 2, `Second sequence step was not added. API errors=${JSON.stringify(apiClientErrors)} notices=${await page.locator('[role="status"], .toast, [role="alert"]').allTextContents()}`);
    step = page.locator('[data-sequence-step]').nth(1);
    await step.locator('[data-sequence-variant="A"] [data-sequence-allocation]').fill('100');
    await step.locator('[data-sequence-variant="A"] [data-sequence-subject]').fill('One last note about {{business_name}}');
    await step.locator('[data-sequence-variant="A"] [data-sequence-body]').fill('Hello {{business_name}}, I will close the loop after this note. If a brief process outline would be useful later, you can reply and I will share one. If it is not a fit, no response is needed.');
    await step.locator('[data-sequence-variant="B"] [data-sequence-allocation]').fill('0');
    await step.locator('[data-sequence-save]').click();
    await page.locator('[data-sequence-preview-contact]').selectOption(String(lead.id));
    await page.locator('[data-sequence-preview]').click();
    await page.locator('.campaign-sequence-preview-result').waitFor({ timeout: 10000 });
    outcomes.sequencePreview = await page.locator('.campaign-sequence-preview-result').innerText();
    assert.match(outcomes.sequencePreview, /Following up about Guided Journey Buyer/);
    assert.match(await page.locator('[data-cw-content], .cw-content').innerText(), /Sequence controls sent messages/);

    await page.locator('[data-cw-step="ready"]').click();
    await page.locator('[data-cw-preflight]').click();
    const firstReview = page.locator('dialog[open]');
    await firstReview.getByText(/Queueing is blocked until/).waitFor({ timeout: 10000 }).catch(() => {});
    const initialBlockers = await firstReview.locator('.campaign-preflight-section.is-blocked').innerText().catch(() => 'No blocked section rendered');
    assert.match(initialBlockers, /block|sequence|sender|compliance/i);
    outcomes.initialPreflightBlockers = initialBlockers;
    await firstReview.locator('[data-close]').first().click();
    await page.locator('[data-cw-step="senders"]').click();
    assert.match(await page.locator('.cw-shared-schedule').innerText(), /applies across campaigns/i);
    await page.locator('[data-cw-senders]').click();
    await page.locator('.studio-dialog input[name="mailboxId"]').check();
    await page.getByRole('button', { name: 'Save sender pool' }).click();
    await until(() => db.prepare('SELECT COUNT(*) AS n FROM campaign_senders WHERE campaign_id=?').get(campaignId).n === 1, 'sender pool saved through UI');
    outcomes.senderPoolSaved = true;
    await page.locator('[data-cw-step="ready"]').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-campaign-workspace]').getByRole('heading', { name: 'GUIDED-CAMPAIGN-001 real journey' }).waitFor({ timeout: 20000 });
    assert.equal(new URL(page.url()).searchParams.get('campaign'), String(campaignId));
    assert.equal(await page.locator('[data-campaign-overview]').isVisible(), false, 'reloading a selected campaign resumes the focused workspace view');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[data-campaign-workspace]'))), true);
    outcomes.reloadResumedCanonicalCampaign = true;
    const evidenceDir = path.resolve('orchestration/evidence/GUIDED-CAMPAIGN-001-UI');
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, 'guided-campaign-desktop.png'), fullPage: true }); outcomes.screenshots.push('guided-campaign-desktop.png');

    await page.locator('[data-cw-preflight]').click();
    await page.locator('dialog[open] .campaign-preflight-hash').waitFor({ timeout: 10000 });
    const finalReview = page.locator('dialog[open]');
    const finalReviewText = await finalReview.innerText();
    assert.match(finalReviewText.replace(/\s+/g, ' '), /1 eligible/); assert.match(finalReviewText.replace(/\s+/g, ' '), /1 blocked/);
    outcomes.authoritativePreflight = finalReviewText.slice(0, 1800);
    await finalReview.locator('input[name="limit"]').fill('1');
    await finalReview.getByRole('button', { name: 'Queue reviewed recipients' }).click();
    await until(() => db.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id=? AND status='scheduled'").get(campaignId).n === 1, 'explicit reviewed queue submission');
    outcomes.queued = true;
    await page.locator('[data-cw-process]').click();
    await until(() => db.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id=? AND status='sent'").get(campaignId).n === 1, 'explicit process request and SMTP sink acceptance');
    assert.equal(acceptedMessages.length, 1); assert.deepEqual(acceptedMessages[0].recipients, ['journey@recipient.test']);
    assert.match(acceptedMessages[0].raw, /Following up about Guided Journey Buyer/);
    const sentEvent = db.prepare("SELECT meta_json FROM events WHERE event_type='sent' AND send_id IN (SELECT id FROM sends WHERE campaign_id=?) ORDER BY id DESC LIMIT 1").get(campaignId);
    const sentEvidence = JSON.parse(sentEvent.meta_json); assert.match(sentEvidence.response, /^250\b/); assert.equal(sentEvidence.smtp_acceptance, 'confirmed');
    outcomes.smtpAcceptedData = { recipients: acceptedMessages[0].recipients, response: sentEvidence.response, messageId: sentEvidence.messageId };

    const followup = db.prepare("SELECT id,status FROM sends WHERE campaign_id=? AND campaign_step_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(campaignId);
    assert.ok(followup, 'sequence created follow-up send after SMTP acceptance');
    const reply = await request('/api/replies/ingest', 'POST', { fromEmail: 'journey@recipient.test', toMailboxEmail: 'guided-sender@example.test',
      subject: 'Re: Following up about Guided Journey Buyer', body: 'Thanks, please share the outline.', messageId: '<guided-reply@recipient.test>',
      inReplyTo: sentEvidence.messageId }, { authorization: `Bearer ${process.env.ODD_REPLY_INGEST_TOKEN}` });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    await until(() => db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status === 'cancelled', 'reply stops follow-up');
    const workerResult = await new Promise((resolve, reject) => {
      let result; const worker = new Worker(new URL('./support/send-worker.mjs', import.meta.url), {
        workerData: { databasePath: process.env.ODD_DB_PATH, domainLimit: 50 },
        execArgv: ['--import', new URL('./support/loopback-only.mjs', import.meta.url).href],
      });
      worker.on('message', value => { result = value; }); worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve(result) : reject(new Error(`Fresh worker exited ${code}`)));
    });
    assert.equal(workerResult.processed, 0); assert.equal(db.prepare('SELECT status FROM sends WHERE id=?').get(followup.id).status, 'cancelled');
    assert.equal(acceptedMessages.length, 1, 'fresh worker did not submit any follow-up after the reply');
    outcomes.replyAndFreshWorker = { replyStatus: reply.status, followupStatus: 'cancelled', freshWorkerProcessed: workerResult.processed, acceptedMessagesAfterWorker: acceptedMessages.length };

    await page.locator('[data-cw-step="activity"]').click();
    await page.locator('[data-cw-timeline] .cw-timeline').waitFor({ timeout: 10000 });
    assert.match(await page.locator('[data-cw-timeline]').innerText(), /1 SMTP accepted/);
    await page.getByRole('link', { name: 'Open workspace Inbox' }).click();
    await page.locator('[data-inbox-reply]').filter({ hasText: 'Guided Journey Buyer' }).waitFor({ timeout: 10000 });
    await page.locator('[data-inbox-reply]').first().click();
    await page.locator('[data-inbox-thread]').getByText('Thanks, please share the outline.', { exact: true }).waitFor();
    outcomes.inboxReplyRendered = true;

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${base}/?campaign=${campaignId}&step=review#campaigns`, { waitUntil: 'domcontentloaded' });
    await page.locator('.cw-review-card').first().waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(evidenceDir, 'guided-campaign-320-review.png'), fullPage: true }); outcomes.screenshots.push('guided-campaign-320-review.png');
    const headerBounds = await page.locator('.cw-heading').evaluate(node => {
      const title = node.querySelector('h1').getBoundingClientRect(); const button = node.querySelector('button').getBoundingClientRect();
      return { titleBottom: title.bottom, buttonTop: button.top };
    });
    assert.ok(headerBounds.titleBottom <= headerBounds.buttonTop, `320px workspace title overlaps its return button: ${JSON.stringify(headerBounds)}`);
    await page.locator('[data-cw-save-copy]').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidenceDir, 'guided-campaign-320-review-actions.png') }); outcomes.screenshots.push('guided-campaign-320-review-actions.png');
    const layout = await page.locator('.cw-content').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `320px campaign review overflows: ${JSON.stringify(layout)}`);
    outcomes.mobileLayout = layout;

    const raceCampaign = await request('/api/sending/campaigns', 'POST', { name: 'GUIDED-CAMPAIGN-001 selection race target' });
    assert.equal(raceCampaign.status, 200, JSON.stringify(raceCampaign.body));
    await page.goto(`${base}/#campaigns`, { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-campaign-workspace-open="${campaignId}"]`).click();
    await page.locator('[data-campaign-workspace]').getByRole('heading', { name: 'GUIDED-CAMPAIGN-001 real journey' }).waitFor();
    await page.locator('[data-cw-step="review"]').click();
    let releaseLeadRead; let signalLeadRead;
    const leadReadStarted = new Promise(resolve => { signalLeadRead = resolve; });
    const heldLeadRead = new Promise(resolve => { releaseLeadRead = resolve; });
    const verifyPostRequests = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/verify/email/')) verifyPostRequests.push(new URL(request.url()).pathname);
    });
    const leadUrl = `${base}/api/leads/${lead.id}`;
    await page.route(leadUrl, async route => {
      if (route.request().method() === 'GET') { signalLeadRead(); await heldLeadRead; }
      await route.continue();
    });
    try {
      await page.locator(`[data-cw-contact="${lead.id}"] [data-cw-verify]`).click();
      let leadReadTimeout;
      try {
        await Promise.race([leadReadStarted, new Promise((_, reject) => { leadReadTimeout = setTimeout(() => reject(new Error('Saved-contact request did not reach the selection-race gate.')), 8000); })]);
      } finally { clearTimeout(leadReadTimeout); }
      await page.locator('[data-cw-close]').click();
      await page.locator(`[data-campaign-workspace-open="${raceCampaign.body.id}"]`).click();
      await page.locator('[data-campaign-workspace]').getByRole('heading', { name: 'GUIDED-CAMPAIGN-001 selection race target' }).waitFor();
      const leadReadResponse = page.waitForResponse(response => response.url() === leadUrl, { timeout: 8000 });
      releaseLeadRead();
      await leadReadResponse;
      assert.deepEqual(verifyPostRequests, [], 'switching campaigns during contact load must prevent a stale reverify mutation');
      outcomes.selectionRace = { heldRequest: `/api/leads/${lead.id}`, switchedToCampaignId: raceCampaign.body.id, staleVerifyPosts: verifyPostRequests.length };
      await page.locator('[data-cw-close]').click();
      assert.equal(await page.locator('[data-campaign-overview]').isVisible(), true, 'All campaigns returns to the overview');
      assert.equal(await page.locator('[data-campaign-workspace]').isVisible(), false);
      assert.equal(new URL(page.url()).searchParams.has('campaign'), false);
    } finally {
      releaseLeadRead();
      await page.unroute(leadUrl);
    }

    assert.deepEqual(pageErrors, []); assert.deepEqual(serverErrors, []);
    const unexpectedExternalOrigins = outcomes.browserExternalRequests.filter(origin => origin !== 'https://fonts.googleapis.com');
    assert.deepEqual(unexpectedExternalOrigins, [], `Unexpected browser egress attempts were denied: ${JSON.stringify(unexpectedExternalOrigins)}`);
    outcomes.browserExternalRequestsDenied = [...new Set(outcomes.browserExternalRequests)];
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(lead.id).n, 1, 'journey used real first copy append, not a seeded personalization');
    outcomes.endedAt = new Date().toISOString(); outcomes.pageErrors = pageErrors; outcomes.serverErrors = serverErrors;
    outcomes.ollamaProbe = outcomes.blockedNodeEgress.includes('localhost:11434') || outcomes.blockedNodeEgress.includes('127.0.0.1:11434')
      ? 'Configured localhost AI probe was rejected before network connection by the exact fixture-port allowlist; Bedrock was disabled.'
      : 'No AI/provider network call occurred during this journey; Bedrock was disabled and browser requests were blocked outside the local app origin.';
    const evidencePath = path.join(evidenceDir, 'guided-campaign-journey.json'); fs.writeFileSync(evidencePath, JSON.stringify(outcomes, null, 2));
    t.diagnostic(JSON.stringify(outcomes));
  } finally { await context.close(); await browser.close(); }
});
