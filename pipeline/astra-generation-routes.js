import { AstraTenantContextError } from './astra-tenant-context.js';
import {
  cancelAstraGenerationJob, createAstraCampaignGenerationJob, createAstraReplyGenerationJob,
  getAstraGenerationJob, generationProviderContract,
} from './astra-generation.js';

const TENANT_GENERATION_ROUTE = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/generation(?<resource>\/policy|\/campaigns\/(?<campaignId>[0-9a-fA-F-]{36})\/jobs|\/replies\/(?<messageId>[0-9a-fA-F-]{36})\/jobs|\/jobs\/(?<jobId>[0-9a-fA-F-]{36})(?<action>\/cancel)?)?$/;
const WRITER_ROLES = new Set(['owner','admin','operator']);
const CONFIG_ROLES = new Set(['owner','admin']);
const TASKS = new Set(['campaign_generation','reply_classification']);

function fail(message,statusCode=400,code='generation_route_invalid') {
  throw new AstraTenantContextError(message,statusCode,code);
}
function assertActor(params,actor) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    fail('Verified tenant membership is required.',403,'tenant_membership_required');
  }
}

async function policyStatus(db,tenantId) {
  const [policyResult,globalResult,jobs] = await Promise.all([
    db.query(`SELECT enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens
      FROM astra.generation_tenant_policies WHERE tenant_id=$1`,[tenantId]),
    db.query(`SELECT enabled,daily_budget_microusd,breaker_state,breaker_open_until FROM astra.ai_global_limits WHERE singleton=true`),
    db.query(`SELECT state,count(*)::bigint AS count,COALESCE(sum(reserved_microusd),0)::bigint AS reserved_microusd
      FROM astra.generation_jobs WHERE tenant_id=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY state`,[tenantId]),
  ]);
  const policy=policyResult.rows[0]||{};
  const global=globalResult.rows[0]||{};
  const contract=generationProviderContract();
  const preview=process.env.ASTRA_GLM_LOCAL_PREVIEW !== 'false';
  const blocker=preview?'local_preview_egress_denied':!global.enabled?'global_budget_disabled':!policy.enabled?'tenant_policy_disabled':null;
  return { provider:contract.provider,model:contract.model,endpoint:contract.endpoint,reasoning:contract.reasoning,
    tasks:contract.tasks,workerAutostart:false,egressEnabled:false,egressBlocker:blocker||'commercial_and_data_approval_required',
    policy:{enabled:policy.enabled===true,allowedTasks:policy.allowed_tasks||[],dailyBudgetMicrousd:Number(policy.daily_budget_microusd||0),
      reservationMicrousd:Number(policy.reservation_microusd||0),maxInputTokens:Number(policy.max_input_tokens||0),maxOutputTokens:Number(policy.max_output_tokens||0)},
    global:{enabled:global.enabled===true,dailyBudgetMicrousd:Number(global.daily_budget_microusd||0),breakerState:global.breaker_state||'closed'},
    usage:jobs.rows.map(row=>({state:row.state,count:Number(row.count),reservedMicrousd:Number(row.reserved_microusd)})) };
}

async function updatePolicy(db,tenantId,input) {
  if (!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).some(key=>!['enabled','allowedTasks','dailyBudgetMicrousd','reservationMicrousd','maxInputTokens','maxOutputTokens'].includes(key))) {
    fail('Policy accepts only bounded enablement, task, budget and token fields.');
  }
  const enabled=input.enabled===true;
  const tasks=input.allowedTasks??[];
  if (!Array.isArray(tasks)||tasks.length>2||tasks.some(task=>!TASKS.has(task))) fail('allowedTasks is invalid.');
  const values={ dailyBudgetMicrousd:input.dailyBudgetMicrousd??0,reservationMicrousd:input.reservationMicrousd??0,
    maxInputTokens:input.maxInputTokens??0,maxOutputTokens:input.maxOutputTokens??0 };
  for (const [field,value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value)||value<0) fail(`${field} must be a non-negative integer.`);
  }
  if (values.dailyBudgetMicrousd>9_000_000_000_000_000||values.reservationMicrousd>9_000_000_000_000_000
    ||values.maxInputTokens>128000||values.maxOutputTokens>16384) fail('Policy values exceed supported limits.');
  if (enabled&&(!tasks.length||!values.dailyBudgetMicrousd||!values.reservationMicrousd||!values.maxInputTokens||!values.maxOutputTokens)) fail('Enabled policy requires tasks, budget reservation and token ceilings.');
  const result=await db.query(`INSERT INTO astra.generation_tenant_policies(tenant_id,enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens,updated_at)
    VALUES($1,$2,$3::text[],$4,$5,$6,$7,now()) ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,allowed_tasks=EXCLUDED.allowed_tasks,
      daily_budget_microusd=EXCLUDED.daily_budget_microusd,reservation_microusd=EXCLUDED.reservation_microusd,
      max_input_tokens=EXCLUDED.max_input_tokens,max_output_tokens=EXCLUDED.max_output_tokens,updated_at=now()
    RETURNING enabled,allowed_tasks,daily_budget_microusd,reservation_microusd,max_input_tokens,max_output_tokens`,
  [tenantId,enabled,[...new Set(tasks)],values.dailyBudgetMicrousd,values.reservationMicrousd,values.maxInputTokens,values.maxOutputTokens]);
  return result.rows[0];
}

async function handle(req,res,context) {
  const {params,actor,db,legacyDb,readJson,sendJson}=context;
  assertActor(params,actor);
  const resource=params.resource||'';
  if (req.method==='GET'&&(resource===''||resource==='/policy')) return sendJson(res,{data:await policyStatus(db,actor.tenantId)},200);
  if (req.method==='PATCH'&&resource==='/policy') {
    if (!CONFIG_ROLES.has(actor.tenantRole)) fail('Only tenant owners or admins may change generation policy.',403,'generation_policy_role_required');
    const policy=await updatePolicy(db,actor.tenantId,await readJson(req,16*1024));
    return sendJson(res,{data:{policy,egressEnabled:false}},200);
  }
  if (req.method==='POST'&&params.campaignId) {
    if (!WRITER_ROLES.has(actor.tenantRole)) fail('A tenant operator role is required to request generation.',403,'generation_request_role_required');
    const job=await createAstraCampaignGenerationJob(db,actor,legacyDb,params.campaignId,await readJson(req,8*1024));
    return sendJson(res,{data:{...job,provider:'glm-5.3-api',model:'GLM-5.3',workerAutostart:false}},job.duplicate?200:202);
  }
  if (req.method==='POST'&&params.messageId) {
    if (!WRITER_ROLES.has(actor.tenantRole)) fail('A tenant operator role is required to request reply intelligence.',403,'generation_request_role_required');
    const result=await createAstraReplyGenerationJob(db,actor,params.messageId,await readJson(req,8*1024));
    return sendJson(res,{data:{...result,provider:'glm-5.3-api',model:'GLM-5.3',workerAutostart:false}},result.job?.duplicate?200:result.job?202:200);
  }
  if (req.method==='GET'&&params.jobId&&!params.action) {
    const job=await getAstraGenerationJob(db,actor.tenantId,params.jobId);
    if (!job) fail('Generation job was not found.',404,'generation_job_not_found');
    return sendJson(res,{data:job},200);
  }
  if (req.method==='POST'&&params.jobId&&params.action==='/cancel') {
    if (!WRITER_ROLES.has(actor.tenantRole)) fail('A tenant operator role is required to cancel generation.',403,'generation_request_role_required');
    return sendJson(res,{data:await cancelAstraGenerationJob(db,actor.tenantId,params.jobId)},200);
  }
  return sendJson(res,{error:'Generation route was not found.',code:'generation_route_not_found'},404);
}

/** Registrar for verified tenant routes. Jobs run only through an explicit worker invocation. */
export function registerAstraGenerationRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute!=='function') throw new TypeError('registerAstraApiRoute must be a function.');
  for (const method of ['GET','PATCH','POST']) registerAstraApiRoute({method,path:TENANT_GENERATION_ROUTE,handler:handle});
  return {registered:[
    'GET /api/astra/tenants/:tenantId/generation',
    'GET|PATCH /api/astra/tenants/:tenantId/generation/policy',
    'POST /api/astra/tenants/:tenantId/generation/campaigns/:campaignId/jobs',
    'POST /api/astra/tenants/:tenantId/generation/replies/:messageId/jobs',
    'GET /api/astra/tenants/:tenantId/generation/jobs/:jobId',
    'POST /api/astra/tenants/:tenantId/generation/jobs/:jobId/cancel',
  ]};
}
