import net from 'node:net';
import { createSafeFetcher } from './ssrf-guard.js';
import { decryptCredential, encryptCredential, isEncryptedCredential } from './credential-vault.js';
import { normalizeWebsiteUrl } from './website-email-discovery.js';
import { createLocalSearxngFetcher, localSearxngEndpoint } from './searxng-local-transport.js';

const MAX_QUERY_LENGTH = 300;
const MAX_RESULTS = 30;
// A provider page can contain 30 accepted websites. Keep manual and automated
// imports aligned so a complete result page can be scanned in one worker job.
const MAX_SELECTED_IMPORTS = 30;
// SearXNG fans a search out to upstream engines. Keep requests slow enough to
// stay below the guarded fetch budget and reduce the chance of upstream blocks.
const MIN_REQUEST_GAP_MS = 5_000;
const TEST_QUERY = 'Odd Ecosys SearXNG connection check';
const SOCIAL_OR_SEARCH_HOSTS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com',
  'tiktok.com', 'pinterest.com', 'reddit.com', 'threads.net', 'google.com', 'bing.com',
  'duckduckgo.com', 'search.brave.com', 'searx.space',
];

export class SearxngSearchError extends Error {
  constructor(message, statusCode = 400, code = 'searxng_search_error') {
    super(message);
    this.name = 'SearxngSearchError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeEndpoint(value, localEndpoint = null) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2048) {
    throw new SearxngSearchError('Enter the HTTPS base URL for your SearXNG instance.', 422, 'provider_endpoint_invalid');
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new SearxngSearchError('The SearXNG base URL is invalid.', 422, 'provider_endpoint_invalid'); }
  const normalized = url.href.replace(/\/+$/, '');
  if (localEndpoint && normalized === localEndpoint) return localEndpoint;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !url.hostname.includes('.') || net.isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) {
    throw new SearxngSearchError('Use an HTTPS SearXNG hostname without URL credentials, query, or fragment.', 422, 'provider_endpoint_invalid');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

function validateQuery(value) {
  if (typeof value !== 'string') throw new SearxngSearchError('Enter a business search query.', 422, 'search_query_invalid');
  const query = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (query.length < 3 || query.length > MAX_QUERY_LENGTH) {
    throw new SearxngSearchError(`Search queries must be between 3 and ${MAX_QUERY_LENGTH} characters.`, 422, 'search_query_invalid');
  }
  return query;
}

function cleanText(value, maximum) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function isExcludedHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return SOCIAL_OR_SEARCH_HOSTS.some(domain => normalized === domain || normalized.endsWith(`.${domain}`));
}

function normalizeResult(row, position, seenDomains) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const title = cleanText(row.title, 280);
  if (!title || typeof row.url !== 'string' || row.url.length > 4096) return null;
  let url;
  try { url = new URL(row.url); } catch { return null; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || !host.includes('.')
    || net.isIP(host) || host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal') || isExcludedHost(host)) return null;
  const resultUrl = new URL(url.href);
  resultUrl.hash = '';
  resultUrl.search = '';
  resultUrl.pathname = resultUrl.pathname.slice(0, 500) || '/';
  let websiteUrl;
  try { websiteUrl = normalizeWebsiteUrl(resultUrl.href).href; } catch { return null; }
  const canonicalDomain = new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, '');
  if (seenDomains.has(canonicalDomain)) return null;
  seenDomains.add(canonicalDomain);
  return {
    position,
    title,
    url: resultUrl.href,
    website_url: websiteUrl,
    canonical_domain: canonicalDomain,
    snippet: cleanText(row.content ?? row.snippet, 600),
    engine: cleanText(row.engine, 80),
  };
}

function providerError(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  if (error instanceof SearxngSearchError) return error;
  if (/SSRF blocked/i.test(error?.message || '')) return new SearxngSearchError('The configured search endpoint was blocked by the outbound network safety check.', 422, 'provider_endpoint_blocked');
  if (/timed out|timeout/i.test(error?.message || '')) return new SearxngSearchError('The SearXNG request timed out.', 504, 'provider_timeout');
  if (status === 403) return new SearxngSearchError('SearXNG rejected JSON output or the configured access token.', 502, 'provider_json_unavailable');
  if (status === 429) return new SearxngSearchError('SearXNG is rate limiting requests. Wait before searching again.', 429, 'provider_rate_limited');
  if (status >= 500) return new SearxngSearchError('The SearXNG instance returned a server error.', 502, 'provider_unavailable');
  return new SearxngSearchError('The SearXNG request failed. Check the instance URL and its JSON search settings.', 502, 'provider_request_failed');
}

export function createSearxngSearchManager({
  db,
  websiteDiscoveryJobs,
  fetcher,
  now = Date.now,
} = {}) {
  if (!db || !websiteDiscoveryJobs || typeof websiteDiscoveryJobs.createJob !== 'function') {
    throw new TypeError('Database and website discovery jobs are required.');
  }
  const safeFetch = fetcher || createSafeFetcher({ maxRequests: 20, maxConcurrency: 1, budgetWindowMs: 60_000 });
  const localEndpoint = localSearxngEndpoint();
  const localFetch = localEndpoint ? createLocalSearxngFetcher(localEndpoint) : null;
  let activeRequest = false;

  const getSetting = db.prepare('SELECT * FROM lead_search_provider_settings WHERE id=1');
  const getJobRow = db.prepare('SELECT * FROM lead_search_jobs WHERE id=?');
  const getSeedLeadRow = db.prepare(`SELECT id,batch_id,business_name,category,city,state,country,normalized_domain
    FROM leads WHERE id=?`);

  function publicStatus() {
    const row = getSetting.get();
    return {
      configured: Boolean(row?.endpoint_url),
      endpoint_url: row?.endpoint_url || '',
      local_endpoint_enabled: Boolean(localEndpoint),
      authentication: row?.api_token_enc ? 'bearer_configured' : 'none',
      updated_at: row?.updated_at || null,
      ...(localEndpoint ? { local_endpoint_url: localEndpoint } : {}),
    };
  }

  function saveConfiguration(input = {}, actor = null) {
    if (!['owner', 'admin'].includes(actor?.role)) throw new SearxngSearchError('Only workspace owners and admins can configure search providers.', 403, 'provider_admin_required');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SearxngSearchError('Enter valid SearXNG settings.');
    const endpointInput = typeof input.endpoint_url === 'string' ? input.endpoint_url.trim() : '';
    if (!endpointInput) {
      db.prepare('DELETE FROM lead_search_provider_settings WHERE id=1').run();
      return publicStatus();
    }
    const endpoint = normalizeEndpoint(endpointInput, localEndpoint);
    const current = getSetting.get();
    let token = current?.api_token_enc || null;
    const incomingToken = typeof input.api_token === 'string' ? input.api_token.trim() : '';
    if (current?.endpoint_url !== endpoint && !incomingToken) token = null;
    if (input.clear_api_token === true) token = null;
    if (incomingToken) {
      if (input.api_token.length > 2048) throw new SearxngSearchError('The optional access token is too long.', 422, 'provider_token_invalid');
      token = encryptCredential(incomingToken);
    }
    db.prepare(`INSERT INTO lead_search_provider_settings(id,endpoint_url,api_token_enc,last_request_at_ms,updated_by)
      VALUES(1,?,?,0,?) ON CONFLICT(id) DO UPDATE SET endpoint_url=excluded.endpoint_url,
      api_token_enc=excluded.api_token_enc,last_request_at_ms=0,updated_at=datetime('now'),updated_by=excluded.updated_by`)
      .run(endpoint, token, Number.isSafeInteger(Number(actor.id)) ? Number(actor.id) : null);
    return publicStatus();
  }

  function reserveCall() {
    const setting = getSetting.get();
    if (!setting?.endpoint_url) throw new SearxngSearchError('Configure your self-hosted SearXNG endpoint before searching.', 409, 'provider_not_configured');
    // Revalidate before reserving a request: removing operator trust must block
    // a saved local endpoint without leaving this manager stuck as active.
    const endpoint = normalizeEndpoint(setting.endpoint_url, localEndpoint);
    if (activeRequest) throw new SearxngSearchError('A SearXNG request is already running. Wait for it to finish.', 429, 'provider_request_busy');
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp) || timestamp - Number(setting.last_request_at_ms || 0) < MIN_REQUEST_GAP_MS) {
      throw new SearxngSearchError('Wait five seconds between requests to the search instance.', 429, 'provider_request_throttled');
    }
    const encrypted = setting.api_token_enc;
    const token = encrypted ? decryptCredential(encrypted) : '';
    if (encrypted && !isEncryptedCredential(encrypted)) {
      throw new SearxngSearchError('The saved SearXNG token is not encrypted. Remove it and save it again with the credential key configured.', 503, 'provider_token_not_encrypted');
    }
    db.prepare('UPDATE lead_search_provider_settings SET last_request_at_ms=? WHERE id=1').run(timestamp);
    activeRequest = true;
    return { endpoint, token };
  }

  async function requestResults(query, pageNumber, { endpoint, token }) {
    try {
      const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
      const url = new URL('search', base);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('pageno', String(pageNumber));
      url.searchParams.set('safesearch', '1');
      const requestFetch = localEndpoint && endpoint === localEndpoint ? localFetch : safeFetch;
      const response = await requestFetch(url.href, {
        method: 'GET', redirect: 'error', timeoutMs: 12_000, maxBytes: 1_048_576,
        headers: {
          accept: 'application/json',
          'user-agent': 'OddEcosys-LeadDiscovery/1.0 (+operator-configured self-hosted SearXNG)',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) throw Object.assign(new Error(`SearXNG responded with ${response.status}.`), { statusCode: response.status });
      if (!String(response.headers.get('content-type') || '').toLowerCase().includes('json')) {
        throw new SearxngSearchError('SearXNG did not return JSON. Enable the json format in its search settings.', 502, 'provider_json_unavailable');
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw new SearxngSearchError('SearXNG returned invalid JSON.', 502, 'provider_response_invalid'); }
      if (!payload || !Array.isArray(payload.results)) {
        throw new SearxngSearchError('SearXNG response is missing its results array.', 502, 'provider_response_invalid');
      }
      const upstreamWarnings = Array.isArray(payload.unresponsive_engines) ? payload.unresponsive_engines : [];
      const upstreamThrottle = upstreamWarnings.some(entry => {
        const detail = Array.isArray(entry) ? entry.join(' ') : JSON.stringify(entry);
        return /captcha|too many requests?|rate[ -]?limit|suspend/i.test(detail || '');
      });
      if (upstreamThrottle) {
        throw new SearxngSearchError('A SearXNG search source is rate limiting or challenging requests. The run has been paused; wait before searching again.',
          429, 'provider_rate_limited');
      }
      const seenDomains = new Set();
      let rejected = 0;
      const results = [];
      for (const [index, raw] of payload.results.entries()) {
        const result = normalizeResult(raw, index + 1, seenDomains);
        if (!result) { rejected += 1; continue; }
        results.push(result);
        if (results.length >= MAX_RESULTS) {
          rejected += Math.max(0, payload.results.length - index - 1);
          break;
        }
      }
      return { results, rejected_result_count: rejected, raw_result_count: payload.results.length };
    } catch (error) {
      throw providerError(error);
    }
  }

  async function performSearch(queryInput, pageNumber = 1) {
    const query = validateQuery(queryInput);
    const configuration = reserveCall();
    try { return await requestResults(query, pageNumber, configuration); }
    finally { activeRequest = false; }
  }

  async function testConnection() {
    const started = Number(now());
    const { results, rejected_result_count } = await performSearch(TEST_QUERY);
    return { ok: true, endpoint_url: publicStatus().endpoint_url, json_search_available: true,
      accepted_results: results.length, rejected_results: rejected_result_count, elapsed_ms: Math.max(0, Number(now()) - started) };
  }

  function getJob(jobIdInput) {
    const id = Number(jobIdInput);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const job = getJobRow.get(id);
    if (!job) return null;
    const results = db.prepare(`SELECT id,job_id,position,title,url,website_url,canonical_domain,snippet,engine,
        page_number,imported_lead_id,imported_at,created_at FROM lead_search_results WHERE job_id=? ORDER BY position,id LIMIT ?`)
      .all(id, MAX_RESULTS);
    const rootJobId = Number(job.root_job_id || job.id);
    const pages = db.prepare(`SELECT id,page_number,status,result_count,rejected_result_count,error_code,created_at,finished_at
      FROM lead_search_jobs WHERE root_job_id=? OR id=? ORDER BY page_number,id`).all(rootJobId, rootJobId);
    return { ...job, has_more: job.has_more === 1, pages, results };
  }

  function listJobs({ batch_id, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const batchId = batch_id === undefined || batch_id === null || batch_id === '' ? null : Number(batch_id);
    const rootFilter = batchId === null ? '' : 'AND j.batch_id=?';
    const parameters = batchId === null ? [safeLimit] : [batchId, safeLimit];
    const rows = db.prepare(`SELECT j.*,COUNT(DISTINCT p.id) AS page_count,COUNT(r.id) AS result_count_saved,
        COALESCE(SUM(CASE WHEN r.imported_lead_id IS NOT NULL THEN 1 ELSE 0 END),0) AS imported_count
      FROM lead_search_jobs j
      LEFT JOIN lead_search_jobs p ON COALESCE(p.root_job_id,p.id)=COALESCE(j.root_job_id,j.id)
      LEFT JOIN lead_search_results r ON r.job_id=p.id
      WHERE j.parent_job_id IS NULL ${rootFilter}
      GROUP BY j.id ORDER BY j.created_at DESC,j.id DESC LIMIT ?`).all(...parameters);
    return rows;
  }

  async function search(input = {}) {
    const query = validateQuery(input.query);
    const batchId = Number(input.batch_id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new SearxngSearchError('Choose an existing open batch.', 422, 'batch_invalid');
    const batch = db.prepare('SELECT id,status FROM batches WHERE id=?').get(batchId);
    if (!batch) throw new SearxngSearchError('Batch not found.', 404, 'batch_missing');
    if (batch.status !== 'open') throw new SearxngSearchError('Search results can only be collected into an open batch.', 409, 'batch_closed');
    let seedLeadId = null;
    if (input.seed_lead_id !== undefined && input.seed_lead_id !== null) {
      seedLeadId = Number(input.seed_lead_id);
      if (!Number.isSafeInteger(seedLeadId) || seedLeadId < 1) {
        throw new SearxngSearchError('The source company contact is invalid.', 422, 'search_seed_invalid');
      }
      const seedLead = getSeedLeadRow.get(seedLeadId);
      if (!seedLead) throw new SearxngSearchError('The source company contact could not be found.', 404, 'search_seed_missing');
      if (Number(seedLead.batch_id) !== batchId) {
        throw new SearxngSearchError('Choose the same open batch as the source company contact.', 422, 'search_seed_batch_mismatch');
      }
    }
    return runPage({ batchId, query, seedLeadId, pageNumber: 1, parentJobId: null, rootJobId: null });
  }

  async function runPage({ batchId, query, seedLeadId = null, pageNumber, parentJobId, rootJobId, existingJobId = null }) {
    const started = Number(now());
    const configuration = reserveCall();
    let jobId = existingJobId;
    try {
      if (jobId) {
        db.prepare(`UPDATE lead_search_jobs SET status='running',error_code=NULL,started_at=datetime('now'),finished_at=NULL
          ,seed_lead_id=COALESCE(seed_lead_id,?) WHERE id=? AND status IN ('failed','interrupted')`).run(seedLeadId, jobId);
      } else {
        jobId = db.transaction(() => {
          const created = db.prepare(`INSERT INTO lead_search_jobs(batch_id,parent_job_id,root_job_id,seed_lead_id,page_number,
              provider,query,status) VALUES(?,?,?,?,?, 'searxng',?,'running')`)
            .run(batchId, parentJobId, rootJobId, seedLeadId, pageNumber, query);
          const id = Number(created.lastInsertRowid);
          db.prepare('UPDATE lead_search_jobs SET root_job_id=COALESCE(root_job_id,?) WHERE id=?').run(id, id);
          return id;
        })();
      }
      const page = await requestResults(query, pageNumber, configuration);
      const seedLead = seedLeadId ? getSeedLeadRow.get(seedLeadId) : null;
      const seedDomain = String(seedLead?.normalized_domain || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      if (seedDomain) {
        const before = page.results.length;
        page.results = page.results.filter(result => result.canonical_domain !== seedDomain);
        page.rejected_result_count += before - page.results.length;
      }
      const canonicalRoot = Number(rootJobId || jobId);
      const priorDomains = new Set(db.prepare(`SELECT r.canonical_domain FROM lead_search_results r
        JOIN lead_search_jobs j ON j.id=r.job_id WHERE j.root_job_id=? OR j.id=?`)
        .all(canonicalRoot, canonicalRoot).map(row => row.canonical_domain));
      const fresh = page.results.filter(result => !priorDomains.has(result.canonical_domain));
      const repeatedDomains = page.results.length - fresh.length;
      const rejected = page.rejected_result_count + repeatedDomains;
      db.transaction(() => {
        const insert = db.prepare(`INSERT OR IGNORE INTO lead_search_results
          (job_id,page_number,position,title,url,website_url,canonical_domain,snippet,engine)
          VALUES(?,?,?,?,?,?,?,?,?)`);
        let inserted = 0;
        for (const result of fresh) {
          inserted += insert.run(jobId, pageNumber, result.position, result.title, result.url, result.website_url,
            result.canonical_domain, result.snippet, result.engine).changes;
        }
        db.prepare(`UPDATE lead_search_jobs SET status='completed',result_count=?,rejected_result_count=?,has_more=?,
          next_page_number=?,error_code=NULL,elapsed_ms=?,finished_at=datetime('now') WHERE id=?`)
          .run(inserted, rejected, page.raw_result_count > 0 ? 1 : 0,
            page.raw_result_count > 0 ? pageNumber + 1 : null, Math.max(0, Number(now()) - started), jobId);
      })();
    } catch (error) {
      const safeError = providerError(error);
      if (jobId) db.prepare(`UPDATE lead_search_jobs SET status='failed',error_code=?,elapsed_ms=?,finished_at=datetime('now')
        WHERE id=? AND status='running'`).run(safeError.code, Math.max(0, Number(now()) - started), jobId);
      else throw safeError;
    } finally {
      activeRequest = false;
    }
    return getJob(jobId);
  }

  async function loadNextPage(jobIdInput) {
    const jobId = Number(jobIdInput);
    const job = getJobRow.get(jobId);
    if (!job) throw new SearxngSearchError('Search job not found.', 404, 'search_job_missing');
    if (job.status !== 'completed' || job.has_more !== 1 || !job.next_page_number) {
      throw new SearxngSearchError('This search page has no saved next page to load.', 409, 'search_page_exhausted');
    }
    const rootJobId = Number(job.root_job_id || job.id);
    const pageNumber = Number(job.next_page_number);
    const existing = db.prepare(`SELECT id,status FROM lead_search_jobs WHERE root_job_id=? AND page_number=?
      ORDER BY id LIMIT 1`).get(rootJobId, pageNumber);
    if (existing?.status === 'completed' || existing?.status === 'running') return getJob(existing.id);
    return runPage({ batchId: Number(job.batch_id), query: job.query, seedLeadId: Number(job.seed_lead_id) || null, pageNumber, parentJobId: job.id,
      rootJobId, existingJobId: existing?.id || null });
  }

  function importResults(jobIdInput, input = {}) {
    const jobId = Number(jobIdInput);
    const job = getJobRow.get(jobId);
    if (!job) throw new SearxngSearchError('Search job not found.', 404, 'search_job_missing');
    if (job.status !== 'completed') throw new SearxngSearchError('Only completed searches can be imported.', 409, 'search_job_not_completed');
    if (!Array.isArray(input.result_ids) || input.result_ids.length < 1 || input.result_ids.length > MAX_SELECTED_IMPORTS) {
      throw new SearxngSearchError(`Select between 1 and ${MAX_SELECTED_IMPORTS} business websites to scan.`, 422, 'search_selection_invalid');
    }
    const selectedIds = [...new Set(input.result_ids.map(Number))];
    if (selectedIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new SearxngSearchError('The selected result list is invalid.', 422, 'search_selection_invalid');
    const rootJobId = Number(job.root_job_id || job.id);
    const placeholders = selectedIds.map(() => '?').join(',');
    const selected = db.prepare(`SELECT r.* FROM lead_search_results r
      JOIN lead_search_jobs page ON page.id=r.job_id
      WHERE COALESCE(page.root_job_id,page.id)=? AND r.id IN (${placeholders})
      ORDER BY page.page_number,r.position,r.id`).all(rootJobId, ...selectedIds);
    if (selected.length !== selectedIds.length) throw new SearxngSearchError('One or more selected results do not belong to this search.', 422, 'search_selection_invalid');
    const fresh = selected.filter(result => !result.imported_lead_id);
    if (!fresh.length) return { website_discovery_job: null, imported_count: 0, already_imported_count: selected.length };
    const businesses = fresh.map(result => ({ business_name: result.title, website_url: result.url }));
    const websiteDiscoveryJob = websiteDiscoveryJobs.createJob({
      batch_id: job.batch_id,
      businesses,
      source: 'searxng_search',
      sourceContext: {
        searchJobId: rootJobId,
        seedLeadId: Number(job.seed_lead_id) || null,
        query: job.query,
        results: fresh.map(result => ({ id: result.id, title: result.title, url: result.url, website_url: result.website_url,
          snippet: result.snippet, seed_lead_id: Number(job.seed_lead_id) || null })),
      },
    });
    const leadByCanonical = new Map(websiteDiscoveryJob.tasks.map(task => [task.canonical_url, task.lead_id]));
    db.transaction(() => {
      const markImported = db.prepare(`UPDATE lead_search_results SET imported_lead_id=?,imported_at=datetime('now')
        WHERE job_id=? AND id=? AND imported_lead_id IS NULL`);
      for (const result of fresh) {
        const leadId = leadByCanonical.get(result.website_url);
        if (leadId) markImported.run(leadId, result.job_id, result.id);
      }
    })();
    return { website_discovery_job: websiteDiscoveryJob, imported_count: fresh.length,
      already_imported_count: selected.length - fresh.length };
  }

  function importSelectedResults(input = {}) {
    if (!Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 10) {
      throw new SearxngSearchError('Choose search results from 1 to 10 company searches.', 422, 'search_selection_invalid');
    }
    const selected = [];
    const seenIds = new Set();
    let batchId = null;
    let requestedCount = 0;
    for (const group of input.groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        throw new SearxngSearchError('The selected search list is invalid.', 422, 'search_selection_invalid');
      }
      const jobId = Number(group.search_job_id);
      const job = getJobRow.get(jobId);
      if (!job) throw new SearxngSearchError('One of the company searches could not be found.', 404, 'search_job_missing');
      if (job.status !== 'completed') throw new SearxngSearchError('Wait for each selected search to finish before importing.', 409, 'search_job_not_completed');
      if (batchId !== null && batchId !== Number(job.batch_id)) {
        throw new SearxngSearchError('Select websites from the same open batch.', 422, 'search_batch_mismatch');
      }
      batchId = Number(job.batch_id);
      if (!Array.isArray(group.result_ids) || group.result_ids.length < 1) {
        throw new SearxngSearchError('Select at least one website from each included company search.', 422, 'search_selection_invalid');
      }
      const ids = [...new Set(group.result_ids.map(Number))];
      requestedCount += ids.length;
      if (requestedCount > MAX_SELECTED_IMPORTS
        || ids.some(id => !Number.isSafeInteger(id) || id < 1 || seenIds.has(id))) {
        throw new SearxngSearchError('Select up to 30 different website matches in total.', 422, 'search_selection_invalid');
      }
      for (const id of ids) seenIds.add(id);
      const rootJobId = Number(job.root_job_id || job.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare('SELECT r.*,page.query AS source_query,page.batch_id AS source_batch_id,page.seed_lead_id AS source_seed_lead_id ' +
        'FROM lead_search_results r JOIN lead_search_jobs page ON page.id=r.job_id ' +
        'WHERE COALESCE(page.root_job_id,page.id)=? AND r.id IN (' + placeholders + ') ' +
        'ORDER BY page.page_number,r.position,r.id').all(rootJobId, ...ids);
      if (rows.length !== ids.length || rows.some(row => Number(row.source_batch_id) !== batchId)) {
        throw new SearxngSearchError('One or more selected websites do not belong to these company searches.', 422, 'search_selection_invalid');
      }
      for (const row of rows) selected.push({
        ...row, search_job_id: rootJobId, query: String(row.source_query || job.query),
      });
    }
    const importedLeadByDomain = new Map();
    for (const row of selected) {
      if (row.imported_lead_id) importedLeadByDomain.set(String(row.canonical_domain).toLowerCase(), Number(row.imported_lead_id));
    }
    const uniqueFresh = new Map();
    for (const row of selected) {
      const domain = String(row.canonical_domain || '').toLowerCase();
      if (!row.imported_lead_id && domain && !importedLeadByDomain.has(domain) && !uniqueFresh.has(domain)) {
        uniqueFresh.set(domain, row);
      }
    }
    if (!uniqueFresh.size) {
      return { website_discovery_job: null, imported_count: 0,
        already_imported_count: selected.filter(row => row.imported_lead_id).length,
        duplicate_domain_count: Math.max(0, selected.length - new Set(selected.map(row => row.canonical_domain)).size) };
    }
    const fresh = [...uniqueFresh.values()];
    const context = {
      searchJobId: fresh[0].search_job_id,
      query: fresh[0].query,
      results: fresh.map(row => ({
        id: Number(row.id), title: row.title, url: row.url, website_url: row.website_url,
        snippet: row.snippet, query: row.query, search_job_id: row.search_job_id,
        seed_lead_id: Number(row.source_seed_lead_id) || null,
      })),
    };
    return db.transaction(() => {
      const websiteDiscoveryJob = websiteDiscoveryJobs.createJob({
        batch_id: batchId,
        businesses: fresh.map(row => ({ business_name: row.title, website_url: row.url })),
        source: 'searxng_search',
        sourceContext: context,
      });
      const leadByDomain = new Map();
      for (const task of websiteDiscoveryJob.tasks || []) {
        try {
          const domain = new URL(task.canonical_url).hostname.toLowerCase().replace(/^www\./, '');
          leadByDomain.set(domain, Number(task.lead_id));
        } catch { /* A guarded task without a normalized domain is not marked imported. */ }
      }
      for (const [domain, leadId] of importedLeadByDomain) leadByDomain.set(domain, leadId);
      const markImported = db.prepare('UPDATE lead_search_results SET imported_lead_id=?,imported_at=COALESCE(imported_at,datetime(\'now\')) ' +
        'WHERE job_id=? AND id=? AND imported_lead_id IS NULL');
      let markedCount = 0;
      for (const row of selected) {
        const leadId = leadByDomain.get(String(row.canonical_domain || '').toLowerCase());
        if (leadId) markedCount += markImported.run(leadId, row.job_id, row.id).changes;
      }
      return { website_discovery_job: websiteDiscoveryJob, imported_count: fresh.length,
        already_imported_count: selected.filter(row => row.imported_lead_id).length,
        duplicate_domain_count: Math.max(0, selected.length - new Set(selected.map(row => row.canonical_domain)).size),
        marked_count: markedCount };
    }).immediate();
  }

  function recover() {
    return db.prepare(`UPDATE lead_search_jobs SET status='interrupted',error_code='process_interrupted',
      finished_at=datetime('now') WHERE status='running'`).run().changes;
  }

  recover();
  return { publicStatus, saveConfiguration, testConnection, search, loadNextPage, listJobs, getJob, importResults, importSelectedResults, recover };
}
