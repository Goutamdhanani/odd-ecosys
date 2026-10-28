import { randomUUID } from 'node:crypto';
import { readAstraSourceRights } from './astra-source-rights.js';
import { AstraResearchError, getResearchBlob, getResearchEvidence, normalizeResearchDomain, researchSha256 } from './astra-evidence.js';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { recordAstraXrayRadarDiffs } from './astra-radar.js';
import { ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS, ASTRA_XRAY_VERSION, buildAstraXrayReport, inspectXrayPage } from './astra-xray.js';

const RIGHTS_POLICIES = new Set(['synthetic_fixture', 'user_provided', 'licensed', 'public_terms_permitted']);
const REPORT_METADATA_SIGNAL = '__account_report_metadata__';

export function normalizeResearchIdentity(value) {
  const { domain } = normalizeResearchDomain(value);
  return domain;
}

export async function listResearchIdentities(db, tenantId, { limit = 50 } = {}) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 50));
  const result = await db.query(`SELECT a.id,a.normalized_domain AS "normalizedDomain",a.display_domain AS "displayDomain",a.created_at AS "createdAt",
      count(DISTINCT e.id)::int AS "evidenceCount",count(DISTINCT c.id)::int AS "candidateCount"
    FROM astra.research_accounts a LEFT JOIN astra.research_sources s ON (s.tenant_id,s.normalized_domain)=(a.tenant_id,a.normalized_domain)
    LEFT JOIN astra.research_evidence e ON (e.tenant_id,e.source_id)=(s.tenant_id,s.id)
    LEFT JOIN astra.research_identity_candidates c ON (c.tenant_id,c.account_id)=(a.tenant_id,a.id)
    WHERE a.tenant_id=$1 GROUP BY a.tenant_id,a.id ORDER BY a.normalized_domain LIMIT $2`, [tenantId, bounded]);
  return result.rows;
}

export async function getResearchIdentityCandidates(db, tenantId, accountId) {
  const result = await db.query(`SELECT c.id,c.candidate_type AS "candidateType",c.display_value AS "displayValue",c.verification_state AS "verificationState",
      c.exact_excerpt AS "exactExcerpt",c.created_at AS "createdAt",e.id AS "evidenceId",e.content_sha256 AS "contentSha256",s.id AS "sourceId",s.source_url AS "sourceUrl"
    FROM astra.research_identity_candidates c JOIN astra.research_evidence e ON (e.tenant_id,e.id)=(c.tenant_id,c.evidence_id)
    JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
    WHERE c.tenant_id=$1 AND c.account_id=$2 ORDER BY c.created_at DESC`, [tenantId, accountId]);
  const rights=await readAstraSourceRights(db,tenantId,result.rows.map(row=>row.sourceId).filter(Boolean));
  return result.rows.map(row=>{const current=rights.get(String(row.sourceId).toLowerCase());return {...row,
    sourceRightsStatus:current?.status||'unavailable',sourceRightsUsable:current?.usable===true,
    rightsRevokedAt:current?.revokedAt||null,rightsRevocationEventId:current?.revocationEventId||null,
    rightsRevocationReason:current?.reason||null};});
}

async function annotateHistoricalReportRights(db,tenantId,report) {
  if (!report||typeof report!=='object') return report;
  const refs=[...(Array.isArray(report.evidence)?report.evidence:[]),...(Array.isArray(report.sourceCoverage?.pages)?report.sourceCoverage.pages:[])];
  const rights=await readAstraSourceRights(db,tenantId,refs.map(ref=>ref?.sourceId).filter(Boolean));
  const annotate=ref=>{const current=ref?.sourceId?rights.get(String(ref.sourceId).toLowerCase()):null;return {...ref,
    sourceRightsStatus:current?.status||'unavailable',sourceRightsUsable:current?.usable===true,
    rightsRevokedAt:current?.revokedAt||null,rightsRevocationEventId:current?.revocationEventId||null,
    rightsRevocationReason:current?.reason||null};};
  return {...report,evidence:Array.isArray(report.evidence)?report.evidence.map(annotate):report.evidence,
    sourceCoverage:report.sourceCoverage?{...report.sourceCoverage,pages:(report.sourceCoverage.pages||[]).map(annotate)}:report.sourceCoverage};
}

const auditFinding = (signal, outcome, evidenceId, detail = null) => ({ signal, outcome, evidenceId, detail });

function validUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function dateValue(value) { return value == null || value === '' ? NaN : value instanceof Date ? value.valueOf() : new Date(value).valueOf(); }
function asIso(value) { const timestamp = dateValue(value); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null; }
function canonicalSourceKey(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return `${url.origin.toLowerCase()}${url.pathname}${url.search}`;
  } catch { return null; }
}

function sourceRightState(row, at) {
  if (row.sourceRightsStatus === 'revoked') return 'rights_revoked';
  if (row.sourceRightsUsable === false && row.sourceRightsStatus) return row.sourceRightsStatus === 'expired' ? 'rights_expired' : 'rights_unverified';
  if (!row.robotsAllowed || !row.rightsAttested || !RIGHTS_POLICIES.has(row.rightsPolicy)) return 'rights_unverified';
  if (row.rightsExpiresAt && dateValue(row.rightsExpiresAt) <= at.valueOf()) return 'rights_expired';
  return 'usable';
}

function metadataFinding(report) {
  return { signal: REPORT_METADATA_SIGNAL, outcome: 'metadata', accountId: report.summary.accountId,
    normalizedDomain: report.summary.normalizedDomain, summary: report.summary,
    opportunities: report.opportunities, sourceCoverage: report.sourceCoverage, metrics: report.metrics };
}

function reportFromStoredFindings(findings) {
  const rows = Array.isArray(findings) ? findings : [];
  const meta = rows.find(item => item?.signal === REPORT_METADATA_SIGNAL) || null;
  return { findings: rows.filter(item => item?.signal !== REPORT_METADATA_SIGNAL), ...(meta ? {
    accountId: meta.accountId, summary: meta.summary, opportunities: meta.opportunities, sourceCoverage: meta.sourceCoverage,
  } : {}) };
}

async function persistResearchAudit(db, actor, { evidenceId, auditVersion, coverageStatus = 'partial', findings, report = null }) {
  const storedFindings = report ? [...findings, metadataFinding(report)] : findings;
  const id = randomUUID();
  const saved = await db.query(`INSERT INTO astra.research_audits(tenant_id,id,evidence_id,audit_version,coverage_status,findings,created_at)
    VALUES($1,$2,$3,$4,'partial',$5::jsonb,clock_timestamp()) RETURNING id,evidence_id AS "evidenceId",created_at AS "createdAt",audit_version AS "auditVersion",
    coverage_status AS "coverageStatus",findings`, [actor.tenantId, id, evidenceId, auditVersion, JSON.stringify(storedFindings)]);
  const row = saved.rows[0];
  const restored = reportFromStoredFindings(row.findings);
  return { ...row, findings: restored.findings, ...restored, ...(report ? { coverageStatus: report.coverageStatus } : { coverageStatus }) };
}

function assertEvidenceCurrent(evidence, at) {
  if (sourceRightState(evidence, at) !== 'usable') throw new AstraResearchError('Evidence source rights are no longer valid.', 403, 'source_rights_required');
  const age = at.valueOf() - dateValue(evidence.capturedAt);
  if (!Number.isFinite(age) || age < -5 * 60_000 || age > ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS * 86400_000) {
    throw new AstraResearchError('Evidence is stale or has an invalid capture time; capture a fresh permitted page.', 409, 'evidence_stale');
  }
}

/** A one-snapshot compatibility path. Its original finding names and fields remain stable. */
export async function auditResearchEvidence(db, actor, evidenceId) {
  if (!validUuid(evidenceId)) throw new AstraResearchError('evidenceId must be a UUID.', 400, 'evidence_id_invalid');
  const evidence = await getResearchEvidence(db, actor.tenantId, evidenceId);
  if (!evidence) throw new AstraResearchError('Evidence was not found.', 404, 'evidence_not_found');
  const at = new Date();
  assertEvidenceCurrent(evidence, at);
  const blob = await getResearchBlob(db, actor.tenantId, evidenceId);
  if (!blob || blob.sha256 !== evidence.contentSha256 || researchSha256(blob.content) !== evidence.contentSha256) {
    throw new AstraResearchError('Evidence content could not be verified.', 409, 'evidence_hash_mismatch');
  }
  const lower = evidence.extractedText.toLowerCase();
  const findings = [
    auditFinding('document_title', evidence.documentTitle ? 'observed' : 'unknown', evidenceId, evidence.documentTitle || null),
    auditFinding('h1_heading', evidence.headings?.length ? 'observed' : 'unknown', evidenceId, evidence.headings?.[0] || null),
    auditFinding('email_candidate', evidence.extractedEmails?.length ? 'observed' : 'unknown', evidenceId, `${evidence.extractedEmails?.length || 0} candidate(s)`),
    auditFinding('privacy_page', 'unknown', evidenceId, 'Not inspected; a single supplied page cannot establish site-wide absence.'),
    auditFinding('contact_page', 'unknown', evidenceId, 'Not inspected; a single supplied page cannot establish site-wide absence.'),
    auditFinding('pricing_page', 'unknown', evidenceId, 'Not inspected; a single supplied page cannot establish site-wide absence.'),
  ];
  if (/\b(contact|privacy|pricing)\b/.test(lower)) findings.push(auditFinding('navigation_or_copy_mentions_policy_contact_or_pricing', 'observed', evidenceId, 'Term appears in supplied page text only.'));
  const result = await persistResearchAudit(db, actor, { evidenceId, auditVersion: 'astra-site-audit/1.0.0', findings });
  return { ...result, summary: { suppliedPages: 1, usablePages: 1, uniqueContentPages: 1 }, opportunities: [],
    sourceCoverage: { status: 'partial', explanation: 'Only this permitted snapshot was inspected; no site-wide crawl was performed.',
      pages: [{ evidenceId, sourceId: evidence.sourceId, sourceUrl: evidence.sourceUrl,
        contentSha256: evidence.contentSha256, capturedAt: asIso(evidence.capturedAt), status: 'usable' }] } };
}

/** Account-level X-Ray over current, tenant-owned, permitted captures only. */
export async function auditResearchAccount(db, actor, accountId, { now = new Date() } = {}) {
  if (!validUuid(accountId)) throw new AstraResearchError('accountId must be a UUID.', 400, 'account_id_invalid');
  const result = await db.query(`SELECT a.id AS "accountId",a.normalized_domain AS "accountDomain",a.display_domain AS "displayDomain",
      e.id AS "evidenceId",e.source_id AS "evidenceSourceId",e.normalized_domain AS "evidenceDomain",
      e.content_sha256 AS "contentSha256",e.captured_at AS "capturedAt",e.extracted_text AS "extractedText",
      e.document_title AS "documentTitle",e.headings,e.meta_description AS "metaDescription",e.extracted_emails AS "extractedEmails",
      e.coverage_status AS "evidenceCoverageStatus",e.source_content_untrusted AS "sourceContentUntrusted",
      s.id AS "sourceId",s.source_url AS "sourceUrl",s.normalized_domain AS "sourceDomain",s.rights_policy AS "rightsPolicy",
      s.rights_expires_at AS "rightsExpiresAt",s.robots_allowed AS "robotsAllowed",s.rights_attested AS "rightsAttested",
      b.content AS html,b.sha256 AS "blobSha256"
    FROM astra.research_accounts a
    LEFT JOIN astra.research_sources s ON (s.tenant_id,s.normalized_domain)=(a.tenant_id,a.normalized_domain)
    LEFT JOIN astra.research_evidence e ON (e.tenant_id,e.source_id,e.normalized_domain)=(s.tenant_id,s.id,s.normalized_domain)
    LEFT JOIN astra.research_blobs b ON (b.tenant_id,b.sha256)=(e.tenant_id,e.content_sha256)
    WHERE a.tenant_id=$1 AND a.id=$2
    ORDER BY e.captured_at DESC NULLS LAST,e.id DESC`, [actor.tenantId, accountId]);
  const rows = result.rows;
  if (!rows.length) throw new AstraResearchError('Research account was not found.', 404, 'account_not_found');
  const account = { id: rows[0].accountId, normalizedDomain: rows[0].accountDomain, displayDomain: rows[0].displayDomain };
  const captures = rows.filter(row => row.evidenceId);
  if (!captures.length) throw new AstraResearchError('Capture at least one permitted page before auditing this account.', 409, 'evidence_required');

  const rightsBySource = await readAstraSourceRights(db, actor.tenantId, captures.map(row => row.sourceId).filter(Boolean), { at: now });
  const checks = captures.map(row => {
    const coverage = { evidenceId: row.evidenceId, sourceId: row.sourceId, sourceUrl: row.sourceUrl,
      contentSha256: row.contentSha256, capturedAt: asIso(row.capturedAt), sourceContentUntrusted: true };
    if (!row.sourceId || row.evidenceSourceId !== row.sourceId || row.evidenceDomain !== account.normalizedDomain || row.sourceDomain !== account.normalizedDomain) {
      return { row, coverage: { ...coverage, status: 'source_mismatch', unknownReason: 'Evidence, source, and account domain are not the same tenant-owned association.' } };
    }
    const key = canonicalSourceKey(row.sourceUrl);
    if (!key) return { row, coverage: { ...coverage, status: 'source_invalid', unknownReason: 'A valid stored source URL is unavailable.' } };
    const rights = rightsBySource.get(String(row.sourceId).toLowerCase());
    const status = !rights?.usable ? (rights?.status === 'revoked' ? 'rights_revoked' : rights?.status === 'expired' ? 'rights_expired' : 'rights_unverified') : 'usable';
    const rightsMetadata = { sourceRightsStatus: rights?.status || 'unavailable', rightsRevokedAt: rights?.revokedAt || null,
      rightsRevocationEventId: rights?.revocationEventId || null, rightsRevocationReason: rights?.reason || null };
    if (status !== 'usable') return { row, key, coverage: { ...coverage, ...rightsMetadata, status, rightsPolicy: row.rightsPolicy,
      rightsExpiresAt: asIso(row.rightsExpiresAt), unknownReason: status === 'rights_revoked' ? 'Source rights were revoked.' : status === 'rights_expired' ? 'Source rights have expired.' : 'Source permission is not verified.' } };
    const age = now.valueOf() - dateValue(row.capturedAt);
    if (!Number.isFinite(age) || age < -5 * 60_000 || age > ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS * 86400_000) {
      return { row, key, coverage: { ...coverage, status: 'stale', unknownReason: `Capture is outside the ${ASTRA_XRAY_MAX_EVIDENCE_AGE_DAYS}-day freshness window.` } };
    }
    if (!row.html || row.blobSha256 !== row.contentSha256 || researchSha256(row.html) !== row.contentSha256) {
      return { row, key, coverage: { ...coverage, status: 'content_unavailable', unknownReason: 'The saved content could not be verified against its evidence hash.' } };
    }
    try {
      return { row, key, coverage: { ...coverage, ...rightsMetadata, status: 'candidate', rightsPolicy: row.rightsPolicy,
        rightsExpiresAt: asIso(row.rightsExpiresAt), rightsCheckedAt: now.toISOString() },
        inspected: inspectXrayPage({ html: row.html, sourceUrl: row.sourceUrl, normalizedDomain: account.normalizedDomain }) };
    } catch {
      return { row, key, coverage: { ...coverage, status: 'parse_failed', unknownReason: 'The saved page could not be parsed.' } };
    }
  });

  const byUrl = new Map();
  for (const item of checks) {
    if (!item.key || !Number.isFinite(dateValue(item.row.capturedAt))) continue;
    if (!byUrl.has(item.key)) byUrl.set(item.key, []);
    byUrl.get(item.key).push(item);
  }
  for (const group of byUrl.values()) {
    group.sort((a, b) => dateValue(b.row.capturedAt) - dateValue(a.row.capturedAt) || String(a.row.evidenceId).localeCompare(String(b.row.evidenceId)));
    const newestAt = dateValue(group[0].row.capturedAt);
    const newest = group.filter(item => dateValue(item.row.capturedAt) === newestAt);
    const distinctNewestHashes = new Set(newest.map(item => item.row.contentSha256));
    if (distinctNewestHashes.size > 1) {
      for (const item of newest) item.coverage = { ...item.coverage, status: 'ambiguous', unknownReason: 'Conflicting snapshots for this exact source URL have the same latest capture time.' };
    } else {
      newest[0].coverage = { ...newest[0].coverage, status: newest[0].coverage.status === 'candidate' ? 'usable' : newest[0].coverage.status };
      for (const item of newest.slice(1)) item.coverage = { ...item.coverage, status: 'duplicate_capture', unknownReason: 'Same URL and content were captured more than once at the same time.' };
    }
    for (const item of group.filter(item => dateValue(item.row.capturedAt) < newestAt)) {
      item.coverage = { ...item.coverage, status: 'superseded', unknownReason: 'A newer snapshot for this exact source URL supersedes this capture.' };
    }
  }
  const byHash = new Map();
  const currentCandidates = checks.filter(item => item.coverage.status === 'usable');
  for (const item of currentCandidates) {
    const hash = item.row.contentSha256;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(item);
  }
  for (const group of byHash.values()) {
    group.sort((a, b) => dateValue(b.row.capturedAt) - dateValue(a.row.capturedAt) || String(a.row.evidenceId).localeCompare(String(b.row.evidenceId)));
    for (const duplicate of group.slice(1)) duplicate.coverage = { ...duplicate.coverage, status: 'duplicate_content',
      duplicateOfEvidenceId: group[0].row.evidenceId, unknownReason: 'Identical content hash is already represented and is not an independent confirmation.' };
  }
  const analyzedPages = checks.filter(item => item.inspected).map(item => ({
    ...item.inspected, evidenceId: item.row.evidenceId, sourceId: item.row.sourceId, contentSha256: item.row.contentSha256,
    capturedAt: asIso(item.row.capturedAt), rightsPolicy: item.row.rightsPolicy,
    rightsExpiresAt: asIso(item.row.rightsExpiresAt), status: item.coverage.status,
  }));
  const pageCoverage = checks.map(item => ({ ...item.coverage, ...(item.inspected ? {
    role: item.inspected.role, title: item.inspected.title, path: item.inspected.path,
    byteLength: item.row.html?.length ?? null, textWordCount: item.inspected.wordCount,
  } : {}) }));
  const report = buildAstraXrayReport({ account, pages: analyzedPages, pageCoverage, now });
  const anchor = currentCandidates[0]?.row.evidenceId || captures[0].evidenceId;
  const persisted = await persistResearchAudit(db, actor, { evidenceId: anchor, auditVersion: ASTRA_XRAY_VERSION,
    coverageStatus: report.coverageStatus, findings: report.findings, report });
  // Radar consumes only measured deltas that can be attached to existing watches.
  const radar = await recordAstraXrayRadarDiffs(db, actor, { ...report, auditId: persisted.id, anchorEvidenceId: anchor });
  return { ...persisted, ...report, id: persisted.id, createdAt: persisted.createdAt,
    radarSignals: radar.created, radar: { created: radar.created, reason: radar.reason || null, expiresAt: radar.expiresAt || null } };
}

export async function getResearchAudit(db, tenantId, auditId) {
  const r = await db.query(`SELECT id,evidence_id AS "evidenceId",audit_version AS "auditVersion",coverage_status AS "coverageStatus",findings,created_at AS "createdAt"
    FROM astra.research_audits WHERE tenant_id=$1 AND id=$2`, [tenantId, auditId]);
  if (!r.rows[0]) return null;
  const restored = reportFromStoredFindings(r.rows[0].findings);
  const report=await annotateHistoricalReportRights(db,tenantId,restored);
  return { ...r.rows[0], findings: restored.findings, ...report };
}

/** Run only deterministic evidence collation; it never fetches, calls a model, or asserts truth. */
export async function runAstraResearchTask({ db, actor, workflowId, task }) {
  const refs = [];
  const supplied = Array.isArray(task.inputEvidenceRefs) ? task.inputEvidenceRefs : [];
  const manifestRefs = (task.contextManifest?.entries || []).filter(x => x.recordType === 'evidence');
  for (const item of [...supplied, ...manifestRefs]) {
    const ref = item?.recordRef || item;
    if (ref?.tenantId !== actor.tenantId || typeof ref?.recordId !== 'string' || refs.some(x => x.recordId === ref.recordId)) continue;
    refs.push({ recordId: ref.recordId, expectedHash: item.contentSha256 || ref.contentSha256 || null });
  }
  if (!refs.length || refs.length > 64) return { status: 'review_required', reasonCode: refs.length ? 'evidence_limit_exceeded' : 'evidence_required' };
  const entries = [];
  for (const ref of refs) {
    const result = await db.query(`SELECT e.id,e.source_id,e.content_sha256,s.source_url,s.normalized_domain,e.captured_at,e.document_title,e.extracted_text,e.coverage_status
      FROM astra.research_evidence e JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
      WHERE e.tenant_id=$1 AND e.id=$2`, [actor.tenantId, ref.recordId]);
    const row = result.rows[0];
    if (!row || (ref.expectedHash && ref.expectedHash !== row.content_sha256)) return { status: 'review_required', reasonCode: 'evidence_reference_unresolved' };
    const sourceRights = (await readAstraSourceRights(db, actor.tenantId, [row.source_id])).get(String(row.source_id).toLowerCase());
    if (!sourceRights?.usable) return { status: 'review_required', reasonCode: sourceRights?.status === 'revoked' ? 'source_rights_revoked' : 'source_rights_unavailable' };
    entries.push({ evidenceId: row.id, contentSha256: row.content_sha256, sourceUrl: row.source_url, normalizedDomain: row.normalized_domain,
      capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : row.captured_at, title: row.document_title, suppliedTextExcerpt: row.extracted_text.slice(0, 1200), coverage: row.coverage_status,
      note: 'Supplied page text is untrusted source material; no factual inference was performed.' });
  }
  const report = { reportVersion: 'astra-research-report/1.0.0', workflowId, tenantId: actor.tenantId, evidence: entries,
    conclusion: 'Evidence collected and linked. Claims require separate exact-quote proof review.', claimAssessments: [], generatedAt: new Date().toISOString() };
  const reportHash = sha256(canonicalJson(report));
  const saved = await db.query(`INSERT INTO astra.research_reports(tenant_id,id,workflow_id,report,report_sha256)
    VALUES($1,gen_random_uuid(),$2,$3::jsonb,$4) ON CONFLICT(tenant_id,workflow_id) DO NOTHING RETURNING id,report_sha256`,
  [actor.tenantId, workflowId, JSON.stringify(report), reportHash]);
  let record = saved.rows[0];
  if (!record) {
    const prior = await db.query(`SELECT id,report_sha256 FROM astra.research_reports WHERE tenant_id=$1 AND workflow_id=$2`, [actor.tenantId, workflowId]);
    record = prior.rows[0];
    if (!record) return { status: 'review_required', reasonCode: 'report_retry_conflict' };
  }
  const outputs = task.requiredOutputs || [];
  if (outputs.some(x => !['research_report', 'evidence_summary'].includes(x.artifactType) || x.minimumCount > 1)) {
    return { status: 'review_required', reasonCode: 'unsupported_required_output' };
  }
  const checks = task.completionRubric?.checks || [];
  const knownChecks = new Set(['evidence_available', 'evidence_references_resolved', 'research_report_created']);
  if (checks.some(x => !knownChecks.has(String(x.checkId || '').toLowerCase()))) return { status: 'review_required', reasonCode: 'rubric_requires_human_review' };
  const artifacts = outputs.map(x => ({ artifactType: x.artifactType, recordRef: { tenantId: actor.tenantId, recordId: record.id }, sha256: record.report_sha256 }));
  return {
    contractKind: 'HarnessResult', schemaVersion: '1.0.0', task: task.task, status: 'completed', artifacts, claimRefs: [],
    unresolvedQuestions: [], completionChecks: checks.map(x => ({ checkId: x.checkId, outcome: 'passed' })),
    proposedNextStep: 'human_review', evidenceLinkedSummary: `Collated ${entries.length} supplied page snapshot(s) into a deterministic report.`,
    usage: [], checkpointRef: task.taskRevision, completedAt: new Date().toISOString(),
  };
}

export async function getResearchReport(db, tenantId, reportId) {
  const r = await db.query(`SELECT id,workflow_id AS "workflowId",report,report_sha256 AS "reportSha256",created_at AS "createdAt"
    FROM astra.research_reports WHERE tenant_id=$1 AND id=$2`, [tenantId, reportId]);
  if(!r.rows[0])return null;
  const row=r.rows[0];
  return {...row,report:await annotateHistoricalReportRights(db,tenantId,row.report)};
}
