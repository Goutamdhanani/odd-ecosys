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
import { fileURLToPath } from 'url';
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
  batchId: null,
  processed: 0,
  total: 0,
  currentEmail: null,
  cancelling: false,
  startedAt: null,
};

export function getVerificationStatus() {
  return { ..._state };
}

// ══════════════════════════════════════════════════════════════
//  1. PROVIDER & SYNTAX VALIDATION (Reacher Syntax Rules)
// ══════════════════════════════════════════════════════════════

export function validateSyntax(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { is_valid_syntax: false, username: null, domain: null, reason: 'missing_at_symbol' };
  }

  const parts = email.toLowerCase().trim().split('@');
  if (parts.length !== 2) {
    return { is_valid_syntax: false, username: null, domain: null, reason: 'multiple_at_symbols' };
  }

  const username = parts[0];
  const domain = parts[1];

  // Standard RFC regex
  const rfcRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!rfcRegex.test(email.trim())) {
    return { is_valid_syntax: false, username, domain, reason: 'bad_syntax' };
  }

  // Gmail / Googlemail constraints
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    if (username.length < 6 || username.length > 30) {
      return { is_valid_syntax: false, username, domain, reason: `gmail_length_invalid:${username.length}_chars (must be 6-30)` };
    }
    if (!/^[a-z0-9.]+$/i.test(username)) {
      return { is_valid_syntax: false, username, domain, reason: 'gmail_illegal_characters' };
    }
    if (username.startsWith('.') || username.endsWith('.') || username.includes('..')) {
      return { is_valid_syntax: false, username, domain, reason: 'gmail_dot_syntax_violation' };
    }
  }

  // Yahoo constraints
  if (domain === 'yahoo.com' || domain === 'ymail.com') {
    if (username.length < 4 || username.length > 32) {
      return { is_valid_syntax: false, username, domain, reason: `yahoo_length_invalid:${username.length}_chars (must be 4-32)` };
    }
    if (!/^[a-z][a-z0-9_.]*$/i.test(username)) {
      return { is_valid_syntax: false, username, domain, reason: 'yahoo_must_start_with_letter' };
    }
  }

  // Outlook / Hotmail constraints
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') {
    if (username.length < 1 || username.length > 64) {
      return { is_valid_syntax: false, username, domain, reason: 'outlook_length_invalid' };
    }
    if (username.startsWith('.') || username.endsWith('.')) {
      return { is_valid_syntax: false, username, domain, reason: 'outlook_dot_boundary_violation' };
    }
  }

  return { is_valid_syntax: true, username, domain };
}

// ══════════════════════════════════════════════════════════════
//  2. AUTHORITATIVE DNS MX RESOLUTION (Cached & Resilient)
// ══════════════════════════════════════════════════════════════

const mxResolver = new dns.promises.Resolver();
try {
  mxResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '9.9.9.9']);
} catch {}

const _mxCache = new Map();
const KNOWN_MX_MAP = {
  'google.com': 'smtp.google.com',
  'gmail.com': 'gmail-smtp-in.l.google.com',
  'googlemail.com': 'gmail-smtp-in.l.google.com',
  'yahoo.com': 'mta5.am0.yahoodns.net',
  'ymail.com': 'mta5.am0.yahoodns.net',
  'outlook.com': 'outlook-com.olc.protection.outlook.com',
  'hotmail.com': 'hotmail-com.olc.protection.outlook.com',
  'live.com': 'live-com.olc.protection.outlook.com',
  'icloud.com': 'mx1.mail.icloud.com',
  'apple.com': 'mx1.mail.icloud.com',
  'github.com': 'aspmx.l.google.com',
  'microsoft.com': 'microsoft-com.mail.protection.outlook.com',
};

async function checkMxRecords(domain) {
  const cleanDomain = (domain || '').toLowerCase().trim();
  if (!cleanDomain) return { accepts_mail: false, records: [], primary: null };

  if (_mxCache.has(cleanDomain)) {
    return _mxCache.get(cleanDomain);
  }

  try {
    let records = null;
    try {
      records = await mxResolver.resolveMx(cleanDomain);
    } catch {
      try {
        records = await dns.promises.resolveMx(cleanDomain);
      } catch {
        // Fallback to known MX if public provider lookup had transient network error
        if (KNOWN_MX_MAP[cleanDomain]) {
          records = [{ exchange: KNOWN_MX_MAP[cleanDomain], priority: 10 }];
        }
      }
    }

    if (records && records.length > 0) {
      records.sort((a, b) => a.priority - b.priority);
      const res = {
        accepts_mail: true,
        records: records.map(r => r.exchange),
        primary: records[0].exchange,
      };
      _mxCache.set(cleanDomain, res);
      return res;
    }
  } catch {}

  // Last check for major provider known fallback
  if (KNOWN_MX_MAP[cleanDomain]) {
    const res = {
      accepts_mail: true,
      records: [KNOWN_MX_MAP[cleanDomain]],
      primary: KNOWN_MX_MAP[cleanDomain],
    };
    _mxCache.set(cleanDomain, res);
    return res;
  }

  const negativeRes = { accepts_mail: false, records: [], primary: null };
  _mxCache.set(cleanDomain, negativeRes);
  return negativeRes;
}

// ══════════════════════════════════════════════════════════════
//  3. DISPOSABLE & DISIFY LIVE VERIFICATION
// ══════════════════════════════════════════════════════════════

const _disifyCache = new Map();

async function checkDisifyAndDisposable(email, domain, rules) {
  const disposableDomains = new Set([
    'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
    'temp-mail.org', 'trashmail.com', 'yopmail.com', 'sharklasers.com',
    'dispostable.com', 'fakemailgenerator.com', 'getairmail.com', 'throwawaymail.com',
    'mohmal.com', 'burnermail.io', 'inboxkitten.com', 'crazymailing.com',
    'mail2.mailinator.com', 'temp-mail.io', 'generator.email'
  ]);

  const cleanDomain = (domain || '').toLowerCase().trim();
  const username = (email || '').split('@')[0].toLowerCase().trim();

  let is_disposable = disposableDomains.has(cleanDomain);
  let is_role_account = rules.role_account_prefixes.includes(username);
  let disifyData = null;

  if (is_disposable) {
    return { is_disposable: true, is_role_account, disifyData: { disposable: true } };
  }

  // Well-known provider domains do not need third-party disify API calls
  if (KNOWN_MX_MAP[cleanDomain] || cleanDomain.endsWith('.edu') || cleanDomain.endsWith('.gov')) {
    return { is_disposable: false, is_role_account, disifyData: null };
  }

  if (_disifyCache.has(cleanDomain)) {
    const cached = _disifyCache.get(cleanDomain);
    return {
      is_disposable: cached.disposable ?? false,
      is_role_account: is_role_account || (cached.role ?? false),
      disifyData: cached,
    };
  }

  try {
    const res = await fetch(`https://disify.com/api/email/${encodeURIComponent(email)}`, {
      headers: { 'User-Agent': 'oddecosys-verifier/2.0' },
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      disifyData = await res.json();
      if (disifyData.disposable === true) is_disposable = true;
      if (disifyData.role === true) is_role_account = true;
      _disifyCache.set(cleanDomain, disifyData);
    }
  } catch {}

  return { is_disposable, is_role_account, disifyData };
}

// ══════════════════════════════════════════════════════════════
//  4. SMTP SOCKET PROBE (Port 25 Reachability & Non-Blocking Circuit Breaker)
// ══════════════════════════════════════════════════════════════

let _port25Blocked = false;
let _port25ConsecutiveTimeouts = 0;

function probeSmtp(mxHost, toEmail, fromEmail = 'verify@outreach.local', timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!mxHost) {
      return resolve({ can_connect_smtp: false, is_deliverable: false, is_catch_all: false, reason: 'no_mx_host' });
    }

    const isLocalhost = mxHost === 'localhost' || mxHost === '127.0.0.1' || mxHost === '::1';
    if (!isLocalhost && _port25Blocked) {
      return resolve({ can_connect_smtp: false, is_deliverable: null, is_catch_all: false, reason: 'smtp_port25_timeout_blocked' });
    }

    const socket = net.createConnection(25, mxHost);
    let step = 0;
    let completed = false;

    const finish = (result) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => {
      if (!isLocalhost) {
        _port25ConsecutiveTimeouts++;
        if (_port25ConsecutiveTimeouts >= 1) _port25Blocked = true;
      }
      finish({ can_connect_smtp: false, is_deliverable: null, is_catch_all: false, reason: 'smtp_port25_timeout_blocked' });
    });

    socket.on('error', (err) => {
      if (!isLocalhost && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENETUNREACH' || err.code === 'EHOSTUNREACH')) {
        _port25ConsecutiveTimeouts++;
        if (_port25ConsecutiveTimeouts >= 1) _port25Blocked = true;
      }
      finish({ can_connect_smtp: false, is_deliverable: null, is_catch_all: false, reason: err.message });
    });

    socket.on('data', (data) => {
      if (!isLocalhost) {
        _port25Blocked = false;
        _port25ConsecutiveTimeouts = 0;
      }
      const msg = data.toString();
      const code = parseInt(msg.slice(0, 3));

      if (step === 0 && (code === 220 || code === 250)) {
        step = 1;
        socket.write(`EHLO outreach.local\r\n`);
      } else if (step === 1 && (code === 250 || code === 220)) {
        step = 2;
        socket.write(`MAIL FROM:<${fromEmail}>\r\n`);
      } else if (step === 2 && code === 250) {
        step = 3;
        socket.write(`RCPT TO:<${toEmail}>\r\n`);
      } else if (step === 3) {
        if (code === 250) {
          socket.write(`QUIT\r\n`);
          finish({ can_connect_smtp: true, is_deliverable: true, is_catch_all: false, code });
        } else if (code >= 500 && code <= 559) {
          const lowerMsg = msg.toLowerCase();
          const isPolicyBlock = lowerMsg.includes('5.7.1') || lowerMsg.includes('5.7.26') || lowerMsg.includes('spf') || lowerMsg.includes('spam') || lowerMsg.includes('client host') || lowerMsg.includes('blocked');
          finish({
            can_connect_smtp: true,
            is_deliverable: isPolicyBlock ? null : false,
            is_catch_all: false,
            code,
            reason: isPolicyBlock ? `smtp_policy_blocked:${code}` : `smtp_rejected:${code}`
          });
        } else {
          finish({ can_connect_smtp: true, is_deliverable: null, is_catch_all: false, code, reason: `ambiguous_response:${code}` });
        }
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
  const is_catch_all = r.smtp?.is_catch_all || false;
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
    reasonLabel = 'Unconfirmed Mailbox';
    reasons.push('smtp_unconfirmed');
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
      mailbox_full: false,
      no_reply: /noreply|no-reply|do-not-reply/i.test(username),
      secure_email_gateway: /pphosted|mimecast|barracuda|proofpoint/i.test(mx_host || ''),
    },
    mail_server: {
      smtp_provider: provider,
      mx_record: mx_host,
      implicit_mx_record: false,
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

// ══════════════════════════════════════════════════════════════
//  MASTER EMAIL VERIFICATION (Reacher Docker → Local Fallback)
// ══════════════════════════════════════════════════════════════

export async function verifyEmail(email) {
  const cleanEmail = (email || '').toLowerCase().trim();
  const rules = getRules();

  // 1. Syntax & Provider Constraints Check (Fast Gate)
  const syntax = validateSyntax(cleanEmail);
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
        free: false,
        role: false,
        disposable: false,
        accept_all: false,
        tag: false,
        numerical_characters: 0,
        alphabetical_characters: 0,
        unicode_symbols: 0,
        mailbox_full: false,
        no_reply: false,
        secure_email_gateway: false,
      },
      mail_server: {
        smtp_provider: 'Unknown',
        mx_record: null,
        implicit_mx_record: false,
      },
      is_disposable: false,
      is_free_provider: false,
      is_role_account: false,
      is_catch_all: false,
      mx_host: null,
      checks: { regex: false, mx: null, disposable: null, smtp: null },
      reasons: [syntax.reason],
      reacher: {
        input: cleanEmail,
        is_reachable: 'invalid',
        syntax,
        mx: { accepts_mail: false, records: [] },
        misc: { is_disposable: false, is_role_account: false },
        smtp: { can_connect_smtp: false, is_deliverable: false },
      },
    };
  }

  // 3. Reacher Docker Backend (auto-detected at localhost:8080 or REACHER_API_URL)
  const reacherUp = await isReacherAvailable();
  if (reacherUp) {
    try {
      const res = await fetch(REACHER_API_URL, {
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
  const mx = await checkMxRecords(syntax.domain);
  if (!mx.accepts_mail) {
    return {
      email: cleanEmail,
      valid: false,
      verification_status: 'undeliverable',
      is_disposable: false,
      is_free_provider: false,
      is_role_account: false,
      is_catch_all: false,
      mx_host: null,
      checks: { regex: true, mx: false, disposable: null, smtp: null },
      reasons: ['no_mx_records_found'],
      reacher: {
        input: cleanEmail,
        is_reachable: 'invalid',
        syntax,
        mx,
        misc: { is_disposable: false, is_role_account: false },
        smtp: { can_connect_smtp: false, is_deliverable: false },
      },
    };
  }

  // 4. Disposable & Disify Verification
  const { is_disposable, is_role_account, disifyData } = await checkDisifyAndDisposable(cleanEmail, syntax.domain, rules);
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
        smtp: { can_connect_smtp: false, is_deliverable: false },
      },
    };
  }

  // 5. Socket SMTP Handshake
  const smtp = await probeSmtp(mx.primary, cleanEmail);

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
    // Port 25 blocked locally — mailbox existence cannot be confirmed
    status = 'risky';
    isValid = false;
    reasons.push('smtp_unconfirmed_port25_blocked');
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
    else reasonLabel = 'Unconfirmed Mailbox (Port 25 Blocked)';
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
      accept_all: smtp.is_catch_all || false,
      tag: hasTag,
      numerical_characters: numDigits,
      alphabetical_characters: numLetters,
      unicode_symbols: numUnicode,
      mailbox_full: false,
      no_reply: isNoReply,
      secure_email_gateway: /pphosted|mimecast|barracuda|proofpoint|subspace|fireeye|forcepoint/i.test(mx.primary || ''),
    },
    mail_server: {
      smtp_provider: provider,
      mx_record: mx.primary || null,
      implicit_mx_record: false,
    },
    is_disposable: is_disposable,
    is_free_provider: is_free_provider,
    is_role_account: is_role_account,
    is_catch_all: smtp.is_catch_all || false,
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
  const { dryRun = false, onProgress, delayMs } = options;
  const rules = getRules();
  const db = getDb();

  const leads = db.prepare(`
    SELECT l.id, l.business_name, l.email, l.batch_id
    FROM leads l
    WHERE l.batch_id = ? AND l.status IN ('site_checked', 'discovered', 'verifying')
    AND l.email IS NOT NULL AND l.email != ''
    ORDER BY l.id
  `).all(batchId);

  _state.active = true;
  _state.batchId = batchId;
  _state.total = leads.length;
  _state.processed = 0;
  _state.deliverable = 0;
  _state.risky = 0;
  _state.undeliverable = 0;
  _state.startedAt = new Date().toISOString();

  // Prepare SQL statements once for high performance and smooth execution
  const findExistingStmt = db.prepare('SELECT id FROM lead_emails WHERE lead_id = ? AND LOWER(email) = LOWER(?)');
  const updateLeadEmailStmt = db.prepare(`
    UPDATE lead_emails SET
      is_primary = ?,
      verification_status = ?,
      confidence_score = ?,
      is_catch_all = ?,
      is_role_account = ?,
      is_free_provider = ?,
      is_disposable = ?,
      mx_host = ?,
      verification_json = ?,
      verified_at = datetime('now')
    WHERE id = ?
  `);
  const insertLeadEmailStmt = db.prepare(`
    INSERT INTO lead_emails (
      lead_id, email, source, is_primary, verification_status, confidence_score,
      is_catch_all, is_role_account, is_free_provider, is_disposable,
      mx_host, verification_json, verified_at
    ) VALUES (?, ?, 'verifier', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const updateLeadStatusStmt = db.prepare(`
    UPDATE leads SET status = ?, email = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const getSecondaryEmailsStmt = db.prepare(`
    SELECT id, email FROM lead_emails WHERE lead_id = ? AND email != ?
  `);

  let deliverable = 0;
  let risky = 0;
  let undeliverable = 0;

  for (const lead of leads) {
    if (_state.cancelling) break;
    _state.currentEmail = lead.email;

    // 1. Verify primary email
    const res = await verifyEmail(lead.email);
    let chosenEmail = lead.email;
    let chosenStatus = res.verification_status;

    if (!dryRun) {
      const existing = findExistingStmt.get(lead.id, lead.email);
      if (existing) {
        updateLeadEmailStmt.run(
          1,
          res.verification_status,
          res.score || (res.valid ? 90 : 20),
          res.is_catch_all ? 1 : 0,
          res.is_role_account ? 1 : 0,
          res.is_free_provider ? 1 : 0,
          res.is_disposable ? 1 : 0,
          res.mx_host,
          JSON.stringify(res),
          existing.id
        );
      } else {
        insertLeadEmailStmt.run(
          lead.id,
          lead.email,
          1,
          res.verification_status,
          res.score || (res.valid ? 90 : 20),
          res.is_catch_all ? 1 : 0,
          res.is_role_account ? 1 : 0,
          res.is_free_provider ? 1 : 0,
          res.is_disposable ? 1 : 0,
          res.mx_host,
          JSON.stringify(res)
        );
      }
    }

    if (res.verification_status === 'deliverable') deliverable++;
    else if (res.verification_status === 'risky') risky++;
    else undeliverable++;

    // 2. Also verify any secondary emails discovered for this lead in lead_emails
    const secondaryRows = getSecondaryEmailsStmt.all(lead.id, lead.email);
    for (const sec of secondaryRows) {
      if (_state.cancelling) break;
      const secRes = await verifyEmail(sec.email);
      if (!dryRun) {
        updateLeadEmailStmt.run(
          0,
          secRes.verification_status,
          secRes.score || (secRes.valid ? 90 : 20),
          secRes.is_catch_all ? 1 : 0,
          secRes.is_role_account ? 1 : 0,
          secRes.is_free_provider ? 1 : 0,
          secRes.is_disposable ? 1 : 0,
          secRes.mx_host,
          JSON.stringify(secRes),
          sec.id
        );
      }

      if (secRes.verification_status === 'deliverable') deliverable++;
      else if (secRes.verification_status === 'risky') risky++;
      else undeliverable++;

      // If primary was undeliverable but this secondary is deliverable or acceptable, promote it!
      if (chosenStatus === 'undeliverable' && secRes.verification_status !== 'undeliverable') {
        chosenEmail = sec.email;
        chosenStatus = secRes.verification_status;
        if (!dryRun) {
          updateLeadEmailStmt.run(
            1,
            secRes.verification_status,
            secRes.score || 90,
            secRes.is_catch_all ? 1 : 0,
            secRes.is_role_account ? 1 : 0,
            secRes.is_free_provider ? 1 : 0,
            secRes.is_disposable ? 1 : 0,
            secRes.mx_host,
            JSON.stringify(secRes),
            sec.id
          );
        }
      }
    }

    // 3. Update lead status in leads table
    if (!dryRun) {
      const nextStatus = chosenStatus === 'undeliverable' ? 'disqualified' : 'verified';
      updateLeadStatusStmt.run(nextStatus, chosenEmail, lead.id);
    }

    _state.processed++;
    _state.deliverable = deliverable;
    _state.risky = risky;
    _state.undeliverable = undeliverable;

    if (onProgress) {
      onProgress({ ..._state });
    }

    const stepDelay = delayMs !== undefined ? delayMs : (dryRun ? 0 : 50);
    if (stepDelay > 0) await sleep(stepDelay);
  }

  _state.active = false;
  _state.cancelling = false;

  return {
    batchId,
    total: leads.length,
    processed: _state.processed,
    deliverable,
    risky,
    undeliverable,
  };
}

export function cancelVerification() {
  if (_state.active) _state.cancelling = true;
  return { cancelling: true };
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

  const results = db.prepare(query).all(...params);
  return { results, total, limit, offset };
}

export async function reverifyEmailById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM lead_emails WHERE id = ?').get(id);
  if (!row) throw new Error(`Lead email #${id} not found`);

  const res = await verifyEmail(row.email);

  db.prepare(`
    UPDATE lead_emails SET
      verification_status = ?,
      confidence_score = ?,
      is_catch_all = ?,
      is_role_account = ?,
      is_free_provider = ?,
      is_disposable = ?,
      mx_host = ?,
      verification_json = ?,
      verified_at = datetime('now')
    WHERE id = ?
  `).run(
    res.verification_status,
    res.score || (res.valid ? 90 : 20),
    res.is_catch_all ? 1 : 0,
    res.is_role_account ? 1 : 0,
    res.is_free_provider ? 1 : 0,
    res.is_disposable ? 1 : 0,
    res.mx_host,
    JSON.stringify(res),
    id
  );

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
