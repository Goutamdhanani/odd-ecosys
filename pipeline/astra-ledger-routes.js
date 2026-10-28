import { AstraLedgerError, appendEvent, listEvents } from './astra-ledger.js';
import { listOutcomeProjections, normalizeAndValidateAccountEntity, rebuildOutcomeProjection, recordOutcome, recordOutcomeCorrection } from './astra-outcomes.js';

const TENANT_ROUTE = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/(?<resource>events|outcomes(?:\/corrections)?)$/;

function assertRouteActor(params, actor) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    throw new AstraLedgerError('Verified tenant membership is required for this route.', 403, 'tenant_membership_required');
  }
}

function canWrite(actor) {
  return ['owner', 'admin', 'operator'].includes(actor?.tenantRole || actor?.role);
}

function queryOptions(pathname, requestUrl) {
  const url = new URL(requestUrl || pathname, 'http://astra.local');
  return {
    afterSequence: url.searchParams.get('afterSequence') ?? 0,
    limit: url.searchParams.get('limit') ?? 100,
    entityType: url.searchParams.get('entityType') || undefined,
    entityId: url.searchParams.get('entityId') || undefined,
  };
}

export function registerAstraLedgerRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute must be a function.');
  const route = async (req, res, context) => {
    const { params, actor, db, pathname, readJson, sendJson } = context;
    assertRouteActor(params, actor);
    const target = pathname.includes('/outcomes/corrections') ? 'corrections' : pathname.endsWith('/outcomes') ? 'outcomes' : 'events';
    if (req.method === 'GET') {
      const options = queryOptions(pathname, req.url);
      const data = target === 'events'
        ? await listEvents(db, actor.tenantId, options)
        : await listOutcomeProjections(db, actor.tenantId, options);
      return sendJson(res, { data }, 200);
    }
    if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed.', code: 'method_not_allowed' }, 405);
    if (!canWrite(actor)) return sendJson(res, { error: 'A tenant operator role is required to write outcomes.', code: 'role_required' }, 403);
    const body = await readJson(req, 256 * 1024);
    // The generic event endpoint also feeds the outcome projection. Apply the
    // same tenant boundary before appendEvent can write its event or outbox row.
    if (target === 'events') {
      body.entity = await normalizeAndValidateAccountEntity(db, actor.tenantId, body.entity);
    }
    const result = target === 'events'
      ? await appendEvent(db, actor, body)
      : target === 'corrections'
        ? await recordOutcomeCorrection(db, actor, body)
        : await recordOutcome(db, actor, body);
    if (target === 'events') {
      result.projection = await rebuildOutcomeProjection(db, actor.tenantId, body.entity.type, body.entity.id);
    }
    return sendJson(res, { data: result }, result.duplicate ? 200 : 201);
  };

  for (const method of ['GET', 'POST']) {
    registerAstraApiRoute({ method, path: TENANT_ROUTE, handler: route });
  }
  return { registered: ['GET /api/astra/tenants/:tenantId/events', 'POST /api/astra/tenants/:tenantId/events',
    'GET /api/astra/tenants/:tenantId/outcomes', 'POST /api/astra/tenants/:tenantId/outcomes',
    'POST /api/astra/tenants/:tenantId/outcomes/corrections'] };
}

