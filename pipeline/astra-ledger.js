import { createHash, randomUUID } from 'node:crypto';

export const ASTRA_EVENT_SCHEMA_VERSION = 1;
export const ASTRA_EVENT_TYPES = Object.freeze([
  'meeting.booked', 'meeting.held', 'meeting.cancelled',
  'opportunity.created', 'opportunity.qualified', 'opportunity.won', 'opportunity.lost',
  'revenue.paid', 'revenue.refunded', 'outcome.labelled',
  'outcome.corrected', 'outcome.reversed',
  'campaign.created', 'campaign.qualified', 'campaign.draft_saved', 'campaign.approved',
  'campaign.dispatch_plan_prepared', 'campaign.dispatch_quarantined',
  'workflow.scheduled', 'workflow.claimed', 'workflow.checkpointed',
  'workflow.completed', 'workflow.failed', 'workflow.cancelled',
]);

export class AstraLedgerError extends Error {
  constructor(message, status = 400, code = 'astra_ledger_error') {
    super(message);
    this.name = 'AstraLedgerError';
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

const jsonValue = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonValue).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${jsonValue(value[key])}`).join(',')}}`;
};

export const canonicalJson = value => jsonValue(value);
export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');

function requiredText(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AstraLedgerError(`${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function validDate(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new AstraLedgerError(`${field} must be an ISO date.`);
  return date.toISOString();
}

function validateProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AstraLedgerError('provenance is required and must be an object.');
  }
  const source = requiredText(value.source, 'provenance.source', 120);
  const sourceConfidence = value.confidence ?? 'unknown';
  if (!['high', 'medium', 'low', 'unknown'].includes(sourceConfidence)) {
    throw new AstraLedgerError('provenance.confidence must be high, medium, low, or unknown.');
  }
  const authority = value.fieldAuthority ?? 'source';
  if (!['crm', 'human', 'system', 'source'].includes(authority)) {
    throw new AstraLedgerError('provenance.fieldAuthority is invalid.');
  }
  return {
    source,
    sourceId: value.sourceId == null ? null : requiredText(value.sourceId, 'provenance.sourceId', 500),
    externalEventId: value.externalEventId == null ? null : requiredText(value.externalEventId, 'provenance.externalEventId', 500),
    evidenceRef: value.evidenceRef == null ? null : requiredText(value.evidenceRef, 'provenance.evidenceRef', 1000),
    confidence: sourceConfidence,
    fieldAuthority: authority,
  };
}

export function normalizeEvent(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraLedgerError('Event body must be an object.');
  const eventType = requiredText(input.eventType, 'eventType', 80);
  if (!ASTRA_EVENT_TYPES.includes(eventType)) throw new AstraLedgerError('Unsupported Astra event type.');
  const version = input.schemaVersion ?? ASTRA_EVENT_SCHEMA_VERSION;
  if (version !== ASTRA_EVENT_SCHEMA_VERSION) throw new AstraLedgerError('Unsupported event schemaVersion.');
  const entity = input.entity;
  if (!entity || typeof entity !== 'object') throw new AstraLedgerError('entity is required.');
  const entityType = requiredText(entity.type, 'entity.type', 80);
  const entityId = requiredText(entity.id, 'entity.id', 500);
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 250);
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AstraLedgerError('payload must be an object.');
  if (eventType.startsWith('workflow.') && (!/^[0-9a-f-]{36}$/i.test(entityId)
    || entityType !== 'astra_workflow' || typeof payload.workflowId !== 'string'
    || payload.workflowId !== entityId || typeof payload.state !== 'string')) {
    throw new AstraLedgerError('Workflow ledger events require a matching workflow identity and state.');
  }
  if (['revenue.paid', 'revenue.refunded'].includes(eventType)
    && (!Number.isSafeInteger(payload.amountMinor) || payload.amountMinor < 0 || !/^[A-Z]{3}$/.test(payload.currency || ''))) {
    throw new AstraLedgerError(`${eventType} requires a non-negative integer amountMinor and uppercase ISO currency.`);
  }
  if (eventType === 'outcome.labelled' && (typeof payload.label !== 'string' || !payload.label.trim())) {
    throw new AstraLedgerError('outcome.labelled requires a label.');
  }
  if (eventType === 'outcome.corrected' && (!payload.replacement || typeof payload.replacement !== 'object'
    || !['meeting_booked','meeting_held','meeting_cancelled','opportunity_created','opportunity_qualified',
      'opportunity_won','opportunity_lost','revenue_paid','revenue_refunded','label'].includes(payload.replacement.stage))) {
    throw new AstraLedgerError('outcome.corrected requires a supported replacement outcome.');
  }
  if (eventType === 'outcome.corrected' && ['revenue_paid','revenue_refunded'].includes(payload.replacement.stage)
    && (!Number.isSafeInteger(payload.replacement.amountMinor) || payload.replacement.amountMinor < 0
      || !/^[A-Z]{3}$/.test(payload.replacement.currency || ''))) {
    throw new AstraLedgerError('Revenue corrections require a non-negative integer amountMinor and uppercase ISO currency.');
  }
  if (eventType === 'outcome.corrected' && payload.replacement.stage === 'label'
    && (typeof payload.replacement.label !== 'string' || !payload.replacement.label.trim())) {
    throw new AstraLedgerError('Label corrections require a label.');
  }
  const correctsEventId = input.correctsEventId == null ? null : requiredText(input.correctsEventId, 'correctsEventId', 80);
  if (['outcome.corrected', 'outcome.reversed'].includes(eventType) && !correctsEventId) {
    throw new AstraLedgerError(`${eventType} requires correctsEventId.`);
  }
  if (!['outcome.corrected', 'outcome.reversed'].includes(eventType) && correctsEventId) {
    throw new AstraLedgerError('correctsEventId is only valid on correction or reversal events.');
  }
  if (!actor?.userId) throw new AstraLedgerError('A verified actor is required.', 403, 'actor_required');
  return {
    id: randomUUID(), schemaVersion: version, eventType,
    entityType, entityId,
    actorId: String(actor.userId),
    occurredAt: validDate(input.occurredAt, 'occurredAt'),
    payload,
    provenance: validateProvenance(input.provenance),
    idempotencyKey,
    correctsEventId,
  };
}

export async function appendEvent(client, actor, input) {
  const event = normalizeEvent(input, actor);
  const payloadHash = sha256(canonicalJson({
    schemaVersion: event.schemaVersion, eventType: event.eventType, entityType: event.entityType,
    entityId: event.entityId, actorId: event.actorId, occurredAt: event.occurredAt, payload: event.payload,
    provenance: event.provenance, correctsEventId: event.correctsEventId,
  }));

  // The application role intentionally has no UPDATE privilege on ledger_heads.
  // A transaction advisory lock serializes writers for this tenant; the event
  // trigger advances the protected head with owner privileges after INSERT.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [actor.tenantId]);
  await client.query(`INSERT INTO astra.ledger_heads(tenant_id, last_seq, last_hash)
    VALUES ($1, 0, $2) ON CONFLICT (tenant_id) DO NOTHING`, [actor.tenantId, '0'.repeat(64)]);
  const head = (await client.query(`SELECT last_seq, last_hash FROM astra.ledger_heads
    WHERE tenant_id=$1`, [actor.tenantId])).rows[0];
  const prior = await client.query(`SELECT id, payload_hash FROM astra.events
    WHERE tenant_id=$1 AND (idempotency_key=$2 OR ($3::text IS NOT NULL
      AND provenance->>'source'=$4 AND provenance->>'externalEventId'=$3))`, [
    actor.tenantId, event.idempotencyKey, event.provenance.externalEventId, event.provenance.source,
  ]);
  if (prior.rowCount) {
    if (prior.rows.some(row => row.payload_hash !== payloadHash) || new Set(prior.rows.map(row => row.id)).size > 1) {
      throw new AstraLedgerError('Idempotency key was already used with a different event payload.', 409, 'idempotency_conflict');
    }
    return { id: prior.rows[0].id, duplicate: true };
  }

  if (event.correctsEventId) {
    const target = await client.query(`SELECT entity_type, entity_id FROM astra.events WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, event.correctsEventId]);
    if (!target.rowCount) throw new AstraLedgerError('Correction target was not found for this tenant.', 404, 'correction_target_missing');
    if (target.rows[0].entity_type !== event.entityType || target.rows[0].entity_id !== event.entityId) {
      throw new AstraLedgerError('Correction target must refer to the same entity.', 409, 'correction_entity_mismatch');
    }
  }

  const sequence = BigInt(head.last_seq) + 1n;
  const recordedAt = new Date().toISOString();
  const previousHash = head.last_hash;
  const body = {
    id: event.id, tenantId: actor.tenantId, sequence: sequence.toString(), schemaVersion: event.schemaVersion,
    eventType: event.eventType, entityType: event.entityType, entityId: event.entityId,
    actorId: event.actorId, occurredAt: event.occurredAt, recordedAt,
    payload: event.payload, provenance: event.provenance, correctsEventId: event.correctsEventId,
    idempotencyKey: event.idempotencyKey, payloadHash, previousHash,
  };
  const eventHash = sha256(`${previousHash}\n${canonicalJson(body)}`);
  await client.query(`INSERT INTO astra.events
    (tenant_id,id,sequence,schema_version,event_type,entity_type,entity_id,actor_id,occurred_at,recorded_at,
     payload,provenance,corrects_event_id,idempotency_key,payload_hash,previous_hash,event_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)`, [
    actor.tenantId, event.id, sequence.toString(), event.schemaVersion, event.eventType, event.entityType,
    event.entityId, event.actorId, event.occurredAt, recordedAt, JSON.stringify(event.payload),
    JSON.stringify(event.provenance), event.correctsEventId, event.idempotencyKey, payloadHash, previousHash, eventHash,
  ]);
  await client.query(`INSERT INTO astra.event_outbox(tenant_id,event_id,sequence)
    VALUES($1,$2,$3)`, [actor.tenantId, event.id, sequence.toString()]);
  return { id: event.id, sequence: sequence.toString(), eventHash, duplicate: false };
}

export async function listEvents(client, tenantId, { afterSequence = 0, limit = 100, entityType, entityId } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const after = Number.isSafeInteger(Number(afterSequence)) && Number(afterSequence) >= 0 ? String(afterSequence) : '0';
  const result = await client.query(`SELECT id,sequence,schema_version AS "schemaVersion",event_type AS "eventType",
    entity_type AS "entityType",entity_id AS "entityId",actor_id AS "actorId",occurred_at AS "occurredAt",
    recorded_at AS "recordedAt",payload,provenance,corrects_event_id AS "correctsEventId",previous_hash AS "previousHash",
    event_hash AS "eventHash" FROM astra.events WHERE tenant_id=$1 AND sequence>$2
    AND ($3::text IS NULL OR entity_type=$3) AND ($4::text IS NULL OR entity_id=$4)
    ORDER BY sequence ASC LIMIT $5`, [tenantId, after, entityType ?? null, entityId ?? null, safeLimit]);
  return result.rows;
}

export async function recordConsumerReceipt(client, { tenantId, consumer, eventId, result = {} }) {
  const name = requiredText(consumer, 'consumer', 120);
  const saved = await client.query(`INSERT INTO astra.consumer_receipts(tenant_id,consumer,event_id,result)
    SELECT $1,$2,$3,$4::jsonb WHERE EXISTS(SELECT 1 FROM astra.events WHERE tenant_id=$1 AND id=$3)
    ON CONFLICT(tenant_id,consumer,event_id) DO NOTHING RETURNING event_id`, [tenantId, name, eventId, JSON.stringify(result)]);
  if (!saved.rowCount) {
    const exists = await client.query(`SELECT 1 FROM astra.events WHERE tenant_id=$1 AND id=$2`, [tenantId, eventId]);
    if (!exists.rowCount) throw new AstraLedgerError('Event does not exist for this tenant.', 404, 'event_missing');
  }
  return { duplicate: saved.rowCount === 0 };
}

export async function listUnprocessedOutbox(client, tenantId, consumer, limit = 100) {
  const name = requiredText(consumer, 'consumer', 120);
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await client.query(`SELECT e.id,e.sequence,e.schema_version AS "schemaVersion",e.event_type AS "eventType",
    e.entity_type AS "entityType",e.entity_id AS "entityId",e.occurred_at AS "occurredAt",e.recorded_at AS "recordedAt",
    e.payload,e.provenance,e.corrects_event_id AS "correctsEventId",e.event_hash AS "eventHash"
    FROM astra.event_outbox o JOIN astra.events e ON e.tenant_id=o.tenant_id AND e.id=o.event_id
    LEFT JOIN astra.consumer_receipts r ON r.tenant_id=o.tenant_id AND r.event_id=o.event_id AND r.consumer=$2
    WHERE o.tenant_id=$1 AND r.event_id IS NULL ORDER BY o.sequence ASC LIMIT $3`, [tenantId, name, safeLimit]);
  return result.rows;
}

