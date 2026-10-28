import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { runAstraGenerationJob } from './astra-generation.js';
import { runAstraConnectorJob } from './astra-connectors.js';
import { prepareAstraReacherJob, executeAstraReacherJob, commitAstraReacherJob } from './astra-verifier-adapter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso = value => value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString();
const digest = value => sha256(canonicalJson(value));

function normalizeGenerationPolicySnapshot(policy, global) {
  const tenant = policy ? { ...policy, allowed_tasks: [...(policy.allowed_tasks || [])].sort() } : null;
  if (tenant?.updated_at) tenant.updated_at = iso(tenant.updated_at);
  const limits = global ? { ...global } : null;
  if (limits?.breaker_open_until) limits.breaker_open_until = iso(limits.breaker_open_until);
  return { tenant, global: limits };
}

export async function loadAstraGenerationPolicyPin(db, tenantId) {
  const [policy, global] = await Promise.all([
    db.query(`SELECT enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens,updated_at
      FROM astra.generation_tenant_policies WHERE tenant_id=$1::uuid`, [tenantId]),
    db.query(`SELECT enabled,daily_budget_microusd,breaker_state,breaker_open_until FROM astra.ai_global_limits WHERE singleton=true`),
  ]);
  const snapshot = normalizeGenerationPolicySnapshot(policy.rows[0] || null, global.rows[0] || null);
  return { snapshot, policyHash: digest(snapshot) };
}

export function buildAstraConnectorJobInputPin({ jobId, jobType, payload, candidateId, connectorId, evidenceId, contentSha256, candidateValue }) {
  const addressSha256 = createHash('sha256').update(String(candidateValue || '').trim().toLowerCase()).digest('hex');
  return digest({ jobId, jobType, payload, candidateId, connectorId, evidenceId, contentSha256: contentSha256 || null, addressSha256 });
}

export function buildAstraConnectorPolicyPin({ provider, connectorState, endpointHost, publicConfig, approval }) {
  return digest({ provider, connectorState, endpointHost, publicConfig, approval: approval || null });
}

function evidenceEntries(tenantId, refs, egressMode) {
  const unique = new Map();
  for (const item of refs || []) {
    const id = String(item.evidenceId || item.recordId || '').toLowerCase();
    const hash = String(item.evidenceHash || item.contentSha256 || '').toLowerCase();
    if (UUID.test(id) && /^[a-f0-9]{64}$/.test(hash)) unique.set(id, {
      recordRef: { tenantId, recordId: id }, recordType: 'evidence', revision: '1.0.0', sha256: hash,
      sensitivity: 'tenant_confidential', egressMode,
    });
  }
  return [...unique.values()];
}

/** Build the only supported HarnessTask shapes for already-created domain jobs. */
export function buildAstraDomainHarnessTask({ tenantId, kind, jobId, inputHash, evidenceHash, policyHash, evidence = [] }) {
  if (!UUID.test(String(tenantId)) || !UUID.test(String(jobId)) || !['verification', 'drafting', 'reply_classification'].includes(kind)
    || !/^[a-f0-9]{64}$/.test(inputHash || '') || !/^[a-f0-9]{64}$/.test(evidenceHash || '') || !/^[a-f0-9]{64}$/.test(policyHash || '')) {
    throw Object.assign(new Error('A canonical tenant domain job pin is required.'), { code: 'domain_job_pin_invalid' });
  }
  const createdAt = new Date().toISOString();
  const egressMode = ['drafting', 'reply_classification'].includes(kind) ? 'MINIMIZED_REMOTE' : 'NO_MODEL_EGRESS';
  const policyId = `astra-domain-job-policy-${kind}`;
  const policyRef = { id: policyId, version: '1.0.0', sha256: policyHash };
  const policyEntry = { recordRef: { tenantId, recordId: policyId }, recordType: 'policy', revision: '1.0.0', sha256: policyHash,
    sensitivity: 'tenant_confidential', egressMode: 'NO_MODEL_EGRESS' };
  const taskEvidenceEntries = evidenceEntries(tenantId, evidence, egressMode);
  const entries = [...taskEvidenceEntries, policyEntry];
  const manifestBody = { manifestVersion: 1, tenantRef: { tenantId }, createdAt, entries };
  const contextManifest = { ...manifestBody, sha256: digest(manifestBody) };
  const pin = { kind, jobId, inputHash, evidenceHash, policyHash };
  const taskRevision = { id: `astra-domain-${kind}`, version: '1.0.0', sha256: digest(pin) };
  const rubricChecks = [{ checkId: 'canonical_domain_job_completed', kind: 'required_output_present', required: true }];
  return {
    contractKind: 'HarnessTask', schemaVersion: '1.0.0',
    task: { tenantRef: { tenantId }, taskId: `domain-${jobId}`, revision: taskRevision.sha256.slice(0, 24) },
    runRef: { tenantId, recordId: jobId }, subjectRefs: [{ tenantId, recordId: jobId }],
    purpose: kind, taskRevision, policyRefs: [policyRef],
    inputEvidenceRefs: taskEvidenceEntries.map(entry => entry.recordRef), contextManifest,
    allowedReadTools: [], requiredOutputs: [{ artifactType: kind === 'verification' ? 'verification_result' : kind === 'drafting' ? 'draft_copy' : 'reply_classification', minimumCount: 1 }],
    versionPins: { model: null, prompt: null, skills: [], domainJobKind: kind, domainJobId: jobId, inputHash, evidenceHash, policyHash },
    limits: { maxModelCalls: 0, maxReadToolCalls: 0, maxSpendMicroUsd: 0, deadlineSeconds: 60, maxRepairAttempts: 0, maxChallengeRounds: 0 },
    retryPolicy: { id: 'astra-domain-job-no-retry', versionRef: { id: 'astra-domain-job-retry', version: '1.0.0', sha256: digest({ retries: 0 }) },
      modelTimeout: 'stop_for_review', externalSideEffects: 'prohibited' },
    progressPolicy: { versionRef: { id: 'astra-domain-job-progress', version: '1.0.0', sha256: digest({ progress: 'terminal_domain_job_only' }) },
      progressSignals: ['canonical_domain_job_completed'], noProgressAction: 'stop_for_review' },
    completionRubric: { versionRef: { id: 'astra-domain-job-completion', version: '1.0.0', sha256: digest(rubricChecks) }, checks: rubricChecks },
    egressMode, createdAt,
  };
}

function stop(code, status = 'manual_review') {
  return { stopped: true, code: /^[a-z0-9_.:-]{1,64}$/i.test(String(code || '')) ? String(code) : `domain_job_${status}`,
    domainStatus: status };
}

async function loadBinding(db, tenantId, workflowId, task) {
  const result = await db.query(`SELECT b.source_kind AS "sourceKind",b.domain_job_id AS "domainJobId",b.input_hash AS "inputHash",
      b.evidence_hash AS "evidenceHash",b.policy_hash AS "policyHash",b.purpose,b.workflow_id AS "workflowId"
    FROM astra.domain_harness_bindings b WHERE b.tenant_id=$1::uuid AND b.workflow_id=$2::uuid`, [tenantId, workflowId]);
  const binding = result.rows[0];
  const pins = task?.versionPins || {};
  if (!binding || binding.purpose !== task.purpose || binding.domainJobId !== task.runRef?.recordId
    || binding.domainJobId !== pins.domainJobId || binding.sourceKind !== pins.domainJobKind
    || binding.inputHash !== pins.inputHash || binding.evidenceHash !== pins.evidenceHash || binding.policyHash !== pins.policyHash) {
    return null;
  }
  return binding;
}

async function loadCurrentJob(db, tenantId, binding) {
  if (binding.sourceKind === 'generation') {
    const result = await db.query(`SELECT id,task,state,input_hash AS "inputHash",evidence_hash AS "evidenceHash",placeholder_hash AS "placeholderHash"
      FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, binding.domainJobId]);
    return result.rows[0] ? { ...result.rows[0], sourceKind: 'generation' } : null;
  }
  const result = await db.query(`SELECT j.id,j.job_type AS "jobType",j.state,j.payload,j.candidate_id AS "candidateId",j.connector_id AS "connectorId",
      c.provider,c.state AS "connectorState",c.endpoint_host AS "endpointHost",c.public_config AS "publicConfig",c.approval,
      candidate.evidence_id AS "evidenceId",candidate.normalized_value AS "candidateValue",e.content_sha256 AS "contentSha256"
    FROM astra.connector_jobs j JOIN astra.connector_configs c ON (c.tenant_id,c.id)=(j.tenant_id,j.connector_id)
    JOIN astra.research_identity_candidates candidate ON (candidate.tenant_id,candidate.id)=(j.tenant_id,j.candidate_id)
    LEFT JOIN astra.research_evidence e ON (e.tenant_id,e.id)=(candidate.tenant_id,candidate.evidence_id)
    WHERE j.tenant_id=$1::uuid AND j.id=$2::uuid`, [tenantId, binding.domainJobId]);
  return result.rows[0] ? { ...result.rows[0], sourceKind: 'connector' } : null;
}

async function assertBindingCurrent(db, tenantId, binding, job) {
  if (!job) return false;
  if (binding.sourceKind === 'generation') {
    if (job.inputHash !== binding.inputHash || job.evidenceHash !== binding.evidenceHash) return false;
    const { policyHash } = await loadAstraGenerationPolicyPin(db, tenantId);
    return policyHash === binding.policyHash;
  }
  const sourceInputHash = buildAstraConnectorJobInputPin({ jobId: job.id, jobType: job.jobType, payload: job.payload, candidateId: job.candidateId,
    connectorId: job.connectorId, evidenceId: job.evidenceId, contentSha256: job.contentSha256 || null, candidateValue: job.candidateValue });
  const policyHash = buildAstraConnectorPolicyPin({ provider: job.provider, connectorState: job.connectorState, endpointHost: job.endpointHost,
    publicConfig: job.publicConfig, approval: job.approval });
  return sourceInputHash === binding.inputHash && (job.contentSha256 || digest({ evidenceId: job.evidenceId })) === binding.evidenceHash
    && policyHash === binding.policyHash;
}

function harnessResult(task, ref, artifactType, artifactHash, summary) {
  return {
    contractKind: 'HarnessResult', schemaVersion: '1.0.0', task: { tenantRef: task.task.tenantRef, taskId: task.task.taskId, revision: task.task.revision },
    status: 'completed', artifacts: [{ artifactType, recordRef: ref, sha256: artifactHash }], claimRefs: [], unresolvedQuestions: [],
    completionChecks: [{ checkId: 'canonical_domain_job_completed', outcome: 'passed', reasonCode: 'canonical_job_completed' }],
    proposedNextStep: 'human_review', evidenceLinkedSummary: summary, usage: [], checkpointRef: task.taskRevision, completedAt: new Date().toISOString(),
  };
}

/** Execute a server-pinned, existing domain job. All transport and policy work stays in its canonical service. */
export async function executeAstraDomainHarnessTask({ store, tenantId, userId, workflowId, task, legacyDb = null, preview = false } = {}) {
  if (!store || typeof store.withWorkerTenant !== 'function') throw new TypeError('A dedicated worker tenant store is required.');
  const pinned = await store.withWorkerTenant({ tenantId, userId }, async db => {
    const binding = await loadBinding(db, tenantId, workflowId, task);
    if (!binding) return { stopped: true, code: 'domain_job_binding_missing', domainStatus: 'manual_review' };
    const job = await loadCurrentJob(db, tenantId, binding);
    if (!await assertBindingCurrent(db, tenantId, binding, job)) return { stopped: true, code: 'domain_job_pin_changed', domainStatus: job?.state || 'not_found' };
    if (job.state !== 'queued') return { stopped: true, code: `domain_job_already_${job.state || 'unavailable'}`, domainStatus: job.state || 'not_found' };
    return { binding, job };
  });
  if (pinned.stopped) return pinned;

  let outcome;
  if (pinned.binding.sourceKind === 'generation') {
    const tenantStore = Object.freeze({ withTenant: store.withWorkerTenant, withWorkerTenant: store.withWorkerTenant });
    outcome = await runAstraGenerationJob({ tenantStore, tenantId, userId, requestId: pinned.binding.domainJobId, legacyDb });
  } else {
    outcome = await runAstraConnectorJob({ withWorkerTenant: store.withWorkerTenant, tenantId, userId, jobId: pinned.binding.domainJobId,
      preview: preview || ['1', 'true'].includes(String(process.env.LOCAL_PREVIEW || '').toLowerCase())
        || ['1', 'true'].includes(String(process.env.ASTRA_LOCAL_PREVIEW || '').toLowerCase()),
      prepareProvider: context => prepareAstraReacherJob(context),
      executeProvider: context => executeAstraReacherJob(context),
      commitResult: context => commitAstraReacherJob(context),
    });
  }
  const status = outcome?.status || outcome?.state || 'unknown';
  if (status !== 'completed') return stop(outcome?.errorCode || outcome?.diagnosticCode || `domain_job_${status}`, status);

  const completed = await store.withWorkerTenant({ tenantId, userId }, async db => {
    const binding = await loadBinding(db, tenantId, workflowId, task);
    if (!binding) return null;
    if (binding.sourceKind === 'generation') {
      const row = await db.query(`SELECT state,result_payload FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, binding.domainJobId]);
      const job = row.rows[0];
      if (job?.state !== 'completed' || !job.result_payload) return null;
      return { ref: { tenantId, recordId: binding.domainJobId }, type: task.purpose === 'drafting' ? 'draft_copy' : 'reply_classification',
        hash: digest(job.result_payload), summary: `Canonical ${task.purpose} job ${binding.domainJobId} completed; output remains subject to human review.` };
    }
    const row = await db.query(`SELECT j.state,j.result->>'receiptSha256' AS "receiptSha256",r.id AS "receiptId",r.candidate_id AS "candidateId",
        r.address_sha256 AS "addressSha256",r.classification,r.environment,r.provider_status AS "providerStatus",r.expires_at AS "expiresAt"
      FROM astra.connector_jobs j JOIN astra.verification_adapter_receipts r ON r.tenant_id=j.tenant_id
        AND r.candidate_id=j.candidate_id AND r.receipt_sha256=j.result->>'receiptSha256'
      WHERE j.tenant_id=$1::uuid AND j.id=$2::uuid`, [tenantId, binding.domainJobId]);
    const receipt = row.rows[0];
    if (!receipt || receipt.state !== 'completed') return null;
    const record = { id: receipt.receiptId, candidateId: receipt.candidateId, addressSha256: String(receipt.addressSha256).trim(),
      classification: receipt.classification, environment: receipt.environment, providerStatus: receipt.providerStatus, expiresAt: iso(receipt.expiresAt), receiptSha256: receipt.receiptSha256 };
    return { ref: { tenantId, recordId: receipt.receiptId }, type: 'verification_result', hash: digest(record),
      summary: `Canonical verification receipt ${receipt.receiptId} was recorded; classification is ${receipt.classification}.` };
  });
  if (!completed) return stop('domain_job_result_unavailable', 'manual_review');
  return { completed: true, result: harnessResult(task, completed.ref, completed.type, completed.hash, completed.summary), domainStatus: 'completed' };
}

export function canonicalAstraDomainPolicyHash(value) { return sha256(canonicalJson(value)); }
