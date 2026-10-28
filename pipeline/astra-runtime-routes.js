import { createAstraTenantStore } from './astra-tenant-store.js';
import { normalizeAstraTenantId, normalizeAstraUserId } from './astra-tenant-context.js';
import { runAstraWorkflowOnce } from './astra-harness.js';
import { scheduleWorkflow } from './astra-workflow.js';
import { ASTRA_RESEARCH_READ_TOOL, buildAstraResearchHarnessTask, buildAstraResearchPolicyPin } from './astra-runtime.js';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';

const PATH = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/automation(?:\/(?<action>status|run-once|research))$/;
const OPERATOR_ROLES = ['owner', 'admin', 'operator'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RIGHTS_POLICIES = new Set(['synthetic_fixture', 'user_provided', 'licensed', 'public_terms_permitted']);
let workerStore = null;

export class AstraRuntimeError extends Error {
  constructor(message, statusCode = 503, code = 'astra_worker_unavailable') { super(message); this.name = 'AstraRuntimeError'; this.statusCode = statusCode; this.code = code; }
}

function getWorkerStore() {
  if (!workerStore) workerStore = createAstraTenantStore({ connectionString: process.env.ASTRA_WORKER_DATABASE_URL?.trim() || '' });
  return workerStore;
}

/** A one-pass request is explicitly started by a verified operator; no poller is started on import. */
export function requestAstraWorkflowRun({ store, tenantId, userId, workerId = 'astra-manual-run', limits = {}, legacyDb = null }) {
  if (!store && !process.env.ASTRA_WORKER_DATABASE_URL?.trim()) throw new AstraRuntimeError('A dedicated Astra worker database connection is not configured.');
  store ||= getWorkerStore();
  return runAstraWorkflowOnce({ store, tenantId: normalizeAstraTenantId(tenantId), userId: normalizeAstraUserId(userId), workerId, limits, legacyDb });
}

export function registerAstraRuntimeRoutes(registerAstraApiRoute, { store: suppliedStore } = {}) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  const workerConfigured = Boolean(suppliedStore || process.env.ASTRA_WORKER_DATABASE_URL?.trim());
  const store = suppliedStore || getWorkerStore();
  const handler = async (req, res, context) => {
    const { params, actor, db, readJson, sendJson, afterCommit, legacyDb } = context;
    if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
      return sendJson(res, { error: 'Verified tenant membership is required.', code: 'tenant_membership_required' }, 403);
    }
    if (params.action === 'status' && req.method === 'GET') {
      const counts = await db.query(`SELECT state,count(*)::int AS count FROM astra.workflows WHERE tenant_id=$1::uuid
        GROUP BY state ORDER BY state`, [actor.tenantId]);
      const recent = await db.query(`SELECT id,task_type AS "taskType",state,attempt,created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
        FROM astra.workflows WHERE tenant_id=$1::uuid ORDER BY created_at DESC LIMIT 10`, [actor.tenantId]);
      return sendJson(res, { data: { worker: 'manual-run-only', workerConfigured, automaticStart: false, states: counts.rows, recent: recent.rows,
        capabilities: { research: { enabled: true, maxEvidenceRecords: 6,
          queuePath: `/api/astra/tenants/${actor.tenantId}/automation/research`,
          runPath: `/api/astra/tenants/${actor.tenantId}/automation/run-once`, requiresExplicitRun: true },
          domainJobs: { enabled: true, kinds: ['verification','drafting','reply_classification'],
            queuePath: `/api/astra/tenants/${actor.tenantId}/automation/domain-jobs/:kind/:jobId`,
            runPath: `/api/astra/tenants/${actor.tenantId}/automation/run-once`, requiresExplicitRun: true, releaseReady: false },
        }, releaseReady: false } }, 200);
    }
    if (params.action === 'research' && req.method === 'POST') {
      const body = await readJson(req, 4096);
      if (Object.keys(body).some(key => !['evidenceIds', 'idempotencyKey'].includes(key)) || !Array.isArray(body.evidenceIds)
        || body.evidenceIds.length < 1 || body.evidenceIds.length > 6
        || body.evidenceIds.some(id => typeof id !== 'string' || !UUID.test(id))) {
        return sendJson(res, { error: 'Select one to six evidence records by ID.', code: 'research_selection_invalid' }, 400);
      }
      const headerKey = req.headers?.['idempotency-key'] ?? req.headers?.get?.('idempotency-key') ?? null;
      const bodyKey = body.idempotencyKey ?? null;
      if ((bodyKey !== null && (typeof bodyKey !== 'string' || !bodyKey.trim() || bodyKey.length > 250))
        || (headerKey !== null && (typeof headerKey !== 'string' || !headerKey.trim() || headerKey.length > 250))
        || (bodyKey && headerKey && bodyKey.trim() !== headerKey.trim())) {
        return sendJson(res, { error: 'Provide one valid idempotency key in the body or header.', code: 'research_idempotency_key_invalid' }, 400);
      }
      const explicitKey = (headerKey || bodyKey)?.trim() || null;
      const requestedIds = [...body.evidenceIds.map(id => id.toLowerCase())].sort();
      if (new Set(requestedIds).size !== requestedIds.length) return sendJson(res, { error: 'Evidence IDs must be unique.', code: 'research_selection_invalid' }, 400);
      const selected = await db.query(`SELECT e.id,e.content_sha256,e.extractor_version,e.captured_at,
          s.normalized_domain,s.rights_policy,s.rights_expires_at,s.robots_allowed,s.rights_attested,
          a.id AS account_id,a.normalized_domain AS account_domain,a.display_domain AS account_display_domain,b.content
        FROM astra.research_evidence e
        JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
        JOIN astra.research_accounts a ON (a.tenant_id,a.normalized_domain)=(e.tenant_id,e.normalized_domain)
        JOIN astra.research_blobs b ON (b.tenant_id,b.sha256)=(e.tenant_id,e.content_sha256)
        WHERE e.tenant_id=$1::uuid AND e.id=ANY($2::uuid[])
        ORDER BY array_position($2::uuid[],e.id)`, [actor.tenantId, requestedIds]);
      if (selected.rows.length !== requestedIds.length) return sendJson(res, { error: 'One or more selected evidence records were not found.', code: 'evidence_not_found' }, 404);
      const rows = selected.rows;
      const invalid = rows.some(row => !row.robots_allowed || !row.rights_attested || !RIGHTS_POLICIES.has(row.rights_policy)
        || (row.rights_expires_at && new Date(row.rights_expires_at).getTime() <= Date.now())
        || !/^[a-f0-9]{64}$/.test(row.content_sha256)
        || createHash('sha256').update(Buffer.from(row.content)).digest('hex') !== row.content_sha256);
      if (invalid) return sendJson(res, { error: 'Selected evidence is stale, damaged, or lacks current recorded use rights.', code: 'source_rights_unavailable' }, 422);

      const policy = buildAstraResearchPolicyPin(rows.map(row => ({ ...row, id: row.id,
        accountId: row.account_id, normalizedDomain: row.normalized_domain,
        displayDomain: row.account_display_domain, normalized_domain: row.normalized_domain })), actor.tenantId);
      const task = buildAstraResearchHarnessTask({ tenantId: actor.tenantId, evidenceRows: rows.map(row => ({ ...row,
        id: row.id, accountId: row.account_id, normalizedDomain: row.normalized_domain,
        displayDomain: row.account_display_domain, contentSha256: row.content_sha256,
        rightsPolicy: row.rights_policy, rightsExpiresAt: row.rights_expires_at,
        robotsAllowed: row.robots_allowed, rightsAttested: row.rights_attested,
      })) });
      // Both the policy pin and the executable tool schema are resolved by
      // server code; callers supply only evidence identifiers.
      if (task.allowedReadTools[0].name !== ASTRA_RESEARCH_READ_TOOL.name || task.policyRefs[0].sha256 !== policy.pin.sha256) {
        throw new AstraRuntimeError('The research task could not be pinned to current tenant evidence.', 503, 'research_task_build_failed');
      }
      const requestDigest = sha256(canonicalJson({ tenantId: actor.tenantId, actorId: String(actor.userId),
        evidence: rows.map(row => ({ evidenceId: row.id, contentSha256: row.content_sha256,
          accountId: row.account_id, normalizedDomain: row.normalized_domain })), policy: policy.pin,
        contractVersion: 'astra-research-request/1.0.0' }));
      const requestKey = explicitKey
        ? `research:explicit:${sha256(explicitKey)}`
        : `research:default:${requestDigest}`;
      // The request binding and workflow insert share the API transaction. The
      // transaction lock makes concurrent retries observe the same binding.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${actor.tenantId}:${requestKey}`]);
      const prior = await db.query(`SELECT request_digest,workflow_id FROM astra.research_workflow_requests
        WHERE tenant_id=$1::uuid AND request_key=$2`, [actor.tenantId, requestKey]);
      if (prior.rowCount) {
        if (prior.rows[0].request_digest !== requestDigest) {
          return sendJson(res, { error: 'Idempotency key was already used for a different research request.', code: 'idempotency_conflict' }, 409);
        }
        const workflow = await db.query(`SELECT id,state FROM astra.workflows WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [actor.tenantId, prior.rows[0].workflow_id]);
        if (!workflow.rowCount) throw new AstraRuntimeError('The bound research workflow is unavailable.', 503, 'research_workflow_binding_invalid');
        return sendJson(res, { data: { id: workflow.rows[0].id, state: workflow.rows[0].state, duplicate: true } }, 200);
      }
      const queued = await scheduleWorkflow(db, actor, { task, priority: 50, taskClass: 'interactive', maxAttempts: 1 });
      await db.query(`INSERT INTO astra.research_workflow_requests(tenant_id,request_key,request_digest,workflow_id,actor_id)
        VALUES($1::uuid,$2,$3,$4::uuid,$5)`, [actor.tenantId, requestKey, requestDigest, queued.id, String(actor.userId)]);
      return sendJson(res, { data: queued }, queued.duplicate ? 200 : 201);
    }
    if (params.action === 'run-once' && req.method === 'POST') {
      const body = await readJson(req, 1024);
      if (Object.keys(body).length) return sendJson(res, { error: 'This endpoint accepts an empty JSON object only.', code: 'run_request_invalid' }, 400);
      if (!workerConfigured) return sendJson(res, { error: 'A dedicated Astra worker database connection is not configured.', code: 'astra_worker_unavailable' }, 503);
      const tenantId = normalizeAstraTenantId(actor.tenantId);
      const userId = normalizeAstraUserId(actor.userId);
      // The hook runs only after the route transaction commits. The worker
      // opens a new signed tenant context and revalidates current membership.
      afterCommit(() => {
        setImmediate(() => { void requestAstraWorkflowRun({ store, tenantId, userId, legacyDb }).catch(() => {}); });
      });
      return sendJson(res, { data: { accepted: true, state: 'run_requested', worker: 'manual-run-only' } }, 202);
    }
    return sendJson(res, { error: 'Method not allowed.', code: 'method_not_allowed' }, 405);
  };
  registerAstraApiRoute({ method: 'GET', path: PATH, handler, allowedRoles: OPERATOR_ROLES });
  registerAstraApiRoute({ method: 'POST', path: PATH, handler, allowedRoles: OPERATOR_ROLES });
  return { registered: [
    'GET /api/astra/tenants/:tenantId/automation/status',
    'POST /api/astra/tenants/:tenantId/automation/research',
    'POST /api/astra/tenants/:tenantId/automation/run-once',
  ] };
}

