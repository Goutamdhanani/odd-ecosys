import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export class AstraLifecycleError extends Error {
  constructor(message, statusCode = 400, code = 'lifecycle_request_invalid') {
    super(message); this.name = 'AstraLifecycleError'; this.publicMessage = message; this.statusCode = statusCode; this.code = code;
  }
}
const fail = (m, s = 400, c = 'lifecycle_request_invalid') => { throw new AstraLifecycleError(m, s, c); };
const OWNER = new Set(['owner', 'admin']);
const WRITERS = new Set(['owner', 'admin', 'operator']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TABLES = Object.freeze([
  'events','event_outbox','consumer_receipts','outcome_projection','workflows','workflow_attempts',
  'ai_tenant_policies','ai_usage_requests','permission_decisions','suppression_decisions','mailboxes',
  'inbox_threads','inbox_messages','reply_tasks','crm_settings','crm_mappings','crm_outbox','crm_attempts',
  'research_sources','research_blobs','research_evidence','research_accounts','research_identity_candidates',
  'research_audits','research_claims','research_claim_corrections','research_reports','campaigns',
  'campaign_qualifications','campaign_verification_records','campaign_approvals','campaign_dispatch_plans',
  'campaign_dispatch_claims','memory_items','memory_links','memory_tombstones','experiments',
  'experiment_assignments','experiment_exposures','connector_evidence','connector_jobs',
  'verification_adapter_receipts','crm_webhook_receipts','generation_tenant_policies','generation_jobs',
  'decisions','campaign_authorizations','authorization_approvals','authorization_revocations',
  'authorization_exception_requests','authorization_exception_approvals','execution_tickets','execution_attempts',
  'eval_datasets','eval_examples','eval_annotations','eval_adjudications','eval_candidates','eval_scorers',
  'eval_runs','eval_run_results','release_artifacts','release_approvals','release_rollbacks',
  'operational_telemetry','operational_kill_switches','operational_incidents','recovery_requests',
  'engagement_privacy_permissions','engagement_events'
]);
// Deletion requests can guard only these conventional id-column tables. The
// database trigger itself discovers the same shape when migration 014 runs.
const GUARDED_TABLES = new Set([
  'workflows','workflow_attempts','ai_usage_requests','permission_decisions','suppression_decisions','mailboxes',
  'inbox_threads','inbox_messages','reply_tasks','crm_outbox','crm_attempts','research_sources','research_evidence',
  'research_blobs','research_accounts','research_identity_candidates','research_audits','research_claims','research_claim_corrections',
  'research_reports','campaigns','campaign_qualifications','campaign_verification_records','campaign_approvals',
  'campaign_dispatch_plans','memory_items','memory_links','memory_tombstones','experiments','experiment_exposures',
  'connector_evidence','connector_jobs','verification_adapter_receipts','crm_webhook_receipts','generation_jobs',
  'decisions','campaign_authorizations','authorization_approvals','authorization_revocations',
  'authorization_exception_requests','authorization_exception_approvals','execution_tickets','execution_attempts',
  'eval_datasets','eval_examples','eval_candidates','eval_scorers','eval_runs','release_artifacts','release_approvals',
  'release_rollbacks','operational_telemetry','operational_incidents','recovery_requests','engagement_events'
]);
const SECRET_KEY = /(?:password|credential|secret|token|authorization|private.?key|access.?key|refresh.?key|signature|proof|ciphertext)/i;

function actorRole(actor) { return actor?.tenantRole || ''; }
function requireActor(actor, params, roles = WRITERS) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) fail('Verified tenant membership is required.', 403, 'tenant_membership_required');
  if (!roles.has(actorRole(actor))) fail('Tenant role is not permitted for this lifecycle action.', 403, 'tenant_role_forbidden');
}
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') };
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => !SECRET_KEY.test(k)).map(k => [k, stable(value[k])]));
  return value;
}
const json = value => JSON.stringify(stable(value));
const sha = value => createHash('sha256').update(value).digest('hex');
function boundedLimit(value, fallback = 100, max = 500) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`limit must be an integer from 1 to ${max}.`, 400, 'lifecycle_limit_invalid');
  return n;
}
function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) fail('targets must contain 1 to 1000 explicit object references.', 400, 'lifecycle_targets_invalid');
  const seen = new Set();
  return value.map((item, index) => {
    const table = item?.table;
    const id = item?.id;
    if (typeof table !== 'string' || !GUARDED_TABLES.has(table) || typeof id !== 'string' || !id.trim() || id.length > 500) fail(`targets[${index}] must name a supported single-id table and explicit object id.`, 400, 'lifecycle_target_invalid');
    const key = `${table}\n${id}`; if (seen.has(key)) fail('Deletion targets must be unique.', 400, 'lifecycle_targets_duplicate'); seen.add(key);
    return { table, id };
  });
}
function safeRetention(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length > 12) fail('retentionPolicy must be an object.', 400, 'retention_policy_invalid');
  const result = {};
  for (const [key, days] of Object.entries(policy)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key) || !Number.isInteger(days) || days < 1 || days > 3650) fail('Retention values must be integer days from 1 to 3650.', 400, 'retention_policy_invalid');
    result[key] = days;
  }
  if (!Object.keys(result).length) fail('At least one retention duration is required.', 400, 'retention_policy_empty');
  return result;
}

export async function createAstraExportRequest(db, actor, input = {}) {
  if (!WRITERS.has(actorRole(actor))) fail('Tenant operator membership is required.', 403, 'tenant_role_forbidden');
  const rowLimit = boundedLimit(input.rowLimit, 50000, 100000);
  const result = await db.query(`INSERT INTO astra.lifecycle_export_requests(tenant_id,requested_by,row_limit)
    VALUES($1::uuid,$2,$3) RETURNING id,status,row_limit,requested_at,expires_at`, [actor.tenantId, String(actor.userId), rowLimit]);
  return result.rows[0];
}

export async function listAstraExportRequests(db, actor, { limit = 50 } = {}) {
  const result = await db.query(`SELECT id,status,row_limit,manifest,error_code AS "errorCode",requested_at AS "requestedAt",
    completed_at AS "completedAt",expires_at AS "expiresAt" FROM astra.lifecycle_export_requests
    WHERE tenant_id=$1::uuid ORDER BY requested_at DESC,id DESC LIMIT $2`, [actor.tenantId, boundedLimit(limit, 50)]);
  return result.rows;
}

export async function createAstraLifecycleRequest(db, actor, { type, targets, retentionPolicy, legalHold = false, suppressionDigests = [] } = {}) {
  if (!WRITERS.has(actorRole(actor))) fail('Tenant operator membership is required.', 403, 'tenant_role_forbidden');
  if (type !== 'deletion' && type !== 'retention') fail('type must be deletion or retention.', 400, 'lifecycle_type_invalid');
  if (typeof legalHold !== 'boolean') fail('legalHold must be boolean.', 400, 'lifecycle_legal_hold_invalid');
  const normalizedTargets = type === 'deletion' ? normalizeTargets(targets) : [];
  const policy = type === 'retention' ? safeRetention(retentionPolicy) : {};
  if (type === 'deletion' && (!Array.isArray(suppressionDigests) || suppressionDigests.length > 1000
    || suppressionDigests.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
    fail('suppressionDigests must contain at most 1000 lowercase SHA-256 digests.', 400, 'lifecycle_suppression_digest_invalid');
  }
  const refs = type === 'deletion' ? normalizedTargets : [];
  const inventory = await inventoryAstraTenant(db, actor.tenantId);
  const result = await db.query(`INSERT INTO astra.lifecycle_requests(tenant_id,request_type,requested_by,targets,retention_policy,inventory,legal_hold)
    VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
    RETURNING id,request_type AS type,status,targets,retention_policy AS "retentionPolicy",inventory,legal_hold AS "legalHold",requested_at AS "requestedAt"`,
  [actor.tenantId, type, String(actor.userId), JSON.stringify(refs), JSON.stringify(policy), JSON.stringify(inventory), legalHold]);
  if (type === 'deletion') {
    for (const target of refs) await db.query(`INSERT INTO astra.lifecycle_tombstone_guards(tenant_id,table_name,object_id,request_id)
      VALUES($1::uuid,$2,$3,$4::uuid) ON CONFLICT(tenant_id,table_name,object_id) DO NOTHING`, [actor.tenantId, target.table, target.id, result.rows[0].id]);
    for (const digest of suppressionDigests) await db.query(`INSERT INTO astra.lifecycle_suppression_retention(tenant_id,digest,reason_code,source_request_id)
      VALUES($1::uuid,$2,'deletion_request',$3::uuid) ON CONFLICT(tenant_id,digest) DO NOTHING`, [actor.tenantId, digest, result.rows[0].id]);
  }
  return result.rows[0];
}

export async function inventoryAstraTenant(db, tenantId) {
  const counts = {};
  for (const table of SAFE_TABLES) {
    const result = await db.query(`SELECT count(*)::bigint AS count FROM astra.${table} WHERE tenant_id=$1::uuid`, [tenantId]);
    counts[table] = Number(result.rows[0]?.count || 0);
  }
  return {
    observedAt: new Date().toISOString(),
    rowCounts: counts,
    objectClasses: {
      rawSources: { status: 'partially_inventoried', tables: ['research_sources','research_blobs','research_evidence'] },
      summariesAndMemory: { status: 'inventoried', tables: ['research_reports','memory_items','memory_links'] },
      indexesAndCaches: { status: 'not_connected', detail: 'No lifecycle adapter is configured for external indexes or caches.' },
      connectors: { status: 'metadata_only', tables: ['connector_evidence','connector_jobs'], credentialsExcluded: true },
      logs: { status: 'partially_inventoried', tables: ['operational_telemetry','operational_incidents'] },
      objectStore: { status: 'not_connected', detail: 'No object-store inventory or deletion adapter is configured.' },
      backups: { status: 'unknown', expiry: null, detail: 'Backup retention and expiry are controlled outside this database and are not reported as known.' },
      canonicalHistory: { status: 'retained', tables: ['events','event_outbox','consumer_receipts'], immutable: true },
    },
  };
}

export async function listAstraLifecycleRequests(db, actor, { limit = 50 } = {}) {
  const result = await db.query(`SELECT id,request_type AS type,status,targets,retention_policy AS "retentionPolicy",inventory,receipt,
    legal_hold AS "legalHold",requested_at AS "requestedAt",planned_at AS "plannedAt",cancelled_at AS "cancelledAt"
    FROM astra.lifecycle_requests WHERE tenant_id=$1::uuid ORDER BY requested_at DESC,id DESC LIMIT $2`, [actor.tenantId, boundedLimit(limit, 50)]);
  return result.rows;
}

export async function cancelAstraLifecycleRequest(db, actor, requestId) {
  if (!UUID.test(requestId || '')) fail('Lifecycle request ID must be a UUID.', 400, 'lifecycle_id_invalid');
  const locked = await db.query(`SELECT id FROM astra.lifecycle_requests WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='prepared' FOR UPDATE`, [actor.tenantId, requestId]);
  if (!locked.rows[0]) fail('Only a prepared lifecycle request can be cancelled.', 409, 'lifecycle_cancel_unavailable');
  const result = await db.query(`UPDATE astra.lifecycle_requests SET status='cancelled',cancelled_at=pg_catalog.clock_timestamp()
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='prepared' RETURNING id,status,cancelled_at AS "cancelledAt"`, [actor.tenantId, requestId]);
  if (!result.rows[0]) fail('Only a prepared lifecycle request can be cancelled.', 409, 'lifecycle_cancel_unavailable');
  await db.query(`DELETE FROM astra.lifecycle_tombstone_guards WHERE tenant_id=$1::uuid AND request_id=$2::uuid`, [actor.tenantId, requestId]);
  return result.rows[0];
}

export async function planAstraLifecycleRequest(db, actor, requestId) {
  if (!UUID.test(requestId || '')) fail('Lifecycle request ID must be a UUID.', 400, 'lifecycle_id_invalid');
  const found = await db.query(`SELECT id,request_type,targets,retention_policy,inventory,legal_hold,status
    FROM astra.lifecycle_requests WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [actor.tenantId, requestId]);
  const request = found.rows[0]; if (!request) fail('Lifecycle request was not found.', 404, 'lifecycle_request_not_found');
  if (request.status !== 'prepared') fail('Only a prepared lifecycle request can be planned.', 409, 'lifecycle_plan_unavailable');
  const receipt = {
    schemaVersion: 'astra-lifecycle-receipt/1', requestId,
    outcome: request.request_type === 'deletion' ? 'deletion_plan_prepared' : 'retention_policy_prepared',
    preparedAt: new Date().toISOString(), physicalDeletionPerformed: false,
    targets: request.targets,
    retentionPolicy: request.retention_policy,
    legalHold: request.legal_hold,
    suppression: { retained: true, representation: 'tenant-scoped normalized SHA-256 digest only', expiry: null },
    immutableHistory: { retained: true, detail: 'Canonical event ledger, outbox and receipts remain append-only.' },
    backupExpiry: { status: 'unknown', expiresAt: null, detail: 'No backup inventory/expiry adapter is configured.' },
    inventory: request.inventory,
    limitations: ['This receipt records a prepared plan; it is not a claim of full erasure.', 'External indexes, caches, object stores, connector providers, logs outside Astra and backups require separately configured adapters.'],
    resurrectionGuard: { status: 'partial', protects: 'future inserts matching explicit tenant/table/id targets on conventional id-column Astra tables present when migration 014 was applied',
      excludes: ['updates to existing rows','composite/link rows without an id column','tables introduced after migration 014','external object stores, caches, indexes, providers, or restores performed outside Astra'] },
  };
  const result = await db.query(`UPDATE astra.lifecycle_requests SET status='plan_ready',planned_at=pg_catalog.clock_timestamp(),receipt=$3::jsonb
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='prepared' RETURNING id,status,receipt,planned_at AS "plannedAt"`,
  [actor.tenantId, requestId, JSON.stringify(receipt)]);
  return result.rows[0];
}

function scrub(value) { return stable(value); }
async function buildExport(client, tenantId, exportId, rowLimit) {
  const records = [];
  const tableCounts = {};
  let left = rowLimit;
  for (const table of SAFE_TABLES) {
    if (left <= 0) { tableCounts[table] = { exported: 0, truncated: true }; continue; }
    const result = await client.query(`SELECT * FROM astra.${table} WHERE tenant_id=$1::uuid LIMIT $2`, [tenantId, left + 1]);
    const rows = result.rows.slice(0, left).map(scrub);
    records.push(...rows.map(row => ({ type: 'row', table, data: row })));
    tableCounts[table] = { exported: rows.length, truncated: result.rows.length > left };
    left -= rows.length;
  }
  const ndjson = records.map(json).join('\n') + (records.length ? '\n' : '');
  if (Buffer.byteLength(ndjson) > 50 * 1024 * 1024) fail('Export exceeds the 50 MiB uncompressed size limit.', 413, 'lifecycle_export_too_large');
  const manifest = { schemaVersion: 'astra-export/1', exportId, tenantId, generatedAt: new Date().toISOString(), rowCount: records.length,
    rowLimit, tables: tableCounts, contentSha256: sha(ndjson), contentBytes: Buffer.byteLength(ndjson), credentialsIncluded: false,
    omittedClasses: ['connector credentials and encrypted secrets','external object store contents','external caches/indexes','backup contents'] };
  const full = `${json({ type: 'manifest', manifest })}\n${ndjson}`;
  const content = gzipSync(Buffer.from(full, 'utf8'), { level: 9 });
  return { content, manifest, sha256: sha(content), byteLength: content.byteLength };
}

/** Manually invoked worker; no poller is created. Claim is committed before building the artifact. */
export async function runAstraExportWorker({ store, tenantId, userId, exportId }) {
  if (!store || typeof store.withWorkerTenant !== 'function') fail('Dedicated Astra worker store is required.', 503, 'astra_worker_unavailable');
  if (!UUID.test(exportId || '')) fail('Export ID must be a UUID.', 400, 'lifecycle_id_invalid');
  const claim = await store.withWorkerTenant({ tenantId, userId }, async (db, membership) => {
    const row = await db.query(`UPDATE astra.lifecycle_export_requests SET status='running',started_at=COALESCE(started_at,pg_catalog.clock_timestamp())
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='queued' AND expires_at>pg_catalog.clock_timestamp()
      RETURNING id,row_limit`, [membership.tenantId, exportId]);
    if (!row.rows[0]) fail('Queued export was not found.', 404, 'lifecycle_export_not_found');
    return row.rows[0];
  });
  try { return await store.withWorkerTenant({ tenantId, userId }, async (db, membership) => {
    const built = await buildExport(db, membership.tenantId, exportId, claim.row_limit);
    await db.query(`INSERT INTO astra.lifecycle_export_artifacts(tenant_id,export_id,filename,content,sha256,byte_length)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6) ON CONFLICT(tenant_id,export_id) DO NOTHING`,
    [membership.tenantId, exportId, `astra-export-${exportId}.jsonl.gz`, built.content, built.sha256, built.byteLength]);
    await db.query(`UPDATE astra.lifecycle_export_requests SET status='complete',manifest=$3::jsonb,completed_at=pg_catalog.clock_timestamp()
      WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='running'`, [membership.tenantId, exportId, JSON.stringify(built.manifest)]);
    return { exportId, status: 'complete', manifest: built.manifest, sha256: built.sha256, byteLength: built.byteLength };
  }); } catch (error) {
    await store.withWorkerTenant({ tenantId, userId }, async (db, membership) => {
      await db.query(`UPDATE astra.lifecycle_export_requests SET status='failed',error_code='export_build_failed',completed_at=pg_catalog.clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='running'`, [membership.tenantId, exportId]);
    }).catch(() => {});
    throw error;
  }
}

export async function getAstraExportArtifact(db, actor, exportId) {
  if (!UUID.test(exportId || '')) fail('Export ID must be a UUID.', 400, 'lifecycle_id_invalid');
  if (!OWNER.has(actorRole(actor))) fail('Owner or admin membership is required to download exports.', 403, 'tenant_role_forbidden');
  const result = await db.query(`SELECT r.status,r.expires_at,a.filename,a.content_type,a.content,a.sha256,a.byte_length
    FROM astra.lifecycle_export_requests r JOIN astra.lifecycle_export_artifacts a ON (a.tenant_id,a.export_id)=(r.tenant_id,r.id)
    WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid`, [actor.tenantId, exportId]);
  const row = result.rows[0];
  if (!row || row.status !== 'complete' || new Date(row.expires_at).getTime() <= Date.now()) fail('Export artifact was not found or has expired.', 404, 'lifecycle_export_not_found');
  return { filename: row.filename, contentType: row.content_type, content: row.content, sha256: row.sha256.trim(), byteLength: Number(row.byte_length) };
}

export const ASTRA_LIFECYCLE_EXPORT_TABLES = SAFE_TABLES;
export const ASTRA_LIFECYCLE_GUARDED_TABLES = Object.freeze([...GUARDED_TABLES]);
