import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-imap-scheduler-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { initDb, closeDb } = await import('../pipeline/database.js');
const { createImapSyncScheduler } = await import('../pipeline/imap-sync-scheduler.js');
let db = initDb();

after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('legacy inbox sync state gains receive-result columns without dropping existing scheduler state', () => {
  db.exec(`DROP TABLE imap_sync_mailbox_state;
    CREATE TABLE imap_sync_mailbox_state (
      mailbox_id INTEGER PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
      last_attempt_at TEXT,last_success_at TEXT,failure_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,last_error TEXT
    );`);
  initDb();
  const columns = new Set(db.prepare('PRAGMA table_info(imap_sync_mailbox_state)').all().map(column => column.name));
  for (const column of ['last_attempt_at', 'last_success_at', 'failure_count', 'next_attempt_at', 'last_error',
    'last_fetched', 'last_imported', 'last_duplicates', 'last_skipped', 'last_cursor_uid']) {
    assert.ok(columns.has(column), `migration keeps or adds ${column}`);
  }
});

function seedMailbox() {
  db.prepare(`INSERT INTO mailboxes(id,email,domain,imap_host,imap_port,imap_user,imap_pass,imap_secure)
    VALUES(1,'receiver@example.test','example.test','imap.example.test',993,'fixture-user','sensitive-fixture-pass',1)`).run();
}

test('continuous IMAP sync is opt-in, admin-controlled, bounded, persisted and backs off after failure', async () => {
  seedMailbox();
  let now = 1_800_000_000_000;
  let callback = null;
  let timerDelay = null;
  let timerCleared = false;
  let calls = 0;
  let failOnce = true;
  const scheduler = createImapSyncScheduler({
    db,
    now: () => now,
    setTimer: (fn, delay) => { callback = fn; timerDelay = delay; return { unref() {} }; },
    clearTimer: () => { timerCleared = true; },
    receiver: { syncMailbox: async (mailboxId, options) => {
      assert.equal(mailboxId, 1);
      assert.deepEqual(options, { limit: 100 });
      calls++;
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('IMAP connection failed (CERT_HAS_EXPIRED). Check settings.'), { statusCode: 502 });
      }
      return { ok: true, fetched: 3, imported: 2, duplicates: 1, skipped: 0, cursorUid: 9, moreNewMessages: false };
    } },
  });

  assert.equal(scheduler.status().enabled, false);
  assert.equal(callback, null, 'the default state creates no background timer');
  assert.throws(() => scheduler.setSettings({ enabled: true, intervalMinutes: 5 }, { id: 3, role: 'operator' }), error => error.statusCode === 403);
  assert.throws(() => scheduler.setSettings({ enabled: true, intervalMinutes: 4 }, { id: 1, role: 'owner' }), error => error.statusCode === 400);

  const enabled = scheduler.setSettings({ enabled: true, intervalMinutes: 5 }, { id: 1, role: 'owner' });
  assert.equal(enabled.enabled, true);
  assert.equal(timerDelay, 5 * 60_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM imap_sync_events').get().n, 1);
  assert.doesNotMatch(JSON.stringify(scheduler.status()), /sensitive-fixture-pass|imap\.example\.test/,
    'status contains no credential or host data');

  const failedCycle = await scheduler.runOnce();
  assert.equal(failedCycle.ok, false);
  assert.equal(calls, 1);
  let mailboxState = db.prepare('SELECT failure_count,next_attempt_at,last_error FROM imap_sync_mailbox_state WHERE mailbox_id=1').get();
  assert.equal(mailboxState.failure_count, 1);
  assert.match(mailboxState.last_error, /^IMAP connection failed/);
  assert.equal(Date.parse(mailboxState.next_attempt_at), now + 5 * 60_000);

  now += 60_000;
  const backoffCycle = await scheduler.runOnce();
  assert.equal(backoffCycle.mailboxes[0].reason, 'backoff');
  assert.equal(calls, 1, 'failed mailboxes are not retried before the scheduled backoff');

  now += 4 * 60_000;
  const recoveredCycle = await scheduler.runOnce();
  assert.equal(recoveredCycle.ok, true);
  assert.equal(calls, 2);
  mailboxState = db.prepare('SELECT failure_count,next_attempt_at,last_error,last_success_at FROM imap_sync_mailbox_state WHERE mailbox_id=1').get();
  assert.equal(mailboxState.failure_count, 0);
  assert.equal(mailboxState.next_attempt_at, null);
  assert.equal(mailboxState.last_error, null);
  assert.ok(mailboxState.last_success_at);
  assert.deepEqual(scheduler.status().mailboxes[0].lastResult, {
    fetched: 3, imported: 2, duplicates: 1, skipped: 0, cursorUid: 9,
  });

  assert.equal(scheduler.recordManualFailure(1, Object.assign(new Error('raw password=sensitive-fixture-pass imap.example.test'), { statusCode: 502 })), true);
  const failedManualStatus = scheduler.status();
  assert.match(failedManualStatus.mailboxes[0].lastError, /Review the mailbox IMAP settings/);
  assert.doesNotMatch(JSON.stringify(failedManualStatus), /sensitive-fixture-pass|imap\.example\.test/);
  assert.equal(scheduler.recordManualFailure(1, Object.assign(new Error('sync already running'), { statusCode: 409 })), false,
    'a concurrent sync conflict does not overwrite the saved outcome');
  assert.equal(scheduler.recordManualSuccess(1, {
    fetched: 5, imported: 2, duplicates: 2, skipped: 1, cursorUid: 14,
  }), true);
  assert.deepEqual(scheduler.status().mailboxes[0].lastResult, {
    fetched: 5, imported: 2, duplicates: 2, skipped: 1, cursorUid: 14,
  });
  assert.equal(scheduler.status().mailboxes[0].lastError, null);

  let markStarted;
  let releaseCycle;
  const started = new Promise(resolve => { markStarted = resolve; });
  const blockedCycle = new Promise(resolve => { releaseCycle = resolve; });
  const serialized = createImapSyncScheduler({
    db,
    now: () => now,
    receiver: { syncMailbox: async () => { markStarted(); return blockedCycle; } },
  });
  const firstCycle = serialized.runOnce();
  await started;
  const overlappingCycle = await serialized.runOnce();
  assert.equal(overlappingCycle.skipped, true, 'an overlapping interval cannot start a second cycle');
  releaseCycle({ ok: true });
  await firstCycle;
  serialized.stop();

  const restarted = createImapSyncScheduler({ db, receiver: { syncMailbox: async () => ({ ok: true }) }, setTimer: (fn, delay) => {
    callback = fn; timerDelay = delay; return { unref() {} };
  }, clearTimer: () => { timerCleared = true; } });
  const restored = await restarted.start();
  assert.equal(restored.enabled, true);
  assert.equal(timerDelay, 5 * 60_000, 'the opt-in setting survives restart');
  assert.equal(typeof callback, 'function');
  restarted.stop();
  assert.equal(timerCleared, true);

  const disabled = scheduler.setSettings({ enabled: false, intervalMinutes: 10 }, { id: 1, role: 'owner' });
  assert.equal(disabled.enabled, false);
  assert.equal(scheduler.status().enabled, false);
  scheduler.stop();

  assert.equal(scheduler.recordManualSuccess(1, {
    fetched: 5, imported: 2, duplicates: 2, skipped: 1, cursorUid: 14,
  }), true);
  closeDb();
  db = initDb();
  const restoredScheduler = createImapSyncScheduler({ db, receiver: { syncMailbox: async () => ({ ok: true }) } });
  assert.deepEqual(restoredScheduler.status().mailboxes[0].lastResult, {
    fetched: 5, imported: 2, duplicates: 2, skipped: 1, cursorUid: 14,
  }, 'the latest receive counts survive closing and reopening SQLite');
  restoredScheduler.stop();
});
