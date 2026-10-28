import { createHash, randomUUID } from 'node:crypto';

export class OfferProofError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'OfferProofError'; this.statusCode = statusCode; }
}

export function normalizeOfferTenantId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

const tenantId = actor => {
  const value = normalizeOfferTenantId(actor?.tenantId);
  if (!value) throw new OfferProofError('A trusted tenant membership UUID is required.', 403);
  return value;
};

export function initializeOfferProofStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS offer_proof_objects (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL, content BLOB NOT NULL,
    created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL, revoked_at TEXT, revoked_by INTEGER, revoke_reason TEXT,
    UNIQUE(tenant_id, content_hash)
  );
  CREATE TABLE IF NOT EXISTS offer_version_proof_objects (
    offer_version_id INTEGER NOT NULL, proof_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
    object_id TEXT NOT NULL REFERENCES offer_proof_objects(id), linked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(offer_version_id, proof_id),
    FOREIGN KEY(offer_version_id) REFERENCES offer_versions(id)
  );
  CREATE TABLE IF NOT EXISTS offer_tenant_ownership (
    offer_id INTEGER PRIMARY KEY REFERENCES offers(id), tenant_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')), assigned_by INTEGER
  );
  CREATE TABLE IF NOT EXISTS offer_capacity_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id),
    send_id INTEGER NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, state TEXT NOT NULL
      CHECK(state IN ('reserved','accepted','uncertain','released')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(offer_version_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_offer_proof_tenant_hash ON offer_proof_objects(tenant_id, content_hash);
  CREATE INDEX IF NOT EXISTS idx_offer_version_proof_tenant ON offer_version_proof_objects(tenant_id, offer_version_id);
  CREATE TRIGGER IF NOT EXISTS offer_proof_object_bytes_immutable
    BEFORE UPDATE OF tenant_id,content_hash,mime_type,byte_length,content,created_by,created_at,expires_at ON offer_proof_objects
    BEGIN SELECT RAISE(ABORT,'offer proof bytes and identity are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS offer_proof_object_no_delete
    BEFORE DELETE ON offer_proof_objects BEGIN SELECT RAISE(ABORT,'offer proof objects cannot be deleted'); END;
  CREATE TRIGGER IF NOT EXISTS offer_version_proof_insert_draft_only
    BEFORE INSERT ON offer_version_proof_objects WHEN (SELECT status FROM offer_versions WHERE id=NEW.offer_version_id)!='draft'
    BEGIN SELECT RAISE(ABORT,'proof objects can only be attached to draft offer versions'); END;
  CREATE TRIGGER IF NOT EXISTS offer_version_proof_no_update
    BEFORE UPDATE ON offer_version_proof_objects BEGIN SELECT RAISE(ABORT,'offer proof links are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS offer_version_proof_no_delete
    BEFORE DELETE ON offer_version_proof_objects BEGIN SELECT RAISE(ABORT,'offer proof links cannot be deleted'); END;`);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function registerOfferProof(db, actor, input) {
  initializeOfferProofStore(db);
  const tenant = tenantId(actor);
  const bytes = Buffer.isBuffer(input?.bytes) ? input.bytes : input?.bytes instanceof Uint8Array ? Buffer.from(input.bytes) : null;
  if (!bytes?.length || bytes.length > 10 * 1024 * 1024) throw new OfferProofError('Proof bytes must be between 1 byte and 10 MiB.');
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(mimeType)) throw new OfferProofError('A valid MIME type is required.');
  const expiresAt = typeof input.expiresAt === 'string' ? new Date(input.expiresAt) : null;
  if (!expiresAt || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new OfferProofError('Proof expiry must be a future timestamp.');
  const contentHash = sha256(bytes);
  if (input.contentHash && String(input.contentHash).toLowerCase() !== contentHash) throw new OfferProofError('Supplied proof hash does not match the supplied bytes.', 409);
  const id = randomUUID();
  const saved = db.transaction(() => {
    const existing = db.prepare('SELECT id,tenant_id,mime_type,byte_length,expires_at,revoked_at FROM offer_proof_objects WHERE tenant_id=? AND content_hash=?').get(tenant, contentHash);
    if (existing) {
      if (existing.revoked_at || Date.parse(existing.expires_at) <= Date.now()) throw new OfferProofError('Matching proof object is expired or revoked.', 409);
      if (existing.mime_type !== mimeType || Number(existing.byte_length) !== bytes.length) throw new OfferProofError('Matching proof hash has conflicting metadata.', 409);
      return { id: existing.id, contentHash, mimeType: existing.mime_type, byteLength: Number(existing.byte_length), expiresAt: existing.expires_at, reused: true };
    }
    db.prepare(`INSERT INTO offer_proof_objects(id,tenant_id,content_hash,mime_type,byte_length,content,created_by,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, tenant, contentHash, mimeType, bytes.length, bytes, Number.isSafeInteger(actor.id) ? actor.id : null, expiresAt.toISOString());
    return { id, contentHash, mimeType, byteLength: bytes.length, expiresAt: expiresAt.toISOString(), reused: false };
  });
  return saved();
}

export function assignOfferToTenant(db, offerId, actor) {
  initializeOfferProofStore(db);
  const tenant = tenantId(actor);
  const id = Number(offerId);
  if (!Number.isSafeInteger(id) || id < 1 || !db.prepare('SELECT 1 FROM offers WHERE id=?').get(id)) throw new OfferProofError('Offer not found.', 404);
  const existing = db.prepare('SELECT tenant_id FROM offer_tenant_ownership WHERE offer_id=?').get(id);
  if (existing && normalizeOfferTenantId(String(existing.tenant_id)) !== tenant) throw new OfferProofError('Offer belongs to another tenant.', 404);
  if (!existing) db.prepare('INSERT INTO offer_tenant_ownership(offer_id,tenant_id,assigned_by) VALUES(?,?,?)')
    .run(id, tenant, Number.isSafeInteger(actor.id) ? actor.id : null);
  return tenant;
}

export function linkOfferProof(db, actor, { offerVersionId, proofId, objectId }) {
  initializeOfferProofStore(db);
  const tenant = tenantId(actor);
  return db.transaction(() => {
    const proof = db.prepare('SELECT id,content_hash,expires_at,revoked_at FROM offer_proof_objects WHERE id=? AND tenant_id=?').get(objectId, tenant);
    if (!proof || proof.revoked_at || Date.parse(proof.expires_at) <= Date.now()) throw new OfferProofError('Proof object is missing, expired, or revoked for this tenant.', 404);
    const version = db.prepare('SELECT id,status FROM offer_versions WHERE id=?').get(Number(offerVersionId));
    if (!version) throw new OfferProofError('Offer version not found.', 404);
    if (version.status !== 'draft') throw new OfferProofError('Proof bytes can only be attached to a draft offer version.', 409);
    const offerId = db.prepare('SELECT offer_id FROM offer_versions WHERE id=?').get(Number(offerVersionId)).offer_id;
    if (normalizeOfferTenantId(String(db.prepare('SELECT tenant_id FROM offer_tenant_ownership WHERE offer_id=?').get(offerId)?.tenant_id ?? '')) !== tenant) {
      throw new OfferProofError('Offer ownership is unknown or belongs to another tenant.', 403);
    }
    const content = JSON.parse(db.prepare('SELECT content_json FROM offer_versions WHERE id=?').get(Number(offerVersionId)).content_json);
    const declared = content.proofAssets?.find(item => item.proofId === proofId);
    if (!declared || declared.contentHash !== proof.content_hash) throw new OfferProofError('Declared proof id/hash does not match the stored proof bytes.', 409);
    const linked = db.prepare('SELECT object_id FROM offer_version_proof_objects WHERE offer_version_id=? AND proof_id=?')
      .get(Number(offerVersionId), String(proofId));
    if (linked) {
      if (linked.object_id !== objectId) throw new OfferProofError('Proof id is already linked to different immutable bytes.', 409);
    } else {
      db.prepare(`INSERT INTO offer_version_proof_objects(offer_version_id,proof_id,tenant_id,object_id)
        VALUES(?,?,?,?)`).run(Number(offerVersionId), String(proofId), tenant, objectId);
    }
    return { offerVersionId: Number(offerVersionId), proofId, contentHash: proof.content_hash, linked: true };
  })();
}

export function verifyOfferProofs(db, offerVersionId, expectedTenantId = null, now = new Date()) {
  initializeOfferProofStore(db);
  const version = db.prepare('SELECT content_json FROM offer_versions WHERE id=?').get(Number(offerVersionId));
  if (!version) return { ok: false, code: 'offer_version_missing', message: 'Offer version not found.' };
  let content;
  try { content = JSON.parse(version.content_json); } catch { return { ok: false, code: 'offer_content_invalid', message: 'Offer content is unreadable.' }; }
  const proofs = content.proofAssets || [];
  if (!proofs.length) return { ok: false, code: 'offer_proof_missing', message: 'Offer has no proof assets.' };
  for (const proof of proofs) {
    const link = expectedTenantId == null
      ? db.prepare(`SELECT p.* FROM offer_version_proof_objects l JOIN offer_proof_objects p ON p.id=l.object_id
          WHERE l.offer_version_id=? AND l.proof_id=?`).get(Number(offerVersionId), proof.proofId)
      : (() => {
          const expectedTenant = normalizeOfferTenantId(String(expectedTenantId ?? ''));
          if (!expectedTenant) return null;
          return db.prepare(`SELECT p.* FROM offer_version_proof_objects l JOIN offer_proof_objects p ON p.id=l.object_id
            WHERE l.offer_version_id=? AND l.proof_id=? AND l.tenant_id=? AND p.tenant_id=?`)
            .get(Number(offerVersionId), proof.proofId, expectedTenant, expectedTenant);
        })();
    if (!link) return { ok: false, code: 'offer_proof_unverified', message: `Proof ${proof.proofId} has no tenant-owned uploaded bytes.` };
    if (link.revoked_at) return { ok: false, code: 'offer_proof_revoked', message: `Proof ${proof.proofId} has been revoked.` };
    if (Date.parse(link.expires_at) <= now.getTime() || Date.parse(proof.expiresAt) <= now.getTime()) return { ok: false, code: 'offer_proof_expired', message: `Proof ${proof.proofId} has expired.` };
    const bytes = Buffer.from(link.content);
    if (sha256(bytes) !== proof.contentHash || sha256(bytes) !== link.content_hash) return { ok: false, code: 'offer_proof_hash_mismatch', message: `Proof ${proof.proofId} bytes failed the SHA-256 check.` };
  }
  return { ok: true };
}

export function revokeOfferProofObject(db, actor, objectId, reason) {
  initializeOfferProofStore(db);
  const tenant = tenantId(actor);
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (!note || note.length > 1000) throw new OfferProofError('A revocation reason of at most 1,000 characters is required.');
  return db.transaction(() => {
    const changed = db.prepare(`UPDATE offer_proof_objects SET revoked_at=datetime('now'),revoked_by=?,revoke_reason=?
      WHERE id=? AND tenant_id=? AND revoked_at IS NULL`).run(Number.isSafeInteger(actor.id) ? actor.id : null, note, objectId, tenant).changes;
    if (!changed) throw new OfferProofError('Proof object not found or already revoked.', 404);
    return { objectId, revoked: true };
  })();
}
