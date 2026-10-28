import { runAstraResearchTask } from './astra-research.js';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { normalizeAstraTenantId } from './astra-tenant-context.js';
import { createHash, randomUUID } from 'node:crypto';

const TOOL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['workflowId', 'evidenceRefs'],
  properties: {
    workflowId: { type: 'string', format: 'uuid' },
    evidenceRefs: { type: 'array', minItems: 1, maxItems: 6, items: {
      type: 'object', additionalProperties: false, required: ['tenantId', 'recordId', 'contentSha256'],
      properties: {
        tenantId: { type: 'string', format: 'uuid' }, recordId: { type: 'string', format: 'uuid' },
        contentSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    } },
  },
});

export const ASTRA_RESEARCH_READ_TOOL = Object.freeze({
  name: 'astra.research.collate_evidence', capability: 'read',
  argumentSchemaRef: Object.freeze({ id: 'astra-research-read-tool-args', version: '1.0.0', sha256: sha256(canonicalJson(TOOL_SCHEMA)) }),
});
export const ASTRA_RUNTIME_VERSION = 'astra-runtime/1.0.0';
export const ASTRA_RUNTIME_MIGRATION_COMPATIBILITY = 9;

export function buildAstraResearchPolicyPin(evidenceRows, tenantId) {
  tenantId = normalizeAstraTenantId(tenantId);
  const evidence = [...evidenceRows].map(row => ({
    evidenceId: row.id || row.evidenceId,
    contentSha256: row.content_sha256 || row.contentSha256,
    normalizedDomain: row.normalized_domain || row.normalizedDomain,
    rightsPolicy: row.rights_policy || row.rightsPolicy,
    rightsExpiresAt: (row.rights_expires_at || row.rightsExpiresAt) ? new Date(row.rights_expires_at || row.rightsExpiresAt).toISOString() : null,
    robotsAllowed: row.robots_allowed ?? row.robotsAllowed,
    rightsAttested: row.rights_attested ?? row.rightsAttested,
  })).sort((a, b) => String(a.evidenceId).localeCompare(String(b.evidenceId)));
  const body = { policyType: 'astra-research-rights', policyVersion: '1.0.0', tenantId, evidence };
  const pin = Object.freeze({ id: 'astra-research-rights-policy', version: body.policyVersion, sha256: sha256(canonicalJson(body)) });
  return { pin, manifestEntry: {
    recordRef: { tenantId, recordId: pin.id }, recordType: 'policy', revision: pin.version, sha256: pin.sha256,
    sensitivity: 'public_business', egressMode: 'NO_MODEL_EGRESS',
  } };
}

const versionRef = (id, version, contract) => ({ id, version, sha256: sha256(canonicalJson(contract)) });
export function buildAstraResearchHarnessTask({ tenantId, userId, evidenceRows }) {
  tenantId = normalizeAstraTenantId(tenantId);
  const taskId = randomUUID();
  const rows = [...evidenceRows];
  const { pin: policyPin, manifestEntry: policyEntry } = buildAstraResearchPolicyPin(rows, tenantId);
  const accountRows = [...new Map(rows.map(row => [row.accountId || row.account_id, row])).values()];
  const entries = [
    ...accountRows.map(row => {
      const id = row.accountId || row.account_id;
      const domain = row.normalizedDomain || row.normalized_domain;
      const displayDomain = row.displayDomain || row.display_domain || domain;
      return { recordRef: { tenantId, recordId: id }, recordType: 'account', revision: domain,
        sha256: sha256(canonicalJson({ id, normalizedDomain: domain, displayDomain })), sensitivity: 'public_business', egressMode: 'NO_MODEL_EGRESS' };
    }),
    ...rows.map(row => ({ recordRef: { tenantId, recordId: row.id || row.evidenceId }, recordType: 'evidence',
      revision: '1.0.0', sha256: row.content_sha256 || row.contentSha256,
      sensitivity: 'public_business', egressMode: 'NO_MODEL_EGRESS' })),
    policyEntry,
  ];
  const manifestBody = { manifestVersion: 1, tenantRef: { tenantId }, createdAt: new Date().toISOString(), entries };
  const contextManifest = { ...manifestBody, sha256: sha256(canonicalJson(manifestBody)) };
  const taskVersion = versionRef('astra-research-task', '1.0.0', { purpose: 'research', output: 'research_report', egressMode: 'NO_MODEL_EGRESS' });
  const retryVersion = versionRef('astra-research-retry', '1.0.0', { retries: 1, modelTimeout: 'stop_for_review', sideEffects: 'prohibited' });
  const progressVersion = versionRef('astra-research-progress', '1.0.0', { signals: ['new_usable_evidence', 'required_output_satisfied'], action: 'stop_for_review' });
  const rubricChecks = [
    { checkId: 'evidence_available', kind: 'evidence_refs_resolve', required: true },
    { checkId: 'evidence_references_resolved', kind: 'evidence_refs_resolve', required: true },
    { checkId: 'research_report_created', kind: 'required_output_present', required: true },
  ];
  const completionVersion = versionRef('astra-research-completion', '1.0.0', rubricChecks);
  return {
    contractKind: 'HarnessTask', schemaVersion: '1.0.0',
    task: { tenantRef: { tenantId }, taskId, revision: '1' },
    runRef: { tenantId, recordId: taskId },
    subjectRefs: accountRows.map(row => ({ tenantId, recordId: row.accountId || row.account_id })),
    purpose: 'research', taskRevision: taskVersion, policyRefs: [policyPin],
    inputEvidenceRefs: rows.map(row => ({ tenantId, recordId: row.id || row.evidenceId })),
    contextManifest, allowedReadTools: [ASTRA_RESEARCH_READ_TOOL],
    requiredOutputs: [{ artifactType: 'research_report', minimumCount: 1 }],
    versionPins: { model: null, prompt: null, skills: [] },
    limits: { maxModelCalls: 0, maxReadToolCalls: 1, maxSpendMicroUsd: 0, deadlineSeconds: 30, maxRepairAttempts: 0, maxChallengeRounds: 0 },
    retryPolicy: { id: 'astra-research-bounded-retry', versionRef: retryVersion, modelTimeout: 'stop_for_review', externalSideEffects: 'prohibited' },
    progressPolicy: { versionRef: progressVersion, progressSignals: ['new_usable_evidence', 'required_output_satisfied'], noProgressAction: 'stop_for_review' },
    completionRubric: { versionRef: completionVersion, checks: rubricChecks },
    egressMode: 'NO_MODEL_EGRESS', createdAt: new Date().toISOString(),
  };
}

function reject(message, code) {
  const error = new Error(message); error.code = code; return error;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateToolArguments(args, tenantId) {
  if (!exactKeys(args, ['workflowId', 'evidenceRefs']) || typeof args.workflowId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(args.workflowId) || !Array.isArray(args.evidenceRefs)
    || args.evidenceRefs.length < 1 || args.evidenceRefs.length > 6) throw reject('Read-tool arguments do not match the pinned schema.', 'tool_arguments_invalid');
  const seen = new Set();
  for (const ref of args.evidenceRefs) {
    if (!exactKeys(ref, ['tenantId', 'recordId', 'contentSha256']) || ref.tenantId !== tenantId
      || !/^[0-9a-f-]{36}$/i.test(ref.recordId) || !/^[a-f0-9]{64}$/.test(ref.contentSha256)) {
      throw reject('Read-tool evidence reference is invalid or cross-tenant.', 'tool_arguments_invalid');
    }
    if (seen.has(ref.recordId)) throw reject('Read-tool evidence references must be unique.', 'tool_arguments_invalid');
    seen.add(ref.recordId);
  }
  return args;
}

function taskEvidenceRefs(task, tenantId) {
  const fromTask = Array.isArray(task.inputEvidenceRefs) ? task.inputEvidenceRefs : [];
  const manifestEntries = (task.contextManifest?.entries || []).filter(entry => entry.recordType === 'evidence');
  const manifestById = new Map(manifestEntries.map(entry => [entry.recordRef?.recordId, entry]));
  const requestedIds = new Set(fromTask.map(ref => ref?.recordId));
  if (requestedIds.size && manifestEntries.some(entry => !requestedIds.has(entry.recordRef?.recordId))) {
    throw reject('Evidence manifest and task evidence references do not match.', 'evidence_manifest_mismatch');
  }
  const chosen = requestedIds.size ? fromTask : manifestEntries.map(entry => entry.recordRef);
  const result = [];
  for (const ref of chosen) {
    if (ref?.tenantId !== tenantId || typeof ref.recordId !== 'string') throw reject('Evidence reference is outside the verified tenant scope.', 'evidence_reference_invalid');
    const entry = manifestById.get(ref.recordId);
    if (!entry || entry.recordRef.tenantId !== tenantId || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      throw reject('Every evidence reference must be pinned in the context manifest.', 'evidence_manifest_mismatch');
    }
    result.push({ tenantId, recordId: ref.recordId, contentSha256: entry.sha256 });
  }
  if (result.length < 1 || result.length > 6) throw reject('This worker supports one to six pinned evidence records per run.', 'evidence_limit_exceeded');
  return result;
}

function validatePinnedPolicy(task, tenantId) {
  const entries = (task.contextManifest?.entries || []).filter(entry => entry.recordType === 'policy');
  for (const pin of task.policyRefs || []) {
    const match = entries.some(entry => entry.recordRef?.tenantId === tenantId
      && entry.recordRef?.recordId === pin.id && entry.revision === pin.version && entry.sha256 === pin.sha256);
    if (!match) throw reject('A required policy version is not pinned in the context manifest.', 'policy_manifest_mismatch');
  }
}

async function assertEvidenceRights(db, tenantId, refs) {
  const currentRows = [];
  for (const ref of refs) {
    const row = await db.query(`SELECT e.id,e.content_sha256,s.normalized_domain,s.rights_policy,s.rights_expires_at,s.robots_allowed,s.rights_attested,b.content
      FROM astra.research_evidence e JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
      JOIN astra.research_blobs b ON (b.tenant_id,b.sha256)=(e.tenant_id,e.content_sha256)
      WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid`, [tenantId, ref.recordId]);
    const evidence = row.rows[0];
    if (!evidence || evidence.content_sha256 !== ref.contentSha256 || !evidence.robots_allowed || !evidence.rights_attested
      || !['synthetic_fixture', 'user_provided', 'licensed', 'public_terms_permitted'].includes(evidence.rights_policy)
      || createHash('sha256').update(Buffer.from(evidence.content)).digest('hex') !== evidence.content_sha256
      || (evidence.rights_expires_at && new Date(evidence.rights_expires_at).getTime() <= Date.now())) {
      throw reject('Evidence is missing, changed, or no longer covered by its recorded rights.', 'evidence_rights_unavailable');
    }
    currentRows.push(evidence);
  }
  return currentRows;
}

async function assertResearchResult(db, tenantId, workflowId, task, refs, result) {
  if (result?.status !== 'completed' || !Array.isArray(result.artifacts) || result.artifacts.length === 0) return false;
  const allowedTypes = new Set(['research_report', 'evidence_summary']);
  for (const artifact of result.artifacts) {
    if (!allowedTypes.has(artifact.artifactType) || artifact.recordRef?.tenantId !== tenantId) return false;
    const row = await db.query(`SELECT report,report_sha256 FROM astra.research_reports
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND workflow_id=$3::uuid`, [tenantId, artifact.recordRef.recordId, workflowId]);
    const saved = row.rows[0];
    if (!saved || saved.report_sha256 !== artifact.sha256 || sha256(canonicalJson(saved.report)) !== saved.report_sha256
      || saved.report?.tenantId !== tenantId || saved.report?.workflowId !== workflowId) return false;
    const ids = new Set((saved.report.evidence || []).map(item => item.evidenceId));
    if (!ids.size || [...ids].some(id => !refs.some(ref => ref.recordId === id))) return false;
  }
  const checks = new Map((result.completionChecks || []).map(check => [check.checkId, check.outcome]));
  if (!task.completionRubric.checks.every(check => checks.get(check.checkId) === 'passed')) return false;
  const policyRows = await assertEvidenceRights(db, tenantId, refs);
  const currentPin = buildAstraResearchPolicyPin(policyRows, tenantId).pin;
  if (task.policyRefs.length !== 1 || canonicalJson(currentPin) !== canonicalJson(task.policyRefs[0])) return false;
  return true;
}

/** Run only the pinned deterministic evidence collation tool. */
export async function executeAstraBoundedResearch({ db, actor, workflowId, task, deadlineAt }) {
  const tenantId = normalizeAstraTenantId(actor.tenantId);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw reject('Execution deadline has expired.', 'execution_deadline_exceeded');
  if (task.limits?.maxModelCalls !== 0 || task.limits?.maxSpendMicroUsd < 0 || task.limits?.maxReadToolCalls < 1
    || task.limits?.maxRepairAttempts > 1 || task.limits?.maxChallengeRounds > 1) {
    throw reject('Task limits exceed the bounded offline runner.', 'runtime_budget_rejected');
  }
  const refs = taskEvidenceRefs(task, tenantId);
  const currentPolicyRows = await assertEvidenceRights(db, tenantId, refs);
  validatePinnedPolicy(task, tenantId);
  const currentPin = buildAstraResearchPolicyPin(currentPolicyRows, tenantId).pin;
  if (task.policyRefs?.length !== 1 || canonicalJson(task.policyRefs[0]) !== canonicalJson(currentPin)) {
    throw reject('Pinned rights policy no longer matches the current evidence rights.', 'policy_changed');
  }
  const allowed = task.allowedReadTools || [];
  if (allowed.length !== 1 || allowed[0].name !== ASTRA_RESEARCH_READ_TOOL.name || allowed[0].capability !== 'read'
    || canonicalJson(allowed[0].argumentSchemaRef) !== canonicalJson(ASTRA_RESEARCH_READ_TOOL.argumentSchemaRef)) {
    throw reject('Read tool is not pinned to the runtime allowlist and argument schema.', 'tool_not_allowlisted');
  }
  const args = validateToolArguments({ workflowId, evidenceRefs: refs }, tenantId);
  if (Date.now() >= deadlineAt) throw reject('Execution deadline has expired.', 'execution_deadline_exceeded');
  // Rights and content hashes were just rechecked in the signed worker context.
  const evidenceEntries = (task.contextManifest.entries || []).filter(entry => entry.recordType === 'evidence');
  const researchTask = { ...task, inputEvidenceRefs: args.evidenceRefs.map(ref => ({ tenantId: ref.tenantId, recordId: ref.recordId, contentSha256: ref.contentSha256 })),
    contextManifest: { ...task.contextManifest, entries: evidenceEntries } };
  const result = await runAstraResearchTask({ db, actor, workflowId: args.workflowId, task: researchTask });
  if (Date.now() >= deadlineAt) throw reject('Execution deadline has expired.', 'execution_deadline_exceeded');
  if (!await assertResearchResult(db, tenantId, workflowId, task, refs, result)) {
    return { ...result, status: 'review_required', proposedNextStep: 'human_review' };
  }
  return { ...result, usage: [] };
}

