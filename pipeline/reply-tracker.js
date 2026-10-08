// ============================================================
//  ODD-ECOSYS Pipeline — Reply Ingestion, Tracking & AI Sentiment (Phase 8)
//  Inbound reply webhook handler, local Ollama sentiment classifier,
//  auto-suppression on unsubscribe request, tracking pixel & click handler,
//  and nightly analytics rollup engine.
// ============================================================

import http from 'http';
import { getDb } from './database.js';
import { suppressEmail } from './compliance.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';

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

  // Escalation to Local Ollama AI for Nuanced Replies
  try {
    const prompt = `You are an AI sales assistant classifying an inbound email reply to a cold outreach message.
Reply Content: "${cleanText}"

Classify the reply into strictly ONE of these categories:
1. interested (asking for call, pricing, information, meeting, portfolio)
2. not_interested (declining, no need)
3. out_of_office (automated out of office message)
4. wrong_person (referring to someone else or wrong email)
5. unsubscribe_request (asking to be removed or stop contacting)

Respond in JSON format only:
{"sentiment": "interested|not_interested|out_of_office|wrong_person|unsubscribe_request", "confidence": 0.95, "reason": "brief reason"}`;

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json',
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data = await res.json();
      const parsed = JSON.parse(data.response);
      const allowedSentiments = new Set(['interested', 'not_interested', 'out_of_office', 'wrong_person', 'unsubscribe_request']);
      if (allowedSentiments.has(parsed.sentiment)) {
        const confidence = Number(parsed.confidence);
        return {
          sentiment: parsed.sentiment,
          confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
          reason: parsed.reason || 'classified by ollama',
          source: 'ollama_ai',
        };
      }
    }
  } catch {
    // Ollama offline or timed out
  }

  // A provider failure is unknown. It must never manufacture positive interest.
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

function parseEventMeta(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function sentEventsForLead(db, leadId) {
  return db.prepare(`
    SELECT s.id AS send_id, s.sent_at, s.mailbox_id, m.email AS mailbox_email, e.meta_json, e.event_at
    FROM sends s
    JOIN events e ON e.send_id = s.id AND e.event_type = 'sent'
    LEFT JOIN mailboxes m ON m.id = s.mailbox_id
    WHERE s.lead_id = ? AND s.sent_at IS NOT NULL
    ORDER BY e.event_at DESC, s.id DESC
    LIMIT 200
  `).all(leadId);
}

function attributeReplyToSend(db, leadId, toMailboxEmail, inReplyTo) {
  if (!leadId) return { send: null, method: 'unmatched', confidence: null };
  const sent = sentEventsForLead(db, leadId).map(row => ({ ...row, meta: parseEventMeta(row.meta_json) }));
  const mailbox = typeof toMailboxEmail === 'string' ? toMailboxEmail.trim().toLowerCase() : null;
  const reference = normalizeMessageId(inReplyTo);
  if (reference) {
    const exact = sent.filter(row => normalizeMessageId(row.meta.messageId) === reference && (!mailbox || row.mailbox_email?.toLowerCase() === mailbox));
    if (exact.length === 1) return { send: exact[0], method: 'in_reply_to', confidence: 1 };
    if (exact.length > 1) return { send: null, method: 'ambiguous_message_id', confidence: null };
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
  } = replyData;

  if (!fromEmail) throw new Error('fromEmail is required');
  const cleanFrom = fromEmail.toLowerCase().trim();
  const cleanMailbox = typeof toMailboxEmail === 'string' ? toMailboxEmail.trim().toLowerCase() : null;

  const duplicate = findDuplicateReply(db, cleanMailbox, messageId);
  if (duplicate) {
    return {
      ok: true,
      duplicate: true,
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
  const lead = db.prepare('SELECT * FROM leads WHERE lower(email) = ?').get(cleanFrom);
  const leadId = lead ? lead.id : null;

  const attribution = attributeReplyToSend(db, leadId, cleanMailbox, inReplyTo);
  const send = attribution.send;

  // Run AI Sentiment Classification
  const classification = await classifyReplySentiment(body, {
    business_name: lead?.business_name,
    subject,
  });

  const sentiment = classification.sentiment;

  // Record Event in Events Table
  const eventMeta = {
    from: fromEmail,
    to: toMailboxEmail,
    subject,
    bodySnippet: body.slice(0, 300),
    sentiment,
    confidence: classification.confidence,
    source: classification.source,
    messageId,
    inReplyTo,
    sendAttribution: attribution.method,
    sendAttributionConfidence: attribution.confidence,
  };

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
    db.prepare(`
      INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json)
      VALUES (?, ?, 'replied', datetime('now'), ?)
    `).run(send?.send_id || null, leadId, JSON.stringify(eventMeta));
    if (sentiment === 'unsubscribe_request') suppressEmail(cleanFrom, 'unsubscribe_request', leadId);
    if (leadId) db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(updatedStatus, leadId);
  });
  persistReply();

  return {
    ok: true,
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

/**
 * Record open pixel event.
 */
export function recordOpenEvent(sendId) {
  const db = getDb();
  const send = db.prepare('SELECT * FROM sends WHERE id = ?').get(sendId);
  if (!send) return false;

  db.prepare(`
    INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json)
    VALUES (?, ?, 'opened', datetime('now'), ?)
  `).run(send.id, send.lead_id, JSON.stringify({ type: 'pixel_open', timestamp: new Date().toISOString() }));

  return true;
}

/**
 * Record link click event.
 */
export function recordClickEvent(sendId, targetUrl) {
  const db = getDb();
  const send = db.prepare('SELECT * FROM sends WHERE id = ?').get(sendId);
  if (!send) return false;

  db.prepare(`
    INSERT INTO events (send_id, lead_id, event_type, event_at, meta_json)
    VALUES (?, ?, 'clicked', datetime('now'), ?)
  `).run(send.id, send.lead_id, JSON.stringify({ targetUrl, timestamp: new Date().toISOString() }));

  return true;
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
      COUNT(CASE WHEN event_type = 'opened' THEN 1 END) as opened,
      COUNT(CASE WHEN event_type = 'clicked' THEN 1 END) as clicked,
      COUNT(CASE WHEN event_type = 'replied' THEN 1 END) as replied,
      COUNT(CASE WHEN event_type IN ('hard_bounce','soft_bounce') THEN 1 END) as bounced,
      COUNT(CASE WHEN event_type = 'unsubscribed' THEN 1 END) as unsubscribed
    FROM events
    WHERE date(event_at) = date('now')
  `).get();

  return { date: today, ...stats };
}
