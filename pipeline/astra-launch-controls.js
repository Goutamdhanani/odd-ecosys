import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { resolveAstraSkill } from './astra-learning.js';
import { assertAstraDispatchEnabled } from './astra-operations.js';
import { resolveAstraOutcomeComparison, resolveAstraReleaseEvidence } from './astra-release-evidence.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const COMPONENTS=Object.freeze({harness:'astra-offline-deterministic/1.0.0',decision:'astra-decision/2',metric:'astra-eval-report/1.0.0'});
const fail=(message,statusCode=409,code='launch_control_blocked')=>{const e=new Error(message);e.statusCode=statusCode;e.code=code;throw e;};
const digest=value=>sha256(canonicalJson(value));
const sameJson=(a,b)=>canonicalJson(a)===canonicalJson(b);
function optionalUuid(value,name){if(value==null||value==='')return null;const normalized=String(value).toLowerCase();if(!UUID.test(normalized))fail(`${name} must be a UUID when supplied.`,400,'launch_input_invalid');return normalized;}
const LAUNCH_POLICY=Object.freeze({id:'astra-launch-policy-envelope',version:'1.0.0',sha256:digest({allowedHarness:COMPONENTS.harness,dispatchRequiresActiveRelease:true,independentSignoffs:['owner','reviewer'],killSwitchRequired:true,livePilotAllowed:false,syntheticShadowOnly:true,automaticPromotion:false})});
const text=(v,n,max=160)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(`${n} is required and bounded.`,400,'launch_input_invalid');return v.trim();};
function assertActor(actor,tenantId,roles=['owner','admin']){if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(tenantId).toLowerCase())fail('Verified tenant membership is required.',403,'tenant_membership_required');if(!roles.includes(actor.tenantRole||actor.role))fail('Tenant role does not allow this launch action.',403,'tenant_role_forbidden');if(!/^[1-9][0-9]{0,39}$/.test(String(actor.userId||'')))fail('A verified user is required.',401,'authenticated_user_required');}
const role=(actor)=>actor?.tenantRole||actor?.role;

async function loadEvaluatedRun(db,tenantId,runId){
 const r=await db.query(`SELECT r.id,r.dataset_id,r.scorer_id,r.snapshot,r.snapshot_sha256,r.report_sha256,r.report,r.state,r.budget,
   d.manifest_sha256 AS dataset_hash,d.label_rights,d.split_policy,s.version AS scorer_version,s.manifest_sha256 AS scorer_hash,
   c.id AS candidate_id,c.version AS candidate_version,c.variant_id,c.manifest_sha256 AS candidate_hash,c.created_by AS candidate_owner,
   d.created_by AS dataset_owner,s.created_by AS scorer_owner
   FROM astra.eval_runs r JOIN astra.eval_datasets d ON(d.tenant_id,d.id)=(r.tenant_id,r.dataset_id)
   JOIN astra.eval_scorers s ON(s.tenant_id,s.id)=(r.tenant_id,r.scorer_id)
   JOIN astra.eval_run_results rr ON(rr.tenant_id,rr.run_id)=(r.tenant_id,r.id)
   JOIN astra.eval_candidates c ON(c.tenant_id,c.id)=(rr.tenant_id,rr.candidate_id)
   WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND r.state='completed'`,[tenantId,runId]);
 if(!r.rows.length)fail('A completed evaluation run with frozen candidate results is required.',409,'launch_evaluation_required');
 return r.rows;
}
function validateCurrentComponentVersions(pins){
 if(!pins||typeof pins!=='object'||Array.isArray(pins))fail('Component version pins are required.',400,'launch_components_invalid');
 for(const key of ['harness','decision','metric']) if(pins[key]!==COMPONENTS[key])fail(`Unsupported ${key} version; only a registered evaluated version may be selected.`,409,'launch_component_unknown');
}

/** Create an immutable tenant release manifest from existing evaluated, approved facts. */
export async function prepareAstraLaunchRelease(db,actor,input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['name','version','sourceReleaseId','evaluationRunId','componentVersions','skillId','priorStableReleaseId','campaignId','calibrationArtifactId','conformanceRunId','validationReportId'].includes(k)))fail('Unsupported launch release fields.',400,'launch_input_invalid');
 const name=text(input.name,'name'),version=text(input.version,'version',80),sourceReleaseId=String(input.sourceReleaseId||'').toLowerCase(),evaluationRunId=String(input.evaluationRunId||'').toLowerCase();
 const campaignId=String(input.campaignId||'').toLowerCase();if(!UUID.test(sourceReleaseId)||!UUID.test(evaluationRunId)||!UUID.test(campaignId))fail('sourceReleaseId, evaluationRunId and campaignId must be UUIDs.',400,'launch_input_invalid');
 const campaign=await db.query(`SELECT id FROM astra.campaigns WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,campaignId]);if(!campaign.rowCount)fail('Campaign scope must exist in this tenant.',404,'campaign_not_found');
 validateCurrentComponentVersions(input.componentVersions);
 const priorId=input.priorStableReleaseId==null?null:String(input.priorStableReleaseId).toLowerCase();if(priorId&&!UUID.test(priorId))fail('priorStableReleaseId must be a UUID.',400,'launch_input_invalid');
 const base=await db.query(`SELECT id,status,manifest,manifest_sha256,candidate_id,evaluation_run_id,created_by FROM astra.release_artifacts WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,sourceReleaseId]);
 const release=base.rows[0];if(!release||release.status!=='approved_not_deployed'||release.evaluation_run_id!==evaluationRunId)fail('Source evaluation release must be approved and match the selected run.',409,'launch_source_release_unapproved');
 const rows=await loadEvaluatedRun(db,actor.tenantId,evaluationRunId);
 const candidateIds=new Set(rows.map(x=>x.candidate_id));if(!candidateIds.has(release.candidate_id))fail('Source release candidate is absent from the selected evaluation.',409,'launch_candidate_mismatch');
 const selected=rows.find(x=>x.candidate_id===release.candidate_id);if(!selected.report_sha256||!HASH.test(selected.report_sha256.trim())||!selected.snapshot_sha256||!HASH.test(selected.snapshot_sha256.trim()))fail('Frozen evaluation report or dataset snapshot hash is missing.',409,'launch_evaluation_hash_missing');
 const selectedVariant=selected.report?.variants?.find(v=>v.candidateId===selected.candidate_id);
 if(digest(selected.report)!==selected.report_sha256.trim()||digest(selected.snapshot)!==selected.snapshot_sha256.trim()||selected.report?.runId!==evaluationRunId||selected.report?.snapshotSha256!==selected.snapshot_sha256.trim()||selected.report?.datasetId!==selected.dataset_id||selected.report?.datasetManifestSha256!==selected.dataset_hash.trim()||selected.report?.scorerId!==selected.scorer_id||selected.report?.scorerManifestSha256!==selected.scorer_hash.trim()||selectedVariant?.candidateManifestSha256!==selected.candidate_hash.trim())fail('Evaluation report, snapshot, candidate, dataset, or scorer fingerprint does not match its persisted identity.',409,'launch_evaluation_identity_mismatch');
 const blockers=[];if(!selected.label_rights||selected.label_rights.attested!==true||!['synthetic_fixture','authorized','licensed','public_terms_permitted'].includes(selected.label_rights.basis))blockers.push({code:'dataset_rights_unknown',status:'unknown'});
 const skillId=String(input.skillId||'').toLowerCase();if(!UUID.test(skillId))fail('An explicitly evaluated tenant skill version is required.',409,'launch_skill_required');
 const skill=await db.query(`SELECT id,name,version,manifest_sha256,status,scope,created_by,evaluation_run_id FROM astra.skills WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,skillId]);
 const skillRow=skill.rows[0];if(!skillRow||!['approved','canary'].includes(skillRow.status)||skillRow.evaluation_run_id!==evaluationRunId)fail('Only a compatible evaluated and approved tenant skill may be selected.',409,'launch_skill_incompatible');
 const prior=priorId?await db.query(`SELECT id,manifest_sha256,status FROM astra.launch_releases WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,priorId]):null;
 if(priorId&&(!prior?.rows[0]||prior.rows[0].status!=='approved_not_deployed'))fail('Prior stable pointer must be a same-tenant approved release manifest.',409,'launch_prior_stable_invalid');
 const measured=selectedVariant?.metrics;
 const variants=selected.report?.variants||[];const matchedVariants=['H0','H1','H2','H3'];
 if(!selected.report?.matchedBudget||selected.report?.pairedBy!=='same frozen holdout example IDs'||!sameJson(selected.budget,selected.report?.budget)||matchedVariants.some(v=>!variants.some(x=>x.variantId===v))||variants.length!==4)blockers.push({code:'harness_comparison_unknown',status:'unknown'});
 if(!Number.isFinite(measured?.criticalHarmRate)||!Number.isFinite(measured?.criticalCaseCount)||measured.criticalCaseCount<1)blockers.push({code:'adversarial_evidence_unknown',status:'unknown'});
 const evidence=await resolveAstraReleaseEvidence(db,actor.tenantId,{sourceReleaseId,evaluationRunId,datasetId:selected.dataset_id,datasetHash:selected.dataset_hash.trim(),candidateId:selected.candidate_id,candidateHash:selected.candidate_hash.trim(),calibrationArtifactId:optionalUuid(input.calibrationArtifactId,'calibrationArtifactId'),conformanceRunId:optionalUuid(input.conformanceRunId,'conformanceRunId'),validationReportId:optionalUuid(input.validationReportId,'validationReportId')});
 blockers.push(...evidence.blockers);
 const manifest={schemaVersion:'astra-launch-release/1.0.0',name,version,tenantId:String(actor.tenantId).toLowerCase(),campaignId,sourceRelease:{id:sourceReleaseId,manifestSha256:release.manifest_sha256.trim(),status:release.status},evaluation:{runId:evaluationRunId,reportSha256:selected.report_sha256.trim(),snapshotSha256:selected.snapshot_sha256.trim(),datasetId:selected.dataset_id,datasetManifestSha256:selected.dataset_hash.trim(),candidateId:selected.candidate_id,candidateVersion:selected.candidate_version,candidateManifestSha256:selected.candidate_hash.trim(),scorerId:selected.scorer_id,scorerVersion:selected.scorer_version,scorerManifestSha256:selected.scorer_hash.trim(),matchedBudget:selected.report?.budget||null,pairedBy:selected.report?.pairedBy||'unknown',variants:variants.map(x=>({candidateId:x.candidateId,variantId:x.variantId,candidateManifestSha256:x.candidateManifestSha256,resultSha256:x.resultSha256,metrics:x.metrics}))},evidence:{calibration:evidence.calibration,conformance:evidence.conformance,validation:evidence.validation},components:{...input.componentVersions,policy:LAUNCH_POLICY,skill:{id:skillRow.id,name:skillRow.name,version:skillRow.version,manifestSha256:skillRow.manifest_sha256.trim(),status:skillRow.status}},priorStablePointer:priorId?{id:priorId,manifestSha256:prior.rows[0].manifest_sha256.trim()}:null,blockingEvidence:blockers,rollout:{mode:'shadow_or_canary_preparation_only',livePilotAllowed:false,automaticPromotion:false},releaseReady:false};
 const manifestSha256=digest(manifest);const id=randomUUID();
 await db.query(`INSERT INTO astra.launch_releases(tenant_id,id,name,version,source_release_id,manifest,manifest_sha256,prior_stable_release_id,status,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb,$7,$8::uuid,'pending_approval',$9)`,[actor.tenantId,id,name,version,sourceReleaseId,JSON.stringify(manifest),manifestSha256,priorId,String(actor.userId)]);
 await db.query(`INSERT INTO astra.launch_release_evidence(tenant_id,launch_release_id,calibration_artifact_id,calibration_artifact_sha256,conformance_run_id,conformance_summary_sha256,validation_report_id,validation_report_sha256,outcome_report_id)
  VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,$7::uuid,$8,$9::uuid)`,[actor.tenantId,id,evidence.calibration?.id||null,evidence.calibration?.artifactSha256||null,evidence.conformance?.id||null,evidence.conformance?.summarySha256||null,evidence.validation?.id||null,evidence.validation?.reportSha256||null,evidence.validation?.outcomeReportId||null]);
 return {id,name,version,manifest,manifestSha256,status:'pending_approval',releaseReady:false,live:false};
}

export async function signoffAstraLaunchRelease(db,actor,releaseId,{decision,reasonCode}={}){
 if(!UUID.test(String(releaseId))||!['approve','reject'].includes(decision))fail('Valid releaseId and decision are required.',400,'launch_input_invalid');
 const reason=text(reasonCode,'reasonCode',80),r=await db.query(`SELECT id,status,manifest_sha256,created_by,source_release_id FROM astra.launch_releases WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,[actor.tenantId,releaseId]);
 const release=r.rows[0];if(!release||release.status!=='pending_approval')fail('Only a pending tenant release can receive independent signoff.',409,'launch_release_not_pending');if(release.manifest.blockingEvidence?.length)fail('Unknown evaluation, calibration, adversarial, or rights evidence blocks release signoff.',409,'launch_evidence_unknown');if(String(actor.userId)===String(release.created_by))fail('Release author cannot sign off their own manifest.',403,'launch_signoff_independence_required');
 const source=await db.query(`SELECT r.candidate_id,r.evaluation_run_id,c.created_by candidate_owner,d.created_by dataset_owner,s.created_by scorer_owner FROM astra.release_artifacts r JOIN astra.eval_candidates c ON(c.tenant_id,c.id)=(r.tenant_id,r.candidate_id) JOIN astra.eval_runs e ON(e.tenant_id,e.id)=(r.tenant_id,r.evaluation_run_id) JOIN astra.eval_datasets d ON(d.tenant_id,d.id)=(e.tenant_id,e.dataset_id) JOIN astra.eval_scorers s ON(s.tenant_id,s.id)=(e.tenant_id,e.scorer_id) WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid`,[actor.tenantId,release.source_release_id]);
 const owners=source.rows[0];if(!owners||[owners.candidate_owner,owners.dataset_owner,owners.scorer_owner].includes(String(actor.userId)))fail('Candidate, dataset, and scorer authors cannot sign off this release.',403,'launch_component_author_forbidden');
 const result=await db.query(`INSERT INTO astra.launch_release_signoffs(tenant_id,release_id,approval_role,decision,reason_code,manifest_sha256,approved_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING approval_role`,[actor.tenantId,releaseId,role(actor),decision,reason,release.manifest_sha256.trim(),String(actor.userId)]);if(!result.rowCount)fail('This membership role has already signed off this manifest.',409,'launch_signoff_exists');
 const signs=await db.query(`SELECT approval_role,decision,approved_by FROM astra.launch_release_signoffs WHERE tenant_id=$1::uuid AND release_id=$2::uuid`,[actor.tenantId,releaseId]);const owner=signs.rows.find(x=>x.approval_role==='owner'),reviewer=signs.rows.find(x=>x.approval_role==='reviewer');let status='pending_approval';if(owner?.decision==='reject'||reviewer?.decision==='reject'){status='rejected';await db.query(`UPDATE astra.launch_releases SET status='rejected' WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,releaseId]);}else if(owner?.decision==='approve'&&reviewer?.decision==='approve'){if(owner.approved_by===reviewer.approved_by)fail('Owner and reviewer signoffs must be independent.',409,'launch_signoff_independence_required');status='approved_not_deployed';await db.query(`UPDATE astra.launch_releases SET status='approved_not_deployed' WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,releaseId]);}
 return {status,live:false,releaseReady:false,approvalState:status==='approved_not_deployed'?'approved_not_deployed':'pending_or_rejected'};
}

async function appendEvent(db,actor,releaseId,kind,payload){const clean={...payload,recordedAt:new Date().toISOString()};const h=digest(clean);await db.query(`INSERT INTO astra.launch_release_events(tenant_id,release_id,kind,payload,payload_sha256,created_by) VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6)`,[actor.tenantId,releaseId,kind,JSON.stringify(clean),h,String(actor.userId)]);return {kind,payload:clean,payloadSha256:h};}
export async function prepareAstraShadow(db,actor,{releaseId,cohortRef,checkpointRef,idMapping,rollbackPlan,exceptionWorkflow}={}){
 if(!UUID.test(String(releaseId))||!['synthetic','synthetic_fixture'].includes(cohortRef?.kind)||typeof cohortRef?.datasetId!=='string'||!UUID.test(cohortRef.datasetId))fail('Only a bounded synthetic frozen evaluation cohort can be prepared for local shadow.',409,'launch_shadow_cohort_invalid');
 const rel=await db.query(`SELECT status,manifest,manifest_sha256 FROM astra.launch_releases WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,releaseId]);if(rel.rows[0]?.status!=='approved_not_deployed')fail('Shadow preparation requires an independently approved tenant manifest.',409,'launch_release_unapproved');
 const dataset=await db.query(`SELECT id,manifest_sha256,label_rights,status FROM astra.eval_datasets WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,cohortRef.datasetId]);if(!dataset.rows[0]||dataset.rows[0].status!=='frozen'||dataset.rows[0].label_rights?.basis!=='synthetic_fixture'||dataset.rows[0].label_rights?.attested!==true||dataset.rows[0].manifest_sha256.trim()!==rel.rows[0].manifest.evaluation.datasetManifestSha256)fail('Shadow cohort must be the exact frozen synthetic evaluation dataset.',409,'launch_shadow_cohort_invalid');
 const disabledBaseline=rel.rows[0].manifest.priorStablePointer==null&&rollbackPlan?.priorReleaseId==='disabled';
 if(!checkpointRef||typeof checkpointRef!=='object'||!HASH.test(String(checkpointRef.sha256||''))||!idMapping||idMapping.kind!=='synthetic_id_map'||!HASH.test(String(idMapping.sha256||''))||!rollbackPlan||typeof rollbackPlan.priorReleaseId!=='string'||(!UUID.test(rollbackPlan.priorReleaseId)&&!disabledBaseline)||!exceptionWorkflow||typeof exceptionWorkflow!=='object'||Array.isArray(exceptionWorkflow))fail('Checkpoint, hashed synthetic ID map, rollback target and exception workflow plan are required.',400,'launch_shadow_incomplete');
 if(!disabledBaseline&&rel.rows[0].manifest.priorStablePointer?.id!==rollbackPlan.priorReleaseId)fail('Rollback target must match the immutable prior stable pointer.',409,'launch_rollback_pointer_mismatch');
 const rollbackTarget=disabledBaseline?{kind:'disabled_baseline',live:false}: {kind:'approved_prior_release',id:rollbackPlan.priorReleaseId,manifestSha256:rel.rows[0].manifest.priorStablePointer.manifestSha256};
 const event=await appendEvent(db,actor,releaseId,'shadow_prepared',{mode:'local_synthetic_shadow_only',cohortRef,checkpointRef,idMapping,rollbackPlan,rollbackTarget,exceptionWorkflow:{proposed:exceptionWorkflow,dailyReview:{required:true,cadenceHours:24,state:'prepared_not_active',approvalRequired:true}},liveActions:false});
 return {...event,releaseReady:false,live:false};
}
export async function prepareAstraCanary(db,actor,{releaseId,cohortRef,checkpointRef,idMapping,rollbackPlan,exceptionWorkflow}={}){
 if(cohortRef?.kind!=='synthetic'||cohortRef?.live===true)fail('Live canary cohorts remain explicitly blocked pending separate real approvals.',409,'launch_live_pilot_blocked');
 return prepareAstraShadow(db,actor,{releaseId,cohortRef,checkpointRef,idMapping,rollbackPlan,exceptionWorkflow});
}
export async function revokeAstraLaunchRelease(db,actor,releaseId,{reasonCode}={}){
 if(!UUID.test(String(releaseId)))fail('releaseId must be a UUID.',400,'launch_input_invalid');const reason=text(reasonCode,'reasonCode',80);
 const r=await db.query(`UPDATE astra.launch_releases SET status='revoked' WHERE tenant_id=$1::uuid AND id=$2::uuid AND status IN ('pending_approval','approved_not_deployed') RETURNING manifest_sha256`,[actor.tenantId,releaseId]);if(!r.rowCount)fail('Only a pending or approved_not_deployed release may be revoked.',409,'launch_release_transition_invalid');
 const stale=await db.query(`UPDATE astra.workflows SET state='cancelled',lease_owner=NULL,lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now(),last_error_code='launch_release_revoked' WHERE tenant_id=$1::uuid AND state IN ('queued','checkpointed') AND task #>> '{versionPins,releaseId}'=$2 RETURNING id`,[actor.tenantId,releaseId]);
 const pointer=await db.query(`SELECT campaign_id FROM astra.launch_active_pointers WHERE tenant_id=$1::uuid AND release_id=$2::uuid`,[actor.tenantId,releaseId]);
 let invalidatedTicketCount=0;
 if(pointer.rowCount){
   const tickets=await db.query(`SELECT astra.revoke_issued_execution_tickets($1::uuid,$2::uuid,$3) AS count`,[actor.tenantId,pointer.rows[0].campaign_id,`launch_release_revoked:${reason}`]);
   invalidatedTicketCount=Number(tickets.rows[0].count);
 }
 const event=await appendEvent(db,actor,releaseId,'revoked',{reasonCode:reason,invalidatedWorkflowIds:stale.rows.map(x=>x.id),pointerCampaignId:pointer.rows[0]?.campaign_id||null,invalidatedTicketCount,manifestSha256:r.rows[0].manifest_sha256.trim()});return {...event,invalidatedTaskCount:stale.rowCount,invalidatedTicketCount,live:false,releaseReady:false};
}
export async function rollbackAstraLaunchPointer(db,actor,{fromReleaseId,targetReleaseId,reasonCode}={}){
 if(!UUID.test(String(fromReleaseId))||!UUID.test(String(targetReleaseId))||fromReleaseId===targetReleaseId)fail('Distinct source and target release IDs are required.',400,'launch_input_invalid');
 const reason=text(reasonCode,'reasonCode',80),rows=await db.query(`SELECT id,status,manifest_sha256,prior_stable_release_id FROM astra.launch_releases WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,[actor.tenantId,[fromReleaseId,targetReleaseId]]);
 const from=rows.rows.find(x=>x.id===fromReleaseId),target=rows.rows.find(x=>x.id===targetReleaseId);if(from?.status!=='approved_not_deployed'||target?.status!=='approved_not_deployed'||from.prior_stable_release_id!==targetReleaseId)fail('Rollback must point to the immutable approved prior release.',409,'launch_rollback_pointer_mismatch');
 return {...await appendEvent(db,actor,fromReleaseId,'rollback_recorded',{targetReleaseId,fromManifestSha256:from.manifest_sha256.trim(),targetManifestSha256:target.manifest_sha256.trim(),reasonCode:reason,effect:'pointer_only_no_deployment'}),live:false,releaseReady:false};
}

/** Compare only completed runs over the identical frozen dataset and scorer. */
export async function compareAstraLaunchRuns(db,actor,{baselineRunId,candidateRunId,baselineCandidateId,candidateCandidateId,outcomeReportId}={}){
 if(!UUID.test(String(baselineRunId))||!UUID.test(String(candidateRunId))||!UUID.test(String(baselineCandidateId||''))||!UUID.test(String(candidateCandidateId||''))||String(baselineCandidateId).toLowerCase()===String(candidateCandidateId).toLowerCase())fail('Distinct valid run and candidate IDs are required.',400,'launch_validation_input_invalid');
 baselineCandidateId=String(baselineCandidateId).toLowerCase();candidateCandidateId=String(candidateCandidateId).toLowerCase();
 const runs=await Promise.all([loadEvaluatedRun(db,actor.tenantId,baselineRunId),loadEvaluatedRun(db,actor.tenantId,candidateRunId)]),a=runs[0],b=runs[1];
 if(a[0].dataset_id!==b[0].dataset_id||a[0].dataset_hash!==b[0].dataset_hash||a[0].scorer_id!==b[0].scorer_id||a[0].scorer_hash!==b[0].scorer_hash)fail('Runs must share the exact frozen dataset and scorer.',409,'launch_validation_context_mismatch');
 if(!sameJson(a[0].budget,b[0].budget)||!a[0].report?.matchedBudget||!b[0].report?.matchedBudget||a[0].report?.pairedBy!=='same frozen holdout example IDs'||b[0].report?.pairedBy!=='same frozen holdout example IDs')fail('Matched comparison requires identical frozen example and budget lineage.',409,'launch_validation_context_mismatch');
 const oldA=a.find(x=>x.candidate_id===baselineCandidateId),newB=b.find(x=>x.candidate_id===candidateCandidateId);if(!oldA||!newB)fail('Selected baseline and candidate must both be present in their frozen evaluation runs.',409,'launch_validation_candidate_missing');const metricsOld=oldA.report?.variants?.find(v=>v.candidateId===baselineCandidateId)?.metrics,metricsNew=newB.report?.variants?.find(v=>v.candidateId===candidateCandidateId)?.metrics;const comparisons=[{baselineCandidateId,candidateCandidateId,metrics:metricDeltas(metricsOld,metricsNew)}];
 const outcome=await resolveAstraOutcomeComparison(db,actor.tenantId,{outcomeReportId:optionalUuid(outcomeReportId,'outcomeReportId'),baselineCandidateId,candidateCandidateId,baselineMetrics:metricsOld,candidateMetrics:metricsNew});
 const report={schemaVersion:'astra-controlled-validation/1.0.0',baselineRunId,candidateRunId,baselineCandidateId,candidateCandidateId,datasetId:a[0].dataset_id,datasetManifestSha256:a[0].dataset_hash.trim(),scorerId:a[0].scorer_id,scorerVersion:a[0].scorer_version,snapshotSha256:a[0].snapshot_sha256.trim(),budget:a[0].budget,pairedBy:'same frozen holdout example IDs',baselineReportHashes:[...new Set(a.map(x=>x.report_sha256?.trim()).filter(Boolean))].sort(),candidateReportHashes:[...new Set(b.map(x=>x.report_sha256?.trim()).filter(Boolean))].sort(),comparisons,outcomes:outcome.outcomes,heldOutCompanyTime:{status:'unknown',reason:'Run-level frozen split policy does not prove independent held-out company/time comparison.'},subgroups:outcome.subgroups,missingData:outcome.missingData,overlap:outcome.overlap,promotion:'blocked',releaseReady:false};
 const reportSha256=digest(report),id=randomUUID();await db.query(`INSERT INTO astra.launch_validation_reports(tenant_id,id,baseline_run_id,candidate_run_id,report,report_sha256,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6,$7)`,[actor.tenantId,id,baselineRunId,candidateRunId,JSON.stringify(report),reportSha256,String(actor.userId)]);return {id,report,reportSha256,releaseReady:false};
}
function metricDeltas(a,b){if(!a||!b||typeof a!=='object'||typeof b!=='object')return {status:'unknown',reason:'Metric result missing.'};const deltas={};for(const k of Object.keys(a).sort()){if(typeof a[k]==='number'&&Number.isFinite(a[k])&&typeof b[k]==='number'&&Number.isFinite(b[k]))deltas[k]={baseline:a[k],candidate:b[k],delta:b[k]-a[k]};}return Object.keys(deltas).length?{status:'measured',deltas}:{status:'unknown',reason:'No comparable numeric metrics.'};}

/** Current code versions are allow-listed; active deployment is intentionally unsupported. */
export async function assertAstraLaunchTaskCompatible(db,tenantId,task){
 const pins=task?.versionPins||{};
 let activeRelease=null;
 if(pins.releaseId||pins.manifestSha256){
  if(process.env.ASTRA_LAUNCH_ACTIVATION_AUTHORIZED!=='enabled'||process.env.ASTRA_S01_COMMERCIAL_PRIVACY_AUTHORIZED!=='enabled')fail('Current server-side S01/X14 authority is disabled.',409,'launch_activation_unavailable');
  const active=await db.query(`SELECT r.id,r.manifest,r.manifest_sha256 AS manifest_hash,p.campaign_id,p.manifest_sha256 AS pointer_hash FROM astra.launch_active_pointers p JOIN astra.launch_releases r ON(r.tenant_id,r.id)=(p.tenant_id,p.release_id) WHERE p.tenant_id=$1::uuid AND r.status='approved_not_deployed'`,[tenantId]);
  const row=active.rows[0];if(!row||row.id!==pins.releaseId||row.manifest_hash.trim()!==pins.manifestSha256||row.pointer_hash.trim()!==row.manifest_hash.trim()||row.manifest.blockingEvidence?.length)fail('Pinned release is stale, blocked, or not the tenant active pointer.',409,'launch_release_stale');
  const taskCampaign=task?.campaignId||task?.campaign_id||task?.task?.campaignId;if(taskCampaign&&String(taskCampaign).toLowerCase()!==String(row.campaign_id).toLowerCase())fail('Pinned active release is outside this task campaign scope.',409,'launch_release_stale');
  validateCurrentComponentVersions(row.manifest.components);activeRelease=row;
 }
 if(pins.skillId||pins.skillVersion){
  const skill=await resolveAstraLaunchSkill(db,tenantId,{skillId:pins.skillId,version:pins.skillVersion,scope:task?.task?.scope||{}});
  if(!skill||pins.skillManifestSha256&&pins.skillManifestSha256!==skill.manifest_sha256.trim())fail('Task skill pin does not resolve to a compatible approved tenant skill.',409,'launch_skill_incompatible');
 }
 if(task?.purpose==='research'&&(!task.egressMode||task.egressMode==='NO_MODEL_EGRESS'))return {mode:'offline_synthetic_preview',compatible:true,releaseId:null};
 if(!pins.releaseId||!UUID.test(String(pins.releaseId)))fail('Side-effect tasks require an active compatible approved release.',409,'launch_release_required');
 if(!activeRelease)fail('Side-effect tasks require a tenant active release pointer.',409,'launch_release_required');
 await assertAstraDispatchEnabled(db,tenantId,activeRelease.campaign_id);
 return {mode:'internally_authorized_active_release',compatible:true,releaseId:activeRelease.id,campaignId:activeRelease.campaign_id,manifestSha256:activeRelease.manifest_hash.trim(),live:false,releaseReady:false};
}
export async function assertAstraLaunchDispatchCompatible(db,tenantId,ticket){
 if(process.env.ASTRA_LAUNCH_ACTIVATION_AUTHORIZED!=='enabled'||process.env.ASTRA_S01_COMMERCIAL_PRIVACY_AUTHORIZED!=='enabled'||process.env.ASTRA_LAUNCH_LIVE_DISPATCH_AUTHORIZED!=='enabled')fail('Current server-side S01/X14/live-dispatch authority is disabled.',409,'launch_activation_unavailable');
 const id=ticket?.campaign_id||ticket?.campaignId;const q=await db.query(`SELECT r.id,r.status,r.manifest,r.manifest_sha256 AS manifest_hash,p.campaign_id,p.manifest_sha256 AS pointer_hash FROM astra.launch_active_pointers p JOIN astra.launch_releases r ON(r.tenant_id,r.id)=(p.tenant_id,p.release_id) WHERE p.tenant_id=$1::uuid`,[tenantId]);
 if(!q.rowCount)fail('No active approved tenant release exists; production dispatch remains blocked.',409,'launch_release_required');
 const active=q.rows[0],m=active.manifest,versions=m.components||{};if(active.status!=='approved_not_deployed'||active.campaign_id!==id||active.manifest_hash.trim()!==active.pointer_hash.trim()||m.blockingEvidence?.length)fail('Active launch pointer is stale, blocked, or out of campaign scope.',409,'launch_release_stale');validateCurrentComponentVersions(versions);
 const skill=await resolveAstraLaunchSkill(db,tenantId,{skillId:versions.skill?.id,version:versions.skill?.version,scope:ticket?.intent?.skillScope||{}});
 if(!skill||skill.manifest_sha256.trim()!==versions.skill?.manifestSha256)fail('Active release skill pin is stale or incompatible.',409,'launch_skill_incompatible');
 return {compatible:true,releaseId:active.id,manifestSha256:active.manifest_hash.trim()};
}

/** Internal-only prepared pointer transition. Default-off server flags and external S01 authority are mandatory. */
export async function activateAstraLaunchPointerInternally(db,actor,{releaseId,campaignId}={}){
 if(role(actor)!=='owner')fail('An owner membership is required.',403,'tenant_role_forbidden');
 if(process.env.ASTRA_LAUNCH_ACTIVATION_AUTHORIZED!=='enabled'||process.env.ASTRA_S01_COMMERCIAL_PRIVACY_AUTHORIZED!=='enabled')fail('Launch activation is disabled until explicit server-side X14 and S01 authority is configured.',409,'launch_activation_unavailable');
 if(!UUID.test(String(releaseId))||!UUID.test(String(campaignId)))fail('Valid release and campaign IDs are required.',400,'launch_input_invalid');
 const q=await db.query(`SELECT r.id,r.status,r.manifest,r.manifest_sha256 AS manifest_hash,s.created_by AS source_release_author,
   count(DISTINCT a.approval_role) FILTER(WHERE a.decision='approve' AND a.manifest_sha256=r.manifest_sha256)::int AS approved_roles,
   count(DISTINCT a.approved_by) FILTER(WHERE a.decision='approve' AND a.manifest_sha256=r.manifest_sha256)::int AS independent_approvers,
   count(DISTINCT sa.approval_role) FILTER(WHERE sa.decision='approve')::int AS source_approved_roles,
   count(DISTINCT sa.approved_by) FILTER(WHERE sa.decision='approve')::int AS source_independent_approvers
   FROM astra.launch_releases r JOIN astra.release_artifacts s ON(s.tenant_id,s.id)=(r.tenant_id,r.source_release_id)
   LEFT JOIN astra.launch_release_signoffs a ON(a.tenant_id,a.release_id)=(r.tenant_id,r.id)
   LEFT JOIN astra.release_approvals sa ON(sa.tenant_id,sa.release_id)=(s.tenant_id,s.id)
   WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND s.status='approved_not_deployed'
   GROUP BY r.id,r.status,r.manifest,r.manifest_sha256,s.created_by`,[actor.tenantId,releaseId]);
 const r=q.rows[0];if(!r||r.status!=='approved_not_deployed'||r.manifest.blockingEvidence?.length||r.manifest.campaignId!==campaignId||r.approved_roles!==2||r.independent_approvers!==2||r.source_approved_roles!==2||r.source_independent_approvers!==2)fail('Release requires campaign binding, independent launch/source signoffs, and complete compatible evidence.',409,'launch_activation_evidence_blocked');
 validateCurrentComponentVersions(r.manifest.components);const skill=await resolveAstraLaunchSkill(db,actor.tenantId,{skillId:r.manifest.components.skill.id,version:r.manifest.components.skill.version,scope:{}});if(!skill||skill.manifest_sha256.trim()!==r.manifest.components.skill.manifestSha256)fail('Release skill is not currently compatible.',409,'launch_skill_incompatible');
 const campaign=await db.query(`SELECT id FROM astra.campaigns WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,campaignId]);if(!campaign.rowCount)fail('Campaign is outside this tenant.',404,'campaign_not_found');
 await assertAstraDispatchEnabled(db,actor.tenantId,campaignId);
 const previous=await db.query(`SELECT release_id,campaign_id FROM astra.launch_active_pointers WHERE tenant_id=$1::uuid`,[actor.tenantId]);
 await db.query(`INSERT INTO astra.launch_active_pointers(tenant_id,release_id,campaign_id,manifest_sha256,changed_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET release_id=EXCLUDED.release_id,campaign_id=EXCLUDED.campaign_id,manifest_sha256=EXCLUDED.manifest_sha256,changed_by=EXCLUDED.changed_by,changed_at=now()`,[actor.tenantId,releaseId,campaignId,r.manifest_hash.trim(),String(actor.userId)]);
 let invalidatedTicketCount=0;
 if(previous.rowCount){
   const tickets=await db.query(`SELECT astra.revoke_issued_execution_tickets($1::uuid,$2::uuid,$3) AS count`,[actor.tenantId,previous.rows[0].campaign_id,'launch_pointer_changed']);
   invalidatedTicketCount=Number(tickets.rows[0].count);
 }
 const staleWork=await db.query(`UPDATE astra.workflows SET state='cancelled',lease_owner=NULL,lease_token=NULL,lease_until=NULL,completed_at=now(),updated_at=now(),last_error_code='launch_release_stale' WHERE tenant_id=$1::uuid AND state IN ('queued','checkpointed') AND task #>> '{versionPins,releaseId}' IS NOT NULL AND task #>> '{versionPins,releaseId}'<>$2 RETURNING id`,[actor.tenantId,releaseId]);
 const staleDrafts=await db.query(`UPDATE astra.generation_jobs SET state='cancelled',completed_at=now(),error_code='launch_release_stale' WHERE tenant_id=$1::uuid AND state='queued' AND COALESCE(input_payload #>> '{versionPins,releaseId}',input_payload->>'releaseId') IS NOT NULL AND COALESCE(input_payload #>> '{versionPins,releaseId}',input_payload->>'releaseId')<>$2 RETURNING id`,[actor.tenantId,releaseId]);
 await appendEvent(db,actor,releaseId,'pointer_activated',{campaignId,priorReleaseId:previous.rows[0]?.release_id||null,manifestSha256:r.manifest_hash.trim(),invalidatedTaskCount:staleWork.rowCount,invalidatedDraftCount:staleDrafts.rowCount,invalidatedTicketCount,effect:'tenant_pointer_only_no_deployment'});
 return {releaseId,campaignId,status:'prepared_pointer_active',invalidatedTaskCount:staleWork.rowCount,invalidatedDraftCount:staleDrafts.rowCount,invalidatedTicketCount,liveActions:false,deployed:false,releaseReady:false};
}
export async function rollbackAstraLaunchPointerInternally(db,actor,{fromReleaseId,targetReleaseId,campaignId}={}){
 const active=await db.query(`SELECT release_id,campaign_id FROM astra.launch_active_pointers WHERE tenant_id=$1::uuid`,[actor.tenantId]);if(active.rows[0]?.release_id!==fromReleaseId)fail('Rollback source is not the current tenant pointer.',409,'launch_rollback_pointer_mismatch');
 const source=await db.query(`SELECT manifest FROM astra.launch_releases WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,fromReleaseId]);if(source.rows[0]?.manifest.priorStablePointer?.id!==targetReleaseId)fail('Rollback target does not match the signed prior stable pointer.',409,'launch_rollback_pointer_mismatch');
 const target=await db.query(`SELECT manifest FROM astra.launch_releases WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,targetReleaseId]);if(!target.rows[0]||target.rows[0].manifest.campaignId!==campaignId)fail('Rollback target campaign scope is invalid.',409,'launch_rollback_pointer_mismatch');
 return activateAstraLaunchPointerInternally(db,actor,{releaseId:targetReleaseId,campaignId});
}
export async function resolveAstraLaunchSkill(db,tenantId,{skillId,version,scope}={}){const skill=await resolveAstraSkill(db,tenantId,{skillId,version,scope});if(!skill)return null;const q=await db.query(`SELECT 1 FROM astra.launch_active_pointers p JOIN astra.launch_releases r ON(r.tenant_id,r.id)=(p.tenant_id,p.release_id) WHERE p.tenant_id=$1::uuid AND r.status='approved_not_deployed' AND p.manifest_sha256=r.manifest_sha256 AND r.manifest #>> '{components,skill,id}'=$2 AND r.manifest #>> '{components,skill,version}'=$3 AND r.manifest #>> '{components,skill,manifestSha256}'=$4 LIMIT 1`,[tenantId,skillId,version,skill.manifest_sha256.trim()]);return q.rowCount?skill:null;}

export function registerAstraLaunchRoutes(registerAstraApiRoute,{store}={}){
 if(typeof registerAstraApiRoute!=='function')throw new TypeError('registerAstraApiRoute is required.');
 const base='^/api/astra/tenants/(?<tenantId>[0-9a-fA-F-]{36})/launch';
 const reg=(method,path,handler,allowedRoles)=>registerAstraApiRoute({method,path:new RegExp(`${base}${path}$`),handler,allowedRoles});
 const context=(actor,params)=>{assertActor(actor,params.tenantId,['owner','admin','operator','reviewer']);};
 reg('GET','/releases',async(_req,_res,{actor,params,db})=>{context(actor,params);const r=await db.query(`SELECT id,name,version,manifest,manifest_sha256 AS "manifestSha256",prior_stable_release_id AS "priorStableReleaseId",status,created_at AS "createdAt" FROM astra.launch_releases WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT 100`,[actor.tenantId]);return {items:r.rows,activeRelease:null,live:false,releaseReady:false};},['owner','admin','operator','reviewer']);
 reg('POST','/releases',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return {status:201,body:{release:await prepareAstraLaunchRelease(db,actor,await readJson(req,32*1024))}};},['owner','admin']);
 reg('POST','/releases/(?<releaseId>[0-9a-fA-F-]{36})/signoff',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return signoffAstraLaunchRelease(db,actor,params.releaseId,await readJson(req,4096));},['owner','reviewer']);
 reg('POST','/releases/(?<releaseId>[0-9a-fA-F-]{36})/shadow',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return prepareAstraShadow(db,actor,{...await readJson(req,16*1024),releaseId:params.releaseId});},['owner','admin','operator']);
 reg('POST','/releases/(?<releaseId>[0-9a-fA-F-]{36})/canary',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return prepareAstraCanary(db,actor,{...await readJson(req,16*1024),releaseId:params.releaseId});},['owner','admin']);
 reg('POST','/releases/(?<releaseId>[0-9a-fA-F-]{36})/revoke',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return revokeAstraLaunchRelease(db,actor,params.releaseId,await readJson(req,4096));},['owner']);
 reg('POST','/rollback',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return rollbackAstraLaunchPointer(db,actor,await readJson(req,4096));},['owner']);
 reg('POST','/validation/compare',async(req,_res,{actor,params,db,readJson})=>{context(actor,params);return {validation:await compareAstraLaunchRuns(db,actor,await readJson(req,4096))};},['owner','admin','reviewer']);
 reg('GET','/validation',async(_req,_res,{actor,params,db})=>{context(actor,params);const r=await db.query(`SELECT id,baseline_run_id AS "baselineRunId",candidate_run_id AS "candidateRunId",report,report_sha256 AS "reportSha256",created_at AS "createdAt" FROM astra.launch_validation_reports WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT 100`,[actor.tenantId]);return {items:r.rows};},['owner','admin','reviewer']);
 return {registered:['GET|POST /api/astra/tenants/:tenantId/launch/releases','POST /api/astra/tenants/:tenantId/launch/releases/:releaseId/signoff','POST /api/astra/tenants/:tenantId/launch/releases/:releaseId/shadow','POST /api/astra/tenants/:tenantId/launch/releases/:releaseId/canary','POST /api/astra/tenants/:tenantId/launch/releases/:releaseId/revoke','POST /api/astra/tenants/:tenantId/launch/rollback','GET|POST /api/astra/tenants/:tenantId/launch/validation'],liveActivation:false,livePilotAllowed:false,releaseReady:false};
}







