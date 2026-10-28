import { AstraLedgerError } from './astra-ledger.js';
import {
  createAstraMemoryItem, listAstraMemory, recallAstraMemory, tombstoneAstraMemory,
} from './astra-memory.js';
import {
  assignAstraExperimentAccounts, createAstraExperiment, declareAstraExperimentExposure,
  getAstraExperimentVerifiedExposureEventTypes, listAstraExperimentAssignments, listAstraExperiments,
} from './astra-experiments.js';
import { getAstraExperimentAnalysis, getAstraFunnelAnalytics } from './astra-analytics.js';

const PATH = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/(?<resource>memory|experiments|analytics)(?:\/(?<recordId>[0-9a-fA-F-]{36}|recall|items|funnel)(?:\/(?<action>assignments|exposures|analysis|tombstones))?)?$/;
const WRITE_ROLES = ['owner', 'admin', 'operator'];

function fail(message, status = 400, code = 'astra_insights_route_error') {
  throw new AstraLedgerError(message, status, code);
}
function assertActor(params, actor) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    throw new AstraLedgerError('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
}
function query(req, pathname) {
  return new URL(req.url || pathname, 'http://astra.local').searchParams;
}
function send(sendJson, res, data, status = 200) { return sendJson(res, { data }, status); }
function methodNotAllowed(sendJson, res) {
  return sendJson(res, { error: 'Method not allowed.', code: 'method_not_allowed' }, 405);
}

async function handleMemory(req, res, context) {
  const { params, actor, db, pathname, readJson, sendJson } = context;
  assertActor(params, actor);
  const url = query(req, pathname);
  if (req.method === 'POST' && (params.recordId === 'items' || !params.recordId)) {
    const body = await readJson(req, 32 * 1024);
    return send(sendJson, res, await createAstraMemoryItem(db, actor, body), 201);
  }
  if (req.method === 'POST' && params.recordId && params.action === 'tombstones') {
    const body = await readJson(req, 8 * 1024);
    const result = await tombstoneAstraMemory(db, actor, params.recordId, body.reason);
    return send(sendJson, res, result, result.duplicate ? 200 : 201);
  }
  if (req.method === 'GET' && params.recordId === 'recall') {
    const result = await recallAstraMemory(db, actor.tenantId, {
      subject: { type: url.get('subjectType'), id: url.get('subjectId') },
      purpose: url.get('purpose'), query: url.get('q'), at: url.get('at'), limit: url.get('limit'),
    });
    return send(sendJson, res, result);
  }
  if (req.method === 'GET' && (!params.recordId || params.recordId === 'items')) {
    const result = await listAstraMemory(db, actor.tenantId, {
      subject: { type: url.get('subjectType'), id: url.get('subjectId') },
      purpose: url.get('purpose'), at: url.get('at'), limit: url.get('limit'),
    });
    return send(sendJson, res, result);
  }
  return methodNotAllowed(sendJson, res);
}

async function handleExperiments(req, res, context) {
  const { params, actor, db, pathname, readJson, sendJson } = context;
  assertActor(params, actor);
  const url = query(req, pathname);
  if (req.method === 'POST' && !params.recordId) {
    const body = await readJson(req, 64 * 1024);
    return send(sendJson, res, await createAstraExperiment(db, actor, body), 201);
  }
  if (req.method === 'GET' && !params.recordId) {
    return send(sendJson, res, await listAstraExperiments(db, actor.tenantId, { limit: url.get('limit') }));
  }
  if (params.recordId && !['assignments', 'exposures', 'analysis'].includes(params.action)) {
    return sendJson(res, { error: 'Experiment route was not found.', code: 'experiment_route_not_found' }, 404);
  }
  if (req.method === 'GET' && params.action === 'assignments') {
    return send(sendJson, res, await listAstraExperimentAssignments(db, actor.tenantId, params.recordId, { limit: url.get('limit') }));
  }
  if (req.method === 'POST' && params.action === 'assignments') {
    const body = await readJson(req, 128 * 1024);
    const result = await assignAstraExperimentAccounts(db, actor, params.recordId, body.accounts);
    return send(sendJson, res, result, 201);
  }
  if (req.method === 'POST' && params.action === 'exposures') {
    const body = await readJson(req, 16 * 1024);
    const result = await declareAstraExperimentExposure(db, actor, params.recordId, body);
    return send(sendJson, res, result, result.duplicate ? 200 : 201);
  }
  if (req.method === 'GET' && params.action === 'analysis') {
    return send(sendJson, res, await getAstraExperimentAnalysis(db, actor.tenantId, params.recordId));
  }
  return methodNotAllowed(sendJson, res);
}

async function handleAnalytics(req, res, context) {
  const { params, actor, db, pathname, sendJson } = context;
  assertActor(params, actor);
  if (req.method !== 'GET') return methodNotAllowed(sendJson, res);
  if (params.recordId === 'funnel' || !params.recordId) {
    const url = query(req, pathname);
    return send(sendJson, res, await getAstraFunnelAnalytics(db, actor.tenantId, {
      from: url.get('from'), to: url.get('to'),
    }));
  }
  return sendJson(res, { error: 'Analytics route was not found.', code: 'analytics_route_not_found' }, 404);
}

async function handle(req, res, context) {
  const resource = context.params?.resource;
  if (resource === 'memory') return handleMemory(req, res, context);
  if (resource === 'experiments') return handleExperiments(req, res, context);
  if (resource === 'analytics') return handleAnalytics(req, res, context);
  return context.sendJson(res, { error: 'Insights route was not found.', code: 'insights_route_not_found' }, 404);
}

export function registerAstraInsightsRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  registerAstraApiRoute({ method: 'GET', path: PATH, handler: handle });
  registerAstraApiRoute({ method: 'POST', path: PATH, handler: handle, allowedRoles: WRITE_ROLES });
  return { registered: [
    'POST /api/astra/tenants/:tenantId/memory/items',
    'GET /api/astra/tenants/:tenantId/memory/items?subjectType=&subjectId=&purpose=&at=&limit=',
    'GET /api/astra/tenants/:tenantId/memory/recall?subjectType=&subjectId=&purpose=&q=&at=&limit=',
    'POST /api/astra/tenants/:tenantId/memory/:memoryId/tombstones',
    'GET /api/astra/tenants/:tenantId/experiments',
    'POST /api/astra/tenants/:tenantId/experiments',
    'GET /api/astra/tenants/:tenantId/experiments/:experimentId/assignments',
    'POST /api/astra/tenants/:tenantId/experiments/:experimentId/assignments',
    'POST /api/astra/tenants/:tenantId/experiments/:experimentId/exposures',
    'GET /api/astra/tenants/:tenantId/experiments/:experimentId/analysis',
    'GET /api/astra/tenants/:tenantId/analytics/funnel?from=&to=',
  ], exposureVerificationEventTypes: getAstraExperimentVerifiedExposureEventTypes() };
}
