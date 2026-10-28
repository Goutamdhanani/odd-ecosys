import { createHash } from 'node:crypto';
import { getDb } from './database.js';
import { runGuardrails } from './personalizer.js';

export class CampaignPreparationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CampaignPreparationError';
    this.statusCode = statusCode;
  }
}

function canonicalId(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new CampaignPreparationError(`${label} must be a canonical positive integer.`);
  }
  return Number(value);
}

// Audience exposes these five fields. Include review flags so a concurrent
// approval or legacy in-place edit cannot be silently replaced by an old editor.
export function recipientDraftHash(copy) {
  return copy ? createHash('sha256').update(JSON.stringify([
    copy.id, copy.subject_line, copy.body_text, copy.approved, copy.guardrail_passed,
  ])).digest('hex') : null;
}

function validateDraft(value) {
  const keys = ['subjectLine', 'bodyText', 'expectedLatestPersonalizationId', 'expectedLatestCopyHash'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new CampaignPreparationError('Provide a subject, message, and the current saved-copy version only. Refresh the campaign and try again.');
  }
  if (typeof value.subjectLine !== 'string' || !value.subjectLine.trim() || value.subjectLine.length > 998
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value.subjectLine)) {
    throw new CampaignPreparationError('Enter a subject of 1 to 998 characters on one line, without control characters.');
  }
  if (typeof value.bodyText !== 'string' || !value.bodyText.trim() || value.bodyText.length > 50000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.bodyText)) {
    throw new CampaignPreparationError('Enter a message of 1 to 50,000 characters without unsupported control characters.');
  }
  const expectedId = value.expectedLatestPersonalizationId;
  const expectedHash = value.expectedLatestCopyHash;
  if (expectedId !== null && (typeof expectedId !== 'number' || !Number.isSafeInteger(expectedId) || expectedId < 1)) {
    throw new CampaignPreparationError('The saved-copy version is invalid. Refresh the campaign and reopen the message.');
  }
  if ((expectedId === null && expectedHash !== null)
    || (expectedId !== null && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)))) {
    throw new CampaignPreparationError('The saved-copy fingerprint is invalid. Refresh the campaign and reopen the message.');
  }
  return { subject_line: value.subjectLine.trim(), body_text: value.bodyText.trim(), expectedId, expectedHash };
}

/** Append a human-written draft. This performs no AI, verification or sending. */
export function saveCampaignRecipientDraft(campaignValue, leadValue, value, actor) {
  const campaignId = canonicalId(campaignValue, 'Campaign id');
  const leadId = canonicalId(leadValue, 'Contact id');
  const draft = validateDraft(value);
  const db = getDb();
  return db.transaction(() => {
    // Re-read role under the same write lock as every policy and version check.
    const member = Number.isSafeInteger(actor?.id) && actor.id > 0
      ? db.prepare('SELECT id,role,is_active FROM auth_users WHERE id=?').get(actor.id) : null;
    if (!member?.is_active || !['owner', 'admin', 'operator'].includes(member.role) || actor.role !== member.role) {
      throw new CampaignPreparationError('Sign in as an active owner, admin, or operator to write campaign messages.', 403);
    }
    const campaign = db.prepare('SELECT status FROM campaigns WHERE id=?').get(campaignId);
    if (!campaign) throw new CampaignPreparationError('This campaign no longer exists. Return to Campaigns and choose a saved draft.', 404);
    if (campaign.status !== 'draft'
      || db.prepare('SELECT 1 FROM campaign_launches WHERE campaign_id=? LIMIT 1').get(campaignId)
      || db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId)) {
      throw new CampaignPreparationError('This campaign has launched or has sending history. Duplicate it as a new draft to change messages.', 409);
    }
    const enrollment = db.prepare('SELECT status FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId);
    if (!enrollment) throw new CampaignPreparationError('This contact is no longer in this campaign. Refresh recipients before writing a message.', 404);
    if (enrollment.status !== 'active') throw new CampaignPreparationError('This recipient has stopped or completed the sequence. Its copy cannot be replaced here.', 409);
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
    if (!lead) throw new CampaignPreparationError('This contact no longer exists. Refresh recipients.', 404);
    // Single-address re-verification preserves imported/qualified stages;
    // batch verification uses 'verifying'. Every permitted stage still needs
    // the matching saved deliverable evidence below to unlock manual review.
    if (!['discovered', 'site_checked', 'verified', 'verifying', 'awaiting_approval', 'queued'].includes(lead.status)) {
      throw new CampaignPreparationError('This contact is not ready for message review. Verify it and resolve its contact status before continuing.', 409);
    }
    if (!lead.email?.trim() || !db.prepare(`SELECT 1 FROM lead_emails WHERE lead_id=?
        AND lower(trim(email))=lower(trim(?)) AND verification_status='deliverable' LIMIT 1`).get(leadId, lead.email)) {
      throw new CampaignPreparationError('Verify this contact’s current email address first. Only a saved deliverable result can unlock message drafting.', 409);
    }
    if (db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=lower(trim(?)) LIMIT 1').get(lead.email)) {
      throw new CampaignPreparationError('This email is suppressed. Keep it out of outreach; message drafting cannot remove suppression.', 409);
    }
    // Copy is contact-wide. Replacing it could invalidate another campaign's
    // immutable launch, so reject those conflicts rather than editing history.
    if (db.prepare(`SELECT 1 FROM sends WHERE lead_id=? AND status IN ('scheduled','sending','processing','uncertain','sent') LIMIT 1`).get(leadId)
      || db.prepare(`SELECT 1 FROM campaign_enrollments e JOIN campaign_launches cl ON cl.campaign_id=e.campaign_id
        WHERE e.lead_id=? LIMIT 1`).get(leadId)) {
      throw new CampaignPreparationError('This contact already belongs to launched or pending outreach. Resolve that campaign before replacing contact-wide copy.', 409);
    }
    const previous = db.prepare('SELECT * FROM personalizations WHERE lead_id=? ORDER BY generated_at DESC,id DESC LIMIT 1').get(leadId);
    if ((previous?.id ?? null) !== draft.expectedId || recipientDraftHash(previous) !== draft.expectedHash) {
      throw new CampaignPreparationError('This message changed while you were reviewing it. Refresh the campaign and reopen the latest copy before saving.', 409);
    }
    const facts = Object.fromEntries(['business_name', 'category', 'city', 'country', 'rating', 'reviews', 'website_url', 'site_status', 'site_score']
      .filter(key => lead[key] !== null && lead[key] !== undefined).map(key => [key, lead[key]]));
    const guardrails = runGuardrails(draft, facts);
    // New ids break equal-timestamp ties. Preserve a future legacy timestamp
    // rather than appending a row that the existing latest-copy query ignores.
    const inserted = db.prepare(`INSERT INTO personalizations
        (lead_id,subject_variant,subject_line,body_variant,body_text,model_used,guardrail_passed,fact_check_passed,fact_check_status,approved,generated_at)
      VALUES (?,'A',?,'A',?,'manual',?,0,'unavailable',0,
        CASE WHEN ? > datetime('now') THEN ? ELSE datetime('now') END)`)
      .run(leadId, draft.subject_line, draft.body_text, Number(guardrails.passed), previous?.generated_at ?? '', previous?.generated_at ?? '');
    const personalizationId = Number(inserted.lastInsertRowid);
    db.prepare("UPDATE leads SET status='awaiting_approval',updated_at=datetime('now') WHERE id=?").run(leadId);
    db.prepare("INSERT INTO events(lead_id,event_type,meta_json) VALUES (?,'campaign_manual_copy_saved',?)").run(leadId, JSON.stringify({
      campaignId, personalizationId, previousPersonalizationId: previous?.id ?? null,
      actorId: member.id, actorRole: member.role, modelUsed: 'manual',
      copyContentHash: createHash('sha256').update(JSON.stringify([draft.subject_line, draft.body_text])).digest('hex'),
      guardrailPassed: guardrails.passed, guardrailFailures: guardrails.failures, factCheckStatus: 'unavailable', approved: false,
    }));
    const saved = db.prepare('SELECT id,subject_line,body_text,approved,guardrail_passed FROM personalizations WHERE id=?').get(personalizationId);
    return { campaignId, leadId, personalizationId, approved: false, guardrailPassed: guardrails.passed,
      guardrailFailures: guardrails.failures, factCheckStatus: 'unavailable', latestCopyHash: recipientDraftHash(saved) };
  }).immediate();
}
