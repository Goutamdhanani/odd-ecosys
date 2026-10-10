// ============================================================
//  ODD-ECOSYS Pipeline — Sending Engine (Phase 6)
//  Mailbox rotation, warmup management, daily limits,
//  send scheduling with jitter, health scoring,
//  suppression pre-check, auto-pause on threshold breach,
//  real DNS resolution (SPF/DMARC/MX/DNSBL), real SMTP transport (Nodemailer),
//  and test email transmission.
// ============================================================

import fs from 'fs';
import path from 'path';
import dns from 'dns';
import { createHash, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII, fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { getDb } from './database.js';
import { buildComplianceEnvelope, getComplianceReadiness } from './compliance.js';
import { getSendWindowState, isWithinSendWindow, nextAllowedSendTime } from './sending-schedule.js';
import { CampaignAudienceError, getAllCampaignAudienceRecipients, getCampaignRecipientPolicy, getQueueEligibleCampaignRecipients } from './campaign-audience.js';
import { previewCampaignStep, selectCampaignStepVariant } from './campaign-sequence.js';
import { decryptCredential, encryptCredential, getCredentialVaultStatus, hasActiveCredentialKey } from './credential-vault.js';

const dnsPromises = dns.promises;
const DNSBL_ZONES = [
  'zen.spamhaus.org',
  'b.barracudacentral.org',
  'dnsbl.sorbs.net',
];
const MAX_DNSBL_DOMAIN_ADDRESSES = 8;

function classifyDnsblResponse(blocklist, addresses) {
  const responseCodes = [...new Set(addresses.map(String))];
  const spamhausErrors = {
    '127.255.255.252': 'DNSBL_QUERY_NAME_TYPO',
    '127.255.255.254': 'DNSBL_QUERY_NOT_PERMITTED',
    '127.255.255.255': 'DNSBL_RATE_LIMITED',
  };

  if (blocklist === 'zen.spamhaus.org') {
    const errorCode = responseCodes.find(code => spamhausErrors[code]);
    if (errorCode) return { outcome: 'unavailable', error: spamhausErrors[errorCode], response_codes: responseCodes };
    if (responseCodes.length && responseCodes.every(code => code === '127.0.0.1')) {
      return { outcome: 'not_listed', response_codes: responseCodes };
    }

    // Spamhaus Zen documents these 127.0.0.x values as listing categories.
    // Unknown 127/8 answers are not promoted to a listing without documented evidence.
    const knownListingCodes = new Set([
      '127.0.0.2', '127.0.0.3', '127.0.0.4',
      '127.0.0.9', '127.0.0.10', '127.0.0.11',
    ]);
    if (responseCodes.length && responseCodes.every(code => knownListingCodes.has(code))) {
      return { outcome: 'listed', response_codes: responseCodes };
    }
    return { outcome: 'unavailable', error: 'DNSBL_UNEXPECTED_RESPONSE', response_codes: responseCodes };
  }

  if (responseCodes.length && responseCodes.every(code => isIP(code) === 4 && code.startsWith('127.'))) {
    return { outcome: 'listed', response_codes: responseCodes };
  }
  return { outcome: 'unavailable', error: 'DNSBL_UNEXPECTED_RESPONSE', response_codes: responseCodes };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'sending-engine.json');
let _config = null;
function getConfig() {
  if (!_config) {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    for (const [name, key] of [
      ['ODD_SEND_MAX_DAILY_PER_MAILBOX', 'max_daily_per_mailbox'],
      ['ODD_SEND_MAX_DAILY_PER_DOMAIN', 'max_daily_per_domain'],
    ]) {
      if (process.env[name] === undefined) continue;
      const value = Number(process.env[name]);
      if (!Number.isSafeInteger(value) || value < 0 || value > 100000) {
        throw new Error(`${name} must be an integer between 0 and 100000.`);
      }
      _config[key] = value;
    }
    if (process.env.NODE_ENV === 'test' && process.env.ODD_SEND_TEST_PACING_MS !== undefined) {
      const value = Number(process.env.ODD_SEND_TEST_PACING_MS);
      if (!Number.isSafeInteger(value) || value < 0 || value > 3600000) {
        throw new Error('ODD_SEND_TEST_PACING_MS must be an integer between 0 and 3600000.');
      }
      _config.jitter_ms = { min: value, max: value };
    }
    const schedule = { ..._config.send_window };
    if (process.env.ODD_SEND_WINDOW_TIMEZONE) schedule.timezone = process.env.ODD_SEND_WINDOW_TIMEZONE;
    if (process.env.ODD_SEND_WINDOW_START_HOUR !== undefined) schedule.start_hour = Number(process.env.ODD_SEND_WINDOW_START_HOUR);
    if (process.env.ODD_SEND_WINDOW_END_HOUR !== undefined) schedule.end_hour = Number(process.env.ODD_SEND_WINDOW_END_HOUR);
    if (process.env.ODD_SEND_WINDOW_WEEKDAYS_ONLY !== undefined) {
      schedule.weekdays_only = !['false', '0', 'no'].includes(process.env.ODD_SEND_WINDOW_WEEKDAYS_ONLY.toLowerCase());
    }
    _config.send_window = schedule;
  }
  return _config;
}

// ── Run state ────────────────────────────────────────────────
let _sendState = {
  active: false,
  campaignId: null,
  processed: 0,
  total: 0,
  currentLead: null,
  cancelling: false,
  startedAt: null,
  errors: [],
};

// Sends currently inside the SMTP call cannot be recalled. Tracking their
// campaign lets stop operations cancel every other queued row while reporting
// the submissions that may still be accepted by the provider.
const inFlightSends = new Map();

export function getSendingStatus() {
  return { ..._sendState };
}

export function cancelSending() {
  if (_sendState.active) { _sendState.cancelling = true; return true; }
  return false;
}

function readSendControlRow(db) {
  const row = db.prepare(`SELECT paused,reason,updated_at,updated_by,updated_by_role
    FROM sending_control WHERE id=1`).get();
  return {
    paused: row?.paused === 1,
    reason: row?.reason || '',
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by ?? null,
    updatedByRole: row?.updated_by_role || null,
  };
}

export function getSendControlState(db = getDb()) {
  const history = db.prepare(`SELECT id,paused,reason,changed_at,actor_id,actor_role
    FROM sending_control_events ORDER BY id DESC LIMIT 20`).all();
  return {
    ...readSendControlRow(db),
    history: history.map(event => ({
      id: event.id,
      paused: event.paused === 1,
      reason: event.reason,
      changedAt: event.changed_at,
      actorId: event.actor_id ?? null,
      actorRole: event.actor_role || null,
    })),
  };
}

export function setSendControlState({ paused, reason = '', actor = null } = {}) {
  if (typeof paused !== 'boolean') throw new CampaignAudienceError('paused must be true or false.', 400);
  const normalizedReason = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
  if (paused && normalizedReason.length < 4) {
    throw new CampaignAudienceError('Enter a reason of at least four characters before pausing all sending.', 400);
  }
  const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
  const actorRole = ['owner', 'admin', 'operator', 'reviewer'].includes(actor?.role) ? actor.role : null;
  const db = getDb();
  return db.transaction(() => {
    const current = db.prepare('SELECT paused,reason FROM sending_control WHERE id=1').get();
    if (!current) throw new Error('Workspace sending control is not initialized.');
    if (current.paused === Number(paused) && current.reason === normalizedReason) return getSendControlState(db);
    db.prepare(`UPDATE sending_control SET paused=?,reason=?,updated_at=datetime('now'),updated_by=?,updated_by_role=?
      WHERE id=1`).run(Number(paused), normalizedReason, actorId, actorRole);
    db.prepare(`INSERT INTO sending_control_events(paused,reason,changed_at,actor_id,actor_role)
      VALUES(?,?,datetime('now'),?,?)`).run(Number(paused), normalizedReason, actorId, actorRole);
    return getSendControlState(db);
  })();
}

function normalizeSendSchedule(value) {
  const timezone = typeof value?.timezone === 'string' ? value.timezone.trim() : '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
  catch { throw new CampaignAudienceError('Enter a valid IANA time zone, such as America/New_York.', 400); }
  const startHour = Number(value?.startHour);
  const endHour = Number(value?.endHour);
  const minIntervalMs = Number(value?.minIntervalMs);
  const maxIntervalMs = Number(value?.maxIntervalMs);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23
    || !Number.isInteger(endHour) || endHour < 1 || endHour > 24 || startHour >= endHour) {
    throw new CampaignAudienceError('The send window must use whole hours, start from 0–23, end from 1–24, and end after it starts.', 400);
  }
  if (typeof value?.weekdaysOnly !== 'boolean') throw new CampaignAudienceError('weekdaysOnly must be true or false.', 400);
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 5000 || minIntervalMs > 3600000
    || !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < minIntervalMs || maxIntervalMs > 3600000) {
    throw new CampaignAudienceError('Sender pacing must be between 5 seconds and 1 hour, with the maximum at least the minimum.', 400);
  }
  return { timezone, startHour, endHour, weekdaysOnly: value.weekdaysOnly, minIntervalMs, maxIntervalMs };
}

export function getOperationalSendConfig(db = getDb()) {
  const base = getConfig();
  const config = { ...base, send_window: { ...base.send_window }, jitter_ms: { ...base.jitter_ms } };
  const stored = db.prepare(`SELECT timezone,start_hour,end_hour,weekdays_only,min_interval_ms,max_interval_ms
    FROM sending_schedule_settings WHERE id=1`).get();
  if (stored) {
    config.send_window = {
      timezone: stored.timezone,
      start_hour: stored.start_hour,
      end_hour: stored.end_hour,
      weekdays_only: stored.weekdays_only === 1,
    };
    config.jitter_ms = { min: stored.min_interval_ms, max: stored.max_interval_ms };
  }
  return config;
}

export function getSendingScheduleSettings(db = getDb()) {
  const active = getOperationalSendConfig(db);
  const history = db.prepare(`SELECT id,schedule_json,changed_at,actor_id,actor_role
    FROM sending_schedule_events ORDER BY id DESC LIMIT 20`).all().map(event => ({
      id: event.id,
      schedule: JSON.parse(event.schedule_json),
      changedAt: event.changed_at,
      actorId: event.actor_id ?? null,
      actorRole: event.actor_role || null,
    }));
  const stored = db.prepare('SELECT updated_at,updated_by,updated_by_role FROM sending_schedule_settings WHERE id=1').get();
  return {
    schedule: {
      timezone: active.send_window.timezone,
      startHour: active.send_window.start_hour,
      endHour: active.send_window.end_hour,
      weekdaysOnly: active.send_window.weekdays_only !== false,
      minIntervalMs: active.jitter_ms.min,
      maxIntervalMs: active.jitter_ms.max,
    },
    updatedAt: stored?.updated_at || null,
    updatedBy: stored?.updated_by ?? null,
    updatedByRole: stored?.updated_by_role || null,
    source: stored ? 'workspace' : 'configuration',
    history,
  };
}

export function setSendingScheduleSettings(value = {}, actor = null) {
  const schedule = normalizeSendSchedule(value);
  const actorId = Number.isSafeInteger(Number(actor?.id)) && Number(actor.id) > 0 ? Number(actor.id) : null;
  const actorRole = ['owner', 'admin', 'operator', 'reviewer'].includes(actor?.role) ? actor.role : null;
  const db = getDb();
  const scheduleJson = JSON.stringify(schedule);
  return db.transaction(() => {
    const previous = db.prepare(`SELECT timezone,start_hour,end_hour,weekdays_only,min_interval_ms,max_interval_ms
      FROM sending_schedule_settings WHERE id=1`).get();
    if (previous && JSON.stringify({
      timezone: previous.timezone,
      startHour: previous.start_hour,
      endHour: previous.end_hour,
      weekdaysOnly: previous.weekdays_only === 1,
      minIntervalMs: previous.min_interval_ms,
      maxIntervalMs: previous.max_interval_ms,
    }) === scheduleJson) return getSendingScheduleSettings(db);
    db.prepare(`INSERT INTO sending_schedule_settings(id,timezone,start_hour,end_hour,weekdays_only,
      min_interval_ms,max_interval_ms,updated_at,updated_by,updated_by_role)
      VALUES(1,?,?,?,?,?,?,datetime('now'),?,?)
      ON CONFLICT(id) DO UPDATE SET timezone=excluded.timezone,start_hour=excluded.start_hour,
        end_hour=excluded.end_hour,weekdays_only=excluded.weekdays_only,
        min_interval_ms=excluded.min_interval_ms,max_interval_ms=excluded.max_interval_ms,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by,updated_by_role=excluded.updated_by_role`)
      .run(schedule.timezone,schedule.startHour,schedule.endHour,Number(schedule.weekdaysOnly),
        schedule.minIntervalMs,schedule.maxIntervalMs,actorId,actorRole);
    db.prepare(`INSERT INTO sending_schedule_events(schedule_json,changed_at,actor_id,actor_role)
      VALUES(?,datetime('now'),?,?)`).run(scheduleJson,actorId,actorRole);
    return getSendingScheduleSettings(db);
  })();
}

// ══════════════════════════════════════════════════════════════
//  REAL DNS VERIFICATION (SPF, DMARC, MX, DNSBL)
// ══════════════════════════════════════════════════════════════

function inspectDkimKeyRecord(txtRecords) {
  if (!Array.isArray(txtRecords) || txtRecords.length === 0) return { status: 'not_discovered', raw: null };
  const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  for (const chunks of txtRecords) {
    const raw = chunks.join('');
    const tags = new Map();
    let malformed = false;
    for (const part of raw.split(';')) {
      const tag = part.trim();
      if (!tag) continue;
      const equals = tag.indexOf('=');
      if (equals < 1) { malformed = true; break; }
      const name = tag.slice(0, equals).trim().toLowerCase();
      const value = tag.slice(equals + 1).trim();
      if (!/^[a-z][a-z0-9_]*$/.test(name) || tags.has(name)) { malformed = true; break; }
      tags.set(name, value);
    }
    if (malformed || (tags.has('v') && tags.get('v').toUpperCase() !== 'DKIM1') || !tags.has('p')) continue;
    const encodedKey = tags.get('p').replace(/\s+/g, '');
    if (!encodedKey) return { status: 'revoked', raw };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) || encodedKey.length % 4 === 1) continue;
    const normalizedKey = encodedKey.replace(/=+$/, '');
    const keyBytes = Buffer.from(normalizedKey, 'base64');
    if (keyBytes.toString('base64').replace(/=+$/, '') !== normalizedKey) continue;
    const keyType = (tags.get('k') || 'rsa').toLowerCase();
    try {
      if (keyType === 'rsa') createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
      else if (keyType === 'ed25519' && keyBytes.length === 32) {
        createPublicKey({ key: Buffer.concat([ed25519SpkiPrefix, keyBytes]), format: 'der', type: 'spki' });
      } else continue;
      return { status: 'published', raw };
    } catch {
      // A TXT value at the selector is not sufficient unless its public key parses.
    }
  }
  return { status: 'invalid_record', raw: txtRecords.map(chunks => chunks.join('')).join('\n') };
}

/**
 * Perform real DNS lookups on a domain.
 * Resolves SPF, DMARC (_dmarc.<domain>), MX, and DNSBL reputation.
 */
export async function checkDomainDns(domain) {
  const result = {
    domain,
    spf_ok: 0,
    // DNS key publication does not prove an outgoing message was signed or aligned.
    dkim_ok: null,
    dkim_status: 'unknown',
    dkim_key_status: 'unknown',
    dkim_selector: null,
    dkim_record: null,
    dmarc_ok: 0,
    // These legacy fields describe only DNSBL results for the domain's A records.
    // They do not describe a mailbox or the SMTP relay's actual egress address.
    blacklisted: null,
    domain_blacklisted: null,
    blacklist_status: 'not_checked',
    domain_dnsbl_status: 'not_checked',
    domain_a_records: [],
    domain_a_records_truncated: false,
    dnsbl_unchecked_domain_ip_count: 0,
    dnsbl_coverage_status: 'not_checked',
    sender_ip: null,
    sender_ip_status: 'unknown',
    sender_reputation_status: 'unknown',
    dnsbl_subject_type: 'domain_apex_ipv4',
    dnsbl_status: 'not_checked',
    dnsbl_checks: [],
    mx_records: [],
    spf_record: null,
    dmarc_record: null,
    blacklist_matches: [],
    checked_at: new Date().toISOString(),
  };

  if (!domain || typeof domain !== 'string') return result;

  // 1. Resolve Apex TXT records for SPF
  try {
    const txtRecords = await dnsPromises.resolveTxt(domain);
    const flattened = txtRecords.map(r => r.join(''));
    const spf = flattened.find(t => t.toLowerCase().startsWith('v=spf1'));
    if (spf) {
      result.spf_ok = 1;
      result.spf_record = spf;
    }
  } catch (err) {
    // No TXT records or domain not found
  }

  // 2. Resolve DMARC TXT record (_dmarc.<domain>)
  try {
    const dmarcRecords = await dnsPromises.resolveTxt(`_dmarc.${domain}`);
    const flattened = dmarcRecords.map(r => r.join(''));
    const dmarc = flattened.find(t => t.toLowerCase().startsWith('v=dmarc1'));
    if (dmarc) {
      result.dmarc_ok = 1;
      result.dmarc_record = dmarc;
    }
  } catch (err) {
    // No DMARC record
  }

  // 3. Resolve MX records
  try {
    const mx = await dnsPromises.resolveMx(domain);
    result.mx_records = mx.sort((a, b) => a.priority - b.priority);
  } catch (err) {
    // No MX
  }

  // 4. IP DNSBL checks against every bounded, observed IPv4 address on the
  // domain apex. This is domain-web-address evidence only. The actual SMTP
  // egress IP is learned from the sending relay/provider and is not inferred here.
  let resolvedDomainIps = [];
  try {
    resolvedDomainIps = await dnsPromises.resolve4(domain);
  } catch (err) {
    result.dnsbl_status = err.code === 'ENOTFOUND' || err.code === 'ENODATA'
      ? 'no_a_record'
      : 'unavailable';
    result.domain_dnsbl_status = result.dnsbl_status === 'no_a_record' ? 'not_checked' : 'unavailable';
    result.blacklist_status = result.domain_dnsbl_status;
  }

  const allDomainIps = [...new Set((Array.isArray(resolvedDomainIps) ? resolvedDomainIps : []).filter(ip => isIP(String(ip)) === 4))];
  const domainIps = allDomainIps.slice(0, MAX_DNSBL_DOMAIN_ADDRESSES);
  result.domain_a_records = domainIps;
  result.domain_a_records_truncated = allDomainIps.length > domainIps.length;
  result.dnsbl_unchecked_domain_ip_count = Math.max(0, allDomainIps.length - domainIps.length);

  if (domainIps.length) {
    const outcomes = [];
    for (const ip of domainIps) {
      const reversedIp = ip.split('.').reverse().join('.');
      for (const blocklist of DNSBL_ZONES) {
        const queryName = `${reversedIp}.${blocklist}`;
        try {
          const answers = await dnsPromises.resolve4(queryName);
          const classified = classifyDnsblResponse(blocklist, Array.isArray(answers) ? answers : []);
          outcomes.push({
            subject_type: 'domain_apex_ipv4',
            checked_ip: ip,
            blocklist,
            query_name: queryName,
            ...classified,
          });
        } catch (err) {
          if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
            outcomes.push({
              subject_type: 'domain_apex_ipv4', checked_ip: ip, blocklist, query_name: queryName,
              outcome: 'not_listed', response_codes: [],
            });
          } else {
            const errorCode = err.code === 'ESERVFAIL' ? 'DNSBL_SERVFAIL'
              : err.code === 'ETIMEDOUT' || err.code === 'ETIMEOUT' ? 'DNSBL_TIMEOUT'
                : err.code === 'EREFUSED' ? 'DNSBL_QUERY_REFUSED'
                  : err.code || 'DNSBL_DNS_ERROR';
            outcomes.push({
              subject_type: 'domain_apex_ipv4', checked_ip: ip, blocklist, query_name: queryName,
              outcome: 'unavailable', error: errorCode, response_codes: [],
            });
          }
        }
      }
    }

    result.dnsbl_checks = outcomes;
    result.blacklist_matches = [...new Set(outcomes.filter(check => check.outcome === 'listed').map(check => check.blocklist))];
    const anyListed = outcomes.some(check => check.outcome === 'listed');
    const anyUnavailable = outcomes.some(check => check.outcome === 'unavailable') || result.domain_a_records_truncated;
    const allNotListed = outcomes.length > 0 && outcomes.every(check => check.outcome === 'not_listed');
    result.domain_dnsbl_status = anyListed ? 'listed'
      : anyUnavailable ? 'unavailable'
        : allNotListed ? 'not_listed' : 'unknown';
    result.blacklist_status = result.domain_dnsbl_status;
    result.domain_blacklisted = result.domain_dnsbl_status === 'listed' ? 1
      : result.domain_dnsbl_status === 'not_listed' ? 0 : null;
    result.blacklisted = null;
    result.dnsbl_status = 'checked';
    result.dnsbl_coverage_status = result.domain_a_records_truncated ? 'partial' : 'complete';
  } else if (result.dnsbl_status !== 'unavailable') {
    result.dnsbl_status = 'no_a_record';
    result.domain_dnsbl_status = 'not_checked';
    result.blacklist_status = 'not_checked';
    result.blacklisted = null;
    result.domain_blacklisted = null;
    result.dnsbl_coverage_status = 'not_checked';
  } else {
    result.dnsbl_coverage_status = 'unavailable';
  }

  // DKIM: actual selector discovery via <selector>._domainkey.<domain> TXT lookups.
  // A published DKIM key is a real DNS observation; it is NOT proof that a given
  // message was signed or that signatures align. If no selector resolves, the
  // outcome is unknown, never a pass derived from SPF/DMARC.
  const selectors = (getConfig().dkim_selectors || ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 'dkim', 'mail', 'zoho', 'mandrill']);
  let dnsError = false;
  let unusableRecord = null;
  for (const sel of selectors) {
    try {
      const records = await dnsPromises.resolveTxt(`${sel}._domainkey.${domain}`);
      const keyRecord = inspectDkimKeyRecord(records);
      if (keyRecord.status === 'published') {
        result.dkim_key_status = 'published';
        result.dkim_status = 'signature_unverified';
        result.dkim_selector = sel;
        result.dkim_record = keyRecord.raw;
        break;
      }
      if (!unusableRecord) unusableRecord = { ...keyRecord, selector: sel };
    } catch (err) {
      if (err.code !== 'ENOTFOUND' && err.code !== 'ENODATA') dnsError = true;
    }
  }
  if (result.dkim_key_status !== 'published') {
    result.dkim_key_status = unusableRecord?.status || (dnsError ? 'unavailable' : 'not_discovered');
    result.dkim_status = 'unknown';
    result.dkim_selector = unusableRecord?.selector || null;
    result.dkim_record = unusableRecord?.raw || null;
  }

  return result;
}

/**
 * Run real DNS check for a specific mailbox and persist results in SQLite.
 */
export async function verifyMailboxDns(mailboxId) {
  const db = getDb();
  const mb = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!mb) throw new Error(`Mailbox #${mailboxId} not found`);

  const dnsData = await checkDomainDns(mb.domain);

  // Update domains table
  db.prepare(`
    INSERT OR REPLACE INTO domains (domain, spf_ok, dkim_ok, dkim_status, dmarc_ok, blacklisted, blacklist_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(mb.domain, dnsData.spf_ok, dnsData.dkim_ok, dnsData.dkim_status, dnsData.dmarc_ok, dnsData.domain_blacklisted, dnsData.blacklist_status);

  // Update mailboxes table
  db.prepare(`
    UPDATE mailboxes
    SET spf_ok = ?, dkim_ok = ?, dkim_status = ?, dmarc_ok = ?, blacklisted = ?, blacklist_status = ?,
        dns_checked_at = datetime('now'), dns_records_json = ?
    WHERE id = ?
  `).run(
    dnsData.spf_ok,
    dnsData.dkim_ok,
    dnsData.dkim_status,
    dnsData.dmarc_ok,
    dnsData.blacklisted,
    dnsData.blacklist_status,
    JSON.stringify(dnsData),
    mailboxId
  );

  return { mailboxId, domain: mb.domain, ...dnsData };
}

// ══════════════════════════════════════════════════════════════
//  REAL SMTP CONNECTION VERIFICATION (NODEMAILER)
// ══════════════════════════════════════════════════════════════

function inspectSmtpSettings(mailbox) {
  const hostValue = typeof mailbox.smtp_host === 'string' ? mailbox.smtp_host.trim() : '';
  const user = typeof mailbox.smtp_user === 'string' ? mailbox.smtp_user.trim() : '';
  let pass = '';
  try {
    pass = decryptCredential(mailbox.smtp_pass);
  } catch (error) {
    return { ok: false, code: error.code || 'SMTP_CREDENTIAL_UNAVAILABLE', error: error.message };
  }
  const encryptedStorageRequired = process.env.NODE_ENV === 'production'
    || process.env.ODD_CREDENTIAL_ENFORCE_ENCRYPTION === 'true';
  if (encryptedStorageRequired && mailbox.smtp_pass && !String(mailbox.smtp_pass).startsWith('oddc1:') && !hasActiveCredentialKey()) {
    return {
      ok: false,
      code: 'SMTP_CREDENTIAL_ENCRYPTION_REQUIRED',
      error: 'Mailbox credential storage is still plaintext. Configure ODD_CREDENTIAL_ENCRYPTION_KEY and restart to migrate it before connecting or sending.',
    };
  }
  const hasAny = Boolean(hostValue || user || pass);
  if (!hostValue || !user || pass.length === 0) {
    return {
      ok: false,
      code: hasAny ? 'SMTP_INCOMPLETE_CONFIG' : 'SMTP_NOT_CONFIGURED',
      error: hasAny
        ? 'SMTP Host, username, and password must all be present before connecting.'
        : 'SMTP credentials are not configured. Add an SMTP Host, username, and password before connecting.',
    };
  }

  const unwrappedHost = hostValue.startsWith('[') && hostValue.endsWith(']') ? hostValue.slice(1, -1) : hostValue;
  let host;
  if (isIP(unwrappedHost)) {
    host = unwrappedHost;
  } else if (!/[\s\/@?#\\]/.test(hostValue) && hostValue.length <= 254) {
    const ascii = domainToASCII(hostValue.endsWith('.') ? hostValue.slice(0, -1) : hostValue);
    const validLabels = ascii && ascii.length <= 253 && ascii.split('.').every(label =>
      label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
    if (validLabels) host = ascii.toLowerCase();
  }

  const port = mailbox.smtp_port == null ? (mailbox.smtp_secure ? 465 : 587) : Number(mailbox.smtp_port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, code: 'SMTP_INVALID_CONFIG', error: 'SMTP Host must be a hostname or IP address, and Port must be an integer from 1 to 65535.' };
  }

  return { ok: true, host, port, secure: Boolean(mailbox.smtp_secure) || port === 465, user, pass };
}

/** Build a Nodemailer transporter only after SMTP settings pass validation. */
function createMailboxTransporter(settings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

/**
 * Test SMTP connection and authentication handshake.
 */
export async function testMailboxSmtp(mailboxId) {
  const db = getDb();
  const mb = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!mb) throw new Error(`Mailbox #${mailboxId} not found`);

  const settings = inspectSmtpSettings(mb);
  if (!settings.ok) {
    return {
      ok: false,
      code: settings.code,
      message: settings.error,
      error: settings.error,
      configured: false,
    };
  }

  try {
    const transporter = createMailboxTransporter(settings);
    await transporter.verify();
    return {
      ok: true,
      message: `SMTP handshake successful (${settings.host}:${settings.port})`,
      host: settings.host,
      port: settings.port,
      configured: true,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.code || 'ESOCKET',
      configured: true,
    };
  }
}

/**
 * Send a real test email from a mailbox to verify end-to-end delivery.
 */
export async function sendTestEmail(mailboxId, toEmail, subject = 'oddecosys Test Message', body = 'This is a live test email from oddecosys Sending Engine.') {
  const db = getDb();
  const mb = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!mb) throw new Error(`Mailbox #${mailboxId} not found`);

  const fromName = mb.from_name || 'Outreach Team';
  const fromAddress = `"${fromName}" <${mb.email}>`;

  const settings = inspectSmtpSettings(mb);
  if (settings.ok) {
    const transporter = createMailboxTransporter(settings);
    const info = await transporter.sendMail({
      from: fromAddress,
      to: toEmail,
      subject,
      text: body,
      headers: {
        'X-Mailer': 'oddecosys-engine/1.0',
        'X-Mailbox-Id': String(mb.id),
      },
    });

    if (!info.accepted?.length || info.rejected?.length) {
      throw new Error('SMTP did not accept the test recipient');
    }
    // SMTP acceptance is observed; delivery remains unknown.
    db.prepare(`
      INSERT INTO events (lead_id, event_type, event_at, meta_json)
      VALUES (NULL, 'sent', datetime('now'), ?)
    `).run(JSON.stringify({
      test_send: true,
      from: mb.email,
      to: toEmail,
      messageId: info.messageId,
      response: info.response,
    }));

    return {
      ok: true,
      messageId: info.messageId,
      response: info.response,
      recipient: toEmail,
      mode: 'real_smtp',
      delivery: 'unknown',
    };
  } else {
    return {
      ok: false,
      code: settings.code,
      recipient: toEmail,
      mode: 'unavailable',
      error: settings.error,
    };
  }
}

// ══════════════════════════════════════════════════════════════
//  MAILBOX HEALTH SCORING (recompute daily)
// ══════════════════════════════════════════════════════════════

/**
 * Recompute health scores for all active mailboxes.
 * Score (0-100) based on: bounce rate, complaint rate,
 * reply rate (positive signal), age, blacklist status, and DNS checks.
 */
export function recomputeHealthScores() {
  const db = getDb();
  const mailboxes = db.prepare('SELECT * FROM mailboxes WHERE active = 1').all();
  const updateStmt = db.prepare('UPDATE mailboxes SET health_score = ? WHERE id = ?');
  const results = [];

  for (const mb of mailboxes) {
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN e.event_type = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN e.event_type = 'hard_bounce' THEN 1 END) as hard_bounces,
        COUNT(CASE WHEN e.event_type = 'soft_bounce' THEN 1 END) as soft_bounces,
        COUNT(CASE WHEN e.event_type = 'spam_complaint' THEN 1 END) as complaints,
        COUNT(CASE WHEN e.event_type = 'opened' THEN 1 END) as opens,
        COUNT(CASE WHEN e.event_type = 'replied' THEN 1 END) as replies
      FROM sends s
      JOIN events e ON e.send_id = s.id
      WHERE s.mailbox_id = ?
      AND e.event_at >= datetime('now', '-30 days')
    `).get(mb.id);

    let score = 100;

    if (stats.sent > 0) {
      const bounceRate = ((stats.hard_bounces + stats.soft_bounces) / stats.sent) * 100;
      const complaintRate = (stats.complaints / stats.sent) * 100;
      const replyRate = (stats.replies / stats.sent) * 100;

      // Penalties
      if (bounceRate > 5)  score -= 40;
      else if (bounceRate > 2) score -= 20;
      else if (bounceRate > 0) score -= bounceRate * 5;

      if (complaintRate > 0.1) score -= 35;
      else if (complaintRate > 0) score -= complaintRate * 200;

      // Hard bounces extra penalty
      score -= stats.hard_bounces * 3;

      // Positive: reply rate boost
      score += Math.min(10, replyRate * 2);
    }

    // Warmup age factor
    if (mb.warmup_started_at) {
      const daysSinceWarmup = Math.floor((Date.now() - new Date(mb.warmup_started_at).getTime()) / 86400000);
      if (daysSinceWarmup < 14) score -= (14 - daysSinceWarmup);
    }

    // DNS check deductions
    if (!mb.spf_ok) score -= 15;
    if (!mb.dmarc_ok) score -= 10;

    score = Math.max(0, Math.min(100, Math.round(score)));
    updateStmt.run(score, mb.id);
    results.push({ id: mb.id, email: mb.email, health_score: score });
  }

  return results;
}

// ══════════════════════════════════════════════════════════════
//  WARMUP MANAGEMENT
// ══════════════════════════════════════════════════════════════

export function getWarmupInfo(mailbox) {
  const config = getConfig();
  const startedAt = mailbox.warmup_started_at ? Date.parse(mailbox.warmup_started_at) : NaN;
  const daysSinceStart = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 86400000))
    : 0;

  const week = Math.ceil(daysSinceStart / 7) || 1;
  const ramp = config.warmup_ramp.find(r => r.week >= week) || config.warmup_ramp[config.warmup_ramp.length - 1];

  return {
    day: daysSinceStart,
    week,
    warmupPerDay: ramp.warmup_per_day,
    coldPerDay: ramp.cold_per_day,
    // This is progress through a suggested calendar plan only. It is never a
    // sending decision; that requires real evidence and an explicit review.
    rampComplete: daysSinceStart >= config.warmup_total_days,
    totalDays: config.warmup_total_days,
  };
}

export function processWarmupTransitions() {
  const db = getDb();
  const warming = db.prepare("SELECT * FROM mailboxes WHERE warmup_status = 'warming' AND active = 1").all();
  const awaitingReview = warming.map(mailbox => ({
    id: mailbox.id,
    email: mailbox.email,
    rampComplete: getWarmupInfo(mailbox).rampComplete,
    reason: 'A person must review the recorded email activity before campaign sending is allowed.',
  }));
  return { transitioned: [], checked: warming.length, awaitingReview };
}

const MAILBOX_SEND_REVIEW_POLICY = 'smtp-and-inbox-activity-v1';

function getMailboxWarmupEvidence(db, mailboxId) {
  const outbound = db.prepare(`SELECT COUNT(*) AS count,MAX(sent_at) AS latest_at
    FROM sends WHERE mailbox_id=? AND status='sent'`).get(mailboxId);
  const replies = db.prepare(`SELECT COUNT(*) AS count,MAX(e.event_at) AS latest_at
    FROM events e JOIN sends s ON s.id=e.send_id
    WHERE s.mailbox_id=? AND e.event_type='replied'`).get(mailboxId);
  const inbox = db.prepare(`SELECT last_success_at,last_fetched,last_imported,last_duplicates,last_skipped
    FROM imap_sync_mailbox_state WHERE mailbox_id=?`).get(mailboxId) || {};
  return {
    outbound: { source: 'accepted_sends', count: Number(outbound.count || 0), latestAt: outbound.latest_at || null },
    replies: { source: 'attributed_inbound_reply_events', count: Number(replies.count || 0), latestAt: replies.latest_at || null },
    inbox: {
      source: 'imap_sync_mailbox_state',
      lastCheckedAt: inbox.last_success_at || null,
      fetched: Number.isFinite(Number(inbox.last_fetched)) ? Number(inbox.last_fetched) : null,
      imported: Number.isFinite(Number(inbox.last_imported)) ? Number(inbox.last_imported) : null,
      alreadyRecorded: Number.isFinite(Number(inbox.last_duplicates)) ? Number(inbox.last_duplicates) : null,
      skipped: Number.isFinite(Number(inbox.last_skipped)) ? Number(inbox.last_skipped) : null,
    },
  };
}

export function reviewMailboxForCampaignSending(id, { decision, acknowledgeEvidenceLimits = false, actor = null } = {}) {
  const mailboxId = Number(id);
  if (!Number.isSafeInteger(mailboxId) || mailboxId < 1) throw new CampaignAudienceError('Mailbox was not found.', 404);
  if (!['approve','hold'].includes(decision)) throw new CampaignAudienceError('Choose whether to allow or hold campaign sending.', 400);
  if (decision === 'approve' && acknowledgeEvidenceLimits !== true) {
    throw new CampaignAudienceError('Confirm that these records show email activity, not inbox placement.', 400);
  }
  const db = getDb();
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id=? AND active=1').get(mailboxId);
  if (!mailbox) throw new CampaignAudienceError('Mailbox not found or no longer active.', 404);
  const evidence = getMailboxWarmupEvidence(db, mailboxId);
  const info = getWarmupInfo(mailbox);
  const config = getConfig();
  if (decision === 'approve') {
    if (!info.rampComplete) throw new CampaignAudienceError(`The ${info.totalDays}-day sending plan is not finished yet.`, 409);
    if (mailbox.health_score < config.min_health_to_send) throw new CampaignAudienceError('Mailbox health is below the sending limit. Review its connection and DNS checks first.', 409);
    if (evidence.outbound.count < 1) throw new CampaignAudienceError('No accepted outgoing email is recorded yet. Send a safe test email and check the result first.', 409);
    if (Number(evidence.inbox.fetched || 0) < 1) throw new CampaignAudienceError('No received email is recorded yet. Connect Inbox and sync at least one message first.', 409);
  }
  const reviewAt = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO mailbox_warmup_reviews(mailbox_id,decision,policy_version,evidence_json,reviewed_by,reviewed_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(mailbox_id) DO UPDATE SET decision=excluded.decision,
      policy_version=excluded.policy_version,evidence_json=excluded.evidence_json,
      reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at`)
      .run(mailboxId, decision === 'approve' ? 'approved' : 'held', MAILBOX_SEND_REVIEW_POLICY,
        JSON.stringify(evidence), Number.isSafeInteger(actor?.id) ? actor.id : null, reviewAt);
    db.prepare('UPDATE mailboxes SET warmup_status=?,daily_limit=? WHERE id=?')
      .run(decision === 'approve' ? 'eligible' : 'warming', decision === 'approve' ? config.max_daily_per_mailbox : 0, mailboxId);
  })();
  return { id: mailboxId, decision: decision === 'approve' ? 'approved' : 'held', reviewedAt: reviewAt, policyVersion: MAILBOX_SEND_REVIEW_POLICY, evidence };
}

function readDailyCapacityUsage(db, mailboxId, domain) {
  const today = db.prepare("SELECT date('now') AS day").get().day;
  const mailboxSent = db.prepare("SELECT COUNT(*) AS count FROM sends WHERE mailbox_id=? AND status='sent' AND sent_at>=date('now')").get(mailboxId).count;
  const mailboxReserved = db.prepare(`SELECT COUNT(*) AS count FROM send_capacity_reservations
    WHERE mailbox_id=? AND capacity_day=? AND state IN ('reserved','uncertain')`).get(mailboxId, today).count;
  const domainSent = db.prepare(`SELECT COUNT(*) AS count FROM sends s JOIN mailboxes m ON m.id=s.mailbox_id
    WHERE m.domain=? AND s.status='sent' AND s.sent_at>=date('now')`).get(domain).count;
  const domainReserved = db.prepare(`SELECT COUNT(*) AS count FROM send_capacity_reservations
    WHERE domain=? AND capacity_day=? AND state IN ('reserved','uncertain')`).get(domain, today).count;
  return {
    today,
    mailboxSent,
    mailboxReserved,
    mailboxUsed: mailboxSent + mailboxReserved,
    domainSent,
    domainReserved,
    domainUsed: domainSent + domainReserved,
  };
}

function reserveDailyCapacity(db, send) {
  const config = getConfig();
  const mailbox = db.prepare('SELECT id,domain,daily_limit FROM mailboxes WHERE id=?').get(send.mailbox_id);
  if (!mailbox) return { ok: false, reason: 'sender_missing' };
  const usage = readDailyCapacityUsage(db, mailbox.id, mailbox.domain);
  if (usage.mailboxUsed >= Number(mailbox.daily_limit || 0)) return { ok: false, reason: 'mailbox_daily_limit_reached', usage };
  if (usage.domainUsed >= Number(config.max_daily_per_domain || 0)) return { ok: false, reason: 'domain_daily_limit_reached', usage };

  const reserved = db.prepare(`INSERT INTO send_capacity_reservations(send_id,mailbox_id,domain,capacity_day,state)
    VALUES(?,?,?,?, 'reserved')
    ON CONFLICT(send_id) DO UPDATE SET mailbox_id=excluded.mailbox_id,domain=excluded.domain,
      capacity_day=excluded.capacity_day,state='reserved',updated_at=datetime('now')
    WHERE send_capacity_reservations.state='released'`)
    .run(send.id, mailbox.id, mailbox.domain, usage.today);
  if (reserved.changes !== 1) return { ok: false, reason: 'send_capacity_reservation_already_exists', usage };
  return { ok: true, usage };
}

// ══════════════════════════════════════════════════════════════
//  MAILBOX ROTATION (Weighted Round-Robin)
// ══════════════════════════════════════════════════════════════

export function selectMailbox(allowedMailboxIds = null) {
  const db = getDb();
  const config = getConfig();
  const allowedIds = allowedMailboxIds === null ? null : normalizeCampaignSenderIds(allowedMailboxIds);
  if (allowedIds && !allowedIds.length) return null;
  const selectionClause = allowedIds ? `AND m.id IN (${allowedIds.map(() => '?').join(',')})` : '';

  const eligible = db.prepare(`
    SELECT m.*,
      COALESCE((SELECT COUNT(*) FROM sends s
        WHERE s.mailbox_id = m.id AND s.status='sent' AND s.sent_at >= date('now')), 0) as today_sent,
      COALESCE((SELECT COUNT(*) FROM send_capacity_reservations r
        WHERE r.mailbox_id=m.id AND r.capacity_day=date('now') AND r.state IN ('reserved','uncertain')), 0) as today_reserved
    FROM mailboxes m
    WHERE m.warmup_status = 'eligible'
      AND m.active = 1
      AND m.health_score >= ?
      ${selectionClause}
    ORDER BY m.health_score DESC
  `).all(config.min_health_to_send, ...(allowedIds || []));

  const withCapacity = eligible.filter(m => m.today_sent + m.today_reserved < m.daily_limit);
  if (withCapacity.length === 0) return null;

  const domainCounts = {};
  for (const m of withCapacity) {
    if (!domainCounts[m.domain]) {
      domainCounts[m.domain] = db.prepare(`
        SELECT (SELECT COUNT(*) FROM sends s JOIN mailboxes mb ON s.mailbox_id = mb.id
          WHERE mb.domain = ? AND s.status='sent' AND s.sent_at >= date('now'))
        + (SELECT COUNT(*) FROM send_capacity_reservations r
          WHERE r.domain=? AND r.capacity_day=date('now') AND r.state IN ('reserved','uncertain')) AS count
      `).get(m.domain, m.domain).count;
    }
  }

  const domainEligible = withCapacity.filter(
    m => domainCounts[m.domain] < config.max_daily_per_domain
  );
  if (domainEligible.length === 0) return null;

  const poolKey = allowedIds
    ? `senders:${[...allowedIds].sort((a, b) => a - b).join(',')}`
    : 'senders:all';
  return db.transaction(() => {
    const stored = new Map(db.prepare('SELECT mailbox_id,current_weight FROM mailbox_rotation_state WHERE pool_key=?')
      .all(poolKey).map(row => [row.mailbox_id, row.current_weight]));
    const candidates = domainEligible.map(mailbox => ({
      mailbox,
      weight: Math.max(1, Math.round(Number(mailbox.health_score) || 0)),
      currentWeight: Number(stored.get(mailbox.id) || 0),
    }));
    const totalWeight = candidates.reduce((sum, item) => sum + item.weight, 0);
    for (const item of candidates) item.currentWeight += item.weight;
    const selected = [...candidates].sort((a, b) => b.currentWeight - a.currentWeight || a.mailbox.id - b.mailbox.id)[0];
    selected.currentWeight -= totalWeight;
    const save = db.prepare(`INSERT INTO mailbox_rotation_state(pool_key,mailbox_id,current_weight,updated_at)
      VALUES(?,?,?,datetime('now')) ON CONFLICT(pool_key,mailbox_id) DO UPDATE SET
      current_weight=excluded.current_weight,updated_at=excluded.updated_at`);
    for (const item of candidates) save.run(poolKey, item.mailbox.id, item.currentWeight);
    return selected.mailbox;
  })();
}

// ══════════════════════════════════════════════════════════════
//  AUTO-PAUSE ON THRESHOLD BREACH
// ══════════════════════════════════════════════════════════════

export function checkAutoThresholds() {
  const db = getDb();
  const config = getConfig();
  if (!config.auto_pause_on_threshold) return [];

  const eligible = db.prepare("SELECT * FROM mailboxes WHERE warmup_status = 'eligible' AND active = 1").all();
  const paused = [];

  for (const mb of eligible) {
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN e.event_type IN ('hard_bounce','soft_bounce') THEN 1 END) as bounces,
        COUNT(CASE WHEN e.event_type = 'spam_complaint' THEN 1 END) as complaints,
        COUNT(CASE WHEN e.event_type = 'sent' THEN 1 END) as sent
      FROM sends s
      JOIN events e ON e.send_id = s.id
      WHERE s.mailbox_id = ?
      AND e.event_at >= datetime('now', '-7 days')
    `).get(mb.id);

    if (stats.sent > 10) {
      const bounceRate = (stats.bounces / stats.sent) * 100;
      const complaintRate = (stats.complaints / stats.sent) * 100;

      if (bounceRate > config.bounce_threshold_pct || complaintRate > config.complaint_threshold_pct) {
        db.prepare("UPDATE mailboxes SET warmup_status = 'paused', daily_limit = 0 WHERE id = ?").run(mb.id);
        paused.push({
          id: mb.id,
          email: mb.email,
          reason: bounceRate > config.bounce_threshold_pct
            ? `bounce_rate:${bounceRate.toFixed(1)}%`
            : `complaint_rate:${complaintRate.toFixed(2)}%`,
        });
      }
    }
  }

  return paused;
}

// ══════════════════════════════════════════════════════════════
//  SEND QUEUE PROCESSING (SMTP ACCEPTANCE; DELIVERY UNKNOWN)
// ══════════════════════════════════════════════════════════════

function validThreadMessageId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id.length <= 998 && /^<[^<>\s\r\n]+>$/.test(id) ? id : null;
}

function stopSequenceEnrollment(db, campaignId, leadId, sendId, reason) {
  const updated = db.prepare("UPDATE campaign_enrollments SET status='stopped' WHERE campaign_id=? AND lead_id=? AND status='active'").run(campaignId, leadId).changes;
  const cancelled = db.prepare(`UPDATE sends SET status='cancelled',sent_at=NULL,error_message=?
    WHERE campaign_id=? AND lead_id=? AND campaign_step_id IS NOT NULL AND status='scheduled'`)
    .run(`Campaign sequence stopped: ${reason}`, campaignId, leadId).changes;
  db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
    VALUES(?,?, 'campaign_sequence_stopped',datetime('now'),?)`)
    .run(sendId || null, leadId, JSON.stringify({ campaign_id: campaignId, reason, cancelled_followups: cancelled }));
  return { enrollmentChanged: updated, cancelled };
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function buildCampaignLaunchSnapshot(db, campaignId) {
  const campaign = db.prepare(`SELECT id,name,sequence_step,template_ref
    FROM campaigns WHERE id=?`).get(campaignId);
  if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);

  const audience = db.prepare(`SELECT e.lead_id,e.source_list_id,
      l.email,l.business_name,l.category,l.address,l.city,l.state,l.country,l.phone,l.website_url,
      p.id AS personalization_id,p.subject_variant,p.subject_line,p.body_variant,p.body_text,
      p.guardrail_passed,p.fact_check_passed,p.fact_check_status,p.approved
    FROM campaign_enrollments e
    JOIN leads l ON l.id=e.lead_id
    LEFT JOIN personalizations p ON p.id=(
      SELECT p2.id FROM personalizations p2 WHERE p2.lead_id=e.lead_id
      ORDER BY p2.generated_at DESC,p2.id DESC LIMIT 1
    )
    WHERE e.campaign_id=? ORDER BY e.lead_id`).all(campaignId).map(row => {
      const customFieldValues = db.prepare(`SELECT f.field_key,v.value_json
        FROM lead_custom_field_values v JOIN contact_field_definitions f ON f.id=v.field_id
        WHERE v.lead_id=? ORDER BY f.field_key`).all(row.lead_id).map(value => [value.field_key, value.value_json]);
      const customFieldHash = customFieldValues.length ? sha256Json(customFieldValues) : null;
      return {
        leadId: row.lead_id,
        sourceListId: row.source_list_id,
        profileHash: sha256Json([
          row.email, row.business_name, row.category, row.address, row.city, row.state,
          row.country, row.phone, row.website_url, ...(customFieldHash ? [customFieldHash] : []),
        ]),
        personalizationId: row.personalization_id,
        personalizationHash: row.personalization_id === null ? null : sha256Json([
          row.subject_variant, row.subject_line, row.body_variant, row.body_text,
          row.guardrail_passed, row.fact_check_passed, row.fact_check_status, row.approved,
        ]),
      };
    });

  const senderIdentities = db.prepare(`SELECT m.id AS mailbox_id,m.email,m.domain,m.from_name
    FROM campaign_senders cs JOIN mailboxes m ON m.id=cs.mailbox_id
    WHERE cs.campaign_id=? ORDER BY m.id`).all(campaignId).map(row => ({
      mailboxId: row.mailbox_id,
      email: row.email,
      domain: row.domain,
      fromName: row.from_name,
    }));
  const senderMailboxIds = senderIdentities.map(sender => sender.mailboxId);
  const steps = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? ORDER BY position,id')
    .all(campaignId).map(step => ({
      id: step.id,
      position: step.position,
      delayDays: step.delay_days,
      variants: db.prepare(`SELECT variant_key,allocation_pct,subject_line,body_text
        FROM campaign_step_variants WHERE step_id=? ORDER BY variant_key`).all(step.id)
        .map(variant => ({
          key: variant.variant_key,
          allocationPct: variant.allocation_pct,
          subject: variant.subject_line,
          body: variant.body_text,
        })),
    }));
  const snapshot = {
    schemaVersion: 1,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      sequenceStep: campaign.sequence_step,
      templateRef: campaign.template_ref,
    },
    audience,
    senderMailboxIds,
    senderIdentities,
    steps,
  };
  const snapshotJson = JSON.stringify(snapshot);
  return { snapshot, snapshotJson, snapshotHash: createHash('sha256').update(snapshotJson).digest('hex') };
}

function getOrCreateCampaignLaunch(db, campaignId) {
  const current = buildCampaignLaunchSnapshot(db, campaignId);
  let launch = db.prepare('SELECT id,version,snapshot_json,snapshot_hash FROM campaign_launches WHERE campaign_id=? ORDER BY version DESC LIMIT 1')
    .get(campaignId);
  if (launch) {
    if (createHash('sha256').update(launch.snapshot_json).digest('hex') !== launch.snapshot_hash) {
      throw new CampaignAudienceError('The stored campaign launch snapshot failed its integrity check. No sends were queued.', 409);
    }
    if (launch.snapshot_hash !== current.snapshotHash) {
      throw new CampaignAudienceError('Launched campaign configuration changed after its immutable snapshot. No additional sends were queued; clone it into a new draft to change recipients or copy.', 409);
    }
    return { id: launch.id, version: launch.version, snapshot_hash: launch.snapshot_hash };
  }

  const inserted = db.prepare(`INSERT INTO campaign_launches(campaign_id,version,snapshot_json,snapshot_hash)
    VALUES (?,1,?,?)`).run(campaignId, current.snapshotJson, current.snapshotHash);
  launch = { id: Number(inserted.lastInsertRowid), version: 1, snapshot_hash: current.snapshotHash };
  db.prepare(`INSERT INTO events(event_type,event_at,meta_json)
    VALUES ('campaign_launch_snapshot_created',datetime('now'),?)`)
    .run(JSON.stringify({ campaign_id: campaignId, version: launch.version, snapshot_hash: launch.snapshot_hash,
      recipient_count: current.snapshot.audience.length, sender_count: current.snapshot.senderMailboxIds.length,
      sequence_step_count: current.snapshot.steps.length }));
  return launch;
}

function campaignLaunchMatchesCurrentConfig(db, send) {
  if (!send.campaign_launch_id) return true; // Preserve rows created before launch snapshots existed.
  const launch = db.prepare('SELECT campaign_id,snapshot_json,snapshot_hash FROM campaign_launches WHERE id=?').get(send.campaign_launch_id);
  if (!launch || launch.campaign_id !== send.campaign_id
    || createHash('sha256').update(launch.snapshot_json).digest('hex') !== launch.snapshot_hash) return false;
  return buildCampaignLaunchSnapshot(db, send.campaign_id).snapshotHash === launch.snapshot_hash;
}

function sendContentMatchesLaunch(db, send) {
  if (!send.campaign_launch_id) return true;
  if (!campaignLaunchMatchesCurrentConfig(db, send)) return false;
  const launch = db.prepare('SELECT snapshot_json FROM campaign_launches WHERE id=? AND campaign_id=?')
    .get(send.campaign_launch_id, send.campaign_id);
  let snapshot;
  try { snapshot = JSON.parse(launch?.snapshot_json || ''); } catch { return false; }
  if (!snapshot.audience?.some(item => item.leadId === send.lead_id)
    || !snapshot.senderMailboxIds?.includes(send.mailbox_id)) return false;
  if (send.campaign_step_id) {
    if (!snapshot.steps?.some(step => step.id === send.campaign_step_id)) return false;
    const preview = previewCampaignStep(send.campaign_id, send.campaign_step_id, send.lead_id, send.variant);
    return preview.ready && preview.subject === send.subject_snapshot && preview.body === send.body_snapshot;
  }
  const copy = db.prepare('SELECT subject_line,body_text FROM personalizations WHERE id=? AND lead_id=?')
    .get(send.personalization_id, send.lead_id);
  return Boolean(copy && copy.subject_line === send.subject_snapshot && copy.body_text === send.body_snapshot);
}

export function getCampaignLaunchSummary(value) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const row = getDb().prepare(`SELECT id,version,snapshot_json,snapshot_hash,created_at
    FROM campaign_launches WHERE campaign_id=? ORDER BY version DESC LIMIT 1`).get(campaignId);
  if (!row) return null;
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { snapshot = {}; }
  const integrityVerified = createHash('sha256').update(row.snapshot_json).digest('hex') === row.snapshot_hash;
  return {
    id: row.id,
    version: row.version,
    snapshotHash: row.snapshot_hash,
    createdAt: row.created_at,
    recipientCount: Array.isArray(snapshot.audience) ? snapshot.audience.length : null,
    senderCount: Array.isArray(snapshot.senderMailboxIds) ? snapshot.senderMailboxIds.length : null,
    sequenceStepCount: Array.isArray(snapshot.steps) ? snapshot.steps.length : null,
    personalizedContactCount: Array.isArray(snapshot.audience)
      ? snapshot.audience.filter(item => item.personalizationId !== null).length : null,
    integrityVerified,
  };
}

function campaignPreflightSnapshot(db, campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
  const status = getEffectiveCampaignStatus(db, campaign);
  const configuredSenders = db.prepare(`SELECT m.* FROM campaign_senders cs
    JOIN mailboxes m ON m.id=cs.mailbox_id WHERE cs.campaign_id=? ORDER BY m.id`).all(campaignId);
  const config = getOperationalSendConfig(db);
  const senders = configuredSenders.map(mailbox => {
    const readiness = campaignSenderReadiness(mailbox, config);
    const usage = readDailyCapacityUsage(db, mailbox.id, mailbox.domain);
    const mailboxRemaining = Math.max(0, Number(mailbox.daily_limit || 0) - usage.mailboxUsed);
    const domainRemaining = Math.max(0, Number(config.max_daily_per_domain || 0) - usage.domainUsed);
    const available = readiness === 'ready' && mailboxRemaining > 0 && domainRemaining > 0;
    return {
      mailboxId: mailbox.id,
      email: mailbox.email,
      readiness,
      available,
      todaySent: usage.mailboxSent,
      reservedToday: usage.mailboxReserved,
      mailboxRemaining,
      domainSent: usage.domainSent,
      domainReservedToday: usage.domainReserved,
      domainRemaining,
      reason: readiness !== 'ready' ? readiness
        : mailboxRemaining < 1 ? 'mailbox_daily_limit_reached'
          : domainRemaining < 1 ? 'domain_daily_limit_reached' : 'ready',
    };
  });

  const firstStep = db.prepare('SELECT id,position FROM campaign_steps WHERE campaign_id=? ORDER BY position,id LIMIT 1').get(campaignId) || null;
  let sequenceBlocker = null;
  if (firstStep) {
    const variants = db.prepare(`SELECT variant_key,allocation_pct,subject_line,body_text FROM campaign_step_variants
      WHERE step_id=? AND allocation_pct>0 ORDER BY variant_key`).all(firstStep.id);
    if (!variants.length || variants.reduce((sum, variant) => sum + variant.allocation_pct, 0) !== 100) {
      sequenceBlocker = { code: 'sequence_variant_allocation_invalid', message: 'The first sequence step needs active copy variants whose allocations total 100%.' };
    } else {
      const empty = variants.find(variant => !variant.subject_line?.trim() || !variant.body_text?.trim());
      if (empty) sequenceBlocker = { code: 'sequence_copy_incomplete', message: `First-step variant ${empty.variant_key} needs a subject and body.` };
    }
  }

  const blockers = [];
  const compliance = getComplianceReadiness();
  const sendControl = getSendControlState(db);
  if (!['draft', 'active'].includes(status)) blockers.push({ code: 'campaign_not_launchable', message: `Campaign is ${status}; resume it before queueing sends.` });
  if (sendControl.paused) blockers.push({ code: 'workspace_send_paused', message: sendControl.reason
    ? `Workspace-wide sending is paused: ${sendControl.reason}`
    : 'Workspace-wide sending is paused by an administrator.' });
  if (!senders.length) blockers.push({ code: 'sender_not_assigned', message: 'Choose at least one sender mailbox for this campaign.' });
  else if (!senders.some(sender => sender.available)) blockers.push({ code: 'sender_unavailable', message: 'No assigned sender is currently ready and within its daily sending limits.' });
  if (sequenceBlocker) blockers.push(sequenceBlocker);
  if (compliance.blockers.includes('https_unsubscribe_endpoint_not_configured')) {
    blockers.push({ code: 'https_unsubscribe_endpoint_not_configured', message: 'Set APP_URL or ODD_PUBLIC_BASE_URL to the public HTTPS application origin to enable one-click unsubscribe.' });
  }
  if (compliance.blockers.includes('physical_mailing_address_not_configured')) {
    blockers.push({ code: 'physical_mailing_address_not_configured', message: 'Set COMPANY_PHYSICAL_ADDRESS to the real business mailing address required in campaign messages.' });
  }

  const currentSnapshot = buildCampaignLaunchSnapshot(db, campaignId);
  const launch = db.prepare('SELECT snapshot_json,snapshot_hash FROM campaign_launches WHERE campaign_id=? ORDER BY version DESC LIMIT 1').get(campaignId);
  if (launch && (createHash('sha256').update(launch.snapshot_json).digest('hex') !== launch.snapshot_hash
    || launch.snapshot_hash !== currentSnapshot.snapshotHash)) {
    blockers.push({ code: 'launch_configuration_changed', message: 'Launched configuration has changed or failed its integrity check; no additional sends can be queued.' });
  }

  const audience = getAllCampaignAudienceRecipients(campaignId);
  if (!audience) throw new CampaignAudienceError('Campaign not found.', 404);
  const recipients = [];
  for (const item of audience) {
    let reason = item.eligibility;
    let statusForLaunch = reason === 'eligible' ? 'eligible'
      : ['out_of_office_deferred', 'out_of_office_review'].includes(reason) ? 'deferred' : 'blocked';
    let sequenceCopyHash = null;
    if (statusForLaunch === 'eligible' && firstStep && !sequenceBlocker) {
      const variant = selectCampaignStepVariant(campaignId, firstStep.id, item.lead_id);
      const preview = previewCampaignStep(campaignId, firstStep.id, item.lead_id, variant);
      if (!preview.ready) {
        statusForLaunch = 'blocked';
        reason = preview.missingContent?.length ? 'sequence_copy_missing' : 'sequence_merge_fields_missing';
      } else sequenceCopyHash = sha256Json([variant, preview.subject, preview.body]);
    }
    if (statusForLaunch === 'eligible' && !senders.some(sender => sender.available)) {
      statusForLaunch = 'blocked';
      reason = senders.length ? 'sender_unavailable' : 'sender_not_assigned';
    }
    if (statusForLaunch === 'eligible' && !['draft', 'active'].includes(status)) {
      statusForLaunch = 'blocked';
      reason = 'campaign_not_launchable';
    }
    if (statusForLaunch === 'eligible' && sequenceBlocker) {
      statusForLaunch = 'blocked';
      reason = sequenceBlocker.code;
    }
    recipients.push({
      contactId: item.lead_id,
      email: item.email,
      businessName: item.business_name,
      status: statusForLaunch,
      reason,
      sequenceCopyHash,
    });
  }

  const counts = recipients.reduce((acc, recipient) => {
    acc[recipient.status] += 1;
    acc.byReason[recipient.reason] = (acc.byReason[recipient.reason] || 0) + 1;
    return acc;
  }, { total: recipients.length, eligible: 0, blocked: 0, deferred: 0, byReason: {} });
  if (counts.eligible === 0 && !blockers.length) {
    blockers.push({ code: 'no_eligible_recipients', message: 'No enrolled recipients are currently eligible to queue.' });
  }
  const reviewBasis = {
    policyVersion: 1,
    campaignId,
    campaignStatus: status,
    snapshotHash: currentSnapshot.snapshotHash,
    launchIntegrity: launch ? createHash('sha256').update(launch.snapshot_json).digest('hex') === launch.snapshot_hash : null,
    complianceFingerprint: compliance.configurationFingerprint,
    sendWindowPolicy: config.send_window,
    pacingPolicy: config.jitter_ms,
    sendControl: { paused: sendControl.paused, updatedAt: sendControl.updatedAt, updatedBy: sendControl.updatedBy },
    senders,
    blockers: blockers.map(({ code }) => code),
    recipients,
  };
  return {
    campaignId,
    campaignName: campaign.name,
    campaignStatus: status,
    reviewedAt: new Date().toISOString(),
    reviewHash: sha256Json(reviewBasis),
    ready: blockers.length === 0 && counts.eligible > 0,
    blockers,
    compliance: {
      ready: compliance.ok,
      unsubscribeEndpointConfigured: compliance.unsubscribeEndpointConfigured,
      physicalAddressConfigured: compliance.physicalAddressConfigured,
    },
    sendControl: {
      paused: sendControl.paused,
      reason: sendControl.reason,
      updatedAt: sendControl.updatedAt,
    },
    sendPolicy: {
      sendWindow: { ...config.send_window },
      pacing: { minIntervalMs: config.jitter_ms.min, maxIntervalMs: config.jitter_ms.max },
    },
    schedule: getSendWindowState(new Date(), config.send_window),
    senders,
    counts,
    recipients,
    snapshotHash: currentSnapshot.snapshotHash,
  };
}

export function getCampaignPreflight(value) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  return campaignPreflightSnapshot(getDb(), campaignId);
}

function advanceSequenceAfterAcceptance(db, send, messageId) {
  if (!send.campaign_step_id) return { sequenced: false };
  const campaign = db.prepare('SELECT status FROM campaigns WHERE id=?').get(send.campaign_id);
  const enrollment = db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(send.campaign_id, send.lead_id);
  if (!campaign || ['stopped', 'archived', 'completed'].includes(campaign.status)) return { sequenced: true, stopped: true };
  if (!enrollment || enrollment.status !== 'active') return { sequenced: true, stopped: true };

  const currentStep = db.prepare('SELECT id,position FROM campaign_steps WHERE campaign_id=? AND id=?').get(send.campaign_id, send.campaign_step_id);
  if (!currentStep) {
    stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id, 'current_step_missing');
    return { sequenced: true, stopped: true };
  }
  const nextStep = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? AND position>? ORDER BY position LIMIT 1')
    .get(send.campaign_id, currentStep.position);
  if (!nextStep) {
    db.prepare("UPDATE campaign_enrollments SET status='completed' WHERE campaign_id=? AND lead_id=? AND status='active'")
      .run(send.campaign_id, send.lead_id);
    db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
      VALUES(?,?, 'campaign_sequence_completed',datetime('now'),?)`)
      .run(send.id, send.lead_id, JSON.stringify({ campaign_id: send.campaign_id, final_step_id: currentStep.id }));
    db.prepare(`UPDATE campaigns SET status='completed' WHERE id=? AND status='active'
      AND NOT EXISTS (SELECT 1 FROM campaign_enrollments WHERE campaign_id=? AND status='active')
      AND NOT EXISTS (SELECT 1 FROM sends WHERE campaign_id=? AND status IN ('scheduled','processing'))`)
      .run(send.campaign_id, send.campaign_id, send.campaign_id);
    return { sequenced: true, completed: true };
  }

  const policy = getCampaignRecipientPolicy(send.campaign_id, send.lead_id, { allowSent: true, ignoreOutOfOffice: true });
  if (policy.eligibility !== 'eligible' || policy.personalizationId !== send.personalization_id) {
    stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id, policy.eligibility === 'eligible' ? 'approved_copy_changed' : policy.eligibility);
    return { sequenced: true, stopped: true };
  }
  const sender = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(send.mailbox_id);
  const assigned = db.prepare('SELECT 1 FROM campaign_senders WHERE campaign_id=? AND mailbox_id=?').get(send.campaign_id, send.mailbox_id);
  if (!sender || !assigned || campaignSenderReadiness(sender) !== 'ready') {
    stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id, 'assigned_sender_unavailable');
    return { sequenced: true, stopped: true };
  }

  const variant = selectCampaignStepVariant(send.campaign_id, nextStep.id, send.lead_id);
  const preview = previewCampaignStep(send.campaign_id, nextStep.id, send.lead_id, variant);
  if (!preview.ready) {
    stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id,
      preview.missingContent.length ? `step_${nextStep.position}_copy_incomplete` : `step_${nextStep.position}_merge_fields_unresolved`);
    return { sequenced: true, stopped: true };
  }

  const priorMessageId = validThreadMessageId(messageId);
  const scheduled = db.prepare(`INSERT INTO sends(
      lead_id,mailbox_id,campaign_id,campaign_launch_id,personalization_id,campaign_step_id,variant,
      subject_snapshot,body_snapshot,in_reply_to_message_id,scheduled_at,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,datetime((SELECT sent_at FROM sends WHERE id=?),'+' || ? || ' days'),'scheduled')`)
    .run(send.lead_id, send.mailbox_id, send.campaign_id, send.campaign_launch_id, send.personalization_id, nextStep.id, variant,
      preview.subject, preview.body, priorMessageId, send.id, nextStep.delay_days);
  let oooHold = null;
  if (policy.deferManualReview) {
    db.prepare("UPDATE sends SET scheduled_at=NULL,error_message='Held for operator review after an out-of-office reply.' WHERE id=?")
      .run(Number(scheduled.lastInsertRowid));
    oooHold = 'manual_review';
  } else if (policy.deferUntil && db.prepare("SELECT julianday(?) > julianday('now') AS active").get(policy.deferUntil).active) {
    db.prepare(`UPDATE sends SET scheduled_at=CASE
        WHEN scheduled_at IS NULL OR julianday(scheduled_at)<julianday(?) THEN ? ELSE scheduled_at END,
      error_message='Deferred after out-of-office reply until the day after the stated return date.' WHERE id=?`)
      .run(policy.deferUntil, policy.deferUntil, Number(scheduled.lastInsertRowid));
    oooHold = policy.deferUntil;
  }
  db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
    VALUES(?,?, 'campaign_sequence_step_scheduled',datetime('now'),?)`)
    .run(Number(scheduled.lastInsertRowid), send.lead_id, JSON.stringify({
      campaign_id: send.campaign_id, previous_send_id: send.id, step_id: nextStep.id,
      position: nextStep.position, delay_days: nextStep.delay_days,
      threaded: Boolean(priorMessageId), out_of_office_hold: oooHold,
    }));
  if (oooHold) {
    db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
      VALUES(?,?,?,datetime('now'),?)`)
      .run(Number(scheduled.lastInsertRowid), send.lead_id,
        oooHold === 'manual_review' ? 'campaign_sequence_ooo_review_required' : 'campaign_sequence_deferred_ooo',
        JSON.stringify({ campaign_id: send.campaign_id, defer_until: oooHold === 'manual_review' ? null : oooHold }));
  }
  return { sequenced: true, nextSendId: Number(scheduled.lastInsertRowid), nextStepId: nextStep.id };
}

export async function queueSends(campaignId, options = {}) {
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  const { dryRun = false } = options;
  const db = getDb();
  if (!dryRun && (typeof options.reviewHash !== 'string' || !/^[a-f0-9]{64}$/i.test(options.reviewHash))) {
    throw new CampaignAudienceError('Review the current campaign preflight before queueing sends.', 428);
  }

  return db.transaction(() => {
  if (!dryRun) {
    const preflight = campaignPreflightSnapshot(db, Number(campaignId));
    if (preflight.reviewHash !== options.reviewHash.toLowerCase()) {
      throw new CampaignAudienceError('Campaign or recipient readiness changed after review. Refresh preflight before queueing; no sends were queued.', 409);
    }
    const blocker = preflight.blockers.find(item => [
      'https_unsubscribe_endpoint_not_configured',
      'physical_mailing_address_not_configured',
      'workspace_send_paused',
    ].includes(item.code));
    if (blocker) throw new CampaignAudienceError(`Campaign preflight is blocked: ${blocker.message}`, 409);
  }
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
  const campaignStatus = getEffectiveCampaignStatus(db, campaign);
  if (!['draft', 'active'].includes(campaignStatus)) {
    throw new CampaignAudienceError(`Campaign is ${campaignStatus}; resume it before queueing sends.`, 409);
  }
  const sequenceSteps = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? ORDER BY position,id').all(campaignId);
  const firstStep = sequenceSteps[0] || null;
  if (firstStep) {
    const activeVariants = db.prepare(`SELECT variant_key,allocation_pct,subject_line,body_text
      FROM campaign_step_variants WHERE step_id=? AND allocation_pct > 0 ORDER BY variant_key`).all(firstStep.id);
    if (!activeVariants.length || activeVariants.reduce((sum, variant) => sum + variant.allocation_pct, 0) !== 100) {
      throw new CampaignAudienceError('The first sequence step needs active copy variants whose allocations total 100%.', 409);
    }
    const emptyVariant = activeVariants.find(variant => !variant.subject_line?.trim() || !variant.body_text?.trim());
    if (emptyVariant) throw new CampaignAudienceError(`First-step variant ${emptyVariant.variant_key} needs a subject and body before queueing.`, 409);
  }
  const senderIds = db.prepare('SELECT mailbox_id FROM campaign_senders WHERE campaign_id=? ORDER BY mailbox_id').all(campaignId).map(row => row.mailbox_id);
  if (!senderIds.length) throw new CampaignAudienceError('Choose at least one eligible sender mailbox for this campaign before queueing.', 409);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new CampaignAudienceError('limit must be an integer from 1 to 500.');

  const leads = getQueueEligibleCampaignRecipients(campaignId, limit);

  const queued = [];
  const skipped = [];

  for (const lead of leads) {
    const mailbox = selectMailbox(senderIds);
    if (!mailbox) {
      skipped.push({ leadId: lead.id, email: lead.email, reason: 'no_assigned_sender_available' });
      continue;
    }

    const config = getOperationalSendConfig(db);
    const jitterMs = config.jitter_ms.min + Math.random() * (config.jitter_ms.max - config.jitter_ms.min);
    const targetSendTime = new Date(Date.now() + queued.length * jitterMs);
    const scheduledAt = nextAllowedSendTime(targetSendTime, config.send_window).toISOString();
    const variant = firstStep
      ? selectCampaignStepVariant(campaignId, firstStep.id, lead.id)
      : lead.subject_variant || lead.body_variant || 'A';
    const preview = firstStep ? previewCampaignStep(campaignId, firstStep.id, lead.id, variant) : null;
    if (preview && !preview.ready) {
      skipped.push({ leadId: lead.id, email: lead.email, reason: preview.missingContent.length ? `sequence_${preview.missingContent.join('_')}_missing` : `sequence_merge_fields_missing:${preview.unresolvedTokens.join(',')}` });
      continue;
    }

    if (!dryRun) {
      const queuedSend = db.transaction(() => {
        const currentCampaign = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId);
        if (!currentCampaign) throw new CampaignAudienceError('Campaign not found.', 404);
        const currentFirstStep = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? ORDER BY position,id LIMIT 1').get(campaignId);
        if (Boolean(currentFirstStep) !== Boolean(firstStep) || (firstStep && currentFirstStep.id !== firstStep.id)) {
          throw new CampaignAudienceError('The campaign sequence changed while queueing. Review it and try again.', 409);
        }
        const currentStatus = getEffectiveCampaignStatus(db, currentCampaign);
        if (!['draft', 'active'].includes(currentStatus)) {
          throw new CampaignAudienceError(`Campaign is ${currentStatus}; resume it before queueing sends.`, 409);
        }
        const senderStillAssigned = db.prepare('SELECT 1 FROM campaign_senders WHERE campaign_id=? AND mailbox_id=?').get(campaignId, mailbox.id);
        const currentMailbox = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(mailbox.id);
        if (!senderStillAssigned || !currentMailbox || campaignSenderReadiness(currentMailbox) !== 'ready') {
          return { skipped: 'assigned_sender_became_unavailable' };
        }
        const policy = getCampaignRecipientPolicy(campaignId, lead.id);
        if (policy.eligibility !== 'eligible' || policy.personalizationId !== lead.personalization_id) {
          return { skipped: policy.eligibility === 'eligible' ? 'copy_changed_after_queue' : policy.eligibility };
        }
        const existing = firstStep
          ? db.prepare('SELECT status FROM sends WHERE lead_id=? AND campaign_id=? LIMIT 1').get(lead.id, campaignId)
          : db.prepare('SELECT status FROM sends WHERE lead_id = ? AND campaign_id = ? AND status IN (?, ?, ?, ?) LIMIT 1')
            .get(lead.id, campaignId, 'sent', 'scheduled', 'processing', 'uncertain');
        if (existing) return { skipped: existing.status === 'sent' ? 'already_sent' : existing.status === 'uncertain' ? 'submission_uncertain' : 'already_queued' };
        const currentPreview = firstStep ? previewCampaignStep(campaignId, currentFirstStep.id, lead.id, variant) : null;
        if (currentPreview && !currentPreview.ready) return { skipped: 'sequence_copy_changed_or_unresolved' };
        if (currentPreview && currentPreview.variantKey !== variant) return { skipped: 'sequence_variant_changed_after_queue' };
        const launch = getOrCreateCampaignLaunch(db, campaignId);
        const result = db.prepare(`
          INSERT INTO sends (lead_id, mailbox_id, campaign_id, campaign_launch_id, personalization_id, campaign_step_id,
            variant, subject_snapshot, body_snapshot, scheduled_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
        `).run(lead.id, mailbox.id, campaignId, launch.id, lead.personalization_id, firstStep?.id || null,
          variant, currentPreview?.subject ?? lead.subject_line ?? null,
          currentPreview?.body ?? lead.body_text ?? null, scheduledAt);
        db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaignId);
        db.prepare("UPDATE leads SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(lead.id);
        return { sendId: result.lastInsertRowid, preview: currentPreview };
      })();
      if (queuedSend.skipped) {
        skipped.push({ leadId: lead.id, email: lead.email, reason: queuedSend.skipped });
        continue;
      }

      queued.push({
        sendId: queuedSend.sendId,
        leadId: lead.id,
        email: lead.email,
        mailboxId: mailbox.id,
        mailboxEmail: mailbox.email,
        variant,
        scheduledAt,
        ...(firstStep ? { stepId: firstStep.id, sequencePosition: firstStep.position } : {}),
      });
    } else {
      queued.push({ leadId: lead.id, email: lead.email, mailbox: mailbox.email, variant, scheduledAt });
    }
  }

  return { campaignId, queued: queued.length, skipped: skipped.length, queuedList: queued, skippedList: skipped };
  })();
}

export async function processSendQueue(options = {}) {
  const { limit = 50 } = options;
  const db = getDb();

  const initialControl = readSendControlRow(db);
  if (initialControl.paused) {
    return { processed: 0, sent: 0, failed: 0, uncertain: 0, blocked: 0, sendPaused: true, pauseReason: initialControl.reason };
  }

  if (_sendState.active) return { processed: 0, sent: 0, failed: 0, uncertain: 0, blocked: 0, alreadyProcessing: true };

  const pending = db.prepare(`
    SELECT s.*, l.email as recipient_email, l.business_name,
      m.email as from_email, m.domain as from_domain, m.from_name,
      m.smtp_host, m.smtp_port, m.smtp_user, m.smtp_pass, m.smtp_secure,
      COALESCE(s.subject_snapshot,p.subject_line) AS subject_line,
      COALESCE(s.body_snapshot,p.body_text) AS body_text, c.status AS campaign_status
    FROM sends s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN leads l ON s.lead_id = l.id
    JOIN mailboxes m ON s.mailbox_id = m.id
    JOIN personalizations p ON s.personalization_id = p.id
    WHERE s.status = 'scheduled'
    AND julianday(s.scheduled_at) <= julianday('now')
    AND COALESCE(c.status, 'draft') NOT IN ('paused', 'stopped', 'completed', 'archived')
    ORDER BY s.scheduled_at
    LIMIT ?
  `).all(limit);

  if (pending.length === 0) return { processed: 0 };

  _sendState = {
    active: true,
    campaignId: pending[0]?.campaign_id,
    processed: 0,
    total: pending.length,
    currentLead: null,
    cancelling: false,
    startedAt: new Date().toISOString(),
    errors: [],
  };

  const claimSend = db.prepare("UPDATE sends SET status = 'processing' WHERE id = ? AND status = 'scheduled' AND julianday(scheduled_at) <= julianday('now')");
  const settleSend = db.prepare("UPDATE sends SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END, error_message = ? WHERE id = ? AND status = 'processing'");
  const cancelClaimed = db.prepare("UPDATE sends SET status = 'cancelled', sent_at = NULL, error_message = ? WHERE id = ? AND status = 'processing'");
  const insertEvent = db.prepare("INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json) VALUES (?, ?, ?, datetime('now'), ?)");
  const updateLead = db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('queued','awaiting_approval')");

  let sentCount = 0;
  let failCount = 0;
  let uncertainCount = 0;
  let blockedCount = 0;
  let deferredCount = 0;

  for (const send of pending) {
    if (_sendState.cancelling) break;

    _sendState.currentLead = send.business_name;

    let claimed = false;
    try {
      const claimResult = db.transaction(() => {
        if (readSendControlRow(db).paused) return 'workspace_send_paused';
        const sendConfig = getOperationalSendConfig(db);
        const campaignStatus = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(send.campaign_id)?.status;
        if (['paused', 'stopped', 'completed', 'archived'].includes(campaignStatus)) return 'campaign_blocked';
        if (!isWithinSendWindow(new Date(), sendConfig.send_window)) {
          const nextAllowedAt = nextAllowedSendTime(new Date(), sendConfig.send_window).toISOString();
          const deferred = db.prepare(`UPDATE sends SET scheduled_at=?,error_message='Deferred until the configured send window opens.'
            WHERE id=? AND status='scheduled'`).run(nextAllowedAt, send.id).changes;
          if (deferred) insertEvent.run(send.id, send.lead_id, 'send_deferred', JSON.stringify({
            reason: 'outside_configured_send_window', nextDueAt: nextAllowedAt,
            timezone: sendConfig.send_window.timezone,
          }));
          return deferred ? 'window_deferred' : 'claim_lost';
        }
        if (!sendContentMatchesLaunch(db, send)) {
          const changed = db.prepare(`UPDATE sends SET status='cancelled',sent_at=NULL,
            error_message='Campaign configuration changed after launch; blocked before SMTP.'
            WHERE id=? AND status='scheduled'`).run(send.id).changes;
          if (changed) {
            insertEvent.run(send.id, send.lead_id, 'campaign_launch_configuration_mismatch', JSON.stringify({
              campaign_id: send.campaign_id, launch_id: send.campaign_launch_id, stage: 'pre_smtp_launch_snapshot_gate',
            }));
            if (send.campaign_step_id) stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id, 'launch_configuration_changed');
          }
          return changed ? 'launch_blocked' : 'claim_lost';
        }
        if (claimSend.run(send.id).changes !== 1) return 'claim_lost';
        if (send.campaign_step_id) {
          const ooo = db.prepare(`SELECT defer_until,defer_manual_review FROM campaign_enrollments
            WHERE campaign_id=? AND lead_id=? AND status='active'`).get(send.campaign_id, send.lead_id);
          if (ooo?.defer_manual_review) {
            db.prepare("UPDATE sends SET status='scheduled',scheduled_at=NULL,error_message='Held for operator review after an out-of-office reply.' WHERE id=? AND status='processing'").run(send.id);
            insertEvent.run(send.id, send.lead_id, 'send_deferred', JSON.stringify({ reason: 'out_of_office_manual_review' }));
            return 'ooo_deferred';
          }
          const activeOoo = ooo?.defer_until
            ? db.prepare("SELECT julianday(?) > julianday('now') AS active").get(ooo.defer_until).active
            : false;
          if (activeOoo) {
            db.prepare("UPDATE sends SET status='scheduled',scheduled_at=?,error_message='Deferred after out-of-office reply until the day after the stated return date.' WHERE id=? AND status='processing'")
              .run(ooo.defer_until, send.id);
            insertEvent.run(send.id, send.lead_id, 'send_deferred', JSON.stringify({ reason: 'out_of_office_return_date', defer_until: ooo.defer_until }));
            return 'ooo_deferred';
          }
          const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id=?').get(send.mailbox_id);
          const assigned = db.prepare('SELECT 1 FROM campaign_senders WHERE campaign_id=? AND mailbox_id=?').get(send.campaign_id, send.mailbox_id);
          const readiness = mailbox ? campaignSenderReadiness(mailbox, sendConfig) : 'missing';
          if (!assigned || readiness !== 'ready') {
            cancelClaimed.run(`Blocked before SMTP: assigned sender unavailable (${readiness}).`, send.id);
            stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id, 'assigned_sender_unavailable');
            insertEvent.run(send.id, send.lead_id, 'send_blocked', JSON.stringify({ reason: 'assigned_sender_unavailable', readiness, stage: 'sequence_sender_gate' }));
            return 'blocked';
          }
        }
        const policy = getCampaignRecipientPolicy(send.campaign_id, send.lead_id, { allowSent: Boolean(send.campaign_step_id) });
        const prior = send.campaign_step_id
          ? db.prepare(`SELECT id,status FROM sends WHERE campaign_id=? AND lead_id=? AND id!=?
              AND (status='uncertain' OR status IN ('scheduled','processing')
                OR (campaign_step_id IS NULL AND status='sent')
                OR (campaign_step_id=? AND status='sent'))
              ORDER BY id LIMIT 1`).get(send.campaign_id, send.lead_id, send.id, send.campaign_step_id)
          : db.prepare(`SELECT id,status FROM sends WHERE campaign_id=? AND lead_id=? AND id!=?
              AND (status IN ('sent','uncertain') OR (status IN ('scheduled','processing') AND id<?))
              ORDER BY id LIMIT 1`).get(send.campaign_id, send.lead_id, send.id, send.id);
        if (policy.eligibility !== 'eligible' || policy.personalizationId !== send.personalization_id || prior) {
          const reason = policy.eligibility !== 'eligible'
            ? policy.eligibility
            : policy.personalizationId !== send.personalization_id ? 'copy_changed_after_queue' : 'duplicate_campaign_send';
          cancelClaimed.run(`Blocked before SMTP: ${reason}`, send.id);
          insertEvent.run(send.id, send.lead_id, 'send_blocked', JSON.stringify({ reason, stage: 'atomic_pre_smtp_policy_gate' }));
          if (send.campaign_step_id) stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id, reason);
          return 'blocked';
        }
        const nextAllowed = db.prepare('SELECT next_allowed_at FROM mailbox_send_pacing WHERE mailbox_id=?').get(send.mailbox_id);
        if (nextAllowed && db.prepare("SELECT julianday(?) > julianday('now') AS active").get(nextAllowed.next_allowed_at).active) {
          db.prepare(`UPDATE sends SET status='scheduled',scheduled_at=?,
            error_message='Deferred to preserve the assigned sender pacing interval.'
            WHERE id=? AND status='processing'`).run(nextAllowed.next_allowed_at, send.id);
          insertEvent.run(send.id, send.lead_id, 'send_deferred', JSON.stringify({
            reason: 'sender_pacing_interval', nextDueAt: nextAllowed.next_allowed_at, mailbox_id: send.mailbox_id,
          }));
          return 'pacing_deferred';
        }
        const capacity = reserveDailyCapacity(db, send);
        if (!capacity.ok) {
          const nextDueAt = db.prepare("SELECT datetime('now','start of day','+1 day') AS value").get().value;
          db.prepare(`UPDATE sends SET status='scheduled',scheduled_at=?,
            error_message='Deferred because the assigned mailbox or domain reached its daily send limit.'
            WHERE id=? AND status='processing'`).run(nextDueAt, send.id);
          insertEvent.run(send.id, send.lead_id, 'send_deferred', JSON.stringify({
            reason: capacity.reason,
            retry_after: nextDueAt,
            mailbox_id: send.mailbox_id,
          }));
          return 'capacity_deferred';
        }
        const pacingDelay = sendConfig.jitter_ms.min + Math.random() * (sendConfig.jitter_ms.max - sendConfig.jitter_ms.min);
        const pacingDueAt = new Date(Date.now() + pacingDelay).toISOString();
        db.prepare(`INSERT INTO mailbox_send_pacing(mailbox_id,next_allowed_at,last_send_id,updated_at)
          VALUES(?,?,?,datetime('now')) ON CONFLICT(mailbox_id) DO UPDATE SET
          next_allowed_at=excluded.next_allowed_at,last_send_id=excluded.last_send_id,updated_at=excluded.updated_at`)
          .run(send.mailbox_id, pacingDueAt, send.id);
        return 'claimed';
      })();
      if (claimResult === 'workspace_send_paused') {
        _sendState.processed++;
        break;
      }
      if (claimResult === 'campaign_blocked' || claimResult === 'claim_lost') {
        _sendState.processed++;
        continue;
      }
      if (claimResult === 'blocked' || claimResult === 'launch_blocked') {
        blockedCount++;
        _sendState.processed++;
        continue;
      }
      if (claimResult === 'capacity_deferred') {
        deferredCount++;
        _sendState.processed++;
        continue;
      }
      if (claimResult === 'pacing_deferred') {
        deferredCount++;
        _sendState.processed++;
        continue;
      }
      if (claimResult === 'ooo_deferred') {
        deferredCount++;
        _sendState.processed++;
        continue;
      }
      if (claimResult === 'window_deferred') {
        deferredCount++;
        _sendState.processed++;
        continue;
      }
      claimed = true;

      const settings = inspectSmtpSettings(send);
      if (settings.ok) {
        const compliance = buildComplianceEnvelope(send.recipient_email, send.lead_id, send.from_domain, send.id);
        if (!compliance.ok) {
          const reason = compliance.blockers[0] || 'campaign_compliance_not_ready';
          db.transaction(() => {
            cancelClaimed.run(`Blocked before SMTP: ${reason}`, send.id);
            db.prepare("UPDATE send_capacity_reservations SET state='released',updated_at=datetime('now') WHERE send_id=? AND state='reserved'").run(send.id);
            insertEvent.run(send.id, send.lead_id, 'send_blocked', JSON.stringify({ reason, stage: 'atomic_pre_smtp_compliance_gate' }));
          })();
          claimed = false;
          blockedCount++;
          _sendState.processed++;
          continue;
        }
        const transporter = createMailboxTransporter(settings);
        const fromName = send.from_name || 'Outreach';
        const pausedBeforeTransport = db.transaction(() => {
          const control = readSendControlRow(db);
          if (!control.paused) return false;
          const released = db.prepare(`UPDATE sends SET status='scheduled',sent_at=NULL,
            error_message='Held by the workspace-wide send pause.' WHERE id=? AND status='processing'`).run(send.id).changes;
          if (released) {
            db.prepare("UPDATE send_capacity_reservations SET state='released',updated_at=datetime('now') WHERE send_id=? AND state='reserved'").run(send.id);
            insertEvent.run(send.id, send.lead_id, 'send_deferred', JSON.stringify({
              reason: 'workspace_send_paused', pauseReason: control.reason,
            }));
          }
          return released === 1;
        })();
        if (pausedBeforeTransport) {
          claimed = false;
          deferredCount++;
          _sendState.processed++;
          continue;
        }
        inFlightSends.set(send.id, send.campaign_id);
        let info;
        const headers = compliance.headers;
        const threadId = validThreadMessageId(send.in_reply_to_message_id);
        if (threadId) {
          headers['In-Reply-To'] = threadId;
          headers.References = threadId;
        }
        try {
          info = await transporter.sendMail({
            from: `"${fromName}" <${send.from_email}>`,
            to: send.recipient_email,
            subject: send.subject_line,
            text: `${send.body_text}${compliance.textFooter}`,
            headers,
          });
        } finally {
          inFlightSends.delete(send.id);
        }

        if (!info.accepted?.length || info.rejected?.length) {
          const error = new Error('SMTP did not accept the recipient');
          error.smtpNotAccepted = true;
          error.response = info.response;
          throw error;
        }
        db.transaction(() => {
          if (settleSend.run('sent', 'sent', null, send.id).changes !== 1) {
            throw new Error('SMTP accepted the message, but its claimed send state changed before acceptance could be stored.');
          }
          const capacityAccepted = db.prepare("UPDATE send_capacity_reservations SET state='accepted',updated_at=datetime('now') WHERE send_id=? AND state='reserved'").run(send.id).changes;
          if (capacityAccepted !== 1) throw new Error('SMTP accepted the message, but its daily capacity reservation could not be finalized.');
          insertEvent.run(send.id, send.lead_id, 'sent', JSON.stringify({
            from: send.from_email,
            to: send.recipient_email,
            subject: send.subject_line,
            variant: send.variant,
            messageId: info.messageId,
            response: info.response,
            delivery: 'unknown',
          }));
          updateLead.run('sent', send.lead_id);
          advanceSequenceAfterAcceptance(db, send, info.messageId);
        })();
        claimed = false;
        sentCount++;
      } else {
        const err = new Error(settings.error);
        err.code = settings.code;
        throw err;
      }
    } catch (err) {
      if (claimed) {
        const knownNoAcceptance = err.smtpNotAccepted === true
          || (Number(err.responseCode) >= 400 && Number(err.responseCode) <= 599)
          || /^SMTP_(NOT_CONFIGURED|INCOMPLETE_CONFIG|INVALID_CONFIG)$/.test(err.code || '')
          || (err.code === 'EAUTH' && err.command === 'AUTH');
        const status = knownNoAcceptance ? 'failed' : 'uncertain';
        const eventType = status === 'uncertain' ? 'send_submission_uncertain' : 'send_failed';
        const recorded = db.transaction(() => {
          if (settleSend.run(status, status, err.message, send.id).changes !== 1) return false;
          db.prepare(`UPDATE send_capacity_reservations SET state=?,updated_at=datetime('now')
            WHERE send_id=? AND state='reserved'`).run(status === 'uncertain' ? 'uncertain' : 'released', send.id);
          insertEvent.run(send.id, send.lead_id, eventType, JSON.stringify({
            code: err.code || 'SMTP_SEND_FAILED',
            error: err.message,
            stage: err.command || null,
            retry_policy: status === 'uncertain' ? 'quarantined_no_automatic_resend' : 'known_not_accepted',
          }));
          if (send.campaign_step_id) stopSequenceEnrollment(db, send.campaign_id, send.lead_id, send.id,
            status === 'uncertain' ? 'smtp_outcome_uncertain' : 'smtp_not_accepted');
          return true;
        })();
        if (recorded) {
          claimed = false;
          if (status === 'uncertain') uncertainCount++;
          else failCount++;
        }
      } else {
        failCount++;
      }
      _sendState.errors.push({ sendId: send.id, error: err.message });
    }

    _sendState.processed++;
  }

  _sendState.active = false;
  _sendState.currentLead = null;

  const autoPaused = checkAutoThresholds();

  return {
    processed: _sendState.processed,
    sent: sentCount,
    failed: failCount,
    uncertain: uncertainCount,
    blocked: blockedCount,
    deferred: deferredCount,
    autoPaused,
    cancelled: _sendState.cancelling,
  };
}

/**
 * A worker restart leaves claimed rows with no trustworthy SMTP outcome.
 * Quarantine them instead of letting another worker submit them again.
 */
export function recoverInterruptedSends() {
  const db = getDb();
  return db.transaction(() => {
    const interrupted = db.prepare("SELECT id,lead_id,campaign_id FROM sends WHERE status = 'processing'").all();
    const quarantine = db.prepare("UPDATE sends SET status = 'uncertain', sent_at = NULL, error_message = 'Worker restarted before the SMTP outcome was recorded.' WHERE id = ? AND status = 'processing'");
    const event = db.prepare("INSERT INTO events (send_id,lead_id,event_type,event_at,meta_json) VALUES (?,?, 'send_submission_uncertain',datetime('now'),?)");
    let recovered = 0;
    for (const send of interrupted) {
      if (!quarantine.run(send.id).changes) continue;
      event.run(send.id, send.lead_id, JSON.stringify({
        campaign_id: send.campaign_id,
        reason: 'worker_restarted_during_submission',
        retry_policy: 'quarantined_no_automatic_resend',
      }));
      db.prepare("UPDATE send_capacity_reservations SET state='uncertain',updated_at=datetime('now') WHERE send_id=? AND state='reserved'")
        .run(send.id);
      recovered++;
    }
    return { recovered, sendIds: interrupted.map(send => send.id) };
  })();
}

// ══════════════════════════════════════════════════════════════
//  MAILBOX CRUD & MANAGEMENT
// ══════════════════════════════════════════════════════════════

export async function addMailbox(data) {
  const db = getDb();
  const email = data.email.trim();
  const domain = email.split('@')[1];
  const provider = data.provider || 'smtp';
  const fromName = data.from_name || null;
  const smtpHost = data.smtp_host || (provider === 'gmail' ? 'smtp.gmail.com' : provider === 'outlook' ? 'smtp.office365.com' : `smtp.${domain}`);
  const smtpPort = parseInt(data.smtp_port) || (provider === 'gmail' ? 465 : 587);
  const smtpUser = data.smtp_user ? String(data.smtp_user).trim() : null;
  const smtpPass = data.smtp_pass ? encryptCredential(data.smtp_pass) : null;
  const smtpSecure = data.smtp_secure != null ? (data.smtp_secure ? 1 : 0) : (smtpPort === 465 ? 1 : 0);
  const dailyLimit = parseInt(data.daily_limit) || 0;

  // Run initial real DNS check in background
  const dnsCheck = await checkDomainDns(domain).catch(() => ({
    spf_ok: 0, dkim_ok: null, dkim_status: 'unknown', dkim_key_status: 'unavailable', dmarc_ok: 0,
    blacklisted: null, domain_blacklisted: null, blacklist_status: 'unavailable', domain_dnsbl_status: 'unavailable',
    dnsbl_subject_type: 'domain_apex_ipv4', dnsbl_checks: [],
    dnsbl_status: 'unavailable', sender_ip: null, sender_ip_status: 'unknown', sender_reputation_status: 'unknown',
  }));

  // Insert or update domain record
  db.prepare(`
    INSERT OR REPLACE INTO domains (domain, spf_ok, dkim_ok, dkim_status, dmarc_ok, blacklisted, blacklist_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(domain, dnsCheck.spf_ok, dnsCheck.dkim_ok, dnsCheck.dkim_status || 'unknown', dnsCheck.dmarc_ok, dnsCheck.domain_blacklisted, dnsCheck.blacklist_status || 'unavailable');

  const result = db.prepare(`
    INSERT INTO mailboxes (
      email, domain, provider, from_name,
      smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure,
      warmup_status, warmup_started_at, daily_limit, health_score, active,
      spf_ok, dkim_ok, dkim_status, dmarc_ok, blacklisted, blacklist_status, dns_checked_at, dns_records_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'warming', datetime('now'), ?, 100, 1, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    email, domain, provider, fromName,
    smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure,
    dailyLimit,
    dnsCheck.spf_ok, dnsCheck.dkim_ok, dnsCheck.dkim_status || 'unknown', dnsCheck.dmarc_ok, dnsCheck.blacklisted, dnsCheck.blacklist_status || 'unavailable',
    JSON.stringify(dnsCheck)
  );

  return {
    id: result.lastInsertRowid,
    email,
    domain,
    provider,
    warmup_status: 'warming',
    health_score: 100,
    ...dnsCheck,
  };
}

function normalizeImapAliases(value, mailboxEmail, mailboxId, db) {
  let candidates;
  if (Array.isArray(value)) candidates = value;
  else if (typeof value === 'string') candidates = value.split(/[;,\r\n]+/).map(item => item.trim()).filter(Boolean);
  else if (value === null) candidates = [];
  else throw new CampaignAudienceError('IMAP aliases must be a list of email addresses.', 400);
  if (candidates.length > 20) throw new CampaignAudienceError('A mailbox can have at most 20 IMAP aliases.', 400);
  const aliases = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') throw new CampaignAudienceError('IMAP aliases must be email addresses.', 400);
    const email = candidate.trim().toLowerCase();
    if (email.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
      throw new CampaignAudienceError('Enter valid email addresses for IMAP aliases.', 400);
    }
    if (email === String(mailboxEmail || '').trim().toLowerCase()) {
      throw new CampaignAudienceError('The primary mailbox address is already included; do not add it as an alias.', 400);
    }
    if (!aliases.includes(email)) aliases.push(email);
  }
  const otherMailboxes = db.prepare('SELECT id,email,imap_aliases_json FROM mailboxes WHERE id<>?').all(mailboxId);
  for (const other of otherMailboxes) {
    let assigned = [];
    try { assigned = JSON.parse(other.imap_aliases_json || '[]'); } catch { /* Ignore malformed legacy metadata while preserving it. */ }
    const addresses = [String(other.email || '').trim().toLowerCase(), ...(Array.isArray(assigned) ? assigned.map(item => String(item).trim().toLowerCase()) : [])];
    if (aliases.some(alias => addresses.includes(alias))) {
      throw new CampaignAudienceError('An IMAP alias is already assigned to another mailbox.', 409);
    }
  }
  return aliases;
}

export function updateMailbox(id, data) {
  const db = getDb();
  if (data.from_name !== undefined) {
    const mailbox = db.prepare('SELECT from_name FROM mailboxes WHERE id=?').get(id);
    if (!mailbox) throw new CampaignAudienceError(`Mailbox #${id} not found.`, 404);
    const senderIdentityIsLaunched = db.prepare(`SELECT 1 FROM campaign_senders cs
      JOIN campaign_launches cl ON cl.campaign_id=cs.campaign_id
      WHERE cs.mailbox_id=? LIMIT 1`).get(id);
    if (senderIdentityIsLaunched && data.from_name !== mailbox.from_name) {
      throw new CampaignAudienceError('Sender display identity is locked by an immutable campaign launch. Retire this mailbox and choose another for a new campaign.', 409);
    }
  }
  const fields = [];
  const vals = [];

  if (data.daily_limit !== undefined) { fields.push('daily_limit = ?'); vals.push(parseInt(data.daily_limit)); }
  if (data.from_name !== undefined)   { fields.push('from_name = ?'); vals.push(data.from_name); }
  if (data.smtp_host !== undefined)   { fields.push('smtp_host = ?'); vals.push(data.smtp_host); }
  if (data.smtp_port !== undefined)   { fields.push('smtp_port = ?'); vals.push(parseInt(data.smtp_port)); }
  if (data.smtp_user !== undefined)   { fields.push('smtp_user = ?'); vals.push(data.smtp_user); }
  if (data.smtp_pass !== undefined)   { fields.push('smtp_pass = ?'); vals.push(data.smtp_pass ? encryptCredential(data.smtp_pass) : null); }
  if (data.smtp_secure !== undefined) { fields.push('smtp_secure = ?'); vals.push(data.smtp_secure ? 1 : 0); }
  if (data.imap_host !== undefined) {
    const host = typeof data.imap_host === 'string' ? data.imap_host.trim() : '';
    if (host.length > 253 || /[\s\r\n/@]/.test(host)) throw new CampaignAudienceError('IMAP host must be a hostname or IP address.', 400);
    fields.push('imap_host = ?'); vals.push(host || null);
  }
  if (data.imap_port !== undefined) {
    const port = Number(data.imap_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CampaignAudienceError('IMAP port must be an integer from 1 to 65535.', 400);
    fields.push('imap_port = ?'); vals.push(port);
  }
  if (data.imap_user !== undefined) {
    const user = typeof data.imap_user === 'string' ? data.imap_user.trim() : '';
    if (user.length > 254 || /[\r\n\0]/.test(user)) throw new CampaignAudienceError('IMAP username is invalid.', 400);
    fields.push('imap_user = ?'); vals.push(user || null);
  }
  if (data.imap_pass !== undefined) {
    const pass = typeof data.imap_pass === 'string' ? data.imap_pass : '';
    if (pass.length > 4096 || /[\r\n\0]/.test(pass)) throw new CampaignAudienceError('IMAP password is invalid.', 400);
    fields.push('imap_pass = ?'); vals.push(pass ? encryptCredential(pass) : null);
  }
  if (data.imap_secure !== undefined) {
    if (![true, false, 0, 1].includes(data.imap_secure)) throw new CampaignAudienceError('Choose implicit TLS or required STARTTLS.', 400);
    fields.push('imap_secure = ?'); vals.push(data.imap_secure ? 1 : 0);
  }
  if (data.imap_aliases !== undefined) {
    const mailbox = db.prepare('SELECT email FROM mailboxes WHERE id=?').get(id);
    if (!mailbox) throw new CampaignAudienceError(`Mailbox #${id} not found.`, 404);
    const aliases = normalizeImapAliases(data.imap_aliases, mailbox.email, id, db);
    fields.push('imap_aliases_json = ?'); vals.push(JSON.stringify(aliases));
  }
  if (data.warmup_status !== undefined){ fields.push('warmup_status = ?'); vals.push(data.warmup_status); }

  if (fields.length === 0) return { id, updated: false };

  vals.push(id);
  db.prepare(`UPDATE mailboxes SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return { id, updated: true };
}

export function pauseMailbox(id) {
  const db = getDb();
  db.prepare("UPDATE mailboxes SET warmup_status = 'paused', daily_limit = 0 WHERE id = ?").run(id);
  return { id, status: 'paused' };
}

export function activateMailbox(id) {
  const db = getDb();
  const mb = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
  if (!mb) throw new Error(`Mailbox #${id} not found`);

  db.prepare("UPDATE mailboxes SET warmup_status = 'warming', warmup_started_at = datetime('now') WHERE id = ?").run(id);
  return { id, status: 'warming' };
}

export function retireMailbox(id) {
  const db = getDb();
  db.prepare("UPDATE mailboxes SET warmup_status = 'retired', active = 0, daily_limit = 0 WHERE id = ?").run(id);
  return { id, status: 'retired' };
}

export function deleteMailbox(id) {
  const db = getDb();
  const tx = db.transaction(() => {
    const launched = db.prepare(`SELECT 1 FROM campaign_senders cs
      JOIN campaign_launches cl ON cl.campaign_id=cs.campaign_id
      WHERE cs.mailbox_id=? LIMIT 1`).get(id);
    if (launched) {
      throw new CampaignAudienceError('This mailbox is part of an immutable campaign launch. Retire it to preserve sender and send history.', 409);
    }
    db.prepare('UPDATE sends SET mailbox_id = NULL WHERE mailbox_id = ?').run(id);
    db.prepare('DELETE FROM mailboxes WHERE id = ?').run(id);
  });
  tx();
  return { id, deleted: true };
}

// ══════════════════════════════════════════════════════════════
//  CAMPAIGN CRUD & QUERY HELPERS
// ══════════════════════════════════════════════════════════════

export function createCampaign(data) {
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  if (!name) throw new CampaignAudienceError('Campaign name is required.');
  if (name.length > 200) throw new CampaignAudienceError('Campaign names must be 200 characters or fewer.');
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO campaigns (name, sequence_step, template_ref)
    VALUES (?, ?, ?)
  `).run(name, data.sequence_step || 1, data.template_ref || null);

  return { id: result.lastInsertRowid, name };
}

export function updateCampaignDraft(value, nameValue) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const name = typeof nameValue === 'string' ? nameValue.trim() : '';
  if (!name) throw new CampaignAudienceError('Campaign name is required.');
  if (name.length > 200) throw new CampaignAudienceError('Campaign names must be 200 characters or fewer.');
  const db = getDb();
  return db.transaction(() => {
    const campaign = db.prepare('SELECT id,name,status FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    const sends = db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count;
    if (campaign.status !== 'draft' || sends) throw new CampaignAudienceError('Only a draft campaign with no send history can be edited.', 409);
    if (campaign.name === name) return { id: campaignId, name, changed: false };
    db.prepare('UPDATE campaigns SET name=? WHERE id=?').run(name, campaignId);
    db.prepare(`INSERT INTO events(event_type,event_at,meta_json) VALUES ('campaign_renamed',datetime('now'),?)`)
      .run(JSON.stringify({ campaign_id: campaignId, old_name: campaign.name, new_name: name }));
    return { id: campaignId, name, changed: true };
  })();
}

export function archiveCampaignDraft(value, archived = true) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const db = getDb();
  return db.transaction(() => {
    const campaign = db.prepare('SELECT id,name,status FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    const expected = archived ? 'draft' : 'archived';
    const next = archived ? 'archived' : 'draft';
    if (campaign.status === next) return { id: campaignId, status: next, changed: false };
    if (campaign.status !== expected) throw new CampaignAudienceError(`Only an empty ${expected} campaign can be ${archived ? 'archived' : 'restored'}.`, 409);
    const sendCount = db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count;
    if (sendCount) throw new CampaignAudienceError('Campaigns with send history cannot be archived or restored as drafts.', 409);
    db.prepare('UPDATE campaigns SET status=? WHERE id=?').run(next, campaignId);
    db.prepare(`INSERT INTO events(event_type,event_at,meta_json) VALUES (?,datetime('now'),?)`)
      .run(archived ? 'campaign_archived' : 'campaign_restored', JSON.stringify({ campaign_id: campaignId }));
    return { id: campaignId, status: next, changed: true };
  })();
}

function normalizeCampaignSenderIds(values) {
  if (!Array.isArray(values)) throw new CampaignAudienceError('Sender mailbox ids must be an array.');
  if (values.length > 100) throw new CampaignAudienceError('Select at most 100 sender mailboxes.');
  return [...new Set(values.map(value => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new CampaignAudienceError('Sender mailbox ids must be positive integers.');
    return id;
  }))];
}

function campaignSenderReadiness(mailbox, config = getConfig()) {
  if (!mailbox.active) return 'inactive';
  if (mailbox.warmup_status !== 'eligible') return `warmup_${mailbox.warmup_status || 'unknown'}`;
  if (Number(mailbox.health_score) < Number(config.min_health_to_send)) return 'health_below_threshold';
  const smtp = inspectSmtpSettings(mailbox);
  return smtp.ok ? 'ready' : smtp.code.toLowerCase();
}

export function getCampaignSenderSelection(value) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const db = getDb();
  const campaign = db.prepare('SELECT id,status FROM campaigns WHERE id=?').get(campaignId);
  if (!campaign) return null;
  const assigned = new Set(db.prepare('SELECT mailbox_id FROM campaign_senders WHERE campaign_id=?').all(campaignId).map(row => row.mailbox_id));
  const config = getConfig();
  const mailboxes = db.prepare(`SELECT id,email,domain,warmup_status,active,health_score,daily_limit,
    smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure FROM mailboxes ORDER BY lower(email),id`).all()
    .map(mailbox => {
      const readiness = campaignSenderReadiness(mailbox, config);
      const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, ...safeMailbox } = mailbox;
      return { ...safeMailbox, selected: assigned.has(mailbox.id), readiness };
    });
  const hasSendHistory = db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId) !== undefined;
  return {
    campaignId,
    locked: campaign.status !== 'draft' || hasSendHistory,
    senderIds: [...assigned],
    mailboxes,
    readyCount: mailboxes.filter(mailbox => assigned.has(mailbox.id) && mailbox.readiness === 'ready').length,
  };
}

export function getMailboxCredentialStorageStatus(db = getDb()) {
  return getCredentialVaultStatus(db);
}

export function updateCampaignSenderSelection(value, mailboxValues) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const mailboxIds = normalizeCampaignSenderIds(mailboxValues);
  const db = getDb();
  return db.transaction(() => {
    const campaign = db.prepare('SELECT id,name,status FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    if (campaign.status !== 'draft' || db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId)) {
      throw new CampaignAudienceError('Sender selection is locked after a campaign is launched or has send history.', 409);
    }
    const previous = db.prepare('SELECT mailbox_id FROM campaign_senders WHERE campaign_id=? ORDER BY mailbox_id').all(campaignId).map(row => row.mailbox_id);
    const config = getConfig();
    const rows = mailboxIds.length
      ? db.prepare(`SELECT * FROM mailboxes WHERE id IN (${mailboxIds.map(() => '?').join(',')})`).all(...mailboxIds)
      : [];
    if (rows.length !== mailboxIds.length) throw new CampaignAudienceError('One or more sender mailboxes do not exist.', 404);
    const unavailable = rows.find(mailbox => campaignSenderReadiness(mailbox, config) !== 'ready' && !previous.includes(mailbox.id));
    if (unavailable) throw new CampaignAudienceError(`Mailbox ${unavailable.email} cannot be selected: ${campaignSenderReadiness(unavailable, config)}.`, 409);

    const selected = [...mailboxIds].sort((a, b) => a - b);
    db.prepare('DELETE FROM campaign_senders WHERE campaign_id=?').run(campaignId);
    const insert = db.prepare('INSERT INTO campaign_senders(campaign_id,mailbox_id) VALUES (?,?)');
    for (const mailboxId of selected) insert.run(campaignId, mailboxId);
    const before = [...previous].sort((a, b) => a - b);
    const changed = selected.length !== before.length || selected.some((id, index) => id !== before[index]);
    if (changed) {
      db.prepare(`INSERT INTO events(event_type,event_at,meta_json) VALUES ('campaign_senders_updated',datetime('now'),?)`)
        .run(JSON.stringify({ campaign_id: campaignId, mailbox_ids: selected }));
    }
    return getCampaignSenderSelection(campaignId);
  })();
}

function getEffectiveCampaignStatus(db, campaign) {
  const storedStatus = campaign.status || 'draft';
  if (storedStatus !== 'draft') return storedStatus;
  const sends = db.prepare(`
    SELECT COUNT(CASE WHEN status IN ('scheduled','sending','processing') THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'sent' THEN 1 END) AS accepted
    FROM sends WHERE campaign_id = ?
  `).get(campaign.id);
  return sends.pending > 0 ? 'active' : sends.accepted > 0 ? 'completed' : 'draft';
}

export function pauseCampaign(value) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const db = getDb();
  return db.transaction(() => {
    const campaign = db.prepare('SELECT id,status FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    const status = getEffectiveCampaignStatus(db, campaign);
    if (status === 'paused') return { id: campaignId, status: 'paused', changed: false };
    if (['completed', 'archived'].includes(status)) throw new CampaignAudienceError(`A ${status} campaign cannot be paused.`, 409);
    if (status !== 'active') throw new CampaignAudienceError('Only an active campaign can be paused.', 409);

    const pending = db.prepare("SELECT COUNT(*) AS count FROM sends WHERE campaign_id = ? AND status IN ('scheduled','sending','processing')").get(campaignId).count;
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    db.prepare(`INSERT INTO events (event_type,event_at,meta_json) VALUES ('campaign_paused',datetime('now'),?)`)
      .run(JSON.stringify({ campaign_id: campaignId, pending_retained: pending }));
    return { id: campaignId, status: 'paused', changed: true, pendingRetained: pending };
  })();
}

export function resumeCampaign(value) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const db = getDb();
  return db.transaction(() => {
    const campaign = db.prepare('SELECT id,status FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    if (campaign.status !== 'paused') throw new CampaignAudienceError('Only a paused campaign can be resumed.', 409);
    db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaignId);
    db.prepare(`INSERT INTO events (event_type,event_at,meta_json) VALUES ('campaign_resumed',datetime('now'),?)`)
      .run(JSON.stringify({ campaign_id: campaignId }));
    return { id: campaignId, status: 'active', changed: true };
  })();
}

export function stopCampaign(value) {
  const campaignId = Number(value);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) throw new CampaignAudienceError('Campaign id must be a positive integer.');
  const db = getDb();
  return db.transaction(() => {
    const campaign = db.prepare('SELECT id,status FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    const status = getEffectiveCampaignStatus(db, campaign);
    if (status === 'stopped') return { id: campaignId, status: 'stopped', changed: false, cancelled: 0, inFlight: 0 };
    if (['completed', 'archived'].includes(status)) throw new CampaignAudienceError(`A ${status} campaign cannot be stopped.`, 409);
    if (!['active', 'paused'].includes(status)) throw new CampaignAudienceError('Only an active or paused campaign can be stopped.', 409);

    const inFlightIds = new Set([...inFlightSends]
      .filter(([, activeCampaignId]) => activeCampaignId === campaignId)
      .map(([sendId]) => sendId));
    const queued = db.prepare("SELECT id,status FROM sends WHERE campaign_id = ? AND status IN ('scheduled','processing','sending')").all(campaignId);
    let cancelled = 0;
    let persistedInFlight = 0;
    const cancel = db.prepare("UPDATE sends SET status = 'cancelled', error_message = ? WHERE id = ? AND status = 'scheduled'");
    for (const send of queued) {
      if (send.status === 'scheduled' && !inFlightIds.has(send.id)) {
        cancelled += cancel.run('Campaign stopped before SMTP submission.', send.id).changes;
      } else {
        persistedInFlight++;
      }
    }
    const inFlight = Math.max(persistedInFlight, inFlightIds.size);
    const stoppedEnrollments = db.prepare("UPDATE campaign_enrollments SET status = 'stopped' WHERE campaign_id = ? AND status = 'active'").run(campaignId).changes;
    db.prepare("UPDATE campaigns SET status = 'stopped' WHERE id = ?").run(campaignId);
    db.prepare("INSERT INTO events (event_type,event_at,meta_json) VALUES ('campaign_stopped',datetime('now'),?)")
      .run(JSON.stringify({ campaign_id: campaignId, cancelled_scheduled: cancelled, in_flight: inFlight, stopped_enrollments: stoppedEnrollments }));
    return { id: campaignId, status: 'stopped', changed: true, cancelled, inFlight, stoppedEnrollments };
  })();
}

export function getCampaigns() {
  const db = getDb();
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();

  return campaigns.map(c => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_sends,
        COUNT(CASE WHEN s.status = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN s.status = 'scheduled' THEN 1 END) as scheduled,
        COUNT(CASE WHEN s.status = 'failed' THEN 1 END) as failed
      FROM sends s WHERE s.campaign_id = ?
    `).get(c.id);

    const events = db.prepare(`
      SELECT
        COUNT(CASE WHEN e.event_type = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN e.event_type = 'opened' THEN 1 END) as opened,
        COUNT(CASE WHEN e.event_type = 'clicked' THEN 1 END) as clicked,
        COUNT(CASE WHEN e.event_type = 'replied' THEN 1 END) as replied,
        COUNT(CASE WHEN e.event_type IN ('hard_bounce','soft_bounce') THEN 1 END) as bounced,
        COUNT(CASE WHEN e.event_type = 'spam_complaint' THEN 1 END) as complaints
      FROM events e
      JOIN sends s ON e.send_id = s.id
      WHERE s.campaign_id = ?
    `).get(c.id);

    return { ...c, ...stats, ...events };
  });
}

export function getMailboxFleet() {
  const db = getDb();
  return db.prepare(`
    SELECT m.*,
      COALESCE((SELECT COUNT(*) FROM sends s
        WHERE s.mailbox_id = m.id AND s.status='sent' AND s.sent_at >= date('now')), 0) as today_sent,
      COALESCE((SELECT COUNT(*) FROM send_capacity_reservations r
        WHERE r.mailbox_id=m.id AND r.capacity_day=date('now') AND r.state IN ('reserved','uncertain')), 0) as today_reserved,
      COALESCE(m.spf_ok, d.spf_ok, 0) as spf_ok,
      COALESCE(NULLIF(m.dkim_status,'unknown'),NULLIF(d.dkim_status,'unknown'),'unknown') as dkim_evidence_status,
      COALESCE(m.dmarc_ok, d.dmarc_ok, 0) as dmarc_ok,
      ims.last_attempt_at AS imap_last_sync_attempt_at,
      ims.last_success_at AS imap_last_sync_success_at,
      ims.last_error AS imap_last_sync_error,
      ims.last_fetched AS imap_last_sync_fetched,
      ims.last_imported AS imap_last_sync_imported,
      ims.last_duplicates AS imap_last_sync_duplicates,
      ims.last_skipped AS imap_last_sync_skipped,
      ims.last_cursor_uid AS imap_last_sync_cursor_uid
    FROM mailboxes m
    LEFT JOIN domains d ON d.domain = m.domain
    LEFT JOIN imap_sync_mailbox_state ims ON ims.mailbox_id=m.id
    WHERE m.active = 1
    ORDER BY m.health_score DESC
  `).all().map(mailbox => {
    const { smtp_pass, imap_pass, imap_aliases_json, blacklisted: _legacyMailboxBlacklist, blacklist_status: _legacyBlacklistStatus, ...safeMailbox } = mailbox;
    let imapAliases = [];
    try { imapAliases = JSON.parse(imap_aliases_json || '[]'); } catch { /* Return no guessed aliases for invalid legacy JSON. */ }
    let dnsEvidence = null;
    try { dnsEvidence = JSON.parse(mailbox.dns_records_json || 'null'); } catch { /* Old or malformed records are not DNSBL evidence. */ }
    const recognizedDomainDnsblStatuses = new Set(['listed', 'not_listed', 'unavailable', 'not_checked', 'unknown']);
    const hasAttributedDnsblEvidence = dnsEvidence?.dnsbl_subject_type === 'domain_apex_ipv4'
      && recognizedDomainDnsblStatuses.has(dnsEvidence.domain_dnsbl_status)
      && Array.isArray(dnsEvidence.dnsbl_checks);
    const domainDnsblStatus = hasAttributedDnsblEvidence ? dnsEvidence.domain_dnsbl_status : 'not_checked';
    const domainBlacklisted = domainDnsblStatus === 'listed' ? 1 : domainDnsblStatus === 'not_listed' ? 0 : null;
    const dkimStatus = mailbox.dkim_evidence_status || mailbox.dkim_status || 'unknown';
    const dkimVerified = dkimStatus === 'aligned_verified' || dkimStatus === 'unaligned_verified';
    return {
      ...safeMailbox,
      domain_dnsbl_status: domainDnsblStatus,
      domain_blacklisted: domainBlacklisted,
      sender_ip_status: 'unknown',
      sender_reputation_status: 'unknown',
      dkim_status: dkimStatus,
      // Mask legacy key-presence flags. Only a separate message-signature verifier
      // may promote this from unknown to a verified aligned/unaligned outcome.
      dkim_ok: dkimVerified ? Number(dkimStatus === 'aligned_verified') : null,
      imap_aliases: Array.isArray(imapAliases) ? imapAliases : [],
      smtp_configured: Boolean(mailbox.smtp_host && mailbox.smtp_user && smtp_pass),
      imap_configured: Boolean(mailbox.imap_host && mailbox.imap_user && imap_pass),
    };
  });
}

export function getSendQueue(campaignId) {
  const db = getDb();
  let q = `
    SELECT s.*, l.email as recipient_email, l.business_name,
      m.email as from_email, p.subject_line, s.variant
    FROM sends s
    JOIN leads l ON s.lead_id = l.id
    JOIN mailboxes m ON s.mailbox_id = m.id
    LEFT JOIN personalizations p ON s.personalization_id = p.id
  `;
  const params = [];
  if (campaignId) {
    q += ' WHERE s.campaign_id = ?';
    params.push(campaignId);
  }
  q += ' ORDER BY s.scheduled_at DESC LIMIT 200';
  return db.prepare(q).all(...params);
}

export function getSendStats() {
  const db = getDb();
  return {
    total_sends: db.prepare('SELECT COUNT(*) as c FROM sends').get().c,
    sent: db.prepare("SELECT COUNT(*) as c FROM sends WHERE status = 'sent'").get().c,
    scheduled: db.prepare("SELECT COUNT(*) as c FROM sends WHERE status = 'scheduled'").get().c,
    processing: db.prepare("SELECT COUNT(*) as c FROM sends WHERE status = 'processing'").get().c,
    uncertain: db.prepare("SELECT COUNT(*) as c FROM sends WHERE status = 'uncertain'").get().c,
    failed: db.prepare("SELECT COUNT(*) as c FROM sends WHERE status = 'failed'").get().c,
    today_sent: db.prepare("SELECT COUNT(*) as c FROM sends WHERE sent_at >= date('now')").get().c,
  };
}
