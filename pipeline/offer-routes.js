import { initializeOfferProofStore, linkOfferProof, normalizeOfferTenantId, registerOfferProof, revokeOfferProofObject } from './offer-proof-store.js';
import { assertOfferTenantOwnership } from './offer-policy.js';
import {
  approveOfferVersion, createOffer, createOfferVersion, getOffer, getOfferVersion, revokeOfferVersion,
  OfferContractError,
} from './offer-contracts.js';

const safeActor = actor => Boolean(normalizeOfferTenantId(actor?.tenantId));
const owner = actor => ['owner', 'admin'].includes(actor?.role);

/** Native HTTP route adapter. `readJson(req, maxBytes)` parses only the supplied request body. */
export async function handleOfferProofRoute({ req, res, pathname, legacyDb, actor, readJson, sendJson }) {
  const match = pathname.match(/^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/offers\/(\d+)\/versions\/(\d+)\/proofs(?:\/([A-Za-z0-9_-]{1,120})\/revoke)?$/i);
  if (!match) return false;
  if (!safeActor(actor)) {
    sendJson(res, { error: 'A trusted tenant membership is required.' }, 403);
    return true;
  }
  if (!legacyDb) {
    sendJson(res, { error: 'The staged SQLite offer bridge is unavailable.' }, 503);
    return true;
  }
  const db = legacyDb;
  if (normalizeOfferTenantId(match.groups.tenantId) !== normalizeOfferTenantId(actor.tenantId)) {
    sendJson(res, { error: 'Offer not found.' }, 404);
    return true;
  }
  const offerId = Number(match[2]);
  const offerVersionId = Number(match[3]);
  if (!db.prepare('SELECT 1 FROM offer_versions WHERE id=? AND offer_id=?').get(offerVersionId, offerId)) {
    sendJson(res, { error: 'Offer version not found.' }, 404);
    return true;
  }
  if (!assertOfferTenantOwnership(db, offerId, actor.tenantId)) {
    sendJson(res, { error: 'Offer not found.' }, 404);
    return true;
  }
  if (req.method === 'POST' && !match[4]) {
    if (!owner(actor)) { sendJson(res, { error: 'Only workspace owners and admins can attach offer proof.' }, 403); return true; }
    try {
      const body = await readJson(req, 14 * 1024 * 1024);
      if (typeof body.proofId !== 'string' || !body.proofId.trim() || body.proofId.length > 100) {
        sendJson(res, { error: 'A proof id is required.' }, 400); return true;
      }
      if (typeof body.bytesBase64 !== 'string' || body.bytesBase64.length > 14 * 1024 * 1024
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.bytesBase64)) {
        sendJson(res, { error: 'Proof upload must contain valid base64 bytes.' }, 400); return true;
      }
      const bytes = Buffer.from(body.bytesBase64, 'base64');
      const stored = registerOfferProof(db, actor, {
        bytes, mimeType: body.mimeType, expiresAt: body.expiresAt, contentHash: body.contentHash,
      });
      const linked = linkOfferProof(db, actor, { offerVersionId, proofId: body.proofId, objectId: stored.id });
      sendJson(res, { proof: { ...stored, ...linked } }, 201);
    } catch (error) {
      sendJson(res, { error: error.message }, error.statusCode || 400);
    }
    return true;
  }
  if (req.method === 'POST' && match[4]) {
    if (!owner(actor)) { sendJson(res, { error: 'Only workspace owners and admins can revoke offer proof.' }, 403); return true; }
    try {
      const body = await readJson(req, 8 * 1024);
      const result = revokeOfferProofObject(db, actor, match[4], body.reason);
      sendJson(res, result, 200);
    } catch (error) {
      sendJson(res, { error: error.message }, error.statusCode || 400);
    }
    return true;
  }
  sendJson(res, { error: 'Method not allowed.' }, 405);
  return true;
}

/** Tenant-scoped SQLite offer API, called only with the explicitly staged legacyDb handle. */
export async function handleTenantOfferRoute({ req, res, pathname, legacyDb, actor, readJson, sendJson }) {
  const match = pathname.match(/^\/api\/astra\/tenants\/(?<tenantId>[0-9a-f-]{36})\/offers(?:\/(\d+))?(?:\/versions(?:\/(\d+))?(?:\/(approve|revoke))?)?$/i);
  if (!match) return false;
  const tenant = normalizeOfferTenantId(match.groups.tenantId);
  if (!safeActor(actor) || tenant !== normalizeOfferTenantId(actor.tenantId)) {
    sendJson(res, { error: 'Tenant membership is required for this offer.' }, 404);
    return true;
  }
  if (!legacyDb) {
    sendJson(res, { error: 'The staged SQLite offer bridge is unavailable.' }, 503);
    return true;
  }
  initializeOfferProofStore(legacyDb);
  try {
    const offerId = match[2] ? Number(match[2]) : null;
    const versionId = match[3] ? Number(match[3]) : null;
    if (req.method === 'GET' && !offerId) {
      const offers = legacyDb.prepare(`SELECT o.id,o.name,o.created_at,o.created_by,v.id AS latest_version_id,
        v.version AS latest_version,v.status AS latest_status,v.content_hash AS latest_content_hash
        FROM offers o JOIN offer_tenant_ownership t ON t.offer_id=o.id
        LEFT JOIN offer_versions v ON v.id=(SELECT id FROM offer_versions WHERE offer_id=o.id ORDER BY version DESC LIMIT 1)
        WHERE t.tenant_id=? ORDER BY o.id DESC`).all(tenant);
      sendJson(res, { offers }); return true;
    }
    if (req.method === 'POST' && !offerId) {
      const body = await readJson(req, 128 * 1024);
      sendJson(res, { offer: createOffer(legacyDb, body, actor) }, 201); return true;
    }
    if (!offerId || !assertOfferTenantOwnership(legacyDb, offerId, tenant)) {
      sendJson(res, { error: 'Offer not found.' }, 404); return true;
    }
    if (req.method === 'GET' && !versionId) {
      sendJson(res, { offer: getOffer(legacyDb, offerId) }); return true;
    }
    if (req.method === 'GET' && versionId && !match[4]) {
      const version = getOfferVersion(legacyDb, versionId);
      if (!version || version.offerId !== offerId) { sendJson(res, { error: 'Offer version not found.' }, 404); return true; }
      sendJson(res, { version }); return true;
    }
    if (req.method === 'POST' && pathname.endsWith('/versions') && !versionId) {
      const body = await readJson(req, 128 * 1024);
      sendJson(res, { version: createOfferVersion(legacyDb, offerId, body.content, actor) }, 201); return true;
    }
    if (versionId && match[4] === 'approve' && req.method === 'POST') {
      sendJson(res, { version: approveOfferVersion(legacyDb, offerId, versionId, actor) }, 200); return true;
    }
    if (versionId && match[4] === 'revoke' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      sendJson(res, { version: revokeOfferVersion(legacyDb, offerId, versionId, body.reason, actor) }, 200); return true;
    }
    sendJson(res, { error: 'Method not allowed.' }, 405); return true;
  } catch (error) {
    sendJson(res, { error: error.message }, error.statusCode || (error instanceof OfferContractError ? error.statusCode : 400));
    return true;
  }
}
