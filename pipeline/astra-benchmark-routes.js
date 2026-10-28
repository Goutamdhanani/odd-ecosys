import { AstraTenantContextError } from './astra-tenant-context.js';
import { collectAstraBenchmarkObservations, createAstraBenchmarkReport, getAstraBenchmark, listAstraBenchmarks,
  prepareAstraBenchmarkCohort, recordAstraBenchmarkQuote, reviewAstraBenchmarkQuote } from './astra-benchmark.js';

const BASE='^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})';
const WRITE_ROLES=['owner','admin','operator'];
const respond=(body,status=200)=>({body,status});
function assertTenant(actor,params){if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(params?.tenantId||'').toLowerCase())throw new AstraTenantContextError('Verified tenant membership is required.',403,'tenant_membership_required');}

/** Tenant APIs for frozen cohorts and evidence collection; no worker or provider is started here. */
export function registerAstraBenchmarkRoutes(registerAstraApiRoute){
  if(typeof registerAstraApiRoute!=='function')throw new TypeError('registerAstraApiRoute is required.');
  const register=(method,suffix,handler,allowedRoles)=>registerAstraApiRoute({method,path:new RegExp(`${BASE}/economics/benchmarks${suffix}$`),handler,...(allowedRoles?{allowedRoles}:{})});
  register('GET','',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return listAstraBenchmarks(db,actor);});
  register('POST','',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({cohort:await prepareAstraBenchmarkCohort(db,actor,await readJson(req,2*1024*1024)),releaseReady:false},201);},WRITE_ROLES);
  register('GET','/(?<benchmarkId>[0-9a-fA-F-]{36})',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return getAstraBenchmark(db,actor,params.benchmarkId);});
  register('POST','/(?<benchmarkId>[0-9a-fA-F-]{36})/collect',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond(await collectAstraBenchmarkObservations(db,actor,params.benchmarkId,await readJson(req,16384)),201);},WRITE_ROLES);
  register('POST','/(?<benchmarkId>[0-9a-fA-F-]{36})/report',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return respond({report:await createAstraBenchmarkReport(db,actor,params.benchmarkId),releaseReady:false},201);},WRITE_ROLES);
  register('POST','/(?<benchmarkId>[0-9a-fA-F-]{36})/quotes',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({quote:await recordAstraBenchmarkQuote(db,actor,params.benchmarkId,await readJson(req,16384)),releaseReady:false},201);},['owner']);
  register('POST','/(?<benchmarkId>[0-9a-fA-F-]{36})/quotes/(?<quoteId>[0-9a-fA-F-]{36})/reviews',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return respond({review:await reviewAstraBenchmarkQuote(db,actor,params.benchmarkId,params.quoteId,await readJson(req,8192)),releaseReady:false},201);},['owner','admin','reviewer']);
  return {registered:['GET|POST /api/astra/tenants/:tenantId/economics/benchmarks','GET /api/astra/tenants/:tenantId/economics/benchmarks/:benchmarkId',
    'POST /api/astra/tenants/:tenantId/economics/benchmarks/:benchmarkId/collect','POST /api/astra/tenants/:tenantId/economics/benchmarks/:benchmarkId/report',
    'POST /api/astra/tenants/:tenantId/economics/benchmarks/:benchmarkId/quotes','POST /api/astra/tenants/:tenantId/economics/benchmarks/:benchmarkId/quotes/:quoteId/reviews'],
    startsWork:false,providerEgress:false,releaseReady:false};
}
