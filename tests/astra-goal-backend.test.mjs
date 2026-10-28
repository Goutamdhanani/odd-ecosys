import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FREEINFERENCE_ENDPOINTS, FREEINFERENCE_CANONICAL_MODEL } from '../pipeline/astra-freeinference-client.js';
import { createAstraGoalGateway } from '../pipeline/astra-goal-gateway.js';
import { createAstraGoalPlanner } from '../pipeline/astra-goal-planner.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const USER = '6000000001';
const RUN = '20000000-0000-4000-8000-000000000001';
const validOutput = {
  offerSummary: 'SEO audits', targetIndustry: 'plumbers', country: 'US', city: 'Austin', objective: 'Research public plumbing businesses',
  targetCount: 10, unknownCommercialFacts: ['Pricing not provided'], assumptions: {},
  questions: [{ questionId: 'q-market', question: 'Which customer segment should be prioritized?' }],
};

function ledgerHarness({ cost = 0, status = 'succeeded', responseOutput = validOutput, hang = false, deferred = false,
  duplicateReservation = false, duplicateState = 'running', duplicateAgeMs = 100, deadlineMs = undefined } = {}) {
  const events = [];
  let providerStartedResolve;
  let releaseProvider;
  const providerStarted = new Promise(resolve => { providerStartedResolve = resolve; });
  const tenantStore = { withWorkerTenant: async (actor, callback) => {
    events.push(['transaction-start', actor.tenantId, actor.userId]);
    const result = await callback({ query: async sql => String(sql).includes('FROM astra.ai_usage_requests')
      ? { rows: [{ state: duplicateState, ageMs: duplicateAgeMs }], rowCount: 1 } : { rows: [], rowCount: 0 } });
    events.push(['transaction-commit', actor.tenantId]);
    return result;
  } };
  const usage = {
    assertReceiptReady: async () => true,
    reserve: async (_db, request) => { events.push(['reserve', request.task, request.dataClassification, request.input.goalRunId]); return { id: 'usage-request-1', duplicate: duplicateReservation }; },
    assertDispatch: async () => { events.push(['assert-dispatch']); return true; },
    markStarted: async () => { events.push(['mark-started']); return true; },
    settle: async (_db, tenantId, requestId, receipt) => {
      events.push(['settle', tenantId, requestId, receipt.status, receipt.responseVerified]);
      return { state: status, accountingStatus: status === 'uncertain' ? 'unknown' : 'settled' };
    },
  };
  const env = { ASTRA_GOAL_PLANNER_AUTHORIZED: 'enabled', ASTRA_GOAL_PLANNER_LIVE_AUTHORIZED: 'enabled',
    ASTRA_GLM_LOCAL_PREVIEW: 'false', ASTRA_GLM_EGRESS_ENABLED: 'true', FREEINFERENCE_API_KEY: 'synthetic-test-key' };
  const gateway = createAstraGoalGateway({ env, tenantStore, usage, egressCheck: async input => {
    events.push(['egress-check', input.task, input.dataClassification]);
    if (input.dataClassification !== 'synthetic-fixture') throw Object.assign(new Error('classification denied'), { code: 'ai_data_classification_denied' });
  }, clientFactory: () => ({ complete: async (input, options) => {
    events.push(['provider-call']);
    events.push(['model-prompt', input.messages[1].content]);
    await options.onCheckpoint({ state: 'dispatching' });
    options.onRequestStart();
    const response = { id: 'request-1', provider: 'freeinference', model: FREEINFERENCE_CANONICAL_MODEL,
      endpoint: FREEINFERENCE_ENDPOINTS.chatCompletions, message: { content: JSON.stringify(responseOutput) },
      usage: { inputTokens: 120, outputTokens: 90, reasoningTokens: 0, actualCostMicrousd: cost }, quota: {}, outcome: 'succeeded' };
    if (deferred) {
      providerStartedResolve();
      return new Promise(resolve => { releaseProvider = () => resolve(response); });
    }
    if (hang) return new Promise(() => {});
    return response;
  } }), now: () => new Date('2026-10-28T00:00:00Z'), ...(deadlineMs ? { deadlineMs } : {}) });
  return { gateway, events, providerStarted, releaseProvider: () => releaseProvider?.() };
}

test('goal gateway reserves and settles through committed shared usage transactions before returning a bounded plan', async () => {
  const { gateway, events } = ledgerHarness();
  const outcome = await gateway.plan({ tenantId: TENANT, userId: USER, runId: RUN, brief: 'I sell SEO audits to local plumbers.',
    answers: [], dataClassification: 'synthetic-fixture' });
  assert.equal(outcome.status, 'planned', JSON.stringify(outcome));
  assert.equal(outcome.plan.targetCount, 10);
  assert.deepEqual(outcome.questions, [{ questionId: 'q-market', question: 'Which customer segment should be prioritized?' }]);
  assert.equal(events.filter(event => event[0] === 'reserve').length, 1);
  assert.equal(events.filter(event => event[0] === 'provider-call').length, 1);
  assert.equal(events.filter(event => event[0] === 'settle').length, 1);
  assert.equal(events.find(event => event[0] === 'model-prompt')[1].includes(RUN), false, 'goal UUID stays in durable metadata, not model input');
  assert.ok(events.findIndex(event => event[0] === 'transaction-commit') < events.findIndex(event => event[0] === 'provider-call'),
    'usage reservation transaction commits before provider dispatch');
  assert.ok(events.findIndex(event => event[0] === 'provider-call') < events.findLastIndex(event => event[0] === 'transaction-commit'),
    'provider result is settled in a later committed transaction');
});

test('goal gateway records non-synthetic classification and blocks before any provider call', async () => {
  const { gateway, events } = ledgerHarness();
  const outcome = await gateway.plan({ tenantId: TENANT, userId: USER, runId: RUN, brief: 'Customer goal contains private business facts.',
    answers: [], dataClassification: 'unknown' });
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasons[0].code, 'ai_data_classification_denied');
  assert.equal(events.some(event => event[0] === 'provider-call'), false);
  assert.equal(events.some(event => event[0] === 'reserve'), false);
});

test('goal gateway enforces its provider deadline and keeps timed-out spend uncertain', async () => {
  const { gateway, events } = ledgerHarness({ hang: true, status: 'uncertain', deadlineMs: 20 });
  const outcome = await gateway.plan({ tenantId: TENANT, userId: USER, runId: RUN, brief: 'Synthetic goal.', answers: [], dataClassification: 'synthetic-fixture' });
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.reasons[0].code, 'goal_provider_deadline_exceeded', JSON.stringify(outcome));
  assert.ok(events.some(event => event[0] === 'settle' && event[3] === 'uncertain'));
});

test('overlapping draft polls share one provider dispatch and pending duplicates cannot block the active winner', async () => {
  const { gateway, events, providerStarted, releaseProvider } = ledgerHarness({ deferred: true });
  const input = { tenantId: TENANT, userId: USER, runId: RUN, brief: 'Synthetic goal.', answers: [], dataClassification: 'synthetic-fixture' };
  const winner = gateway.plan(input);
  await providerStarted;
  const duplicatePoll = await gateway.plan(input);
  assert.equal(duplicatePoll.status, 'pending');
  assert.equal(events.filter(event => event[0] === 'provider-call').length, 1);
  releaseProvider();
  const appliedPlan = await winner;
  assert.equal(appliedPlan.status, 'planned');
  const completedDuplicate = await gateway.plan(input);
  assert.equal(completedDuplicate.status, 'planned', 'the brief settled-before-apply window returns the cached plan');
  assert.equal(events.filter(event => event[0] === 'provider-call').length, 1);
});

test('a recent cross-process queued reservation is pending while an old settled duplicate requires reconciliation', async () => {
  const recent = ledgerHarness({ duplicateReservation: true, duplicateState: 'running', duplicateAgeMs: 100 });
  const input = { tenantId: TENANT, userId: USER, runId: RUN, brief: 'Synthetic goal.', answers: [], dataClassification: 'synthetic-fixture' };
  const pending = await recent.gateway.plan(input);
  assert.equal(pending.status, 'pending');
  assert.equal(recent.events.some(event => event[0] === 'provider-call'), false);

  const stale = ledgerHarness({ duplicateReservation: true, duplicateState: 'succeeded', duplicateAgeMs: 120_000 });
  const reconciled = await stale.gateway.plan(input);
  assert.equal(reconciled.status, 'blocked');
  assert.equal(reconciled.reasons[0].code, 'goal_usage_reconciliation_required');
  assert.equal(stale.events.some(event => event[0] === 'provider-call'), false);
});

test('planner deadline aborts a stalled gateway and returns a blocked result', async () => {
  const planner = createAstraGoalPlanner({ env: { ASTRA_GOAL_PLANNER_AUTHORIZED: 'enabled' }, gateway: {
    plan: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('deadline'), { code: 'goal_plan_deadline_exceeded' })), { once: true })),
  }, limits: { stepSeconds: 5 } });
  const result = await planner.plan({ tenantId: TENANT, userId: USER, runId: RUN, brief: 'Bounded goal.', answers: [] });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasons[0].code, 'goal_plan_deadline_exceeded');
});

test('goal plan schema keeps questions and rejects oversized prospecting counts', async () => {
  const { gateway } = ledgerHarness();
  const outcome = await gateway.plan({ tenantId: TENANT, userId: USER, runId: RUN, brief: 'Synthetic.', answers: [], dataClassification: 'synthetic-fixture' });
  assert.equal(outcome.questions.length, 1, `questions survive plan normalization: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.plan.country, 'US');
  const invalid = ledgerHarness({ responseOutput: { ...validOutput, targetCount: 11 } });
  const rejected = await invalid.gateway.plan({ tenantId: TENANT, userId: USER, runId: RUN, brief: 'Synthetic.', answers: [], dataClassification: 'synthetic-fixture' });
  assert.equal(rejected.status, 'blocked');
  assert.equal(rejected.reasons[0].code, 'goal_provider_schema_invalid');
});
