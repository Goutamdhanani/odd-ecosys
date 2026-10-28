import { AstraTenantContextError } from './astra-tenant-context.js';
import { configureAstraConnector,listAstraConnectors,bindAstraMailboxConnector } from './astra-connectors.js';
import { randomUUID } from 'node:crypto';

const BASE='^/api/astra/tenants/(?<tenantId>[0-9a-f-]{36})/connectors';
const respond=(body,status=200)=>({body,status});
let routeDependencies={};
export function configureAstraConnectorRoutes(dependencies={}) { routeDependencies={...dependencies}; }
async function rawBody(req,max=128*1024) {
  const chunks=[];let length=0;
  for await(const chunk of req){length+=chunk.length;if(length>max)throw new AstraTenantContextError('Webhook body is too large.',413,'webhook_body_invalid');chunks.push(chunk);}
  return Buffer.concat(chunks,length);
}
function requireAdmin(actor){if(!['owner','admin'].includes(actor.tenantRole))throw new AstraTenantContextError('Connector configuration requires tenant owner or admin.',403,'connector_admin_required');}
async function enqueueJob(db,actor,afterCommit,{connectorId,mailboxId=null,candidateId=null,jobType,payload={}}) {
  const taskId=randomUUID();
  const valid=jobType==='verify_candidate'
    ?await db.query(`SELECT 1 FROM astra.connector_configs c JOIN astra.research_identity_candidates i ON i.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2::uuid AND c.provider='reacher' AND c.state='configured' AND i.id=$3::uuid`,[actor.tenantId,connectorId,candidateId])
    :await db.query(`SELECT 1 FROM astra.mailbox_connectors WHERE tenant_id=$1 AND connector_id=$2::uuid AND mailbox_id=$3::uuid`,[actor.tenantId,connectorId,mailboxId]);
  if(!valid.rowCount)throw new AstraTenantContextError('Connector or mailbox was not found.',404,'connector_job_target_not_found');
  await db.query(`INSERT INTO astra.connector_jobs(tenant_id,id,connector_id,mailbox_id,candidate_id,job_type,payload,created_by)
    VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::jsonb,$8)`,[actor.tenantId,taskId,connectorId,mailboxId,candidateId,jobType,JSON.stringify(payload),String(actor.userId)]);
  return taskId;
}

export function registerAstraConnectorRoutes(registerAstraApiRoute) {
  if(typeof registerAstraApiRoute!=='function')throw new TypeError('registerAstraApiRoute must be a function.');
  const register=(method,suffix,handler,roles)=>registerAstraApiRoute({method,path:new RegExp(`${BASE}${suffix}$`),handler,...(roles?{allowedRoles:roles}:{})});
  register('GET','',async(_req,_res,{actor,db})=>({items:await listAstraConnectors(db,actor.tenantId)}));
  register('GET','/jobs',async(_req,_res,{actor,db})=>{
    const rows=await db.query(`SELECT id,connector_id AS "connectorId",mailbox_id AS "mailboxId",candidate_id AS "candidateId",job_type AS "jobType",state,result,diagnostic_code AS "diagnosticCode",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
      FROM astra.connector_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,[actor.tenantId]);return {items:rows.rows};
  });
  register('GET','/jobs/(?<taskId>[0-9a-f-]{36})',async(_req,_res,{actor,db,params})=>{
    const row=await db.query(`SELECT id,connector_id AS "connectorId",mailbox_id AS "mailboxId",candidate_id AS "candidateId",job_type AS "jobType",state,result,diagnostic_code AS "diagnosticCode",created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
      FROM astra.connector_jobs WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,params.taskId]);return row.rowCount?{job:row.rows[0]}:respond({error:'Connector job was not found.'},404);
  });
  register('POST','',async(req,_res,{actor,db,readJson})=>respond({connector:await configureAstraConnector(db,actor,await readJson(req))},201),['owner','admin']);
  register('POST','/(?<connectorId>[0-9a-f-]{36})/mailboxes/(?<mailboxId>[0-9a-f-]{36})',async(req,_res,{actor,db,params,readJson})=>{
    const body=await readJson(req);return respond({binding:await bindAstraMailboxConnector(db,actor,{...params,providerMailboxId:body.providerMailboxId})},201);
  },['owner','admin']);
  register('POST','/(?<connectorId>[0-9a-f-]{36})/mailboxes/(?<mailboxId>[0-9a-f-]{36})/probe',async(_req,_res,{actor,db,params,afterCommit})=>{
    const taskId=await enqueueJob(db,actor,afterCommit,{...params,jobType:'probe_mailbox'});
    if(typeof routeDependencies.runMailboxTask==='function')afterCommit(()=>routeDependencies.runMailboxTask({taskId,tenantId:actor.tenantId,userId:String(actor.userId),action:'probe',...params}));
    return respond({taskId,state:'queued'},202);
  },['owner','admin']);
  register('POST','/(?<connectorId>[0-9a-f-]{36})/mailboxes/(?<mailboxId>[0-9a-f-]{36})/sync',async(req,_res,{actor,db,params,readJson,afterCommit})=>{
    const body=await readJson(req);const limit=body.limit??25;if(!Number.isInteger(limit)||limit<1||limit>100)throw new AstraTenantContextError('limit must be an integer from 1 to 100.',400,'connector_job_limit_invalid');
    const taskId=await enqueueJob(db,actor,afterCommit,{...params,jobType:'sync_mailbox',payload:{limit}});
    if(typeof routeDependencies.runMailboxTask==='function')afterCommit(()=>routeDependencies.runMailboxTask({taskId,tenantId:actor.tenantId,userId:String(actor.userId),action:'sync',...params,limit}));
    return respond({taskId,state:'queued'},202);
  },['owner','admin','operator']);
  register('POST','/verify/(?<candidateId>[0-9a-f-]{36})',async(_req,_res,{actor,db,params,afterCommit})=>{
    const connector=await db.query(`SELECT id FROM astra.connector_configs WHERE tenant_id=$1 AND provider='reacher' AND state='configured' ORDER BY updated_at DESC LIMIT 2`,[actor.tenantId]);
    if(connector.rowCount!==1)throw new AstraTenantContextError('Exactly one Reacher connector must be configured.',409,'reacher_connector_ambiguous');
    const taskId=await enqueueJob(db,actor,afterCommit,{connectorId:connector.rows[0].id,candidateId:params.candidateId,jobType:'verify_candidate'});
    if(typeof routeDependencies.runVerificationTask==='function')afterCommit(()=>routeDependencies.runVerificationTask({taskId,tenantId:actor.tenantId,userId:String(actor.userId),candidateId:params.candidateId,connectorId:connector.rows[0].id}));
    return respond({taskId,state:'queued'},202);
  },['owner','admin','operator']);
  register('POST','/(?<connectorId>[0-9a-f-]{36})/webhooks/twenty',async(req,_res,{actor,db,params,afterCommit})=>{
    const exists=await db.query(`SELECT id FROM astra.connector_configs WHERE tenant_id=$1 AND id=$2::uuid AND provider='twenty' AND state='configured'`,[actor.tenantId,params.connectorId]);
    if(!exists.rowCount)throw new AstraTenantContextError('Twenty connector was not found.',404,'connector_not_found');
    if(typeof routeDependencies.runWebhookTask!=='function')throw new AstraTenantContextError('Signed webhook worker boundary is not configured.',503,'webhook_worker_unavailable');
    const raw=await rawBody(req);const taskId=randomUUID();
    afterCommit(()=>routeDependencies.runWebhookTask({taskId,tenantId:actor.tenantId,userId:String(actor.userId),connectorId:params.connectorId,
      rawBody:raw,signature:req.headers?.['x-twenty-signature'],timestamp:req.headers?.['x-twenty-timestamp']}));
    return respond({taskId,state:'queued'},202);
  },['owner','admin','operator']);
  return {registered:[
    'GET|POST /api/astra/tenants/:tenantId/connectors',
    'POST /api/astra/tenants/:tenantId/connectors/:connectorId/mailboxes/:mailboxId',
    'POST /api/astra/tenants/:tenantId/connectors/:connectorId/mailboxes/:mailboxId/probe',
    'POST /api/astra/tenants/:tenantId/connectors/:connectorId/mailboxes/:mailboxId/sync',
    'POST /api/astra/tenants/:tenantId/connectors/verify/:candidateId',
    'POST /api/astra/tenants/:tenantId/connectors/:connectorId/webhooks/twenty',
  ]};
}
