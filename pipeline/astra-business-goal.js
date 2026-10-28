import { randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { canonicalJson, sha256 } from './astra-ledger.js';

const fail = (message, status = 400, code = 'business_goal_invalid') => { throw new AstraTenantContextError(message, status, code); };
const isObj = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max = 4000, { optional = false } = {}) => {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${name} is required and must be bounded printable text.`);
  }
  return value.trim();
};
const uuid = (value, name, required = true) => {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || ! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(`${name} must be a UUID.`);
  }
  return value.toLowerCase();
};
const array = (value, name, max = 100) => {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be a bounded array.`);
  return value;
};
const hash = value => sha256(canonicalJson(value));

const STATUS_FLOW = Object.freeze({
  draft: new Set(['blocked', 'failed']),
  planned: new Set(['awaiting_confirmation', 'running', 'blocked', 'failed']),
  awaiting_confirmation: new Set(['running', 'blocked', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed']),
  blocked: new Set(['draft', 'planned', 'awaiting_confirmation', 'cancelled']),
  failed: new Set([]),
  cancelled: new Set([]),
});

function normalizeAnswer(value, index) {
  const allowed = ['questionId', 'answer', 'sourceRef'];
  if (!isObj(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`answers[${index}] contains unsupported fields.`);
  const questionId = text(value.questionId, `answers[${index}].questionId`, 160);
  const answer = text(value.answer, `answers[${index}].answer`, 2000);
  const sourceRef = value.sourceRef == null ? null : text(value.sourceRef, `answers[${index}].sourceRef`, 500);
  return { questionId, answer, sourceRef };
}

function normalizePlan(value) {
  if (!isObj(value)) fail('Plan must be an object.');
  const allowed = ['offerSummary', 'targetIndustry', 'country', 'city', 'objective', 'targetCount', 'unknownCommercialFacts', 'assumptions'];
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Plan contains unsupported fields.');
  const boundedText = (field, name, max = 500) => (value[field] == null ? null : text(value[field], `plan.${name}`, max));
  if (value.targetCount != null && (!Number.isInteger(value.targetCount) || value.targetCount < 1 || value.targetCount > 10)) {
    fail('plan.targetCount must be between 1 and 10 for the current prospecting source budget.');
  }
  if (value.unknownCommercialFacts != null && (!Array.isArray(value.unknownCommercialFacts) || value.unknownCommercialFacts.length > 30
    || value.unknownCommercialFacts.some(item => typeof item !== 'string' || !item.trim() || item.length > 300))) fail('plan.unknownCommercialFacts must be a bounded list of text.');
  if (value.assumptions != null) {
    if (!isObj(value.assumptions)) fail('plan.assumptions must be an object.');
    if (Array.isArray(value.assumptions)) fail('plan.assumptions must be an object, not an array.');
  }
  return {
    offerSummary: boundedText('offerSummary', 'offerSummary', 500),
    targetIndustry: boundedText('targetIndustry', 'targetIndustry', 200),
    country: value.country == null ? null : text(String(value.country).toUpperCase(), 'plan.country', 2),
    city: boundedText('city', 'city', 200),
    objective: boundedText('objective', 'objective', 500),
    targetCount: value.targetCount ?? null,
    unknownCommercialFacts: value.unknownCommercialFacts ?? [],
    assumptions: value.assumptions ?? {},
  };
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('expectedVersion is required and must be a positive integer.', 409, 'business_goal_version_required');
  return value;
}

/** PG-backed guided goal runs. The planner and the start service are injected. */
export function createAstraBusinessGoalService({ planner = null, prospectingService = null, resolveSourceRights = null,
  classifyGoal = () => 'unknown', now = () => new Date(), initialLimit = 50 } = {}) {
  if (planner && typeof planner.plan !== 'function') fail('planner must expose plan().', 503, 'goal_planner_invalid');

  async function row(db, tenantId, id) {
    const result = await db.query(`SELECT tenant_id AS "tenantId",id,brief,status,plan,questions,answers,state_revision AS "stateRevision",
      blocked_reasons AS "blockedReasons",start_ref AS "startRef",created_at AS "createdAt",updated_at AS "updatedAt",started_at AS "startedAt"
      FROM astra.business_goal_runs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, id]);
    return result.rows[0] || null;
  }

  /** Create a goal run from a free-form customer brief. Idempotent by key. */
  async function createGoalRun(db, actor, { brief, idempotencyKey }) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const createdBy = String(actor?.userId || '');
    if (!/^[1-9][0-9]{0,39}$/.test(createdBy)) fail('A verified user is required.', 401, 'authenticated_user_required');
    const normalizedBrief = text(brief, 'brief', 4000);
    const key = text(idempotencyKey, 'idempotencyKey', 200);
    const id = randomUUID();
    const inserted = await db.query(`INSERT INTO astra.business_goal_runs(tenant_id,id,brief,status,questions,answers,blocked_reasons,idempotency_key,created_by)
      VALUES($1::uuid,$2::uuid,$3,'draft','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$4,$5)
      ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`, [tenantId, id, normalizedBrief, key, createdBy]);
    let duplicate = false;
    let goalId = id;
    if (!inserted.rowCount) {
      const prior = await db.query(`SELECT id,brief FROM astra.business_goal_runs WHERE tenant_id=$1::uuid AND idempotency_key=$2`, [tenantId, key]);
      if (!prior.rows[0] || prior.rows[0].brief !== normalizedBrief) fail('Idempotency key is already bound to a different brief.', 409, 'business_goal_idempotency_conflict');
      duplicate = true;
      goalId = prior.rows[0].id;
    }
    return { ...(await getGoalRun(db, actor, goalId)), duplicate };
  }

  /** Owner-confirmed start: hands the confirmed plan to the prospecting service. */
  async function confirmAndStartGoalRun(db, actor, id, { expectedVersion }) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    if (actor?.tenantRole !== 'owner') fail('Only the tenant owner can start a goal run.', 403, 'goal_owner_required');
    const goalId = uuid(id, 'goalId');
    expectedRevision(expectedVersion);
    const current = await db.query(`SELECT id,status,plan,state_revision AS "stateRevision" FROM astra.business_goal_runs
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, goalId]);
    const goal = current.rows[0];
    if (!goal) fail('Goal run was not found.', 404, 'business_goal_not_found');
    if (Number(goal.stateRevision) !== Number(expectedVersion)) {
      fail('The goal run changed. Refresh its status and try again.', 409, 'business_goal_version_conflict');
    }
    if (!STATUS_FLOW[goal.status]?.has('running')) fail(`A ${goal.status} goal run cannot start.`, 409, 'business_goal_not_startable');
    const plan = goal.plan == null ? null : normalizePlan(goal.plan);
    if (!isObj(plan)) fail('A confirmed plan is required before starting.', 400, 'goal_plan_required');
    const pending = { kind: 'prospecting_job', state: 'starting' };
    await db.query(`UPDATE astra.business_goal_runs SET status='running',start_ref=$3::jsonb,started_at=now(),state_revision=state_revision+1,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$4`, [tenantId, goalId, JSON.stringify(pending), expectedVersion]);
    return await getGoalRun(db, actor, goalId);
  }

  /** Load only the current revision and bounded model input in a short worker transaction. */
  async function prepareGoalPlan(db, actor, id, { expectedVersion, initial = true }) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const goalId = uuid(id, 'goalId');
    if (!planner) fail('The goal planner is not configured.', 503, 'goal_planner_unavailable');
    expectedRevision(expectedVersion);
    const current = await db.query(`SELECT id,status,brief,state_revision AS "stateRevision",questions AS "questions",answers AS "answers" FROM astra.business_goal_runs
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, goalId]);
    const goal = current.rows[0];
    if (!goal) fail('Goal run was not found.', 404, 'business_goal_not_found');
    if (Number(goal.stateRevision) !== Number(expectedVersion)) {
      fail('The goal run changed. Refresh its status and try again.', 409, 'business_goal_version_conflict');
    }
    if (initial && goal.status !== 'draft') return { noOp: true, goal: await getGoalRun(db, actor, goalId) };
    if (!initial && !['draft', 'blocked'].includes(goal.status)) fail(`A ${goal.status} goal run cannot be retried.`, 409, 'business_goal_not_plannable');
    return {
      noOp: false, tenantId, userId: String(actor.userId), goalId,
      expectedVersion: Number(goal.stateRevision), brief: goal.brief || '', answers: [...(goal.answers || [])],
    };
  }

  /** Make the bounded provider call after prepare's database transaction has committed. */
  async function executeGoalPlan(prepared, { signal = null } = {}) {
    if (prepared?.noOp) return { noOp: true, goal: prepared.goal };
    const classification = await classifyGoal({ tenantId: prepared.tenantId, userId: prepared.userId, brief: prepared.brief, goalId: prepared.goalId });
    return planner.plan({ tenantId: prepared.tenantId, userId: prepared.userId, runId: prepared.goalId, brief: prepared.brief,
      answers: prepared.answers, dataClassification: classification, signal });
  }

  /** Apply the planner result in a fresh short transaction with revision CAS. */
  async function applyGoalPlan(db, actor, id, { expectedVersion, outcome }) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const goalId = uuid(id, 'goalId');
    expectedRevision(expectedVersion);
    const current = await db.query(`SELECT id,status,state_revision AS "stateRevision",answers AS "answers" FROM astra.business_goal_runs
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, goalId]);
    const goal = current.rows[0];
    if (!goal) fail('Goal run was not found.', 404, 'business_goal_not_found');
    if (Number(goal.stateRevision) !== Number(expectedVersion)) fail('The goal run changed. Refresh its status and try again.', 409, 'business_goal_version_conflict');
    if (outcome?.status === 'pending') return await getGoalRun(db, actor, goalId);
    if (!['draft', 'blocked'].includes(goal.status)) fail(`A ${goal.status} goal run cannot accept a planner result.`, 409, 'business_goal_not_plannable');
    if (!isObj(outcome) || !['planned', 'blocked'].includes(String(outcome.status || ''))) {
      fail('Planner returned an unsupported outcome.', 502, 'goal_planner_outcome_invalid');
    }
    if (outcome.status === 'blocked') {
      const reasons = array(Array.isArray(outcome.reasons) ? outcome.reasons : [], 'reasons');
      await db.query(`UPDATE astra.business_goal_runs SET status='blocked',blocked_reasons=$3::jsonb,answers=$4::jsonb,state_revision=state_revision+1,updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$5`, [tenantId, goalId, JSON.stringify(reasons), JSON.stringify(goal.answers || []), expectedVersion]);
      return await getGoalRun(db, actor, goalId);
    }
    const plan = normalizePlan(outcome.plan == null ? null : outcome.plan);
    const questions = array(Array.isArray(outcome.questions) ? outcome.questions : [], 'questions', 3).map(q => {
      if (!isObj(q) || !['questionId', 'question'].every(k => typeof q[k] === 'string')) fail('Planner questions need questionId and question text.');
      return { questionId: text(q.questionId, 'questionId', 160), question: text(q.question, 'question', 500) };
    });
    if (!plan) fail('A planned outcome must include an executable prospecting plan.', 502, 'goal_planner_outcome_invalid');
    await db.query(`UPDATE astra.business_goal_runs SET status=${questions.length ? "'awaiting_confirmation'" : "'planned'"},
      plan=$3::jsonb,questions=$4::jsonb,answers=$5::jsonb,blocked_reasons='[]'::jsonb,state_revision=state_revision+1,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$6`, [tenantId, goalId, JSON.stringify(plan), JSON.stringify(questions), JSON.stringify(goal.answers || []), expectedVersion]);
    return await getGoalRun(db, actor, goalId);
  }

  /** Durably save current answers and queue replanning for a post-commit worker. */
  async function queueAnswerPlan(db, actor, id, { expectedVersion, answers = [] }) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const goalId = uuid(id, 'goalId');
    expectedRevision(expectedVersion);
    const processedAnswers = array(answers, 'answers', 3).map(normalizeAnswer);
    const current = await db.query(`SELECT id,status,questions AS "questions",answers AS "answers",state_revision AS "stateRevision"
      FROM astra.business_goal_runs WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, goalId]);
    const goal = current.rows[0];
    if (!goal) fail('Goal run was not found.', 404, 'business_goal_not_found');
    if (Number(goal.stateRevision) !== expectedVersion) fail('The goal run changed. Refresh its status and try again.', 409, 'business_goal_version_conflict');
    if (goal.status !== 'awaiting_confirmation' || !goal.questions?.length) fail(`A ${goal.status} goal run cannot accept answers.`, 409, 'business_goal_not_plannable');
    const knownQuestionIds = new Set(goal.questions.map(question => question.questionId));
    const alreadyAnswered = new Set((goal.answers || []).map(answer => answer.questionId));
    if (!processedAnswers.length || processedAnswers.some(answer => !knownQuestionIds.has(answer.questionId) || alreadyAnswered.has(answer.questionId))
      || new Set(processedAnswers.map(answer => answer.questionId)).size !== processedAnswers.length) {
      fail('Answers must match unanswered questions from the current goal revision.', 409, 'business_goal_answer_not_current');
    }
    const merged = [...(goal.answers || []), ...processedAnswers];
    await db.query(`UPDATE astra.business_goal_runs SET status='draft',plan=NULL,questions='[]'::jsonb,answers=$3::jsonb,
      blocked_reasons='[]'::jsonb,state_revision=state_revision+1,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$4`,
    [tenantId, goalId, JSON.stringify(merged), expectedVersion]);
    return await getGoalRun(db, actor, goalId);
  }

  /** Resolve and persist a server-approved source request, then return its id for post-commit runOnce. */
  async function startGoalOnce(db, actor, id) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const goalId = uuid(id, 'goalId');
    const current = await row(db, tenantId, goalId);
    if (!current) fail('Goal run was not found.', 404, 'business_goal_not_found');
    if (current.status !== 'running' || current.startRef?.state !== 'starting') return { goal: current, jobId: null };
    const blocked = async (code, message) => {
      await db.query(`UPDATE astra.business_goal_runs SET status='blocked',start_ref=NULL,blocked_reasons=$3::jsonb,state_revision=state_revision+1,updated_at=now()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$4 AND status='running'`,
      [tenantId, goalId, JSON.stringify([{ code, message }]), current.stateRevision]);
      return { goal: await getGoalRun(db, actor, goalId), jobId: null };
    };
    if (typeof resolveSourceRights !== 'function') return blocked('goal_source_rights_unavailable', 'A server-approved source-use grant is not configured for this workspace.');
    if (!prospectingService || typeof prospectingService.create !== 'function' || typeof prospectingService.runOnce !== 'function') {
      return blocked('goal_prospecting_unavailable', 'The existing prospecting service is not configured.');
    }
    let rights;
    try { rights = await resolveSourceRights({ db, actor, plan: current.plan }); }
    catch { rights = null; }
    if (!isObj(rights)) return blocked('goal_source_rights_unavailable', 'A current owner-approved source-use request is required before prospecting can start.');
    if (!current.plan?.targetIndustry || !current.plan?.country || !current.plan?.objective || !Number.isInteger(current.plan?.targetCount)
      || current.plan.targetCount < 1 || current.plan.targetCount > 10) return blocked('goal_plan_incomplete', 'The confirmed plan needs a category, country, objective, and a count from 1 to 10.');
    const { normalizeProspectingRequest } = await import('./astra-prospecting.js');
    let payload;
    try {
      payload = normalizeProspectingRequest({ category: current.plan.targetIndustry, country: current.plan.country,
        city: current.plan.city || '', goal: current.plan.objective, targetCount: current.plan.targetCount, sourceRights: rights });
    } catch { return blocked('goal_source_rights_invalid', 'The approved source-use request is expired, incomplete, or incompatible with this prospecting plan.'); }
    let result;
    try {
      result = await prospectingService.create({ tenantId, payload, idempotencyKey: `goal-start-${goalId}` });
    } catch (error) {
      const code = /^[a-z0-9_.:-]{1,64}$/i.test(String(error?.code || '')) ? String(error.code) : 'goal_prospecting_create_failed';
      return blocked(code, 'The prospecting job could not be created. Review workspace setup and retry.');
    }
    const job = result?.job;
    if (!job || typeof job.id !== 'string') return blocked('goal_prospecting_create_invalid', 'The prospecting service did not return a saved job reference.');
    const startRef = { kind: 'prospecting_job', id: job.id, state: job.state || 'queued' };
    await db.query(`UPDATE astra.business_goal_runs SET start_ref=$3::jsonb,state_revision=state_revision+1,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$4 AND status='running'`,
    [tenantId, goalId, JSON.stringify(startRef), current.stateRevision]);
    return { goal: await getGoalRun(db, actor, goalId), jobId: job.id };
  }

  async function blockGoalRun(db, actor, id, { expectedVersion, code, message }) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const goalId = uuid(id, 'goalId');
    expectedRevision(expectedVersion);
    const safeCode = /^[a-z0-9_.:-]{1,64}$/i.test(String(code || '')) ? String(code) : 'goal_worker_unavailable';
    const safeMessage = text(message, 'message', 240);
    await db.query(`UPDATE astra.business_goal_runs SET status='blocked',blocked_reasons=$3::jsonb,state_revision=state_revision+1,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state_revision=$4 AND status IN ('draft','planned','awaiting_confirmation','blocked')`,
    [tenantId, goalId, JSON.stringify([{ code: safeCode, message: safeMessage }]), expectedVersion]);
    return await getGoalRun(db, actor, goalId);
  }

  async function getGoalRun(db, actor, id) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const goal = await row(db, tenantId, uuid(id, 'goalId'));
    if (!goal) fail('Goal run was not found.', 404, 'business_goal_not_found');
    return goal;
  }

  async function listGoalRuns(db, actor, { limit = 50 } = {}) {
    const tenantId = uuid(actor?.tenantId, 'tenantId');
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 200)) : initialLimit;
    const result = await db.query(`SELECT id,brief,status,state_revision AS "stateRevision",blocked_reasons AS "blockedReasons",start_ref AS "startRef",created_at AS "createdAt"
      FROM astra.business_goal_runs WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT $2`, [tenantId, bounded]);
    return result.rows;
  }

  return { createGoalRun, prepareGoalPlan, executeGoalPlan, applyGoalPlan, queueAnswerPlan, confirmAndStartGoalRun, startGoalOnce, blockGoalRun, getGoalRun, listGoalRuns };
}

export { hash as goalHash }; // eslint-disable-line no-unused-vars
