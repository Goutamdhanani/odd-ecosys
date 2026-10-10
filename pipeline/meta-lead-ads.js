import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { decryptCredential, encryptCredential } from './credential-vault.js';
import { getDb } from './database.js';
import { importContactsToBatch } from './contact-manager.js';

const PROVIDER = 'meta_lead_ads';
const GRAPH_ORIGIN = 'https://graph.facebook.com';
const MAX_LEADS_PER_IMPORT = 250;
const MAX_GRAPH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FIELD_VALUE_LENGTH = 2000;
const META_RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613]);
const MAX_META_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_META_COOLDOWN_MS = 60 * 1000;
const IMPORT_FIELDS = new Set(['business_name', 'category', 'address', 'city', 'state', 'country', 'phone', 'website_url', 'email']);

export class MetaLeadAdsError extends Error {
  constructor(message, statusCode = 400, code = 'meta_lead_ads_error', details = {}) {
    super(message);
    this.name = 'MetaLeadAdsError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterAt = typeof details.retryAfterAt === 'string' ? details.retryAfterAt : null;
  }
}

export function isMetaLeadAdsAdmin(actor) {
  return Boolean(actor?.id && ['owner', 'admin'].includes(actor.role));
}

function numericId(value, label) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,32}$/.test(id)) throw new MetaLeadAdsError(`${label} must be a numeric Meta ID.`);
  return id;
}

function graphVersion(value) {
  const version = typeof value === 'string' ? value.trim() : '';
  if (!/^v\d{1,2}\.\d{1,2}$/.test(version)) throw new MetaLeadAdsError('Graph API version must use the format vNN.N.');
  return version;
}

function fieldMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MetaLeadAdsError('Choose the lead form fields to import.');
  const result = {};
  for (const [target, source] of Object.entries(value)) {
    if (!IMPORT_FIELDS.has(target)) throw new MetaLeadAdsError('The selected field mapping contains an unsupported contact field.');
    if (source == null || source === '') continue;
    if (typeof source !== 'string' || source.length > 120 || /[\u0000-\u001f]/.test(source)) throw new MetaLeadAdsError('Lead form field names must be plain text.');
    result[target] = source.trim();
  }
  if (!result.business_name) throw new MetaLeadAdsError('Map a form field to Business or respondent name.');
  return result;
}

function safeText(value, limit = MAX_FIELD_VALUE_LENGTH) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, limit);
}

function formFieldData(lead) {
  if (!Array.isArray(lead.field_data)) return new Map();
  const result = new Map();
  for (const item of lead.field_data) {
    if (!item || typeof item.name !== 'string' || item.name.length > 120) continue;
    const values = Array.isArray(item.values) ? item.values : item.value === undefined ? [] : [item.value];
    const value = values.map(candidate => safeText(candidate, 500)).filter(Boolean).join(', ').slice(0, MAX_FIELD_VALUE_LENGTH);
    if (value) result.set(item.name, value);
  }
  return result;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function opaqueCursor(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MetaLeadAdsError('Meta returned an invalid paging cursor; the saved progress was kept.', 502, 'meta_cursor_invalid');
  }
  return value;
}

function graphMessage(status) {
  if (status === 401 || status === 403) return 'Meta rejected this request. Check that the Page access token is valid and has approved lead retrieval access.';
  if (status === 429) return 'Meta rate-limited this connection. Requests are paused until the displayed time; retry manually afterward.';
  return 'Meta Graph API request failed. Check the Page, form permissions, and API version, then try again.';
}

function safeUsageNumber(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number * 100) / 100 : null;
}

function parseJsonHeader(value) {
  if (typeof value !== 'string' || !value || value.length > 16 * 1024) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function usageMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [source, target] of [['call_count', 'callCount'], ['total_time', 'totalTime'], ['total_cputime', 'totalCpuTime']]) {
    const normalized = safeUsageNumber(value[source]);
    if (normalized !== null) result[target] = normalized;
  }
  return Object.keys(result).length ? result : null;
}

function collectBusinessUsage(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4 || output.length >= 32) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBusinessUsage(item, output, depth + 1);
    return;
  }
  const metrics = usageMetrics(value);
  const rawRegain = typeof value.estimated_time_to_regain_access === 'number'
    || typeof value.estimated_time_to_regain_access === 'string'
    ? Number(value.estimated_time_to_regain_access) : NaN;
  const regain = Number.isFinite(rawRegain) && rawRegain >= 0 && rawRegain <= MAX_META_COOLDOWN_MS / 60_000
    ? Math.round(rawRegain * 100) / 100 : null;
  const type = typeof value.type === 'string' && /^[a-z_]{1,40}$/i.test(value.type) ? value.type.toLowerCase() : null;
  if (metrics || regain !== null || type) {
    const item = { ...(type ? { type } : {}), ...(metrics || {}) };
    if (regain !== null) item.estimatedTimeToRegainAccessMinutes = regain;
    output.push(item);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.length <= 40) collectBusinessUsage(child, output, depth + 1);
  }
}

export function parseMetaRateUsage(headers) {
  const app = parseJsonHeader(headers?.get?.('x-app-usage'));
  const business = parseJsonHeader(headers?.get?.('x-business-use-case-usage'));
  const appUsage = usageMetrics(app);
  const businessUseCaseUsage = [];
  collectBusinessUsage(business, businessUseCaseUsage);
  return {
    ...(appUsage ? { app: appUsage } : {}),
    ...(businessUseCaseUsage.length ? { businessUseCase: businessUseCaseUsage.slice(0, 8) } : {}),
  };
}

function retryAfterDelayMs(value, nowMs) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let delay = null;
  if (/^\d{1,10}$/.test(raw)) delay = Number(raw) * 1000;
  else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) delay = at - nowMs;
  }
  if (!Number.isFinite(delay)) return null;
  return Math.min(MAX_META_COOLDOWN_MS, Math.max(1000, delay));
}

export function metaRateLimitDeadline({ retryAfter, usage, nowMs = Date.now() } = {}) {
  const explicit = retryAfterDelayMs(retryAfter, nowMs);
  if (explicit !== null) return new Date(nowMs + explicit).toISOString();
  const estimates = (usage?.businessUseCase || [])
    .map(item => item.estimatedTimeToRegainAccessMinutes)
    .filter(value => Number.isFinite(value) && value > 0)
    .map(minutes => Math.min(MAX_META_COOLDOWN_MS, minutes * 60_000));
  const delay = estimates.length ? Math.max(...estimates) : DEFAULT_META_COOLDOWN_MS;
  return new Date(nowMs + Math.min(MAX_META_COOLDOWN_MS, delay)).toISOString();
}

function isMetaRateLimitError(payload) {
  const code = Number(payload?.error?.code);
  return Number.isInteger(code) && META_RATE_LIMIT_ERROR_CODES.has(code);
}

function parsedUsageJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function hashedVerifyToken(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeHexMatch(expectedHex, supplied) {
  if (typeof supplied !== 'string' || supplied.length > 512) return false;
  const expected = Buffer.from(expectedHex || '', 'hex');
  const actual = Buffer.from(hashedVerifyToken(supplied), 'hex');
  return expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual);
}

function constantTimeSignatureMatch(secret, signature, rawBody) {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const supplied = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function persistMappedLeadRecords(db, row, formId, batchId, mapping, fetched) {
  const accepted = [];
  const invalidProviderRows = [];
  for (const [index, lead] of fetched.entries()) {
    const externalId = String(lead?.id || '').trim();
    if (!/^\d{1,40}$/.test(externalId) || (lead?.form_id && String(lead.form_id) !== formId)) {
      invalidProviderRows.push(index + 1);
      continue;
    }
    const sourceFields = formFieldData(lead);
    const values = Object.fromEntries(Object.entries(mapping).map(([target, field]) => [target, sourceFields.get(field) || '']));
    if (!values.business_name) {
      invalidProviderRows.push(index + 1);
      continue;
    }
    const submittedAt = safeTimestamp(lead.created_time);
    values.source_details = `Meta Lead Ads · form ${formId}${submittedAt ? ` · submitted ${submittedAt}` : ''}`;
    values.source_url = `https://www.facebook.com/${row.page_id}`;
    accepted.push({ externalId, submittedAt, values });
  }

  const csvFields = [...new Set(['business_name', ...Object.keys(mapping).filter(key => key !== 'business_name'), 'source_details', 'source_url'])];
  const csv = [csvFields.map(csvCell).join(','), ...accepted.map(item => csvFields.map(key => csvCell(item.values[key])).join(','))].join('\r\n');
  const sourceRecordsByRow = Object.fromEntries(accepted.map((item, index) => [String(index + 2), {
    external_id: item.externalId, page_id: row.page_id, form_id: formId, source_created_at: item.submittedAt,
  }]));
  const result = accepted.length
    ? importContactsToBatch(batchId, csv, {}, PROVIDER, { sourceRecordsByRow })
    : { counts: { inserted: 0, duplicates: 0, invalid: 0 }, rejections: [] };
  return { accepted, invalidProviderRows, result };
}

function publicWebhookUrl() {
  const configured = String(process.env.ODD_PUBLIC_BASE_URL || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/api/webhooks/meta/leadgen`;
  } catch { return ''; }
}

export function createMetaLeadAdsManager({ db = getDb(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!db) throw new TypeError('A database connection is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof now !== 'function') throw new TypeError('A clock function is required.');

  const getStoredConnection = db.prepare('SELECT * FROM lead_source_connections WHERE provider=?');

  function activeRateLimit(row = getStoredConnection.get(PROVIDER)) {
    const until = Date.parse(getStoredConnection.get(PROVIDER)?.rate_limit_until || row?.rate_limit_until || '');
    return Number.isFinite(until) && until > Number(now()) ? new Date(until).toISOString() : null;
  }

  function cooldownError(until) {
    return new MetaLeadAdsError(`Meta rate-limit cooldown is active until ${new Date(until).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' })}. No Graph API request was made. Retry manually after the deadline.`, 429,
      'meta_rate_limit_cooldown', { retryAfterAt: until });
  }

  function assertNoActiveRateLimit(row) {
    const until = activeRateLimit();
    if (until) throw cooldownError(until);
    return row;
  }

  function saveUsage(headers, { rateLimited = false, retryAfter = '', usage = parseMetaRateUsage(headers) } = {}) {
    const hasUsage = Boolean(usage && Object.keys(usage).length);
    const serialized = JSON.stringify(usage || {});
    if (rateLimited) {
      const deadline = metaRateLimitDeadline({ retryAfter, usage, nowMs: Number(now()) });
      db.prepare(`UPDATE lead_source_connections SET
        rate_usage_json=CASE WHEN ? THEN ? ELSE rate_usage_json END,
        rate_usage_observed_at=CASE WHEN ? THEN ? ELSE rate_usage_observed_at END,
        rate_limit_until=?,rate_limit_recovery_required=1,updated_at=datetime('now') WHERE provider=?`)
        .run(hasUsage ? 1 : 0, serialized, hasUsage ? 1 : 0, new Date(Number(now())).toISOString(), deadline, PROVIDER);
      return deadline;
    }
    db.prepare(`UPDATE lead_source_connections SET
      rate_usage_json=CASE WHEN ? THEN ? ELSE rate_usage_json END,
      rate_usage_observed_at=CASE WHEN ? THEN ? ELSE rate_usage_observed_at END,
      rate_limit_until=CASE WHEN rate_limit_until IS NOT NULL AND rate_limit_until<=? THEN NULL ELSE rate_limit_until END,
      rate_limit_recovery_required=CASE WHEN rate_limit_until IS NOT NULL AND rate_limit_until<=? THEN 0 ELSE rate_limit_recovery_required END,
      updated_at=datetime('now') WHERE provider=?`)
      .run(hasUsage ? 1 : 0, serialized, hasUsage ? 1 : 0, new Date(Number(now())).toISOString(),
        new Date(Number(now())).toISOString(), new Date(Number(now())).toISOString(), PROVIDER);
    return null;
  }

  function recordRateLimit(headers, payload = null) {
    const usage = parseMetaRateUsage(headers);
    const retryAfter = headers?.get?.('retry-after') || '';
    const deadline = saveUsage(headers, { rateLimited: true, retryAfter, usage });
    const code = isMetaRateLimitError(payload) ? Number(payload.error.code) : null;
    const detail = code ? ` (Graph API throttle code ${code})` : '';
    throw new MetaLeadAdsError(`${graphMessage(429)}${detail} Cooldown until ${new Date(deadline).toISOString()}.`, 429,
      'meta_rate_limited', { retryAfterAt: deadline });
  }

  function publicStatus() {
    const row = getStoredConnection.get(PROVIDER);
    const rateUsage = parsedUsageJson(row?.rate_usage_json);
    return {
      provider: PROVIDER,
      configured: Boolean(row),
      pageId: row?.page_id || '',
      graphVersion: row?.graph_version || '',
      tokenPresent: Boolean(row?.access_token_enc),
      connectionStatus: row?.connection_status === 'verified' ? 'provider_verified' : row ? 'provider_unverified' : 'not_configured',
      webhookConfigured: Boolean(row?.webhook_app_secret_enc && row?.webhook_verify_token_hash),
      lastTestAt: row?.last_test_at || null,
      lastImportAt: row?.last_import_at || null,
      rateLimitUntil: row?.rate_limit_until || null,
      rateLimitActive: Boolean(activeRateLimit(row)),
      rateLimitRecoveryRequired: Boolean(row?.rate_limit_recovery_required),
      rateUsage,
      rateUsageObservedAt: row?.rate_usage_observed_at || null,
    };
  }

  function saveConfiguration({ page_id, graph_version, access_token } = {}) {
    const pageId = numericId(page_id, 'Page ID');
    const version = graphVersion(graph_version);
    const current = getStoredConnection.get(PROVIDER);
    let tokenCiphertext = current?.access_token_enc || '';
    if (typeof access_token === 'string' && access_token.trim()) {
      if (access_token.length > 5000 || /[\r\n\u0000]/.test(access_token)) throw new MetaLeadAdsError('Page access token must be a single-line value under 5,000 characters.');
      tokenCiphertext = encryptCredential(access_token.trim());
    }
    if (!tokenCiphertext) throw new MetaLeadAdsError('Enter a Page access token before saving the Meta connection.');
    db.prepare(`INSERT INTO lead_source_connections(provider,page_id,graph_version,access_token_enc,connection_status,last_test_at,last_import_at,updated_at)
      VALUES(?,?,?,?,'unverified',NULL,NULL,datetime('now'))
      ON CONFLICT(provider) DO UPDATE SET page_id=excluded.page_id,graph_version=excluded.graph_version,
        access_token_enc=excluded.access_token_enc,connection_status='unverified',last_test_at=NULL,updated_at=datetime('now')`)
      .run(PROVIDER, pageId, version, tokenCiphertext);
    return publicStatus();
  }

  function requireVerifiedConnection() {
    const row = getStoredConnection.get(PROVIDER);
    if (!row) throw new MetaLeadAdsError('Configure a Meta Page connection first.', 409, 'meta_connection_required');
    assertNoActiveRateLimit(row);
    if (row.connection_status !== 'verified') throw new MetaLeadAdsError('Test the Meta Page connection successfully before listing forms or importing leads.', 409, 'meta_connection_unverified');
    let token;
    try { token = decryptCredential(row.access_token_enc); }
    catch (error) { throw new MetaLeadAdsError(error.message, error.statusCode || 503, error.code || 'credential_unavailable'); }
    return { ...row, token };
  }

  async function requestGraph(row, path, params = {}, method = 'GET') {
    assertNoActiveRateLimit(row);
    const url = new URL(`/${row.graph_version}/${path}`, GRAPH_ORIGIN);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${row.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new MetaLeadAdsError(error?.name === 'TimeoutError' ? 'Meta Graph API request timed out.' : 'Meta Graph API could not be reached.', 502, 'meta_network_error');
    }
    let raw;
    try { raw = await response.text(); } catch {
      if (response.status === 429) recordRateLimit(response.headers);
      throw new MetaLeadAdsError('Meta returned an unreadable response.', 502, 'meta_response_error');
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_GRAPH_RESPONSE_BYTES) throw new MetaLeadAdsError('Meta response exceeded the 2 MB safety limit.', 502, 'meta_response_too_large');
    let payload;
    try { payload = JSON.parse(raw); } catch {
      if (response.status === 429) recordRateLimit(response.headers);
      throw new MetaLeadAdsError('Meta returned a response that was not valid JSON.', 502, 'meta_response_error');
    }
    const limited = response.status === 429 || isMetaRateLimitError(payload);
    if (limited) recordRateLimit(response.headers, payload);
    const usage = parseMetaRateUsage(response.headers);
    saveUsage(response.headers, { usage });
    if (!response.ok || payload?.error) throw new MetaLeadAdsError(graphMessage(response.status), response.status === 429 ? 429 : 502, 'meta_graph_rejected');
    return payload;
  }

  async function testConnection() {
    const row = getStoredConnection.get(PROVIDER);
    if (!row) throw new MetaLeadAdsError('Configure a Meta Page connection first.', 409, 'meta_connection_required');
    let connection;
    try { connection = { ...row, token: decryptCredential(row.access_token_enc) }; }
    catch (error) { throw new MetaLeadAdsError(error.message, error.statusCode || 503, error.code || 'credential_unavailable'); }
    try {
      const page = await requestGraph(connection, row.page_id, { fields: 'id,name' });
      if (String(page?.id || '') !== row.page_id) throw new MetaLeadAdsError('Meta returned a different Page than the one configured.', 502, 'meta_page_mismatch');
      db.prepare("UPDATE lead_source_connections SET connection_status='verified',last_test_at=datetime('now'),updated_at=datetime('now') WHERE provider=?").run(PROVIDER);
      return { ...publicStatus(), pageName: safeText(page.name, 200) || 'Connected Page' };
    } catch (error) {
      if (!['meta_rate_limited', 'meta_rate_limit_cooldown'].includes(error?.code)) {
        db.prepare("UPDATE lead_source_connections SET connection_status='unverified',last_test_at=datetime('now'),updated_at=datetime('now') WHERE provider=?").run(PROVIDER);
      }
      throw error;
    }
  }

  async function listForms({ continuePage = false } = {}) {
    const row = requireVerifiedConnection();
    const savedCursor = db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_list_cursors WHERE page_id=?').get(row.page_id);
    if (continuePage && (!savedCursor?.has_more || !savedCursor?.after_cursor)) {
      throw new MetaLeadAdsError('There are no more saved Meta forms to load for this Page.', 409, 'meta_form_list_complete');
    }
    const after = continuePage ? opaqueCursor(savedCursor.after_cursor) : '';
    const payload = await requestGraph(row, `${row.page_id}/leadgen_forms`, {
      fields: 'id,name,status,created_time,questions', limit: 100, ...(after ? { after } : {}),
    });
    if (!Array.isArray(payload?.data) || payload.data.length > 100 || payload.data.some(form =>
      !form || typeof form !== 'object' || Array.isArray(form) || !/^\d{1,32}$/.test(String(form.id || '')))) {
      throw new MetaLeadAdsError('Meta did not return a valid lead form page; the saved progress was kept.', 502, 'meta_response_error');
    }
    const hasMore = Boolean(payload.paging?.next);
    const nextCursor = opaqueCursor(payload.paging?.cursors?.after);
    if (hasMore && (!nextCursor || nextCursor === after)) {
      throw new MetaLeadAdsError('Meta did not return a usable next-page cursor; the saved progress was kept.', 502, 'meta_cursor_invalid');
    }
    const forms = payload.data.map(form => {
      const id = String(form.id);
      const progress = db.prepare('SELECT after_cursor,has_more FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get(row.page_id, id);
      const settings = db.prepare('SELECT batch_id,field_map_json FROM meta_lead_form_settings WHERE page_id=? AND form_id=?').get(row.page_id, id);
      let savedFieldMap = {};
      try { savedFieldMap = settings ? fieldMap(JSON.parse(settings.field_map_json)) : {}; } catch { savedFieldMap = {}; }
      return {
        id, name: safeText(form.name, 200) || `Form ${form.id}`,
        status: safeText(form.status, 40) || 'unknown', createdAt: safeTimestamp(form.created_time),
        continuationAvailable: Boolean(progress?.after_cursor && progress?.has_more),
        moreResultsLastSeen: Boolean(progress?.has_more),
        savedBatchId: settings?.batch_id || null,
        savedFieldMap,
        fields: Array.isArray(form.questions) ? form.questions.slice(0, 100).flatMap(question => {
          const key = safeText(question?.key, 120);
          if (!key || /[\u0000-\u001f]/.test(key)) return [];
          return [{ key, label: safeText(question?.label, 200) || key }];
        }) : [],
      };
    });
    // Persist only the opaque cursor. Never save, return, or follow Meta's
    // paging.next URL. A failed/invalid response leaves the prior checkpoint.
    db.prepare(`INSERT INTO meta_lead_form_list_cursors(page_id,after_cursor,has_more,updated_at)
      VALUES(?,?,?,datetime('now')) ON CONFLICT(page_id) DO UPDATE SET
        after_cursor=excluded.after_cursor,has_more=excluded.has_more,updated_at=datetime('now')`)
      .run(row.page_id, hasMore ? nextCursor : (nextCursor || null), hasMore ? 1 : 0);
    return { forms, hasMore };
  }

  async function importForm({ form_id, batch_id, field_map } = {}) {
    const row = requireVerifiedConnection();
    const formId = numericId(form_id, 'Form ID');
    const mapping = fieldMap(field_map);
    const batchId = Number(batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new MetaLeadAdsError('Choose an existing open batch.');
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
    if (!batch) throw new MetaLeadAdsError('Batch not found.', 404);
    if (batch.status !== 'open') throw new MetaLeadAdsError('Meta leads can only be imported into an open batch.', 409);

    const formsPayload = await requestGraph(row, `${row.page_id}/leadgen_forms`, { fields: 'id', limit: 100 });
    if (!Array.isArray(formsPayload?.data) || !formsPayload.data.some(form => String(form?.id || '') === formId)) {
      throw new MetaLeadAdsError('Choose a form listed under the configured Page.', 400, 'meta_form_page_mismatch');
    }

    const previousCursor = db.prepare('SELECT after_cursor FROM meta_lead_form_cursors WHERE page_id=? AND form_id=?').get(row.page_id, formId)?.after_cursor || '';
    const fetched = [];
    let after = previousCursor;
    let nextCursor = previousCursor;
    let hasMore = false;
    const seenCursors = new Set(previousCursor ? [previousCursor] : []);
    for (let page = 0; page < 3 && fetched.length < MAX_LEADS_PER_IMPORT; page++) {
      const requestedPageSize = Math.min(100, MAX_LEADS_PER_IMPORT - fetched.length);
      const payload = await requestGraph(row, `${formId}/leads`, {
        fields: 'id,created_time,form_id,field_data', limit: requestedPageSize, after,
      });
      if (!Array.isArray(payload?.data)) throw new MetaLeadAdsError('Meta did not return leads for this form.', 502, 'meta_response_error');
      if (payload.data.length > requestedPageSize) {
        throw new MetaLeadAdsError('Meta returned more leads than the requested page size. The saved progress was kept; try again.', 502, 'meta_page_size_exceeded');
      }
      for (const lead of payload.data) fetched.push(lead);
      const cursor = opaqueCursor(payload.paging?.cursors?.after);
      if (payload.data.length && !cursor) {
        throw new MetaLeadAdsError('Meta omitted the safe paging cursor. The saved progress was kept; try again.', 502, 'meta_cursor_missing');
      }
      if (cursor) nextCursor = cursor;
      hasMore = Boolean(payload.paging?.next);
      if (!hasMore) break;
      if (!cursor || seenCursors.has(cursor)) {
        throw new MetaLeadAdsError('Meta did not advance the form cursor. The saved progress was kept; test the Page connection before retrying.', 502, 'meta_cursor_stalled');
      }
      seenCursors.add(cursor);
      if (fetched.length >= MAX_LEADS_PER_IMPORT) break;
      after = cursor;
    }

    const { accepted, invalidProviderRows, result } = persistMappedLeadRecords(db, row, formId, batchId, mapping, fetched);
    const canAdvanceCursor = invalidProviderRows.length === 0 && result.counts.invalid === 0;
    if (canAdvanceCursor) {
      db.prepare(`INSERT INTO meta_lead_form_cursors(page_id,form_id,after_cursor,has_more,updated_at)
        VALUES(?,?,?,?,datetime('now'))
        ON CONFLICT(page_id,form_id) DO UPDATE SET after_cursor=excluded.after_cursor,
          has_more=excluded.has_more,updated_at=datetime('now')`)
        .run(row.page_id, formId, nextCursor || null, hasMore ? 1 : 0);
    } else hasMore = true;
    db.prepare("UPDATE lead_source_connections SET last_import_at=datetime('now'),updated_at=datetime('now') WHERE provider=?").run(PROVIDER);
    return {
      batchId, formId, fetched: fetched.length, mapped: accepted.length,
      inserted: result.counts.inserted, duplicates: result.counts.duplicates,
      rejected: result.counts.invalid + invalidProviderRows.length,
      rejectedRows: invalidProviderRows.length + (result.rejections?.length || 0),
      truncated: fetched.length >= MAX_LEADS_PER_IMPORT,
      hasMore,
      cursorAdvanced: canAdvanceCursor,
      emailEvidence: 'unknown', consentRecorded: false, sendingWorkCreated: false,
    };
  }

  function saveWebhookConfiguration({ app_secret, verify_token } = {}) {
    const current = getStoredConnection.get(PROVIDER);
    if (!current) throw new MetaLeadAdsError('Configure the Meta Page connection before enabling lead notifications.', 409, 'meta_connection_required');
    let appSecretCiphertext = current.webhook_app_secret_enc || '';
    let verifyTokenHash = current.webhook_verify_token_hash || '';
    if (app_secret !== undefined && app_secret !== '') {
      if (typeof app_secret !== 'string' || app_secret.trim().length < 16 || app_secret.length > 5000 || /[\r\n\u0000]/.test(app_secret)) {
        throw new MetaLeadAdsError('Meta App Secret must be a single-line value with at least 16 characters.');
      }
      appSecretCiphertext = encryptCredential(app_secret.trim());
    }
    if (verify_token !== undefined && verify_token !== '') {
      if (typeof verify_token !== 'string' || verify_token.trim().length < 32 || verify_token.length > 512 || /[\r\n\u0000]/.test(verify_token)) {
        throw new MetaLeadAdsError('Choose a private webhook verify token with at least 32 characters.');
      }
      verifyTokenHash = hashedVerifyToken(verify_token.trim());
    }
    if (!appSecretCiphertext || !verifyTokenHash) {
      throw new MetaLeadAdsError('Enter both the Meta App Secret and webhook verify token before saving.', 400, 'meta_webhook_configuration_incomplete');
    }
    db.prepare(`UPDATE lead_source_connections SET webhook_app_secret_enc=?,webhook_verify_token_hash=?,updated_at=datetime('now')
      WHERE provider=?`).run(appSecretCiphertext, verifyTokenHash, PROVIDER);
    return getWebhookStatus();
  }

  function getWebhookStatus() {
    const row = getStoredConnection.get(PROVIDER);
    const counts = Object.fromEntries(db.prepare(`SELECT status,COUNT(*) AS count FROM meta_lead_webhook_events
      WHERE page_id=? GROUP BY status`).all(row?.page_id || '').map(item => [item.status, item.count]));
    const recent = db.prepare(`SELECT id,form_id,lead_id,status,attempts,last_error_code,received_at,updated_at
      FROM meta_lead_webhook_events WHERE page_id=? ORDER BY id DESC LIMIT 20`).all(row?.page_id || '');
    return {
      configured: Boolean(row?.webhook_app_secret_enc && row?.webhook_verify_token_hash),
      pageId: row?.page_id || '',
      webhookUrl: publicWebhookUrl() || null,
      lastPageSubscriptionAt: row?.webhook_page_subscribed_at || null,
      counts: { pending: counts.pending || 0, processing: counts.processing || 0, imported: counts.imported || 0, failed: counts.failed || 0 },
      recent,
    };
  }

  async function subscribePageToLeadgen() {
    const row = requireVerifiedConnection();
    if (!row.webhook_app_secret_enc || !row.webhook_verify_token_hash) {
      throw new MetaLeadAdsError('Save the webhook App Secret and verify token before subscribing the Page.', 409, 'meta_webhook_configuration_incomplete');
    }
    if (!publicWebhookUrl()) {
      throw new MetaLeadAdsError('Set ODD_PUBLIC_BASE_URL to the externally reachable HTTPS app URL before subscribing the Page.', 409, 'meta_webhook_public_url_required');
    }
    const result = await requestGraph(row, `${row.page_id}/subscribed_apps`, { subscribed_fields: 'leadgen' }, 'POST');
    if (result?.success !== true) {
      throw new MetaLeadAdsError('Meta did not confirm the Page leadgen subscription. Check Page permissions and try again.', 502, 'meta_page_subscription_unconfirmed');
    }
    db.prepare("UPDATE lead_source_connections SET webhook_page_subscribed_at=datetime('now'),updated_at=datetime('now') WHERE provider=?")
      .run(PROVIDER);
    return getWebhookStatus();
  }

  function verifyWebhookChallenge({ mode, verifyToken, challenge } = {}) {
    const row = getStoredConnection.get(PROVIDER);
    if (!row?.webhook_verify_token_hash || !row?.webhook_app_secret_enc) {
      throw new MetaLeadAdsError('Meta webhook verification is not configured.', 503, 'meta_webhook_unconfigured');
    }
    if (mode !== 'subscribe' || typeof challenge !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(challenge)
      || !constantTimeHexMatch(row.webhook_verify_token_hash, verifyToken)) {
      throw new MetaLeadAdsError('Meta webhook verification was not accepted.', 403, 'meta_webhook_challenge_rejected');
    }
    return challenge;
  }

  function receiveWebhook({ rawBody, signature } = {}) {
    const row = getStoredConnection.get(PROVIDER);
    if (!row?.webhook_app_secret_enc) throw new MetaLeadAdsError('Meta webhook receipt is not configured.', 503, 'meta_webhook_unconfigured');
    let appSecret;
    try { appSecret = decryptCredential(row.webhook_app_secret_enc); }
    catch (error) { throw new MetaLeadAdsError(error.message, error.statusCode || 503, error.code || 'credential_unavailable'); }
    const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
    if (bytes.length < 2 || bytes.length > 256 * 1024) throw new MetaLeadAdsError('Meta webhook body is empty or exceeds the 256 KB limit.', 413, 'meta_webhook_body_size');
    if (!constantTimeSignatureMatch(appSecret, signature, bytes)) {
      throw new MetaLeadAdsError('Meta webhook signature was not accepted.', 401, 'meta_webhook_signature_rejected');
    }
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8')); }
    catch { throw new MetaLeadAdsError('Meta webhook body is not valid JSON.', 400, 'meta_webhook_invalid_json'); }
    if (payload?.object !== 'page' || !Array.isArray(payload.entry) || payload.entry.length > 100) {
      throw new MetaLeadAdsError('Meta webhook payload is not a supported Page event.', 400, 'meta_webhook_invalid_payload');
    }

    const events = [];
    let ignored = 0;
    for (const entry of payload.entry) {
      if (String(entry?.id || '') !== row.page_id) { ignored += Array.isArray(entry?.changes) ? entry.changes.length : 1; continue; }
      if (!Array.isArray(entry?.changes) || entry.changes.length > 100) {
        throw new MetaLeadAdsError('Meta webhook Page entry has an invalid change list.', 400, 'meta_webhook_invalid_payload');
      }
      for (const change of entry.changes) {
        if (change?.field !== 'leadgen') { ignored += 1; continue; }
        const value = change.value;
        if (!value || (value.page_id != null && String(value.page_id) !== row.page_id)) { ignored += 1; continue; }
        const formId = numericId(value.form_id, 'Form ID');
        const leadId = numericId(value.leadgen_id, 'Lead ID');
        const seconds = Number(value.created_time);
        const createdAt = Number.isFinite(seconds) && seconds > 0 && seconds < 32503680000
          ? new Date(seconds * 1000).toISOString() : safeTimestamp(value.created_time);
        events.push({ formId, leadId, createdAt });
        if (events.length > 1000) throw new MetaLeadAdsError('Meta webhook contains too many lead notifications.', 413, 'meta_webhook_too_many_events');
      }
    }

    const insert = db.prepare(`INSERT OR IGNORE INTO meta_lead_webhook_events(page_id,form_id,lead_id,source_created_at)
      VALUES(?,?,?,?)`);
    let accepted = 0;
    let duplicates = 0;
    db.transaction(() => {
      for (const event of events) {
        const result = insert.run(row.page_id, event.formId, event.leadId, event.createdAt);
        if (result.changes) accepted += 1;
        else duplicates += 1;
      }
    })();
    return { accepted, duplicates, ignored };
  }

  async function saveFormMapping({ form_id, batch_id, field_map } = {}) {
    const row = requireVerifiedConnection();
    const formId = numericId(form_id, 'Form ID');
    const batchId = Number(batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new MetaLeadAdsError('Choose an existing open batch.');
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
    if (!batch) throw new MetaLeadAdsError('Batch not found.', 404);
    if (batch.status !== 'open') throw new MetaLeadAdsError('Webhook imports require an open batch.', 409);
    const mapping = fieldMap(field_map);
    const payload = await requestGraph(row, `${row.page_id}/leadgen_forms`, { fields: 'id,questions', limit: 100 });
    const selected = Array.isArray(payload?.data) ? payload.data.find(form => String(form?.id || '') === formId) : null;
    if (!selected) throw new MetaLeadAdsError('Choose a form listed under the configured Page.', 400, 'meta_form_page_mismatch');
    const known = new Set((Array.isArray(selected.questions) ? selected.questions : []).map(question => String(question?.key || '')));
    if (Object.values(mapping).some(key => !known.has(key))) {
      throw new MetaLeadAdsError('The saved mapping includes a field that is not on this Meta form. Reload its questions and try again.', 400, 'meta_mapping_field_mismatch');
    }
    db.prepare(`INSERT INTO meta_lead_form_settings(page_id,form_id,batch_id,field_map_json,updated_at) VALUES(?,?,?,?,datetime('now'))
      ON CONFLICT(page_id,form_id) DO UPDATE SET batch_id=excluded.batch_id,field_map_json=excluded.field_map_json,updated_at=datetime('now')`)
      .run(row.page_id, formId, batchId, JSON.stringify(mapping));
    return { formId, batchId, saved: true, fieldCount: Object.keys(mapping).length };
  }

  async function importWebhookLead(row, event, settings) {
    const mapping = fieldMap(JSON.parse(settings.field_map_json));
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(settings.batch_id);
    if (!batch || batch.status !== 'open') throw new MetaLeadAdsError('The saved Meta webhook batch is no longer open.', 409, 'meta_webhook_batch_closed');
    const payload = await requestGraph(row, event.lead_id, { fields: 'id,form_id,created_time,field_data' });
    if (String(payload?.id || '') !== event.lead_id || String(payload?.form_id || '') !== event.form_id) {
      throw new MetaLeadAdsError('Meta returned a lead that does not match the verified webhook form.', 502, 'meta_webhook_lead_mismatch');
    }
    const { accepted, invalidProviderRows, result } = persistMappedLeadRecords(db, row, event.form_id, batch.id, mapping, [payload]);
    if (invalidProviderRows.length || result.counts.invalid || accepted.length !== 1) {
      throw new MetaLeadAdsError('The retrieved Meta lead did not satisfy the saved form mapping.', 422, 'meta_webhook_lead_invalid');
    }
    return { inserted: result.counts.inserted, duplicates: result.counts.duplicates };
  }

  async function processWebhookEvents({ limit = 25, includeFailed = false, operatorInitiated = false } = {}) {
    const stored = getStoredConnection.get(PROVIDER);
    if (!operatorInitiated && (stored?.rate_limit_recovery_required || activeRateLimit(stored))) {
      return { examined: 0, imported: 0, failed: 0, inserted: 0, duplicates: 0, sendingWorkCreated: false,
        pausedForRateLimit: true, rateLimitUntil: stored?.rate_limit_until || null };
    }
    const row = requireVerifiedConnection();
    const max = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 25;
    const statuses = includeFailed ? ['pending', 'failed'] : ['pending'];
    const placeholders = statuses.map(() => '?').join(',');
    const events = db.prepare(`SELECT id,page_id,form_id,lead_id,status,attempts FROM meta_lead_webhook_events
      WHERE page_id=? AND (status IN (${placeholders}) OR (status='processing' AND updated_at<=datetime('now','-5 minutes'))) ORDER BY id LIMIT ?`).all(row.page_id, ...statuses, max);
    const claim = db.prepare(`UPDATE meta_lead_webhook_events SET status='processing',attempts=attempts+1,last_error_code=NULL,updated_at=datetime('now')
      WHERE id=? AND status=? AND (status!='processing' OR updated_at<=datetime('now','-5 minutes'))`);
    let imported = 0;
    let failed = 0;
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      if (!claim.run(event.id, event.status).changes) continue;
      try {
        const settings = db.prepare('SELECT batch_id,field_map_json FROM meta_lead_form_settings WHERE page_id=? AND form_id=?').get(row.page_id, event.form_id);
        if (!settings) throw new MetaLeadAdsError('Save a field mapping and open batch for this form before processing webhook leads.', 409, 'meta_webhook_mapping_missing');
        const result = await importWebhookLead(row, event, settings);
        db.prepare("UPDATE meta_lead_webhook_events SET status='imported',last_error_code=NULL,updated_at=datetime('now') WHERE id=? AND status='processing'").run(event.id);
        imported += 1;
        inserted += result.inserted;
        duplicates += result.duplicates;
      } catch (error) {
        const code = /^[a-z0-9_]{1,64}$/i.test(String(error?.code || '')) ? String(error.code) : 'processing_failed';
        db.prepare("UPDATE meta_lead_webhook_events SET status='failed',last_error_code=?,updated_at=datetime('now') WHERE id=? AND status='processing'").run(code, event.id);
        failed += 1;
        if (code === 'meta_rate_limited' || code === 'meta_rate_limit_cooldown') break;
      }
    }
    const rateLimitState = getStoredConnection.get(PROVIDER);
    return {
      examined: events.length, imported, failed, inserted, duplicates, sendingWorkCreated: false,
      ...(rateLimitState?.rate_limit_recovery_required ? {
        pausedForRateLimit: true, rateLimitUntil: rateLimitState.rate_limit_until || null,
      } : {}),
    };
  }

  return {
    publicStatus, saveConfiguration, testConnection, listForms, importForm,
    saveWebhookConfiguration, getWebhookStatus, verifyWebhookChallenge, receiveWebhook,
    saveFormMapping, processWebhookEvents, subscribePageToLeadgen,
  };
}

export const META_LEAD_ADS_LIMITS = Object.freeze({ maxImport: MAX_LEADS_PER_IMPORT });
