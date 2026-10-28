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
import { captureScreenshot, getRenderedPage, getScreenshotPath } from './screenshot.js';
import { normalizeDomain } from './dedup.js';
import { getQualificationScoringManager, scoreQualificationSignals } from './qualification-scoring.js';

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
  jobId: null,
  batchId: null,
  processed: 0,
  total: 0,
  failedCount: 0,
  currentLead: null,
  cancelling: false,
  startedAt: null,
  domainCache: new Map(),      // normalized_domain → result
  circuitBreakers: new Map(),  // normalized_domain → failure count
};
let _singleLeadAuditActive = false;

const ACTIVE_QUALIFICATION_JOB_STATUSES = ['queued', 'running', 'cancel_requested'];

function parseJson(value, fallback) {
  try { const parsed = JSON.parse(value); return parsed ?? fallback; } catch { return fallback; }
}

export function getQualificationStatus(batchIdValue = null) {
  const db = getDb();
  const batchId = batchIdValue === null || batchIdValue === undefined || batchIdValue === '' ? null : Number(batchIdValue);
  if (batchId !== null && (!Number.isSafeInteger(batchId) || batchId < 1)) throw qualificationError('Batch ID is invalid.');
  const placeholders = ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',');
  const activeJob = db.prepare(`SELECT * FROM qualification_jobs WHERE status IN (${placeholders}) ORDER BY id DESC LIMIT 1`)
    .get(...ACTIVE_QUALIFICATION_JOB_STATUSES);
  const job = activeJob || (batchId !== null
    ? db.prepare('SELECT * FROM qualification_jobs WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(batchId)
    : db.prepare('SELECT * FROM qualification_jobs ORDER BY id DESC LIMIT 1').get());
  if (!job) return {
    ..._runState, jobId: null, batchId, status: null, active: false,
    retryableCount: batchId !== null ? (db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='discovered'").get(batchId)?.count || 0) : 0,
    currentLeadIds: [], statusCounts: {}, errorCode: null, errorMessage: null,
    domainCache: undefined, circuitBreakers: undefined,
  };

  const currentLeadIds = parseJson(job.current_lead_ids_json, []);
  const currentLeadsById = Array.isArray(currentLeadIds) && currentLeadIds.length
    ? new Map(db.prepare(`SELECT id,business_name FROM leads WHERE id IN (${currentLeadIds.map(() => '?').join(',')})`).all(...currentLeadIds).map(lead => [lead.id, lead]))
    : new Map();
  const currentLeads = Array.isArray(currentLeadIds) ? currentLeadIds.map(id => currentLeadsById.get(id)).filter(Boolean) : [];
  const retryableCount = db.prepare("SELECT COUNT(*) AS count FROM leads WHERE batch_id=? AND status='discovered'")
    .get(job.batch_id)?.count || 0;
  return {
    jobId: job.id,
    batchId: job.batch_id,
    status: job.status,
    active: ACTIVE_QUALIFICATION_JOB_STATUSES.includes(job.status),
    cancelling: job.status === 'cancel_requested',
    processed: job.processed,
    total: job.total,
    failedCount: job.failed_count,
    retryableCount,
    currentLeadIds: Array.isArray(currentLeadIds) ? currentLeadIds : [],
    currentLeads: currentLeads.map(lead => ({ id: lead.id, name: lead.business_name })),
    currentLead: currentLeads[0]?.business_name || null,
    statusCounts: parseJson(job.status_counts_json, {}),
    scoringVersion: job.scoring_profile_version,
    scoringConfigHash: job.scoring_profile_hash,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    cancelRequestedAt: job.cancel_requested_at,
    completedAt: job.completed_at,
    errorCode: job.error_code,
    errorMessage: job.error_message,
  };
}

// ══════════════════════════════════════════════════════════════
//  QUALIFY A SINGLE LEAD
// ══════════════════════════════════════════════════════════════

async function captureFacebookEvidence(checkFacebook, facebookUrl) {
  if (!facebookUrl) return { value: null, reason: null };
  try {
    const result = await checkFacebook(facebookUrl);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const value = result.value === 1 || result.value === 0 ? result.value : null;
      return { value, reason: value === null ? String(result.reason || 'facebook_check_unknown').slice(0, 120) : null };
    }
    if (result === 1 || result === 0) return { value: result, reason: null };
    return { value: null, reason: 'facebook_check_unknown' };
  } catch {
    return { value: null, reason: 'facebook_check_unavailable' };
  }
}

function withFacebookEvidence(result, facebook, facebookUrl) {
  const signals = { ...(result.signals || {}), facebook_access: !facebookUrl ? null : facebook.value === 1 ? 'reachable' : facebook.value === 0 ? 'unreachable' : 'unknown' };
  const reasons = (result.site_reasons || []).filter(reason => !String(reason).startsWith('facebook_check_unknown:'));
  if (facebook.reason) {
    signals.facebook_check_reason = facebook.reason;
    reasons.push(`facebook_check_unknown:${facebook.reason}`);
  } else {
    delete signals.facebook_check_reason;
  }
  return { ...result, signals, site_reasons: reasons, fb_active: facebook.value };
}

/**
 * Run all qualification checks on a single lead.
 * @param {object} lead - Lead object from DB
 * @returns {Promise<object>} Qualification result
 */
export async function qualifyLead(lead, {
  scoringProfile,
  fetchPage = safeFetch,
  checkFacebook = checkFacebookLiveness,
  takeScreenshot = captureScreenshot,
} = {}) {
  await ensureCheerio();
  const config = getConfig();
  const profile = scoringProfile || getQualificationScoringManager(getDb()).getProfile();
  const scoring = { version: profile.version, configHash: profile.configHash, applicable: false };
  const scoringConfig = profile.config;

  // ── No website URL → NO_SITE immediately ────────────────
  if (!lead.website_url) {
    const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
    return withFacebookEvidence({
      site_status: 'NO_SITE',
      site_score: null,
      site_reasons: ['no_website_url'],
      confidence: 100,
      signals: {},
      scoring,
      screenshot_path: null,
    }, facebook, lead.facebook_url);
  }

  // ── Normalize URL ───────────────────────────────────────
  let url = lead.website_url.trim();
  if (!url.startsWith('http')) url = `https://${url}`;

  const config_timeout = config.fetch_timeout_ms || 10000;

  // ── Check domain-level cache ────────────────────────────
  const domain = normalizeDomain(lead.website_url);
  const cacheKey = domain ? `${domain}|${profile.configHash}` : null;
  if (cacheKey && _runState.domainCache.has(cacheKey)) {
    const cached = _runState.domainCache.get(cacheKey);
    const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
    return { ...withFacebookEvidence(cached, facebook, lead.facebook_url), _cached: true };
  }

  // ── Circuit breaker check ──────────────────────────────
  if (domain && (_runState.circuitBreakers.get(domain) || 0) >= (config.circuit_breaker_max_failures || 3)) {
    const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
    return withFacebookEvidence({
      site_status: 'CHECK_FAILED',
      site_score: null,
      site_reasons: ['circuit_open'],
      confidence: 0,
      signals: {},
      scoring,
      screenshot_path: null,
    }, facebook, lead.facebook_url);
  }

  // ── Fetch the page ─────────────────────────────────────
  let response, html, finalUrl, fetchError;
  const signals = {};
  const reasons = [];

  try {
    response = await fetchPage(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      timeoutMs: config_timeout,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 4,
    });

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
        response = await fetchPage(httpUrl, {
          headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
          redirect: 'follow',
          timeoutMs: config_timeout,
          maxBytes: 2 * 1024 * 1024,
          maxRedirects: 4,
        });

        finalUrl = response.url;
        html = await response.text();
        fetchError = null;
        signals.https_redirect = false;
        signals.ssl_check_failed = true;
        reasons.push('no_https');
      } catch {
        // Both HTTP and HTTPS failed
      }
    }
  }

  // ── Fetch failure is inconclusive, not proof that a site is dead ────
  if (fetchError || !response) {
    const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
    const result = withFacebookEvidence({
      site_status: 'CHECK_FAILED',
      site_score: null,
      site_reasons: [fetchError?.includes('SSRF') ? 'ssrf_blocked' : 'site_fetch_unknown', fetchError || 'no_response'],
      confidence: 0,
      signals: {},
      scoring,
      screenshot_path: null,
    }, facebook, lead.facebook_url);
    if (cacheKey) _runState.domainCache.set(cacheKey, result);
    return result;
  }

  // ── Only explicit not-found statuses prove the requested page is missing ──
  if (!response.ok) {
    const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
    const confirmedMissing = response.status === 404 || response.status === 410;
    const accessRestricted = [401, 403, 407, 408, 423, 429, 451].includes(response.status) || response.status >= 500;
    const sourceReason = confirmedMissing ? `http_${response.status}`
      : accessRestricted ? `source_access_unknown_http_${response.status}` : `source_response_unknown_http_${response.status}`;
    const result = withFacebookEvidence({
      site_status: confirmedMissing ? 'DEAD_SITE' : 'CHECK_FAILED',
      site_score: null,
      site_reasons: [sourceReason],
      confidence: confirmedMissing ? 90 : 0,
      signals: { http_status: response.status, source_access: accessRestricted ? 'unknown' : confirmedMissing ? 'confirmed_missing' : 'unknown' },
      scoring,
      screenshot_path: null,
    }, facebook, lead.facebook_url);
    if (cacheKey) _runState.domainCache.set(cacheKey, result);
    return result;
  }

  // ── Domain parking detection ───────────────────────────
  const parkingResult = detectDomainParking(html, url, finalUrl, domain);
  if (parkingResult.isParked) {
    const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
    const result = withFacebookEvidence({
      site_status: 'DOMAIN_PARKED',
      site_score: null,
      site_reasons: ['domain_parked', ...parkingResult.evidence],
      confidence: 90,
      signals: { parking_provider: parkingResult.provider || null },
      scoring,
      screenshot_path: null,
    }, facebook, lead.facebook_url);
    if (cacheKey) _runState.domainCache.set(cacheKey, result);
    return result;
  }

  // ── Parse HTML with cheerio ────────────────────────────
  const $ = parseHtml(html);

  // ── SPA detection ─────────────────────────────────────
  $('script, style, noscript').remove();
  let visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  let $fullHtml = parseHtml(html); // re-parse to check scripts
  let renderedScreenshotPath = null;

  if (visibleText.length < (config.spa_text_threshold || 200)) {
    const hasBundler = detectSpaSignals($fullHtml);
    if (hasBundler) {
      const screenshotPath = Number.isSafeInteger(Number(lead.id)) ? getScreenshotPath(Number(lead.id)) : null;
      const rendered = await getRenderedPage(finalUrl || url, {
        timeoutMs: config_timeout,
        ...(screenshotPath && !fs.existsSync(screenshotPath) ? { screenshotPath } : {}),
      });
      if (rendered?.html && rendered.text.trim().length >= (config.spa_text_threshold || 200)) {
        html = rendered.html;
        finalUrl = rendered.url || finalUrl;
        visibleText = rendered.text.replace(/\s+/g, ' ').trim();
        $fullHtml = parseHtml(html);
        renderedScreenshotPath = rendered.screenshotPath || null;
        signals.spa_detected = true;
        signals.spa_rendered = true;
        signals.render_requests = rendered.requestsSeen;
        signals.render_bytes = rendered.bytesFetched;
        reasons.push('spa_rendered');
      } else {
        reasons.push('needs_js_render');
        const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);
        const result = withFacebookEvidence({
          site_status: 'CHECK_FAILED',
          site_score: null,
          site_reasons: ['needs_js_render', 'spa_render_inconclusive'],
          confidence: 30,
          signals: { spa_detected: true, spa_rendered: false, visible_text_length: visibleText.length },
          scoring,
          screenshot_path: null,
        }, facebook, lead.facebook_url);
        if (cacheKey) _runState.domainCache.set(cacheKey, result);
        return result;
      }
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
  const recentWithin = scoringConfig.copyright_year_recent_within;
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
    signals.last_modified_recent = ageDays < scoringConfig.last_modified_recent_days;
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
  // ── Compute score, class and confidence from an immutable profile ──
  const evaluation = scoreQualificationSignals(signals, profile);
  const normalizedScore = evaluation.site_score;
  signals._raw_score = evaluation.scoring.rawScore;
  signals._max_score = evaluation.scoring.maxScore;
  reasons.push(...evaluation.reasons);
  const siteStatus = evaluation.site_status;
  const confidence = evaluation.confidence;

  // ── Facebook liveness ─────────────────────────────────
  const facebook = await captureFacebookEvidence(checkFacebook, lead.facebook_url);

  // ── Screenshot ────────────────────────────────────────
  let screenshotPath = renderedScreenshotPath;
  if (!screenshotPath) {
    try {
      screenshotPath = await takeScreenshot(lead);
    } catch {
      // Non-critical
    }
  }

  // ── Cache result ──────────────────────────────────────
  const result = withFacebookEvidence({
    site_status: siteStatus,
    site_score: normalizedScore,
    site_reasons: [...reasons],
    confidence,
    signals,
    scoring: { ...evaluation.scoring, applicable: true },
    screenshot_path: screenshotPath,
  }, facebook, lead.facebook_url);

  if (cacheKey) _runState.domainCache.set(cacheKey, result);

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
function qualificationError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function prepareQualificationRun(batchIdValue, options = {}) {
  const config = getConfig();
  const batchId = Number(batchIdValue);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw qualificationError('A valid batch ID is required.');
  const concurrency = Number(options.concurrency ?? config.concurrency ?? 5);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw qualificationError('Qualification concurrency must be from 1 to 20.');
  }
  if (_runState.active || _singleLeadAuditActive) throw qualificationError('Another qualification audit is already running.', 409);

  const db = getDb();
  const scoringProfile = getQualificationScoringManager(db).getProfile();
  let jobId = null;
  let leads;
  try {
    const setup = db.transaction(() => {
      if (!db.prepare('SELECT id FROM batches WHERE id=?').get(batchId)) throw qualificationError('Batch not found.', 404);
      if (!options.dryRun) {
        const active = db.prepare(`SELECT id,batch_id FROM qualification_jobs
          WHERE status IN (${ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',')}) LIMIT 1`)
          .get(...ACTIVE_QUALIFICATION_JOB_STATUSES);
        if (active) throw qualificationError(`Qualification job #${active.id} is already active for batch #${active.batch_id}.`, 409);
      }
      const pending = db.prepare("SELECT * FROM leads WHERE batch_id=? AND status='discovered' ORDER BY id").all(batchId);
      if (!options.dryRun) {
        const inserted = db.prepare(`INSERT INTO qualification_jobs(batch_id,status,total,scoring_profile_version,scoring_profile_hash)
          VALUES (?,'queued',?,?,?)`).run(batchId, pending.length, scoringProfile.version, scoringProfile.configHash);
        jobId = Number(inserted.lastInsertRowid);
        db.prepare("UPDATE qualification_jobs SET status='running',started_at=datetime('now'),updated_at=datetime('now') WHERE id=?")
          .run(jobId);
      }
      return pending;
    });
    leads = setup();
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw qualificationError('Another qualification job is already active.', 409);
    throw error;
  }

  _runState = {
    active: true, jobId, batchId, processed: 0, total: leads.length, failedCount: 0,
    currentLead: null, currentLeadIds: [], cancelling: false,
    startedAt: new Date().toISOString(), scoringVersion: scoringProfile.version,
    domainCache: new Map(), circuitBreakers: new Map(),
  };
  return { db, batchId, concurrency, dryRun: options.dryRun === true, onProgress: options.onProgress,
    scoringProfile, jobId, leads, startedAt: Date.now(), qualifyLeadImpl: options.qualifyLeadImpl };
}

/** Start a durable qualification run and return immediately with its completion promise. */
export function startQualificationBatch(batchId, options = {}) {
  const context = prepareQualificationRun(batchId, options);
  return { jobId: context.jobId, batchId: context.batchId, promise: executeQualificationRun(context) };
}

/** Run qualification for every discovered or recoverable lead in a batch. */
export async function qualifyBatch(batchId, options = {}) {
  return executeQualificationRun(prepareQualificationRun(batchId, options));
}

async function executeQualificationRun(context) {
  const { db, batchId, concurrency, dryRun, onProgress, scoringProfile, jobId, leads } = context;
  const statusCounts = { NO_SITE: 0, DEAD_SITE: 0, DOMAIN_PARKED: 0, OUTDATED: 0, MODERN: 0, CHECK_FAILED: 0 };
  let failedCount = 0;
  let disqualifiedCount = 0;
  const updateLead = db.prepare(`UPDATE leads SET
    status=CASE WHEN status='checking' THEN ? ELSE status END,site_status=?,site_score=?,site_reasons=?,fb_active=?,screenshot_path=?,confidence=?,
    site_reasons_json=?,site_checked_at=datetime('now'),updated_at=datetime('now') WHERE id=?`);
  const setChecking = db.prepare("UPDATE leads SET status='checking',updated_at=datetime('now') WHERE id=? AND status IN ('discovered','checking')");
  const requeueChecking = db.prepare("UPDATE leads SET status='discovered',updated_at=datetime('now') WHERE id=? AND status='checking'");
  const insertEvent = db.prepare(`INSERT INTO events (lead_id,event_type,event_at,meta_json)
    VALUES (?, 'site_check', datetime('now'), ?)`);

  const updateJobProgress = db.prepare(`UPDATE qualification_jobs SET processed=processed+1,failed_count=failed_count+?,
    status_counts_json=?,current_lead_ids_json=?,error_code=CASE WHEN ?=1 THEN 'qualification_lead_failed' ELSE error_code END,
    error_message=CASE WHEN ?=1 THEN ? ELSE error_message END,updated_at=datetime('now') WHERE id=?
    AND status IN ('running','cancel_requested')`);
  const persistCurrentChunk = db.prepare(`UPDATE qualification_jobs SET current_lead_ids_json=?,updated_at=datetime('now')
    WHERE id=? AND status='running'`);

  try {
    for (let i = 0; i < leads.length; i += concurrency) {
      const jobStatus = jobId ? db.prepare('SELECT status FROM qualification_jobs WHERE id=?').get(jobId)?.status : null;
      if (_runState.cancelling || jobStatus === 'cancel_requested' || (jobId && !ACTIVE_QUALIFICATION_JOB_STATUSES.includes(jobStatus))) break;

      const chunk = leads.slice(i, i + concurrency);
      _runState.currentLeadIds = chunk.map(lead => lead.id);
      _runState.currentLead = chunk[0]?.business_name || null;
      if (!dryRun) db.transaction(() => {
        for (const lead of chunk) setChecking.run(lead.id);
        persistCurrentChunk.run(JSON.stringify(_runState.currentLeadIds), jobId);
      })();

      const results = await Promise.all(chunk.map(async lead => {
        _runState.currentLead = lead.business_name;
        const qualify = typeof context.qualifyLeadImpl === 'function' ? context.qualifyLeadImpl : qualifyLead;
        try { return { status: 'fulfilled', value: { lead, result: await qualify(lead, { scoringProfile }) } }; }
        catch (reason) { return { status: 'rejected', lead, reason }; }
      }));

      for (const outcome of results) {
        if (outcome.status === 'rejected') {
          const message = String(outcome.reason?.message || 'Site audit failed.').slice(0, 500);
          console.log(`   ❌ Failed: ${message}`);
          failedCount++;
          _runState.failedCount = failedCount;
          if (!dryRun) db.transaction(() => {
            requeueChecking.run(outcome.lead.id);
            updateJobProgress.run(1, JSON.stringify(statusCounts), JSON.stringify(_runState.currentLeadIds), 1, 1, message, jobId);
          })();
          else _runState.processed++;
          continue;
        }

        const { lead, result } = outcome.value;
        statusCounts[result.site_status] = (statusCounts[result.site_status] || 0) + 1;
        const newStatus = result.site_status === 'MODERN' ? 'disqualified' : 'site_checked';
        if (result.site_status === 'MODERN') disqualifiedCount++;
        if (!dryRun) db.transaction(() => {
          updateLead.run(
            newStatus, result.site_status, result.site_score, (result.site_reasons || []).join(', '), result.fb_active,
            result.screenshot_path, result.confidence,
            JSON.stringify({ signals: result.signals || {}, reasons: result.site_reasons || [], scoring: result.scoring || null }), lead.id,
          );
          insertEvent.run(lead.id, JSON.stringify({
            site_status: result.site_status, site_score: result.site_score, confidence: result.confidence,
            scoringVersion: result.scoring?.version ?? null, scoringConfigHash: result.scoring?.configHash ?? null,
          }));
          updateJobProgress.run(0, JSON.stringify(statusCounts), JSON.stringify(_runState.currentLeadIds), 0, 0, '', jobId);
        })();
        else _runState.processed++;
      }

      _runState.processed = Math.min(i + chunk.length, leads.length);
      _runState.currentLeadIds = [];
      _runState.currentLead = null;
      if (jobId) db.prepare("UPDATE qualification_jobs SET current_lead_ids_json='[]',updated_at=datetime('now') WHERE id=?").run(jobId);
      if (onProgress) onProgress(_runState.processed, leads.length, statusCounts);
      const pct = leads.length ? Math.round((_runState.processed / leads.length) * 100) : 100;
      console.log(`   [${pct}%] ${_runState.processed}/${leads.length} — ${Object.entries(statusCounts).filter(([, value]) => value > 0).map(([key, value]) => `${key}:${value}`).join(' ')}`);
    }

    const persistedStatus = jobId ? db.prepare('SELECT status FROM qualification_jobs WHERE id=?').get(jobId)?.status : null;
    const cancelled = _runState.cancelling || persistedStatus === 'cancel_requested';
    const finalStatus = cancelled ? 'cancelled' : 'completed';
    if (jobId) db.prepare(`UPDATE qualification_jobs SET status=?,current_lead_ids_json='[]',updated_at=datetime('now'),completed_at=datetime('now')
      WHERE id=? AND status IN ('running','cancel_requested')`).run(finalStatus, jobId);
    const summary = {
      jobId, batchId, processed: _runState.processed, total: leads.length, failedCount,
      cancelled, status: finalStatus, statusCounts, disqualified: disqualifiedCount,
      cacheHits: _runState.domainCache.size, duration: Date.now() - context.startedAt,
    };
    if (leads.length === 0) console.log(`\n⚠️  No leads to qualify in batch #${batchId}\n`);
    else {
      console.log('\n' + '═'.repeat(60));
      console.log('  ✅ Qualification Complete');
      console.log('═'.repeat(60));
      console.log(`  Processed: ${summary.processed}/${summary.total}`);
      Object.entries(statusCounts).forEach(([status, count]) => { if (count > 0) console.log(`  ${status}: ${count}`); });
      console.log(`  Failed/retryable: ${failedCount}`);
      console.log(`  Disqualified (MODERN): ${disqualifiedCount}`);
      console.log(`  Cache hits: ${summary.cacheHits} domains`);
      console.log(`  Duration: ${(summary.duration / 1000).toFixed(1)}s`);
      if (cancelled) console.log('  ⚠️  Run was cancelled');
      console.log('═'.repeat(60) + '\n');
    }
    return summary;
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code.slice(0, 80) : 'qualification_failed';
    const message = String(error.message || 'Qualification failed.').slice(0, 500);
    if (jobId) db.transaction(() => {
      const reset = db.prepare("UPDATE leads SET status='discovered',updated_at=datetime('now') WHERE batch_id=? AND status='checking'").run(batchId);
      db.prepare(`UPDATE qualification_jobs SET status='failed',failed_count=failed_count+?,error_code=?,error_message=?,
        current_lead_ids_json='[]',updated_at=datetime('now'),completed_at=datetime('now')
        WHERE id=? AND status IN ('running','cancel_requested')`).run(reset.changes, code, message, jobId);
    })();
    throw error;
  } finally {
    _runState.active = false;
    _runState.cancelling = false;
    _runState.currentLead = null;
    _runState.currentLeadIds = [];
  }
}

/** Request durable cancellation of the active qualification job. */
export function cancelQualification(batchIdValue = null) {
  const db = getDb();
  const batchId = batchIdValue === null || batchIdValue === undefined || batchIdValue === '' ? null : Number(batchIdValue);
  const active = batchId === null
    ? db.prepare(`SELECT id,batch_id,status FROM qualification_jobs WHERE status IN (${ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(...ACTIVE_QUALIFICATION_JOB_STATUSES)
    : db.prepare(`SELECT id,batch_id,status FROM qualification_jobs WHERE batch_id=? AND status IN (${ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(batchId, ...ACTIVE_QUALIFICATION_JOB_STATUSES);
  if (!active) return { jobId: null, batchId, status: null, cancelling: false, changed: false };
  const changed = db.prepare(`UPDATE qualification_jobs SET status='cancel_requested',cancel_requested_at=datetime('now'),updated_at=datetime('now')
    WHERE id=? AND status IN ('queued','running')`).run(active.id).changes > 0;
  if (Number(_runState.jobId) === Number(active.id)) _runState.cancelling = true;
  return { jobId: active.id, batchId: active.batch_id, status: 'cancel_requested', cancelling: true, changed };
}

/**
 * Re-qualify a single lead by ID.
 */
export async function requalifyLead(leadId) {
  const db = getDb();
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`Lead #${leadId} not found`);

  if (_runState.active || _singleLeadAuditActive || db.prepare(`SELECT id FROM qualification_jobs
    WHERE status IN (${ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',')}) LIMIT 1`)
    .get(...ACTIVE_QUALIFICATION_JOB_STATUSES)) {
    throw qualificationError('A qualification audit is already running. Try again when it finishes.', 409);
  }
  if (lead.status === 'checking') throw qualificationError('This lead is already being checked.', 409);
  if (!['discovered', 'site_checked', 'disqualified'].includes(lead.status)) {
    throw qualificationError('This lead is in a later lifecycle stage and cannot be re-audited here.', 409);
  }

  const scoringProfile = getQualificationScoringManager(db).getProfile();
  _singleLeadAuditActive = true;
  db.prepare("UPDATE leads SET status='checking',updated_at=datetime('now') WHERE id=?").run(leadId);
  try {
    const result = await qualifyLead(lead, { scoringProfile });
    const newStatus = result.site_status === 'MODERN' ? 'disqualified' : 'site_checked';
    db.prepare(`UPDATE leads SET status=CASE WHEN status='checking' THEN ? ELSE status END,site_status=?,site_score=?,site_reasons=?,fb_active=?,screenshot_path=?,confidence=?,
      site_reasons_json=?,site_checked_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(
      newStatus, result.site_status, result.site_score, (result.site_reasons || []).join(', '), result.fb_active,
      result.screenshot_path, result.confidence,
      JSON.stringify({ signals: result.signals || {}, reasons: result.site_reasons || [], scoring: result.scoring || null }), leadId,
    );
    return result;
  } catch (error) {
    db.prepare("UPDATE leads SET status=?,updated_at=datetime('now') WHERE id=? AND status='checking'").run(lead.status, leadId);
    throw error;
  } finally {
    _singleLeadAuditActive = false;
  }
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
  const days = windowDays === undefined ? (config.freshness_window_days || 60) : Number(windowDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw qualificationError('Stale audit window must be from 1 to 3650 days.');
  const db = getDb();

  return db.prepare(`
    SELECT * FROM leads
    WHERE site_checked_at IS NOT NULL
      AND site_checked_at < datetime('now', ?)
      AND status='site_checked'
  `).all(`-${days} days`);
}

export function getStaleLeadCount(windowDays) {
  const config = getConfig();
  const days = windowDays === undefined ? (config.freshness_window_days || 60) : Number(windowDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw qualificationError('Stale audit window must be from 1 to 3650 days.');
  return getDb().prepare(`SELECT COUNT(*) AS count FROM leads WHERE site_checked_at IS NOT NULL
    AND site_checked_at < datetime('now', ?) AND status='site_checked'`).get(`-${days} days`).count;
}

/**
 * Requeue stale leads back to 'discovered' for re-qualification.
 */
export function requeueStaleLeads(windowDays) {
  const db = getDb();
  const days = windowDays === undefined ? undefined : Number(windowDays);
  if (_runState.active || _singleLeadAuditActive || db.prepare(`SELECT id FROM qualification_jobs
    WHERE status IN (${ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',')}) LIMIT 1`)
    .get(...ACTIVE_QUALIFICATION_JOB_STATUSES)) {
    throw qualificationError('Wait for the active qualification audit to finish before rechecking stale leads.', 409);
  }
  const requeued = db.transaction(() => {
    const ids = getStaleLeads(days).map(lead => lead.id);
    const update = db.prepare("UPDATE leads SET status='discovered',updated_at=datetime('now') WHERE id=? AND status='site_checked'");
    let count = 0;
    for (const id of ids) count += update.run(id).changes;
    return count;
  })();
  console.log(`🔄 Requeued ${requeued} stale leads for re-qualification`);
  return { requeued };
}


// ══════════════════════════════════════════════════════════════
//  RESUMABILITY — startup recovery
// ══════════════════════════════════════════════════════════════

/**
 * Reset leads stuck in 'checking' status (from a crash).
 * Call on server startup.
 */
export function recoverStuckLeads() {
  const db = getDb();
  const recovered = db.prepare("UPDATE leads SET status='discovered',updated_at=datetime('now') WHERE status='checking'").run().changes;
  if (recovered > 0) console.log(`🔄 Recovered ${recovered} leads left in 'checking' status`);
  return recovered;
}

/** Mark persisted work interrupted at process startup and make all claimed leads retryable. */
export function recoverInterruptedQualificationJobs() {
  if (_runState.active) return [];
  const db = getDb();
  return db.transaction(() => {
    const active = db.prepare(`SELECT id,status FROM qualification_jobs WHERE status IN (${ACTIVE_QUALIFICATION_JOB_STATUSES.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ACTIVE_QUALIFICATION_JOB_STATUSES);
    const recover = db.prepare(`UPDATE qualification_jobs SET
      status=CASE WHEN status='cancel_requested' THEN 'cancelled' WHEN processed>=total THEN 'completed' ELSE 'interrupted' END,
      error_code=CASE WHEN status='cancel_requested' OR processed>=total THEN NULL ELSE 'worker_restarted' END,
      error_message=CASE WHEN status='cancel_requested' OR processed>=total THEN NULL ELSE 'Worker stopped before qualification finished. Retry the remaining discovered leads.' END,
      current_lead_ids_json='[]',updated_at=datetime('now'),completed_at=datetime('now')
      WHERE id=? AND status IN ('queued','running','cancel_requested')`);
    for (const job of active) recover.run(job.id);
    const reset = db.prepare("UPDATE leads SET status='discovered',updated_at=datetime('now') WHERE status='checking'").run();
    if (active.length || reset.changes) console.log(`🔄 Recovered ${reset.changes} checking leads from ${active.length} interrupted qualification job(s)`);
    return active.map(job => ({ id: job.id, status: job.status === 'cancel_requested' ? 'cancelled' : 'interrupted' }));
  })();
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

  const rows = db.prepare(query).all(...params);
  const results = rows.map(lead => {
    let siteEvidence = null;
    try { siteEvidence = JSON.parse(lead.site_reasons_json || 'null'); } catch { /* retain legacy evidence as unavailable */ }
    return { ...lead, site_evidence: siteEvidence };
  });

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
export async function checkFacebookLiveness(facebookUrl, { fetchPage = safeFetch } = {}) {
  if (!facebookUrl) return { value: null, reason: 'facebook_url_missing' };

  let url = facebookUrl.trim();
  if (!url.startsWith('http')) {
    if (url.startsWith('fb.com/')) url = `https://www.facebook.com/${url.slice(7)}`;
    else url = `https://${url}`;
  }

  try {
    const response = await fetchPage(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      timeoutMs: 5000,
      maxBytes: 1024,
      maxRedirects: 4,
    });

    if (response.ok || response.status === 302) return { value: 1, reason: null };
    if (response.status === 404 || response.status === 410) return { value: 0, reason: null };
    if (response.status === 403 || response.status === 401) return { value: null, reason: `facebook_access_restricted_http_${response.status}` };
    if (response.status === 429) return { value: null, reason: 'facebook_rate_limited_http_429' };
    return { value: null, reason: `facebook_response_unknown_http_${response.status}` };
  } catch (error) {
    return { value: null, reason: String(error?.message || '').toLowerCase().includes('ssrf')
      ? 'facebook_source_policy_blocked' : 'facebook_network_unavailable' };
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
