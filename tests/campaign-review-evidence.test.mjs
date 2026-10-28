import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-campaign-review-evidence-'));
const dbPath = path.join(directory, 'review-evidence.db');
const blockedAttempts = [];
Object.assign(process.env, {
  NODE_ENV: 'test', ODD_DB_PATH: dbPath, PORT: '0', HOST: '127.0.0.1',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'review-evidence-disposable-bootstrap-token-123456789',
  ODD_CREDENTIAL_ENCRYPTION_KEY: '8'.repeat(64),
});

const originalFetch = globalThis.fetch;
let allowedPort = null;
const blocked = host => Object.assign(new Error(`External connection blocked in review evidence test: ${host}`), { code: 'TEST_EXTERNAL_NETWORK_BLOCKED' });
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== allowedPort) {
    blockedAttempts.push(url.href);
    return Promise.reject(blocked(url.host));
  }
  return originalFetch(input, options);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object'
    ? first
    : typeof first === 'number' ? { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }
      : { path: first };
  if (options.path || options.host !== '127.0.0.1' || Number(options.port) !== allowedPort) {
    const target = options.path || `${options.host || 'unknown'}:${options.port || 'unknown'}`;
    blockedAttempts.push(String(target));
    throw blocked(target);
  }
  return Reflect.apply(originalConnect, this, args);
};
const originalLookup = dns.lookup;
dns.lookup = function(hostname, ...args) {
  if (hostname === '127.0.0.1') return Reflect.apply(originalLookup, this, [hostname, ...args]);
  blockedAttempts.push(`dns:${hostname}`);
  const callback = args.find(value => typeof value === 'function');
  const error = blocked(hostname);
  if (callback) return process.nextTick(callback, error);
  throw error;
};
syncBuiltinESMExports();

const database = await import('../pipeline/database.js');
const db = database.initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
allowedPort = server.address().port;
const base = `http://127.0.0.1:${allowedPort}`;
let headers = {};
after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  syncBuiltinESMExports();
  assert.deepEqual(blockedAttempts, [], 'no provider or non-fixture network was attempted');
});

async function request(route, method = 'GET', body, authenticated = true) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(authenticated ? headers : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const boot = await request('/api/auth/bootstrap', 'POST', {
  email: 'review-evidence-owner@example.test', password: 'Disposable-review-evidence-password-22!',
  bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
});
assert.equal(boot.status, 201, JSON.stringify(boot.body));
const session = boot.headers.get('set-cookie').match(/odd_session=([^;,]+)/)[1];
const csrf = boot.headers.get('set-cookie').match(/odd_csrf=([^;,]+)/)[1];
headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };

function fixture(label = 'Evidence Workshop') {
  const leadId = Number(db.prepare('INSERT INTO leads(business_name,email,status) VALUES (?,? ,\'verified\')')
    .run(label, `${label.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2)}@example.test`).lastInsertRowid);
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  db.prepare("INSERT INTO lead_emails(lead_id,email,is_primary,verification_status) VALUES (?,?,1,'deliverable')").run(leadId, lead.email);
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES (?,'draft')").run(`${label} campaign`).lastInsertRowid);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);
  return { leadId, campaignId, email: lead.email, audience: `/api/sending/campaigns/${campaignId}/audience`, draft: `/api/sending/campaigns/${campaignId}/audience/${leadId}/draft` };
}

function draft(overrides = {}) {
  return {
    subjectLine: 'A practical note about Evidence Workshop',
    bodyText: 'Hello Evidence Workshop, I am writing to ask whether a short conversation about your current outreach process would be useful. We can compare the steps your team uses today and discuss a practical way to reduce repeated work. Would you like to review a brief outline next week?',
    expectedLatestPersonalizationId: null,
    expectedLatestCopyHash: null,
    ...overrides,
  };
}

function version(leadId) {
  const latest = db.prepare('SELECT * FROM personalizations WHERE lead_id=? ORDER BY generated_at DESC,id DESC LIMIT 1').get(leadId);
  return latest ? {
    expectedLatestPersonalizationId: latest.id,
    expectedLatestCopyHash: createHash('sha256').update(JSON.stringify([
      latest.id, latest.subject_line, latest.body_text, latest.approved, latest.guardrail_passed,
    ])).digest('hex'),
  } : { expectedLatestPersonalizationId: null, expectedLatestCopyHash: null };
}

async function saveFailure(f) {
  const response = await request(f.draft, 'POST', draft({ bodyText: 'Evidence Workshop short.' }));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.guardrailPassed, false);
  assert.ok(response.body.guardrailFailures.length > 0);
  return response.body;
}

function audienceItem(f) {
  return request(f.audience).then(response => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.items.find(item => item.lead_id === f.leadId);
  });
}

test('normal owner audience reload exposes the current saved failure and clears it for a corrected version', async () => {
  const f = fixture();
  const saved = await saveFailure(f);
  const first = await audienceItem(f);
  assert.deepEqual(first.guardrail_failures, saved.guardrailFailures);
  assert.equal(first.fact_check_status, 'unavailable');
  assert.equal(first.personalization_id, saved.personalizationId);

  const reopened = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const persisted = reopened.prepare('SELECT fact_check_status FROM personalizations WHERE id=?').get(saved.personalizationId);
    const persistedCopy = reopened.prepare('SELECT subject_line,body_text FROM personalizations WHERE id=?').get(saved.personalizationId);
    const event = reopened.prepare("SELECT meta_json FROM events WHERE lead_id=? AND event_type='campaign_manual_copy_saved' ORDER BY id DESC LIMIT 1").get(f.leadId);
    assert.equal(persisted.fact_check_status, 'unavailable');
    const audit = JSON.parse(event.meta_json);
    assert.deepEqual(audit.guardrailFailures, saved.guardrailFailures);
    assert.equal(audit.copyContentHash, createHash('sha256').update(JSON.stringify([
      persistedCopy.subject_line, persistedCopy.body_text,
    ])).digest('hex'));
  } finally { reopened.close(); }

  assert.equal((await request(`/api/personalize/approve/${saved.personalizationId}`, 'POST', {})).status, 200);
  const approvedOnly = await audienceItem(f);
  assert.deepEqual(approvedOnly.guardrail_failures, saved.guardrailFailures,
    'approval changes do not invalidate evidence bound to unchanged content');

  const edited = await request(`/api/personalize/${saved.personalizationId}`, 'PATCH', {
    subject_line: 'Edited after the recorded guardrail review',
    body_text: 'Evidence Workshop short copy was edited in place after its recorded review.',
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const sameIdEdited = await audienceItem(f);
  assert.equal(sameIdEdited.personalization_id, saved.personalizationId);
  assert.deepEqual(sameIdEdited.guardrail_failures, [], 'same-ID content edits cannot reuse old save reasons');

  const corrected = await request(f.draft, 'POST', draft({
    subjectLine: 'A revised note about Evidence Workshop',
    ...version(f.leadId),
  }));
  assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  assert.equal(corrected.body.guardrailPassed, true);
  const afterCorrection = await audienceItem(f);
  assert.deepEqual(afterCorrection.guardrail_failures, []);
  assert.equal(afterCorrection.personalization_id, corrected.body.personalizationId);
  assert.equal(afterCorrection.fact_check_status, 'unavailable');
});

test('campaign and lead bindings prevent another campaign or lead event from leaking reasons', async () => {
  const f = fixture('Shared Evidence Workshop');
  await saveFailure(f);
  const otherCampaignId = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES ('Other evidence campaign','draft')").run().lastInsertRowid);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(otherCampaignId, f.leadId);
  const otherDraftRoute = `/api/sending/campaigns/${otherCampaignId}/audience/${f.leadId}/draft`;
  const otherSave = await request(otherDraftRoute, 'POST', draft({
    bodyText: 'Shared Evidence Workshop short.', ...version(f.leadId),
  }));
  assert.equal(otherSave.status, 201);
  const otherAudience = await request(`/api/sending/campaigns/${otherCampaignId}/audience`);
  const otherItem = otherAudience.body.items.find(item => item.lead_id === f.leadId);
  assert.deepEqual(otherItem.guardrail_failures, otherSave.body.guardrailFailures);

  const oldCampaignItem = await audienceItem(f);
  assert.equal(oldCampaignItem.personalization_id, otherSave.body.personalizationId);
  assert.deepEqual(oldCampaignItem.guardrail_failures, [], 'same lead/version evidence saved under another campaign is unavailable here');

  const otherLead = fixture('Separate Evidence Workshop');
  const otherLeadSave = await saveFailure(otherLead);
  const oldEvent = db.prepare("SELECT id FROM events WHERE lead_id=? AND event_type='campaign_manual_copy_saved' ORDER BY id DESC LIMIT 1").get(f.leadId);
  const meta = JSON.parse(db.prepare('SELECT meta_json FROM events WHERE id=?').get(oldEvent.id).meta_json);
  meta.guardrailFailures = ['secret=must-not-leak'];
  db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify(meta), oldEvent.id);
  assert.ok(otherLeadSave.guardrailFailures.length > 0);
  const separate = await audienceItem(otherLead);
  assert.deepEqual(separate.guardrail_failures, otherLeadSave.guardrailFailures);
  assert.ok(!JSON.stringify(separate).includes('must-not-leak'));
});

test('malformed, stale and oversized event evidence fails closed and stays bounded', async () => {
  const f = fixture('Bounded Evidence Workshop');
  const saved = await saveFailure(f);
  const event = db.prepare("SELECT id,meta_json FROM events WHERE lead_id=? AND event_type='campaign_manual_copy_saved' ORDER BY id DESC LIMIT 1").get(f.leadId);
  db.prepare('UPDATE events SET meta_json=? WHERE id=?').run('{malformed', event.id);
  let item = await audienceItem(f);
  assert.deepEqual(item.guardrail_failures, []);
  assert.equal(item.fact_check_status, 'unavailable');

  const current = db.prepare('SELECT id,subject_line,body_text,guardrail_passed FROM personalizations WHERE id=?').get(saved.personalizationId);
  const user = db.prepare("SELECT id FROM auth_users WHERE email='review-evidence-owner@example.test'").get();
  db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify({
    campaignId: f.campaignId, personalizationId: current.id - 1,
    copyContentHash: createHash('sha256').update(JSON.stringify([current.subject_line, current.body_text])).digest('hex'), actorId: user.id,
    actorRole: 'owner', guardrailPassed: false, guardrailFailures: ['stale_reason=must-not-leak'],
  }), event.id);
  item = await audienceItem(f);
  assert.deepEqual(item.guardrail_failures, [], 'a prior personalization version cannot supply current reasons');

  db.prepare('DELETE FROM events WHERE id=?').run(event.id);
  item = await audienceItem(f);
  assert.deepEqual(item.guardrail_failures, [], 'legacy or missing events remain unavailable');
  const boundedEventId = Number(db.prepare("INSERT INTO events(lead_id,event_type,meta_json) VALUES (?,'campaign_manual_copy_saved',?)")
    .run(f.leadId, JSON.stringify({ campaignId: f.campaignId, personalizationId: current.id, actorId: user.id,
      actorRole: 'owner', guardrailPassed: false, guardrailFailures: [] })).lastInsertRowid);

  const oversized = {
    campaignId: f.campaignId, personalizationId: current.id,
    copyContentHash: createHash('sha256').update(JSON.stringify([current.subject_line, current.body_text])).digest('hex'),
    actorId: user.id, actorRole: 'owner', guardrailPassed: Boolean(current.guardrail_passed),
    guardrailFailures: Array.from({ length: 30 }, (_, i) => `body_too_short_${i} ` + 'x'.repeat(400))
      .concat(['token=never-expose-this']),
  };
  db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify(oversized), boundedEventId);
  item = await audienceItem(f);
  assert.equal(item.guardrail_failures.length, 20);
  assert.ok(item.guardrail_failures.every(reason => reason.length <= 240));
  assert.ok(!JSON.stringify(item).includes('never-expose-this'));

  db.prepare("UPDATE personalizations SET fact_check_status='untrusted-status-value' WHERE id=?").run(current.id);
  item = await audienceItem(f);
  assert.equal(item.fact_check_status, 'unavailable', 'unsupported persisted status is not presented as evidence');
  assert.deepEqual(blockedAttempts, []);
});
