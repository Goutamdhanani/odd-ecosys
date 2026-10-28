import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-offer-contract-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const offers = await import('../pipeline/offer-contracts.js');
const proofStore = await import('../pipeline/offer-proof-store.js');

after(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

const future = '2035-01-01T00:00:00.000Z';
const observed = '2026-10-01T00:00:00.000Z';
const tenantA = '98387fbb-0e5a-4657-a435-61b32989291a';
const tenantB = '5dbf91f7-17c5-4ac3-b7cb-99bc55185d72';
const proofBytes = Buffer.from('Synthetic uploaded proof bytes for offer-contract unit fixtures.');
const proofHash = createHash('sha256').update(proofBytes).digest('hex');
function content(overrides = {}) {
  return {
    service: 'SEO audit', scope: 'One technical audit with a written findings report.',
    price: { minMinor: 100_00, maxMinor: 900_00, currency: 'USD' },
    proofAssets: [{ proofId: 'case-study-1', reference: 'fixture://uploaded/case-study-1', contentHash: proofHash, observedAt: observed, expiresAt: future, rightsBasis: 'Synthetic fixture grant 77' }],
    audienceExclusions: ['Existing customer'], geography: { includedCountries: ['US'], excludedCountries: ['CA'] },
    capacity: 8, egress: { mode: 'APPROVED_REMOTE', allowedDestinations: ['glm-api'] }, ...overrides,
  };
}

function attachProof(version, actor) {
  const proof = version.content.proofAssets[0];
  const stored = proofStore.registerOfferProof(db, actor, {
    bytes: proofBytes, mimeType: 'text/plain', expiresAt: proof.expiresAt, contentHash: proof.contentHash,
  });
  return proofStore.linkOfferProof(db, actor, { offerVersionId: version.id, proofId: proof.proofId, objectId: stored.id });
}

test('offer content is validated, immutable, versioned and gated by trusted approval metadata', () => {
  assert.throws(() => offers.normalizeOfferContent(content({ price: { minMinor: 2, maxMinor: 1, currency: 'USD' } })), /ordered non-negative/);
  assert.throws(() => offers.normalizeOfferContent(content({ geography: { includedCountries: [], excludedCountries: [] } })), /Included geography/);
  assert.throws(() => offers.normalizeOfferContent(content({ proofAssets: [{ ...content().proofAssets[0], expiresAt: '2026-10-02T00:00:00Z' }] })), /expired/);
  assert.throws(() => offers.normalizeOfferContent({ ...content(), status: 'approved' }), /unsupported fields/);

  const owner = { id: 71, role: 'owner', tenantId: tenantA };
  const created = offers.createOffer(db, { name: 'SEO audit', content: content() }, owner);
  const first = created.version;
  attachProof(first, owner);
  assert.equal(first.version, 1);
  assert.equal(first.status, 'draft');
  assert.equal(offers.validateOfferVersionForUse(db, first.id).code, 'offer_unapproved');
  assert.throws(() => offers.approveOfferVersion(db, created.id, first.id, { id: 72, role: 'operator', tenantId: tenantA }), /Only workspace owners and admins/);

  const approved = offers.approveOfferVersion(db, created.id, first.id, owner);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, owner.id);
  assert.equal(offers.validateOfferVersionForUse(db, first.id).ok, true);
  assert.throws(() => offers.createOfferVersion(db, created.id, content(), { id: 73, role: 'owner', tenantId: tenantB }), /ownership is unknown or belongs to another tenant/i);
  assert.throws(() => offers.approveOfferVersion(db, created.id, first.id, { id: 74, role: 'owner', tenantId: tenantB }), /ownership is unknown or belongs to another tenant/i);
  assert.throws(() => db.prepare('UPDATE offer_versions SET content_json=? WHERE id=?').run('{}', first.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM offer_versions WHERE id=?').run(first.id), /immutable/);

  const second = offers.createOfferVersion(db, created.id, content({ scope: 'Two technical audits with a written findings report.' }), owner);
  attachProof(second, owner);
  assert.equal(second.version, 2);
  assert.notEqual(second.contentHash, first.contentHash);
  assert.equal(offers.getOfferVersion(db, first.id).content.scope, 'One technical audit with a written findings report.');
  assert.equal(second.status, 'draft');
});

test('proof revocation, offer revocation and elapsed proof expiry block use after approval', () => {
  const admin = { id: 81, role: 'admin', tenantId: tenantA };
  const one = offers.createOffer(db, { name: 'Proof lifecycle', content: content() }, admin);
  attachProof(one.version, admin);
  offers.approveOfferVersion(db, one.id, one.version.id, admin);
  assert.equal(offers.validateOfferVersionForUse(db, one.version.id).ok, true);
  offers.revokeOfferProof(db, one.id, one.version.id, 'case-study-1', 'Rights withdrawn', admin);
  assert.equal(offers.validateOfferVersionForUse(db, one.version.id).code, 'offer_proof_revoked');

  const two = offers.createOffer(db, { name: 'Offer lifecycle', content: content() }, admin);
  attachProof(two.version, admin);
  offers.approveOfferVersion(db, two.id, two.version.id, admin);
  offers.revokeOfferVersion(db, two.id, two.version.id, 'Offer withdrawn', admin);
  assert.equal(offers.validateOfferVersionForUse(db, two.version.id).code, 'offer_revoked');

  const three = offers.createOffer(db, { name: 'Expiry lifecycle', content: content() }, admin);
  attachProof(three.version, admin);
  offers.approveOfferVersion(db, three.id, three.version.id, admin);
  assert.equal(offers.validateOfferVersionForUse(db, three.version.id, new Date('2035-01-01T00:00:00.000Z')).code, 'offer_proof_expired');
});

test('NO_MODEL_EGRESS is valid for deterministic offer workflows and malformed destinations fail as contract errors', () => {
  const noModelEgress = content({ egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] } });
  const owner = { id: 91, role: 'owner', tenantId: tenantA };
  const created = offers.createOffer(db, { name: 'Deterministic only', content: noModelEgress }, owner);
  attachProof(created.version, owner);
  offers.approveOfferVersion(db, created.id, created.version.id, owner);
  assert.equal(offers.validateOfferVersionForUse(db, created.version.id).ok, true);
  assert.throws(() => offers.normalizeOfferContent(content({ egress: { mode: 'APPROVED_REMOTE', allowedDestinations: 'glm-api' } })), /must be an array/);
  assert.throws(() => offers.normalizeOfferContent(content({ egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: ['glm-api'] } })), /cannot list remote destinations/);
});

test('legacy offers without trusted UUID ownership remain unusable', () => {
  const legacy = offers.createOffer(db, { name: 'Unowned legacy offer', content: content() }, { id: 92, role: 'owner' });
  assert.throws(() => offers.approveOfferVersion(db, legacy.id, legacy.version.id, { id: 92, role: 'owner' }), /ownership is unknown or belongs to another tenant/i);
  assert.equal(offers.validateOfferVersionForUse(db, legacy.version.id).code, 'offer_unapproved');
});

test('additive campaign offer migration preserves existing campaign, send, suppression and launch snapshot data', async () => {
  const migrationPath = path.join(directory, 'legacy-migration.db');
  const oldDbPath = process.env.ODD_DB_PATH;
  let legacy;
  let migrated;
  try {
    process.env.ODD_DB_PATH = migrationPath;
    legacy = await import('../pipeline/database.js?offer-migration-seed');
    const seededDb = legacy.initDb();
    const snapshotJson = '{"schemaVersion":1,"campaign":{"id":51,"name":"legacy frozen"},"steps":[]}';
    const snapshotHash = 'd'.repeat(64);
    seededDb.prepare('INSERT INTO campaigns(id,name) VALUES(?,?)').run(51, 'legacy frozen');
    seededDb.prepare(`INSERT INTO campaign_launches(id,campaign_id,version,snapshot_json,snapshot_hash)
      VALUES(?,?,?,?,?)`).run(61, 51, 1, snapshotJson, snapshotHash);
    seededDb.prepare(`INSERT INTO sends(id,campaign_id,campaign_launch_id,status)
      VALUES(?,?,?,?)`).run(71, 51, 61, 'scheduled');
    seededDb.prepare('INSERT INTO suppression_list(email,reason,added_at) VALUES(?,?,?)')
      .run('legacy@example.test', 'historical opt-out', '2026-01-02 03:04:05');
    legacy.closeDb();

    // Recreate the pre-S02 schema shape after seeding representative history,
    // then open it through the real initializer to exercise the additive path.
    const oldSchemaDb = new Database(migrationPath);
    oldSchemaDb.pragma('foreign_keys = OFF');
    oldSchemaDb.exec('ALTER TABLE campaigns DROP COLUMN offer_version_id; DELETE FROM schema_migrations WHERE version=8');
    oldSchemaDb.close();

    migrated = await import('../pipeline/database.js?offer-migration-reopen');
    const migratedDb = migrated.initDb();
    const campaign = migratedDb.prepare('SELECT id,name,offer_version_id FROM campaigns WHERE id=51').get();
    assert.deepEqual(campaign, { id: 51, name: 'legacy frozen', offer_version_id: null });
    assert.deepEqual(migratedDb.prepare('SELECT id,campaign_id,campaign_launch_id,status FROM sends WHERE id=71').get(), {
      id: 71, campaign_id: 51, campaign_launch_id: 61, status: 'scheduled',
    });
    assert.deepEqual(migratedDb.prepare('SELECT email,reason,added_at FROM suppression_list WHERE email=?')
      .get('legacy@example.test'), {
      email: 'legacy@example.test', reason: 'historical opt-out', added_at: '2026-01-02 03:04:05',
    });
    const launch = migratedDb.prepare('SELECT snapshot_json,snapshot_hash FROM campaign_launches WHERE id=61').get();
    assert.deepEqual(launch, { snapshot_json: snapshotJson, snapshot_hash: snapshotHash });
  } finally {
    migrated?.closeDb();
    legacy?.closeDb();
    process.env.ODD_DB_PATH = oldDbPath;
  }
});
