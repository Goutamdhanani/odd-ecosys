import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-discovery-verification-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
delete process.env.ODD_AUTH_ENFORCE_TESTS;
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const database = await import('../pipeline/database.js');
let db = database.initDb();
const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES('Verifier handoff fixtures','discovery','open')").run().lastInsertRowid);
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { createWebsiteDiscoveryJobs } = await import('../pipeline/website-discovery-jobs.js');
const { createContact } = await import('../pipeline/contact-manager.js');
const emailVerifier = await import('../pipeline/email-verifier.js');
const { setWebsiteEmailDiscoveryTestManager, setWebsiteDiscoveryJobsTestManager, server } = await import('../server.js');

const statusByEmail = new Map([
  ['sales@deliverable.example.test', 'deliverable'],
  ['sales@risky.example.test', 'risky'],
  ['sales@unknown.example.test', 'unknown'],
  ['sales@rejected.example.test', 'undeliverable'],
  ['shared@duplicate.example.test', 'deliverable'],
  ['sales@failed.example.test', 'deliverable'],
  ['sales@newly-suppressed.example.test', 'deliverable'],
  ['sales@suppressed.example.test', 'deliverable'],
]);
const verificationCalls = [];
const scanCalls = [];

function html(body) { return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }); }
async function fixtureFetch(input) {
  const url = new URL(input);
  scanCalls.push(url.href);
  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  const address = url.hostname === 'duplicate-a.example.test' || url.hostname === 'duplicate-b.example.test'
    ? 'shared@duplicate.example.test'
    : `sales@${url.hostname}`;
  return html(`<html><body><main>Business enquiries: <a href="mailto:${address}">${address}</a></main></body></html>`);
}

const discovery = createWebsiteEmailDiscovery({ db, fetchImpl: fixtureFetch, minimumRequestIntervalMs: 0, wait: async () => {} });
let jobs = createWebsiteDiscoveryJobs({
  db, discovery, createContact, schedule: callback => setImmediate(callback),
  verifyCandidate: (emailId, context) => emailVerifier.reverifyEmailById(emailId, {
    verifyEmailImpl: async email => {
      verificationCalls.push({ email, sourceUrl: context.sourceUrl });
      if (email === 'sales@failed.example.test' || email === 'sales@newly-suppressed.example.test') {
        throw Object.assign(new Error('synthetic timeout'), { code: 'provider_timeout' });
      }
      return {
        verification_status: statusByEmail.get(email) || 'unknown',
        score: email === 'sales@deliverable.example.test' ? 92 : undefined,
        is_catch_all: false, is_role_account: false, is_free_provider: false, is_disposable: false,
        mx_host: `mx.${email.split('@')[1]}`,
      };
    },
  }),
});
setWebsiteEmailDiscoveryTestManager(discovery);
setWebsiteDiscoveryJobsTestManager(jobs);

if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  jobs.close();
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function request(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  return { response, body: contentType.includes('json') ? await response.json() : await response.text() };
}

async function waitForJob(id) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await request(`/api/leads/website-discovery-jobs/${id}`);
    if (['completed', 'partial', 'failed'].includes(result.body.status)
      && Number(result.body.progress?.verification?.waiting || 0) === 0) return result.body;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Discovery job ${id} did not finish.`);
}

test('HTTP website discovery verifies unique source-backed emails and persists honest outcomes', async () => {
  db.prepare("INSERT INTO suppression_list(email,reason) VALUES('sales@suppressed.example.test','fixture unsubscribe')").run();
  const created = await request('/api/leads/website-discovery-jobs', {
    method: 'POST',
    body: { batch_id: batchId, businesses: [
      { business_name: 'Deliverable Fixture', website_url: 'https://deliverable.example.test/' },
      { business_name: 'Risky Fixture', website_url: 'https://risky.example.test/' },
      { business_name: 'Unknown Fixture', website_url: 'https://unknown.example.test/' },
      { business_name: 'Rejected Fixture', website_url: 'https://rejected.example.test/' },
      { business_name: 'Failed Fixture', website_url: 'https://failed.example.test/' },
      { business_name: 'New Suppression Fixture', website_url: 'https://newly-suppressed.example.test/' },
      { business_name: 'Suppressed Fixture', website_url: 'https://suppressed.example.test/' },
      { business_name: 'Duplicate A', website_url: 'https://duplicate-a.example.test/' },
      { business_name: 'Duplicate B', website_url: 'https://duplicate-b.example.test/' },
    ] },
  });
  assert.equal(created.response.status, 201);
  const job = await waitForJob(created.body.id);
  assert.equal(job.status, 'partial', 'a checker failure is visible instead of being called success');
  assert.equal(job.progress.found_emails, 8, 'the two businesses sharing an address count once');
  assert.deepEqual(job.progress.verification, {
    waiting: 0, deliverable: 2, risky: 1, unknown: 1, undeliverable: 1, suppressed: 1, failed: 2, cancelled: 0,
  });
  assert.equal(verificationCalls.length, 7, 'each unique unsuppressed address is checked once');
  assert.equal(verificationCalls.some(call => call.email === 'sales@suppressed.example.test'), false);
  assert.equal(verificationCalls.filter(call => call.email === 'shared@duplicate.example.test').length, 1);
  assert.ok(verificationCalls.every(call => call.sourceUrl.startsWith('https://')));
  assert.ok(scanCalls.length > 0, 'the request used the synthetic website transport');

  const stored = db.prepare(`SELECT le.email,le.verification_status,le.verified_at,le.confidence_score,
      vc.status AS check_status,vc.verification_status AS check_result,vc.error_code,vc.source_url
    FROM lead_emails le JOIN website_discovery_tasks t ON t.lead_id=le.lead_id AND t.job_id=?
    JOIN website_discovery_email_checks vc ON vc.job_id=t.job_id AND vc.normalized_email=lower(trim(le.email))
    ORDER BY le.email,le.id`).all(created.body.id);
  assert.ok(stored.find(row => row.email === 'sales@deliverable.example.test' && row.verification_status === 'deliverable'
    && row.verified_at && row.confidence_score === 92));
  assert.ok(stored.find(row => row.email === 'sales@risky.example.test' && row.check_result === 'risky'));
  assert.ok(stored.find(row => row.email === 'sales@unknown.example.test' && row.check_status === 'completed'
    && row.check_result === 'unknown'));
  assert.ok(stored.find(row => row.email === 'sales@rejected.example.test' && row.verification_status === 'undeliverable'));
  assert.ok(stored.find(row => row.email === 'sales@failed.example.test' && row.verification_status === 'unknown'
    && row.check_status === 'failed' && row.error_code === 'provider_timeout'));
  assert.ok(stored.find(row => row.email === 'sales@newly-suppressed.example.test' && row.check_status === 'failed'));
  assert.ok(stored.find(row => row.email === 'sales@suppressed.example.test' && row.check_status === 'suppressed'));
  assert.ok(stored.find(row => row.email === 'shared@duplicate.example.test' && row.verification_status === 'deliverable'));
  assert.ok(stored.every(row => row.source_url.startsWith('https://')));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM website_discovery_email_checks WHERE job_id=?').get(created.body.id).count, 8);
  assert.equal(db.prepare("SELECT consent_recorded_at FROM leads WHERE business_name='Deliverable Fixture'").get().consent_recorded_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);

  const csv = await request(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.equal(csv.response.status, 200);
  assert.ok(csv.body.includes('"verification_check_status","discovery_verification_result","verification_error_code"'));
  assert.match(csv.body, /sales@deliverable\.example\.test.*completed.*deliverable/);
  assert.match(csv.body, /sales@failed\.example\.test.*failed.*provider_timeout/);

  const durable = db.prepare(`SELECT id,job_id,lead_id,lead_email_id,normalized_email,source_url
    FROM website_discovery_email_checks WHERE job_id=? AND normalized_email='shared@duplicate.example.test'`).get(created.body.id);
  db.prepare(`UPDATE website_discovery_email_checks SET status='running',verification_status=NULL,completed_at=NULL WHERE id=?`).run(durable.id);
  jobs.close();
  database.closeDb();

  // Simulate a process restart after the verifier saved its result but before
  // the job check row was finalized. Recovery must use that durable result.
  db = database.initDb();
  let recoveryVerificationCalls = 0;
  const recoveryDiscovery = { scanLead: async () => { throw new Error('completed site must not be scanned again'); }, getLeadScan: () => null };
  jobs = createWebsiteDiscoveryJobs({
    db, discovery: recoveryDiscovery, createContact,
    verifyCandidate: async () => { recoveryVerificationCalls += 1; throw new Error('saved verification must not be repeated'); },
    schedule: callback => setImmediate(callback),
  });
  setWebsiteDiscoveryJobsTestManager(jobs);
  jobs.recover();
  const recovered = await waitForJob(created.body.id);
  assert.equal(recoveryVerificationCalls, 0, 'a saved verifier result is not dispatched again after restart');
  const recoveredCheck = db.prepare(`SELECT status,verification_status,attempt_count FROM website_discovery_email_checks WHERE id=?`).get(durable.id);
  assert.deepEqual(recoveredCheck, { status: 'completed', verification_status: 'deliverable', attempt_count: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  assert.equal(recovered.progress.verification.deliverable, 2);

  db.prepare(`INSERT INTO suppression_list(email,reason) VALUES(?,?)`)
    .run('sales@newly-suppressed.example.test', 'operator suppression added after first check');
  jobs.close();
  const deferredDrains = [];
  const retryCalls = [];
  const retryVerifier = emailId => emailVerifier.reverifyEmailById(emailId, {
    verifyEmailImpl: async email => {
      retryCalls.push(email);
      return { verification_status: 'deliverable', score: 86, is_catch_all: false, is_role_account: false,
        is_free_provider: false, is_disposable: false, mx_host: `mx.${email.split('@')[1]}` };
    },
  });
  jobs = createWebsiteDiscoveryJobs({ db, discovery: recoveryDiscovery, createContact,
    verifyCandidate: retryVerifier, schedule: callback => deferredDrains.push(callback) });
  setWebsiteDiscoveryJobsTestManager(jobs);
  jobs.recover();
  const retry = await request(`/api/leads/website-discovery-jobs/${created.body.id}/retry-verification`, { method: 'POST' });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.retry_queued, 2);
  assert.equal(retry.body.job.progress.verification.waiting, 2);
  const duplicateRetry = await request(`/api/leads/website-discovery-jobs/${created.body.id}/retry-verification`, { method: 'POST' });
  assert.equal(duplicateRetry.body.retry_queued, 0, 'a second action cannot queue the same failed check twice');
  assert.deepEqual(retryCalls, [], 'queued retries remain durable until a worker claims them');

  jobs.close();
  jobs = createWebsiteDiscoveryJobs({ db, discovery: recoveryDiscovery, createContact,
    verifyCandidate: retryVerifier, schedule: callback => setImmediate(callback) });
  setWebsiteDiscoveryJobsTestManager(jobs);
  jobs.recover();
  const retried = await waitForJob(created.body.id);
  assert.deepEqual(retryCalls, ['sales@failed.example.test'], 'new suppression is rechecked before verification');
  assert.deepEqual(retried.progress.verification, {
    waiting: 0, deliverable: 3, risky: 1, unknown: 1, undeliverable: 1, suppressed: 2, failed: 0, cancelled: 0,
  });
  const retriedRows = db.prepare(`SELECT normalized_email,status,attempt_count FROM website_discovery_email_checks
    WHERE job_id=? AND normalized_email IN ('sales@failed.example.test','sales@newly-suppressed.example.test') ORDER BY normalized_email`)
    .all(created.body.id);
  assert.deepEqual(retriedRows, [
    { normalized_email: 'sales@failed.example.test', status: 'completed', attempt_count: 2 },
    { normalized_email: 'sales@newly-suppressed.example.test', status: 'suppressed', attempt_count: 2 },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0);
  const retriedCsv = await request(`/api/leads/website-discovery-jobs/${created.body.id}/export`);
  assert.match(retriedCsv.body, /sales@failed\.example\.test.*completed.*deliverable/);
  assert.match(retriedCsv.body, /sales@newly-suppressed\.example\.test.*suppressed.*address_suppressed/);
});
