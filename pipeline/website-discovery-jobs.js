import { createHash } from 'node:crypto';
import { normalizeWebsiteUrl } from './website-email-discovery.js';

const MAX_TASK_PAGE_SIZE = 100;
const RETRYABLE_ERRORS = new Set(['website_request_failed', 'site_unavailable', 'scan_request_budget_reached']);
const RATE_LIMIT_ERRORS = new Set(['site_rate_limited', 'robots_rate_limited']);
const VERIFICATION_STATUSES = new Set(['deliverable', 'undeliverable', 'risky', 'unknown']);

function hasPendingPaths(value) {
  try {
    const paths = JSON.parse(value || '[]');
    return Array.isArray(paths) && paths.some(item => typeof item === 'string' && item.length <= 320);
  } catch { return false; }
}

function isRetryableWebsiteError(code) {
  return RETRYABLE_ERRORS.has(code) || /^robots_http_5\d\d$/.test(String(code || ''));
}

export class WebsiteDiscoveryJobError extends Error {
  constructor(message, statusCode = 400, code = 'website_discovery_job_error') {
    super(message);
    this.name = 'WebsiteDiscoveryJobError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeSeed(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebsiteDiscoveryJobError(`Business ${index + 1} must include a name and website.`);
  }
  const businessName = typeof value.business_name === 'string' ? value.business_name.trim() : '';
  if (!businessName || businessName.length > 200) {
    throw new WebsiteDiscoveryJobError(`Business ${index + 1} needs a name of 1–200 characters.`);
  }
  let website;
  try { website = normalizeWebsiteUrl(value.website_url); }
  catch (error) { throw new WebsiteDiscoveryJobError(`Business ${index + 1}: ${error.message}`, 422, error.code || 'website_invalid'); }
  let leadId = null;
  if (value.lead_id !== undefined && value.lead_id !== null) {
    if (typeof value.lead_id !== 'number' || !Number.isSafeInteger(value.lead_id) || value.lead_id < 1) {
      throw new WebsiteDiscoveryJobError(`Business ${index + 1} has an invalid contact id.`, 422, 'lead_id_invalid');
    }
    leadId = value.lead_id;
  }
  const optional = (field, max) => {
    if (value[field] === undefined || value[field] === null || value[field] === '') return null;
    if (typeof value[field] !== 'string' || value[field].trim().length > max) {
      throw new WebsiteDiscoveryJobError(`Business ${index + 1} has an invalid ${field.replaceAll('_', ' ')}.`);
    }
    return value[field].trim() || null;
  };
  return {
    lead_id: leadId,
    business_name: businessName,
    website_url: website.href,
    canonical_url: website.href,
    category: optional('category', 120),
    city: optional('city', 120),
    state: optional('state', 120),
    country: optional('country', 120),
  };
}

function scanTaskStatus(status) {
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'queued';
  return 'skipped';
}

function csvCell(value) {
  let clean = String(value ?? '');
  if (/^[\u0000-\u0020]*[=+\-@]/.test(clean)) clean = `'${clean}`;
  return `"${clean.replaceAll('"', '""')}"`;
}

export function createWebsiteDiscoveryJobs({ db, discovery, createContact, verifyCandidate = null, schedule = setImmediate, now = Date.now } = {}) {
  if (!db || !discovery || typeof discovery.scanLead !== 'function' || typeof createContact !== 'function') {
    throw new TypeError('Database, website discovery, and contact creation services are required.');
  }
  if (verifyCandidate !== null && typeof verifyCandidate !== 'function') throw new TypeError('Email verification service must be a function.');

  let draining = false;
  let closed = false;

  const getJobSelect = `SELECT j.*,
      (SELECT COUNT(*) FROM website_discovery_tasks t WHERE t.job_id=j.id AND t.status='completed') AS completed_count,
      (SELECT COUNT(*) FROM website_discovery_tasks t WHERE t.job_id=j.id AND t.status='blocked') AS blocked_count,
      (SELECT COUNT(*) FROM website_discovery_tasks t WHERE t.job_id=j.id AND t.status='failed') AS failed_count,
      (SELECT COUNT(*) FROM website_discovery_tasks t WHERE t.job_id=j.id AND t.status='skipped') AS skipped_count,
      (SELECT COUNT(*) FROM website_discovery_tasks t WHERE t.job_id=j.id AND t.status='queued') AS queued_count,
      (SELECT COUNT(*) FROM website_discovery_tasks t WHERE t.job_id=j.id AND t.status='running') AS running_count,
      (SELECT COUNT(*) FROM website_discovery_email_checks c WHERE c.job_id=j.id AND c.status='queued') AS verification_queued_count,
      (SELECT COUNT(*) FROM website_discovery_email_checks c WHERE c.job_id=j.id AND c.status='running') AS verification_running_count,
      (SELECT COUNT(*) FROM website_discovery_email_checks c WHERE c.job_id=j.id AND c.status='failed') AS verification_failed_count
    FROM website_discovery_jobs j`;
  const getJobRow = db.prepare(`${getJobSelect} WHERE j.id=?`);
  function rateLimitDeadlineForTask(task) {
    const candidates = [task.scan_retry_after_at].filter(value => Number.isFinite(Date.parse(value)));
    try {
      const hostname = normalizeWebsiteUrl(task.canonical_url || task.website_url).hostname.toLowerCase();
      const hostCooldown = db.prepare('SELECT not_before FROM website_host_cooldowns WHERE hostname=?').get(hostname);
      if (hostCooldown && Number.isFinite(Date.parse(hostCooldown.not_before))) candidates.push(hostCooldown.not_before);
    } catch { /* A malformed saved target cannot produce a retry action. */ }
    return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  }
  const sourceRefreshHistory = db.prepare(`SELECT r.generation,r.status AS refresh_status,
      p.outcome,p.observed_at AS page_observed_at,p.content_hash AS page_content_hash,o.state,
      o.prior_content_hash,o.prior_raw_excerpt,o.prior_extractor_version,
      o.content_hash AS current_content_hash,o.raw_excerpt AS current_raw_excerpt,
      o.extractor_version AS current_extractor_version,o.observed_at AS email_observed_at
    FROM lead_website_email_refreshes r
    LEFT JOIN lead_website_email_refresh_pages p
      ON p.refresh_id=r.id AND p.source_url=? AND p.fetch_mode=?
    LEFT JOIN lead_website_email_refresh_observations o
      ON o.refresh_id=r.id AND o.lead_email_id=? AND o.source_url=? AND o.fetch_mode=?
    WHERE r.lead_id=? ORDER BY r.generation DESC LIMIT 20`);

  const candidateEmailsForLead = db.prepare(`SELECT le.id AS lead_email_id,le.email,le.verification_status,le.verified_at,
      (SELECT ev.source_url FROM lead_email_source_evidence ev WHERE ev.lead_email_id=le.id
        AND (le.source='website_scan' OR ev.evidence_type IN ('website_html','mailto','visible_text'))
        ORDER BY ev.observed_at DESC,ev.id DESC LIMIT 1) AS source_url
    FROM lead_emails le
    WHERE le.lead_id=? AND EXISTS (
      SELECT 1 FROM lead_email_source_evidence ev WHERE ev.lead_email_id=le.id
        AND (le.source='website_scan' OR ev.evidence_type IN ('website_html','mailto','visible_text'))
    ) ORDER BY le.id`);
  const insertVerificationCheck = db.prepare(`INSERT OR IGNORE INTO website_discovery_email_checks
      (job_id,lead_id,lead_email_id,normalized_email,source_url,status,verification_status,error_code,completed_at)
    VALUES(?,?,?,?,?,?,?,?,CASE WHEN ? IN ('completed','suppressed','cancelled') THEN datetime('now') ELSE NULL END)`);

  function enqueueCandidates(jobId, leadId) {
    if (!verifyCandidate) return 0;
    const job = db.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(jobId);
    if (!job) return 0;
    let queued = 0;
    for (const candidate of candidateEmailsForLead.all(leadId)) {
      const normalizedEmail = String(candidate.email || '').trim().toLowerCase();
      if (!normalizedEmail || !candidate.source_url) continue;
      const isSuppressed = Boolean(db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1').get(normalizedEmail));
      const existingStatus = String(candidate.verification_status || '').toLowerCase();
      const decided = Boolean(candidate.verified_at) && VERIFICATION_STATUSES.has(existingStatus);
      const status = isSuppressed ? 'suppressed'
        : ['cancel_requested', 'cancelled'].includes(job.status) ? 'cancelled'
          : decided ? 'completed' : 'queued';
      const resultStatus = status === 'completed' ? existingStatus : null;
      const errorCode = status === 'suppressed' ? 'address_suppressed' : null;
      const result = insertVerificationCheck.run(jobId, leadId, candidate.lead_email_id, normalizedEmail,
        candidate.source_url, status, resultStatus, errorCode, status);
      queued += result.changes;
    }
    return queued;
  }

  function findExistingLead(batchId, canonicalUrl) {
    const leads = db.prepare('SELECT id,website_url FROM leads WHERE batch_id=? AND website_url IS NOT NULL ORDER BY id').all(batchId);
    for (const lead of leads) {
      try {
        if (normalizeWebsiteUrl(lead.website_url).href === canonicalUrl) return lead;
      } catch { /* Existing malformed operator data is not a match. */ }
    }
    return null;
  }

  function createJob({ batch_id, businesses, source = 'website_seed', sourceContext = null } = {}) {
    const batchId = Number(batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new WebsiteDiscoveryJobError('Choose an existing open batch.');
    if (!Array.isArray(businesses) || businesses.length < 1) {
      throw new WebsiteDiscoveryJobError('Add at least one business website.');
    }
    if (!['website_seed', 'searxng_search', 'epch_directory'].includes(source)) throw new WebsiteDiscoveryJobError('This collection lane is not available.');
    const seeds = businesses.map(normalizeSeed);
    const searchEvidenceByUrl = new Map();
    let directoryHandoffContext = null;
    if (source === 'searxng_search') {
      if (!sourceContext || !Number.isSafeInteger(Number(sourceContext.searchJobId)) || Number(sourceContext.searchJobId) < 1
        || typeof sourceContext.query !== 'string' || !Array.isArray(sourceContext.results)) {
        throw new WebsiteDiscoveryJobError('Search result provenance is missing.', 422, 'search_provenance_missing');
      }
      for (const item of sourceContext.results) {
        try {
          const canonicalUrl = normalizeWebsiteUrl(item.website_url || item.url).href;
          const searchJobId = Number(item.search_job_id ?? sourceContext.searchJobId);
          const query = typeof item.query === 'string' && item.query.trim() ? item.query.trim() : sourceContext.query;
          const seedLeadId = Number(item.seed_lead_id ?? sourceContext.seedLeadId) || null;
          if (Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0
            && Number.isSafeInteger(searchJobId) && searchJobId > 0 && typeof query === 'string') {
            searchEvidenceByUrl.set(canonicalUrl, { ...item, query, search_job_id: searchJobId, seed_lead_id: seedLeadId });
          }
        } catch { /* Invalid search results are rejected below when matched to a seed. */ }
      }
      if (seeds.some(seed => !searchEvidenceByUrl.has(seed.canonical_url))) {
        throw new WebsiteDiscoveryJobError('A selected website has no matching SearXNG result evidence.', 422, 'search_provenance_missing');
      }
    }
    if (source === 'epch_directory') {
      const directoryJobId = Number(sourceContext?.directoryJobId);
      const leadDiscoveryJobId = Number(sourceContext?.leadDiscoveryJobId);
      const leadDiscoverySourceRunId = Number(sourceContext?.leadDiscoverySourceRunId);
      if (!Number.isSafeInteger(directoryJobId) || directoryJobId < 1
        || !Number.isSafeInteger(leadDiscoveryJobId) || leadDiscoveryJobId < 1
        || !Number.isSafeInteger(leadDiscoverySourceRunId) || leadDiscoverySourceRunId < 1
        || seeds.length !== 1 || seeds.some(seed => seed.lead_id === null)) {
        throw new WebsiteDiscoveryJobError('Directory website provenance is missing.', 422, 'directory_provenance_missing');
      }
      const sourceRun = db.prepare(`SELECT 1 FROM lead_discovery_source_runs r JOIN lead_discovery_jobs j ON j.id=r.job_id
        WHERE r.id=? AND r.job_id=? AND r.directory_job_id=? AND r.source_type='epch_directory' AND j.batch_id=?`).get(
        leadDiscoverySourceRunId, leadDiscoveryJobId, directoryJobId, batchId);
      if (!sourceRun) throw new WebsiteDiscoveryJobError('This directory result is not attached to the selected discovery run.', 422, 'directory_provenance_missing');
      directoryHandoffContext = { directoryJobId, leadDiscoveryJobId, leadDiscoverySourceRunId };
      for (const seed of seeds) {
        const evidence = db.prepare(`SELECT 1 FROM epch_directory_records r
          JOIN epch_directory_jobs j ON j.id=r.job_id JOIN leads l ON l.id=r.lead_id
          WHERE r.job_id=? AND r.lead_id=? AND r.status='imported' AND j.batch_id=? AND l.batch_id=?
            AND lower(trim(l.website_url))=? LIMIT 1`).get(directoryJobId, seed.lead_id, batchId, batchId, seed.canonical_url);
        if (!evidence) throw new WebsiteDiscoveryJobError('This website is not part of the selected directory results.', 422, 'directory_provenance_missing');
      }
    }
    const unique = new Map();
    let duplicateCount = 0;
    for (const seed of seeds) {
      const seedKey = seed.lead_id === null ? `website:${seed.canonical_url}` : `lead:${seed.lead_id}`;
      if (unique.has(seedKey)) { duplicateCount += 1; continue; }
      unique.set(seedKey, seed);
    }

    const jobId = db.transaction(() => {
      const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
      if (!batch) throw new WebsiteDiscoveryJobError('Batch not found.', 404, 'batch_missing');
      if (batch.status !== 'open') throw new WebsiteDiscoveryJobError('Businesses can only be added to an open batch.', 409, 'batch_closed');
      if (directoryHandoffContext) {
        const existing = db.prepare(`SELECT website_job_id FROM lead_discovery_directory_scan_handoffs
          WHERE job_id=? AND lead_id=?`).get(directoryHandoffContext.leadDiscoveryJobId, seeds[0].lead_id);
        if (existing) return Number(existing.website_job_id);
      }
      const created = db.prepare(`INSERT INTO website_discovery_jobs(batch_id,status,source,task_count,duplicate_count)
        VALUES(?,'queued',?,?,?)`).run(batchId, source, unique.size, duplicateCount);
      const id = Number(created.lastInsertRowid);
      const insertTask = db.prepare(`INSERT INTO website_discovery_tasks
        (job_id,lead_id,canonical_url,status,attempt_count,error_code,found_count)
        VALUES(?,?,?,?,?,?,?)`);
      const insertSearchEvidence = db.prepare(`INSERT INTO lead_profile_source_evidence
        (lead_id,source_url,source_key,evidence_type,raw_excerpt,content_hash,extractor_version)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(lead_id,source_key) DO NOTHING`);
      for (const seed of unique.values()) {
        let lead = null;
        if (seed.lead_id !== null) {
          lead = db.prepare('SELECT id,website_url FROM leads WHERE id=? AND batch_id=?').get(seed.lead_id, batchId) || null;
          if (!lead) throw new WebsiteDiscoveryJobError('This contact is no longer in the selected batch.', 409, 'lead_not_in_batch');
          let savedCanonicalUrl;
          try { savedCanonicalUrl = normalizeWebsiteUrl(lead.website_url).href; }
          catch { throw new WebsiteDiscoveryJobError('This contact no longer has a scannable public website.', 409, 'lead_website_changed'); }
          if (savedCanonicalUrl !== seed.canonical_url) {
            throw new WebsiteDiscoveryJobError('This contact’s website changed. Refresh the directory record before scanning.', 409, 'lead_website_changed');
          }
        } else {
          lead = findExistingLead(batchId, seed.canonical_url);
        }
        const searchEvidence = source === 'searxng_search' ? searchEvidenceByUrl.get(seed.canonical_url) : null;
        if (!lead) {
          const createdLead = createContact({
            batch_id: batchId,
            business_name: seed.business_name,
            website_url: seed.website_url,
            category: seed.category,
            city: seed.city,
            state: seed.state,
            country: seed.country,
          });
          lead = { id: Number(createdLead.contact.id) };
          const sourceDetails = source === 'searxng_search'
            ? `Public business website candidate found by SearXNG${searchEvidence.seed_lead_id ? ` similar-company search from contact #${Number(searchEvidence.seed_lead_id)}` : ''} query: ${searchEvidence.query}. Search result: ${searchEvidence.title}`
            : source === 'epch_directory'
              ? `Public business website linked from an imported EPCH directory record (directory job ${Number(sourceContext.directoryJobId)}); contact details remain subject to review and verification.`
              : 'Operator-supplied public business website seed; extracted addresses require review and separate verification.';
          db.prepare(`UPDATE leads SET source=?,source_url=?,source_details=? WHERE id=?`)
            .run(source === 'searxng_search' ? 'searxng_search' : 'website_discovery',
              source === 'searxng_search' ? searchEvidence.url : seed.canonical_url, sourceDetails, lead.id);
          const creationEvent = db.prepare(`SELECT id,meta_json FROM events WHERE lead_id=? AND event_type='contact_created' ORDER BY id DESC LIMIT 1`).get(lead.id);
          if (creationEvent) {
            let meta = {};
            try { meta = JSON.parse(creationEvent.meta_json || '{}'); } catch { /* Preserve a valid object below. */ }
            meta.source = source === 'searxng_search' ? 'searxng_search' : 'website_discovery';
            if (source === 'searxng_search') {
              meta.search_job_id = Number(searchEvidence.search_job_id);
              if (searchEvidence.seed_lead_id) meta.seed_lead_id = Number(searchEvidence.seed_lead_id);
            }
            db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify(meta), creationEvent.id);
          }
        }
        if (source === 'searxng_search') {
          const excerpt = [searchEvidence.seed_lead_id ? `Similar-company seed contact: #${Number(searchEvidence.seed_lead_id)}` : '',
            `Search query: ${searchEvidence.query}`, searchEvidence.title, searchEvidence.snippet].filter(Boolean).join('\n').slice(0, 1000);
          const fingerprint = createHash('sha256').update(JSON.stringify({
            query: searchEvidence.query, result_url: searchEvidence.url, title: searchEvidence.title, snippet: searchEvidence.snippet,
          })).digest('hex');
          insertSearchEvidence.run(lead.id, searchEvidence.url, `searxng_search_${Number(searchEvidence.search_job_id)}_${Number(searchEvidence.id)}`,
            'search_result', excerpt, fingerprint, 'searxng-json-v1');
        }
        const previous = discovery.getLeadScan?.(lead.id) || null;
        const initialStatus = previous ? (previous.status === 'completed' ? 'skipped' : scanTaskStatus(previous.status)) : 'queued';
        const errorCode = previous ? (previous.error_code || `existing_scan_${previous.status}`) : null;
        const foundCount = previous?.found_count || 0;
        insertTask.run(id, lead.id, seed.canonical_url, initialStatus, previous?.status === 'interrupted' ? 1 : 0, errorCode, foundCount);
        // A repeat job may reuse a completed scan. Reuse its saved source
        // evidence and queue only addresses that have not already been checked.
        enqueueCandidates(id, lead.id);
        if (directoryHandoffContext) {
          db.prepare(`INSERT INTO lead_discovery_directory_scan_handoffs(job_id,source_run_id,lead_id,website_job_id,status)
            VALUES(?,?,?,?,'running')`).run(directoryHandoffContext.leadDiscoveryJobId,
            directoryHandoffContext.leadDiscoverySourceRunId, lead.id, id);
        }
      }
      db.prepare(`UPDATE batches SET lead_count=(SELECT COUNT(*) FROM leads WHERE batch_id=?) WHERE id=?`).run(batchId, batchId);
      return id;
    })();
    schedule(() => { void drain(); });
    settleJob(jobId);
    return getJob(jobId);
  }

  function listJobs({ batch_id, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const batchId = batch_id === undefined || batch_id === null || batch_id === '' ? null : Number(batch_id);
    const rows = batchId === null
      ? db.prepare(`${getJobSelect} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).all(safeLimit)
      : db.prepare(`${getJobSelect} WHERE j.batch_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).all(batchId, safeLimit);
    return rows;
  }

  function getJob(jobIdInput, { offset = 0, limit = MAX_TASK_PAGE_SIZE } = {}) {
    const id = Number(jobIdInput);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    // A worker can persist terminal task and verification rows just before a
    // restart or coordinator handoff leaves the parent marker stale. Reconcile
    // that derived state whenever a caller reads the durable job.
    settleJob(id);
    const taskOffset = Number.isSafeInteger(Number(offset)) ? Math.max(0, Number(offset)) : 0;
    const taskLimit = Number.isSafeInteger(Number(limit)) ? Math.max(1, Math.min(MAX_TASK_PAGE_SIZE, Number(limit))) : MAX_TASK_PAGE_SIZE;
    const job = getJobRow.get(id);
    if (!job) return null;
      const rows = db.prepare(`SELECT t.*,l.business_name,l.website_url,l.category,l.address,l.city,l.state,l.country,l.phone,l.facebook_url,
        s.status AS scan_status,s.page_count,s.found_count AS scan_found_count,s.error_code AS scan_error_code,
        s.retry_after_at AS scan_retry_after_at,
        s.pending_paths_json AS scan_pending_paths_json
      FROM website_discovery_tasks t JOIN leads l ON l.id=t.lead_id
      LEFT JOIN lead_website_email_scans s ON s.lead_id=l.id
      WHERE t.job_id=? ORDER BY t.id LIMIT ? OFFSET ?`).all(id, taskLimit, taskOffset);
    const tasks = rows.map(task => {
      const emails = db.prepare(`SELECT le.id AS lead_email_id,le.email,le.verification_status,le.is_free_provider,ev.id AS evidence_id,ev.source_url,
          ev.evidence_type,ev.raw_excerpt,ev.content_hash,ev.extractor_version,ev.observed_at,
          vc.status AS verification_check_status,vc.verification_status AS discovery_verification_status,
          vc.error_code AS verification_error_code,vc.attempt_count AS verification_attempt_count
        FROM lead_emails le JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
        LEFT JOIN website_discovery_email_checks vc
          ON vc.job_id=? AND vc.normalized_email=lower(trim(le.email))
        WHERE le.lead_id=? AND (le.source='website_scan' OR ev.evidence_type IN ('website_html','mailto','visible_text'))
        ORDER BY ev.observed_at DESC,le.id LIMIT 500`).all(id, task.lead_id);
      for (const email of emails) {
        const fetchMode = String(email.evidence_type || '').startsWith('rendered_') ? 'rendered' : 'http';
        const history = sourceRefreshHistory.all(email.source_url, fetchMode, email.lead_email_id,
          email.source_url, fetchMode, task.lead_id);
        email.refresh_history = history.map(row => ({
          generation: row.generation, status: row.refresh_status, outcome: row.outcome || 'not_rechecked',
          state: row.outcome === 'fetched' ? row.state || 'not_rechecked' : row.outcome || 'not_rechecked',
          observed_at: row.email_observed_at || row.page_observed_at || null,
          page_content_hash: row.page_content_hash || null,
          prior_content_hash: row.prior_content_hash || null, prior_excerpt: row.prior_raw_excerpt || null,
          prior_extractor_version: row.prior_extractor_version || null,
          current_content_hash: row.current_content_hash || null, current_excerpt: row.current_raw_excerpt || null,
          current_extractor_version: row.current_extractor_version || null,
        }));
        const latest = email.refresh_history[0];
        email.refresh_state = latest?.state || null;
        email.refresh_generation = latest?.generation || null;
        email.refresh_observed_at = latest?.observed_at || null;
      }
      const evidenceIds = [...new Set(emails.map(item => item.evidence_id).filter(Number.isSafeInteger))];
      const contactPoints = evidenceIds.length ? db.prepare(`SELECT evidence_id,contact_type,contact_name,contact_title
        FROM lead_email_contact_point_evidence WHERE evidence_id IN (${evidenceIds.map(() => '?').join(',')})
        ORDER BY id`).all(...evidenceIds) : [];
      const pointsByEvidence = new Map();
      for (const point of contactPoints) {
        if (!pointsByEvidence.has(point.evidence_id)) pointsByEvidence.set(point.evidence_id, []);
        pointsByEvidence.get(point.evidence_id).push({ contact_type: point.contact_type,
          contact_name: point.contact_name, contact_title: point.contact_title });
      }
      for (const email of emails) email.contact_points = pointsByEvidence.get(email.evidence_id) || [];
      const contact_forms = db.prepare(`SELECT source_url,evidence_type,raw_excerpt,content_hash,extractor_version,observed_at
        FROM lead_profile_source_evidence WHERE lead_id=? AND evidence_type='website_contact_form'
        ORDER BY observed_at DESC,id DESC LIMIT 100`).all(task.lead_id);
      const latestRefresh = discovery.getLeadScan(task.lead_id)?.latest_refresh || null;
      const statesByEmail = new Map();
      for (const email of emails) {
        if (email.refresh_generation !== latestRefresh?.generation || !['present', 'not_present'].includes(email.refresh_state)) continue;
        const key = String(email.email || '').toLowerCase();
        if (!statesByEmail.has(key)) statesByEmail.set(key, []);
        statesByEmail.get(key).push(email);
      }
      for (const email of emails) {
        const states = statesByEmail.get(String(email.email || '').toLowerCase()) || [];
        const present = states.filter(item => item.refresh_state === 'present');
        const absent = states.filter(item => item.refresh_state === 'not_present');
        email.source_conflict = present.length && absent.length ? {
          generation: latestRefresh.generation,
          present_sources: [...new Set(present.map(item => item.source_url))],
          absent_sources: [...new Set(absent.map(item => item.source_url))],
        } : null;
      }
      const hasPending = hasPendingPaths(task.scan_pending_paths_json);
      const retryAfterAt = rateLimitDeadlineForTask(task);
      const retryableNetworkFailure = task.status === 'failed' && task.scan_status === 'failed'
        && isRetryableWebsiteError(task.scan_error_code)
        && (task.page_count === 0 || hasPending)
        && (task.scan_error_code !== 'scan_request_budget_reached' || hasPending);
      const retryableRateLimit = task.status === 'blocked' && task.scan_status === 'blocked'
        && RATE_LIMIT_ERRORS.has(task.scan_error_code) && retryAfterAt
        && Date.parse(retryAfterAt) <= Number(now());
      return { ...task, retryable: Boolean(retryableNetworkFailure || retryableRateLimit), retry_after_at: retryAfterAt,
        latest_refresh: latestRefresh,
        emails, contact_forms };
    });
    const verification = db.prepare(`SELECT
        SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status='completed' AND verification_status='deliverable' THEN 1 ELSE 0 END) AS deliverable,
        SUM(CASE WHEN status='completed' AND verification_status='risky' THEN 1 ELSE 0 END) AS risky,
        SUM(CASE WHEN status='completed' AND verification_status='unknown' THEN 1 ELSE 0 END) AS unknown,
        SUM(CASE WHEN status='completed' AND verification_status='undeliverable' THEN 1 ELSE 0 END) AS undeliverable,
        SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END) AS suppressed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM website_discovery_email_checks WHERE job_id=?`).get(id);
    return {
      ...job,
      task_pagination: {
        offset: taskOffset,
        limit: taskLimit,
        total: job.task_count,
        hasMore: taskOffset + tasks.length < job.task_count,
      },
      progress: {
        total: job.task_count,
        completed: job.completed_count,
        blocked: job.blocked_count,
        failed: job.failed_count,
        skipped: job.skipped_count,
        queued: job.queued_count,
        running: job.running_count,
        found_emails: db.prepare(`SELECT COUNT(DISTINCT lower(trim(le.email))) AS count
          FROM website_discovery_tasks t JOIN lead_emails le ON le.lead_id=t.lead_id
          JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
          WHERE t.job_id=? AND (le.source='website_scan' OR ev.evidence_type IN ('website_html','mailto','visible_text'))`).get(id).count,
        verification: Object.fromEntries(Object.entries(verification).map(([key, value]) => [key, Number(value || 0)])),
      },
      tasks,
    };
  }

  function exportCsv(jobIdInput) {
    const id = Number(jobIdInput);
    if (!Number.isSafeInteger(id) || id < 1 || !db.prepare('SELECT 1 FROM website_discovery_jobs WHERE id=?').get(id)) return null;
    const header = ['business_name', 'website_url', 'category', 'city', 'state', 'country', 'email', 'verification_status',
      'source_url', 'evidence_type', 'source_excerpt', 'content_hash', 'extractor_version', 'observed_at',
      'contact_type', 'contact_name', 'contact_title', 'business_phone', 'facebook_profile_url', 'business_address',
      'contact_form_available', 'contact_form_source_urls', 'contact_form_evidence', 'contact_form_content_hashes',
      'contact_form_extractor_versions', 'contact_form_observed_at', 'source_refresh_state', 'source_refresh_generation',
      'source_refresh_observed_at', 'latest_refresh_status', 'latest_refresh_generation', 'source_refresh_history',
      'source_conflict', 'verification_check_status', 'discovery_verification_result', 'verification_error_code'];
    const tasks = db.prepare(`SELECT l.id,l.business_name,l.website_url,l.category,l.address,l.city,l.state,l.country,l.phone,l.facebook_url
      FROM website_discovery_tasks t JOIN leads l ON l.id=t.lead_id WHERE t.job_id=? ORDER BY t.id`).all(id);
    const rows = [header];
    for (const task of tasks) {
      const latestRefresh = discovery.getLeadScan(task.id)?.latest_refresh || null;
      const contactForms = db.prepare(`SELECT source_url,raw_excerpt,content_hash,extractor_version,observed_at
        FROM lead_profile_source_evidence WHERE lead_id=? AND evidence_type='website_contact_form'
        ORDER BY observed_at DESC,id DESC LIMIT 100`).all(task.id);
      const contactFormSources = contactForms.map(item => item.source_url).filter(Boolean).join(' | ');
      const contactFormExcerpt = contactForms.map(item => item.raw_excerpt).filter(Boolean).join(' | ');
      const contactFormHashes = contactForms.map(item => item.content_hash).filter(Boolean).join(' | ');
      const contactFormVersions = contactForms.map(item => item.extractor_version).filter(Boolean).join(' | ');
      const contactFormObservedAt = contactForms.map(item => item.observed_at).filter(Boolean).join(' | ');
      const contactFormCsv = [contactForms.length ? 'yes' : 'no', contactFormSources, contactFormExcerpt,
        contactFormHashes, contactFormVersions, contactFormObservedAt];
      const evidence = db.prepare(`SELECT le.id AS lead_email_id,le.email,le.verification_status,ev.id AS evidence_id,ev.source_url,ev.evidence_type,ev.raw_excerpt,
          ev.content_hash,ev.extractor_version,ev.observed_at,vc.status AS verification_check_status,
          vc.verification_status AS discovery_verification_status,vc.error_code AS verification_error_code
        FROM lead_emails le JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id
        LEFT JOIN website_discovery_email_checks vc
          ON vc.job_id=? AND vc.normalized_email=lower(trim(le.email))
        WHERE le.lead_id=? AND (le.source='website_scan' OR ev.evidence_type IN ('website_html','mailto','visible_text')) ORDER BY le.id,ev.id`).all(id, task.id);
      const historyByEvidence = new Map();
      const statesByEmail = new Map();
      for (const item of evidence) {
        const fetchMode = String(item.evidence_type || '').startsWith('rendered_') ? 'rendered' : 'http';
        const history = sourceRefreshHistory.all(item.source_url, fetchMode, item.lead_email_id,
          item.source_url, fetchMode, task.id).map(row => ({
          generation: row.generation, status: row.refresh_status, outcome: row.outcome || 'not_rechecked',
          state: row.outcome === 'fetched' ? row.state || 'not_rechecked' : row.outcome || 'not_rechecked',
          observed_at: row.email_observed_at || row.page_observed_at || null,
          page_content_hash: row.page_content_hash || null,
          prior_content_hash: row.prior_content_hash || null, prior_excerpt: row.prior_raw_excerpt || null,
          prior_extractor_version: row.prior_extractor_version || null,
          current_content_hash: row.current_content_hash || null, current_excerpt: row.current_raw_excerpt || null,
          current_extractor_version: row.current_extractor_version || null,
        }));
        historyByEvidence.set(item.evidence_id, history);
        const latest = history[0];
        if (latest && latest.generation === latestRefresh?.generation && ['present', 'not_present'].includes(latest.state)) {
          const key = String(item.email || '').toLowerCase();
          if (!statesByEmail.has(key)) statesByEmail.set(key, new Set());
          statesByEmail.get(key).add(latest.state);
        }
      }
      const conflicts = new Set([...statesByEmail.entries()]
        .filter(([, states]) => states.has('present') && states.has('not_present')).map(([email]) => email));
      const evidenceIds = [...new Set(evidence.map(item => item.evidence_id).filter(Number.isSafeInteger))];
      const contactPoints = evidenceIds.length ? db.prepare(`SELECT evidence_id,contact_type,contact_name,contact_title
        FROM lead_email_contact_point_evidence WHERE evidence_id IN (${evidenceIds.map(() => '?').join(',')}) ORDER BY id`).all(...evidenceIds) : [];
      const pointsByEvidence = new Map();
      for (const point of contactPoints) {
        if (!pointsByEvidence.has(point.evidence_id)) pointsByEvidence.set(point.evidence_id, []);
        pointsByEvidence.get(point.evidence_id).push(point);
      }
      const contacts = evidence.length ? evidence : [null];
      for (const item of contacts) {
        const history = item ? historyByEvidence.get(item.evidence_id) || [] : [];
        const refresh = history[0];
        const refreshState = refresh?.state || '';
        const sourceConflict = item && conflicts.has(String(item.email || '').toLowerCase()) ? 'yes' : 'no';
        const points = pointsByEvidence.get(item?.evidence_id) || [null];
        for (const point of points) rows.push([
          task.business_name, task.website_url, task.category, task.city, task.state, task.country,
          item?.email, item?.verification_status, item?.source_url, item?.evidence_type, item?.raw_excerpt,
          item?.content_hash, item?.extractor_version, item?.observed_at, point?.contact_type, point?.contact_name,
          point?.contact_title, task.phone, task.facebook_url, task.address, ...contactFormCsv,
          refreshState, refresh?.generation, refresh?.observed_at, latestRefresh?.status, latestRefresh?.generation,
          JSON.stringify(history), sourceConflict, item?.verification_check_status,
          item?.discovery_verification_status, item?.verification_error_code,
        ]);
      }
    }
    return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  function finalizeControl(jobId) {
    const job = db.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(jobId);
    if (!job) return null;
    if (job.status === 'cancel_requested') {
      db.prepare(`UPDATE website_discovery_tasks SET status='cancelled',completed_at=datetime('now'),error_code='job_cancelled'
        WHERE job_id=? AND status='queued'`).run(jobId);
      db.prepare(`UPDATE website_discovery_email_checks SET status='cancelled',error_code='job_cancelled',
        completed_at=datetime('now'),updated_at=datetime('now') WHERE job_id=? AND status='queued'`).run(jobId);
      db.prepare(`UPDATE website_discovery_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(jobId);
      return 'cancelled';
    }
    if (job.status === 'pause_requested') {
      db.prepare(`UPDATE website_discovery_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(jobId);
      return 'paused';
    }
    return null;
  }

  function settleJob(jobId) {
    const job = getJobRow.get(jobId);
    if (!job || job.queued_count || job.running_count || job.verification_queued_count || job.verification_running_count
      || ['paused', 'pause_requested', 'cancel_requested', 'cancelled'].includes(job.status)) return;
    const terminal = job.blocked_count || job.failed_count || job.verification_failed_count ? 'partial' : 'completed';
    db.prepare(`UPDATE website_discovery_jobs SET status=?,finished_at=COALESCE(finished_at,datetime('now')),
      updated_at=datetime('now') WHERE id=?`).run(terminal, jobId);
  }

  const claimNext = db.transaction(() => {
    const controlJobs = db.prepare(`SELECT id FROM website_discovery_jobs WHERE status IN ('pause_requested','cancel_requested') ORDER BY id`).all();
    for (const job of controlJobs) finalizeControl(job.id);
    const row = db.prepare(`SELECT t.id AS task_id,t.job_id,t.lead_id,t.attempt_count,j.status AS job_status
      FROM website_discovery_tasks t JOIN website_discovery_jobs j ON j.id=t.job_id
      WHERE t.status='queued' AND j.status IN ('queued','running') ORDER BY j.id,t.id LIMIT 1`).get();
    if (row) {
      const claimed = db.prepare(`UPDATE website_discovery_tasks SET status='running',attempt_count=attempt_count+1,
        started_at=COALESCE(started_at,datetime('now')),completed_at=NULL,error_code=NULL
        WHERE id=? AND status='queued'`).run(row.task_id).changes;
      if (!claimed) return null;
      db.prepare(`UPDATE website_discovery_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),
        updated_at=datetime('now') WHERE id=? AND status='queued'`).run(row.job_id);
      return { ...row, kind: 'website', attempt_count: row.attempt_count + 1 };
    }
    if (!verifyCandidate) return null;
    const candidate = db.prepare(`SELECT c.id AS check_id,c.job_id,c.lead_id,c.lead_email_id,c.normalized_email,
        c.source_url,c.attempt_count,j.status AS job_status
      FROM website_discovery_email_checks c JOIN website_discovery_jobs j ON j.id=c.job_id
      WHERE c.status='queued' AND j.status IN ('queued','running','completed','partial') ORDER BY j.id,c.id LIMIT 1`).get();
    if (!candidate) return null;
    const claimed = db.prepare(`UPDATE website_discovery_email_checks SET status='running',attempt_count=attempt_count+1,
      started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now'),error_code=NULL
      WHERE id=? AND status='queued'`).run(candidate.check_id).changes;
    if (!claimed) return null;
    db.prepare(`UPDATE website_discovery_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),
      updated_at=datetime('now') WHERE id=? AND status='queued'`).run(candidate.job_id);
    return { ...candidate, kind: 'verification', attempt_count: candidate.attempt_count + 1 };
  });

  function finishTask(task, scanResult, errorCode = null) {
    const scan = scanResult?.scan || discovery.getLeadScan?.(task.lead_id) || null;
    let status = scan ? scanTaskStatus(scan.status) : 'failed';
    if (status === 'queued') status = 'failed';
    const found = Number(scan?.found_count ?? scanResult?.foundCount ?? scanResult?.emails?.length ?? 0);
    db.prepare(`UPDATE website_discovery_tasks SET status=?,completed_at=datetime('now'),error_code=?,found_count=?
      WHERE id=?`).run(status, errorCode || scan?.error_code || null, found, task.task_id);
    enqueueCandidates(task.job_id, task.lead_id);
    finalizeControl(task.job_id);
    const counts = getJobRow.get(task.job_id);
    if (!counts) return;
    if (counts.status === 'pause_requested' || counts.status === 'cancel_requested' || counts.status === 'paused' || counts.status === 'cancelled') return;
    if (!counts.queued_count && !counts.running_count) settleJob(task.job_id);
    else {
      db.prepare(`UPDATE website_discovery_jobs SET status='running',updated_at=datetime('now') WHERE id=?`).run(task.job_id);
    }
  }

  function validStoredVerification(row) {
    const status = String(row?.verification_status || '').toLowerCase();
    return Boolean(row?.verified_at) && VERIFICATION_STATUSES.has(status) ? status : null;
  }

  function finishVerification(check, { status, verificationStatus = null, errorCode = null }) {
    db.prepare(`UPDATE website_discovery_email_checks SET status=?,verification_status=?,error_code=?,
      completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .run(status, verificationStatus, errorCode, check.check_id);
    finalizeControl(check.job_id);
    settleJob(check.job_id);
  }

  function safeVerifierErrorCode(error) {
    const candidate = String(error?.code || 'verification_failed').toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    return /^[a-z][a-z0-9_]*$/.test(candidate) ? candidate : 'verification_failed';
  }

  async function processVerification(check) {
    const emailRow = db.prepare('SELECT id,email,verification_status,verified_at FROM lead_emails WHERE id=?').get(check.lead_email_id);
    if (!emailRow) {
      finishVerification(check, { status: 'failed', errorCode: 'candidate_missing' });
      return;
    }
    if (db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1').get(check.normalized_email)) {
      finishVerification(check, { status: 'suppressed', errorCode: 'address_suppressed' });
      return;
    }
    const savedStatus = validStoredVerification(emailRow);
    if (savedStatus) {
      finishVerification(check, { status: 'completed', verificationStatus: savedStatus });
      return;
    }
    try {
      const result = await verifyCandidate(check.lead_email_id, {
        jobId: check.job_id, leadId: check.lead_id, email: emailRow.email, sourceUrl: check.source_url,
      });
      const persisted = db.prepare(`SELECT verification_status,verified_at,confidence_score,is_catch_all,is_role_account,
          is_free_provider,is_disposable,mx_host,verification_json
        FROM lead_emails WHERE id=?`).get(check.lead_email_id);
      const verificationStatus = validStoredVerification(persisted);
      if (!verificationStatus) {
        throw Object.assign(new Error('Verifier result was not saved.'), { code: 'verification_result_not_saved' });
      }
      if (result?.verification_status && VERIFICATION_STATUSES.has(String(result.verification_status).toLowerCase())
        && String(result.verification_status).toLowerCase() !== verificationStatus) {
        throw Object.assign(new Error('Verifier result did not match the saved result.'), { code: 'verification_result_mismatch' });
      }
      // The same address can be attached to more than one business in this job.
      // Copy only this verified address result to those duplicate records.
      db.prepare(`UPDATE lead_emails SET verification_status=?,confidence_score=?,is_catch_all=?,is_role_account=?,
          is_free_provider=?,is_disposable=?,mx_host=?,verification_json=?,verified_at=?
        WHERE lower(trim(email))=? AND lead_id IN (
          SELECT lead_id FROM website_discovery_tasks WHERE job_id=?
        )`).run(verificationStatus, persisted.confidence_score, persisted.is_catch_all, persisted.is_role_account,
          persisted.is_free_provider, persisted.is_disposable, persisted.mx_host, persisted.verification_json,
          persisted.verified_at, check.normalized_email, check.job_id);
      finishVerification(check, { status: 'completed', verificationStatus });
    } catch (error) {
      finishVerification(check, { status: 'failed', errorCode: safeVerifierErrorCode(error) });
    }
  }

  async function drain() {
    if (draining || closed) return;
    draining = true;
    try {
      while (!closed) {
        const task = claimNext();
        if (!task) break;
        if (task.kind === 'verification') {
          await processVerification(task);
          continue;
        }
        try {
          const result = await discovery.scanLead(task.lead_id, { resumeInterrupted: task.attempt_count > 1, retryFailed: task.attempt_count > 1 });
          finishTask(task, result);
        } catch (error) {
          const current = discovery.getLeadScan?.(task.lead_id) || null;
          if (error.code === 'already_scanned' && current) finishTask(task, { scan: current });
          else finishTask(task, null, error.code || 'website_scan_failed');
        }
      }
    } finally {
      draining = false;
      const remaining = db.prepare(`SELECT 1 FROM website_discovery_tasks t JOIN website_discovery_jobs j ON j.id=t.job_id
        WHERE t.status='queued' AND j.status IN ('queued','running')
        UNION ALL
        SELECT 1 FROM website_discovery_email_checks c JOIN website_discovery_jobs j ON j.id=c.job_id
        WHERE c.status='queued' AND j.status IN ('queued','running','completed','partial') LIMIT 1`).get();
      if (remaining && !closed) schedule(() => { void drain(); });
    }
  }

  function pause(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(id);
    if (!job) throw new WebsiteDiscoveryJobError('Discovery job not found.', 404, 'job_missing');
    if (!['queued', 'running', 'pause_requested', 'paused'].includes(job.status)) throw new WebsiteDiscoveryJobError('This discovery job is already finished.', 409, 'job_terminal');
    if (job.status === 'running') db.prepare(`UPDATE website_discovery_jobs SET status='pause_requested',updated_at=datetime('now') WHERE id=?`).run(id);
    else if (job.status !== 'paused') db.prepare(`UPDATE website_discovery_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(id);
    return getJob(id);
  }

  function resume(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(id);
    if (!job) throw new WebsiteDiscoveryJobError('Discovery job not found.', 404, 'job_missing');
    if (!['paused', 'queued'].includes(job.status)) throw new WebsiteDiscoveryJobError('Only a paused discovery job can resume.', 409, 'job_not_paused');
    db.prepare(`UPDATE website_discovery_jobs SET status='queued',finished_at=NULL,updated_at=datetime('now') WHERE id=?`).run(id);
    schedule(() => { void drain(); });
    return getJob(id);
  }

  function cancel(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(id);
    if (!job) throw new WebsiteDiscoveryJobError('Discovery job not found.', 404, 'job_missing');
    if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)) return getJob(id);
    if (job.status === 'running' || job.status === 'cancel_requested') {
      db.prepare(`UPDATE website_discovery_jobs SET status='cancel_requested',updated_at=datetime('now') WHERE id=?`).run(id);
    } else {
      db.prepare(`UPDATE website_discovery_tasks SET status='cancelled',completed_at=datetime('now'),error_code='job_cancelled'
        WHERE job_id=? AND status='queued'`).run(id);
      db.prepare(`UPDATE website_discovery_email_checks SET status='cancelled',completed_at=datetime('now'),
        error_code='job_cancelled',updated_at=datetime('now') WHERE job_id=? AND status='queued'`).run(id);
      db.prepare(`UPDATE website_discovery_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
    }
    schedule(() => { void drain(); });
    return getJob(id);
  }

  function retryTask(jobIdInput, taskIdInput) {
    const jobId = Number(jobIdInput);
    const taskId = Number(taskIdInput);
    const task = db.prepare(`SELECT t.*,s.status AS scan_status,s.page_count,s.error_code AS scan_error_code,
        s.retry_after_at AS scan_retry_after_at,
        s.pending_paths_json AS scan_pending_paths_json
      FROM website_discovery_tasks t JOIN lead_website_email_scans s ON s.lead_id=t.lead_id
      WHERE t.job_id=? AND t.id=?`).get(jobId, taskId);
    if (!task) throw new WebsiteDiscoveryJobError('Failed discovery task not found.', 404, 'task_missing');
    const hasPending = hasPendingPaths(task.scan_pending_paths_json);
    const isRateLimited = task.status === 'blocked' && task.scan_status === 'blocked' && RATE_LIMIT_ERRORS.has(task.scan_error_code);
    const retryAfterAt = isRateLimited ? rateLimitDeadlineForTask(task) : null;
    if (isRateLimited && retryAfterAt && Date.parse(retryAfterAt) > Number(now())) {
      throw new WebsiteDiscoveryJobError(`This host requested a pause until ${retryAfterAt}. Retry is available after that time.`, 429, 'site_cooldown_active');
    }
    const retryableNetworkFailure = task.status === 'failed' && task.scan_status === 'failed'
      && isRetryableWebsiteError(task.scan_error_code)
      && (task.page_count === 0 || hasPending)
      && (task.scan_error_code !== 'scan_request_budget_reached' || hasPending);
    const retryableRateLimit = isRateLimited && retryAfterAt && Date.parse(retryAfterAt) <= Number(now());
    if (!retryableNetworkFailure && !retryableRateLimit) {
      throw new WebsiteDiscoveryJobError('Only a pending scan budget or retryable network failure can be continued safely.', 409, 'task_not_retryable');
    }
    db.transaction(() => {
      db.prepare(`UPDATE website_discovery_tasks SET status='queued',completed_at=NULL,error_code=NULL WHERE id=?`).run(taskId);
      db.prepare(`UPDATE website_discovery_jobs SET status='queued',finished_at=NULL,error_code=NULL,updated_at=datetime('now') WHERE id=?`).run(jobId);
    })();
    schedule(() => { void drain(); });
    return getJob(jobId);
  }

  function retryVerification(jobIdInput) {
    const jobId = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM website_discovery_jobs WHERE id=?').get(jobId);
    if (!job) throw new WebsiteDiscoveryJobError('Discovery job not found.', 404, 'job_missing');
    if (!verifyCandidate) throw new WebsiteDiscoveryJobError('Email checking is not available right now.', 503, 'email_check_unavailable');
    if (!['completed', 'partial'].includes(job.status)) {
      throw new WebsiteDiscoveryJobError('Finish or pause the website scan before retrying email checks.', 409, 'job_not_ready_for_email_retry');
    }
    const retryQueued = db.transaction(() => db.prepare(`UPDATE website_discovery_email_checks
      SET status='queued',verification_status=NULL,error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=datetime('now')
      WHERE job_id=? AND status='failed'`).run(jobId).changes).immediate();
    if (retryQueued) schedule(() => { void drain(); });
    return { job: getJob(jobId), retry_queued: retryQueued };
  }

  function recover() {
    const recovered = db.transaction(() => {
      const runningChecks = db.prepare(`SELECT c.id,c.job_id,c.normalized_email,le.verification_status,le.verified_at
        FROM website_discovery_email_checks c LEFT JOIN lead_emails le ON le.id=c.lead_email_id
        WHERE c.status='running'`).all();
      for (const check of runningChecks) {
        const savedStatus = validStoredVerification(check);
        const suppressed = db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1').get(check.normalized_email);
        if (suppressed) {
          db.prepare(`UPDATE website_discovery_email_checks SET status='suppressed',verification_status=NULL,
            error_code='address_suppressed',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(check.id);
        } else if (savedStatus) {
          db.prepare(`UPDATE website_discovery_email_checks SET status='completed',verification_status=?,error_code=NULL,
            completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(savedStatus, check.id);
        } else {
          db.prepare(`UPDATE website_discovery_email_checks SET status='queued',error_code=NULL,updated_at=datetime('now') WHERE id=?`).run(check.id);
        }
      }
      const runningTasks = db.prepare(`SELECT t.id,t.job_id,t.lead_id,s.status AS scan_status,s.error_code,s.found_count
        FROM website_discovery_tasks t LEFT JOIN lead_website_email_scans s ON s.lead_id=t.lead_id
        WHERE t.status='running'`).all();
      for (const task of runningTasks) {
        if (task.scan_status && ['completed', 'blocked', 'failed'].includes(task.scan_status)) {
          db.prepare(`UPDATE website_discovery_tasks SET status=?,completed_at=datetime('now'),error_code=?,found_count=? WHERE id=?`)
            .run(scanTaskStatus(task.scan_status), task.error_code, task.found_count || 0, task.id);
        } else {
          db.prepare(`UPDATE website_discovery_tasks SET status='queued',error_code=NULL WHERE id=?`).run(task.id);
        }
      }
      const jobs = db.prepare(`SELECT id,status FROM website_discovery_jobs WHERE status IN ('running','pause_requested','cancel_requested')`).all();
      for (const job of jobs) {
        if (job.status === 'pause_requested') db.prepare(`UPDATE website_discovery_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(job.id);
        else if (job.status === 'cancel_requested') finalizeControl(job.id);
        else db.prepare(`UPDATE website_discovery_jobs SET status='queued',updated_at=datetime('now') WHERE id=?`).run(job.id);
      }
      db.prepare(`SELECT id FROM website_discovery_jobs WHERE status IN ('queued','running')`).all()
        .forEach(job => settleJob(job.id));
      return runningTasks.length + runningChecks.length + jobs.length;
    })();
    schedule(() => { void drain(); });
    return recovered;
  }

  function close() { closed = true; }

  return { createJob, listJobs, getJob, exportCsv, pause, resume, cancel, retryTask, retryVerification, recover, close };
}

