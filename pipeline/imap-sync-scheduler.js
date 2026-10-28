import { getDb } from './database.js';
import { createImapReceiver } from './imap-receiver.js';

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 60;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function publicSettings(db) {
  const row = db.prepare(`SELECT enabled,interval_minutes,updated_at,updated_by_role
    FROM imap_sync_settings WHERE id=1`).get();
  return {
    enabled: Boolean(row?.enabled),
    intervalMinutes: Number(row?.interval_minutes) || 10,
    updatedAt: row?.updated_at || null,
    updatedByRole: row?.updated_by_role || null,
  };
}

function normalizeSettings(value) {
  if (!value || typeof value.enabled !== 'boolean') {
    const error = new Error('Choose whether automatic Inbox sync is enabled.');
    error.statusCode = 400;
    throw error;
  }
  const intervalMinutes = Number(value.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES || intervalMinutes > MAX_INTERVAL_MINUTES) {
    const error = new Error(`Sync interval must be from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes.`);
    error.statusCode = 400;
    throw error;
  }
  return { enabled: value.enabled, intervalMinutes };
}

function actorId(actor) {
  const id = Number(actor?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** One opt-in, sequential IMAP poller. The default persisted state is disabled. */
export function createImapSyncScheduler({
  db = getDb(),
  receiver = createImapReceiver({ db }),
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let timer = null;
  let cyclePromise = null;

  function syncCount(value) {
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  }

  function syncCursor(value) {
    const cursor = Number(value);
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
  }

  function recordManualSuccess(mailboxValue, result) {
    const mailboxId = Number(mailboxValue);
    if (!Number.isSafeInteger(mailboxId) || mailboxId < 1
      || !db.prepare('SELECT 1 FROM mailboxes WHERE id=?').get(mailboxId)) return false;
    const at = new Date(now()).toISOString();
    const metrics = [syncCount(result?.fetched), syncCount(result?.imported), syncCount(result?.duplicates),
      syncCount(result?.skipped), syncCursor(result?.cursorUid)];
    db.prepare(`INSERT INTO imap_sync_mailbox_state(mailbox_id,last_attempt_at,last_success_at,failure_count,
      next_attempt_at,last_error,last_fetched,last_imported,last_duplicates,last_skipped,last_cursor_uid)
      VALUES(?,?,?,0,NULL,NULL,?,?,?,?,?)
      ON CONFLICT(mailbox_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
        last_success_at=excluded.last_success_at,failure_count=0,next_attempt_at=NULL,last_error=NULL,
        last_fetched=excluded.last_fetched,last_imported=excluded.last_imported,
        last_duplicates=excluded.last_duplicates,last_skipped=excluded.last_skipped,
        last_cursor_uid=excluded.last_cursor_uid`)
      .run(mailboxId, at, at, ...metrics);
    return true;
  }

  function recordManualFailure(mailboxValue, error) {
    if (error?.statusCode === 409) return false;
    const mailboxId = Number(mailboxValue);
    if (!Number.isSafeInteger(mailboxId) || mailboxId < 1
      || !db.prepare('SELECT 1 FROM mailboxes WHERE id=?').get(mailboxId)) return false;
    const at = new Date(now()).toISOString();
    const safeCode = typeof error?.message === 'string'
      ? error.message.match(/^IMAP connection failed \(([A-Z0-9_]{1,64})\)\. Check settings\.$/)?.[1]
      : null;
    const message = safeCode
      ? `IMAP connection failed (${safeCode}). Check settings.`
      : 'Inbox sync failed. Review the mailbox IMAP settings and try again.';
    db.prepare(`INSERT INTO imap_sync_mailbox_state(mailbox_id,last_attempt_at,last_error)
      VALUES(?,?,?) ON CONFLICT(mailbox_id) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error`)
      .run(mailboxId, at, message);
    return true;
  }

  function status() {
    const settings = publicSettings(db);
    const mailboxes = db.prepare(`SELECT m.id,m.email,s.last_attempt_at,s.last_success_at,
        s.failure_count,s.next_attempt_at,s.last_error,s.last_fetched,s.last_imported,
        s.last_duplicates,s.last_skipped,s.last_cursor_uid
      FROM mailboxes m LEFT JOIN imap_sync_mailbox_state s ON s.mailbox_id=m.id
      WHERE m.active=1 AND m.imap_host IS NOT NULL AND m.imap_user IS NOT NULL AND m.imap_pass IS NOT NULL
      ORDER BY m.id`).all().map(row => ({
      mailboxId: row.id,
      email: row.email,
      lastAttemptAt: row.last_attempt_at || null,
      lastSuccessAt: row.last_success_at || null,
      failureCount: Number(row.failure_count) || 0,
      nextAttemptAt: row.next_attempt_at || null,
      lastError: row.last_error || null,
      lastResult: row.last_success_at ? {
        fetched: row.last_fetched === null ? null : Number(row.last_fetched),
        imported: row.last_imported === null ? null : Number(row.last_imported),
        duplicates: row.last_duplicates === null ? null : Number(row.last_duplicates),
        skipped: row.last_skipped === null ? null : Number(row.last_skipped),
        cursorUid: row.last_cursor_uid === null ? null : Number(row.last_cursor_uid),
      } : null,
    }));
    return { ...settings, running: Boolean(cyclePromise), mailboxes };
  }

  async function runOnce() {
    if (cyclePromise) return { ok: false, skipped: true, reason: 'cycle_already_running' };
    if (!publicSettings(db).enabled) return { ok: true, skipped: true, reason: 'disabled', mailboxes: [] };
    cyclePromise = (async () => {
      const currentTime = now();
      const configured = db.prepare(`SELECT id FROM mailboxes WHERE active=1
        AND imap_host IS NOT NULL AND imap_user IS NOT NULL AND imap_pass IS NOT NULL ORDER BY id`).all();
      const results = [];
      for (const mailbox of configured) {
        const previous = db.prepare('SELECT failure_count,next_attempt_at FROM imap_sync_mailbox_state WHERE mailbox_id=?').get(mailbox.id);
        const dueAt = previous?.next_attempt_at ? Date.parse(previous.next_attempt_at) : 0;
        if (Number.isFinite(dueAt) && dueAt > currentTime) {
          results.push({ mailboxId: mailbox.id, skipped: true, reason: 'backoff' });
          continue;
        }
        db.prepare(`INSERT INTO imap_sync_mailbox_state(mailbox_id,last_attempt_at)
          VALUES(?,?) ON CONFLICT(mailbox_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`)
          .run(mailbox.id, new Date(currentTime).toISOString());
        try {
          const result = await receiver.syncMailbox(mailbox.id, { limit: 100 });
          const metrics = [syncCount(result?.fetched), syncCount(result?.imported), syncCount(result?.duplicates),
            syncCount(result?.skipped), syncCursor(result?.cursorUid)];
          db.prepare(`UPDATE imap_sync_mailbox_state SET last_success_at=?,failure_count=0,
            next_attempt_at=NULL,last_error=NULL,last_fetched=?,last_imported=?,last_duplicates=?,
            last_skipped=?,last_cursor_uid=? WHERE mailbox_id=?`)
            .run(new Date(now()).toISOString(), ...metrics, mailbox.id);
          results.push({ mailboxId: mailbox.id, ...result });
        } catch (error) {
          const previousFailures = Number(previous?.failure_count) || 0;
          if (error?.statusCode === 409) {
            const retryAt = new Date(now() + Number(publicSettings(db).intervalMinutes) * 60_000).toISOString();
            db.prepare(`UPDATE imap_sync_mailbox_state SET next_attempt_at=?,last_error=NULL WHERE mailbox_id=?`)
              .run(retryAt, mailbox.id);
            results.push({ mailboxId: mailbox.id, ok: true, skipped: true,
              reason: 'mailbox_sync_already_running', nextAttemptAt: retryAt });
            continue;
          }
          const failures = previousFailures + 1;
          const retryDelay = Math.min(Number(publicSettings(db).intervalMinutes) * 60_000 * (2 ** Math.min(failures - 1, 12)), MAX_BACKOFF_MS);
          const retryAt = new Date(now() + retryDelay).toISOString();
          const message = typeof error?.message === 'string' && error.message.startsWith('IMAP connection failed')
            ? error.message : 'Mailbox sync failed; retry scheduled.';
          db.prepare(`UPDATE imap_sync_mailbox_state SET failure_count=?,next_attempt_at=?,last_error=?
            WHERE mailbox_id=?`).run(failures, retryAt, message, mailbox.id);
          results.push({ mailboxId: mailbox.id, ok: false, skipped: false,
            error: message, nextAttemptAt: retryAt });
        }
      }
      return { ok: results.every(result => result.ok !== false), mailboxes: results };
    })().finally(() => { cyclePromise = null; });
    return cyclePromise;
  }

  function stopTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  async function start() {
    stopTimer();
    const settings = publicSettings(db);
    if (!settings.enabled) return status();
    const period = settings.intervalMinutes * 60_000;
    timer = setTimer(() => { void runOnce(); }, period);
    timer?.unref?.();
    return status();
  }

  function setSettings(value, actor = null) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) {
      const error = new Error('Only workspace owners and admins can change automatic Inbox sync.');
      error.statusCode = 403;
      throw error;
    }
    const settings = normalizeSettings(value);
    db.transaction(() => {
      db.prepare(`UPDATE imap_sync_settings SET enabled=?,interval_minutes=?,updated_at=datetime('now'),
        updated_by=?,updated_by_role=? WHERE id=1`)
        .run(settings.enabled ? 1 : 0, settings.intervalMinutes, actorId(actor), actor.role);
      db.prepare(`INSERT INTO imap_sync_events(enabled,interval_minutes,actor_id,actor_role)
        VALUES(?,?,?,?)`).run(settings.enabled ? 1 : 0, settings.intervalMinutes, actorId(actor), actor.role);
    })();
    void start();
    return status();
  }

  function close() {
    stopTimer();
  }

  return { status, runOnce, start, stop: close, setSettings, recordManualSuccess, recordManualFailure };
}
