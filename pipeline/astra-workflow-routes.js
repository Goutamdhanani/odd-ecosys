import { AstraWorkflowError, cancelWorkflow, getWorkflow, scheduleWorkflow } from './astra-workflow.js';

const PATH=/^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/workflows(?:\/(?<workflowId>[0-9a-fA-F-]{36})(?:\/(?<action>cancel))?)?$/;
const WRITE_ROLES=['owner','admin','operator'];

function verifyActor(params,actor) {
  if(!actor?.tenantId || String(actor.tenantId).toLowerCase()!==String(params?.tenantId||'').toLowerCase()) throw new AstraWorkflowError('Verified tenant membership is required.',403,'tenant_membership_required');
}

export function registerAstraWorkflowRoutes({registerAstraApiRoute}) {
  if(typeof registerAstraApiRoute!=='function') throw new TypeError('registerAstraApiRoute is required.');
  const handler=async(req,res,context)=>{
    const {params,actor,db,readJson,sendJson}=context; verifyActor(params,actor);
    const {workflowId,action}=params||{};
    if(req.method==='POST' && action==='cancel') {
      const result=await cancelWorkflow(db,actor,workflowId); return sendJson(res,{data:result},200);
    }
    if(req.method==='GET') {
      if(workflowId) { const data=await getWorkflow(db,actor.tenantId,workflowId); return data?sendJson(res,{data},200):sendJson(res,{error:'Workflow not found.',code:'workflow_not_found'},404); }
      const limit=Math.max(1,Math.min(100,Number(new URL(req.url||context.pathname,'http://astra.local').searchParams.get('limit'))||50));
      const rows=await db.query(`SELECT id,task_key AS "taskKey",task_type AS "taskType",state,priority,task_class AS "taskClass",attempt,
        available_at AS "availableAt",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
        FROM astra.workflows WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,[actor.tenantId,limit]);
      return sendJson(res,{data:rows.rows},200);
    }
    if(req.method==='POST' && !workflowId) {
      const body=await readJson(req,1024*1024); const result=await scheduleWorkflow(db,actor,body);
      return sendJson(res,{data:result},result.duplicate?200:201);
    }
    return sendJson(res,{error:'Method not allowed.',code:'method_not_allowed'},405);
  };
  for(const method of ['GET','POST']) registerAstraApiRoute({method,path:PATH,handler,...(method==='POST'?{allowedRoles:WRITE_ROLES}:{})});
  return {registered:['GET /api/astra/tenants/:tenantId/workflows','POST /api/astra/tenants/:tenantId/workflows','GET /api/astra/tenants/:tenantId/workflows/:workflowId','POST /api/astra/tenants/:tenantId/workflows/:workflowId/cancel']};
}
