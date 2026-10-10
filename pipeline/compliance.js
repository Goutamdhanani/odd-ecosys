// ============================================================
//  ODD-ECOSYS Pipeline — Compliance & Deliverability (Phase 0)
//  CAN-SPAM, GDPR/PECR, CASL & 2024+ Bulk Sender Standards
//  RFC 8058 One-Click Unsubscribe, Global Suppression List,
//  Physical Mailing Address Footer, Pre-send Compliance Gate
// ============================================================

import crypto from 'crypto';
import { getDb } from './database.js';

const LEGACY_SECRET_MIN_BYTES = 32;
const TEST_PHYSICAL_ADDRESS = '100 Test Loopback Lane, Testville, ZZ 00001';

/**
 * Generate a cryptographically signed unsubscribe token for a lead.
 */
export function generateUnsubscribeToken(email, leadId, sendId = null) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanLeadId = Number(leadId);
  if (!cleanEmail || !Number.isSafeInteger(cleanLeadId) || cleanLeadId < 1) throw new TypeError('A recipient email and contact id are required for unsubscribe tokens.');
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  getDb().prepare('INSERT INTO unsubscribe_tokens (token_hash,email,lead_id,send_id) VALUES (?,?,?,?)').run(tokenHash, cleanEmail, cleanLeadId, sendId);
  return token;
}

/**
 * Verify and decode an unsubscribe token.
 */
export function verifyUnsubscribeToken(token) {
  try {
    if (typeof token !== 'string' || token.length < 20 || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return { valid: false, email: null, leadId: null };
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const stored = getDb().prepare('SELECT email,lead_id,send_id,used_at FROM unsubscribe_tokens WHERE token_hash = ?').get(tokenHash);
    if (stored) return { valid: true, email: stored.email, leadId: stored.lead_id, sendId: stored.send_id, usedAt: stored.used_at, stored: true };

    // Accept links sent by older versions while they are still in recipients' inboxes.
    const legacySecret = process.env.COMPLIANCE_SECRET;
    if (typeof legacySecret !== 'string' || Buffer.byteLength(legacySecret) < LEGACY_SECRET_MIN_BYTES) {
      return { valid: false, email: null, leadId: null };
    }
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const match = raw.match(/^([^:\s]+):([1-9]\d*):([a-f0-9]{16})$/i);
    if (!match) return { valid: false, email: null, leadId: null };
    const email = match[1].toLowerCase();
    const leadId = Number(match[2]);
    if (!Number.isSafeInteger(leadId) || leadId < 1) return { valid: false, email: null, leadId: null };
    const expected = crypto.createHash('sha256').update(`${email}:${leadId}:${legacySecret}`).digest('hex').slice(0, 16);
    const suppliedHash = Buffer.from(match[3].toLowerCase());
    const expectedHash = Buffer.from(expected);
    if (crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      return { valid: true, email, leadId, stored: false };
    }
  } catch {
    // Invalid encoding
  }
  return { valid: false, email: null, leadId: null };
}

function getHttpsPublicBaseUrl() {
  const configured = process.env.APP_URL || process.env.ODD_PUBLIC_BASE_URL
    || (process.env.NODE_ENV === 'test' ? 'https://mail.test.invalid' : null);
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function getPhysicalAddress() {
  const configured = process.env.COMPANY_PHYSICAL_ADDRESS?.trim();
  if (configured) return configured;
  return process.env.NODE_ENV === 'test' ? TEST_PHYSICAL_ADDRESS : null;
}

function physicalAddressIsPlausiblyConfigured(address) {
  return Boolean(address && address.length >= 12
    && !/(?:placeholder|outreach way|your (?:business )?address|change\s*me|todo|example address)/i.test(address));
}

export function getComplianceReadiness() {
  const baseUrl = getHttpsPublicBaseUrl();
  const physicalAddress = getPhysicalAddress();
  const blockers = [];
  if (!baseUrl) blockers.push('https_unsubscribe_endpoint_not_configured');
  if (!physicalAddressIsPlausiblyConfigured(physicalAddress)) blockers.push('physical_mailing_address_not_configured');
  return {
    ok: blockers.length === 0,
    blockers,
    unsubscribeEndpointConfigured: Boolean(baseUrl),
    physicalAddressConfigured: physicalAddressIsPlausiblyConfigured(physicalAddress),
    configurationFingerprint: crypto.createHash('sha256').update(JSON.stringify([baseUrl, physicalAddress])).digest('hex'),
  };
}

/** Build the one-click headers and human footer from the same stored capability token. */
export function buildComplianceEnvelope(leadEmail, leadId, domain, sendId = null) {
  const readiness = getComplianceReadiness();
  if (!readiness.ok) return { ok: false, blockers: readiness.blockers };
  const baseUrl = getHttpsPublicBaseUrl();
  const physicalAddress = getPhysicalAddress();
  const token = generateUnsubscribeToken(leadEmail, leadId, sendId);
  const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;
  const unsubscribeMailto = `mailto:unsubscribe@${domain || 'outreach.local'}?subject=unsubscribe`;
  return {
    ok: true,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>, <${unsubscribeMailto}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Entity-Ref-ID': `lead-${leadId}-${Date.now()}`,
      'X-Compliant-CAN-SPAM': 'true',
    },
    textFooter: `\n\n---\n${physicalAddress}\nTo stop receiving these emails, use: ${unsubscribeUrl}`,
  };
}

/**
 * Generate RFC 8058 compliant headers for an outgoing send.
 */
export function getComplianceHeaders(leadEmail, leadId, domain, sendId = null) {
  const baseUrl = getHttpsPublicBaseUrl();
  const unsubMailto = `mailto:unsubscribe@${domain || 'outreach.local'}?subject=unsubscribe`;
  const physicalAddress = getPhysicalAddress();
  const headers = {
    'List-Unsubscribe': baseUrl
      ? `<${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(leadEmail, leadId, sendId)}>, <${unsubMailto}>`
      : `<${unsubMailto}>`,
    'X-Entity-Ref-ID': `lead-${leadId}-${Date.now()}`,
  };
  if (baseUrl) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  if (physicalAddressIsPlausiblyConfigured(physicalAddress)) headers['X-Compliant-CAN-SPAM'] = 'true';
  return headers;
}

/**
 * Append standard physical address and unsubscribe footer to body.
 */
export function appendComplianceFooter(bodyText, leadEmail, leadId, domain) {
  const baseUrl = getHttpsPublicBaseUrl();
  const physicalAddress = getPhysicalAddress();
  if (!physicalAddressIsPlausiblyConfigured(physicalAddress)) throw new Error('A real COMPANY_PHYSICAL_ADDRESS is required before sending compliant email.');
  const unsubscribe = baseUrl
    ? `${baseUrl}/api/unsubscribe?token=${generateUnsubscribeToken(leadEmail, leadId)}`
    : `mailto:unsubscribe@${domain || 'outreach.local'}?subject=unsubscribe`;
  const footer = `\n\n---\n${physicalAddress}\nTo stop receiving these emails, use: ${unsubscribe}`;
  return bodyText + footer;
}

/**
 * Check if an email address is in the global suppression list.
 */
export function isSuppressed(email) {
  if (!email) return false;
  const db = getDb();
  const found = db.prepare('SELECT email, reason FROM suppression_list WHERE email = ?').get(email.toLowerCase().trim());
  return !!found;
}

/**
 * Add an email to global suppression list permanently.
 */
export function suppressEmail(email, reason = 'unsubscribed', leadId = null) {
  if (!email) return false;
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();

  db.prepare(`
    INSERT OR IGNORE INTO suppression_list (email, reason, added_at)
    VALUES (?, ?, datetime('now'))
  `).run(cleanEmail, reason);

  // If lead exists, update lead status to disqualified
  if (leadId) {
    db.prepare("UPDATE leads SET status = 'disqualified', disqualification_reason = ?, updated_at = datetime('now') WHERE id = ?")
      .run(`suppressed:${reason}`, leadId);
  } else {
    db.prepare("UPDATE leads SET status = 'disqualified', disqualification_reason = ?, updated_at = datetime('now') WHERE lower(email) = ?")
      .run(`suppressed:${reason}`, cleanEmail);
  }

  // Record suppression event
  db.prepare(`
    INSERT INTO events (lead_id, event_type, event_at, meta_json)
    VALUES (?, 'unsubscribed', datetime('now'), ?)
  `).run(leadId || null, JSON.stringify({ email: cleanEmail, reason }));

  return true;
}

export function unsubscribeFromToken(token) {
  const verified = verifyUnsubscribeToken(token);
  if (!verified.valid) return { ok: false, status: 'invalid_token' };
  const db = getDb();
  const cleanEmail = verified.email.toLowerCase().trim();

  return db.transaction(() => {
    const existingSuppression = db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email)) = ?').get(cleanEmail);
    const existingToken = verified.stored
      ? db.prepare('SELECT used_at FROM unsubscribe_tokens WHERE token_hash = ?').get(crypto.createHash('sha256').update(token).digest('hex'))
      : null;
    if (existingToken?.used_at) return { ok: true, status: 'already_unsubscribed' };

    db.prepare('INSERT OR IGNORE INTO suppression_list (email,reason,added_at) VALUES (?,?,datetime(\'now\'))')
      .run(cleanEmail, 'one_click_unsubscribe');
    if (verified.leadId) {
      const lead = db.prepare('SELECT email FROM leads WHERE id = ?').get(verified.leadId);
      if (lead && lead.email?.trim().toLowerCase() === cleanEmail) {
        db.prepare("UPDATE leads SET status='disqualified',disqualification_reason='suppressed:one_click_unsubscribe',updated_at=datetime('now') WHERE id=?")
          .run(verified.leadId);
      }
      db.prepare("UPDATE sends SET status='cancelled',sent_at=NULL,error_message='Recipient unsubscribed.' WHERE lead_id=? AND status='scheduled'")
        .run(verified.leadId);
      db.prepare("UPDATE campaign_enrollments SET status='stopped' WHERE lead_id=? AND status='active'")
        .run(verified.leadId);
    }
    if (!existingSuppression) {
      db.prepare("INSERT INTO events (lead_id,send_id,event_type,event_at,meta_json) VALUES (?,?, 'unsubscribed',datetime('now'),?)")
        .run(verified.leadId || null, verified.sendId || null, JSON.stringify({ reason: 'one_click_unsubscribe', source: 'list_unsubscribe' }));
    }
    if (verified.stored) {
      db.prepare('UPDATE unsubscribe_tokens SET used_at = COALESCE(used_at,datetime(\'now\')) WHERE token_hash = ?')
        .run(crypto.createHash('sha256').update(token).digest('hex'));
    }
    return { ok: true, status: existingSuppression ? 'already_unsubscribed' : 'unsubscribed' };
  })();
}

/**
 * Pre-send compliance validation gate.
 * Ensures the email is NOT suppressed, has valid syntax, and passes basic rules.
 */
export function validateSendCompliance(lead, personalization) {
  if (!lead.email) return { ok: false, reason: 'missing_email' };
  if (isSuppressed(lead.email)) return { ok: false, reason: 'email_suppressed' };
  if (!personalization || !personalization.body_text) return { ok: false, reason: 'missing_body' };
  if (!personalization.subject_line) return { ok: false, reason: 'missing_subject' };

  // Check for forbidden deception keywords in subject line
  const deceptivePatterns = [/re:\s*re:/i, /^fwd:/i, /urgent:\s*payment/i, /invoice\s*attached/i];
  for (const pat of deceptivePatterns) {
    if (pat.test(personalization.subject_line)) {
      return { ok: false, reason: 'deceptive_subject_line' };
    }
  }

  return { ok: true };
}

/**
 * List suppression records with pagination.
 */
export function listSuppressed(limit = 100, offset = 0) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM suppression_list').get().count;
  const items = db.prepare('SELECT * FROM suppression_list ORDER BY added_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  return { items, total, limit, offset };
}
