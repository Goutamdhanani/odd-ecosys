import { getDb } from './database.js';
import { listLeadCustomFields } from './contact-fields.js';

export class CampaignSequenceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CampaignSequenceError';
    this.statusCode = statusCode;
  }
}

const MAX_STEPS = 10;
const MAX_VARIANTS = 4;
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 50000;
const ALLOWED_VARIANTS = new Set(['A', 'B', 'C', 'D']);

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new CampaignSequenceError(`${label} must be a positive integer.`);
  return id;
}

function validateDelay(value, position) {
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 365) {
    throw new CampaignSequenceError('Step delay must be an integer from 0 to 365 days.');
  }
  if (position === 1 && delay !== 0) throw new CampaignSequenceError('The first sequence step must have a 0-day delay.');
  if (position > 1 && delay < 1) throw new CampaignSequenceError('Follow-up steps must wait at least 1 day.');
  return delay;
}

function validateVariants(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_VARIANTS) {
    throw new CampaignSequenceError(`Each step must have 1 to ${MAX_VARIANTS} copy variants.`);
  }
  const variants = values.map((item, index) => {
    const variantKey = String(item?.variantKey || '').trim().toUpperCase();
    if (!ALLOWED_VARIANTS.has(variantKey)) throw new CampaignSequenceError('Variant keys must be A, B, C, or D.');
    const subjectLine = item.subjectLine === undefined ? '' : item.subjectLine;
    const bodyText = item.bodyText === undefined ? '' : item.bodyText;
    if (typeof subjectLine !== 'string' || subjectLine.length > MAX_SUBJECT_LENGTH) {
      throw new CampaignSequenceError(`Variant ${variantKey} subject must be text of at most ${MAX_SUBJECT_LENGTH} characters.`);
    }
    if (typeof bodyText !== 'string' || bodyText.length > MAX_BODY_LENGTH) {
      throw new CampaignSequenceError(`Variant ${variantKey} body must be text of at most ${MAX_BODY_LENGTH} characters.`);
    }
    const allocationPct = Number(item.allocationPct);
    if (!Number.isSafeInteger(allocationPct) || allocationPct < 0 || allocationPct > 100) {
      throw new CampaignSequenceError(`Variant ${variantKey} allocation must be an integer from 0 to 100.`);
    }
    return { variantKey, subjectLine, bodyText, allocationPct, index };
  });
  if (new Set(variants.map(item => item.variantKey)).size !== variants.length) {
    throw new CampaignSequenceError('Variant keys must be unique within a sequence step.');
  }
  if (!variants.some(item => item.variantKey === 'A')) throw new CampaignSequenceError('Variant A is required.');
  if (variants.reduce((total, item) => total + item.allocationPct, 0) !== 100) {
    throw new CampaignSequenceError('Variant allocations must total exactly 100%.');
  }
  return variants.sort((a, b) => a.variantKey.localeCompare(b.variantKey));
}

function getCampaign(db, campaignId) {
  return db.prepare('SELECT id,name,status FROM campaigns WHERE id=?').get(campaignId);
}

function requireEditableCampaign(db, campaignId) {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) throw new CampaignSequenceError('Campaign not found.', 404);
  if (campaign.status !== 'draft' || db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId)) {
    throw new CampaignSequenceError('Sequence drafts can only be changed on campaigns with draft status and no send history.', 409);
  }
  return campaign;
}

function hasSendHistory(db, campaignId) {
  return db.prepare('SELECT 1 FROM sends WHERE campaign_id=? LIMIT 1').get(campaignId) !== undefined;
}

function readSequence(db, campaign) {
  const steps = db.prepare('SELECT id,campaign_id,position,delay_days,created_at,updated_at FROM campaign_steps WHERE campaign_id=? ORDER BY position,id').all(campaign.id);
  const getVariants = db.prepare(`
    SELECT id,variant_key AS variantKey,allocation_pct AS allocationPct,subject_line AS subjectLine,body_text AS bodyText
    FROM campaign_step_variants WHERE step_id=? ORDER BY variant_key
  `);
  return {
    campaign: { ...campaign },
    locked: campaign.status !== 'draft' || hasSendHistory(db, campaign.id),
    executionAvailable: true,
    executionNote: 'Queueing starts step 1. The existing send worker schedules each follow-up only after SMTP acceptance and stops the sequence when a reply is recorded.',
    steps: steps.map(step => ({ ...step, delayDays: step.delay_days, variants: getVariants.all(step.id) })),
  };
}

/** Assign a contact to a copy variant deterministically, without using runtime randomness. */
export function selectCampaignStepVariant(campaignValue, stepValue, leadValue) {
  const campaignId = positiveId(campaignValue, 'Campaign id');
  const stepId = positiveId(stepValue, 'Step id');
  const leadId = positiveId(leadValue, 'Contact id');
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM campaign_steps WHERE campaign_id=? AND id=?').get(campaignId, stepId)) {
    throw new CampaignSequenceError('Sequence step not found for this campaign.', 404);
  }
  if (!db.prepare('SELECT 1 FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, leadId)) {
    throw new CampaignSequenceError('Contact is not enrolled in this campaign.', 404);
  }
  const variants = db.prepare(`
    SELECT variant_key, allocation_pct FROM campaign_step_variants
    WHERE step_id=? AND allocation_pct > 0 ORDER BY variant_key
  `).all(stepId);
  if (!variants.length || variants.reduce((sum, variant) => sum + variant.allocation_pct, 0) !== 100) {
    throw new CampaignSequenceError('Active sequence variant allocations must total exactly 100%.', 409);
  }
  const identity = `${campaignId}:${stepId}:${leadId}`;
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bucket = (hash >>> 0) % 100;
  let boundary = 0;
  for (const variant of variants) {
    boundary += variant.allocation_pct;
    if (bucket < boundary) return variant.variant_key;
  }
  return variants.at(-1).variant_key;
}

function recordEvent(db, eventType, campaignId, metadata = {}) {
  db.prepare('INSERT INTO events(event_type,event_at,meta_json) VALUES (?,datetime(\'now\'),?)')
    .run(eventType, JSON.stringify({ campaign_id: campaignId, ...metadata }));
}

function compactStepOrder(db, campaignId, orderedIds) {
  if (orderedIds.length) {
    db.prepare('UPDATE campaign_steps SET position=position+10 WHERE campaign_id=?').run(campaignId);
    const setPosition = db.prepare('UPDATE campaign_steps SET position=?,delay_days=?,updated_at=datetime(\'now\') WHERE campaign_id=? AND id=?');
    orderedIds.forEach((stepId, index) => {
      const row = db.prepare('SELECT delay_days FROM campaign_steps WHERE campaign_id=? AND id=?').get(campaignId, stepId);
      const delayDays = index === 0 ? 0 : Math.max(1, row.delay_days);
      setPosition.run(index + 1, delayDays, campaignId, stepId);
    });
  }
}

export function getCampaignSequence(value) {
  const campaignId = positiveId(value, 'Campaign id');
  const db = getDb();
  const campaign = getCampaign(db, campaignId);
  return campaign ? readSequence(db, campaign) : null;
}

/** Create a safe, unsent draft copy of a campaign's reusable sequence content. */
export function cloneCampaignAsDraft(value, input = {}) {
  const sourceCampaignId = positiveId(value, 'Campaign id');
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw new CampaignSequenceError('A name is required for the new campaign draft.');
  if (name.length > 200) throw new CampaignSequenceError('Campaign names must be 200 characters or fewer.');

  const db = getDb();
  return db.transaction(() => {
    const source = db.prepare('SELECT id FROM campaigns WHERE id=?').get(sourceCampaignId);
    if (!source) throw new CampaignSequenceError('Campaign not found.', 404);
    const steps = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? ORDER BY position,id').all(sourceCampaignId);
    if (steps.length > MAX_STEPS) throw new CampaignSequenceError('The source campaign has more steps than a new draft supports.', 409);

    const created = db.prepare(`INSERT INTO campaigns(name,sequence_step,template_ref,status)
      VALUES (?,1,NULL,'draft')`).run(name,);
    const campaignId = Number(created.lastInsertRowid);
    const insertStep = db.prepare('INSERT INTO campaign_steps(campaign_id,position,delay_days) VALUES (?,?,?)');
    const selectVariants = db.prepare(`SELECT variant_key,allocation_pct,subject_line,body_text
      FROM campaign_step_variants WHERE step_id=? ORDER BY variant_key`);
    const insertVariant = db.prepare(`INSERT INTO campaign_step_variants
      (step_id,variant_key,allocation_pct,subject_line,body_text) VALUES (?,?,?,?,?)`);
    for (const step of steps) {
      const result = insertStep.run(campaignId, step.position, step.delay_days);
      for (const variant of selectVariants.all(step.id)) {
        insertVariant.run(Number(result.lastInsertRowid), variant.variant_key, variant.allocation_pct, variant.subject_line, variant.body_text);
      }
    }
    recordEvent(db, 'campaign_cloned', campaignId, { source_campaign_id: sourceCampaignId, sequence_step_count: steps.length });
    return { id: campaignId, name, status: 'draft', sourceCampaignId, sequenceStepCount: steps.length };
  })();
}

export function createCampaignStep(value, input = {}) {
  const campaignId = positiveId(value, 'Campaign id');
  const db = getDb();
  return db.transaction(() => {
    requireEditableCampaign(db, campaignId);
    const count = db.prepare('SELECT COUNT(*) AS count FROM campaign_steps WHERE campaign_id=?').get(campaignId).count;
    if (count >= MAX_STEPS) throw new CampaignSequenceError(`A campaign can have at most ${MAX_STEPS} sequence steps.`, 409);
    const position = count + 1;
    const delayDays = validateDelay(input.delayDays === undefined ? (position === 1 ? 0 : 3) : input.delayDays, position);
    const step = db.prepare('INSERT INTO campaign_steps(campaign_id,position,delay_days) VALUES (?,?,?)').run(campaignId, position, delayDays);
    const stepId = Number(step.lastInsertRowid);
    const insertVariant = db.prepare('INSERT INTO campaign_step_variants(step_id,variant_key,allocation_pct) VALUES (?,?,?)');
    insertVariant.run(stepId, 'A', 50);
    insertVariant.run(stepId, 'B', 50);
    recordEvent(db, 'campaign_sequence_step_created', campaignId, { step_id: stepId, position, delay_days: delayDays });
    return readSequence(db, getCampaign(db, campaignId));
  })();
}

export function updateCampaignStep(value, stepValue, input = {}) {
  const campaignId = positiveId(value, 'Campaign id');
  const stepId = positiveId(stepValue, 'Step id');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CampaignSequenceError('Step update must be an object.');
  const db = getDb();
  return db.transaction(() => {
    requireEditableCampaign(db, campaignId);
    const step = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? AND id=?').get(campaignId, stepId);
    if (!step) throw new CampaignSequenceError('Sequence step not found.', 404);
    const delayDays = input.delayDays === undefined ? step.delay_days : validateDelay(input.delayDays, step.position);
    db.prepare('UPDATE campaign_steps SET delay_days=?,updated_at=datetime(\'now\') WHERE id=?').run(delayDays, stepId);
    if (input.variants !== undefined) {
      const variants = validateVariants(input.variants);
      db.prepare('DELETE FROM campaign_step_variants WHERE step_id=?').run(stepId);
      const insertVariant = db.prepare(`INSERT INTO campaign_step_variants(step_id,variant_key,allocation_pct,subject_line,body_text) VALUES (?,?,?,?,?)`);
      for (const variant of variants) insertVariant.run(stepId, variant.variantKey, variant.allocationPct, variant.subjectLine, variant.bodyText);
    }
    recordEvent(db, 'campaign_sequence_step_updated', campaignId, { step_id: stepId, delay_days: delayDays, variants_updated: input.variants !== undefined });
    return readSequence(db, getCampaign(db, campaignId));
  })();
}

export function reorderCampaignSteps(value, orderValues) {
  const campaignId = positiveId(value, 'Campaign id');
  if (!Array.isArray(orderValues) || orderValues.length > MAX_STEPS) throw new CampaignSequenceError(`Step order must contain at most ${MAX_STEPS} ids.`);
  const ids = orderValues.map(id => positiveId(id, 'Step id'));
  if (new Set(ids).size !== ids.length) throw new CampaignSequenceError('Step order cannot contain duplicates.');
  const db = getDb();
  return db.transaction(() => {
    requireEditableCampaign(db, campaignId);
    const current = db.prepare('SELECT id FROM campaign_steps WHERE campaign_id=? ORDER BY position,id').all(campaignId).map(row => row.id);
    if (ids.length !== current.length || ids.some(id => !current.includes(id))) {
      throw new CampaignSequenceError('Step order must include every current step exactly once.');
    }
    compactStepOrder(db, campaignId, ids);
    recordEvent(db, 'campaign_sequence_reordered', campaignId, { step_ids: ids });
    return readSequence(db, getCampaign(db, campaignId));
  })();
}

export function deleteCampaignStep(value, stepValue) {
  const campaignId = positiveId(value, 'Campaign id');
  const stepId = positiveId(stepValue, 'Step id');
  const db = getDb();
  return db.transaction(() => {
    requireEditableCampaign(db, campaignId);
    const step = db.prepare('SELECT id FROM campaign_steps WHERE campaign_id=? AND id=?').get(campaignId, stepId);
    if (!step) throw new CampaignSequenceError('Sequence step not found.', 404);
    db.prepare('DELETE FROM campaign_steps WHERE id=?').run(stepId);
    const remaining = db.prepare('SELECT id FROM campaign_steps WHERE campaign_id=? ORDER BY position,id').all(campaignId).map(row => row.id);
    compactStepOrder(db, campaignId, remaining);
    recordEvent(db, 'campaign_sequence_step_deleted', campaignId, { step_id: stepId });
    return readSequence(db, getCampaign(db, campaignId));
  })();
}

function fallbackValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function renderMerge(text, fields, unresolved) {
  const rendered = text.replace(/\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)?)\s*(?:\|\s*([^{}]*?))?\s*\}\}/gi, (_match, rawField, rawFallback) => {
    const key = rawField.toLowerCase();
    const value = fields[key];
    if (value !== null && value !== undefined && !(typeof value === 'string' && !value.trim())) return String(value);
    if (rawFallback !== undefined) return fallbackValue(rawFallback);
    unresolved.add(key);
    return '';
  });
  return rendered.replace(/\{\{[^{}]*(?:\}\}|$)/g, token => {
    const unresolvedToken = token.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim().toLowerCase();
    unresolved.add(unresolvedToken || 'invalid_merge_field');
    return '';
  });
}

export function previewCampaignStep(value, stepValue, leadValue, variantKeyValue = 'A') {
  const campaignId = positiveId(value, 'Campaign id');
  const stepId = positiveId(stepValue, 'Step id');
  const leadId = positiveId(leadValue, 'Contact id');
  const variantKey = String(variantKeyValue || '').trim().toUpperCase();
  if (!ALLOWED_VARIANTS.has(variantKey)) throw new CampaignSequenceError('Variant key must be A, B, C, or D.');
  const db = getDb();
  const campaign = getCampaign(db, campaignId);
  if (!campaign) throw new CampaignSequenceError('Campaign not found.', 404);
  const step = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? AND id=?').get(campaignId, stepId);
  if (!step) throw new CampaignSequenceError('Sequence step not found.', 404);
  const lead = db.prepare(`
    SELECT l.id,l.business_name,l.email,l.category,l.address,l.city,l.state,l.country,l.phone,l.website_url
    FROM campaign_enrollments e JOIN leads l ON l.id=e.lead_id
    WHERE e.campaign_id=? AND e.lead_id=?
  `).get(campaignId, leadId);
  if (!lead) throw new CampaignSequenceError('Choose a contact enrolled in this campaign to preview.', 404);
  const variant = db.prepare(`SELECT variant_key,allocation_pct,subject_line,body_text FROM campaign_step_variants WHERE step_id=? AND variant_key=?`).get(stepId, variantKey);
  if (!variant) throw new CampaignSequenceError(`Variant ${variantKey} does not exist for this step.`, 404);
  const fields = {
    business_name: lead.business_name || '', company: lead.business_name || '', email: lead.email || '',
    category: lead.category || '', address: lead.address || '', city: lead.city || '', state: lead.state || '',
    country: lead.country || '', phone: lead.phone || '', website: lead.website_url || '', website_url: lead.website_url || '',
  };
  for (const field of listLeadCustomFields(db, lead.id)) fields[`custom.${field.fieldKey}`] = field.value;
  const unresolved = new Set();
  const subject = renderMerge(variant.subject_line, fields, unresolved);
  const body = renderMerge(variant.body_text, fields, unresolved);
  const unresolvedTokens = [...unresolved].sort();
  const missingContent = [];
  if (!subject.trim()) missingContent.push('subject');
  if (!body.trim()) missingContent.push('body');
  return {
    campaignId, stepId, leadId, position: step.position, delayDays: step.delay_days,
    variantKey: variant.variant_key, allocationPct: variant.allocation_pct,
    subject, body, unresolvedTokens, missingContent,
    ready: missingContent.length === 0 && unresolvedTokens.length === 0,
  };
}
