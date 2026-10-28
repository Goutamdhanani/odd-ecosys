import { AstraLedgerError } from './astra-ledger.js';
import { readAstraSourceRights } from './astra-source-rights.js';

const MEMORY_KINDS = new Set(['fact', 'episode', 'preference', 'strategy']);
const SUBJECT_TYPES = new Set(['tenant', 'account', 'contact', 'opportunity', 'meeting', 'invoice']);
const AUTHORITIES = new Set(['crm', 'human', 'system', 'source']);
const CONFIDENCE = new Set(['high', 'medium', 'low', 'unknown']);
const SENSITIVITY = new Set(['public', 'internal', 'personal', 'confidential']);
const PERMISSION_SUBJECT_TYPES = new Set(['recipient', 'domain', 'account', 'channel']);
const RIGHTS_POLICIES = new Set(['synthetic_fixture', 'user_provided', 'licensed', 'public_terms_permitted', 'internal_event']);

function fail(message, status = 400, code = 'astra_memory_invalid') {
  throw new AstraLedgerError(message, status, code);
}

function text(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${field} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function date(value, field, optional = false) {
  if (value == null && optional) return null;
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.valueOf())) fail(`${field} must be a valid date.`);
  return parsed.toISOString();
}

function jsonObject(value, field, maxBytes = 16 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) fail(`${field} is too large.`);
  return encoded;
}

function normalizeMemory(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Memory body must be an object.');
  const kind = text(input.kind, 'kind', 32);
  if (!MEMORY_KINDS.has(kind)) fail('kind must be fact, episode, preference, or strategy.');
  const subject = input.subject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)
    || !SUBJECT_TYPES.has(subject.type)) fail('subject.type is not supported.');
  const subjectId = text(subject.id, 'subject.id', 500);
  const purpose = text(input.purpose, 'purpose', 120);
  const key = text(input.key, 'key', 160);
  if (input.value === undefined || input.value === null || (typeof input.value === 'number' && !Number.isFinite(input.value))) {
    fail('value must be non-null JSON data.');
  }
  const valueJson = JSON.stringify(input.value);
  if (Buffer.byteLength(valueJson, 'utf8') > 12 * 1024) fail('value is too large.');
  const validFrom = date(input.validFrom, 'validFrom');
  const validTo = date(input.validTo, 'validTo', true);
  const expiresAt = date(input.expiresAt, 'expiresAt', true);
  if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) fail('validTo must be later than validFrom.');
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(validFrom)) fail('expiresAt must be later than validFrom.');
  const confidence = input.confidence ?? 'unknown';
  const authority = input.authority ?? 'source';
  const sensitivity = input.sensitivity ?? 'internal';
  if (!CONFIDENCE.has(confidence)) fail('confidence is invalid.');
  if (!AUTHORITIES.has(authority)) fail('authority is invalid.');
  if (!SENSITIVITY.has(sensitivity)) fail('sensitivity is invalid.');
  const permissionSubjectType = text(input.permissionSubjectType, 'permissionSubjectType', 32);
  if (!PERMISSION_SUBJECT_TYPES.has(permissionSubjectType)) fail('permissionSubjectType is invalid.');
  const permissionSubjectValue = text(input.permissionSubjectValue, 'permissionSubjectValue', 320);
  if (subject.type === 'account' && permissionSubjectType === 'account' && permissionSubjectValue !== subjectId) {
    fail('Account memory permission must refer to the same account.');
  }
  const sourceEventId = input.sourceEventId == null ? null : text(String(input.sourceEventId), 'sourceEventId', 36);
  const sourceEvidenceId = input.sourceEvidenceId == null ? null : text(String(input.sourceEvidenceId), 'sourceEvidenceId', 36);
  if (Boolean(sourceEventId) === Boolean(sourceEvidenceId)) fail('Provide exactly one sourceEventId or sourceEvidenceId.');
  const rightsPolicy = input.rightsPolicy ?? (sourceEventId ? 'internal_event' : 'user_provided');
  if (!RIGHTS_POLICIES.has(rightsPolicy)) fail('rightsPolicy is invalid.');
  const rightsExpiresAt = date(input.rightsExpiresAt, 'rightsExpiresAt', true);
  const provenance = input.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || typeof provenance.source !== 'string' || !provenance.source.trim()
    || !['high', 'medium', 'low', 'unknown'].includes(provenance.confidence ?? 'unknown')
    || (provenance.fieldAuthority ?? authority) !== authority) {
    fail('provenance requires a source, valid confidence, and the same field authority as the memory item.');
  }
  const encodedProvenance = jsonObject(provenance, 'provenance');
  const permissionDecisionId = text(input.permissionDecisionId, 'permissionDecisionId', 36);
  const supersedesMemoryId = input.supersedesMemoryId == null ? null : text(String(input.supersedesMemoryId), 'supersedesMemoryId', 36);
  const contradictsMemoryId = input.contradictsMemoryId == null ? null : text(String(input.contradictsMemoryId), 'contradictsMemoryId', 36);
  if (supersedesMemoryId && contradictsMemoryId) fail('A memory item cannot both supersede and contradict the same item.');
  return {
    kind, subjectType: subject.type, subjectId, purpose, key, valueJson, validFrom, validTo, expiresAt,
    confidence, authority, sensitivity, permissionSubjectType, permissionSubjectValue,
    sourceEventId, sourceEvidenceId, rightsPolicy, rightsExpiresAt, provenance: encodedProvenance,
    permissionDecisionId, supersedesMemoryId, contradictsMemoryId, actorId: String(actor.userId),
  };
}

const MEMORY_COLUMNS = `m.id,m.memory_kind AS "kind",m.subject_type AS "subjectType",m.subject_id AS "subjectId",
  m.purpose,m.memory_key AS "key",m.value,m.valid_from AS "validFrom",m.valid_to AS "validTo",
  m.observed_at AS "observedAt",m.expires_at AS "expiresAt",m.confidence,m.authority,m.sensitivity,m.provenance,
  m.source_event_id AS "sourceEventId",m.source_evidence_id AS "sourceEvidenceId",m.rights_policy AS "rightsPolicy",
  m.rights_expires_at AS "rightsExpiresAt",m.supersedes_memory_id AS "supersedesMemoryId",m.created_at AS "createdAt"`;

async function assertMemoryPermission(db, tenantId, item) {
  const result = await db.query(`SELECT p.id FROM astra.permission_decisions p
    WHERE p.tenant_id=$1::uuid AND p.id=$2::uuid AND p.subject_type=$3 AND p.subject_value=$4
      AND p.purpose=$5 AND p.decision='granted'
      AND (p.consent_expires_at IS NULL OR p.consent_expires_at>now())
      AND NOT EXISTS (SELECT 1 FROM astra.permission_decisions newer
        WHERE newer.tenant_id=p.tenant_id AND newer.subject_type=p.subject_type
          AND newer.subject_value=p.subject_value AND newer.purpose=p.purpose
          AND (newer.created_at,newer.id)>(p.created_at,p.id))`, [tenantId, item.permissionDecisionId,
    item.permissionSubjectType, item.permissionSubjectValue, item.purpose]);
  if (!result.rowCount) fail('A current granted permission decision for this subject and purpose is required.', 403, 'memory_permission_required');
}

async function assertMemorySource(db, tenantId, item) {
  if (item.sourceEventId) {
    const source = await db.query(`SELECT event_type FROM astra.events WHERE tenant_id=$1::uuid AND id=$2::uuid
      AND entity_type=$3 AND entity_id=$4`, [tenantId, item.sourceEventId, item.subjectType, item.subjectId]);
    if (!source.rowCount) fail('The immutable source event was not found for this tenant and subject.', 404, 'memory_source_event_missing');
    return;
  }
  if (item.subjectType !== 'account') fail('Research evidence can only be attached to an account memory item.');
  const source = await db.query(`SELECT s.id AS "sourceId" FROM astra.research_evidence e
    JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
    JOIN astra.research_accounts a ON a.tenant_id=e.tenant_id AND a.normalized_domain=e.normalized_domain
    WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid AND a.id=$3::uuid
      AND s.robots_allowed AND s.rights_attested
      AND (s.rights_expires_at IS NULL OR s.rights_expires_at>now())`, [tenantId, item.sourceEvidenceId, item.subjectId]);
  if (!source.rowCount) fail('The research evidence is unavailable, out of scope, or no longer rights-cleared.', 403, 'memory_source_evidence_unavailable');
  const rights = (await readAstraSourceRights(db,tenantId,[source.rows[0].sourceId])).get(String(source.rows[0].sourceId).toLowerCase());
  if (!rights?.usable) fail(rights?.status==='revoked'?'The research source rights were revoked.':'The research source rights are unavailable.',403,
    rights?.status==='revoked'?'memory_source_rights_revoked':'memory_source_evidence_unavailable');
}

async function annotateMemorySourceRights(db,tenantId,rows) {
  const evidenceIds=rows.map(row=>row.sourceEvidenceId).filter(Boolean);
  if (!evidenceIds.length) return rows.map(row=>({...row,sourceRightsStatus:'not_applicable',sourceRightsUsable:true}));
  const evidence=await db.query(`SELECT e.id AS "evidenceId",e.source_id AS "sourceId" FROM astra.research_evidence e
    WHERE e.tenant_id=$1::uuid AND e.id=ANY($2::uuid[])`,[tenantId,[...new Set(evidenceIds)]]);
  const sourceByEvidence=new Map(evidence.rows.map(row=>[String(row.evidenceId),row.sourceId]));
  const rights=await readAstraSourceRights(db,tenantId,evidence.rows.map(row=>row.sourceId));
  return rows.map(row=>{
    const sourceId=sourceByEvidence.get(String(row.sourceEvidenceId));
    const current=sourceId?rights.get(String(sourceId).toLowerCase()):null;
    return {...row,sourceRightsStatus:current?.status||'unavailable',sourceRightsUsable:current?.usable===true,
      rightsRevokedAt:current?.revokedAt||null,rightsRevocationEventId:current?.revocationEventId||null,
      rightsRevocationReason:current?.reason||null};
  });
}

export async function createAstraMemoryItem(db, actor, input) {
  const item = normalizeMemory(input, actor);
  await assertMemoryPermission(db, actor.tenantId, item);
  await assertMemorySource(db, actor.tenantId, item);
  if (item.kind === 'strategy') {
    const experimentId = text(String(input.provenance.experimentId || ''), 'provenance.experimentId', 36);
    const armId = text(input.provenance.armId, 'provenance.armId', 80);
    const planSha256 = text(input.provenance.planSha256, 'provenance.planSha256', 64);
    if (!/^[a-f0-9]{64}$/i.test(planSha256)) fail('provenance.planSha256 must be a SHA-256 digest.');
    const tested = await db.query(`SELECT e.stopping_rule,
        COUNT(a.account_id)::integer AS "maturedAccounts"
      FROM astra.experiments e LEFT JOIN astra.experiment_assignments a
        ON (a.tenant_id,a.experiment_id)=(e.tenant_id,e.id) AND a.arm_id=$3
          AND a.assigned_at+make_interval(days=>GREATEST(e.primary_horizon_days,e.attribution_window_days))<=now()
      WHERE e.tenant_id=$1::uuid AND e.id=$2::uuid AND e.plan_sha256::text=$4
        AND e.arms @> jsonb_build_array(jsonb_build_object('id',$3::text))
      GROUP BY e.tenant_id,e.id`, [actor.tenantId, experimentId, armId, planSha256]);
    const required = Math.max(1, Number(tested.rows[0]?.stopping_rule?.minimumMatureAccounts || 0));
    if (!tested.rowCount || Number(tested.rows[0].maturedAccounts) < required) {
      fail('A strategy memory item requires a matching frozen experiment arm and matured account evidence.', 409, 'memory_strategy_unverified');
    }
  }
  if (item.rightsExpiresAt && Date.parse(item.rightsExpiresAt) <= Date.now()) fail('rightsExpiresAt must be in the future.');
  if (item.supersedesMemoryId || item.contradictsMemoryId) {
    const linkedId = item.supersedesMemoryId || item.contradictsMemoryId;
    const target = await db.query(`SELECT subject_type,subject_id,purpose FROM astra.memory_items
      WHERE tenant_id=$1::uuid AND id=$2::uuid`, [actor.tenantId, linkedId]);
    if (!target.rowCount) fail('The linked memory item was not found for this tenant.', 404, 'memory_link_target_missing');
    const row = target.rows[0];
    if (row.subject_type !== item.subjectType || row.subject_id !== item.subjectId || row.purpose !== item.purpose) {
      fail('Memory lineage must stay within the same subject and purpose.', 409, 'memory_lineage_mismatch');
    }
  }
  const inserted = await db.query(`INSERT INTO astra.memory_items(
    tenant_id,memory_kind,subject_type,subject_id,purpose,memory_key,value,valid_from,valid_to,expires_at,
    confidence,authority,sensitivity,provenance,permission_decision_id,permission_subject_type,
    permission_subject_value,source_event_id,source_evidence_id,rights_policy,rights_expires_at,created_by,supersedes_memory_id
  ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz,$10::timestamptz,
    $11,$12,$13,$14::jsonb,$15::uuid,$16,$17,$18::uuid,$19::uuid,$20,$21::timestamptz,$22,$23::uuid)
  RETURNING id`, [actor.tenantId, item.kind, item.subjectType, item.subjectId, item.purpose, item.key, item.valueJson,
    item.validFrom, item.validTo, item.expiresAt, item.confidence, item.authority, item.sensitivity, item.provenance,
    item.permissionDecisionId, item.permissionSubjectType, item.permissionSubjectValue, item.sourceEventId,
    item.sourceEvidenceId, item.rightsPolicy, item.rightsExpiresAt, item.actorId, item.supersedesMemoryId]);
  const id = inserted.rows[0].id;
  if (item.contradictsMemoryId) {
    await db.query(`INSERT INTO astra.memory_links(tenant_id,from_memory_id,to_memory_id,link_type,provenance,created_by)
      VALUES($1::uuid,$2::uuid,$3::uuid,'contradicts',$4::jsonb,$5)`, [actor.tenantId, id, item.contradictsMemoryId, item.provenance, item.actorId]);
  }
  const result = await db.query(`SELECT ${MEMORY_COLUMNS} FROM astra.memory_items m WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid`, [actor.tenantId, id]);
  return result.rows[0];
}

const RECALL_FILTERS = `m.tenant_id=$1::uuid AND m.subject_type=$2 AND m.subject_id=$3 AND m.purpose=$4
  AND m.valid_from<=$5::timestamptz AND (m.valid_to IS NULL OR m.valid_to>$5::timestamptz)
  AND (m.expires_at IS NULL OR m.expires_at>$5::timestamptz)
  AND (m.rights_expires_at IS NULL OR m.rights_expires_at>$5::timestamptz)
  AND NOT EXISTS (SELECT 1 FROM astra.memory_tombstones t WHERE t.tenant_id=m.tenant_id AND t.memory_item_id=m.id)
  AND NOT EXISTS (SELECT 1 FROM astra.memory_items newer WHERE newer.tenant_id=m.tenant_id AND newer.supersedes_memory_id=m.id)
  AND EXISTS (SELECT 1 FROM astra.permission_decisions pd
    WHERE pd.tenant_id=m.tenant_id AND pd.id=m.permission_decision_id AND pd.decision='granted'
      AND (pd.consent_expires_at IS NULL OR pd.consent_expires_at>$5::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM astra.permission_decisions later WHERE later.tenant_id=pd.tenant_id
        AND later.subject_type=pd.subject_type AND later.subject_value=pd.subject_value AND later.purpose=pd.purpose
        AND (later.created_at,later.id)>(pd.created_at,pd.id)))
  AND (m.source_evidence_id IS NULL OR EXISTS (SELECT 1 FROM astra.research_evidence e
    JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
    WHERE e.tenant_id=m.tenant_id AND e.id=m.source_evidence_id AND s.robots_allowed AND s.rights_attested
      AND (s.rights_expires_at IS NULL OR s.rights_expires_at>$5::timestamptz)))
  AND NOT EXISTS (SELECT 1 FROM astra.suppression_decisions sd WHERE sd.tenant_id=m.tenant_id AND (
    (m.subject_type='account' AND sd.scope='account' AND sd.scope_value=m.subject_id) OR
    (m.permission_subject_type='recipient' AND sd.scope='recipient' AND sd.scope_value=m.permission_subject_value) OR
    (m.subject_type='account' AND sd.scope='domain' AND sd.scope_value=(SELECT a.normalized_domain FROM astra.research_accounts a
      WHERE a.tenant_id=m.tenant_id AND a.id::text=m.subject_id))))`;

function normalizeRecall(input = {}) {
  const subject = input.subject;
  if (!subject || !SUBJECT_TYPES.has(subject.type)) fail('subject.type is required.');
  const subjectId = text(subject.id, 'subject.id', 500);
  const purpose = text(input.purpose, 'purpose', 120);
  const query = text(input.query, 'query', 500);
  const at = date(input.at ?? new Date().toISOString(), 'at');
  const limit = input.limit == null || input.limit === '' ? 20
    : Math.max(1, Math.min(50, Number.isInteger(Number(input.limit)) ? Number(input.limit) : 20));
  return { subjectType: subject.type, subjectId, purpose, query, at, limit };
}

export async function recallAstraMemory(db, tenantId, input) {
  const request = normalizeRecall(input);
  const rows = await db.query(`SELECT ${MEMORY_COLUMNS}, ts_rank_cd(m.search_vector,plainto_tsquery('simple',$6)) AS rank
    FROM astra.memory_items m WHERE ${RECALL_FILTERS}
      AND m.search_vector @@ plainto_tsquery('simple',$6)
    ORDER BY rank DESC,m.valid_from DESC,m.created_at DESC,m.id LIMIT $7`, [tenantId, request.subjectType,
    request.subjectId, request.purpose, request.at, request.query, request.limit]);
  const annotated=await annotateMemorySourceRights(db,tenantId,rows.rows);
  const usable=annotated.filter(row=>row.sourceRightsUsable);
  if (!usable.length) return { status: 'unknown', abstain: true, reason: annotated.some(row=>row.sourceRightsStatus==='revoked')?'source_rights_revoked':'no_current_permitted_memory', records: [] };
  const ids = usable.map(row => row.id);
  const otherFilters = RECALL_FILTERS.replaceAll('m.', 'o.');
  const conflict = await db.query(`SELECT l.from_memory_id AS "fromMemoryId",l.to_memory_id AS "toMemoryId"
    FROM astra.memory_links l WHERE l.tenant_id=$1::uuid AND l.link_type='contradicts'
      AND (l.from_memory_id=ANY($6::uuid[]) OR l.to_memory_id=ANY($6::uuid[]))
      AND EXISTS (SELECT 1 FROM astra.memory_items o WHERE o.tenant_id=l.tenant_id
        AND o.id=CASE WHEN l.from_memory_id=ANY($6::uuid[]) THEN l.to_memory_id ELSE l.from_memory_id END
        AND ${otherFilters})`, [tenantId, request.subjectType, request.subjectId, request.purpose, request.at, ids]);
  return {
    status: conflict.rowCount ? 'conflicted' : 'found', abstain: conflict.rowCount > 0,
    reason: conflict.rowCount ? 'current_memories_conflict' : null,
    records: usable.map(({ rank, ...row }) => ({ ...row, matchRank: Number(rank) })),
    conflicts: conflict.rows,
  };
}

export async function listAstraMemory(db, tenantId, { subject, purpose, limit = 50, at = new Date().toISOString() } = {}) {
  const request = normalizeRecall({ subject, purpose, query: 'memory', limit, at });
  const rows = await db.query(`SELECT ${MEMORY_COLUMNS} FROM astra.memory_items m WHERE ${RECALL_FILTERS}
    ORDER BY m.valid_from DESC,m.created_at DESC,m.id LIMIT $6`, [tenantId, request.subjectType, request.subjectId,
    request.purpose, request.at, request.limit]);
  return annotateMemorySourceRights(db,tenantId,rows.rows);
}

export async function tombstoneAstraMemory(db, actor, memoryId, reason) {
  const safeId = text(String(memoryId), 'memoryId', 36);
  const safeReason = text(reason, 'reason', 240);
  const result = await db.query(`INSERT INTO astra.memory_tombstones(tenant_id,memory_item_id,reason,actor_id)
    SELECT $1::uuid,m.id,$3,$4 FROM astra.memory_items m WHERE m.tenant_id=$1::uuid AND m.id=$2::uuid
    ON CONFLICT(tenant_id,memory_item_id) DO NOTHING RETURNING id,created_at AS "createdAt"`, [actor.tenantId, safeId, safeReason, String(actor.userId)]);
  if (result.rowCount) return { ...result.rows[0], duplicate: false };
  const existing = await db.query(`SELECT id,created_at AS "createdAt" FROM astra.memory_tombstones
    WHERE tenant_id=$1::uuid AND memory_item_id=$2::uuid`, [actor.tenantId, safeId]);
  if (!existing.rowCount) fail('Memory item was not found for this tenant.', 404, 'memory_item_missing');
  return { ...existing.rows[0], duplicate: true };
}
