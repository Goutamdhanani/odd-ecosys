import { AstraResearchError, ASTRA_RESEARCH_MAX_SNAPSHOT_BYTES, getResearchBlob, getResearchEvidence, saveResearchSnapshot } from './astra-evidence.js';
import { auditResearchAccount, auditResearchEvidence, getResearchAudit, getResearchIdentityCandidates, getResearchReport, listResearchIdentities } from './astra-research.js';
import { correctResearchClaim, createResearchClaim, listResearchClaims } from './astra-claims.js';
import { getAstraSourceRights, revokeAstraSourceRights } from './astra-source-rights.js';

const PATH = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/research(?:\/(?<resource>snapshots|evidence|identities|audits|claims|reports)(?:\/(?<recordId>[0-9a-fA-F-]{36})(?:\/(?<action>content|candidates|corrections))?)?)?$/;
const SOURCE_RIGHTS_PATH = /^\/api\/astra\/tenants\/(?<tenantId>[0-9a-fA-F-]{36})\/research\/sources\/(?<sourceId>[0-9a-fA-F-]{36})\/(?<rightsAction>rights|rights-revocations)$/;
const WRITE_ROLES = ['owner', 'admin', 'operator'];
const RIGHTS_REVOCATION_ROLES = ['owner', 'admin'];

function assertActor(params, actor) {
  if (!actor?.tenantId || String(actor.tenantId).toLowerCase() !== String(params?.tenantId || '').toLowerCase()) {
    throw new AstraResearchError('Verified tenant membership is required.', 403, 'tenant_membership_required');
  }
}
const limitOf = req => Math.max(1, Math.min(100, Number(new URL(req.url || '/', 'http://astra.local').searchParams.get('limit')) || 50));

async function handle(req, res, context) {
  const { params, actor, db, readJson, sendJson } = context;
  assertActor(params, actor);
  const { resource, recordId, action } = params || {};
  if (req.method === 'POST' && resource === 'snapshots' && !recordId) {
    const body = await readJson(req, ASTRA_RESEARCH_MAX_SNAPSHOT_BYTES * 4);
    const data = await saveResearchSnapshot(db, actor, body);
    return sendJson(res, { data }, 201);
  }
  if (req.method === 'GET' && (!resource || resource === 'evidence') && !recordId) {
    const limit = limitOf(req);
    const rows = await db.query(`SELECT e.id,e.source_id AS "sourceId",s.source_url AS "sourceUrl",s.normalized_domain AS "normalizedDomain",
      s.rights_policy AS "rightsPolicy",s.rights_expires_at AS "rightsExpiresAt",e.content_sha256 AS "contentSha256",e.captured_at AS "capturedAt",
      e.extractor_version AS "extractorVersion",e.document_title AS "documentTitle",e.coverage_status AS "coverageStatus",e.source_content_untrusted AS "sourceContentUntrusted",length(b.content) AS "byteLength"
      FROM astra.research_evidence e JOIN astra.research_sources s ON (s.tenant_id,s.id)=(e.tenant_id,e.source_id)
      JOIN astra.research_blobs b ON (b.tenant_id,b.sha256)=(e.tenant_id,e.content_sha256)
      WHERE e.tenant_id=$1 ORDER BY e.captured_at DESC LIMIT $2`, [actor.tenantId, limit]);
    return sendJson(res, { data: rows.rows }, 200);
  }
  if (req.method === 'GET' && resource === 'evidence' && recordId && !action) {
    const data = await getResearchEvidence(db, actor.tenantId, recordId);
    return data ? sendJson(res, { data }, 200) : sendJson(res, { error: 'Evidence was not found.', code: 'evidence_not_found' }, 404);
  }
  if (req.method === 'GET' && resource === 'evidence' && recordId && action === 'content') {
    const blob = await getResearchBlob(db, actor.tenantId, recordId);
    return blob ? sendJson(res, { data: { contentSha256: blob.sha256, mediaType: blob.media_type, byteLength: Number(blob.byte_length), contentBase64: Buffer.from(blob.content).toString('base64') } }, 200)
      : sendJson(res, { error: 'Evidence was not found.', code: 'evidence_not_found' }, 404);
  }
  if (req.method === 'GET' && resource === 'identities' && !recordId) return sendJson(res, { data: await listResearchIdentities(db, actor.tenantId, { limit: limitOf(req) }) }, 200);
  if (req.method === 'GET' && resource === 'identities' && recordId && action === 'candidates') {
    const data = await getResearchIdentityCandidates(db, actor.tenantId, recordId);
    return sendJson(res, { data }, 200);
  }
  if (req.method === 'POST' && resource === 'audits' && !recordId) {
    const body = await readJson(req, 16 * 1024);
    const hasEvidenceId = Object.hasOwn(body || {}, 'evidenceId');
    const hasAccountId = Object.hasOwn(body || {}, 'accountId');
    if (hasEvidenceId === hasAccountId) throw new AstraResearchError('Provide exactly one of evidenceId or accountId.', 400, 'audit_target_invalid');
    const data = hasAccountId
      ? await auditResearchAccount(db, actor, body.accountId)
      : await auditResearchEvidence(db, actor, body.evidenceId);
    return sendJson(res, { data }, 201);
  }
  if (req.method === 'GET' && resource === 'audits' && recordId && !action) {
    const data = await getResearchAudit(db, actor.tenantId, recordId);
    return data ? sendJson(res, { data }, 200) : sendJson(res, { error: 'Audit was not found.', code: 'audit_not_found' }, 404);
  }
  if (req.method === 'POST' && resource === 'claims' && !recordId) {
    const body = await readJson(req, 32 * 1024);
    return sendJson(res, { data: await createResearchClaim(db, actor, body) }, 201);
  }
  if (req.method === 'GET' && resource === 'claims' && !recordId) return sendJson(res, { data: await listResearchClaims(db, actor.tenantId, { limit: limitOf(req) }) }, 200);
  if (req.method === 'GET' && resource === 'reports' && recordId && !action) {
    const data = await getResearchReport(db, actor.tenantId, recordId);
    return data ? sendJson(res, { data }, 200) : sendJson(res, { error: 'Research report was not found.', code: 'research_report_not_found' }, 404);
  }
  if (req.method === 'POST' && resource === 'claims' && recordId && action === 'corrections') {
    const body = await readJson(req, 16 * 1024);
    return sendJson(res, { data: await correctResearchClaim(db, actor, recordId, body) }, 201);
  }
  return sendJson(res, { error: 'Research route was not found.', code: 'research_route_not_found' }, 404);
}

export function registerAstraResearchRoutes(registerAstraApiRoute) {
  if (typeof registerAstraApiRoute !== 'function') throw new TypeError('registerAstraApiRoute is required.');
  for (const method of ['GET', 'POST']) registerAstraApiRoute({ method, path: PATH, handler: handle, ...(method === 'POST' ? { allowedRoles: WRITE_ROLES } : {}) });
  registerAstraApiRoute({
    method: 'GET', path: SOURCE_RIGHTS_PATH,
    handler: async (_req, _res, { params, actor, db, sendJson }) => {
      assertActor(params, actor);
      const data = await getAstraSourceRights(db, actor.tenantId, params.sourceId);
      return data
        ? sendJson({ data: {
          sourceId: data.sourceId, sourceUrl: data.sourceUrl, rightsPolicy: data.rightsPolicy,
          rightsExpiresAt: data.rightsExpiresAt, effectiveRightsStatus: data.status,
          usable: data.usable, revokedAt: data.revokedAt, revocationEventId: data.revocationEventId, reason: data.reason,
        } }, 200)
        : sendJson({ error: 'Source was not found.', code: 'source_not_found' }, 404);
    },
  });
  registerAstraApiRoute({
    method: 'POST', path: SOURCE_RIGHTS_PATH, allowedRoles: RIGHTS_REVOCATION_ROLES,
    handler: async (req, _res, { params, actor, db, readJson, sendJson }) => {
      assertActor(params, actor);
      const body = await readJson(req, 8 * 1024);
      const result = await revokeAstraSourceRights(db, actor, params.sourceId, body);
      return sendJson({ data: {
        sourceId: result.sourceId, revoked: true, revocationEventId: result.revocationEventId,
        revokedAt: result.revokedAt, reason: result.reason, duplicate: result.duplicate,
      } }, result.duplicate ? 200 : 201);
    },
  });
  return { registered: [
    'POST /api/astra/tenants/:tenantId/research/snapshots',
    'GET /api/astra/tenants/:tenantId/research/evidence',
    'GET /api/astra/tenants/:tenantId/research/evidence/:evidenceId',
    'GET /api/astra/tenants/:tenantId/research/evidence/:evidenceId/content',
    'GET /api/astra/tenants/:tenantId/research/identities',
    'GET /api/astra/tenants/:tenantId/research/identities/:accountId/candidates',
    'POST /api/astra/tenants/:tenantId/research/audits',
    'GET /api/astra/tenants/:tenantId/research/audits/:auditId',
    'POST /api/astra/tenants/:tenantId/research/claims',
    'GET /api/astra/tenants/:tenantId/research/claims',
    'GET /api/astra/tenants/:tenantId/research/reports/:reportId',
    'POST /api/astra/tenants/:tenantId/research/claims/:claimId/corrections',
    'GET /api/astra/tenants/:tenantId/research/sources/:sourceId/rights',
    'POST /api/astra/tenants/:tenantId/research/sources/:sourceId/rights-revocations',
  ] };
}
