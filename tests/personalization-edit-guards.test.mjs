import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-personalization-edit-'));
const evidenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../orchestration/evidence/COPY-EDIT-GUARDS-001');
fs.mkdirSync(evidenceDir, { recursive: true });
const transportEvidence = { backendDenied: [], socketDenied: [], dnsDenied: [], browserDenied: [], pageErrors: [] };
Object.assign(process.env, {
  NODE_ENV: 'test', ODD_DB_PATH: path.join(directory, 'edit-guards.db'), PORT: '0', HOST: '127.0.0.1',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'edit-guards-disposable-bootstrap-token-123456789',
  ODD_CREDENTIAL_ENCRYPTION_KEY: '8'.repeat(64),
});
delete process.env.ODD_PUBLIC_BASE_URL;
delete process.env.APP_URL;

// Install fail-closed Node transport guards before importing the app. Only the
// literal ephemeral API listener is allowed; test API calls use captured fetch
// after checking that exact origin. Provider probes are recorded and denied.
const nativeFetch = globalThis.fetch;
const dnsNames = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt', 'resolveNs', 'resolveCname', 'reverse'];
const nativeDns = Object.fromEntries(dnsNames.map(name => [name, dns[name]]));
const nativeDnsPromises = Object.fromEntries(dnsNames.map(name => [name, dnsPromises[name]]));
let apiPort = -1;
const denied = (kind, target) => {
  transportEvidence[kind].push(String(target));
  return Object.assign(new Error(`Edit-guard fixture denied ${kind}: ${String(target)}`), { code: 'EDIT_GUARD_EGRESS_BLOCKED' });
};
globalThis.fetch = input => Promise.reject(denied('backendDenied', input instanceof Request ? input.url : String(input)));
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === 'object'
    ? first
    : typeof first === 'number' ? { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' }
      : { path: first };
  if (options.path || Number(options.port) !== apiPort || !['127.0.0.1', '::ffff:127.0.0.1'].includes(options.host)) {
    throw denied('socketDenied', options.path || `${options.host || 'unknown'}:${options.port || 'unknown'}`);
  }
  return Reflect.apply(nativeConnect, this, args);
};
for (const name of dnsNames) {
  if (typeof dns[name] === 'function') dns[name] = function(hostname, ...args) {
    const callback = args.find(value => typeof value === 'function');
    if (name === 'lookup' && hostname === '127.0.0.1' && callback) {
      const options = args.find(value => value && typeof value === 'object') || {};
      return queueMicrotask(() => options.all
        ? callback(null, [{ address: '127.0.0.1', family: 4 }])
        : callback(null, '127.0.0.1', 4));
    }
    const error = denied('dnsDenied', `${name}:${hostname}`);
    if (callback) return queueMicrotask(() => callback(error));
    throw error;
  };
  if (typeof dnsPromises[name] === 'function') dnsPromises[name] = async function(hostname, ...args) {
    if (name === 'lookup' && hostname === '127.0.0.1') {
      const options = args.find(value => value && typeof value === 'object') || {};
      return options.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 };
    }
    throw denied('dnsDenied', `promise ${name}:${hostname}`);
  };
}
syncBuiltinESMExports();

const personalizer = await import('../pipeline/personalizer.js');
const personalizationConfig = JSON.parse(fs.readFileSync(new URL('../config/personalization.json', import.meta.url), 'utf8'));
personalizationConfig.bedrock = { ...personalizationConfig.bedrock, enabled: false };
await personalizer.setPersonalizationTestAdapters({ config: personalizationConfig });
const database = await import('../pipeline/database.js');
const db = database.initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
apiPort = server.address().port;
const base = `http://127.0.0.1:${apiPort}`;
let headers = {};

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  globalThis.fetch = nativeFetch;
  net.Socket.prototype.connect = nativeConnect;
  for (const name of dnsNames) {
    if (nativeDns[name]) dns[name] = nativeDns[name];
    if (nativeDnsPromises[name]) dnsPromises[name] = nativeDnsPromises[name];
  }
  syncBuiltinESMExports();
  // Keep the disposable database as the evidence fixture; no cleanup deletes.
});

async function request(route, method = 'GET', body, authenticated = true) {
  const target = new URL(route, base);
  if (target.origin !== base || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || Number(target.port) !== apiPort) {
    throw new Error(`Invalid fixture API target: ${target.href}`);
  }
  const response = await nativeFetch(target, {
    method,
    headers: {
      ...(authenticated ? headers : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(error => { console.error('Fixture fetch', error.cause, transportEvidence); throw error; });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const boot = await request('/api/auth/bootstrap', 'POST', {
  email: 'edit-guards-owner@example.test', password: 'Disposable-edit-guards-password-42!',
  bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
});
assert.equal(boot.status, 201, JSON.stringify(boot.body));
const session = boot.headers.get('set-cookie').match(/odd_session=([^;,]+)/)[1];
const csrf = boot.headers.get('set-cookie').match(/odd_csrf=([^;,]+)/)[1];
headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };

const validBody = 'Hello Fixture Workshop, I saw your neighborhood bakery and wanted to ask about the way customers find your menu online. A clearer page could make ordering easier for nearby families. Would a short outline be useful for your team this month?';
function fixture() {
  const leadId = Number(db.prepare("INSERT INTO leads(business_name,status) VALUES ('Fixture Workshop','awaiting_approval')").run().lastInsertRowid);
  const personalizationId = Number(db.prepare(`INSERT INTO personalizations
    (lead_id,subject_line,body_text,guardrail_passed,fact_check_passed,fact_check_status,approved)
    VALUES (?, 'A note for Fixture Workshop', ?, 1, 1, 'passed', 1)`).run(leadId, validBody).lastInsertRowid);
  return { leadId, personalizationId, route: `/api/personalize/${personalizationId}` };
}

function saved(f) {
  return db.prepare('SELECT * FROM personalizations WHERE id=?').get(f.personalizationId);
}

test('too-short and missing-reference edits recompute guardrails and clear old approval/fact state', async () => {
  for (const badBody of ['Fixture Workshop short.', validBody.replaceAll('Fixture Workshop', 'our local shop')]) {
    const f = fixture();
    const response = await request(f.route, 'PATCH', { body_text: badBody });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.guardrailPassed, false);
    assert.equal(response.body.approved, false);
    assert.equal(response.body.fact_check_status, 'unavailable');
    const failures = response.body.guardrailFailures;
    assert.ok(failures.includes(badBody.length < 40 ? 'body_too_short:3_words' : 'missing_business_name_reference'), failures.join(','));
    const row = saved(f);
    assert.equal(row.guardrail_passed, 0);
    assert.equal(row.approved, 0);
    assert.equal(row.fact_check_passed, 0);
    assert.equal(row.fact_check_status, 'unavailable');

    // An explicit legacy approval can set only approval; it cannot turn the
    // failed, current copy into guardrail-passed evidence.
    const email = `fixture-${f.leadId}@example.test`;
    db.prepare('UPDATE leads SET email=? WHERE id=?').run(email, f.leadId);
    db.prepare("INSERT INTO lead_emails(lead_id,email,is_primary,verification_status) VALUES (?, ?, 1, 'deliverable')").run(f.leadId, email);
    const campaignId = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES ('Edit guard eligibility fixture','draft')").run().lastInsertRowid);
    db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, f.leadId);
    const approval = await request(`/api/personalize/approve/${f.personalizationId}`, 'POST', {});
    assert.equal(approval.status, 200);
    assert.equal(saved(f).approved, 1);
    assert.equal(saved(f).guardrail_passed, 0);
    assert.equal(saved(f).fact_check_status, 'unavailable');
    const audience = await request(`/api/sending/campaigns/${campaignId}/audience`);
    assert.equal(audience.status, 200, JSON.stringify(audience.body));
    assert.equal(audience.body.items[0].eligibility, 'copy_review_required');
  }
});

test('valid correction passes rule checks but remains unapproved with fact check unavailable', async () => {
  const f = fixture();
  const bad = await request(f.route, 'PATCH', { body_text: 'Fixture Workshop short.' });
  assert.equal(bad.body.guardrailPassed, false);
  const corrected = await request(f.route, 'PATCH', { body_text: validBody });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.guardrailPassed, true);
  assert.deepEqual(corrected.body.guardrailFailures, []);
  assert.equal(corrected.body.approved, false);
  assert.equal(corrected.body.fact_check_status, 'unavailable');
  assert.equal(saved(f).guardrail_passed, 1);
  assert.equal(saved(f).approved, 0);
  assert.equal(saved(f).fact_check_passed, 0);
  assert.equal(saved(f).fact_check_status, 'unavailable');
});

test('partial subject edit validates the retained body; no-op and invalid input preserve all state', async () => {
  const f = fixture();
  const partial = await request(f.route, 'PATCH', { subject_line: 'A revised subject' });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.guardrailPassed, true);
  assert.equal(saved(f).body_text, validBody);
  const beforeNoop = saved(f);
  const noop = await request(f.route, 'PATCH', {});
  assert.equal(noop.status, 200);
  assert.equal(noop.body.updated, false);
  assert.deepEqual(saved(f), beforeNoop);
  assert.equal((await request('/api/personalize/999999999', 'PATCH', { subject_line: 'Missing copy edit' })).status, 404);
  for (const invalid of [{ body_text: 5 }, { subject_line: [] }, { body_text: 'x'.repeat(50001) }, { subject_line: 'x'.repeat(999) }, null, []]) {
    const response = await request(f.route, 'PATCH', invalid);
    assert.equal(response.status, 400, JSON.stringify({ invalid, response }));
    assert.deepEqual(saved(f), beforeNoop);
  }
});

test('lead-stage failure rolls back the edited copy and computed guardrail state', async () => {
  const f = fixture();
  const before = saved(f);
  db.exec("CREATE TRIGGER fail_edit_stage BEFORE UPDATE OF status ON leads WHEN NEW.status='awaiting_approval' BEGIN SELECT RAISE(ABORT,'fixture stage rollback'); END");
  try {
    const response = await request(f.route, 'PATCH', { body_text: 'Fixture Workshop short.' });
    assert.equal(response.status, 500);
  } finally {
    db.exec('DROP TRIGGER fail_edit_stage');
  }
  assert.deepEqual(saved(f), before);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(f.leadId).status, 'awaiting_approval');
});

test('installed Edge shows failed correction guidance, updated badges, and separate approval', async () => {
  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  assert.ok(fs.existsSync(edgePath), `Installed Edge is required for UI evidence: ${edgePath}`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('request', request => { if (new URL(request.url()).origin !== base) transportEvidence.browserDenied.push(request.url()); });
  page.on('pageerror', error => transportEvidence.pageErrors.push(error.message));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    if (!transportEvidence.browserDenied.includes(route.request().url())) transportEvidence.browserDenied.push(route.request().url());
    return route.abort();
  });
  await context.addCookies([
    { name: 'odd_session', value: session, url: base, httpOnly: true, sameSite: 'Lax' },
    { name: 'odd_csrf', value: csrf, url: base, sameSite: 'Lax' },
  ]);
  const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Copy edit guard UI fixture','personalization','open')").run().lastInsertRowid);
  const leadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,status) VALUES (?,'Fixture Workshop','awaiting_approval')").run(batchId).lastInsertRowid);
  const personalizationId = Number(db.prepare(`INSERT INTO personalizations
    (lead_id,subject_variant,subject_line,body_text,guardrail_passed,fact_check_passed,fact_check_status,approved,model_used)
    VALUES (?,'A','A note for Fixture Workshop',?,1,1,'passed',0,'fixture')`).run(leadId, validBody).lastInsertRowid);
  const feedbackLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,status) VALUES (?,'Fixture Workshop','awaiting_approval')").run(batchId).lastInsertRowid);
  const feedbackCopyId = Number(db.prepare(`INSERT INTO personalizations
    (lead_id,subject_variant,subject_line,body_text,guardrail_passed,fact_check_passed,fact_check_status,approved,model_used)
    VALUES (?,'A','Valid second copy',?,1,0,'unavailable',0,'fixture')`).run(feedbackLeadId, validBody).lastInsertRowid);
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-view="personalization"]').click();
    const card = page.locator(`.pers-card[data-lead-id="${leadId}"]`);
    await card.waitFor();
    await card.getByRole('button', { name: '✎ Edit' }).click();
    await page.locator('#edit-body').fill('Fixture Workshop short.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.locator('#edit-save-feedback').getByText('Body is too short (3 words).', { exact: false }).waitFor();
    assert.match(await page.locator('#edit-save-feedback').textContent(), /Correct the copy and save again\./);
    assert.equal(await page.locator('#pers-edit-modal').isVisible(), true, 'failed copy remains open for correction');
    await card.locator('.check-dot.fail[title="Guardrail failed"]').waitFor();
    assert.equal(await card.getByText('Approved', { exact: true }).count(), 0);
    assert.equal(saved({ personalizationId }).approved, 0);

    await page.locator('#pers-edit-modal .btn-secondary').click();
    const feedbackCard = page.locator(`.pers-card[data-lead-id="${feedbackLeadId}"]`);
    await feedbackCard.getByRole('button', { name: '✎ Edit' }).click();
    assert.equal(await page.locator('#edit-save-feedback').textContent(), '', 'opening a different valid copy clears stale feedback');
    assert.equal(await page.locator('#edit-body').inputValue(), validBody);
    await page.locator('#pers-edit-modal .btn-secondary').click();
    await card.getByRole('button', { name: '✎ Edit' }).click();
    await page.locator('#edit-body').fill(validBody);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Copy saved. Separate approval is required; fact-check is unavailable.', { exact: true }).waitFor();
    await card.locator('.check-dot.pass[title="Guardrail passed"]').waitFor();
    assert.equal(await card.getByText('Approved', { exact: true }).count(), 0);
    assert.equal(saved({ personalizationId }).approved, 0);
    await card.getByRole('button', { name: '✓ Approve' }).click();
    assert.equal(saved({ personalizationId }).approved, 1);
    await page.locator('.verify-tab[data-filter="approved"]').click();
    const approvedCard = page.locator(`.pers-card[data-lead-id="${leadId}"]`);
    await approvedCard.getByText('Approved', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidenceDir, 'personalization-edit-guard-edge-r2.png'), fullPage: true });

    const makePendingFixture = name => {
      const id = Number(db.prepare("INSERT INTO leads(batch_id,business_name,status) VALUES (?,'Fixture Workshop','awaiting_approval')").run(batchId).lastInsertRowid);
      const copyId = Number(db.prepare(`INSERT INTO personalizations
        (lead_id,subject_variant,subject_line,body_text,guardrail_passed,fact_check_passed,fact_check_status,approved,model_used)
        VALUES (?,'A',?, ?,1,0,'unavailable',0,'fixture')`).run(id, name, validBody).lastInsertRowid);
      return { leadId: id, copyId };
    };
    const pendingCopy = makePendingFixture('Pending fixture copy');
    const otherCopy = makePendingFixture('Other fixture copy');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-view="personalization"]').click();
    const pendingCard = page.locator(`.pers-card[data-lead-id="${pendingCopy.leadId}"]`);
    const otherCard = page.locator(`.pers-card[data-lead-id="${otherCopy.leadId}"]`);
    await pendingCard.waitFor();
    await otherCard.waitFor();
    await pendingCard.getByRole('button', { name: '✎ Edit' }).click();
    const retainedText = 'This draft stays available after a failed save attempt.';
    await page.locator('#edit-body').fill(retainedText);
    let finishPatch;
    let patchCount = 0;
    let startedPatch;
    const patchStarted = new Promise(resolve => { startedPatch = resolve; });
    const blockedPatch = new Promise(resolve => { finishPatch = resolve; });
    const patchUrl = `${base}/api/personalize/${pendingCopy.copyId}`;
    await page.route(patchUrl, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patchCount++;
      startedPatch();
      await blockedPatch;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture save failure' }) });
    });
    const saveButton = page.getByRole('button', { name: 'Save changes' });
    await saveButton.click();
    await patchStarted;
    assert.equal(await saveButton.isDisabled(), true);
    await page.evaluate(() => window.__persSaveEdit());
    assert.equal(patchCount, 1, 'a second save during the pending request is ignored');
    await page.evaluate(id => window.__persEdit(id, 'Other fixture copy', 'Other body'), otherCopy.copyId);
    assert.equal(await page.locator('#edit-subject').inputValue(), 'Pending fixture copy', 'a stale selection cannot replace the pending editor');
    finishPatch();
    await page.waitForFunction(() => !document.querySelector('.pers-modal-footer .btn-primary')?.disabled);
    assert.equal(await page.locator('#edit-body').inputValue(), retainedText, 'a failed save keeps the user\'s body text');
    assert.equal(await saveButton.isDisabled(), false, 'the save control is restored after failure');
    await page.unroute(patchUrl);
    await page.locator('#pers-edit-modal .btn-secondary').click();

    const successCopy = makePendingFixture('Delayed success fixture');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-view="personalization"]').click();
    const successCard = page.locator(`.pers-card[data-lead-id="${successCopy.leadId}"]`);
    await successCard.waitFor();
    await successCard.getByRole('button', { name: '✎ Edit' }).click();
    let releaseSuccessfulResponse;
    let resolveBackendCommitted;
    let successfulPatchCount = 0;
    const successfulResponseGate = new Promise(resolve => { releaseSuccessfulResponse = resolve; });
    const backendCommitted = new Promise(resolve => { resolveBackendCommitted = resolve; });
    const successUrl = `${base}/api/personalize/${successCopy.copyId}`;
    await page.route(successUrl, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      successfulPatchCount++;
      const response = await route.fetch();
      const responseBody = await response.body();
      resolveBackendCommitted({ response, responseBody });
      await successfulResponseGate;
      await route.fulfill({ response, body: responseBody });
    });
    await page.locator('#edit-body').fill(validBody);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await backendCommitted;
    assert.equal(saved({ personalizationId: successCopy.copyId }).body_text, validBody, 'the actual API committed the submitted copy before the response was released');
    assert.equal(await page.locator('#edit-subject').evaluate(element => element.readOnly), true);
    assert.equal(await page.locator('#edit-body').evaluate(element => element.readOnly), true);
    assert.equal(await page.locator('#edit-save-feedback').textContent(), 'Saving…');
    await page.locator('#edit-body').focus();
    await page.keyboard.press('End');
    await page.keyboard.type(' later unsaved text');
    assert.equal(await page.locator('#edit-body').inputValue(), validBody, 'the pending editor does not accept text that would be discarded');
    await page.evaluate(() => window.__persSaveEdit());
    assert.equal(successfulPatchCount, 1, 'a repeated pending save does not submit a second PATCH');
    releaseSuccessfulResponse();
    await page.waitForFunction(() => document.querySelector('#pers-edit-modal')?.style.display === 'none');
    assert.equal(saved({ personalizationId: successCopy.copyId }).body_text, validBody);
    assert.equal(saved({ personalizationId: successCopy.copyId }).approved, 0);
    await page.unroute(successUrl);
    assert.deepEqual(transportEvidence.pageErrors, []);
    fs.writeFileSync(path.join(evidenceDir, 'personalization-edit-guard-edge-r2.json'), JSON.stringify({
      browser: 'Microsoft Edge via Playwright, headless',
      viewport: { width: 1280, height: 900 },
      fixture: { leadId, personalizationId, syntheticBusiness: 'Fixture Workshop' },
      final: { guardrailPassed: saved({ personalizationId }).guardrail_passed === 1,
        approved: saved({ personalizationId }).approved === 1, factCheckStatus: saved({ personalizationId }).fact_check_status },
      transportEvidence,
      sends: db.prepare('SELECT COUNT(*) AS count FROM sends').get().count,
      aiUsageEvents: db.prepare('SELECT COUNT(*) AS count FROM ai_usage_events').get().count,
    }, null, 2) + '\n');
  } finally {
    await context.close();
    await browser.close();
  }
});

test('fixture transport guard rejects outside fetch, socket, DNS and TLS targets before connection', async () => {
  await assert.rejects(globalThis.fetch('https://203.0.113.10/provider'), error => error.code === 'EDIT_GUARD_EGRESS_BLOCKED');
  const socket = new net.Socket();
  assert.throws(() => socket.connect({ host: '203.0.113.10', port: 443 }), error => error.code === 'EDIT_GUARD_EGRESS_BLOCKED');
  socket.destroy();
  await assert.rejects(dnsPromises.lookup('example.invalid'), error => error.code === 'EDIT_GUARD_EGRESS_BLOCKED');
  await new Promise(resolve => dns.lookup('example.invalid', error => {
    assert.equal(error.code, 'EDIT_GUARD_EGRESS_BLOCKED');
    resolve();
  }));
  assert.throws(() => tls.connect({ host: '203.0.113.10', port: 443 }),
    error => ['EDIT_GUARD_EGRESS_BLOCKED', 'EQA_EGRESS_BLOCKED'].includes(error.code),
    'either the fixture socket guard or the outer suite TLS guard must deny before connecting');
  assert.ok(transportEvidence.backendDenied.some(target => target.includes('203.0.113.10')));
  assert.ok(transportEvidence.socketDenied.some(target => target.includes('203.0.113.10:443')));
  assert.ok(transportEvidence.dnsDenied.some(target => target.includes('example.invalid')));
});
