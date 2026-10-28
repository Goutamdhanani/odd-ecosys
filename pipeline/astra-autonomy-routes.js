import { recordAstraDecision, listAstraDecisions, getAstraDecision } from './astra-decisions.js';
import { approveAstraAuthorizationEnvelope, approveAstraExceptionReview, bindAstraMailboxConnector, createAstraAuthorizationEnvelope, listAstraAuthorizationEnvelopes, listAstraExceptionReviews, requestAstraExceptionReview, revokeAstraAuthorizationEnvelope } from './astra-autonomy.js';

const BASE='^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})';
const WRITE=['owner','admin','operator'];
const ADMIN=['owner','admin'];
const out=(body,status=200)=>({body,status});
const params=req=>new URL(req.url||'/','http://astra.local').searchParams;
function assertActor(actor,p){if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(p?.tenantId||'').toLowerCase()){const e=new Error('Verified tenant membership is required.');e.name='AstraTenantContextError';e.statusCode=403;e.code='tenant_membership_required';throw e;}}

export function registerAstraAutonomyRoutes(registerAstraApiRoute){
  if(typeof registerAstraApiRoute!=='function')throw new TypeError('registerAstraApiRoute is required.');
  const register=(method,suffix,handler,allowedRoles)=>registerAstraApiRoute({method,path:new RegExp(`${BASE}${suffix}$`),handler,...(allowedRoles?{allowedRoles}:{})});
  register('GET','/decisions',async(req,_res,{actor,params:p,db})=>{assertActor(actor,p);const limit=Number(params(req).get('limit')||100);if(!Number.isInteger(limit)){const e=new Error('limit must be an integer.');e.statusCode=400;throw e;}return {items:await listAstraDecisions(db,actor.tenantId,{limit})};});
  register('POST','/decisions',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);return out({decision:await recordAstraDecision(db,actor,await readJson(req))},201);},WRITE);
  register('GET','/decisions/(?<decisionId>[0-9a-fA-F-]{36})',async(_req,_res,{actor,params:p,db})=>{assertActor(actor,p);const decision=await getAstraDecision(db,actor.tenantId,p.decisionId);return decision?{decision}:out({error:'Decision not found.',code:'decision_not_found'},404);});
  register('GET','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/authorizations',async(_req,_res,{actor,params:p,db})=>{assertActor(actor,p);return {items:await listAstraAuthorizationEnvelopes(db,actor.tenantId,p.campaignId)};});
  register('POST','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/authorizations',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);return out({authorization:await createAstraAuthorizationEnvelope(db,actor,p.campaignId,await readJson(req))},201);},ADMIN);
  register('POST','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/authorizations/(?<version>[1-9][0-9]*)/approve',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);return out({authorization:await approveAstraAuthorizationEnvelope(db,actor,p.campaignId,Number(p.version),await readJson(req))},201);},['owner']);
  register('POST','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/authorizations/(?<version>[1-9][0-9]*)/revoke',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);return out({authorization:await revokeAstraAuthorizationEnvelope(db,actor,p.campaignId,Number(p.version),await readJson(req))},201);},ADMIN);
  register('PUT','/autonomy/mailboxes/(?<mailboxId>[0-9a-fA-F-]{36})/connector',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);const body=await readJson(req);if(!body||Object.keys(body).length!==1||typeof body.connectorId!=='string'){const e=new Error('connectorId is required.');e.statusCode=400;throw e;}return out({binding:await bindAstraMailboxConnector(db,actor,p.mailboxId,body.connectorId)},201);},ADMIN);
  register('GET','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/exceptions',async(_req,_res,{actor,params:p,db})=>{assertActor(actor,p);return {items:await listAstraExceptionReviews(db,actor.tenantId,p.campaignId)};});
  register('POST','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/exceptions',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);return out({review:await requestAstraExceptionReview(db,actor,p.campaignId,await readJson(req))},201);},WRITE);
  register('POST','/autonomy/campaigns/(?<campaignId>[0-9a-fA-F-]{36})/exceptions/(?<requestId>[0-9a-fA-F-]{36})/approve',async(req,_res,{actor,params:p,db,readJson})=>{assertActor(actor,p);return out({review:await approveAstraExceptionReview(db,actor,p.campaignId,p.requestId,await readJson(req))},201);},['owner']);
  return {registered:['GET|POST /api/astra/tenants/:tenantId/decisions','GET /api/astra/tenants/:tenantId/decisions/:decisionId','GET|POST /api/astra/tenants/:tenantId/autonomy/campaigns/:campaignId/authorizations','POST /api/astra/tenants/:tenantId/autonomy/campaigns/:campaignId/authorizations/:version/approve','POST /api/astra/tenants/:tenantId/autonomy/campaigns/:campaignId/authorizations/:version/revoke','PUT /api/astra/tenants/:tenantId/autonomy/mailboxes/:mailboxId/connector','GET|POST /api/astra/tenants/:tenantId/autonomy/campaigns/:campaignId/exceptions','POST /api/astra/tenants/:tenantId/autonomy/campaigns/:campaignId/exceptions/:requestId/approve'],ticketMintRoute:false};
}
