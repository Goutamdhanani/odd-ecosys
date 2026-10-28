import { EpchDirectoryError, EPCH_DIRECTORY_EXTRACTOR_VERSION, EPCH_DIRECTORY_SOURCE_URL } from './epch-member-directory.js';
import { normalizeDomain } from './dedup.js';
import { rateLimitDeadline } from './website-email-discovery.js';

const DEFAULT_PAGE_LIMIT = 5;
const MAX_INITIAL_PAGE_LIMIT = 50;
const PAGE_LIMIT_INCREMENT = 5;
const MAX_PAGE_LIMIT = 200;
const MAX_DIRECTORY_RECORDS = 5000;
const RETRYABLE_ERRORS = new Set(['robots_unavailable', 'member_page_unavailable', 'directory_page_unavailable', 'source_rate_limited']);
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mail.com', 'protonmail.com', 'proton.me',
  'zoho.com', 'yandex.com', 'gmx.com', 'fastmail.com',
]);

export class EpchDirectoryJobError extends Error {
  constructor(message, statusCode = 400, code = 'epch_directory_job_error') {
    super(message);
    this.name = 'EpchDirectoryJobError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function csvCell(value) {
  let clean = String(value ?? '');
  if (/^[\u0000-\u0020]*[=+\-@]/.test(clean)) clean = `'${clean}`;
  return `"${clean.replaceAll('"', '""')}"`;
}

function profileKey(value) {
  return String(value || '').trim().toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeLeadDiscoveryFilter(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || profileKey(value.country) !== 'india'
    || !Array.isArray(value.cities) || !value.cities.length || value.cities.length > 10
    || !Array.isArray(value.niches) || !value.niches.length
    || value.niches.some(niche => !['handicraft exporter','handicraft exporters'].includes(profileKey(niche)))) {
    throw new EpchDirectoryJobError('The EPCH source only supports an India handicraft-exporter city search.', 422, 'directory_filter_unsupported');
  }
  const cities = [...new Set(value.cities.map(city => profileKey(city)).filter(Boolean))];
  if (!cities.length) throw new EpchDirectoryJobError('Choose at least one city for the EPCH source.', 422, 'directory_filter_invalid');
  const state = value.state ? profileKey(value.state) : '';
  const excludedDomains = value.exclude_domains === undefined ? [] : value.exclude_domains;
  if (!Array.isArray(excludedDomains) || excludedDomains.length > 1000
    || excludedDomains.some(domain => typeof domain !== 'string' || domain.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain.trim()))) {
    throw new EpchDirectoryJobError('The directory search has an invalid duplicate-domain filter.', 422, 'directory_filter_invalid');
  }
  return { country: 'india', cities, state, niches: ['handicraft exporter'],
    exclude_domains: [...new Set(excludedDomains.map(domain => domain.trim().toLowerCase().replace(/^www\./, '')))] };
}

function recordMatchesFilter(record, filter) {
  if (!filter) return true;
  if (profileKey(record.country) !== filter.country || !filter.cities.includes(profileKey(record.city))
    || profileKey(record.category) !== 'handicraft exporter') return false;
  if (filter.state && profileKey(record.state) !== filter.state) return false;
  if (filter.exclude_domains?.length && record.website_url) {
    try {
      const domain = normalizeDomain(record.website_url);
      if (domain && filter.exclude_domains.includes(domain)) return false;
    } catch { /* Invalid websites remain subject to website normalization before scanning. */ }
  }
  return true;
}

export function createEpchDirectoryJobs({ db, adapter, adapters = {}, createContact, verifyCandidate = null, schedule = setImmediate, now = Date.now } = {}) {
  if (!db || !adapter || typeof adapter.createSession !== 'function' || typeof adapter.fetchDirectoryPage !== 'function'
    || typeof createContact !== 'function') throw new TypeError('EPCH adapter, database, and contact service are required.');
  if (verifyCandidate !== null && typeof verifyCandidate !== 'function') throw new TypeError('Email verification service must be a function.');

  const sourceAdapters = {
    epch: { adapter, sourceUrl: EPCH_DIRECTORY_SOURCE_URL, label: 'EPCH member directory', evidenceType: 'epch_member_directory', extractorVersion: EPCH_DIRECTORY_EXTRACTOR_VERSION },
    ...adapters,
  };
  for (const [sourceId, config] of Object.entries(sourceAdapters)) {
    if (!/^[a-z0-9_]{2,40}$/.test(sourceId) || !config?.adapter
      || typeof config.adapter.createSession !== 'function' || typeof config.adapter.fetchDirectoryPage !== 'function'
      || typeof config.sourceUrl !== 'string' || typeof config.evidenceType !== 'string'
      || typeof config.extractorVersion !== 'string') {
      throw new TypeError(`Directory source adapter ${sourceId} is incomplete.`);
    }
  }

  let draining = false;
  let closed = false;

  function sourceHostname(sourceUrl) {
    try { return new URL(sourceUrl).hostname.toLowerCase(); } catch { return null; }
  }

  function activeHostCooldown(sourceUrl) {
    const hostname = sourceHostname(sourceUrl);
    if (!hostname) return null;
    const row = db.prepare('SELECT not_before FROM website_host_cooldowns WHERE hostname=?').get(hostname);
    return row && Number.isFinite(Date.parse(row.not_before)) && Date.parse(row.not_before) > Number(now())
      ? row.not_before : null;
  }

  function saveHostCooldown(sourceUrl, candidate) {
    const hostname = sourceHostname(sourceUrl);
    const candidateAt = Date.parse(candidate || '');
    if (!hostname || !Number.isFinite(candidateAt)) return null;
    const prior = db.prepare('SELECT not_before FROM website_host_cooldowns WHERE hostname=?').get(hostname)?.not_before;
    const priorAt = Date.parse(prior || '');
    const deadline = new Date(Math.max(candidateAt, Number.isFinite(priorAt) ? priorAt : 0)).toISOString();
    db.prepare(`INSERT INTO website_host_cooldowns(hostname,not_before,reason)
      VALUES(?,?,'directory_source_rate_limited')
      ON CONFLICT(hostname) DO UPDATE SET not_before=excluded.not_before,reason=excluded.reason,updated_at=datetime('now')`)
      .run(hostname, deadline);
    return deadline;
  }

  function latestCooldown(job) {
    const values = [job.retry_after_at, activeHostCooldown(job.source_url)]
      .filter(value => Number.isFinite(Date.parse(value || '')));
    return values.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
  }

  const jobSelect = `SELECT j.*,
      (SELECT COUNT(*) FROM epch_directory_pages p WHERE p.job_id=j.id AND p.status='completed') AS completed_page_count,
      (SELECT COUNT(*) FROM epch_directory_pages p WHERE p.job_id=j.id AND p.status='queued') AS queued_page_count,
      (SELECT COUNT(*) FROM epch_directory_pages p WHERE p.job_id=j.id AND p.status='blocked') AS blocked_page_count,
      (SELECT COUNT(*) FROM epch_directory_pages p WHERE p.job_id=j.id AND p.status='failed') AS failed_page_count
    FROM epch_directory_jobs j`;
  const getJobRow = db.prepare(`${jobSelect} WHERE j.id=?`);

  function getJob(jobIdInput) {
    const id = Number(jobIdInput);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const job = getJobRow.get(id);
    if (!job) return null;
    const pages = db.prepare(`SELECT id,page_url,page_number,status,record_count,content_hash,error_code,started_at,completed_at
      FROM epch_directory_pages WHERE job_id=? ORDER BY page_number,id LIMIT ?`).all(id, MAX_PAGE_LIMIT);
    const records = db.prepare(`SELECT r.*,l.business_name,l.website_url,l.category,l.address,l.city,l.state,l.country,l.contact_person_name AS company_contact_person
      FROM epch_directory_records r LEFT JOIN leads l ON l.id=r.lead_id WHERE r.job_id=? ORDER BY r.id LIMIT 5000`).all(id)
      .map(row => ({ ...row, emails: JSON.parse(row.emails_json || '[]') }));
    const emailChecks = db.prepare(`SELECT normalized_email,status,verification_status,error_code,attempt_count
      FROM epch_directory_email_checks WHERE job_id=?`).all(id);
    const checksByEmail = Object.fromEntries(emailChecks.map(check => [check.normalized_email, check]));
    for (const record of records) record.email_checks = checksByEmail;
    const verification = db.prepare(`SELECT
        SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status='completed' AND verification_status='deliverable' THEN 1 ELSE 0 END) AS deliverable,
        SUM(CASE WHEN status='completed' AND verification_status='risky' THEN 1 ELSE 0 END) AS risky,
        SUM(CASE WHEN status='completed' AND verification_status='unknown' THEN 1 ELSE 0 END) AS unknown,
        SUM(CASE WHEN status='completed' AND verification_status='undeliverable' THEN 1 ELSE 0 END) AS undeliverable,
        SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END) AS suppressed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM epch_directory_email_checks WHERE job_id=?`).get(id);
    let recordFilter = null;
    try { recordFilter = job.record_filter_json ? JSON.parse(job.record_filter_json) : null; } catch { recordFilter = null; }
    return {
      ...job,
      record_filter: recordFilter,
      source_name: sourceAdapters[job.source_id]?.label || 'Business directory',
      can_extend_pages: job.status === 'partial' && job.error_code === 'page_limit_reached'
        && Number(job.page_limit) < MAX_PAGE_LIMIT,
      progress: {
        pages_total_limit: job.page_limit,
        pages_completed: job.pages_completed,
        businesses_created: job.businesses_created,
        emails_created: job.emails_created,
        records_seen: job.records_seen,
        records_matched: job.records_matched,
        record_limit: job.record_limit,
        duplicates: job.duplicates,
        suppressed_emails_skipped: job.suppressed_emails_skipped,
        verification: Object.fromEntries(Object.entries(verification).map(([key, value]) => [key, Number(value || 0)])),
      },
      pages,
      records,
    };
  }

  function listJobs({ batch_id, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const batchId = batch_id === undefined || batch_id === null || batch_id === '' ? null : Number(batch_id);
    const rows = batchId === null
      ? db.prepare(`${jobSelect} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).all(safeLimit)
      : db.prepare(`${jobSelect} WHERE j.batch_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).all(batchId, safeLimit);
    return rows.map(row => ({ ...row, source_name: sourceAdapters[row.source_id]?.label || 'Business directory' }));
  }

  function createJob({ batch_id, page_limit = DEFAULT_PAGE_LIMIT, source_id = 'epch', record_limit = MAX_DIRECTORY_RECORDS,
    record_filter = null, lead_discovery_source_run_id = null } = {}) {
    const batchId = Number(batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new EpchDirectoryJobError('Choose an existing open batch.');
    if (typeof source_id !== 'string' || !sourceAdapters[source_id]) {
      throw new EpchDirectoryJobError('Choose a supported public directory source.', 422, 'directory_source_unsupported');
    }
    if (typeof page_limit !== 'number' || !Number.isSafeInteger(page_limit)
        || page_limit < 1 || page_limit > MAX_INITIAL_PAGE_LIMIT) {
      throw new EpchDirectoryJobError(`Directory page cap must be an integer from 1 to ${MAX_INITIAL_PAGE_LIMIT}.`, 400, 'invalid_page_limit');
    }
    if (typeof record_limit !== 'number' || !Number.isSafeInteger(record_limit) || record_limit < 1 || record_limit > MAX_DIRECTORY_RECORDS) {
      throw new EpchDirectoryJobError(`Directory record cap must be a whole number from 1 to ${MAX_DIRECTORY_RECORDS}.`, 400, 'invalid_record_limit');
    }
    const recordFilter = normalizeLeadDiscoveryFilter(record_filter);
    const sourceRunId = lead_discovery_source_run_id === null ? null : Number(lead_discovery_source_run_id);
    if (sourceRunId !== null && (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1)) {
      throw new EpchDirectoryJobError('The lead-discovery handoff is invalid.', 422, 'directory_handoff_invalid');
    }
    if (sourceRunId !== null) {
      const existing = db.prepare('SELECT id,batch_id,source_id FROM epch_directory_jobs WHERE lead_discovery_source_run_id=?').get(sourceRunId);
      if (existing) {
        if (Number(existing.batch_id) !== batchId || existing.source_id !== source_id) {
          throw new EpchDirectoryJobError('This discovery step is already linked to a different directory job.', 409, 'directory_handoff_conflict');
        }
        return getJob(existing.id);
      }
    }
    const id = db.transaction(() => {
      const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
      if (!batch) throw new EpchDirectoryJobError('Batch not found.', 404, 'batch_missing');
      if (batch.status !== 'open') throw new EpchDirectoryJobError('Directory records can only be imported into an open batch.', 409, 'batch_closed');
      const result = db.prepare(`INSERT INTO epch_directory_jobs(batch_id,source_id,source_url,status,page_limit,record_limit,
          record_filter_json,lead_discovery_source_run_id)
        VALUES(?,?,?,'queued',?,?,?,?)`).run(batchId, source_id, sourceAdapters[source_id].sourceUrl, page_limit,
        record_limit, recordFilter ? JSON.stringify(recordFilter) : null, sourceRunId);
      return Number(result.lastInsertRowid);
    })();
    schedule(() => { void drain(); });
    return getJob(id);
  }

  const insertProfileEvidence = db.prepare(`INSERT INTO lead_profile_source_evidence
      (lead_id,source_url,source_key,evidence_type,raw_excerpt,content_hash,extractor_version)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(lead_id,source_key) DO UPDATE SET source_url=excluded.source_url,raw_excerpt=excluded.raw_excerpt,
      evidence_type=excluded.evidence_type,content_hash=excluded.content_hash,extractor_version=excluded.extractor_version,observed_at=datetime('now')`);
  const insertEmail = db.prepare(`INSERT INTO lead_emails(lead_id,email,source,verification_status,is_primary,is_free_provider)
    VALUES(?,?,?,'unknown',0,?)`);
  const findEmailOnLead = db.prepare('SELECT id FROM lead_emails WHERE lead_id=? AND lower(trim(email))=? LIMIT 1');
  const findEmailAnywhere = db.prepare(`SELECT lead_id FROM lead_emails WHERE lower(trim(email))=?
    UNION ALL SELECT id AS lead_id FROM leads WHERE lower(trim(email))=? LIMIT 1`);
  const isSuppressed = db.prepare('SELECT 1 FROM suppression_list WHERE lower(trim(email))=? LIMIT 1');
  const findEmailForCheck = db.prepare(`SELECT id,verification_status,verified_at FROM lead_emails
    WHERE lead_id=? AND lower(trim(email))=? ORDER BY id LIMIT 1`);
  const insertEmailCheck = db.prepare(`INSERT OR IGNORE INTO epch_directory_email_checks
      (job_id,lead_id,lead_email_id,normalized_email,source_url,status,verification_status,completed_at)
    VALUES(?,?,?,?,?,?,?,CASE WHEN ?='completed' THEN datetime('now') ELSE NULL END)`);

  function importPage(jobId, pageId, pageUrl, parsed) {
    return db.transaction(() => {
      const job = db.prepare(`SELECT batch_id,status,source_id,record_limit,records_matched,record_filter_json
        FROM epch_directory_jobs WHERE id=?`).get(jobId);
      if (!job || !['running', 'pause_requested', 'cancel_requested'].includes(job.status)) return { imported: 0, emails: 0, duplicates: 0, suppressed: 0 };
      const sourceConfig = sourceAdapters[job.source_id] || sourceAdapters.epch;
      const batch = db.prepare('SELECT status FROM batches WHERE id=?').get(job.batch_id);
      if (!batch || batch.status !== 'open') {
        db.prepare(`UPDATE epch_directory_jobs SET status='failed',error_code='batch_closed',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(jobId);
        throw new EpchDirectoryJobError('The selected batch was closed during directory collection.', 409, 'batch_closed');
      }
      let businessesCreated = 0;
      let emailsCreated = 0;
      let duplicates = 0;
      let suppressed = 0;
      let recordsSeen = 0;
      let recordFilter = null;
      try { recordFilter = job.record_filter_json ? JSON.parse(job.record_filter_json) : null; } catch { /* Invalid filters fail closed below. */ }
      if (job.record_filter_json && !recordFilter) throw new EpchDirectoryJobError('The saved directory filter is invalid.', 409, 'directory_filter_invalid');
      const matchingRecords = parsed.records.filter(record => recordMatchesFilter(record, recordFilter));
      const priorKeys = new Set(db.prepare('SELECT record_key FROM epch_directory_records WHERE job_id=?').all(jobId).map(row => row.record_key));
      const remainingRecords = Math.max(0, Number(job.record_limit) - Number(job.records_matched));
      const pageKeys = new Set();
      const eligibleRecords = matchingRecords.filter(record => {
        if (priorKeys.has(record.record_key) || pageKeys.has(record.record_key)) return false;
        pageKeys.add(record.record_key);
        return true;
      }).slice(0, remainingRecords);
      const recordLimitReached = eligibleRecords.length >= remainingRecords;
      const insertRecord = db.prepare(`INSERT INTO epch_directory_records
        (job_id,page_id,record_key,lead_id,contact_person_name,contact_title,emails_json,source_url,raw_excerpt,content_hash,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      for (const record of eligibleRecords) {
        recordsSeen += 1;
        let recordSuppressed = 0;
        if (db.prepare('SELECT id FROM epch_directory_records WHERE job_id=? AND record_key=?').get(jobId, record.record_key)) {
          duplicates += 1;
          continue;
        }
        let business = db.prepare('SELECT lead_id FROM epch_directory_businesses WHERE batch_id=? AND business_key=?').get(job.batch_id, record.business_key);
        let leadId = business?.lead_id || null;
        if (!leadId) {
          const existing = db.prepare(`SELECT id FROM leads WHERE batch_id=? AND lower(trim(business_name))=?
            AND lower(trim(COALESCE(address,'')))=? AND lower(trim(COALESCE(country,'')))=? ORDER BY id LIMIT 1`)
            .get(job.batch_id, record.business_name.trim().toLocaleLowerCase('en'), (record.address || '').trim().toLocaleLowerCase('en'), 'india');
          if (existing) leadId = Number(existing.id);
        }
        if (!leadId) {
          const created = createContact({
            batch_id: job.batch_id,
            business_name: record.business_name,
            category: record.category,
            address: record.address || undefined,
            city: record.city || undefined,
            state: record.state || undefined,
            country: record.country,
            website_url: record.website_url || undefined,
          });
          leadId = Number(created.contact.id);
          businessesCreated += 1;
          db.prepare(`UPDATE leads SET source=?,source_url=?,source_details=?,contact_person_name=? WHERE id=?`)
            .run(sourceConfig.evidenceType, pageUrl,
              `${sourceConfig.label || 'Public business directory'} listing; publication freshness unknown. A public directory listing is not consent to send.`,
              record.contact_person_name, leadId);
          const event = db.prepare(`SELECT id,meta_json FROM events WHERE lead_id=? AND event_type='contact_created' ORDER BY id DESC LIMIT 1`).get(leadId);
          if (event) {
            let metadata = {};
            try { metadata = JSON.parse(event.meta_json || '{}'); } catch { /* Replace invalid event JSON with a safe object. */ }
            metadata.source = sourceConfig.evidenceType;
            db.prepare('UPDATE events SET meta_json=? WHERE id=?').run(JSON.stringify(metadata), event.id);
          }
        } else {
          db.prepare(`UPDATE leads SET contact_person_name=COALESCE(NULLIF(contact_person_name,''),?),
            website_url=COALESCE(NULLIF(trim(website_url),''),?),
            normalized_domain=CASE WHEN NULLIF(trim(website_url),'') IS NULL AND ? IS NOT NULL THEN ? ELSE normalized_domain END
            WHERE id=?`)
            .run(record.contact_person_name, record.website_url || null, record.website_url || null,
              normalizeDomain(record.website_url), leadId);
        }
        db.prepare(`INSERT INTO epch_directory_businesses(batch_id,business_key,lead_id) VALUES(?,?,?)
          ON CONFLICT(batch_id,business_key) DO UPDATE SET lead_id=excluded.lead_id,last_seen_at=datetime('now')`)
          .run(job.batch_id, record.business_key, leadId);

        const acceptedEmails = [];
        for (const rawEmail of record.emails) {
          const email = rawEmail.trim().toLowerCase();
          if (isSuppressed.get(email)) { suppressed += 1; recordSuppressed += 1; continue; }
          const onLead = findEmailOnLead.get(leadId, email);
          if (!onLead) {
            const existing = findEmailAnywhere.get(email, email);
            if (existing && Number(existing.lead_id) !== leadId) { duplicates += 1; continue; }
            const domain = email.slice(email.lastIndexOf('@') + 1);
            insertEmail.run(leadId, email, sourceConfig.evidenceType, Number(FREE_EMAIL_DOMAINS.has(domain)));
            emailsCreated += 1;
          } else {
            const domain = email.slice(email.lastIndexOf('@') + 1);
            db.prepare(`UPDATE lead_emails SET is_free_provider=? WHERE id=?`).run(Number(FREE_EMAIL_DOMAINS.has(domain)), onLead.id);
          }
          acceptedEmails.push(email);
          const excerpt = record.raw_excerpt.replace(/Email:\s*[^·]+/, `Email: ${acceptedEmails.join(', ') || '[suppressed address omitted]'} `).slice(0, 300);
          const evidenceUrl = record.source_url;
          db.prepare(`INSERT INTO lead_email_source_evidence
              (lead_email_id,source_url,evidence_type,raw_excerpt,content_hash,extractor_version)
            SELECT id,?,?,?,?,? FROM lead_emails WHERE lead_id=? AND lower(trim(email))=?
            ON CONFLICT(lead_email_id,source_url) DO UPDATE SET evidence_type=excluded.evidence_type,
              raw_excerpt=excluded.raw_excerpt,content_hash=excluded.content_hash,extractor_version=excluded.extractor_version,
              observed_at=datetime('now')`)
            .run(evidenceUrl, sourceConfig.evidenceType, excerpt, record.content_hash, sourceConfig.extractorVersion, leadId, email);
          if (record.contact_type || record.contact_title) {
            db.prepare(`INSERT INTO lead_email_contact_point_evidence(evidence_id,contact_type,contact_name,contact_title)
              SELECT evidence.id,?,?,? FROM lead_email_source_evidence evidence
              JOIN lead_emails email ON email.id=evidence.lead_email_id
              WHERE email.lead_id=? AND lower(trim(email.email))=? AND evidence.source_url=?
                AND NOT EXISTS (SELECT 1 FROM lead_email_contact_point_evidence prior WHERE prior.evidence_id=evidence.id
                  AND COALESCE(prior.contact_type,'')=COALESCE(?,'') AND COALESCE(prior.contact_name,'')=COALESCE(?,'')
                  AND COALESCE(prior.contact_title,'')=COALESCE(? ,''))`)
              .run(record.contact_type || null, record.contact_person_name || null, record.contact_title || null,
                leadId, email, evidenceUrl, record.contact_type || null, record.contact_person_name || null, record.contact_title || null);
          }
          if (verifyCandidate) {
            const candidate = findEmailForCheck.get(leadId, email);
            const savedStatus = String(candidate?.verification_status || '').toLowerCase();
            const status = candidate?.verified_at && ['deliverable','undeliverable','risky','unknown'].includes(savedStatus)
              ? 'completed' : 'queued';
            insertEmailCheck.run(jobId, leadId, candidate.id, email, evidenceUrl, status,
              status === 'completed' ? savedStatus : null, status);
          }
        }
        const safeExcerpt = record.raw_excerpt.replace(/Email:\s*[^·]+/, `${acceptedEmails.length ? `Email: ${acceptedEmails.join(', ')}` : 'Email: [suppressed address omitted]'} `).slice(0, 300);
        insertProfileEvidence.run(leadId, pageUrl, record.record_key, sourceConfig.evidenceType, safeExcerpt,
          record.content_hash, sourceConfig.extractorVersion);
        const recordStatus = recordSuppressed && !acceptedEmails.length ? 'suppressed_email' : leadId ? 'imported' : 'invalid';
        insertRecord.run(jobId, pageId, record.record_key, leadId, record.contact_person_name, record.contact_title || null,
          JSON.stringify(acceptedEmails), record.source_url, safeExcerpt, record.content_hash, recordStatus);
      }
      db.prepare(`UPDATE batches SET lead_count=(SELECT COUNT(*) FROM leads WHERE batch_id=?) WHERE id=?`).run(job.batch_id, job.batch_id);
      return { imported: businessesCreated, emails: emailsCreated, duplicates, suppressed, recordsSeen,
        recordsMatched: eligibleRecords.length, recordLimitReached };
    }).immediate();
  }

  function directoryVerifierErrorCode(error) {
    const code = String(error?.code || 'verification_failed').toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    return /^[a-z][a-z0-9_]*$/.test(code) ? code : 'verification_failed';
  }

  async function processVerificationChecks(jobId) {
    if (!verifyCandidate) return;
    while (!closed) {
      const jobStatus = db.prepare('SELECT status FROM epch_directory_jobs WHERE id=?').get(jobId)?.status;
      if (jobStatus === 'pause_requested') {
        db.prepare(`UPDATE epch_directory_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(jobId);
        return;
      }
      if (jobStatus === 'cancel_requested') {
        db.prepare(`UPDATE epch_directory_email_checks SET status='cancelled',error_code='job_cancelled',
          completed_at=datetime('now'),updated_at=datetime('now') WHERE job_id=? AND status='queued'`).run(jobId);
        db.prepare(`UPDATE epch_directory_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(jobId);
        return;
      }
      if (!['running','partial','completed'].includes(jobStatus)) return;
      const check = db.transaction(() => {
        const row = db.prepare(`SELECT c.id,c.job_id,c.lead_id,c.lead_email_id,c.normalized_email,c.source_url,
            le.verification_status,le.verified_at
          FROM epch_directory_email_checks c JOIN lead_emails le ON le.id=c.lead_email_id
          WHERE c.job_id=? AND c.status='queued' ORDER BY c.id LIMIT 1`).get(jobId);
        if (!row) return null;
        db.prepare(`UPDATE epch_directory_email_checks SET status='running',attempt_count=attempt_count+1,
          started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND status='queued'`).run(row.id);
        return row;
      }).immediate();
      if (!check) return;
      const finish = (status, verificationStatus = null, errorCode = null) => db.prepare(`UPDATE epch_directory_email_checks
        SET status=?,verification_status=?,error_code=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(status, verificationStatus, errorCode, check.id);
      if (isSuppressed.get(check.normalized_email)) { finish('suppressed', null, 'address_suppressed'); continue; }
      const savedStatus = String(check.verification_status || '').toLowerCase();
      if (check.verified_at && ['deliverable','undeliverable','risky','unknown'].includes(savedStatus)) {
        finish('completed', savedStatus);
        continue;
      }
      try {
        const result = await verifyCandidate(check.lead_email_id, { jobId, leadId: check.lead_id, email: check.normalized_email, sourceUrl: check.source_url });
        const saved = db.prepare('SELECT verification_status,verified_at FROM lead_emails WHERE id=?').get(check.lead_email_id);
        const status = String(saved?.verification_status || '').toLowerCase();
        if (!saved?.verified_at || !['deliverable','undeliverable','risky','unknown'].includes(status)
          || (result?.verification_status && result.verification_status !== status)) {
          throw Object.assign(new Error('Verifier did not save a usable result.'), { code: 'verification_result_not_saved' });
        }
        finish('completed', status);
      } catch (error) {
        finish('failed', null, directoryVerifierErrorCode(error));
      }
    }
  }

  function completePage(jobId, pageId, pageUrl, pageNumber, parsed, pageImport) {
    return db.transaction(() => {
      const possibleNext = parsed.pagination_urls.find(url =>
        !db.prepare('SELECT 1 FROM epch_directory_pages WHERE job_id=? AND page_url=? AND status=\'completed\'').get(jobId, url));
      db.prepare(`UPDATE epch_directory_pages SET status='completed',record_count=?,content_hash=?,completed_at=datetime('now') WHERE id=?`)
        .run(parsed.records.length, parsed.content_hash, pageId);
      db.prepare(`UPDATE epch_directory_jobs SET pages_completed=pages_completed+1,records_seen=records_seen+?,records_matched=records_matched+?,
        businesses_created=businesses_created+?,emails_created=emails_created+?,duplicates=duplicates+?,
        suppressed_emails_skipped=suppressed_emails_skipped+?,current_page_url=?,next_page_url=?,updated_at=datetime('now')
        WHERE id=?`).run(parsed.records.length, pageImport.recordsMatched || 0, pageImport.imported, pageImport.emails, pageImport.duplicates,
          pageImport.suppressed, pageUrl, possibleNext || null, jobId);
      const job = db.prepare('SELECT * FROM epch_directory_jobs WHERE id=?').get(jobId);
      const hasMore = Boolean(possibleNext);
      if (job.status === 'cancel_requested') {
        db.prepare(`UPDATE epch_directory_pages SET status='skipped',completed_at=datetime('now'),error_code='job_cancelled'
          WHERE job_id=? AND status='queued'`).run(jobId);
        db.prepare(`UPDATE epch_directory_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(jobId);
      } else if (hasMore && pageImport.recordLimitReached) {
        db.prepare(`UPDATE epch_directory_jobs SET status='partial',error_code='record_limit_reached',finished_at=datetime('now') WHERE id=?`).run(jobId);
      } else if (hasMore && job.pages_completed >= job.page_limit) {
        db.prepare(`UPDATE epch_directory_jobs SET status='partial',error_code='page_limit_reached',finished_at=datetime('now') WHERE id=?`).run(jobId);
      } else if (!hasMore) {
        db.prepare(`UPDATE epch_directory_jobs SET status='completed',next_page_url=NULL,finished_at=datetime('now') WHERE id=?`).run(jobId);
      } else if (job.status === 'pause_requested') {
        db.prepare(`UPDATE epch_directory_jobs SET status='paused',finished_at=NULL,updated_at=datetime('now') WHERE id=?`).run(jobId);
      }
      return { hasMore, status: db.prepare('SELECT status FROM epch_directory_jobs WHERE id=?').get(jobId).status };
    })();
  }

  async function processJob(jobId) {
    db.prepare(`UPDATE epch_directory_jobs SET status='running',attempt_count=attempt_count+1,
      started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND status='queued'`).run(jobId);
    let session;
    try {
      const jobSource = db.prepare('SELECT source_id FROM epch_directory_jobs WHERE id=?').get(jobId)?.source_id || 'epch';
      const sourceConfig = sourceAdapters[jobSource];
      if (!sourceConfig) throw new EpchDirectoryJobError('This directory job references an unavailable source adapter.', 409, 'directory_source_unavailable');
      const hostCooldown = activeHostCooldown(sourceConfig.sourceUrl);
      if (hostCooldown) throw new EpchDirectoryError(`This directory source host is cooling down until ${hostCooldown}. No request was made.`,
        'source_rate_limited', 429, { retryAfterAt: hostCooldown });
      session = await sourceConfig.adapter.createSession();
      while (!closed) {
        const job = db.prepare('SELECT * FROM epch_directory_jobs WHERE id=?').get(jobId);
        if (!job || !['running', 'pause_requested', 'cancel_requested'].includes(job.status)) return;
        if (job.status === 'pause_requested') {
          db.prepare(`UPDATE epch_directory_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(jobId);
          return;
        }
        if (job.status === 'cancel_requested') {
          db.prepare(`UPDATE epch_directory_pages SET status='skipped',completed_at=datetime('now'),error_code='job_cancelled'
            WHERE job_id=? AND status='queued'`).run(jobId);
          db.prepare(`UPDATE epch_directory_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(jobId);
          return;
        }
        const nextUrl = job.next_page_url || session.directory_url;
        const previousPage = db.prepare('SELECT id,status FROM epch_directory_pages WHERE job_id=? AND page_url=?').get(jobId, nextUrl);
        const pageNumber = job.pages_completed + 1;
        let pageId;
        if (previousPage) {
          pageId = previousPage.id;
          db.prepare(`UPDATE epch_directory_pages SET status='running',started_at=datetime('now'),completed_at=NULL,error_code=NULL WHERE id=?`).run(pageId);
        } else {
          pageId = Number(db.prepare(`INSERT INTO epch_directory_pages(job_id,page_url,page_number,status,started_at)
            VALUES(?,?,?,'running',datetime('now'))`).run(jobId, nextUrl, pageNumber).lastInsertRowid);
        }
        db.prepare(`UPDATE epch_directory_jobs SET current_page_url=?,updated_at=datetime('now') WHERE id=?`).run(nextUrl, jobId);
        const parsed = await sourceConfig.adapter.fetchDirectoryPage(session, nextUrl);
        const result = db.transaction(() => {
          const pageImport = importPage(jobId, pageId, nextUrl, parsed);
          return completePage(jobId, pageId, nextUrl, pageNumber, parsed, pageImport);
        }).immediate();
        if (['running','completed','partial'].includes(result.status)) await processVerificationChecks(jobId);
        if (db.prepare('SELECT status FROM epch_directory_jobs WHERE id=?').get(jobId)?.status !== 'running') return;
        if (!result.hasMore || result.status !== 'running') return;
      }
    } catch (error) {
      const job = db.prepare('SELECT pages_completed,attempt_count,source_id,source_url FROM epch_directory_jobs WHERE id=?').get(jobId);
      const code = error.code || (String(error.message || '').includes('SSRF blocked') ? 'unsafe_source_url' : 'directory_job_failed');
      const status = job?.pages_completed ? 'partial' : (error instanceof EpchDirectoryError && error.statusCode === 403 ? 'partial' : 'failed');
      let retryAfterAt = null;
      if (code === 'source_rate_limited' && job) {
        const configuredUrl = sourceAdapters[job.source_id]?.sourceUrl || job.source_url;
        const candidate = error.retryAfterAt || rateLimitDeadline(error.retryAfter, job.attempt_count, Number(now()));
        retryAfterAt = saveHostCooldown(configuredUrl, candidate);
      }
      const pageStatus = code === 'source_rate_limited' || (status === 'partial' && error.statusCode === 403) ? 'blocked' : 'failed';
      db.prepare(`UPDATE epch_directory_pages SET status=?,error_code=?,completed_at=datetime('now') WHERE job_id=? AND status='running'`)
        .run(pageStatus, code, jobId);
      db.prepare(`UPDATE epch_directory_jobs SET status=?,error_code=?,retry_after_at=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .run(status, code, retryAfterAt, jobId);
    }
  }

  async function drain() {
    if (draining || closed) return;
    draining = true;
    try {
      while (!closed) {
        const row = db.prepare(`SELECT id FROM epch_directory_jobs WHERE status='queued' ORDER BY id LIMIT 1`).get();
        if (row) {
          await processJob(row.id);
          continue;
        }
        const pending = verifyCandidate ? db.prepare(`SELECT c.job_id FROM epch_directory_email_checks c
          JOIN epch_directory_jobs j ON j.id=c.job_id
          WHERE c.status='queued' AND j.status IN ('completed','partial') ORDER BY c.job_id,c.id LIMIT 1`).get() : null;
        if (!pending) break;
        await processVerificationChecks(pending.job_id);
      }
    } finally {
      draining = false;
      if (!closed && (db.prepare(`SELECT 1 FROM epch_directory_jobs WHERE status='queued' LIMIT 1`).get()
        || (verifyCandidate && db.prepare(`SELECT 1 FROM epch_directory_email_checks c JOIN epch_directory_jobs j ON j.id=c.job_id
          WHERE c.status='queued' AND j.status IN ('completed','partial') LIMIT 1`).get()))) schedule(() => { void drain(); });
    }
  }

  function pause(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM epch_directory_jobs WHERE id=?').get(id);
    if (!job) throw new EpchDirectoryJobError('EPCH directory job not found.', 404, 'job_missing');
    if (job.status === 'running') db.prepare(`UPDATE epch_directory_jobs SET status='pause_requested',updated_at=datetime('now') WHERE id=?`).run(id);
    else if (job.status === 'queued') db.prepare(`UPDATE epch_directory_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(id);
    else if (!['paused', 'pause_requested'].includes(job.status)) throw new EpchDirectoryJobError('This directory job is already finished.', 409, 'job_terminal');
    return getJob(id);
  }

  function resume(jobIdInput, { extendPages = false } = {}) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status,page_limit,error_code FROM epch_directory_jobs WHERE id=?').get(id);
    if (!job) throw new EpchDirectoryJobError('EPCH directory job not found.', 404, 'job_missing');
    const canContinue = job.status === 'partial' && job.error_code === 'page_limit_reached' && extendPages;
    if (!['paused', 'queued'].includes(job.status) && !canContinue) throw new EpchDirectoryJobError('Only paused jobs or page-limited jobs can resume.', 409, 'job_not_resumable');
    db.prepare(`UPDATE epch_directory_jobs SET status='queued',page_limit=?,error_code=NULL,retry_after_at=NULL,finished_at=NULL,updated_at=datetime('now') WHERE id=?`)
      .run(canContinue ? Math.min(MAX_PAGE_LIMIT, job.page_limit + PAGE_LIMIT_INCREMENT) : job.page_limit, id);
    schedule(() => { void drain(); });
    return getJob(id);
  }

  function cancel(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM epch_directory_jobs WHERE id=?').get(id);
    if (!job) throw new EpchDirectoryJobError('EPCH directory job not found.', 404, 'job_missing');
    if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)) return getJob(id);
    if (job.status === 'running') db.prepare(`UPDATE epch_directory_jobs SET status='cancel_requested',updated_at=datetime('now') WHERE id=?`).run(id);
    else {
      db.prepare(`UPDATE epch_directory_pages SET status='skipped',completed_at=datetime('now'),error_code='job_cancelled' WHERE job_id=? AND status='queued'`).run(id);
      db.prepare(`UPDATE epch_directory_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
    }
    schedule(() => { void drain(); });
    return getJob(id);
  }

  function retry(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status,error_code,source_url,retry_after_at,attempt_count FROM epch_directory_jobs WHERE id=?').get(id);
    if (!job) throw new EpchDirectoryJobError('EPCH directory job not found.', 404, 'job_missing');
    if (!['failed', 'partial'].includes(job.status) || !RETRYABLE_ERRORS.has(job.error_code)) {
      throw new EpchDirectoryJobError('This directory job did not stop for a retryable network condition.', 409, 'job_not_retryable');
    }
    let retryAfterAt = latestCooldown(job);
    if (job.error_code === 'source_rate_limited' && !retryAfterAt) {
      retryAfterAt = saveHostCooldown(job.source_url, rateLimitDeadline('', job.attempt_count, Number(now())));
      db.prepare('UPDATE epch_directory_jobs SET retry_after_at=? WHERE id=?').run(retryAfterAt, id);
    }
    if (job.error_code === 'source_rate_limited' && retryAfterAt && Date.parse(retryAfterAt) > Number(now())) {
      throw new EpchDirectoryJobError(`This directory host requested a pause until ${retryAfterAt}. Retry is available after that time.`,
        429, 'directory_source_cooldown_active');
    }
    db.transaction(() => {
      db.prepare(`UPDATE epch_directory_pages SET status='queued',started_at=NULL,completed_at=NULL,error_code=NULL
        WHERE job_id=? AND status IN ('failed','blocked')`).run(id);
      db.prepare(`UPDATE epch_directory_jobs SET status='queued',error_code=NULL,retry_after_at=NULL,finished_at=NULL,updated_at=datetime('now') WHERE id=?`).run(id);
    }).immediate();
    schedule(() => { void drain(); });
    return getJob(id);
  }

  function retryVerification(jobIdInput) {
    const id = Number(jobIdInput);
    const job = db.prepare('SELECT status FROM epch_directory_jobs WHERE id=?').get(id);
    if (!job) throw new EpchDirectoryJobError('Directory job not found.', 404, 'job_missing');
    if (!verifyCandidate) throw new EpchDirectoryJobError('Email checking is not available right now.', 503, 'email_check_unavailable');
    if (!['completed', 'partial'].includes(job.status)) {
      throw new EpchDirectoryJobError('Finish or pause the directory import before retrying email checks.', 409, 'job_not_ready_for_email_retry');
    }
    const retryQueued = db.transaction(() => db.prepare(`UPDATE epch_directory_email_checks
      SET status='queued',verification_status=NULL,error_code=NULL,started_at=NULL,completed_at=NULL,updated_at=datetime('now')
      WHERE job_id=? AND status='failed'`).run(id).changes).immediate();
    if (retryQueued) schedule(() => { void drain(); });
    return { job: getJob(id), retry_queued: retryQueued };
  }

  function recover() {
    const result = db.transaction(() => {
      const runningChecks = db.prepare(`SELECT c.id,c.normalized_email,c.lead_email_id,le.verification_status,le.verified_at
        FROM epch_directory_email_checks c LEFT JOIN lead_emails le ON le.id=c.lead_email_id WHERE c.status='running'`).all();
      for (const check of runningChecks) {
        const suppressed = isSuppressed.get(check.normalized_email);
        const status = String(check.verification_status || '').toLowerCase();
        if (suppressed) {
          db.prepare(`UPDATE epch_directory_email_checks SET status='suppressed',error_code='address_suppressed',
            completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(check.id);
        } else if (check.verified_at && ['deliverable','undeliverable','risky','unknown'].includes(status)) {
          db.prepare(`UPDATE epch_directory_email_checks SET status='completed',verification_status=?,error_code=NULL,
            completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(status, check.id);
        } else {
          db.prepare(`UPDATE epch_directory_email_checks SET status='queued',error_code=NULL,updated_at=datetime('now') WHERE id=?`).run(check.id);
        }
      }
      db.prepare(`UPDATE epch_directory_pages SET status='queued',completed_at=NULL,error_code=NULL WHERE status='running'
        AND job_id IN (SELECT id FROM epch_directory_jobs WHERE status='running')`).run();
      const running = db.prepare(`UPDATE epch_directory_jobs SET status='queued',updated_at=datetime('now') WHERE status='running'`).run().changes;
      db.prepare(`UPDATE epch_directory_jobs SET status='paused',updated_at=datetime('now') WHERE status='pause_requested'`).run();
      const canceling = db.prepare(`SELECT id FROM epch_directory_jobs WHERE status='cancel_requested'`).all();
      for (const job of canceling) {
        db.prepare(`UPDATE epch_directory_pages SET status='skipped',completed_at=datetime('now'),error_code='job_cancelled' WHERE job_id=? AND status='queued'`).run(job.id);
        db.prepare(`UPDATE epch_directory_jobs SET status='cancelled',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(job.id);
      }
      return running + runningChecks.length;
    })();
    schedule(() => { void drain(); });
    return result;
  }

  function exportCsv(jobIdInput) {
    const job = getJob(jobIdInput);
    if (!job) return null;
    const rows = [['business_name','contact_person_name','category','address','city','state','country','email','verification_status',
      'source_url','source_excerpt','content_hash','extractor_version','publication_freshness','website_url','contact_title','source_id',
      'verification_check_status','verification_result','verification_error_code']];
    for (const record of job.records) {
      const emails = record.emails.length ? record.emails : [''];
      for (const email of emails) {
        const check = email ? db.prepare(`SELECT status,verification_status,error_code FROM epch_directory_email_checks
          WHERE job_id=? AND normalized_email=?`).get(job.id, String(email).trim().toLowerCase()) : null;
        rows.push([
          record.business_name, record.contact_person_name, record.category, record.address, record.city, record.state, record.country,
          email, check?.verification_status || 'unknown', record.source_url, record.raw_excerpt, record.content_hash,
          sourceAdapters[job.source_id]?.extractorVersion || EPCH_DIRECTORY_EXTRACTOR_VERSION, 'unknown', record.website_url,
          record.contact_title || '', job.source_id, check?.status || '', check?.verification_status || '', check?.error_code || '',
        ]);
      }
    }
    return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  return { createJob, listJobs, getJob, exportCsv, pause, resume, cancel, retry, retryVerification, recover, close: () => { closed = true; } };
}

