import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, ASTRA_EVENT_TYPES, canonicalJson } from './astra-ledger.js';
import { AstraTenantContextError } from './astra-tenant-context.js';

const fail = (message,status=400,code='crm_invalid') => { throw new AstraTenantContextError(message,status,code); };
const text = (value,name,max=500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${name} is invalid.`);
  return value.trim();
};
const jsonObject = (value,name,max=30000) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  const encoded = JSON.stringify(value);
  if (encoded.length > max) fail(`${name} is too large.`);
  return encoded;
};
const crmRow = row => ({ ...row,
  entityType: row.entityType ?? row.entity_type,
  entityId: row.entityId ?? row.entity_id,
  externalId: row.externalId ?? row.external_id,
  idempotencyKey: row.idempotencyKey ?? row.idempotency_key,
  fieldAuthority: row.fieldAuthority ?? row.field_authority,
  createdAt: row.createdAt ?? row.created_at,
  updatedAt: row.updatedAt ?? row.updated_at,
  actorId: row.actorId ?? row.actor_id,
});

async function resolveEntityAssociation(client, actor, input) {
  const accountId = input?.accountId;
  if (accountId == null) return text(input?.entityId, 'entityId'); // Legacy opaque references remain supported.
  if (typeof accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) {
    fail('accountId must identify a research account in this workspace.');
  }
  const account = await client.query('SELECT id FROM astra.research_accounts WHERE tenant_id=$1 AND id=$2::uuid', [actor.tenantId, accountId]);
  if (!account.rowCount) fail('Research account was not found in this workspace.', 404, 'crm_account_not_found');
  if (input.entityId != null) {
    const suppliedEntityId = text(input.entityId, 'entityId');
    if (suppliedEntityId.toLowerCase() !== String(account.rows[0].id).toLowerCase()) {
      fail('entityId conflicts with the selected research account.', 409, 'crm_entity_account_conflict');
    }
  }
  return account.rows[0].id;
}

export async function createAstraCrmMapping(client, actor, input) {
  const entityType = input?.entityType;
  if (entityType !== 'company') fail('The Twenty adapter currently maps company identities only.');
  const entityId = await resolveEntityAssociation(client, actor, input);
  const externalId = text(input.externalId,'externalId');
  const fieldAuthority = input.fieldAuthority ?? {};
  const provenance = input.provenance ?? {};
  const result = await client.query(`INSERT INTO astra.crm_mappings(tenant_id,entity_type,entity_id,external_id,field_authority,provenance,created_by)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
    ON CONFLICT DO NOTHING RETURNING entity_type,entity_id,provider,external_id,field_authority,provenance,created_at`,
  [actor.tenantId,entityType,entityId,externalId,jsonObject(fieldAuthority,'fieldAuthority'),jsonObject(provenance,'provenance'),String(actor.userId)]);
  if (!result.rowCount) {
    const existing = await client.query(`SELECT entity_type,entity_id,provider,external_id,field_authority,provenance
      FROM astra.crm_mappings WHERE tenant_id=$1 AND ((entity_type=$2 AND entity_id=$3 AND provider='twenty') OR (provider='twenty' AND external_id=$4))`,
    [actor.tenantId,entityType,entityId,externalId]);
    if (existing.rowCount === 1 && existing.rows[0].entity_type === entityType && existing.rows[0].entity_id === entityId && existing.rows[0].external_id === externalId) {
      return { ...crmRow(existing.rows[0]), duplicate:true };
    }
    fail('CRM external identity is already mapped to another tenant entity or mapping.',409,'crm_mapping_conflict');
  }
  return { ...crmRow(result.rows[0]), duplicate:false };
}

export async function listAstraCrmMappings(client, tenantId) {
  const result = await client.query(`SELECT entity_type,entity_id,provider,external_id,field_authority,provenance,created_at,updated_at
    FROM astra.crm_mappings WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 500`,[tenantId]);
  return result.rows.map(crmRow);
}

/** Store a durable outbound proposal. The adapter transport is intentionally disabled in SQL. */
export async function enqueueAstraCrmProposal(client, actor, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CRM proposal must be an object.');
  const entityType = input.entityType;
  if (entityType !== 'company') fail('The Twenty adapter currently supports company creation only.');
  const entityId = await resolveEntityAssociation(client, actor, input);
  const idempotencyKey = text(input.idempotencyKey,'idempotencyKey',250);
  const fieldAuthority = input.fieldAuthority;
  const provenance = input.provenance;
  if (!fieldAuthority || typeof fieldAuthority !== 'object' || Array.isArray(fieldAuthority)) fail('fieldAuthority is required.');
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) fail('provenance is required.');
  const requestedPayload = input.payload;
  if (!requestedPayload || typeof requestedPayload !== 'object' || Array.isArray(requestedPayload)) fail('payload must be an object.');
  if (Object.keys(requestedPayload).some(field => !['name','domainName'].includes(field))
    || typeof requestedPayload.name !== 'string' || !requestedPayload.name.trim() || requestedPayload.name.trim().length > 250) {
    fail('Twenty company proposals require name and support only the standard name and domainName fields.');
  }
  // This adapter only creates a new Twenty company; it does not implement remote updates.
  // Keep field authority attached so any future update path can reject human-owned fields.
  const safePayload = {};
  for (const [field,value] of Object.entries(requestedPayload)) {
    const authority = fieldAuthority[field];
    if (!['human','crm','system','source'].includes(authority)) fail(`fieldAuthority.${field} is required and must be known.`);
    safePayload[field] = field === 'name' ? value.trim() : value;
  }
  if (safePayload.domainName != null) {
    if (typeof safePayload.domainName !== 'string' || !safePayload.domainName.trim() || safePayload.domainName.length > 253
      || /[\s/@?#]/.test(safePayload.domainName)) fail('domainName must be a plain DNS name.');
    safePayload.domainName = safePayload.domainName.toLowerCase();
  }
  const payloadJson = jsonObject(safePayload,'payload');
  const authorityJson = jsonObject(fieldAuthority,'fieldAuthority');
  const provenanceJson = jsonObject(provenance,'provenance');
  const setting = await client.query(`SELECT commercial_approved,explicit_opt_in,transport_enabled FROM astra.crm_settings WHERE tenant_id=$1`,[actor.tenantId]);
  const gates = setting.rows[0] || { commercial_approved:false,explicit_opt_in:false,transport_enabled:false };
  const state = gates.commercial_approved && gates.explicit_opt_in ? 'queued' : 'held';
  const id = randomUUID();
  const inserted = await client.query(`INSERT INTO astra.crm_outbox(tenant_id,id,entity_type,entity_id,operation,idempotency_key,payload,field_authority,provenance,state,actor_id)
    VALUES ($1,$2,$3,$4,'create_company',$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
    ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
    RETURNING id,entity_type,entity_id,provider,operation,idempotency_key,payload,field_authority,provenance,state,created_at`,
  [actor.tenantId,id,entityType,entityId,idempotencyKey,payloadJson,authorityJson,provenanceJson,state,String(actor.userId)]);
  if (!inserted.rowCount) {
    const existing = await client.query(`SELECT id,entity_type,entity_id,provider,operation,idempotency_key,payload,field_authority,provenance,state,created_at
      FROM astra.crm_outbox WHERE tenant_id=$1 AND idempotency_key=$2`,[actor.tenantId,idempotencyKey]);
    const row = existing.rows[0];
    if (row.entity_type !== entityType || row.entity_id !== entityId || canonicalJson(row.payload) !== canonicalJson(JSON.parse(payloadJson))
      || canonicalJson(row.field_authority) !== canonicalJson(JSON.parse(authorityJson))
      || canonicalJson(row.provenance) !== canonicalJson(JSON.parse(provenanceJson))) fail('CRM outbox idempotency key conflicts with an earlier proposal.',409,'crm_outbox_conflict');
    return { ...crmRow(row), duplicate:true, transportEnabled:false };
  }
  return { ...crmRow(inserted.rows[0]),duplicate:false,transportEnabled:false,
    gate: state === 'held' ? 'commercial_approval_or_explicit_opt_in_required' : 'transport_disabled' };
}

export async function listAstraCrmOutbox(client, tenantId, { state = null, limit = 100 } = {}) {
  if (state && !['held','queued','attempting','uncertain','succeeded','failed'].includes(state)) fail('state is invalid.');
  const bounded = Number.isInteger(limit) ? Math.max(1,Math.min(limit,200)) : 100;
  const result = await client.query(`SELECT id,entity_type,entity_id,provider,operation,idempotency_key,payload,field_authority,provenance,state,actor_id,created_at,updated_at
    FROM astra.crm_outbox WHERE tenant_id=$1 AND ($2::text IS NULL OR state=$2) ORDER BY created_at DESC LIMIT $3`,[tenantId,state,bounded]);
  return { transportEnabled:false,items:result.rows.map(crmRow) };
}

/** Worker-only record writer; callers still cannot execute a provider without the currently-false transport gate. */
export async function recordAstraCrmAttempt(client, actor, outboxId, state, diagnosticCode = null, externalId = null) {
  if (!['started','uncertain','succeeded','failed'].includes(state)) fail('Attempt state is invalid.');
  const settings = await client.query(`SELECT commercial_approved,explicit_opt_in,transport_enabled FROM astra.crm_settings WHERE tenant_id=$1`,[actor.tenantId]);
  const gates = settings.rows[0];
  if (!gates?.commercial_approved || !gates?.explicit_opt_in || gates.transport_enabled !== true) fail('CRM transport is disabled.',409,'crm_transport_disabled');
  const row = await client.query(`SELECT id,state FROM astra.crm_outbox WHERE tenant_id=$1 AND id=$2::uuid FOR UPDATE`,[actor.tenantId,outboxId]);
  if (!row.rowCount) fail('CRM outbox proposal was not found.',404,'crm_outbox_not_found');
  if (['uncertain','succeeded','failed'].includes(row.rows[0].state)) fail('Terminal or uncertain CRM proposals cannot be retried automatically.',409,'crm_outbox_not_retryable');
  const number = await client.query(`SELECT COALESCE(MAX(attempt_number),0)+1 AS next FROM astra.crm_attempts WHERE tenant_id=$1 AND outbox_id=$2::uuid`,[actor.tenantId,outboxId]);
  const attemptState = state === 'started' ? 'started' : state;
  const id = randomUUID();
  await client.query(`INSERT INTO astra.crm_attempts(tenant_id,id,outbox_id,attempt_number,state,diagnostic_code,external_id,created_by)
    VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8)`,[actor.tenantId,id,outboxId,Number(number.rows[0].next),attemptState,diagnosticCode,externalId,String(actor.userId)]);
  const outboxState = state === 'started' ? 'attempting' : state;
  await client.query(`UPDATE astra.crm_outbox SET state=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2::uuid`,[actor.tenantId,outboxId,outboxState]);
  return { id,outboxId,state:attemptState,attemptNumber:Number(number.rows[0].next) };
}

const outcomeEventTypes = new Set(ASTRA_EVENT_TYPES.filter(type => type.startsWith('meeting.') || type.startsWith('opportunity.') || type.startsWith('revenue.') || type.startsWith('outcome.')));
export async function importAstraCrmOutcome(client, actor, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Outcome import must be an object.');
  const eventType = text(input.eventType,'eventType',80);
  if (!outcomeEventTypes.has(eventType)) fail('Unsupported CRM outcome event type.');
  const externalEventId = text(input.externalEventId,'externalEventId',500);
  const entity = input.entity;
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) fail('entity is required.');
  const entityType = text(entity.type,'entity.type',80);
  const entityId = text(entity.id,'entity.id',500);
  const payload = input.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('payload must be an object.');
  const occurredAt = new Date(input.occurredAt || Date.now());
  if (Number.isNaN(occurredAt.valueOf())) fail('occurredAt must be a valid date.');
  const correctionId = input.correctsEventId == null ? null : text(input.correctsEventId,'correctsEventId',80);
  const evidenceRef = input.evidenceRef == null ? `twenty:${externalEventId}` : text(input.evidenceRef,'evidenceRef',1000);
  const event = await appendEvent(client,actor,{
    eventType,entity:{type:entityType,id:entityId},occurredAt:occurredAt.toISOString(),payload,
    idempotencyKey:`twenty:${createHash('sha256').update(externalEventId).digest('hex')}`,
    correctsEventId:correctionId,
    provenance:{source:'twenty',externalEventId,confidence:'medium',fieldAuthority:'crm',evidenceRef},
  });
  return { ...event,source:'twenty' };
}

