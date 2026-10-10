import { getDb } from './database.js';

const MAX_MEMBERS_PER_LIST = 10000;
const MAX_SELECTED_CONTACTS = 500;
const MAX_PAGE_SIZE = 200;

export class CampaignAudienceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CampaignAudienceError';
    this.statusCode = statusCode;
  }
}

function normalizeId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new CampaignAudienceError(`${label} must be a positive integer.`);
  return id;
}

const AUDIENCE_ROWS = `
  SELECT e.id AS enrollment_id, e.campaign_id, e.lead_id, e.source_list_id,
    e.status AS enrollment_status, e.enrolled_at, e.defer_until, e.defer_manual_review,
    l.business_name, l.email, l.city, l.country, l.status AS contact_status,
    COALESCE(cl.name, 'Legacy enrollment') AS source_list_name,
    p.id AS personalization_id, p.subject_line, p.body_text, p.approved, p.guardrail_passed,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM sends s WHERE s.campaign_id = e.campaign_id
          AND s.lead_id = e.lead_id AND s.status = 'uncertain'
      ) THEN 'submission_uncertain'
      WHEN EXISTS (
        SELECT 1 FROM sends s JOIN campaign_steps cs ON cs.id=s.campaign_step_id
        WHERE s.campaign_id=e.campaign_id AND s.lead_id=e.lead_id AND s.status='failed'
      ) THEN 'sequence_failed'
      WHEN e.status = 'stopped' THEN 'stopped'
      WHEN e.status = 'completed' THEN 'completed'
      WHEN NULLIF(TRIM(l.email), '') IS NULL THEN 'missing_email'
      WHEN EXISTS (
        SELECT 1 FROM suppression_list sl
        WHERE LOWER(TRIM(sl.email)) = LOWER(TRIM(l.email))
      ) THEN 'suppressed'
      WHEN e.defer_manual_review = 1 THEN 'out_of_office_review'
      WHEN e.defer_until IS NOT NULL AND julianday(e.defer_until) > julianday('now') THEN 'out_of_office_deferred'
      WHEN e.status = 'active'
        AND EXISTS (SELECT 1 FROM campaign_steps cs WHERE cs.campaign_id=e.campaign_id)
        AND EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id=e.campaign_id
          AND s.lead_id=e.lead_id AND s.campaign_step_id IS NOT NULL AND s.status='sent')
        AND EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id=e.campaign_id
          AND s.lead_id=e.lead_id AND s.campaign_step_id IS NOT NULL AND s.status IN ('scheduled','processing','uncertain'))
        THEN 'sequence_running'
      WHEN EXISTS (
        SELECT 1 FROM sends s WHERE s.campaign_id = e.campaign_id
          AND s.lead_id = e.lead_id AND s.status = 'sent'
      ) THEN 'already_sent'
      WHEN EXISTS (
        SELECT 1 FROM sends s WHERE s.campaign_id = e.campaign_id
          AND s.lead_id = e.lead_id AND s.status IN ('scheduled', 'sending', 'processing')
      ) THEN 'already_queued'
      WHEN NOT EXISTS (
        SELECT 1 FROM lead_emails le
        WHERE le.lead_id = l.id
          AND LOWER(TRIM(le.email)) = LOWER(TRIM(l.email))
          AND le.verification_status = 'deliverable'
      ) THEN 'verification_required'
      WHEN l.status NOT IN ('queued', 'awaiting_approval') THEN 'contact_not_ready'
      WHEN p.id IS NULL THEN 'personalization_required'
      WHEN COALESCE(p.guardrail_passed, 0) != 1 THEN 'copy_review_required'
      WHEN COALESCE(p.approved, 0) != 1 THEN 'approval_required'
      WHEN NULLIF(TRIM(p.subject_line), '') IS NULL OR NULLIF(TRIM(p.body_text), '') IS NULL THEN 'copy_incomplete'
      ELSE 'eligible'
    END AS eligibility
    ,(SELECT u.id FROM sends u WHERE u.campaign_id = e.campaign_id
      AND u.lead_id = e.lead_id AND u.status = 'uncertain' ORDER BY u.id DESC LIMIT 1) AS uncertain_send_id
    ,(SELECT u.error_message FROM sends u WHERE u.campaign_id = e.campaign_id
      AND u.lead_id = e.lead_id AND u.status = 'uncertain' ORDER BY u.id DESC LIMIT 1) AS uncertainty_error
    ,(SELECT ev.event_at FROM events ev WHERE ev.send_id = (
      SELECT u.id FROM sends u WHERE u.campaign_id = e.campaign_id
        AND u.lead_id = e.lead_id AND u.status = 'uncertain' ORDER BY u.id DESC LIMIT 1
    ) AND ev.event_type = 'send_submission_uncertain' ORDER BY ev.id DESC LIMIT 1) AS uncertainty_event_at
    ,(SELECT ev.meta_json FROM events ev WHERE ev.send_id = (
      SELECT u.id FROM sends u WHERE u.campaign_id = e.campaign_id
        AND u.lead_id = e.lead_id AND u.status = 'uncertain' ORDER BY u.id DESC LIMIT 1
    ) AND ev.event_type = 'send_submission_uncertain' ORDER BY ev.id DESC LIMIT 1) AS uncertainty_meta_json
    ,(SELECT cs.position FROM sends s JOIN campaign_steps cs ON cs.id=s.campaign_step_id
      WHERE s.campaign_id=e.campaign_id AND s.lead_id=e.lead_id AND s.status='scheduled'
      ORDER BY cs.position,s.id LIMIT 1) AS next_sequence_position
    ,(SELECT s.scheduled_at FROM sends s JOIN campaign_steps cs ON cs.id=s.campaign_step_id
      WHERE s.campaign_id=e.campaign_id AND s.lead_id=e.lead_id AND s.status='scheduled'
      ORDER BY cs.position,s.id LIMIT 1) AS next_sequence_at
  FROM campaign_enrollments e
  JOIN leads l ON l.id = e.lead_id
  LEFT JOIN contact_lists cl ON cl.id = e.source_list_id
  LEFT JOIN personalizations p ON p.id = (
    SELECT p2.id FROM personalizations p2
    WHERE p2.lead_id = e.lead_id
    ORDER BY p2.generated_at DESC, p2.id DESC
    LIMIT 1
  )
  WHERE e.campaign_id = ?
`;

function safeDiagnostic(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/[\r\n\t\0-\x1f\x7f]+/g, ' ')
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .trim()
    .slice(0, 240);
}

function publicAudienceItem(row) {
  const {
    uncertainty_error: rawError,
    uncertainty_meta_json: rawMeta,
    uncertain_send_id: sendId,
    uncertainty_event_at: recordedAt,
    ...item
  } = row;
  if (item.eligibility !== 'submission_uncertain') return item;

  let meta = {};
  try { meta = rawMeta ? JSON.parse(rawMeta) : {}; } catch { /* retain the stored send diagnostic fallback */ }
  const reason = safeDiagnostic(meta.reason || meta.error || rawError);
  return {
    ...item,
    uncertainty: {
      sendId: Number.isSafeInteger(Number(sendId)) ? Number(sendId) : null,
      recordedAt: recordedAt || null,
      code: safeDiagnostic(meta.code) || 'SMTP_OUTCOME_UNKNOWN',
      stage: safeDiagnostic(meta.stage),
      reason: reason || 'The worker could not record a definitive SMTP outcome.',
      evidenceSource: 'local_smtp_worker',
      providerEvidence: 'unavailable',
      blockedReason: 'No provider message-trace adapter is configured, so SMTP acceptance cannot be confirmed. This recipient remains quarantined and must not be resent.',
    },
  };
}

function getCampaign(db, campaignId) {
  return db.prepare('SELECT id, name, status, sequence_step FROM campaigns WHERE id = ?').get(campaignId) || null;
}

export function enrollListInCampaign(campaignValue, listValue) {
  const db = getDb();
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  const listId = normalizeId(listValue, 'List id');
  return db.transaction(() => {
    const campaign = getCampaign(db, campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    if (campaign.status !== 'draft') throw new CampaignAudienceError('Only draft campaigns can change their audience.', 409);
    if (db.prepare('SELECT 1 FROM sends WHERE campaign_id = ? LIMIT 1').get(campaignId)) {
      throw new CampaignAudienceError('A campaign with send history has a locked audience.', 409);
    }
    const list = db.prepare('SELECT id, name, status FROM contact_lists WHERE id = ?').get(listId);
    if (!list) throw new CampaignAudienceError('Contact list not found.', 404);
    if (list.status !== 'active') throw new CampaignAudienceError('Restore this contact list before adding it to a campaign.', 409);

    const members = db.prepare('SELECT lead_id FROM contact_list_members WHERE list_id = ? ORDER BY added_at, lead_id LIMIT ?')
      .all(listId, MAX_MEMBERS_PER_LIST);
    if (members.length === MAX_MEMBERS_PER_LIST) {
      const additional = db.prepare('SELECT 1 FROM contact_list_members WHERE list_id = ? ORDER BY added_at, lead_id LIMIT 1 OFFSET ?').get(listId, MAX_MEMBERS_PER_LIST);
      if (additional) throw new CampaignAudienceError(`A list can enroll at most ${MAX_MEMBERS_PER_LIST} contacts at a time.`);
    }
    const insert = db.prepare('INSERT OR IGNORE INTO campaign_enrollments (campaign_id, lead_id, source_list_id) VALUES (?, ?, ?)');
    let added = 0;
    for (const member of members) added += insert.run(campaignId, member.lead_id, listId).changes;
    return { campaignId, listId, listName: list.name, added, alreadyEnrolled: members.length - added, totalListMembers: members.length };
  })();
}

export function enrollContactsInCampaign(campaignValue, leadValues) {
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  if (!Array.isArray(leadValues) || leadValues.length < 1 || leadValues.length > MAX_SELECTED_CONTACTS) {
    throw new CampaignAudienceError(`Select between 1 and ${MAX_SELECTED_CONTACTS} contacts.`);
  }
  const leadIds = [...new Set(leadValues.map(value => normalizeId(value, 'Contact id')))];
  const db = getDb();
  return db.transaction(() => {
    const campaign = getCampaign(db, campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    if (campaign.status !== 'draft') throw new CampaignAudienceError('Only draft campaigns can change their audience.', 409);
    if (db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId)) {
      throw new CampaignAudienceError('A campaign with send history has a locked audience.', 409);
    }
    const placeholders = leadIds.map(() => '?').join(',');
    const found = db.prepare(`SELECT id FROM leads WHERE id IN (${placeholders})`).all(...leadIds).map(row => row.id);
    if (found.length !== leadIds.length) throw new CampaignAudienceError('One or more contacts were not found; no contacts were enrolled.', 404);
    const insert = db.prepare('INSERT OR IGNORE INTO campaign_enrollments(campaign_id,lead_id,source_list_id) VALUES (?, ?, NULL)');
    let added = 0;
    for (const leadId of leadIds) added += insert.run(campaignId, leadId).changes;
    return { campaignId, added, alreadyEnrolled: leadIds.length - added, selected: leadIds.length };
  })();
}

export function removeCampaignRecipient(campaignValue, leadValue) {
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  const leadId = normalizeId(leadValue, 'Contact id');
  const db = getDb();
  return db.transaction(() => {
    const campaign = getCampaign(db, campaignId);
    if (!campaign) throw new CampaignAudienceError('Campaign not found.', 404);
    if (campaign.status !== 'draft') throw new CampaignAudienceError('Only draft campaigns can change their audience.', 409);
    if (db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId)) {
      throw new CampaignAudienceError('A campaign with send history has a locked audience.', 409);
    }
    const enrollment = db.prepare('SELECT source_list_id FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?')
      .get(campaignId, leadId);
    if (!enrollment) throw new CampaignAudienceError('Contact is not enrolled in this campaign.', 404);
    db.prepare('DELETE FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').run(campaignId, leadId);
    db.prepare('INSERT INTO events(lead_id,event_type,event_at,meta_json) VALUES (?,\'campaign_recipient_removed\',datetime(\'now\'),?)')
      .run(leadId, JSON.stringify({ campaign_id: campaignId, source_list_id: enrollment.source_list_id }));
    return { campaignId, leadId, removed: true };
  })();
}

export function getCampaignAudience(campaignValue, { search = '', limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  const campaign = getCampaign(db, campaignId);
  if (!campaign) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new CampaignAudienceError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CampaignAudienceError('offset must be a non-negative integer.');

  const counts = Object.fromEntries(db.prepare(`
    SELECT eligibility, COUNT(*) AS count
    FROM (${AUDIENCE_ROWS})
    GROUP BY eligibility
  `).all(campaignId).map(row => [row.eligibility, row.count]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  let query = `SELECT * FROM (${AUDIENCE_ROWS})`;
  const values = [campaignId];
  if (search) {
    query += ' WHERE (business_name LIKE ? OR email LIKE ? OR city LIKE ? OR source_list_name LIKE ?)';
    const term = `%${search}%`;
    values.push(term, term, term, term);
  }
  const filteredTotal = db.prepare(`SELECT COUNT(*) AS count FROM (${query})`).get(...values).count;
  const items = db.prepare(`${query} ORDER BY enrolled_at DESC, enrollment_id DESC LIMIT ? OFFSET ?`)
    .all(...values, limit, offset).map(publicAudienceItem);
  const sendLifecycle = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status IN ('scheduled', 'sending', 'processing') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS accepted
    FROM sends WHERE campaign_id = ?
  `).get(campaignId);
  const effectiveStatus = campaign.status === 'draft' && sendLifecycle.pending > 0 ? 'active'
    : campaign.status === 'draft' && sendLifecycle.accepted > 0 ? 'completed'
    : campaign.status;
  return {
    campaign: { ...campaign, status: effectiveStatus },
    counts: {
      total,
      eligible: counts.eligible || 0,
      alreadyQueued: counts.already_queued || 0,
      alreadySent: counts.already_sent || 0,
      sequenceRunning: counts.sequence_running || 0,
      acceptedSends: sendLifecycle.accepted || 0,
      deferred: counts.out_of_office_deferred || 0,
      blocked: total - (counts.eligible || 0) - (counts.already_queued || 0) - (counts.already_sent || 0) - (counts.sequence_running || 0) - (counts.out_of_office_deferred || 0),
      byReason: counts,
    },
    items,
    pagination: { total: filteredTotal, limit, offset, hasMore: offset + items.length < filteredTotal },
  };
}

/** Return every enrolled recipient's current policy reason for a server-side launch review. */
export function getAllCampaignAudienceRecipients(campaignValue) {
  const db = getDb();
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  if (!getCampaign(db, campaignId)) return null;
  return db.prepare(`SELECT lead_id,business_name,email,eligibility FROM (${AUDIENCE_ROWS})
    ORDER BY enrolled_at DESC,enrollment_id DESC`).all(campaignId);
}

export function getQueueEligibleCampaignRecipients(campaignValue, limit = 100) {
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new CampaignAudienceError('limit must be an integer from 1 to 500.');
  const db = getDb();
  return db.prepare(`
    SELECT l.*, p.id AS personalization_id, p.subject_line, p.body_text, p.subject_variant, p.body_variant
    FROM (${AUDIENCE_ROWS}) eligible
    JOIN leads l ON l.id = eligible.lead_id
    JOIN personalizations p ON p.id = eligible.personalization_id
    WHERE eligible.eligibility = 'eligible'
    ORDER BY eligible.enrolled_at, eligible.enrollment_id
    LIMIT ?
  `).all(campaignId, limit);
}

export function getCampaignRecipientPolicy(campaignValue, leadValue, { allowSent = false, ignoreOutOfOffice = false } = {}) {
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  const leadId = normalizeId(leadValue, 'Contact id');
  const db = getDb();
  const row = db.prepare(`
    SELECT e.status AS enrollment_status, e.defer_until, e.defer_manual_review, l.email, l.status AS contact_status,
      p.id AS personalization_id, p.subject_line, p.body_text, p.approved, p.guardrail_passed,
      EXISTS (SELECT 1 FROM suppression_list sl WHERE LOWER(TRIM(sl.email)) = LOWER(TRIM(l.email))) AS suppressed,
      EXISTS (SELECT 1 FROM sends s WHERE s.campaign_id = e.campaign_id
        AND s.lead_id = e.lead_id AND s.status = 'uncertain') AS submission_uncertain,
      EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = l.id
        AND LOWER(TRIM(le.email)) = LOWER(TRIM(l.email))
        AND le.verification_status = 'deliverable') AS email_verified
    FROM campaign_enrollments e
    JOIN leads l ON l.id = e.lead_id
    LEFT JOIN personalizations p ON p.id = (
      SELECT p2.id FROM personalizations p2 WHERE p2.lead_id = e.lead_id
      ORDER BY p2.generated_at DESC, p2.id DESC LIMIT 1
    )
    WHERE e.campaign_id = ? AND e.lead_id = ?
  `).get(campaignId, leadId);
  if (!row) return { eligibility: 'not_enrolled', personalizationId: null };
  let eligibility = 'eligible';
  if (row.enrollment_status === 'stopped') eligibility = 'stopped';
  else if (row.enrollment_status === 'completed') eligibility = 'completed';
  else if (row.submission_uncertain) eligibility = 'submission_uncertain';
  else if (!row.email?.trim()) eligibility = 'missing_email';
  else if (row.suppressed) eligibility = 'suppressed';
  else if (!ignoreOutOfOffice && row.defer_manual_review) eligibility = 'out_of_office_review';
  else if (!ignoreOutOfOffice && row.defer_until && db.prepare("SELECT julianday(?) > julianday('now') AS active").get(row.defer_until).active) eligibility = 'out_of_office_deferred';
  else if (!row.email_verified) eligibility = 'verification_required';
  else if (!['queued', 'awaiting_approval'].includes(row.contact_status)
    && !(allowSent && row.contact_status === 'sent')) eligibility = 'contact_not_ready';
  else if (!row.personalization_id) eligibility = 'personalization_required';
  else if (!row.guardrail_passed) eligibility = 'copy_review_required';
  else if (!row.approved) eligibility = 'approval_required';
  else if (!row.subject_line?.trim() || !row.body_text?.trim()) eligibility = 'copy_incomplete';
  else if (row.enrollment_status !== 'active') eligibility = 'not_active';
  return { eligibility, personalizationId: row.personalization_id, deferUntil: row.defer_until || null, deferManualReview: Boolean(row.defer_manual_review) };
}

export function reactivateSequenceAfterOutOfOffice(campaignValue, leadValue) {
  const campaignId = normalizeId(campaignValue, 'Campaign id');
  const leadId = normalizeId(leadValue, 'Contact id');
  const db = getDb();
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM campaigns WHERE id=?').get(campaignId)) throw new CampaignAudienceError('Campaign not found.', 404);
    if (!db.prepare('SELECT 1 FROM campaign_steps WHERE campaign_id=? LIMIT 1').get(campaignId)) {
      throw new CampaignAudienceError('This campaign has no sequence to reactivate.', 409);
    }
    const enrollment = db.prepare(`SELECT status,defer_manual_review FROM campaign_enrollments
      WHERE campaign_id=? AND lead_id=?`).get(campaignId, leadId);
    if (!enrollment) throw new CampaignAudienceError('Contact is not enrolled in this campaign.', 404);
    if (enrollment.status !== 'active' || !enrollment.defer_manual_review) {
      throw new CampaignAudienceError('This sequence is not waiting for out-of-office review.', 409);
    }
    const followup = db.prepare(`SELECT id FROM sends WHERE campaign_id=? AND lead_id=?
      AND campaign_step_id IS NOT NULL AND status='scheduled' ORDER BY scheduled_at, id LIMIT 1`).get(campaignId, leadId);
    if (!followup) throw new CampaignAudienceError('There is no scheduled follow-up to reactivate.', 409);
    db.prepare('UPDATE campaign_enrollments SET defer_until=NULL,defer_manual_review=0 WHERE campaign_id=? AND lead_id=?')
      .run(campaignId, leadId);
    db.prepare("UPDATE sends SET scheduled_at=datetime('now'),error_message='Out-of-office hold cleared by operator; review reply before processing.' WHERE id=? AND status='scheduled'")
      .run(followup.id);
    db.prepare(`INSERT INTO events(send_id,lead_id,event_type,event_at,meta_json)
      VALUES(?,?, 'campaign_sequence_reactivated_after_ooo',datetime('now'),?)`)
      .run(followup.id, leadId, JSON.stringify({ campaign_id: campaignId, operator_action: true }));
    return { campaignId, leadId, sendId: followup.id, scheduledAt: db.prepare('SELECT scheduled_at FROM sends WHERE id=?').get(followup.id).scheduled_at };
  })();
}
