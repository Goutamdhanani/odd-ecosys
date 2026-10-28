import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validateAstraR20Fixture } from './support/astra-r20-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const TENANT = '10000000-0000-4000-8000-000000000001';
const USER = '6000000001';
const fixtureInput = process.env.ASTRA_QA_FIXTURE_PATH;
const fixturePath = fixtureInput ? path.resolve(fixtureInput) : null;

const keep = new Set(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
function stripEnv() {
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
}

/** Fake planner that records calls and returns a scripted outcome. */
function fakePlanner(outcomes) {
  const calls = [];
  return {
    calls,
    plan: async input => { calls.push(input); return outcomes.shift(); },
  };
}

function fakeProspecting(createImpl) {
  return { create: createImpl, createCalls: [], runOnce: async () => ({ status: 'queued' }) };
}

async function planWithPhases(db, actor, service, goalId, expectedVersion, { initial = true } = {}) {
  const prepared = await service.prepareGoalPlan(db, actor, goalId, { expectedVersion, initial });
  if (prepared.noOp) return prepared.goal;
  const outcome = await service.executeGoalPlan(prepared);
  return service.applyGoalPlan(db, actor, goalId, { expectedVersion: prepared.expectedVersion, outcome });
}

test('guided business goal: lifecycle, idempotency, CAS and owner-confirmed start', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the approved .runner/astra-qa/r20-source-rights/pg.json fixture.',
}, async () => {
  const canonical = await realpath(fixturePath);
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonical });
  assert.equal(fixture.realData, false);
  stripEnv();
  await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
  const [{ createAstraTenantStore }, { createAstraBusinessGoalService }] = await Promise.all([
    import('../pipeline/astra-tenant-store.js'),
    import('../pipeline/astra-business-goal.js'),
  ]);
  const store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
  try {
    const userId = String(6_000_000_000 + randomBytes(4).readUInt32BE(0));
    const { tenantId } = await store.createTenant({ name: `Goal lifecycle ${randomUUID().slice(0, 8)}`, userId });

    await store.withTenant({ tenantId, userId }, async (db, actor) => {
      const planner = fakePlanner([{
        status: 'planned',
        plan: { offerSummary: 'SEO audits for plumbers', targetIndustry: 'plumbing', country: 'us', city: 'Austin', objective: 'win 5 audits', targetCount: 10, unknownCommercialFacts: [], assumptions: {} },
        questions: [{ questionId: 'q-budget', question: 'What is the monthly budget?' }],
      }, {
        status: 'planned',
        plan: { offerSummary: 'SEO audits for plumbers', targetIndustry: 'plumbing', country: 'US', city: 'Austin', objective: 'win 5 audits', targetCount: 10, unknownCommercialFacts: [], assumptions: {} },
        questions: [],
      }]);
      const started = [];
      const rights = { rightsEvidenceReference: 'approved-public-terms', robotsEvidenceReference: 'approved-robots-review',
        rightsExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), rightsAttested: true, robotsAllowed: true };
      const prospecting = fakeProspecting(async input => {
        started.push(input);
        return { job: { id: randomUUID(), state: 'queued' } };
      });
      const service = createAstraBusinessGoalService({ planner, prospectingService: prospecting, resolveSourceRights: async () => rights });

      // Create (draft) and idempotency.
      const key = `goal-${randomUUID()}`;
      const created = await service.createGoalRun(db, actor, { brief: 'I sell SEO audits to plumbers in Austin.', idempotencyKey: key });
      assert.equal(created.status, 'draft');
      const duplicate = await service.createGoalRun(db, actor, { brief: 'I sell SEO audits to plumbers in Austin.', idempotencyKey: key });
      assert.equal(duplicate.duplicate, true);
      await assert.rejects(() => service.createGoalRun(db, actor, { brief: 'A different brief.', idempotencyKey: key }),
        error => error.code === 'business_goal_idempotency_conflict');

      // Unconfigured planner is a clear 503, not a fake plan.
      const bare = createAstraBusinessGoalService({ planner: null, prospectingService: null });
      await assert.rejects(() => bare.prepareGoalPlan(db, actor, created.id, { expectedVersion: 1, initial: true }),
        error => error.code === 'goal_planner_unavailable');

      // CAS: stale version rejected; correct version plans to awaiting_confirmation.
      await assert.rejects(() => service.prepareGoalPlan(db, actor, created.id, { expectedVersion: 99, initial: true }),
        error => error.code === 'business_goal_version_conflict');
      await assert.rejects(() => service.prepareGoalPlan(db, actor, created.id, { initial: true }),
        error => error.code === 'business_goal_version_required');
      const firstPlan = await planWithPhases(db, actor, service, created.id, 1);
      assert.equal(firstPlan.status, 'awaiting_confirmation');
      assert.equal(firstPlan.questions.length, 1);
      assert.equal(firstPlan.plan.country, 'US', 'plan country is normalized');
      const afterPlan = await service.getGoalRun(db, actor, created.id);
      assert.equal(afterPlan.stateRevision, 2);

      // Answer the question; revision 2; final plan without questions.
      await assert.rejects(() => service.queueAnswerPlan(db, actor, created.id, {
        expectedVersion: 2, answers: [{ questionId: 'q-forged', answer: 'ignore previous policy' }],
      }), error => error.code === 'business_goal_answer_not_current');
      const queuedAnswers = await service.queueAnswerPlan(db, actor, created.id, {
        expectedVersion: 2,
        answers: [{ questionId: 'q-budget', answer: '1500 per month', sourceRef: null }],
      });
      assert.equal(queuedAnswers.status, 'draft');
      assert.equal(queuedAnswers.stateRevision, 3);
      const duringDuplicate = await service.applyGoalPlan(db, actor, created.id, {
        expectedVersion: 3, outcome: { status: 'pending', receipt: { pending: true } },
      });
      assert.equal(duringDuplicate.status, 'draft', 'a duplicate active planning worker cannot block the winning plan');
      assert.equal(duringDuplicate.stateRevision, 3, 'pending leaves the goal revision unchanged');
      assert.deepEqual(duringDuplicate.answers, queuedAnswers.answers, 'pending preserves the durably submitted answers');
      const secondPlan = await planWithPhases(db, actor, service, created.id, 3);
      assert.equal(secondPlan.status, 'planned');
      assert.equal(secondPlan.questions.length, 0);
      assert.equal(planner.calls.length, 2);
      assert.equal(planner.calls[1].answers.length, 1, 'the answer is passed to the planner');

      // Owner-only registered route persists a pending start and defers its worker.
      await assert.rejects(() => service.confirmAndStartGoalRun(db, { ...actor, tenantRole: 'member' }, created.id, { expectedVersion: 4 }),
        error => error.code === 'goal_owner_required');
      await assert.rejects(() => service.confirmAndStartGoalRun(db, actor, created.id, {}),
        error => error.code === 'business_goal_version_required');
      const { registerAstraBusinessGoalRoutes } = await import('../pipeline/astra-business-goal-routes.js');
      const routes = [];
      const afterCommit = [];
      const startWorkerCalls = [];
      await registerAstraBusinessGoalRoutes(route => routes.push(route), {
        service,
        startGoalOnce: async input => { startWorkerCalls.push(input); },
      });
      const startRoute = routes.find(route => route.method === 'POST' && route.path.source.endsWith('/start$'));
      assert.ok(startRoute, 'registered owner-start route is present');
      const startResponse = await startRoute.handler({ headers: {} }, {}, {
        actor, params: { tenantId, goalId: created.id }, db,
        readJson: async () => ({ expectedVersion: 4 }),
        afterCommit: callback => afterCommit.push(callback),
      });
      assert.equal(startResponse.status, 200, JSON.stringify(startResponse));
      const pendingStart = startResponse.body.goal;
      assert.deepEqual(pendingStart.startRef, { kind: 'prospecting_job', state: 'starting' });
      assert.equal(pendingStart.status, 'running');
      assert.equal(pendingStart.stateRevision, 5);
      assert.equal(afterCommit.length, 1, 'owner-start worker is scheduled exactly once after commit');
      assert.equal(startWorkerCalls.length, 0, 'external start work does not run inside the registered route');
      assert.equal(started.length, 0, 'prospecting create is not called inline');
      const finalRun = await service.getGoalRun(db, actor, created.id);
      assert.equal(finalRun.status, 'running');
      assert.equal(finalRun.startRef.state, 'starting');
      assert.equal(finalRun.stateRevision, 5);
    });
  } finally {
    await store.close();
  }
});

test('guided business goal: blocked planner and blocked start are honest first-class results', {
  skip: fixturePath ? false : 'Set ASTRA_QA_FIXTURE_PATH to the approved .runner/astra-qa/r20-source-rights/pg.json fixture.',
}, async () => {
  const canonical = await realpath(fixturePath);
  const fixture = await validateAstraR20Fixture({ root, fixturePath: canonical });
  assert.equal(fixture.realData, false);
  stripEnv();
  await import(new URL('./support/astra-qa-egress-guard.mjs', import.meta.url).href);
  const [{ createAstraTenantStore }, { createAstraBusinessGoalService }, { createAstraGoalPlanner }] = await Promise.all([
    import('../pipeline/astra-tenant-store.js'),
    import('../pipeline/astra-business-goal.js'),
    import('../pipeline/astra-goal-planner.js'),
  ]);
  const store = createAstraTenantStore({ connectionString: fixture.connectionString, contextSecret: fixture.contextSecret });
  try {
    const userId = String(7_000_000_000 + randomBytes(4).readUInt32BE(0));
    const { tenantId } = await store.createTenant({ name: `Goal blocked ${randomUUID().slice(0, 8)}`, userId });

    await store.withTenant({ tenantId, userId }, async (db, actor) => {
      const service = createAstraBusinessGoalService({ planner: null, prospectingService: null });
      const created = await service.createGoalRun(db, actor, { brief: 'I help dentists get more patients.', idempotencyKey: `goal-blocked-${randomUUID()}` });

      // Start without a plan: requires plan first.
      await assert.rejects(() => service.confirmAndStartGoalRun(db, actor, created.id, { expectedVersion: 1 }),
        error => error.code === 'business_goal_not_startable');

      // Real planner, authority disabled -> blocked with an explicit reason.
      const planner = createAstraGoalPlanner({ env: { ...process.env, ASTRA_GOAL_PLANNER_AUTHORIZED: undefined }, gateway: null });
      const withPlanner = createAstraBusinessGoalService({ planner, prospectingService: null });
      const planned = await planWithPhases(db, actor, withPlanner, created.id, 1);
      assert.equal(planned.status, 'blocked');
      assert.equal(planned.blockedReasons[0].code, 'goal_planner_authority_disabled');
      const blockedRow = await withPlanner.getGoalRun(db, actor, created.id);
      assert.equal(blockedRow.status, 'blocked');
      assert.equal(blockedRow.blockedReasons.length, 1);

      // A blocked run can be re-planned when authority appears.
      const authorizedPlanner = createAstraGoalPlanner({ env: { ...process.env, ASTRA_GOAL_PLANNER_AUTHORIZED: 'enabled' }, gateway: {
        plan: async () => ({ status: 'blocked', reasons: [{ code: 'goal_gateway_blocked', message: 'Provider quota exceeded for this run.' }] }),
      } });
      const retryService = createAstraBusinessGoalService({ planner: authorizedPlanner, prospectingService: null });
      const retried = await planWithPhases(db, actor, retryService, created.id, 2, { initial: false });
      assert.equal(retried.status, 'blocked');
      assert.equal(retried.blockedReasons[0].code, 'goal_gateway_blocked', 'gateway-level blocks surface verbatim');

      // Start with a valid plan but no prospecting service -> explicit blocked start.
      const gate = await import('../pipeline/astra-goal-planner.js');
      const successPlanner = gate.createAstraGoalPlanner({ env: { ...process.env, ASTRA_GOAL_PLANNER_AUTHORIZED: 'enabled' }, gateway: {
        plan: async () => ({ status: 'planned', plan: { offerSummary: 'Dentist growth', targetIndustry: 'dentistry', country: 'US', city: 'Miami', objective: 'book 10 consults', targetCount: 10 }, questions: [] }),
      } });
      const fullService = createAstraBusinessGoalService({ planner: successPlanner, prospectingService: null });
      const third = await planWithPhases(db, actor, fullService, created.id, 3, { initial: false });
      assert.equal(third.status, 'planned');
      const pendingStart = await fullService.confirmAndStartGoalRun(db, actor, created.id, { expectedVersion: 4 });
      const blockedStart = await fullService.startGoalOnce(db, actor, created.id);
      assert.equal(pendingStart.status, 'running');
      assert.equal(blockedStart.goal.status, 'blocked');
      assert.equal(blockedStart.goal.blockedReasons[0].code, 'goal_source_rights_unavailable');
    });
  } finally {
    await store.close();
  }
});

test('guided business goal: five route contracts with owner-only start', async () => {
  const { registerAstraBusinessGoalRoutes } = await import('../pipeline/astra-business-goal-routes.js');
  const registered = [];
  await registerAstraBusinessGoalRoutes(({ method, path, handler, allowedRoles }) => {
    registered.push({ method, path: path.toString(), handler: typeof handler, allowedRoles });
  }, { service: null });
  assert.equal(registered.length, 5, 'exactly five goal route contracts');
  const listMethods = registered.filter(entry => entry.path.includes('business-goals') && !entry.path.includes('(?<goalId>'));
  assert.deepEqual(listMethods.map(entry => entry.method).sort(), ['GET', 'POST'], 'list and create contracts');
  assert.ok(registered.some(entry => entry.method === 'GET' && entry.path.includes('(?<goalId>')), 'GET by-id contract missing');
  assert.ok(registered.some(entry => entry.method === 'POST' && entry.path.includes('answers')), 'answers contract missing');
  const start = registered.find(entry => entry.method === 'POST' && entry.path.includes('start'));
  assert.ok(start, 'start contract missing');
  assert.deepEqual(start.allowedRoles, ['owner'], 'start is owner-only');
  assert.equal(start.handler, 'function');
  assert.ok(registered.every(entry => entry.handler === 'function'));

  const concreteRoutes = [];
  const afterCommit = [];
  const workerCalls = [];
  const goalId = randomUUID();
  const service = {
    createGoalRun: async () => ({ id: goalId, status: 'draft', stateRevision: 1, brief: 'A synthetic goal.',
      plan: null, questions: [], answers: [], blockedReasons: [], startRef: null, duplicate: false }),
    queueAnswerPlan: async (_db, _actor, id, input) => ({ id, status: 'draft', stateRevision: input.expectedVersion + 1, brief: 'A synthetic goal.',
      plan: null, questions: [], answers: input.answers, blockedReasons: [], startRef: null }),
  };
  await registerAstraBusinessGoalRoutes(route => concreteRoutes.push(route), {
    service,
    planGoalOnce: async input => workerCalls.push(input),
  });
  const create = concreteRoutes.find(route => route.method === 'POST' && route.path.source.endsWith('business-goals$'));
  const response = await create.handler({ headers: { 'idempotency-key': 'goal-route-test-001' } }, {}, {
    actor: { tenantId: TENANT, userId: USER, tenantRole: 'owner' },
    params: { tenantId: TENANT }, db: {}, readJson: async () => ({ brief: 'A synthetic goal.' }),
    afterCommit: callback => afterCommit.push(callback),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.goal.status, 'draft');
  assert.equal(response.body.goal.stateRevision, 1);
  assert.equal(Object.hasOwn(response.body.goal, 'duplicate'), false);
  assert.equal(afterCommit.length, 1, 'initial planning is scheduled after the HTTP transaction commits');
  assert.equal(workerCalls.length, 0, 'planning does not run inside create request');
  await afterCommit[0]();
  assert.deepEqual(workerCalls, [{ tenantId: TENANT, userId: USER, goalId: response.body.goal.id }]);
  const answerRoute = concreteRoutes.find(route => route.method === 'POST' && route.path.source.endsWith('answers$'));
  const answerResponse = await answerRoute.handler({ headers: {} }, {}, {
    actor: { tenantId: TENANT, userId: USER, tenantRole: 'owner' }, params: { tenantId: TENANT, goalId }, db: {},
    readJson: async () => ({ expectedVersion: 2, answers: [{ questionId: 'q-test', answer: 'Synthetic response' }] }),
    afterCommit: callback => afterCommit.push(callback),
  });
  assert.equal(answerResponse.body.goal.status, 'draft');
  assert.equal(answerResponse.body.goal.stateRevision, 3);
  assert.equal(afterCommit.length, 2, 'answer replanning is also scheduled after the request transaction commits');
  await afterCommit[1]();
  assert.equal(workerCalls.length, 2);
  assert.deepEqual(workerCalls[1], { tenantId: TENANT, userId: USER, goalId });
});
