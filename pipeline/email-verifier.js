// ============================================================
//  ODD-ECOSYS Pipeline — Evidence-Based Email Verification
//  Syntax · bounded DNS routing · optional identified Reacher · opt-in safe SMTP response
//  Mailbox existence is never inferred from provider labels or RCPT acceptance.
// ============================================================

import dns from 'dns';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { domainToASCII, fileURLToPath } from 'url';
import { getDb } from './database.js';
import { isPublicAddress } from './ssrf-guard.js';
import { classifyEmailType } from './email-type-intelligence.js';
import { deriveVerificationClassification } from '../shared/verification-classification.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ──────────────────────────────────────────────────
const RULES_PATH = path.join(__dirname, '..', 'config', 'verification-rules.json');
let _rules = null;
function getRules() {
  if (!_rules) _rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
  return _rules;
}

// Prefer Reacher's throttled endpoint. The deprecated v0 route bypasses its
// server-side throttle and can harm the verifier host's mail reputation.
const DEFAULT_REACHER_API_URL = 'http://localhost:8080/v1/check_email';
const REACHER_TIMEOUT_MS = Math.max(1000, Math.min(15000, Number.parseInt(process.env.REACHER_TIMEOUT_MS, 10) || 8000));
const DNS_QUERY_TIMEOUT_MS = Math.max(500, Math.min(10000, Number.parseInt(process.env.ODD_VERIFIER_DNS_TIMEOUT_MS, 10) || 4000));
const DISIFY_DOMAIN_CACHE_MS = 10 * 60_000;
const DISIFY_ERROR_CACHE_MS = 30_000;
const DISIFY_CACHE_MAX = 512;
const _disifyDomainCache = new Map();
const _disifyDomainPending = new Map();
let _disifyCooldownUntil = 0;
let _disifyCooldownStatus = 'unavailable';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isDisifyDomainCheckEnabled() {
  return ['1', 'true', 'on', 'yes'].includes(String(process.env.ODD_DISIFY_DOMAIN_CHECK || '').trim().toLowerCase());
}

const REACHER_STATUS_TTL_MS = 30_000;
let _reacherStatusCache = null;
let _reacherStatusPending = null;

function configuredReacherUrl(value = process.env.REACHER_API_URL) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : null;
  return candidate || DEFAULT_REACHER_API_URL;
}

function safeServiceUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'configured endpoint';
  }
}

function reacherVersionUrl(apiUrl) {
  const url = new URL(apiUrl);
  url.pathname = '/version';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function reacherIdentityHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.REACHER_API_SECRET;
  if (typeof secret === 'string' && secret.length) headers['x-reacher-secret'] = secret;
  return headers;
}

async function isReacherEndpoint({ apiUrl, fetchImpl }) {
  // Reacher's documented /version endpoint is intentionally only a version
  // string, so pair it with the documented empty-address validation error on
  // the configured check endpoint. This narrows the check to documented
  // Reacher behavior and blocks ordinary endpoint mismatches without
  // disclosing a contact address during the preflight. The configured host
  // must still be trusted by the operator; a behavioral fingerprint is not
  // cryptographic service authentication.
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: reacherIdentityHeaders(),
    body: JSON.stringify({ to_email: '' }),
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  });
  if (response.redirected || response.status !== 400) return false;
  let body;
  try { body = await response.json(); } catch { return false; }
  return body && body.error === 'to_email field is required.'
    && Object.keys(body).length === 1;
}

function verifierMode(value = process.env.ODD_EMAIL_VERIFIER_MODE) {
  const configured = String(value || '').trim().toLowerCase();
  if (['syntax_dns', 'smtp_if_permitted', 'reacher'].includes(configured)) return configured;
  // Match the pre-Luna behavior: try the local Reacher service by default,
  // then retain DNS-only evidence if that optional service is unavailable.
  return 'reacher';
}

async function inspectReacher({ apiUrl = configuredReacherUrl(), fetchImpl = fetch, force = false } = {}) {
  const configured = Boolean(process.env.REACHER_API_URL) || apiUrl !== DEFAULT_REACHER_API_URL;
  const endpointSource = configured ? 'configured' : 'local_default';
  const cacheKey = `${apiUrl}\u0000${endpointSource}`;
  const safeUrl = safeServiceUrl(apiUrl);

  const now = Date.now();
  if (!force && _reacherStatusCache?.key === cacheKey && now - _reacherStatusCache.checkedAt < REACHER_STATUS_TTL_MS) {
    return { ..._reacherStatusCache.value };
  }
  if (!force && _reacherStatusPending?.key === cacheKey) return _reacherStatusPending.promise;

  const promise = (async () => {
    let value;
    try {
      const response = await fetchImpl(reacherVersionUrl(apiUrl), {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        value = { configured, endpointSource, reachable: true, apiValid: false, smtpCapable: null, url: safeUrl, version: null, errorCode: `http_${response.status}` };
      } else {
        let body;
        try { body = await response.json(); } catch { body = null; }
        const validVersion = body && Object.keys(body).length === 1
          && typeof body.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(body.version);
        const endpointContractValid = validVersion && !response.redirected
          && await isReacherEndpoint({ apiUrl, fetchImpl });
        value = {
          configured,
          endpointSource,
          reachable: true,
          apiValid: Boolean(endpointContractValid),
          smtpCapable: null,
          url: safeUrl,
          version: endpointContractValid ? body.version : null,
          errorCode: endpointContractValid ? null : 'unexpected_service_identity',
        };
      }
    } catch (error) {
      value = {
        configured,
        endpointSource,
        reachable: false,
        apiValid: null,
        smtpCapable: null,
        url: safeUrl,
        version: null,
        errorCode: error?.name === 'TimeoutError' ? 'health_check_timeout' : 'service_unavailable',
      };
    }
    _reacherStatusCache = { key: cacheKey, checkedAt: Date.now(), value };
    return { ...value };
  })();
  _reacherStatusPending = { key: cacheKey, promise };
  try { return await promise; }
  finally { if (_reacherStatusPending?.promise === promise) _reacherStatusPending = null; }
}

function isReacherResult(value, expectedEmail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(['safe', 'risky', 'invalid', 'unknown']);
  const booleanOrNull = field => typeof field === 'boolean' || field === null;
  if (typeof value.input !== 'string' || value.input !== expectedEmail || !allowed.has(value.is_reachable)) return false;
  if (!value.syntax || typeof value.syntax !== 'object' || typeof value.syntax.is_valid_syntax !== 'boolean') return false;
  if (!value.mx || typeof value.mx !== 'object' || Array.isArray(value.mx) || typeof value.mx.accepts_mail !== 'boolean'
    || !Array.isArray(value.mx.records) || value.mx.records.some(record => typeof record !== 'string'
      && (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.exchange !== 'string'))) return false;
  if (!value.smtp || typeof value.smtp !== 'object' || typeof value.smtp.can_connect_smtp !== 'boolean'
    || !booleanOrNull(value.smtp.is_deliverable)) return false;
  const smtpFields = new Set(['can_connect_smtp', 'has_full_inbox', 'is_catch_all', 'is_deliverable', 'is_disabled']);
  if (Object.keys(value.smtp).some(key => !smtpFields.has(key))) return false;
  if (['has_full_inbox', 'is_catch_all', 'is_disabled'].some(key => typeof value.smtp[key] !== 'boolean')) return false;
  if (!value.misc || typeof value.misc !== 'object' || typeof value.misc.is_disposable !== 'boolean'
    || !booleanOrNull(value.misc.is_role_account)) return false;
  return true;
}

// ── Run state ────────────────────────────────────────────────
let _state = {
  active: false,
  jobId: null,
  batchId: null,
  processed: 0,
  total: 0,
  deliverable: 0,
  risky: 0,
  unknown: 0,
  undeliverable: 0,
  suppressed: 0,
  currentEmail: null,
  cancelling: false,
  startedAt: null,
};

const ACTIVE_JOB_STATUSES = ['queued', 'running', 'cancel_requested'];

export function recoverInterruptedVerificationJobs() {
  if (_state.active) return [];
  const db = getDb();
  return db.transaction(() => {
    const orphaned = db.prepare("SELECT id,status FROM verification_jobs WHERE status IN ('queued','running','cancel_requested') ORDER BY id").all();
    const recover = db.prepare(`UPDATE verification_jobs SET
      status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'interrupted' END,
      error_code=CASE WHEN status='cancel_requested' THEN NULL ELSE 'worker_restarted' END,
      error_message=CASE WHEN status='cancel_requested' THEN NULL ELSE 'Worker stopped before the verification job completed. Start a new verification run to retry remaining contacts.' END,
      current_lead_id=NULL,current_email=NULL,current_email_row_id=NULL,
      updated_at=datetime('now'),completed_at=datetime('now')
      WHERE id=? AND status IN ('queued','running','cancel_requested')`);
    for (const job of orphaned) recover.run(job.id);
    return orphaned.map(job => ({ id: job.id, status: job.status === 'cancel_requested' ? 'cancelled' : 'interrupted' }));
  })();
}

export function getVerificationStatus(batchIdValue = null) {
  const db = getDb();
  const batchId = batchIdValue === null || batchIdValue === undefined || batchIdValue === '' ? null : Number(batchIdValue);
  const placeholders = ACTIVE_JOB_STATUSES.map(() => '?').join(',');
  const active = db.prepare(`SELECT * FROM verification_jobs WHERE status IN (${placeholders}) ORDER BY id DESC LIMIT 1`).get(...ACTIVE_JOB_STATUSES);
  const job = active || (batchId !== null
    ? db.prepare('SELECT * FROM verification_jobs WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId)
    : db.prepare('SELECT * FROM verification_jobs ORDER BY id DESC LIMIT 1').get());
  if (!job) return { ..._state, status: null, errorCode: null, errorMessage: null, completedAt: null };
  const currentEmail = job.current_email ?? (job.current_lead_id
    ? db.prepare('SELECT email FROM leads WHERE id=?').get(job.current_lead_id)?.email || null
    : null);
  return {
    jobId: job.id,
    batchId: job.batch_id,
    status: job.status,
    active: ACTIVE_JOB_STATUSES.includes(job.status),
    cancelling: job.status === 'cancel_requested',
    processed: job.processed,
    total: job.total,
    deliverable: job.deliverable,
    risky: job.risky,
    unknown: job.unknown ?? 0,
    undeliverable: job.undeliverable,
    suppressed: job.suppressed ?? 0,
    currentEmail,
    currentEmailRowId: job.current_email_row_id ?? null,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    cancelRequestedAt: job.cancel_requested_at,
    completedAt: job.completed_at,
    errorCode: job.error_code,
    errorMessage: job.error_message,
  };
}

// ══════════════════════════════════════════════════════════════
//  1. PROVIDER & SYNTAX VALIDATION (Reacher Syntax Rules)
// ══════════════════════════════════════════════════════════════

export function validateSyntax(email) {
  const originalEmail = typeof email === 'string' ? email : null;
  const trimmedEmail = originalEmail?.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '') ?? '';
  const normalization = [];
  if (originalEmail !== null && trimmedEmail !== originalEmail) normalization.push('trimmed_outer_whitespace');

  const invalid = (reason, username = null, domain = null) => ({
    is_valid_syntax: false,
    originalEmail,
    normalizedEmail: null,
    normalization,
    username,
    domain,
    asciiDomain: null,
    requiresSmtpUtf8: false,
    reason,
  });

  if (!trimmedEmail || !trimmedEmail.includes('@')) return invalid('missing_at_symbol');
  const at = trimmedEmail.indexOf('@');
  if (at !== trimmedEmail.lastIndexOf('@')) return invalid('multiple_at_symbols');

  const username = trimmedEmail.slice(0, at);
  const inputDomain = trimmedEmail.slice(at + 1);
  if (!username) return invalid('empty_local_part', username, inputDomain || null);
  if (!inputDomain) return invalid('empty_domain', username, null);

  // Validate the supplied domain before WHATWG IDNA conversion. domainToASCII
  // parses URL host input, which can silently remove controls or reinterpret
  // URL delimiters and percent escapes as a different hostname.
  if (/[\p{Cc}\p{White_Space}%/?#\\:[\]]/u.test(inputDomain)) {
    return invalid('invalid_domain_input_characters', username, inputDomain);
  }

  const localBytes = Buffer.byteLength(username, 'utf8');
  if (localBytes > 64) return invalid('local_part_too_long', username, inputDomain);

  const isUtf8NonAscii = char => {
    const codePoint = char.codePointAt(0);
    return codePoint > 0x7f && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  };
  const isAtextCharacter = char => /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]$/.test(char);
  let validLocal = false;
  if (username.startsWith('"') || username.endsWith('"')) {
    if (username.length >= 2 && username.startsWith('"') && username.endsWith('"')) {
      const quoted = username.slice(1, -1);
      validLocal = true;
      const quotedCharacters = [...quoted];
      for (let index = 0; index < quotedCharacters.length; index++) {
        const char = quotedCharacters[index];
        const code = char.codePointAt(0);
        if (char === '\\') {
          const escaped = quotedCharacters[++index];
          if (!escaped || (escaped.codePointAt(0) < 0x20 || escaped.codePointAt(0) > 0x7e)) {
            validLocal = false;
            break;
          }
        } else if (code < 0x20 || code === 0x7f || char === '"' || (code > 0x7f && !isUtf8NonAscii(char))) {
          validLocal = false;
          break;
        }
      }
    }
  } else {
    const atoms = username.split('.');
    validLocal = atoms.every(atom => atom.length > 0 && [...atom].every(char =>
      isAtextCharacter(char) || isUtf8NonAscii(char)));
  }
  if (!validLocal) return invalid('bad_local_part', username, inputDomain);

  // Convert a domain with a reserved suffix so WHATWG's URL host parser cannot
  // reinterpret numeric shorthand as an IPv4 address. Compare with ordinary
  // URL conversion only to reject cases where it would rewrite that input.
  const urlHostAsciiDomain = domainToASCII(inputDomain);
  const domainOnlyAscii = domainToASCII(`${inputDomain}.invalid`);
  if (!urlHostAsciiDomain || !domainOnlyAscii?.endsWith('.invalid')) {
    return invalid('invalid_idn_domain', username, inputDomain);
  }
  const asciiDomain = domainOnlyAscii.slice(0, -'.invalid'.length);
  if (!asciiDomain) return invalid('invalid_idn_domain', username, inputDomain);
  if (urlHostAsciiDomain.toLowerCase() !== asciiDomain.toLowerCase()) {
    return invalid('invalid_domain_input_characters', username, inputDomain);
  }
  const domain = asciiDomain.toLowerCase();
  const labels = domain.split('.');
  if (domain.length > 253) return invalid('domain_too_long', username, domain);
  if (labels.some(label => label.length > 63)) return invalid('domain_label_too_long', username, domain);
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return invalid('bad_domain_syntax', username, domain);
  }

  const normalizedEmail = `${username}@${domain}`;
  if (Buffer.byteLength(normalizedEmail, 'utf8') > 254) return invalid('address_too_long', username, domain);
  if (domain !== inputDomain) {
    normalization.push(/[^\x00-\x7f]/u.test(inputDomain) ? 'idn_domain_to_ascii' : 'lowercased_domain');
  }
  return {
    is_valid_syntax: true,
    originalEmail,
    normalizedEmail,
    normalization,
    username,
    domain,
    asciiDomain: domain,
    requiresSmtpUtf8: /[^\x00-\x7f]/.test(username),
    providerConstraints: 'not_inferred_from_syntax',
  };
}

// ══════════════════════════════════════════════════════════════
//  2. AUTHORITATIVE DNS MX RESOLUTION
// ══════════════════════════════════════════════════════════════

const DNS_CACHE_MAX_ENTRIES = 1000;
const DNS_DEFAULT_POSITIVE_TTL_MS = Math.max(1000, Math.min(300000, Number.parseInt(process.env.ODD_VERIFIER_DNS_CACHE_TTL_MS, 10) || 30000));
const DNS_DEFAULT_NEGATIVE_TTL_MS = 15000;
const dnsResultCache = new Map();
const dnsInFlight = new Map();
const dnsResolverIds = new WeakMap();
let nextDnsResolverId = 1;
const dnsMetrics = { lookups: 0, cacheHits: 0, coalesced: 0, temporaryFailures: 0 };

function dnsResolverId(resolver) {
  if (typeof resolver !== 'function') return 'default';
  if (!dnsResolverIds.has(resolver)) dnsResolverIds.set(resolver, nextDnsResolverId++);
  return dnsResolverIds.get(resolver);
}

function cloneDnsResult(result, diagnostics = {}) {
  return { ...result, records: Array.isArray(result.records) ? [...result.records] : [],
    ...(result.address_record_types ? { address_record_types: [...result.address_record_types] } : {}),
    diagnostics: { ...(result.diagnostics || {}), ...diagnostics } };
}

export function getEmailVerifierDnsMetrics() {
  return { ...dnsMetrics, cacheEntries: dnsResultCache.size, inFlight: dnsInFlight.size, resolverServers: dns.getServers() };
}

export function resetEmailVerifierDnsCache() {
  dnsResultCache.clear();
  dnsInFlight.clear();
  dnsMetrics.lookups = 0;
  dnsMetrics.cacheHits = 0;
  dnsMetrics.coalesced = 0;
  dnsMetrics.temporaryFailures = 0;
}

function resolveWithTimeout(resolveImpl, domain, timeoutMs = DNS_QUERY_TIMEOUT_MS, onTimeout = null) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => resolveImpl(domain)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* cancel is best-effort */ }
        reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' }));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function checkMxRecords(domain, options = {}) {
  const hasCustomResolver = Boolean(options.resolveMxImpl || options.resolve4Impl || options.resolve6Impl);
  const resolver = hasCustomResolver ? null : new dns.Resolver();
  if (resolver && dns.getServers().length) resolver.setServers(dns.getServers());
  const resolveMxImpl = options.resolveMxImpl || (resolver ? resolver.resolveMx.bind(resolver) : dns.promises.resolveMx);
  const resolve4Impl = options.resolve4Impl || (resolver ? resolver.resolve4.bind(resolver) : dns.promises.resolve4);
  const resolve6Impl = options.resolve6Impl || (resolver ? resolver.resolve6.bind(resolver) : dns.promises.resolve6);
  const normalizedDomain = typeof domain === 'string' ? (domainToASCII(domain.trim()) || domain.trim()).toLowerCase() : '';
  const start = Date.now();
  if (!normalizedDomain) {
    return cloneDnsResult({ accepts_mail: null, records: [], primary: null, implicit_mx_record: null, reason: 'dns_invalid_query_domain' }, {
      query: String(domain || ''), resolver_servers: dns.getServers(), latency_ms: 0, cache: 'bypass',
    });
  }
  const cacheEnabled = options.cache !== false;
  const resolverKey = hasCustomResolver
    ? [dnsResolverId(resolveMxImpl), dnsResolverId(resolve4Impl), dnsResolverId(resolve6Impl)].join(':')
    : `system:${dns.getServers().join(',')}`;
  const key = [normalizedDomain, resolverKey, options.dnsTimeoutMs || DNS_QUERY_TIMEOUT_MS].join('|');
  const cached = cacheEnabled ? dnsResultCache.get(key) : null;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (cached && cached.expiresAt > now) {
    dnsMetrics.cacheHits++;
    return cloneDnsResult(cached.result, {
      query: normalizedDomain, resolver_servers: dns.getServers(), latency_ms: 0,
      cache: 'hit', cache_ttl_remaining_ms: cached.expiresAt - now,
    });
  }
  if (cached) dnsResultCache.delete(key);
  if (cacheEnabled && dnsInFlight.has(key)) {
    dnsMetrics.coalesced++;
    const result = await dnsInFlight.get(key);
    return cloneDnsResult(result, {
      query: normalizedDomain, resolver_servers: dns.getServers(), latency_ms: Date.now() - start, cache: 'coalesced',
    });
  }

  dnsMetrics.lookups++;
  const lookup = resolveMxRecordsUncached(normalizedDomain, { ...options, resolveMxImpl, resolve4Impl, resolve6Impl,
    onDnsTimeout: resolver ? () => resolver.cancel() : options.onDnsTimeout });
  if (cacheEnabled) dnsInFlight.set(key, lookup);
  try {
    const result = await lookup;
    const answerTtl = Number.isFinite(result.dns_ttl_seconds) && result.dns_ttl_seconds > 0
      ? result.dns_ttl_seconds * 1000
      : Number.POSITIVE_INFINITY;
    const mxTtl = Array.isArray(result.records) && result.records.length
      ? Math.min(answerTtl, ...result.records.map(record => Number.isFinite(record?.ttl) && record.ttl > 0 ? record.ttl * 1000 : Number.POSITIVE_INFINITY))
      : answerTtl;
    const fallbackTtl = result.accepts_mail === true
      ? (Number.isFinite(mxTtl) ? Math.min(mxTtl, options.cacheMaxTtlMs || DNS_DEFAULT_POSITIVE_TTL_MS) : options.cacheMaxTtlMs || DNS_DEFAULT_POSITIVE_TTL_MS)
      : options.negativeCacheTtlMs || DNS_DEFAULT_NEGATIVE_TTL_MS;
    if (cacheEnabled && result.accepts_mail !== null) {
      dnsResultCache.set(key, { result, expiresAt: (typeof options.now === 'function' ? options.now() : Date.now()) + fallbackTtl });
      while (dnsResultCache.size > DNS_CACHE_MAX_ENTRIES) dnsResultCache.delete(dnsResultCache.keys().next().value);
    }
    if (result.accepts_mail === null) dnsMetrics.temporaryFailures++;
    return cloneDnsResult(result, {
      query: normalizedDomain, resolver_servers: dns.getServers(), latency_ms: Date.now() - start,
      cache: 'miss', cache_ttl_ms: result.accepts_mail === null ? null : fallbackTtl,
      cache_ttl_source: Number.isFinite(mxTtl) ? 'dns_record' : 'conservative_resolver_cap',
    });
  } finally {
    if (dnsInFlight.get(key) === lookup) dnsInFlight.delete(key);
  }
}

async function resolveMxRecordsUncached(domain, options = {}) {
  const {
    resolveMxImpl = dns.promises.resolveMx,
    resolve4Impl = dns.promises.resolve4,
    resolve6Impl = dns.promises.resolve6,
  } = options;

  let mxRecords = null;
  try {
    mxRecords = await resolveWithTimeout(resolveMxImpl, domain, options.dnsTimeoutMs || DNS_QUERY_TIMEOUT_MS, options.onDnsTimeout);
  } catch (error) {
    if (['ENOTFOUND', 'ENONAME'].includes(error?.code)) {
      return { accepts_mail: false, records: [], primary: null, implicit_mx_record: false, reason: 'dns_domain_not_found' };
    }
    if (error?.code !== 'ENODATA') {
      const code = typeof error?.code === 'string' ? error.code : 'unknown';
      return { accepts_mail: null, records: [], primary: null, implicit_mx_record: null, reason: `dns_mx_lookup_failed:${code}` };
    }
  }

  if (Array.isArray(mxRecords) && mxRecords.length > 0) {
    const records = [...mxRecords].sort((a, b) => a.priority - b.priority);
    if (records.length === 1 && records[0].exchange === '.') {
      return { accepts_mail: false, records: ['.'], primary: null, implicit_mx_record: false, reason: 'dns_null_mx' };
    }
    if (records.some(record => record.exchange === '.')) {
      return { accepts_mail: null, records: records.map(record => record.exchange), primary: null, implicit_mx_record: null, reason: 'dns_invalid_null_mx_rrset' };
    }
    return {
      accepts_mail: true,
      records: records.map(record => record.exchange),
      primary: records[0].exchange,
      implicit_mx_record: false,
      dns_ttl_seconds: records.every(record => Number.isFinite(record.ttl) && record.ttl > 0)
        ? Math.min(...records.map(record => record.ttl)) : null,
      reason: null,
    };
  }

  // RFC 5321 treats a successful empty MX answer as an implicit MX pointing to
  // the domain itself, but only when that host has an A or AAAA address.
  const resolveAddress = async resolveAddressImpl => {
    try {
      const addresses = await resolveWithTimeout(resolveAddressImpl, domain, options.dnsTimeoutMs || DNS_QUERY_TIMEOUT_MS, options.onDnsTimeout);
      return Array.isArray(addresses) && addresses.length > 0
        ? { kind: 'found', addresses }
        : { kind: 'no_data' };
    } catch (error) {
      if (error?.code === 'ENODATA') return { kind: 'no_data' };
      if (error?.code === 'ENOTFOUND') return { kind: 'nxdomain' };
      return { kind: 'temporary', code: typeof error?.code === 'string' ? error.code : 'unknown' };
    }
  };
  const [ipv4, ipv6] = await Promise.all([resolveAddress(resolve4Impl), resolveAddress(resolve6Impl)]);
  if (ipv4.kind === 'found' || ipv6.kind === 'found') {
    return {
      accepts_mail: true,
      records: [domain],
      primary: domain,
      implicit_mx_record: true,
      address_record_types: [ipv4.kind === 'found' ? 'A' : null, ipv6.kind === 'found' ? 'AAAA' : null].filter(Boolean),
      reason: null,
    };
  }

  const addressResults = [ipv4, ipv6];
  if (addressResults.every(result => result.kind === 'no_data')) {
    return { accepts_mail: false, records: [], primary: null, implicit_mx_record: false, reason: 'dns_no_mx_or_address_records' };
  }
  if (addressResults.every(result => result.kind === 'nxdomain')) {
    return { accepts_mail: false, records: [], primary: null, implicit_mx_record: false, reason: 'dns_domain_not_found' };
  }
  const details = addressResults.map(result => result.kind === 'temporary' ? result.code : result.kind).join(',');
  return { accepts_mail: null, records: [], primary: null, implicit_mx_record: null, reason: `dns_address_lookup_inconclusive:${details}` };
}

// ══════════════════════════════════════════════════════════════
//  3. DISPOSABLE & DISIFY LIVE VERIFICATION
// ══════════════════════════════════════════════════════════════

export function resetDisposableDomainCache() {
  _disifyDomainCache.clear();
  _disifyDomainPending.clear();
  _disifyCooldownUntil = 0;
  _disifyCooldownStatus = 'unavailable';
}

async function readDisifyJson(response) {
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function checkDisifyDomain(domain, { fetchImpl = fetch, enabled = isDisifyDomainCheckEnabled(), now = Date.now } = {}) {
  const normalizedDomain = typeof domain === 'string' ? domainToASCII(domain.trim()).toLowerCase() : '';
  const labels = normalizedDomain.split('.');
  if (normalizedDomain.length > 253 || labels.length < 2
    || labels.some(label => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return { status: 'invalid_domain', disposable: null };
  }
  domain = normalizedDomain;
  if (!enabled || CONSUMER_MAIL_DOMAINS.has(domain)) {
    return { status: enabled ? 'skipped_consumer_provider' : 'disabled', disposable: null };
  }
  // Reserved example/test domains can appear in synthetic jobs and must never
  // be disclosed to or classified by an external provider.
  if (/(?:^|\.)(?:test|invalid|example|localhost)$/.test(domain)
    || ['example.com', 'example.net', 'example.org'].includes(domain)) {
    return { status: 'skipped_special_use_domain', disposable: null };
  }
  const cached = _disifyDomainCache.get(domain);
  if (cached && now() < cached.expiresAt) return cached.result;
  if (now() < _disifyCooldownUntil) return { status: _disifyCooldownStatus, disposable: null };
  if (_disifyDomainPending.has(domain)) return _disifyDomainPending.get(domain);

  const pending = (async () => {
    let result = { status: 'unavailable', disposable: null };
    try {
      const response = await fetchImpl(`https://disify.com/api/domain/${encodeURIComponent(domain)}`, {
        method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      if (!response.redirected && response.ok) {
        const body = await readDisifyJson(response);
        if (body && !Array.isArray(body) && body.format === true
          && typeof body.domain === 'string' && body.domain.toLowerCase() === domain
          && typeof body.disposable === 'boolean') {
          result = { status: 'checked', disposable: body.disposable };
        }
      } else if ([401, 403, 429, 503].includes(response.status)) {
        const retrySeconds = Number(response.headers?.get?.('retry-after'));
        const defaultDelay = [401, 403].includes(response.status) ? 3600 : response.status === 429 ? 60 : 30;
        const delaySeconds = Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.max(defaultDelay, Math.min(retrySeconds, 3600)) : defaultDelay;
        _disifyCooldownUntil = Math.max(_disifyCooldownUntil, now() + delaySeconds * 1000);
        _disifyCooldownStatus = [401, 403].includes(response.status) ? 'configuration_error'
          : response.status === 429 ? 'rate_limited' : 'unavailable';
        result = { status: _disifyCooldownStatus, disposable: null };
      }
    } catch {
      _disifyCooldownUntil = Math.max(_disifyCooldownUntil, now() + 60_000);
      _disifyCooldownStatus = 'unavailable';
    }
    _disifyDomainCache.set(domain, {
      result, expiresAt: now() + (result.status === 'checked' ? DISIFY_DOMAIN_CACHE_MS : DISIFY_ERROR_CACHE_MS),
    });
    if (_disifyDomainCache.size > DISIFY_CACHE_MAX) {
      _disifyDomainCache.delete(_disifyDomainCache.keys().next().value);
    }
    return result;
  })();
  _disifyDomainPending.set(domain, pending);
  try { return await pending; }
  finally { if (_disifyDomainPending.get(domain) === pending) _disifyDomainPending.delete(domain); }
}

export async function checkDisifyAndDisposable(email, domain, rules = {}, options = {}) {
  const local = classifyEmailType({ domain, localPart: String(email || '').slice(0, String(email || '').lastIndexOf('@')),
    rolePrefixes: Array.isArray(rules.role_account_prefixes) ? rules.role_account_prefixes : [] });
  const external = local.is_disposable === true ? { status: 'skipped_local_match', disposable: null }
    : await checkDisifyDomain(domain, options);
  return { is_disposable: local.is_disposable === true || external.disposable === true
      ? true : local.is_disposable,
    is_role_account: local.is_role_account,
    disposableSource: external.status === 'checked' ? external.disposable ? 'disify_domain' : 'local_disposable_dataset_and_disify_domain' : 'local_disposable_dataset',
    disifyStatus: external.status, classification_evidence: local.classification_evidence };
}

// ══════════════════════════════════════════════════════════════
//  4. SMTP SOCKET PROBE (Port 25 Reachability)
// ══════════════════════════════════════════════════════════════

export async function probeSmtp(mxHost, toEmail, options = {}) {
  const {
    fromEmail = process.env.ODD_VERIFIER_FROM_EMAIL || null,
    ehloHostname = process.env.ODD_VERIFIER_EHLO_DOMAIN || null,
    timeoutMs: configuredTimeout = 3000,
    port = 25,
    connectImpl = (targetPort, host, family) => net.createConnection({ port: targetPort, host, family }),
    resolveAddressesImpl = host => (options.lookupImpl || dns.promises.lookup)(host, { all: true, verbatim: true }),
    addressPolicy = options.allowPrivateAddresses === true ? () => true : isPublicAddress,
  } = options;
  const unknown = (reason, stage = 'connect') => ({
    can_connect_smtp: false, is_deliverable: null, is_catch_all: null, stage, reason,
  });
  if (!mxHost) return unknown('no_mx_host');
  if (!fromEmail || !ehloHostname) return { ...unknown('smtp_probe_identity_not_configured', 'identity'), can_connect_smtp: null };
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(ehloHostname))
    return { ...unknown('smtp_probe_identity_invalid', 'identity'), can_connect_smtp: null };
  const recipient = validateSyntax(toEmail);
  const sender = validateSyntax(fromEmail);
  if (!recipient.is_valid_syntax || !sender.is_valid_syntax || recipient.requiresSmtpUtf8 || sender.requiresSmtpUtf8
    || /[\r\n]/.test(toEmail) || /[\r\n]/.test(fromEmail)) return unknown('smtp_invalid_envelope');
  const host = typeof mxHost === 'string' ? mxHost.replace(/\.$/, '').toLowerCase() : '';
  if (!host || /[\s\x00-\x1f]/.test(host)
    || (!net.isIP(host) && (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || /\.(?:local|localhost|internal)$/.test(host)))) {
    return unknown('smtp_destination_blocked');
  }
  const timeoutMs = Number.isFinite(Number(configuredTimeout))
    ? Math.min(30_000, Math.max(1, Math.floor(Number(configuredTimeout)))) : 3000;
  const deadline = Date.now() + timeoutMs;
  let resolutionTimer;
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([
      Promise.resolve().then(() => resolveAddressesImpl(host)),
      new Promise((_, reject) => { resolutionTimer = setTimeout(() => reject(Object.assign(new Error('DNS deadline'), { code: 'SMTP_DNS_TIMEOUT' })), timeoutMs); }),
    ]);
  } catch (error) {
    return unknown(error?.code === 'SMTP_DNS_TIMEOUT' ? 'smtp_timeout:resolve' : 'smtp_dns_unavailable', 'resolve');
  } finally {
    clearTimeout(resolutionTimer);
  }
  // Validate the whole answer, then connect to the literal address. Never resolve
  // the hostname again at connect time, including when DNS answers change.
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item || !net.isIP(item.address)
    || (item.family && item.family !== net.isIP(item.address)) || !addressPolicy(item.address))) return unknown('smtp_destination_blocked');
  if (Date.now() >= deadline) return unknown('smtp_timeout:resolve', 'resolve');
  const destination = addresses[0];
  return new Promise((resolve) => {
    let socket;
    try {
      socket = connectImpl(port, destination.address, net.isIP(destination.address));
    } catch (error) {
      return resolve({
        can_connect_smtp: false,
        is_deliverable: null,
        is_catch_all: null,
        stage: 'connect',
        reason: `smtp_connection_failed:${typeof error?.code === 'string' ? error.code : 'unknown'}`,
      });
    }

    const stages = ['greeting', 'ehlo', 'mail_from', 'rcpt_to'];
    let stageIndex = 0;
    let completed = false;
    let connected = false;
    let input = '';
    let multilineCode = null;
    let multilineLines = [];
    let multilineBytes = 0;
    const MAX_RESPONSE_BYTES = 16 * 1024;
    let totalTimer;

    const finish = (result, end = false) => {
      if (completed) return;
      completed = true;
      if (end && !socket.destroyed) {
        // Flush QUIT, then close both halves even if the peer withholds its FIN.
        // Keep the deadline armed in case the write itself stalls.
        socket.end(() => socket.destroy());
      } else {
        clearTimeout(totalTimer);
        if (!socket.destroyed) socket.destroy();
      }
      resolve(result);
    };

    const baseEvidence = (stage, code = null, response = '') => ({
      can_connect_smtp: connected,
      is_deliverable: null,
      is_catch_all: null,
      stage,
      code,
      raw_code: code,
      enhanced_code: response.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] || null,
      response: response.slice(0, 512),
    });

    const writeNextCommand = (code, response) => {
      const stage = stages[stageIndex];
      if (stage === 'greeting') {
        if (code !== 220) return finish({ ...baseEvidence(stage, code), reason: `smtp_unexpected_greeting:${code}` }, true);
        stageIndex++;
        socket.write(`EHLO ${ehloHostname}\r\n`);
        return;
      }
      if (stage === 'ehlo') {
        if (code !== 250) return finish({ ...baseEvidence(stage, code), reason: `smtp_ehlo_rejected:${code}` }, true);
        stageIndex++;
        socket.write(`MAIL FROM:<${sender.normalizedEmail}>\r\n`);
        return;
      }
      if (stage === 'mail_from') {
        if (code !== 250) return finish({ ...baseEvidence(stage, code), reason: `smtp_mail_from_rejected:${code}` }, true);
        stageIndex++;
        socket.write(`RCPT TO:<${recipient.normalizedEmail}>\r\n`);
        return;
      }

      const evidence = baseEvidence('rcpt_to', code, response);
      if (code >= 200 && code < 300) {
        evidence.recipient_accepted = true;
        evidence.reason = 'smtp_rcpt_accepted_not_mailbox_proof';
      } else if (code === 550 && /\b5\.1\.1\b/.test(evidence.response)) {
        evidence.is_deliverable = false;
        evidence.recipient_accepted = false;
        evidence.reason = 'smtp_recipient_address_rejected:5.1.1';
      } else {
        evidence.recipient_accepted = null;
        evidence.reason = code >= 400 && code < 500
          ? `smtp_temporary_rcpt_response:${code}`
          : `smtp_unclassified_rcpt_response:${code}`;
      }

      socket.write('QUIT\r\n');
      finish(evidence, true);
    };

    const onTimeout = () => {
      if (completed) { clearTimeout(totalTimer); socket.destroy(); return; }
      finish({
        ...baseEvidence(stages[stageIndex] || 'complete'),
        reason: `smtp_timeout:${stages[stageIndex] || 'complete'}`,
      });
    };
    const remainingMs = Math.max(1, deadline - Date.now());
    totalTimer = setTimeout(onTimeout, remainingMs);
    socket.setTimeout(remainingMs);
    socket.on('connect', () => { connected = true; });
    socket.on('timeout', onTimeout);
    socket.on('error', error => finish({
      ...baseEvidence(stages[stageIndex] || 'connect'),
      reason: `smtp_connection_failed:${typeof error?.code === 'string' ? error.code : 'unknown'}`,
    }));
    socket.on('close', () => {
      clearTimeout(totalTimer);
      if (!completed) finish({
        ...baseEvidence(stages[stageIndex] || 'complete'),
        reason: `smtp_connection_closed:${stages[stageIndex] || 'complete'}`,
      });
    });
    socket.on('data', data => {
      input += data.toString('utf8');
      if (Buffer.byteLength(input, 'utf8') > MAX_RESPONSE_BYTES) {
        finish({ ...baseEvidence(stages[stageIndex] || 'unknown'), reason: 'smtp_response_too_large' });
        return;
      }

      while (!completed) {
        const lineEnd = input.indexOf('\r\n');
        if (lineEnd < 0) break;
        const line = input.slice(0, lineEnd);
        input = input.slice(lineEnd + 2);
        const match = line.match(/^(\d{3})([- ])(.*)$/);
        if (!match) {
          finish({ ...baseEvidence(stages[stageIndex] || 'unknown'), reason: 'smtp_malformed_response_line' });
          break;
        }
        const code = Number(match[1]);
        multilineBytes += Buffer.byteLength(line, 'utf8') + 2;
        if (multilineBytes > MAX_RESPONSE_BYTES) {
          finish({ ...baseEvidence(stages[stageIndex] || 'unknown', code), reason: 'smtp_response_too_large' });
          break;
        }
        if (multilineCode !== null && code !== multilineCode) {
          finish({ ...baseEvidence(stages[stageIndex] || 'unknown', code), reason: 'smtp_multiline_code_mismatch' });
          break;
        }
        if (multilineCode === null) multilineCode = code;
        multilineLines.push(match[3]);
        if (match[2] === '-') continue;

        const response = multilineLines.join('\n');
        multilineCode = null;
        multilineLines = [];
        multilineBytes = 0;
        writeNextCommand(code, response);
        if (completed) break;
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  REACHER DOCKER BACKEND → ENTERPRISE AUDIT FORMAT CONVERTER
// ══════════════════════════════════════════════════════════════

export async function getReacherStatus(options = {}) {
  const mode = verifierMode(options.mode);
  const apiUrl = configuredReacherUrl(options.apiUrl);
  const reacher = await inspectReacher({ apiUrl, fetchImpl: options.fetchImpl || fetch, force: options.force === true });
  const up = reacher.reachable && reacher.apiValid === true;
  const metrics = getEmailVerifierDnsMetrics();
  return {
    mode,
    available: up,
    reacher,
    disposableDomainCheck: {
      enabled: isDisifyDomainCheckEnabled(),
      mode: 'domain_only',
      sendsFullAddress: false,
      cachedDomains: _disifyDomainCache.size,
    },
    dns: {
      resolverServers: metrics.resolverServers,
      cacheEntries: metrics.cacheEntries,
      cacheCapacity: DNS_CACHE_MAX_ENTRIES,
      lookups: metrics.lookups,
      cacheHits: metrics.cacheHits,
      coalesced: metrics.coalesced,
      temporaryFailures: metrics.temporaryFailures,
      queryTimeoutMs: DNS_QUERY_TIMEOUT_MS,
    },
    outboundSmtp: { tested: false, note: 'Outbound TCP 25 is not tested by this status check.' },
    engine: mode === 'reacher' && up ? 'reacher_api' : mode === 'smtp_if_permitted' ? 'local_dns_optional_smtp' : 'local_dns',
    note: mode === 'reacher' && up
      ? `The ${reacher.endpointSource === 'local_default' ? 'local default' : 'configured'} endpoint matches Reacher ${reacher.version}'s version and validation-error contract. Provider results remain unconfirmed mailbox evidence.`
      : mode === 'reacher'
        ? `Reacher was not validated at ${reacher.endpointSource === 'local_default' ? 'the local default endpoint' : 'the configured endpoint'}. Syntax and DNS evidence remain available; mailbox status stays unknown.`
        : mode === 'smtp_if_permitted'
          ? 'Syntax and DNS checks are enabled. SMTP recipient checks run only for eligible custom domains with a configured probe identity; RCPT acceptance is not mailbox confirmation.'
          : 'Syntax and DNS checks are enabled. Mailbox existence is not confirmed by these checks.',
  };
}

const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mail.com', 'protonmail.com',
  'proton.me', 'zoho.com', 'yandex.com', 'gmx.com', 'fastmail.com',
]);

const CONSUMER_PROVIDER_BY_DOMAIN = new Map([
  ['gmail.com', ['google', 'Google']], ['googlemail.com', ['google', 'Google']],
  ['yahoo.com', ['yahoo', 'Yahoo']], ['ymail.com', ['yahoo', 'Yahoo']],
  ['hotmail.com', ['microsoft', 'Microsoft']], ['outlook.com', ['microsoft', 'Microsoft']],
  ['live.com', ['microsoft', 'Microsoft']], ['msn.com', ['microsoft', 'Microsoft']],
  ['aol.com', ['aol', 'AOL']], ['icloud.com', ['apple', 'Apple']], ['me.com', ['apple', 'Apple']],
  ['mail.com', ['mail_com', 'mail.com']], ['protonmail.com', ['proton', 'Proton']],
  ['proton.me', ['proton', 'Proton']], ['zoho.com', ['zoho', 'Zoho']],
  ['yandex.com', ['yandex', 'Yandex']], ['gmx.com', ['gmx', 'GMX']],
  ['fastmail.com', ['fastmail', 'Fastmail']],
]);

export function detectMailProvider(domain, mxRecords = []) {
  const hosts = (Array.isArray(mxRecords) ? mxRecords : []).map(record =>
    (typeof record === 'string' ? record : record?.exchange || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  const normalizedDomain = String(domain || '').toLowerCase();
  let provider = CONSUMER_PROVIDER_BY_DOMAIN.get(normalizedDomain)?.[0] || 'other';
  if (provider === 'other' && hosts.some(host => host === 'aspmx.l.google.com' || host === 'gmail-smtp-in.l.google.com'
    || host === 'smtp.google.com' || /^alt\d+\.aspmx\.l\.google\.com$/.test(host) || host.endsWith('.googlemail.com'))) provider = 'google';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.mail.protection.outlook.com'))) provider = 'microsoft';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.yahoodns.net') || host.endsWith('.mail.yahoo.com'))) provider = 'yahoo';
  else if (provider === 'other' && hosts.some(host => /(^|\.)(zoho\.com|zoho\.eu|zohomail\.com)$/.test(host))) provider = 'zoho';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.protonmail.ch') || host.endsWith('.protonmail.com'))) provider = 'proton';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.messagingengine.com'))) provider = 'fastmail';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.pphosted.com') || host.endsWith('.ppe-hosted.com') || host.endsWith('.proofpoint.com'))) provider = 'proofpoint';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.mimecast.com'))) provider = 'mimecast';
  else if (provider === 'other' && hosts.some(host => host.endsWith('.barracudanetworks.com'))) provider = 'barracuda';
  const displayProvider = {
    google: 'Google', microsoft: 'Microsoft', yahoo: 'Yahoo', zoho: 'Zoho',
    proton: 'Proton', fastmail: 'Fastmail', aol: 'AOL', apple: 'Apple',
    mail_com: 'mail.com', yandex: 'Yandex', gmx: 'GMX', proofpoint: 'Proofpoint',
    mimecast: 'Mimecast', barracuda: 'Barracuda', other: 'Other',
  }[provider] || CONSUMER_PROVIDER_BY_DOMAIN.get(normalizedDomain)?.[1] || 'Other';
  const isConsumerDomain = CONSUMER_MAIL_DOMAINS.has(normalizedDomain);
  return {
    provider: displayProvider,
    providerKey: provider,
    isConsumerDomain,
    isProviderProbeUninformative: provider !== 'other' || isConsumerDomain,
  };
}

function dnsEvidenceStatus(mx) {
  if (mx?.accepts_mail === true) return 'mail_route_present';
  if (mx?.reason === 'dns_null_mx') return 'null_mx';
  if (mx?.reason === 'dns_domain_not_found') return 'nxdomain';
  if (mx?.accepts_mail === false) return 'no_route';
  if (/timeout|SERVFAIL|REFUSED|DNSSEC|dns_.*failed|inconclusive/i.test(String(mx?.reason || ''))) return 'temporary_failure';
  return 'unknown';
}

function smtpEvidenceStatus(smtp, engine = 'local_smtp_probe') {
  if (!smtp || smtp.stage === 'identity' || smtp.reason?.startsWith('not_attempted')) return 'not_attempted';
  if (smtp.reason === 'smtp_target_private_address_blocked') return 'private_target_blocked';
  if (smtp.recipient_accepted === true && engine === 'local_smtp_probe') return 'rcpt_accepted';
  if (engine === 'local_smtp_probe' && smtp.stage === 'rcpt_to' && smtp.raw_code === 550
    && smtp.enhanced_code === '5.1.1' && smtp.is_deliverable === false
    && smtp.reason === 'smtp_recipient_address_rejected:5.1.1') return 'explicit_recipient_rejected';
  if (engine === 'local_smtp_probe' && smtp.stage === 'rcpt_to' && Number(smtp.raw_code ?? smtp.code) >= 400
    && Number(smtp.raw_code ?? smtp.code) < 500) return 'temp_rejected';
  if (smtp.can_connect_smtp === false) return 'unavailable';
  if (/timeout|connection_failed|connection_closed/.test(smtp.reason || '')) return 'unavailable';
  return 'unknown';
}

function buildEvidence({ syntax, mx, provider, smtp, engine, roleAccount, disposable, suppressionStatus = 'not_checked', providerVerdict = null, disposableSource = null, disifyStatus = null }) {
  const smtpStatus = smtpEvidenceStatus(smtp, engine);
  const dnsStatus = dnsEvidenceStatus(mx);
  const mailboxStatus = smtpStatus === 'explicit_recipient_rejected' ? 'rejected'
    : syntax?.is_valid_syntax === true && dnsStatus === 'mail_route_present' ? 'unconfirmed' : 'unknown';
  const reason = engine === 'local_smtp_probe' ? smtp?.reason || mx?.reason || 'mailbox_unconfirmed'
    : engine === 'reacher_api' ? `reacher_${providerVerdict || 'unknown'}_is_not_mailbox_confirmation`
      : mx?.reason || 'mailbox_unconfirmed';
  const numericCode = engine === 'local_smtp_probe'
    ? Number.isInteger(smtp?.raw_code) ? smtp.raw_code : Number.isInteger(smtp?.code) ? smtp.code : null
    : null;
  const enhancedCode = engine === 'local_smtp_probe'
    ? typeof smtp?.enhanced_code === 'string' ? smtp.enhanced_code
      : typeof smtp?.response === 'string' ? smtp.response.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] || null : null
    : null;
  return {
    schema_version: 1,
    syntax_status: syntax?.is_valid_syntax === true ? 'valid' : syntax?.is_valid_syntax === false ? 'invalid' : 'unknown',
    dns_status: dnsStatus,
    provider: provider || 'unknown',
    smtp_status: smtpStatus,
    mailbox_status: mailboxStatus,
    disposable_status: disposable === true ? 'known_disposable' : disposable === false ? 'not_in_checked_list' : 'not_checked',
    disposable_evidence_source: engine === 'reacher_api' ? 'reacher' : disposableSource || 'local_known_domain_list',
    disposable_external_status: disifyStatus,
    role_account: typeof roleAccount === 'boolean' ? roleAccount : null,
    disposable: typeof disposable === 'boolean' ? disposable : null,
    suppression_status: suppressionStatus,
    evidence_source: engine === 'reacher_api' ? 'reacher' : 'system_dns_and_optional_smtp',
    verifier_engine: engine,
    checked_at: new Date().toISOString(),
    raw_code: numericCode,
    enhanced_code: enhancedCode,
    diagnostic_reason: reason,
    dns_diagnostics: mx?.diagnostics || null,
    retryable: smtpStatus === 'temp_rejected' || smtpStatus === 'unavailable' || dnsStatus === 'temporary_failure',
    provider_verdict: providerVerdict,
  };
}

export function buildAuditResult(email, raw, _rules = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const checkedSyntax = validateSyntax(email);
  const localType = classifyEmailType({ domain: checkedSyntax.domain, localPart: checkedSyntax.username, rolePrefixes: _rules.role_account_prefixes || [] });
  const parts = email.split('@');
  const username = parts[0] || '';
  const domain = (parts[1] || '').toLowerCase();
  const is_free = CONSUMER_MAIL_DOMAINS.has(domain);
  const is_disposable = r.misc?.is_disposable === true || localType.is_disposable === true
    ? true : typeof r.misc?.is_disposable === 'boolean' ? r.misc.is_disposable : localType.is_disposable;
  const is_role = r.misc?.is_role_account === true || localType.is_role_account === true
    ? true : typeof r.misc?.is_role_account === 'boolean' ? r.misc.is_role_account : localType.is_role_account;
  const is_catch_all = r.smtp?.is_catch_all === true ? true : r.smtp?.is_catch_all === false ? false : null;
  const mx = r.mx || { accepts_mail: null, records: [], reason: 'reacher_mx_missing' };
  const syntax = r.syntax || { is_valid_syntax: null };
  const mx_valid = mx.accepts_mail === true;
  const syntax_valid = syntax.is_valid_syntax === true;
  const mxRecords = Array.isArray(mx.records) ? mx.records : [];
  const mx_host = mxRecords[0]?.exchange || mxRecords[0] || null;
  const providerInfo = detectMailProvider(domain, mxRecords);
  const providerVerdict = ['safe', 'risky', 'invalid', 'unknown'].includes(r.is_reachable) ? r.is_reachable : 'unknown';
  const smtp = r.smtp || { can_connect_smtp: null, is_deliverable: null, reason: 'reacher_smtp_missing' };
  const code = typeof smtp.code === 'string' && /^[2-5]\d{2}$/.test(smtp.code) ? Number(smtp.code) : smtp.code;
  const positive = smtp.is_deliverable === true || smtp.recipient_accepted === true;
  const negative = smtp.is_deliverable === false || smtp.is_disabled === true;
  const contradictory = (smtp.code != null && (!Number.isInteger(code) || code < 200 || code > 599))
    || (positive && negative) || (positive && code != null && (code < 200 || code >= 300))
    || (negative && code != null && code >= 200 && code < 300);
  const usableProviderSmtp = smtp.can_connect_smtp !== false && !contradictory && !(code >= 400 && code < 500);
  const reasons = [];
  let status = 'unknown';
  let reasonLabel = 'Mailbox unconfirmed';
  if (syntax.is_valid_syntax === false) {
    status = 'undeliverable';
    reasonLabel = 'Invalid address format';
    reasons.push(syntax.reason || 'invalid_syntax');
  } else if (mx.accepts_mail === false) {
    status = 'undeliverable';
    reasonLabel = mx.reason === 'dns_null_mx' ? 'Domain explicitly accepts no mail' : 'No mail route found';
    reasons.push(mx.reason || 'no_mail_route');
  } else if (is_disposable) {
    status = 'risky';
    reasonLabel = 'Disposable domain';
    reasons.push('disposable_domain');
  } else {
    // Provider, syntax and MX signals do not establish that this mailbox exists.
    // Keep inconclusive results in Unknown; reserve Risky for explicit risk signals.
    const hasExplicitRisk = providerVerdict === 'risky' || is_role === true
      || is_catch_all === true || smtp.has_full_inbox === true
      || (smtp.is_disabled === true && usableProviderSmtp);
    status = hasExplicitRisk ? 'risky' : 'unknown';
    const smtpReason = providerInfo.providerKey !== 'other'
      ? 'provider_mailbox_existence_unconfirmed'
      : 'mailbox_unconfirmed';
    reasons.push(smtpReason);
    if (is_role) reasons.push('role_account_informational');
    if (providerVerdict === 'safe') reasons.push('reacher_safe_is_not_mailbox_confirmation');
    else if (providerVerdict === 'invalid') reasons.push('reacher_invalid_without_protocol_rejection_evidence');
    if (smtp.can_connect_smtp === false) reasons.push('smtp_connection_unavailable');
    reasonLabel = is_role && _rules.suppress_role_accounts ? 'Role account excluded by workspace policy'
      : is_role ? 'Role contact · mailbox unconfirmed'
      : providerInfo.providerKey !== 'other' ? `${providerInfo.provider} mail route · mailbox unconfirmed`
        : 'Domain accepts mail · mailbox unconfirmed';
  }

  const isValid = status === 'deliverable';
  const numDigits = (username.match(/\d/g) || []).length;
  const numLetters = (username.match(/[a-z]/gi) || []).length;
  const numUnicode = (username.match(/[^\x00-\x7F]/g) || []).length;
  const evidence = buildEvidence({ syntax, mx, provider: providerInfo.provider, smtp, engine: 'reacher_api', roleAccount: is_role, disposable: is_disposable, providerVerdict });

  return {
    email,
    valid: isValid,
    verification_status: status,
    engine: 'reacher_api',
    score: null,
    evidence: { mail_route: evidence.dns_status === 'mail_route_present' ? 'present' : evidence.dns_status, ...evidence },
    verification_evidence: evidence,
    general: {
      full_name: null, gender: null,
      state: status === 'undeliverable' ? 'Undeliverable' : status === 'risky' ? 'Risky' : 'Unconfirmed',
      reason: reasonLabel, domain,
    },
    attributes: {
      free: is_free,
      role: is_role,
      disposable: is_disposable,
      accept_all: is_catch_all,
      tag: username.includes('+'),
      numerical_characters: numDigits,
      alphabetical_characters: numLetters,
      unicode_symbols: numUnicode,
      mailbox_full: r.smtp?.has_full_inbox ?? null,
      no_reply: /noreply|no-reply|do-not-reply/i.test(username),
      secure_email_gateway: null,
    },
    mail_server: { smtp_provider: providerInfo.provider, mx_record: mx_host, implicit_mx_record: mx.implicit_mx_record ?? null },
    is_disposable,
    is_free_provider: is_free,
    is_role_account: is_role,
    is_catch_all,
    mx_host,
    classification_evidence: localType.classification_evidence,
    checks: { regex: syntax.is_valid_syntax ?? null, mx: mx.accepts_mail ?? null, disposable: is_disposable === null ? null : !is_disposable, smtp: null },
    reasons,
    reacher: r,
  };
}

function buildDnsGateResult(email, syntax, mx) {
  const hasNoMailRoute = mx.accepts_mail === false;
  const status = hasNoMailRoute ? 'undeliverable' : 'unknown';
  const reasonLabels = {
    dns_domain_not_found: 'Domain does not exist in DNS',
    dns_null_mx: 'Domain explicitly does not accept email',
    dns_no_mx_or_address_records: 'No mail route was found for this domain',
  };
  const reason = reasonLabels[mx.reason] || `DNS mail routing is inconclusive (${mx.reason || 'unknown_dns_result'})`;
  const providerInfo = detectMailProvider(syntax.domain, mx.records || []);
  const smtp = {
    can_connect_smtp: null,
    is_deliverable: null,
    recipient_accepted: null,
    reason: hasNoMailRoute ? 'not_attempted_no_mail_route' : 'not_attempted_dns_inconclusive',
  };
  const evidence = buildEvidence({ syntax, mx, provider: providerInfo.provider, smtp, engine: 'local_dns_gate', roleAccount: null, disposable: null });
  return {
    email,
    valid: false,
    verification_status: status,
    engine: 'local_dns_gate',
    verification_evidence: evidence,
    general: { full_name: null, gender: null, state: hasNoMailRoute ? 'Undeliverable' : 'Unknown', reason, domain: syntax.domain },
    attributes: {
      free: null,
      role: null,
      disposable: null,
      accept_all: null,
      tag: syntax.username.includes('+'),
      numerical_characters: (syntax.username.match(/\d/g) || []).length,
      alphabetical_characters: (syntax.username.match(/[a-z]/gi) || []).length,
      unicode_symbols: (syntax.username.match(/[^\x00-\x7F]/g) || []).length,
      mailbox_full: null,
      no_reply: /noreply|no-reply|do-not-reply/i.test(syntax.username),
      secure_email_gateway: null,
    },
    mail_server: { smtp_provider: providerInfo.provider, mx_record: mx.primary, implicit_mx_record: mx.implicit_mx_record },
    is_disposable: null,
    is_free_provider: null,
    is_role_account: null,
    is_catch_all: null,
    mx_host: mx.primary,
    checks: { regex: true, mx: mx.accepts_mail, disposable: null, smtp: null },
    reasons: [mx.reason || 'dns_mail_routing_inconclusive'],
    reacher: {
      input: email,
      is_reachable: hasNoMailRoute ? 'invalid' : 'unknown',
      syntax,
      mx,
      misc: { is_disposable: null, is_role_account: null },
      smtp,
    },
  };
}

export function isEmailSuppressed(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1').get(normalized));
}

export function buildSuppressedVerificationResult(email) {
  const value = String(email || '').trim();
  const syntax = validateSyntax(value);
  const mx = { accepts_mail: null, records: [], primary: null, implicit_mx_record: null, reason: 'not_checked_suppressed' };
  const smtp = { can_connect_smtp: null, is_deliverable: null, recipient_accepted: null, reason: 'not_attempted_suppressed' };
  const provider = 'unknown';
  const evidence = buildEvidence({ syntax, mx, provider, smtp, engine: 'local_policy_gate', roleAccount: null, disposable: null, suppressionStatus: 'suppressed' });
  evidence.diagnostic_reason = 'address_is_on_suppression_list';
  return {
    email: syntax.normalizedEmail || value,
    valid: false,
    verification_status: 'unknown',
    engine: 'local_policy_gate',
    verification_evidence: evidence,
    general: { full_name: null, gender: null, state: 'Not checked', reason: 'Not checked because this address is suppressed', domain: syntax.domain || null },
    attributes: { free: null, role: null, disposable: null, accept_all: null, tag: null, mailbox_full: null },
    mail_server: { smtp_provider: provider, mx_record: null, implicit_mx_record: null },
    is_disposable: null, is_free_provider: null, is_role_account: null, is_catch_all: null, mx_host: null,
    checks: { regex: syntax.is_valid_syntax, mx: null, disposable: null, smtp: null },
    reasons: ['suppressed_not_checked'],
    reacher: { input: syntax.normalizedEmail || value, is_reachable: 'unknown', syntax, mx, misc: { is_disposable: null, is_role_account: null }, smtp },
  };
}

export async function verifySingleEmail(email, options = {}) {
  if (isEmailSuppressed(email)) return buildSuppressedVerificationResult(email);
  return verifyEmail(email, options);
}

// ══════════════════════════════════════════════════════════════
//  MASTER EMAIL VERIFICATION (Reacher Docker → Local Fallback)
// ══════════════════════════════════════════════════════════════

export async function verifyEmail(email, options = {}) {
  const syntax = validateSyntax(email);
  const localType = syntax.is_valid_syntax ? classifyEmailType({ domain: syntax.domain, localPart: syntax.username,
    rolePrefixes: getRules().role_account_prefixes || [] }) : null;
  if (localType?.is_disposable === true) {
    const result = buildAuditResult(syntax.normalizedEmail, { syntax,
      mx: { accepts_mail: null, records: [], reason: 'not_checked_local_disposable_domain' },
      misc: { is_disposable: true, is_role_account: localType.is_role_account },
      smtp: { can_connect_smtp: null, is_deliverable: null, reason: 'not_attempted_local_disposable_domain_gate' } }, getRules());
    result.engine = 'local_disposable_domain_gate';
    result.verification_status = 'undeliverable';
    result.general.state = 'Undeliverable';
    result.general.reason = 'Disposable Domain';
    result.evidence.mailbox_status = 'unconfirmed';
    return result;
  }
  const result = await verifyEmailWithEvidence(email, options);
  if (localType) {
    result.classification_evidence = localType.classification_evidence;
    result.is_free_provider = localType.is_free_provider;
    // A pinned-list no-match is classification evidence, not a completed
    // disposable check. Preserve null from capability/DNS gates that did not
    // perform that check; a positive local match remains authoritative.
    result.is_disposable = result.is_disposable === true || localType.is_disposable === true
      ? true : result.is_disposable ?? null;
    result.is_role_account = result.is_role_account === true || localType.is_role_account === true;
    result.attributes = { ...result.attributes, free: result.is_free_provider, role: result.is_role_account, disposable: result.is_disposable };
  }
  result.score ??= null;
  if (result.verification_evidence) result.evidence = { mail_route: result.verification_evidence.dns_status === 'mail_route_present' ? 'present' : result.verification_evidence.dns_status, ...result.verification_evidence };
  return result;
}

async function verifyEmailWithEvidence(email, options = {}) {
  const {
    reacherFetchImpl = fetch,
    resolveMxImpl = dns.promises.resolveMx,
    resolve4Impl = dns.promises.resolve4,
    resolve6Impl = dns.promises.resolve6,
    checkDisifyImpl = checkDisifyAndDisposable,
    smtpProbeImpl = probeSmtp,
  } = options;
  const mode = verifierMode(options.mode);
  const suppliedEmail = typeof email === 'string' ? email : '';
  const rules = getRules();

  // Syntax normalization preserves the case-sensitive local part and converts only the domain.
  const syntax = validateSyntax(suppliedEmail);
  const cleanEmail = syntax.is_valid_syntax ? syntax.normalizedEmail : suppliedEmail.trim();
  if (!syntax.is_valid_syntax) {
    const mx = { accepts_mail: null, records: [], primary: null, implicit_mx_record: null, reason: 'not_checked_invalid_syntax' };
    const smtp = { can_connect_smtp: null, is_deliverable: null, recipient_accepted: null, reason: 'not_attempted_invalid_syntax' };
    const evidence = buildEvidence({ syntax, mx, provider: 'unknown', smtp, engine: 'local_syntax_gate', roleAccount: null, disposable: null });
    return {
      email: cleanEmail,
      valid: false,
      verification_status: 'undeliverable',
      engine: 'local_syntax_gate',
      verification_evidence: evidence,
      general: {
        full_name: null,
        gender: null,
        state: 'Undeliverable',
        reason: 'Invalid Syntax',
        domain: syntax.domain || (cleanEmail.split('@')[1] || ''),
      },
      attributes: {
        free: null,
        role: null,
        disposable: null,
        accept_all: null,
        tag: null,
        numerical_characters: 0,
        alphabetical_characters: 0,
        unicode_symbols: 0,
        mailbox_full: null,
        no_reply: null,
        secure_email_gateway: null,
      },
      mail_server: {
        smtp_provider: 'Unknown',
        mx_record: null,
        implicit_mx_record: null,
      },
      is_disposable: null,
      is_free_provider: null,
      is_role_account: null,
      is_catch_all: null,
      mx_host: null,
      checks: { regex: false, mx: null, disposable: null, smtp: null },
      reasons: [syntax.reason],
      reacher: {
        input: cleanEmail,
        is_reachable: 'invalid',
        syntax,
        mx: { accepts_mail: null, records: [], reason: 'not_checked_invalid_syntax' },
        misc: { is_disposable: null, is_role_account: null },
        smtp: { can_connect_smtp: null, is_deliverable: null, reason: 'not_attempted_invalid_syntax' },
      },
    };
  }

  // Until this service negotiates and verifies SMTPUTF8 end to end, valid
  // internationalized local-parts stay syntactically valid but unverified.
  if (syntax.requiresSmtpUtf8) {
    const mx = { accepts_mail: null, records: [], primary: null, implicit_mx_record: null, reason: 'not_checked_smtp_utf8_capability_unknown' };
    const smtp = { can_connect_smtp: null, is_deliverable: null, recipient_accepted: null, reason: 'not_attempted_smtp_utf8_capability_unknown' };
    const evidence = buildEvidence({ syntax, mx, provider: 'unknown', smtp, engine: 'smtp_utf8_capability_gate', roleAccount: null, disposable: null });
    evidence.diagnostic_reason = 'smtp_utf8_required_probe_unsupported';
    return {
      email: cleanEmail,
      valid: false,
      verification_status: 'unknown',
      engine: 'smtp_utf8_capability_gate',
      verification_evidence: evidence,
      general: { full_name: null, gender: null, state: 'Unknown', reason: 'SMTPUTF8 is required; verifier capability has not been established', domain: syntax.domain },
      attributes: { free: null, role: null, disposable: null, accept_all: null, tag: syntax.username.includes('+'),
        numerical_characters: (syntax.username.match(/\d/g) || []).length,
        alphabetical_characters: (syntax.username.match(/[a-z]/gi) || []).length,
        unicode_symbols: (syntax.username.match(/[^\x00-\x7F]/g) || []).length,
        mailbox_full: null, no_reply: /noreply|no-reply|do-not-reply/i.test(syntax.username), secure_email_gateway: null },
      mail_server: { smtp_provider: 'Unknown', mx_record: null, implicit_mx_record: null },
      is_disposable: null, is_free_provider: null, is_role_account: null, is_catch_all: null, mx_host: null,
      checks: { regex: true, mx: null, disposable: null, smtp: null },
      reasons: ['smtp_utf8_required_probe_unsupported'],
      reacher: { input: cleanEmail, is_reachable: 'unknown', syntax, mx,
        misc: { is_disposable: null, is_role_account: null }, smtp },
    };
  }

  // DNS evidence is collected first and survives a provider timeout or bad response.
  const mx = await checkMxRecords(syntax.domain, { resolveMxImpl, resolve4Impl, resolve6Impl });
  if (mx.accepts_mail !== true) return buildDnsGateResult(cleanEmail, syntax, mx);

  const providerInfo = detectMailProvider(syntax.domain, mx.records);
  const { is_disposable, is_role_account, disposableSource, disifyStatus } = await checkDisifyImpl(
    cleanEmail, syntax.domain, rules, options.disifyOptions || {},
  );
  if (is_disposable) {
    const smtp = { can_connect_smtp: null, is_deliverable: null, recipient_accepted: null, reason: 'not_attempted_disposable_domain_gate' };
    const evidence = buildEvidence({ syntax, mx, provider: providerInfo.provider, smtp, engine: 'local_dns_gate', roleAccount: is_role_account, disposable: true, disposableSource, disifyStatus });
    return {
      email: cleanEmail, valid: false, verification_status: 'risky', engine: 'local_dns_gate', verification_evidence: evidence,
      general: { full_name: null, gender: null, state: 'Risky', reason: 'Disposable domain', domain: syntax.domain },
      attributes: { free: CONSUMER_MAIL_DOMAINS.has(syntax.domain), role: is_role_account, disposable: true, accept_all: null,
        tag: syntax.username.includes('+'), numerical_characters: (syntax.username.match(/\d/g) || []).length,
        alphabetical_characters: (syntax.username.match(/[a-z]/gi) || []).length,
        unicode_symbols: (syntax.username.match(/[^\x00-\x7F]/g) || []).length, mailbox_full: null,
        no_reply: /noreply|no-reply|do-not-reply/i.test(syntax.username), secure_email_gateway: null },
      mail_server: { smtp_provider: providerInfo.provider, mx_record: mx.primary, implicit_mx_record: mx.implicit_mx_record },
      is_disposable: true, is_free_provider: CONSUMER_MAIL_DOMAINS.has(syntax.domain), is_role_account, is_catch_all: null,
      mx_host: mx.primary, checks: { regex: true, mx: true, disposable: false, smtp: null }, reasons: ['disposable_domain'],
      reacher: { input: cleanEmail, is_reachable: 'risky', syntax, mx, misc: { is_disposable: true, is_role_account }, smtp },
    };
  }

  // Reacher is the historical optional local engine. Probe its documented
  // contract before sending an address; keep major-provider verdicts as hints,
  // never mailbox confirmation. Direct SMTP probing remains separately gated.
  let reacherDiagnostic = null;
  if (mode === 'reacher') {
    const reacherUrl = configuredReacherUrl(options.reacherApiUrl);
    const reacherUp = (await inspectReacher({ apiUrl: reacherUrl, fetchImpl: reacherFetchImpl, force: options.reacherHealthForce === true })).apiValid === true;
    if (!reacherUp) {
      reacherDiagnostic = 'reacher_unavailable_or_wrong_service';
    } else {
      try {
        const response = await reacherFetchImpl(reacherUrl, {
          method: 'POST',
          headers: reacherIdentityHeaders(),
          body: JSON.stringify({ to_email: cleanEmail }),
          redirect: 'error',
          signal: AbortSignal.timeout(REACHER_TIMEOUT_MS),
        });
        if (response.redirected || !response.ok) {
          reacherDiagnostic = 'reacher_http_' + response.status;
        } else {
          const body = await response.json();
          if (isReacherResult(body, cleanEmail)) {
            // DNS and syntax from this verifier run remain the authoritative observations;
            // Reacher contributes provider/SMTP evidence only.
            const result = buildAuditResult(cleanEmail, { ...body, syntax, mx }, rules);
            result.verification_evidence.disposable_external_status = disifyStatus || null;
            return result;
          }
          reacherDiagnostic = 'reacher_invalid_response_schema';
        }
      } catch (error) {
        reacherDiagnostic = error?.name === 'TimeoutError' ? 'reacher_request_timeout' : 'reacher_request_failed';
      }
    }
  }

  const free = CONSUMER_MAIL_DOMAINS.has(syntax.domain);
  const smtpNotAttemptedReason = syntax.requiresSmtpUtf8
    ? 'not_attempted_smtp_utf8_capability_unknown'
    : providerInfo.isProviderProbeUninformative
      ? 'not_attempted_provider_probe_uninformative'
      : mode !== 'smtp_if_permitted'
        ? 'not_attempted_syntax_dns_mode'
        : 'not_attempted';
  let smtp = { can_connect_smtp: null, is_deliverable: null, recipient_accepted: null, reason: smtpNotAttemptedReason };
  let engine = 'local_dns';
  if (!syntax.requiresSmtpUtf8 && mode === 'smtp_if_permitted' && !providerInfo.isProviderProbeUninformative) {
    smtp = await smtpProbeImpl(mx.primary, cleanEmail, options.smtpProbeOptions || {});
    engine = smtp.stage === 'identity' ? 'local_dns' : 'local_smtp_probe';
  }

  const explicitRecipientRejection = engine === 'local_smtp_probe' && smtp.stage === 'rcpt_to'
    && smtp.raw_code === 550 && smtp.enhanced_code === '5.1.1'
    && smtp.is_deliverable === false && smtp.reason === 'smtp_recipient_address_rejected:5.1.1';
  const status = explicitRecipientRejection ? 'undeliverable' : is_role_account ? 'risky' : 'unknown';
  const reasonLabel = explicitRecipientRejection
    ? 'Recipient rejected by mail server'
    : syntax.requiresSmtpUtf8
      ? 'Domain accepts mail · SMTPUTF8 mailbox check unavailable'
      : is_role_account
        ? 'Role contact · mailbox unconfirmed'
        : providerInfo.isProviderProbeUninformative
          ? providerInfo.provider + ' mail route · mailbox unconfirmed'
          : 'Domain accepts mail · mailbox unconfirmed';
  const reasons = [];
  if (explicitRecipientRejection) reasons.push('smtp_recipient_address_rejected:5.1.1');
  else if (smtp.recipient_accepted === true) reasons.push('smtp_rcpt_accepted_not_mailbox_proof');
  else if (smtp.can_connect_smtp === false) reasons.push('smtp_connection_unavailable');
  else reasons.push(syntax.requiresSmtpUtf8 ? 'smtp_utf8_required_probe_unsupported' : 'deliverability_unconfirmed');
  if (is_role_account) reasons.push('role_account_informational');
  if (reacherDiagnostic) reasons.push(reacherDiagnostic);

  const username = syntax.username;
  const numDigits = (username.match(/\d/g) || []).length;
  const numLetters = (username.match(/[a-z]/gi) || []).length;
  const numUnicode = (username.match(/[^\x00-\x7F]/g) || []).length;
  const evidence = buildEvidence({ syntax, mx, provider: providerInfo.provider, smtp, engine, roleAccount: is_role_account, disposable: false, disposableSource, disifyStatus });
  if (reacherDiagnostic) evidence.diagnostic_reason = reacherDiagnostic;
  const checkSmtp = smtp.recipient_accepted === true ? true : explicitRecipientRejection ? false : null;

  return {
    email: cleanEmail,
    valid: false,
    verification_status: status,
    engine,
    verification_evidence: evidence,
    general: {
      full_name: null, gender: null,
      state: status === 'undeliverable' ? 'Undeliverable' : status === 'risky' ? 'Risky' : 'Unconfirmed',
      reason: reasonLabel, domain: syntax.domain,
    },
    attributes: {
      free,
      role: is_role_account,
      disposable: false,
      accept_all: null,
      tag: username.includes('+'),
      numerical_characters: numDigits,
      alphabetical_characters: numLetters,
      unicode_symbols: numUnicode,
      mailbox_full: null,
      no_reply: /noreply|no-reply|do-not-reply/i.test(username),
      secure_email_gateway: null,
    },
    mail_server: { smtp_provider: providerInfo.provider, mx_record: mx.primary, implicit_mx_record: mx.implicit_mx_record },
    is_disposable: false,
    is_free_provider: free,
    is_role_account,
    is_catch_all: null,
    mx_host: mx.primary,
    checks: { regex: true, mx: true, disposable: true, smtp: checkSmtp },
    reasons,
    reacher: {
      input: cleanEmail,
      is_reachable: status === 'undeliverable' ? 'invalid' : status === 'risky' ? 'risky' : 'unknown',
      syntax,
      mx,
      misc: { is_disposable: false, is_role_account },
      smtp,
      ...(reacherDiagnostic ? { provider_error: reacherDiagnostic } : {}),
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  BATCH VERIFICATION ENGINE
// ══════════════════════════════════════════════════════════════

export async function verifyBatch(batchId, options = {}) {
  const {
    dryRun = false,
    verifyEmailImpl = verifyEmail,
    sleepImpl = sleep,
    onProgress = null,
  } = options;
  const normalizedBatchId = Number(batchId);
  if (!Number.isSafeInteger(normalizedBatchId) || normalizedBatchId < 1) {
    const error = new Error('Batch id must be a positive integer.');
    error.statusCode = 400;
    throw error;
  }
  if (_state.active) {
    const error = new Error(`Verification job #${_state.jobId} is already running for batch #${_state.batchId}.`);
    error.statusCode = 409;
    throw error;
  }
  const rules = getRules();
  const db = getDb();
  if (!db.prepare('SELECT id FROM batches WHERE id=?').get(normalizedBatchId)) {
    const error = new Error('Batch not found.');
    error.statusCode = 404;
    throw error;
  }

  // Verify the saved email records themselves. A contact may have several
  // addresses, may have an address only in lead_emails, or may still use the
  // legacy leads.email field. Never let one address overwrite another one's
  // primary flag or contact lifecycle status.
  const targets = db.prepare(`
    SELECT le.id AS email_row_id, le.lead_id, le.email, trim(le.email) AS check_email, le.is_primary, 0 AS legacy_address
    FROM lead_emails le JOIN leads l ON l.id=le.lead_id
    WHERE l.batch_id=? AND trim(le.email)!=''
    UNION ALL
    SELECT NULL AS email_row_id, l.id AS lead_id, l.email, trim(l.email) AS check_email,
      CASE WHEN EXISTS(SELECT 1 FROM lead_emails p WHERE p.lead_id=l.id AND p.is_primary=1) THEN 0 ELSE 1 END AS is_primary,
      1 AS legacy_address
    FROM leads l
    WHERE l.batch_id=? AND l.email IS NOT NULL AND trim(l.email)!=''
      AND NOT EXISTS(SELECT 1 FROM lead_emails le WHERE le.lead_id=l.id AND lower(trim(le.email))=lower(trim(l.email)))
    ORDER BY lead_id, is_primary DESC, email_row_id
  `).all(normalizedBatchId, normalizedBatchId);

  let jobId;
  try {
    jobId = db.transaction(() => {
      const activeJob = db.prepare(`SELECT id,batch_id FROM verification_jobs WHERE status IN (${ACTIVE_JOB_STATUSES.map(() => '?').join(',')}) LIMIT 1`).get(...ACTIVE_JOB_STATUSES);
      if (activeJob) {
        const error = new Error(`Verification job #${activeJob.id} is already running for batch #${activeJob.batch_id}.`);
        error.statusCode = 409;
        throw error;
      }
      const result = db.prepare(`INSERT INTO verification_jobs(batch_id,status,total,started_at) VALUES (?,'queued',?,datetime('now'))`)
        .run(normalizedBatchId, targets.length);
      const id = Number(result.lastInsertRowid);
      db.prepare("UPDATE verification_jobs SET status='running',updated_at=datetime('now') WHERE id=?").run(id);
      return id;
    })();
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const conflict = new Error('Another verification job is already active.');
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }

  _state = {
    active: true,
    jobId,
    batchId: normalizedBatchId,
    total: targets.length,
    processed: 0,
    deliverable: 0,
    risky: 0,
    unknown: 0,
    undeliverable: 0,
    suppressed: 0,
    currentEmail: null,
    cancelling: false,
    startedAt: new Date().toISOString(),
  };

  let deliverable = 0;
  let risky = 0;
  let unknown = 0;
  let undeliverable = 0;
  let suppressed = 0;
  const checkSuppression = db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=lower(trim(?)) LIMIT 1');

  try {
    for (const target of targets) {
      const jobStatus = db.prepare('SELECT status FROM verification_jobs WHERE id=?').get(jobId)?.status;
      if (_state.cancelling || jobStatus === 'cancel_requested' || !ACTIVE_JOB_STATUSES.includes(jobStatus)) break;
      _state.currentEmail = target.check_email;
      db.prepare(`UPDATE verification_jobs SET current_lead_id=?,current_email=?,current_email_row_id=?,updated_at=datetime('now')
        WHERE id=? AND status='running'`).run(target.lead_id, target.check_email, target.email_row_id, jobId);

      if (checkSuppression.get(target.check_email)) {
        db.transaction(() => {
          if (!dryRun && !target.email_row_id) {
            db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,is_primary)
              VALUES (?,?,'unknown',?)`).run(target.lead_id, target.email, target.is_primary === 1 ? 1 : 0);
          }
          db.prepare(`UPDATE verification_jobs SET processed=processed+1,suppressed=suppressed+1,
            current_lead_id=NULL,current_email=NULL,current_email_row_id=NULL,updated_at=datetime('now')
            WHERE id=? AND status IN ('running','cancel_requested')`).run(jobId);
        })();
        suppressed++;
        _state.processed++;
        _state.suppressed = suppressed;
        _state.currentEmail = null;
        await sleepImpl(rules.delay_between_emails_ms || 200);
        continue;
      }

      const res = await verifyEmailImpl(target.check_email);
      const classification = ['deliverable', 'risky', 'unknown', 'undeliverable'].includes(res.verification_status)
        ? res.verification_status : 'unknown';

      db.transaction(() => {
        if (!dryRun) {
          saveVerificationResult(db, target.lead_id, target.email, res, {
            rowId: target.email_row_id,
            primary: target.email_row_id ? false : target.is_primary === 1,
          });
        }
        db.prepare(`UPDATE verification_jobs SET processed=processed+1,
          deliverable=deliverable+?,risky=risky+?,unknown=unknown+?,undeliverable=undeliverable+?,
          current_lead_id=NULL,current_email=NULL,current_email_row_id=NULL,updated_at=datetime('now')
          WHERE id=? AND status IN ('running','cancel_requested')`)
          .run(classification === 'deliverable' ? 1 : 0, classification === 'risky' ? 1 : 0, classification === 'unknown' ? 1 : 0,
            classification === 'undeliverable' ? 1 : 0, jobId);
      })();

      if (classification === 'deliverable') deliverable++;
      else if (classification === 'risky') risky++;
      else if (classification === 'unknown') unknown++;
      else undeliverable++;
      _state.processed++;
      _state.deliverable = deliverable;
      _state.risky = risky;
      _state.unknown = unknown;
      _state.undeliverable = undeliverable;
      _state.currentEmail = null;
      if (typeof onProgress === 'function') onProgress({ ..._state });
      await sleepImpl(rules.delay_between_emails_ms || 200);
    }

    const current = db.prepare('SELECT status FROM verification_jobs WHERE id=?').get(jobId)?.status;
    const finalStatus = current === 'cancel_requested' || _state.cancelling ? 'cancelled' : 'completed';
    db.prepare(`UPDATE verification_jobs SET status=?,current_lead_id=NULL,current_email=NULL,current_email_row_id=NULL,
      updated_at=datetime('now'),completed_at=datetime('now')
      WHERE id=? AND status IN ('running','cancel_requested')`).run(finalStatus, jobId);
    return {
      jobId,
      batchId: normalizedBatchId,
      status: finalStatus,
      total: targets.length,
      processed: _state.processed,
      deliverable,
      risky,
      unknown,
      undeliverable,
      suppressed,
    };
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code.slice(0, 80) : 'verification_failed';
    const message = typeof error.message === 'string' ? error.message.slice(0, 500) : 'Verification failed.';
    db.prepare(`UPDATE verification_jobs SET status='failed',error_code=?,error_message=?,current_lead_id=NULL,
      current_email=NULL,current_email_row_id=NULL,
      updated_at=datetime('now'),completed_at=datetime('now') WHERE id=? AND status IN ('running','cancel_requested')`)
      .run(code, message, jobId);
    throw error;
  } finally {
    _state.active = false;
    _state.cancelling = false;
    _state.currentEmail = null;
  }
}

export function cancelVerification(batchIdValue = null) {
  const db = getDb();
  const batchId = batchIdValue === null || batchIdValue === undefined ? null : Number(batchIdValue);
  const activeJob = batchId === null
    ? db.prepare(`SELECT id,batch_id,status FROM verification_jobs WHERE status IN (${ACTIVE_JOB_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(...ACTIVE_JOB_STATUSES)
    : db.prepare(`SELECT id,batch_id,status FROM verification_jobs WHERE batch_id=? AND status IN (${ACTIVE_JOB_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(batchId, ...ACTIVE_JOB_STATUSES);
  if (!activeJob) return { jobId: null, batchId, cancelling: false, changed: false };
  const changed = db.prepare(`UPDATE verification_jobs SET status='cancel_requested',cancel_requested_at=datetime('now'),updated_at=datetime('now')
    WHERE id=? AND status IN ('queued','running')`).run(activeJob.id).changes > 0;
  if (Number(_state.jobId) === Number(activeJob.id)) _state.cancelling = true;
  return { jobId: activeJob.id, batchId: activeJob.batch_id, status: 'cancel_requested', cancelling: true, changed };
}

export function getVerificationResults(batchId, options = {}) {
  const { status, limit = 100, offset = 0 } = options;
  const db = getDb();

  const query = `
    SELECT le.*, l.business_name, l.batch_id
    FROM lead_emails le
    JOIN leads l ON le.lead_id = l.id
    WHERE l.batch_id = ?
  `;
  let total;
  let rows;
  if (status) {
    // Filter after applying the read-only legacy projection so Unknown and Risky tabs agree with evidence.
    rows = [];
    total = 0;
    for (const stored of db.prepare(`${query} ORDER BY le.id DESC`).iterate(batchId)) {
      const projected = projectStoredVerificationResult(stored);
      if (projected.verification_status !== status) continue;
      if (total >= offset && rows.length < limit) rows.push(projected);
      total++;
    }
  } else {
    total = db.prepare('SELECT COUNT(*) AS total FROM lead_emails le JOIN leads l ON le.lead_id=l.id WHERE l.batch_id=?').get(batchId)?.total || 0;
    rows = db.prepare(`${query} ORDER BY le.id DESC LIMIT ? OFFSET ?`).all(batchId, limit, offset)
      .map(projectStoredVerificationResult);
  }

  const results = rows.map(row => ({
    ...row,
    // Older verifier runs could store guessed fallback numbers in this column.
    // The JSON evidence is authoritative: if it did not include a score, expose none.
    confidence_score: scoreFromVerifierEvidence(row.verification_json),
  }));
  return { results, total, limit, offset };
}

function parseStoredVerificationResult(serialized) {
  try {
    const parsed = JSON.parse(serialized || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function projectStoredVerificationResult(row) {
  const saved = parseStoredVerificationResult(row.verification_json);
  const evidence = saved.verification_evidence && typeof saved.verification_evidence === 'object'
    ? saved.verification_evidence : null;
  const classification = deriveVerificationClassification(row.verification_status, {
    ...saved,
    is_catch_all: row.is_catch_all ?? saved.is_catch_all,
    is_disposable: row.is_disposable ?? saved.is_disposable,
    is_free_provider: row.is_free_provider ?? saved.is_free_provider,
    is_role_account: row.is_role_account ?? saved.is_role_account,
    verification_evidence: evidence,
  });
  return {
    ...row,
    stored_verification_status: row.verification_status,
    verification_status: classification.status,
    classification_adjustment: classification.adjustment,
  };
}

function normalizeVerifierScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value)
    : null;
}

function scoreFromVerifierEvidence(serializedEvidence) {
  try {
    return normalizeVerifierScore(JSON.parse(serializedEvidence || '{}')?.score);
  } catch {
    return null;
  }
}

const VERIFICATION_STATUSES = new Set(['deliverable', 'risky', 'undeliverable', 'unknown']);

function verificationExportError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function getVerificationExport(batchValue, { status } = {}) {
  const batchId = Number(batchValue);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw verificationExportError('Batch id must be a positive integer.');
  if (status !== undefined && !VERIFICATION_STATUSES.has(status)) throw verificationExportError('status must be deliverable, risky, undeliverable, or unknown.');
  const db = getDb();
  const batch = db.prepare('SELECT id,name FROM batches WHERE id=?').get(batchId);
  if (!batch) return null;
  const rows = db.prepare(`
    SELECT le.id AS email_id, le.lead_id AS contact_id, le.email,
      le.verification_status, le.verified_at, le.mx_host, le.verification_json,
      le.is_catch_all, le.is_disposable, le.is_free_provider, le.is_role_account,
      l.business_name
    FROM lead_emails le JOIN leads l ON l.id=le.lead_id
    WHERE l.batch_id=?
    ORDER BY l.id, le.is_primary DESC, le.id
  `).iterate(batchId);
  function* projectedRows() {
    for (const row of rows) {
      const projected = projectStoredVerificationResult(row);
      if (status !== undefined && projected.verification_status !== status) continue;
      yield projected;
    }
  }
  return { batch, status: status ?? null, rows: projectedRows() };
}

export function formatVerificationCsvRow(row) {
  let evidence = {};
  try { const parsed = JSON.parse(row.verification_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) evidence = parsed;
  } catch { /* malformed legacy evidence remains blank */ }
  const checks = evidence.checks && typeof evidence.checks === 'object' && !Array.isArray(evidence.checks) ? { ...evidence.checks } : {};
  if (evidence.classification_evidence && typeof evidence.classification_evidence === 'object') checks.classification_evidence = evidence.classification_evidence;
  const verificationEvidence = evidence.verification_evidence && typeof evidence.verification_evidence === 'object' ? evidence.verification_evidence : {};
  const fields = [
    row.contact_id, row.email_id, row.business_name, row.email, row.verification_status || 'unknown',
    row.verified_at, row.mx_host, evidence.engine, Object.keys(checks).length ? JSON.stringify(checks) : '',
    Array.isArray(evidence.reasons) ? JSON.stringify(evidence.reasons) : typeof evidence.reason === 'string' ? evidence.reason : '',
    verificationEvidence.syntax_status, verificationEvidence.dns_status, verificationEvidence.provider,
    verificationEvidence.provider_verdict, verificationEvidence.smtp_status, verificationEvidence.mailbox_status,
    verificationEvidence.suppression_status, verificationEvidence.checked_at, verificationEvidence.diagnostic_reason,
  ];
  return fields.map(csvCell).join(',') + '\r\n';
}

function csvCell(value) {
  let cell = String(value ?? '');
  if (/^[\u0000-\u0020]*[=+@-]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}
function saveVerificationResult(db, leadId, email, res, { rowId = null, primary = false } = {}) {
  const existingId = rowId ?? db.prepare(`
    SELECT id FROM lead_emails
    WHERE lead_id = ? AND lower(trim(email)) = lower(trim(?))
    ORDER BY id DESC LIMIT 1
  `).get(leadId, email)?.id;

  const confidenceScore = normalizeVerifierScore(res.score);
  const values = [
    res.verification_status,
    confidenceScore,
    res.is_catch_all ? 1 : 0,
    res.is_role_account ? 1 : 0,
    res.is_free_provider ? 1 : 0,
    res.is_disposable === true ? 1 : res.is_disposable === false ? 0 : null,
    res.mx_host ?? null,
    JSON.stringify(res),
  ];

  if (primary) {
    db.prepare('UPDATE lead_emails SET is_primary = 0 WHERE lead_id = ?').run(leadId);
  }

  if (existingId) {
    // Preserve any legacy/current audit before replacing the summary. A versioned
    // migration backfills existing audits; this also covers rows added after startup.
    db.prepare(`INSERT INTO email_verification_history(email_id,email,verification_status,verification_json,verified_at)
      SELECT id,email,verification_status,verification_json,verified_at FROM lead_emails le
      WHERE id=? AND verification_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM email_verification_history h WHERE h.email_id=le.id
          AND h.verification_json=le.verification_json AND h.verified_at IS le.verified_at
      )`).run(existingId);
    db.prepare(`
      UPDATE lead_emails SET
        email = ?, verification_status = ?, confidence_score = ?,
        is_catch_all = ?, is_role_account = ?, is_free_provider = ?, is_disposable = ?,
        mx_host = ?, verification_json = ?, verified_at = datetime('now'),
        is_primary = CASE WHEN ? THEN 1 ELSE is_primary END
      WHERE id = ?
    `).run(email, ...values, primary ? 1 : 0, existingId);
    recordVerificationHistory(db, existingId);
    return existingId;
  }

  const result = db.prepare(`
    INSERT INTO lead_emails (
      lead_id, email, is_primary, verification_status, confidence_score,
      is_catch_all, is_role_account, is_free_provider, is_disposable,
      mx_host, verification_json, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(leadId, email, primary ? 1 : 0, ...values);
  const id = Number(result.lastInsertRowid);
  recordVerificationHistory(db, id);
  return id;
}

function recordVerificationHistory(db, emailId) {
  db.prepare(`INSERT INTO email_verification_history(email_id,email,verification_status,verification_json,verified_at)
    SELECT id,email,verification_status,verification_json,verified_at FROM lead_emails WHERE id=?`).run(emailId);
}

export function getVerificationHistory(idValue, { before, limit = 25 } = {}) {
  const id = Number(idValue);
  const cursor = before === undefined ? null : Number(before);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100
    || (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1))) {
    const error = new Error('Invalid verification history id, cursor or limit.');
    error.statusCode = 400;
    throw error;
  }
  const db = getDb();
  const contact = db.prepare('SELECT id,lead_id,email,source FROM lead_emails WHERE id=?').get(id);
  if (!contact) { const error = new Error('Email record not found.'); error.statusCode = 404; throw error; }
  const rows = db.prepare(`SELECT * FROM email_verification_history WHERE email_id=? ${cursor === null ? '' : 'AND id<?'}
    ORDER BY id DESC LIMIT ?`).all(...(cursor === null ? [id, Number(limit) + 1] : [id, cursor, Number(limit) + 1]));
  const more = rows.length > Number(limit);
  const results = rows.slice(0, Number(limit)).map(row => {
    let result = null;
    try { result = JSON.parse(row.verification_json); } catch { /* Keep malformed legacy audits unchanged in storage. */ }
    return { ...row, result };
  });
  return { contact, results, nextCursor: more ? results.at(-1).id : null };
}

export async function reverifyEmailById(id, options = {}) {
  const { verifyEmailImpl = verifyEmail } = options;
  const db = getDb();
  const row = db.prepare('SELECT * FROM lead_emails WHERE id = ?').get(id);
  if (!row) throw new Error(`Lead email #${id} not found`);

  if (isEmailSuppressed(row.email)) return buildSuppressedVerificationResult(row.email);

  const res = await verifyEmailImpl(row.email);
  db.transaction(() => saveVerificationResult(db, row.lead_id, row.email, res, { rowId: row.id }))();

  return res;
}

export function getVerificationDistribution(batchId = null) {
  const db = getDb();
  const rows = batchId
    ? db.prepare(`SELECT le.verification_status, le.verification_json, le.is_catch_all, le.is_disposable,
          le.is_free_provider, le.is_role_account
        FROM lead_emails le JOIN leads l ON le.lead_id=l.id WHERE l.batch_id=?`).iterate(batchId)
    : db.prepare(`SELECT verification_status, verification_json, is_catch_all, is_disposable,
          is_free_provider, is_role_account FROM lead_emails`).iterate();
  const counts = new Map();
  for (const row of rows) {
    const { verification_status: currentStatus } = projectStoredVerificationResult(row);
    counts.set(currentStatus, (counts.get(currentStatus) || 0) + 1);
  }
  return ['deliverable', 'risky', 'undeliverable', 'unknown']
    .filter(currentStatus => counts.has(currentStatus))
    .map(currentStatus => ({ verification_status: currentStatus, count: counts.get(currentStatus) }));
}

export function getVerificationEvidenceDistribution(batchIdValue = null) {
  const db = getDb();
  const batchId = batchIdValue === null || batchIdValue === undefined || batchIdValue === '' ? null : Number(batchIdValue);
  if (batchId !== null && (!Number.isSafeInteger(batchId) || batchId < 1)) {
    const error = new Error('Batch id must be a positive integer.');
    error.statusCode = 400;
    throw error;
  }
  const rows = db.prepare(`
    SELECT le.verification_json,
      EXISTS(SELECT 1 FROM lead_email_source_evidence e WHERE e.lead_email_id=le.id) AS source_backed,
      EXISTS(SELECT 1 FROM suppression_list s WHERE lower(trim(s.email))=lower(trim(le.email))) AS suppressed
    FROM lead_emails le JOIN leads l ON l.id=le.lead_id
    WHERE (? IS NULL OR l.batch_id=?)
  `).all(batchId, batchId);
  const counts = {
    emailRecords: rows.length,
    sourceBacked: 0,
    suppressed: 0,
    syntaxValid: 0,
    syntaxInvalid: 0,
    mailRoutePresent: 0,
    noMailRoute: 0,
    nullMx: 0,
    temporaryDnsFailures: 0,
    providerSignals: 0,
    smtpRecipientAccepted: 0,
    smtpExplicitRecipientRejected: 0,
    smtpTemporaryOrUnavailable: 0,
    smtpSafetyBlocked: 0,
    mailboxConfirmed: 0,
    mailboxUnconfirmed: 0,
    mailboxRejected: 0,
    mailboxUnknown: 0,
  };
  for (const row of rows) {
    if (row.source_backed) counts.sourceBacked++;
    if (row.suppressed) counts.suppressed++;
    let evidence;
    try { evidence = JSON.parse(row.verification_json || '{}').verification_evidence; } catch { evidence = null; }
    if (!evidence || typeof evidence !== 'object') { counts.mailboxUnknown++; continue; }
    if (evidence.syntax_status === 'valid') counts.syntaxValid++;
    else if (evidence.syntax_status === 'invalid') counts.syntaxInvalid++;
    if (evidence.dns_status === 'mail_route_present') counts.mailRoutePresent++;
    else if (evidence.dns_status === 'no_route' || evidence.dns_status === 'nxdomain') counts.noMailRoute++;
    else if (evidence.dns_status === 'null_mx') counts.nullMx++;
    else if (evidence.dns_status === 'temporary_failure') counts.temporaryDnsFailures++;
    if (typeof evidence.provider === 'string' && !['other', 'unknown'].includes(evidence.provider.toLowerCase())) counts.providerSignals++;
    if (evidence.smtp_status === 'rcpt_accepted') counts.smtpRecipientAccepted++;
    else if (evidence.smtp_status === 'explicit_recipient_rejected') counts.smtpExplicitRecipientRejected++;
    else if (evidence.smtp_status === 'private_target_blocked') counts.smtpSafetyBlocked++;
    else if (['temp_rejected', 'unavailable'].includes(evidence.smtp_status)) counts.smtpTemporaryOrUnavailable++;
    if (evidence.mailbox_status === 'confirmed') counts.mailboxConfirmed++;
    else if (evidence.mailbox_status === 'unconfirmed') counts.mailboxUnconfirmed++;
    else if (evidence.mailbox_status === 'rejected') counts.mailboxRejected++;
    else counts.mailboxUnknown++;
  }
  return {
    batchId,
    counts,
    mailboxConfirmationPolicy: 'Only explicit mailbox confirmation evidence counts as confirmed. DNS routing, provider labels and SMTP recipient acceptance do not.',
  };
}
