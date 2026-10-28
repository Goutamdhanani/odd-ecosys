// ============================================================
//  ODD-ECOSYS Pipeline — Reply Ingestion, Tracking & AI Sentiment (Phase 8)
//  Inbound reply webhook handler, local Ollama sentiment classifier,
//  auto-suppression on unsubscribe request, tracking pixel & click handler,
//  and nightly analytics rollup engine.
// ============================================================

import http from 'http';
import { getDb } from './database.js';
import { suppressEmail } from './compliance.js';


class ReplyInboxError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ReplyInboxError';
    this.statusCode = statusCode;
  }
}

/**
 * Classify reply sentiment using local Ollama model (with heuristic fallback).
 * Categories:
 *  - 'interested' (positive buying signal / request for call / pricing inquiry)
 *  - 'not_interested' (polite or firm decline)
 *  - 'out_of_office' (automated vacation / OOO reply)
 *  - 'wrong_person' (referral or incorrect contact)
 *  - 'unsubscribe_request' (explicit removal request)
 */
export async function classifyReplySentiment(replyText, leadContext = {}) {
  const cleanText = (replyText || '').trim();
  if (!cleanText) return { sentiment: 'unclassified', confidence: null, source: 'empty', action: 'human_review' };

  // Fast Rule-Based Heuristic Pass (Deterministic & Instant)
  const lower = cleanText.toLowerCase();

  if (
    lower.includes('unsubscribe') ||
    lower.includes('remove me') ||
    lower.includes('stop emailing') ||
    lower.includes('take me off') ||
    lower.includes('delete my data') ||
    lower.includes('do not contact')
  ) {
    return {
      sentiment: 'unsubscribe_request',
      confidence: 0.99,
      source: 'heuristic_rule',
      action: 'auto_suppress',
    };
  }

  if (
    lower.includes('out of the office') ||
    lower.includes('out of office') ||
    lower.includes('auto-reply') ||
    lower.includes('autoreply') ||
    lower.includes('automated response') ||
    lower.includes('returning on') ||
    lower.includes('on leave') ||
    lower.includes('maternity leave') ||
    lower.includes('vacation')
  ) {
    return {
      sentiment: 'out_of_office',
      confidence: 0.95,
      source: 'heuristic_rule',
      action: 'defer_followup',
    };
  }

  if (
    lower.includes('not the right person') ||
    lower.includes('contact instead') ||
    lower.includes('reach out to') ||
    lower.includes('no longer with') ||
    lower.includes('wrong email')
  ) {
    return {
      sentiment: 'wrong_person',
      confidence: 0.9,
      source: 'heuristic_rule',
      action: 'flag_for_reenrichment',
    };
  }

  if (
    lower.includes('not interested') ||
    lower.includes('no thanks') ||
    lower.includes('no thank you') ||
    lower.includes('pass on this') ||
    lower.includes('we are good') ||
    lower.includes('already have')
  ) {
    return {
      sentiment: 'not_interested',
      confidence: 0.92,
      source: 'heuristic_rule',
      action: 'mark_lost',
    };
  }

  if (
    lower.includes('interested') ||
    lower.includes('send more info') ||
    lower.includes('sounds good') ||
    lower.includes('call me') ||
    lower.includes('lets chat') ||
    lower.includes("let's chat") ||
    lower.includes('book a time') ||
    lower.includes('how much') ||
    lower.includes('pricing') ||
    lower.includes('schedule')
  ) {
    return {
      sentiment: 'interested',
      confidence: 0.92,
      source: 'heuristic_rule',
      action: 'mark_replied',
    };
  }

  // This legacy SQLite workflow has no verified Astra tenant and durable
  // reservation context. Never send private reply text to a local or remote
  // model from here; return an explicit abstention for human review.
  return {
    sentiment: 'unclassified',
    confidence: null,
    reason: 'sentiment provider unavailable or returned an invalid response',
    source: 'unavailable',
    action: 'human_review',
  };
}

function normalizeMessageId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^<+|>+$/g, '').toLowerCase();
  return normalized || null;
}

function normalizeMessageIds(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.match(/<[^>]*>|[^\s]+/g) || [] : [];
  return [...new Set(values.map(normalizeMessageId).filter(Boolean))].slice(-50);
}

function normalizeEmailAddress(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

function normalizeRecipientAddresses(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeEmailAddress).filter(Boolean))].slice(0, 20);
}

function parseEventMeta(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function monthNumber(name) {
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const index = names.findIndex(value => value.startsWith(name.toLowerCase().slice(0, 3)));
  return index < 0 ? null : index + 1;
}

/** Parse an explicit future return date near return/back/availability wording. */
export function parseOutOfOfficeReturnDate(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const triggers = /\b(?:return(?:ing)?|back|available)\b/gi;
  const patterns = [
    { regex: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, fields: m => [Number(m[1]), Number(m[2]), Number(m[3])] },
    { regex: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, fields: m => [Number(m[3]), Number(m[1]), Number(m[2])] },
    { regex: /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
      fields: m => [m[3] ? Number(m[3]) : null, monthNumber(m[1]), Number(m[2])] },
    { regex: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:,?\s+(\d{4}))?\b/i,
      fields: m => [m[3] ? Number(m[3]) : null, monthNumber(m[2]), Number(m[1])] },
  ];
  for (const trigger of text.matchAll(triggers)) {
    const remainder = text.slice(trigger.index + trigger[0].length, trigger.index + trigger[0].length + 100);
    let candidate = null;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(remainder);
      if (match && (!candidate || match.index < candidate.index)) candidate = { index: match.index, fields: pattern.fields(match) };
    }
    if (!candidate) continue;
    let [year, month, day] = candidate.fields;
    if (!year) {
      year = today.getUTCFullYear();
      const currentYearDate = validDateParts(year, month, day);
      if (!currentYearDate) continue;
      if (currentYearDate <= today) year++;
    }
    const date = validDateParts(year, month, day);
    if (!date || date <= today) continue;
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  return null;
}

function sentEventsForLead(db, leadId) {
  return db.prepare(`
    SELECT s.id AS send_id, s.campaign_id, s.sent_at, s.mailbox_id, m.email AS mailbox_email, e.meta_json, e.event_at
    FROM sends s
    JOIN events e ON e.send_id = s.id AND e.event_type = 'sent'
    LEFT JOIN mailboxes m ON m.id = s.mailbox_id
    WHERE s.lead_id = ? AND s.sent_at IS NOT NULL
    ORDER BY e.event_at DESC, s.id DESC
    LIMIT 200
  `).all(leadId);
}

function findLeadByReplyAddress(db, email) {
  const matches = db.prepare(`SELECT DISTINCT l.* FROM leads l
    LEFT JOIN lead_emails le ON le.lead_id=l.id
    WHERE LOWER(TRIM(l.email))=? OR LOWER(TRIM(le.email))=?
    ORDER BY l.id LIMIT 2`).all(email, email);
  // A reused alias is ambiguous: leave the reply unlinked rather than risking
  // suppressing or stopping the wrong contact's campaign.
  return matches.length === 1 ? matches[0] : null;
}

function hasExplicitOooSignal(text) {
  const lower = text.toLowerCase();
  return lower.includes('out of the office') || lower.includes('out of office')
    || lower.includes('auto-reply') || lower.includes('autoreply')
    || lower.includes('automated response') || lower.includes('returning on')
    || lower.includes('on leave') || lower.includes('maternity leave') || lower.includes('vacation');
}

function hasExplicitUnsubscribeSignal(text) {
  const lower = text.toLowerCase();
  return lower.includes('unsubscribe') || lower.includes('remove me') || lower.includes('stop emailing')
    || lower.includes('take me off') || lower.includes('delete my data') || lower.includes('do not contact');
}

function applyReplyToActiveSequences(db, leadId, sendId, { outOfOffice, returnDate, sentiment }) {
  if (!leadId) return null;
  const activeSequences = db.prepare(`SELECT e.campaign_id FROM campaign_enrollments e
    WHERE e.lead_id=? AND e.status='active'
      AND EXISTS (SELECT 1 FROM campaign_steps cs WHERE cs.campaign_id=e.campaign_id)
      AND EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id=e.campaign_id AND s.lead_id=e.lead_id
        AND s.campaign_step_id IS NOT NULL AND s.status IN ('scheduled','processing'))`).all(leadId);
  let action = null;
  for (const enrollment of activeSequences) {
    const campaignId = enrollment.campaign_id;
    if (outOfOffice) {
      if (returnDate) {
        const deferUntil = db.prepare("SELECT datetime(?, '+1 day') AS value").get(returnDate).value;
        db.prepare(`UPDATE campaign_enrollments SET defer_until=?,defer_manual_review=0
          WHERE campaign_id=? AND lead_id=? AND status='active'`).run(deferUntil, campaignId, leadId);
        const deferred = db.prepare(`UPDATE sends SET scheduled_at=CASE
            WHEN scheduled_at IS NULL OR julianday(scheduled_at)<julianday(?) THEN ? ELSE scheduled_at END,
          error_message='Deferred after out-of-office reply until the day after the stated return date.'
          WHERE campaign_id=? AND lead_id=? AND campaign_step_id IS NOT NULL AND status='scheduled'`)
          .run(deferUntil, deferUntil, campaignId, leadId).changes;
        db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
          VALUES(?,?, 'campaign_sequence_deferred_ooo',datetime('now'),?)`)
          .run(sendId || null, leadId, JSON.stringify({ campaign_id: campaignId, return_date: returnDate, defer_until: deferUntil, deferred_sends: deferred }));
        action = 'deferred_ooo';
      } else {
        db.prepare(`UPDATE campaign_enrollments SET defer_until=NULL,defer_manual_review=1
          WHERE campaign_id=? AND lead_id=? AND status='active'`).run(campaignId, leadId);
        const held = db.prepare(`UPDATE sends SET scheduled_at=NULL,
          error_message='Held for operator review after an out-of-office reply with no unambiguous return date.'
          WHERE campaign_id=? AND lead_id=? AND campaign_step_id IS NOT NULL AND status='scheduled'`)
          .run(campaignId, leadId).changes;
        db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
          VALUES(?,?, 'campaign_sequence_ooo_review_required',datetime('now'),?)`)
          .run(sendId || null, leadId, JSON.stringify({ campaign_id: campaignId, held_sends: held }));
        action = 'ooo_review';
      }
    } else {
      db.prepare("UPDATE campaign_enrollments SET status='stopped',defer_until=NULL,defer_manual_review=0 WHERE campaign_id=? AND lead_id=? AND status='active'")
        .run(campaignId, leadId);
      const cancelled = db.prepare(`UPDATE sends SET status='cancelled',sent_at=NULL,
        error_message='Campaign sequence stopped after a reply.'
        WHERE campaign_id=? AND lead_id=? AND campaign_step_id IS NOT NULL AND status='scheduled'`)
        .run(campaignId, leadId).changes;
      db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
        VALUES(?,?, 'campaign_sequence_stopped_by_reply',datetime('now'),?)`)
        .run(sendId || null, leadId, JSON.stringify({ campaign_id: campaignId, cancelled_followups: cancelled, sentiment }));
      action = 'stopped_by_reply';
    }
  }
  return action;
}

function attributeReplyToSend(db, leadId, toMailboxEmail, inReplyTo, references) {
  if (!leadId) return { send: null, method: 'unmatched', confidence: null };
  const sent = sentEventsForLead(db, leadId).map(row => ({ ...row, meta: parseEventMeta(row.meta_json) }));
  const mailbox = typeof toMailboxEmail === 'string' ? toMailboxEmail.trim().toLowerCase() : null;
  const reference = normalizeMessageId(inReplyTo);
  if (reference) {
    const exact = sent.filter(row => normalizeMessageId(row.meta.messageId) === reference && (!mailbox || row.mailbox_email?.toLowerCase() === mailbox));
    if (exact.length === 1) return { send: exact[0], method: 'in_reply_to', confidence: 1 };
    if (exact.length > 1) return { send: null, method: 'ambiguous_message_id', confidence: null };
  }

  const referenceIds = normalizeMessageIds(references);
  if (referenceIds.length) {
    // References is ordered from the thread root to its latest ancestor. Prefer
    // the closest prior message that is one of our sent messages. A duplicate
    // Message-ID in local send history remains ambiguous and fails closed.
    for (const referenceId of [...referenceIds].reverse()) {
      const exact = sent.filter(row => normalizeMessageId(row.meta.messageId) === referenceId
        && (!mailbox || row.mailbox_email?.toLowerCase() === mailbox));
      if (exact.length === 1) return { send: exact[0], method: 'references', confidence: 0.9 };
      if (exact.length > 1) return { send: null, method: 'ambiguous_references', confidence: null };
    }
  }

  // Address-only fallback is safe only when the receiving mailbox and a single recent send agree.
  if (!mailbox) return { send: null, method: reference ? 'unmatched_reference' : 'mailbox_required_for_fallback', confidence: null };
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = sent.filter(row => {
    if (row.mailbox_email?.toLowerCase() !== mailbox) return false;
    const timestamp = Date.parse(row.sent_at);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
  if (recent.length === 1) return { send: recent[0], method: 'unique_recent_send', confidence: 0.5 };
  if (recent.length > 1) return { send: null, method: 'ambiguous_recent_sends', confidence: null };
  return { send: null, method: reference ? 'unmatched_reference' : 'no_recent_send', confidence: null };
}

function findDuplicateReply(db, toMailboxEmail, messageId) {
  const id = normalizeMessageId(messageId);
  if (!id) return null;
  const mailbox = typeof toMailboxEmail === 'string' ? toMailboxEmail.trim().toLowerCase() : null;
  const rows = db.prepare("SELECT id, send_id, lead_id, meta_json FROM events WHERE event_type = 'replied' ORDER BY id DESC LIMIT 2000").all();
  for (const row of rows) {
    const meta = parseEventMeta(row.meta_json);
    if (normalizeMessageId(meta.messageId) !== id) continue;
    if (mailbox && meta.to?.toLowerCase() !== mailbox) continue;
    if (!mailbox && meta.to) continue;
    return { ...row, meta };
  }
  return null;
}

/**
 * Process an inbound email reply (webhook from mail server / Warmbly / IMAP).
 */
export async function ingestInboundReply(replyData) {
  const db = getDb();
  const {
    fromEmail,
    toMailboxEmail,
    subject = '',
    body = '',
    messageId = null,
    inReplyTo = null,
    references = null,
    receivedTo = null,
    recipientAddresses = null,
    receivedAt = null,
  } = replyData;

  if (!fromEmail) throw new Error('fromEmail is required');
  const cleanFrom = fromEmail.toLowerCase().trim();
  const cleanMailbox = typeof toMailboxEmail === 'string' ? toMailboxEmail.trim().toLowerCase() : null;
  const cleanReceivedTo = normalizeEmailAddress(receivedTo) || cleanMailbox;
  const cleanRecipientAddresses = normalizeRecipientAddresses(recipientAddresses);
  const safeSubject = typeof subject === 'string' ? subject.slice(0, 998) : '';
  const rawBody = typeof body === 'string' ? body : '';
  const storedBody = rawBody.slice(0, 100_000);
  const classificationBody = rawBody.slice(0, 12_000);
  const parsedReceivedAt = typeof receivedAt === 'string' || receivedAt instanceof Date
    ? Date.parse(receivedAt) : Number.NaN;
  const storedReceivedAt = Number.isFinite(parsedReceivedAt) && parsedReceivedAt <= Date.now() + 24 * 60 * 60 * 1000
    ? new Date(parsedReceivedAt).toISOString() : null;

  const duplicate = findDuplicateReply(db, cleanMailbox, messageId);
  if (duplicate) {
    return {
      ok: true,
      duplicate: true,
      eventId: duplicate.id,
      leadId: duplicate.lead_id,
      sendId: duplicate.send_id,
      fromEmail: cleanFrom,
      sentiment: duplicate.meta.sentiment || 'unclassified',
      classification: {
        sentiment: duplicate.meta.sentiment || 'unclassified',
        confidence: duplicate.meta.confidence ?? null,
        source: duplicate.meta.source || 'recorded_event',
      },
      updatedLeadStatus: duplicate.lead_id ? db.prepare('SELECT status FROM leads WHERE id = ?').get(duplicate.lead_id)?.status || null : null,
      sendAttribution: duplicate.meta.sendAttribution || 'unmatched',
    };
  }

  // Find lead by email
  const lead = findLeadByReplyAddress(db, cleanFrom);
  const leadId = lead ? lead.id : null;

  const cleanReferences = normalizeMessageIds(references);
  const attribution = attributeReplyToSend(db, leadId, cleanMailbox, inReplyTo, cleanReferences);
  const send = attribution.send;

  const replyText = `${safeSubject}\n${classificationBody}`;
  const fastOoo = hasExplicitOooSignal(replyText);
  const fastUnsubscribe = hasExplicitUnsubscribeSignal(replyText);
  const initialMeta = {
    from: fromEmail,
    to: toMailboxEmail,
    receivedTo: cleanReceivedTo,
    recipientAddresses: cleanRecipientAddresses,
    subject: safeSubject,
    bodySnippet: storedBody.slice(0, 300),
    bodyText: storedBody,
    bodyTruncated: rawBody.length > storedBody.length,
    sentiment: fastOoo ? 'out_of_office' : fastUnsubscribe ? 'unsubscribe_request' : 'classification_pending',
    confidence: fastOoo || fastUnsubscribe ? 0.99 : null,
    source: fastOoo || fastUnsubscribe ? 'heuristic_rule' : 'classification_pending',
    messageId,
    inReplyTo,
    references: cleanReferences,
    receivedAt: storedReceivedAt,
    sendAttribution: attribution.method,
    sendAttributionConfidence: attribution.confidence,
    classificationState: 'pending',
  };
  if (fastOoo) initialMeta.returnDate = parseOutOfOfficeReturnDate(replyText);

  // Persist the reply and stop non-OOO sequences before any network classifier call.
  // An Ollama timeout or outage must never leave a follow-up eligible to send.
  const replyEventId = db.transaction(() => {
    const inserted = db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
      VALUES(?,?,'replied',COALESCE(datetime(?),datetime('now')),?)`)
      .run(send?.send_id || null, leadId, storedReceivedAt, JSON.stringify(initialMeta));
    if (leadId && !fastOoo) db.prepare("UPDATE leads SET status='replied',updated_at=datetime('now') WHERE id=?").run(leadId);
    if (fastUnsubscribe) suppressEmail(cleanFrom, 'unsubscribe_request', leadId);
    const sequenceAction = applyReplyToActiveSequences(db, leadId, send?.send_id || null, {
      outOfOffice: fastOoo,
      returnDate: initialMeta.returnDate || null,
      sentiment: fastOoo ? 'out_of_office' : fastUnsubscribe ? 'unsubscribe_request' : 'classification_pending',
    });
    if (sequenceAction) initialMeta.sequenceAction = sequenceAction;
    db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify(initialMeta), Number(inserted.lastInsertRowid));
    return Number(inserted.lastInsertRowid);
  })();

  const classification = await classifyReplySentiment(replyText, {
    business_name: lead?.business_name,
    subject: safeSubject,
  });

  const sentiment = classification.sentiment;
  const eventMeta = {
    ...initialMeta,
    sentiment,
    confidence: classification.confidence,
    source: classification.source,
    classificationState: 'complete',
  };
  if (sentiment === 'out_of_office') eventMeta.returnDate = parseOutOfOfficeReturnDate(replyText);
  else delete eventMeta.returnDate;

  // A reply proves engagement, not a booked meeting or closed sale.
  let updatedStatus = 'replied';

  if (sentiment === 'unsubscribe_request') {
    updatedStatus = 'disqualified';
  } else if (sentiment === 'not_interested') {
    updatedStatus = 'lost';
  } else if (sentiment === 'wrong_person') {
    updatedStatus = 'enriching';
  } else if (sentiment === 'out_of_office') {
    updatedStatus = 'sent';
  }

  const persistReply = db.transaction(() => {
    db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify(eventMeta), replyEventId);
    if (sentiment === 'unsubscribe_request' && !fastUnsubscribe) suppressEmail(cleanFrom, 'unsubscribe_request', leadId);
    if (leadId) db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(updatedStatus, leadId);
  });
  persistReply();

  return {
    ok: true,
    eventId: replyEventId,
    duplicate: false,
    leadId,
    sendId: send?.send_id || null,
    fromEmail,
    sentiment,
    classification,
    updatedLeadStatus: updatedStatus,
    sendAttribution: attribution.method,
    sendAttributionConfidence: attribution.confidence,
  };
}

function inboxLimit(value, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new ReplyInboxError(`Inbox pagination value must be from 0 to ${maximum}.`);
  return parsed;
}

function inboxReplySummary(row) {
  const meta = parseEventMeta(row.meta_json);
  return {
    id: row.id,
    leadId: row.lead_id,
    sendId: row.send_id,
    eventAt: row.event_at,
    businessName: row.business_name || 'Unknown contact',
    contactEmail: row.contact_email || meta.from || null,
    fromEmail: meta.from || null,
    toMailboxEmail: meta.to || row.mailbox_email || null,
    receivedTo: meta.receivedTo || meta.to || row.mailbox_email || null,
    recipientAddresses: normalizeRecipientAddresses(meta.recipientAddresses),
    subject: meta.subject || '(no subject)',
    snippet: meta.bodySnippet || '',
    sentiment: meta.sentiment || 'unclassified',
    classificationState: meta.classificationState || 'legacy',
    sendAttribution: meta.sendAttribution || 'unmatched',
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
    readAt: row.read_at || null,
  };
}

/** List only replies actually ingested into the local event ledger. */
export function listInboxReplies({ search = '', unreadOnly = false, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const safeLimit = inboxLimit(limit, 50, 100);
  if (safeLimit < 1) throw new ReplyInboxError('Inbox limit must be from 1 to 100.');
  const safeOffset = inboxLimit(offset, 0, 1_000_000);
  const term = typeof search === 'string' ? search.trim().slice(0, 120) : '';
  const predicates = ["e.event_type='replied'"];
  const values = [];
  if (unreadOnly) predicates.push("COALESCE(ris.read_at,'')=''");
  if (term) {
    const escaped = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    predicates.push(`(COALESCE(l.business_name,'') LIKE ? ESCAPE '\\'
      OR COALESCE(l.email,'') LIKE ? ESCAPE '\\' OR e.meta_json LIKE ? ESCAPE '\\')`);
    values.push(escaped, escaped, escaped);
  }
  const where = predicates.join(' AND ');
  const from = `FROM events e
    LEFT JOIN leads l ON l.id=e.lead_id
    LEFT JOIN reply_inbox_state ris ON ris.event_id=e.id
    LEFT JOIN sends s ON s.id=e.send_id
    LEFT JOIN campaigns c ON c.id=s.campaign_id
    LEFT JOIN mailboxes m ON m.id=s.mailbox_id`;
  const total = db.prepare(`SELECT COUNT(*) AS count ${from} WHERE ${where}`).get(...values).count;
  const unreadCount = db.prepare("SELECT COUNT(*) AS count FROM events e LEFT JOIN reply_inbox_state ris ON ris.event_id=e.id WHERE e.event_type='replied' AND COALESCE(ris.read_at,'')=''").get().count;
  const rows = db.prepare(`SELECT e.id,e.lead_id,e.send_id,e.event_at,e.meta_json,
      l.business_name,l.email AS contact_email,c.id AS campaign_id,c.name AS campaign_name,
      m.email AS mailbox_email,ris.read_at
    ${from} WHERE ${where} ORDER BY e.event_at DESC,e.id DESC LIMIT ? OFFSET ?`)
    .all(...values, safeLimit, safeOffset);
  return { items: rows.map(inboxReplySummary), pagination: { total, limit: safeLimit, offset: safeOffset, hasMore: safeOffset + rows.length < total }, unreadCount };
}

/** Load a contact/mailbox-scoped thread from persisted accepted-send and reply events. */
export function getInboxReplyThread(eventValue) {
  const eventId = Number(eventValue);
  if (!Number.isSafeInteger(eventId) || eventId < 1) throw new ReplyInboxError('Reply id must be a positive integer.');
  const db = getDb();
  const row = db.prepare(`SELECT e.id,e.lead_id,e.send_id,e.event_at,e.meta_json,
      l.business_name,l.email AS contact_email,c.id AS campaign_id,c.name AS campaign_name,
      m.email AS mailbox_email,ris.read_at
    FROM events e LEFT JOIN leads l ON l.id=e.lead_id
    LEFT JOIN reply_inbox_state ris ON ris.event_id=e.id
    LEFT JOIN sends s ON s.id=e.send_id LEFT JOIN campaigns c ON c.id=s.campaign_id
    LEFT JOIN mailboxes m ON m.id=s.mailbox_id
    WHERE e.id=? AND e.event_type='replied'`).get(eventId);
  if (!row) return null;
  const replyMeta = parseEventMeta(row.meta_json);
  const mailbox = (replyMeta.to || '').trim().toLowerCase();
  const threadRows = row.lead_id ? db.prepare(`SELECT e.id,e.send_id,e.event_type,e.event_at,e.meta_json,
      s.subject_snapshot,s.body_snapshot,s.mailbox_id,p.subject_line,p.body_text,m.email AS sender_email
    FROM events e LEFT JOIN sends s ON s.id=e.send_id
    LEFT JOIN personalizations p ON p.id=s.personalization_id
    LEFT JOIN mailboxes m ON m.id=s.mailbox_id
    WHERE e.lead_id=? AND e.event_type IN ('sent','replied')
    ORDER BY e.event_at,e.id LIMIT 200`).all(row.lead_id) : [];
  const messages = threadRows.flatMap(item => {
    const meta = parseEventMeta(item.meta_json);
    const from = item.event_type === 'sent' ? (meta.from || item.sender_email || '') : (meta.from || '');
    const to = item.event_type === 'sent' ? (meta.to || row.contact_email || '') : (meta.receivedTo || meta.to || '');
    const canonicalMailbox = item.event_type === 'sent' ? from : (meta.to || '');
    const sameMailbox = !mailbox || canonicalMailbox.trim().toLowerCase() === mailbox;
    if (!sameMailbox && item.id !== row.id && item.send_id !== row.send_id) return [];
    return [{
      id: item.id,
      type: item.event_type,
      eventAt: item.event_at,
      from,
      to,
      recipientAddresses: item.event_type === 'replied' ? normalizeRecipientAddresses(meta.recipientAddresses) : [],
      subject: meta.subject || item.subject_snapshot || item.subject_line || '(no subject)',
      body: item.event_type === 'replied' ? (meta.bodyText || meta.bodySnippet || '') : (item.body_snapshot || item.body_text || ''),
      messageId: meta.messageId || null,
      sentiment: meta.sentiment || null,
    }];
  });
  if (!messages.some(message => message.id === row.id)) {
    messages.push({
      id: row.id, type: 'replied', eventAt: row.event_at,
      from: replyMeta.from || '', to: replyMeta.receivedTo || replyMeta.to || '',
      recipientAddresses: normalizeRecipientAddresses(replyMeta.recipientAddresses),
      subject: replyMeta.subject || '(no subject)',
      body: replyMeta.bodyText || replyMeta.bodySnippet || '',
      messageId: replyMeta.messageId || null,
      sentiment: replyMeta.sentiment || 'unclassified',
    });
    messages.sort((a, b) => String(a.eventAt).localeCompare(String(b.eventAt)) || a.id - b.id);
  }
  return { reply: inboxReplySummary(row), messages };
}

export function setInboxReplyReadState(eventValue, read) {
  const eventId = Number(eventValue);
  if (!Number.isSafeInteger(eventId) || eventId < 1) throw new ReplyInboxError('Reply id must be a positive integer.');
  const db = getDb();
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM events WHERE id=? AND event_type='replied'").get(eventId)) return null;
    db.prepare(`INSERT INTO reply_inbox_state(event_id,read_at,updated_at) VALUES(?,${read ? "datetime('now')" : 'NULL'},datetime('now'))
      ON CONFLICT(event_id) DO UPDATE SET read_at=${read ? "datetime('now')" : 'NULL'},updated_at=datetime('now')`).run(eventId);
    return db.prepare('SELECT event_id,read_at,updated_at FROM reply_inbox_state WHERE event_id=?').get(eventId);
  })();
}

/**
 * Get reply analytics & sentiment breakdown for reporting.
 */
export function getReplySentimentAnalytics() {
  const db = getDb();
  const events = db.prepare(`
    SELECT meta_json FROM events WHERE event_type = 'replied' ORDER BY event_at DESC LIMIT 500
  `).all();

  const breakdown = {
    interested: 0,
    not_interested: 0,
    out_of_office: 0,
    wrong_person: 0,
    unsubscribe_request: 0,
    total: events.length,
  };

  for (const e of events) {
    try {
      const meta = JSON.parse(e.meta_json);
      if (meta.sentiment && breakdown[meta.sentiment] !== undefined) {
        breakdown[meta.sentiment]++;
      }
    } catch {}
  }

  return breakdown;
}

/**
 * Nightly analytics rollup materializer.
 */
export function materializeDailyRollup() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN event_type = 'sent' THEN 1 END) as sent,
      COUNT(CASE WHEN event_type = 'delivered' THEN 1 END) as delivered,
      COUNT(CASE WHEN event_type = 'tracked_link_requested' THEN 1 END) as tracked_link_requests,
      COUNT(CASE WHEN event_type = 'replied' THEN 1 END) as replied,
      COUNT(CASE WHEN event_type IN ('hard_bounce','soft_bounce') THEN 1 END) as bounced,
      COUNT(CASE WHEN event_type = 'unsubscribed' THEN 1 END) as unsubscribed
    FROM events
    WHERE date(event_at) = date('now')
  `).get();

  return { date: today, ...stats };
}
