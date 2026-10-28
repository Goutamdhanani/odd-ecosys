import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { AstraTenantContextError } from './astra-tenant-context.js';

const fail=(m,s=400,c='learning_invalid')=>{throw new AstraTenantContextError(m,s,c);};
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>{if(typeof x!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))fail('A valid UUID is required.');return x.toLowerCase();};
const short=(x,n='value',max=160)=>{if(typeof x!=='string'||!x.trim()||x.trim().length>max)fail(`${n} is required and bounded.`);return x.trim();};
const hash=x=>sha256(canonicalJson(x));
const LIMITS=Object.freeze({examples:5000,features:32,skills:100,candidates:8,optimizerIterations:12,optimizerBytes:12000,explorationFraction:.2,minCohort:20});

function featureVector(packet) {
  const p=obj(packet)?packet:{}; const out={};
  for(const key of ['source_count','evidence_count','recency_days','website_present','email_verified','company_size','intent_score']){
    const v=p[key]; if(typeof v==='number'&&Number.isFinite(v))out[key]=Math.max(-100000,Math.min(100000,v));
    else if(typeof v==='boolean')out[key]=v?1:0;
  }
  return out;
}
function fitModel(rows,labels) {
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))].slice(0,LIMITS.features); const means={},scales={},weights={};
  for(const k of keys){const vs=rows.map(r=>Number(r[k]||0));means[k]=vs.reduce((a,b)=>a+b,0)/Math.max(vs.length,1);const sd=Math.sqrt(vs.reduce((a,v)=>a+(v-means[k])**2,0)/Math.max(vs.length,1));scales[k]=sd||1;}
  const positives=labels.filter(Boolean).length; const intercept=Math.log((positives+.5)/(labels.length-positives+.5));
  // Bounded deterministic ridge-style single-pass ranker. No external model or generation.
  for(const k of keys){let cov=0,varx=0;rows.forEach((r,i)=>{const x=(Number(r[k]||0)-means[k])/scales[k];cov+=x*(Number(labels[i])-positives/Math.max(labels.length,1));varx+=x*x;});weights[k]=Math.max(-2,Math.min(2,cov/(varx+8)));}
  return {kind:'bounded_logistic_ranker_v1',keys,means,scales,weights,intercept};
}
function rawScore(model,features){let z=model.intercept;for(const k of model.keys)z+=model.weights[k]*(Number(features[k]||0)-model.means[k])/model.scales[k];return Math.max(-20,Math.min(20,z));}
function predict(model,features){const raw=rawScore(model,features),cal=model.calibration||{slope:1,intercept:0};return 1/(1+Math.exp(-Math.max(-20,Math.min(20,cal.intercept+cal.slope*raw))));}
function fitCalibration(model,rows,labels){if(rows.length<8||new Set(labels).size<2)return {slope:1,intercept:0,method:'identity_insufficient_validation',count:rows.length};const xs=rows.map(x=>rawScore(model,x));let a=1,b=0;for(let it=0;it<25;it++){let g0=0,g1=0,h00=1e-4,h01=0,h11=1e-4;xs.forEach((x,i)=>{const p=1/(1+Math.exp(-Math.max(-20,Math.min(20,a*x+b)))),e=p-Number(labels[i]),w=p*(1-p);g0+=e*x;g1+=e;h00+=w*x*x;h01+=w*x;h11+=w;});const det=h00*h11-h01*h01;if(det<1e-10)break;const da=(h11*g0-h01*g1)/det,db=(-h01*g0+h00*g1)/det;a=Math.max(.1,Math.min(5,a-da));b=Math.max(-5,Math.min(5,b-db));if(Math.abs(da)+Math.abs(db)<1e-6)break;}return {slope:a,intercept:b,method:'platt_validation',count:rows.length};}
function metrics(rows,labels,model){const n=rows.length;if(!n)return {count:0,brier:null,accuracy:null,precision:null,recall:null,f1:null,positiveRate:null,calibrationBins:[]};let b=0,correct=0,tp=0,fp=0,fn=0;const bins=Array.from({length:5},()=>({n:0,p:0,y:0}));rows.forEach((x,i)=>{const p=predict(model,x),y=Number(labels[i]),pred=p>=.5;b+=(p-y)**2;if(pred===Boolean(y))correct++;if(pred&&y)tp++;else if(pred&&!y)fp++;else if(!pred&&y)fn++;const j=Math.min(4,Math.floor(p*5));bins[j].n++;bins[j].p+=p;bins[j].y+=y;});const precision=tp/(tp+fp||1),recall=tp/(tp+fn||1);return {count:n,brier:b/n,accuracy:correct/n,precision,recall,f1:2*precision*recall/(precision+recall||1),positiveRate:labels.filter(Boolean).length/n,calibrationBins:bins.map(x=>({count:x.n,meanProbability:x.n?x.p/x.n:null,observedRate:x.n?x.y/x.n:null}))};}
function baselineMetrics(labels){const n=labels.length;if(!n)return {brier:null,accuracy:null};const p=labels.filter(Boolean).length/n;return {kind:'constant_prevalence',brier:labels.reduce((s,y)=>s+(p-Number(y))**2,0)/n,accuracy:Math.max(p,1-p)};}
function approved13(r){return r&&r.artifact_status==='approved_not_deployed'&&r.owner_decision==='approve'&&r.reviewer_decision==='approve'&&r.run_state==='completed';}

/** Train only from adjudicated frozen 013 examples with explicit label rights and company/time splits. */
export async function trainAstraLearningArtifact(db,actor,input){
  if(!obj(input)||Object.keys(input).some(k=>!['datasetId','releaseId','name','version','positiveLabel'].includes(k)))fail('Unsupported learning training fields.');
  const datasetId=uuid(input.datasetId),releaseId=uuid(input.releaseId),name=short(input.name,'name'),version=short(input.version,'version',80);
  const gate=await db.query(`SELECT r.status artifact_status,run.state run_state,
    max(a.decision) FILTER(WHERE a.approval_role='owner') owner_decision,
    max(a.decision) FILTER(WHERE a.approval_role='reviewer') reviewer_decision,
    max(a.approved_by) FILTER(WHERE a.approval_role='owner') owner_id,
    max(a.approved_by) FILTER(WHERE a.approval_role='reviewer') reviewer_id,
    d.id dataset_id,d.label_rights,d.split_policy
    FROM astra.release_artifacts r JOIN astra.eval_runs run ON (run.tenant_id,run.id)=(r.tenant_id,r.evaluation_run_id)
    JOIN astra.eval_datasets d ON (d.tenant_id,d.id)=(run.tenant_id,run.dataset_id)
    LEFT JOIN astra.release_approvals a ON (a.tenant_id,a.release_id)=(r.tenant_id,r.id)
    WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND d.id=$3::uuid GROUP BY r.status,run.state,d.id,d.label_rights,d.split_policy`,[actor.tenantId,releaseId,datasetId]);
  const g=gate.rows[0]; if(!approved13(g))fail('Training requires a completed 013 evaluation release approved independently by owner and reviewer.',409,'learning_release_unapproved');
  if(g.owner_id===g.reviewer_id)fail('013 evaluation release approvals must come from distinct owner and reviewer identities.',409,'learning_release_not_independent');
  if(!['authorized','licensed','public_terms_permitted'].includes(g.label_rights?.basis)||g.label_rights?.attested!==true)fail('Dataset label rights do not authorize outcome training.',409,'learning_label_rights_missing');
  const positiveLabel=short(input.positiveLabel,'positiveLabel',80);
  const schema=await db.query(`SELECT label_schema FROM astra.eval_datasets WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,datasetId]);
  if(!schema.rows[0]?.label_schema?.includes(positiveLabel))fail('positiveLabel must be a label in the frozen 013 label schema.');
  const examples=await db.query(`SELECT e.id,e.company_hash,e.observed_at,e.split,e.input_packet,e.subgroups,a.final_label
    FROM astra.eval_examples e JOIN astra.eval_adjudications a ON (a.tenant_id,a.dataset_id,a.example_id)=(e.tenant_id,e.dataset_id,e.id)
    WHERE e.tenant_id=$1::uuid AND e.dataset_id=$2::uuid ORDER BY e.observed_at,e.id LIMIT $3`,[actor.tenantId,datasetId,LIMITS.examples+1]);
  if(examples.rows.length>LIMITS.examples)fail('Dataset exceeds the bounded learning example limit.');
  const rows=examples.rows.filter(r=>schema.rows[0].label_schema.includes(r.final_label));
  const labels=rows.map(r=>Number(r.final_label===positiveLabel));
  const groups={development:[],validation:[],holdout:[]};rows.forEach((r,i)=>groups[r.split]?.push(i));
  if(groups.development.length<8||groups.validation.length<4||groups.holdout.length<4)fail('Insufficient independently split adjudicated examples; keep the cohort manual.',409,'learning_cohort_insufficient');
  const companies={}; for(const r of rows)(companies[r.company_hash]??=[]).push(r);
  if(Object.values(companies).some(rs=>new Set(rs.map(x=>x.split)).size>1))fail('Company leakage crosses evaluation splits.',409,'learning_company_leakage');
  const dev=groups.development, val=groups.validation, hold=groups.holdout;
  const model=fitModel(dev.map(i=>featureVector(rows[i].input_packet)),dev.map(i=>labels[i]));
  model.calibration=fitCalibration(model,val.map(i=>featureVector(rows[i].input_packet)),groups.validation.map(i=>labels[i]));
  const validationLabels=val.map(i=>labels[i]),holdoutLabels=hold.map(i=>labels[i]);
  const validation=metrics(val.map(i=>featureVector(rows[i].input_packet)),validationLabels,model);
  const holdoutMetrics=metrics(hold.map(i=>featureVector(rows[i].input_packet)),holdoutLabels,model);
  validation.baseline=baselineMetrics(validationLabels);holdoutMetrics.baseline=baselineMetrics(holdoutLabels);
  const subgroupMetrics={};for(const key of new Set(rows.flatMap(r=>Object.keys(r.subgroups||{})))){const ix=hold.filter(i=>rows[i].subgroups?.[key]!=null);const vals=new Set(ix.map(i=>String(rows[i].subgroups[key])));for(const v of vals){const selected=ix.filter(i=>String(rows[i].subgroups[key])===v);const name=`${key}:${v}`;subgroupMetrics[name]=selected.length<LIMITS.minCohort?{count:selected.length,manualFallback:true}:{...metrics(selected.map(i=>featureVector(rows[i].input_packet)),selected.map(i=>labels[i]),model),manualFallback:false};}}
  const payload={kind:'calibrated_ranker',algorithm:'bounded_logistic_ranker_v1',model,validation,holdout:holdoutMetrics,subgroups:subgroupMetrics,training:{datasetId,releaseId,positiveLabel,labelRightsBasis:g.label_rights.basis,examples:rows.length,splitCounts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length]))},calibration:{method:model.calibration.method,fitSplit:'validation',holdoutUsedForFit:false},calibratedAt:new Date().toISOString(),releaseReady:false};
  const artifactId=randomUUID(),artifactHash=hash(payload);
  await db.query(`INSERT INTO astra.learning_artifacts(tenant_id,id,name,version,source_dataset_id,source_release_id,artifact,artifact_sha256,created_by,status)
    VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7::jsonb,$8,$9,'pending_review')`,[actor.tenantId,artifactId,name,version,datasetId,releaseId,JSON.stringify(payload),artifactHash,String(actor.userId)]);
  return {id:artifactId,name,version,artifactHash,status:'pending_review',metrics:{validation,holdout:holdoutMetrics,subgroups:subgroupMetrics},releaseReady:false};
}
export async function reviewAstraLearningArtifact(db,actor,id,{decision,reason}={}){id=uuid(id);if(!['approve','reject'].includes(decision))fail('decision must be approve or reject.');reason=short(reason,'reason',240);const r=await db.query(`SELECT id,status,artifact_sha256,created_by FROM astra.learning_artifacts WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,id]);if(!r.rows[0])fail('Learning artifact not found.',404,'learning_artifact_not_found');if(r.rows[0].created_by===String(actor.userId))fail('Artifact creator cannot independently review it.',403,'independent_review_required');const saved=await db.query(`INSERT INTO astra.learning_reviews(tenant_id,artifact_id,reviewer_id,decision,reason,artifact_sha256) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) ON CONFLICT(tenant_id,artifact_id,reviewer_id) DO NOTHING RETURNING artifact_id`,[actor.tenantId,id,String(actor.userId),decision,reason,r.rows[0].artifact_sha256]);if(!saved.rowCount)fail('This reviewer has already recorded a decision for the artifact.',409,'learning_review_exists');return {id,status:'review_recorded',releaseReady:false};}
export async function promoteAstraLearningArtifact(db,actor,id){id=uuid(id);const r=await db.query(`SELECT a.id,a.status,a.created_by,count(*) FILTER(WHERE v.decision='approve' AND v.reviewer_id<>a.created_by)::int approvals,count(*) FILTER(WHERE v.decision='reject')::int rejections FROM astra.learning_artifacts a LEFT JOIN astra.learning_reviews v ON (v.tenant_id,v.artifact_id)=(a.tenant_id,a.id) WHERE a.tenant_id=$1::uuid AND a.id=$2::uuid GROUP BY a.id`,[actor.tenantId,id]);const a=r.rows[0];if(!a)fail('Learning artifact not found.',404,'learning_artifact_not_found');if(a.status==='approved')return {id,status:'approved',releaseReady:false};if(a.rejections||a.approvals<1)fail('Independent reviewer approval is required before owner promotion.',409,'learning_review_required');await db.query(`UPDATE astra.learning_artifacts SET status='approved',promoted_by=$3,promoted_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending_review'`,[actor.tenantId,id,String(actor.userId)]);return {id,status:'approved',releaseReady:false};}
export async function resolveAstraLearningPrediction(db,tenantId,{artifactId,entityRef}={}){if(typeof entityRef!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entityRef))return null;const q=await db.query(`SELECT artifact,source_dataset_id,name,version FROM astra.learning_artifacts WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='approved'`,[tenantId,artifactId]);if(!q.rows[0])return null;const p=q.rows[0].artifact,cohort=Number(p.holdout?.count||0);if(cohort<LIMITS.minCohort||p.calibration?.method!=='platt_validation'||p.holdout?.positiveRate<=0||p.holdout?.positiveRate>=1)return null;const e=await db.query(`SELECT e.input_packet FROM astra.eval_examples e JOIN astra.eval_datasets d ON (d.tenant_id,d.id)=(e.tenant_id,e.dataset_id) WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid AND e.dataset_id<>$3::uuid AND d.label_rights->>'attested'='true' AND d.label_rights->>'basis' IN ('authorized','licensed','public_terms_permitted')`,[tenantId,entityRef,q.rows[0].source_dataset_id]);if(!e.rows[0])return null;const probability=predict(p.model,featureVector(e.rows[0].input_packet));return {probability,artifactId,artifactName:q.rows[0].name,artifactVersion:q.rows[0].version,entityRef,source:'approved_calibrated_ranker'};}

/** Deterministic priority with logged randomized exploration and exact inclusion probability. */
export function allocateAstraResearch(items,{budget=0,exploration=.1,seed='allocation-v1',sourceAllowed=()=>false,approvedArtifact=null}={}){if(!Array.isArray(items)||items.length>10000)fail('items must be bounded.');if(!Number.isFinite(budget)||budget<0||budget>100000)fail('budget must be between zero and 100000 units.');const exp=Math.max(0,Math.min(LIMITS.explorationFraction,Number(exploration)||0));const eligible=items.filter(x=>obj(x)&&typeof x.id==='string'&&x.id.length<=160&&typeof x.sourceId==='string'&&sourceAllowed(x)&&Number.isFinite(x.cost)&&x.cost>=0);const ranked=eligible.map(x=>({id:x.id,sourceId:x.sourceId,cost:x.cost,priority:Number.isFinite(x.priority)?x.priority:0,rankProbability:null,artifactId:approvedArtifact?.id??null})).sort((a,b)=>b.priority-a.priority||String(a.id).localeCompare(String(b.id)));const picked=[];let spent=0;const explorationBudget=budget*exp;
  // The remaining budget follows deterministic priority; one uniformly sampled exploration slot has exact probability 1/N.
  for(const item of ranked){if(spent+item.cost>budget-explorationBudget)continue;picked.push({...item,inclusionProbability:1,selection:'priority',predictedResponse:null});spent+=item.cost;}
  const explore=ranked.filter(x=>!picked.some(y=>y.id===x.id)&&x.cost<=explorationBudget);if(exp>0&&explore.length){const ordered=[...explore].sort((a,b)=>sha256(`${seed}:${a.id}`).localeCompare(sha256(`${seed}:${b.id}`)));const item=ordered[0];picked.push({...item,inclusionProbability:1/explore.length,selection:'exploration',predictedResponse:null});spent+=item.cost;}
  return {items:picked,spent,budget,eligibleCount:eligible.length,explorationFraction:exp,causalLift:null,releaseReady:false};}

/** Skill resolution returns stored text as untrusted data; it never executes instructions. */
export async function resolveAstraSkill(db,tenantId,{skillId,version,scope}={}){const q=await db.query(`SELECT id,name,version,body,scope,license,provenance_sha256,manifest_sha256 FROM astra.skills WHERE tenant_id=$1::uuid AND id=$2::uuid AND version=$3 AND status IN ('approved','canary','active') AND scope @> $4::jsonb`,[tenantId,uuid(skillId),short(version,'version',80),JSON.stringify(scope||{})]);if(!q.rows[0])return null;return {...q.rows[0],trustedAsPolicy:false,executable:false};}
export { LIMITS as ASTRA_LEARNING_LIMITS };
