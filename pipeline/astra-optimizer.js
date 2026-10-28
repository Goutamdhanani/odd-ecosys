import { createHash, randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';
import { assertGlmEgressApproved, minimizeGlmInput } from './astra-egress.js';
import { executeAstraGlmRequest } from './astra-glm-gateway.js';
import { reserveAstraUsage } from './astra-usage.js';

export const ASTRA_OPTIMIZER_LIMITS = Object.freeze({
  iterations: 12, devExamples: 8, providerCalls: 24, candidateBytes: 12000,
  deadlineMs: 60000, outputTokens: 100, inputTokens: 128000,
});
export const ASTRA_OPTIMIZER_ENGINES = Object.freeze({
  native: 'native_bounded_v1', gepa: 'gepa', dspy: 'dspy',
});
export const ASTRA_OPTIMIZER_ADAPTER_CONTRACT = Object.freeze({
  version: 'astra-optimizer-adapter/1',
  input: ['candidateText', 'declaredLabels', 'evaluateDevelopmentCandidate(candidateText)', 'maxIterations', 'deadlineMs'],
  output: ['candidateText', 'candidateSha256', 'developmentScoreReference'],
  forbidden: ['examples', 'humanLabels', 'validationExamples', 'holdoutExamples', 'automaticApproval', 'productionPromotion', 'networkFallback'],
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYNTHETIC_RIGHTS = new Set(['synthetic_fixture']);
const fail = (message, status = 409, code = 'optimizer_unavailable') => { throw new AstraTenantContextError(message, status, code); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8').digest('hex');

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${field} must be a UUID.`, 400, 'optimizer_input_invalid');
  return value.toLowerCase();
}

function validBudget(value = {}) {
  const allowed = new Set(['iterations', 'maxDevExamples', 'maxProviderCalls', 'deadlineMs']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) {
    fail('Optimizer budget fields are invalid.', 400, 'optimizer_budget_invalid');
  }
  const budget = {
    iterations: value.iterations ?? 2,
    maxDevExamples: value.maxDevExamples ?? 4,
    maxProviderCalls: value.maxProviderCalls ?? 8,
    deadlineMs: value.deadlineMs ?? 30000,
  };
  if (!Number.isInteger(budget.iterations) || budget.iterations < 1 || budget.iterations > ASTRA_OPTIMIZER_LIMITS.iterations
    || !Number.isInteger(budget.maxDevExamples) || budget.maxDevExamples < 2 || budget.maxDevExamples > ASTRA_OPTIMIZER_LIMITS.devExamples
    || !Number.isInteger(budget.maxProviderCalls) || budget.maxProviderCalls < 2 || budget.maxProviderCalls > ASTRA_OPTIMIZER_LIMITS.providerCalls
    || !Number.isInteger(budget.deadlineMs) || budget.deadlineMs < 1000 || budget.deadlineMs > ASTRA_OPTIMIZER_LIMITS.deadlineMs
    || budget.iterations * budget.maxDevExamples > budget.maxProviderCalls) {
    fail('Optimizer budget exceeds the bounded iteration, development-example, provider-call or deadline limit.', 400, 'optimizer_budget_invalid');
  }
  return budget;
}

function assertRights(dataset) {
  const labels = dataset.label_rights;
  const sources = Array.isArray(dataset.source_manifest) ? dataset.source_manifest : [];
  if (dataset.dataset_status !== 'frozen' || labels?.attested !== true || !SYNTHETIC_RIGHTS.has(labels?.basis)
    || !sources.length || sources.some(source => source?.rightsAttested !== true || !SYNTHETIC_RIGHTS.has(source?.rightsBasis))) {
    fail('Optimizer egress requires a frozen development dataset whose label and every source right are explicitly attested synthetic fixtures.', 403, 'optimizer_source_rights_denied');
  }
  if (!Array.isArray(dataset.label_schema) || dataset.label_schema.length < 2 || dataset.label_schema.length > 50
    || dataset.label_schema.some(label => typeof label !== 'string' || label.length > 80)) {
    fail('The frozen optimizer label schema is invalid.', 409, 'optimizer_label_schema_invalid');
  }
}

function makeCandidate(seed, iteration, previous, labels) {
  if (iteration === 0) return seed;
  const hasUnknown = labels.some(label => label.toLowerCase() === 'unknown');
  const guidance = previous?.errors
    ? hasUnknown
      ? 'Use only explicit feature evidence. When the available evidence does not distinguish a declared class, return unknown.'
      : 'Use only explicit feature evidence. Do not infer attributes that are absent from the feature packet.'
    : 'Return exactly one declared label. Do not add explanation or extra output.';
  const labelList = labels.join(', ');
  const addition = `${guidance} Declared labels: ${labelList}.`;
  const next = `${seed.trim()}\n${addition}`.trim();
  if (Buffer.byteLength(next, 'utf8') > ASTRA_OPTIMIZER_LIMITS.candidateBytes) fail('A bounded native candidate exceeded the prompt limit.', 413, 'optimizer_candidate_too_large');
  return next;
}

function score(predictions) {
  const count = predictions.length;
  const correct = predictions.reduce((total, row) => total + Number(row.prediction === row.expectedLabel), 0);
  return { count, correct, errors: count - correct, accuracy: count ? correct / count : null, method: 'exact_label_accuracy_v1' };
}

function developmentFeaturePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) fail('Development packet is invalid.', 409, 'optimizer_dev_packet_invalid');
  const minimized = {};
  for (const key of ['source_count', 'evidence_count', 'recency_days', 'website_present', 'company_size', 'intent_score']) {
    const value = packet[key];
    if (typeof value === 'boolean') minimized[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) minimized[key] = Math.max(-100000, Math.min(100000, value));
  }
  return minimizeGlmInput(minimized, 'synthetic-fixture');
}

function requireWorkerStore(store) {
  if (!store || typeof store.withWorkerTenant !== 'function') fail('A dedicated worker tenant store is required.', 503, 'optimizer_worker_store_required');
}

async function setBlocked(store, tenantId, userId, jobId, code) {
  await store.withWorkerTenant({ tenantId, userId }, async db => {
    await db.query(`UPDATE astra.learning_optimizer_jobs SET state='blocked',diagnostic=$3,diagnostic_code=$4,
      completed_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='prepared'`,
    [tenantId, jobId, code === 'glm_local_preview_egress_denied'
      ? 'Provider egress is disabled in local preview; no optimizer calls were made.'
      : 'Current commercial, privacy or GLM task approval denied optimizer egress; no optimizer calls were made.', code]);
  });
}

async function markFailure(store, tenantId, userId, jobId, fence, { uncertain = false, code = 'optimizer_failed' } = {}) {
  await store.withWorkerTenant({ tenantId, userId }, async db => {
    await db.query(`UPDATE astra.learning_optimizer_jobs SET state=$4,diagnostic=$5,diagnostic_code=$6,
      completed_at=now(),updated_at=now(),lease_until=NULL
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND worker_fence=$3::uuid AND state='running'`,
    [tenantId, jobId, fence, uncertain ? 'uncertain' : 'failed',
      uncertain ? 'At least one provider call has an unresolved outcome; the reservation remains retained and the job will not retry.' : 'Optimizer execution failed; the job is terminal and will not retry.', code]);
  });
}

async function reserveCall(store, tenantId, userId, jobId, fence, { iteration, example, input }) {
  return store.withWorkerTenant({ tenantId, userId }, async db => {
    const job = await db.query(`SELECT state,worker_fence FROM astra.learning_optimizer_jobs
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, jobId]);
    if (job.rows[0]?.state !== 'running' || String(job.rows[0]?.worker_fence) !== fence) {
      fail('Optimizer worker fence is stale; no provider call was dispatched.', 409, 'optimizer_worker_fence_stale');
    }
    const requestId = randomUUID();
    const idempotencyKey = `optimizer:${jobId}:${iteration}:${example.id}`;
    const maxInputTokens = Buffer.byteLength(JSON.stringify(input), 'utf8') + 1024;
    if (maxInputTokens > ASTRA_OPTIMIZER_LIMITS.inputTokens) fail('Optimizer input exceeds the bounded per-call token ceiling.', 413, 'optimizer_input_too_large');
    const reservation = await reserveAstraUsage(db, {
      tenantId, task: 'optimizer_dev_prediction', idempotencyKey, requestId,
      optimizerJobId: jobId,
      input, dataClassification: 'synthetic-fixture',
      maxInputTokens, maxOutputTokens: ASTRA_OPTIMIZER_LIMITS.outputTokens,
    });
    if (reservation.duplicate) fail('A prior optimizer call with this idempotency key already exists; ambiguous work is never retried.', 409, 'optimizer_call_already_reserved');
    const inserted = await db.query(`INSERT INTO astra.learning_optimizer_calls(
      tenant_id,job_id,iteration,example_id,idempotency_key,usage_request_id,input_sha256,state,expected_label
    ) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7,'queued',$8)
    RETURNING id`, [tenantId, jobId, iteration, example.id, idempotencyKey, requestId, digest(input), example.expectedLabel]);
    return { requestId, callId: inserted.rows[0].id };
  });
}

async function saveCall(store, tenantId, userId, jobId, fence, callId, prediction, state = 'succeeded', errorCode = null) {
  await store.withWorkerTenant({ tenantId, userId }, async db => {
    const saved = await db.query(`UPDATE astra.learning_optimizer_calls c SET state=$5,prediction=$6,
        prediction_sha256=$7,diagnostic_code=$8,completed_at=now()
      FROM astra.learning_optimizer_jobs j
      WHERE c.tenant_id=$1::uuid AND c.job_id=$2::uuid AND c.id=$4::uuid
        AND j.tenant_id=c.tenant_id AND j.id=c.job_id AND j.state='running' AND j.worker_fence=$3::uuid
      RETURNING c.id`,
    [tenantId, jobId, fence, callId, state, prediction, prediction === null ? null : digest(prediction), errorCode]);
    if (!saved.rowCount) fail('Optimizer worker fence was lost before call evidence could be saved.', 409, 'optimizer_worker_fence_stale');
  });
}

async function markCallStarted(store, tenantId, userId, jobId, fence, callId) {
  await store.withWorkerTenant({ tenantId, userId }, async db => {
    const started = await db.query(`UPDATE astra.learning_optimizer_calls c SET state='running'
      FROM astra.learning_optimizer_jobs j
      WHERE c.tenant_id=$1::uuid AND c.job_id=$2::uuid AND c.id=$4::uuid AND c.state='queued'
        AND j.tenant_id=c.tenant_id AND j.id=c.job_id AND j.state='running' AND j.worker_fence=$3::uuid
      RETURNING c.id`, [tenantId, jobId, fence, callId]);
    if (!started.rowCount) fail('Optimizer call could not pass its worker fence.', 409, 'optimizer_worker_fence_stale');
  });
}

async function saveIteration(store, tenantId, userId, jobId, fence, {
  iteration, candidatePrompt, predictions, metrics, selected, devSetHash, inputHash,
}) {
  const promptHash = digest(candidatePrompt);
  const predictionHash = digest(predictions.map(row => ({ exampleId: row.id, prediction: row.prediction, expectedLabel: row.expectedLabel })));
  await store.withWorkerTenant({ tenantId, userId }, async db => {
    const current = await db.query(`SELECT state,worker_fence FROM astra.learning_optimizer_jobs
      WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [tenantId, jobId]);
    if (current.rows[0]?.state !== 'running' || String(current.rows[0]?.worker_fence) !== fence) fail('Optimizer worker fence is stale.', 409, 'optimizer_worker_fence_stale');
    await db.query(`INSERT INTO astra.learning_optimizer_results(
      tenant_id,job_id,iteration,candidate_prompt,candidate_sha256,metrics,prediction_sha256,dev_set_sha256,input_sha256,status
    ) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
    [tenantId, jobId, iteration, candidatePrompt, promptHash, JSON.stringify(metrics), predictionHash, devSetHash, inputHash,
      selected ? 'selected_candidate' : 'candidate']);
  });
}

/**
 * One explicit run-once worker. Native search is deterministic prompt mutation
 * plus exact dev-label scoring; all predictions use the canonical reserved GLM
 * gateway. It has no scheduler, model fallback, holdout access or auto-retry.
 */
export async function runAstraOptimizerJob({ store, tenantId, userId, jobId, now = () => Date.now() } = {}) {
  requireWorkerStore(store);
  tenantId = uuid(tenantId, 'tenantId'); jobId = uuid(jobId, 'jobId'); userId = String(userId || '');
  if (!/^[1-9][0-9]{0,39}$/.test(userId)) fail('A verified worker user is required.', 401, 'authenticated_user_required');

  const prepared = await store.withWorkerTenant({ tenantId, userId }, async db => {
    const result = await db.query(`SELECT j.id,j.dataset_id,j.candidate_prompt,j.budget,j.engine,j.state,j.worker_fence,j.lease_until,
        d.label_rights,d.source_manifest,d.label_schema,d.manifest_sha256,d.source_manifest_sha256,d.created_by,d.status dataset_status
      FROM astra.learning_optimizer_jobs j JOIN astra.eval_datasets d
        ON (d.tenant_id,d.id)=(j.tenant_id,j.dataset_id)
      WHERE j.tenant_id=$1::uuid AND j.id=$2::uuid`, [tenantId, jobId]);
    return result.rows[0] || null;
  });
  if (!prepared) fail('Optimizer job was not found.', 404, 'optimizer_job_not_found');
  if (prepared.state !== 'prepared') {
    if (prepared.state === 'running' && prepared.lease_until && new Date(prepared.lease_until).getTime() < now()) {
      await store.withWorkerTenant({ tenantId, userId }, async db => {
        await db.query(`UPDATE astra.learning_optimizer_jobs SET state='uncertain',diagnostic='A worker lease expired; execution will not be retried.',
          diagnostic_code='optimizer_lease_expired',completed_at=now(),updated_at=now(),lease_until=NULL
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='running' AND lease_until<now()`, [tenantId, jobId]);
      });
    }
    return { id: jobId, state: prepared.state, providerCalls: false, releaseReady: false };
  }
  if (prepared.engine !== ASTRA_OPTIMIZER_ENGINES.native) {
    await setBlocked(store, tenantId, userId, jobId, 'optimizer_adapter_unavailable');
    return { id: jobId, state: 'blocked', providerCalls: false, engine: prepared.engine, adapter: 'unavailable_unverified', releaseReady: false };
  }

  try {
    assertRights(prepared);
    if (process.env.ASTRA_OPTIMIZER_EGRESS_AUTHORIZED !== 'enabled') {
      fail('Optimizer-specific egress authority is disabled.', 503, 'optimizer_egress_authority_disabled');
    }
    await assertGlmEgressApproved({ task: 'optimizer_dev_prediction', dataClassification: 'synthetic-fixture' });
  } catch (error) {
    const code = error?.code || 'optimizer_egress_denied';
    await setBlocked(store, tenantId, userId, jobId, code);
    return { id: jobId, state: 'blocked', providerCalls: false, diagnosticCode: code, releaseReady: false };
  }

  const budget = validBudget(prepared.budget);
  const labels = prepared.label_schema;
  const dev = await store.withWorkerTenant({ tenantId, userId }, async db => {
    const result = await db.query(`SELECT e.id,e.input_packet,e.input_sha256,a.final_label,a.adjudicated_by,
        count(DISTINCT n.annotated_by)::int annotation_count
      FROM astra.eval_examples e JOIN astra.eval_adjudications a
        ON (a.tenant_id,a.dataset_id,a.example_id)=(e.tenant_id,e.dataset_id,e.id)
      LEFT JOIN astra.eval_annotations n
        ON (n.tenant_id,n.dataset_id,n.example_id)=(e.tenant_id,e.dataset_id,e.id)
      WHERE e.tenant_id=$1::uuid AND e.dataset_id=$2::uuid AND e.split='development'
      GROUP BY e.id,e.input_packet,e.input_sha256,a.final_label,a.adjudicated_by
      HAVING count(DISTINCT n.annotated_by)>=2
      ORDER BY e.observed_at,e.id LIMIT $3`, [tenantId, prepared.dataset_id, budget.maxDevExamples + 1]);
    return result.rows;
  });
  if (dev.length < 2 || dev.length > budget.maxDevExamples || dev.some(row => !labels.includes(row.final_label)
    || String(row.adjudicated_by) === String(prepared.created_by))) {
    fail('Optimizer requires two to the configured number of independently adjudicated development examples with declared labels.', 409, 'optimizer_dev_cohort_invalid');
  }
  // The query above explicitly includes only development. Holdout and validation
  // rows are never loaded, counted, hashed, passed to a prompt, or scored here.
  const normalizedDev = dev.map(row => {
    const packet = developmentFeaturePacket(row.input_packet);
    return { id: row.id, inputSha256: row.input_sha256, packet, expectedLabel: row.final_label };
  });
  const devSetHash = digest(normalizedDev.map(row => ({ id: row.id, inputSha256: row.inputSha256, labelHash: digest(row.expectedLabel) })));
  const labelCounts = new Map();
  for (const row of normalizedDev) labelCounts.set(row.expectedLabel, (labelCounts.get(row.expectedLabel) || 0) + 1);
  const baselineLabel = [...labelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const baselineMetrics = { kind: 'constant_majority_label_v1', label: baselineLabel, count: normalizedDev.length,
    accuracy: labelCounts.get(baselineLabel) / normalizedDev.length };
  const fence = randomUUID();
  const claim = await store.withWorkerTenant({ tenantId, userId }, async db => {
    const result = await db.query(`UPDATE astra.learning_optimizer_jobs SET state='running',worker_fence=$3::uuid,
        lease_until=now()+($4::integer * interval '1 millisecond'),started_at=COALESCE(started_at,now()),updated_at=now(),
        diagnostic='Native bounded development optimization is running.',diagnostic_code=NULL
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='prepared'
      RETURNING id`, [tenantId, jobId, fence, budget.deadlineMs]);
    if (result.rowCount === 1) {
      await db.query(`INSERT INTO astra.learning_optimizer_provenance(
        tenant_id,job_id,dataset_id,dataset_manifest_sha256,source_manifest_sha256,label_rights_sha256,
        development_set_sha256,partition,label_rights_basis
      ) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,'development','synthetic_fixture')`,
      [tenantId, jobId, prepared.dataset_id, String(prepared.manifest_sha256).trim(),
        String(prepared.source_manifest_sha256).trim(), digest(prepared.label_rights), devSetHash]);
    }
    return result.rowCount === 1;
  });
  if (!claim) return { id: jobId, state: 'not_claimed', providerCalls: false, releaseReady: false };

  const tenantStore = Object.freeze({ withTenant: store.withWorkerTenant });
  const deadline = now() + budget.deadlineMs;
  let best = null;
  let calls = 0;
  try {
    for (let iteration = 0; iteration < budget.iterations; iteration++) {
      if (now() >= deadline) fail('Optimizer deadline expired.', 504, 'optimizer_deadline_exceeded');
      const candidatePrompt = makeCandidate(prepared.candidate_prompt, iteration, best?.metrics, labels);
      const predictions = [];
      for (const example of normalizedDev) {
        if (calls >= budget.maxProviderCalls) fail('Optimizer provider-call budget was exhausted.', 429, 'optimizer_call_budget_exhausted');
        const remaining = deadline - now();
        if (remaining < 1000) fail('Optimizer deadline is too close for another provider call.', 504, 'optimizer_deadline_exceeded');
        const input = minimizeGlmInput({ candidateText: candidatePrompt, featurePacket: example.packet, declaredLabels: labels }, 'synthetic-fixture');
        const reservation = await reserveCall(store, tenantId, userId, jobId, fence, {
        iteration, example, input,
        });
        calls++;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        try {
          await markCallStarted(store, tenantId, userId, jobId, fence, reservation.callId);
          const result = await executeAstraGlmRequest({ tenantStore, tenantId, userId, requestId: reservation.requestId, signal: controller.signal });
          const prediction = result.data?.prediction;
          if (!labels.includes(prediction)) {
            await saveCall(store, tenantId, userId, jobId, fence, reservation.callId, null, 'failed', 'optimizer_prediction_outside_schema');
            fail('Optimizer prediction did not match a declared dataset label.', 502, 'optimizer_prediction_invalid');
          }
          await saveCall(store, tenantId, userId, jobId, fence, reservation.callId, prediction);
          predictions.push({ id: example.id, prediction, expectedLabel: example.expectedLabel });
        } catch (error) {
          const usage = await store.withWorkerTenant({ tenantId, userId }, async db => {
            const q = await db.query(`SELECT state,error_code FROM astra.ai_usage_requests WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, reservation.requestId]);
            return q.rows[0] || null;
          });
          const uncertain = usage?.state === 'uncertain' || usage?.state === 'running' || usage?.state === 'queued';
          await saveCall(store, tenantId, userId, jobId, fence, reservation.callId, null,
            uncertain ? 'uncertain' : 'failed', usage?.error_code || error?.code || 'optimizer_call_failed');
          throw Object.assign(error, { optimizerUncertain: uncertain });
        } finally { clearTimeout(timer); }
      }
      const metrics = score(predictions);
      const inputHash = digest(predictions.map((row, index) => ({ exampleId: row.id, inputSha256: normalizedDev[index].inputSha256 })));
      const selected = !best || metrics.accuracy > best.metrics.accuracy
        || (metrics.accuracy === best.metrics.accuracy && candidatePrompt.localeCompare(best.prompt) < 0);
      await saveIteration(store, tenantId, userId, jobId, fence, {
        iteration, candidatePrompt, predictions, metrics, selected, devSetHash, inputHash,
      });
      if (selected) best = { prompt: candidatePrompt, iteration, metrics, predictions };
    }
    if (!best) fail('No optimizer candidate completed development scoring.', 409, 'optimizer_result_missing');
    const result = {
      algorithm: 'native_bounded_prompt_search_v1', engine: ASTRA_OPTIMIZER_ENGINES.native,
      selectedIteration: best.iteration, selectedPrompt: best.prompt, selectedPromptSha256: digest(best.prompt),
      development: best.metrics, baselineDevelopment: baselineMetrics,
      accuracyDeltaVsBaseline: best.metrics.accuracy - baselineMetrics.accuracy, developmentSetSha256: devSetHash,
      calls, holdoutRead: false, independentHoldoutRequired: true,
      status: 'needs_independent_holdout', releaseReady: false,
    };
    await store.withWorkerTenant({ tenantId, userId }, async db => {
      const finish = await db.query(`UPDATE astra.learning_optimizer_jobs SET state='completed',result=$4::jsonb,
          selected_prompt=$5,selected_prompt_sha256=$6,diagnostic='Candidate is unapproved and requires an independent holdout evaluation.',
          diagnostic_code='needs_independent_holdout',completed_at=now(),updated_at=now(),lease_until=NULL
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND worker_fence=$3::uuid AND state='running' RETURNING id`,
      [tenantId, jobId, fence, JSON.stringify(result), best.prompt, digest(best.prompt)]);
      if (!finish.rowCount) fail('Optimizer worker fence is stale at completion.', 409, 'optimizer_worker_fence_stale');
      await db.query(`UPDATE astra.learning_optimizer_results SET status=CASE WHEN iteration=$3 THEN 'needs_independent_holdout' ELSE 'not_selected' END
        WHERE tenant_id=$1::uuid AND job_id=$2::uuid`, [tenantId, jobId, best.iteration]);
    });
    return { id: jobId, state: 'completed', engine: ASTRA_OPTIMIZER_ENGINES.native,
      candidateStatus: 'needs_independent_holdout', providerCalls: calls, holdoutAccess: false, releaseReady: false };
  } catch (error) {
    const usage = error?.optimizerUncertain === true || ['optimizer_deadline_exceeded', 'glm_deadline_or_cancelled'].includes(error?.code);
    await markFailure(store, tenantId, userId, jobId, fence, { uncertain: usage, code: error?.code || 'optimizer_failed' });
    throw error;
  }
}

export function getAstraOptimizerEngineStatus(engine) {
  if (engine === ASTRA_OPTIMIZER_ENGINES.native) return { engine, available: true, kind: 'native_bounded', provider: 'glm-5.3-api', transport: 'canonical_reserved_gateway' };
  if (engine === ASTRA_OPTIMIZER_ENGINES.gepa || engine === ASTRA_OPTIMIZER_ENGINES.dspy) {
    return { engine, available: false, kind: 'optional_adapter', reason: 'not_installed_or_approved', providerCalls: false };
  }
  return { engine, available: false, kind: 'unknown', providerCalls: false };
}

export { validBudget as normalizeAstraOptimizerBudget };
