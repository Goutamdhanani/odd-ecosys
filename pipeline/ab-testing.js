// ============================================================
//  ODD-ECOSYS Pipeline — A/B Testing Framework (Phase 7)
//  Two-proportion z-test, fixed-horizon testing,
//  champion/challenger auto-promotion, variant tracking
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';
import { selectCampaignStepVariant } from './campaign-sequence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'sending-engine.json');
let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return _config;
}

// ══════════════════════════════════════════════════════════════
//  STATISTICAL TESTS
// ══════════════════════════════════════════════════════════════

/**
 * Standard normal CDF (approximation via Abramowitz & Stegun).
 */
function normalCDF(z) {
  if (z < -6) return 0;
  if (z > 6) return 1;
  const sign = z < 0 ? -1 : 1;
  const abs = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * abs);
  const d = 0.3989422804014327; // 1/sqrt(2*PI)
  const p = d * Math.exp(-abs * abs / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return sign > 0 ? 1 - p * poly : p * poly;
}

/**
 * Two-proportion z-test.
 * Tests whether p1 (variant A success rate) is significantly
 * different from p2 (variant B success rate).
 *
 * @param {number} n1 - Sample size for variant A
 * @param {number} x1 - Successes for variant A
 * @param {number} n2 - Sample size for variant B
 * @param {number} x2 - Successes for variant B
 * @returns {object} { zScore, pValue, significant, confidence }
 */
export function zTest(n1, x1, n2, x2) {
  if (n1 === 0 || n2 === 0) return { zScore: 0, pValue: 1, significant: false, confidence: 0 };

  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1/n1 + 1/n2));

  if (se === 0) return { zScore: 0, pValue: 1, significant: false, confidence: 0 };

  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCDF(Math.abs(z))); // two-tailed
  const confidence = 1 - pValue;

  return {
    zScore: parseFloat(z.toFixed(4)),
    pValue: parseFloat(pValue.toFixed(6)),
    significant: confidence >= (getConfig().ab_testing.significance_threshold || 0.95),
    confidence: parseFloat(confidence.toFixed(4)),
  };
}

// ══════════════════════════════════════════════════════════════
//  VARIANT STATS
// ══════════════════════════════════════════════════════════════

/**
 * Get evidence-based per-variant statistics. Sequence campaigns default to
 * their first step and can be queried one step at a time; combining steps
 * would compare different messages as one experiment.
 */
export function getVariantStats(campaignId, stepIdValue = null) {
  const db = getDb();
  const config = getConfig().ab_testing;
  const normalizedCampaignId = Number(campaignId);
  if (!Number.isSafeInteger(normalizedCampaignId) || normalizedCampaignId < 1) {
    const error = new Error('Campaign id must be a positive integer.'); error.statusCode = 400; throw error;
  }
  if (!db.prepare('SELECT 1 FROM campaigns WHERE id=?').get(normalizedCampaignId)) {
    const error = new Error('Campaign not found.'); error.statusCode = 404; throw error;
  }
  const sequenceSteps = db.prepare('SELECT id,position,delay_days FROM campaign_steps WHERE campaign_id=? ORDER BY position,id').all(normalizedCampaignId);
  let selectedStep = null;
  if (sequenceSteps.length) {
    const requestedStepId = stepIdValue === null || stepIdValue === undefined ? sequenceSteps[0].id : Number(stepIdValue);
    if (!Number.isSafeInteger(requestedStepId) || requestedStepId < 1) {
      const error = new Error('stepId must be a positive integer.'); error.statusCode = 400; throw error;
    }
    selectedStep = sequenceSteps.find(step => step.id === requestedStepId);
    if (!selectedStep) { const error = new Error('Sequence step not found for this campaign.'); error.statusCode = 404; throw error; }
  } else if (stepIdValue !== null && stepIdValue !== undefined) {
    const error = new Error('This campaign has no sequence step to report.'); error.statusCode = 404; throw error;
  }

  const variantRows = selectedStep
    ? db.prepare(`SELECT DISTINCT variant FROM sends
        WHERE campaign_id=? AND campaign_step_id=? AND variant IS NOT NULL AND status='sent' ORDER BY variant`)
      .all(normalizedCampaignId, selectedStep.id)
    : db.prepare(`SELECT DISTINCT variant FROM sends
        WHERE campaign_id=? AND campaign_step_id IS NULL AND variant IS NOT NULL AND status='sent' ORDER BY variant`)
      .all(normalizedCampaignId);
  const responseBase = {
    campaignId: normalizedCampaignId,
    sequenceSteps: sequenceSteps.map(step => ({ id: step.id, position: step.position, delayDays: step.delay_days })),
    selectedStepId: selectedStep?.id ?? null,
    selectedStepPosition: selectedStep?.position ?? null,
    sample_size: config.default_sample_size,
    significance_threshold: config.significance_threshold,
    metric: config.primary_metric,
  };
  if (!variantRows.length) return { ...responseBase, variants: [], comparisons: [], winner: null };

  const scope = selectedStep ? ' AND s.campaign_step_id=?' : ' AND s.campaign_step_id IS NULL';
  const variants = variantRows.map(({ variant }) => {
    const statsQuery = `SELECT COUNT(DISTINCT s.id) AS sent,
        COUNT(DISTINCT CASE WHEN e.event_type='delivered' THEN s.id END) AS delivered,
        COUNT(CASE WHEN e.event_type='tracked_link_requested' THEN 1 END) AS tracked_link_requests,
        COUNT(DISTINCT CASE WHEN e.event_type='tracked_link_requested' THEN s.id END) AS messages_with_link_requests,
        COUNT(DISTINCT CASE WHEN e.event_type='replied' THEN s.id END) AS replied,
        COUNT(DISTINCT CASE WHEN e.event_type IN ('hard_bounce','soft_bounce') THEN s.id END) AS bounced,
        COUNT(DISTINCT CASE WHEN e.event_type='spam_complaint' THEN s.id END) AS complaints
      FROM sends s LEFT JOIN events e ON e.send_id=s.id
      WHERE s.campaign_id=? AND s.variant=? AND s.status='sent'${scope}`;
    const stats = selectedStep
      ? db.prepare(statsQuery).get(normalizedCampaignId, variant, selectedStep.id)
      : db.prepare(statsQuery).get(normalizedCampaignId, variant);
    const replyRowsQuery = `SELECT e.send_id,e.meta_json,e.event_at FROM events e
      JOIN sends s ON s.id=e.send_id
      WHERE s.campaign_id=? AND s.variant=? AND s.status='sent'${scope} AND e.event_type='replied'
      ORDER BY e.event_at,e.id`;
    const replyRows = selectedStep
      ? db.prepare(replyRowsQuery).all(normalizedCampaignId, variant, selectedStep.id)
      : db.prepare(replyRowsQuery).all(normalizedCampaignId, variant);
    const replyBySend = new Map();
    for (const row of replyRows) {
      let meta = {};
      try { meta = JSON.parse(row.meta_json || '{}'); } catch { /* malformed history is not positive evidence */ }
      const current = replyBySend.get(row.send_id) || { positive: false };
      current.positive ||= meta.sentiment === 'interested' || meta.sentiment === 'positive';
      replyBySend.set(row.send_id, current);
    }
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const dailyQuery = `SELECT COUNT(*) AS c FROM (
          SELECT e.send_id,MIN(e.event_at) AS replied_at FROM events e JOIN sends s ON s.id=e.send_id
          WHERE s.campaign_id=? AND s.variant=? AND s.status='sent'${scope} AND e.event_type='replied'
          GROUP BY e.send_id
        ) replies WHERE date(replied_at)>=date('now','-${i} days')
          AND date(replied_at)<date('now','-${i - 1} days')`;
      const count = selectedStep
        ? db.prepare(dailyQuery).get(normalizedCampaignId, variant, selectedStep.id).c
        : db.prepare(dailyQuery).get(normalizedCampaignId, variant).c;
      daily.push(count);
    }
    const sent = stats.sent || 0;
    const replied = replyBySend.size;
    const positive = [...replyBySend.values()].filter(reply => reply.positive).length;
    const sampleTarget = Math.max(1, Number(config.default_sample_size) || 1);
    return {
      variant, sent, delivered: stats.delivered || 0,
      trackedLinkRequests: stats.tracked_link_requests || 0,
      messagesWithLinkRequests: stats.messages_with_link_requests || 0,
      replied, positive, bounced: stats.bounced || 0,
      complaints: stats.complaints || 0, daily,
      reply_rate: sent > 0 ? (replied / sent) : 0,
      positive_rate: sent > 0 ? (positive / sent) : 0,
      sample_target: config.default_sample_size,
      sample_progress: Math.min(1, sent / sampleTarget),
    };
  });

  const comparisons = [];
  const metric = config.primary_metric || 'replied';
  const sampleTarget = Math.max(1, Number(config.default_sample_size) || 1);
  for (let i = 1; i < variants.length; i++) {
    const a = variants[0];
    const b = variants[i];
    const metricA = a[metric] || 0;
    const metricB = b[metric] || 0;
    const test = zTest(a.sent, metricA, b.sent, metricB);
    const sampleMet = a.sent >= sampleTarget && b.sent >= sampleTarget;
    const significant = sampleMet && test.significant;
    comparisons.push({
      variantA: a.variant, variantB: b.variant, metric,
      rateA: a.sent > 0 ? metricA / a.sent : 0,
      rateB: b.sent > 0 ? metricB / b.sent : 0,
      ...test, significant, sampleTarget, sampleMet,
      winner: significant ? (metricA / (a.sent || 1)) > (metricB / (b.sent || 1)) ? a.variant : b.variant : null,
    });
  }
  let declaredWinner = null;
  for (const comparison of comparisons) if (comparison.winner) { declaredWinner = comparison.winner; break; }
  const enrichedVariants = variants.map(variant => ({
    ...variant,
    declared_winner: variant.variant === declaredWinner,
    significance: comparisons.find(comparison => comparison.variantA === variant.variant || comparison.variantB === variant.variant)?.confidence || 0,
  }));
  return { ...responseBase, variants: enrichedVariants, comparisons, winner: declaredWinner };
}

// ══════════════════════════════════════════════════════════════
//  CHAMPION / CHALLENGER AUTO-PROMOTE
// ══════════════════════════════════════════════════════════════

/** Return statistically eligible winner recommendations without mutating a launched experiment. */
export function autoPromoteWinners() {
  const db = getDb();
  const campaigns = db.prepare("SELECT * FROM campaigns WHERE status NOT IN ('archived','stopped')").all();
  const recommendations = [];

  for (const campaign of campaigns) {
    const stats = getVariantStats(campaign.id);
    if (!stats.winner) continue;
    recommendations.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      winner: stats.winner,
      confidence: stats.comparisons[0]?.confidence,
      stepId: stats.selectedStepId,
      stepPosition: stats.selectedStepPosition,
      applied: false,
      reason: 'A/B results are recommendations only; launched campaign allocation is not changed.',
    });
  }

  return recommendations;
}

/**
 * Get the variant assignment for the next send in a campaign.
 * Implements champion/challenger: 90% champion, 10% new challenger.
 */
export function assignVariant(campaignId, leadId, stepId) {
  if (leadId === null || leadId === undefined || stepId === null || stepId === undefined) {
    const error = new Error('leadId and stepId are required for a stable campaign sequence assignment.');
    error.statusCode = 400;
    throw error;
  }
  return selectCampaignStepVariant(campaignId, stepId, leadId);
}
// ══════════════════════════════════════════════════════════════
//  QUERY HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * Get all campaign stats with variant data for the UI.
 */
export function getAllCampaignStats() {
  const db = getDb();
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id').all();

  return campaigns.map(c => {
    const variantStats = getVariantStats(c.id);
    const sendStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN status = 'scheduled' THEN 1 END) as scheduled,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
        COUNT(CASE WHEN status = 'uncertain' THEN 1 END) as uncertain
      FROM sends WHERE campaign_id = ?
    `).get(c.id);
    const linkStats = db.prepare(`
      SELECT COALESCE(SUM(l.request_count),0) AS tracked_link_requests
      FROM campaign_click_links l JOIN sends s ON s.id=l.send_id
      WHERE s.campaign_id=?
    `).get(c.id);

    const storedStatus = c.status || 'draft';
    const status = ['paused', 'stopped', 'completed', 'archived'].includes(storedStatus)
      ? storedStatus
      : sendStats.scheduled > 0 || storedStatus === 'active'
        ? 'active'
        : sendStats.sent > 0 ? 'completed' : 'draft';

    return {
      ...c,
      ...sendStats,
      ...linkStats,
      ...variantStats,
      status,
    };
  });
}

/**
 * Get send performance over time for a campaign.
 */
export function getCampaignTimeline(campaignId, days = 14) {
  const db = getDb();
  const timeline = [];

  for (let i = days - 1; i >= 0; i--) {
    const dayStats = db.prepare(`
      SELECT
        COUNT(CASE WHEN e.event_type = 'sent' THEN 1 END) as sent,
        COUNT(CASE WHEN e.event_type = 'tracked_link_requested' THEN 1 END) as tracked_link_requests,
        COUNT(CASE WHEN e.event_type = 'replied' THEN 1 END) as replied,
        COUNT(CASE WHEN e.event_type IN ('hard_bounce','soft_bounce') THEN 1 END) as bounced
      FROM events e
      JOIN sends s ON e.send_id = s.id
      WHERE s.campaign_id = ?
      AND date(e.event_at) = date('now', '-${i} days')
    `).get(campaignId);

    timeline.push({
      date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
      ...dayStats,
    });
  }

  return timeline;
}
