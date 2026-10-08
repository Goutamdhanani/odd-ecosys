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
import { isIP } from 'node:net';
import { domainToASCII, fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { getDb } from './database.js';

const dnsPromises = dns.promises;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'sending-engine.json');
let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return _config;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

export function getSendingStatus() {
  return { ..._sendState };
}

export function cancelSending() {
  if (_sendState.active) { _sendState.cancelling = true; return true; }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  REAL DNS VERIFICATION (SPF, DMARC, MX, DNSBL)
// ══════════════════════════════════════════════════════════════

/**
 * Perform real DNS lookups on a domain.
 * Resolves SPF, DMARC (_dmarc.<domain>), MX, and DNSBL reputation.
 */
export async function checkDomainDns(domain) {
  const result = {
    domain,
    spf_ok: 0,
    dkim_ok: 0,
    dkim_status: 'unknown',
    dkim_selector: null,
    dkim_record: null,
    dmarc_ok: 0,
    blacklisted: 0,
    blacklist_status: 'unknown',
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

  // 4. DNSBL Reputation Check (query major real-time blocklists)
  // Each blocklist query has its own observed outcome:
  //   listed      -> resolver returned an address (evidence of a listing)
  //   not_listed  -> resolver returned NXDOMAIN/NOERROR-empty (the DNSBL "not listed" signal)
  //   unavailable -> timeout / servfail / network error: unknown, NOT clean
  // Checked against the domain's A-record IPs (domain-level evidence only).
  // This is NOT proof that a specific mailbox or sending IP is unlisted.
  try {
    let ips = [];
    try {
      ips = await dnsPromises.resolve4(domain);
    } catch {
      result.dnsbl_status = 'no_a_record';
    }
    if (ips.length > 0) {
      const ip = ips[0];
      const reversedIp = ip.split('.').reverse().join('.');
      const blocklists = [
        'zen.spamhaus.org',
        'b.barracudacentral.org',
        'dnsbl.sorbs.net',
      ];

      const outcomes = [];
      for (const bl of blocklists) {
        try {
          await dnsPromises.resolve4(`${reversedIp}.${bl}`);
          outcomes.push({ blocklist: bl, outcome: 'listed', checked_ip: ip });
        } catch (err) {
          if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
            outcomes.push({ blocklist: bl, outcome: 'not_listed', checked_ip: ip });
          } else {
            outcomes.push({ blocklist: bl, outcome: 'unavailable', checked_ip: ip, error: err.code || 'DNS_ERROR' });
          }
        }
      }
      result.dnsbl_checks = outcomes;
      result.blacklist_matches = outcomes.filter(o => o.outcome === 'listed').map(o => o.blocklist);
      const anyListed = result.blacklist_matches.length > 0;
      const anyUnavailable = outcomes.some(o => o.outcome === 'unavailable');
      const allNotListed = outcomes.length > 0 && outcomes.every(o => o.outcome === 'not_listed');
      result.blacklisted = anyListed ? 1 : 0;
      result.blacklist_status = anyListed ? 'listed' : allNotListed ? 'not_listed' : anyUnavailable ? 'unavailable' : 'unknown';
    } else if (!result.dnsbl_status) {
      result.dnsbl_status = 'no_a_record';
    }
  } catch {
    result.blacklist_status = 'unavailable';
  }

  // DKIM: actual selector discovery via <selector>._domainkey.<domain> TXT lookups.
  // A published DKIM key is a real DNS observation; it is NOT proof that a given
  // message was signed or that signatures align. If no selector resolves, the
  // outcome is unknown, never a pass derived from SPF/DMARC.
  const selectors = (getConfig().dkim_selectors || ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 'dkim', 'mail', 'zoho', 'mandrill']);
  let dnsError = false;
  for (const sel of selectors) {
    try {
      const records = await dnsPromises.resolveTxt(`${sel}._domainkey.${domain}`);
      const flattened = records.map(r => r.join(''));
      if (flattened.length > 0) {
        result.dkim_ok = 1;
        result.dkim_status = 'key_published';
        result.dkim_selector = sel;
        result.dkim_record = flattened.find(t => t.startsWith('v=DKIM1')) || flattened[0];
        break;
      }
    } catch (err) {
      if (err.code !== 'ENOTFOUND' && err.code !== 'ENODATA') dnsError = true;
    }
  }
  if (!result.dkim_ok) {
    result.dkim_status = dnsError ? 'unknown' : 'no_selector_found';
    result.dkim_selector = null;
    result.dkim_record = null;
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
  `).run(mb.domain, dnsData.spf_ok, dnsData.dkim_ok, dnsData.dkim_status, dnsData.dmarc_ok, dnsData.blacklisted, dnsData.blacklist_status);

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
  const pass = typeof mailbox.smtp_pass === 'string' ? mailbox.smtp_pass : '';
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

    // Blacklist check
    if (mb.blacklisted) score = Math.min(score, 5);

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
  const daysSinceStart = mailbox.warmup_started_at
    ? Math.floor((Date.now() - new Date(mailbox.warmup_started_at).getTime()) / 86400000)
    : 0;

  const week = Math.ceil(daysSinceStart / 7) || 1;
  const ramp = config.warmup_ramp.find(r => r.week >= week) || config.warmup_ramp[config.warmup_ramp.length - 1];

  return {
    day: daysSinceStart,
    week,
    warmupPerDay: ramp.warmup_per_day,
    coldPerDay: ramp.cold_per_day,
    eligible: daysSinceStart >= config.warmup_total_days,
    totalDays: config.warmup_total_days,
  };
}

export function processWarmupTransitions() {
  const db = getDb();
  const config = getConfig();
  const warming = db.prepare("SELECT * FROM mailboxes WHERE warmup_status = 'warming' AND active = 1").all();
  const transitioned = [];

  for (const mb of warming) {
    const info = getWarmupInfo(mb);
    if (info.eligible && mb.health_score >= config.min_health_to_send) {
      db.prepare("UPDATE mailboxes SET warmup_status = 'eligible', daily_limit = ? WHERE id = ?")
        .run(config.max_daily_per_mailbox, mb.id);
      transitioned.push({ id: mb.id, email: mb.email });
    }
  }

  return transitioned;
}

// ══════════════════════════════════════════════════════════════
//  MAILBOX ROTATION (Weighted Round-Robin)
// ══════════════════════════════════════════════════════════════

export function selectMailbox() {
  const db = getDb();
  const config = getConfig();

  const eligible = db.prepare(`
    SELECT m.*,
      COALESCE((SELECT COUNT(*) FROM sends s
        WHERE s.mailbox_id = m.id AND s.sent_at >= date('now')), 0) as today_sent
    FROM mailboxes m
    WHERE m.warmup_status = 'eligible'
      AND m.active = 1
      AND m.health_score >= ?
    ORDER BY m.health_score DESC
  `).all(config.min_health_to_send);

  const withCapacity = eligible.filter(m => m.today_sent < m.daily_limit);
  if (withCapacity.length === 0) return null;

  const domainCounts = {};
  for (const m of withCapacity) {
    if (!domainCounts[m.domain]) {
      domainCounts[m.domain] = db.prepare(`
        SELECT COUNT(*) as count FROM sends s
        JOIN mailboxes mb ON s.mailbox_id = mb.id
        WHERE mb.domain = ? AND s.sent_at >= date('now')
      `).get(m.domain).count;
    }
  }

  const domainEligible = withCapacity.filter(
    m => domainCounts[m.domain] < config.max_daily_per_domain
  );
  if (domainEligible.length === 0) return null;

  const totalWeight = domainEligible.reduce((s, m) => s + m.health_score, 0);
  let roll = Math.random() * totalWeight;
  for (const m of domainEligible) {
    roll -= m.health_score;
    if (roll <= 0) return m;
  }

  return domainEligible[0];
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

export async function queueSends(campaignId, options = {}) {
  const { limit = 100, dryRun = false } = options;
  const db = getDb();

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) throw new Error(`Campaign #${campaignId} not found`);

  const leads = db.prepare(`
    SELECT l.*, p.id as personalization_id, p.subject_line, p.body_text, p.subject_variant, p.body_variant
    FROM leads l
    JOIN personalizations p ON p.lead_id = l.id
    WHERE l.status IN ('queued', 'awaiting_approval')
      AND p.approved = 1
      AND p.guardrail_passed = 1
      AND l.email IS NOT NULL
    ORDER BY l.id
    LIMIT ?
  `).all(limit);

  const suppressed = new Set(
    db.prepare('SELECT email FROM suppression_list').all().map(r => r.email.toLowerCase())
  );

  const queued = [];
  const skipped = [];

  for (const lead of leads) {
    if (suppressed.has(lead.email.toLowerCase())) {
      skipped.push({ leadId: lead.id, email: lead.email, reason: 'suppressed' });
      continue;
    }

    const alreadySent = db.prepare(
      'SELECT id FROM sends WHERE lead_id = ? AND campaign_id = ? AND status IN (?, ?)'
    ).get(lead.id, campaignId, 'sent', 'scheduled');
    if (alreadySent) {
      skipped.push({ leadId: lead.id, email: lead.email, reason: 'already_sent' });
      continue;
    }

    const mailbox = selectMailbox();
    if (!mailbox) {
      skipped.push({ leadId: lead.id, email: lead.email, reason: 'no_mailbox_available' });
      continue;
    }

    const config = getConfig();
    const jitterMs = config.jitter_ms.min + Math.random() * (config.jitter_ms.max - config.jitter_ms.min);
    const scheduledAt = new Date(Date.now() + queued.length * jitterMs).toISOString();
    const variant = lead.subject_variant || lead.body_variant || 'A';

    if (!dryRun) {
      const result = db.prepare(`
        INSERT INTO sends (lead_id, mailbox_id, campaign_id, personalization_id, variant, scheduled_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
      `).run(lead.id, mailbox.id, campaignId, lead.personalization_id, variant, scheduledAt);

      db.prepare("UPDATE leads SET status = 'queued', updated_at = datetime('now') WHERE id = ?").run(lead.id);

      queued.push({
        sendId: result.lastInsertRowid,
        leadId: lead.id,
        email: lead.email,
        mailboxId: mailbox.id,
        mailboxEmail: mailbox.email,
        variant,
        scheduledAt,
      });
    } else {
      queued.push({ leadId: lead.id, email: lead.email, mailbox: mailbox.email, variant, scheduledAt });
    }
  }

  return { campaignId, queued: queued.length, skipped: skipped.length, queuedList: queued, skippedList: skipped };
}

export async function processSendQueue(options = {}) {
  const { limit = 50 } = options;
  const db = getDb();
  const config = getConfig();

  const pending = db.prepare(`
    SELECT s.*, l.email as recipient_email, l.business_name,
      m.email as from_email, m.domain as from_domain, m.from_name,
      m.smtp_host, m.smtp_port, m.smtp_user, m.smtp_pass, m.smtp_secure,
      p.subject_line, p.body_text
    FROM sends s
    JOIN leads l ON s.lead_id = l.id
    JOIN mailboxes m ON s.mailbox_id = m.id
    JOIN personalizations p ON s.personalization_id = p.id
    WHERE s.status = 'scheduled'
    AND julianday(s.scheduled_at) <= julianday('now')
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

  const updateSend = db.prepare("UPDATE sends SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END, error_message = ? WHERE id = ?");
  const insertEvent = db.prepare("INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json) VALUES (?, ?, ?, datetime('now'), ?)");
  const updateLead = db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?");

  let sentCount = 0;
  let failCount = 0;

  for (const send of pending) {
    if (_sendState.cancelling) break;

    _sendState.currentLead = send.business_name;

    try {
      const settings = inspectSmtpSettings(send);
      if (settings.ok) {
        const transporter = createMailboxTransporter(settings);
        const fromName = send.from_name || 'Outreach';
        const info = await transporter.sendMail({
          from: `"${fromName}" <${send.from_email}>`,
          to: send.recipient_email,
          subject: send.subject_line,
          text: send.body_text,
          headers: {
            'List-Unsubscribe': `<mailto:unsubscribe@${send.from_domain}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        if (!info.accepted?.length || info.rejected?.length) {
          throw new Error('SMTP did not accept the recipient');
        }
        updateSend.run('sent', 'sent', null, send.id);
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
        sentCount++;
      } else {
        const err = new Error(settings.error);
        err.code = settings.code;
        throw err;
      }
    } catch (err) {
      updateSend.run('failed', 'failed', err.message, send.id);
      // Configuration/auth/network failures do not prove a recipient bounce.
      insertEvent.run(send.id, send.lead_id, 'send_failed', JSON.stringify({ code: err.code || 'SMTP_SEND_FAILED', error: err.message }));
      _sendState.errors.push({ sendId: send.id, error: err.message });
      failCount++;
    }

    _sendState.processed++;
    const jitterMs = config.jitter_ms.min / 10 + Math.random() * (config.jitter_ms.max / 10 - config.jitter_ms.min / 10);
    await sleep(Math.min(jitterMs, 1500));
  }

  _sendState.active = false;
  _sendState.currentLead = null;

  const autoPaused = checkAutoThresholds();

  return {
    processed: _sendState.processed,
    sent: sentCount,
    failed: failCount,
    autoPaused,
    cancelled: _sendState.cancelling,
  };
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
  const smtpPass = data.smtp_pass || null;
  const smtpSecure = data.smtp_secure != null ? (data.smtp_secure ? 1 : 0) : (smtpPort === 465 ? 1 : 0);
  const dailyLimit = parseInt(data.daily_limit) || 0;

  // Run initial real DNS check in background
  const dnsCheck = await checkDomainDns(domain).catch(() => ({ spf_ok: 0, dkim_ok: 0, dmarc_ok: 0, blacklisted: 0 }));

  // Insert or update domain record
  db.prepare(`
    INSERT OR REPLACE INTO domains (domain, spf_ok, dkim_ok, dmarc_ok, blacklisted)
    VALUES (?, ?, ?, ?, ?)
  `).run(domain, dnsCheck.spf_ok, dnsCheck.dkim_ok, dnsCheck.dmarc_ok, dnsCheck.blacklisted);

  const result = db.prepare(`
    INSERT INTO mailboxes (
      email, domain, provider, from_name,
      smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure,
      warmup_status, warmup_started_at, daily_limit, health_score, active,
      spf_ok, dkim_ok, dmarc_ok, blacklisted, dns_checked_at, dns_records_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'warming', datetime('now'), ?, 100, 1, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    email, domain, provider, fromName,
    smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure,
    dailyLimit,
    dnsCheck.spf_ok, dnsCheck.dkim_ok, dnsCheck.dmarc_ok, dnsCheck.blacklisted,
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

export function updateMailbox(id, data) {
  const db = getDb();
  const fields = [];
  const vals = [];

  if (data.daily_limit !== undefined) { fields.push('daily_limit = ?'); vals.push(parseInt(data.daily_limit)); }
  if (data.from_name !== undefined)   { fields.push('from_name = ?'); vals.push(data.from_name); }
  if (data.smtp_host !== undefined)   { fields.push('smtp_host = ?'); vals.push(data.smtp_host); }
  if (data.smtp_port !== undefined)   { fields.push('smtp_port = ?'); vals.push(parseInt(data.smtp_port)); }
  if (data.smtp_user !== undefined)   { fields.push('smtp_user = ?'); vals.push(data.smtp_user); }
  if (data.smtp_pass !== undefined)   { fields.push('smtp_pass = ?'); vals.push(data.smtp_pass); }
  if (data.smtp_secure !== undefined) { fields.push('smtp_secure = ?'); vals.push(data.smtp_secure ? 1 : 0); }
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
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO campaigns (name, sequence_step, template_ref)
    VALUES (?, ?, ?)
  `).run(data.name, data.sequence_step || 1, data.template_ref || null);

  return { id: result.lastInsertRowid, name: data.name };
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
        WHERE s.mailbox_id = m.id AND s.sent_at >= date('now')), 0) as today_sent,
      COALESCE(m.spf_ok, d.spf_ok, 0) as spf_ok,
      COALESCE(m.dkim_ok, d.dkim_ok, 0) as dkim_ok,
      COALESCE(m.dmarc_ok, d.dmarc_ok, 0) as dmarc_ok,
      COALESCE(m.blacklisted, d.blacklisted, 0) as blacklisted
    FROM mailboxes m
    LEFT JOIN domains d ON d.domain = m.domain
    WHERE m.active = 1
    ORDER BY m.health_score DESC
  `).all();
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
    failed: db.prepare("SELECT COUNT(*) as c FROM sends WHERE status = 'failed'").get().c,
    today_sent: db.prepare("SELECT COUNT(*) as c FROM sends WHERE sent_at >= date('now')").get().c,
  };
}
