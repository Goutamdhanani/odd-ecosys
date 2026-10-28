import { randomUUID } from 'node:crypto';
import { minimizeGlmInput, AstraGlmGatewayError, GLM_PROVIDER } from './astra-egress.js';
import {
  assertAstraReceiptTelemetryReady, configureAstraAiTenantPolicy, getAstraAiStatus, reserveAstraUsage,
} from './astra-usage.js';
import { validateOfferVersionForUse } from './offer-contracts.js';
import { evaluateOfferModelEgress } from './offer-policy.js';

const TENANT_AI_ROUTE = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/ai(?<resource>\/policy|\/research|\/requests\/(?<requestId>[0-9a-fA-F-]{36})(?<action>\/cancel)?)?$/;
const WRITER_ROLES = new Set(['owner', 'admin', 'operator']);
const CONFIG_ROLES = new Set(['owner', 'admin']);

function routeError(message, statusCode = 400, code = 'ai_request_invalid') {
  return Object.assign(new Error(message), { statusCode, code });
}

function assertActor(params, actor) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    throw routeError('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
}

function checkOfferEgress(legacyDb, actor, offerVersionId) {
  if (!legacyDb) throw new AstraGlmGatewayError('Offer policy storage is unavailable; model egress is blocked.', 'offer_policy_unavailable', 503);
  const versionId = Number(offerVersionId);
  if (!Number.isSafeInteger(versionId) || versionId < 1) throw new AstraGlmGatewayError('The bound offer version is invalid.', 'offer_binding_invalid', 400);
  const version = validateOfferVersionForUse(legacyDb, versionId);
  if (!version.ok) throw new AstraGlmGatewayError(`Offer egress is blocked: ${version.code}.`, 'offer_policy_denied', 403);
  const owner = legacyDb.prepare(`SELECT ownership.tenant_id FROM offer_versions AS versions
    JOIN offer_tenant_ownership AS ownership ON ownership.offer_id=versions.offer_id WHERE versions.id=?`).get(versionId);
  if (!owner?.tenant_id || String(owner.tenant_id).toLowerCase() !== String(actor.tenantId).toLowerCase()) {
    throw new AstraGlmGatewayError('The bound offer does not belong to this tenant.', 'offer_tenant_mismatch', 404);
  }
  const verdict = evaluateOfferModelEgress(version.content, GLM_PROVIDER);
  if (!verdict.ok) throw new AstraGlmGatewayError(`Offer egress is blocked: ${verdict.blockers[0]}.`, 'offer_policy_denied', 403);
  return version.offerVersionId;
}

async function handle(req, _res, context) {
  const { params, actor, db, readJson, sendJson, legacyDb } = context;
  assertActor(params, actor);
  const resource = params.resource || '';
  if (req.method === 'GET' && (resource === '' || resource === '/policy')) {
    return sendJson(_res, { data: await getAstraAiStatus(db, actor.tenantId) }, 200);
  }
  if (req.method === 'PATCH' && resource === '/policy') {
    if (!CONFIG_ROLES.has(actor.tenantRole)) throw routeError('Only tenant owners or admins may change AI policy.', 403, 'ai_policy_role_required');
    const body = await readJson(req, 16 * 1024);
    const policy = await configureAstraAiTenantPolicy(db, actor.tenantId, body);
    return sendJson(_res, { data: { policy } }, 200);
  }
  if (req.method === 'POST' && resource === '/research') {
    if (!WRITER_ROLES.has(actor.tenantRole)) throw routeError('A tenant operator role is required to request model work.', 403, 'ai_request_role_required');
    const body = await readJson(req, 128 * 1024);
    if (body.dataClassification !== 'synthetic-fixture') {
      throw new AstraGlmGatewayError('Only explicitly classified synthetic fixtures may be queued for GLM.', 'glm_data_classification_denied', 403);
    }
    const safeInput = minimizeGlmInput(body.input, body.dataClassification);
    const task = typeof body.task === 'string' ? body.task : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    const offerVersionId = body.offerVersionId === undefined ? null : checkOfferEgress(legacyDb, actor, body.offerVersionId);
    const requestId = randomUUID();
    const reserved = await reserveAstraUsage(db, {
      tenantId: actor.tenantId,
      task,
      idempotencyKey,
      input: safeInput,
      dataClassification: body.dataClassification,
      offerVersionId,
      maxInputTokens: body.maxInputTokens,
      maxOutputTokens: body.maxOutputTokens,
      requestId,
    });
    return sendJson(_res, {
      data: {
        requestId: reserved.id,
        status: reserved.state,
        duplicate: reserved.duplicate,
        provider: 'glm-5.3-api',
        model: 'GLM-5.3',
        reservationMicrousd: reserved.reservedMicrousd,
        pollPath: `/api/astra/tenants/${actor.tenantId}/ai/requests/${reserved.id}`,
      },
    }, reserved.duplicate ? 200 : 202);
  }
  if (req.method === 'GET' && params.requestId) {
    let receiptTelemetryReady = true;
    try { await assertAstraReceiptTelemetryReady(db, 'ai_usage_requests'); }
    catch (error) {
      if (error?.code !== 'ai_receipt_schema_unavailable') throw error;
      receiptTelemetryReady = false;
    }
    const receiptColumns = receiptTelemetryReady
      ? 'actual_provider,actual_model,reasoning_tokens,provider_quota,actual_cost_source,response_verified,accounting_status'
      : 'NULL::text AS actual_provider,NULL::text AS actual_model,NULL::integer AS reasoning_tokens,NULL::jsonb AS provider_quota,NULL::text AS actual_cost_source,NULL::boolean AS response_verified,NULL::text AS accounting_status';
    const result = await db.query(`SELECT id,task,provider,model,state,data_classification,
        reserved_microusd,input_tokens,output_tokens,cost_microusd,error_code,provider_request_id,
        created_at,started_at,completed_at,${receiptColumns}
      FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, params.requestId]);
    const row = result.rows[0];
    if (!row) throw routeError('AI request was not found.', 404, 'ai_request_not_found');
    const responseVerified = row.response_verified === true ? true : row.response_verified === false ? false : null;
    const actual = responseVerified === true && typeof row.actual_provider === 'string' && row.actual_provider.length > 0
      && typeof row.actual_model === 'string' && row.actual_model.length > 0
      ? { provider: row.actual_provider, model: row.actual_model } : null;
    return sendJson(_res, { data: {
      requestId: row.id, task: row.task, provider: row.provider, model: row.model, status: row.state,
      logical: { provider: row.provider, model: row.model }, actual,
      actualProvider: actual?.provider ?? null, actualModel: actual?.model ?? null,
      responseVerified, responseStatus: responseVerified === true ? 'verified' : responseVerified === false ? 'unverified' : 'unknown',
      receiptTelemetryReady, reasoningTokens: row.reasoning_tokens == null ? null : Number(row.reasoning_tokens),
      accountingStatus: row.accounting_status ?? null, providerQuota: row.provider_quota ?? null,
      actualCostSource: row.actual_cost_source ?? null,
      dataClassification: row.data_classification, reservationMicrousd: Number(row.reserved_microusd),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      costMicrousd: row.cost_microusd === null ? null : Number(row.cost_microusd),
      errorCode: row.error_code, providerRequestId: row.provider_request_id,
      createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
    } }, 200);
  }
  if (req.method === 'POST' && params.requestId && params.action === '/cancel') {
    if (!WRITER_ROLES.has(actor.tenantRole)) throw routeError('A tenant operator role is required to cancel model work.', 403, 'ai_request_role_required');
    const result = await db.query(`UPDATE astra.ai_usage_requests SET state='cancelled',reserved_microusd=0,
      error_code='cancelled_before_dispatch',completed_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='queued'
      RETURNING id,state,reserved_microusd`, [actor.tenantId, params.requestId]);
    const row = result.rows[0];
    if (!row) throw routeError('Only queued model requests can be cancelled through this route.', 409, 'ai_request_not_cancellable');
    return sendJson(_res, { data: { requestId: row.id, status: row.state, reservationMicrousd: Number(row.reserved_microusd) } }, 200);
  }
  return sendJson(_res, { error: 'AI route was not found.', code: 'ai_route_not_found' }, 404);
}

/** Positional route registrar matches the foundation's tenant route modules. */
export function registerAstraAiRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute must be a function.');
  for (const method of ['GET', 'PATCH', 'POST']) registerAstraApiRoute({ method, path: TENANT_AI_ROUTE, handler: handle });
  return { registered: [
    'GET /api/astra/tenants/:tenantId/ai',
    'GET /api/astra/tenants/:tenantId/ai/policy',
    'PATCH /api/astra/tenants/:tenantId/ai/policy',
    'POST /api/astra/tenants/:tenantId/ai/research',
    'GET /api/astra/tenants/:tenantId/ai/requests/:requestId',
    'POST /api/astra/tenants/:tenantId/ai/requests/:requestId/cancel',
  ] };
}
