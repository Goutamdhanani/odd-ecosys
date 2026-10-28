import { createAstraBusinessGoalService } from './astra-business-goal.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/business-goals';
const READ = ['owner', 'admin', 'operator', 'reviewer'];
const WRITE = ['owner', 'admin', 'operator'];
const OWNER = ['owner'];

function route(register, method, suffix, handler, allowedRoles = READ) {
  register({ method, path: new RegExp(`${BASE}${suffix}$`), handler: async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const publicMessages = {
        business_goal_idempotency_conflict: 'This request key was already used with a different brief. Refresh and retry with a new key.',
        business_goal_version_conflict: 'The goal run changed. Refresh its status and try again.',
        business_goal_version_required: 'Refresh the goal before saving. Its current revision is required.',
        business_goal_answer_not_current: 'Those answers do not match the questions for this goal revision. Refresh and try again.',
        business_goal_not_found: 'Goal run was not found.',
        business_goal_not_startable: 'This goal run cannot be started in its current state.',
        business_goal_not_plannable: 'This goal run cannot be planned in its current state.',
        goal_plan_required: 'A confirmed plan is required before starting.',
        goal_planner_unavailable: 'The goal planner is not configured yet.',
        goal_planner_outcome_invalid: 'The planner returned an unsupported outcome.',
        goal_owner_required: 'Only a workspace owner can start guided prospecting.',
        goal_gateway_invalid: 'The goal gateway is not configured correctly.',
      };
      const requestedStatus = Number.isInteger(error?.statusCode) ? error.statusCode
        : Number.isInteger(error?.status) ? error.status : 503;
      const status = requestedStatus >= 400 && requestedStatus < 600 ? requestedStatus : 503;
      const trusted = error?.name === 'AstraTenantContextError' || typeof error?.publicMessage === 'string';
      const message = publicMessages[error?.code] || (trusted ? error.publicMessage || error.message : 'The goal request could not complete. Check the setup and retry.');
      return { status, body: { error: message, ...(typeof error?.code === 'string' ? { code: error.code } : {}) } };
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
    throw Object.assign(new Error('A request key is required for this request.'), { statusCode: 400, code: 'idempotency_key_required' });
  }
  return value;
}

/**
 * Mount the guided business-goal slice. The service carries injected planner
 * and prospecting-service dependencies so the server can assemble the real
 * stack while tests inject fakes.
 */
export async function registerAstraBusinessGoalRoutes(registerAstraApiRoute, {
  service = null, planGoalOnce = null, startGoalOnce = null,
} = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const goals = service || createAstraBusinessGoalService({ planner: null, prospectingService: null });

  route(registerAstraApiRoute, 'GET', '', async (_req, _res, { actor, params, db }) => {
    assertTenant(actor, params);
    return { items: await goals.listGoalRuns(db, actor, {}) };
  }, READ);

  route(registerAstraApiRoute, 'POST', '', async (req, _res, { actor, params, db, readJson, afterCommit }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 16 * 1024);
    const created = await goals.createGoalRun(db, actor, {
      brief: body?.brief, idempotencyKey: idempotencyHeader(req),
    });
    let goal = created;
    if (created.status === 'draft') {
      if (typeof planGoalOnce === 'function') afterCommit(() => planGoalOnce({ tenantId: actor.tenantId, userId: actor.userId, goalId: created.id }));
      else goal = await goals.blockGoalRun(db, actor, created.id, { expectedVersion: created.stateRevision,
        code: 'goal_planner_worker_unavailable', message: 'The guided-goal planning worker is not configured.' });
    }
    const { duplicate: _duplicate, ...publicGoal } = goal;
    return { status: 201, body: { goal: publicGoal } };
  }, WRITE);

  route(registerAstraApiRoute, 'GET', '/(?<goalId>[0-9a-fA-F-]{36})', async (_req, _res, { actor, params, db, afterCommit }) => {
    assertTenant(actor, params);
    const goal = await goals.getGoalRun(db, actor, params.goalId);
    if (goal.status === 'draft' && typeof planGoalOnce === 'function') {
      afterCommit(() => planGoalOnce({ tenantId: actor.tenantId, userId: actor.userId, goalId: goal.id }));
    }
    if (goal.status === 'running' && goal.startRef?.state === 'starting' && typeof startGoalOnce === 'function') {
      afterCommit(() => startGoalOnce({ tenantId: actor.tenantId, userId: actor.userId, goalId: goal.id }));
    }
    return { goal };
  }, READ);

  route(registerAstraApiRoute, 'POST', '/(?<goalId>[0-9a-fA-F-]{36})/answers', async (req, _res, { actor, params, db, readJson, afterCommit }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 32 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['expectedVersion', 'answers'].includes(key))) {
      throw Object.assign(new Error('Only the current revision and answers may be supplied.'), { statusCode: 400, code: 'business_goal_input_invalid' });
    }
    if (typeof planGoalOnce !== 'function') {
      return { status: 503, body: { error: 'The guided-goal planning worker is not configured.', code: 'goal_planner_worker_unavailable' } };
    }
    const goal = await goals.queueAnswerPlan(db, actor, params.goalId, {
      expectedVersion: body?.expectedVersion, answers: body?.answers ?? [],
    });
    afterCommit(() => planGoalOnce({ tenantId: actor.tenantId, userId: actor.userId, goalId: goal.id }));
    return { status: 200, body: { goal } };
  }, WRITE);

  route(registerAstraApiRoute, 'POST', '/(?<goalId>[0-9a-fA-F-]{36})/start', async (req, _res, { actor, params, db, readJson, afterCommit }) => {
    assertTenant(actor, params);
    const body = await readJson(req, 16 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'expectedVersion')) {
      throw Object.assign(new Error('Only the current goal revision may be supplied.'), { statusCode: 400, code: 'business_goal_input_invalid' });
    }
    if (typeof startGoalOnce !== 'function') {
      return { status: 503, body: { error: 'The prospecting start worker is not configured.', code: 'goal_start_worker_unavailable' } };
    }
    const goal = await goals.confirmAndStartGoalRun(db, actor, params.goalId, { expectedVersion: body?.expectedVersion });
    afterCommit(() => startGoalOnce({ tenantId: actor.tenantId, userId: actor.userId, goalId: params.goalId }));
    return { status: 200, body: { goal } };
  }, OWNER);

  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/business-goals',
    'GET /api/astra/tenants/:tenantId/business-goals/:goalId',
    'POST /api/astra/tenants/:tenantId/business-goals/:goalId/answers',
    'POST /api/astra/tenants/:tenantId/business-goals/:goalId/start',
  ] };
}
