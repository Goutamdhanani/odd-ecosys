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
import { spawn } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-truth-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { checkDomainDns } = await import('../pipeline/sending-engine.js');
const { editPersonalization, approvePersonalization } = await import('../pipeline/personalizer.js');
const { syncLeadToCRM } = await import('../pipeline/crm-sync.js');

after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

// ── DNS layer test double: controlled resolver responses ──────
const realResolveTxt = dns.promises.resolveTxt.bind(dns.promises);
const realResolve4 = dns.promises.resolve4.bind(dns.promises);
const err = (code) => Object.assign(new Error(code), { code });
after(() => { dns.promises.resolveTxt = realResolveTxt; dns.promises.resolve4 = realResolve4; });

function patchDns({ txt = {}, a4 = {} }) {
  dns.promises.resolveTxt = async (name) => {
    if (name in txt) return txt[name];
    throw err('ENOTFOUND');
  };
  dns.promises.resolve4 = async (name) => {
    if (name in a4) return a4[name];
    throw err('ENOTFOUND');
  };
}

test('B04: SPF+DMARC presence without a DKIM selector is NOT a DKIM pass', async () => {
  patchDns({ txt: { 'example.test': [['v=spf1 include:_spf.google.com ~all']], '_dmarc.example.test': [['v=DMARC1; p=none']] } });
  const r = await checkDomainDns('example.test');
  assert.equal(r.spf_ok, 1);
  assert.equal(r.dmarc_ok, 1);
  assert.equal(r.dkim_ok, 0, 'dkim_ok must not be derived from SPF+DMARC presence');
  assert.equal(r.dkim_status, 'no_selector_found');
  assert.equal(r.dkim_selector, null);
});

test('B04: DKIM pass requires an observed selector key record', async () => {
  patchDns({
    txt: {
      'example.test': [['v=spf1 ~all']],
      'google._domainkey.example.test': [['v=DKIM1; k=rsa; p=MIIBIjANBgkq']],
    },
  });
  const r = await checkDomainDns('example.test');
  assert.equal(r.dkim_ok, 1);
  assert.equal(r.dkim_status, 'key_published');
  assert.equal(r.dkim_selector, 'google');
  assert.match(r.dkim_record, /v=DKIM1/);
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
  assert.equal(r.blacklisted, 0);
  assert.equal(r.blacklist_status, 'unavailable', 'unresolved DNSBL checks must stay unknown');
  assert.deepEqual(r.blacklist_matches, []);
  assert.ok(r.dnsbl_checks.every(c => c.outcome === 'unavailable'));
});

test('B05: an actual DNSBL listing is the only listed evidence', async () => {
  const ip = '93.184.216.34';
  dns.promises.resolve4 = async (name) => {
    if (name === 'example.test') return [ip];
    if (name === `34.216.184.93.zen.spamhaus.org`) return ['127.0.0.4'];
    throw err('ENOTFOUND');
  };
  const r = await checkDomainDns('example.test');
  assert.equal(r.blacklisted, 1);
  assert.equal(r.blacklist_status, 'listed');
  assert.deepEqual(r.blacklist_matches, ['zen.spamhaus.org']);
  const sorbs = r.dnsbl_checks.find(c => c.blocklist === 'dnsbl.sorbs.net');
  assert.equal(sorbs.outcome, 'not_listed');
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
    env: { ...process.env, ODD_DB_PATH: path.join(serverDir, 'srv.db'), PORT: String(port), NODE_NO_WARNINGS: '1' },
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
