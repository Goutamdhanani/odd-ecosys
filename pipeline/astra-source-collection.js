import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { createSafeFetcher } from './ssrf-guard.js';
import { ASTRA_LOCAL_SEARCH_ENGINE, ASTRA_LOCAL_SEARCH_ORIGIN, createAstraLocalSearchTransport, isAstraLocalSearchEnabled, isAstraLocalSearchTestTransport } from './astra-local-search-transport.js';
import { normalizeResearchDomain, saveResearchSnapshot } from './astra-evidence.js';

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_SEARCH_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 30;
const APPROVALS_ENV = 'ASTRA_SOURCE_COLLECTION_APPROVALS_JSON';
const LOCAL_SEARCH_ENABLED_ENV = 'ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED';
const FETCH_DECISIONS = ['source.public-websites', 'glm.input-processing-and-data-protection'];
const SEARCH_DECISIONS = ['source.searxng-instance-and-engines', 'glm.input-processing-and-data-protection'];
const RIGHTS = new Set(['licensed', 'public_terms_permitted']);
const HASH = /^[a-f0-9]{64}$/i;
const defaultSafeFetch = createSafeFetcher({ maxRequests: 24, maxConcurrency: 1, budgetWindowMs: 60_000 });

function error(message, statusCode = 400, code = 'source_collection_invalid') {
  const result = new Error(message); result.statusCode = statusCode; result.code = code; return result;
}
function boundedText(value, field, max) {
  if (typeof value !== 'string') throw error(`${field} is required.`);
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe || safe.length > max) throw error(`${field} must contain 1 to ${max} characters.`);
  return safe;
}
function publicSearchLabel(value, field, max) {
  const safe = boundedText(value, field, max);
  if (/@|https?:\/\/|\b(?:email|phone|contact|person|lead|crm|prompt)\b/i.test(safe) || /\d{5,}/.test(safe)) {
    throw error(`${field} must be a public business category or location label.`);
  }
  return safe;
}
function uuid(value, field = 'jobId') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw error(`${field} must be a UUID.`);
  return value.toLowerCase();
}
function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
}

// A bounded retry gets a new immutable source job. Keep the identity stable
// across lost acknowledgements, and include the tenant in the derivation so a
// caller cannot collide with another tenant's successor.
export function deriveAstraSourceSuccessorId({ tenantId, sourceJobId, sourceRunId, logicalJobId, candidateKey }) {
  const seed = ['astra-source-successor-v1', uuid(tenantId, 'tenantId'), uuid(sourceJobId), uuid(sourceRunId, 'sourceRunId'),
    String(logicalJobId || ''), String(candidateKey || '')].join('\n');
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sanitizedHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw error('sourceUrl must be an HTTPS page URL.');
  let parsed;
  try { parsed = new URL(value); } catch { throw error('sourceUrl must be an HTTPS page URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port && parsed.port !== '443' || parsed.search || parsed.hash) {
    throw error('Use an HTTPS source URL without credentials, query parameters, fragments, or a nonstandard port.');
  }
  const normalized = normalizeResearchDomain(parsed.href);
  return { url: normalized.url, domain: normalized.domain };
}
function isoFuture(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.valueOf() > Date.now() ? date.toISOString() : null;
}
function approvalRefs(input) {
  if (!Array.isArray(input) || input.length > 8) return [];
  const seen = new Set();
  return input.filter(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.decisionId === 'string' && /^[a-z][a-z0-9.-]{2,100}$/.test(item.decisionId)
    && typeof item.reference === 'string' && item.reference.trim().length > 0 && item.reference.trim().length <= 500
    && HASH.test(item.evidenceSha256 || '') && !seen.has(item.decisionId) && seen.add(item.decisionId))
    .map(item => ({ decisionId: item.decisionId, reference: item.reference.trim(), evidenceSha256: item.evidenceSha256.toLowerCase() }));
}
function recordedRights(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    rightsPolicy: RIGHTS.has(body.rightsPolicy) ? body.rightsPolicy : null,
    rightsAttested: body.rightsAttested === true,
    rightsEvidenceReference: typeof body.rightsEvidenceReference === 'string' && body.rightsEvidenceReference.trim().length <= 500 ? body.rightsEvidenceReference.trim() : null,
    robotsAllowed: body.robotsAllowed === true,
    robotsEvidenceReference: typeof body.robotsEvidenceReference === 'string' && body.robotsEvidenceReference.trim().length <= 500 ? body.robotsEvidenceReference.trim() : null,
    rightsReviewedAt: typeof body.rightsReviewedAt === 'string' && Number.isFinite(new Date(body.rightsReviewedAt).valueOf())
      && new Date(body.rightsReviewedAt).valueOf() <= Date.now() ? new Date(body.rightsReviewedAt).toISOString() : null,
    rightsExpiresAt: isoFuture(body.rightsExpiresAt),
  };
}
function parseApprovalEntries() {
  const raw = process.env[APPROVALS_ENV];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : parsed?.approvals;
    if (!Array.isArray(entries)) return [];
    return entries.filter(x => x && typeof x === 'object' && x.status === 'approved'
      && typeof x.decisionId === 'string' && typeof x.reference === 'string' && x.reference.trim().length > 0
      && HASH.test(x.evidenceSha256 || '') && (x.scope === undefined || typeof x.scope === 'string') && isoFuture(x.expiresAt))
      .map(x => ({ ...x, reference: x.reference.trim(), evidenceSha256: x.evidenceSha256.toLowerCase() }));
  } catch { return []; }
}
function serverApprovalRefs(jobType, request) {
  const required = jobType === 'fetch' ? FETCH_DECISIONS : SEARCH_DECISIONS;
  let scope = null;
  if (jobType === 'fetch') scope = request?.normalizedDomain;
  else {
    try { scope = searchProviderConfiguration().origin; } catch { return null; }
  }
  if (typeof scope !== 'string' || !scope) return null;
  const entries = parseApprovalEntries();
  const refs = [];
  for (const decisionId of required) {
    const matches = entries.filter(entry => entry.decisionId === decisionId
      && (entry.scope === undefined || entry.scope === scope));
    if (matches.length !== 1) return null;
    const approval = matches[0];
    if (decisionId === 'source.public-websites' && approval.scope !== scope) return null;
    if (decisionId === 'source.searxng-instance-and-engines' && approval.scope !== scope) return null;
    refs.push({ decisionId, reference: approval.reference, evidenceSha256: approval.evidenceSha256 });
  }
  return refs;
}
function policyBlock(job) {
  const rights = job.rightsRecord || {};
  if (!rights.rightsAttested || !rights.robotsAllowed || !RIGHTS.has(rights.rightsPolicy)
    || !rights.rightsEvidenceReference || !rights.robotsEvidenceReference || !rights.rightsReviewedAt
    || !rights.rightsExpiresAt || new Date(rights.rightsExpiresAt).valueOf() <= Date.now()) return 'source_rights_unknown_or_expired';
  const required = job.jobType === 'fetch' ? FETCH_DECISIONS : SEARCH_DECISIONS;
  const supplied = new Map((job.approvalReferences || []).map(x => [x.decisionId, x]));
  const registry = parseApprovalEntries();
  let searchOrigin = null;
  let searchProvider = null;
  if (job.jobType === 'search') {
    try { searchProvider = searchProviderConfiguration(); searchOrigin = searchProvider.origin; }
    catch { return 's01_approval_unknown_or_expired'; }
  }
  for (const id of required) {
    const ref = supplied.get(id);
    if (!ref) return 's01_approval_unknown_or_expired';
    const matches = registry.filter(approval => approval.decisionId === id
      && approval.reference === ref.reference
      && approval.evidenceSha256 === ref.evidenceSha256.toLowerCase()
      && (id !== 'source.public-websites' || approval.scope === job.request?.normalizedDomain)
      && (id !== 'source.searxng-instance-and-engines' || approval.scope === searchOrigin));
    if (matches.length !== 1) return 's01_approval_unknown_or_expired';
  }
  if (job.jobType === 'search' && searchProvider?.mode === 'local') return null;
  if (process.env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED !== 'true') return 'remote_transport_disabled';
  return null;
}
export function getAstraSearchPolicyBlock(request, sourceRights) {
  return policyBlock({ jobType: 'search', request, rightsRecord: recordedRights(sourceRights),
    approvalReferences: serverApprovalRefs('search', request) || [] });
}
export function getAstraWebsitePolicyBlock(sourceUrl, sourceRights) {
  const source = sanitizedHttpsUrl(sourceUrl);
  const request = { sourceUrl: source.url, normalizedDomain: source.domain };
  return policyBlock({ jobType: 'fetch', request, rightsRecord: recordedRights(sourceRights),
    approvalReferences: serverApprovalRefs('fetch', request) || [] });
}
function normalizeSearchFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('Search fields are required.');
  const allowed = new Set(['category', 'country', 'city', 'approvalReferences', 'sourceRights', 'approvalMode']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw error('Search accepts only public category, country, city, and S01 approval references.');
  const category = publicSearchLabel(input.category, 'category', 80);
  const country = publicSearchLabel(input.country, 'country', 80);
  const city = input.city == null || input.city === '' ? '' : publicSearchLabel(input.city, 'city', 80);
  return { category, country, city };
}
function searchQuery(fields) { return [fields.category, fields.city, fields.country].filter(Boolean).join(' '); }
function localSearchEnabled() {
  try { return isAstraLocalSearchEnabled(process.env); }
  catch { throw error(`Local search requires ${LOCAL_SEARCH_ENABLED_ENV}=true and the exact pinned loopback origin.`, 503, 'source_search_unavailable'); }
}
function safeSearchOrigin(env = process.env) {
  const raw = env.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN;
  if (!raw) throw error('Server-owned SearXNG origin is not configured.', 503, 'source_search_unavailable');
  let url;
  try { url = new URL(raw); } catch { throw error('Server-owned SearXNG origin is invalid.', 503, 'source_search_unavailable'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !hostname.includes('.') || net.isIP(hostname)
    || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || url.port && url.port !== '443') {
    throw error('Server-owned SearXNG origin must be an HTTPS origin without path, credentials, query, or fragment.', 503, 'source_search_unavailable');
  }
  return url.origin;
}
export function isAstraPublicSearchOriginConfigured(env = process.env) {
  try { safeSearchOrigin(env); return true; }
  catch { return false; }
}
function searchProviderConfiguration() {
  if (localSearchEnabled()) return { mode: 'local', origin: ASTRA_LOCAL_SEARCH_ORIGIN, engine: ASTRA_LOCAL_SEARCH_ENGINE };
  return { mode: 'remote', origin: safeSearchOrigin(), engine: null };
}
function canonicalCandidate(row) {
  if (!row || typeof row !== 'object' || typeof row.url !== 'string' || row.url.length > 4096) return null;
  let url;
  try { url = new URL(row.url); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.port && !['80', '443'].includes(url.port)) return null;
  let normalized;
  try { normalized = normalizeResearchDomain(url.href); } catch { return null; }
  const title = typeof row.title === 'string' ? row.title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280) : '';
  if (!title) return null;
  return { title, url: normalized.url, canonicalDomain: normalized.domain,
    snippet: typeof (row.content ?? row.snippet) === 'string' ? String(row.content ?? row.snippet).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) : '',
    engine: typeof row.engine === 'string' ? row.engine.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) : '' };
}
function robotsAllows(text, pathname) {
  let active = false, disallow = [], allow = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.split('#', 1)[0].match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2];
    if (key === 'user-agent') { active = value === '*' || value.toLowerCase() === 'odd-ecosys'; continue; }
    if (active && key === 'disallow' && value) disallow.push(value);
    if (active && key === 'allow' && value) allow.push(value);
  }
  const matching = [...allow.map(path => ({ path, allow: true })), ...disallow.map(path => ({ path, allow: false }))]
    .filter(rule => {
      const endAnchored = rule.path.endsWith('$');
      const path = endAnchored ? rule.path.slice(0, -1) : rule.path;
      const escaped = path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      try { return new RegExp(`^${escaped}${endAnchored ? '$' : ''}`).test(pathname); } catch { return false; }
    }).sort((a, b) => b.path.replace(/[*$]/g, '').length - a.path.replace(/[*$]/g, '').length);
  return matching[0]?.allow !== false;
}

/** Durable tenant-scoped collection jobs. Network is opt-in and S01-gated before any resolver or fetcher runs. */
export function createAstraSourceCollectionManager(db, { now = () => new Date(), workerAvailable = true, withRequestAdmission = null,
  localSearchTransportForTests = null } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('A tenant-scoped database client is required.');
  if (localSearchTransportForTests && !isAstraLocalSearchTestTransport(localSearchTransportForTests)) {
    throw new TypeError('Local search test transports must be created with the trusted loopback-only constructor seam.');
  }
  // Admission is injected only by the trusted live worker. The regular source
  // collector keeps its historic behavior; the live integration fails closed
  // if it cannot provide this wrapper. The wrapper encloses the actual safe
  // fetch (including DNS/SSRF checks and response handling), not a permit-only
  // window before it.
  const safeFetch = (input, options = {}, context = {}) => {
    const dispatch = () => defaultSafeFetch(input, options);
    return withRequestAdmission ? withRequestAdmission({
      ...context, url: String(input), signal: options.signal || context.signal || null,
    }, dispatch) : dispatch();
  };
  // The injected transport is a trusted constructor seam for isolated tests;
  // API input and environment configuration cannot supply a destination.
  const localSearchTransport = localSearchTransportForTests || createAstraLocalSearchTransport();
  const localSearchFetch = (input, options = {}, context = {}) => {
    if (!withRequestAdmission) throw error('Trusted local search request admission is unavailable.', 503, 'source_request_admission_unavailable');
    const dispatch = () => localSearchTransport(input, options);
    return withRequestAdmission({
      ...context, url: String(input), signal: options.signal || context.signal || null,
    }, dispatch);
  };

  async function createFetchJob(actor, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sourceUrl', 'sourceRights', 'approvalReferences', 'approvalMode'].includes(key))) throw error('Unsupported source fetch fields were supplied.');
    if (input.approvalMode !== undefined && input.approvalMode !== 'server') throw error('approvalMode must be server when supplied.');
    if (input.approvalMode === 'server' && Object.hasOwn(input, 'approvalReferences')) throw error('Server approval mode cannot be combined with client approval references.', 400, 'source_approval_mode_conflict');
    const source = sanitizedHttpsUrl(input.sourceUrl);
    const jobId = randomUUID(), createdAt = now().toISOString();
    const rights = recordedRights(input.sourceRights);
    const request = { sourceUrl: source.url, normalizedDomain: source.domain, captureKind: 'provider_observed', requestedAt: createdAt };
    const approvals = input.approvalMode === 'server' ? serverApprovalRefs('fetch', request) || [] : approvalRefs(input.approvalReferences);
    const blockedReason = policyBlock({ jobType: 'fetch', request, rightsRecord: rights, approvalReferences: approvals }) || (!workerAvailable ? 'worker_unavailable' : null);
    const result = await db.query(`INSERT INTO astra.source_collection_jobs(tenant_id,id,job_type,status,blocked_reason,request,approval_references,rights_record,created_by,created_at,updated_at,finished_at)
      VALUES($1,$2,'fetch',$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$9,$10)
      RETURNING id,job_type AS "jobType",status,blocked_reason AS "blockedReason",created_at AS "createdAt"`,
    [actor.tenantId, jobId, blockedReason ? 'blocked' : 'queued', blockedReason, JSON.stringify(request), JSON.stringify(approvals), JSON.stringify(rights), String(actor.userId), createdAt, blockedReason ? createdAt : null]);
    return result.rows[0];
  }

  async function createSearchJob(actor, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['category', 'country', 'city', 'approvalReferences', 'sourceRights', 'approvalMode'].includes(key))) throw error('Unsupported business search fields were supplied.');
    if (input.approvalMode !== undefined && input.approvalMode !== 'server') throw error('approvalMode must be server when supplied.');
    if (input.approvalMode === 'server' && Object.hasOwn(input, 'approvalReferences')) throw error('Server approval mode cannot be combined with client approval references.', 400, 'source_approval_mode_conflict');
    const fields = normalizeSearchFields(input);
    const jobId = randomUUID(), createdAt = now().toISOString();
    const rights = recordedRights(input.sourceRights);
    const request = { fields, querySha256: null, requestedAt: createdAt, captureKind: 'provider_observed' };
    const approvals = input.approvalMode === 'server' ? serverApprovalRefs('search', request) || [] : approvalRefs(input.approvalReferences);
    const blockedReason = policyBlock({ jobType: 'search', request, rightsRecord: rights, approvalReferences: approvals }) || (!workerAvailable ? 'worker_unavailable' : null);
    const result = await db.query(`INSERT INTO astra.source_collection_jobs(tenant_id,id,job_type,status,blocked_reason,request,approval_references,rights_record,created_by,created_at,updated_at,finished_at)
      VALUES($1,$2,'search',$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$9,$10)
      RETURNING id,job_type AS "jobType",status,blocked_reason AS "blockedReason",created_at AS "createdAt"`,
    [actor.tenantId, jobId, blockedReason ? 'blocked' : 'queued', blockedReason, JSON.stringify(request), JSON.stringify(approvals), JSON.stringify(rights), String(actor.userId), createdAt, blockedReason ? createdAt : null]);
    return result.rows[0];
  }

  async function getJob(tenantId, jobId) {
    const result = await db.query(`SELECT id,job_type AS "jobType",status,blocked_reason AS "blockedReason",error_code AS "errorCode",
      source_id AS "sourceId",evidence_id AS "evidenceId",result_count AS "resultCount",latest_run_id AS "latestRunId",created_at AS "createdAt",
      started_at AS "startedAt",finished_at AS "finishedAt",updated_at AS "updatedAt"
      FROM astra.source_collection_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, uuid(jobId)]);
    if (!result.rowCount) return null;
    const job = result.rows[0];
    if (job.latestRunId) {
      const run = await db.query(`SELECT id,status,provenance,outcome,created_at AS "createdAt",finished_at AS "finishedAt"
        FROM astra.source_collection_runs WHERE tenant_id=$1 AND id=$2 AND job_id=$3`, [tenantId, job.latestRunId, job.id]);
      job.latestRun = run.rows[0] || null;
    }
    if (job.jobType === 'search') {
      const candidates = await db.query(`SELECT id,title,canonical_domain AS "canonicalDomain",source_url AS "sourceUrl",snippet,
        engine,independence_key AS "independenceKey",lineage,created_at AS "createdAt"
        FROM astra.source_collection_candidates WHERE tenant_id=$1 AND job_id=$2 ORDER BY position,id LIMIT 30`, [tenantId, job.id]);
      job.candidates = candidates.rows.map(row => ({ ...row, verified: false, candidateOnly: true, independentConfirmation: false, sourceContentUntrusted: true }));
    }
    return job;
  }

  async function listJobs(tenantId, { limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
    const result = await db.query(`SELECT id,job_type AS "jobType",status,blocked_reason AS "blockedReason",error_code AS "errorCode",
      source_id AS "sourceId",evidence_id AS "evidenceId",result_count AS "resultCount",latest_run_id AS "latestRunId",created_at AS "createdAt",
      started_at AS "startedAt",finished_at AS "finishedAt",updated_at AS "updatedAt"
      FROM astra.source_collection_jobs WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT $2`, [tenantId, bounded]);
    return result.rows;
  }

  /** Called in a short worker transaction. The caller must commit before doing I/O. */
  async function claim(tenantId, jobId) {
    const id = uuid(jobId);
    const picked = await db.query(`SELECT id,job_type AS "jobType",request,approval_references AS "approvalReferences",rights_record AS "rightsRecord",
      created_by AS "createdBy",status FROM astra.source_collection_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE SKIP LOCKED`, [tenantId, id]);
    if (!picked.rowCount) return null;
    const job = picked.rows[0];
    if (job.status !== 'queued') return { alreadyClaimed: true, status: job.status, jobId: id };
    if (job.jobType === 'fetch') {
      const previous = await db.query(`SELECT etag,last_modified AS "lastModified",content_sha256 AS "contentSha256",evidence_id AS "evidenceId"
        FROM astra.source_collection_observations WHERE tenant_id=$1 AND normalized_domain=$2 ORDER BY observed_at DESC,id DESC LIMIT 1`,
      [tenantId, job.request.normalizedDomain]);
      job.previousObservation = previous.rows[0] || null;
    }
    const runId = randomUUID(), startedAt = now().toISOString();
    const provenance = { runId, jobId: id, jobType: job.jobType, captureKind: 'provider_observed', startedAt,
      workerMode: 'explicit_one_shot', transportGate: 'checked_before_dns_or_io', releaseReady: false };
    await db.query(`INSERT INTO astra.source_collection_runs(tenant_id,id,job_id,status,provenance,created_at,updated_at)
      VALUES($1,$2,$3,'started',$4::jsonb,$5,$5)`, [tenantId, runId, id, JSON.stringify(provenance), startedAt]);
    await db.query(`UPDATE astra.source_collection_jobs SET status='running',started_at=$3,finished_at=NULL,blocked_reason=NULL,error_code=NULL,
      latest_run_id=$4,updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='queued'`, [tenantId, id, startedAt, runId]);
    return { ...job, id, runId, startedAt, provenance, alreadyClaimed: false };
  }

  async function finish(tenantId, claimInfo, { status, blockedReason = null, errorCode = null, source = null, observation = null, candidates = [], provenance = {} } = {}) {
    const finishedAt = now().toISOString();
    let saved = null;
    if (source) saved = await saveResearchSnapshot(db, { tenantId, userId: claimInfo.createdBy }, {
      sourceUrl: source.url, html: source.html, mediaType: source.mediaType, rightsPolicy: claimInfo.rightsRecord.rightsPolicy,
      rightsAttested: true, robotsAllowed: true, rightsExpiresAt: claimInfo.rightsRecord.rightsExpiresAt,
    });
    for (const [index, item] of candidates.entries()) {
      await db.query(`INSERT INTO astra.source_collection_candidates(tenant_id,id,job_id,position,title,canonical_domain,source_url,snippet,engine,independence_key,lineage,created_at)
        VALUES($1,gen_random_uuid(),$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) ON CONFLICT(tenant_id,job_id,canonical_domain) DO NOTHING`,
      [tenantId, claimInfo.id, index + 1, item.title, item.canonicalDomain, item.url, item.snippet, item.engine,
        `searxng:${item.canonicalDomain}`, JSON.stringify(item.lineage), finishedAt]);
    }
    let evidenceId = saved?.evidence?.id || null;
    let sourceId = saved?.evidence?.sourceId || null;
    if (!saved && observation?.evidenceId) {
      const previous = await db.query(`SELECT id,source_id AS "sourceId" FROM astra.research_evidence WHERE tenant_id=$1 AND id=$2`, [tenantId, observation.evidenceId]);
      if (previous.rowCount) { evidenceId = previous.rows[0].id; sourceId = previous.rows[0].sourceId; }
    }
    if (claimInfo.jobType === 'fetch' && status === 'completed' && observation && evidenceId && sourceId) {
      await db.query(`INSERT INTO astra.source_collection_observations(tenant_id,id,job_id,run_id,normalized_domain,etag,last_modified,content_sha256,evidence_id,outcome,observed_at)
        VALUES($1,gen_random_uuid(),$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, claimInfo.id, claimInfo.runId, claimInfo.request.normalizedDomain, observation.etag || null,
        observation.lastModified || null, observation.contentSha256, evidenceId, observation.outcome, finishedAt]);
    }
    const runOutcome = { ...provenance, status, blockedReason, errorCode, finishedAt,
      evidenceId, sourceId,
      contentSha256: observation?.contentSha256 || (saved?.evidence?.content_sha256 ? String(saved.evidence.content_sha256).trim() : null),
      candidateCount: candidates.length, candidateOnly: claimInfo.jobType === 'search', sourceContentUntrusted: Boolean(evidenceId),
      noAutomaticSend: true, noModelCall: true, releaseReady: false };
    await db.query(`UPDATE astra.source_collection_runs SET status=$4,outcome=$5::jsonb,finished_at=$6,updated_at=$6
      WHERE tenant_id=$1 AND id=$2 AND job_id=$3 AND status='started'`, [tenantId, claimInfo.runId, claimInfo.id, status, JSON.stringify(runOutcome), finishedAt]);
    await db.query(`UPDATE astra.source_collection_jobs SET status=$3,blocked_reason=$4,error_code=$5,source_id=$6,evidence_id=$7,
      result_count=$8,finished_at=$9,updated_at=$9 WHERE tenant_id=$1 AND id=$2 AND status='running'`,
    [tenantId, claimInfo.id, status, blockedReason, errorCode, sourceId, evidenceId,
      candidates.length || (evidenceId ? 1 : 0), finishedAt]);
    return { id: claimInfo.id, runId: claimInfo.runId, status, blockedReason, errorCode,
      evidenceId, sourceId, candidateCount: candidates.length, releaseReady: false };
  }

  // A pause or lost parent fence is recorded as a terminal immutable attempt.
  // Native 025 forbids running->queued and rebinding latest_run_id, so a proven
  // pre-transport retry must use one deterministic successor job.
  async function deferBeforeDispatch(tenantId, claimInfo, { errorCode, provenance = {} } = {}) {
    if (!['job_paused', 'lease_lost'].includes(errorCode) || provenance.transportAttempted !== false
      || provenance.dnsAttempted !== false || provenance.requestReservationAttempted !== false) {
      throw error('The source attempt does not have explicit retry-safe provenance.', 409, 'source_request_outcome_uncertain');
    }
    const finishedAt = now().toISOString();
    const outcome = { ...provenance, status: 'deferred', retrySafe: true, errorCode,
      finishedAt, candidateOnly: claimInfo.jobType === 'search', noAutomaticSend: true,
      noModelCall: true, releaseReady: false };
    const run = await db.query(`UPDATE astra.source_collection_runs SET status='failed',outcome=$4::jsonb,finished_at=$5,updated_at=$5
      WHERE tenant_id=$1 AND id=$2 AND job_id=$3 AND status='started' RETURNING id`,
    [tenantId, claimInfo.runId, claimInfo.id, JSON.stringify(outcome), finishedAt]);
    if (!run.rowCount) throw error('The source run could not be safely deferred.', 409, 'source_request_outcome_uncertain');
    const job = await db.query(`UPDATE astra.source_collection_jobs SET status='failed',blocked_reason=NULL,error_code=$4,
      finished_at=$5,updated_at=$5 WHERE tenant_id=$1 AND id=$2 AND status='running' AND latest_run_id=$3 RETURNING id`,
    [tenantId, claimInfo.id, claimInfo.runId, errorCode, finishedAt]);
    if (!job.rowCount) throw error('The claimed source job changed before safe deferral.', 409, 'source_request_outcome_uncertain');
    return { id: claimInfo.id, runId: claimInfo.runId, status: 'failed', deferred: true, retrySafe: true, errorCode,
      transportAttempted: false, releaseReady: false };
  }

  async function createRetrySuccessor({ tenantId, logicalJobId, candidateKey, sourceJobId, sourceRunId, successorJobId }) {
    const parentId = uuid(sourceJobId);
    const runId = uuid(sourceRunId, 'sourceRunId');
    const successorId = uuid(successorJobId, 'successorJobId');
    const expectedId = deriveAstraSourceSuccessorId({ tenantId, sourceJobId: parentId, sourceRunId: runId, logicalJobId, candidateKey });
    if (successorId !== expectedId || typeof logicalJobId !== 'string' || logicalJobId.length < 1 || logicalJobId.length > 128
      || typeof candidateKey !== 'string' || !/^[a-f0-9]{64}$/.test(candidateKey)) {
      throw error('The source successor identity is invalid.', 400, 'source_successor_invalid');
    }
    const locked = await db.query(`SELECT job.job_type AS "jobType",job.status,job.request,job.approval_references AS "approvalReferences",
      job.rights_record AS "rightsRecord",job.created_by AS "createdBy",run.outcome
      FROM astra.source_collection_jobs job JOIN astra.source_collection_runs run
        ON run.tenant_id=job.tenant_id AND run.job_id=job.id AND run.id=job.latest_run_id
      WHERE job.tenant_id=$1 AND job.id=$2 AND run.id=$3 FOR UPDATE OF job`, [tenantId, parentId, runId]);
    if (!locked.rowCount) throw error('The proven source attempt is unavailable in this tenant.', 404, 'source_successor_unavailable');
    const original = locked.rows[0], proof = original.outcome || {};
    if (original.status !== 'failed' || proof.status !== 'deferred' || proof.retrySafe !== true
      || !['job_paused', 'lease_lost'].includes(proof.errorCode) || proof.transportAttempted !== false
      || proof.dnsAttempted !== false || proof.requestReservationAttempted !== false
      || original.request?.retryLineage?.protocol === 'pre-dispatch-successor-v1') {
      throw error('This source job has no eligible retry-safe terminal attempt.', 409, 'source_request_outcome_uncertain');
    }
    const lineage = { protocol: 'pre-dispatch-successor-v1', logicalJobId, candidateKey,
      predecessorJobId: parentId, predecessorRunId: runId, depth: 1 };
    const request = { ...original.request, retryLineage: lineage };
    const inserted = await db.query(`INSERT INTO astra.source_collection_jobs(tenant_id,id,job_type,status,blocked_reason,request,
      approval_references,rights_record,created_by,created_at,updated_at,finished_at)
      VALUES($1,$2,$3,'queued',NULL,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$8,NULL)
      ON CONFLICT(tenant_id,id) DO NOTHING RETURNING id,job_type AS "jobType",status,request,created_at AS "createdAt"`,
    [tenantId, successorId, original.jobType, JSON.stringify(request), JSON.stringify(original.approvalReferences),
      JSON.stringify(original.rightsRecord), original.createdBy, now().toISOString()]);
    const saved = inserted.rows[0] || (await db.query(`SELECT id,job_type AS "jobType",status,request,created_at AS "createdAt"
      FROM astra.source_collection_jobs WHERE tenant_id=$1 AND id=$2`, [tenantId, successorId])).rows[0];
    if (!saved || saved.jobType !== original.jobType || saved.status !== 'queued'
      || JSON.stringify(stableJson(saved.request?.retryLineage)) !== JSON.stringify(stableJson(lineage))
      || JSON.stringify(stableJson({ ...saved.request, retryLineage: undefined }))
        !== JSON.stringify(stableJson({ ...original.request, retryLineage: undefined }))) {
      throw error('The deterministic source successor conflicts with different immutable facts.', 409, 'source_successor_conflict');
    }
    return { id: saved.id, jobType: saved.jobType, status: saved.status, retryLineage: lineage, replayed: !inserted.rowCount };
  }

  async function fetchWebsite(job, { signal, beforeRequest, reserveRequest } = {}) {
    const { url, domain } = sanitizedHttpsUrl(job.request.sourceUrl);
    const robotsUrl = new URL('/robots.txt', url);
    const robotsResponse = await safeFetch(robotsUrl, { method: 'GET', redirect: 'manual', maxRedirects: 0, maxBytes: 128 * 1024, timeoutMs: 8000, signal, headers: { 'user-agent': 'OddEcosysResearch/1.0 (+source-rights-reviewed)' } }, { operation: 'robots', jobId: job.id, signal, beforeRequest, reserveRequest });
    if ([301, 302, 303, 307, 308].includes(robotsResponse.status) || !robotsResponse.ok) throw error('Robots policy could not be confirmed.', 403, 'robots_policy_unavailable');
    if (robotsResponse.headers.get('content-encoding') && robotsResponse.headers.get('content-encoding') !== 'identity') throw error('Compressed robots responses are not accepted.', 502, 'remote_content_encoding_rejected');
    const robotsText = await robotsResponse.text();
    const parsed = new URL(url);
    if (!robotsAllows(robotsText, parsed.pathname)) throw error('The current robots policy disallows this page.', 403, 'robots_disallowed');
    const headers = { 'user-agent': 'OddEcosysResearch/1.0 (+source-rights-reviewed)', accept: 'text/html' };
    const previous = job.previousObservation || null;
    if (previous?.etag && previous.etag.length <= 512 && !/[\r\n]/.test(previous.etag)) headers['if-none-match'] = previous.etag;
    if (previous?.lastModified && previous.lastModified.length <= 120 && !/[\r\n]/.test(previous.lastModified)) headers['if-modified-since'] = previous.lastModified;
    const response = await safeFetch(url, { method: 'GET', redirect: 'manual', maxRedirects: 0, maxBytes: MAX_HTML_BYTES, timeoutMs: 10_000, signal, headers }, { operation: 'page', jobId: job.id, signal, beforeRequest, reserveRequest });
    const etagHeader = response.headers.get('etag');
    const etag = etagHeader && etagHeader.length <= 512 && !/[\r\n]/.test(etagHeader) ? etagHeader : null;
    const lastModifiedHeader = response.headers.get('last-modified');
    const lastModified = lastModifiedHeader && lastModifiedHeader.length <= 120 && !/[\r\n]/.test(lastModifiedHeader) ? lastModifiedHeader : null;
    if (response.status === 304 && previous?.evidenceId && HASH.test(String(previous.contentSha256 || '').trim())) {
      return { unchanged: true, url, observation: { etag: etag || previous.etag, lastModified: lastModified || previous.lastModified,
        contentSha256: String(previous.contentSha256).trim(), evidenceId: previous.evidenceId, outcome: 'not_modified' } };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      let target;
      try { target = sanitizedHttpsUrl(new URL(location, url).href); } catch { throw error('Redirect target is invalid or outside the recorded source policy.', 403, 'redirect_policy_blocked'); }
      if (target.domain !== domain) throw error('Cross-domain redirect requires a separately recorded source policy.', 403, 'redirect_policy_blocked');
      throw error('Redirects require a separately approved explicit source URL.', 403, 'redirect_policy_blocked');
    }
    if (!response.ok) throw error('Website returned an unsuccessful response.', 502, 'source_response_unavailable');
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('text/html')) throw error('Website did not return text/html.', 415, 'source_content_type_rejected');
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') throw error('Compressed responses are not accepted.', 502, 'remote_content_encoding_rejected');
    const html = Buffer.from(await response.arrayBuffer());
    if (!html.length || html.length > MAX_HTML_BYTES) throw error('Website response is outside the snapshot byte limit.', 413, 'snapshot_too_large');
    const contentSha256 = createHash('sha256').update(html).digest('hex');
    if (previous?.evidenceId && String(previous.contentSha256 || '').trim() === contentSha256) {
      return { unchanged: true, url, observation: { etag: etag || previous.etag, lastModified: lastModified || previous.lastModified,
        contentSha256, evidenceId: previous.evidenceId, outcome: 'hash_unchanged' } };
    }
    return { url, html, mediaType: type, observation: { etag, lastModified, contentSha256, evidenceId: null, outcome: 'captured' } };
  }

  async function searchBusinesses(job, { signal, beforeRequest, reserveRequest } = {}) {
    const provider = searchProviderConfiguration();
    const { origin } = provider;
    const fields = job.request.fields;
    const query = searchQuery(fields);
    const url = new URL('/search', origin); url.searchParams.set('q', query); url.searchParams.set('format', 'json');
    if (provider.mode === 'local') url.searchParams.set('engines', ASTRA_LOCAL_SEARCH_ENGINE);
    const transport = provider.mode === 'local' ? localSearchFetch : safeFetch;
    const response = await transport(url, { method: 'GET', redirect: 'error', maxRedirects: 0, maxBytes: MAX_SEARCH_BYTES, timeoutMs: 10_000, signal,
      headers: { accept: 'application/json', 'user-agent': 'OddEcosysResearch/1.0' } }, { operation: 'search', jobId: job.id, signal, beforeRequest, reserveRequest });
    if (!response.ok || provider.mode === 'local' && response.status !== 200) throw error('Configured search service returned an unsuccessful response.', 502, 'search_response_unavailable');
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const validJsonContentType = provider.mode === 'local'
      ? /^application\/json(?:\s*;|$)/.test(contentType)
      : contentType.includes('application/json');
    if (!validJsonContentType) throw error('Configured search service did not return JSON.', 415, 'search_content_type_rejected');
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw error('Compressed search results are not accepted.', 502, 'remote_content_encoding_rejected');
    let body;
    try { body = await response.json(); }
    catch { throw error('Search results were not valid JSON.', 502, 'search_response_invalid'); }
    if (!Array.isArray(body?.results)) throw error('Search results did not match the expected response shape.', 502, 'search_response_invalid');
    const seen = new Set(), candidates = [];
    for (const row of body.results.slice(0, MAX_SEARCH_RESULTS * 3)) {
      if (provider.mode === 'local' && (typeof row?.engine !== 'string' || row.engine.trim().toLowerCase() !== ASTRA_LOCAL_SEARCH_ENGINE)) {
        throw error('Local search response included a result outside the pinned engine.', 502, 'search_response_invalid');
      }
      const candidate = canonicalCandidate(row);
      if (!candidate || seen.has(candidate.canonicalDomain)) continue;
      seen.add(candidate.canonicalDomain);
      if (provider.mode === 'local') candidate.engine = ASTRA_LOCAL_SEARCH_ENGINE;
      candidate.lineage = { provider: provider.mode === 'local' ? 'server_configured_local_searxng' : 'server_configured_searxng', origin, queryKind: 'public_business_category_location',
        querySha256: createHash('sha256').update(query).digest('hex'), engine: provider.mode === 'local' ? ASTRA_LOCAL_SEARCH_ENGINE : candidate.engine || null,
        ...(provider.mode === 'local' ? { engineIdentitySource: 'server_pinned_request' } : {}),
        untrustedDiscoveryCandidate: true, sameDomainSyndicationNotIndependent: true, verifiedContact: false };
      candidates.push(candidate);
      if (candidates.length >= MAX_SEARCH_RESULTS) break;
    }
    return { candidates, origin, provider: provider.mode === 'local' ? 'server_configured_local_searxng' : 'server_configured_searxng',
      engine: provider.engine, querySha256: createHash('sha256').update(query).digest('hex') };
  }

  async function runOnce({ store, tenantId, userId, jobId, signal, withRequestAdmission, beforeRequest, reserveRequest,
    localSearchTransportForTests = null } = {}) {
    if (!store || typeof store.withWorkerTenant !== 'function') throw error('Dedicated Astra worker tenant store is unavailable.', 503, 'astra_worker_unavailable');
    const claimed = await store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).claim(tenantId, jobId));
    if (!claimed) return { status: 'not_found', jobId };
    if (claimed.alreadyClaimed) return { status: claimed.status, jobId: claimed.jobId, claimed: false };
    // The claim transaction has committed. No resolver or transport is reached until all policy gates pass.
    const blocked = policyBlock(claimed);
    if (blocked) return store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).finish(tenantId, claimed, { status: 'blocked', blockedReason: blocked,
      provenance: { transportAttempted: false, dnsAttempted: false } }));
    const localSearch = claimed.jobType === 'search' && searchProviderConfiguration().mode === 'local';
    if (localSearch && typeof withRequestAdmission !== 'function') {
      return store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).finish(tenantId, claimed,
        { status: 'failed', errorCode: 'source_request_admission_unavailable',
          provenance: { transportAttempted: false, dnsAttempted: false, requestReservationAttempted: false } }));
    }
    let transportAttempted = false;
    let requestReservationAttempted = false;
    const trackedReserveRequest = typeof reserveRequest === 'function' ? async context => {
      requestReservationAttempted = true;
      return reserveRequest(context);
    } : reserveRequest;
    try {
      const admitted = typeof withRequestAdmission === 'function'
        ? (context, dispatch) => withRequestAdmission(context, () => { transportAttempted = true; return dispatch(); })
        : null;
      const manager = createAstraSourceCollectionManager({ query: async () => { throw new Error('Unreachable manager query.'); } },
        { now, withRequestAdmission: admitted, localSearchTransportForTests });
      if (claimed.jobType === 'fetch') {
        const source = await manager.fetchWebsite(claimed, { signal, beforeRequest, reserveRequest: trackedReserveRequest });
        return store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).finish(tenantId, claimed,
          { status: 'completed', source: source.html ? source : null, observation: source.observation,
            provenance: { transportAttempted: true, dnsAttempted: true, sourceUrl: source.url, captureKind: 'provider_observed', hashObservation: source.observation?.outcome || 'captured' } }));
      }
      const result = await manager.searchBusinesses(claimed, { signal, beforeRequest, reserveRequest: trackedReserveRequest });
      const finalCandidates = result.candidates.map(candidate => ({ ...candidate, lineage: { ...candidate.lineage, origin: result.origin } }));
      return store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).finish(tenantId, claimed,
        { status: 'completed', candidates: finalCandidates, provenance: { transportAttempted: true, dnsAttempted: !localSearch, provider: result.provider, origin: result.origin, engine: result.engine,
          querySha256: result.querySha256, candidateOnly: true, noVerifiedContacts: true } }));
    } catch (cause) {
      // A trusted fetch/admission adapter may carry stronger dispatch
      // provenance on an error; only let it make replay less permissive.
      if (cause?.transportAttempted === true) transportAttempted = true;
      if (!transportAttempted && !requestReservationAttempted && ['job_paused', 'lease_lost'].includes(cause?.code)) {
        return store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).deferBeforeDispatch(tenantId, claimed,
          { errorCode: cause.code, provenance: { transportAttempted: false, dnsAttempted: false,
            requestReservationAttempted: false, failureClass: cause.code } }));
      }
      const knownCodes = new Set(['source_rights_unknown_or_expired', 's01_approval_unknown_or_expired', 'remote_transport_disabled', 'robots_policy_unavailable', 'robots_disallowed', 'redirect_policy_blocked', 'source_response_unavailable', 'source_content_type_rejected', 'remote_content_encoding_rejected', 'snapshot_too_large', 'search_response_unavailable', 'search_response_too_large', 'search_timeout', 'search_content_type_rejected', 'search_response_invalid', 'source_request_admission_unavailable', 'source_request_outcome_uncertain', 'source_budget_exhausted', 'prospecting_reconciliation_required', 'job_cancelled']);
      const code = knownCodes.has(cause?.code) ? cause.code : 'source_collection_failed';
      return store.withWorkerTenant({ tenantId, userId }, db => createAstraSourceCollectionManager(db, { now }).finish(tenantId, claimed,
        { status: 'failed', errorCode: code, provenance: { transportAttempted, dnsAttempted: transportAttempted && !localSearch, failureClass: code } }));
    }
  }

  return { createFetchJob, createSearchJob, createRetrySuccessor, getJob, listJobs, claim, finish, deferBeforeDispatch,
    fetchWebsite, searchBusinesses, runOnce };
}

export async function runAstraSourceCollectionOnce(args) {
  const manager = createAstraSourceCollectionManager({ query: async () => { throw new Error('Worker manager requires tenant context.'); } });
  return manager.runOnce(args);
}
