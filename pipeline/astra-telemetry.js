import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './astra-ledger.js';

const ALLOWED_KINDS = new Set([
  'task.started', 'task.completed', 'task.failed', 'decision.recorded',
  'queue.observed', 'usage.observed', 'dispatcher.blocked', 'dispatcher.outcome',
  'incident.opened', 'recovery.requested', 'recovery.receipt',
]);
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,160}$/;
const OPTIONAL_IDS = new Set(['taskId', 'decisionId', 'campaignId', 'mailboxId', 'workflowId', 'ticketId', 'canonicalFactId']);
const SAFE_FIELDS = new Set(['durationMs', 'queueDepth', 'queueLimit', 'usedUnits', 'limitUnits', 'costMinor', 'outcome', 'errorCode', 'state', 'source', 'severity', 'rtoSeconds', 'rpoSeconds']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');

export class AstraTelemetryError extends Error {
  constructor(message, statusCode = 400, code = 'telemetry_invalid') { super(message); this.name = 'AstraTelemetryError'; this.statusCode = statusCode; this.code = code; this.publicMessage = message; }
}

function normalizePayload(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraTelemetryError('Telemetry payload must be an object.');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (OPTIONAL_IDS.has(key)) {
      if (typeof value !== 'string' || !UUID.test(value)) throw new AstraTelemetryError('Telemetry reference is invalid.');
      result[key] = value;
    } else if (SAFE_FIELDS.has(key)) {
      if (['durationMs', 'queueDepth', 'queueLimit', 'usedUnits', 'limitUnits', 'costMinor', 'rtoSeconds', 'rpoSeconds'].includes(key)) {
        if (!Number.isSafeInteger(value) || value < 0) throw new AstraTelemetryError('Numeric telemetry value is invalid.');
        result[key] = value;
      } else {
        if (typeof value !== 'string' || !SAFE_VALUE.test(value)) throw new AstraTelemetryError('Telemetry value is invalid.');
        result[key] = value;
      }
    } else throw new AstraTelemetryError('Telemetry field is not permitted.');
  }
  return result;
}

export async function recordAstraTelemetry(client, actor, { kind, payload = {}, taskId = null, decisionId = null, canonicalFactId = null, occurredAt = new Date() } = {}) {
  if (!ALLOWED_KINDS.has(kind)) throw new AstraTelemetryError('Telemetry event kind is not permitted.');
  const safe = normalizePayload(payload);
  const ids = { taskId: taskId || safe.taskId || null, decisionId: decisionId || safe.decisionId || null, canonicalFactId: canonicalFactId || safe.canonicalFactId || null };
  if (kind.startsWith('task.') && !ids.taskId) throw new AstraTelemetryError('Task telemetry must link to its task.', 400, 'task_reference_required');
  if (kind === 'decision.recorded' && !ids.decisionId) throw new AstraTelemetryError('Decision telemetry must link to its decision.', 400, 'decision_reference_required');
  if (Object.hasOwn(safe, 'costMinor') && !ids.canonicalFactId) throw new AstraTelemetryError('Cost telemetry must reference a canonical fact.', 400, 'canonical_fact_required');
  const parsedTime = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (!Number.isFinite(parsedTime.valueOf())) throw new AstraTelemetryError('Telemetry timestamp is invalid.');
  const time = parsedTime.toISOString();
  const event = { schemaVersion: 1, tenantId: actor.tenantId, kind, ...ids, occurredAt: time, payload: safe };
  const eventHash = digest(canonicalJson(event));
  const result = await client.query(`INSERT INTO astra.operational_telemetry
    (tenant_id,id,kind,task_id,decision_id,canonical_fact_id,occurred_at,payload,payload_sha256,created_by)
    VALUES($1,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::timestamptz,$8::jsonb,$9,$10)
    RETURNING id,kind,task_id AS "taskId",decision_id AS "decisionId",canonical_fact_id AS "canonicalFactId",occurred_at AS "occurredAt",payload_sha256 AS "payloadHash"`,
  [actor.tenantId, randomUUID(), kind, ids.taskId, ids.decisionId, ids.canonicalFactId, time, JSON.stringify(safe), eventHash, String(actor.userId)]);
  return result.rows[0];
}

export async function listAstraTelemetry(client, tenantId, { since = null, limit = 100 } = {}) {
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
  const result = await client.query(`SELECT id,kind,task_id AS "taskId",decision_id AS "decisionId",canonical_fact_id AS "canonicalFactId",
      occurred_at AS "occurredAt",payload,payload_sha256 AS "payloadHash"
    FROM astra.operational_telemetry WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR occurred_at >= $2::timestamptz)
    ORDER BY occurred_at DESC,id DESC LIMIT $3`, [tenantId, since, bounded]);
  return result.rows;
}

export function normalizeAstraTelemetryDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new AstraTelemetryError('Telemetry timestamp is invalid.');
  return date.toISOString();
}
