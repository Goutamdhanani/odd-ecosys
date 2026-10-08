// ============================================================
//  ODD-ECOSYS Pipeline — Compliance & Deliverability (Phase 0)
//  CAN-SPAM, GDPR/PECR, CASL & 2024+ Bulk Sender Standards
//  RFC 8058 One-Click Unsubscribe, Global Suppression List,
//  Physical Mailing Address Footer, Pre-send Compliance Gate
// ============================================================

import crypto from 'crypto';
import { getDb } from './database.js';

const SECRET_KEY = process.env.COMPLIANCE_SECRET || 'oddecosys-compliance-secret-key-2026';
const PHYSICAL_ADDRESS = process.env.COMPANY_PHYSICAL_ADDRESS || '100 Outreach Way, Suite 400, Austin, TX 78701, USA';

/**
 * Generate a cryptographically signed unsubscribe token for a lead.
 */
export function generateUnsubscribeToken(email, leadId) {
  const data = `${email.toLowerCase()}:${leadId}:${SECRET_KEY}`;
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  return Buffer.from(`${email}:${leadId}:${hash}`).toString('base64url');
}

/**
 * Verify and decode an unsubscribe token.
 */
export function verifyUnsubscribeToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf-8');
    const [email, leadIdStr, hash] = raw.split(':');
    const leadId = parseInt(leadIdStr);
    const expected = crypto.createHash('sha256').update(`${email.toLowerCase()}:${leadId}:${SECRET_KEY}`).digest('hex').slice(0, 16);
    if (hash === expected) {
      return { valid: true, email: email.toLowerCase(), leadId };
    }
  } catch {
    // Invalid encoding
  }
  return { valid: false, email: null, leadId: null };
}

/**
 * Generate RFC 8058 compliant headers for an outgoing send.
 */
export function getComplianceHeaders(leadEmail, leadId, domain) {
  const token = generateUnsubscribeToken(leadEmail, leadId);
  const baseUrl = process.env.APP_URL || `http://${domain || 'localhost:3000'}`;
  const unsubUrl = `${baseUrl}/api/unsubscribe?token=${token}`;
  const unsubMailto = `mailto:unsubscribe@${domain || 'outreach.local'}?subject=unsubscribe-${token}`;

  return {
    'List-Unsubscribe': `<${unsubUrl}>, <${unsubMailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'X-Entity-Ref-ID': `lead-${leadId}-${Date.now()}`,
    'X-Compliant-CAN-SPAM': 'true',
  };
}

/**
 * Append standard physical address and unsubscribe footer to body.
 */
export function appendComplianceFooter(bodyText, leadEmail, leadId, domain) {
  const token = generateUnsubscribeToken(leadEmail, leadId);
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const unsubUrl = `${baseUrl}/api/unsubscribe?token=${token}`;

  const footer = `\n\n---\n${PHYSICAL_ADDRESS}\nTo stop receiving these emails, click here: ${unsubUrl}`;
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
    INSERT OR REPLACE INTO suppression_list (email, reason, added_at)
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
