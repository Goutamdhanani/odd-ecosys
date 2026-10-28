import { createHash } from 'node:crypto';

const SITE_STATUSES = new Set(['NO_SITE', 'DEAD_SITE', 'DOMAIN_PARKED', 'OUTDATED', 'MODERN', 'CHECK_FAILED']);
const REVIEW_ROLES = new Set(['owner', 'admin', 'operator', 'reviewer']);

function reviewError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function leadIdValue(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw reviewError('Lead ID is invalid.');
  return id;
}

function evidenceFingerprint(lead) {
  const evidence = [
    Number(lead.id), lead.batch_id ?? null, lead.site_status ?? null, lead.site_score ?? null,
    lead.confidence ?? null, lead.site_checked_at ?? null, lead.site_reasons_json ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function parseEvidence(value) {
  try {
    const parsed = JSON.parse(value || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicReview(row, lead = null) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    decision: row.decision,
    originalSiteStatus: row.original_site_status,
    effectiveSiteStatus: row.effective_site_status,
    originalSiteScore: row.original_site_score,
    confidence: row.confidence,
    siteCheckedAt: row.site_checked_at,
    evidenceHash: row.evidence_hash,
    reason: row.reason,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedByRole: row.reviewed_by_role,
    reviewedAt: row.reviewed_at,
    evidenceMatchesCurrent: lead ? row.evidence_hash === evidenceFingerprint(lead) : undefined,
  };
}

export function createQualificationReviewManager(db) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A SQLite database is required.');
  db.exec(`CREATE TABLE IF NOT EXISTS qualification_review_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    batch_id INTEGER,
    decision TEXT NOT NULL CHECK(decision IN ('confirm','override')),
    original_site_status TEXT NOT NULL,
    effective_site_status TEXT NOT NULL,
    original_site_score INTEGER,
    confidence INTEGER NOT NULL,
    site_checked_at TEXT,
    evidence_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    reviewed_by_user_id INTEGER NOT NULL,
    reviewed_by_role TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_qualification_review_events_lead
    ON qualification_review_events(lead_id,id DESC);
  CREATE INDEX IF NOT EXISTS idx_qualification_review_events_queue
    ON qualification_review_events(batch_id,reviewed_at DESC,id DESC);`);

  const leadById = db.prepare('SELECT id,batch_id,business_name,website_url,site_status,site_score,confidence,site_reasons,site_reasons_json,site_checked_at FROM leads WHERE id=?');
  const latestByLeadId = db.prepare('SELECT * FROM qualification_review_events WHERE lead_id=? ORDER BY id DESC LIMIT 1');

  function getReviewHistory(rawLeadId, limit = 20) {
    const id = leadIdValue(rawLeadId);
    const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
    const lead = leadById.get(id) || null;
    return db.prepare('SELECT * FROM qualification_review_events WHERE lead_id=? ORDER BY id DESC LIMIT ?')
      .all(id, safeLimit).map(row => publicReview(row, lead));
  }

  function getCurrentReview(rawLeadId) {
    const id = leadIdValue(rawLeadId);
    const lead = leadById.get(id);
    if (!lead) return null;
    const latest = latestByLeadId.get(id);
    return latest && latest.evidence_hash === evidenceFingerprint(lead) ? publicReview(latest, lead) : null;
  }

  function getReviewQueue({ batchId: rawBatchId, maxConfidence = 70, limit = 50, offset = 0 } = {}) {
    const batchId = Number(rawBatchId);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw reviewError('A valid batch ID is required.');
    const threshold = Number(maxConfidence);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) throw reviewError('Maximum confidence must be from 0 to 100.');
    const pageSize = Number(limit);
    const pageOffset = Number(offset);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw reviewError('Review queue page size must be from 1 to 100.');
    if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || pageOffset > 1_000_000) throw reviewError('Review queue offset is invalid.');

    const candidates = db.prepare(`SELECT id,batch_id,business_name,website_url,site_status,site_score,confidence,
      site_reasons,site_reasons_json,site_checked_at FROM leads
      WHERE batch_id=? AND site_status IS NOT NULL AND confidence IS NOT NULL AND confidence<=?
      ORDER BY confidence ASC,id ASC LIMIT ? OFFSET ?`);
    const latestForIds = ids => db.prepare(`SELECT r.* FROM qualification_review_events r
      JOIN (SELECT lead_id,MAX(id) AS id FROM qualification_review_events WHERE lead_id IN (${ids.map(() => '?').join(',')}) GROUP BY lead_id) latest
      ON latest.id=r.id`).all(...ids);
    const chunkSize = 100;
    const results = [];
    let total = 0;
    let scanOffset = 0;
    for (;;) {
      const chunk = candidates.all(batchId, threshold, chunkSize, scanOffset);
      if (chunk.length === 0) break;
      scanOffset += chunk.length;
      const rows = latestForIds(chunk.map(row => row.id));
      const latestById = new Map(rows.map(row => [row.lead_id, row]));
      for (const lead of chunk) {
        const lastReview = latestById.get(lead.id);
        if (lastReview?.evidence_hash === evidenceFingerprint(lead)) continue;
        if (total >= pageOffset && results.length < pageSize) {
          let reasons = parseEvidence(lead.site_reasons_json)?.reasons;
          if (!Array.isArray(reasons)) reasons = String(lead.site_reasons || '').split(',').map(value => value.trim()).filter(Boolean);
          results.push({
            id: lead.id,
            batchId: lead.batch_id,
            businessName: lead.business_name,
            websiteUrl: lead.website_url,
            siteStatus: lead.site_status,
            siteScore: lead.site_score,
            confidence: lead.confidence,
            siteCheckedAt: lead.site_checked_at,
            siteReasons: reasons,
            siteEvidence: parseEvidence(lead.site_reasons_json),
            previousReview: lastReview ? publicReview(lastReview, lead) : null,
          });
        }
        total += 1;
      }
      if (chunk.length < chunkSize) break;
    }
    return { results, total, limit: pageSize, offset: pageOffset, maxConfidence: threshold };
  }

  function recordReview({ leadId: rawLeadId, decision, siteStatus, reason, actor }) {
    const leadId = leadIdValue(rawLeadId);
    if (!actor?.id || !REVIEW_ROLES.has(actor.role)) throw reviewError('Your workspace role cannot review qualification evidence.', 403);
    const lead = leadById.get(leadId);
    if (!lead) throw reviewError('Lead was not found.', 404);
    if (!lead.site_status || lead.confidence === null || lead.site_checked_at === null) {
      throw reviewError('This lead does not have a completed site audit to review.', 409);
    }

    const selectedDecision = String(decision || '').trim().toLowerCase();
    if (!['confirm', 'override'].includes(selectedDecision)) throw reviewError('Choose whether to confirm or override the automated classification.');
    const effectiveStatus = selectedDecision === 'confirm' ? lead.site_status : String(siteStatus || '').trim().toUpperCase();
    if (!SITE_STATUSES.has(effectiveStatus)) throw reviewError('Choose a valid site classification for the review.');
    if (selectedDecision === 'override' && effectiveStatus === lead.site_status) {
      throw reviewError('Choose the confirm decision when keeping the automated classification.');
    }
    const note = String(reason || '').trim();
    if (note.length < 8 || note.length > 500) throw reviewError('Add a review reason from 8 to 500 characters.');

    const result = db.prepare(`INSERT INTO qualification_review_events(
      lead_id,batch_id,decision,original_site_status,effective_site_status,original_site_score,confidence,
      site_checked_at,evidence_hash,reason,reviewed_by_user_id,reviewed_by_role
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      lead.id, lead.batch_id, selectedDecision, lead.site_status, effectiveStatus, lead.site_score, lead.confidence,
      lead.site_checked_at, evidenceFingerprint(lead), note, actor.id, actor.role,
    );
    const event = db.prepare('SELECT * FROM qualification_review_events WHERE id=?').get(result.lastInsertRowid);
    return publicReview(event, lead);
  }

  return { getReviewQueue, getReviewHistory, getCurrentReview, recordReview };
}

