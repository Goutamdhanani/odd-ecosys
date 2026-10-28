import { appendEvent, AstraLedgerError, canonicalJson } from './astra-ledger.js';

const STAGES = Object.freeze({
  meeting_booked: 'meeting.booked', meeting_held: 'meeting.held', meeting_cancelled: 'meeting.cancelled',
  opportunity_created: 'opportunity.created', opportunity_qualified: 'opportunity.qualified',
  opportunity_won: 'opportunity.won', opportunity_lost: 'opportunity.lost',
  revenue_paid: 'revenue.paid', revenue_refunded: 'revenue.refunded', label: 'outcome.labelled',
});
export const ASTRA_OUTCOME_STAGES = Object.freeze(Object.keys(STAGES));

function canonicalUuidReference(value) {
  // PostgreSQL accepts the canonical, compact, and brace-wrapped UUID forms.
  // Treat all of them as platform IDs so they cannot fall through as opaque
  // legacy identifiers when the account belongs to another tenant.
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  const unwrapped = candidate.startsWith('{') && candidate.endsWith('}')
    ? candidate.slice(1, -1)
    : candidate;
  const compact = unwrapped.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`.toLowerCase();
}

export async function normalizeAndValidateAccountEntity(client, tenantId, entity) {
  if (entity?.type !== 'account') return entity;
  const accountId = canonicalUuidReference(entity.id);
  // Non-UUID values are established external/legacy opaque identifiers. UUID
  // references, however, must resolve to an actual research account here.
  if (!accountId) return entity;
  const owned = await client.query(
    'SELECT id FROM astra.research_accounts WHERE tenant_id=$1::uuid AND id=$2::uuid',
    [tenantId, accountId],
  );
  if (!owned.rowCount) throw new AstraLedgerError('Outcome account was not found for this tenant.', 404, 'outcome_entity_not_found');
  return { ...entity, id: accountId };
}

function sameOutcomeEntity(left, right) {
  if (left.type !== right.type) return false;
  if (left.type === 'account') {
    const leftUuid = canonicalUuidReference(left.id);
    const rightUuid = canonicalUuidReference(right.id);
    if (leftUuid && rightUuid) return leftUuid === rightUuid;
  }
  return left.id === right.id;
}

function normalizeOutcome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AstraLedgerError('Outcome body must be an object.');
  const stage = input.stage;
  const eventType = STAGES[stage];
  if (!eventType) throw new AstraLedgerError('Unsupported outcome stage.');
  const entity = input.entity;
  if (!entity || !['contact', 'account', 'opportunity', 'meeting', 'invoice'].includes(entity.type)
    || typeof entity.id !== 'string' || !entity.id.trim() || entity.id.length > 500) {
    throw new AstraLedgerError('entity must have an allowed type and non-empty id.');
  }
  const occurredAt = input.occurredAt;
  if (!occurredAt || Number.isNaN(new Date(occurredAt).valueOf())) throw new AstraLedgerError('occurredAt must be a valid date.');
  const payload = { stage };
  if (stage === 'revenue_paid' || stage === 'revenue_refunded') {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
      throw new AstraLedgerError('Revenue outcomes require a non-negative integer amountMinor.');
    }
    if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new AstraLedgerError('Revenue outcomes require a three-letter uppercase currency.');
    }
    payload.amountMinor = input.amountMinor;
    payload.currency = input.currency;
    payload.invoiceRef = input.invoiceRef == null ? null : String(input.invoiceRef).slice(0, 500);
  }
  if (stage === 'label') {
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200) throw new AstraLedgerError('Manual outcome labels require a label.');
    payload.label = input.label.trim();
    payload.value = input.value ?? null;
  }
  if (input.sourceEventId != null) payload.sourceEventId = String(input.sourceEventId);
  const trimmedEntityId = entity.id.trim();
  return { eventType, entity: { type: entity.type, id: canonicalUuidReference(trimmedEntityId) || trimmedEntityId }, occurredAt, payload };
}

function projectionRecords(events) {
  const invalidated = new Set(events.filter(e => ['outcome.corrected', 'outcome.reversed'].includes(e.eventType))
    .map(e => e.correctsEventId).filter(Boolean));
  const active = events.filter(e => !invalidated.has(e.id)).slice().sort((a, b) => {
    const time = new Date(a.occurredAt).valueOf() - new Date(b.occurredAt).valueOf();
    return time || (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0);
  });
  const milestones = [];
  const labels = [];
  const paid = new Map();
  const refunded = new Map();
  for (const event of active) {
    let stage = event.payload?.stage;
    let payload = event.payload || {};
    let occurredAt = event.occurredAt;
    if (event.eventType === 'outcome.corrected') {
      stage = payload.replacement?.stage;
      payload = payload.replacement || {};
      occurredAt = event.payload?.replacementOccurredAt || event.occurredAt;
    }
    if (!stage && event.eventType !== 'outcome.reversed') stage = event.eventType;
    if (stage === 'outcome.labelled' || stage === 'label') {
      labels.push({ eventId: event.id, label: payload.label, value: payload.value ?? null, occurredAt, provenance: event.provenance });
    }
    if (stage === 'revenue_paid' || stage === 'revenue.paid') {
      const currency = payload.currency;
      if (currency && Number.isSafeInteger(payload.amountMinor)) paid.set(currency, (paid.get(currency) || 0) + payload.amountMinor);
    }
    if (stage === 'revenue_refunded' || stage === 'revenue.refunded') {
      const currency = payload.currency;
      if (currency && Number.isSafeInteger(payload.amountMinor)) refunded.set(currency, (refunded.get(currency) || 0) + payload.amountMinor);
    }
    if (event.eventType !== 'outcome.reversed') milestones.push({ eventId: event.id, stage, occurredAt, provenance: event.provenance, payload });
  }
  return {
    milestones,
    latestStage: milestones.at(-1)?.stage ?? null,
    latestLabel: labels.at(-1) ?? null,
    revenue: [...new Set([...paid.keys(), ...refunded.keys()])].sort().map(currency => ({
      currency, paidMinor: paid.get(currency) || 0, refundedMinor: refunded.get(currency) || 0,
      netMinor: (paid.get(currency) || 0) - (refunded.get(currency) || 0),
    })),
  };
}

export async function rebuildOutcomeProjection(client, tenantId, entityType, entityId) {
  const result = await client.query(`SELECT id,sequence,event_type AS "eventType",entity_type AS "entityType",entity_id AS "entityId",
    occurred_at AS "occurredAt",payload,provenance,corrects_event_id AS "correctsEventId"
    FROM astra.events WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY sequence ASC`, [tenantId, entityType, entityId]);
  const projection = projectionRecords(result.rows);
  const head = result.rows.at(-1);
  await client.query(`INSERT INTO astra.outcome_projection
    (tenant_id,entity_type,entity_id,latest_event_id,latest_sequence,state,updated_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,now())
    ON CONFLICT(tenant_id,entity_type,entity_id) DO UPDATE SET latest_event_id=excluded.latest_event_id,
      latest_sequence=excluded.latest_sequence,state=excluded.state,updated_at=excluded.updated_at`, [
    tenantId, entityType, entityId, head?.id ?? null, head?.sequence ?? '0', JSON.stringify(projection),
  ]);
  return projection;
}

export async function recordOutcome(client, actor, input) {
  const normalized = normalizeOutcome(input);
  normalized.entity = await normalizeAndValidateAccountEntity(client, actor.tenantId, normalized.entity);
  const eventInput = {
    eventType: normalized.eventType,
    schemaVersion: 1,
    entity: normalized.entity,
    occurredAt: normalized.occurredAt,
    idempotencyKey: input.idempotencyKey,
    payload: normalized.payload,
    provenance: normalized.payload.stage === 'label'
      ? { ...input.provenance, fieldAuthority: 'human' }
      : input.provenance,
  };
  const result = await appendEvent(client, actor, eventInput);
  const projection = await rebuildOutcomeProjection(client, actor.tenantId, normalized.entity.type, normalized.entity.id);
  return { ...result, projection };
}

export async function recordOutcomeCorrection(client, actor, input) {
  if (!input || !['correct', 'reverse'].includes(input.action)) throw new AstraLedgerError('action must be correct or reverse.');
  const targetId = String(input.correctsEventId || '');
  if (!targetId) throw new AstraLedgerError('correctsEventId is required.');
  const target = await client.query(`SELECT entity_type,entity_id FROM astra.events WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, targetId]);
  if (!target.rowCount) throw new AstraLedgerError('Correction target was not found for this tenant.', 404, 'correction_target_missing');
  let payload = {};
  if (input.action === 'correct') {
    const replacement = normalizeOutcome(input.replacement);
    replacement.entity = await normalizeAndValidateAccountEntity(client, actor.tenantId, replacement.entity);
    if (!sameOutcomeEntity(replacement.entity, { type: target.rows[0].entity_type, id: target.rows[0].entity_id })) {
      throw new AstraLedgerError('Replacement must refer to the corrected event entity.', 409, 'correction_entity_mismatch');
    }
    payload = { replacement: replacement.payload, replacementEventType: replacement.eventType,
      replacementOccurredAt: new Date(replacement.occurredAt).toISOString() };
  }
  const event = await appendEvent(client, actor, {
    eventType: input.action === 'correct' ? 'outcome.corrected' : 'outcome.reversed', schemaVersion: 1,
    entity: { type: target.rows[0].entity_type, id: target.rows[0].entity_id },
    correctsEventId: targetId,
    occurredAt: input.occurredAt || new Date().toISOString(), idempotencyKey: input.idempotencyKey,
    payload, provenance: input.action === 'correct' && input.replacement?.stage === 'label'
      ? { ...input.provenance, fieldAuthority: 'human' }
      : input.provenance,
  });
  const projection = await rebuildOutcomeProjection(client, actor.tenantId, target.rows[0].entity_type, target.rows[0].entity_id);
  return { ...event, projection };
}

export async function listOutcomeProjections(client, tenantId, { entityType, entityId, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await client.query(`SELECT entity_type AS "entityType",entity_id AS "entityId",latest_event_id AS "latestEventId",
    latest_sequence AS "latestSequence",state,updated_at AS "updatedAt" FROM astra.outcome_projection
    WHERE tenant_id=$1 AND ($2::text IS NULL OR entity_type=$2) AND ($3::text IS NULL OR entity_id=$3)
    ORDER BY latest_sequence DESC LIMIT $4`, [tenantId, entityType ?? null, entityId ?? null, safeLimit]);
  return result.rows;
}

