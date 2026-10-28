const MAX_CITIES = 10;
const MAX_NICHES = 10;
const MAX_QUERY_COMBINATIONS = 50;
const SEARCH_PHRASES_PER_COMBINATION = 3;
const MAX_TARGET = 500;
const MAX_BUSINESSES = 1000;
const MAX_PAGES = 10;
const MAX_RUNTIME_MINUTES = 120;
const IMPORT_PAGE_SIZE = 30;
const SEARCH_REQUEST_GAP_MS = 5_100;
const MAX_SAVED_SEARCHES_PER_USER = 50;
const DISCOVERY_SOURCES = new Set(['searxng', 'epch_directory']);
const NON_BUSINESS_HOSTS = [
  'yelp.com', 'yelp.ca', 'yellowpages.com', 'yellowpages.ca', 'bbb.org', 'zoominfo.com',
  'clutch.co', 'homestars.com', 'mapquest.com', 'manta.com', 'canada411.ca', 'canpages.ca',
  '411.ca', 'bark.com', 'houzz.com', 'thomasnet.com', 'opencorporates.com', 'linkedin.com',
  'facebook.com', 'instagram.com', 'supportontariomade.ca', 'ontariomade.ca',
];

function isBusinessWebsiteResult(result) {
  let url;
  try { url = new URL(String(result?.url || '')); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (NON_BUSINESS_HOSTS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) return false;
  if (/(?:^|\/)(?:directory|directories|marketplace|business-listings?|company-listings?)(?:\/|$)/i.test(url.pathname)) return false;
  return Boolean(String(result?.canonical_domain || '').trim());
}

function profileKey(value) {
  return String(value || '').trim().toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class LeadDiscoveryJobError extends Error {
  constructor(message, statusCode = 400, code = 'lead_discovery_job_error') {
    super(message);
    this.name = 'LeadDiscoveryJobError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function text(value, label, { required = false, max = 120 } = {}) {
  if (typeof value !== 'string') {
    if (required) throw new LeadDiscoveryJobError(`Enter ${label}.`, 422, 'criteria_invalid');
    return '';
  }
  const result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !result) throw new LeadDiscoveryJobError(`Enter ${label}.`, 422, 'criteria_invalid');
  if (result.length > max) throw new LeadDiscoveryJobError(`${label} must be ${max} characters or fewer.`, 422, 'criteria_invalid');
  return result;
}

function stringList(value, label, maxItems) {
  if (!Array.isArray(value)) throw new LeadDiscoveryJobError(`Add one or more ${label}.`, 422, 'criteria_invalid');
  const values = [...new Set(value.map(item => text(item, label, { required: true, max: 100 }).toLocaleLowerCase()))];
  if (!values.length || values.length > maxItems) {
    throw new LeadDiscoveryJobError(`Choose between 1 and ${maxItems} ${label}.`, 422, 'criteria_invalid');
  }
  return values;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LeadDiscoveryJobError(`${label} must be a whole number from ${minimum} to ${maximum}.`, 422, 'criteria_invalid');
  }
  return value;
}

function normalizeCriteria(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LeadDiscoveryJobError('Enter discovery details.', 422, 'criteria_invalid');
  const country = text(input.country, 'a country', { required: true });
  const state = text(input.state ?? '', 'a region', { max: 100 });
  const cities = stringList(input.cities, 'cities', MAX_CITIES);
  const niches = stringList(input.niches, 'business niches', MAX_NICHES);
  const sources = input.sources === undefined ? ['searxng'] : input.sources;
  if (!Array.isArray(sources) || !sources.length || sources.some(source => typeof source !== 'string' || !DISCOVERY_SOURCES.has(source))) {
    throw new LeadDiscoveryJobError('Choose a supported business source.', 422, 'source_invalid');
  }
  const selectedSources = [...new Set(sources)];
  let epch_filter = null;
  if (selectedSources.includes('epch_directory')) {
    if (profileKey(country) !== 'india' || niches.some(niche => !['handicraft exporter', 'handicraft exporters'].includes(profileKey(niche)))) {
      throw new LeadDiscoveryJobError('The EPCH directory can only be used for India handicraft-exporter searches.', 422, 'epch_filter_unsupported');
    }
    epch_filter = { country: 'india', state: profileKey(state), cities, niches: ['handicraft exporter'] };
  }
  if (cities.length * niches.length > MAX_QUERY_COMBINATIONS) {
    throw new LeadDiscoveryJobError(`Use no more than ${MAX_QUERY_COMBINATIONS} city and niche combinations.`, 422, 'criteria_too_broad');
  }
  const queries = [];
  for (const niche of niches) for (const city of cities) {
    const location = `${city}${state ? ` ${state}` : ''} ${country}`;
    const phrases = [
      `${niche} business contact ${location}`,
      `"${niche}" companies "${city}" website ${state ? `${state} ` : ''}${country}`,
      `"${niche}" official website contact ${location}`,
    ];
    for (const [variant, query] of phrases.entries()) {
      queries.push({ niche, city, variant: variant + 1, query: query.slice(0, 300) });
    }
  }
  return {
    country, state: state || null, cities, niches, queries, sources: selectedSources, epch_filter,
    target_email_count: boundedInteger(input.target_email_count, 100, 1, MAX_TARGET, 'Email-address collection target'),
    max_businesses: boundedInteger(input.max_businesses, 120, 1, MAX_BUSINESSES, 'Business inspection limit'),
    max_pages_per_query: boundedInteger(input.max_pages_per_query, 3, 1, MAX_PAGES, 'Search pages per query'),
    max_runtime_minutes: boundedInteger(input.max_runtime_minutes, 30, 1, MAX_RUNTIME_MINUTES, 'Runtime limit'),
  };
}

export function createLeadDiscoveryJobs({ db, leadSearch, websiteDiscoveryJobs, epchDirectoryJobs = null,
  schedule = (callback, delay = 0) => setTimeout(callback, delay), now = Date.now } = {}) {
  if (!db || !leadSearch || !websiteDiscoveryJobs) throw new TypeError('Database, search and website-discovery services are required.');
  let closed = false;
  let timer = null;
  let draining = false;

  const getRow = db.prepare('SELECT * FROM lead_discovery_jobs WHERE id=?');

  function metrics(jobId) {
    const row = db.prepare(`WITH all_checks AS (
        SELECT c.normalized_email,c.status,c.verification_status
        FROM lead_discovery_scan_handoffs h JOIN website_discovery_email_checks c ON c.job_id=h.website_job_id
        WHERE h.job_id=?
        UNION ALL
        SELECT c.normalized_email,c.status,c.verification_status
        FROM lead_discovery_source_runs r JOIN epch_directory_email_checks c ON c.job_id=r.directory_job_id
        WHERE r.job_id=? AND r.source_type='epch_directory'
        UNION ALL
        SELECT c.normalized_email,c.status,c.verification_status
        FROM lead_discovery_directory_scan_handoffs h JOIN website_discovery_email_checks c ON c.job_id=h.website_job_id
        WHERE h.job_id=?
      ), checks AS (
        SELECT normalized_email,
          MAX(CASE WHEN c.status='completed' AND c.verification_status='deliverable' THEN 1 ELSE 0 END) AS deliverable,
          MAX(CASE WHEN c.status='completed' AND c.verification_status='undeliverable' THEN 1 ELSE 0 END) AS undeliverable,
          MAX(CASE WHEN c.status='completed' AND c.verification_status IN ('risky','unknown') THEN 1 ELSE 0 END) AS uncertain,
          MAX(CASE WHEN c.status='failed' THEN 1 ELSE 0 END) AS failed,
          MAX(CASE WHEN c.status IN ('queued','running') THEN 1 ELSE 0 END) AS waiting,
          MAX(CASE WHEN c.status='suppressed' THEN 1 ELSE 0 END) AS suppressed
        FROM all_checks c GROUP BY normalized_email
      ), inspected_businesses AS (
        SELECT t.lead_id FROM lead_discovery_scan_handoffs h
          JOIN website_discovery_tasks t ON t.job_id=h.website_job_id WHERE h.job_id=?
        UNION
        SELECT t.lead_id FROM lead_discovery_directory_scan_handoffs h
          JOIN website_discovery_tasks t ON t.job_id=h.website_job_id WHERE h.job_id=?
        UNION
        SELECT r.lead_id FROM lead_discovery_source_runs run
          JOIN epch_directory_records r ON r.job_id=run.directory_job_id AND r.status='imported'
          WHERE run.job_id=? AND run.source_type='epch_directory'
      ), found_businesses AS (
        SELECT DISTINCT sr.canonical_domain AS domain FROM lead_discovery_source_runs r
          JOIN lead_search_results sr ON sr.job_id=r.search_job_id WHERE r.job_id=? AND sr.canonical_domain IS NOT NULL
        UNION
        SELECT DISTINCT lower(trim(l.normalized_domain)) AS domain FROM lead_discovery_source_runs run
          JOIN epch_directory_records r ON r.job_id=run.directory_job_id AND r.status='imported'
          JOIN leads l ON l.id=r.lead_id WHERE run.job_id=? AND run.source_type='epch_directory' AND l.normalized_domain IS NOT NULL
      )
      SELECT (SELECT COUNT(*) FROM checks) AS unique_candidates,
        (SELECT COUNT(*) FROM checks WHERE deliverable=1 AND suppressed=0 AND NOT EXISTS
          (SELECT 1 FROM suppression_list s WHERE lower(trim(s.email))=checks.normalized_email)) AS verified_deliverable,
        (SELECT COUNT(*) FROM checks WHERE waiting=1 AND deliverable=0 AND suppressed=0) AS awaiting_verification,
        (SELECT COUNT(*) FROM checks WHERE uncertain=1 AND deliverable=0 AND suppressed=0) AS risky_or_unknown,
        (SELECT COUNT(*) FROM checks WHERE (undeliverable=1 OR suppressed=1) AND deliverable=0) AS rejected_or_suppressed,
        (SELECT COUNT(*) FROM checks WHERE failed=1 AND deliverable=0 AND uncertain=0 AND undeliverable=0 AND suppressed=0) AS verification_failures,
        (SELECT COUNT(*) FROM inspected_businesses) AS businesses_inspected,
        (SELECT COUNT(*) FROM found_businesses) AS businesses_found`).get(jobId, jobId, jobId, jobId, jobId, jobId, jobId, jobId);
    const eligibleSearchDomains = db.prepare(`SELECT sr.canonical_domain,sr.url,sr.title
      FROM lead_discovery_source_runs r JOIN lead_search_results sr ON sr.job_id=r.search_job_id
      WHERE r.job_id=? AND sr.canonical_domain IS NOT NULL`).all(jobId)
      .filter(isBusinessWebsiteResult).map(item => item.canonical_domain.toLowerCase());
    const directoryDomains = db.prepare(`SELECT lower(trim(l.normalized_domain)) AS domain
      FROM lead_discovery_source_runs run JOIN epch_directory_records r ON r.job_id=run.directory_job_id AND r.status='imported'
      JOIN leads l ON l.id=r.lead_id WHERE run.job_id=? AND run.source_type='epch_directory' AND l.normalized_domain IS NOT NULL`)
      .all(jobId).map(item => item.domain);
    row.businesses_found = new Set([...eligibleSearchDomains, ...directoryDomains]).size;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
  }

  function getJob(jobIdInput) {
    const id = Number(jobIdInput);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const row = getRow.get(id);
    if (!row) return null;
    const criteria = JSON.parse(row.criteria_json);
    const runs = db.prepare(`SELECT r.id,r.query_index,r.query,r.page_number,r.source_type,r.search_job_id,r.directory_job_id,r.status,r.result_count,
        r.imported_count,r.has_more,r.error_code,r.created_at,r.updated_at,r.finished_at,
        d.status AS directory_status,d.error_code AS directory_error_code,d.retry_after_at AS directory_retry_after_at,
        d.pages_completed AS directory_pages_completed,d.page_limit AS directory_page_limit
      FROM lead_discovery_source_runs r LEFT JOIN epch_directory_jobs d ON d.id=r.directory_job_id
      WHERE r.job_id=? ORDER BY r.query_index,r.page_number,r.id`).all(id);
    return { ...row, criteria, progress: { ...metrics(id), target_email_count: row.target_email_count,
      target_metric: 'unique_candidates',
      source_runs_completed: runs.filter(run => ['completed','exhausted','failed'].includes(run.status)).length,
      source_runs_total: runs.length }, source_runs: runs };
  }

  function listJobs({ batch_id, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const batchId = batch_id === undefined || batch_id === null || batch_id === '' ? null : Number(batch_id);
    const rows = batchId === null
      ? db.prepare('SELECT id FROM lead_discovery_jobs ORDER BY created_at DESC,id DESC LIMIT ?').all(safeLimit)
      : db.prepare('SELECT id FROM lead_discovery_jobs WHERE batch_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(batchId, safeLimit);
    return rows.map(row => getJob(row.id));
  }

  function savedSearchUserId(actor) {
    if (!['owner','admin','operator'].includes(actor?.role)) {
      throw new LeadDiscoveryJobError('Sign in as an owner, admin, or operator to manage saved searches.', 403, 'saved_search_forbidden');
    }
    const userId = Number(actor.id);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new LeadDiscoveryJobError('Your account could not be identified. Sign in again and retry.', 401, 'saved_search_account_missing');
    }
    return userId;
  }

  function savedSearchView(row) {
    return { id: Number(row.id), name: row.name, criteria: JSON.parse(row.criteria_json),
      created_at: row.created_at, updated_at: row.updated_at };
  }

  function listSavedSearches(actor) {
    const userId = savedSearchUserId(actor);
    return db.prepare(`SELECT id,name,criteria_json,created_at,updated_at FROM lead_discovery_saved_searches
      WHERE user_id=? ORDER BY updated_at DESC,id DESC`).all(userId).map(savedSearchView);
  }

  function saveSearch(input = {}, actor = null) {
    const userId = savedSearchUserId(actor);
    const name = text(input.name, 'a saved-search name', { required: true, max: 80 });
    const criteriaInput = input.criteria && typeof input.criteria === 'object' && !Array.isArray(input.criteria)
      ? input.criteria : input;
    const criteria = normalizeCriteria(criteriaInput);
    try {
      const id = db.transaction(() => {
        const count = db.prepare('SELECT COUNT(*) AS count FROM lead_discovery_saved_searches WHERE user_id=?').get(userId).count;
        if (count >= MAX_SAVED_SEARCHES_PER_USER) {
          throw new LeadDiscoveryJobError(`You can save up to ${MAX_SAVED_SEARCHES_PER_USER} searches. Delete one before saving another.`, 409, 'saved_search_limit_reached');
        }
        const result = db.prepare(`INSERT INTO lead_discovery_saved_searches(user_id,name,criteria_json)
          VALUES(?,?,?)`).run(userId, name, JSON.stringify(criteria));
        return Number(result.lastInsertRowid);
      }).immediate();
      return savedSearchView(db.prepare(`SELECT id,name,criteria_json,created_at,updated_at
        FROM lead_discovery_saved_searches WHERE id=? AND user_id=?`).get(id, userId));
    } catch (error) {
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new LeadDiscoveryJobError('You already have a saved search with that name.', 409, 'saved_search_name_exists');
      }
      throw error;
    }
  }

  function deleteSavedSearch(searchIdInput, actor = null) {
    const userId = savedSearchUserId(actor);
    const searchId = Number(searchIdInput);
    if (!Number.isSafeInteger(searchId) || searchId < 1) {
      throw new LeadDiscoveryJobError('Saved search not found.', 404, 'saved_search_missing');
    }
    const removed = db.prepare('DELETE FROM lead_discovery_saved_searches WHERE id=? AND user_id=?').run(searchId, userId);
    if (!removed.changes) throw new LeadDiscoveryJobError('Saved search not found.', 404, 'saved_search_missing');
    return { deleted: true, id: searchId };
  }

  function scheduleDrain(delay = 0) {
    if (closed || timer) return;
    timer = schedule(() => { timer = null; void drain(); }, delay);
  }

  function finishRun(runId, status = 'completed', errorCode = null) {
    db.prepare(`UPDATE lead_discovery_source_runs SET status=?,error_code=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .run(status, errorCode, runId);
  }

  function finishJob(jobId, status, errorCode = null) {
    db.prepare(`UPDATE lead_discovery_jobs SET status=?,error_code=?,finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
      .run(status, errorCode, jobId);
  }

  function stopOutstandingWork(jobId, errorCode, scanRunStatus = 'exhausted') {
    const handoffs = db.prepare(`SELECT id,website_job_id FROM lead_discovery_scan_handoffs
      WHERE job_id=? AND status='running'`).all(jobId);
    for (const handoff of handoffs) {
      let child = null;
      try { child = websiteDiscoveryJobs.getJob(handoff.website_job_id, { offset: 0, limit: 1 }); } catch { /* The durable handoff is still closed below. */ }
      if (child && ['queued','running','pause_requested','cancel_requested'].includes(child.status)) {
        try { websiteDiscoveryJobs.cancel(handoff.website_job_id); } catch { /* The child may have settled between the read and cancel. */ }
        db.prepare(`UPDATE lead_discovery_scan_handoffs SET status='cancelled',finished_at=datetime('now') WHERE id=?`).run(handoff.id);
      } else {
        const terminal = child?.status === 'failed' ? 'failed' : child?.status === 'completed' ? 'completed' : 'cancelled';
        db.prepare(`UPDATE lead_discovery_scan_handoffs SET status=?,finished_at=datetime('now') WHERE id=?`).run(terminal, handoff.id);
      }
    }
    const directoryScans = db.prepare(`SELECT id,website_job_id FROM lead_discovery_directory_scan_handoffs
      WHERE job_id=? AND status='running'`).all(jobId);
    for (const handoff of directoryScans) {
      let child = null;
      try { child = websiteDiscoveryJobs.getJob(handoff.website_job_id, { offset: 0, limit: 1 }); } catch { /* The durable handoff closes below. */ }
      if (child && ['queued','running','pause_requested','cancel_requested'].includes(child.status)) {
        try { websiteDiscoveryJobs.cancel(handoff.website_job_id); } catch { /* Child may already have settled. */ }
        db.prepare(`UPDATE lead_discovery_directory_scan_handoffs SET status='cancelled',finished_at=datetime('now') WHERE id=?`).run(handoff.id);
      } else {
        const terminal = child?.status === 'failed' ? 'failed' : child?.status === 'completed' ? 'completed' : 'cancelled';
        db.prepare(`UPDATE lead_discovery_directory_scan_handoffs SET status=?,finished_at=datetime('now') WHERE id=?`).run(terminal, handoff.id);
      }
    }
    const directories = db.prepare(`SELECT directory_job_id FROM lead_discovery_source_runs
      WHERE job_id=? AND source_type='epch_directory' AND status IN ('queued','searching','scanning') AND directory_job_id IS NOT NULL`).all(jobId);
    for (const directory of directories) {
      let child = null;
      try { child = epchDirectoryJobs?.getJob(directory.directory_job_id); } catch { /* Close the coordinator run even when a child read fails. */ }
      if (child && ['queued','running','pause_requested','cancel_requested'].includes(child.status)) {
        try { epchDirectoryJobs.cancel(directory.directory_job_id); } catch { /* Child may settle between read and cancel. */ }
      }
    }
    db.prepare(`UPDATE lead_discovery_source_runs SET status=?,website_job_id=NULL,
      error_code=CASE WHEN ?='completed' THEN NULL ELSE COALESCE(error_code,?) END,finished_at=datetime('now'),updated_at=datetime('now')
      WHERE job_id=? AND status IN ('queued','searching','scanning')`)
      .run(scanRunStatus, scanRunStatus, errorCode, jobId);
  }

  function nextPageOrQuery(job, run) {
    const pageCanContinue = run.has_more === 1 && run.page_number < job.max_pages_per_query;
    const count = metrics(job.id);
    if (pageCanContinue && count.businesses_inspected < job.max_businesses) {
      db.prepare(`INSERT OR IGNORE INTO lead_discovery_source_runs(job_id,query_index,query,page_number,status,search_job_id)
        VALUES(?,?,?,?, 'queued',?)`).run(job.id, run.query_index, run.query, run.page_number + 1, run.search_job_id);
    }
    const pending = db.prepare(`SELECT COUNT(*) AS count FROM lead_discovery_source_runs WHERE job_id=? AND status IN ('queued','searching','scanning')`).get(job.id).count;
    if (!pending) {
      const exhausted = count.businesses_inspected >= job.max_businesses;
      const failed = db.prepare(`SELECT error_code FROM lead_discovery_source_runs WHERE job_id=? AND status='failed'
        ORDER BY CASE WHEN error_code='source_rate_limited' THEN 0 ELSE 1 END,id DESC LIMIT 1`).get(job.id);
      finishJob(job.id, 'partial', exhausted ? 'business_inspection_limit_reached' : failed?.error_code || 'search_sources_exhausted');
      return;
    }
    scheduleDrain(SEARCH_REQUEST_GAP_MS);
  }

  function settleIfDone(job) {
    if (!['queued','running'].includes(job.status)) return true;
    const current = getJob(job.id);
    if (current.progress.unique_candidates >= job.target_email_count) {
      stopOutstandingWork(job.id, 'target_reached', 'completed');
      finishJob(job.id, 'completed');
      return true;
    }
    const elapsed = job.started_at ? Math.max(0, Number(now()) - Date.parse(`${job.started_at.replace(' ', 'T')}Z`)) : 0;
    if (elapsed >= Number(job.max_runtime_minutes) * 60_000) {
      stopOutstandingWork(job.id, 'runtime_budget_reached');
      finishJob(job.id, 'partial', 'runtime_budget_reached');
      return true;
    }
    if (current.progress.businesses_inspected >= job.max_businesses) {
      stopOutstandingWork(job.id, 'business_inspection_limit_reached');
      finishJob(job.id, 'partial', 'business_inspection_limit_reached');
      return true;
    }
    return false;
  }

  async function step(jobId) {
    let job = getRow.get(jobId);
    if (!job || !['queued','running'].includes(job.status)) return;
    if (settleIfDone(job)) return;
    if (job.status === 'queued') {
      db.prepare(`UPDATE lead_discovery_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=?`).run(jobId);
      job = getRow.get(jobId);
    }
    let run = db.prepare(`SELECT * FROM lead_discovery_source_runs WHERE job_id=? AND status IN ('queued','searching','scanning')
      ORDER BY query_index,page_number,id LIMIT 1`).get(jobId);
    if (!run) {
      finishJob(jobId, 'partial', 'search_sources_exhausted');
      return;
    }
    try {
      if (run.source_type === 'epch_directory') {
        if (!epchDirectoryJobs) {
          finishRun(run.id, 'failed', 'directory_source_unavailable');
          nextPageOrQuery(job, run);
          return;
        }
        if (run.status === 'queued' || run.status === 'searching' && !run.directory_job_id) {
          db.prepare(`UPDATE lead_discovery_source_runs SET status='searching',updated_at=datetime('now') WHERE id=?`).run(run.id);
          const remainingBusinesses = Math.max(1, Number(job.max_businesses) - metrics(jobId).businesses_inspected);
          const excludedDomains = [...new Set(db.prepare(`SELECT lower(trim(sr.canonical_domain)) AS domain
            FROM lead_discovery_source_runs prior JOIN lead_search_results sr ON sr.job_id=prior.search_job_id
            WHERE prior.job_id=? AND sr.canonical_domain IS NOT NULL
            UNION SELECT lower(trim(l.normalized_domain)) AS domain FROM lead_discovery_scan_handoffs h
            JOIN website_discovery_tasks t ON t.job_id=h.website_job_id JOIN leads l ON l.id=t.lead_id
            WHERE h.job_id=? AND l.normalized_domain IS NOT NULL
            UNION SELECT lower(trim(l.normalized_domain)) AS domain FROM lead_discovery_directory_scan_handoffs h
            JOIN website_discovery_tasks t ON t.job_id=h.website_job_id JOIN leads l ON l.id=t.lead_id
            WHERE h.job_id=? AND l.normalized_domain IS NOT NULL`).all(jobId, jobId, jobId)
            .map(row => String(row.domain || '').replace(/^www\./, '')).filter(Boolean))];
          const directory = epchDirectoryJobs.createJob({ batch_id: job.batch_id,
            page_limit: Number(job.max_pages_per_query), record_limit: remainingBusinesses,
            record_filter: { ...JSON.parse(job.criteria_json).epch_filter, exclude_domains: excludedDomains },
            lead_discovery_source_run_id: run.id });
          db.prepare(`UPDATE lead_discovery_source_runs SET directory_job_id=?,status='scanning',updated_at=datetime('now') WHERE id=?`)
            .run(directory.id, run.id);
          scheduleDrain(100);
          return;
        }
        if (run.status === 'scanning') {
          const directory = epchDirectoryJobs.getJob(run.directory_job_id);
          if (!directory) {
            finishRun(run.id, 'failed', 'directory_job_missing');
            nextPageOrQuery(job, run);
            return;
          }
          const verificationWaiting = Number(directory.progress?.verification?.waiting || 0);
          if (['queued','running','pause_requested','cancel_requested'].includes(directory.status) || verificationWaiting > 0) {
            scheduleDrain(1000);
            return;
          }
          if (directory.status === 'paused') return;
          if (!['completed','partial'].includes(directory.status)) {
            finishRun(run.id, 'failed', directory.error_code || 'directory_source_failed');
            nextPageOrQuery(job, run);
            return;
          }
          if (settleIfDone(getRow.get(jobId))) return;
          if (!run.website_job_id) {
            const remainingBusinesses = Math.max(0, Number(job.max_businesses) - metrics(jobId).businesses_inspected);
            const scannedLeadIds = new Set(db.prepare(`SELECT DISTINCT t.lead_id FROM lead_discovery_scan_handoffs h
              JOIN website_discovery_tasks t ON t.job_id=h.website_job_id WHERE h.job_id=?
              UNION SELECT DISTINCT t.lead_id FROM lead_discovery_directory_scan_handoffs h
              JOIN website_discovery_tasks t ON t.job_id=h.website_job_id WHERE h.job_id=?`).all(jobId, jobId).map(row => Number(row.lead_id)));
            const scannedDomains = new Set(db.prepare(`SELECT DISTINCT lower(trim(l.normalized_domain)) AS domain
              FROM lead_discovery_scan_handoffs h JOIN website_discovery_tasks t ON t.job_id=h.website_job_id
              JOIN leads l ON l.id=t.lead_id WHERE h.job_id=? AND l.normalized_domain IS NOT NULL
              UNION SELECT DISTINCT lower(trim(l.normalized_domain)) AS domain FROM lead_discovery_directory_scan_handoffs h
              JOIN website_discovery_tasks t ON t.job_id=h.website_job_id JOIN leads l ON l.id=t.lead_id
              WHERE h.job_id=? AND l.normalized_domain IS NOT NULL`).all(jobId, jobId).map(row => String(row.domain).replace(/^www\./, '')));
            const candidates = db.prepare(`SELECT DISTINCT r.lead_id,l.business_name,l.website_url,l.category,l.city,l.state,l.country,l.normalized_domain
              FROM epch_directory_records r JOIN leads l ON l.id=r.lead_id
              WHERE r.job_id=? AND r.status='imported' AND NULLIF(trim(l.website_url),'') IS NOT NULL ORDER BY r.id`)
              .all(run.directory_job_id).filter(record => {
                if (scannedLeadIds.has(Number(record.lead_id))) return false;
                let domain = String(record.normalized_domain || '').trim().toLowerCase().replace(/^www\./, '');
                if (!domain) { try { domain = new URL(record.website_url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; } }
                if (scannedDomains.has(domain)) return false;
                scannedDomains.add(domain);
                return true;
              }).slice(0, remainingBusinesses);
            const candidate = candidates[0];
            if (candidate) {
              const scan = websiteDiscoveryJobs.createJob({ batch_id: job.batch_id, source: 'epch_directory',
                sourceContext: { directoryJobId: Number(run.directory_job_id), leadDiscoveryJobId: jobId,
                  leadDiscoverySourceRunId: Number(run.id) },
                businesses: [{ lead_id: Number(candidate.lead_id), business_name: candidate.business_name,
                  website_url: candidate.website_url, category: candidate.category, city: candidate.city,
                  state: candidate.state, country: candidate.country }] });
              db.prepare(`UPDATE lead_discovery_source_runs SET website_job_id=?,updated_at=datetime('now') WHERE id=?`)
                .run(scan.id, run.id);
              scheduleDrain(100);
              return;
            }
          }
          if (run.website_job_id) {
            const scan = websiteDiscoveryJobs.getJob(run.website_job_id, { offset: 0, limit: 1 });
            if (!scan) {
              db.prepare(`UPDATE lead_discovery_directory_scan_handoffs SET status='failed',finished_at=datetime('now')
                WHERE website_job_id=? AND status='running'`).run(run.website_job_id);
              db.prepare(`UPDATE lead_discovery_source_runs SET website_job_id=NULL,updated_at=datetime('now') WHERE id=?`).run(run.id);
              scheduleDrain(0);
              return;
            }
            const pendingChecks = Number(scan.progress?.verification?.waiting || 0);
            if (['queued','running','pause_requested','cancel_requested'].includes(scan.status) || pendingChecks > 0) {
              scheduleDrain(1000);
              return;
            }
            db.prepare(`UPDATE lead_discovery_directory_scan_handoffs SET status=?,finished_at=datetime('now')
              WHERE website_job_id=? AND status='running'`).run(scan.status === 'failed' ? 'failed' : 'completed', run.website_job_id);
            db.prepare(`UPDATE lead_discovery_source_runs SET website_job_id=NULL,updated_at=datetime('now') WHERE id=?`).run(run.id);
            if (settleIfDone(getRow.get(jobId))) return;
            scheduleDrain(0);
            return;
          }
          finishRun(run.id, directory.status === 'partial' ? 'failed' : 'completed',
            directory.status === 'partial' ? directory.error_code || 'directory_source_partial' : null);
          nextPageOrQuery(getRow.get(jobId), run);
          return;
        }
      }
      if (run.status === 'queued' || run.status === 'searching' && !run.search_job_id) {
        db.prepare(`UPDATE lead_discovery_source_runs SET status='searching',updated_at=datetime('now') WHERE id=?`).run(run.id);
        const result = run.search_job_id
          ? await leadSearch.loadNextPage(run.search_job_id)
          : await leadSearch.search({ batch_id: job.batch_id, query: run.query });
        if (result?.status === 'failed') {
          const code = String(result.error_code || 'provider_request_failed')
            .toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 80);
          finishRun(run.id, 'failed', code);
          if (code.startsWith('provider_')) {
            // Do not turn a provider failure into an empty result and dispatch
            // more work to an unavailable or throttling source. Leave the
            // remaining runs queued for an explicit, operator-controlled resume.
            finishJob(jobId, 'blocked', code);
          } else {
            nextPageOrQuery(getRow.get(jobId), run);
          }
          return;
        }
        db.prepare(`UPDATE lead_discovery_source_runs SET status='scanning',search_job_id=?,result_count=?,has_more=?,updated_at=datetime('now') WHERE id=?`)
          .run(result.id, Number(result.result_count || 0), result.has_more ? 1 : 0, run.id);
        run = db.prepare('SELECT * FROM lead_discovery_source_runs WHERE id=?').get(run.id);
        const parentStatus = getRow.get(jobId)?.status;
        if (parentStatus === 'cancelled') {
          finishRun(run.id, 'exhausted', 'job_cancelled');
          return;
        }
        // A search request already in flight may finish after an operator
        // pauses. Save its cursor, but leave the site queue untouched.
        if (parentStatus !== 'running') return;
        if (settleIfDone(getRow.get(jobId))) return;
      }

      if (run.status === 'scanning' && !run.website_job_id) {
        const searchJob = leadSearch.getJob(run.search_job_id);
        const remainingBusinesses = Math.max(0, Number(job.max_businesses) - metrics(jobId).businesses_inspected);
        const inspectedDomains = new Set(db.prepare(`SELECT DISTINCT lower(trim(result.canonical_domain)) AS domain
          FROM lead_discovery_scan_handoffs handoff
          JOIN lead_search_results result ON result.id=handoff.search_result_id
          WHERE handoff.job_id=?`).all(jobId).map(row => row.domain).filter(Boolean));
        const candidateIds = [];
        for (const result of searchJob?.results || []) {
          const domain = String(result.canonical_domain || '').trim().toLowerCase();
          if (!domain || !isBusinessWebsiteResult(result) || result.imported_lead_id || inspectedDomains.has(domain)) continue;
          inspectedDomains.add(domain);
          candidateIds.push(Number(result.id));
          if (candidateIds.length >= Math.min(1, IMPORT_PAGE_SIZE, remainingBusinesses)) break;
        }
        const resultIds = candidateIds;
        if (!resultIds.length) {
          finishRun(run.id);
          nextPageOrQuery(job, run);
          return;
        }
        const imported = leadSearch.importResults(run.search_job_id, { result_ids: resultIds });
        if (!imported.website_discovery_job) {
          db.prepare(`UPDATE lead_discovery_source_runs SET imported_count=0,updated_at=datetime('now') WHERE id=?`).run(run.id);
          finishRun(run.id);
          nextPageOrQuery(job, run);
          return;
        }
        const criteria = JSON.parse(job.criteria_json);
        const searchScope = criteria.queries[run.query_index];
        const importedLeadId = Number(imported.website_discovery_job.tasks[0]?.lead_id);
        if (Number.isSafeInteger(importedLeadId) && importedLeadId > 0 && searchScope?.niche && searchScope?.city) {
          const display = value => {
            const label = String(value || '').trim();
            return label ? label[0].toLocaleUpperCase('en') + label.slice(1) : null;
          };
          db.prepare(`UPDATE leads SET category=COALESCE(NULLIF(trim(category),''),?),
            city=COALESCE(NULLIF(trim(city),''),?),state=COALESCE(NULLIF(trim(state),''),?),
            country=COALESCE(NULLIF(trim(country),''),?) WHERE id=? AND batch_id=?`)
            .run(display(searchScope.niche), display(searchScope.city), criteria.state || null,
              criteria.country || null, importedLeadId, job.batch_id);
        }
        db.transaction(() => {
          db.prepare(`INSERT INTO lead_discovery_scan_handoffs(job_id,source_run_id,search_result_id,website_job_id,status)
            VALUES(?,?,?,?,'running') ON CONFLICT(job_id,search_result_id) DO NOTHING`)
            .run(jobId, run.id, resultIds[0], imported.website_discovery_job.id);
          db.prepare(`UPDATE lead_discovery_source_runs SET website_job_id=?,imported_count=imported_count+?,updated_at=datetime('now') WHERE id=?`)
            .run(imported.website_discovery_job.id, Number(imported.imported_count || 0), run.id);
        })();
        scheduleDrain(100);
        return;
      }

      if (run.status === 'scanning' && run.website_job_id) {
        const scan = websiteDiscoveryJobs.getJob(run.website_job_id, { offset: 0, limit: 1 });
        if (!scan) {
          finishRun(run.id, 'failed', 'website_scan_missing');
          nextPageOrQuery(job, run);
          return;
        }
        const pendingChecks = Number(scan.progress?.verification?.waiting || 0);
        if (['queued','running','pause_requested','cancel_requested'].includes(scan.status) || pendingChecks > 0) {
          scheduleDrain(1000);
          return;
        }
        const handoffStatus = scan.status === 'failed' ? 'failed' : 'completed';
        db.transaction(() => {
          db.prepare(`UPDATE lead_discovery_scan_handoffs SET status=?,finished_at=datetime('now')
            WHERE website_job_id=? AND status='running'`).run(handoffStatus, run.website_job_id);
          db.prepare(`UPDATE lead_discovery_source_runs SET website_job_id=NULL,updated_at=datetime('now') WHERE id=?`).run(run.id);
        })();
        if (settleIfDone(getRow.get(jobId))) return;
        // Inspect one business at a time. This lets the coordinator stop before
        // starting more sites as soon as the verified target is met.
        scheduleDrain(0);
      }
    } catch (error) {
      const code = String(error?.code || 'source_request_failed').replace(/[^a-z0-9_]+/gi, '_').slice(0, 80);
      finishRun(run.id, 'failed', code);
      if (['provider_not_configured','provider_endpoint_invalid','provider_endpoint_blocked'].includes(code)) {
        finishJob(jobId, 'blocked', code);
      } else {
        nextPageOrQuery(getRow.get(jobId), run);
      }
    }
  }

  async function drain() {
    if (draining || closed) return;
    draining = true;
    try {
      const job = db.prepare(`SELECT id FROM lead_discovery_jobs WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT 1`).get();
      if (job) await step(job.id);
    } catch (error) {
      console.error('Lead discovery coordinator failed:', error?.message || 'unknown error');
    } finally {
      draining = false;
      if (!closed && db.prepare(`SELECT 1 FROM lead_discovery_jobs WHERE status IN ('queued','running') LIMIT 1`).get()) scheduleDrain(1000);
    }
  }

  function createJob(input = {}, actor = null) {
    if (!['owner','admin','operator'].includes(actor?.role)) throw new LeadDiscoveryJobError('You do not have access to start lead discovery.', 403, 'lead_discovery_forbidden');
    const batchId = input.batch_id;
    if (typeof batchId !== 'number' || !Number.isSafeInteger(batchId) || batchId < 1) throw new LeadDiscoveryJobError('Choose an open batch.', 422, 'batch_invalid');
    const criteria = normalizeCriteria(input);
    if (criteria.sources.includes('searxng') && !leadSearch.publicStatus().configured) throw new LeadDiscoveryJobError('Connect a search service in Search businesses before starting a discovery run.', 409, 'provider_not_configured');
    if (criteria.sources.includes('epch_directory') && !epchDirectoryJobs) throw new LeadDiscoveryJobError('The Indian handicraft-exporter directory is not available right now.', 503, 'directory_source_unavailable');
    const id = db.transaction(() => {
      const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
      if (!batch) throw new LeadDiscoveryJobError('Batch not found.', 404, 'batch_missing');
      if (batch.status !== 'open') throw new LeadDiscoveryJobError('Lead discovery can only add results to an open batch.', 409, 'batch_closed');
      const created = db.prepare(`INSERT INTO lead_discovery_jobs(batch_id,created_by,criteria_json,status,target_email_count,max_businesses,max_pages_per_query,max_runtime_minutes)
        VALUES(?,?,?,'queued',?,?,?,?)`).run(batchId, Number(actor.id) || null, JSON.stringify(criteria), criteria.target_email_count,
        criteria.max_businesses, criteria.max_pages_per_query, criteria.max_runtime_minutes);
      const jobId = Number(created.lastInsertRowid);
      const insertRun = db.prepare(`INSERT INTO lead_discovery_source_runs(job_id,query_index,query,page_number,source_type,status)
        VALUES(?,?,?,1,?,'queued')`);
      if (criteria.sources.includes('searxng')) criteria.queries.forEach((item, index) => insertRun.run(jobId, index, item.query, 'searxng'));
      if (criteria.sources.includes('epch_directory')) insertRun.run(jobId, criteria.queries.length,
        `India handicraft exporters · ${criteria.cities.join(', ')}`, 'epch_directory');
      return jobId;
    })();
    scheduleDrain();
    return getJob(id);
  }

  function control(jobIdInput, action, actor = null) {
    if (!['owner','admin','operator'].includes(actor?.role)) {
      throw new LeadDiscoveryJobError('You do not have access to manage lead discovery jobs.', 403, 'lead_discovery_forbidden');
    }
    const id = Number(jobIdInput);
    const job = getRow.get(id);
    if (!job) throw new LeadDiscoveryJobError('Lead discovery job not found.', 404, 'job_missing');
    if (action === 'pause') {
      if (!['queued','running'].includes(job.status)) throw new LeadDiscoveryJobError('Only an active job can be paused.', 409, 'job_not_active');
      db.prepare(`UPDATE lead_discovery_jobs SET status='paused',updated_at=datetime('now') WHERE id=?`).run(id);
      const child = db.prepare(`SELECT website_job_id FROM lead_discovery_source_runs WHERE job_id=? AND status='scanning' AND website_job_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
      if (child) {
        const current = websiteDiscoveryJobs.getJob(child.website_job_id, { offset: 0, limit: 1 });
        // A child can finish between coordinator polls. Do not turn a successful
        // parent pause into an API error by forwarding pause to a terminal child.
        if (current && ['queued','running'].includes(current.status)) {
          try {
            websiteDiscoveryJobs.pause(child.website_job_id);
          } catch (error) {
            const latest = websiteDiscoveryJobs.getJob(child.website_job_id, { offset: 0, limit: 1 });
            if (!latest || !['completed','partial','failed','cancelled','blocked'].includes(latest.status)) throw error;
          }
        }
      }
      const directory = db.prepare(`SELECT directory_job_id FROM lead_discovery_source_runs WHERE job_id=? AND source_type='epch_directory' AND status='scanning' AND directory_job_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
      if (directory) {
        const current = epchDirectoryJobs?.getJob(directory.directory_job_id);
        if (current && ['queued','running'].includes(current.status)) epchDirectoryJobs.pause(directory.directory_job_id);
      }
    } else if (action === 'resume') {
      if (!['paused','blocked'].includes(job.status)) throw new LeadDiscoveryJobError('Only a paused or blocked job can resume.', 409, 'job_not_resumable');
      db.prepare(`UPDATE lead_discovery_jobs SET status='queued',error_code=NULL,finished_at=NULL,updated_at=datetime('now') WHERE id=?`).run(id);
      // Schedule recovery before waking children. A child may settle after the
      // status read; the parent must still drain even if that race is observed.
      scheduleDrain();
      const failedRun = db.prepare(`SELECT id FROM lead_discovery_source_runs WHERE job_id=? AND status='failed' ORDER BY id DESC LIMIT 1`).get(id);
      if (failedRun) db.prepare(`UPDATE lead_discovery_source_runs SET status='queued',error_code=NULL,finished_at=NULL,updated_at=datetime('now') WHERE id=?`).run(failedRun.id);
      const child = db.prepare(`SELECT website_job_id FROM lead_discovery_source_runs WHERE job_id=? AND status='scanning' AND website_job_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
      if (child) {
        const current = websiteDiscoveryJobs.getJob(child.website_job_id, { offset: 0, limit: 1 });
        if (current?.status === 'paused') {
          try {
            websiteDiscoveryJobs.resume(child.website_job_id);
          } catch (error) {
            const latest = websiteDiscoveryJobs.getJob(child.website_job_id, { offset: 0, limit: 1 });
            if (!latest || !['completed','partial','failed','cancelled','blocked'].includes(latest.status)) throw error;
          }
        }
      }
      const directory = db.prepare(`SELECT directory_job_id FROM lead_discovery_source_runs WHERE job_id=? AND source_type='epch_directory' AND status='scanning' AND directory_job_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
      if (directory) {
        const current = epchDirectoryJobs?.getJob(directory.directory_job_id);
        if (current?.status === 'paused') epchDirectoryJobs.resume(directory.directory_job_id);
      }
    } else if (action === 'cancel') {
      if (['completed','partial','failed','cancelled'].includes(job.status)) throw new LeadDiscoveryJobError('This discovery job has already ended.', 409, 'job_not_cancellable');
      const child = db.prepare(`SELECT website_job_id FROM lead_discovery_source_runs WHERE job_id=? AND status='scanning' AND website_job_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
      const directory = db.prepare(`SELECT directory_job_id FROM lead_discovery_source_runs WHERE job_id=? AND source_type='epch_directory' AND status='scanning' AND directory_job_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(id);
      db.prepare(`UPDATE lead_discovery_jobs SET status='cancelled',error_code='cancelled_by_operator',finished_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(id);
      db.prepare(`UPDATE lead_discovery_source_runs SET status='exhausted',error_code='job_cancelled',finished_at=datetime('now'),updated_at=datetime('now')
        WHERE job_id=? AND status IN ('queued','searching','scanning')`).run(id);
      if (child) websiteDiscoveryJobs.cancel(child.website_job_id);
      if (directory) epchDirectoryJobs?.cancel(directory.directory_job_id);
    } else throw new LeadDiscoveryJobError('Unknown discovery action.');
    return getJob(id);
  }

  function recover() {
    const count = db.prepare(`UPDATE lead_discovery_jobs SET status='queued',updated_at=datetime('now') WHERE status='running'`).run().changes;
    db.prepare(`UPDATE lead_discovery_source_runs SET status='queued',error_code=NULL,updated_at=datetime('now') WHERE status='searching' AND search_job_id IS NULL`).run();
    scheduleDrain();
    return count;
  }

  recover();
  return { createJob, getJob, listJobs, listSavedSearches, saveSearch, deleteSavedSearch, control, recover, close() { closed = true; if (timer) clearTimeout(timer); } };
}
