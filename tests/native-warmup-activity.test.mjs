import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-native-activity-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { initDb, closeDb } = await import('../pipeline/database.js');
const { createWarmblyActivity } = await import('../pipeline/warmbly-activity.js');
let db = initDb();
const uuid = '18ea7d16-89e1-4dd9-bf9c-6bcf242c8c65';
const owner = { id: 9, role: 'owner' };
const observer = { id: 10, role: 'viewer' };
db.exec("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,active) VALUES(91,'native@example.test','example.test','warming',0,1)");
let mode = 'ok'; const calls = [];
const fixture = http.createServer((req, res) => {
  calls.push({ method: req.method, url: req.url, token: req.headers.authorization });
  assert.equal(req.method, 'GET', 'the app must never activate the worker or submit an email');
  if (mode === 'redirect') { res.writeHead(302, { location: '/secret-target' }); return res.end(); }
  if (mode === 'stalled') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
  if (mode === 'drip') { res.writeHead(200, { 'content-type': 'application/json' }); const timer = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(timer)); return; }
  if (mode === 'oversize') { res.writeHead(200); return res.end(' '.repeat(1024 * 1024 + 1)); }
  if (mode === 'unauthorized') { res.writeHead(401); return res.end('private native error with secret-fixture'); }
  const account = { id: uuid, email: mode === 'mismatch' ? 'somebody-else@example.test' : 'NATIVE@example.test', warmup: '2026-10-01T00:00:00Z', warmup_paused_at: null, password: 'secret-fixture' };
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith(`/v1/emails/${uuid}`)) return res.end(JSON.stringify(account));
  if (req.url.startsWith('/v1/analytics/warmup?')) {
    const url = new URL(req.url, 'http://fixture');
    return res.end(JSON.stringify({ email_account_id: mode === 'wrong-id' ? 'other' : uuid,
      date_range: { from: `${url.searchParams.get('from')}T00:00:00Z`, to: `${url.searchParams.get('to')}T00:00:00Z` },
      summary: { total_sent: 7, total_received: mode === 'missing' ? undefined : 5, total_replied: 3, days_active: 2, reply_rate: 42.8 },
      daily_stats: [{ date: url.searchParams.get('to'), emails_sent: 7, emails_received: 5, emails_replied: 3, target_volume: 10 }], api_key: 'secret-fixture' }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const env = { WARMBLY_BASE_URL: `http://127.0.0.1:${fixture.address().port}`, WARMBLY_API_KEY: 'secret-fixture' };
const manager = () => createWarmblyActivity({ db, env, timeoutMs: 100, minimumIntervalMs: 0, now: () => new Date('2026-10-19T14:00:00Z') });
after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); closeDb(); rmSync(directory, { recursive: true, force: true }); });

test('native linking verifies identity, applies roles and never changes send eligibility', async () => {
  const start = db.prepare('SELECT * FROM mailboxes WHERE id=91').get();
  await assert.rejects(manager().link(91, uuid, observer), error => error.status === 403);
  await assert.rejects(manager().link(91, '../../evil', owner), /UUID/);
  assert.equal(calls.length, 0);
  mode = 'mismatch'; await assert.rejects(manager().link(91, uuid, owner), error => error.code === 'account_mismatch');
  assert.equal(manager().status(91, owner).linked, false);
  mode = 'ok'; const linked = await manager().link(91, uuid.toUpperCase(), owner);
  assert.equal(linked.linked, true); assert.equal(linked.observation, null);
  assert.equal(manager().status(91, observer).can_manage, false);
  await assert.rejects(manager().refresh(91, observer), error => error.status === 403);
  assert.deepEqual(db.prepare('SELECT * FROM mailboxes WHERE id=91').get(), start);
});

test('native observations retain actual counts and provenance through reopen and unavailable responses', async () => {
  const result = await manager().refresh(91, owner);
  assert.equal(result.observation.summary.total_sent, 7);
  assert.equal(result.observation.summary.total_received, 5);
  assert.equal(result.observation.account.state, 'active');
  assert.equal(result.observation.observed_at, '2026-10-19T14:00:00.000Z');
  assert.equal(result.source, 'warmbly_native_api');
  assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  closeDb(); db = initDb();
  assert.deepEqual(manager().status(91, owner).observation, result.observation);
  mode = 'unauthorized';
  await assert.rejects(manager().refresh(91, owner), error => error.code === 'unauthorized' && !error.message.includes('secret-fixture'));
  const retained = manager().status(91, owner);
  assert.equal(retained.observation.stale, true); assert.equal(retained.observation.summary.total_sent, 7);
  assert.equal(retained.error_code, 'unauthorized');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_warmup_observations').get().n, 1);
  mode = 'ok';
  const relinked = await manager().link(91, uuid, owner);
  assert.equal(relinked.error_code, 'unauthorized', 'relinking the same account must not erase an unrefreshed activity failure');
  assert.equal(relinked.observation.stale, true);
  assert.equal(relinked.last_attempt_at, retained.last_attempt_at, 'relink cannot reset the persistent refresh budget');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  mode = 'missing'; const missing = await manager().refresh(91, owner);
  assert.equal(missing.observation.summary.total_received, null, 'missing upstream counts never become zero');
  assert.equal(missing.observation.stale, false);
});

test('redirects, oversized bodies and incomplete bodies fail within a total deadline without overwriting evidence', async () => {
  const original = db.prepare('SELECT * FROM native_warmup_observations ORDER BY id DESC LIMIT 1').get();
  for (const failure of ['redirect', 'oversize', 'stalled', 'drip', 'wrong-id']) {
    mode = failure; const start = Date.now();
    await assert.rejects(manager().refresh(91, owner));
    assert.ok(Date.now() - start < 2000, `${failure} exceeds total deadline`);
    assert.deepEqual(db.prepare('SELECT * FROM native_warmup_observations ORDER BY id DESC LIMIT 1').get(), original);
  }
  assert.equal(calls.some(row => row.url === '/secret-target'), false);
});

test('changed identity or operator connection requires relink; unlink preserves observations and native worker state', async () => {
  mode = 'ok'; const countBefore = calls.length;
  env.WARMBLY_BASE_URL = 'https://different.example.test';
  assert.equal(manager().status(91, owner).requires_relink, true);
  await assert.rejects(manager().refresh(91, owner), error => error.code === 'mapping_changed');
  assert.equal(calls.length, countBefore);
  env.WARMBLY_BASE_URL = `http://127.0.0.1:${fixture.address().port}`;
  db.prepare("UPDATE mailboxes SET email='changed@example.test' WHERE id=91").run();
  await assert.rejects(manager().refresh(91, owner), error => error.code === 'mapping_changed');
  db.prepare("UPDATE mailboxes SET email='native@example.test' WHERE id=91").run();
  const history = db.prepare('SELECT * FROM native_warmup_observations').all();
  const unlinked = manager().unlink(91, owner);
  assert.equal(unlinked.linked, false); assert.equal(unlinked.observation, null);
  assert.deepEqual(db.prepare('SELECT * FROM native_warmup_observations').all(), history);
  assert.equal(calls.length, countBefore);
  assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=91').get().warmup_status, 'warming');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
});

test('unconfigured or invalid operator URLs make no requests, and concurrent checks do not duplicate requests', async () => {
  const before = calls.length;
  for (const url of ['', 'http://public.example.test', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test/?key=secret']) {
    const unconfigured = createWarmblyActivity({ db, env: { ...env, WARMBLY_BASE_URL: url } });
    assert.equal(unconfigured.status(91, owner).configured, false);
    await assert.rejects(unconfigured.link(91, uuid, owner), error => error.code === 'not_configured');
  }
  assert.equal(calls.length, before);
  mode = 'stalled'; const first = manager().link(91, uuid, owner);
  await assert.rejects(manager().link(91, uuid, owner), error => error.status === 409);
  await assert.rejects(first);
  mode = 'ok'; await manager().link(91, uuid, owner); await manager().refresh(91, owner);
  const throttled = createWarmblyActivity({ db, env, now: () => new Date('2026-10-19T14:00:01Z') });
  await assert.rejects(throttled.refresh(91, owner), error => error.status === 429);
});

test('migration 6 rolls back its schema on interruption, preserves older data and retries safely', () => {
  closeDb();
  let legacy = new Database(process.env.ODD_DB_PATH);
  legacy.exec(`DROP TABLE native_warmup_observations; DROP TABLE native_warmup_links; DELETE FROM schema_migrations WHERE version>=6;
    CREATE TRIGGER stop_native_version BEFORE INSERT ON schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'native migration interruption'); END;`);
  legacy.close();
  assert.throws(() => initDb(), /native migration interruption/); closeDb();
  legacy = new Database(process.env.ODD_DB_PATH);
  assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'native_warmup_%'").get().n, 0);
  assert.equal(legacy.prepare('SELECT email FROM mailboxes WHERE id=91').get().email, 'native@example.test');
  legacy.exec('DROP TRIGGER stop_native_version'); legacy.close();
  db = initDb();
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 8);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
