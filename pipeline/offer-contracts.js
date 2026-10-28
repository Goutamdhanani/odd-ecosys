import { createHash } from 'node:crypto';
import { assignOfferToTenant, initializeOfferProofStore, normalizeOfferTenantId, verifyOfferProofs } from './offer-proof-store.js';
import { assertOfferTenantOwnership, evaluateOfferPolicy } from './offer-policy.js';

export class OfferContractError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'OfferContractError'; this.statusCode = statusCode; }
}

const hashJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordEvent = (db, type, meta) => db.prepare('INSERT INTO events(event_type,event_at,meta_json) VALUES(?,datetime(\'now\'),?)')
  .run(type, JSON.stringify(meta));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, allowed, label) => {
  if (!object(value)) throw new OfferContractError(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new OfferContractError(`${label} contains unsupported fields: ${unknown.join(', ')}.`);
};
const text = (value, label, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new OfferContractError(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
};
const isoDate = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new OfferContractError(`${label} must be an ISO UTC timestamp.`);
  }
  return new Date(value).toISOString();
};
const countryList = (value, label, allowEmpty = false) => {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 100) throw new OfferContractError(`${label} must contain ${allowEmpty ? 'at most' : 'between 1 and'} 100 ISO 3166-1 alpha-2 country codes.`);
  const list = value.map(item => {
    if (typeof item !== 'string' || !/^[A-Za-z]{2}$/.test(item)) throw new OfferContractError(`${label} entries must be two-letter country codes.`);
    return item.toUpperCase();
  });
  if (new Set(list).size !== list.length) throw new OfferContractError(`${label} cannot contain duplicate country codes.`);
  return list.sort();
};

export function normalizeOfferContent(input, now = new Date()) {
  keysOnly(input, ['service', 'scope', 'price', 'proofAssets', 'audienceExclusions', 'geography', 'capacity', 'egress'], 'Offer');
  const service = text(input.service, 'Service', 160);
  const scope = text(input.scope, 'Scope', 2000);
  keysOnly(input.price, ['minMinor', 'maxMinor', 'currency'], 'Price');
  const { minMinor, maxMinor } = input.price;
  if (!Number.isSafeInteger(minMinor) || !Number.isSafeInteger(maxMinor) || minMinor < 0 || maxMinor < minMinor || maxMinor > 100_000_000_000) {
    throw new OfferContractError('Price boundaries must be ordered non-negative integer minor units within the supported range.');
  }
  const currency = typeof input.price.currency === 'string' ? input.price.currency.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw new OfferContractError('Currency must be a three-letter ISO currency code.');
  if (!Array.isArray(input.proofAssets) || input.proofAssets.length < 1 || input.proofAssets.length > 30) throw new OfferContractError('At least one and at most 30 proof assets are required.');
  const proofIds = new Set();
  const current = now.getTime();
  const proofAssets = input.proofAssets.map((proof, index) => {
    keysOnly(proof, ['proofId', 'reference', 'contentHash', 'observedAt', 'expiresAt', 'rightsBasis'], `Proof asset ${index + 1}`);
    const proofId = text(proof.proofId, `Proof asset ${index + 1} ID`, 100);
    if (proofIds.has(proofId)) throw new OfferContractError('Proof asset IDs must be unique within a version.');
    proofIds.add(proofId);
    const observedAt = isoDate(proof.observedAt, `Proof ${proofId} observation time`);
    const expiresAt = isoDate(proof.expiresAt, `Proof ${proofId} expiry`);
    if (Date.parse(observedAt) > current || Date.parse(expiresAt) <= current || Date.parse(expiresAt) <= Date.parse(observedAt)) {
      throw new OfferContractError(`Proof ${proofId} is future-dated, expired, or has an invalid validity interval.`);
    }
    const contentHash = typeof proof.contentHash === 'string' ? proof.contentHash.toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new OfferContractError(`Proof ${proofId} needs a SHA-256 content hash.`);
    return {
      proofId,
      reference: text(proof.reference, `Proof ${proofId} reference`, 1000),
      contentHash,
      observedAt,
      expiresAt,
      rightsBasis: text(proof.rightsBasis, `Proof ${proofId} rights basis`, 1000),
    };
  }).sort((a, b) => a.proofId.localeCompare(b.proofId));
  if (!Array.isArray(input.audienceExclusions) || input.audienceExclusions.length > 200) throw new OfferContractError('Audience exclusions must be an array of at most 200 entries.');
  const audienceExclusions = [...new Set(input.audienceExclusions.map((item, index) => text(item, `Audience exclusion ${index + 1}`, 240)))].sort();
  keysOnly(input.geography, ['includedCountries', 'excludedCountries'], 'Geography');
  const includedCountries = countryList(input.geography.includedCountries, 'Included geography');
  const excludedCountries = input.geography.excludedCountries === undefined ? [] : countryList(input.geography.excludedCountries, 'Excluded geography', true);
  if (excludedCountries.some(code => includedCountries.includes(code))) throw new OfferContractError('A country cannot be both included and excluded.');
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > 1_000_000) throw new OfferContractError('Capacity must be a positive integer no greater than 1,000,000.');
  keysOnly(input.egress, ['mode', 'allowedDestinations'], 'Egress policy');
  const mode = input.egress.mode;
  if (!['MINIMIZED_REMOTE', 'APPROVED_REMOTE', 'NO_MODEL_EGRESS'].includes(mode)) throw new OfferContractError('Egress mode must be MINIMIZED_REMOTE, APPROVED_REMOTE, or NO_MODEL_EGRESS.');
  const rawDestinations = input.egress.allowedDestinations === undefined ? [] : input.egress.allowedDestinations;
  if (!Array.isArray(rawDestinations) || rawDestinations.length > 30) throw new OfferContractError('Egress destinations must be an array of at most 30 entries.');
  const allowedDestinations = [...new Set(rawDestinations.map((item, index) => text(item, `Egress destination ${index + 1}`, 160)))].sort();
  if (mode === 'NO_MODEL_EGRESS' && allowedDestinations.length) throw new OfferContractError('NO_MODEL_EGRESS cannot list remote destinations.');
  if (mode !== 'NO_MODEL_EGRESS' && !allowedDestinations.length) throw new OfferContractError('Remote egress modes require an explicit destination allowlist.');
  return {
    contractVersion: 1,
    service,
    scope,
    price: { minMinor, maxMinor, currency },
    proofAssets,
    audienceExclusions,
    geography: { includedCountries, excludedCountries },
    capacity: input.capacity,
    egress: { mode, allowedDestinations },
  };
}

function mapVersion(db, row) {
  if (!row) return null;
  const content = JSON.parse(row.content_json);
  return {
    id: Number(row.id), offerId: Number(row.offer_id), version: Number(row.version),
    schemaVersion: Number(row.schema_version), content, contentHash: row.content_hash,
    status: row.status, createdAt: row.created_at, createdBy: row.created_by,
    approvedAt: row.approved_at, approvedBy: row.approved_by,
    revokedAt: row.revoked_at, revokedBy: row.revoked_by, revocationReason: row.revocation_reason,
    proofRevocations: db.prepare('SELECT proof_id,revoked_at,revoked_by,reason FROM offer_proof_revocations WHERE offer_version_id=? ORDER BY proof_id').all(row.id),
    rightsApprovals: db.prepare('SELECT proof_id,rights_basis,approved_at,approved_by FROM offer_proof_rights_approvals WHERE offer_version_id=? ORDER BY proof_id').all(row.id),
  };
}

function insertVersion(db, offerId, input, actor) {
  const content = normalizeOfferContent(input);
  const latest = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM offer_versions WHERE offer_id=?').get(offerId).version;
  const version = Number(latest) + 1;
  const contentJson = JSON.stringify(content);
  const contentHash = hashJson(content);
  const result = db.prepare(`INSERT INTO offer_versions(offer_id,version,content_json,content_hash,created_by)
    VALUES(?,?,?,?,?)`).run(offerId, version, contentJson, contentHash, Number.isSafeInteger(actor?.id) ? actor.id : null);
  return mapVersion(db, db.prepare('SELECT * FROM offer_versions WHERE id=?').get(result.lastInsertRowid));
}

export function createOffer(db, input, actor) {
  initializeOfferProofStore(db);
  keysOnly(input, ['name', 'content'], 'Offer request');
  const { name, content } = input;
  const label = text(name, 'Offer name', 160);
  const make = db.transaction(() => {
    const result = db.prepare('INSERT INTO offers(name,created_by) VALUES(?,?)').run(label, Number.isSafeInteger(actor?.id) ? actor.id : null);
    if (actor?.tenantId != null) assignOfferToTenant(db, Number(result.lastInsertRowid), actor);
    const version = insertVersion(db, Number(result.lastInsertRowid), content, actor);
    recordEvent(db, 'offer_created', { offer_id: Number(result.lastInsertRowid), offer_version_id: version.id, actor_id: actor?.id ?? null });
    return { id: Number(result.lastInsertRowid), name: label, version };
  });
  return make();
}

export function createOfferVersion(db, offerIdValue, content, actor) {
  initializeOfferProofStore(db);
  const offerId = Number(offerIdValue);
  if (!Number.isSafeInteger(offerId) || offerId < 1 || !db.prepare('SELECT 1 FROM offers WHERE id=?').get(offerId)) throw new OfferContractError('Offer not found.', 404);
  const currentOwner = db.prepare('SELECT tenant_id FROM offer_tenant_ownership WHERE offer_id=?').get(offerId);
  if (currentOwner && !assertOfferTenantOwnership(db, offerId, actor?.tenantId)) throw new OfferContractError('Offer ownership is unknown or belongs to another tenant.', 404);
  if (actor?.tenantId != null && !currentOwner) throw new OfferContractError('Offer ownership is unknown or belongs to another tenant.', 404);
  return db.transaction(() => {
    const version = insertVersion(db, offerId, content, actor);
    recordEvent(db, 'offer_version_created', { offer_id: offerId, offer_version_id: version.id, content_hash: version.contentHash, actor_id: actor?.id ?? null });
    return version;
  })();
}

export function listOffers(db) {
  return db.prepare(`SELECT o.id,o.name,o.created_at,o.created_by,v.id AS latest_version_id,v.version AS latest_version,
    v.status AS latest_status,v.content_hash AS latest_content_hash
    FROM offers o LEFT JOIN offer_versions v ON v.id=(SELECT id FROM offer_versions WHERE offer_id=o.id ORDER BY version DESC LIMIT 1)
    ORDER BY o.id DESC`).all();
}

export function getOffer(db, offerIdValue) {
  const offerId = Number(offerIdValue);
  const offer = db.prepare('SELECT id,name,created_at,created_by FROM offers WHERE id=?').get(offerId);
  if (!offer) return null;
  const versions = db.prepare('SELECT * FROM offer_versions WHERE offer_id=? ORDER BY version DESC').all(offerId).map(row => mapVersion(db, row));
  return { ...offer, versions };
}

export function getOfferVersion(db, versionIdValue) {
  const id = Number(versionIdValue);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return mapVersion(db, db.prepare('SELECT * FROM offer_versions WHERE id=?').get(id));
}

export function validateOfferVersionForUse(db, versionId, now = new Date()) {
  initializeOfferProofStore(db);
  const row = db.prepare('SELECT * FROM offer_versions WHERE id=?').get(Number(versionId));
  if (!row) return { ok: false, code: 'offer_version_missing', message: 'The bound offer version does not exist.' };
  if (row.status !== 'approved') return { ok: false, code: row.status === 'revoked' ? 'offer_revoked' : 'offer_unapproved', message: 'The bound offer version is not approved.' };
  let content;
  try { content = JSON.parse(row.content_json); } catch { return { ok: false, code: 'offer_content_invalid', message: 'The bound offer content is unreadable.' }; }
  if (hashJson(content) !== row.content_hash) return { ok: false, code: 'offer_hash_mismatch', message: 'The bound offer content failed its integrity check.' };
  const current = now.getTime();
  const revoked = new Set(db.prepare('SELECT proof_id FROM offer_proof_revocations WHERE offer_version_id=?').all(row.id).map(item => item.proof_id));
  const rights = new Map(db.prepare('SELECT proof_id,rights_basis FROM offer_proof_rights_approvals WHERE offer_version_id=?').all(row.id).map(item => [item.proof_id, item.rights_basis]));
  for (const proof of content.proofAssets || []) {
    if (revoked.has(proof.proofId)) return { ok: false, code: 'offer_proof_revoked', message: `Proof ${proof.proofId} has been revoked.` };
    if (!Number.isFinite(Date.parse(proof.expiresAt)) || Date.parse(proof.expiresAt) <= current) return { ok: false, code: 'offer_proof_expired', message: `Proof ${proof.proofId} has expired.` };
    if (rights.get(proof.proofId) !== proof.rightsBasis) return { ok: false, code: 'offer_proof_rights_unapproved', message: `Rights for proof ${proof.proofId} are not approved.` };
  }
  if (!content.geography?.includedCountries?.length || !content.price || !content.egress) return { ok: false, code: 'offer_policy_invalid', message: 'The offer lacks required price, geography, or egress settings.' };
  const ownership = db.prepare('SELECT tenant_id FROM offer_tenant_ownership WHERE offer_id=?').get(row.offer_id);
  const ownerTenantId = normalizeOfferTenantId(String(ownership?.tenant_id ?? ''));
  if (!ownerTenantId) {
    return { ok: false, code: 'offer_ownership_unknown', message: 'The offer has no provable tenant ownership.' };
  }
  const proofCheck = verifyOfferProofs(db, row.id, ownerTenantId, now);
  if (!proofCheck.ok) return proofCheck;
  const policyCheck = evaluateOfferPolicy(content);
  if (!policyCheck.ok) return { ok: false, code: policyCheck.blockers[0], message: 'The approved offer violates a current policy constraint.' };
  return { ok: true, offerVersionId: Number(row.id), offerId: Number(row.offer_id), version: Number(row.version), content, contentHash: row.content_hash };
}

export function approveOfferVersion(db, offerIdValue, versionIdValue, actor) {
  initializeOfferProofStore(db);
  if (!['owner', 'admin'].includes(actor?.role)) throw new OfferContractError('Only workspace owners and admins can approve offers.', 403);
  const offerId = Number(offerIdValue), versionId = Number(versionIdValue);
  if (!assertOfferTenantOwnership(db, offerId, actor?.tenantId)) throw new OfferContractError('Offer ownership is unknown or belongs to another tenant.', 404);
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM offer_versions WHERE id=? AND offer_id=?').get(versionId, offerId);
    if (!row) throw new OfferContractError('Offer version not found.', 404);
    if (row.status !== 'draft') throw new OfferContractError('Only a draft offer version can be approved.', 409);
    const storedContent = JSON.parse(row.content_json);
    delete storedContent.contractVersion;
    const usableContent = normalizeOfferContent(storedContent);
    if (hashJson(usableContent) !== row.content_hash) throw new OfferContractError('Offer version content failed its integrity check.', 409);
    const ids = usableContent.proofAssets.map(proof => proof.proofId);
    const values = ids.map(proofId => {
      const proof = usableContent.proofAssets.find(item => item.proofId === proofId);
      return [versionId, proofId, proof.rightsBasis, Number.isSafeInteger(actor?.id) ? actor.id : null];
    });
    const insert = db.prepare(`INSERT INTO offer_proof_rights_approvals(offer_version_id,proof_id,rights_basis,approved_by)
      VALUES(?,?,?,?)`);
    for (const value of values) insert.run(...value);
    const changed = db.prepare(`UPDATE offer_versions SET status='approved',approved_at=datetime('now'),approved_by=?
      WHERE id=? AND status='draft'`).run(Number.isSafeInteger(actor?.id) ? actor.id : null, versionId).changes;
    if (changed !== 1) throw new OfferContractError('Offer version changed during approval.', 409);
    const validity = validateOfferVersionForUse(db, versionId);
    if (!validity.ok) throw new OfferContractError(validity.message, 409);
    recordEvent(db, 'offer_version_approved', { offer_id: offerId, offer_version_id: versionId, content_hash: row.content_hash, actor_id: actor?.id ?? null });
    return getOfferVersion(db, versionId);
  })();
}

export function revokeOfferVersion(db, offerIdValue, versionIdValue, reason, actor) {
  initializeOfferProofStore(db);
  if (!['owner', 'admin'].includes(actor?.role)) throw new OfferContractError('Only workspace owners and admins can revoke offers.', 403);
  const offerId = Number(offerIdValue), versionId = Number(versionIdValue), note = text(reason, 'Revocation reason', 1000);
  if (!assertOfferTenantOwnership(db, offerId, actor?.tenantId)) throw new OfferContractError('Offer ownership is unknown or belongs to another tenant.', 404);
  return db.transaction(() => {
    const row = db.prepare('SELECT status FROM offer_versions WHERE id=? AND offer_id=?').get(versionId, offerId);
    if (!row) throw new OfferContractError('Offer version not found.', 404);
    if (row.status !== 'approved') throw new OfferContractError('Only an approved offer version can be revoked.', 409);
    db.prepare(`UPDATE offer_versions SET status='revoked',revoked_at=datetime('now'),revoked_by=?,revocation_reason=? WHERE id=?`)
      .run(Number.isSafeInteger(actor?.id) ? actor.id : null, note, versionId);
    recordEvent(db, 'offer_version_revoked', { offer_id: offerId, offer_version_id: versionId, reason: note, actor_id: actor?.id ?? null });
    return getOfferVersion(db, versionId);
  })();
}

export function revokeOfferProof(db, offerIdValue, versionIdValue, proofIdValue, reason, actor) {
  initializeOfferProofStore(db);
  if (!['owner', 'admin'].includes(actor?.role)) throw new OfferContractError('Only workspace owners and admins can revoke offer proof.', 403);
  const offerId = Number(offerIdValue), versionId = Number(versionIdValue), proofId = text(proofIdValue, 'Proof ID', 100), note = text(reason, 'Revocation reason', 1000);
  if (!assertOfferTenantOwnership(db, offerId, actor?.tenantId)) throw new OfferContractError('Offer ownership is unknown or belongs to another tenant.', 404);
  return db.transaction(() => {
    const row = db.prepare('SELECT content_json FROM offer_versions WHERE id=? AND offer_id=?').get(versionId, offerId);
    if (!row) throw new OfferContractError('Offer version not found.', 404);
    if (!JSON.parse(row.content_json).proofAssets.some(proof => proof.proofId === proofId)) throw new OfferContractError('Proof asset not found.', 404);
    db.prepare(`INSERT INTO offer_proof_revocations(offer_version_id,proof_id,revoked_by,reason) VALUES(?,?,?,?)`)
      .run(versionId, proofId, Number.isSafeInteger(actor?.id) ? actor.id : null, note);
    recordEvent(db, 'offer_proof_revoked', { offer_id: offerId, offer_version_id: versionId, proof_id: proofId, reason: note, actor_id: actor?.id ?? null });
    return { offerId, offerVersionId: versionId, proofId, revoked: true };
  })();
}
