
import { normalizeOfferTenantId } from './offer-proof-store.js';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const sha256Pattern = /^[a-f0-9]{64}$/;

export function evaluateOfferPolicy(content, context = {}) {
  const blockers = [];
  if (!plain(content) || !plain(content.price) || !plain(content.geography) || !plain(content.egress)) {
    return { ok: false, blockers: ['offer_policy_invalid'] };
  }
  if (!Number.isSafeInteger(content.price.minMinor) || !Number.isSafeInteger(content.price.maxMinor)
    || content.price.minMinor < 0 || content.price.maxMinor < content.price.minMinor
    || !/^[A-Z]{3}$/.test(content.price.currency || '')) blockers.push('offer_price_invalid');
  if (context.priceAtUse !== undefined) {
    const price = context.priceAtUse;
    if (!plain(price) || !Number.isSafeInteger(price.minor) || price.currency !== content.price.currency
      || price.minor < content.price.minMinor || price.minor > content.price.maxMinor) blockers.push('offer_price_outside_approved_bounds');
  }
  if (!Number.isSafeInteger(content.capacity) || content.capacity < 1) blockers.push('offer_capacity_invalid');
  if (context.reservedCapacity !== undefined && Number(context.reservedCapacity) >= Number(content.capacity)) blockers.push('offer_capacity_exhausted');
  const geography = content.geography;
  if (!Array.isArray(geography.includedCountries) || !geography.includedCountries.length
    || geography.includedCountries.some(code => !/^[A-Z]{2}$/.test(code))) blockers.push('offer_geography_invalid');
  if (context.country !== undefined) {
    const country = typeof context.country === 'string' ? context.country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country) || !geography.includedCountries?.includes(country)
      || geography.excludedCountries?.includes(country)) blockers.push('offer_geography_excluded');
  }
  if (!plain(content.egress) || !['MINIMIZED_REMOTE', 'APPROVED_REMOTE', 'NO_MODEL_EGRESS'].includes(content.egress.mode)) blockers.push('offer_egress_invalid');
  if (context.modelDestination !== undefined) {
    if (content.egress.mode === 'NO_MODEL_EGRESS' || !content.egress.allowedDestinations?.includes(context.modelDestination)) blockers.push('offer_model_egress_blocked');
  }
  if (context.proofAssets && (!Array.isArray(content.proofAssets) || content.proofAssets.some(proof => !sha256Pattern.test(proof.contentHash || '')))) blockers.push('offer_proof_invalid');
  if (context.segment !== undefined) {
    if (typeof context.segment !== 'string' || !context.segment.trim()) blockers.push('offer_segment_unknown');
    else if ((content.audienceExclusions || []).some(value => value.toLocaleLowerCase() === context.segment.trim().toLocaleLowerCase())) blockers.push('offer_segment_excluded');
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export function evaluateOfferModelEgress(content, destination) {
  if (typeof destination !== 'string' || !destination.trim()) return { ok: false, blockers: ['offer_model_egress_destination_unknown'] };
  return evaluateOfferPolicy(content, { modelDestination: destination.trim() });
}

export function assertOfferTenantOwnership(db, offerId, tenantId) {
  const tenant = normalizeOfferTenantId(tenantId);
  if (!tenant) return false;
  let count;
  try { count = db.prepare('SELECT COUNT(*) AS count FROM offer_tenant_ownership').get().count; }
  catch { return false; }
  if (!count) return false;
  const row = db.prepare('SELECT tenant_id FROM offer_tenant_ownership WHERE offer_id=?').get(Number(offerId));
  return Boolean(row && normalizeOfferTenantId(String(row.tenant_id)) === tenant);
}

export function campaignOfferTenantMatches(db, campaignId, offerId) {
  const offerOwner = db.prepare('SELECT tenant_id FROM offer_tenant_ownership WHERE offer_id=?').get(Number(offerId));
  if (!offerOwner) return false;
  let campaignTenant = null;
  try {
    const columns = db.prepare('PRAGMA table_info(campaigns)').all().map(column => column.name);
    if (columns.includes('tenant_id')) campaignTenant = db.prepare('SELECT tenant_id FROM campaigns WHERE id=?').get(Number(campaignId))?.tenant_id;
    if (campaignTenant == null) {
      const hasOwnership = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='campaign_tenant_ownership'").get();
      if (hasOwnership) campaignTenant = db.prepare('SELECT tenant_id FROM campaign_tenant_ownership WHERE campaign_id=?').get(Number(campaignId))?.tenant_id;
    }
  } catch { return false; }
  const campaignTenantId = normalizeOfferTenantId(String(campaignTenant ?? ''));
  const offerTenantId = normalizeOfferTenantId(String(offerOwner.tenant_id ?? ''));
  return Boolean(campaignTenantId && offerTenantId && campaignTenantId === offerTenantId);
}

export function reserveOfferCapacity(db, { offerVersionId, sendId, idempotencyKey, capacity }) {
  if (!Number.isSafeInteger(Number(sendId)) || Number(sendId) < 1 || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return { ok: false, code: 'offer_reservation_key_invalid' };
  }
  db.exec(`CREATE TABLE IF NOT EXISTS offer_capacity_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, offer_version_id INTEGER NOT NULL REFERENCES offer_versions(id),
    send_id INTEGER NOT NULL UNIQUE, idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','accepted','uncertain','released')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(offer_version_id,idempotency_key)
  )`);
  const reserve = db.transaction(() => {
    const existing = db.prepare('SELECT state FROM offer_capacity_reservations WHERE offer_version_id=? AND idempotency_key=?')
      .get(Number(offerVersionId), idempotencyKey);
    if (existing) return { ok: ['reserved', 'accepted', 'uncertain'].includes(existing.state), state: existing.state, reused: true };
    const count = db.prepare(`SELECT COUNT(*) AS count FROM offer_capacity_reservations
      WHERE offer_version_id=? AND state IN ('reserved','accepted','uncertain')`).get(Number(offerVersionId)).count;
    if (Number(count) >= Number(capacity)) return { ok: false, code: 'offer_capacity_exhausted' };
    db.prepare(`INSERT INTO offer_capacity_reservations(offer_version_id,send_id,idempotency_key,state)
      VALUES(?,?,?,'reserved')`).run(Number(offerVersionId), Number(sendId), idempotencyKey);
    return { ok: true, state: 'reserved', reused: false };
  });
  return reserve.immediate();
}

export function settleOfferCapacity(db, sendId, state) {
  if (!['accepted', 'uncertain', 'released'].includes(state)) throw new TypeError('Invalid offer capacity reservation state.');
  const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='offer_capacity_reservations'").get();
  if (!present) return 0;
  return db.prepare(`UPDATE offer_capacity_reservations SET state=?,updated_at=datetime('now')
    WHERE send_id=? AND state='reserved'`).run(state, Number(sendId)).changes;
}

