import { createAstraTenantStore } from './astra-tenant-store.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { runAstraConnectorJob, makeAstraConnectorJobAdapters } from './astra-connectors.js';
import { runAstraGenerationJob } from './astra-generation.js';
import { ingestAstraTwentyWebhook } from './astra-crm-adapter.js';
import { reserveAstraEconomicsQuota, reconcileAstraEconomicsQuota } from './astra-economics.js';

let workerStore = null;
let connectorJobAdapters = null;

function getWorkerStore() {
  if (!workerStore) workerStore = createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  return workerStore;
}

function workerActor(actor, tenantId) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(tenantId).toLowerCase()) {
    throw new AstraTenantContextError('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
  return { tenantId: actor.tenantId, userId: String(actor.userId), tenantRole: actor.tenantRole };
}

/** Configure server-owned adapters. The worker store is separate from the API store. */
export function configureAstraFeatureWorkers({ store = null, connectorAdapters = null } = {}) {
  workerStore = store || workerStore || createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  connectorJobAdapters = connectorAdapters ? makeAstraConnectorJobAdapters(connectorAdapters) : null;

  async function runConnectorTask({ taskId, tenantId, userId }) {
    const adapters = connectorJobAdapters;
    return runAstraConnectorJob({
      withWorkerTenant: getWorkerStore().withWorkerTenant,
      tenantId,
      userId,
      jobId: taskId,
      ...(adapters || {}),
      preview: ['1', 'true'].includes(String(process.env.LOCAL_PREVIEW || '').toLowerCase())
        || ['1', 'true'].includes(String(process.env.ASTRA_LOCAL_PREVIEW || '').toLowerCase()),
    });
  }

  async function runWebhookTask({ tenantId, userId, connectorId, rawBody, signature, timestamp }) {
    const storeForWorker = getWorkerStore();
    return storeForWorker.withWorkerTenant({ tenantId, userId }, async (db, membership) =>
      ingestAstraTwentyWebhook(db, { tenantId: membership.tenantId, userId: String(membership.userId), tenantRole: membership.tenantRole },
        { connectorId, rawBody, signature, timestamp }));
  }

  return Object.freeze({ runMailboxTask: runConnectorTask, runVerificationTask: runConnectorTask, runWebhookTask });
}

async function runGenerationOnce({ requestId, tenantId, actor, legacyDb }) {
  const principal = workerActor(actor, tenantId);
  const store = getWorkerStore();
  // The generation runner currently accepts withTenant. Bind that method only
  // to the separate astra_worker store; this never falls back to the API store.
  const withWorkerTenant = store.withWorkerTenant;
  const tenantStore = Object.freeze({ withTenant: withWorkerTenant, withWorkerTenant });
  let quotaReservation = null;
  try {
    quotaReservation = await store.withWorkerTenant({ tenantId, userId: principal.userId }, async (db, membership) => {
      const actorContext = { tenantId: membership.tenantId, userId: String(membership.userId), tenantRole: membership.tenantRole };
      const config = await db.query(`SELECT enabled,max_task_tokens,max_trace_bytes FROM astra.economics_tenant_quotas WHERE tenant_id=$1::uuid`, [tenantId]);
      if (config.rows[0]?.enabled !== true) return null;
      const found = await db.query(`SELECT state,reserved_microusd,input_payload,task FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, requestId]);
      const job = found.rows[0];
      if (!job || job.state !== 'queued') return null;
      const policy = await db.query(`SELECT max_input_tokens,max_output_tokens FROM astra.generation_tenant_policies WHERE tenant_id=$1::uuid`, [tenantId]);
      const traceBytes = Buffer.byteLength(JSON.stringify(job.input_payload || {}), 'utf8');
      const tokenEstimate = Number(policy.rows[0]?.max_input_tokens || 0) + Number(policy.rows[0]?.max_output_tokens || 0);
      return reserveAstraEconomicsQuota(db, actorContext, { taskId: requestId, idempotencyKey: `generation:${requestId}`,
        estimatedMicrousd: Number(job.reserved_microusd), tokens: tokenEstimate, traceBytes });
    });
    if (!quotaReservation && await store.withWorkerTenant({ tenantId, userId: principal.userId }, async db => {
      const q = await db.query(`SELECT enabled FROM astra.economics_tenant_quotas WHERE tenant_id=$1::uuid`, [tenantId]);
      return q.rows[0]?.enabled === true;
    })) {
      await store.withWorkerTenant({ tenantId, userId: principal.userId }, async db => {
        await db.query(`UPDATE astra.generation_jobs SET state='blocked',reserved_microusd=0,error_code='economics_quota_reservation_required',completed_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='queued'`, [tenantId, requestId]);
      });
      return { id: requestId, status: 'blocked', errorCode: 'economics_quota_reservation_required' };
    }
    const result = await runAstraGenerationJob({ tenantStore, tenantId, userId: principal.userId, requestId, legacyDb });
    if (quotaReservation) {
      await store.withWorkerTenant({ tenantId, userId: principal.userId }, async (db, membership) => {
        const usage = result?.usage;
        const state = result?.status === 'completed' ? 'completed' : result?.status === 'uncertain' ? 'uncertain' : 'failed';
        const actualMicrousd = Number.isSafeInteger(usage?.actualCostMicrousd) && usage.actualCostMicrousd >= 0 ? usage.actualCostMicrousd : null;
        const kind = usage?.providerRequestId ? 'provider_receipt' : (actualMicrousd !== null ? 'internal_meter' : 'unknown');
        await reconcileAstraEconomicsQuota(db, { tenantId: membership.tenantId, userId: String(membership.userId), tenantRole: membership.tenantRole }, {
          taskId: requestId, actualMicrousd, state, providerBillId: null,
          provenance: { kind, reference: usage?.providerRequestId || `generation:${requestId}`, observedAt: new Date().toISOString() },
        });
      });
    }
    return result;
  } catch (error) {
    if (quotaReservation) {
      try {
        await store.withWorkerTenant({ tenantId, userId: principal.userId }, async (db, membership) => {
          await reconcileAstraEconomicsQuota(db, { tenantId: membership.tenantId, userId: String(membership.userId), tenantRole: membership.tenantRole }, {
            taskId: requestId, actualMicrousd: null, state: 'uncertain', providerBillId: null,
            provenance: { kind: 'unknown', reference: `generation:${requestId}`, observedAt: new Date().toISOString() },
          });
        });
      } catch { /* preserve the original worker failure; unresolved reservation remains visible as uncertain */ }
    }
    // Validation/storage failures must not leave an explicit operator request
    // looking queued. Keep terminal jobs intact and fail closed for queued ones.
    await store.withWorkerTenant({ tenantId, userId: principal.userId }, async db => {
      await db.query(`UPDATE astra.generation_jobs SET state='blocked',reserved_microusd=0,error_code='generation_worker_blocked',completed_at=now()
        WHERE tenant_id=$1 AND id=$2::uuid AND state='queued'`, [tenantId, requestId]);
    });
    throw error;
  }
}

export function getAstraFeatureWorkerStore() { return getWorkerStore(); }

export function registerAstraFeatureWorkerRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  registerAstraApiRoute({
    method: 'POST',
    path: /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/generation\/jobs\/(?<jobId>[0-9a-fA-F-]{36})\/run-once$/,
    handler: async (req, _res, context) => {
      const { tenantId, jobId } = context.params;
      const actor = workerActor(context.actor, tenantId);
      if (!['owner', 'admin', 'operator'].includes(actor.tenantRole)) {
        throw new AstraTenantContextError('A tenant operator role is required to run generation.', 403, 'generation_request_role_required');
      }
      const body = await context.readJson(req, 1024);
      if (Object.keys(body).length) throw new AstraTenantContextError('Run-once accepts an empty JSON object.', 400, 'generation_run_once_body_invalid');
      context.afterCommit(() => runGenerationOnce({ requestId: jobId, tenantId, actor, legacyDb: context.legacyDb }));
      return {
        status: 202,
        body: { data: { id: jobId, status: 'execution_requested', workerAutostart: false, providerEgress: 'disabled' } },
      };
    },
  });
  return { registered: ['POST /api/astra/tenants/:tenantId/generation/jobs/:jobId/run-once'] };
}
