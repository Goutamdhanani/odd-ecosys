import { normalizeAstraTenantId } from './astra-tenant-context.js';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { scheduleWorkflow } from './astra-workflow.js';
import { buildAstraDomainHarnessTask, buildAstraConnectorJobInputPin, buildAstraConnectorPolicyPin,
  loadAstraGenerationPolicyPin } from './astra-domain-harness.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const PATH = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/automation\/domain-jobs\/(?<kind>verification|drafting|reply_classification)\/(?<jobId>[0-9a-fA-F-]{36})$/;
const OPERATOR_ROLES = ['owner', 'admin', 'operator'];
const hash = value => sha256(canonicalJson(value));
async function generationSource(db, tenantId, jobId, purpose) {
  const result = await db.query(`SELECT id,task,state,input_hash AS "inputHash",evidence_hash AS "evidenceHash",claim_provenance AS "claimProvenance"
    FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, jobId]);
  const job = result.rows[0];
  const expected = purpose === 'drafting' ? 'campaign_generation' : 'reply_classification';
  if (!job) return null;
  if (job.task !== expected) return { conflict: 'domain_job_kind_mismatch' };
  if (job.state !== 'queued') return { conflict: `domain_job_${job.state}` };
  const { policyHash } = await loadAstraGenerationPolicyPin(db, tenantId);
  const evidence = (job.claimProvenance || []).map(item => ({ evidenceId: item.evidenceId, evidenceHash: item.evidenceHash }));
  return { sourceKind: 'generation', taskPurpose: purpose, inputHash: job.inputHash, evidenceHash: job.evidenceHash,
    policyHash, evidence };
}

async function verificationSource(db, tenantId, jobId) {
  const result = await db.query(`SELECT j.id,j.job_type AS "jobType",j.state,j.payload,j.candidate_id AS "candidateId",j.connector_id AS "connectorId",
      c.provider,c.state AS "connectorState",c.endpoint_host AS "endpointHost",c.public_config AS "publicConfig",c.approval,
      candidate.evidence_id AS "evidenceId",candidate.normalized_value AS "candidateValue",e.content_sha256 AS "contentSha256"
    FROM astra.connector_jobs j JOIN astra.connector_configs c ON (c.tenant_id,c.id)=(j.tenant_id,j.connector_id)
    JOIN astra.research_identity_candidates candidate ON (candidate.tenant_id,candidate.id)=(j.tenant_id,j.candidate_id)
    LEFT JOIN astra.research_evidence e ON (e.tenant_id,e.id)=(candidate.tenant_id,candidate.evidence_id)
    WHERE j.tenant_id=$1::uuid AND j.id=$2::uuid`, [tenantId, jobId]);
  const job = result.rows[0];
  if (!job) return null;
  if (job.jobType !== 'verify_candidate' || job.provider !== 'reacher') return { conflict: 'domain_job_kind_mismatch' };
  if (job.state !== 'queued') return { conflict: `domain_job_${job.state}` };
  const inputHash = buildAstraConnectorJobInputPin({ jobId: job.id, jobType: job.jobType, payload: job.payload, candidateId: job.candidateId,
    connectorId: job.connectorId, evidenceId: job.evidenceId, contentSha256: job.contentSha256 || null, candidateValue: job.candidateValue });
  const evidenceHash = job.contentSha256 || hash({ evidenceId: job.evidenceId });
  const policyHash = buildAstraConnectorPolicyPin({ provider: job.provider, connectorState: job.connectorState, endpointHost: job.endpointHost,
    publicConfig: job.publicConfig, approval: job.approval });
  return { sourceKind: 'connector', taskPurpose: 'verification', inputHash, evidenceHash, policyHash,
    evidence: job.contentSha256 ? [{ evidenceId: job.evidenceId, evidenceHash: job.contentSha256 }] : [] };
}

export function registerAstraDomainHarnessRoutes(registerAstraApiRoute, { store: suppliedStore = null } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  // Resolve the dedicated store at registration time so status can accurately
  // report whether the explicit one-pass worker is configured; this does not
  // start a worker or create a polling loop.
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const handler = async (req, res, context) => {
    const { params, actor, db, readJson, sendJson } = context;
    if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
      return sendJson(res, { error: 'Verified tenant membership is required.', code: 'tenant_membership_required' }, 403);
    }
    const tenantId = normalizeAstraTenantId(actor.tenantId);
    const jobId = String(params.jobId || '').toLowerCase();
    if (!UUID.test(jobId)) return sendJson(res, { error: 'A canonical domain job ID is required.', code: 'domain_job_id_invalid' }, 400);

    if (req.method === 'GET') {
      const binding = await db.query(`SELECT b.workflow_id AS "workflowId",b.source_kind AS "sourceKind",b.domain_job_id AS "domainJobId",
          b.purpose,b.input_hash AS "inputHash",b.evidence_hash AS "evidenceHash",b.policy_hash AS "policyHash",
          w.state AS "workflowState",w.last_error_code AS "workflowErrorCode",w.attempt,w.updated_at AS "workflowUpdatedAt"
        FROM astra.domain_harness_bindings b JOIN astra.workflows w ON (w.tenant_id,w.id)=(b.tenant_id,b.workflow_id)
        WHERE b.tenant_id=$1::uuid AND b.domain_job_id=$2::uuid AND b.purpose=$3 ORDER BY b.created_at DESC LIMIT 1`, [tenantId, jobId, params.kind]);
      let domainStatus = null;
      if (params.kind === 'verification') {
        const row = await db.query(`SELECT state,diagnostic_code AS "diagnosticCode" FROM astra.connector_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, jobId]);
        domainStatus = row.rows[0] || null;
      } else {
        const row = await db.query(`SELECT state,error_code AS "errorCode" FROM astra.generation_jobs WHERE tenant_id=$1::uuid AND id=$2::uuid`, [tenantId, jobId]);
        domainStatus = row.rows[0] || null;
      }
      return sendJson(res, { data: { worker: 'manual-run-only', workerConfigured, automaticStart: false,
        binding: binding.rows[0] || null, domainJob: domainStatus } }, 200);
    }
    if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed.', code: 'method_not_allowed' }, 405);
    const body = await readJson(req, 1024);
    if (Object.keys(body).length) return sendJson(res, { error: 'Queue accepts an empty JSON object only.', code: 'domain_harness_request_invalid' }, 400);

    const source = params.kind === 'verification'
      ? await verificationSource(db, tenantId, jobId)
      : await generationSource(db, tenantId, jobId, params.kind);
    if (!source) return sendJson(res, { error: 'The tenant domain job was not found.', code: 'domain_job_not_found' }, 404);
    if (source.conflict) return sendJson(res, { error: 'Only a queued canonical job with the selected purpose can be linked.', code: source.conflict }, 409);

    const prior = await db.query(`SELECT b.workflow_id AS "workflowId",b.input_hash AS "inputHash",b.evidence_hash AS "evidenceHash",b.policy_hash AS "policyHash",w.state
      FROM astra.domain_harness_bindings b JOIN astra.workflows w ON (w.tenant_id,w.id)=(b.tenant_id,b.workflow_id)
      WHERE b.tenant_id=$1::uuid AND b.source_kind=$2 AND b.domain_job_id=$3::uuid`, [tenantId, source.sourceKind, jobId]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      if (row.inputHash !== source.inputHash || row.evidenceHash !== source.evidenceHash || row.policyHash !== source.policyHash) {
        return sendJson(res, { error: 'The domain job changed after its immutable workflow pin was recorded.', code: 'domain_job_binding_conflict' }, 409);
      }
      return sendJson(res, { data: { workflowId: row.workflowId, state: row.state, duplicate: true, domainJobId: jobId,
        domainJobKind: source.sourceKind, purpose: source.taskPurpose, inputHash: source.inputHash, evidenceHash: source.evidenceHash,
        policyHash: source.policyHash, runPath: `/api/astra/tenants/${tenantId}/automation/run-once`,
        requiresExplicitRun: true, automaticStart: false, releaseReady: false } }, 200);
    }

    const task = buildAstraDomainHarnessTask({ tenantId, kind: source.taskPurpose, jobId, inputHash: source.inputHash,
      evidenceHash: source.evidenceHash, policyHash: source.policyHash, evidence: source.evidence });
    const queued = await scheduleWorkflow(db, actor, { task, priority: 50, taskClass: 'interactive', maxAttempts: 1 });
    const inserted = await db.query(`INSERT INTO astra.domain_harness_bindings(tenant_id,workflow_id,source_kind,domain_job_id,purpose,input_hash,evidence_hash,policy_hash,created_by)
      VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9)
      ON CONFLICT(tenant_id,source_kind,domain_job_id) DO NOTHING
      RETURNING workflow_id AS "workflowId"`, [tenantId, queued.id, source.sourceKind, jobId, source.taskPurpose,
      source.inputHash, source.evidenceHash, source.policyHash, String(actor.userId)]);
    if (!inserted.rowCount) {
      const existing = await db.query(`SELECT workflow_id AS "workflowId",input_hash AS "inputHash",evidence_hash AS "evidenceHash",policy_hash AS "policyHash"
        FROM astra.domain_harness_bindings WHERE tenant_id=$1::uuid AND source_kind=$2 AND domain_job_id=$3::uuid`, [tenantId, source.sourceKind, jobId]);
      const prior = existing.rows[0];
      if (!prior || prior.workflowId !== queued.id || prior.inputHash !== source.inputHash || prior.evidenceHash !== source.evidenceHash || prior.policyHash !== source.policyHash) {
        throw Object.assign(new Error('The domain job is already bound to a different immutable workflow pin.'), { statusCode: 409, code: 'domain_job_binding_conflict' });
      }
    }
    return sendJson(res, { data: { workflowId: queued.id, state: queued.state, duplicate: Boolean(queued.duplicate),
      domainJobId: jobId, domainJobKind: source.sourceKind, purpose: source.taskPurpose,
      inputHash: source.inputHash, evidenceHash: source.evidenceHash, policyHash: source.policyHash,
      runPath: `/api/astra/tenants/${tenantId}/automation/run-once`, requiresExplicitRun: true,
      automaticStart: false, releaseReady: false } }, queued.duplicate ? 200 : 201);
  };
  registerAstraApiRoute({ method: 'GET', path: PATH, handler, allowedRoles: OPERATOR_ROLES });
  registerAstraApiRoute({ method: 'POST', path: PATH, handler, allowedRoles: OPERATOR_ROLES });
  return { registered: [
    'GET /api/astra/tenants/:tenantId/automation/domain-jobs/:kind/:jobId',
    'POST /api/astra/tenants/:tenantId/automation/domain-jobs/:kind/:jobId',
  ], workerConfigured, automaticStart: false, releaseReady: false };
}
