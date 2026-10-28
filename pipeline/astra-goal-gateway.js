import { createHash } from 'node:crypto';
import { assertGlmEgressApproved, minimizeGlmInput, GLM_ACTUAL_MODEL, GLM_ACTUAL_PROVIDER, GLM_ENDPOINT, AstraGlmGatewayError } from './astra-egress.js';
import { FREEINFERENCE_ENDPOINTS, FREEINFERENCE_CANONICAL_MODEL, createFreeInferenceClient } from './astra-freeinference-client.js';
import {
  assertAstraReceiptTelemetryReady, assertAstraUsageDispatchAllowed, markAstraUsageStarted,
  reserveAstraUsage, settleAstraUsage,
} from './astra-usage.js';

const TASK = 'business_goal_planning';
const MAX_OUTPUT_TOKENS = 4096;
const DEADLINE_MS = 45_000;

function failure(code, message, statusCode = 503) {
  const error = new AstraGlmGatewayError(message, code, statusCode);
  return { status: 'blocked', plan: null, questions: [], reasons: [{ code: error.code, message: error.message }] };
}

function normalizePlanOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['offerSummary', 'targetIndustry', 'country', 'city', 'objective', 'targetCount', 'unknownCommercialFacts', 'assumptions', 'questions'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return null;
  const str = (field, limit) => value[field] == null ? null
    : typeof value[field] === 'string' && value[field].trim() && value[field].length <= limit ? value[field].trim() : undefined;
  const offerSummary = str('offerSummary', 500), targetIndustry = str('targetIndustry', 200), country = str('country', 2), city = str('city', 200), objective = str('objective', 500);
  if ([offerSummary, targetIndustry, country, city, objective].includes(undefined)) return null;
  if (country && !/^[A-Za-z]{2}$/.test(country)) return null;
  if (value.targetCount != null && (!Number.isInteger(value.targetCount) || value.targetCount < 1 || value.targetCount > 10)) return null;
  if (value.unknownCommercialFacts != null && (!Array.isArray(value.unknownCommercialFacts) || value.unknownCommercialFacts.length > 30
    || value.unknownCommercialFacts.some(item => typeof item !== 'string' || !item.trim() || item.length > 300))) return null;
  if (value.assumptions != null && (!value.assumptions || typeof value.assumptions !== 'object' || Array.isArray(value.assumptions)
    || Object.keys(value.assumptions).length > 30)) return null;
  const questions = value.questions == null ? [] : value.questions;
  if (!Array.isArray(questions) || questions.length > 3 || questions.some(question => !question || typeof question !== 'object' || Array.isArray(question)
    || Object.keys(question).some(key => !['questionId', 'question'].includes(key))
    || typeof question.questionId !== 'string' || !question.questionId.trim() || question.questionId.length > 160
    || typeof question.question !== 'string' || !question.question.trim() || question.question.length > 500)) return null;
  if (new Set(questions.map(question => question.questionId)).size !== questions.length) return null;
  if ((!targetIndustry || !country || !objective || value.targetCount == null) && questions.length === 0) return null;
  return {
    plan: {
      offerSummary, targetIndustry, country: country?.toUpperCase() ?? null, city, objective,
      targetCount: value.targetCount ?? null, unknownCommercialFacts: value.unknownCommercialFacts ?? [], assumptions: value.assumptions ?? {},
    },
    questions: questions.map(({ questionId, question }) => ({ questionId: questionId.trim(), question: question.trim() })),
  };
}

function validIdentity(result) {
  return result?.provider === GLM_ACTUAL_PROVIDER && result?.model === GLM_ACTUAL_MODEL
    && result?.endpoint === GLM_ENDPOINT && GLM_ACTUAL_MODEL === FREEINFERENCE_CANONICAL_MODEL;
}

/**
 * GLM gateway with the canonical tenant/global usage ledger. A reservation is
 * committed before dispatch and settlement is committed after the response;
 * unknown spend remains reserved. No direct provider call is made when any
 * authority, classification, storage, or budget gate is unavailable.
 */
export function createAstraGoalGateway({
  env = process.env,
  tenantStore = null,
  clientFactory = createFreeInferenceClient,
  egressCheck = assertGlmEgressApproved,
  usage = { reserve: reserveAstraUsage, assertDispatch: assertAstraUsageDispatchAllowed, markStarted: markAstraUsageStarted, settle: settleAstraUsage, assertReceiptReady: assertAstraReceiptTelemetryReady },
  now = () => new Date(),
  deadlineMs = DEADLINE_MS,
} = {}) {
  const digest = value => createHash('sha256').update(value).digest('hex');
  const blocked = (code, message) => failure(code, message);
  const inFlight = new Set();
  const recentResults = new Map();
  const pending = usageRequestId => ({ status: 'pending', plan: null, questions: [], reasons: [],
    receipt: { usageRequestId, pending: true } });

  function planKey({ tenantId, runId, brief, answers = [] } = {}) {
    if (!tenantId || !runId || typeof brief !== 'string' || !Array.isArray(answers)) return null;
    const boundedAnswers = answers.map(answer => ({ questionId: answer?.questionId, answer: answer?.answer }));
    return `${tenantId}:${runId}:${digest(JSON.stringify({ brief, answers: boundedAnswers }))}`;
  }

  function status() {
    const reasons = [];
    if (env.ASTRA_GOAL_PLANNER_AUTHORIZED !== 'enabled') reasons.push({ code: 'goal_planner_authority_disabled', message: 'Server-side goal planner authority is not enabled.' });
    if (env.ASTRA_GOAL_PLANNER_LIVE_AUTHORIZED !== 'enabled') reasons.push({ code: 'goal_provider_authority_disabled', message: 'Server-side GLM goal-provider authority is not enabled.' });
    if (env.ASTRA_GLM_LOCAL_PREVIEW !== 'false') reasons.push({ code: 'glm_local_preview_egress_denied', message: 'GLM egress is disabled in the local preview.' });
    if (env.ASTRA_GLM_EGRESS_ENABLED !== 'true') reasons.push({ code: 'glm_egress_disabled', message: 'GLM provider egress is disabled by the application gate.' });
    if (!env.FREEINFERENCE_API_KEY?.trim()) reasons.push({ code: 'goal_provider_unconfigured', message: 'FREEINFERENCE_API_KEY is not configured.' });
    if (!tenantStore || typeof tenantStore.withWorkerTenant !== 'function') reasons.push({ code: 'goal_usage_store_unavailable', message: 'Tenant-scoped durable usage accounting is unavailable.' });
    return { configured: reasons.length === 0, reasons };
  }

  async function executePlan({ tenantId, userId, runId, brief, answers = [], dataClassification = 'unknown', signal = null }) {
      if (!tenantId || !userId || !runId || typeof brief !== 'string' || !brief.trim() || brief.length > 4000) {
        return blocked('goal_input_invalid', 'A tenant-scoped goal and bounded brief are required.');
      }
      const gate = status();
      if (!gate.configured) return { status: 'blocked', plan: null, questions: [], reasons: gate.reasons };
      if (!Array.isArray(answers) || answers.length > 100) return blocked('goal_input_invalid', 'Answers must be a bounded array.');
      if (answers.some(answer => !answer || typeof answer !== 'object' || typeof answer.questionId !== 'string'
        || typeof answer.answer !== 'string' || answer.questionId.length > 160 || answer.answer.length > 2000)) {
        return blocked('goal_input_invalid', 'Answers must contain bounded question IDs and text.');
      }
      let modelInput;
      try {
        modelInput = minimizeGlmInput({ brief, answers: answers.map(answer => ({ questionId: answer.questionId, answer: answer.answer })) }, dataClassification);
      } catch {
        return blocked('goal_input_minimization_required', 'Goal planning input contains content that cannot be sent to the approved model.');
      }
      const usageInput = { goalRunId: runId, ...modelInput };
      const inputBytes = Buffer.byteLength(JSON.stringify(modelInput), 'utf8');
      if (inputBytes > 32 * 1024) return blocked('goal_input_too_large', 'The goal and answers exceed the bounded planning input size.');
      const usageInputTokens = Math.min(128_000, Buffer.byteLength(JSON.stringify(usageInput), 'utf8') + 1024);
      const systemPrompt = [
        'Structure a B2B prospecting plan from the customer goal. Reply with only one JSON object.',
        'Allowed fields: offerSummary, targetIndustry, country (2-letter ISO code), city, objective, targetCount (integer 1-10), unknownCommercialFacts (string array), assumptions (object), questions (at most 3 items with questionId and question).',
        'Never invent prices, revenue, performance metrics, personal names, emails, or unverified facts. Unknown commercial facts must remain unknown and be asked as questions where useful.',
        'Do not infer or fabricate source-use rights. Keep the plan focused on public business prospecting.',
      ].join('\n');
      const userPrompt = JSON.stringify(modelInput);
      const idempotencyKey = `goal-plan:${runId}:${digest(JSON.stringify({ brief, answers: modelInput.answers })).slice(0, 40)}`;
      let reservation = null;
      let attempted = false;
      let result = null;
      let providerError = null;
      let receiptTelemetryReady = false;
      try {
        await egressCheck({ task: TASK, dataClassification, gateId: 'glm-api-inference', now: now() });
        reservation = await tenantStore.withWorkerTenant({ tenantId, userId: String(userId) }, async db => {
          receiptTelemetryReady = await usage.assertReceiptReady(db, 'ai_usage_requests');
          if (!receiptTelemetryReady) throw Object.assign(new Error('Provider receipt migration 034 is required before goal planning.'), { code: 'ai_receipt_schema_unavailable' });
          return usage.reserve(db, { tenantId, task: TASK, idempotencyKey, input: usageInput, dataClassification,
            maxInputTokens: usageInputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS });
        });
        if (reservation.duplicate) {
          const prior = await tenantStore.withWorkerTenant({ tenantId, userId: String(userId) }, db => db.query(`
            SELECT state, (extract(epoch FROM (clock_timestamp()-created_at))*1000)::bigint AS "ageMs"
            FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, reservation.id]));
          const state = prior.rows[0]?.state;
          const ageMs = Number(prior.rows[0]?.ageMs);
          const recoverableWindow = deadlineMs * 2;
          if (['queued', 'running'].includes(state) && Number.isFinite(ageMs) && ageMs <= recoverableWindow) return pending(reservation.id);
          // A successful reservation may be between settlement and goal CAS.
          // Give that active worker time to persist its result before requiring
          // operator reconciliation for output that is no longer recoverable.
          if (state === 'succeeded' && Number.isFinite(ageMs) && ageMs <= recoverableWindow) return pending(reservation.id);
          return blocked('goal_usage_reconciliation_required', 'A prior planning request has a durable usage record but no recoverable plan output. Reconcile the saved provider receipt before planning again.');
        }
        const client = clientFactory({ env, timeoutMs: deadlineMs, maxRetries: 0 });
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) controller.abort(signal.reason);
        else signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('goal_provider_deadline')), deadlineMs);
        let timedOut = false;
        const abortPromise = new Promise((_, reject) => {
          const onAbortController = () => {
            timedOut = !signal?.aborted;
            reject(Object.assign(new Error(timedOut ? 'Goal provider request exceeded its deadline.' : 'Goal provider request was aborted.'), {
              code: timedOut ? 'goal_provider_deadline_exceeded' : 'goal_provider_aborted', uncertain: attempted,
            }));
          };
          if (controller.signal.aborted) onAbortController();
          else controller.signal.addEventListener('abort', onAbortController, { once: true });
        });
        try {
          result = await Promise.race([client.complete({
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            response_format: { type: 'json_object' }, max_tokens: MAX_OUTPUT_TOKENS,
            reasoning_effort: 'low', temperature: 0.2, stream: false,
          }, {
            signal: controller.signal, idempotencyKey,
            onCheckpoint: async checkpoint => {
              if (checkpoint?.state !== 'dispatching') return;
              await egressCheck({ task: TASK, dataClassification, gateId: 'glm-api-inference', now: now() });
              await tenantStore.withWorkerTenant({ tenantId, userId: String(userId) }, async db => {
                await usage.assertDispatch(db, tenantId, reservation.id, TASK);
                if (!await usage.markStarted(db, tenantId, reservation.id)) throw Object.assign(new Error('The durable goal request is no longer queued.'), { code: 'ai_request_unavailable' });
              });
            },
            onRequestStart: () => { attempted = true; },
          }), abortPromise]);
        } catch (error) {
          providerError = error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
        const verified = validIdentity(result) && result?.outcome === 'succeeded';
        const usageReceipt = result?.usage || {};
        const responseCost = Number.isSafeInteger(usageReceipt.actualCostMicrousd) && usageReceipt.actualCostMicrousd >= 0
          ? usageReceipt.actualCostMicrousd : null;
        const settlementStatus = providerError ? attempted ? (providerError?.uncertain === false ? 'failed' : 'uncertain') : 'failed'
          : verified ? 'succeeded' : 'uncertain';
        const settlement = await tenantStore.withWorkerTenant({ tenantId, userId: String(userId) }, db => usage.settle(db, tenantId, reservation.id, {
          status: settlementStatus, inputTokens: usageReceipt.inputTokens ?? null, outputTokens: usageReceipt.outputTokens ?? null,
          reasoningTokens: usageReceipt.reasoningTokens ?? null, providerRequestId: result?.id || null,
          actualProvider: verified ? result.provider : null, actualModel: verified ? result.model : null,
          providerQuota: result?.quota || null, responseVerified: verified,
          actualCostMicrousd: verified ? responseCost : null,
          actualCostSource: verified && responseCost !== null ? 'provider_usage.cost_microusd' : null,
          errorCode: providerError?.code || (!verified ? 'goal_provider_identity_unverified' : null),
          receiptTelemetryReady,
        }));
        if (!settlement || settlement.state === 'uncertain') {
          return blocked(providerError?.code || 'goal_usage_uncertain', 'The provider result or billing could not be verified. The reservation remains held and this request will not be retried automatically.');
        }
        if (providerError) return blocked(providerError?.code || 'goal_provider_call_failed', 'The authorized GLM request failed before it returned a usable plan.');
        if (!verified) return blocked('goal_provider_identity_unverified', 'The provider identity or endpoint did not match the approved GLM target.');
        if (!result?.message || typeof result.message.content !== 'string' || !result.message.content.trim()) return blocked('goal_provider_empty', 'The goal provider returned no content.');
        let parsed;
        try { parsed = JSON.parse(result.message.content); }
        catch { return blocked('goal_provider_invalid_json', 'The goal provider returned unparseable JSON.'); }
        if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 16 * 1024) return blocked('goal_provider_schema_invalid', 'The goal provider returned a plan outside the bounded schema.');
        let safeOutput;
        try { safeOutput = minimizeGlmInput(parsed, dataClassification); }
        catch { return blocked('goal_provider_schema_invalid', 'The goal provider returned a plan outside the bounded schema.'); }
        const normalized = normalizePlanOutput(safeOutput);
        if (!normalized) return blocked('goal_provider_schema_invalid', 'The goal provider returned a plan outside the bounded schema.');
        return { status: 'planned', plan: normalized.plan, questions: normalized.questions,
          receipt: { provider: result.provider, model: result.model, requestId: result.id || null, usageRequestId: reservation.id,
            accountingStatus: settlement.accountingStatus } };
      } catch (error) {
        if (reservation && !attempted) {
          try {
            await tenantStore.withWorkerTenant({ tenantId, userId: String(userId) }, db => usage.settle(db, tenantId, reservation.id, {
              status: 'failed', errorCode: error?.code || 'goal_provider_not_dispatched', receiptTelemetryReady,
            }));
          } catch { /* unresolved queued reservations remain visible in the shared ledger */ }
        }
        const code = /^[a-z0-9_.:-]{1,64}$/i.test(String(error?.code || '')) ? String(error.code) : 'goal_gateway_call_failed';
        const message = typeof error?.message === 'string' && error.message.length <= 240 ? error.message : 'The goal gateway call failed.';
        return blocked(code, message);
      }
  }

  return {
    status,
    async plan(input = {}) {
      const key = planKey(input);
      if (!key) return executePlan(input);
      const cached = recentResults.get(key);
      if (cached) return cached;
      if (inFlight.has(key)) return pending(null);
      inFlight.add(key);
      try {
        const outcome = await executePlan(input);
        if (outcome?.status === 'planned') {
          recentResults.set(key, outcome);
          while (recentResults.size > 128) recentResults.delete(recentResults.keys().next().value);
        }
        return outcome;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
