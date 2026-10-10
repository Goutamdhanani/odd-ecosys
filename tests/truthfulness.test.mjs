// ============================================================
//  Truthfulness regression tests — B04, B05, B07, B08, B09, B12
//  DNS observations, CRM sync honesty, approval semantics and
//  contract availability of UI-called lifecycle routes.
// ============================================================

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-truth-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { checkDomainDns, verifyMailboxDns, getMailboxFleet } = await import('../pipeline/sending-engine.js');
const { renderDnsSheetBody, renderMailboxCard } = await import('../js/mailboxes.js');
const { editPersonalization, approvePersonalization } = await import('../pipeline/personalizer.js');
const { syncLeadToCRM } = await import('../pipeline/crm-sync.js');

after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

// ── DNS layer test double: controlled resolver responses ──────
const realResolveTxt = dns.promises.resolveTxt.bind(dns.promises);
const realResolve4 = dns.promises.resolve4.bind(dns.promises);
const realResolveMx = dns.promises.resolveMx.bind(dns.promises);
const err = (code) => Object.assign(new Error(code), { code });
after(() => { dns.promises.resolveTxt = realResolveTxt; dns.promises.resolve4 = realResolve4; dns.promises.resolveMx = realResolveMx; });

function patchDns({ txt = {}, a4 = {}, mx = {} }) {
  dns.promises.resolveTxt = async (name) => {
    if (name in txt) return txt[name];
    throw err('ENOTFOUND');
  };
  dns.promises.resolve4 = async (name) => {
    if (name in a4) return a4[name];
    throw err('ENOTFOUND');
  };
  dns.promises.resolveMx = async (name) => {
    if (name in mx) return mx[name];
    throw err('ENODATA');
  };
}

test('B04: SPF+DMARC presence without an observed selector leaves DKIM authentication unknown', async () => {
  patchDns({ txt: { 'example.test': [['v=spf1 include:_spf.google.com ~all']], '_dmarc.example.test': [['v=DMARC1; p=none']] } });
  const r = await checkDomainDns('example.test');
  assert.equal(r.spf_ok, 1);
  assert.equal(r.dmarc_ok, 1);
  assert.equal(r.dkim_ok, null, 'DKIM authentication stays unknown without captured-message evidence');
  assert.equal(r.dkim_status, 'unknown');
  assert.equal(r.dkim_key_status, 'not_discovered');
  assert.equal(r.dkim_selector, null);
});

test('B04: a published selector key never claims message signing or alignment', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  patchDns({
    txt: {
      'example.test': [['v=spf1 ~all']],
      'google._domainkey.example.test': [[`v=DKIM1; k=rsa; p=${publicKeyBase64}`]],
    },
  });
  const r = await checkDomainDns('example.test');
  assert.equal(r.dkim_ok, null, 'DNS key publication is not outgoing-message authentication evidence');
  assert.equal(r.dkim_status, 'signature_unverified');
  assert.equal(r.dkim_key_status, 'published');
  assert.equal(r.dkim_selector, 'google');
  assert.match(r.dkim_record, /v=DKIM1/);
  const markup = renderDnsSheetBody(r);
  assert.match(markup, /SIGNATURE \/ ALIGNMENT UNVERIFIED/);
  assert.match(markup, /DNS selector key was observed/);
  assert.doesNotMatch(markup, /ALIGNED/);
  const card = renderMailboxCard({
    id: 989, email: 'sender@example.test', domain: 'example.test', warmup_status: 'eligible',
    health_score: 100, daily_limit: 25, today_sent: 0, today_reserved: 0, dkim_ok: 1, dkim_status: 'key_published',
  });
  assert.match(card, /dns-chip unknown/);
  assert.match(card, /DKIM \?/);
  assert.doesNotMatch(card, /DKIM ✓/);

  db.prepare(`INSERT INTO mailboxes(id,email,domain,dkim_ok,dkim_status,active)
    VALUES(989,'sender@example.test','example.test',1,'key_published',1)`).run();
  await verifyMailboxDns(989);
  const persisted = db.prepare('SELECT dkim_ok,dkim_status,dns_records_json FROM mailboxes WHERE id=989').get();
  assert.equal(persisted.dkim_ok, null, 'a repeat DNS check clears the obsolete key-as-authentication flag');
  assert.equal(persisted.dkim_status, 'signature_unverified');
  assert.equal(JSON.parse(persisted.dns_records_json).dkim_key_status, 'published');
  const fleet = getMailboxFleet().find(mailbox => mailbox.id === 989);
  assert.equal(fleet.dkim_ok, null, 'fleet API does not expose a legacy DKIM key flag as an auth pass');
  assert.equal(fleet.dkim_status, 'signature_unverified');
});

test('B04: malformed DKIM selector TXT is not reported as a published public key', async () => {
  patchDns({ txt: { 'google._domainkey.example.test': [['v=DKIM1; k=rsa; p=not-a-public-key']] } });
  const result = await checkDomainDns('example.test');
  assert.equal(result.dkim_ok, null);
  assert.equal(result.dkim_status, 'unknown');
  assert.equal(result.dkim_key_status, 'invalid_record');
  assert.equal(result.dkim_selector, 'google');
});

test('B05: DNSBL query errors are unavailable, never silently not-listed', async () => {
  const ip = '93.184.216.34';
  patchDns({
    a4: {
      'example.test': [ip],
      // every blocklist reverse lookup times out / fails with a non-NXDOMAIN error
    },
    txt: {},
  });
  dns.promises.resolve4 = async (name) => {
    if (name === 'example.test') return [ip];
    if (name === `34.216.184.93.zen.spamhaus.org`) throw err('ETIMEDOUT');
    if (name === `34.216.184.93.b.barracudacentral.org`) throw err('ETIMEDOUT');
    if (name === `34.216.184.93.dnsbl.sorbs.net`) throw err('ETIMEDOUT');
    throw err('ENOTFOUND');
  };
  const r = await checkDomainDns('example.test');
  assert.equal(r.blacklisted, null, 'partial failures cannot become a clean/negative result');
  assert.equal(r.domain_blacklisted, null);
  assert.equal(r.blacklist_status, 'unavailable');
  assert.equal(r.domain_dnsbl_status, 'unavailable');
  assert.equal(r.domain_a_records[0], ip);
  assert.equal(r.sender_ip, null);
  assert.equal(r.sender_ip_status, 'unknown');
  assert.equal(r.sender_reputation_status, 'unknown');
  assert.deepEqual(r.blacklist_matches, []);
  assert.ok(r.dnsbl_checks.every(c => c.outcome === 'unavailable' && c.subject_type === 'domain_apex_ipv4'));
  assert.ok(r.dnsbl_checks.every(c => c.checked_ip === ip));
});

test('B05: domain A-record listing is attributed and never claims sender IP reputation', async () => {
  const ip = '93.184.216.34';
  dns.promises.resolve4 = async (name) => {
    if (name === 'example.test') return [ip];
    if (name === `34.216.184.93.zen.spamhaus.org`) return ['127.0.0.4'];
    throw err('ENOTFOUND');
  };
  const r = await checkDomainDns('example.test');
  assert.equal(r.blacklisted, null, 'generic mailbox blacklist flag stays unset for domain-only evidence');
  assert.equal(r.domain_blacklisted, 1);
  assert.equal(r.blacklist_status, 'listed');
  assert.equal(r.domain_dnsbl_status, 'listed');
  assert.deepEqual(r.domain_a_records, [ip]);
  assert.equal(r.sender_ip, null);
  assert.equal(r.sender_ip_status, 'unknown');
  assert.equal(r.sender_reputation_status, 'unknown');
  assert.deepEqual(r.blacklist_matches, ['zen.spamhaus.org']);
  const sorbs = r.dnsbl_checks.find(c => c.blocklist === 'dnsbl.sorbs.net');
  assert.equal(sorbs.outcome, 'not_listed');
  assert.equal(sorbs.subject_type, 'domain_apex_ipv4');
  assert.equal(sorbs.checked_ip, ip);

  const detail = renderDnsSheetBody(r);
  assert.match(detail, /Domain A-record DNSBL/);
  assert.match(detail, /SMTP sender-IP reputation: UNKNOWN/);
  assert.match(detail, /93\.184\.216\.34/);
  assert.doesNotMatch(detail, /✓ CLEAN/);
  const card = renderMailboxCard({
    id: 991, email: 'sender@example.test', domain: 'example.test', warmup_status: 'eligible',
    health_score: 85, daily_limit: 25, today_sent: 0, today_reserved: 0,
    domain_blacklisted: 1, domain_dnsbl_status: 'listed',
  });
  assert.match(card, /A-RECORD DNSBL ✗/);
  assert.doesNotMatch(card, /BLACKLISTED/);
});

test('B05: Spamhaus permission, rate and configuration codes are unavailable outcomes', async () => {
  const ip = '93.184.216.34';
  for (const [answer, expectedOutcome, expectedError] of [
    ['127.255.255.252', 'unavailable', 'DNSBL_QUERY_NAME_TYPO'],
    ['127.255.255.254', 'unavailable', 'DNSBL_QUERY_NOT_PERMITTED'],
    ['127.255.255.255', 'unavailable', 'DNSBL_RATE_LIMITED'],
    ['127.0.0.8', 'unavailable', 'DNSBL_UNEXPECTED_RESPONSE'],
    ['127.0.0.1', 'not_listed', null],
  ]) {
    dns.promises.resolve4 = async name => {
      if (name === 'example.test') return [ip];
      if (name === `34.216.184.93.zen.spamhaus.org`) return [answer];
      throw err('ENOTFOUND');
    };
    const result = await checkDomainDns('example.test');
    const zen = result.dnsbl_checks.find(check => check.blocklist === 'zen.spamhaus.org');
    assert.equal(zen.outcome, expectedOutcome, `${answer} must have a documented, non-guessed outcome`);
    if (expectedError) assert.equal(zen.error, expectedError);
    assert.deepEqual(zen.response_codes, [answer]);
    assert.equal(result.blacklist_status, expectedOutcome);
    assert.equal(result.blacklisted, null);
    assert.equal(result.domain_blacklisted, expectedOutcome === 'not_listed' ? 0 : null);
    assert.equal(result.sender_reputation_status, 'unknown');
  }
});

test('B05: no domain A record means not checked, not clean', async () => {
  patchDns({});
  const result = await checkDomainDns('example.test');
  assert.equal(result.dnsbl_status, 'no_a_record');
  assert.equal(result.blacklist_status, 'not_checked');
  assert.equal(result.domain_dnsbl_status, 'not_checked');
  assert.equal(result.blacklisted, null);
  assert.equal(result.domain_blacklisted, null);
  assert.deepEqual(result.dnsbl_checks, []);
  assert.equal(result.sender_ip_status, 'unknown');
});

test('B05: bounded lookups never report clean when domain A records were skipped', async () => {
  const ips = Array.from({ length: 9 }, (_, index) => `93.184.216.${index + 1}`);
  dns.promises.resolve4 = async name => {
    if (name === 'example.test') return ips;
    throw err('ENOTFOUND');
  };
  const result = await checkDomainDns('example.test');
  assert.equal(result.domain_a_records.length, 8);
  assert.equal(result.domain_a_records_truncated, true);
  assert.equal(result.dnsbl_unchecked_domain_ip_count, 1);
  assert.equal(result.dnsbl_coverage_status, 'partial');
  assert.equal(result.domain_dnsbl_status, 'unavailable');
  assert.equal(result.blacklisted, null);
  assert.equal(result.domain_blacklisted, null);
});

test('B05: mailbox persistence and fleet output retain domain evidence separately from sender IP', async () => {
  const ip = '93.184.216.34';
  dns.promises.resolve4 = async name => {
    if (name === 'example.test') return [ip, '198.51.100.4'];
    throw err('ENOTFOUND');
  };
  db.prepare(`INSERT INTO mailboxes(id,email,domain,active,blacklisted,blacklist_status)
    VALUES(992,'another@example.test','example.test',1,1,'unknown')`).run();
  const result = await verifyMailboxDns(992);
  assert.deepEqual(result.domain_a_records, [ip, '198.51.100.4']);
  assert.equal(result.domain_dnsbl_status, 'not_listed');
  const stored = db.prepare('SELECT blacklisted,blacklist_status,dns_records_json FROM mailboxes WHERE id=992').get();
  assert.equal(stored.blacklisted, null, 'mailbox legacy field never stores a domain-only listing claim');
  assert.equal(stored.blacklist_status, 'not_listed');
  assert.equal(db.prepare("SELECT blacklisted FROM domains WHERE domain='example.test'").get().blacklisted, 0);
  assert.deepEqual(JSON.parse(stored.dns_records_json).domain_a_records, [ip, '198.51.100.4']);
  const fleet = getMailboxFleet().find(mailbox => mailbox.id === 992);
  assert.equal(fleet.domain_dnsbl_status, 'not_listed');
  assert.equal(fleet.domain_blacklisted, 0);
  assert.equal(Object.hasOwn(fleet, 'blacklisted'), false, 'fleet API omits the ambiguous legacy mailbox field');
  assert.equal(fleet.sender_ip_status, 'unknown');
  assert.equal(fleet.sender_reputation_status, 'unknown');
});

// ── B07/B13 personalization approval semantics ─────────────────
function copyFixture() {
  db.exec('DELETE FROM events; DELETE FROM personalizations; DELETE FROM leads;');
  db.prepare("INSERT INTO leads(id, business_name, status) VALUES (1, 'Fixture Co', 'awaiting_approval')").run();
  db.prepare(`INSERT INTO personalizations(id, lead_id, subject_line, body_text, guardrail_passed,
    fact_check_passed, fact_check_status, approved) VALUES (1, 1, 's', 'b', 1, 1, 'passed', 1)`).run();
}

test('B07: editing approved copy invalidates approval and marks the check unavailable', () => {
  copyFixture();
  const r = editPersonalization(1, { subject_line: 'edited subject' });
  assert.equal(r.approval_invalidated, true);
  const p = db.prepare('SELECT * FROM personalizations WHERE id=1').get();
  assert.equal(p.approved, 0);
  assert.equal(p.fact_check_status, 'unavailable');
  assert.equal(p.subject_line, 'edited subject');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=1').get().status, 'awaiting_approval');
});

test('B07: human approval never rewrites an unavailable fact-check into a pass', () => {
  copyFixture();
  editPersonalization(1, { subject_line: 'edited' });
  const r = approvePersonalization(1, 'test-operator');
  assert.equal(r.approved, true);
  assert.equal(r.fact_check_status, 'unavailable');
  const p = db.prepare('SELECT * FROM personalizations WHERE id=1').get();
  assert.equal(p.approved, 1);
  assert.equal(p.fact_check_status, 'unavailable', 'approval must not fabricate a passed check');
  assert.equal(p.fact_check_passed, 0);
  const audit = db.prepare("SELECT * FROM events WHERE event_type='copy_approved'").all();
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].meta_json).auto_approve, false);
});

// ── B09 CRM sync truthfulness ──────────────────────────────────
function leadFixture() {
  db.exec("DELETE FROM personalizations; DELETE FROM leads;");
  db.prepare("INSERT INTO leads(id, business_name, website_url, status) VALUES (1, 'Fixture Co', 'https://fixtureco.test/site', 'sent')").run();
}

test('B09: without CRM configuration the lead is NOT reported synchronized', async () => {
  delete process.env.TWENTY_API_TOKEN;
  delete process.env.TWENTY_API_URL;
  leadFixture();
  const r = await syncLeadToCRM(1);
  assert.equal(r.synced, false);
  assert.equal(r.status, 'not_configured');
  assert.equal(db.prepare('SELECT crm_sync_status FROM leads WHERE id=1').get().crm_sync_status, 'not_configured');
});

test('B09: GraphQL errors in an HTTP 200 response are failures, not success', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'Field CompanyCreateInput is not defined' }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TWENTY_API_URL = `http://127.0.0.1:${server.address().port}/graphql`;
  process.env.TWENTY_API_TOKEN = 'fixture-not-a-real-token-123456';
  try {
    leadFixture();
    const r = await syncLeadToCRM(1);
    assert.equal(r.synced, false, 'HTTP 200 with GraphQL errors must not be a synchronized success');
    assert.equal(r.status, 'failed');
    assert.match(r.detail, /not defined/);
    assert.equal(db.prepare('SELECT crm_sync_status FROM leads WHERE id=1').get().crm_sync_status, 'failed');
  } finally { await new Promise(r => server.close(r)); delete process.env.TWENTY_API_URL; delete process.env.TWENTY_API_TOKEN; }
});

test('B09: a verified createCompany response persists the real remote id', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { createCompany: { id: 'cmp_real_9f2', name: 'Fixture Co' } } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TWENTY_API_URL = `http://127.0.0.1:${server.address().port}/graphql`;
  process.env.TWENTY_API_TOKEN = 'fixture-not-a-real-token-123456';
  try {
    leadFixture();
    const r = await syncLeadToCRM(1);
    assert.equal(r.synced, true);
    assert.equal(r.remoteId, 'cmp_real_9f2');
    const lead = db.prepare('SELECT crm_remote_id, crm_sync_status FROM leads WHERE id=1').get();
    assert.equal(lead.crm_remote_id, 'cmp_real_9f2');
    assert.equal(lead.crm_sync_status, 'synced');
    assert.match(received.query, /createCompany/);
    assert.equal(received.variables.data.name, 'Fixture Co');
    assert.equal(received.variables.data.domainName, 'fixtureco.test');
  } finally { await new Promise(r => server.close(r)); delete process.env.TWENTY_API_URL; delete process.env.TWENTY_API_TOKEN; }
});

test('B09: CRM unreachable is a retryable failure, never local-fallback success', async () => {
  process.env.TWENTY_API_URL = 'http://127.0.0.1:9/graphql';
  process.env.TWENTY_API_TOKEN = 'fixture-not-a-real-token-123456';
  try {
    leadFixture();
    const r = await syncLeadToCRM(1);
    assert.equal(r.synced, false);
    assert.equal(r.status, 'failed');
    assert.equal(r.retryable, true);
    assert.equal(db.prepare('SELECT crm_sync_status FROM leads WHERE id=1').get().crm_sync_status, 'failed');
  } finally { delete process.env.TWENTY_API_URL; delete process.env.TWENTY_API_TOKEN; }
});

// ── B08/B12 server contract (child process, isolated DB) ──────
test('B08/B12: analytics reports unknown costs; UI cancel/close routes exist', async () => {
  const serverDir = mkdtempSync(path.join(tmpdir(), 'odd-server-'));
  const port = 41000 + (process.pid % 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(process.cwd()),
    env: { ...process.env, NODE_ENV: 'test', ODD_DB_PATH: path.join(serverDir, 'srv.db'), PORT: String(port), NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  const request = (p, opts = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise(r => setTimeout(r, 250));
      up = await request('/api/batches').then(r => r.status < 500).catch(() => false);
    }
    assert.ok(up, 'server did not start');

    const analytics = await request('/api/stats/analytics');
    assert.equal(analytics.status, 200);
    const payload = JSON.parse(analytics.body);
    assert.equal(payload.aiCost.usage_status, 'unknown');
    assert.equal(payload.aiCost.bedrock_tokens, null, 'token estimates must be null, not fabricated');
    assert.equal(payload.aiCost.bedrock_usd, null);
    assert.equal(payload.aiCost.cost_per_lead, null);
    for (const t of payload.aiCost.tasks) assert.equal(t.cost_usd, null);
    for (const n of payload.niches) assert.equal(n.cost_per_reply, null);

    const qc = await request('/api/qualify/cancel', { method: 'POST' });
    assert.equal(qc.status, 200);
    assert.equal(JSON.parse(qc.body).ok, true);

    const vc = await request('/api/verify/cancel', { method: 'POST' });
    assert.equal(vc.status, 200);
    assert.equal(JSON.parse(vc.body).ok, true);

    const missing = await request('/api/batches/999/close', { method: 'POST' });
    assert.equal(missing.status, 404);

    const create = await request('/api/batches', { method: 'POST', body: JSON.stringify({ name: 'Close Contract', phase: 'discovery' }) });
    assert.equal(create.status, 201);
    const created = JSON.parse(create.body);
    const close1 = await request(`/api/batches/${created.id}/close`, { method: 'POST' });
    assert.equal(close1.status, 200);
    const close2 = await request(`/api/batches/${created.id}/close`, { method: 'POST' });
    assert.equal(close2.status, 409, 'closing twice must be rejected, not silently ok');
  } finally {
    child.kill();
    await new Promise(r => { child.once('exit', r); setTimeout(r, 5000).unref?.(); });
    await new Promise(r => setTimeout(r, 200));
    try { rmSync(serverDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows file-lock residual */ }
  }
});
