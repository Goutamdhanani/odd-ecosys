import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAstraPersistence } from './astra-persistence.js';
import { createAstraTenantStore } from './astra-tenant-store.js';
import { createAstraSourceCollectionManager, deriveAstraSourceSuccessorId, getAstraSearchPolicyBlock, getAstraWebsitePolicyBlock, isAstraPublicSearchOriginConfigured, runAstraSourceCollectionOnce } from './astra-source-collection.js';
import { isAstraLocalSearchEnabled } from './astra-local-search-transport.js';
import { getResearchBlob, getResearchEvidence, researchSha256 } from './astra-evidence.js';
import { buildAstraXrayReport, inspectXrayPage } from './astra-xray.js';
import { prepareProspectCampaignClaims } from './astra-prospecting-claims.js';

const MAX_CANDIDATES = 10;
const WORKER_LEASE_MS = 300_000;
const SOURCE_WAIT_POLL_MS = 500;
const SOURCE_WAIT_MAX_MS = 30_000;

function waitForSourcePoll(ms, signal) {
  if (signal?.aborted) return Promise.reject(fail('This job was paused or stopped while waiting for a source attempt.', 409, 'job_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(fail('This job was paused or stopped while waiting for a source attempt.', 409, 'job_cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fail(message, statusCode = 400, code = 'prospecting_invalid') {
  return Object.assign(new Error(message), { name: 'AstraProspectingError', statusCode, code, publicMessage: message });
}

function cleanText(value, field, max, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string') throw fail(`${field} is required.`);
  const result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!result && optional) return '';
  if (!result || result.length > max || /@|https?:\/\/|\b(?:email|phone|contact|person|lead|crm|prompt)\b|\d{5,}/i.test(result)) {
    throw fail(`${field} must be a public business category, location, or goal.`);
  }
  return result;
}

function cleanReference(value, field, max) {
  if (typeof value !== 'string') throw fail(`${field} is required.`);
  const result = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!result || result.length > max || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(result)) throw fail(`${field} must be a short public policy reference.`);
  return result;
}

export function normalizeProspectingRequest(input = {}) {
  const allowed = new Set(['category', 'country', 'city', 'goal', 'targetCount', 'sourceRights']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) {
    throw fail('Only category, location, goal, target count, and source-use review are accepted.');
  }
  const category = cleanText(input.category, 'Business category', 80);
  const country = cleanText(input.country, 'Country', 80);
  const city = cleanText(input.city, 'City', 80, { optional: true });
  const goal = cleanText(input.goal, 'Research goal', 240);
  const targetCount = Number(input.targetCount);
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > MAX_CANDIDATES) {
    throw fail(`Choose between 1 and ${MAX_CANDIDATES} prospects.`);
  }
  const rights = input.sourceRights;
  if (!rights || typeof rights !== 'object' || Array.isArray(rights)
    || Object.keys(rights).some(key => !['rightsEvidenceReference', 'robotsEvidenceReference', 'rightsExpiresAt', 'rightsAttested', 'robotsAllowed'].includes(key))) {
    throw fail('Review source-use and robots access before starting.');
  }
  const rightsEvidenceReference = cleanReference(rights.rightsEvidenceReference, 'Public-use basis reference', 500);
  const robotsEvidenceReference = cleanReference(rights.robotsEvidenceReference, 'Robots rules reference', 500);
  const expires = new Date(rights.rightsExpiresAt);
  if (!rights.rightsAttested || !rights.robotsAllowed || !Number.isFinite(expires.valueOf()) || expires <= new Date()) {
    throw fail('Confirm permitted public use, robots access, and a future review expiry.');
  }
  return {
    category, country, city, goal, targetCount,
    sourceRights: {
      rightsPolicy: 'public_terms_permitted', rightsAttested: true,
      rightsEvidenceReference, robotsAllowed: true,
      robotsEvidenceReference, rightsReviewedAt: new Date().toISOString(),
      rightsExpiresAt: expires.toISOString(),
    },
    budgets: { maxProviderRequests: 10, maxSearchRequests: 1, maxPublicPages: 10, minRequestIntervalMs: 1000 },
  };
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicBlockReason(code) {
  const reasons = {
    source_rights_unknown_or_expired: 'Source-use permission is missing or expired. Review the source terms and start again.',
    s01_approval_unknown_or_expired: 'Workspace source approval is not configured for this search. Ask an administrator to review source access.',
    remote_transport_disabled: 'Public search is disabled for this workspace.',
    worker_unavailable: 'The prospecting worker is not configured yet.',
    source_search_unavailable: 'The approved search service is not configured.',
    search_response_unavailable: 'The search service is unavailable. You can resume this job later.',
    search_response_invalid: 'The search service returned an unusable response. No prospect was saved.',
    source_collection_failed: 'The search could not finish. No contact was created.',
    source_request_outcome_uncertain: 'A public-source request has an uncertain result. This job stopped before further access to prevent a duplicate request.',
    source_request_admission_unavailable: 'Shared source-request accounting is unavailable. No public request was dispatched.',
    source_budget_exhausted: 'The saved public-source request budget has been reached. No further request was dispatched.',
    prospecting_reconciliation_required: 'A saved job checkpoint is still being reconciled. No further source request was dispatched.',
  };
  return reasons[code] || 'The search is blocked by workspace policy or service setup. Review the setup and resume when ready.';
}

function sourceHash(candidate) {
  return digest({ title: candidate.title, sourceUrl: candidate.sourceUrl, snippet: candidate.snippet || '', engine: candidate.engine || '' });
}

function sanitizedCandidate(candidate) {
  const redact = value => String(value || '').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted email]')
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, '[redacted phone]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  return { ...candidate, title: redact(candidate.title).slice(0, 280), snippet: redact(candidate.snippet),
    createdAt: candidate.createdAt instanceof Date ? candidate.createdAt.toISOString() : candidate.createdAt || null };
}

function measuredSignals(candidate, request) {
  let rawText = String(candidate.visibleText || '');
  // The standalone brand heading already supports the separate identity check;
  // strip its first body occurrence so it cannot make a following market-wide
  // sentence look like a statement by this business.
  for (const heading of [...new Set(candidate.h1 || [])]) {
    if (typeof heading === 'string' && heading.trim()) rawText = rawText.replace(heading, ' ');
  }
  const text = rawText.replace(/\s+/g, ' ').trim();
  const lower = text.toLocaleLowerCase();
  const locate = (value, { allowPlural = false } = {}) => {
    const parts = String(value).trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (allowPlural && parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/s$/i, '') + 's?';
    const escaped = parts.join('\\s+');
    const match = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, 'iu').exec(text);
    return match ? { index: match.index + match[0].length - match[1].length, length: match[1].length } : null;
  };
  const excerpt = (index, length) => text.slice(Math.max(0, index - 80), index + length + 100).slice(0, 320);
  const categoryMatch = locate(request.category, { allowPlural: true });
  const category = categoryMatch
    ? { value: request.category, exactExcerpt: excerpt(categoryMatch.index, categoryMatch.length) }
    : null;
  const findLocation = value => {
    if (!value) return null;
    const aliases = { bengaluru: ['Bengaluru', 'Bangalore'], bangalore: ['Bangalore', 'Bengaluru'] };
    const found = (aliases[String(value).toLowerCase()] || [value]).map(label => ({ label, match: locate(label) })).find(item => item.match);
    return !found ? null : { value, observedLabel: found.label, exactExcerpt: excerpt(found.match.index, found.match.length) };
  };
  const country = findLocation(request.country);
  const city = request.city ? findLocation(request.city) : null;
  const location = country && (!request.city || city) ? {
    value: request.city ? `${request.city}, ${request.country}` : request.country,
    exactExcerpt: [...new Set([city?.exactExcerpt, country.exactExcerpt].filter(Boolean))].join(' … ').slice(0, 320),
  } : null;
  const opportunityPattern = /\b(?:hiring|now hiring|expanding|expansion|opening (?:a|an|new) (?:office|location|branch|studio)|new location|seeking (?:a|an|new)|looking for (?:a|an|new)|request for proposal|rfp|accepting proposals)\b/i;
  const negatedPattern = /\b(?:not|never|no longer|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|without)\s+(?:currently\s+|actively\s+)?(?:hiring|expand(?:ing)?|open(?:ing)?|seeking|looking|accepting)\b|\b(?:no plans to|not planning to)\s+(?:hire|expand|open|seek|accept)\b/i;
  const subjectLabel = domainLabel(candidate.canonicalDomain || candidate.normalizedDomain).split(/[-_]/)[0];
  const identity = normalizedLabel(subjectLabel);
  const sentences = text.split(/(?<=[.!?])\s+|[\r\n;]+/).map(value => value.trim()).filter(Boolean);
  let opportunity = null;
  for (const sentence of sentences) {
    const match = opportunityPattern.exec(sentence);
    if (!match || negatedPattern.test(sentence)) continue;
    const normalizedSentence = normalizedLabel(sentence);
    // Require one source statement to name the discovered business, its requested
    // category and requested geography alongside a positive, current signal.
    // Market-wide commentary and third-party mentions are candidate-only.
    const precedingSignal = sentence.slice(0, match.index);
    const subjectClause = normalizedSentence.includes(identity) && normalizedLabel(precedingSignal).includes(identity);
    const activePredicate = /\b(?:is|are|has|currently|will be)\s+(?:actively\s+)?$/i.test(precedingSignal);
    const identityEnd = precedingSignal.toLocaleLowerCase().indexOf(subjectLabel.toLocaleLowerCase()) + subjectLabel.length;
    const betweenIdentityAndSignal = precedingSignal.slice(identityEnd);
    const thirdParty = /\b(?:other|competitors?|industry|market|sector|companies|businesses|that|who|which|while|whereas|but|and)\b/i.test(betweenIdentityAndSignal);
    if (!identity || !subjectClause || !activePredicate || thirdParty
      || !locateIn(sentence, request.category, { allowPlural: true })
      || !locateIn(sentence, request.country)
      || (request.city && !locateIn(sentence, request.city))) continue;
    opportunity = {
      signal: match[0].toLowerCase().replace(/\s+/g, '_'),
      exactExcerpt: sentence.slice(0, 320),
      subject: 'same_business_site_statement', polarity: 'positive', humanReviewRequired: true,
    };
    break;
  }
  return { category, location, opportunity, ruleset: 'prospecting-evidence-rules-v1' };
}

function locateIn(text, value, { allowPlural = false } = {}) {
  const parts = String(value).trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (allowPlural && parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/s$/i, '') + 's?';
  const escaped = parts.join('\\s+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

function normalizedLabel(value) { return String(value || '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleLowerCase(); }
function domainLabel(domain) { return String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0] || ''; }
function businessIdentityMatches(page, candidate) {
  const host = String(candidate.canonicalDomain || '').toLowerCase().replace(/^www\./, '');
  if (!host || page.normalizedDomain !== host) return false;
  if (/\b(?:directory|directories|listing|listings|marketplace|yellow pages|business index|company index|review site)\b/i.test(`${page.title || ''} ${(page.h1 || []).join(' ')}`)) return false;
  const expected = normalizedLabel(domainLabel(host));
  const names = [page.h1?.[0], page.title].filter(Boolean).map(normalizedLabel).filter(value => value.length >= 5);
  return expected.length >= 3 && names.some(identity => identity.includes(expected) || (expected.includes(identity) && identity.length >= 5));
}
function sourceContext(candidate, request) {
  return {
    rightsPolicy: 'public_terms_permitted', rightsAttested: true,
    rightsEvidenceReference: request.sourceRights.rightsEvidenceReference,
    robotsAllowed: true, robotsEvidenceReference: request.sourceRights.robotsEvidenceReference,
    rightsReviewedAt: request.sourceRights.rightsReviewedAt,
    rightsExpiresAt: request.sourceRights.rightsExpiresAt,
  };
}
function publicSourceMessage(code) {
  const messages = {
    source_rights_unknown_or_expired: 'Source-use permission is missing or expired. Review the source terms and start again.',
    s01_approval_unknown_or_expired: 'Workspace source approval is not configured for this website. The result is held without fetching it.',
    remote_transport_disabled: 'Website collection is disabled for this workspace.',
    robots_policy_unavailable: 'The website robots policy could not be checked. The result is held.',
    robots_disallowed: 'The website robots policy disallows this page. The result is held.',
    source_response_unavailable: 'The website could not be collected. The candidate remains unqualified.',
    source_collection_failed: 'Website collection could not complete. The candidate remains unqualified.',
    source_request_outcome_uncertain: 'A source request has an uncertain result. Further access is held to prevent a duplicate request.',
    source_request_admission_unavailable: 'Shared source-request accounting is unavailable. No page was fetched.',
    source_budget_exhausted: 'The saved source-request budget has been reached. No page was fetched.',
    prospecting_reconciliation_required: 'A source checkpoint needs reconciliation. No further page was fetched.',
  };
  return messages[code] || 'Website collection is blocked by workspace policy or service setup.';
}

async function reconcileDurable(operation, invoke) {
  try { return await invoke(); }
  catch (cause) {
    if (!cause?.reconciliationRequired && !['uncertain_commit', 'transaction_commit_late'].includes(cause?.code)) throw cause;
    const commitState = cause.commitState === 'committed' || cause.code === 'transaction_commit_late' ? 'committed' : 'unknown';
    // Replay exactly the same tenant repository method and idempotency key. Never repeat a source/provider request here.
    try { return await invoke(); }
    catch (reconcileError) {
      const error = fail(commitState === 'committed'
        ? 'A database write completed late and its receipt is still being reconciled. Refresh this job before continuing.'
        : 'A database write may have completed. The worker stopped before continuing; refresh this job to reconcile its saved state.',
      503, 'prospecting_reconciliation_required');
      error.commitState = reconcileError?.commitState || commitState;
      error.reconciliationRequired = true;
      error.operation = operation;
      throw error;
    }
  }
}

function researchReceipt(value = {}) {
  const usage = value.usage || {};
  const units = input => Number.isSafeInteger(input) && input >= 0 ? input : null;
  return {
    status: ['completed', 'blocked', 'failed', 'uncertain'].includes(value.status) ? value.status : 'uncertain',
    code: typeof value.code === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value.code) ? value.code : null,
    responseVerified: value.responseVerified === true ? true : value.responseVerified === false ? false : null,
    actualProvider: value.responseVerified === true && typeof value.actualProvider === 'string' ? value.actualProvider.slice(0, 100) : null,
    actualModel: value.responseVerified === true && typeof value.actualModel === 'string' ? value.actualModel.slice(0, 100) : null,
    usage: { inputTokens: units(usage.inputTokens), outputTokens: units(usage.outputTokens), reasoningTokens: units(usage.reasoningTokens),
      actualCostMicrousd: units(usage.actualCostMicrousd), actualCostSource: typeof usage.actualCostSource === 'string' ? usage.actualCostSource.slice(0, 100) : null },
    opportunities: [],
  };
}

function groundedResearch(value, page, evidenceId, sourceEvidenceId) {
  const research = researchReceipt(value);
  const plain = String(page.visibleText || '').replace(/\s+/g, ' ').trim();
  research.opportunities = (Array.isArray(value?.opportunities) ? value.opportunities : []).slice(0, 10).flatMap(item => {
    const excerpt = typeof item?.evidenceExcerpt === 'string' ? item.evidenceExcerpt.replace(/\s+/g, ' ').trim() : '';
    if (!excerpt || excerpt.length > 1000 || !plain.includes(excerpt) || typeof item.title !== 'string' || !item.title.trim()
      || typeof item.rationale !== 'string' || !item.rationale.trim()) return [];
    return [{ title: item.title.slice(0, 200), rationale: item.rationale.slice(0, 1200), evidenceExcerpt: excerpt,
      evidenceId, sourceEvidenceId, sourceUrl: page.sourceUrl, humanReviewRequired: true }];
  });
  if (research.status === 'completed' && (research.responseVerified !== true || !research.actualProvider || !research.actualModel)) {
    research.status = 'held'; research.code = 'ai_receipt_unverified'; research.opportunities = [];
  }
  return research;
}

function qualifyResearch(identityMatches, signals, research) {
  const checks = [
    ['identity', identityMatches, 30, 'Business identity matches the collected website.'],
    ['category', Boolean(signals.category), 20, 'Requested business category appears on the collected website.'],
    ['geography', Boolean(signals.location), 20, 'Requested country and city appear on the collected website.'],
    ['opportunity', research.status === 'completed' && research.responseVerified === true && research.opportunities.length > 0, 30, 'AI research links a service opportunity to an exact website excerpt.'],
  ];
  const scoreBreakdown = checks.map(([key, supported, maxPoints, reason]) => ({ key, points: supported ? maxPoints : 0, maxPoints,
    reason: supported ? reason : `${key} remains unsupported by the saved evidence.` }));
  const reasons = [!identityMatches && 'business_identity_not_supported_by_site', !signals.category && 'category_not_supported_by_site',
    !signals.location && 'country_and_city_not_supported_by_site', !checks[3][1] && (research.code || 'grounded_ai_opportunity_unavailable')].filter(Boolean);
  return { status: reasons.length ? 'held' : 'qualified', score: scoreBreakdown.reduce((sum, item) => sum + item.points, 0),
    scoreBreakdown, reasons, unknowns: reasons, signals, businessIdentityMatchesDomain: identityMatches };
}

/** Execute one bounded, resumable Mongo job. Test adapters may replace sourceWorkflow; no mock is treated as live-service evidence. */
export async function runAstraProspectingOnce({ persistence, tenantId, userId, sourceWorkflow, researchWorkflow = null, jobId = null, workerId = `prospecting-${randomUUID()}`, now = () => new Date(), onClaim = () => {}, signal = null, sourceWaitMs = SOURCE_WAIT_MAX_MS, wait = waitForSourcePoll } = {}) {
  if (!persistence || persistence.backend !== 'mongodb' || typeof persistence.forTenant !== 'function') throw fail('MongoDB prospecting storage is not ready.', 503, 'prospecting_storage_unavailable');
  if (!sourceWorkflow || typeof sourceWorkflow.createSearchJob !== 'function' || typeof sourceWorkflow.readJob !== 'function'
    || typeof sourceWorkflow.runJob !== 'function' || typeof sourceWorkflow.createFetchJob !== 'function' || typeof sourceWorkflow.readWebsite !== 'function') {
    throw fail('Approved search and website collection capabilities are not configured.', 503, 'source_search_unavailable');
  }
  const tenant = persistence.forTenant({ tenantId });
  const claimed = await tenant.jobs.claim({ workerId, leaseMs: WORKER_LEASE_MS, jobId });
  if (!claimed) return { status: 'idle' };
  if (jobId && claimed.job.id !== jobId) throw fail('The claimed job does not match the authorized request.', 409, 'job_claim_mismatch');
  const { job, lease } = claimed;
  let current = job;
  let cp = { ...(job.checkpoint || {}) };
  onClaim({ job, lease }); // Synchronous registration immediately after claim, before any further await.
  const checkpoint = async (name, patch) => {
    cp = { ...cp, ...patch, updatedAt: now().toISOString() };
    const input = { workerId, fence: lease.fence, expectedVersion: current.version, idempotencyKey: `${lease.fence}:${name}`, checkpoint: cp };
    const result = await reconcileDurable(`jobs.checkpoint:${input.idempotencyKey}`, () => tenant.jobs.checkpoint(job.id, input));
    if (result.job) { current = result.job; cp = { ...(result.job.checkpoint || cp) }; lease.until = result.job.leaseUntil || lease.until; }
  };
  const guard = async () => {
    if (signal?.aborted) throw fail('This job was paused or stopped before the next collection step.', 409, 'job_cancelled');
    const latest = await tenant.jobs.get(job.id);
    if (!latest || latest.state !== 'running' || latest.version !== current.version) throw fail('This job changed before collection could continue.', 409, latest?.state === 'cancelled' ? 'job_cancelled' : 'job_paused');
    if (job.payload.sourceRights.rightsExpiresAt <= now().toISOString()) throw fail('Source-use review expired while this job was running.', 409, 'source_rights_unknown_or_expired');
    return latest;
  };
  const saveOutcome = (key, outcome) => {
    const input = { jobId: job.id, idempotencyKey: `${job.id}:${lease.fence}:${key}`, outcome: { ...outcome, at: now().toISOString() } };
    return reconcileDurable(`outcomes.append:${input.idempotencyKey}`, () => tenant.outcomes.append(input));
  };
  const waitForSource = async ({ sourceJob, phase, candidateKey = null }) => {
    const startedAt = now();
    const leaseUntil = lease.until ? new Date(lease.until).valueOf() : Number.POSITIVE_INFINITY;
    const configuredEnd = startedAt.valueOf() + Math.max(0, Math.min(Number(sourceWaitMs) || 0, SOURCE_WAIT_MAX_MS));
    // Keep a margin for the final checkpoint. The Mongo lease remains the
    // durable handoff: after it expires the ordinary claim path can recover
    // this same logical job and its source pointers.
    const deadline = Math.min(configuredEnd, leaseUntil - 1000);
    const maxPolls = Math.max(0, Math.ceil(Math.max(0, deadline - startedAt.valueOf()) / SOURCE_WAIT_POLL_MS));
    await checkpoint(`source-wait-${sourceJob.id}`, { phase: 'source_wait', pendingSourceJobId: sourceJob.id,
      pendingSourceJobType: sourceJob.jobType || phase, pendingCandidateKey: candidateKey,
      sourceWaitStartedAt: cp.sourceWaitStartedAt || startedAt.toISOString(), sourceWaitDeadline: new Date(Math.max(startedAt.valueOf(), deadline)).toISOString() });
    let latestSource = sourceJob;
    let polls = 0;
    while (polls < maxPolls && now().valueOf() < deadline) {
      await wait(Math.min(SOURCE_WAIT_POLL_MS, Math.max(1, deadline - now().valueOf())), signal);
      await guard();
      latestSource = await sourceWorkflow.readJob({ jobId: sourceJob.id, tenantId, userId });
      polls += 1;
      // Only explicit durable terminal statuses resolve the handover. Missing,
      // queued, or unfamiliar states remain pending and can never authorize a
      // replay or terminal candidate decision.
      if (latestSource && ['completed', 'failed'].includes(latestSource.status)) return { job: latestSource, waiting: false };
    }
    const latestParent = await tenant.jobs.get(job.id);
    if (!latestParent || latestParent.state !== 'running' || latestParent.version !== current.version) {
      throw fail('This job changed while waiting for its source attempt.', 409,
        latestParent?.state === 'cancelled' ? 'job_cancelled' : 'job_paused');
    }
    return { job: latestSource, waiting: true, parent: latestParent };
  };
  const holdCandidate = async (candidateKey, evidenceId, reasons) => saveOutcome(`quarantine:${candidateKey}`, { type: 'prospecting.quarantined', candidateKey, evidenceId, reasons });
  const reserveSourceRequest = async ({ operation, sourceJobId }) => {
    if (!['search', 'robots', 'page'].includes(operation) || typeof sourceJobId !== 'string' || !sourceJobId) {
      throw fail('The source worker did not provide a valid request reservation.', 503, 'source_request_admission_unavailable');
    }
    await guard();
    const reservations = [...(cp.sourceRequestReservations || [])];
    if (reservations.some(item => item.sourceJobId === sourceJobId && item.operation === operation)) {
      throw fail('This source job already has a durable request reservation. Its outcome is held to prevent a duplicate request.', 409, 'source_request_outcome_uncertain');
    }
    const previous = reservations.filter(item => item.operation === operation).length;
    const limits = { search: job.payload.budgets.maxSearchRequests || 1, robots: job.payload.budgets.maxPublicPages || 10, page: job.payload.budgets.maxPublicPages || 10 };
    if (previous >= limits[operation]) throw fail('The saved source-request budget has been reached. Resume after reviewing the job; no request was dispatched.', 409, 'source_budget_exhausted');
    const requestId = `${sourceJobId}:${operation}:${previous + 1}`;
    if (reservations.some(item => item.requestId === requestId)) throw fail('The source request reservation already exists. Its outcome is held to prevent duplicate access.', 409, 'source_request_outcome_uncertain');
    reservations.push({ requestId, sourceJobId, operation, state: 'reserved_before_dispatch', reservedAt: now().toISOString() });
    await checkpoint(`source-request-${digest(requestId).slice(0, 24)}`, {
      phase: 'source_request_admission', sourceRequestReservations: reservations,
      sourceRequestCounts: { ...(cp.sourceRequestCounts || {}), [operation]: previous + 1 },
    });
    await guard();
  };
  try {
    await checkpoint('claimed', { phase: 'search_setup', budgets: job.payload.budgets, pageReservations: cp.pageReservations || [], providerRequestsReserved: cp.providerRequestsReserved || 0, searchRequestsReserved: cp.searchRequestsReserved || 0 });
    let searchJob = cp.searchJobId ? await sourceWorkflow.readJob({ jobId: cp.searchJobId, tenantId, userId }) : null;
    if (!searchJob) {
      searchJob = await sourceWorkflow.createSearchJob({ job, tenantId, userId });
      await checkpoint('search-created', { searchJobId: searchJob.id, searchStatus: searchJob.status });
    }
    if (searchJob.status === 'queued') {
      if (!cp.searchRequestReserved) {
        const count = (Number(cp.searchRequestsReserved) || 0) + 1;
        if (count > (job.payload.budgets.maxSearchRequests || 1)) throw fail('The job search-request limit has been reached.', 409, 'source_budget_exhausted');
        await checkpoint('search-request-reserved', { phase: 'search', searchRequestReserved: true, searchRequestsReserved: count });
      }
      await guard();
      // A still-queued SQL source job has not passed the source collector's atomic claim, so resuming it is safe.
      await sourceWorkflow.runJob({ jobId: searchJob.id, tenantId, userId, signal, beforeRequest: guard, reserveRequest: reserveSourceRequest });
      await guard();
      searchJob = await sourceWorkflow.readJob({ jobId: searchJob.id, tenantId, userId });
    }
    if (searchJob?.status === 'running') {
      const pending = await waitForSource({ sourceJob: searchJob, phase: 'search' });
      searchJob = pending.job;
      if (pending.waiting) return { status: 'waiting_for_source', job: pending.parent, sourceJobId: searchJob?.id || cp.pendingSourceJobId,
        sourceJobType: 'search', leaseUntil: lease.until || null };
    }
    if (searchJob?.status !== 'completed') {
      const code = searchJob?.blockedReason || searchJob?.errorCode || 'source_collection_failed';
      await saveOutcome('search-blocked', { type: 'prospecting.blocked', code, message: publicBlockReason(code), transportAttempted: Boolean(searchJob?.latestRun?.provenance?.transportAttempted) });
      await checkpoint('search-blocked', { phase: 'blocked', searchStatus: searchJob?.status || 'unavailable', searchBlockCode: code });
      current = await tenant.jobs.get(job.id) || current;
      const blockedTransition = { action: 'fail', expectedVersion: current.version, idempotencyKey: `failed:${lease.fence}`, reason: { code, message: publicBlockReason(code) }, workerId, fence: lease.fence };
      const result = await reconcileDurable(`jobs.transition:${blockedTransition.idempotencyKey}`, () => tenant.jobs.transition(job.id, blockedTransition));
      return { status: 'blocked', job: result.job, reason: publicBlockReason(code) };
    }

    const candidates = (Array.isArray(searchJob.candidates) ? searchJob.candidates : []).slice(0, job.payload.targetCount).map(sanitizedCandidate);
    const processedDomains = new Set(cp.processedCandidateDomains || []);
    let qualifiedCount = 0, quarantinedCount = 0, collectedCount = 0;
    for (const [index, candidate] of candidates.entries()) {
      await guard();
      const candidateHash = sourceHash(candidate);
      const candidateKey = digest({ sourceUrl: candidate.sourceUrl, contentSha256: candidateHash });
      const searchEvidenceInput = { jobId: job.id, idempotencyKey: `${lease.fence}:search-candidate:${candidateKey}`, sourceKey: `search:${digest({ url: candidate.sourceUrl, contentSha256: candidateHash })}`, evidence: {
        kind: 'public_search_result', candidateOnly: true, verifiedContact: false, captureKind: 'search_provider_excerpt', discoveryProvider: 'server_configured_searxng', candidateKey,
        title: candidate.title, sourceUrl: candidate.sourceUrl, canonicalDomain: candidate.canonicalDomain, snippet: candidate.snippet || '', engine: candidate.engine || null,
        resultSha256: candidateHash, querySha256: candidate.lineage?.querySha256 || searchJob.latestRun?.provenance?.querySha256 || null,
        capturedAt: candidate.createdAt || now().toISOString(), rightsExpiresAt: job.payload.sourceRights.rightsExpiresAt,
        rightsEvidenceReference: job.payload.sourceRights.rightsEvidenceReference, robotsEvidenceReference: job.payload.sourceRights.robotsEvidenceReference,
        sourceJobId: searchJob.id, sourceJobRunId: searchJob.latestRun?.provenance?.runId || null,
      } };
      const searchEvidence = await reconcileDurable(`evidence.record:${searchEvidenceInput.idempotencyKey}`, () => tenant.evidence.record(searchEvidenceInput));
      await saveOutcome(`candidate-found:${candidateKey}`, { type: 'prospecting.candidate_found', candidateKey, evidenceId: searchEvidence.evidence.id, sourceUrl: candidate.sourceUrl, resultSha256: candidateHash, evidenceBasis: 'search_snippet_candidate_only' });

      const domain = String(candidate.canonicalDomain || '').toLowerCase().replace(/^www\./, '');
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
        await holdCandidate(candidateKey, searchEvidence.evidence.id, ['unsupported_website_domain']); quarantinedCount += 1; continue;
      }
      const pageReservations = [...(cp.pageReservations || [])];
      // A candidate's own durable reservation takes precedence over the
      // cross-candidate domain dedupe set. That set also records reservations,
      // so checking it first made an interrupted candidate dedupe itself.
      let reservation = pageReservations.find(item => item.candidateKey === candidateKey);
      if (processedDomains.has(domain) && !reservation) {
        await holdCandidate(candidateKey, searchEvidence.evidence.id, ['duplicate_canonical_domain_candidate']); quarantinedCount += 1; continue;
      }
      if (reservation && !reservation.fetchJobId) {
        await holdCandidate(candidateKey, searchEvidence.evidence.id, ['website_fetch_outcome_unknown_after_restart']); quarantinedCount += 1; continue;
      }
      if (!reservation) {
        if (pageReservations.length >= job.payload.budgets.maxPublicPages) {
          await holdCandidate(candidateKey, searchEvidence.evidence.id, ['public_page_budget_exhausted']); quarantinedCount += 1; continue;
        }
        // Persist an intent before inserting the SQL source job. If the process
        // stops during that insert, resume sees an incomplete/uncertain intent
        // and holds it instead of silently creating a second fetch job.
        reservation = { candidateKey, url: candidate.sourceUrl, fetchJobId: null, reservedAt: now().toISOString(), status: 'creating' };
        pageReservations.push(reservation);
        processedDomains.add(domain);
        await checkpoint(`page-reserved-${index + 1}`, { phase: 'website_collection', pageReservations, processedCandidateDomains: [...processedDomains] });
        await guard();
        const fetchJob = await sourceWorkflow.createFetchJob({ job, candidate, tenantId, userId });
        reservation.fetchJobId = fetchJob.id;
        reservation.status = fetchJob.status;
        reservation.sourceJobCreatedAt = now().toISOString();
        await checkpoint(`page-job-created-${index + 1}`, { phase: 'website_collection', pageReservations, processedCandidateDomains: [...processedDomains] });
      }
      const activeReservation = pageReservations.find(item => item.candidateKey === candidateKey);
      let fetchJob = await sourceWorkflow.readJob({ jobId: activeReservation.fetchJobId, tenantId, userId });
      const deferredRun = fetchJob?.latestRun?.outcome;
      const retrySafe = fetchJob?.status === 'failed' && deferredRun?.status === 'deferred' && deferredRun?.retrySafe === true
        && ['job_paused', 'lease_lost'].includes(deferredRun.errorCode) && deferredRun.transportAttempted === false
        && deferredRun.dnsAttempted === false && deferredRun.requestReservationAttempted === false;
      if (retrySafe) {
        if (activeReservation.retryIntent && (activeReservation.retryIntent.predecessorJobId !== fetchJob.id
          || activeReservation.retryIntent.predecessorRunId !== fetchJob.latestRun.id
          || activeReservation.retryIntent.candidateKey !== candidateKey || activeReservation.retryIntent.logicalJobId !== job.id)) {
          throw fail('Saved source retry intent does not match the proven attempt.', 409, 'source_request_outcome_uncertain');
        }
        if (!activeReservation.retryIntent) {
          if (typeof sourceWorkflow.createRetrySuccessor !== 'function') {
            throw fail('Safe source retry requires the trusted successor adapter.', 503, 'source_request_admission_unavailable');
          }
          const retryIntent = { logicalJobId: job.id, candidateKey, predecessorJobId: fetchJob.id,
            predecessorRunId: fetchJob.latestRun.id,
            successorJobId: deriveAstraSourceSuccessorId({ tenantId, sourceJobId: fetchJob.id, sourceRunId: fetchJob.latestRun.id, logicalJobId: job.id, candidateKey }) };
          activeReservation.retryIntent = retryIntent;
          await checkpoint(`page-retry-successor-intent-${index + 1}`, { phase: 'website_collection', pageReservations });
        }
        await guard();
        const successorInput = { ...activeReservation.retryIntent, tenantId, userId };
        const successor = await reconcileDurable(`source.successor:${successorInput.successorJobId}`,
          () => sourceWorkflow.createRetrySuccessor(successorInput));
        if (successor?.id !== activeReservation.retryIntent.successorJobId || successor.status !== 'queued') {
          throw fail('The retry-safe successor could not be reconciled.', 409, 'source_request_outcome_uncertain');
        }
        activeReservation.predecessorFetchJobId = activeReservation.retryIntent.predecessorJobId;
        activeReservation.fetchJobId = successor.id;
        activeReservation.status = 'queued';
        activeReservation.successorCreatedAt = now().toISOString();
        await checkpoint(`page-retry-successor-created-${index + 1}`, { phase: 'website_collection', pageReservations });
        fetchJob = await sourceWorkflow.readJob({ jobId: successor.id, tenantId, userId });
      }
      if (fetchJob?.status === 'queued') {
        if (!activeReservation.requestReserved) {
          activeReservation.requestReserved = true;
          activeReservation.requestReservedAt = now().toISOString();
          activeReservation.status = 'reserved';
          await checkpoint(`page-request-reserved-${index + 1}`, { phase: 'website_collection', pageReservations, processedCandidateDomains: [...processedDomains] });
        }
        await guard();
        // A still-queued source job has not passed the collector's atomic claim; resume that same job, never create another.
        await sourceWorkflow.runJob({ jobId: activeReservation.fetchJobId, tenantId, userId, signal, beforeRequest: guard, reserveRequest: reserveSourceRequest });
        await guard();
        fetchJob = await sourceWorkflow.readJob({ jobId: activeReservation.fetchJobId, tenantId, userId });
      }
      if (fetchJob?.status === 'running') {
        const pending = await waitForSource({ sourceJob: fetchJob, phase: 'fetch', candidateKey });
        fetchJob = pending.job;
        if (pending.waiting) return { status: 'waiting_for_source', job: pending.parent, sourceJobId: fetchJob?.id || activeReservation.fetchJobId,
          sourceJobType: 'fetch', candidateKey, leaseUntil: lease.until || null };
      }
      if (fetchJob?.status !== 'completed') {
        const code = fetchJob?.blockedReason || fetchJob?.errorCode || 'source_collection_failed';
        if (['source_request_outcome_uncertain', 'source_request_admission_unavailable', 'source_budget_exhausted', 'prospecting_reconciliation_required'].includes(code)) {
          throw fail(publicBlockReason(code), 409, code);
        }
        activeReservation.status = 'held'; activeReservation.reason = code;
        await checkpoint(`page-held-${index + 1}`, { phase: 'website_collection', pageReservations });
        await saveOutcome(`site-blocked:${candidateKey}`, { type: 'prospecting.quarantined', candidateKey, evidenceId: searchEvidence.evidence.id, reasons: [code], message: publicSourceMessage(code) }); quarantinedCount += 1; continue;
      }
      const captured = await sourceWorkflow.readWebsite({ sourceJob: fetchJob, candidate, tenantId, userId, request: job.payload });
      if (!captured?.page || !captured?.sourceEvidence?.sourceRightsUsable || !captured?.snapshotVerified) {
        await holdCandidate(candidateKey, searchEvidence.evidence.id, ['website_evidence_or_source_rights_unavailable']); quarantinedCount += 1; continue;
      }
      collectedCount += 1;
      const page = captured.page;
      const identityMatches = businessIdentityMatches(page, candidate);
      const signals = measuredSignals(page, job.payload);
      const capturedAt = captured.sourceEvidence.capturedAt instanceof Date ? captured.sourceEvidence.capturedAt.toISOString() : captured.sourceEvidence.capturedAt || null;
      const rightsExpiresAt = captured.sourceEvidence.rightsExpiresAt instanceof Date ? captured.sourceEvidence.rightsExpiresAt.toISOString() : captured.sourceEvidence.rightsExpiresAt || null;
      const xrayPage = { ...page, status: 'usable', evidenceId: fetchJob.evidenceId, sourceId: captured.sourceEvidence.sourceId, contentSha256: captured.sourceEvidence.contentSha256, capturedAt };
      const xray = buildAstraXrayReport({ account: { id: candidate.canonicalDomain, normalizedDomain: candidate.canonicalDomain }, pages: [xrayPage], pageCoverage: [xrayPage] });
      const websiteEvidenceInput = { jobId: job.id, idempotencyKey: `${lease.fence}:website:${candidateKey}:${captured.sourceEvidence.contentSha256}`, sourceKey: `website:${digest({ domain: candidate.canonicalDomain, contentSha256: captured.sourceEvidence.contentSha256 })}`, evidence: {
        kind: 'business_website_page', captureKind: 'ssrf_robots_gated_html', candidateOnly: !identityMatches, candidateKey, title: page.title, h1: page.h1,
        sourceUrl: page.sourceUrl, canonicalDomain: page.normalizedDomain, sourceEvidenceId: fetchJob.evidenceId, sourceJobId: fetchJob.id,
        contentSha256: captured.sourceEvidence.contentSha256, capturedAt, extractorVersion: captured.sourceEvidence.extractorVersion || null,
        rightsPolicy: captured.sourceEvidence.rightsPolicy, rightsExpiresAt, sourceRightsStatus: captured.sourceEvidence.sourceRightsStatus,
        businessIdentityMatchesDomain: identityMatches, exactPageExcerpt: page.pageExcerpt, measuredSignals: signals,
        xray: { version: xray.auditVersion || 'astra-business-xray/1.0.0', findingCount: xray.findings?.length || 0, findings: (xray.findings || []).slice(0, 30) },
        emailCandidates: page.emailEvidence.map(item => ({ ...item, verificationStatus: 'unknown', verified: false })),
        phoneCandidates: page.phones.map(value => ({ value, verificationStatus: 'unknown', verified: false, sourceUrl: page.sourceUrl })),
      } };
      const websiteEvidence = await reconcileDurable(`evidence.record:${websiteEvidenceInput.idempotencyKey}`, () => tenant.evidence.record(websiteEvidenceInput));
      await saveOutcome(`website-collected:${candidateKey}`, { type: 'prospecting.website_collected', candidateKey, evidenceId: websiteEvidence.evidence.id, sourceUrl: page.sourceUrl, contentSha256: captured.sourceEvidence.contentSha256, capturedAt, sourceRightsStatus: captured.sourceEvidence.sourceRightsStatus });
      const researchReservations = [...(cp.researchReservations || [])];
      let researchReservation = researchReservations.find(item => item.candidateKey === candidateKey);
      let research = researchReceipt({ status: 'blocked', code: 'ai_research_unavailable' });
      const priorResearch = !researchReservation && typeof tenant.jobs.list === 'function'
        ? (await tenant.jobs.list({ limit: 100 })).filter(item => item.id !== job.id)
          .flatMap(item => item.checkpoint?.researchReservations || [])
          .find(item => item.contentSha256 === captured.sourceEvidence.contentSha256 && ['uncertain', 'in_flight', 'reserved_before_dispatch'].includes(item.state)) : null;
      if (researchReservation) {
        research = researchReservation.result && researchReservation.contentSha256 === captured.sourceEvidence.contentSha256
          ? researchReservation.result : researchReceipt({ status: 'uncertain', code: 'ai_request_outcome_uncertain' });
      } else if (priorResearch) {
        research = researchReceipt({ status: 'uncertain', code: 'ai_request_outcome_uncertain' });
      } else if (identityMatches && signals.category && signals.location && typeof researchWorkflow?.analyze === 'function') {
        const reserved = Number(cp.providerRequestsReserved) || 0;
        const providerLimit = Math.max(0, Math.min(10, Number(job.payload.budgets.maxProviderRequests) || 0));
        if (reserved >= providerLimit) research = researchReceipt({ status: 'blocked', code: 'ai_provider_budget_exhausted' });
        else {
          researchReservation = { candidateKey, requestId: randomUUID(), state: 'reserved_before_dispatch',
            contentSha256: captured.sourceEvidence.contentSha256, evidenceId: websiteEvidence.evidence.id, reservedAt: now().toISOString() };
          researchReservations.push(researchReservation);
          await checkpoint(`research-reserved-${candidateKey}`, { phase: 'ai_research', researchReservations, providerRequestsReserved: reserved + 1 });
          const beforeRequest = async () => {
            await guard();
            const saved = (cp.researchReservations || []).find(item => item.requestId === researchReservation.requestId);
            if (!saved || !['reserved_before_dispatch', 'in_flight'].includes(saved.state)) throw fail('The AI request reservation cannot be dispatched again.', 409, 'ai_request_outcome_uncertain');
          };
          let checkpointCount = 0;
          try {
            await beforeRequest();
            const response = await researchWorkflow.analyze({ job, candidate, page, evidenceId: fetchJob.evidenceId,
              sourceEvidence: captured.sourceEvidence, signal, beforeRequest,
              onCheckpoint: async record => {
                researchReservation.state = 'in_flight';
                researchReservation.providerCheckpoint = { ...researchReceipt(record), stage: typeof record?.state === 'string' ? record.state.slice(0, 80) : null };
                await checkpoint(`research-provider-${candidateKey}-${++checkpointCount}`, { phase: 'ai_research', researchReservations });
              } });
            research = groundedResearch(response, page, websiteEvidence.evidence.id, fetchJob.evidenceId);
          } catch (cause) {
            if (cause?.reconciliationRequired || ['job_paused', 'job_cancelled', 'lease_lost', 'version_conflict'].includes(cause?.code)) throw cause;
            research = researchReceipt({ status: cause?.uncertain === false ? 'failed' : 'uncertain',
              code: cause?.uncertain === false ? 'ai_research_failed' : 'ai_request_outcome_uncertain' });
          }
          researchReservation.state = research.status;
          researchReservation.result = research;
          researchReservation.completedAt = now().toISOString();
          await checkpoint(`research-result-${candidateKey}`, { phase: 'business_qualification', researchReservations });
        }
      }
      const qualification = qualifyResearch(identityMatches, signals, research);
      await saveOutcome(`research-result:${candidateKey}`, { type: 'prospecting.researched', candidateKey, evidenceId: websiteEvidence.evidence.id,
        sourceUrl: page.sourceUrl, research, qualification, crm: null });
      if (qualification.status !== 'qualified') {
        await saveOutcome(`site-quarantine:${candidateKey}`, { type: 'prospecting.quarantined', candidateKey, evidenceId: websiteEvidence.evidence.id,
          sourceUrl: page.sourceUrl, research, qualification, crm: null, reasons: qualification.reasons,
          message: 'This business remains held until its website fit and grounded AI research are supported.' }); quarantinedCount += 1; continue;
      }
      let crm;
      try {
        const account = await sourceWorkflow.resolveCrmAccount?.({ tenantId, userId, sourceEvidenceId: fetchJob.evidenceId, normalizedDomain: page.normalizedDomain });
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(account?.accountId || '')) throw fail('The collected website has no saved workspace account.', 503, 'crm_account_unavailable');
        crm = { accountId: account.accountId, savedAt: account.savedAt instanceof Date ? account.savedAt.toISOString() : account.savedAt || now().toISOString(), kind: 'workspace_prospect' };
      } catch (cause) {
        if (cause?.reconciliationRequired) throw cause;
        qualification.status = 'held'; qualification.reasons.push('crm_account_unavailable'); qualification.unknowns = [...qualification.reasons];
        await saveOutcome(`crm-held:${candidateKey}`, { type: 'prospecting.quarantined', candidateKey, evidenceId: websiteEvidence.evidence.id,
          sourceUrl: page.sourceUrl, research, qualification, crm: null, reasons: qualification.reasons }); quarantinedCount += 1; continue;
      }
      const publicName = page.title?.split(/\s+[|—–]\s+/)[0] || page.h1?.[0] || candidate.canonicalDomain;
      try {
        const qualificationInput = { jobId: job.id, idempotencyKey: `${job.id}:qualified:${candidateKey}:${captured.sourceEvidence.contentSha256}`, identityKey: `domain:${digest(candidate.canonicalDomain.toLowerCase())}`, contact: {
          name: publicName, website: page.sourceUrl, email: null, phone: null, verified: false, sourceUrl: page.sourceUrl,
          research, crm,
          emailCandidates: page.emailEvidence.map(item => ({ value: item.value, verificationStatus: 'unknown', evidenceExcerpt: item.exactExcerpt, sourceUrl: page.sourceUrl })),
          phoneCandidates: page.phones.map(value => ({ value, verificationStatus: 'unknown', sourceUrl: page.sourceUrl })),
        }, qualification: { ...qualification, research, crm, decision: 'website_evidence_rules_v1', ruleset: signals.ruleset,
          qualifiedAt: now().toISOString(), note: 'Website identity, category and geography are measured; AI service opportunities cite saved website excerpts. Contact verification remains unknown and held.' }, evidenceIds: [websiteEvidence.evidence.id] };
        const qualified = await reconcileDurable(`contacts.qualify:${qualificationInput.idempotencyKey}`, () => tenant.contacts.qualify(qualificationInput));
        await saveOutcome(`business-qualified:${candidateKey}`, { type: 'prospecting.evidence_qualified', contactId: qualified.contact.id, candidateKey, evidenceId: websiteEvidence.evidence.id, research, qualification: qualificationInput.qualification, crm, ruleset: signals.ruleset, contactVerification: 'unknown_held' });
        await saveOutcome(`campaign-blocked:${candidateKey}`, { type: 'campaign.preparation_blocked', code: 'BLOCKED_NEEDS_APPROVED_OFFER', businessContactId: qualified.contact.id, crm, nextAction: 'Open the saved workspace prospect and select an approved offer before preparing a campaign draft.', noCampaignCreated: true, noCopyGenerated: true, noSend: true });
        qualifiedCount += 1;
      } catch (cause) {
        if (!['identity_conflict', 'unique_conflict'].includes(cause?.code)) throw cause;
        await saveOutcome(`site-duplicate:${candidateKey}`, { type: 'prospecting.quarantined', candidateKey, evidenceId: websiteEvidence.evidence.id, reasons: ['existing_business_record_requires_review'], message: 'A saved business already uses this website identity. The new evidence remains available for review.' }); quarantinedCount += 1;
      }
      activeReservation.status = 'completed';
      await checkpoint(`candidate-processed-${index + 1}`, { phase: 'business_qualification', pageReservations, lastCandidateKey: candidateKey, qualifiedCount, quarantinedCount });
    }
    await checkpoint('pipeline-review', { phase: 'review', sourceJobId: searchJob.id, candidateCount: candidates.length, collectedCount, qualifiedCount, quarantinedCount, verificationStage: 'unknown_held', campaignStage: qualifiedCount ? 'BLOCKED_NEEDS_APPROVED_OFFER' : 'not_applicable' });
    await saveOutcome('pipeline-completed', { type: 'prospecting.pipeline_completed', sourceJobId: searchJob.id, candidateCount: candidates.length, collectedCount, qualifiedCount, quarantinedCount, contactVerification: 'unknown_held_when_present', campaignPreparation: qualifiedCount ? 'BLOCKED_NEEDS_APPROVED_OFFER' : 'no_qualified_businesses' });
    const completeInput = { action: 'complete', expectedVersion: current.version, idempotencyKey: `complete:${lease.fence}`, workerId, fence: lease.fence };
    const result = await reconcileDurable(`jobs.transition:${completeInput.idempotencyKey}`, () => tenant.jobs.transition(job.id, completeInput));
    return { status: 'completed', job: result.job, candidateCount: candidates.length, collectedCount, qualifiedCount, quarantinedCount };
  } catch (cause) {
    const latest = await tenant.jobs.get(job.id).catch(() => null);
    if (latest && ['paused', 'cancelled'].includes(latest.state)) return { status: latest.state, job: latest };
    if (cause?.reconciliationRequired || cause?.code === 'prospecting_reconciliation_required') return { status: 'uncertain', job: latest || current, reason: cause.message, commitState: cause.commitState || 'unknown', reconciliationRequired: true, operation: cause.operation || null };
    if (['lease_lost', 'version_conflict', 'job_paused', 'job_cancelled'].includes(cause?.code)) return { status: 'stale', job: latest || current, reason: 'Job state changed; this worker stopped without writing a failure result.' };
    const code = ['source_rights_unknown_or_expired', 'lease_lost', 'version_conflict', 'job_paused', 'job_cancelled', 'source_budget_exhausted',
      'source_request_outcome_uncertain', 'source_request_admission_unavailable', 'prospecting_reconciliation_required'].includes(cause?.code) ? cause.code : 'prospecting_worker_failed';
    const message = publicBlockReason(code);
    try {
      current = latest || current;
      if (current.state === 'running') {
        try { await saveOutcome('worker-error', { type: 'prospecting.failed', code, message }); }
        catch { /* The terminal job reason still records failure if its outcome journal is unavailable. */ }
        const failureInput = { action: 'fail', expectedVersion: current.version, idempotencyKey: `failed:${lease.fence}`, reason: { code, message }, workerId, fence: lease.fence };
        const failed = await reconcileDurable(`jobs.transition:${failureInput.idempotencyKey}`, () => tenant.jobs.transition(job.id, failureInput));
        return { status: 'failed', job: failed.job, reason: message };
      }
    } catch { /* Keep the persisted transition and return a sanitized state. */ }
    return { status: 'failed', job: latest || current, reason: message };
  }
}

/** Existing PostgreSQL S01/SSRF/robots collection with a process-shared transaction lock. */
export function createAstraApprovedSourceSearch({ env = process.env, sourceStoreFactory = createAstraTenantStore, now = () => new Date() } = {}) {
  let sourceStore = null;
  function getSourceStore() {
    if (!env.ASTRA_WORKER_DATABASE_URL?.trim()) throw fail('The dedicated source worker is not configured.', 503, 'worker_unavailable');
    if (!sourceStore) sourceStore = sourceStoreFactory({ connectionString: env.ASTRA_WORKER_DATABASE_URL.trim() });
    return sourceStore;
  }
  const actorOf = (tenantId, userId) => ({ tenantId, userId });
  async function readJob({ jobId, tenantId, userId }) {
    const store = getSourceStore(), actor = actorOf(tenantId, userId);
    return store.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db).getJob(tenantId, jobId));
  }
  async function sharedRequest({ jobId, tenantId, userId, signal, beforeRequest, reserveRequest }) {
    if (signal?.aborted) throw fail('Collection was stopped before dispatch.', 409, 'job_cancelled');
    if (typeof reserveRequest !== 'function' || typeof beforeRequest !== 'function') throw fail('Shared source request accounting is unavailable.', 503, 'source_request_admission_unavailable');
    const store = getSourceStore(), actor = actorOf(tenantId, userId);
    const runResult = await runAstraSourceCollectionOnce({ store, tenantId, userId, jobId, signal,
      beforeRequest,
      reserveRequest,
      withRequestAdmission: async (context, dispatch) => {
        if (typeof context.reserveRequest !== 'function') throw fail('Shared source request accounting is unavailable.', 503, 'source_request_admission_unavailable');
        return store.withWorkerTenant(actor, async db => {
          await beforeRequest();
          if (signal?.aborted) throw fail('Collection was stopped before dispatch.', 409, 'job_cancelled');
          await db.query("SELECT pg_advisory_xact_lock(hashtextextended('astra-live-public-source-v1', 0))");
          await db.query('SELECT pg_sleep(1)');
          await beforeRequest();
          if (signal?.aborted) throw fail('Collection was stopped before dispatch.', 409, 'job_cancelled');
          await context.reserveRequest({ operation: context.operation, sourceJobId: jobId });
          if (signal?.aborted) throw fail('Collection was stopped before dispatch.', 409, 'job_cancelled');
          return dispatch(); // PostgreSQL advisory xact lock remains held through actual safeFetch completion.
        });
      } });
    return runResult;
  }
  return Object.freeze({
    async createSearchJob({ job, tenantId, userId }) {
      const store = getSourceStore(), actor = actorOf(tenantId, userId), request = job.payload;
      return store.withWorkerTenant(actor, async db => {
        const manager = createAstraSourceCollectionManager(db, { workerAvailable: true });
        if (!getAstraSearchPolicyBlock(request, request.sourceRights)) {
          const cached = await db.query(`SELECT id FROM astra.source_collection_jobs
            WHERE tenant_id=$1 AND job_type='search' AND status='completed'
              AND request->'fields'->>'category'=$2 AND request->'fields'->>'country'=$3 AND COALESCE(request->'fields'->>'city','')=$4
              AND finished_at > now()-interval '30 minutes'
              AND (rights_record->>'rightsExpiresAt')::timestamptz > now()
            ORDER BY finished_at DESC,id LIMIT 1`, [tenantId, request.category, request.country, request.city || '']);
          if (cached.rows[0]) return { ...await manager.getJob(tenantId, cached.rows[0].id), reused: true,
            reuseReason: 'same_workspace_same_query_current_rights_recent_saved_search' };
        }
        return manager.createSearchJob(actor, { category: request.category, country: request.country,
          city: request.city, approvalMode: 'server', sourceRights: request.sourceRights });
      });
    },
    async createFetchJob({ job, candidate, tenantId, userId }) {
      const store = getSourceStore(), actor = actorOf(tenantId, userId);
      return store.withWorkerTenant(actor, async db => {
        const manager = createAstraSourceCollectionManager(db, { workerAvailable: true });
        const rights = sourceContext(candidate, job.payload);
        if (!getAstraWebsitePolicyBlock(candidate.sourceUrl, rights)) {
          const cached = await db.query(`SELECT id,evidence_id AS "evidenceId" FROM astra.source_collection_jobs
            WHERE tenant_id=$1 AND job_type='fetch' AND status='completed' AND request->>'sourceUrl'=$2
              AND finished_at > now()-interval '30 minutes' AND evidence_id IS NOT NULL
            ORDER BY finished_at DESC,id LIMIT 1`, [tenantId, candidate.sourceUrl]);
          if (cached.rows[0]) {
            const evidence = await getResearchEvidence(db, tenantId, cached.rows[0].evidenceId);
            if (evidence?.sourceRightsUsable) return { ...await manager.getJob(tenantId, cached.rows[0].id), reused: true,
              reuseReason: 'same_workspace_same_url_current_rights_recent_capture' };
          }
        }
        return manager.createFetchJob(actor, { sourceUrl: candidate.sourceUrl, approvalMode: 'server', sourceRights: rights });
      });
    },
    async createRetrySuccessor({ tenantId, userId, logicalJobId, candidateKey, predecessorJobId, predecessorRunId, successorJobId }) {
      const store = getSourceStore(), actor = actorOf(tenantId, userId);
      return store.withWorkerTenant(actor, db => createAstraSourceCollectionManager(db, { workerAvailable: true }).createRetrySuccessor({
        tenantId, logicalJobId, candidateKey, sourceJobId: predecessorJobId, sourceRunId: predecessorRunId, successorJobId,
      }));
    },
    readJob,
    runJob: sharedRequest,
    async readWebsite({ sourceJob, candidate, tenantId, userId }) {
      if (!sourceJob?.evidenceId) return null;
      const store = getSourceStore();
      return store.withWorkerTenant(actorOf(tenantId, userId), async db => {
        const sourceEvidence = await getResearchEvidence(db, tenantId, sourceJob.evidenceId);
        const blob = await getResearchBlob(db, tenantId, sourceJob.evidenceId);
        if (!sourceEvidence || !blob || !sourceEvidence.sourceRightsUsable || blob.sha256 !== sourceEvidence.contentSha256 || researchSha256(blob.content) !== sourceEvidence.contentSha256) return null;
        const page = inspectXrayPage({ html: blob.content, sourceUrl: sourceEvidence.sourceUrl, normalizedDomain: sourceEvidence.normalizedDomain });
        return { sourceEvidence, snapshotVerified: true, page, candidate };
      });
    },
    async resolveCrmAccount({ tenantId, userId, sourceEvidenceId, normalizedDomain }) {
      return getSourceStore().withWorkerTenant(actorOf(tenantId, userId), async db => {
        const evidence = await getResearchEvidence(db, tenantId, sourceEvidenceId);
        if (!evidence?.sourceRightsUsable || evidence.normalizedDomain !== normalizedDomain) throw fail('The saved account evidence is unavailable.', 409, 'crm_account_unavailable');
        const found = await db.query(`SELECT a.id AS "accountId",a.created_at AS "savedAt"
          FROM astra.research_accounts a JOIN astra.research_evidence e
            ON e.tenant_id=a.tenant_id AND e.normalized_domain=a.normalized_domain
          WHERE a.tenant_id=$1 AND e.id=$2 AND a.normalized_domain=$3`, [tenantId, sourceEvidenceId, normalizedDomain]);
        if (!found.rows[0]) throw fail('The collected website has no saved workspace account.', 404, 'crm_account_unavailable');
        return { ...found.rows[0], kind: 'workspace_prospect' };
      });
    },
    async prepareCampaignProof({ tenantId, userId, contact, job, db: requestDb, actor: requestActor }) {
      const work = (db, actor) => {
        if (!['owner', 'admin', 'operator'].includes(actor.tenantRole)) throw fail('Workspace write permission is required.', 403, 'prospect_write_required');
        return prepareProspectCampaignClaims(db, actor, { contact, job });
      };
      return requestDb ? work(requestDb, requestActor) : getSourceStore().withWorkerTenant(actorOf(tenantId, userId), work);
    },
    async describeCrmProspect({ tenantId, userId, sourceEvidenceId, db: requestDb }) {
      const work = async db => {
        const evidence = await getResearchEvidence(db, tenantId, sourceEvidenceId);
        if (!evidence?.sourceRightsUsable) return null;
        return { displayName: evidence.documentTitle?.split(/\s+[|—–]\s+/)[0] || evidence.normalizedDomain,
          emails: evidence.extractedEmails || [], sourceEvidenceId: evidence.id, sourceUrl: evidence.sourceUrl };
      };
      // Authenticated routes already hold a verified tenant transaction. Opening
      // a nested worker context can wait on the outer context's nonce cleanup.
      return requestDb ? work(requestDb) : getSourceStore().withWorkerTenant(actorOf(tenantId, userId), work);
    },
    close: async () => sourceStore?.close?.(),
  });
}

export function createAstraProspectingService({ env = process.env, persistenceFactory = createAstraPersistence, sourceWorkflow = createAstraApprovedSourceSearch({ env }), researchWorkflow = null } = {}) {
  let persistence = null;
  let connecting = null;
  const activeRuns = new Map();
  const workerId = `prospecting-${randomUUID()}`;

  function storageReadiness() {
    if (env.ASTRA_PERSISTENCE_BACKEND !== 'mongodb' || env.ASTRA_INTEGRATION_MODE !== 'prospecting-test') return { ready: false, reason: 'Dedicated prospecting storage is not configured.' };
    if (!env.MONGODB_URI?.trim() || !env.MONGODB_DATABASE?.trim() || !env.ASTRA_MONGODB_TEST_DATABASES?.split(',').map(value => value.trim()).includes(env.MONGODB_DATABASE.trim())) return { ready: false, reason: 'The dedicated Mongo test database is not configured.' };
    return { ready: true, reason: null };
  }

  function readiness() {
    if (env.ASTRA_LIVE_PROSPECTING_GO !== 'true') return { ready: false, reason: 'The live integration is waiting for coordinator approval.' };
    if (env.ASTRA_PROSPECTING_USAGE_FILE) {
      try {
        const usage = JSON.parse(readFileSync(env.ASTRA_PROSPECTING_USAGE_FILE, 'utf8'));
        if (usage.inference >= 3) return { ready: false, reason: 'The approved three-call live research allowance is used. Saved results remain available; new live research needs renewed approval.' };
      } catch { return { ready: false, reason: 'The approved research usage record could not be checked. New live research is paused.' }; }
    }
    if (env.ASTRA_PERSISTENCE_BACKEND !== 'mongodb' || env.ASTRA_INTEGRATION_MODE !== 'prospecting-test') return { ready: false, reason: 'Dedicated prospecting storage is not configured.' };
    if (!env.MONGODB_URI?.trim() || !env.MONGODB_DATABASE?.trim() || !env.ASTRA_MONGODB_TEST_DATABASES?.split(',').map(value => value.trim()).includes(env.MONGODB_DATABASE.trim())) return { ready: false, reason: 'The dedicated Mongo test database is not configured.' };
    let localSearchEnabled;
    try { localSearchEnabled = isAstraLocalSearchEnabled(env); }
    catch { return { ready: false, reason: 'The local search opt-in or pinned origin is invalid.' }; }
    if (!localSearchEnabled && (env.ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED !== 'true' || !isAstraPublicSearchOriginConfigured(env))) return { ready: false, reason: 'The approved public search service is not configured.' };
    if (!env.ASTRA_WORKER_DATABASE_URL?.trim()) return { ready: false, reason: 'The dedicated source worker is not configured.' };
    return { ready: true, reason: null };
  }

  async function getPersistence() {
    const storage = storageReadiness();
    if (!storage.ready) throw fail(readiness().reason || storage.reason, 503, 'prospecting_integration_blocked');
    if (!persistence) persistence = persistenceFactory({ env });
    if (!connecting) connecting = (async () => {
      await persistence.connect();
      const status = await persistence.health();
      if (!status.ready) throw fail('Mongo storage is not ready for durable work.', 503, 'prospecting_storage_unavailable');
      return persistence;
    })().catch(error => { connecting = null; throw error; });
    return connecting;
  }

  async function runOnceOne({ tenantId, userId, jobId } = {}) {
    const db = await getPersistence();
    const execution = readiness();
    if (!execution.ready) {
      const tenant = db.forTenant({ tenantId });
      const job = jobId ? await tenant.jobs.get(jobId) : null;
      if (job) {
        const input = { jobId: job.id, idempotencyKey: `setup-blocked:${digest(execution.reason)}`,
          outcome: { type: 'prospecting.blocked', code: 'prospecting_execution_blocked', message: execution.reason, research: { status: 'blocked', opportunities: [] } } };
        await reconcileDurable(`outcomes.append:${input.idempotencyKey}`, () => tenant.outcomes.append(input));
      }
      return { status: 'blocked', job, reason: execution.reason };
    }
    if (!researchWorkflow) {
      try {
        const { createAstraProspectingResearch } = await import('./astra-prospecting-research.js');
        researchWorkflow = createAstraProspectingResearch({ env });
      } catch {
        researchWorkflow = { analyze: async () => ({ status: 'blocked', code: 'ai_research_unavailable' }) };
      }
    }
    const controller = new AbortController();
    try {
      return await runAstraProspectingOnce({ persistence: db, tenantId, userId, sourceWorkflow, researchWorkflow, jobId, workerId, signal: controller.signal,
        onClaim: ({ job }) => activeRuns.set(job.id, controller) });
    } finally { for (const [id, activeController] of activeRuns) if (activeController === controller) activeRuns.delete(id); }
  }

  function runOnce(options = {}) { return runOnceOne(options); }

  async function readProspects(tenantId, userId, rows, db) {
    if (!userId || typeof sourceWorkflow.describeCrmProspect !== 'function') return rows;
    return Promise.all(rows.map(async row => {
      const sourceEvidenceId = row.contact?.research?.opportunities?.[0]?.sourceEvidenceId;
      if (!sourceEvidenceId) return row;
      const source = await sourceWorkflow.describeCrmProspect({ tenantId, userId, sourceEvidenceId, db });
      const emails = new Set((source?.emails || []).map(value => value.toLowerCase()));
      const candidates = row.contact.emailCandidates || [];
      const filtered = candidates.filter(item => emails.has(String(item.value).toLowerCase()));
      const phoneKeys = new Set();
      const phones = (source ? row.contact.phoneCandidates || [] : []).filter(item => {
        const key = String(item.value).replace(/\D/g, ''); if (phoneKeys.has(key)) return false; phoneKeys.add(key); return true;
      });
      return { ...row, contact: { ...row.contact, displayName: source?.displayName || row.contact.name,
        emailCandidates: filtered, phoneCandidates: phones, unsupportedContactCandidatesHeld: candidates.length - filtered.length },
        qualification: source ? row.qualification : { ...row.qualification, status: 'held', unknowns: ['source_rights_unavailable'] } };
    }));
  }

  return Object.freeze({
    status: async () => {
      const configured = readiness();
      if (!configured.ready) return { ...configured, canCreate: storageReadiness().ready, storageReady: storageReadiness().ready, executionReady: false,
        storageState: storageReadiness().ready ? persistence ? 'connected' : 'not_checked' : 'not_configured', backend: 'mongodb', releaseReady: false, budgets: { maxProviderRequests: 10, maxSearchRequests: 1, maxPublicPages: 10, minRequestIntervalMs: 1000 } };
      if (!persistence) return { ...configured, canCreate: true, storageState: 'not_checked', backend: 'mongodb', releaseReady: false, budgets: { maxProviderRequests: 10, maxSearchRequests: 1, maxPublicPages: 10, minRequestIntervalMs: 1000 } };
      const health = await persistence.health().catch(() => ({ ready: false }));
      if (!health.ready) return { ready: false, reason: 'Dedicated Mongo test storage is not connected or transaction-ready. Ask the coordinator to check Atlas access.', storageState: 'unavailable', backend: 'mongodb', releaseReady: false, budgets: { maxProviderRequests: 10, maxSearchRequests: 1, maxPublicPages: 10, minRequestIntervalMs: 1000 } };
      return { ...configured, canCreate: true, storageState: 'connected', backend: 'mongodb', releaseReady: false, budgets: { maxProviderRequests: 10, maxSearchRequests: 1, maxPublicPages: 10, minRequestIntervalMs: 1000 } };
    },
    create: async ({ tenantId, payload, idempotencyKey }) => {
      const db = await getPersistence();
      const tenant = db.forTenant({ tenantId });
      const input = { idempotencyKey, payload };
      const result = await reconcileDurable(`jobs.create:${idempotencyKey}`, () => tenant.jobs.create(input));
      const execution = readiness();
      return { ...result, executionReady: execution.ready, executionBlocker: execution.reason };
    },
    list: async tenantId => (await getPersistence()).forTenant({ tenantId }).jobs.list({ limit: 100 }),
    get: async (tenantId, jobId, userId, db) => {
      const tenant = (await getPersistence()).forTenant({ tenantId });
      const job = await tenant.jobs.get(jobId);
      if (!job) return null;
      const [evidence, outcomes, contacts, events] = await Promise.all([
        tenant.evidence.listForJob(jobId), tenant.outcomes.listForJob(jobId), tenant.contacts.list({ limit: 500 }), tenant.jobs.events(jobId, { limit: 500 }),
      ]);
      return { job, evidence, outcomes, contacts: await readProspects(tenantId, userId, contacts.filter(item => item.jobId === jobId), db), events };
    },
    contacts: async (tenantId, userId, db) => readProspects(tenantId, userId, await (await getPersistence()).forTenant({ tenantId }).contacts.list({ limit: 500 }), db),
    prepareCampaignProof: async ({ tenantId, userId, contactId, db, actor }) => {
      const tenant = (await getPersistence()).forTenant({ tenantId });
      const contact = (await tenant.contacts.list({ limit: 500 })).find(item => item.id === contactId);
      const job = contact && await tenant.jobs.get(contact.jobId);
      if (!contact || !job) throw fail('The saved prospect was not found in this workspace.', 404, 'prospect_not_found');
      if (typeof sourceWorkflow.prepareCampaignProof !== 'function') throw fail('Campaign evidence preparation is unavailable.', 503, 'prospect_campaign_proof_unavailable');
      return sourceWorkflow.prepareCampaignProof({ tenantId, userId, contact, job, db, actor });
    },
    transition: async ({ tenantId, jobId, action, expectedVersion, reason }) => {
      const tenant = (await getPersistence()).forTenant({ tenantId });
      const input = { action, expectedVersion, idempotencyKey: `${action}:${jobId}:${expectedVersion}`, reason: reason || null };
      const result = await reconcileDurable(`jobs.transition:${input.idempotencyKey}`, () => tenant.jobs.transition(jobId, input));
      if (action === 'pause' || action === 'cancel') activeRuns.get(jobId)?.abort();
      return result.job;
    },
    runOnce,
    close: async () => { await persistence?.close?.(); await sourceWorkflow?.close?.(); },
  });
}
