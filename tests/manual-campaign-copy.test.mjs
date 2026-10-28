import './support/all-hours-send-window.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-manual-copy-'));
Object.assign(process.env, { NODE_ENV: 'test', ODD_DB_PATH: path.join(directory, 'copy.db'), PORT: '0', HOST: '127.0.0.1',
  ODD_AUTH_ENFORCE_TESTS: 'true', ODD_AUTH_COOKIE_SECURE: 'false',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'manual-copy-disposable-bootstrap-token-123456789', ODD_CREDENTIAL_ENCRYPTION_KEY: '7'.repeat(64) });
const database = await import('../pipeline/database.js');
const db = database.initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let headers = {};
after(async () => { await new Promise(resolve => server.close(resolve)); database.closeDb(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); });
async function request(route, method = 'GET', body, authenticated = true) {
  const response = await fetch(base + route, { method, headers: { ...(authenticated ? headers : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const boot = await request('/api/auth/bootstrap', 'POST', { email: 'manual-owner@example.test', password: 'Disposable-manual-copy-password-22!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN });
assert.equal(boot.status, 201, JSON.stringify(boot.body));
const session = boot.headers.get('set-cookie').match(/odd_session=([^;,]+)/)[1];
const csrf = boot.headers.get('set-cookie').match(/odd_csrf=([^;,]+)/)[1];
headers = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };
function fixture() {
  const leadId = Number(db.prepare("INSERT INTO leads(business_name,email,status) VALUES ('Manual Workshop',?,'verified')").run(`copy-${Math.random().toString(36).slice(2)}@example.test`).lastInsertRowid);
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  db.prepare("INSERT INTO lead_emails(lead_id,email,is_primary,verification_status) VALUES (?,?,1,'deliverable')").run(leadId, lead.email);
  const campaignId = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES ('Manual campaign','draft')").run().lastInsertRowid);
  db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(campaignId, leadId);
  return { leadId, campaignId, email: lead.email, route: `/api/sending/campaigns/${campaignId}/audience/${leadId}/draft` };
}
function body(overrides = {}) { return { subjectLine: 'A note for Manual Workshop', bodyText: 'Hello Manual Workshop, I am writing to ask whether a short conversation about your current outreach process would be useful. We can compare the steps your team uses today and discuss a practical way to reduce repeated work. Would you like to review a brief outline next week?', expectedLatestPersonalizationId: null, expectedLatestCopyHash: null, ...overrides }; }
function version(leadId) {
  const p = db.prepare('SELECT * FROM personalizations WHERE lead_id=? ORDER BY generated_at DESC,id DESC LIMIT 1').get(leadId);
  return p ? { expectedLatestPersonalizationId: p.id, expectedLatestCopyHash: createHash('sha256').update(JSON.stringify([p.id,p.subject_line,p.body_text,p.approved,p.guardrail_passed])).digest('hex') } : { expectedLatestPersonalizationId: null, expectedLatestCopyHash: null };
}

if (process.env.ODD_MANUAL_COPY_REPRO === '1') {
  test('before: first manual draft route is missing and creates no copy', async () => {
    const f = fixture(); const response = await request(f.route, 'POST', body());
    assert.equal(response.status, 404); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations').get().n, 0);
  });
} else {
  test('normal owner saves first manual draft, explicitly approves, and appends a correction', async () => {
    const f = fixture(); const saved = await request(f.route, 'POST', body());
    assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.equal(saved.body.approved, false); assert.equal(saved.body.guardrailPassed, true);
    const first = db.prepare('SELECT * FROM personalizations WHERE id=?').get(saved.body.personalizationId);
    assert.equal(first.model_used, 'manual'); assert.equal(first.approved, 0); assert.equal(first.fact_check_passed, 0); assert.equal(first.fact_check_status, 'unavailable');
    const reopened = new Database(process.env.ODD_DB_PATH, { readonly: true, fileMustExist: true });
    try { assert.deepEqual(reopened.prepare('SELECT * FROM personalizations WHERE id=?').get(first.id), first); } finally { reopened.close(); }
    assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(f.leadId).status, 'awaiting_approval');
    assert.equal((await request(`/api/personalize/approve/${first.id}`, 'POST', {})).status, 200);
    const corrected = await request(f.route, 'POST', body({ ...version(f.leadId), subjectLine: 'A revised note for Manual Workshop' }));
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body)); assert.equal(db.prepare('SELECT approved FROM personalizations WHERE id=?').get(first.id).approved, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(f.leadId).n, 2);
    const audience = (await request(`/api/sending/campaigns/${f.campaignId}/audience`)).body.items[0]; assert.equal(audience.eligibility, 'approval_required');
    const event = db.prepare("SELECT meta_json FROM events WHERE lead_id=? AND event_type='campaign_manual_copy_saved' ORDER BY id DESC LIMIT 1").get(f.leadId);
    const audit = JSON.parse(event.meta_json); assert.equal(audit.actorRole, 'owner'); assert.ok(audit.actorId > 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  });
  test('server guardrails cannot be supplied or bypassed by existing approval', async () => {
    const f = fixture(); const bad = await request(f.route, 'POST', body({ bodyText: 'Manual Workshop short.' }));
    assert.equal(bad.status, 201); assert.equal(bad.body.guardrailPassed, false); assert.ok(bad.body.guardrailFailures.some(reason => reason.startsWith('body_too_short')));
    await request(`/api/personalize/approve/${bad.body.personalizationId}`, 'POST', {});
    assert.equal((await request(`/api/sending/campaigns/${f.campaignId}/audience`)).body.items[0].eligibility, 'copy_review_required');
    assert.equal((await request(f.route, 'POST', body({ ...version(f.leadId), guardrailPassed: true }))).status, 400);
  });
  test('stale versions including a same-row edit or approval reject without mutation', async () => {
    const f = fixture(); await request(f.route, 'POST', body()); const old = version(f.leadId);
    await request(`/api/personalize/${old.expectedLatestPersonalizationId}`, 'PATCH', { subject_line: 'Changed elsewhere' });
    assert.equal((await request(f.route, 'POST', body(old))).status, 409);
    const beforeApprove = version(f.leadId); await request(`/api/personalize/approve/${old.expectedLatestPersonalizationId}`, 'POST', {});
    assert.equal((await request(f.route, 'POST', body(beforeApprove))).status, 409);
    const current = version(f.leadId);
    const responses = await Promise.all([request(f.route, 'POST', body(current)), request(f.route, 'POST', body(current))]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201,409]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(f.leadId).n, 2);
  });
  test('strict request validation, canonical IDs, authentication, CSRF and actor role', async () => {
    const f = fixture(); assert.equal((await request(f.route, 'POST', body(), false)).status, 401);
    for (const updates of [{ subjectLine: '' }, { subjectLine: 'one\r\nBcc: victim@example.test' }, { subjectLine: 'bad\u0000title' }, { subjectLine: 'bad\u2028title' }, { subjectLine: 3 }, { subjectLine: 'x'.repeat(999) }, { bodyText: ' ' }, { bodyText: 'x'.repeat(50001) }, { bodyText: [] }, { expectedLatestPersonalizationId: '1' }, { expectedLatestCopyHash: 'bad' }, { extra: true }]) {
      assert.equal((await request(f.route, 'POST', body(updates))).status, 400, JSON.stringify(updates).slice(0,180));
    }
    assert.equal((await request(f.route.replace(`/campaigns/${f.campaignId}/`, `/campaigns/0${f.campaignId}/`), 'POST', body())).status, 400);
    assert.equal((await request(f.route.replace(`/audience/${f.leadId}/`, '/audience/9007199254740992/'), 'POST', body())).status, 400);
    const user = db.prepare("SELECT id FROM auth_users WHERE email='manual-owner@example.test'").get();
    db.prepare("UPDATE auth_users SET role='reviewer' WHERE id=?").run(user.id);
    try { assert.equal((await request(f.route, 'POST', body())).status, 403); } finally { db.prepare("UPDATE auth_users SET role='owner' WHERE id=?").run(user.id); }
    const savedHeaders = headers; headers = { cookie: headers.cookie };
    try { assert.equal((await request(f.route, 'POST', body())).status, 403); } finally { headers = savedHeaders; }
  });
  test('single-address re-verifier workflow label needs a matching saved deliverable result', async () => {
    const f = fixture(); db.prepare("UPDATE leads SET status='verifying' WHERE id=?").run(f.leadId);
    assert.equal((await request(f.route, 'POST', body())).status, 201);
    const g = fixture(); db.prepare("UPDATE leads SET status='verifying' WHERE id=?").run(g.leadId);
    db.prepare("UPDATE lead_emails SET verification_status='unknown' WHERE lead_id=?").run(g.leadId);
    assert.equal((await request(g.route, 'POST', body())).status, 409);
    assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(g.leadId).status, 'verifying');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(g.leadId).n, 0);
  });
  test('imported discovered and site_checked contacts require current-address evidence before drafting', async t => {
    const { reverifyEmailById } = await import('../pipeline/email-verifier.js');
    const adapterCalls = [];
    for (const stage of ['discovered', 'site_checked']) await t.test(stage, async () => {
      const batch = await request('/api/batches', 'POST', { name: `Manual import ${stage}`, phase: 'discovery' });
      assert.equal(batch.status, 201);
      const imported = await request('/api/leads/import', 'POST', { batch_id: batch.body.id,
        csv: `business_name,email\nManual Workshop Known ${stage},known-${stage}@example.test\nManual Workshop Unknown ${stage},unknown-${stage}@example.test\n` });
      assert.equal(imported.status, 200); assert.equal(imported.body.counts.inserted, 2);
      const contacts = (await request(`/api/leads?batch_id=${batch.body.id}`)).body.leads;
      assert.equal(contacts.length, 2);
      const campaign = await request('/api/sending/campaigns', 'POST', { name: `Imported ${stage} campaign` });
      assert.equal(campaign.status, 200);
      const enrolled = await request(`/api/sending/campaigns/${campaign.body.id}/audience`, 'POST', { leadIds: contacts.map(contact => contact.id) });
      assert.equal(enrolled.status, 200);
      for (const contact of contacts) {
        assert.equal(contact.status, 'discovered', 'real import supplies the initial stage');
        if (stage === 'site_checked') {
          // Missing website/Facebook means this real API audit needs no network.
          const qualified = await request(`/api/qualify/lead/${contact.id}`, 'POST', {});
          assert.equal(qualified.status, 200); assert.equal(qualified.body.site_status, 'NO_SITE');
        }
        const before = (await request(`/api/leads/${contact.id}`)).body;
        assert.equal(before.status, stage); const email = before.emails.find(row => row.email === before.email);
        assert.equal(email.verification_status, 'unknown');
        const isKnown = before.email.startsWith('known-');
        const outcome = { email: before.email, valid: isKnown, verification_status: isKnown ? 'deliverable' : 'unknown',
          score: isKnown ? 96 : null, checks: { smtp: isKnown ? true : null }, reasons: isKnown ? [] : ['fixture_smtp_unconfirmed'] };
        await reverifyEmailById(email.id, { verifyEmailImpl: async address => {
          adapterCalls.push(address); assert.equal(address, before.email); return outcome;
        } });
        const verified = (await request(`/api/leads/${contact.id}`)).body;
        assert.equal(verified.status, stage, 'single-address verification preserves the actual contact stage');
        const current = verified.emails.find(row => row.id === email.id);
        assert.equal(current.email, email.email); assert.equal(current.is_primary, email.is_primary); assert.equal(current.source, email.source);
        assert.equal(current.verification_status, outcome.verification_status);
        const historyBeforeSave = db.prepare('SELECT * FROM email_verification_history WHERE email_id=? ORDER BY id').all(email.id);
        assert.equal(historyBeforeSave.length, 1); assert.deepEqual(JSON.parse(historyBeforeSave[0].verification_json), outcome);
        const response = await request(`/api/sending/campaigns/${campaign.body.id}/audience/${contact.id}/draft`, 'POST',
          body({ bodyText: body().bodyText.replace('Manual Workshop', before.business_name) }));
        assert.equal(response.status, isKnown ? 201 : 409, JSON.stringify({ stage, email: contact.email, response }));
        assert.equal((await request(`/api/leads/${contact.id}`)).body.status, isKnown ? 'awaiting_approval' : stage);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(contact.id).n, isKnown ? 1 : 0);
        assert.deepEqual(db.prepare('SELECT * FROM email_verification_history WHERE email_id=? ORDER BY id').all(email.id), historyBeforeSave,
          'manual preparation preserves the saved verification audit');
      }
    });
    assert.equal(adapterCalls.length, 4); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage_events').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  });
  test('request capacity stays distinct from guardrails and future-dated legacy rows remain versioned', async () => {
    const f = fixture(); const first = await request(f.route, 'POST', body({ subjectLine: 'x'.repeat(998), bodyText: 'Manual Workshop ' + 'x'.repeat(49984) }));
    assert.equal(first.status, 201); assert.equal(first.body.guardrailPassed, false);
    db.prepare("UPDATE personalizations SET generated_at='2099-01-01 00:00:00' WHERE id=?").run(first.body.personalizationId);
    const second = await request(f.route, 'POST', body(version(f.leadId)));
    assert.equal(second.status, 201); assert.equal(version(f.leadId).expectedLatestPersonalizationId, second.body.personalizationId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage_events').get().n, 0, 'manual copy never calls an AI provider');
  });
  test('actual primary verification, suppression, enrollment and terminal status are enforced', async () => {
    for (const mutate of [
      f => db.prepare("UPDATE lead_emails SET verification_status='unknown' WHERE lead_id=?").run(f.leadId),
      f => db.prepare('UPDATE leads SET email=? WHERE id=?').run('different@example.test', f.leadId),
      f => db.prepare('INSERT INTO suppression_list(email,reason) VALUES (?,?)').run(f.email.toUpperCase(), 'fixture'),
      f => db.prepare("UPDATE leads SET status='replied' WHERE id=?").run(f.leadId),
      f => db.prepare("UPDATE leads SET status='disqualified' WHERE id=?").run(f.leadId),
      f => db.prepare("UPDATE campaign_enrollments SET status='stopped' WHERE lead_id=?").run(f.leadId),
      f => db.prepare('DELETE FROM campaign_enrollments WHERE lead_id=?').run(f.leadId),
    ]) { const f = fixture(); mutate(f); const result = await request(f.route, 'POST', body()); assert.ok([404,409].includes(result.status), JSON.stringify(result)); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(f.leadId).n, 0); }
  });
  test('launch, send history and cross-campaign active or uncertain conflicts are blocked', async () => {
    for (const status of ['scheduled','processing','uncertain','sent']) {
      const f = fixture(); const other = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES ('Other launched','active')").run().lastInsertRowid);
      db.prepare('INSERT INTO sends(lead_id,campaign_id,status) VALUES (?,?,?)').run(f.leadId, other, status);
      assert.equal((await request(f.route, 'POST', body())).status, 409, status);
    }
    const f = fixture(); db.prepare("UPDATE campaigns SET status='active' WHERE id=?").run(f.campaignId);
    assert.equal((await request(f.route, 'POST', body())).status, 409);
    const g = fixture(); db.prepare("INSERT INTO campaign_launches(campaign_id,version,snapshot_json,snapshot_hash) VALUES (?,1,'{}',?)").run(g.campaignId, 'a'.repeat(64));
    assert.equal((await request(g.route, 'POST', body())).status, 409);
    const h = fixture(); db.prepare("INSERT INTO sends(lead_id,campaign_id,status) VALUES (?,?,'cancelled')").run(h.leadId, h.campaignId);
    assert.equal((await request(h.route, 'POST', body())).status, 409, 'even cancelled history locks the target draft');
    const i = fixture(); const other = Number(db.prepare("INSERT INTO campaigns(name,status) VALUES ('Past launch','completed')").run().lastInsertRowid);
    db.prepare('INSERT INTO campaign_enrollments(campaign_id,lead_id) VALUES (?,?)').run(other, i.leadId);
    db.prepare("INSERT INTO campaign_launches(campaign_id,version,snapshot_json,snapshot_hash) VALUES (?,1,'{}',?)").run(other, 'b'.repeat(64));
    assert.equal((await request(i.route, 'POST', body())).status, 409, 'a past immutable launch cannot be invalidated via a new campaign');
  });
  test('audit failure rolls back copy append and contact stage atomically', async () => {
    const f = fixture(); db.exec("CREATE TRIGGER fail_manual_audit BEFORE INSERT ON events WHEN NEW.event_type='campaign_manual_copy_saved' BEGIN SELECT RAISE(ABORT,'fixture audit rollback'); END");
    try { assert.equal((await request(f.route, 'POST', body())).status, 500); } finally { db.exec('DROP TRIGGER fail_manual_audit'); }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personalizations WHERE lead_id=?').get(f.leadId).n, 0);
    assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(f.leadId).status, 'verified');
  });
}
