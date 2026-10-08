// ============================================================
//  ODD-ECOSYS Pipeline — A/B Testing Framework (Phase 7)
//  Two-proportion z-test, fixed-horizon testing,
//  champion/challenger auto-promotion, variant tracking
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';

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
 * Get per-variant statistics for a campaign.
 */
export function getVariantStats(campaignId) {
  const db = getDb();
  const config = getConfig().ab_testing;

  // Get all variants used in this campaign
  const variantRows = db.prepare(`
    SELECT DISTINCT s.variant
    FROM sends s
    WHERE s.campaign_id = ? AND s.variant IS NOT NULL
    ORDER BY s.variant
  `).all(campaignId);

  if (variantRows.length === 0) return { variants: [], comparison: null };

  const variants = variantRows.map(vr => {
    const v = vr.variant;

    // Count sends and events per variant
    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT s.id) as sent,
        COUNT(CASE WHEN e.event_type = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN e.event_type = 'opened' THEN 1 END) as opened,
        COUNT(CASE WHEN e.event_type = 'clicked' THEN 1 END) as clicked,
        COUNT(CASE WHEN e.event_type = 'replied' THEN 1 END) as replied,
        COUNT(CASE WHEN e.event_type IN ('hard_bounce','soft_bounce') THEN 1 END) as bounced,
        COUNT(CASE WHEN e.event_type = 'spam_complaint' THEN 1 END) as complaints
      FROM sends s
      LEFT JOIN events e ON e.send_id = s.id
      WHERE s.campaign_id = ? AND s.variant = ? AND s.status = 'sent'
    `).get(campaignId, v);

    // Get positive replies (interested)
    const positiveCount = db.prepare(`
      SELECT COUNT(*) as c
      FROM events e
      JOIN sends s ON e.send_id = s.id
      WHERE s.campaign_id = ? AND s.variant = ?
      AND e.event_type = 'replied'
      AND (e.meta_json LIKE '%interested%' OR e.meta_json LIKE '%positive%')
    `).get(campaignId, v).c;

    // Daily breakdown (last 7 days)
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const dayCount = db.prepare(`
        SELECT COUNT(*) as c
        FROM events e
        JOIN sends s ON e.send_id = s.id
        WHERE s.campaign_id = ? AND s.variant = ?
        AND e.event_type = 'replied'
        AND e.event_at >= date('now', '-${i} days')
        AND e.event_at < date('now', '-${i - 1} days')
      `).get(campaignId, v).c;
      daily.push(dayCount);
    }

    const sent = stats.sent || 0;
    return {
      variant: v,
      sent,
      delivered: stats.delivered || 0,
      opened: stats.opened || 0,
      clicked: stats.clicked || 0,
      replied: stats.replied || 0,
      positive: positiveCount,
      bounced: stats.bounced || 0,
      complaints: stats.complaints || 0,
      daily,
      open_rate: sent > 0 ? ((stats.opened || 0) / sent) : 0,
      reply_rate: sent > 0 ? ((stats.replied || 0) / sent) : 0,
      positive_rate: sent > 0 ? (positiveCount / sent) : 0,
      sample_target: config.default_sample_size,
      sample_progress: Math.min(1, sent / config.default_sample_size),
    };
  });

  // Run z-test between variants (pairwise against first)
  const comparisons = [];
  const metric = config.primary_metric || 'replied'; // 'replied', 'opened', 'clicked'

  for (let i = 1; i < variants.length; i++) {
    const a = variants[0];
    const b = variants[i];
    const metricA = a[metric] || 0;
    const metricB = b[metric] || 0;

    const test = zTest(a.sent, metricA, b.sent, metricB);

    comparisons.push({
      variantA: a.variant,
      variantB: b.variant,
      metric,
      rateA: a.sent > 0 ? (metricA / a.sent) : 0,
      rateB: b.sent > 0 ? (metricB / b.sent) : 0,
      ...test,
      winner: test.significant
        ? (metricA / (a.sent || 1)) > (metricB / (b.sent || 1)) ? a.variant : b.variant
        : null,
    });
  }

  // Assign significance/winner status to each variant
  let declaredWinner = null;
  for (const comp of comparisons) {
    if (comp.winner) {
      declaredWinner = comp.winner;
      break;
    }
  }

  const enrichedVariants = variants.map(v => ({
    ...v,
    declared_winner: v.variant === declaredWinner,
    significance: comparisons.find(c => c.variantA === v.variant || c.variantB === v.variant)?.confidence || 0,
  }));

  return {
    variants: enrichedVariants,
    comparisons,
    winner: declaredWinner,
    metric: config.primary_metric,
    sample_size: config.default_sample_size,
    significance_threshold: config.significance_threshold,
  };
}

// ══════════════════════════════════════════════════════════════
//  CHAMPION / CHALLENGER AUTO-PROMOTE
// ══════════════════════════════════════════════════════════════

/**
 * Check all active campaigns and auto-promote winners.
 * When a winner is declared:
 * - Route 90% of volume to the winner
 * - Keep 10% going to a new challenger variant
 */
export function autoPromoteWinners() {
  const db = getDb();
  const campaigns = db.prepare('SELECT * FROM campaigns').all();
  const promoted = [];

  for (const campaign of campaigns) {
    const stats = getVariantStats(campaign.id);
    if (!stats.winner) continue;

    // Check if already promoted
    const existingMeta = db.prepare(`
      SELECT meta_json FROM events
      WHERE event_type = 'ab_winner_declared'
      AND meta_json LIKE ?
      ORDER BY event_at DESC LIMIT 1
    `).get(`%campaign_id":${campaign.id}%`);

    if (existingMeta) continue; // Already promoted

    // Record the promotion event
    db.prepare(`
      INSERT INTO events (lead_id, event_type, event_at, meta_json)
      VALUES (NULL, 'ab_winner_declared', datetime('now'), ?)
    `).run(JSON.stringify({
      campaign_id: campaign.id,
      winner: stats.winner,
      metric: stats.metric,
      confidence: stats.comparisons[0]?.confidence,
    }));

    promoted.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      winner: stats.winner,
      confidence: stats.comparisons[0]?.confidence,
    });

    console.log(`   🏆 Campaign "${campaign.name}" — Variant ${stats.winner} promoted as champion`);
  }

  return promoted;
}

/**
 * Get the variant assignment for the next send in a campaign.
 * Implements champion/challenger: 90% champion, 10% new challenger.
 */
export function assignVariant(campaignId) {
  const config = getConfig().ab_testing;
  const stats = getVariantStats(campaignId);

  if (stats.winner) {
    // Champion/challenger: 90% champion, 10% challenger
    const roll = Math.random() * 100;
    if (roll < (100 - config.challenger_pct)) {
      return stats.winner;
    }
    // Pick a non-winner variant as challenger
    const challengers = stats.variants.filter(v => !v.declared_winner);
    if (challengers.length > 0) {
      return challengers[Math.floor(Math.random() * challengers.length)].variant;
    }
    return stats.winner;
  }

  // No winner yet — even split
  if (stats.variants.length === 0) return 'A';
  const variantCounts = stats.variants.reduce((acc, v) => { acc[v.variant] = v.sent; return acc; }, {});
  const minSent = Math.min(...Object.values(variantCounts));
  const underRepresented = stats.variants.filter(v => v.sent === minSent);
  return underRepresented[Math.floor(Math.random() * underRepresented.length)].variant;
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
        COUNT(CASE WHEN status = 'scheduled' THEN 1 END) as scheduled
      FROM sends WHERE campaign_id = ?
    `).get(c.id);

    return {
      ...c,
      ...sendStats,
      ...variantStats,
      status: sendStats.scheduled > 0 ? 'active' : sendStats.sent > 0 ? 'completed' : 'draft',
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
        COUNT(CASE WHEN e.event_type = 'opened' THEN 1 END) as opened,
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
