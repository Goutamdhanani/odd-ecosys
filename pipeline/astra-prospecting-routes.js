import { randomUUID } from 'node:crypto';
import { createAstraProspectingService, normalizeProspectingRequest } from './astra-prospecting.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/prospecting';
const READ = ['owner', 'admin', 'operator', 'reviewer'];
const WRITE = ['owner', 'admin', 'operator'];
const START = ['owner'];

function route(register, method, suffix, handler, allowedRoles = READ) {
  register({ method, path: new RegExp(`${BASE}${suffix}$`), handler: async (...args) => {
    try { return await handler(...args); }
    catch (error) {
      const publicMessages = {
        persistence_configuration_invalid: 'Dedicated prospecting storage is not configured.',
        mongodb_connect_failed: 'Prospecting storage could not connect. The coordinator must verify the dedicated test database.',
        mongodb_operation_failed: 'Prospecting storage is unavailable. Retry after the coordinator checks the dedicated test database.',
        mongodb_not_connected: 'Prospecting storage is not connected yet.',
        transaction_unsupported: 'The Mongo deployment does not support durable prospecting transactions.',
        source_search_unavailable: 'The approved public search service is not configured.',
        worker_unavailable: 'The dedicated source worker is not configured.',
        job_not_found: 'Prospecting job was not found.',
        version_conflict: 'This job changed. Refresh its status and try again.',
        lease_lost: 'This worker no longer owns the job. Refresh its status before retrying.',
        idempotency_conflict: 'This request key was already used with different content. Refresh and retry.',
        identity_conflict: 'A different evidence record already exists for this business. The result stays quarantined for review.',
        evidence_required: 'A qualified business requires saved source evidence.',
        owner_required: 'Only a workspace owner can start guided prospecting.',
        prospecting_reconciliation_required: 'A saved change may still be reconciling. Refresh job history and retry the same request; do not start it under a new request key.',
      };
      const requestedStatus = Number.isInteger(error?.statusCode) ? error.statusCode
        : Number.isInteger(error?.status) ? error.status : 503;
      const status = requestedStatus >= 400 && requestedStatus < 600 ? requestedStatus : 503;
      const trustedMessage = error?.name === 'AstraProspectingError' || typeof error?.publicMessage === 'string';
      const message = publicMessages[error?.code] || (trustedMessage ? error.publicMessage || error.message : 'Prospecting could not complete. Check the setup and retry.');
      return { status, body: { error: message, ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(error?.reconciliationRequired ? { reconciliationRequired: true, commitState: error.commitState || 'unknown' } : {}) } };
    }
  }, allowedRoles });
}

function assertTenant(actor, params) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    throw Object.assign(new Error('Verified workspace membership is required.'), { statusCode: 403, code: 'tenant_membership_required' });
  }
}

function idempotencyHeader(req) {
  const value = req.headers?.['idempotency-key'];
  if (typeof value !== 'string' || value.length > 200 || value.trim() !== value || !value) {
    throw Object.assign(new Error('Refresh the page and retry this request.'), { statusCode: 400, code: 'idempotency_key_required' });
  }
  return value;
}

function version(body) {
  if (!Number.isSafeInteger(body?.version) || body.version < 1) {
    throw Object.assign(new Error('Refresh the job before changing its status.'), { statusCode: 409, code: 'version_conflict' });
  }
  return body.version;
}

/** Mongo work is isolated here; all tenantId values originate from Astra's authenticated membership context. */
export function registerAstraProspectingRoutes(registerAstraApiRoute, { service = createAstraProspectingService() } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');

  route(registerAstraApiRoute, 'GET', '/status', async (_req, _res, { actor, params }) => {
    assertTenant(actor, params);
    return { prospecting: await service.status(), releaseReady: false };
  });

  route(registerAstraApiRoute, 'GET', '/jobs', async (_req, _res, { actor, params }) => {
    assertTenant(actor, params);
    return { jobs: await service.list(actor.tenantId), releaseReady: false };
  });

  route(registerAstraApiRoute, 'GET', '/jobs/(?<jobId>[0-9a-fA-F-]{36})', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    const result = await service.get(actor.tenantId, params.jobId, actor.userId, db);
    if (!result) throw Object.assign(new Error('Prospecting job was not found.'), { statusCode: 404, code: 'job_not_found' });
    return { ...result, releaseReady: false };
  });

  route(registerAstraApiRoute, 'GET', '/contacts', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    return { contacts: await service.contacts(actor.tenantId, actor.userId, db), releaseReady: false };
  });

  route(registerAstraApiRoute, 'POST', '/contacts/(?<contactId>[0-9a-fA-F-]{36})/campaign-proof', async (req, _res, { actor, params, readJson, db }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
      return { status: 400, body: { error: 'Select a saved prospect. Research proof is resolved from workspace records.' } };
    }
    return { preparation: await service.prepareCampaignProof({ tenantId: actor.tenantId, userId: actor.userId, contactId: params.contactId, db, actor }), releaseReady: false };
  }, WRITE);

  route(registerAstraApiRoute, 'POST', '/jobs', async (req, _res, { actor, params, readJson, afterCommit }) => {
    assertTenant(actor, params);
    if (actor?.tenantRole !== 'owner') throw Object.assign(new Error('Only a workspace owner can start guided prospecting.'), { statusCode: 403, code: 'owner_required' });
    const body = await readJson(req, 12 * 1024);
    const payload = normalizeProspectingRequest(body);
    const result = await service.create({ tenantId: actor.tenantId, payload, idempotencyKey: idempotencyHeader(req) });
    const leaseExpired = result.job?.state === 'running' && result.job.leaseUntil && new Date(result.job.leaseUntil).valueOf() <= Date.now();
    const dispatchable = result.job?.state === 'queued' || leaseExpired;
    if (dispatchable) {
      // Same-key replay is also the recovery path for a create acknowledged after its write deadline.
      afterCommit(() => service.runOnce({ tenantId: actor.tenantId, userId: actor.userId, jobId: result.job.id }));
    }
    return { status: 202, body: { job: result.job, replayed: result.replayed, executionReady: result.executionReady ?? null,
      executionBlocker: result.executionBlocker ?? null, execution: result.executionReady === false ? 'queued_setup_blocked' : dispatchable ? 'owner_authorized_one_shot_scheduled' : 'owner_authorized_job_already_active', releaseReady: false } };
  }, START);

  route(registerAstraApiRoute, 'POST', '/jobs/(?<jobId>[0-9a-fA-F-]{36})/actions', async (req, _res, { actor, params, readJson, afterCommit }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 8 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action', 'version'].includes(key))
      || !['pause', 'resume', 'cancel'].includes(body.action)) {
      throw Object.assign(new Error('Choose pause, resume, or stop for this job.'), { statusCode: 400, code: 'invalid_transition' });
    }
    const job = await service.transition({ tenantId: actor.tenantId, jobId: params.jobId, action: body.action, expectedVersion: version(body) });
    if (body.action === 'resume') afterCommit(() => service.runOnce({ tenantId: actor.tenantId, userId: actor.userId, jobId: params.jobId }));
    return { job, releaseReady: false };
  }, WRITE);

  return { registered: [
    'GET /api/astra/tenants/:tenantId/prospecting/status',
    'GET /api/astra/tenants/:tenantId/prospecting/jobs',
    'GET /api/astra/tenants/:tenantId/prospecting/jobs/:jobId',
    'GET /api/astra/tenants/:tenantId/prospecting/contacts',
    'POST /api/astra/tenants/:tenantId/prospecting/contacts/:contactId/campaign-proof',
    'POST /api/astra/tenants/:tenantId/prospecting/jobs',
    'POST /api/astra/tenants/:tenantId/prospecting/jobs/:jobId/actions',
  ], service, requestKey: randomUUID };
}
