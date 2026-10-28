import { canonicalJson, sha256 } from './astra-ledger.js';
import { getAstraConformanceManifest } from './astra-conformance.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const MIN_HELD_OUT_COHORT=20;
const CRITICAL_CASES=Object.freeze([
  'source_instruction_read_only_harness','unregistered_side_effect_tool_rejected','source_rights_expiry_denied',
  'cross_tenant_resource_rejected','stale_lease_fence_rejected','duplicate_workflow_idempotency','opt_out_suppression_before_model',
]);
const digest=value=>sha256(canonicalJson(value));
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const validHash=value=>typeof value==='string'&&HASH.test(value.trim());

/** Resolve evidence only from durable same-tenant facts; never accepts caller-supplied measurements. */
export async function resolveAstraReleaseEvidence(db,tenantId,{sourceReleaseId,evaluationRunId,datasetId,datasetHash,candidateId,candidateHash,calibrationArtifactId,conformanceRunId,validationReportId}={}){
 const blockers=[];
 let calibration=null;
 if(calibrationArtifactId){
  const q=await db.query(`SELECT a.id,a.artifact_sha256,a.status,a.artifact,a.source_dataset_id,a.source_release_id,
      d.manifest_sha256 AS dataset_hash,r.candidate_id,r.evaluation_run_id
    FROM astra.learning_artifacts a
    JOIN astra.eval_datasets d ON(d.tenant_id,d.id)=(a.tenant_id,a.source_dataset_id)
    JOIN astra.release_artifacts r ON(r.tenant_id,r.id)=(a.tenant_id,a.source_release_id)
    WHERE a.tenant_id=$1::uuid AND a.id=$2::uuid`,[tenantId,calibrationArtifactId]);
  const row=q.rows[0],artifact=row?.artifact,held=artifact?.holdout;
  if(!row||row.status!=='approved'||row.source_release_id!==sourceReleaseId||row.source_dataset_id!==datasetId||row.dataset_hash?.trim()!==datasetHash||row.candidate_id!==candidateId||row.evaluation_run_id!==evaluationRunId){
   blockers.push({code:'calibration_unknown',status:'unknown',reason:'No approved calibration artifact is bound to this exact release, candidate, dataset, and evaluation.'});
  }else if(!validHash(row.artifact_sha256)||row.artifact_sha256.trim()!==digest(artifact)||artifact?.kind!=='calibrated_ranker'||artifact?.calibration?.method!=='platt_validation'||artifact?.calibration?.holdoutUsedForFit!==false||!Number.isSafeInteger(held?.count)||held.count<MIN_HELD_OUT_COHORT||!Number.isFinite(held?.brier)||!Number.isFinite(held?.accuracy)||!Number.isFinite(held?.positiveRate)||held.positiveRate<=0||held.positiveRate>=1){
   blockers.push({code:'calibration_unknown',status:'unknown',reason:'Approved calibration lacks verified held-out metrics or minimum cohort support.'});
  }else calibration={id:row.id,artifactSha256:row.artifact_sha256.trim(),status:row.status,sourceDatasetId:row.source_dataset_id,sourceReleaseId:row.source_release_id,heldOut:{count:held.count,brier:held.brier,accuracy:held.accuracy,positiveRate:Number.isFinite(held.positiveRate)?held.positiveRate:null,calibrationMethod:artifact.calibration.method,fitSplit:artifact.calibration.fitSplit,holdoutUsedForFit:false},subgroups:artifact.subgroups||{}};
 }else blockers.push({code:'calibration_unknown',status:'unknown',reason:'No approved calibration artifact was selected.'});

 let conformance=null;
 if(conformanceRunId){
  const q=await db.query(`SELECT id,state,case_manifest_version,case_manifest_sha256,component_hashes,evaluation_binding,summary,summary_sha256
    FROM astra.conformance_runs WHERE tenant_id=$1::uuid AND id=$2::uuid`,[tenantId,conformanceRunId]);
  const run=q.rows[0],manifest=getAstraConformanceManifest(),binding=run?.evaluation_binding;
  const caseRows=run?await db.query(`SELECT case_id,status,receipt_sha256 FROM astra.conformance_case_results WHERE tenant_id=$1::uuid AND run_id=$2::uuid ORDER BY case_id`,[tenantId,conformanceRunId]):{rows:[]};
  const results=new Map(caseRows.rows.map(x=>[x.case_id,x]));
  const bindingMatches=binding?.evaluationRun?.id===evaluationRunId&&binding?.evaluationRun?.state==='completed'
    &&binding?.evaluationRun?.snapshotSha256&&binding.dataset?.id===datasetId&&binding.dataset?.manifestSha256===datasetHash
    &&binding.candidate?.id===candidateId&&binding.candidate?.manifestSha256===candidateHash;
  const componentsMatch=same(run?.component_hashes,manifest.componentHashes)&&run?.case_manifest_version===manifest.version
    &&run?.case_manifest_sha256?.trim()===manifest.manifestSha256&&run?.summary?.caseManifestSha256===manifest.manifestSha256
    &&same(run?.summary?.componentHashes,manifest.componentHashes)&&same(run?.summary?.evaluationBinding,binding);
  const critical=CRITICAL_CASES.map(caseId=>{const item=results.get(caseId);return {caseId,status:item?.status||'unknown',receiptSha256:validHash(item?.receipt_sha256)?item.receipt_sha256.trim():null};});
  const invalidReceipts=caseRows.rows.some(x=>!validHash(x.receipt_sha256));
  const summaryCases=(run?.summary?.cases||[]).map(x=>({caseId:x.caseId,status:x.status,receiptSha256:x.receiptSha256})).sort((a,b)=>a.caseId.localeCompare(b.caseId));
  const persistedCases=caseRows.rows.map(x=>({caseId:x.case_id,status:x.status,receiptSha256:x.receipt_sha256?.trim()})).sort((a,b)=>a.caseId.localeCompare(b.caseId));
  const summaryMatches=same(summaryCases,persistedCases);
  if(!run||run.state!=='completed'||!validHash(run.summary_sha256)||run.summary_sha256.trim()!==digest(run.summary)||!bindingMatches||!componentsMatch||!summaryMatches||invalidReceipts){
   blockers.push({code:'application_conformance_unknown',status:'unknown',reason:'Completed conformance run is missing exact evaluation binding, current component fingerprints, or durable receipts.'});
  }
  if(critical.some(x=>x.status!=='passed'))blockers.push({code:'critical_conformance_cases_unknown',status:'unknown',cases:critical.filter(x=>x.status!=='passed').map(x=>({caseId:x.caseId,status:x.status}))});
  // The current case is only a permission-order test; it explicitly has no model-path hook.
  blockers.push({code:'model_order_unverified',status:'unknown',reason:'The application conformance receipt does not instrument model invocation order.'});
  const transport=results.get('transport_effect_receipt');
  if(transport?.status!=='passed')blockers.push({code:'transport_unverified',status:'unknown',reason:'No passing transport-effect receipt is available.'});
  conformance=run&&validHash(run.summary_sha256)?{id:run.id,summarySha256:run.summary_sha256.trim(),caseManifestVersion:run.case_manifest_version,caseManifestSha256:run.case_manifest_sha256.trim(),componentHashes:run.component_hashes,evaluationBinding:{evaluationRun:{id:binding?.evaluationRun?.id,snapshotSha256:binding?.evaluationRun?.snapshotSha256},dataset:{id:binding?.dataset?.id,manifestSha256:binding?.dataset?.manifestSha256},candidate:{id:binding?.candidate?.id,manifestSha256:binding?.candidate?.manifestSha256}},criticalCases:critical,transportStatus:transport?.status||'unknown'}:null;
 }else blockers.push({code:'application_conformance_unknown',status:'unknown',reason:'No completed application conformance run was selected.'});

    let validation=null;
 if(validationReportId){
  const q=await db.query(`SELECT id,report,report_sha256,baseline_run_id,candidate_run_id FROM astra.launch_validation_reports WHERE tenant_id=$1::uuid AND id=$2::uuid`,[tenantId,validationReportId]);
  const row=q.rows[0];
  if(!row||!validHash(row.report_sha256)||row.report_sha256.trim()!==digest(row.report)||row.report?.candidateRunId!==evaluationRunId||row.candidate_run_id!==evaluationRunId||row.report?.candidateCandidateId!==candidateId||row.report?.datasetId!==datasetId||row.report?.datasetManifestSha256!==datasetHash)blockers.push({code:'matched_comparison_unknown',status:'unknown',reason:'Selected matched comparison report is missing, hash-invalid, or not bound to this exact candidate evaluation and frozen dataset.'});
  else if(row.report?.promotion!=='blocked'&&row.report?.releaseReady!==false)blockers.push({code:'matched_comparison_unknown',status:'unknown',reason:'Selected comparison report has an invalid release state.'});
  else {
   validation={id:row.id,reportSha256:row.report_sha256.trim(),outcomeReportId:row.report.outcomes?.reportId||null,outcomes:row.report.outcomes||{status:'unknown'},heldOutCompanyTime:row.report.heldOutCompanyTime||{status:'unknown'},subgroups:row.report.subgroups||{status:'unknown'},overlap:row.report.overlap||'unknown',missingData:row.report.missingData||'unknown'};
   for(const [key,value] of [['outcome_comparison_unknown',validation.outcomes?.status],['subgroup_comparison_unknown',validation.subgroups?.status]])if(value!=='measured')blockers.push({code:key,status:'unknown'});
   if(validation.overlap!=='observed_arm_support_only'&&validation.overlap!=='measured')blockers.push({code:'overlap_unknown',status:'unknown'});
   if(validation.missingData!=='none')blockers.push({code:'missing_data_unknown',status:'unknown'});
  }
 }else blockers.push({code:'matched_comparison_unknown',status:'unknown',reason:'No persisted selected outcome comparison report was supplied.'});
 return {calibration,conformance,validation,blockers};
}

export async function resolveAstraOutcomeComparison(db,tenantId,{outcomeReportId,baselineCandidateId,candidateCandidateId,baselineMetrics,candidateMetrics}={}){
 if(!outcomeReportId)return {outcomes:{status:'unknown',reason:'No mature canonical outcome evidence was selected.'},overlap:'unknown',missingData:'unknown',subgroups:{status:'unknown',reason:'No matched subgroup comparison was computed.'}};
 const q=await db.query(`SELECT r.id,r.report,r.report_sha256,l.id AS lane_id FROM astra.bandit_evaluation_reports r
   JOIN astra.bandit_evaluation_lanes l ON(l.tenant_id,l.id)=(r.tenant_id,r.lane_id)
   WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid`,[tenantId,outcomeReportId]);
 const row=q.rows[0],report=row?.report;
 if(!row||!validHash(row.report_sha256)||row.report_sha256.trim()!==digest(report))return {outcomes:{status:'unknown',reason:'Selected canonical outcome report is unavailable or hash-invalid.'},overlap:'unknown',missingData:'unknown',subgroups:{status:'unknown',reason:'No matched subgroup comparison was computed.'}};
 const arms=await db.query(`SELECT arm_id,variant FROM astra.bandit_arm_registry WHERE tenant_id=$1::uuid AND experiment_id=$2::uuid`,[tenantId,report.experimentId]);
 const map=new Map(arms.rows.map(x=>[x.variant?.candidateId,x.arm_id]));
 const baseArm=map.get(baselineCandidateId),candidateArm=map.get(candidateCandidateId);
 const estimates=new Map((report.estimates||[]).map(x=>[x.armId,x]));
 const baseline=estimates.get(baseArm),candidate=estimates.get(candidateArm),diagnostics=report.diagnostics||{};
 const mature=Number.isSafeInteger(diagnostics.observationCount)&&diagnostics.observationCount>=MIN_HELD_OUT_COHORT&&diagnostics.matureCount===diagnostics.observationCount&&diagnostics.pendingCount===0&&diagnostics.censoredCount===0;
 const comparable=Boolean(baseArm&&candidateArm&&baseArm!==candidateArm&&mature&&baseline?.status==='diagnostic_estimate_only'&&candidate?.status==='diagnostic_estimate_only'&&Number.isFinite(baseline.ips)&&Number.isFinite(candidate.ips));
 const subgroup=(a,b)=>{
  const left=new Map((a?.subgroupUncertainty||[]).map(x=>[x.key||`${x.dimension||''}:${x.value||''}`,x]));
  const right=new Map((b?.subgroupUncertainty||[]).map(x=>[x.key||`${x.dimension||''}:${x.value||''}`,x]));
  const deltas=[];for(const [key,x]of left){const y=right.get(key);if(y&&x.count>=MIN_HELD_OUT_COHORT&&y.count>=MIN_HELD_OUT_COHORT&&Number.isFinite(x.accuracy)&&Number.isFinite(y.accuracy))deltas.push({key,baselineAccuracy:x.accuracy,candidateAccuracy:y.accuracy,delta:y.accuracy-x.accuracy,count:{baseline:x.count,candidate:y.count}});}
  return deltas.length?{status:'measured',comparisons:deltas}:{status:'unknown',reason:'No shared supported subgroup metrics.'};
 };
 const subgroups=subgroup(baselineMetrics,candidateMetrics);
 return {outcomes:comparable?{status:'measured',reportId:row.id,reportSha256:row.report_sha256.trim(),laneId:row.lane_id,metric:report.primaryMetric,baseline:{armId:baseArm,ips:baseline.ips,snips:baseline.snips,effectiveSampleSize:baseline.effectiveSampleSize},candidate:{armId:candidateArm,ips:candidate.ips,snips:candidate.snips,effectiveSampleSize:candidate.effectiveSampleSize},delta: candidate.ips-baseline.ips,cohort:diagnostics.observationCount}:{status:'unknown',reason:'Selected report does not contain mature, overlapping canonical outcome estimates for both selected candidates.'},overlap:comparable&&diagnostics.overlap==='observed_arm_support_only'?'observed_arm_support_only':'unknown',missingData:mature?'none':'unknown',subgroups};
}
