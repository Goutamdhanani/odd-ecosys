import { listAstraTelemetry, recordAstraTelemetry } from './astra-telemetry.js';
import { getAstraEngagementMetrics, prepareAstraTrackingToken, setAstraTrackingPermission } from './astra-engagement.js';
import { AstraOperationsError, openAstraIncident, observeAstraOperations, recordAstraRecoveryReceipt, requestAstraRecovery, resolveAstraIncident, setAstraKillSwitch } from './astra-operations.js';

const PATH = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/operations$/;
const WRITE_ROLES = ['owner', 'admin', 'operator'];
export function registerAstraOperationsRoutes(registrar) {
  const registerAstraApiRoute = typeof registrar === 'function' ? registrar : registrar?.registerAstraApiRoute;
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const handler = async (req, res, context) => {
    const { actor, params, db, readJson, sendJson } = context;
    if (String(actor?.tenantId || '').toLowerCase() !== String(params?.tenantId || '').toLowerCase()) throw new AstraOperationsError('Verified tenant membership is required.', 403, 'tenant_membership_required');
    if (req.method === 'GET') {
      const url = new URL(req.url || context.pathname, 'http://astra.local');
      const campaignId = url.searchParams.get('campaignId');
      if (campaignId) return sendJson(res, { data: await getAstraEngagementMetrics(db, actor.tenantId, campaignId) }, 200);
      const sinceValue = url.searchParams.get('since');
      const since = sinceValue && Number.isFinite(Date.parse(sinceValue)) ? new Date(sinceValue).toISOString() : null;
      return sendJson(res, { data: { operations: await observeAstraOperations(db, actor.tenantId), telemetry: await listAstraTelemetry(db, actor.tenantId, { since }) } }, 200);
    }
    const body = await readJson(req, 64 * 1024);
    if (body.action === 'telemetry.record') return sendJson(res, { data: await recordAstraTelemetry(db, actor, body.event) }, 201);
    if (body.action === 'kill_switch.set') return sendJson(res, { data: await setAstraKillSwitch(db, actor, body) }, 200);
    if (body.action === 'tracking.permission.set') {
      if (!['owner', 'admin'].includes(actor.tenantRole)) throw new AstraOperationsError('Only a tenant owner or admin may set tracking permission.', 403, 'tracking_permission_forbidden');
      return sendJson(res, { data: await setAstraTrackingPermission(db, actor, body) }, 200);
    }
    if (body.action === 'incident.open') return sendJson(res, { data: await openAstraIncident(db, actor, body) }, 201);
    if (body.action === 'incident.resolve') return sendJson(res, { data: await resolveAstraIncident(db, actor, body.incidentId) }, 200);
    if (body.action === 'recovery.request') return sendJson(res, { data: await requestAstraRecovery(db, actor, body) }, 201);
    if (body.action === 'recovery.receipt') return sendJson(res, { data: await recordAstraRecoveryReceipt(db, actor, body) }, 200);
    if (body.action === 'tracking.prepare') return sendJson(res, { data: await prepareAstraTrackingToken(db, actor, body) }, 201);
    throw new AstraOperationsError('Operations action is not supported.', 400, 'operations_action_invalid');
  };
  registerAstraApiRoute({ method: 'GET', path: PATH, handler });
  registerAstraApiRoute({ method: 'POST', path: PATH, handler, allowedRoles: WRITE_ROLES });
  return { registered: ['GET /api/astra/tenants/:tenantId/operations', 'POST /api/astra/tenants/:tenantId/operations'] };
}
