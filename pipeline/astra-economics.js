import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { getAstraBenchmark } from './astra-benchmark.js';

const fail=(message,statusCode=400,code='economics_invalid')=>{throw new AstraTenantContextError(message,statusCode,code);};
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const uuid=x=>{if(typeof x!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))fail('A valid UUID is required.');return x.toLowerCase();};
const integer=(v,name,min=0,max=9000000000000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(`${name} must be a bounded safe integer.`);return v;};
const text=(v,name,max=200)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail(`${name} is required and bounded.`);return v.trim();};

/** Evidence summary is descriptive: reservations and uncertain spend stay separate from actual cost. */
export async function getAstraEconomics(db,actor,{since=null,until=null}={}){
  const from=since?new Date(since):new Date(Date.now()-30*86400000),to=until?new Date(until):new Date();
  if(Number.isNaN(from.valueOf())||Number.isNaN(to.valueOf())||from>=to)fail('A valid increasing reporting window is required.');
  const args=[actor.tenantId,from.toISOString(),to.toISOString()];
  const [ai,generation,bills,review,telemetry,outcomes,quota,byTask,benchmarkEvidence]=await Promise.all([
    db.query(`SELECT count(*)::int sample_count,COALESCE(sum(reserved_microusd) FILTER(WHERE state IN ('queued','running')),0)::text reserved_microusd,
      COALESCE(sum(reserved_microusd) FILTER(WHERE state='uncertain'),0)::text uncertain_microusd,
      COALESCE(sum(cost_microusd) FILTER(WHERE state='succeeded'),0)::text actual_microusd,
      count(*) FILTER(WHERE state='succeeded' AND cost_microusd IS NOT NULL)::int actual_samples,
      count(*) FILTER(WHERE cost_microusd IS NULL AND state NOT IN ('queued','running','uncertain','cancelled'))::int missing_costs,
      COALESCE(sum(input_tokens) FILTER(WHERE state='succeeded'),0)::text input_tokens,COALESCE(sum(output_tokens) FILTER(WHERE state='succeeded'),0)::text output_tokens
      FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND created_at >= $2 AND created_at < $3`,args),
    db.query(`SELECT count(*)::int sample_count,COALESCE(sum(reserved_microusd) FILTER(WHERE state IN ('queued','running')),0)::text reserved_microusd,
      COALESCE(sum(reserved_microusd) FILTER(WHERE state='uncertain'),0)::text uncertain_microusd,
      COALESCE(sum(actual_cost_microusd) FILTER(WHERE state='completed'),0)::text actual_microusd,
      count(*) FILTER(WHERE state='completed' AND actual_cost_microusd IS NOT NULL)::int actual_samples,
      count(*) FILTER(WHERE actual_cost_microusd IS NULL AND state NOT IN ('queued','running','uncertain','cancelled'))::int missing_costs,
      COALESCE(sum(input_tokens) FILTER(WHERE state='completed'),0)::text input_tokens,COALESCE(sum(output_tokens) FILTER(WHERE state='completed'),0)::text output_tokens
      FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND created_at >= $2 AND created_at < $3`,args),
    db.query(`SELECT count(*)::int invoice_count,COALESCE(sum(amount_minor),0)::text amount_minor,currency,
      (linked_usage_id IS NOT NULL) linked_to_usage FROM astra.economics_vendor_bills
      WHERE tenant_id=$1::uuid AND billed_at >= $2 AND billed_at < $3 GROUP BY currency,(linked_usage_id IS NOT NULL) ORDER BY currency,linked_to_usage`,args),
    db.query(`SELECT COALESCE(sum(minutes),0)::text reviewer_minutes,count(*)::int effort_samples,
      COALESCE(jsonb_object_agg(category,n) FILTER(WHERE category IS NOT NULL),'{}'::jsonb) categories
      FROM (SELECT category,sum(minutes)::int minutes,count(*)::int n FROM astra.economics_reviewer_effort
      WHERE tenant_id=$1::uuid AND occurred_at >= $2 AND occurred_at < $3 GROUP BY category) s`,args),
    db.query(`SELECT (SELECT count(*)::int FROM astra.operational_telemetry WHERE tenant_id=$1::uuid AND occurred_at >= $2 AND occurred_at < $3) tasks,
      (SELECT count(*)::int FROM astra.operational_telemetry WHERE tenant_id=$1::uuid AND occurred_at >= $2 AND occurred_at < $3 AND payload ? 'traceBytes') trace_samples,
      (SELECT COALESCE(sum((payload->>'traceBytes')::bigint),0)::text FROM astra.operational_telemetry WHERE tenant_id=$1::uuid AND occurred_at >= $2 AND occurred_at < $3 AND payload->>'traceBytes' ~ '^[0-9]{1,12}$') trace_bytes,
      (SELECT count(*)::int FROM astra.operational_telemetry WHERE tenant_id=$1::uuid AND occurred_at >= $2 AND occurred_at < $3 AND payload ? 'interventionCategory') intervention_samples,
      (SELECT jsonb_build_object('categories',COALESCE(jsonb_object_agg(category,n) FILTER(WHERE category IS NOT NULL),'{}'::jsonb),
          'unknownCategoryCount',COALESCE(sum(n) FILTER(WHERE category IS NULL),0)::int)
        FROM (SELECT payload->>'interventionCategory' category,count(*)::int n FROM astra.operational_telemetry
          WHERE tenant_id=$1::uuid AND occurred_at >= $2 AND occurred_at < $3 AND payload ? 'interventionCategory'
          GROUP BY payload->>'interventionCategory') x) interventions`,args),
    db.query(`SELECT count(*)::int verified_outcome_events,count(DISTINCT (o.entity_type,o.entity_id))::int verified_outcome_accounts
      FROM astra.canonical_outcome_events($1::uuid) o WHERE o.recorded_at >= $2 AND o.recorded_at < $3
      AND (o.stage IN ('opportunity_won','opportunity.won') OR (o.stage IN ('revenue_paid','revenue.paid') AND o.positive_net_revenue))`,args),
    db.query(`SELECT tier,daily_limit_microusd,concurrency_limit,max_task_tokens,max_trace_bytes FROM astra.economics_tenant_quotas WHERE tenant_id=$1::uuid`,[actor.tenantId]),
    db.query(`SELECT task,count(*)::int tasks,COALESCE(sum(input_tokens) FILTER(WHERE state='succeeded'),0)::text input_tokens,COALESCE(sum(output_tokens) FILTER(WHERE state='succeeded'),0)::text output_tokens,
      COALESCE(sum(cost_microusd) FILTER(WHERE state='succeeded'),0)::text actual_microusd,count(*) FILTER(WHERE state='succeeded' AND cost_microusd IS NOT NULL)::int actual_samples
      FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND created_at >= $2 AND created_at < $3 GROUP BY task
      UNION ALL SELECT task,count(*)::int,COALESCE(sum(input_tokens) FILTER(WHERE state='completed'),0)::text,COALESCE(sum(output_tokens) FILTER(WHERE state='completed'),0)::text,
      COALESCE(sum(actual_cost_microusd) FILTER(WHERE state='completed'),0)::text,count(*) FILTER(WHERE state='completed' AND actual_cost_microusd IS NOT NULL)::int
      FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND created_at >= $2 AND created_at < $3 GROUP BY task ORDER BY task`,args),
    getAstraBenchmark(db,actor),
  ]);
  const a=ai.rows[0],g=generation.rows[0],samples=Number(a.actual_samples)+Number(g.actual_samples);
  const vals=[];
  const costs=await db.query(`SELECT cost_microusd FROM (
    SELECT cost_microusd FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND state='succeeded' AND created_at >= $2 AND created_at < $3 AND cost_microusd IS NOT NULL
    UNION ALL SELECT actual_cost_microusd FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND state='completed' AND created_at >= $2 AND created_at < $3 AND actual_cost_microusd IS NOT NULL) c ORDER BY cost_microusd`,args);
  for(const row of costs.rows)vals.push(Number(row.cost_microusd));
  const percentile=p=>vals.length?vals[Math.ceil(p*vals.length)-1]:null;
  const actualUsdMicros=BigInt(a.actual_microusd)+BigInt(g.actual_microusd);
  const verifiedOutcomeAccounts=BigInt(outcomes.rows[0].verified_outcome_accounts||0);
  const cohort=benchmarkEvidence.cohort,report=benchmarkEvidence.report;
  const benchmark={permittedAccounts:cohort?.permittedAccounts??null,eligibleAccounts:cohort?.eligibleAccounts??null,
    requiredMinimum:500,targetAccounts:cohort?.targetAccounts??500,shortfall:cohort?.shortfall??null,
    cohortId:cohort?.id??null,manifestSha256:cohort?.manifestSha256??null,
    status:report?.report?.status??(cohort?'provisional':'insufficient_data'),pricing:'provisional',
    quotes:report?.report?.samples?.reviewedVendorQuotes>0?'reviewed_reference':'unknown',
    actualSamples:report?.report?.samples??(cohort?{permittedAccounts:cohort.permittedAccounts,workflows:0,actualCost:0}:null),
    reportId:report?.id??null,reportSha256:report?.reportSha256??null,benchmarkExecuted:false,
    exclusions:report?.report?.exclusions??{unknownCost:0,unknownQueueTiming:0,unknownRuntime:0},releaseReady:false};
  return {window:{since:from.toISOString(),until:to.toISOString()},costs:{currency:'USD',unit:'microusd',actual:actualUsdMicros.toString(),actualCostPerVerifiedOutcomeMicrousd:verifiedOutcomeAccounts?((actualUsdMicros+verifiedOutcomeAccounts/2n)/verifiedOutcomeAccounts).toString():null,reserved:(BigInt(a.reserved_microusd)+BigInt(g.reserved_microusd)).toString(),uncertain:(BigInt(a.uncertain_microusd)+BigInt(g.uncertain_microusd)).toString(),missingCostSamples:Number(a.missing_costs)+Number(g.missing_costs),unknownExclusions:Number(a.missing_costs)+Number(g.missing_costs),actualSamples:samples,p50Microusd:percentile(.5),p95Microusd:percentile(.95),vendorBills:bills.rows,vendorBillCaveat:'Invoice totals stay separate by currency; usage-linked invoices are flagged and never added to usage costs.'},usage:{tasks:Number(a.sample_count)+Number(g.sample_count),inputTokens:(BigInt(a.input_tokens)+BigInt(g.input_tokens)).toString(),outputTokens:(BigInt(a.output_tokens)+BigInt(g.output_tokens)).toString(),byTask:byTask.rows},reviewerEffort:review.rows[0],telemetry:telemetry.rows[0],outcomes:{...outcomes.rows[0],denominator:'distinct canonical outcome-projection entities with opportunity won or positive net paid revenue in the window; correction and refund events are resolved by the projection'},quota:quota.rows[0]||null,benchmark,releaseReady:false};
}

/** Persist a configurable, disabled-by-default tenant quota tier. */
export async function setAstraEconomicsQuota(db,actor,input){
  if(!isObject(input)||Object.keys(input).some(k=>!['tier','dailyLimitMicrousd','concurrencyLimit','maxTaskTokens','maxTraceBytes','enabled'].includes(k)))fail('Unsupported quota fields.');
  const tier=text(input.tier,'tier',40),daily=integer(input.dailyLimitMicrousd,'dailyLimitMicrousd',0),concurrency=integer(input.concurrencyLimit,'concurrencyLimit',1,10000),tokens=integer(input.maxTaskTokens,'maxTaskTokens',1,100000000),trace=integer(input.maxTraceBytes,'maxTraceBytes',1,1000000000);
  if(input.enabled!==true&&input.enabled!==false)fail('enabled must be explicit.');
  if(input.enabled&&daily===0)fail('Enabled quotas require a positive daily spend ceiling.');
  await db.query(`INSERT INTO astra.economics_tenant_quotas(tenant_id,tier,daily_limit_microusd,concurrency_limit,max_task_tokens,max_trace_bytes,enabled,updated_by)
    VALUES($1::uuid,$2,$3::bigint,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id) DO UPDATE SET tier=EXCLUDED.tier,daily_limit_microusd=EXCLUDED.daily_limit_microusd,concurrency_limit=EXCLUDED.concurrency_limit,max_task_tokens=EXCLUDED.max_task_tokens,max_trace_bytes=EXCLUDED.max_trace_bytes,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[actor.tenantId,tier,daily,concurrency,tokens,trace,input.enabled,String(actor.userId)]);
  return {tier,dailyLimitMicrousd:daily,concurrencyLimit:concurrency,maxTaskTokens:tokens,maxTraceBytes:trace,enabled:input.enabled};
}

/** Called by future task entry points inside the tenant transaction; SQL advisory lock makes burst checks atomic. */
export async function reserveAstraEconomicsQuota(db,actor,{taskId=randomUUID(),idempotencyKey,estimatedMicrousd,tokens,traceBytes=0}={}){
  const id=uuid(taskId),key=text(idempotencyKey,'idempotencyKey',200);const cost=integer(estimatedMicrousd,'estimatedMicrousd',1),tokenCount=integer(tokens,'tokens',1,100000000),bytes=integer(traceBytes,'traceBytes',0,1000000000);
  const r=await db.query('SELECT * FROM astra.reserve_economics_quota($1::uuid,$2::uuid,$3,$4::bigint,$5,$6)',[actor.tenantId,id,key,cost,tokenCount,bytes]);
  if(!r.rows[0]?.accepted){if(r.rows[0]?.duplicate)fail('Idempotency key is already bound to a different task.',409,'economics_idempotency_conflict');fail('Tenant spend quota, task token cap, trace cap, or concurrency cap is exhausted. No task was reserved.',429,'economics_quota_exhausted');}
  return {id,duplicate:Boolean(r.rows[0].duplicate),reservedMicrousd:String(r.rows[0].reserved_microusd),state:r.rows[0].state};
}

/** Reconcile only from a trusted worker/provider result and immutable receipt provenance. */
export async function reconcileAstraEconomicsQuota(db,actor,{taskId,actualMicrousd=null,state='completed',providerBillId=null,provenance}={}){
  const id=uuid(taskId);if(!['completed','failed','uncertain'].includes(state))fail('Unsupported quota reconciliation state.');
  if(actualMicrousd!==null)integer(actualMicrousd,'actualMicrousd',0);
  if(providerBillId!==null)text(providerBillId,'providerBillId',200);
  if(!isObject(provenance)||!['provider_receipt','internal_meter','unknown'].includes(provenance.kind))fail('Cost provenance is required.');
  const normalized={...provenance,observedAt:new Date(provenance.observedAt||Date.now()).toISOString()};
  const provenanceHash=sha256(canonicalJson(normalized));
  const r=await db.query('SELECT * FROM astra.reconcile_economics_quota($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::jsonb,$7)',[actor.tenantId,id,state,actualMicrousd,providerBillId,JSON.stringify(normalized),provenanceHash]);
  if(!r.rows[0])fail('Quota reservation not found or already reconciled.',409,'economics_reservation_unavailable');
  return {id,state:r.rows[0].state,actualMicrousd:r.rows[0].actual_microusd===null?null:String(r.rows[0].actual_microusd)};
}

/** Immutable provider invoice ingestion deduplicates on provider + immutable bill id. */
export async function recordAstraVendorBill(db,actor,input){
  if(!isObject(input))fail('Bill record must be an object.');
  const provider=text(input.provider,'provider',80),billId=text(input.providerBillId,'providerBillId',200),currency=text(input.currency,'currency',3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))fail('ISO currency code required.');const amount=integer(input.amountMinor,'amountMinor',0,9000000000000000);
  const billedAt=new Date(input.billedAt);if(Number.isNaN(billedAt.valueOf()))fail('billedAt must be a valid date.');
  const linkedUsage=input.linkedUsageId===undefined||input.linkedUsageId===null?null:uuid(input.linkedUsageId);
  const provenance=isObject(input.provenance)?input.provenance:null;if(!provenance||!['provider_invoice','provider_api'].includes(provenance.kind)||typeof provenance.reference!=='string')fail('Provider bill provenance is required.');
  const normalized={provider,providerBillId:billId,amountMinor:amount,currency,linkedUsageId:linkedUsage,billedAt:billedAt.toISOString(),evidence:provenance};const hash=sha256(canonicalJson(normalized));
  const r=await db.query(`INSERT INTO astra.economics_vendor_bills(tenant_id,id,provider,provider_bill_id,amount_minor,currency,billed_at,linked_usage_id,provenance,provenance_sha256,recorded_by)
    VALUES($1::uuid,gen_random_uuid(),$2,$3,$4::bigint,$5,$6,$7::uuid,$8::jsonb,$9,$10)
    ON CONFLICT(tenant_id,provider,provider_bill_id) DO NOTHING RETURNING provider_bill_id`,[actor.tenantId,provider,billId,amount,currency,billedAt.toISOString(),linkedUsage,JSON.stringify(normalized),hash,String(actor.userId)]);
  if(!r.rowCount){const prior=await db.query(`SELECT provenance_sha256 FROM astra.economics_vendor_bills WHERE tenant_id=$1::uuid AND provider=$2 AND provider_bill_id=$3`,[actor.tenantId,provider,billId]);if(prior.rows[0]?.provenance_sha256!==hash)fail('Provider bill ID already exists with different provenance.',409,'economics_bill_conflict');}
  return {provider,billId,recorded:Boolean(r.rowCount),duplicate:!r.rowCount};
}

export async function recordAstraReviewerEffort(db,actor,input){
  if(!isObject(input)||Object.keys(input).some(k=>!['taskId','category','minutes','occurredAt','provenance'].includes(k)))fail('Unsupported reviewer-effort fields.');
  const category=input.category;if(!['exception_review','quality_review','correction','escalation','other'].includes(category))fail('Unsupported intervention category.');
  const minutes=integer(input.minutes,'minutes',0,1000000),at=new Date(input.occurredAt);if(Number.isNaN(at.valueOf()))fail('occurredAt must be valid.');
  const provenance=isObject(input.provenance)?input.provenance:null;if(!provenance||typeof provenance.reference!=='string'||!provenance.reference.trim())fail('Reviewer effort evidence reference is required.');
  const normalized={...provenance,occurredAt:at.toISOString()},id=randomUUID();
  await db.query(`INSERT INTO astra.economics_reviewer_effort(tenant_id,id,task_id,category,minutes,occurred_at,provenance,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8)`,[actor.tenantId,id,input.taskId?uuid(input.taskId):null,category,minutes,at.toISOString(),JSON.stringify(normalized),String(actor.userId)]);
  return {id,category,minutes,occurredAt:at.toISOString()};
}

export const ASTRA_ECONOMICS_LIMITS=Object.freeze({maxAmountMinor:9000000000000000,maxPercentileSamples:1000000,currencies:'ISO 4217'});
