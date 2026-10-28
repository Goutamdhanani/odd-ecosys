import { getAstraEconomics, setAstraEconomicsQuota, recordAstraVendorBill, recordAstraReviewerEffort } from './astra-economics.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { createAstraPostSaleProject, listAstraPostSaleProjects, authorizeAstraDeliveryMilestone, captureAstraPostSaleEvidence, revokeAstraPostSaleEvidenceConsent, compareAstraPostSaleEvidence, prepareAstraCaseStudy, recordAstraRenewalSignal } from './astra-postsale.js';

const BASE='^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})';
const respond=(body,status=200)=>({body,status});
function assertTenant(actor,params){if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(params.tenantId).toLowerCase())throw new AstraTenantContextError('Verified tenant membership is required.',403,'tenant_membership_required');}
const query=req=>new URL(req.url||'/','http://astra.local').searchParams;

/** Registrar adapter uses only authenticated tenant context supplied by astra-api.js. */
export function registerAstraEconomicsRoutes(registerAstraApiRoute){
  if(typeof registerAstraApiRoute!=='function')throw new TypeError('registerAstraApiRoute is required.');
  const register=(method,suffix,handler,allowedRoles)=>registerAstraApiRoute({method,path:new RegExp(`${BASE}${suffix}$`),handler,allowedRoles});
  register('GET','/economics',async(req,_res,{actor,params,db})=>{assertTenant(actor,params);const q=query(req);return getAstraEconomics(db,actor,{since:q.get('since'),until:q.get('until')});});
  register('PUT','/economics/quota',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({quota:await setAstraEconomicsQuota(db,actor,await readJson(req,8192)),enforcement:'future-entry-hooks-only',releaseReady:false});},['owner','admin']);
  register('POST','/economics/vendor-bills',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({bill:await recordAstraVendorBill(db,actor,await readJson(req,16384))},201);},['owner','admin','operator']);
  register('POST','/economics/reviewer-effort',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({effort:await recordAstraReviewerEffort(db,actor,await readJson(req,8192))},201);},['owner','admin','operator','reviewer']);

  register('GET','/post-sale/projects',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return listAstraPostSaleProjects(db,actor.tenantId);});
  register('POST','/post-sale/projects',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({project:await createAstraPostSaleProject(db,actor,await readJson(req,8192))},201);},['owner','admin','operator']);
  register('POST','/post-sale/projects/(?<projectId>[0-9a-fA-F-]{36})/milestones',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({milestone:await authorizeAstraDeliveryMilestone(db,actor,{...await readJson(req,8192),projectId:params.projectId})},201);},['owner','admin','operator']);
  register('POST','/post-sale/projects/(?<projectId>[0-9a-fA-F-]{36})/evidence',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({evidence:await captureAstraPostSaleEvidence(db,actor,{...await readJson(req,49152),projectId:params.projectId})},201);},['owner','admin','operator']);
  register('POST','/post-sale/evidence/(?<evidenceId>[0-9a-fA-F-]{36})/revoke-consent',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return {evidence:await revokeAstraPostSaleEvidenceConsent(db,actor,params.evidenceId)};},['owner','admin','operator']);
  register('GET','/post-sale/projects/(?<projectId>[0-9a-fA-F-]{36})/comparison',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return compareAstraPostSaleEvidence(db,actor.tenantId,params.projectId);});
  register('POST','/post-sale/projects/(?<projectId>[0-9a-fA-F-]{36})/case-studies',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({caseStudy:await prepareAstraCaseStudy(db,actor,{...await readJson(req,32768),projectId:params.projectId})},201);},['owner','admin','operator']);
  register('POST','/post-sale/projects/(?<projectId>[0-9a-fA-F-]{36})/renewal-signals',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({signal:await recordAstraRenewalSignal(db,actor,{...await readJson(req,8192),projectId:params.projectId}),outreach:false,crmMutation:false},201);},['owner','admin','operator']);
  return {registered:['GET|PUT /api/astra/tenants/:tenantId/economics','POST /api/astra/tenants/:tenantId/economics/vendor-bills','POST /api/astra/tenants/:tenantId/economics/reviewer-effort','GET|POST /api/astra/tenants/:tenantId/post-sale/projects','POST /api/astra/tenants/:tenantId/post-sale/projects/:projectId/milestones','POST /api/astra/tenants/:tenantId/post-sale/projects/:projectId/evidence','POST /api/astra/tenants/:tenantId/post-sale/evidence/:evidenceId/revoke-consent','GET /api/astra/tenants/:tenantId/post-sale/projects/:projectId/comparison','POST /api/astra/tenants/:tenantId/post-sale/projects/:projectId/case-studies','POST /api/astra/tenants/:tenantId/post-sale/projects/:projectId/renewal-signals']};
}
