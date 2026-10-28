import { AstraTenantContextError } from './astra-tenant-context.js';
import { evaluateAstraPermission, recordAstraPermission, recordAstraSuppression } from './astra-permissions.js';
import { createAstraMailbox, ingestAstraMessage, listAstraInbox, listAstraMailboxes } from './astra-inbox.js';
import { createAstraReplyTask, listAstraReplyTasks, reviewAstraReplyTask } from './astra-reply-tasks.js';
import { createAstraCrmMapping, enqueueAstraCrmProposal, importAstraCrmOutcome, listAstraCrmMappings, listAstraCrmOutbox } from './astra-crm.js';

const BASE = '^/api/astra/tenants/(?<tenantId>[0-9a-f-]{36})';
const urlParams = req => new URL(req.url || '/', 'http://astra.local').searchParams;
const respond = (body, status = 200) => ({ body, status });

export function registerAstraInboxRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute must be a function.');
  const register = (method, suffix, handler) => registerAstraApiRoute({ method, path: new RegExp(`${BASE}${suffix}$`), handler });

  register('GET','/permissions',async (_req,_res,{actor,db}) => {
    const result = await db.query(`SELECT id,subject_type,subject_value,purpose,lawful_basis,geography,decision,consent_expires_at,source_proof,actor_id,created_at
      FROM astra.permission_decisions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500`,[actor.tenantId]);
    return respond({ items:result.rows });
  });
  register('POST','/permissions',async (req,_res,{actor,db,readJson}) => {
    const body = await readJson(req);
    return respond({ permission:await recordAstraPermission(db,actor,body) },201);
  });
  register('POST','/permissions/evaluate',async (req,_res,{actor,db,readJson}) => {
    const body = await readJson(req);
    return { evaluation:await evaluateAstraPermission(db,actor,body) };
  });
  register('GET','/suppressions',async (_req,_res,{actor,db}) => {
    const result = await db.query(`SELECT id,scope,scope_value,reason,evidence,actor_id,created_at
      FROM astra.suppression_decisions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500`,[actor.tenantId]);
    return respond({ items:result.rows, removalSupported:false });
  });
  register('POST','/suppressions',async (req,_res,{actor,db,readJson}) => {
    const body = await readJson(req);
    return respond({ suppression:await recordAstraSuppression(db,actor,body), removalSupported:false },201);
  });
  register('GET','/mailboxes',async (_req,_res,{db}) => respond({ items:await listAstraMailboxes(db), outboundTransport:'disabled' }));
  register('POST','/mailboxes',async (req,_res,{actor,db,readJson}) => {
    const body = await readJson(req);
    return respond({ mailbox:await createAstraMailbox(db,actor,body) },201);
  });
  register('GET','/inbox/messages',async (req,_res,{actor,db}) => {
    const query = urlParams(req);
    const rawLimit = query.get('limit');
    const limit = rawLimit == null ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit)) throw new AstraTenantContextError('limit must be an integer.',400,'inbox_limit_invalid');
    return { items:await listAstraInbox(db,{tenantId:actor.tenantId,threadId:query.get('threadId'),limit}) };
  });
  register('POST','/inbox/messages',async (req,_res,{actor,db,readJson}) => {
    const body = await readJson(req);
    const message=await ingestAstraMessage(db,actor,body);
    return respond({ message },message.duplicate?200:201);
  });
  register('GET','/reply-tasks',async (req,_res,{actor,db}) => {
    const query=urlParams(req);
    const rawLimit=query.get('limit');
    const limit=rawLimit==null?100:Number(rawLimit);
    if (!Number.isInteger(limit)) throw new AstraTenantContextError('limit must be an integer.',400,'reply_task_limit_invalid');
    return { items:await listAstraReplyTasks(db,actor.tenantId,{status:query.get('status'),limit}) };
  });
  register('POST','/reply-tasks',async (req,_res,{actor,db,readJson}) => {
    const body=await readJson(req);
    const task=await createAstraReplyTask(db,actor,body.messageId);
    return respond({ task },task.duplicate?200:201);
  });
  register('POST','/reply-tasks/(?<taskId>[0-9a-f-]{36})/review',async (req,_res,{actor,db,params,readJson}) => {
    const body=await readJson(req);
    return { task:await reviewAstraReplyTask(db,actor,params.taskId,body) };
  });
  register('GET','/crm/mappings',async (_req,_res,{actor,db}) => ({ items:await listAstraCrmMappings(db,actor.tenantId),provider:'twenty' }));
  register('POST','/crm/mappings',async (req,_res,{actor,db,readJson}) => {
    const body=await readJson(req);
    const mapping=await createAstraCrmMapping(db,actor,body);
    return respond({ mapping },mapping.duplicate?200:201);
  });
  register('GET','/crm/outbox',async (req,_res,{actor,db}) => {
    const query=urlParams(req);
    const rawLimit=query.get('limit');
    const limit=rawLimit==null?100:Number(rawLimit);
    if (!Number.isInteger(limit)) throw new AstraTenantContextError('limit must be an integer.',400,'crm_limit_invalid');
    return listAstraCrmOutbox(db,actor.tenantId,{state:query.get('state'),limit});
  });
  register('POST','/crm/outbox',async (req,_res,{actor,db,readJson}) => {
    const body=await readJson(req);
    const proposal=await enqueueAstraCrmProposal(db,actor,body);
    return respond({ proposal,transportEnabled:false },proposal.duplicate?200:201);
  });
  register('POST','/crm/outcomes',async (req,_res,{actor,db,readJson}) => {
    const body=await readJson(req);
    return respond({ event:await importAstraCrmOutcome(db,actor,body) },201);
  });

  return { registered: [
    'GET|POST /api/astra/tenants/:tenantId/permissions',
    'POST /api/astra/tenants/:tenantId/permissions/evaluate',
    'GET|POST /api/astra/tenants/:tenantId/suppressions',
    'GET|POST /api/astra/tenants/:tenantId/mailboxes',
    'GET|POST /api/astra/tenants/:tenantId/inbox/messages',
    'GET|POST /api/astra/tenants/:tenantId/reply-tasks',
    'POST /api/astra/tenants/:tenantId/reply-tasks/:taskId/review',
    'GET|POST /api/astra/tenants/:tenantId/crm/mappings',
    'GET|POST /api/astra/tenants/:tenantId/crm/outbox',
    'POST /api/astra/tenants/:tenantId/crm/outcomes',
  ] };
}

