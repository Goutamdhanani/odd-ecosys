import { trainAstraLearningArtifact, reviewAstraLearningArtifact, promoteAstraLearningArtifact, allocateAstraResearch } from './astra-learning.js';
import { createAstraSkillCandidate, transitionAstraSkill } from './astra-skills.js';
import { getAstraFeatureWorkerStore } from './astra-feature-workers.js';
import { runAstraOptimizerJob, ASTRA_OPTIMIZER_ENGINES, ASTRA_OPTIMIZER_LIMITS, getAstraOptimizerEngineStatus, normalizeAstraOptimizerBudget } from './astra-optimizer.js';

const BASE='^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})';
const READ=['owner','admin','operator','reviewer'], AUTHOR=['owner','admin','operator'], OWNER=['owner','admin'];
function route(register,method,suffix,handler,allowedRoles=READ){register({method,path:new RegExp(`${BASE}${suffix}$`),handler,allowedRoles});}
function assertTenant(actor,params){if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(params.tenantId).toLowerCase()){const e=new Error('Verified tenant membership is required.');e.statusCode=403;e.code='tenant_membership_required';throw e;}}
export function registerAstraLearningRoutes(registerAstraApiRoute){
  if(typeof registerAstraApiRoute!=='function')throw new TypeError('registerAstraApiRoute is required.');
  route(registerAstraApiRoute,'GET','/learning/artifacts',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);const q=await db.query(`SELECT id,name,version,status,artifact_sha256 AS "artifactHash",source_dataset_id AS "sourceDatasetId",source_release_id AS "sourceReleaseId",created_at AS "createdAt",promoted_at AS "promotedAt" FROM astra.learning_artifacts WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT 100`,[actor.tenantId]);return {items:q.rows,releaseReady:false};});
  route(registerAstraApiRoute,'POST','/learning/artifacts',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return {status:201,body:{artifact:await trainAstraLearningArtifact(db,actor,await readJson(req,64*1024)),releaseReady:false}};},OWNER);
  route(registerAstraApiRoute,'POST','/learning/artifacts/(?<artifactId>[0-9a-fA-F-]{36})/review',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return {review:await reviewAstraLearningArtifact(db,actor,params.artifactId,await readJson(req,4096)),releaseReady:false};},['reviewer']);
  route(registerAstraApiRoute,'POST','/learning/artifacts/(?<artifactId>[0-9a-fA-F-]{36})/promote',async(_req,_res,{actor,params,db})=>{assertTenant(actor,params);return {artifact:await promoteAstraLearningArtifact(db,actor,params.artifactId),releaseReady:false};},OWNER);
  route(registerAstraApiRoute,'POST','/learning/optimizer/prepare',async(req,_res,{actor,params,db,readJson})=>{
    assertTenant(actor,params);
    const body=await readJson(req,16*1024);
    if(!body||Object.keys(body).some(k=>!['datasetId','candidatePrompt','budget','engine'].includes(k))
      ||typeof body.datasetId!=='string'||! /^[0-9a-f-]{36}$/i.test(body.datasetId)
      ||typeof body.candidatePrompt!=='string'||!body.candidatePrompt.trim()
      ||Buffer.byteLength(body.candidatePrompt,'utf8')>ASTRA_OPTIMIZER_LIMITS.candidateBytes) {
      throw Object.assign(new Error('Optimizer dataset, candidate text and budget exceed the bounded protocol.'),{statusCode:400,code:'optimizer_input_invalid'});
    }
    const engine=body.engine??ASTRA_OPTIMIZER_ENGINES.native;
    const adapter=getAstraOptimizerEngineStatus(engine);
    if(!adapter.available&&engine!==ASTRA_OPTIMIZER_ENGINES.gepa&&engine!==ASTRA_OPTIMIZER_ENGINES.dspy) {
      throw Object.assign(new Error('The requested optimizer engine is not recognized.'),{statusCode:400,code:'optimizer_engine_invalid'});
    }
    const budget=normalizeAstraOptimizerBudget(body.budget);
    const initialState=adapter.available?'prepared':'blocked';
    const diagnostic=adapter.available?'Native bounded optimizer is prepared; explicit execution is required.':'Optional GEPA/DSPy adapter is not installed or approved; no execution was performed.';
    const q=await db.query(`INSERT INTO astra.learning_optimizer_jobs(
      tenant_id,id,dataset_id,candidate_prompt,budget,engine,state,diagnostic,diagnostic_code,requested_by
    ) VALUES($1::uuid,gen_random_uuid(),$2::uuid,$3,$4::jsonb,$5,$6,$7,$8,$9)
    RETURNING id,state,engine,diagnostic,diagnostic_code,budget,created_at`,
    [actor.tenantId,body.datasetId.toLowerCase(),body.candidatePrompt.trim(),JSON.stringify(budget),engine,initialState,
      diagnostic,adapter.available?null:'optimizer_adapter_unavailable',String(actor.userId)]);
    return {status:201,body:{job:q.rows[0],engine:adapter,execution:'not_started',providerCalls:0,holdoutAccess:false,releaseReady:false}};
  },OWNER);
  route(registerAstraApiRoute,'POST','/learning/optimizer/(?<jobId>[0-9a-fA-F-]{36})/execute',async(req,_res,{actor,params,db,readJson,afterCommit})=>{
    assertTenant(actor,params);
    const body=await readJson(req,1024);
    if(Object.keys(body||{}).length)throw Object.assign(new Error('Optimizer execute accepts an empty JSON object.'),{statusCode:400,code:'optimizer_execute_body_invalid'});
    const q=await db.query(`SELECT id,state,engine FROM astra.learning_optimizer_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,params.jobId]);
    const job=q.rows[0];
    if(!job) return {status:404,body:{error:'Optimizer job not found.',code:'optimizer_job_not_found'}};
    if(job.state!=='prepared')return {status:409,body:{error:'Only a prepared optimizer job can be explicitly executed.',code:'optimizer_job_not_prepared',state:job.state,providerCalls:0,releaseReady:false}};
    afterCommit(()=>runAstraOptimizerJob({store:getAstraFeatureWorkerStore(),tenantId:actor.tenantId,userId:String(actor.userId),jobId:job.id}));
    return {status:202,body:{jobId:job.id,state:'execution_requested',engine:job.engine,dispatch:'after_commit_once',providerCalls:'bounded_by_reserved_usage',holdoutAccess:false,releaseReady:false}};
  },OWNER);
  route(registerAstraApiRoute,'GET','/learning/optimizer/(?<jobId>[0-9a-fA-F-]{36})',async(_req,_res,{actor,params,db})=>{
    assertTenant(actor,params);
    const q=await db.query(`SELECT id,state,engine,budget,diagnostic,diagnostic_code,created_at,started_at,completed_at,
        result->>'status' AS candidate_status,result->>'calls' AS completed_calls
      FROM astra.learning_optimizer_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,params.jobId]);
    const job=q.rows[0];
    return job?{job:{...job,completed_calls:job.completed_calls===null?null:Number(job.completed_calls)},releaseReady:false,holdoutAccess:false}
      :{status:404,body:{error:'Optimizer job not found.',code:'optimizer_job_not_found'}};
  });
  route(registerAstraApiRoute,'POST','/allocation/plan',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);const body=await readJson(req,256*1024);if(!Array.isArray(body.items)||body.items.length>1000||!Number.isFinite(body.budget)||body.budget<0||typeof body.datasetId!=='string'||body.items.some(x=>!x||typeof x.exampleId!=='string'||!Number.isFinite(x.cost)||x.cost<0))throw Object.assign(new Error('A frozen dataset, bounded example IDs, costs, and nonnegative budget are required.'),{statusCode:400});const source=await db.query(`SELECT source_manifest FROM astra.eval_datasets WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,body.datasetId]);if(!source.rows[0])throw Object.assign(new Error('Frozen source manifest not found.'),{statusCode:404});const authorized=new Set((source.rows[0].source_manifest||[]).filter(x=>x.rightsAttested===true&&['authorized','licensed','public_terms_permitted'].includes(x.rightsBasis)).map(x=>x.sourceId));const ids=body.items.map(x=>x.exampleId);if(new Set(ids).size!==ids.length)throw Object.assign(new Error('Example IDs must be unique.'),{statusCode:400});const examples=await db.query(`SELECT id,source_refs,input_packet FROM astra.eval_examples WHERE tenant_id=$1::uuid AND dataset_id=$2::uuid AND id=ANY($3::uuid[])`,[actor.tenantId,body.datasetId,ids]);if(examples.rowCount!==ids.length)throw Object.assign(new Error('Every allocation item must identify an example in this frozen dataset.'),{statusCode:400});const costs=new Map(body.items.map(x=>[x.exampleId,x.cost]));const items=examples.rows.map(e=>{const sourceId=e.source_refs.find(x=>authorized.has(x));return {id:e.id,sourceId,cost:costs.get(e.id),priority:(Number(e.input_packet?.evidence_count)||0)+(e.source_refs.length*0.1)+(e.input_packet?.email_verified===true?1:0)};});const plan=allocateAstraResearch(items,{budget:body.budget,exploration:body.exploration,seed:body.seed,sourceAllowed:x=>Boolean(x.sourceId&&authorized.has(x.sourceId))});plan.datasetId=body.datasetId;plan.execution=false;const q=await db.query(`INSERT INTO astra.allocation_plans(tenant_id,id,plan,created_by) VALUES($1::uuid,gen_random_uuid(),$2::jsonb,$3) RETURNING id,created_at`,[actor.tenantId,JSON.stringify(plan),String(actor.userId)]);return {planId:q.rows[0].id,...plan,releaseReady:false};},AUTHOR);
  route(registerAstraApiRoute,'POST','/skills',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return {status:201,body:{skill:await createAstraSkillCandidate(db,actor,await readJson(req,32*1024)),releaseReady:false}};},AUTHOR);
  route(registerAstraApiRoute,'POST','/skills/(?<skillId>[0-9a-fA-F-]{36})/transition',async(req,_res,{actor,params,db,readJson})=>{assertTenant(actor,params);return {skill:await transitionAstraSkill(db,actor,params.skillId,await readJson(req,4096)),releaseReady:false};},OWNER);
  return {registered:['/learning/artifacts','/learning/optimizer/prepare','/learning/optimizer/:jobId','/learning/optimizer/:jobId/execute','/allocation/plan','/skills','/skills/:skillId/transition'],releaseReady:false};
}
