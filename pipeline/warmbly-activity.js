// Read-only native Warmbly API integration. Warmbly retains its sole scheduler.
import { getDb } from './database.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const running = new WeakMap();
const failures = {
  not_configured: 'The server operator must configure the Warmbly connection first.',
  unauthorized: 'Warmbly rejected the server connection. Ask the operator to check its API permissions.',
  unavailable: 'Warmbly could not be reached. The last successful observation has been retained.',
  invalid_response: 'Warmbly returned an unsupported response. No activity was invented.',
  account_mismatch: 'That Warmbly account does not match this mailbox address.',
  rate_limited: 'Please wait before checking Warmbly again.',
  mapping_changed: 'The mailbox or linked account changed. Refresh this view before trying again.',
};

export class ActivityError extends Error {
  constructor(code, status = 422) { super(failures[code] || code); this.code = code; this.status = status; this.statusCode = status; }
}

function configuration(env) {
  try {
    const url = new URL(env.WARMBLY_BASE_URL);
    const loopback = ['127.0.0.1', '[::1]', 'localhost', 'backend'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    const token = env.WARMBLY_API_KEY;
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)) return null;
    return { origin: url.origin, token };
  } catch { return null; }
}

async function readNative(config, route, { fetchImpl, timeoutMs }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${config.origin}${route}`, {
      method: 'GET', redirect: 'error', signal: abort.signal,
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
    });
    if ([401, 403].includes(response.status)) throw new ActivityError('unauthorized', 502);
    if (response.status === 429) throw new ActivityError('rate_limited', 429);
    if (!response.ok) throw new ActivityError('unavailable', 502);
    if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new ActivityError('invalid_response', 502);
    const reader = response.body?.getReader();
    if (!reader) throw new ActivityError('invalid_response', 502);
    const chunks = []; let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) { abort.abort(); throw new ActivityError('invalid_response', 502); }
      chunks.push(Buffer.from(chunk.value));
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ActivityError('invalid_response', 502); }
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new ActivityError('invalid_response', 502);
    return result;
  } catch (error) {
    if (error instanceof ActivityError) throw error;
    throw new ActivityError('unavailable', 502);
  } finally {
    abort.abort(); clearTimeout(timer);
    try { if (!response?.body?.locked) await response?.body?.cancel(); } catch {}
  }
}

const normalized = email => String(email || '').trim().toLowerCase();
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

function accountInfo(raw, uuid, email) {
  if (String(raw.id).toLowerCase() !== uuid || normalized(raw.email) !== normalized(email)) throw new ActivityError('account_mismatch');
  const state = timestamp(raw.warmup_paused_at) ? 'paused' : timestamp(raw.warmup) ? 'active' : raw.warmup === null && raw.warmup_paused_at === null ? 'stopped' : 'unknown';
  return { id: uuid, email: normalized(email), state,
    started_at: timestamp(raw.warmup) ? raw.warmup : null,
    paused_at: timestamp(raw.warmup_paused_at) ? raw.warmup_paused_at : null };
}

function analyticsInfo(raw, uuid, from, to) {
  const rangeMatches = typeof raw.date_range?.from === 'string' && typeof raw.date_range?.to === 'string'
    && raw.date_range.from.slice(0, 10) === from && raw.date_range.to.slice(0, 10) === to
    && Number.isFinite(Date.parse(raw.date_range.from)) && Number.isFinite(Date.parse(raw.date_range.to));
  if (String(raw.email_account_id).toLowerCase() !== uuid || !raw.summary || typeof raw.summary !== 'object' || Array.isArray(raw.summary) || !rangeMatches || !Array.isArray(raw.daily_stats)) throw new ActivityError('invalid_response', 502);
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const summary = {};
  for (const key of ['total_sent', 'total_replied', 'total_received', 'days_active']) summary[key] = count(raw.summary[key]);
  for (const key of ['average_daily', 'reply_rate', 'target_progress']) summary[key] = number(raw.summary[key]);
  if (raw.daily_stats.length > 366) throw new ActivityError('invalid_response', 502);
  const days = new Set();
  const daily_stats = raw.daily_stats.map(row => {
    if (!date(row?.date) || row.date < from || row.date > to || days.has(row.date)) throw new ActivityError('invalid_response', 502);
    days.add(row.date);
    return { date: row.date, emails_sent: count(row.emails_sent), emails_replied: count(row.emails_replied), emails_received: count(row.emails_received), target_volume: count(row.target_volume) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { from, to, summary, daily_stats };
}

export function createWarmblyActivity({ db = getDb(), env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10000, minimumIntervalMs = 15000, now = () => new Date() } = {}) {
  const transport = { fetchImpl, timeoutMs: Math.max(20, Math.min(30000, Number(timeoutMs) || 10000)) };
  if (!running.has(db)) running.set(db, new Set());
  const active = running.get(db);
  function mailbox(id) {
    if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new ActivityError('Mailbox not found.', 404);
    const row = db.prepare('SELECT id,email FROM mailboxes WHERE id=?').get(Number(id));
    if (!row) throw new ActivityError('Mailbox not found.', 404);
    return row;
  }
  const linkRow = id => db.prepare('SELECT * FROM native_warmup_links WHERE mailbox_id=?').get(Number(id));
  function status(id, actor) {
    const mb = mailbox(id); const link = linkRow(id); const config = configuration(env);
    const snapshot = link ? db.prepare('SELECT observed_at,activity_json FROM native_warmup_observations WHERE mailbox_id=? AND account_id=? AND provider_origin=? AND email=? ORDER BY id DESC LIMIT 1').get(mb.id, link.account_id, link.provider_origin, link.email) : null;
    const matches = !!link && normalized(mb.email) === link.email && config?.origin === link.provider_origin;
    return { configured: !!config, linked: !!link, requires_relink: !!link && !matches,
      can_manage: ['owner', 'admin'].includes(actor?.role), account_id: link?.account_id || null,
      linked_at: link?.linked_at || null, last_attempt_at: link?.last_attempt_at || null,
      error_code: link?.last_error_code || null, error: link?.last_error_code ? failures[link.last_error_code] : null,
      observation: snapshot ? { observed_at: snapshot.observed_at, stale: !matches || !!link.last_error_code, ...JSON.parse(snapshot.activity_json) } : null,
      source: 'warmbly_native_api', read_only: true,
    };
  }
  function authorize(actor) { if (!['owner', 'admin'].includes(actor?.role)) throw new ActivityError('Only workspace owners and admins can manage the native warm-up connection.', 403); }
  async function exclusive(id, callback) {
    if (active.has(Number(id))) throw new ActivityError('A Warmbly check is already running for this mailbox.', 409);
    active.add(Number(id));
    try { return await callback(); } finally { active.delete(Number(id)); }
  }
  function current(config) { if (configuration(env)?.origin !== config.origin || configuration(env)?.token !== config.token) throw new ActivityError('mapping_changed', 409); }
  return {
    status,
    async link(id, accountId, actor) {
      authorize(actor); const mb = mailbox(id);
      if (typeof accountId !== 'string' || !UUID.test(accountId)) throw new ActivityError('Enter the mailbox account UUID from Warmbly.');
      const uuid = accountId.toLowerCase(); const config = configuration(env);
      if (!config) throw new ActivityError('not_configured', 503);
      return exclusive(id, async () => {
        accountInfo(await readNative(config, `/v1/emails/${uuid}`, transport), uuid, mb.email);
        current(config);
        db.transaction(() => {
          if (normalized(mailbox(id).email) !== normalized(mb.email)) throw new ActivityError('mapping_changed', 409);
          const used = db.prepare('SELECT mailbox_id FROM native_warmup_links WHERE account_id=? AND mailbox_id<>?').get(uuid, mb.id);
          if (used) throw new ActivityError('This native account is already linked to another mailbox.', 409);
          const previous = linkRow(id);
          const sameMapping = previous?.account_id === uuid && previous.email === normalized(mb.email) && previous.provider_origin === config.origin;
          db.prepare(`INSERT INTO native_warmup_links(mailbox_id,account_id,email,provider_origin,linked_by,linked_at,last_attempt_at,last_error_code)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(mailbox_id) DO UPDATE SET account_id=excluded.account_id,email=excluded.email,provider_origin=excluded.provider_origin,linked_by=excluded.linked_by,linked_at=excluded.linked_at,last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code`)
            .run(mb.id, uuid, normalized(mb.email), config.origin, actor.id || null, now().toISOString(), sameMapping ? previous.last_attempt_at : null, sameMapping ? previous.last_error_code : null);
        }).immediate();
        return status(id, actor);
      });
    },
    unlink(id, actor) { authorize(actor); mailbox(id); if (active.has(Number(id))) throw new ActivityError('A Warmbly check is already running for this mailbox.', 409); db.prepare('DELETE FROM native_warmup_links WHERE mailbox_id=?').run(Number(id)); return status(id, actor); },
    async refresh(id, actor) {
      authorize(actor); const mb = mailbox(id); const link = linkRow(id); const config = configuration(env);
      if (!config) throw new ActivityError('not_configured', 503);
      if (!link) throw new ActivityError('Link this mailbox to its native Warmbly account first.', 409);
      if (link.provider_origin !== config.origin || link.email !== normalized(mb.email)) throw new ActivityError('mapping_changed', 409);
      const at = now();
      if (link.last_attempt_at && at.getTime() - Date.parse(link.last_attempt_at) < minimumIntervalMs) throw new ActivityError('rate_limited', 429);
      return exclusive(id, async () => {
        db.prepare('UPDATE native_warmup_links SET last_attempt_at=? WHERE mailbox_id=?').run(at.toISOString(), mb.id);
        try {
          const account = accountInfo(await readNative(config, `/v1/emails/${link.account_id}`, transport), link.account_id, mb.email);
          const to = at.toISOString().slice(0, 10); const from = new Date(at.getTime() - 29 * 86400000).toISOString().slice(0, 10);
          const query = new URLSearchParams({ email_id: link.account_id, from, to });
          const analytics = analyticsInfo(await readNative(config, `/v1/analytics/warmup?${query}`, transport), link.account_id, from, to);
          current(config);
          db.transaction(() => {
            const latest = linkRow(id);
            if (!latest || latest.linked_at !== link.linked_at || latest.account_id !== link.account_id || latest.provider_origin !== config.origin || normalized(mailbox(id).email) !== link.email) throw new ActivityError('mapping_changed', 409);
            db.prepare('INSERT INTO native_warmup_observations(mailbox_id,account_id,email,provider_origin,observed_at,activity_json) VALUES(?,?,?,?,?,?)')
              .run(mb.id, link.account_id, link.email, config.origin, now().toISOString(), JSON.stringify({ account, ...analytics }));
            db.prepare('UPDATE native_warmup_links SET last_error_code=NULL WHERE mailbox_id=?').run(mb.id);
          }).immediate();
          return status(id, actor);
        } catch (error) {
          db.prepare('UPDATE native_warmup_links SET last_error_code=? WHERE mailbox_id=? AND account_id=? AND linked_at=?').run(Object.hasOwn(failures, error.code) ? error.code : 'unavailable', mb.id, link.account_id, link.linked_at);
          throw error;
        }
      });
    },
  };
}
