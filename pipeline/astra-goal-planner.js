import { randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';

/** One provider step per invocation, bounded by an enforced abort deadline. */
export function createAstraGoalPlanner({
  env = process.env,
  gateway = null,
  limits = { stepSeconds: 60 },
  now = () => new Date(),
} = {}) {
  const stepSeconds = Number.isInteger(limits?.stepSeconds) ? Math.max(5, Math.min(limits.stepSeconds, 300)) : 60;

  if (gateway && typeof gateway.plan !== 'function') {
    throw new AstraTenantContextError('Goal gateway must expose plan().', 503, 'goal_gateway_invalid');
  }

  function blocked(reasons, receipt = { blocked: true }) {
    return { status: 'blocked', plan: null, questions: [], reasons, receipt };
  }

  return {
    async plan({ tenantId, userId, runId, brief, answers = [], dataClassification = 'unknown', signal = null }) {
      if (!tenantId || !userId || !runId || typeof brief !== 'string' || !brief.trim() || brief.length > 4000) {
        throw new AstraTenantContextError('A tenant-scoped goal and bounded brief are required.', 400, 'goal_input_invalid');
      }
      if (!Array.isArray(answers) || answers.length > 100) {
        throw new AstraTenantContextError('Answers must be a bounded array.', 400, 'goal_input_invalid');
      }
      if (env.ASTRA_GOAL_PLANNER_AUTHORIZED !== 'enabled') {
        return blocked([{ code: 'goal_planner_authority_disabled', message: 'Server-side goal planner authority is not enabled.' }]);
      }
      if (!gateway) {
        return blocked([{ code: 'goal_gateway_unavailable', message: 'The GLM goal gateway is not configured.' }]);
      }
      const deadline = now().valueOf() + stepSeconds * 1000;
      const controller = new AbortController();
      let externalAbort;
      if (signal?.aborted) controller.abort(signal.reason);
      else if (signal) {
        externalAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', externalAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new Error('goal_step_deadline')), stepSeconds * 1000);
      let timedOut = false;
      const timeout = new Promise((_, reject) => {
        const abort = () => {
          if (!signal?.aborted) timedOut = true;
          reject(new AstraTenantContextError(timedOut ? 'Goal planning exceeded its deadline.' : 'Goal planning was aborted.',
            timedOut ? 504 : 409, timedOut ? 'goal_plan_deadline_exceeded' : 'goal_plan_aborted'));
        };
        if (controller.signal.aborted) abort();
        else controller.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const response = await Promise.race([
          gateway.plan({ tenantId, userId, runId, brief, answers, dataClassification, signal: controller.signal }),
          timeout,
        ]);
        if (controller.signal.aborted) return blocked([{ code: 'goal_plan_request_aborted', message: 'Goal planning was aborted.' }]);
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          return blocked([{ code: 'goal_gateway_outcome_invalid', message: 'The goal gateway returned an unsupported outcome.' }]);
        }
        if (response.status === 'pending') {
          return { status: 'pending', plan: null, questions: [], reasons: [], receipt: response.receipt || { pending: true } };
        }
        if (response.status === 'blocked') {
          return blocked(Array.isArray(response.reasons) ? response.reasons : [{ code: 'goal_gateway_blocked', message: 'The goal gateway is blocked.' }], response.receipt);
        }
        if (response.status !== 'planned' || !response.plan || !Array.isArray(response.questions) || response.questions.length > 3) {
          return blocked([{ code: 'goal_gateway_outcome_invalid', message: 'The goal gateway returned an unsupported outcome.' }]);
        }
        const receipt = { ...(response.receipt || {}), stepId: randomUUID(), deadlineAt: new Date(deadline).toISOString() };
        return { status: 'planned', plan: response.plan, questions: response.questions, receipt };
      } catch (error) {
        const code = /^[a-z0-9_.:-]{1,64}$/i.test(String(error?.code || '')) ? String(error.code) : 'goal_gateway_call_failed';
        const message = typeof error?.message === 'string' && error.message.length <= 240 ? error.message : 'The goal gateway call failed.';
        return blocked([{ code, message }]);
      } finally {
        clearTimeout(timer);
        if (signal && externalAbort) signal.removeEventListener('abort', externalAbort);
      }
    },
  };
}
