// ============================================================
//  ODD-ECOSYS Pipeline — Email Verifier (Phase 4 / Stage 5)
//  Powered by Reacher Architecture (alaminfirdows/reacher-email-checker) + Disify
//  Syntax Validation · Authoritative MX · Disposable Filter · Role Accounts · Catch-All
//  RFC Compliance · Real-Time Deliverability Classification
// ============================================================

import dns from 'dns';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { domainToASCII, fileURLToPath } from 'url';
import { getDb } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ──────────────────────────────────────────────────
const RULES_PATH = path.join(__dirname, '..', 'config', 'verification-rules.json');
let _rules = null;
function getRules() {
  if (!_rules) _rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
  return _rules;
}

const REACHER_API_URL = process.env.REACHER_API_URL || 'http://localhost:8080/v0/check_email';
const REACHER_TIMEOUT_MS = parseInt(process.env.REACHER_TIMEOUT_MS) || 35000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Track Reacher availability
let _reacherAvailable = null; // null = unchecked, true/false
async function isReacherAvailable() {
  if (_reacherAvailable !== null) return _reacherAvailable;
  try {
    const res = await fetch(REACHER_API_URL.replace('/v0/check_email', '/'), {
      signal: AbortSignal.timeout(3000),
    });
    _reacherAvailable = res.status < 500;
  } catch {
    _reacherAvailable = false;
  }
  return _reacherAvailable;
}
// Re-check every 60 seconds
// Refresh cached availability without keeping CLI processes alive after completion.
setInterval(() => { _reacherAvailable = null; }, 60000).unref();

// ── Run state ────────────────────────────────────────────────
let _state = {
  active: false,
  jobId: null,
  batchId: null,
  processed: 0,
  total: 0,
  deliverable: 0,
  risky: 0,
  undeliverable: 0,
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
      current_lead_id=NULL,updated_at=datetime('now'),completed_at=datetime('now')
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
  const currentEmail = job.current_lead_id
    ? db.prepare('SELECT email FROM leads WHERE id=?').get(job.current_lead_id)?.email || null
    : null;
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
    undeliverable: job.undeliverable,
    currentEmail,
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

  // SMTP uses DNS A-labels. Convert U-labels for lookups while keeping the local part untouched.
  const asciiDomain = domainToASCII(inputDomain);
  if (!asciiDomain) return invalid('invalid_idn_domain', username, inputDomain);
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

export async function checkMxRecords(domain, options = {}) {
  const {
    resolveMxImpl = dns.promises.resolveMx,
    resolve4Impl = dns.promises.resolve4,
    resolve6Impl = dns.promises.resolve6,
  } = options;

  let mxRecords = null;
  try {
    mxRecords = await resolveMxImpl(domain);
  } catch (error) {
    if (error?.code === 'ENOTFOUND') {
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
      reason: null,
    };
  }

  // RFC 5321 treats a successful empty MX answer as an implicit MX pointing to
  // the domain itself, but only when that host has an A or AAAA address.
  const resolveAddress = async resolveAddressImpl => {
    try {
      const addresses = await resolveAddressImpl(domain);
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

async function checkDisifyAndDisposable(email, domain, rules) {
  const disposableDomains = new Set([
    'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
    'temp-mail.org', 'trashmail.com', 'yopmail.com', 'sharklasers.com',
    'dispostable.com', 'fakemailgenerator.com', 'getairmail.com', 'throwawaymail.com',
    'mohmal.com', 'burnermail.io', 'inboxkitten.com', 'crazymailing.com',
    'mail2.mailinator.com', 'temp-mail.io', 'generator.email'
  ]);

  let is_disposable = disposableDomains.has(domain);
  let is_role_account = rules.role_account_prefixes.includes(email.split('@')[0].toLowerCase());
  let disifyData = null;

  try {
    const res = await fetch(`https://disify.com/api/email/${encodeURIComponent(email)}`, {
      headers: { 'User-Agent': 'oddecosys-verifier/2.0' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      disifyData = await res.json();
      if (disifyData.disposable === true) is_disposable = true;
      if (disifyData.role === true) is_role_account = true;
    }
  } catch {}

  return { is_disposable, is_role_account, disifyData };
}

// ══════════════════════════════════════════════════════════════
//  4. SMTP SOCKET PROBE (Port 25 Reachability)
// ══════════════════════════════════════════════════════════════

export function probeSmtp(mxHost, toEmail, options = {}) {
  const {
    fromEmail = 'verify@outreach.local',
    timeoutMs = 3000,
    port = 25,
    connectImpl = (targetPort, host) => net.createConnection({ port: targetPort, host }),
  } = options;
  return new Promise((resolve) => {
    if (!mxHost) {
      return resolve({ can_connect_smtp: false, is_deliverable: null, is_catch_all: null, stage: 'connect', reason: 'no_mx_host' });
    }

    let socket;
    try {
      socket = connectImpl(port, mxHost);
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

    const finish = (result, end = false) => {
      if (completed) return;
      completed = true;
      if (end && !socket.destroyed) socket.end();
      else if (!socket.destroyed) socket.destroy();
      resolve(result);
    };

    const baseEvidence = (stage, code = null, response = '') => ({
      can_connect_smtp: connected,
      is_deliverable: null,
      is_catch_all: null,
      stage,
      code,
      response: response.slice(0, 512),
    });

    const writeNextCommand = (code, response) => {
      const stage = stages[stageIndex];
      if (stage === 'greeting') {
        if (code !== 220) return finish({ ...baseEvidence(stage, code), reason: `smtp_unexpected_greeting:${code}` }, true);
        stageIndex++;
        socket.write('EHLO outreach.local\r\n');
        return;
      }
      if (stage === 'ehlo') {
        if (code !== 250) return finish({ ...baseEvidence(stage, code), reason: `smtp_ehlo_rejected:${code}` }, true);
        stageIndex++;
        socket.write(`MAIL FROM:<${fromEmail}>\r\n`);
        return;
      }
      if (stage === 'mail_from') {
        if (code !== 250) return finish({ ...baseEvidence(stage, code), reason: `smtp_mail_from_rejected:${code}` }, true);
        stageIndex++;
        socket.write(`RCPT TO:<${toEmail}>\r\n`);
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

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { connected = true; });
    socket.on('timeout', () => finish({
      ...baseEvidence(stages[stageIndex] || 'complete'),
      reason: `smtp_timeout:${stages[stageIndex] || 'complete'}`,
    }));
    socket.on('error', error => finish({
      ...baseEvidence(stages[stageIndex] || 'connect'),
      reason: `smtp_connection_failed:${typeof error?.code === 'string' ? error.code : 'unknown'}`,
    }));
    socket.on('close', () => {
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

export async function getReacherStatus() {
  const up = await isReacherAvailable();
  return {
    available: up,
    url: REACHER_API_URL,
    engine: up ? 'reacher_docker_backend' : 'local_fallback_only',
    note: up ? 'Real SMTP mailbox verification active via Reacher Docker' : 'Reacher not running. Start with: docker run -p 8080:8080 reacherhq/backend:latest',
  };
}

export function buildAuditResult(email, r, rules) {
  const parts = email.split('@');
  const username = parts[0] || '';
  const domain = (parts[1] || '').toLowerCase();

  const freeProviders = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
    'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com',
    'me.com', 'mail.com', 'protonmail.com', 'proton.me', 'zoho.com',
    'yandex.com', 'gmx.com', 'fastmail.com'
  ];
  const corporateRestricted = [
    'instagram.com', 'meta.com', 'facebook.com', 'google.com', 'apple.com',
    'microsoft.com', 'amazon.com', 'netflix.com', 'stripe.com', 'twitter.com',
    'x.com', 'linkedin.com', 'uber.com', 'airbnb.com', 'spotify.com'
  ];

  const is_free = freeProviders.includes(domain);
  const is_corporate = corporateRestricted.includes(domain);
  const is_disposable = r.misc?.is_disposable || false;
  const is_role = r.misc?.is_role_account || false;
  const is_catch_all = r.smtp?.is_catch_all ?? null;
  const mx_valid = r.mx?.accepts_mail || false;
  const syntax_valid = r.syntax?.is_valid_syntax || false;
  const mx_host = r.mx?.records?.[0]?.exchange || r.mx?.records?.[0] || null;

  const numDigits = (username.match(/\d/g) || []).length;
  const numLetters = (username.match(/[a-z]/gi) || []).length;
  const numUnicode = (username.match(/[^\x00-\x7F]/g) || []).length;

  let score = 0;
  let status = 'undeliverable';
  let reasonLabel = 'Rejected Email';
  const reasons = [];

  if (!syntax_valid) {
    score = 0;
    status = 'undeliverable';
    reasonLabel = 'Invalid Syntax';
    reasons.push(r.syntax?.reason || 'invalid_syntax');
  } else if (is_disposable) {
    score = 0;
    status = 'undeliverable';
    reasonLabel = 'Disposable Domain';
    reasons.push('disposable_domain');
  } else if (!mx_valid) {
    score = 0;
    status = 'undeliverable';
    reasonLabel = 'No MX Records';
    reasons.push('no_mx_records');
  } else if (r.smtp?.is_deliverable === false) {
    score = 0;
    status = 'undeliverable';
    reasonLabel = 'Rejected Email (SMTP 550)';
    reasons.push('smtp_rejected_mailbox_does_not_exist');
  } else if (is_corporate) {
    score = 50;
    status = 'risky';
    reasonLabel = 'Corporate Restricted Domain';
    reasons.push('corporate_restricted_domain_unconfirmed');
  } else if (is_role) {
    score = 60;
    status = 'risky';
    reasonLabel = 'Role Account';
    reasons.push('role_account');
  } else if (is_catch_all) {
    score = 65;
    status = 'risky';
    reasonLabel = 'Accept-All (Catch-All)';
    reasons.push('catch_all_domain');
  } else if (r.smtp?.is_deliverable === true) {
    // A remote mailbox acceptance is evidence; syntax/MX alone is not.
    score = 95;
    status = 'deliverable';
    reasonLabel = 'Accepted Email';
  } else {
    score = 50;
    status = 'risky';
    const smtpConnectionUnavailable = r.smtp?.can_connect_smtp === false;
    reasonLabel = smtpConnectionUnavailable ? 'SMTP Connection Unavailable' : 'Mailbox Not Confirmed';
    reasons.push(smtpConnectionUnavailable ? 'smtp_connection_unavailable' : 'smtp_unconfirmed');
  }

  const isValid = status === 'deliverable';

  // Provider detection
  let provider = 'Custom Mail Server';
  const host = ((mx_host || '') + ' ' + domain).toLowerCase();
  if (/google|gmail|googlemail/i.test(host)) provider = 'Google';
  else if (/outlook|hotmail|microsoft|protection\.outlook/i.test(host)) provider = 'Microsoft';
  else if (/yahoo|yahoodns|ymail/i.test(host)) provider = 'Yahoo';
  else if (/pphosted|proofpoint/i.test(host)) provider = 'Proofpoint';
  else if (/mimecast/i.test(host)) provider = 'Mimecast';
  else if (/barracuda/i.test(host)) provider = 'Barracuda';
  else if (/fastmail/i.test(host)) provider = 'Fastmail';
  else if (/proton/i.test(host)) provider = 'ProtonMail';
  else if (/zoho/i.test(host)) provider = 'Zoho';
  else if (/icloud|apple/i.test(host)) provider = 'Apple';

  return {
    email,
    valid: isValid,
    verification_status: status,
    score,
    score_multiplier: `${(score / 100).toFixed(2)}x`,
    engine: 'reacher_docker',
    general: {
      full_name: null,
      gender: null,
      state: status === 'deliverable' ? 'Deliverable' : status === 'risky' ? 'Risky' : 'Undeliverable',
      reason: reasonLabel,
      domain,
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
      mailbox_full: r.misc?.mailbox_full ?? null,
      no_reply: /noreply|no-reply|do-not-reply/i.test(username),
      secure_email_gateway: /pphosted|mimecast|barracuda|proofpoint/i.test(mx_host || ''),
    },
    mail_server: {
      smtp_provider: provider,
      mx_record: mx_host,
      implicit_mx_record: r.mx?.implicit_mx_record ?? null,
    },
    is_disposable,
    is_free_provider: is_free,
    is_role_account: is_role,
    is_catch_all,
    mx_host,
    checks: {
      regex: syntax_valid,
      mx: mx_valid,
      disposable: !is_disposable,
      smtp: r.smtp?.is_deliverable ?? null,
    },
    reasons,
    reacher: r,
  };
}

function buildDnsGateResult(email, syntax, mx) {
  const hasNoMailRoute = mx.accepts_mail === false;
  const status = hasNoMailRoute ? 'undeliverable' : 'risky';
  const reasonLabels = {
    dns_domain_not_found: 'Domain does not exist in DNS',
    dns_null_mx: 'Domain explicitly does not accept email',
    dns_no_mx_or_address_records: 'No mail route was found for this domain',
  };
  const reason = reasonLabels[mx.reason] || `DNS mail routing is inconclusive (${mx.reason || 'unknown_dns_result'})`;
  return {
    email,
    valid: false,
    verification_status: status,
    score: hasNoMailRoute ? 0 : 50,
    score_multiplier: hasNoMailRoute ? '0.00x' : '0.50x',
    engine: 'local_dns_gate',
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
    mail_server: { smtp_provider: 'Unknown', mx_record: mx.primary, implicit_mx_record: mx.implicit_mx_record },
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
      smtp: {
        can_connect_smtp: null,
        is_deliverable: null,
        reason: hasNoMailRoute ? 'not_attempted_no_mail_route' : 'not_attempted_dns_inconclusive',
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  MASTER EMAIL VERIFICATION (Reacher Docker → Local Fallback)
// ══════════════════════════════════════════════════════════════

export async function verifyEmail(email, options = {}) {
  const {
    isReacherAvailableImpl = isReacherAvailable,
    reacherFetchImpl = fetch,
    resolveMxImpl = dns.promises.resolveMx,
    resolve4Impl = dns.promises.resolve4,
    resolve6Impl = dns.promises.resolve6,
    checkDisifyImpl = checkDisifyAndDisposable,
    smtpProbeImpl = probeSmtp,
  } = options;
  const suppliedEmail = typeof email === 'string' ? email : '';
  const rules = getRules();

  // Syntax normalization preserves the case-sensitive local part and converts only the domain.
  const syntax = validateSyntax(suppliedEmail);
  const cleanEmail = syntax.is_valid_syntax ? syntax.normalizedEmail : suppliedEmail.trim();
  if (!syntax.is_valid_syntax) {
    return {
      email: cleanEmail,
      valid: false,
      verification_status: 'undeliverable',
      score: 0,
      score_multiplier: '0.00x',
      engine: 'local_syntax_gate',
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

  // Neither configured Reacher nor the local SMTP probe has an established SMTPUTF8
  // capability contract. Preserve valid syntax, but leave mailbox evidence unknown.
  if (syntax.requiresSmtpUtf8) {
    return {
      email: cleanEmail,
      valid: false,
      verification_status: 'risky',
      score: 50,
      score_multiplier: '0.50x',
      engine: 'smtp_utf8_capability_gate',
      general: {
        full_name: null,
        gender: null,
        state: 'Unknown',
        reason: 'SMTPUTF8 is required; verifier capability has not been established',
        domain: syntax.domain,
      },
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
      mail_server: { smtp_provider: 'Unknown', mx_record: null, implicit_mx_record: null },
      is_disposable: null,
      is_free_provider: null,
      is_role_account: null,
      is_catch_all: null,
      mx_host: null,
      checks: { regex: true, mx: null, disposable: null, smtp: null },
      reasons: ['smtp_utf8_required_probe_unsupported'],
      reacher: {
        input: cleanEmail,
        is_reachable: 'unknown',
        syntax,
        mx: { accepts_mail: null, records: [], reason: 'not_checked_smtp_utf8_capability_unknown' },
        misc: { is_disposable: null, is_role_account: null },
        smtp: { can_connect_smtp: null, is_deliverable: null, reason: 'not_attempted_smtp_utf8_capability_unknown' },
      },
    };
  }

  // 3. Reacher Docker Backend (auto-detected at localhost:8080 or REACHER_API_URL)
  const reacherUp = await isReacherAvailableImpl();
  if (reacherUp) {
    try {
      const res = await reacherFetchImpl(REACHER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_email: cleanEmail }),
        signal: AbortSignal.timeout(REACHER_TIMEOUT_MS),
      });
      if (res.ok) {
        const r = await res.json();
        return buildAuditResult(cleanEmail, r, rules);
      }
    } catch {
      // Reacher call failed, fall through to local checks
    }
  }

  // 3. Authoritative MX Check
  const mx = await checkMxRecords(syntax.domain, { resolveMxImpl, resolve4Impl, resolve6Impl });
  if (mx.accepts_mail !== true) return buildDnsGateResult(cleanEmail, syntax, mx);

  // 4. Disposable & Disify Verification
  const { is_disposable, is_role_account, disifyData } = await checkDisifyImpl(cleanEmail, syntax.domain, rules);
  if (is_disposable) {
    return {
      email: cleanEmail,
      valid: false,
      verification_status: 'undeliverable',
      is_disposable: true,
      is_free_provider: false,
      is_role_account,
      is_catch_all: false,
      mx_host: mx.primary,
      checks: { regex: true, mx: true, disposable: false, smtp: null },
      reasons: ['disposable_domain'],
      reacher: {
        input: cleanEmail,
        is_reachable: 'invalid',
        syntax,
        mx,
        misc: { is_disposable: true, is_role_account },
        smtp: { can_connect_smtp: null, is_deliverable: null, reason: 'not_attempted_disposable_domain_gate' },
      },
    };
  }

  // 5. Socket SMTP Handshake
  const smtp = await smtpProbeImpl(mx.primary, cleanEmail);

  // 6. Free & Corporate Provider Identification
  const freeProviders = [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
    'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com',
    'me.com', 'mail.com', 'protonmail.com', 'proton.me', 'zoho.com',
    'yandex.com', 'gmx.com', 'fastmail.com'
  ];
  const corporateRestricted = [
    'instagram.com', 'meta.com', 'facebook.com', 'google.com', 'apple.com',
    'microsoft.com', 'amazon.com', 'netflix.com', 'stripe.com', 'twitter.com',
    'x.com', 'linkedin.com', 'uber.com', 'airbnb.com', 'spotify.com'
  ];

  const is_free_provider = freeProviders.includes(syntax.domain);
  const is_corporate = corporateRestricted.includes(syntax.domain);

  // 7. Strict Deliverability Classification Decision Tree
  let status = 'risky';
  let isValid = false;
  const reasons = [];

  if (smtp.is_deliverable === false) {
    // Explicit SMTP 5xx mailbox rejection (e.g. 550 Mailbox does not exist)
    status = 'undeliverable';
    isValid = false;
    reasons.push(smtp.reason || 'smtp_rejected:mailbox_does_not_exist');
  } else if (is_role_account && rules.suppress_role_accounts) {
    status = 'undeliverable';
    isValid = false;
    reasons.push('role_account_suppressed');
  } else if (is_role_account) {
    status = 'risky';
    isValid = false;
    reasons.push('role_account');
  } else if (smtp.is_deliverable === true) {
    // Confirmed 250 OK via real SMTP Handshake
    status = 'deliverable';
    isValid = true;
  } else if (is_corporate) {
    // Closed corporate domain without explicit employee SMTP confirmation (e.g. @instagram.com)
    status = 'risky';
    isValid = false;
    reasons.push('corporate_restricted_domain_unconfirmed');
  } else if (smtp.can_connect_smtp === false) {
    // An unsuccessful connection attempt does not establish that port 25 is blocked.
    status = 'risky';
    isValid = false;
    reasons.push('smtp_connection_unavailable');
  } else {
    status = 'risky';
    isValid = false;
    reasons.push('deliverability_unconfirmed');
  }

  // 8. Compute Enterprise Audit Metrics
  const username = syntax.username || cleanEmail.split('@')[0] || '';
  const domain = syntax.domain || cleanEmail.split('@')[1] || '';

  const numDigits = (username.match(/\d/g) || []).length;
  const numLetters = (username.match(/[a-z]/gi) || []).length;
  const numUnicode = (username.match(/[^\x00-\x7F]/g) || []).length;
  const hasTag = username.includes('+');
  const isNoReply = /noreply|no-reply|do-not-reply/i.test(username);

  let provider = 'Custom Mail Server';
  const targetHost = ((mx.primary || '') + ' ' + domain).toLowerCase();
  if (/google|gmail|googlemail/i.test(targetHost)) provider = 'Google';
  else if (/outlook|hotmail|microsoft|protection\.outlook/i.test(targetHost)) provider = 'Microsoft';
  else if (/yahoo|yahoodns|ymail/i.test(targetHost)) provider = 'Yahoo';
  else if (/pphosted|proofpoint/i.test(targetHost)) provider = 'Proofpoint';
  else if (/mimecast/i.test(targetHost)) provider = 'Mimecast';
  else if (/barracuda/i.test(targetHost)) provider = 'Barracuda';
  else if (/fastmail/i.test(targetHost)) provider = 'Fastmail';
  else if (/proton/i.test(targetHost)) provider = 'ProtonMail';
  else if (/zoho/i.test(targetHost)) provider = 'Zoho';
  else if (/icloud|apple/i.test(targetHost)) provider = 'Apple';

  let score = 95;
  let reasonLabel = 'Accepted Email';
  if (status === 'undeliverable') {
    score = 0;
    if (is_disposable) reasonLabel = 'Disposable Domain';
    else if (reasons.some(r => r.includes('syntax') || r.includes('invalid') || r.includes('length'))) reasonLabel = 'Invalid Syntax';
    else if (reasons.some(r => r.includes('no_mx'))) reasonLabel = 'No MX Records';
    else if (reasons.some(r => r.includes('smtp_rejected'))) reasonLabel = 'Rejected Email (550)';
    else reasonLabel = 'Rejected Email';
  } else if (status === 'risky') {
    score = is_role_account ? 60 : 50;
    if (is_role_account) reasonLabel = 'Role Account';
    else if (is_corporate) reasonLabel = 'Corporate Restricted Domain';
    else if (smtp.can_connect_smtp === false) reasonLabel = 'SMTP Connection Unavailable';
    else reasonLabel = 'Mailbox Not Confirmed';
  } else if (status === 'deliverable') {
    score = 95;
    reasonLabel = 'Accepted Email';
  }

  return {
    email: cleanEmail,
    valid: isValid,
    verification_status: status,
    score: score,
    score_multiplier: `${(score / 100).toFixed(2)}x`,
    general: {
      full_name: null,
      gender: null,
      state: status === 'deliverable' ? 'Deliverable' : status === 'risky' ? 'Risky' : status === 'undeliverable' ? 'Undeliverable' : 'Unknown',
      reason: reasonLabel,
      domain: domain,
    },
    attributes: {
      free: is_free_provider,
      role: is_role_account,
      disposable: is_disposable,
      accept_all: smtp.is_catch_all ?? null,
      tag: hasTag,
      numerical_characters: numDigits,
      alphabetical_characters: numLetters,
      unicode_symbols: numUnicode,
      mailbox_full: smtp.mailbox_full ?? null,
      no_reply: isNoReply,
      secure_email_gateway: /pphosted|mimecast|barracuda|proofpoint|subspace|fireeye|forcepoint/i.test(mx.primary || ''),
    },
    mail_server: {
      smtp_provider: provider,
      mx_record: mx.primary || null,
      implicit_mx_record: mx.implicit_mx_record,
    },
    is_disposable: is_disposable,
    is_free_provider: is_free_provider,
    is_role_account: is_role_account,
    is_catch_all: smtp.is_catch_all ?? null,
    mx_host: mx.primary,
    checks: {
      regex: true,
      mx: true,
      disposable: true,
      smtp: smtp.is_deliverable === true ? true : smtp.is_deliverable === false ? false : null,
    },
    reasons,
    reacher: {
      input: cleanEmail,
      is_reachable: status === 'deliverable' ? 'safe' : status === 'undeliverable' ? 'invalid' : status === 'risky' ? 'risky' : 'unknown',
      syntax,
      mx,
      misc: { is_disposable: is_disposable, is_role_account },
      smtp,
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

  const leads = db.prepare(`
    SELECT l.id, l.business_name, l.email, l.batch_id
    FROM leads l
    WHERE l.batch_id = ? AND l.status IN ('site_checked', 'discovered')
    AND l.email IS NOT NULL AND l.email != ''
    ORDER BY l.id
  `).all(normalizedBatchId);

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
        .run(normalizedBatchId, leads.length);
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
    total: leads.length,
    processed: 0,
    deliverable: 0,
    risky: 0,
    undeliverable: 0,
    currentEmail: null,
    cancelling: false,
    startedAt: new Date().toISOString(),
  };

  let deliverable = 0;
  let risky = 0;
  let undeliverable = 0;

  try {
    for (const lead of leads) {
      const jobStatus = db.prepare('SELECT status FROM verification_jobs WHERE id=?').get(jobId)?.status;
      if (_state.cancelling || jobStatus === 'cancel_requested' || !ACTIVE_JOB_STATUSES.includes(jobStatus)) break;
      _state.currentEmail = lead.email;
      db.prepare("UPDATE verification_jobs SET current_lead_id=?,updated_at=datetime('now') WHERE id=? AND status='running'").run(lead.id, jobId);

      const res = await verifyEmailImpl(lead.email);
      const classification = res.verification_status === 'deliverable'
        ? 'deliverable'
        : res.verification_status === 'risky' ? 'risky' : 'undeliverable';

      db.transaction(() => {
        if (!dryRun) {
          saveVerificationResult(db, lead.id, lead.email, res, { primary: true });
          const nextStatus = res.verification_status === 'undeliverable' ? 'disqualified' : 'verifying';
          db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(nextStatus, lead.id);
        }
        db.prepare(`UPDATE verification_jobs SET processed=processed+1,
          deliverable=deliverable+?,risky=risky+?,undeliverable=undeliverable+?,
          current_lead_id=NULL,updated_at=datetime('now') WHERE id=? AND status IN ('running','cancel_requested')`)
          .run(classification === 'deliverable' ? 1 : 0, classification === 'risky' ? 1 : 0, classification === 'undeliverable' ? 1 : 0, jobId);
      })();

      if (classification === 'deliverable') deliverable++;
      else if (classification === 'risky') risky++;
      else undeliverable++;
      _state.processed++;
      _state.deliverable = deliverable;
      _state.risky = risky;
      _state.undeliverable = undeliverable;
      _state.currentEmail = null;
      await sleepImpl(rules.delay_between_emails_ms || 200);
    }

    const current = db.prepare('SELECT status FROM verification_jobs WHERE id=?').get(jobId)?.status;
    const finalStatus = current === 'cancel_requested' || _state.cancelling ? 'cancelled' : 'completed';
    db.prepare(`UPDATE verification_jobs SET status=?,current_lead_id=NULL,updated_at=datetime('now'),completed_at=datetime('now')
      WHERE id=? AND status IN ('running','cancel_requested')`).run(finalStatus, jobId);
    return {
      jobId,
      batchId: normalizedBatchId,
      status: finalStatus,
      total: leads.length,
      processed: _state.processed,
      deliverable,
      risky,
      undeliverable,
    };
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code.slice(0, 80) : 'verification_failed';
    const message = typeof error.message === 'string' ? error.message.slice(0, 500) : 'Verification failed.';
    db.prepare(`UPDATE verification_jobs SET status='failed',error_code=?,error_message=?,current_lead_id=NULL,
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

  let query = `
    SELECT le.*, l.business_name, l.batch_id
    FROM lead_emails le
    JOIN leads l ON le.lead_id = l.id
    WHERE l.batch_id = ?
  `;
  const params = [batchId];

  if (status) {
    query += ' AND le.verification_status = ?';
    params.push(status);
  }

  const countQuery = query.replace('le.*, l.business_name, l.batch_id', 'COUNT(*) as total');
  const total = db.prepare(countQuery).get(...params)?.total || 0;

  query += ' ORDER BY le.id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = db.prepare(query).all(...params).map(row => ({
    ...row,
    // Older verifier runs could store guessed fallback numbers in this column.
    // The JSON evidence is authoritative: if it did not include a score, expose none.
    confidence_score: scoreFromVerifierEvidence(row.verification_json),
  }));
  return { results, total, limit, offset };
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
  const predicate = status === undefined ? '' : ' AND COALESCE(le.verification_status, \'unknown\') = ?';
  const values = status === undefined ? [batchId] : [batchId, status];
  const rows = db.prepare(`
    SELECT le.id AS email_id, le.lead_id AS contact_id, le.email,
      COALESCE(le.verification_status, 'unknown') AS verification_status, le.verified_at, le.mx_host, le.verification_json,
      l.business_name
    FROM lead_emails le JOIN leads l ON l.id=le.lead_id
    WHERE l.batch_id=?${predicate}
    ORDER BY l.id, le.is_primary DESC, le.id
  `).iterate(...values);
  return { batch, status: status ?? null, rows };
}

export function formatVerificationCsvRow(row) {
  let evidence = {};
  try { evidence = JSON.parse(row.verification_json || '{}'); } catch { /* malformed legacy evidence remains blank */ }
  const fields = [
    row.contact_id, row.email_id, row.business_name, row.email, row.verification_status || 'unknown',
    row.verified_at, row.mx_host, evidence.engine, evidence.checks ? JSON.stringify(evidence.checks) : '',
    Array.isArray(evidence.reasons) ? JSON.stringify(evidence.reasons) : typeof evidence.reason === 'string' ? evidence.reason : '',
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
    WHERE lead_id = ? AND lower(email) = lower(?)
    ORDER BY id DESC LIMIT 1
  `).get(leadId, email)?.id;

  const confidenceScore = normalizeVerifierScore(res.score);
  const values = [
    res.verification_status,
    confidenceScore,
    res.is_catch_all ? 1 : 0,
    res.is_role_account ? 1 : 0,
    res.is_free_provider ? 1 : 0,
    res.is_disposable ? 1 : 0,
    res.mx_host ?? null,
    JSON.stringify(res),
  ];

  if (primary) {
    db.prepare('UPDATE lead_emails SET is_primary = 0 WHERE lead_id = ?').run(leadId);
  }

  if (existingId) {
    db.prepare(`
      UPDATE lead_emails SET
        email = ?, verification_status = ?, confidence_score = ?,
        is_catch_all = ?, is_role_account = ?, is_free_provider = ?, is_disposable = ?,
        mx_host = ?, verification_json = ?, verified_at = datetime('now'),
        is_primary = CASE WHEN ? THEN 1 ELSE is_primary END
      WHERE id = ?
    `).run(email, ...values, primary ? 1 : 0, existingId);
    return existingId;
  }

  const result = db.prepare(`
    INSERT INTO lead_emails (
      lead_id, email, is_primary, verification_status, confidence_score,
      is_catch_all, is_role_account, is_free_provider, is_disposable,
      mx_host, verification_json, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(leadId, email, primary ? 1 : 0, ...values);
  return Number(result.lastInsertRowid);
}

export async function reverifyEmailById(id, options = {}) {
  const { verifyEmailImpl = verifyEmail } = options;
  const db = getDb();
  const row = db.prepare('SELECT * FROM lead_emails WHERE id = ?').get(id);
  if (!row) throw new Error(`Lead email #${id} not found`);

  const res = await verifyEmailImpl(row.email);
  db.transaction(() => saveVerificationResult(db, row.lead_id, row.email, res, { rowId: row.id }))();

  return res;
}

export function getVerificationDistribution(batchId = null) {
  const db = getDb();
  if (batchId) {
    return db.prepare(`
      SELECT le.verification_status, COUNT(*) as count
      FROM lead_emails le
      JOIN leads l ON le.lead_id = l.id
      WHERE l.batch_id = ?
      GROUP BY le.verification_status
    `).all(batchId);
  }
  return db.prepare(`
    SELECT verification_status, COUNT(*) as count
    FROM lead_emails
    GROUP BY verification_status
  `).all();
}
