import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { readAstraSourceRights } from './astra-source-rights.js';

const fail=(message,statusCode=400,code='benchmark_invalid')=>{throw new AstraTenantContextError(message,statusCode,code);};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const id=(x,name='id')=>{if(typeof x!=='string'||!UUID.test(x))fail(`${name} must be a UUID.`);return x.toLowerCase();};
const str=(x,name,max=200)=>{if(typeof x!=='string'||!x.trim()||x.trim().length>max)fail(`${name} is required and bounded.`);return x.trim();};
const int=(x,name,min=0,max=9000000000000000)=>{if(!Number.isSafeInteger(x)||x<min||x>max)fail(`${name} must be a bounded safe integer.`);return x;};
const iso=x=>{const d=x instanceof Date?x:new Date(x);if(!Number.isFinite(d.valueOf()))fail('A valid timestamp is required.');return d.toISOString();};
const hash=x=>sha256(canonicalJson(x));
const actorId=a=>{const x=String(a?.userId??'');if(!/^[1-9][0-9]{0,39}$/.test(x))fail('A verified tenant actor is required.',401,'authenticated_user_required');return x;};
const calendarDate=(value,name)=>{const x=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(x)||!Number.isFinite(Date.parse(`${x}T00:00:00Z`))||new Date(`${x}T00:00:00Z`).toISOString().slice(0,10)!==x)fail(`${name} must be a valid ISO calendar date.`);return x;};
function safeEvidenceReference(value){
  const reference=str(value,'evidenceReference',2000);
  if(reference.startsWith('https://')){
    let url;try{url=new URL(reference);}catch{fail('evidenceReference must be a safe HTTPS reference or opaque reference ID.');}
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.search||url.hash)fail('HTTPS evidence references cannot include credentials, query strings, or fragments.');
    return reference;
  }
  if(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1999}$/.test(reference)||/^ref:[A-Za-z0-9][A-Za-z0-9._:/-]{0,1994}$/.test(reference))return reference;
  fail('evidenceReference must be a safe HTTPS reference or opaque reference ID.');
}

function cohortView(row){return row?{id:row.id,targetAccounts:Number(row.targetAccounts),eligibleAccounts:Number(row.eligibleAccounts),permittedAccounts:Number(row.permittedAccounts),shortfall:Number(row.shortfall),evidenceAgeDays:Number(row.evidenceAgeDays),manifestSha256:row.manifestSha256,preparedAt:iso(row.preparedAt),status:Number(row.shortfall)>0?'insufficient_data':'provisional'}:null;}

/** Prepare a frozen cohort from current, attested, permitted source evidence only. */
export async function prepareAstraBenchmarkCohort(db,actor,input={}){
  if(!object(input)||Object.keys(input).some(k=>!['targetAccounts','evidenceAgeDays'].includes(k)))fail('Unsupported benchmark cohort fields.');
  const target=int(input.targetAccounts??500,'targetAccounts',500,1000),ageDays=int(input.evidenceAgeDays??90,'evidenceAgeDays',1,3650);
  const preparedAt=new Date().toISOString();
  const selected=await db.query(`WITH eligible AS (
      SELECT DISTINCT ON(a.id) a.id AS account_id,a.normalized_domain,s.id AS source_id,s.rights_policy,s.rights_expires_at,
        e.id AS evidence_id,e.content_sha256,e.captured_at
      FROM astra.research_accounts a
      JOIN astra.research_sources s ON(s.tenant_id,s.normalized_domain)=(a.tenant_id,a.normalized_domain)
      JOIN astra.research_evidence e ON(e.tenant_id,e.source_id)=(s.tenant_id,s.id)
      WHERE a.tenant_id=$1::uuid AND s.rights_attested AND s.robots_allowed
        AND s.rights_policy IN ('user_provided','licensed','public_terms_permitted')
        AND (s.rights_expires_at IS NULL OR s.rights_expires_at>$2::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM astra.research_source_rights_revocations r
          WHERE r.tenant_id=s.tenant_id AND r.source_id=s.id)
        AND e.captured_at >= $2::timestamptz - ($3::int * interval '1 day')
      ORDER BY a.id,e.captured_at DESC,e.id
    ), counted AS (SELECT eligible.*,count(*) OVER()::int AS eligible_count FROM eligible)
    SELECT account_id,normalized_domain,source_id,rights_policy,rights_expires_at,evidence_id,content_sha256,captured_at,eligible_count
    FROM counted ORDER BY normalized_domain,account_id LIMIT $4`,[actor.tenantId,preparedAt,ageDays,target]);
  const rightsBySource=await readAstraSourceRights(db,actor.tenantId,selected.rows.map(row=>row.source_id));
  const permittedRows=selected.rows.filter(row=>rightsBySource.get(String(row.source_id).toLowerCase())?.usable);
  const members=permittedRows.map(row=>{
    const rights={policy:row.rights_policy,expiresAt:row.rights_expires_at?iso(row.rights_expires_at):null,attested:true,robotsAllowed:true};
    const rightsHash=hash(rights);
    const member={accountId:row.account_id,normalizedDomain:row.normalized_domain,sourceId:row.source_id,evidenceId:row.evidence_id,
      evidenceSha256:String(row.content_sha256).trim(),evidenceCapturedAt:iso(row.captured_at),rightsPolicy:row.rights_policy,
      rightsExpiresAt:rights.expiresAt,sourceRightsSha256:rightsHash};
    return {...member,memberSha256:hash(member)};
  });
  const eligible=selected.rows.length?Number(selected.rows[0].eligible_count):0;
  const shortfall=Math.max(0,target-members.length);
  const manifestBody={manifestVersion:1,tenantId:actor.tenantId,preparedAt,targetAccounts:target,evidenceAgeDays:ageDays,
    eligibleAccounts:eligible,permittedAccounts:members.length,shortfall,members};
  const manifest={...manifestBody,sha256:hash(manifestBody)};
  const cohortId=randomUUID(),by=actorId(actor);
  await db.query(`INSERT INTO astra.economics_benchmark_cohorts
    (tenant_id,id,target_accounts,eligible_accounts,permitted_accounts,shortfall,evidence_age_days,manifest,manifest_sha256,prepared_by,prepared_at)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::timestamptz)`,
  [actor.tenantId,cohortId,target,eligible,members.length,shortfall,ageDays,JSON.stringify(manifest),manifest.sha256,by,preparedAt]);
  if(members.length)await db.query(`INSERT INTO astra.economics_benchmark_cohort_members
    (tenant_id,cohort_id,account_id,normalized_domain,source_id,evidence_id,evidence_sha256,evidence_captured_at,rights_policy,rights_expires_at,source_rights_sha256,member_sha256)
    SELECT $1::uuid,$2::uuid,m."accountId",m."normalizedDomain",m."sourceId",m."evidenceId",m."evidenceSha256",m."evidenceCapturedAt"::timestamptz,
      m."rightsPolicy",m."rightsExpiresAt"::timestamptz,m."sourceRightsSha256",m."memberSha256"
    FROM jsonb_to_recordset($3::jsonb) AS m("accountId" uuid,"normalizedDomain" text,"sourceId" uuid,"evidenceId" uuid,"evidenceSha256" text,
      "evidenceCapturedAt" text,"rightsPolicy" text,"rightsExpiresAt" text,"sourceRightsSha256" text,"memberSha256" text)`,
  [actor.tenantId,cohortId,JSON.stringify(members)]);
  return {...cohortView({id:cohortId,targetAccounts:target,eligibleAccounts:eligible,permittedAccounts:members.length,shortfall,evidenceAgeDays:ageDays,manifestSha256:manifest.sha256,preparedAt}),manifest};
}

async function loadCohort(db,tenantId,cohortId){
  const r=await db.query(`SELECT id,target_accounts AS "targetAccounts",eligible_accounts AS "eligibleAccounts",permitted_accounts AS "permittedAccounts",
      shortfall,evidence_age_days AS "evidenceAgeDays",manifest,manifest_sha256 AS "manifestSha256",prepared_at AS "preparedAt"
    FROM astra.economics_benchmark_cohorts WHERE tenant_id=$1::uuid AND id=$2::uuid`,[tenantId,cohortId]);
  if(!r.rows[0])fail('Benchmark cohort was not found.',404,'benchmark_not_found');return r.rows[0];
}

/** Record only already persisted workflows selected by an operator. This does not schedule work. */
export async function collectAstraBenchmarkObservations(db,actor,cohortId,input={}){
  const cohort=await loadCohort(db,actor.tenantId,id(cohortId,'cohortId'));
  if(!object(input)||Object.keys(input).some(k=>k!=='workflowIds')||!Array.isArray(input.workflowIds)||input.workflowIds.length<1||input.workflowIds.length>100)fail('Select 1 to 100 existing workflow IDs.');
  const ids=input.workflowIds.map((x,i)=>id(x,`workflowIds[${i}]`));
  if(new Set(ids).size!==ids.length)fail('Workflow IDs must be unique.');
  const memberRows=await db.query(`SELECT account_id AS "accountId",evidence_id AS "evidenceId",evidence_sha256 AS "evidenceSha256",
      source_id AS "sourceId",evidence_captured_at AS "evidenceCapturedAt",rights_expires_at AS "rightsExpiresAt" FROM astra.economics_benchmark_cohort_members
    WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid`,[actor.tenantId,cohort.id]);
  const memberByEvidence=new Map(memberRows.rows.map(x=>[String(x.evidenceId),x]));
  const currentRights=await readAstraSourceRights(db,actor.tenantId,memberRows.rows.map(x=>x.sourceId));
  const by=actorId(actor),observedAt=new Date().toISOString(),saved=[];
  for(const member of memberRows.rows){
    if(!currentRights.get(String(member.sourceId).toLowerCase())?.usable
      ||(member.rightsExpiresAt&&new Date(member.rightsExpiresAt).valueOf()<=Date.parse(observedAt))
      ||new Date(member.evidenceCapturedAt).valueOf()<Date.parse(observedAt)-Number(cohort.evidenceAgeDays)*86400000){
      fail('Cohort source rights or evidence are no longer current; prepare a fresh cohort before collecting.',409,'benchmark_cohort_evidence_stale');
    }
  }
  for(const workflowId of ids){
    const w=(await db.query(`SELECT w.id,w.task,w.context_manifest AS "contextManifest",w.state,w.payload_hash AS "payloadHash",w.created_at AS "createdAt",
        b.source_kind AS "sourceKind",b.domain_job_id AS "domainJobId"
      FROM astra.workflows w LEFT JOIN astra.domain_harness_bindings b ON(b.tenant_id,b.workflow_id)=(w.tenant_id,w.id)
      WHERE w.tenant_id=$1::uuid AND w.id=$2::uuid`,[actor.tenantId,workflowId])).rows[0];
    if(!w)fail('One or more selected workflows were not found.',404,'benchmark_workflow_not_found');
    const entries=w.contextManifest?.entries||[];
    const matched=entries.filter(e=>e.recordRef?.tenantId===actor.tenantId&&memberByEvidence.has(String(e.recordRef?.recordId||''))
      &&String(e.sha256||'')===String(memberByEvidence.get(String(e.recordRef.recordId)).evidenceSha256).trim());
    const matchedAccounts=[...new Set(matched.map(e=>String(memberByEvidence.get(String(e.recordRef.recordId)).accountId)))];
    if(matchedAccounts.length!==1)fail('Selected workflow must pin the current cohort evidence for exactly one account.');
    const matchedMember=memberByEvidence.get(String(matched[0].recordRef.recordId));
    let sourceKind=w.sourceKind||'workflow',job=null;
    if(sourceKind==='generation'){
      job=(await db.query(`SELECT state,created_at AS "createdAt",started_at AS "startedAt",completed_at AS "completedAt",actual_cost_microusd AS "actualCostMicrousd",
          input_tokens AS "inputTokens",output_tokens AS "outputTokens" FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,w.domainJobId])).rows[0]||null;
    } else if(sourceKind==='connector') {
      job=(await db.query(`SELECT state,created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
        FROM astra.connector_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`,[actor.tenantId,w.domainJobId])).rows[0]||null;
    }
    const telemetry=await db.query(`SELECT kind,occurred_at AS "occurredAt",payload FROM astra.operational_telemetry
      WHERE tenant_id=$1::uuid AND task_id=$2::uuid AND kind IN ('task.started','task.completed','task.failed') ORDER BY occurred_at,id`,[actor.tenantId,w.id]);
    const start=telemetry.rows.find(t=>t.kind==='task.started'),finish=[...telemetry.rows].reverse().find(t=>['task.completed','task.failed'].includes(t.kind));
    const canonicalStart=job?.startedAt||null,canonicalFinish=job?.completedAt||null,canonicalCreated=job?.createdAt||null;
    const queueWaitMs=start?Math.max(0,new Date(start.occurredAt).valueOf()-new Date(w.createdAt).valueOf()):canonicalStart&&canonicalCreated?Math.max(0,new Date(canonicalStart).valueOf()-new Date(canonicalCreated).valueOf()):null;
    const runDuration=finish&&Number.isSafeInteger(finish.payload?.durationMs)?finish.payload.durationMs:canonicalStart&&canonicalFinish?Math.max(0,new Date(canonicalFinish).valueOf()-new Date(canonicalStart).valueOf()):null;
    const effort=await db.query(`SELECT COALESCE(sum(minutes),0)::int minutes,count(*)::int samples FROM astra.economics_reviewer_effort WHERE tenant_id=$1::uuid AND task_id=ANY($2::uuid[])`,[actor.tenantId,[w.id,w.domainJobId].filter(Boolean)]);
    const actualCost=sourceKind==='generation'&&job?.state==='completed'&&job.actualCostMicrousd!==null?String(job.actualCostMicrousd):null;
    const metrics={schemaVersion:1,observedAt,workflowId:w.id,workflowState:w.state,sourceKind,domainJobId:w.domainJobId||null,domainJobState:job?.state||null,
      queueWaitMs,runtimeMs:runDuration,actualCostMicrousd:actualCost,costEvidence:actualCost===null?'unknown_or_not_linked':'canonical_generation_job',
      tokenSamples:sourceKind==='generation'&&job?.inputTokens!==null&&job?.outputTokens!==null?1:0,
      inputTokens:sourceKind==='generation'&&job?.inputTokens!==null?Number(job.inputTokens):null,
      outputTokens:sourceKind==='generation'&&job?.outputTokens!==null?Number(job.outputTokens):null,
      reviewerMinutes:Number(effort.rows[0]?.minutes||0),reviewerEffortSamples:Number(effort.rows[0]?.samples||0),
      telemetrySamples:telemetry.rowCount};
    const sourceSha=hash({workflowId:w.id,payloadHash:w.payloadHash,sourceKind,domainJobId:w.domainJobId||null,
      accountId:matchedMember.accountId,evidenceId:matchedMember.evidenceId,evidenceSha256:String(matchedMember.evidenceSha256).trim(),
      matchingPins:matched.map(e=>({recordId:e.recordRef.recordId,sha256:e.sha256})).sort((a,b)=>a.recordId.localeCompare(b.recordId))});
    const metricsSha=hash(metrics),workflowState=w.state,when=observedAt;
    const inserted=await db.query(`INSERT INTO astra.economics_benchmark_observations
      (tenant_id,id,cohort_id,account_id,evidence_id,workflow_id,source_kind,domain_job_id,workflow_state,source_sha256,metrics,metrics_sha256,queue_wait_ms,runtime_ms,actual_cost_microusd,reviewer_minutes,observed_at,created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,$9,$10,$11::jsonb,$12,$13,$14,$15::bigint,$16,$17::timestamptz,$18)
      ON CONFLICT DO NOTHING RETURNING id,metrics_sha256 AS "metricsSha256"`,
    [actor.tenantId,randomUUID(),cohort.id,matchedMember.accountId,matchedMember.evidenceId,w.id,sourceKind,w.domainJobId||null,workflowState,sourceSha,JSON.stringify(metrics),metricsSha,
      queueWaitMs,runDuration,actualCost,metrics.reviewerMinutes,when,by]);
    if(!inserted.rowCount){
      const prior=(await db.query(`SELECT workflow_id AS "workflowId",metrics_sha256 AS "metricsSha256" FROM astra.economics_benchmark_observations WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid AND (workflow_id=$3::uuid OR account_id=$4::uuid)`,[actor.tenantId,cohort.id,w.id,matchedMember.accountId])).rows[0];
      if(prior?.workflowId!==w.id||prior?.metricsSha256!==metricsSha)fail('A cohort account already has a different frozen workflow observation.',409,'benchmark_observation_conflict');
      saved.push({workflowId:w.id,duplicate:true});
    }else saved.push({workflowId:w.id,observationId:inserted.rows[0].id,duplicate:false});
  }
  const report=await createAstraBenchmarkReport(db,actor,cohort.id);
  return {cohort:cohortView(cohort),observations:saved,report};
}

/** Store an immutable quote reference as unverified evidence; callers cannot mark a quote verified. */
export async function recordAstraBenchmarkQuote(db,actor,cohortId,input={}){
  if(actor?.tenantRole!=='owner')fail('A tenant owner must submit vendor quote evidence.',403,'benchmark_quote_owner_required');
  const cohort=await loadCohort(db,actor.tenantId,id(cohortId,'cohortId'));
  if(!object(input)||Object.keys(input).some(k=>!['vendor','evidenceReference','evidenceSha256','provenance','amountMinor','currency','unit','effectiveFrom','effectiveUntil'].includes(k)))fail('Unsupported quote fields.');
  const vendor=str(input.vendor,'vendor',120),reference=safeEvidenceReference(input.evidenceReference),evidenceSha=str(input.evidenceSha256,'evidenceSha256',64).toLowerCase();
  if(!HASH.test(evidenceSha))fail('evidenceSha256 must be a SHA-256 digest.');
  if(!object(input.provenance)||typeof input.provenance.kind!=='string'||typeof input.provenance.source!=='string')fail('Quote source provenance is required.');
  const provenance={kind:str(input.provenance.kind,'provenance.kind',80),source:str(input.provenance.source,'provenance.source',300),evidenceSha256:evidenceSha,reference};
  const provenanceSha=hash(provenance),amount=int(input.amountMinor,'amountMinor'),currency=str(input.currency,'currency',3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))fail('Currency must be an ISO currency code.');
  const unit=str(input.unit,'unit',80),from=calendarDate(input.effectiveFrom,'effectiveFrom');
  const until=input.effectiveUntil===undefined||input.effectiveUntil===null?null:calendarDate(input.effectiveUntil,'effectiveUntil');
  if(until!==null&&until<from)fail('effectiveUntil must be on or after effectiveFrom.');
  const submittedAt=new Date().toISOString(),quoteId=randomUUID();
  const body={cohortId:cohort.id,vendor,evidenceReference:reference,evidenceSha256:evidenceSha,provenance,amountMinor:amount,currency,unit,effectiveFrom:from,effectiveUntil:until,submittedBy:actorId(actor),submittedAt};
  const quoteSha=hash(body);
  await db.query(`INSERT INTO astra.economics_benchmark_quotes(tenant_id,id,cohort_id,vendor,evidence_reference,evidence_sha256,evidence_provenance,provenance_sha256,quote_sha256,amount_minor,currency,unit,effective_from,effective_until,submitted_by,submitted_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9,$10::bigint,$11,$12,$13::date,$14::date,$15,$16::timestamptz)`,
  [actor.tenantId,quoteId,cohort.id,vendor,reference,evidenceSha,JSON.stringify(provenance),provenanceSha,quoteSha,amount,currency,unit,from,until,body.submittedBy,submittedAt]);
  return {id:quoteId,cohortId:cohort.id,vendor,evidenceSha256:evidenceSha,provenanceSha256:provenanceSha,quoteSha256:quoteSha,amountMinor:amount,currency,unit,effectiveFrom:from,effectiveUntil:until,status:'unverified',verified:false};
}

/** Append a role-stamped review. Verification requires distinct owner and independent admin/reviewer approvals. */
export async function reviewAstraBenchmarkQuote(db,actor,cohortId,quoteId,input={}){
  const cohort=await loadCohort(db,actor.tenantId,id(cohortId,'cohortId'));
  if(!object(input)||Object.keys(input).some(k=>!['verdict','rationaleCode'].includes(k)))fail('Unsupported quote review fields.');
  const reviewerRole=actor?.tenantRole;if(!['owner','admin','reviewer'].includes(reviewerRole))fail('An owner or independent reviewer is required.',403,'benchmark_quote_reviewer_required');
  const quote=(await db.query(`SELECT id,submitted_by AS "submittedBy" FROM astra.economics_benchmark_quotes WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid AND id=$3::uuid`,[actor.tenantId,cohort.id,id(quoteId,'quoteId')])).rows[0];
  if(!quote)fail('Quote evidence was not found.',404,'benchmark_quote_not_found');
  const reviewer=actorId(actor),verdict=input.verdict;if(!['approved','rejected'].includes(verdict))fail('verdict must be approved or rejected.');
  if(verdict==='approved'&&reviewer===quote.submittedBy)fail('Quote submitter cannot provide an independent approval.',403,'benchmark_quote_independent_review_required');
  const rationale=str(input.rationaleCode,'rationaleCode',80);if(!/^[a-z][a-z0-9_.:-]{1,79}$/.test(rationale))fail('rationaleCode must be a bounded code.');
  const reviewedAt=new Date().toISOString(),body={cohortId:cohort.id,quoteId:quote.id,reviewerId:reviewer,reviewerRole,verdict,rationaleCode:rationale,reviewedAt},reviewSha=hash(body);
  const inserted=await db.query(`INSERT INTO astra.economics_benchmark_quote_reviews(tenant_id,id,quote_id,reviewer_id,reviewer_role,verdict,rationale_code,reviewed_at,review_sha256)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::timestamptz,$9) ON CONFLICT(tenant_id,quote_id,reviewer_id) DO NOTHING RETURNING id`,
  [actor.tenantId,randomUUID(),quote.id,reviewer,reviewerRole,verdict,rationale,reviewedAt,reviewSha]);
  if(!inserted.rowCount){const prior=(await db.query(`SELECT verdict,rationale_code AS "rationaleCode" FROM astra.economics_benchmark_quote_reviews WHERE tenant_id=$1::uuid AND quote_id=$2::uuid AND reviewer_id=$3`,[actor.tenantId,quote.id,reviewer])).rows[0];
    if(prior?.verdict!==verdict||prior?.rationaleCode!==rationale)fail('A quote review is immutable; this reviewer already submitted a different decision.',409,'benchmark_quote_review_conflict');}
  return {quoteId:quote.id,reviewerRole,verdict,reviewedAt,immutable:true};
}

function percentile(values,p){return values.length?values[Math.ceil(p*values.length)-1]:null;}
function safeBigInt(value){try{return BigInt(value||0);}catch{return 0n;}}

/** Build and persist an immutable report exclusively from canonical stored observations and outcomes. */
export async function createAstraBenchmarkReport(db,actor,cohortId){
  const cohort=await loadCohort(db,actor.tenantId,id(cohortId,'cohortId'));
  const members=await db.query(`SELECT account_id AS "id",source_id AS "sourceId",evidence_captured_at AS "evidenceCapturedAt",rights_expires_at AS "rightsExpiresAt"
    FROM astra.economics_benchmark_cohort_members WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid ORDER BY account_id`,[actor.tenantId,cohort.id]);
  const observations=await db.query(`SELECT account_id AS "accountId",workflow_id AS "workflowId",source_kind AS "sourceKind",workflow_state AS "workflowState",queue_wait_ms AS "queueWaitMs",runtime_ms AS "runtimeMs",
      actual_cost_microusd AS "actualCostMicrousd",reviewer_minutes AS "reviewerMinutes",metrics,observed_at AS "observedAt"
      FROM astra.economics_benchmark_observations WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid ORDER BY observed_at,workflow_id`,[actor.tenantId,cohort.id]);
  const quotes=await db.query(`SELECT q.id,q.vendor,q.evidence_sha256 AS "evidenceSha256",q.provenance_sha256 AS "provenanceSha256",q.quote_sha256 AS "quoteSha256",
      q.amount_minor AS "amountMinor",q.currency,q.unit,q.effective_from AS "effectiveFrom",q.effective_until AS "effectiveUntil",
      q.submitted_by AS "submittedBy",COALESCE(bool_or(r.reviewer_role='owner' AND r.verdict='approved'),false) owner_approved,
      COALESCE(bool_or(r.reviewer_role IN ('admin','reviewer') AND r.verdict='approved'),false) independent_approved,
      count(r.id)::int review_count
      FROM astra.economics_benchmark_quotes q LEFT JOIN astra.economics_benchmark_quote_reviews r ON(r.tenant_id,r.quote_id)=(q.tenant_id,q.id)
      WHERE q.tenant_id=$1::uuid AND q.cohort_id=$2::uuid GROUP BY q.tenant_id,q.id ORDER BY q.submitted_at,q.id`,[actor.tenantId,cohort.id]);
  const quota=await db.query(`SELECT tier,daily_limit_microusd AS "dailyLimitMicrousd",enabled FROM astra.economics_tenant_quotas WHERE tenant_id=$1::uuid`,[actor.tenantId]);
  const outcomes=await db.query(`SELECT count(DISTINCT (o.entity_type,o.entity_id))::int accounts,count(*)::int events
      FROM astra.canonical_outcome_events($1::uuid) o WHERE o.entity_id=ANY($2::text[]) AND o.recorded_at<=now()-interval '30 days'
        AND (o.stage IN ('opportunity_won','opportunity.won') OR (o.stage IN ('revenue_paid','revenue.paid') AND o.positive_net_revenue))`,
      [actor.tenantId,members.rows.map(x=>String(x.id))]);
  const rightsBySource=await readAstraSourceRights(db,actor.tenantId,members.rows.map(row=>row.sourceId));
  const permittedAccounts=new Set(members.rows.filter(m=>rightsBySource.get(String(m.sourceId).toLowerCase())?.usable
    &&(!m.rightsExpiresAt||new Date(m.rightsExpiresAt).valueOf()>Date.now())
    &&new Date(m.evidenceCapturedAt).valueOf()>=Date.now()-Number(cohort.evidenceAgeDays)*86400000).map(m=>String(m.id)));
  const currentObservations=observations.rows.filter(row=>permittedAccounts.has(String(row.accountId)));
  const costValues=currentObservations.filter(x=>x.actualCostMicrousd!==null).map(x=>Number(x.actualCostMicrousd)).filter(Number.isSafeInteger).sort((a,b)=>a-b);
  const queueValues=currentObservations.filter(x=>x.queueWaitMs!==null).map(x=>Number(x.queueWaitMs)).sort((a,b)=>a-b);
  const runtimeValues=currentObservations.filter(x=>x.runtimeMs!==null).map(x=>Number(x.runtimeMs)).sort((a,b)=>a-b);
  const reviewedQuotes=quotes.rows.filter(q=>q.owner_approved&&q.independent_approved&&!q.rejected);
  const now=Date.now(),currentlyPermitted=permittedAccounts.size;
  const missing=[];
  if(Number(cohort.permittedAccounts)<Number(cohort.targetAccounts))missing.push('permitted_account_shortfall');
  if(currentlyPermitted<Number(cohort.permittedAccounts))missing.push('cohort_rights_or_evidence_no_longer_current');
  const uniqueWorkflowAccounts=new Set(currentObservations.map(x=>String(x.accountId))).size;
  if(uniqueWorkflowAccounts<500)missing.push('fewer_than_500_distinct_accounts_with_persisted_workflow_observations');
  if(!costValues.length)missing.push('no_actual_cost_observations');
  if(!Number(outcomes.rows[0]?.accounts||0))missing.push('no_mature_canonical_outcomes_for_cohort_accounts');
  if(!reviewedQuotes.length)missing.push('no_owner_and_independent_reviewed_quote_reference');
  const reviewerValues=currentObservations.filter(x=>Number(x.metrics?.reviewerEffortSamples||0)>0).map(x=>Number(x.reviewerMinutes||0)).sort((a,b)=>a-b);
  const maximum=costValues.length?BigInt(Math.max(...costValues)):null;
  const quotaCeiling=maximum===null?null:(maximum*BigInt(Math.min(1000,Math.max(1,Number(cohort.targetAccounts))))*2n>9000000000000000n?9000000000000000n:maximum*BigInt(Math.min(1000,Math.max(1,Number(cohort.targetAccounts))))*2n);
  const report={schemaVersion:1,cohort:cohortView(cohort),status:missing.some(x=>x==='permitted_account_shortfall'||x==='fewer_than_500_distinct_accounts_with_persisted_workflow_observations')?'insufficient_data':'provisional',
    source:'tenant-persisted canonical workflow records only',outcomeMaturityWindowDays:30,createdAt:new Date().toISOString(),releaseReady:false,benchmarkExecuted:false,
    samples:{permittedAccounts:Number(cohort.permittedAccounts),targetAccounts:Number(cohort.targetAccounts),workflows:observations.rowCount,
      uniqueAccountsWithWorkflow:uniqueWorkflowAccounts,currentPermittedAccounts:currentlyPermitted,actualCost:costValues.length,queueWait:queueValues.length,runtime:runtimeValues.length,reviewerEffort:reviewerValues.length,
      matureCanonicalOutcomeAccounts:Number(outcomes.rows[0]?.accounts||0),matureCanonicalOutcomeEvents:Number(outcomes.rows[0]?.events||0),
      vendorQuotes:quotes.rowCount,reviewedVendorQuotes:reviewedQuotes.length},
    metrics:{actualCostMicrousd:{p50:percentile(costValues,.5),p95:percentile(costValues,.95),max:maximum===null?null:maximum.toString()},
      queueWaitMs:{p50:percentile(queueValues,.5),p95:percentile(queueValues,.95)},runtimeMs:{p50:percentile(runtimeValues,.5),p95:percentile(runtimeValues,.95)},reviewerMinutesPerAccount:{p50:percentile(reviewerValues,.5),p95:percentile(reviewerValues,.95)},
      reviewerMinutesTotal:currentObservations.reduce((n,x)=>n+Number(x.reviewerMinutes||0),0)},
    quota:{basis:'twice the observed maximum actual workflow cost per target account, capped at USD 9,000,000,000,000,000 microusd',
      provisionalDailyCeilingMicrousd:quotaCeiling===null?null:quotaCeiling.toString(),enabled:false,
      configuredTenantQuota:quota.rows[0]?{tier:quota.rows[0].tier,dailyLimitMicrousd:String(quota.rows[0].dailyLimitMicrousd),enabled:Boolean(quota.rows[0].enabled)}:null,
      headroomMicrousd:quota.rows[0]?.dailyLimitMicrousd!==undefined&&quotaCeiling!==null?(safeBigInt(quota.rows[0].dailyLimitMicrousd)-quotaCeiling).toString():null},
    quotes:{reviewed:reviewedQuotes.map(q=>({vendor:q.vendor,evidenceSha256:String(q.evidenceSha256).trim(),provenanceSha256:String(q.provenanceSha256).trim(),quoteSha256:String(q.quoteSha256).trim(),amountMinor:String(q.amountMinor),currency:q.currency,unit:q.unit,effectiveFrom:q.effectiveFrom,effectiveUntil:q.effectiveUntil})),
      unreviewedExcluded:quotes.rowCount-reviewedQuotes.length,callerPriceIsNotVerifiedFact:true,reviewMeaning:'owner and independent review of supplied reference; not an independently verified vendor price'},
    exclusions:{unknownCost:currentObservations.filter(x=>x.actualCostMicrousd===null).length,unknownQueueTiming:currentObservations.filter(x=>x.queueWaitMs===null).length,
      unknownRuntime:currentObservations.filter(x=>x.runtimeMs===null).length,historicalObservationsExcludedForRevokedOrStaleSources:observations.rows.length-currentObservations.length,
      unlinkedQuoteCosts:'not added to actual usage costs',providerOrRemoteWork:'disabled; benchmark flag cannot enable it'},missing};
  const createdAt=report.createdAt,reportSha=hash(report),reportId=randomUUID(),by=actorId(actor);
  await db.query(`INSERT INTO astra.economics_benchmark_reports(tenant_id,id,cohort_id,report,report_sha256,actual_cost_samples,quota_ceiling_microusd,created_by,created_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5,$6,$7::bigint,$8,$9::timestamptz)`,
  [actor.tenantId,reportId,cohort.id,JSON.stringify(report),reportSha,costValues.length,quotaCeiling===null?null:quotaCeiling.toString(),by,createdAt]);
  return {id:reportId,reportSha256:reportSha,...report};
}

export async function getAstraBenchmark(db,actor,cohortId=null){
  let row;
  if(cohortId){row=await loadCohort(db,actor.tenantId,id(cohortId,'cohortId'));}
  else row=(await db.query(`SELECT id,target_accounts AS "targetAccounts",eligible_accounts AS "eligibleAccounts",permitted_accounts AS "permittedAccounts",
      shortfall,evidence_age_days AS "evidenceAgeDays",manifest_sha256 AS "manifestSha256",prepared_at AS "preparedAt"
      FROM astra.economics_benchmark_cohorts WHERE tenant_id=$1::uuid ORDER BY prepared_at DESC,id DESC LIMIT 1`,[actor.tenantId])).rows[0];
  if(!row)return {cohort:null,report:null,quotes:[]};
  const report=(await db.query(`SELECT id,report,report_sha256 AS "reportSha256",created_at AS "createdAt" FROM astra.economics_benchmark_reports
    WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid ORDER BY created_at DESC,id DESC LIMIT 1`,[actor.tenantId,row.id])).rows[0]||null;
  const memberStatus=await db.query(`SELECT account_id AS "accountId",source_id AS "sourceId",evidence_captured_at AS "evidenceCapturedAt",rights_expires_at AS "rightsExpiresAt"
    FROM astra.economics_benchmark_cohort_members WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid`,[actor.tenantId,row.id]);
  const memberRights=await readAstraSourceRights(db,actor.tenantId,memberStatus.rows.map(member=>member.sourceId));
  const currentMembers=memberStatus.rows.filter(member=>memberRights.get(String(member.sourceId).toLowerCase())?.usable
    &&(!member.rightsExpiresAt||new Date(member.rightsExpiresAt).valueOf()>Date.now())
    &&new Date(member.evidenceCapturedAt).valueOf()>=Date.now()-Number(row.evidenceAgeDays)*86400000);
  const revokedAccounts=memberStatus.rows.filter(member=>memberRights.get(String(member.sourceId).toLowerCase())?.status==='revoked').length;
  const counts=await db.query(`SELECT (SELECT count(*)::int FROM astra.economics_benchmark_cohort_members WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid) members,
      (SELECT count(*)::int FROM astra.economics_benchmark_observations WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid) observations,
      (SELECT count(*)::int FROM astra.economics_benchmark_quotes WHERE tenant_id=$1::uuid AND cohort_id=$2::uuid) quotes`,[actor.tenantId,row.id]);
  const quoteRows=await db.query(`SELECT q.id,q.vendor,q.evidence_reference AS "evidenceReference",q.evidence_sha256 AS "evidenceSha256",q.provenance_sha256 AS "provenanceSha256",q.quote_sha256 AS "quoteSha256",
        q.amount_minor AS "amountMinor",q.currency,q.unit,q.effective_from AS "effectiveFrom",q.effective_until AS "effectiveUntil",
        COALESCE(bool_or(r.reviewer_role='owner' AND r.verdict='approved'),false) owner_approved,
        COALESCE(bool_or(r.reviewer_role IN ('admin','reviewer') AND r.verdict='approved'),false) independent_approved,
        COALESCE(bool_or(r.verdict='rejected'),false) rejected,count(r.id)::int "reviewCount",
        COALESCE(jsonb_agg(jsonb_build_object('reviewerRole',r.reviewer_role,'verdict',r.verdict,'rationaleCode',r.rationale_code,
          'reviewedAt',r.reviewed_at,'reviewSha256',r.review_sha256) ORDER BY r.reviewed_at) FILTER(WHERE r.id IS NOT NULL),'[]'::jsonb) reviews
      FROM astra.economics_benchmark_quotes q LEFT JOIN astra.economics_benchmark_quote_reviews r ON(r.tenant_id,r.quote_id)=(q.tenant_id,q.id)
      WHERE q.tenant_id=$1::uuid AND q.cohort_id=$2::uuid GROUP BY q.tenant_id,q.id ORDER BY q.submitted_at,q.id`,[actor.tenantId,row.id]);
  const quotes=quoteRows.rows.map(q=>({...q,evidenceSha256:String(q.evidenceSha256).trim(),provenanceSha256:String(q.provenanceSha256).trim(),quoteSha256:String(q.quoteSha256).trim(),
    status:q.rejected?'rejected':q.owner_approved&&q.independent_approved?'reviewed':'unreviewed',reviewed:Boolean(!q.rejected&&q.owner_approved&&q.independent_approved),amountMinor:String(q.amountMinor)}));
  const historicalReport=report?{...report,effectiveSourceRights:{currentlyPermittedAccounts:currentMembers.length,
    revokedAccounts,historicalObservationsRemainHistorical:true}}:null;
  return {cohort:{...cohortView(row),memberRecords:Number(counts.rows[0].members),workflowObservations:Number(counts.rows[0].observations),quoteEvidence:Number(counts.rows[0].quotes),
    currentlyPermittedAccounts:currentMembers.length,revokedAccounts},report:historicalReport,quotes};
}

export async function listAstraBenchmarks(db,actor){
  const r=await db.query(`SELECT c.id,c.target_accounts AS "targetAccounts",c.eligible_accounts AS "eligibleAccounts",c.permitted_accounts AS "permittedAccounts",
      c.shortfall,c.evidence_age_days AS "evidenceAgeDays",c.manifest_sha256 AS "manifestSha256",c.prepared_at AS "preparedAt",
      (SELECT count(*)::int FROM astra.economics_benchmark_observations o WHERE(o.tenant_id,o.cohort_id)=(c.tenant_id,c.id)) AS "workflowObservations",
      (SELECT count(*)::int FROM astra.economics_benchmark_reports r WHERE(r.tenant_id,r.cohort_id)=(c.tenant_id,c.id)) AS "reportCount"
    FROM astra.economics_benchmark_cohorts c WHERE c.tenant_id=$1::uuid ORDER BY c.prepared_at DESC,c.id DESC LIMIT 50`,[actor.tenantId]);
  const ids=r.rows.map(row=>row.id);
  const members=ids.length?await db.query(`SELECT cohort_id AS "cohortId",account_id AS "accountId",source_id AS "sourceId",rights_expires_at AS "rightsExpiresAt",evidence_captured_at AS "evidenceCapturedAt"
    FROM astra.economics_benchmark_cohort_members WHERE tenant_id=$1::uuid AND cohort_id=ANY($2::uuid[])`,[actor.tenantId,ids]):{rows:[]};
  const rights=await readAstraSourceRights(db,actor.tenantId,members.rows.map(member=>member.sourceId));
  const byCohort=new Map();
  for(const member of members.rows){const current=rights.get(String(member.sourceId).toLowerCase());const row=byCohort.get(member.cohortId)||{currentlyPermittedAccounts:0,revokedAccounts:0};
    if(current?.usable&&(!member.rightsExpiresAt||new Date(member.rightsExpiresAt).valueOf()>Date.now()))row.currentlyPermittedAccounts++;
    if(current?.status==='revoked')row.revokedAccounts++;byCohort.set(member.cohortId,row);}
  return {benchmarks:r.rows.map(x=>({...cohortView(x),workflowObservations:Number(x.workflowObservations),reportCount:Number(x.reportCount),
    ...(byCohort.get(x.id)||{currentlyPermittedAccounts:0,revokedAccounts:0}),historicalObservationsRemainHistorical:true})),releaseReady:false};
}
