import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'qualification-scoring.json');
const SIGNALS = [
  'ssl_valid', 'viewport_meta', 'copyright_recent', 'has_analytics', 'modern_cms', 'responsive_images',
  'fast_load', 'structured_data', 'custom_domain_email', 'social_links', 'last_modified_recent', 'https_redirect',
];
const PENALTIES = ['ssl_check_failed', 'html_truncated', 'unresolved_signal', 'near_threshold', 'threshold_proximity'];
const JSON_KEYS = ['thresholds', 'signal_weights', 'confidence_penalties', 'copyright_year_recent_within', 'last_modified_recent_days'];
const initialized = new WeakSet();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function canonicalScoringJson(value) {
  return JSON.stringify(stableValue(value));
}

export function scoringProfileHash(config) {
  return createHash('sha256').update(canonicalScoringJson(config)).digest('hex');
}

export function normalizeScoringConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Scoring configuration must be an object.');
  const extra = Object.keys(value).filter(key => !JSON_KEYS.includes(key));
  if (extra.length) throw new Error(`Unknown scoring setting: ${extra[0]}.`);
  for (const key of JSON_KEYS) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing scoring setting: ${key}.`);
  }
  const integer = (raw, label, min, max) => {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
    return number;
  };
  const requireKeys = (object, expected, label) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label} must be an object.`);
    const missing = expected.filter(key => !Object.hasOwn(object, key));
    const unknown = Object.keys(object).filter(key => !expected.includes(key));
    if (missing.length) throw new Error(`${label} is missing ${missing[0]}.`);
    if (unknown.length) throw new Error(`${label} contains unknown key ${unknown[0]}.`);
  };

  requireKeys(value.thresholds, ['outdated_max', 'modern_min'], 'Thresholds');
  const outdatedMax = integer(value.thresholds.outdated_max, 'Outdated threshold', 0, 99);
  const modernMin = integer(value.thresholds.modern_min, 'Modern threshold', 1, 100);
  if (outdatedMax >= modernMin) throw new Error('The outdated threshold must be lower than the modern threshold.');

  requireKeys(value.signal_weights, SIGNALS, 'Signal weights');
  const signalWeights = Object.fromEntries(SIGNALS.map(signal => [signal, integer(value.signal_weights[signal], `Weight for ${signal}`, 0, 100)]));
  if (Object.values(signalWeights).every(weight => weight === 0)) throw new Error('At least one site signal must have a positive weight.');

  requireKeys(value.confidence_penalties, PENALTIES, 'Confidence penalties');
  const confidencePenalties = Object.fromEntries(PENALTIES.map(key => [key, integer(value.confidence_penalties[key], `Penalty for ${key}`, 0, 100)]));

  return {
    thresholds: { outdated_max: outdatedMax, modern_min: modernMin },
    signal_weights: signalWeights,
    confidence_penalties: confidencePenalties,
    copyright_year_recent_within: integer(value.copyright_year_recent_within, 'Recent copyright year window', 0, 10),
    last_modified_recent_days: integer(value.last_modified_recent_days, 'Recent Last-Modified window', 1, 3650),
  };
}

export function scoreQualificationSignals(signals, profile) {
  const config = normalizeScoringConfig(profile.config || profile);
  const weights = config.signal_weights;
  const resolvedSignals = [];
  const unresolvedSignals = [];
  let rawScore = 0;
  let maxScore = 0;
  for (const [signal, weight] of Object.entries(weights)) {
    maxScore += weight;
    if (signals?.[signal] === true) {
      rawScore += weight;
      resolvedSignals.push(signal);
    } else if (signals?.[signal] === false) {
      resolvedSignals.push(signal);
    } else {
      unresolvedSignals.push(signal);
    }
  }
  const siteScore = maxScore > 0 ? Math.round((rawScore / maxScore) * 100) : 0;
  const reasons = [];
  let siteStatus;
  if (siteScore >= config.thresholds.modern_min) {
    siteStatus = 'MODERN';
    reasons.push('modern_site');
  } else if (siteScore < config.thresholds.outdated_max) {
    siteStatus = 'OUTDATED';
    reasons.push('low_score');
  } else {
    siteStatus = 'OUTDATED';
    reasons.push('marginal_score');
  }
  const penalties = config.confidence_penalties;
  const appliedPenalties = {};
  if (signals?.ssl_check_failed === true) appliedPenalties.ssl_check_failed = penalties.ssl_check_failed;
  if (signals?.html_truncated === true) appliedPenalties.html_truncated = penalties.html_truncated;
  if (unresolvedSignals.length) appliedPenalties.unresolved_signal = unresolvedSignals.length * penalties.unresolved_signal;
  const nearThreshold = Math.abs(siteScore - config.thresholds.outdated_max) <= penalties.threshold_proximity
    || Math.abs(siteScore - config.thresholds.modern_min) <= penalties.threshold_proximity;
  if (nearThreshold) appliedPenalties.near_threshold = penalties.near_threshold;
  let confidence = 100 - Object.values(appliedPenalties).reduce((sum, penalty) => sum + penalty, 0);
  confidence = Math.max(0, Math.min(100, confidence));
  return {
    site_status: siteStatus,
    site_score: siteScore,
    confidence,
    reasons,
    scoring: {
      version: profile.version ?? null,
      configHash: profile.configHash || scoringProfileHash(config),
      rawScore,
      maxScore,
      resolvedSignals,
      unresolvedSignals,
      thresholds: config.thresholds,
      confidencePenalties: config.confidence_penalties,
      appliedPenalties,
    },
  };
}

function loadDefaultConfig() {
  const source = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  return normalizeScoringConfig({
    thresholds: source.thresholds,
    signal_weights: source.signal_weights,
    confidence_penalties: source.confidence_penalties,
    copyright_year_recent_within: source.copyright_year_recent_within,
    last_modified_recent_days: source.last_modified_recent_days,
  });
}

export function createQualificationScoringManager(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  db.exec(`CREATE TABLE IF NOT EXISTS qualification_scoring_profiles (
    version INTEGER PRIMARY KEY,
    config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by_user_id INTEGER,
    change_note TEXT
  )`);
  if (!initialized.has(db)) {
    const existing = db.prepare('SELECT COUNT(*) AS count FROM qualification_scoring_profiles').get().count;
    if (existing === 0) {
      const config = loadDefaultConfig();
      db.prepare(`INSERT INTO qualification_scoring_profiles(version,config_json,config_hash,change_note)
        VALUES (1,?,?,?)`).run(canonicalScoringJson(config), scoringProfileHash(config), 'Initial profile from config/qualification-scoring.json');
    }
    initialized.add(db);
  }

  function getProfile(version) {
    const row = version === undefined || version === null
      ? db.prepare('SELECT * FROM qualification_scoring_profiles ORDER BY version DESC LIMIT 1').get()
      : db.prepare('SELECT * FROM qualification_scoring_profiles WHERE version=?').get(Number(version));
    if (!row) throw Object.assign(new Error('Scoring profile was not found.'), { statusCode: 404 });
    return {
      version: row.version,
      configHash: row.config_hash,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
      changeNote: row.change_note,
      config: JSON.parse(row.config_json),
    };
  }

  function listProfiles(limit = 10) {
    const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
    return db.prepare(`SELECT version,config_hash AS configHash,created_at AS createdAt,
      created_by_user_id AS createdByUserId,change_note AS changeNote
      FROM qualification_scoring_profiles ORDER BY version DESC LIMIT ?`).all(safeLimit);
  }

  function createVersion({ actor, config, changeNote = '', remoteAddress: _remoteAddress }) {
    if (!actor?.id || !['owner', 'admin'].includes(actor.role)) {
      throw Object.assign(new Error('Only workspace owners and admins can change site scoring.'), { statusCode: 403 });
    }
    const normalized = normalizeScoringConfig(config);
    const hash = scoringProfileHash(normalized);
    const current = getProfile();
    if (current.configHash === hash) {
      throw Object.assign(new Error('These scoring settings already match the active profile.'), { statusCode: 409 });
    }
    const note = String(changeNote || '').trim();
    if (note.length > 240) throw Object.assign(new Error('Change note must be 240 characters or fewer.'), { statusCode: 400 });
    return db.transaction(() => {
      const nextVersion = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM qualification_scoring_profiles').get().version;
      db.prepare(`INSERT INTO qualification_scoring_profiles(version,config_json,config_hash,created_by_user_id,change_note)
        VALUES (?,?,?,?,?)`).run(nextVersion, canonicalScoringJson(normalized), hash, actor.id, note || null);
      return getProfile(nextVersion);
    })();
  }

  function replayLead(leadId, version) {
    const lead = db.prepare('SELECT id,site_score,site_status,confidence,site_reasons_json FROM leads WHERE id=?').get(Number(leadId));
    if (!lead) throw Object.assign(new Error('Lead was not found.'), { statusCode: 404 });
    let savedEvidence;
    try { savedEvidence = JSON.parse(lead.site_reasons_json || '{}'); }
    catch { throw Object.assign(new Error('Saved audit evidence is invalid and cannot be replayed.'), { statusCode: 409 }); }
    if (!savedEvidence.signals || typeof savedEvidence.signals !== 'object' || Array.isArray(savedEvidence.signals)) {
      throw Object.assign(new Error('This lead has no saved site signals to replay.'), { statusCode: 409 });
    }
    if (savedEvidence.scoring?.applicable === false || lead.site_score === null) {
      throw Object.assign(new Error('This audit did not produce a score that can be replayed.'), { statusCode: 409 });
    }
    const profile = getProfile(version);
    return {
      leadId: lead.id,
      profile: { version: profile.version, configHash: profile.configHash },
      recorded: {
        siteScore: lead.site_score,
        siteStatus: lead.site_status,
        confidence: lead.confidence,
        profileVersion: savedEvidence.scoring?.version ?? null,
        configHash: savedEvidence.scoring?.configHash ?? null,
      },
      replayed: scoreQualificationSignals(savedEvidence.signals, profile),
      signals: savedEvidence.signals,
    };
  }

  return { getProfile, listProfiles, createVersion, replayLead };
}

export function getQualificationScoringManager(db) {
  return createQualificationScoringManager(db);
}
