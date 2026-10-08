// ============================================================
//  ODD-ECOSYS Pipeline — Qualification Engine (v3)
//  Technical site checks → scoring → classification
//
//  Terminal site_status values:
//    NO_SITE | DEAD_SITE | DOMAIN_PARKED | OUTDATED | MODERN | CHECK_FAILED
//
//  Features: SPA detection, parking detection, circuit breaker,
//  domain-level caching, resumability, batch cancellation,
//  confidence scoring, SSRF-safe fetches
// ============================================================

let cheerioModule = null;
async function ensureCheerio() {
  if (!cheerioModule) cheerioModule = await import('cheerio');
  return cheerioModule;
}
function parseHtml(html) {
  if (!cheerioModule) throw new Error('cheerio not loaded; await ensureCheerio() before parsing HTML');
  return cheerioModule.load(html);
}
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';
import { safeFetch } from './ssrf-guard.js';
import { captureScreenshot } from './screenshot.js';
import { normalizeDomain } from './dedup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load config files ────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'qualification-scoring.json');
const PARKING_PATH = path.join(__dirname, '..', 'config', 'parking-signatures.json');

let _config = null;
let _parking = null;

function getConfig() {
  if (!_config) {
    _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return _config;
}

function getParkingSignatures() {
  if (!_parking) {
    _parking = JSON.parse(fs.readFileSync(PARKING_PATH, 'utf-8'));
  }
  return _parking;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Qualification state (per-run) ────────────────────────────
let _runState = {
  active: false,
  batchId: null,
  processed: 0,
  total: 0,
  currentLead: null,
  cancelling: false,
  startedAt: null,
  domainCache: new Map(),      // normalized_domain → result
  circuitBreakers: new Map(),  // normalized_domain → failure count
};

export function getQualificationStatus() {
  return { ..._runState, domainCache: undefined, circuitBreakers: undefined };
}

// ══════════════════════════════════════════════════════════════
//  QUALIFY A SINGLE LEAD
// ══════════════════════════════════════════════════════════════

/**
 * Run all qualification checks on a single lead.
 * @param {object} lead - Lead object from DB
 * @returns {Promise<object>} Qualification result
 */
export async function qualifyLead(lead) {
  await ensureCheerio();
  const config = getConfig();

  // ── No website URL → NO_SITE immediately ────────────────
  if (!lead.website_url) {
    const fbActive = await checkFacebookLiveness(lead.facebook_url);
    return {
      site_status: 'NO_SITE',
      site_score: null,
      site_reasons: ['no_website_url'],
      confidence: 100,
      signals: {},
      fb_active: fbActive,
      screenshot_path: null,
    };
  }

  // ── Normalize URL ───────────────────────────────────────
  let url = lead.website_url.trim();
  if (!url.startsWith('http')) url = `https://${url}`;

  const config_timeout = config.fetch_timeout_ms || 10000;

  // ── Check domain-level cache ────────────────────────────
  const domain = normalizeDomain(lead.website_url);
  if (domain && _runState.domainCache.has(domain)) {
    const cached = _runState.domainCache.get(domain);
    const fbActive = await checkFacebookLiveness(lead.facebook_url);
    return { ...cached, fb_active: fbActive, _cached: true };
  }

  // ── Circuit breaker check ──────────────────────────────
  if (domain && (_runState.circuitBreakers.get(domain) || 0) >= (config.circuit_breaker_max_failures || 3)) {
    return {
      site_status: 'CHECK_FAILED',
      site_score: null,
      site_reasons: ['circuit_open'],
      confidence: 0,
      signals: {},
      fb_active: await checkFacebookLiveness(lead.facebook_url),
      screenshot_path: null,
    };
  }

  // ── Fetch the page ─────────────────────────────────────
  let response, html, finalUrl, fetchError;
  const signals = {};
  const reasons = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config_timeout);

    response = await safeFetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);
    finalUrl = response.url;
    html = await response.text();

  } catch (error) {
    fetchError = error.message;

    // Track circuit breaker failures
    if (domain) {
      const current = _runState.circuitBreakers.get(domain) || 0;
      _runState.circuitBreakers.set(domain, current + 1);
    }

    // Try HTTP fallback if HTTPS failed
    if (url.startsWith('https://')) {
      try {
        const httpUrl = url.replace('https://', 'http://');
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), config_timeout);

        response = await safeFetch(httpUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
          signal: controller2.signal,
          redirect: 'follow',
        });

        clearTimeout(timeout2);
        finalUrl = response.url;
        html = await response.text();
        fetchError = null;
        signals.https_redirect = false;
        reasons.push('no_https');
      } catch {
        // Both HTTP and HTTPS failed
      }
    }
  }

  // ── Total fetch failure → DEAD_SITE or CHECK_FAILED ────
  if (fetchError || !response) {
    const fbActive = await checkFacebookLiveness(lead.facebook_url);
    const result = {
      site_status: fetchError?.includes('SSRF') ? 'CHECK_FAILED' : 'DEAD_SITE',
      site_score: null,
      site_reasons: [fetchError?.includes('SSRF') ? 'ssrf_blocked' : 'fetch_failed', fetchError || 'no_response'],
      confidence: 0,
      signals: {},
      fb_active: fbActive,
      screenshot_path: null,
    };
    if (domain) _runState.domainCache.set(domain, result);
    return result;
  }

  // ── Non-200 status → DEAD_SITE ────────────────────────
  if (!response.ok) {
    const fbActive = await checkFacebookLiveness(lead.facebook_url);
    const result = {
      site_status: 'DEAD_SITE',
      site_score: null,
      site_reasons: [`http_${response.status}`],
      confidence: 80,
      signals: { http_status: response.status },
      fb_active: fbActive,
      screenshot_path: null,
    };
    if (domain) _runState.domainCache.set(domain, result);
    return result;
  }

  // ── Domain parking detection ───────────────────────────
  const parkingResult = detectDomainParking(html, url, finalUrl, domain);
  if (parkingResult.isParked) {
    const fbActive = await checkFacebookLiveness(lead.facebook_url);
    const result = {
      site_status: 'DOMAIN_PARKED',
      site_score: null,
      site_reasons: ['domain_parked', ...parkingResult.evidence],
      confidence: 90,
      signals: { parking_provider: parkingResult.provider || null },
      fb_active: fbActive,
      screenshot_path: null,
    };
    if (domain) _runState.domainCache.set(domain, result);
    return result;
  }

  // ── Parse HTML with cheerio ────────────────────────────
  const $ = parseHtml(html);

  // ── SPA detection ─────────────────────────────────────
  $('script, style, noscript').remove();
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  const $fullHtml = parseHtml(html); // re-parse to check scripts

  if (visibleText.length < (config.spa_text_threshold || 200)) {
    const hasBundler = detectSpaSignals($fullHtml);
    if (hasBundler) {
      reasons.push('needs_js_render');
      // Without Playwright, we can't score properly — mark CHECK_FAILED
      const fbActive = await checkFacebookLiveness(lead.facebook_url);
      const result = {
        site_status: 'CHECK_FAILED',
        site_score: null,
        site_reasons: ['needs_js_render', 'spa_detected'],
        confidence: 30,
        signals: { spa_detected: true, visible_text_length: visibleText.length },
        fb_active: fbActive,
        screenshot_path: null,
      };
      if (domain) _runState.domainCache.set(domain, result);
      return result;
    }
  }

  // ── Run all technical signal checks ────────────────────
  const fullHtml = html;

  // SSL
  signals.ssl_valid = finalUrl?.startsWith('https://') || false;
  if (!signals.ssl_valid) reasons.push('no_ssl');

  // HTTPS redirect
  if (signals.https_redirect === undefined) {
    signals.https_redirect = signals.ssl_valid;
  }

  // Viewport meta (mobile-ready)
  signals.viewport_meta = !!$fullHtml('meta[name="viewport"]').length;
  if (!signals.viewport_meta) reasons.push('no_viewport_meta');

  // Copyright year
  const copyrightYear = extractCopyrightYear(fullHtml, visibleText);
  signals.copyright_year = copyrightYear;
  const currentYear = new Date().getFullYear();
  const recentWithin = config.copyright_year_recent_within || 2;
  signals.copyright_recent = copyrightYear ? (currentYear - copyrightYear <= recentWithin) : false;
  if (copyrightYear && !signals.copyright_recent) {
    reasons.push(`copyright_${copyrightYear}`);
  }

  // Last-Modified header
  const lastModified = response.headers.get('last-modified');
  if (lastModified) {
    const modDate = new Date(lastModified);
    const ageDays = (Date.now() - modDate.getTime()) / 86400000;
    signals.last_modified = lastModified;
    signals.last_modified_recent = ageDays < (config.last_modified_recent_days || 365);
    if (!signals.last_modified_recent) reasons.push('stale_last_modified');
  } else {
    signals.last_modified = null;
    signals.last_modified_recent = null;
  }

  // Analytics/tracking
  signals.has_analytics = detectAnalytics(fullHtml);
  if (!signals.has_analytics) reasons.push('no_analytics');

  // CMS detection
  const cms = detectCms(fullHtml);
  signals.modern_cms = cms.isModern;
  signals.cms_name = cms.name;
  if (cms.name) reasons.push(`cms:${cms.name}`);

  // Responsive images
  signals.responsive_images = !!($fullHtml('img[srcset], picture source').length > 0);

  // Structured data
  signals.structured_data = !!(
    $fullHtml('script[type="application/ld+json"]').length > 0 ||
    $fullHtml('[itemscope]').length > 0
  );

  // Social links
  const socialCount = $fullHtml('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="instagram.com"], a[href*="linkedin.com"], a[href*="youtube.com"]').length;
  signals.social_links = socialCount >= 2;

  // Custom domain email (mailto with matching domain)
  const mailtoLinks = [];
  $fullHtml('a[href^="mailto:"]').each((_, el) => {
    mailtoLinks.push($fullHtml(el).attr('href')?.replace('mailto:', '').split('?')[0]);
  });
  signals.custom_domain_email = mailtoLinks.some(e => e && domain && e.includes(domain));

  // Fast load (approximate from content length)
  const contentLength = parseInt(response.headers.get('content-length') || '0');
  signals.fast_load = contentLength > 0 ? contentLength < 2000000 : true; // < 2MB

  // ── Compute site score ────────────────────────────────
  const weights = config.signal_weights;
  let score = 0;
  let maxScore = 0;
  let unresolvedCount = 0;

  for (const [signal, weight] of Object.entries(weights)) {
    maxScore += weight;
    if (signals[signal] === true) {
      score += weight;
    } else if (signals[signal] === null || signals[signal] === undefined) {
      unresolvedCount++;
    }
  }

  // Normalize to 0-100
  const normalizedScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  signals._raw_score = score;
  signals._max_score = maxScore;

  // ── Classify site_status ──────────────────────────────
  let siteStatus;
  if (normalizedScore >= config.thresholds.modern_min) {
    siteStatus = 'MODERN';
    reasons.push('modern_site');
  } else if (normalizedScore < config.thresholds.outdated_max) {
    siteStatus = 'OUTDATED';
    reasons.push('low_score');
  } else {
    siteStatus = 'OUTDATED';
    reasons.push('marginal_score');
  }

  // ── Compute confidence score ──────────────────────────
  let confidence = 100;
  const penalties = config.confidence_penalties;

  if (!signals.ssl_valid && signals.ssl_valid !== undefined) {
    // SSL check completed but invalid — that's data, not a penalty
  }
  // Penalty for unresolved signals
  confidence -= unresolvedCount * (penalties.unresolved_signal || 10);

  // Penalty for score near threshold boundary
  const distToOutdated = Math.abs(normalizedScore - config.thresholds.outdated_max);
  const distToModern = Math.abs(normalizedScore - config.thresholds.modern_min);
  if (distToOutdated <= (penalties.threshold_proximity || 5) || distToModern <= (penalties.threshold_proximity || 5)) {
    confidence -= penalties.near_threshold || 25;
  }

  confidence = Math.max(0, Math.min(100, confidence));

  // ── Facebook liveness ─────────────────────────────────
  const fbActive = await checkFacebookLiveness(lead.facebook_url);

  // ── Screenshot ────────────────────────────────────────
  let screenshotPath = null;
  try {
    screenshotPath = await captureScreenshot(lead);
  } catch {
    // Non-critical
  }

  // ── Cache result ──────────────────────────────────────
  const result = {
    site_status: siteStatus,
    site_score: normalizedScore,
    site_reasons: reasons,
    confidence,
    signals,
    fb_active: fbActive,
    screenshot_path: screenshotPath,
  };

  if (domain) _runState.domainCache.set(domain, result);

  return result;
}


// ══════════════════════════════════════════════════════════════
//  QUALIFY A BATCH
// ══════════════════════════════════════════════════════════════

/**
 * Run qualification on all discovered leads in a batch.
 * @param {number} batchId
 * @param {object} [options]
 * @param {number} [options.concurrency=5]
 * @param {boolean} [options.dryRun=false]
 * @param {Function} [options.onProgress]
 * @returns {Promise<object>} Batch qualification summary
 */
export async function qualifyBatch(batchId, options = {}) {
  const config = getConfig();
  const { concurrency = config.concurrency || 5, dryRun = false, onProgress } = options;
  const db = getDb();

  // Get leads to qualify
  const leads = db.prepare(`
    SELECT * FROM leads
    WHERE batch_id = ? AND (status = 'discovered' OR status = 'checking')
    ORDER BY id
  `).all(batchId);

  if (leads.length === 0) {
    console.log(`\n⚠️  No leads to qualify in batch #${batchId}\n`);
    return { batchId, processed: 0, results: {} };
  }

  // Reset run state
  _runState = {
    active: true,
    batchId,
    processed: 0,
    total: leads.length,
    currentLead: null,
    cancelling: false,
    startedAt: new Date().toISOString(),
    domainCache: new Map(),
    circuitBreakers: new Map(),
  };

  console.log('\n' + '═'.repeat(60));
  console.log('  🔍 Qualification Pipeline — Stage 4');
  console.log('═'.repeat(60));
  console.log(`  Batch:       #${batchId}`);
  console.log(`  Leads:       ${leads.length}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Dry run:     ${dryRun}`);
  console.log('═'.repeat(60) + '\n');

  const statusCounts = {
    NO_SITE: 0, DEAD_SITE: 0, DOMAIN_PARKED: 0,
    OUTDATED: 0, MODERN: 0, CHECK_FAILED: 0,
  };
  let disqualifiedCount = 0;

  // Prepared statements
  const updateLead = db.prepare(`
    UPDATE leads SET
      status = ?, site_status = ?, site_score = ?, site_reasons = ?,
      fb_active = ?, screenshot_path = ?, confidence = ?,
      site_reasons_json = ?, site_checked_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const setChecking = db.prepare(`
    UPDATE leads SET status = 'checking', updated_at = datetime('now') WHERE id = ?
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (lead_id, event_type, event_at, meta_json)
    VALUES (?, 'site_check', datetime('now'), ?)
  `);

  // Process in chunks
  for (let i = 0; i < leads.length; i += concurrency) {
    // Check for cancellation
    if (_runState.cancelling) {
      console.log('\n⏹  Qualification cancelled. Finalizing...\n');
      break;
    }

    const chunk = leads.slice(i, i + concurrency);

    // Mark as checking
    if (!dryRun) {
      for (const lead of chunk) {
        setChecking.run(lead.id);
      }
    }

    // Process chunk concurrently
    const results = await Promise.allSettled(
      chunk.map(async (lead) => {
        _runState.currentLead = lead.business_name;
        return { lead, result: await qualifyLead(lead) };
      })
    );

    // Write results
    for (const outcome of results) {
      if (outcome.status === 'rejected') {
        console.log(`   ❌ Failed: ${outcome.reason?.message}`);
        continue;
      }

      const { lead, result } = outcome.value;
      statusCounts[result.site_status] = (statusCounts[result.site_status] || 0) + 1;

      // Determine new lead status
      let newStatus = 'site_checked';
      if (result.site_status === 'MODERN') {
        newStatus = 'disqualified';
        disqualifiedCount++;
      }

      if (!dryRun) {
        updateLead.run(
          newStatus,
          result.site_status,
          result.site_score,
          result.site_reasons.join(', '),
          result.fb_active,
          result.screenshot_path,
          result.confidence,
          JSON.stringify({ signals: result.signals, reasons: result.site_reasons }),
          lead.id
        );

        insertEvent.run(lead.id, JSON.stringify({
          site_status: result.site_status,
          site_score: result.site_score,
          confidence: result.confidence,
        }));
      }
    }

    _runState.processed = Math.min(i + concurrency, leads.length);

    if (onProgress) {
      onProgress(_runState.processed, leads.length, statusCounts);
    }

    const pct = Math.round((_runState.processed / leads.length) * 100);
    console.log(`   [${pct}%] ${_runState.processed}/${leads.length} — ${Object.entries(statusCounts).filter(([,v]) => v > 0).map(([k,v]) => `${k}:${v}`).join(' ')}`);
  }

  // Finalize
  _runState.active = false;
  _runState.currentLead = null;

  const summary = {
    batchId,
    processed: _runState.processed,
    total: leads.length,
    cancelled: _runState.cancelling,
    statusCounts,
    disqualified: disqualifiedCount,
    cacheHits: [..._runState.domainCache.entries()].length,
    duration: Date.now() - new Date(_runState.startedAt).getTime(),
  };

  console.log('\n' + '═'.repeat(60));
  console.log('  ✅ Qualification Complete');
  console.log('═'.repeat(60));
  console.log(`  Processed: ${summary.processed}/${summary.total}`);
  Object.entries(statusCounts).forEach(([status, count]) => {
    if (count > 0) console.log(`  ${status}: ${count}`);
  });
  console.log(`  Disqualified (MODERN): ${disqualifiedCount}`);
  console.log(`  Cache hits: ${summary.cacheHits} domains`);
  console.log(`  Duration: ${(summary.duration / 1000).toFixed(1)}s`);
  if (summary.cancelled) console.log('  ⚠️  Run was cancelled');
  console.log('═'.repeat(60) + '\n');

  return summary;
}

/**
 * Cancel a running qualification batch.
 */
export function cancelQualification() {
  if (_runState.active) {
    _runState.cancelling = true;
    return true;
  }
  return false;
}

/**
 * Re-qualify a single lead by ID.
 */
export async function requalifyLead(leadId) {
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`Lead #${leadId} not found`);

  const result = await qualifyLead(lead);

  let newStatus = 'site_checked';
  if (result.site_status === 'MODERN') newStatus = 'disqualified';

  db.prepare(`
    UPDATE leads SET
      status = ?, site_status = ?, site_score = ?, site_reasons = ?,
      fb_active = ?, screenshot_path = ?, confidence = ?,
      site_reasons_json = ?, site_checked_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    newStatus, result.site_status, result.site_score,
    result.site_reasons.join(', '), result.fb_active,
    result.screenshot_path, result.confidence,
    JSON.stringify({ signals: result.signals, reasons: result.site_reasons }),
    leadId
  );

  return result;
}


// ══════════════════════════════════════════════════════════════
//  FRESHNESS RECHECK
// ══════════════════════════════════════════════════════════════

/**
 * Get leads that need re-qualification (stale results).
 * @param {number} [windowDays=60]
 * @returns {object[]}
 */
export function getStaleLeads(windowDays) {
  const config = getConfig();
  const days = windowDays || config.freshness_window_days || 60;
  const db = getDb();

  return db.prepare(`
    SELECT * FROM leads
    WHERE site_checked_at IS NOT NULL
      AND site_checked_at < datetime('now', ?)
      AND status NOT IN ('disqualified', 'won', 'lost')
  `).all(`-${days} days`);
}

/**
 * Requeue stale leads back to 'discovered' for re-qualification.
 */
export function requeueStaleLeads(windowDays) {
  const stale = getStaleLeads(windowDays);
  if (stale.length === 0) return { requeued: 0 };

  const db = getDb();
  const update = db.prepare(`
    UPDATE leads SET status = 'discovered', updated_at = datetime('now') WHERE id = ?
  `);

  const requeue = db.transaction(() => {
    for (const lead of stale) {
      update.run(lead.id);
    }
  });

  requeue();
  console.log(`🔄 Requeued ${stale.length} stale leads for re-qualification`);
  return { requeued: stale.length };
}


// ══════════════════════════════════════════════════════════════
//  RESUMABILITY — startup recovery
// ══════════════════════════════════════════════════════════════

/**
 * Reset leads stuck in 'checking' status (from a crash).
 * Call on server startup.
 */
export function recoverStuckLeads() {
  const config = getConfig();
  const minutes = config.checking_stuck_minutes || 15;
  const db = getDb();

  const stuck = db.prepare(`
    SELECT COUNT(*) as count FROM leads
    WHERE status = 'checking'
      AND updated_at < datetime('now', ?)
  `).get(`-${minutes} minutes`);

  if (stuck.count > 0) {
    db.prepare(`
      UPDATE leads SET status = 'discovered', updated_at = datetime('now')
      WHERE status = 'checking'
        AND updated_at < datetime('now', ?)
    `).run(`-${minutes} minutes`);

    console.log(`🔄 Recovered ${stuck.count} leads stuck in 'checking' status`);
  }

  return stuck.count;
}


// ══════════════════════════════════════════════════════════════
//  QUALIFICATION RESULTS QUERY
// ══════════════════════════════════════════════════════════════

/**
 * Get qualification results for a batch.
 */
export function getQualificationResults(batchId, options = {}) {
  const { siteStatus, limit = 100, offset = 0 } = options;
  const db = getDb();

  let query = `
    SELECT * FROM leads
    WHERE batch_id = ? AND site_status IS NOT NULL
  `;
  const params = [batchId];

  if (siteStatus) {
    query += ' AND site_status = ?';
    params.push(siteStatus);
  }

  // Count
  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
  const total = db.prepare(countQuery).get(...params).count;

  query += ' ORDER BY confidence ASC, id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = db.prepare(query).all(...params);

  return { results, total, limit, offset };
}

/**
 * Get site status distribution for a batch.
 */
export function getSiteStatusDistribution(batchId) {
  const db = getDb();
  let query = `
    SELECT site_status, COUNT(*) as count
    FROM leads WHERE site_status IS NOT NULL
  `;
  const params = [];

  if (batchId) {
    query += ' AND batch_id = ?';
    params.push(batchId);
  }

  query += ' GROUP BY site_status ORDER BY count DESC';
  return db.prepare(query).all(...params);
}

/**
 * Get the lowest-confidence leads for spot-checking.
 */
export function getSpotCheckLeads(batchId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM leads
    WHERE batch_id = ? AND site_status IS NOT NULL AND confidence IS NOT NULL
    ORDER BY confidence ASC
    LIMIT ?
  `).all(batchId, limit);
}


// ══════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Check if a Facebook URL is still accessible.
 */
async function checkFacebookLiveness(facebookUrl) {
  if (!facebookUrl) return null;

  let url = facebookUrl.trim();
  if (!url.startsWith('http')) {
    if (url.startsWith('fb.com/')) url = `https://www.facebook.com/${url.slice(7)}`;
    else url = `https://${url}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    // Facebook returns 200 for existing pages, 404 for removed ones
    // but redirects to login for private pages (still "active")
    return response.ok || response.status === 302 ? 1 : 0;
  } catch {
    return null; // Couldn't determine — network error
  }
}

/**
 * Detect if a page is a parked domain.
 */
function detectDomainParking(html, originalUrl, finalUrl, originalDomain) {
  const parking = getParkingSignatures();
  const evidence = [];
  let provider = null;

  // Check redirect to different domain (parking provider)
  if (finalUrl && originalDomain) {
    try {
      const finalHostname = new URL(finalUrl).hostname.replace(/^www\./, '');
      if (finalHostname !== originalDomain && finalHostname !== `www.${originalDomain}`) {
        // Check if redirected to a known parking provider
        for (const [name, markers] of Object.entries(parking.provider_fingerprints)) {
          if (markers.some(m => finalHostname.includes(m) || finalUrl.includes(m))) {
            evidence.push(`redirect_to_${name}`);
            provider = name;
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Check HTML content against parking phrases
  const lowerHtml = html.toLowerCase();
  for (const phrase of parking.phrases) {
    if (lowerHtml.includes(phrase.toLowerCase())) {
      evidence.push(`phrase:${phrase.slice(0, 40)}`);
      break; // One phrase match is enough
    }
  }

  // Check HTML markers
  for (const marker of parking.html_markers) {
    if (lowerHtml.includes(marker.toLowerCase())) {
      evidence.push(`marker:${marker}`);
      break;
    }
  }

  // Check provider fingerprints in HTML
  if (!provider) {
    for (const [name, markers] of Object.entries(parking.provider_fingerprints)) {
      if (markers.some(m => lowerHtml.includes(m.toLowerCase()))) {
        evidence.push(`provider:${name}`);
        provider = name;
        break;
      }
    }
  }

  return {
    isParked: evidence.length >= 1,
    evidence,
    provider,
  };
}

/**
 * Detect SPA/JS-rendered site signals.
 */
function detectSpaSignals($) {
  // Root container divs typical of SPAs
  const hasRootDiv = !!(
    $('div#root').length || $('div#app').length || $('div#__next').length ||
    $('div#__nuxt').length || $('div[data-reactroot]').length
  );

  // Bundled script tags
  const scripts = [];
  $('script[src]').each((_, el) => {
    scripts.push($(el).attr('src') || '');
  });

  const hasBundledScript = scripts.some(src =>
    /\.[a-f0-9]{6,}\.(js|mjs)/.test(src) || // hashed filenames
    src.includes('bundle.') ||
    src.includes('chunk.') ||
    src.includes('_app.')
  );

  const hasModuleScript = $('script[type="module"]').length > 0;

  return hasRootDiv && (hasBundledScript || hasModuleScript);
}

/**
 * Extract copyright year from HTML/text content.
 */
function extractCopyrightYear(html, text) {
  // Match patterns like "© 2024", "Copyright 2023", "©2022"
  const patterns = [
    /©\s*(\d{4})/,
    /copyright\s*(?:©\s*)?(\d{4})/i,
    /(\d{4})\s*©/,
    /©\s*\d{4}\s*[-–]\s*(\d{4})/,  // © 2020-2024 → use end year
    /copyright\s*\d{4}\s*[-–]\s*(\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = (text || html).match(pattern);
    if (match) {
      const year = parseInt(match[1]);
      if (year >= 2000 && year <= new Date().getFullYear() + 1) {
        return year;
      }
    }
  }

  return null;
}

/**
 * Detect analytics/tracking scripts.
 */
function detectAnalytics(html) {
  const analyticsPatterns = [
    'google-analytics.com', 'googletagmanager.com', 'gtag(',
    'ga.js', 'analytics.js', 'gtm.js',
    'facebook.com/tr', 'fbq(', 'connect.facebook.net',
    'hotjar.com', 'clarity.ms', 'plausible.io',
    'matomo', 'piwik', 'segment.com',
  ];

  const lower = html.toLowerCase();
  return analyticsPatterns.some(p => lower.includes(p));
}

/**
 * Detect CMS/platform from HTML.
 */
function detectCms(html) {
  const lower = html.toLowerCase();
  const cmsList = [
    { name: 'wordpress', patterns: ['wp-content/', 'wp-includes/', 'wordpress'], isModern: false },
    { name: 'wix', patterns: ['wix.com', 'wixstatic.com', '_wix_browser_sess'], isModern: true },
    { name: 'squarespace', patterns: ['squarespace.com', 'sqsp.net', 'squarespace-cdn'], isModern: true },
    { name: 'shopify', patterns: ['shopify.com', 'cdn.shopify', 'myshopify.com'], isModern: true },
    { name: 'webflow', patterns: ['webflow.com', 'webflow.js', 'wf-page'], isModern: true },
    { name: 'godaddy_builder', patterns: ['godaddy.com/website-builder', 'wsimg.com'], isModern: false },
    { name: 'weebly', patterns: ['weebly.com', 'editmysite.com'], isModern: false },
    { name: 'gatsby', patterns: ['gatsby-', '__gatsby'], isModern: true },
    { name: 'nextjs', patterns: ['__next', '_next/static', 'nextjs'], isModern: true },
    { name: 'react', patterns: ['react-dom', 'data-reactroot', 'react.production'], isModern: true },
  ];

  for (const cms of cmsList) {
    if (cms.patterns.some(p => lower.includes(p))) {
      return { name: cms.name, isModern: cms.isModern };
    }
  }

  return { name: null, isModern: false };
}
