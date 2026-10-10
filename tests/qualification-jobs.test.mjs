import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-qualification-jobs-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'qualification-jobs-bootstrap-fixture-123456';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const database = await import('../pipeline/database.js');
let db = database.initDb();
const qualifier = await import('../pipeline/qualifier.js');
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

after(async () => {
  await new Promise(resolve => server.close(resolve));
  database.closeDb();
  rmSync(directory, { recursive: true, force: true });
});

function authCookies(setCookie) {
  const session = setCookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrf = setCookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'workspace login issues a session cookie');
  assert.ok(csrf, 'workspace login issues a CSRF cookie');
  return { cookie: `odd_session=${session}; odd_csrf=${csrf}`, csrf: decodeURIComponent(csrf) };
}

async function request(route, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.csrf) headers['x-csrf-token'] = auth.csrf;
  const response = await fetch(`${base}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* retain empty response */ }
  return { status: response.status, setCookie: response.headers.get('set-cookie') || '', body: payload };
}

function syntheticResult() {
  return {
    site_status: 'OUTDATED', site_score: 24, site_reasons: ['synthetic fixture'], confidence: 46,
    signals: { ssl_valid: false, viewport_meta: null }, scoring: { version: 1, configHash: 'fixture' },
    fb_active: null, screenshot_path: null,
  };
}

test('qualification progress, cancel, failure retry, and restart recovery persist without stranded checking leads', async t => {
  const bootstrapped = await request('/api/auth/bootstrap', {
    method: 'POST', body: {
      email: 'qualification-owner@example.test', password: 'qualification-owner-password-fixture-2026',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(bootstrapped.status, 201);
  const owner = authCookies(bootstrapped.setCookie);
  assert.equal((await request('/api/qualify/status', { auth: owner })).status, 200, 'initialize the application before claiming a run');
  assert.equal((await request('/api/qualify/status?batch_id=invalid', { auth: owner })).status, 400);

  const batchResult = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Qualification job fixture','qualification','open')").run();
  const batchId = Number(batchResult.lastInsertRowid);
  const addLead = db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,'https://synthetic.invalid/','discovered')");
  const leadIds = [1, 2, 3, 4].map(id => Number(addLead.run(batchId, `Synthetic lead ${id}`).lastInsertRowid));

  let announceStarted;
  const started = new Promise(resolve => { announceStarted = resolve; });
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const firstRun = qualifier.startQualificationBatch(batchId, {
    concurrency: 1,
    qualifyLeadImpl: async lead => {
      announceStarted(lead.id);
      if (lead.id === leadIds[0]) await gate;
      return syntheticResult();
    },
  });
  assert.equal(await started, leadIds[0]);

  const active = await request(`/api/qualify/status?batch_id=${batchId}`, { auth: owner });
  assert.equal(active.status, 200);
  assert.equal(active.body.jobId, firstRun.jobId);
  assert.equal(active.body.status, 'running');
  assert.equal(active.body.active, true);
  assert.equal(active.body.processed, 0);
  assert.equal(active.body.total, 4);
  assert.deepEqual(active.body.currentLeadIds, [leadIds[0]]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='checking'").get(batchId).count, 1);
  await assert.rejects(() => qualifier.qualifyBatch(batchId, { qualifyLeadImpl: async () => syntheticResult() }), error => error.statusCode === 409);

  const cancelled = await request(`/api/qualify/batch/${batchId}/cancel`, { method: 'POST', auth: owner });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, true);
  assert.equal(cancelled.body.status, 'cancel_requested');
  releaseFirst();
  const firstSummary = await firstRun.promise;
  assert.equal(firstSummary.status, 'cancelled');
  assert.equal(firstSummary.processed, 1);
  assert.equal(firstSummary.total, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='checking'").get(batchId).count, 0);
  assert.equal(db.prepare("SELECT status FROM leads WHERE id=?").get(leadIds[0]).status, 'site_checked');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE id IN (?,?,?) AND status='discovered'").get(...leadIds.slice(1)).count, 3);

  const recoveredAfterRestart = await request(`/api/qualify/status?batch_id=${batchId}`, { auth: owner });
  assert.equal(recoveredAfterRestart.body.status, 'cancelled');
  assert.equal(recoveredAfterRestart.body.processed, 1);

  // Simulate a process exit after it claimed two leads but before it persisted results.
  db.prepare("UPDATE leads SET status='checking' WHERE id=?").run(leadIds[1]);
  const interrupted = db.prepare(`INSERT INTO qualification_jobs(batch_id,status,total,processed,started_at,current_lead_ids_json)
    VALUES (?,'running',3,0,datetime('now'),?)`).run(batchId, JSON.stringify([leadIds[1], leadIds[2]]));
  assert.deepEqual(qualifier.recoverInterruptedQualificationJobs(), [{ id: Number(interrupted.lastInsertRowid), status: 'interrupted' }]);
  assert.equal(db.prepare("SELECT status FROM leads WHERE id=?").get(leadIds[1]).status, 'discovered');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE status='checking'").get().count, 0);
  const interruptedStatus = await request(`/api/qualify/status?batch_id=${batchId}`, { auth: owner });
  assert.equal(interruptedStatus.body.status, 'interrupted');
  assert.equal(interruptedStatus.body.errorCode, 'worker_restarted');
  assert.equal(interruptedStatus.body.retryableCount, 3);

  const failedRun = await qualifier.qualifyBatch(batchId, {
    concurrency: 1,
    qualifyLeadImpl: async lead => {
      if (lead.id === leadIds[3]) throw new Error('synthetic site check timeout');
      return syntheticResult();
    },
  });
  assert.equal(failedRun.status, 'completed');
  assert.equal(failedRun.processed, 3);
  assert.equal(failedRun.failedCount, 1);
  assert.equal(db.prepare("SELECT status FROM leads WHERE id=?").get(leadIds[3]).status, 'discovered');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='checking'").get(batchId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE lead_id IN (?,?,?) AND event_type='site_check'").get(...leadIds.slice(1)).count, 2);
  const failedStatus = await request(`/api/qualify/status?batch_id=${batchId}`, { auth: owner });
  assert.equal(failedStatus.body.status, 'completed');
  assert.equal(failedStatus.body.failedCount, 1);
  assert.equal(failedStatus.body.retryableCount, 1);
  assert.equal(failedStatus.body.statusCounts.OUTDATED, 2);

  const staleDate = '2020-01-01 00:00:00';
  db.prepare("UPDATE leads SET site_checked_at=?,status='site_checked' WHERE id=?").run(staleDate, leadIds[0]);
  db.prepare("UPDATE leads SET site_checked_at=?,status='checking' WHERE id=?").run(staleDate, leadIds[3]);
  const protectedWon = Number(addLead.run(batchId, 'Protected won contact').lastInsertRowid);
  const protectedSent = Number(addLead.run(batchId, 'Protected sent contact').lastInsertRowid);
  db.prepare("UPDATE leads SET site_checked_at=?,status='won' WHERE id=?").run(staleDate, protectedWon);
  db.prepare("UPDATE leads SET site_checked_at=?,status='sent' WHERE id=?").run(staleDate, protectedSent);
  assert.equal(qualifier.getStaleLeadCount(60), 1, 'stale counting excludes a currently checking lead and uses SQL COUNT');
  assert.throws(() => qualifier.getStaleLeadCount(0), /1 to 3650 days/);
  const staleRequest = await request('/api/qualify/recheck-stale', { method: 'POST', auth: owner, body: { days: 60 } });
  assert.equal(staleRequest.status, 200);
  assert.equal(staleRequest.body.requeued, 1);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(leadIds[0]).status, 'discovered');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(leadIds[3]).status, 'checking');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(protectedWon).status, 'won');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(protectedSent).status, 'sent');
  await assert.rejects(() => qualifier.requalifyLead(protectedSent), error => error.statusCode === 409);
  db.prepare("UPDATE leads SET status='discovered' WHERE id=?").run(leadIds[3]);

  const retryRun = await qualifier.qualifyBatch(batchId, {
    concurrency: 2, qualifyLeadImpl: async () => syntheticResult(),
  });
  assert.equal(retryRun.status, 'completed');
  assert.equal(retryRun.total, 2, 'the retry processes the stale lead and the previously failed lead only');
  assert.equal(retryRun.processed, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='checking'").get(batchId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='site_checked'").get(batchId).count, 4);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  const emptyBatch = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Empty API start fixture','qualification','open')").run().lastInsertRowid);
  const apiStart = await request(`/api/qualify/batch/${emptyBatch}`, { method: 'POST', auth: owner });
  assert.equal(apiStart.status, 202);
  assert.equal(apiStart.body.started, true);
  assert.ok(apiStart.body.jobId);
  const apiStartStatus = await request(`/api/qualify/status?batch_id=${emptyBatch}`, { auth: owner });
  assert.equal(apiStartStatus.body.status, 'completed');
  assert.equal(apiStartStatus.body.total, 0);

  if (!existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    const session = owner.cookie.match(/odd_session=([^;]+)/)?.[1];
    const csrf = owner.cookie.match(/odd_csrf=([^;]+)/)?.[1];
    await context.addCookies([
      { name: 'odd_session', value: decodeURIComponent(session), url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), url: base, sameSite: 'Strict' },
    ]);
    await page.goto(`${base}/#qualification`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Know who’s worth a closer look.' }).waitFor({ timeout: 10_000 });
    await page.getByText('Last qualification run · completed').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Qualify leads' }).isDisabled(), true);
    assert.deepEqual(pageErrors, [], 'durable run summary renders without browser errors');
  } finally {
    await context.close();
    await browser.close();
  }
  database.closeDb();
  db = database.initDb();
  assert.equal(qualifier.getQualificationStatus(batchId).status, 'completed', 'job state remains durable after the SQLite connection reopens');
});
