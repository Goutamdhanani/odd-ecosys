import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAuthManager } from '../pipeline/auth-manager.js';
import { decodeBase32, totpCode } from '../pipeline/totp.js';

const PASSWORD = 'synthetic-owner-password-2026';
const WRONG_PASSWORD = 'synthetic-wrong-password-2026';
const EMAIL = 'owner@example.test';
const IP = '127.0.0.73';
const INTERVAL = 15 * 60_000;
const FIXED_NOW = 1_800_000_000_000;
const WAVE_SIZE = 12;
Object.assign(process.env, {
  NODE_ENV: 'test',
  ODD_AUTH_ENFORCE_TESTS: 'true',
  ODD_AUTH_BOOTSTRAP_TOKEN: 'synthetic-private-bootstrap-token-0123456789',
  ODD_CREDENTIAL_ENCRYPTION_KEY: '7a'.repeat(32),
  ODD_CREDENTIAL_PREVIOUS_KEYS: '',
  ODD_GOOGLE_LOGIN_ENABLED: 'false',
  ODD_AUTH_COOKIE_SECURE: 'false',
});

const digest = value => createHash('sha256').update(value).digest('hex');
const loginKeys = (email = EMAIL, ip = IP) => [digest(`login\0${email}\0${ip}`), digest(`login-ip\0${ip}`)];
const stepupKeys = (userId, ip = IP) => [digest(`mfa-stepup-user\0${userId}`), digest(`mfa-stepup-ip\0${ip}`)];
const rows = db => db.prepare('SELECT attempt_key,failures,window_started_at,locked_until FROM auth_login_attempts ORDER BY attempt_key').all();
const sessions = db => db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count;

function clock(t) {
  const original = Date.now;
  let now = FIXED_NOW;
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  return { get now() { return now; }, set(value) { now = value; } };
}

async function fixture(t, { durable = false, mfa = false } = {}) {
  const directory = durable ? mkdtempSync(path.join(tmpdir(), 'odd-auth-concurrency-')) : null;
  const filename = directory ? path.join(directory, 'fixture.db') : ':memory:';
  let db = new Database(filename);
  let auth = createAuthManager(db);
  t.after(() => {
    if (db.open) db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const owner = await auth.bootstrap({ email: EMAIL, password: PASSWORD,
    bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN, remoteAddress: IP });
  const actor = auth.currentSession(owner.sessionToken);
  let recoveryCodes;
  if (mfa) {
    const enrollment = auth.beginMfaEnrollment(actor, IP);
    ({ recoveryCodes } = auth.confirmMfaEnrollment(actor, totpCode(decodeBase32(enrollment.secret)), IP));
    assert.equal(auth.mfaStatus(actor).enabled, true);
  }
  return {
    get db() { return db; }, get auth() { return auth; }, actor, recoveryCodes,
    reopen() { db.close(); db = new Database(filename); auth = createAuthManager(db); },
  };
}

async function failures(auth, emails = Array(WAVE_SIZE).fill(EMAIL), ip = IP) {
  return Promise.all(emails.map(email => auth.login({ email, password: WRONG_PASSWORD, remoteAddress: ip })
    .then(() => ({ status: 200 }), error => ({ status: error.statusCode, message: error.message }))));
}

function forceLock(db, keys, now) {
  const save = db.prepare(`INSERT INTO auth_login_attempts(attempt_key,failures,window_started_at,locked_until)
    VALUES (?,5,?,?) ON CONFLICT(attempt_key) DO UPDATE SET
    failures=excluded.failures,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until`);
  for (const key of keys) save.run(key, now, now + INTERVAL);
}

for (const email of [EMAIL, 'unknown@example.test']) {
  test(`parallel wrong passwords retain all failures and an active lock for ${email}`, async t => {
    const time = clock(t);
    const { db, auth } = await fixture(t);
    const sessionCount = sessions(db);
    const result = await failures(auth, Array(WAVE_SIZE).fill(email));
    const stored = rows(db);
    let nextStatus;
    try { await auth.login({ email, password: WRONG_PASSWORD, remoteAddress: IP }); nextStatus = 200; }
    catch (error) { nextStatus = error.statusCode; }
    t.diagnostic(JSON.stringify({ scenario: email === EMAIL ? 'known' : 'unknown',
      statuses: result.map(item => item.status), stored, nextStatus }));
    assert.ok(result.every(item => item.status === 401));
    assert.ok(result.every(item => item.message === 'Email or password was not accepted.'));
    assert.equal(stored.length, 2);
    assert.ok(stored.every(row => row.failures === WAVE_SIZE), 'every completed failure must be durable');
    assert.ok(stored.every(row => row.locked_until === time.now + INTERVAL), 'late failures must retain the first active lock');
    assert.equal(nextStatus, 429);
    assert.equal(sessions(db), sessionCount, 'neither the wave nor a locked attempt issues a session');
    const denied = db.prepare("SELECT user_id,source_hash FROM auth_audit_events WHERE event_type='sign_in_denied'").all();
    assert.equal(denied.length, WAVE_SIZE);
    assert.ok(denied.every(event => event.source_hash === digest(IP)));
    assert.ok(denied.every(event => email === EMAIL ? event.user_id === 1 : event.user_id === null));
    assert.doesNotMatch(JSON.stringify(auth.auditEvents()), new RegExp(`${WRONG_PASSWORD}|${IP.replaceAll('.', '\\.')}`));
  });
}

test('rotating account identifiers share the per-IP lock without losing their own failures', async t => {
  clock(t);
  const { db, auth } = await fixture(t);
  const emails = Array.from({ length: WAVE_SIZE }, (_, index) => `rotated-${index}@example.test`);
  const result = await failures(auth, emails);
  const ipRow = db.prepare('SELECT failures,locked_until FROM auth_login_attempts WHERE attempt_key=?').get(loginKeys()[1]);
  t.diagnostic(JSON.stringify({ scenario: 'rotating-emails', statuses: result.map(item => item.status), ipRow }));
  assert.ok(result.every(item => item.status === 401));
  assert.equal(ipRow.failures, WAVE_SIZE);
  assert.ok(ipRow.locked_until > Date.now());
  assert.ok(rows(db).filter(row => row.attempt_key !== loginKeys()[1]).every(row => row.failures === 1));
  await assert.rejects(auth.login({ email: 'another@example.test', password: PASSWORD, remoteAddress: IP }), { statusCode: 429 });
  const otherSource = await auth.login({ email: EMAIL, password: PASSWORD, remoteAddress: '127.0.0.74' });
  assert.equal(auth.currentSession(otherSource.sessionToken).id, 1, 'the policy remains scoped to account/source and source');
});

test('completion-time counts, lock preservation, reopen, expiry and ordinary success retain policy', async t => {
  const time = clock(t);
  const state = await fixture(t, { durable: true });
  const originalCredentials = state.db.prepare('SELECT password_salt,password_hash FROM auth_users WHERE id=1').get();
  const pending = failures(state.auth);
  time.set(time.now + 60_000); // All checks started earlier; accounting happens when scrypt completes.
  const completed = await pending;
  assert.ok(completed.every(item => item.status === 401));
  const stored = rows(state.db);
  assert.ok(stored.every(row => row.window_started_at === time.now));
  assert.ok(stored.every(row => row.locked_until === time.now + INTERVAL));
  assert.ok(stored.every(row => row.failures === WAVE_SIZE));
  state.reopen();
  assert.deepEqual(rows(state.db), stored);
  const beforeSessions = sessions(state.db);
  await assert.rejects(state.auth.login({ email: EMAIL, password: PASSWORD, remoteAddress: IP }), { statusCode: 429 });
  assert.equal(sessions(state.db), beforeSessions);
  time.set(time.now + INTERVAL);
  await assert.rejects(state.auth.login({ email: EMAIL, password: WRONG_PASSWORD, remoteAddress: IP }), { statusCode: 401 });
  assert.ok(rows(state.db).every(row => row.failures === 1 && row.locked_until === 0 && row.window_started_at === time.now));
  time.set(time.now + INTERVAL);
  await assert.rejects(state.auth.login({ email: EMAIL, password: WRONG_PASSWORD, remoteAddress: IP }), { statusCode: 401 });
  assert.ok(rows(state.db).every(row => row.failures === 1 && row.window_started_at === time.now), 'an expired unlocked window restarts at one');
  const signedIn = await state.auth.login({ email: EMAIL, password: PASSWORD, remoteAddress: IP });
  const session = state.auth.currentSession(signedIn.sessionToken);
  assert.equal(session.id, 1);
  assert.equal(state.auth.verifyCsrf(session, signedIn.csrfToken, signedIn.csrfToken), true);
  assert.deepEqual(rows(state.db), []);
  assert.deepEqual(state.db.prepare('SELECT password_salt,password_hash FROM auth_users WHERE id=1').get(), originalCredentials);
});

test('already-admitted failures increment a current lock without shortening or extending its deadline', async t => {
  const time = clock(t);
  const { db, auth } = await fixture(t);
  const pending = failures(auth, Array(4).fill(EMAIL));
  forceLock(db, loginKeys(), time.now);
  const deadline = time.now + INTERVAL;
  time.set(time.now + 60_000);
  assert.ok((await pending).every(item => item.status === 401));
  assert.ok(rows(db).every(row => row.failures === 9 && row.locked_until === deadline
    && row.window_started_at === FIXED_NOW));
  await assert.rejects(auth.login({ email: EMAIL, password: PASSWORD, remoteAddress: IP }), { statusCode: 429 });
});

test('an in-flight correct password cannot clear a lock acquired during scrypt or issue a session', async t => {
  const time = clock(t);
  const { db, auth } = await fixture(t);
  const before = sessions(db);
  const pending = auth.login({ email: EMAIL, password: PASSWORD, remoteAddress: IP });
  forceLock(db, loginKeys(), time.now);
  const locked = rows(db);
  await assert.rejects(pending, { statusCode: 429 });
  assert.deepEqual(rows(db), locked);
  assert.equal(sessions(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_mfa_challenges').get().count, 0);
});

for (const operation of ['regenerateMfaRecoveryCodes', 'disableMfa']) {
  test(`concurrent wrong-password MFA ${operation} preserves factors and the active step-up lock`, async t => {
    const time = clock(t);
    const { db, auth, actor, recoveryCodes } = await fixture(t, { mfa: true });
    const factorRows = db.prepare('SELECT * FROM auth_mfa_recovery_codes ORDER BY code_hash').all();
    const userBefore = db.prepare('SELECT mfa_secret_enc,mfa_enabled_at,mfa_last_counter FROM auth_users WHERE id=1').get();
    const pending = Array.from({ length: WAVE_SIZE }, () => auth[operation](actor,
      { password: WRONG_PASSWORD, code: recoveryCodes[0], remoteAddress: IP })
      .then(() => 200, error => error.statusCode));
    time.set(time.now + 60_000);
    const statuses = await Promise.all(pending);
    t.diagnostic(JSON.stringify({ scenario: operation, statuses, stored: rows(db) }));
    assert.ok(statuses.every(status => status === 401));
    assert.equal(rows(db).length, 2);
    assert.ok(rows(db).every(row => row.failures === WAVE_SIZE && row.locked_until === time.now + INTERVAL));
    assert.deepEqual(db.prepare('SELECT * FROM auth_mfa_recovery_codes ORDER BY code_hash').all(), factorRows);
    assert.deepEqual(db.prepare('SELECT mfa_secret_enc,mfa_enabled_at,mfa_last_counter FROM auth_users WHERE id=1').get(), userBefore);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_audit_events WHERE event_type='mfa_stepup_denied'").get().count, WAVE_SIZE);
    await assert.rejects(auth[operation](actor, { password: PASSWORD, code: recoveryCodes[0], remoteAddress: IP }), { statusCode: 429 });
    time.set(time.now + INTERVAL);
    const result = await auth[operation](actor, { password: PASSWORD, code: recoveryCodes[0], remoteAddress: IP });
    if (operation === 'disableMfa') {
      assert.equal(result.ok, true);
      assert.equal(auth.mfaStatus(actor).enabled, false);
    } else {
      assert.equal(result.recoveryCodes.length, 10);
      assert.equal(auth.mfaStatus(actor).enabled, true);
      assert.notDeepEqual(result.recoveryCodes, recoveryCodes);
    }
    assert.deepEqual(rows(db), []);
  });

  test(`concurrent valid-password invalid-factor MFA ${operation} counts denials and preserves protection`, async t => {
    clock(t);
    const { db, auth, actor, recoveryCodes } = await fixture(t, { mfa: true });
    const factors = db.prepare('SELECT * FROM auth_mfa_recovery_codes ORDER BY code_hash').all();
    const statuses = await Promise.all(Array.from({ length: WAVE_SIZE }, () => auth[operation](actor,
      { password: PASSWORD, code: 'invalid-synthetic-factor', remoteAddress: IP })
      .then(() => 200, error => error.statusCode)));
    assert.equal(statuses.filter(status => status === 401).length, 5);
    assert.equal(statuses.filter(status => status === 429).length, WAVE_SIZE - 5);
    assert.equal(rows(db).length, 2);
    assert.ok(rows(db).every(row => row.failures === 5 && row.locked_until === Date.now() + INTERVAL));
    assert.deepEqual(db.prepare('SELECT * FROM auth_mfa_recovery_codes ORDER BY code_hash').all(), factors);
    assert.equal(auth.mfaStatus(actor).enabled, true);
    await assert.rejects(auth[operation](actor, { password: PASSWORD, code: recoveryCodes[0], remoteAddress: IP }), { statusCode: 429 });
  });

  test(`in-flight correct MFA ${operation} cannot erase a newly acquired lock or consume a factor`, async t => {
    const time = clock(t);
    const { db, auth, actor, recoveryCodes } = await fixture(t, { mfa: true });
    const factors = db.prepare('SELECT * FROM auth_mfa_recovery_codes ORDER BY code_hash').all();
    const userBefore = db.prepare('SELECT mfa_secret_enc,mfa_enabled_at,mfa_last_counter FROM auth_users WHERE id=1').get();
    const pending = auth[operation](actor, { password: PASSWORD, code: recoveryCodes[0], remoteAddress: IP });
    forceLock(db, stepupKeys(actor.id), time.now);
    const locked = rows(db);
    await assert.rejects(pending, { statusCode: 429 });
    assert.deepEqual(rows(db), locked);
    assert.deepEqual(db.prepare('SELECT * FROM auth_mfa_recovery_codes ORDER BY code_hash').all(), factors);
    assert.deepEqual(db.prepare('SELECT mfa_secret_enc,mfa_enabled_at,mfa_last_counter FROM auth_users WHERE id=1').get(), userBefore);
  });
}

test('normal HTTP login retains a parallel failure wave and returns 429 without a session cookie', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'odd-auth-concurrency-http-'));
  Object.assign(process.env, { ODD_DB_PATH: path.join(directory, 'fixture.db'), HOST: '127.0.0.1', PORT: '0' });
  const { closeDb, initDb } = await import('../pipeline/database.js');
  const db = initDb();
  const { server } = await import('../server.js');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie') || '', body: await response.json() };
  }
  assert.equal((await post('/api/auth/bootstrap', { email: EMAIL, password: PASSWORD,
    bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN })).status, 201);
  const before = sessions(db);
  const wave = await Promise.all(Array.from({ length: WAVE_SIZE }, () => post('/api/auth/login', { email: EMAIL, password: WRONG_PASSWORD })));
  const stored = rows(db);
  const next = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  t.diagnostic(JSON.stringify({ scenario: 'http', statuses: wave.map(item => item.status), stored, nextStatus: next.status }));
  // Socket scheduling can admit a late request after the lock is already active.
  const admitted = wave.filter(item => item.status === 401);
  assert.ok(wave.every(item => [401, 429].includes(item.status)));
  assert.ok(admitted.length >= 5);
  assert.equal(new Set(admitted.map(item => item.body.error)).size, 1);
  assert.equal(stored.length, 2);
  assert.ok(stored.every(row => row.failures === admitted.length && row.locked_until > Date.now()));
  assert.equal(next.status, 429);
  assert.doesNotMatch(next.cookie, /odd_session=[^;]/);
  assert.equal(sessions(db), before);
});
