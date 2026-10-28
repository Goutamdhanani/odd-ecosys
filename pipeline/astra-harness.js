import { checkpointWorkflow, claimWorkflow, completeWorkflow, failWorkflow, normalizeHarnessTask } from './astra-workflow.js';
import { normalizeAstraTenantId, normalizeAstraUserId } from './astra-tenant-context.js';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { executeAstraBoundedResearch } from './astra-runtime.js';
import { assertAstraLaunchTaskCompatible } from './astra-launch-controls.js';
import { executeAstraDomainHarnessTask } from './astra-domain-harness.js';

/** The current worker has no model/provider calls and never performs side effects. */
export const ASTRA_HARNESS_HANDLER_NAMES = Object.freeze(['research', 'verification', 'drafting', 'reply_classification']);

function actorFromMembership(membership, tenantId, userId) {
  return Object.freeze({ ...membership, tenantId, userId, role: membership.tenantRole });
}

function checkDeadline(deadlineAt) {
  if (Date.now() >= deadlineAt) {
    const error = new Error('Execution deadline exceeded.');
    error.code = 'execution_deadline_exceeded';
    throw error;
  }
}

function checkpointFor(lease, task, result, inputHash, deadlineAt) {
  checkDeadline(deadlineAt);
  const evidenceRefs = (task.contextManifest?.entries || []).filter(entry => entry.recordType === 'evidence'
    && (!task.inputEvidenceRefs?.length || task.inputEvidenceRefs.some(ref => ref.recordId === entry.recordRef?.recordId)))
    .map(entry => ({ tenantId: entry.recordRef.tenantId, recordId: entry.recordRef.recordId, contentSha256: entry.sha256 }));
  const noveltyHash = sha256(canonicalJson({
    artifacts: result.artifacts.map(x => ({ artifactType: x.artifactType, recordRef: x.recordRef, sha256: x.sha256 })),
    claimRefs: result.claimRefs,
    evidenceRefs,
  }));
  return {
    checkpointVersion: 'astra-runtime-checkpoint/1.0.0',
    migrationCompatibility: 9,
    workflowId: lease.id,
    attemptRef: { attempt: lease.attempt, leaseTokenSha256: sha256(lease.leaseToken) },
    taskRevision: task.taskRevision,
    contextManifestHash: lease.contextHash,
    policyRefs: task.policyRefs,
    evidenceRefs,
    usageRefs: result.usage || [],
    progress: { canonicalHash: inputHash, noveltyHash },
    artifactRefs: result.artifacts,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Claim and commit, execute one bounded local pass, then checkpoint and
 * complete in independent tenant transactions. No import starts a worker.
 */
export async function runAstraWorkflowOnce({ store, tenantId, userId, workerId = 'astra-harness', leaseSeconds = 180, limits = {}, legacyDb = null, preview = false }) {
  if (!store || typeof store.withWorkerTenant !== 'function') throw new TypeError('A worker tenant store is required.');
  const tenant = normalizeAstraTenantId(tenantId);
  const user = normalizeAstraUserId(userId);
  const safeWorkerId = typeof workerId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(workerId) ? workerId : 'astra-harness';
  const safeLeaseSeconds = Number.isInteger(leaseSeconds) ? Math.max(10, Math.min(300, leaseSeconds)) : 180;

  const lease = await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
    const actor = actorFromMembership(membership, tenant, user);
    return claimWorkflow(db, actor, { workerId: safeWorkerId, leaseSeconds: safeLeaseSeconds, taskClasses: ['interactive', 'suppression', 'standard', 'bulk'] });
  });
  if (!lease) return { worked: false, state: 'idle' };

  const start = Date.now();
  let normalizedLimits = null;
  let result;
  try {
    const inspected = await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
      const actor = actorFromMembership(membership, tenant, user);
      const { task, contextHash } = normalizeHarnessTask(lease.task, tenant);
      await assertAstraLaunchTaskCompatible(db, tenant, task);
      const deadlineSeconds = Math.min(120, Number(task.limits.deadlineSeconds) || 0, Number(limits.deadlineSeconds) || 120);
      if (deadlineSeconds < 1) throw Object.assign(new Error('No execution deadline remains.'), { code: 'execution_deadline_exceeded' });
      normalizedLimits = {
        deadlineAt: start + deadlineSeconds * 1000,
        maxModelCalls: Math.min(task.limits.maxModelCalls ?? 0, Number.isInteger(limits.maxModelCalls) ? limits.maxModelCalls : 0),
        maxReadToolCalls: Math.min(task.limits.maxReadToolCalls ?? 0, Number.isInteger(limits.maxReadToolCalls) ? limits.maxReadToolCalls : 6),
        maxSpendMicroUsd: Math.min(task.limits.maxSpendMicroUsd ?? 0, Number.isSafeInteger(limits.maxSpendMicroUsd) ? limits.maxSpendMicroUsd : 0),
        maxDepth: Math.min(1, Number.isInteger(limits.maxDepth) ? limits.maxDepth : 1),
        maxRepairAttempts: Math.min(1, task.limits.maxRepairAttempts ?? 0),
      };
      // The deployed worker is deliberately offline: any model budget is unusable here.
      // This pass performs no provider/model call, so it creates no AI quota reservation; a future provider-backed path must reserve and reconcile through astra-economics before it can run.
      if (normalizedLimits.maxModelCalls !== 0 || normalizedLimits.maxSpendMicroUsd < 0 || normalizedLimits.maxDepth !== 1) {
        throw Object.assign(new Error('Runtime budget exceeds the offline worker policy.'), { code: 'runtime_budget_rejected' });
      }
      const inputHash = sha256(canonicalJson({ task, contextHash }));
      checkDeadline(normalizedLimits.deadlineAt);
      if (task.purpose !== 'research') {
        const delegated = await executeAstraDomainHarnessTask({ store, tenantId: tenant, userId: user, workflowId: lease.id,
          task, legacyDb, preview });
        checkDeadline(normalizedLimits.deadlineAt);
        if (!delegated.completed) {
          return { task, contextHash, inputHash, blocked: delegated, actor };
        }
        return { task, contextHash, inputHash, result: {
          ...delegated.result,
        } };
      }
      if (normalizedLimits.maxReadToolCalls < 1) throw Object.assign(new Error('Read-tool budget is exhausted.'), { code: 'read_tool_budget_exhausted' });
      await db.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, normalizedLimits.deadlineAt - Date.now()))]);
      const bounded = await executeAstraBoundedResearch({ db, actor, workflowId: lease.id, task, deadlineAt: normalizedLimits.deadlineAt });
      checkDeadline(normalizedLimits.deadlineAt);
      return { task, contextHash, inputHash, result: bounded, actor };
    });

    if (inspected.blocked) {
      const errorCode = /^[a-z0-9_.:-]{1,64}$/i.test(String(inspected.blocked.code || '')) ? inspected.blocked.code : 'domain_job_manual_review';
      const failed = await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
        const actor = actorFromMembership(membership, tenant, user);
        return failWorkflow(db, actor, { id: lease.id, leaseToken: lease.leaseToken, retryable: false,
          externalOutcomeUnknown: inspected.blocked.domainStatus === 'uncertain', errorCode });
      });
      return { worked: true, ...failed, errorCode, domainJobStatus: inspected.blocked.domainStatus || 'manual_review' };
    }

    result = inspected.result;
    if (result.status !== 'completed') {
      const failed = await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
        const actor = actorFromMembership(membership, tenant, user);
        return failWorkflow(db, actor, { id: lease.id, leaseToken: lease.leaseToken, retryable: false, errorCode: 'manual_review_required' });
      });
      return { worked: true, ...failed };
    }

    const checkpoint = checkpointFor(lease, inspected.task, result, inspected.inputHash, normalizedLimits.deadlineAt);
    await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
      const actor = actorFromMembership(membership, tenant, user);
      await checkpointWorkflow(db, actor, { id: lease.id, leaseToken: lease.leaseToken, checkpoint, releaseLease: false });
    });
    checkDeadline(normalizedLimits.deadlineAt);
    const completed = await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
      const actor = actorFromMembership(membership, tenant, user);
      return completeWorkflow(db, actor, { id: lease.id, leaseToken: lease.leaseToken, result });
    });
    return { worked: true, ...completed, attempt: lease.attempt };
  } catch (error) {
    const code = /^[a-z0-9_.:-]{1,64}$/i.test(String(error?.code || '')) ? String(error.code) : 'handler_failed';
    try {
      const failed = await store.withWorkerTenant({ tenantId: tenant, userId: user }, async (db, membership) => {
        const actor = actorFromMembership(membership, tenant, user);
        return failWorkflow(db, actor, { id: lease.id, leaseToken: lease.leaseToken, retryable: false, errorCode: code });
      });
      return { worked: true, ...failed };
    } catch (fenceError) {
      return { worked: true, id: lease.id, state: 'lease_fenced', errorCode: fenceError?.code || 'lease_fenced' };
    }
  }
}

export const runOnce = runAstraWorkflowOnce;

