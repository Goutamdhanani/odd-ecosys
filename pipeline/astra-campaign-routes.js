import {
  approveAstraCampaign, createAstraCampaign, getAstraCampaign, listAstraCampaignApprovals,
  listAstraCampaigns, saveAstraCampaignDraft, getAstraCampaignComposer, getAstraCampaignReview,
} from './astra-campaigns.js';
import { qualifyAstraCampaign } from './astra-qualification.js';
import { recordAstraVerificationEvidence } from './astra-verification.js';
import { claimAstraOfflineDispatchPlan, listAstraDispatchPlans, prepareAstraOfflineDispatchPlan } from './astra-dispatcher.js';

const BASE='^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/campaigns';
const WRITE_ROLES=['owner','admin','operator'];
const ADMIN_ROLES=['owner','admin'];
const respond=(body,status=200)=>({body,status});
const urlParams=req=>new URL(req.url||'/', 'http://astra.local').searchParams;

function assertActor(actor,params) {
  if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(params?.tenantId||'').toLowerCase()) {
    const error=new Error('Verified tenant membership is required.'); error.name='AstraTenantContextError'; error.statusCode=403; error.code='tenant_membership_required'; throw error;
  }
}

export function registerAstraCampaignRoutes(registerAstraApiRoute) {
  if(typeof registerAstraApiRoute!=='function') throw new TypeError('registerAstraApiRoute is required.');
  const register=(method,suffix,handler,allowedRoles=undefined)=>registerAstraApiRoute({method,path:new RegExp(`${BASE}${suffix}$`),handler,...(allowedRoles?{allowedRoles}:{})});

  register('GET','',async(req,_res,{actor,params,db})=>{
    assertActor(actor,params);
    const raw=urlParams(req).get('limit'); const limit=raw==null?100:Number(raw);
    if(!Number.isInteger(limit)) { const e=new Error('limit must be an integer.');e.name='AstraTenantContextError';e.statusCode=400;throw e; }
    return {items:await listAstraCampaigns(db,actor.tenantId,{limit})};
  });
  register('POST','',async(req,_res,{actor,params,db,legacyDb,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    return respond({campaign:await createAstraCampaign(db,actor,legacyDb,body)},201);
  },WRITE_ROLES);
  register('GET','/(?<campaignId>[0-9a-fA-F-]{36})',async(_req,_res,{actor,params,db})=>{
    assertActor(actor,params); const campaign=await getAstraCampaign(db,actor.tenantId,params.campaignId);
    if(!campaign)return respond({error:'Campaign not found.',code:'campaign_not_found'},404);
    const approvals=await listAstraCampaignApprovals(db,actor.tenantId,params.campaignId);
    const plans=await listAstraDispatchPlans(db,actor.tenantId,params.campaignId);
    return {campaign:{id:campaign.id,name:campaign.name,state:campaign.state,version:campaign.version,offerVersionId:campaign.offer_version_id,
      offerContentHash:campaign.offer_content_hash,mailboxId:campaign.mailbox_id,purpose:campaign.purpose,geography:campaign.geography,
      scheduleAt:campaign.schedule_at,spendLimitMinor:campaign.spend_limit_minor,currency:campaign.currency,copyVersion:campaign.copy_version,
      subject:campaign.subject,body:campaign.body,claimsMap:campaign.claims_map,audience:campaign.audience_snapshot,copyHash:campaign.copy_hash},
      approvals,dispatchPlans:plans};
  });
  register('POST','/(?<campaignId>[0-9a-fA-F-]{36})/qualification',async(req,_res,{actor,params,db,legacyDb,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    return {qualification:await qualifyAstraCampaign(db,actor,legacyDb,params.campaignId,body)};
  },WRITE_ROLES);
  register('GET','/(?<campaignId>[0-9a-fA-F-]{36})/composer',async(_req,_res,{actor,params,db})=>{
    assertActor(actor,params);
    const composer=await getAstraCampaignComposer(db,actor.tenantId,params.campaignId);
    return composer?{composer}:respond({error:'Campaign not found.',code:'campaign_not_found'},404);
  });
  register('GET','/(?<campaignId>[0-9a-fA-F-]{36})/review',async(_req,_res,{actor,params,db,legacyDb})=>{
    assertActor(actor,params);
    const review=await getAstraCampaignReview(db,actor,legacyDb,params.campaignId);
    return review?{review}:respond({error:'Campaign not found.',code:'campaign_not_found'},404);
  });
  register('POST','/(?<campaignId>[0-9a-fA-F-]{36})/verification',async(req,_res,{actor,params,db,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    return respond({verification:await recordAstraVerificationEvidence(db,actor,params.campaignId,body)},201);
  },WRITE_ROLES);
  register('PUT','/(?<campaignId>[0-9a-fA-F-]{36})/draft',async(req,_res,{actor,params,db,legacyDb,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    const draft=await saveAstraCampaignDraft(db,actor,legacyDb,params.campaignId,body);
    return {draft,validation:draft.validation};
  },WRITE_ROLES);
  register('GET','/(?<campaignId>[0-9a-fA-F-]{36})/approvals',async(_req,_res,{actor,params,db})=>{
    assertActor(actor,params); const result=await listAstraCampaignApprovals(db,actor.tenantId,params.campaignId);
    return result===null?respond({error:'Campaign not found.',code:'campaign_not_found'},404):{items:result};
  });
  register('POST','/(?<campaignId>[0-9a-fA-F-]{36})/approvals',async(req,_res,{actor,params,db,legacyDb,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    return respond({approval:await approveAstraCampaign(db,actor,legacyDb,params.campaignId,body)},201);
  },ADMIN_ROLES);
  register('GET','/(?<campaignId>[0-9a-fA-F-]{36})/dispatch-plans',async(_req,_res,{actor,params,db})=>{
    assertActor(actor,params); const campaign=await getAstraCampaign(db,actor.tenantId,params.campaignId);
    return campaign?{items:await listAstraDispatchPlans(db,actor.tenantId,params.campaignId)}:respond({error:'Campaign not found.',code:'campaign_not_found'},404);
  });
  register('POST','/(?<campaignId>[0-9a-fA-F-]{36})/dispatch-plans',async(req,_res,{actor,params,db,legacyDb,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    return respond({plan:await prepareAstraOfflineDispatchPlan(db,actor,legacyDb,params.campaignId,body)},201);
  },WRITE_ROLES);
  register('POST','/(?<campaignId>[0-9a-fA-F-]{36})/dispatch-plans/(?<planId>[0-9a-fA-F-]{36})/claim',async(req,_res,{actor,params,db,legacyDb,readJson})=>{
    assertActor(actor,params); const body=await readJson(req);
    return respond({claim:await claimAstraOfflineDispatchPlan(db,actor,legacyDb,params.campaignId,params.planId,body)},201);
  },WRITE_ROLES);

  return {registered:[
    'GET|POST /api/astra/tenants/:tenantId/campaigns',
    'GET /api/astra/tenants/:tenantId/campaigns/:campaignId',
    'GET /api/astra/tenants/:tenantId/campaigns/:campaignId/composer',
    'GET /api/astra/tenants/:tenantId/campaigns/:campaignId/review',
    'POST /api/astra/tenants/:tenantId/campaigns/:campaignId/qualification',
    'POST /api/astra/tenants/:tenantId/campaigns/:campaignId/verification',
    'PUT /api/astra/tenants/:tenantId/campaigns/:campaignId/draft',
    'GET|POST /api/astra/tenants/:tenantId/campaigns/:campaignId/approvals',
    'GET|POST /api/astra/tenants/:tenantId/campaigns/:campaignId/dispatch-plans',
    'POST /api/astra/tenants/:tenantId/campaigns/:campaignId/dispatch-plans/:planId/claim',
  ]};
}
