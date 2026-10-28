import { randomUUID } from 'node:crypto';
import { AstraTenantContextError } from './astra-tenant-context.js';

const fail = (message, status = 400, code = 'permission_invalid') => {
  throw new AstraTenantContextError(message, status, code);
};

function text(value, name, max = 320) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${name} is required and must be at most ${max} printable characters.`);
  }
  return value.trim();
}

export function normalizeAstraPermissionSubject(type, value) {
  if (!['recipient', 'domain', 'account', 'channel'].includes(type)) fail('Unsupported permission subject type.');
  let normalized = text(value, 'subject.value');
  if (type === 'recipient') {
    normalized = normalized.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail('Recipient must be a valid email address.');
  } else if (type === 'domain') {
    normalized = normalized.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)) fail('Domain is invalid.');
  } else if (type === 'channel' && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(normalized)) fail('Channel is invalid.');
  return normalized;
}

function permissionInput(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Permission decision must be an object.');
  const subjectType = input.subject?.type;
  const subjectValue = normalizeAstraPermissionSubject(subjectType, input.subject?.value);
  const purpose = text(input.purpose, 'purpose', 120);
  const lawfulBasis = input.lawfulBasis;
  if (!['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests', 'unknown'].includes(lawfulBasis)) fail('lawfulBasis is unsupported.');
  const geography = text(input.geography, 'geography', 80);
  const decision = input.decision || 'granted';
  if (!['granted', 'denied', 'withdrawn', 'expired'].includes(decision)) fail('decision must be granted, denied, withdrawn, or expired.');
  if (!input.sourceProof || typeof input.sourceProof !== 'object' || Array.isArray(input.sourceProof) || !Object.keys(input.sourceProof).length) fail('sourceProof must contain evidence of the permission source.');
  const proofJson = JSON.stringify(input.sourceProof);
  if (proofJson.length > 8000) fail('sourceProof is too large.');
  let expiresAt = null;
  if (input.consentExpiresAt != null) {
    const date = new Date(input.consentExpiresAt);
    if (Number.isNaN(date.valueOf())) fail('consentExpiresAt must be a valid date.');
    expiresAt = date.toISOString();
  }
  if (decision === 'granted' && lawfulBasis === 'consent' && !expiresAt) fail('Consent grants require consentExpiresAt or an explicit expiry policy.');
  return { id: randomUUID(), subjectType, subjectValue, purpose, lawfulBasis, geography, decision, expiresAt,
    sourceProof: input.sourceProof, actorId: String(actor.userId) };
}

export async function recordAstraPermission(client, actor, input) {
  const item = permissionInput(input, actor);
  await client.query(`INSERT INTO astra.permission_decisions
    (tenant_id,id,subject_type,subject_value,purpose,lawful_basis,geography,decision,consent_expires_at,source_proof,actor_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
  [actor.tenantId,item.id,item.subjectType,item.subjectValue,item.purpose,item.lawfulBasis,item.geography,item.decision,item.expiresAt,JSON.stringify(item.sourceProof),item.actorId]);
  return item;
}

export async function recordAstraSuppression(client, actor, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Suppression must be an object.');
  const scope = input.scope;
  if (!['recipient', 'domain', 'account', 'channel', 'purpose'].includes(scope)) fail('Unsupported suppression scope.');
  const value = scope === 'purpose' ? text(input.value, 'value', 120)
    : normalizeAstraPermissionSubject(scope === 'purpose' ? 'account' : scope, input.value);
  const reason = text(input.reason, 'reason', 240);
  const evidence = input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence) ? input.evidence : null;
  if (!evidence || Object.keys(evidence).length === 0 || JSON.stringify(evidence).length > 8000) fail('evidence must contain a bounded audit record.');
  const id = randomUUID();
  await client.query(`INSERT INTO astra.suppression_decisions(tenant_id,id,scope,scope_value,reason,evidence,actor_id)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [actor.tenantId,id,scope,value,reason,JSON.stringify(evidence),String(actor.userId)]);
  return { id, scope, value, reason, evidence, actorId: String(actor.userId) };
}

/** Fast action gate. Only a current, purpose-matched grant with no matching suppression allows work. */
export async function evaluateAstraPermission(client, actor, { recipient, domain = null, account = null, channel = null, purpose }) {
  const normalizedPurpose = text(purpose, 'purpose', 120);
  const subjects = [];
  if (recipient) subjects.push(['recipient', normalizeAstraPermissionSubject('recipient', recipient)]);
  if (domain) subjects.push(['domain', normalizeAstraPermissionSubject('domain', domain)]);
  if (account) subjects.push(['account', normalizeAstraPermissionSubject('account', account)]);
  if (channel) subjects.push(['channel', normalizeAstraPermissionSubject('channel', channel)]);
  if (!subjects.length) fail('At least one recipient, domain, account, or channel is required.');
  const values = subjects.map(([, value]) => value);
  const types = subjects.map(([type]) => type);
  const suppressed = await client.query(`SELECT s.scope,s.scope_value,s.reason,s.created_at
    FROM astra.suppression_decisions s WHERE s.tenant_id=$1 AND ((s.scope='purpose' AND s.scope_value=$2)
      OR EXISTS (SELECT 1 FROM unnest($3::text[],$4::text[]) requested(scope,scope_value)
        WHERE requested.scope=s.scope AND requested.scope_value=s.scope_value))
    ORDER BY s.created_at DESC LIMIT 1`, [actor.tenantId, normalizedPurpose, types, values]);
  if (suppressed.rowCount) return { allowed: false, reason: 'suppressed', suppression: suppressed.rows[0], purpose: normalizedPurpose };
  for (const [subjectType, subjectValue] of subjects) {
    const decision = await client.query(`SELECT decision,lawful_basis,geography,consent_expires_at,created_at
      FROM astra.permission_decisions WHERE tenant_id=$1 AND subject_type=$2 AND subject_value=$3 AND purpose=$4
      ORDER BY created_at DESC,id DESC LIMIT 1`, [actor.tenantId, subjectType, subjectValue, normalizedPurpose]);
    const latest = decision.rows[0];
    if (latest && latest.decision === 'granted' && latest.lawful_basis !== 'unknown'
      && (!latest.consent_expires_at || new Date(latest.consent_expires_at).valueOf() > Date.now())) {
      return { allowed: true, reason: 'current_permission', subjectType, subjectValue,
        lawfulBasis: latest.lawful_basis, geography: latest.geography, purpose: normalizedPurpose };
    }
  }
  return { allowed: false, reason: 'permission_missing_or_expired', purpose: normalizedPurpose };
}

