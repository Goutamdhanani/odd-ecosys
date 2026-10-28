const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSourceId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function rightsView(row) {
  if (!row) return null;
  const revokedAt = row.revokedAt ?? null;
  const rightsExpiresAt = row.rightsExpiresAt ?? null;
  let status = 'unavailable';
  if (revokedAt) status = 'revoked';
  else if (row.expired === true) status = 'expired';
  else if (row.rightsAttested === true && row.robotsAllowed === true
    && ['synthetic_fixture', 'user_provided', 'licensed', 'public_terms_permitted'].includes(row.rightsPolicy)) status = 'permitted';
  return {
    sourceId: row.sourceId,
    found: true,
    usable: status === 'permitted',
    status,
    sourceUrl: row.sourceUrl,
    rightsPolicy: row.rightsPolicy,
    rightsExpiresAt,
    revokedAt,
    revocationEventId: row.revocationEventId ?? null,
    reason: row.reason ?? null,
  };
}

/** Read persisted, tenant-bound rights. Unknown and foreign IDs are never usable. */
export async function readAstraSourceRights(client, tenantId, sourceIds, { at = new Date() } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('A PostgreSQL client is required.');
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new TypeError('A tenant UUID is required.');
  if (!Array.isArray(sourceIds)) throw new TypeError('sourceIds must be an array.');
  if (!(at instanceof Date) || !Number.isFinite(at.valueOf())) throw new TypeError('A valid source-rights evaluation time is required.');
  const ids = [...new Set(sourceIds.map(normalizeSourceId).filter(Boolean))];
  const byId = new Map();
  if (ids.length) {
    const result = await client.query(`
      SELECT s.id AS "sourceId", s.source_url AS "sourceUrl", s.rights_policy AS "rightsPolicy",
             s.rights_expires_at AS "rightsExpiresAt", s.rights_attested AS "rightsAttested",
             (s.rights_expires_at IS NOT NULL AND s.rights_expires_at <= GREATEST(statement_timestamp(), $3::timestamptz)) AS expired,
             s.robots_allowed AS "robotsAllowed", r.id AS "revocationEventId",
             r.revoked_at AS "revokedAt", r.reason
      FROM astra.research_sources s
      LEFT JOIN LATERAL (
        SELECT id, revoked_at, reason
        FROM astra.research_source_rights_revocations
        WHERE tenant_id = s.tenant_id AND source_id = s.id
        ORDER BY revoked_at DESC, id DESC LIMIT 1
      ) r ON true
      WHERE s.tenant_id = $1::uuid AND s.id = ANY($2::uuid[])
    `, [tenantId.toLowerCase(), ids, at]);
    for (const row of result.rows) byId.set(String(row.sourceId).toLowerCase(), rightsView(row));
  }
  const output = new Map();
  for (const rawId of sourceIds) {
    const id = normalizeSourceId(rawId);
    if (!id) continue;
    if (output.has(id)) continue;
    const found = byId.get(id);
    output.set(id, found || {
      sourceId: id, found: false, usable: false, status: 'unavailable', sourceUrl: null,
      rightsPolicy: null, rightsExpiresAt: null, revokedAt: null, revocationEventId: null, reason: null,
    });
  }
  return output;
}

function problem(message, statusCode, code) {
  const error = new Error(message);
  error.name = 'AstraResearchError';
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function safeText(value, field, max) {
  if (typeof value !== 'string') throw problem(`${field} is required.`, 400, 'source_rights_input_invalid');
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > max) throw problem(`${field} must contain 1 to ${max} characters.`, 400, 'source_rights_input_invalid');
  return normalized;
}

function assertOwnerAdmin(actor) {
  if (!['owner', 'admin'].includes(actor?.tenantRole)) {
    throw problem('Only tenant owners and admins can revoke source rights.', 403, 'source_rights_role_denied');
  }
}

/** Append a permanent source-rights revocation with tenant/source-scoped idempotency. */
export async function revokeAstraSourceRights(client, actor, sourceId, input) {
  assertOwnerAdmin(actor);
  const id = normalizeSourceId(sourceId);
  if (!id) throw problem('Source was not found.', 404, 'source_not_found');
  if (Object.hasOwn(input || {}, 'tenantId') || Object.hasOwn(input || {}, 'actorId') || Object.hasOwn(input || {}, 'userId')) {
    throw problem('Actor and tenant identity come from the verified session.', 400, 'source_rights_identity_spoofed');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['reason', 'idempotencyKey'].includes(key))) {
    throw problem('Only reason and idempotencyKey may be supplied.', 400, 'source_rights_input_invalid');
  }
  const reason = safeText(input.reason, 'reason', 1000);
  const idempotencyKey = safeText(input.idempotencyKey, 'idempotencyKey', 200);
  const actorId = String(actor?.userId || '');
  if (!/^[1-9][0-9]{0,39}$/.test(actorId)) throw problem('Verified actor identity is required.', 403, 'source_rights_actor_required');

  const source = await client.query(
    'SELECT 1 FROM astra.research_sources WHERE tenant_id = $1::uuid AND id = $2::uuid',
    [actor.tenantId, id],
  );
  if (!source.rows[0]) throw problem('Source was not found.', 404, 'source_not_found');

  const inserted = await client.query(`
    INSERT INTO astra.research_source_rights_revocations
      (tenant_id, source_id, idempotency_key, reason, created_by)
    VALUES ($1::uuid, $2::uuid, $3, $4, $5)
    ON CONFLICT (tenant_id, source_id, idempotency_key) DO NOTHING
    RETURNING id AS "revocationEventId", revoked_at AS "revokedAt", reason
  `, [actor.tenantId, id, idempotencyKey, reason, actorId]);
  if (inserted.rows[0]) return { ...inserted.rows[0], sourceId: id, duplicate: false };

  const prior = await client.query(`
    SELECT id AS "revocationEventId", revoked_at AS "revokedAt", reason
    FROM astra.research_source_rights_revocations
    WHERE tenant_id = $1::uuid AND source_id = $2::uuid AND idempotency_key = $3
  `, [actor.tenantId, id, idempotencyKey]);
  if (!prior.rows[0]) throw problem('Source was not found.', 404, 'source_not_found');
  if (prior.rows[0].reason !== reason) throw problem('Idempotency key was already used with different content.', 409, 'source_rights_idempotency_conflict');
  return { ...prior.rows[0], sourceId: id, duplicate: true };
}

export async function getAstraSourceRights(client, tenantId, sourceId) {
  const id = normalizeSourceId(sourceId);
  if (!id) return null;
  const rights = await readAstraSourceRights(client, tenantId, [id]);
  const view = rights.get(id);
  return view?.found ? view : null;
}
