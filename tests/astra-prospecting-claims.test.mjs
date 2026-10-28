import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalProspectFact, prepareProspectCampaignClaims } from '../pipeline/astra-prospecting-claims.js';

const actor = { tenantId: 'tenant-a', userId: 'user-a' };
const fixedNow = new Date('2026-10-27T00:00:00.000Z');
const future = new Date('2027-01-01T00:00:00.000Z').toISOString();

function fixture({
  tenantId = actor.tenantId,
  accountDomain = 'northwind.example',
  evidenceDomain = 'northwind.example',
  extractedText = 'Northwind is among the leading Dental Practices in Canada.',
  rightsExpiresAt = future,
  jobRightsExpiresAt = future,
  current = [],
} = {}) {
  const calls = { queries: [], evidenceReads: [], claimReads: [], creations: [] };
  const db = {
    async query(sql, values) {
      calls.queries.push({ sql, values });
      if (sql.includes('SELECT normalized_domain FROM astra.research_accounts')) {
        return { rows: [{ normalized_domain: accountDomain }] };
      }
      return { rows: [] };
    },
  };
  const contact = {
    tenantId,
    jobId: 'job-a',
    qualification: { status: 'qualified' },
    contact: {
      crm: { accountId: 'account-a' },
      research: { opportunities: [{ sourceEvidenceId: 'evidence-a' }] },
    },
  };
  const job = {
    id: 'job-a', tenantId,
    payload: { category: 'Dental Practice', country: 'Canada', sourceRights: { rightsExpiresAt: jobRightsExpiresAt } },
  };
  const deps = {
    now: () => fixedNow,
    async readEvidence(_db, tenant, evidenceId) {
      calls.evidenceReads.push({ tenant, evidenceId });
      return {
        id: evidenceId, normalizedDomain: evidenceDomain, extractedText,
        contentSha256: 'a'.repeat(64), sourceRightsUsable: true, rightsExpiresAt,
      };
    },
    async readClaims(_db, input) {
      calls.claimReads.push(input);
      return current;
    },
    async createClaim(_db, _actor, claim) {
      calls.creations.push(claim);
      return { id: `claim-${claim.predicate}`, status: 'supported', value: claim.value };
    },
  };
  return { db, contact, job, deps, calls };
}

test('literalProspectFact matches complete words and requested plurals, not embedded country codes', () => {
  assert.equal(literalProspectFact('Serving Dental Practices in Canada.', 'Dental Practice', { plural: true }).value, 'Dental Practices');
  assert.equal(literalProspectFact('Made for businesses worldwide.', 'US'), null);
  assert.equal(literalProspectFact('A service in Australasia.', 'Australia'), null);
  assert.equal(literalProspectFact('US suppliers and Canada teams.', 'US').value, 'US');
});

test('prepares supported industry and country claims only from literal source wording', async () => {
  const f = fixture();
  const result = await prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps);

  assert.equal(result.ready, true);
  assert.deepEqual(result.claims.map(({ predicate, value, replayed }) => ({ predicate, value, replayed })), [
    { predicate: 'industry', value: 'Dental Practices', replayed: false },
    { predicate: 'country', value: 'Canada', replayed: false },
  ]);
  assert.deepEqual(f.calls.creations.map(({ predicate, value, exactExcerpt }) => ({ predicate, value, hasExactExcerpt: f.calls.evidenceReads.length === 1 && exactExcerpt.includes(value) })), [
    { predicate: 'industry', value: 'Dental Practices', hasExactExcerpt: true },
    { predicate: 'country', value: 'Canada', hasExactExcerpt: true },
  ]);
  assert.ok(f.calls.creations.every(claim => claim.contentSha256 === 'a'.repeat(64) && claim.subjectKey === 'northwind.example'));
  assert.equal(result.noCampaignApproval, true);
  assert.equal(result.noSend, true);
});

test('tenant and job/account/source mismatches reject before claim writes', async t => {
  await t.test('contact belongs to a different tenant', async () => {
    const f = fixture({ tenantId: 'tenant-b' });
    await assert.rejects(prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps), { code: 'prospect_not_found' });
    assert.equal(f.calls.evidenceReads.length, 0);
    assert.equal(f.calls.creations.length, 0);
  });
  await t.test('job belongs to a different tenant', async () => {
    const f = fixture(); f.job.tenantId = 'tenant-b';
    await assert.rejects(prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps), { code: 'prospect_not_found' });
    assert.equal(f.calls.queries.length, 0);
    assert.equal(f.calls.creations.length, 0);
  });
  await t.test('account domain differs from evidence domain', async () => {
    const f = fixture({ accountDomain: 'other.example' });
    await assert.rejects(prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps), { code: 'prospect_campaign_proof_unavailable' });
    assert.equal(f.calls.claimReads.length, 0);
    assert.equal(f.calls.creations.length, 0);
    assert.equal(f.calls.queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')), false);
  });
  await t.test('saved source evidence belongs to a different domain', async () => {
    const f = fixture({ evidenceDomain: 'other.example' });
    await assert.rejects(prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps), { code: 'prospect_campaign_proof_unavailable' });
    assert.equal(f.calls.claimReads.length, 0);
    assert.equal(f.calls.creations.length, 0);
    assert.equal(f.calls.queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')), false);
  });
});

test('expired permission rejects before creating any claim', async () => {
  const expired = '2026-10-26T23:59:59.000Z';
  const f = fixture({ rightsExpiresAt: expired, jobRightsExpiresAt: expired });
  await assert.rejects(prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps), /permission expired/i);
  assert.equal(f.calls.claimReads.length, 1);
  assert.equal(f.calls.creations.length, 0);
});

test('reuses matching current claims and does not create duplicates', async () => {
  const f = fixture({ current: [
    { claimId: 'current-industry', predicate: 'industry', value: 'Dental Practices', valid: true },
    { claimId: 'current-country', predicate: 'country', value: 'Canada', valid: true },
  ] });
  const result = await prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps);

  assert.equal(result.ready, true);
  assert.deepEqual(result.claims.map(({ claimId, replayed }) => ({ claimId, replayed })), [
    { claimId: 'current-industry', replayed: true },
    { claimId: 'current-country', replayed: true },
  ]);
  assert.equal(f.calls.creations.length, 0);
});

test('holds a conflicting corrected/current fact for review without overwriting it', async () => {
  const f = fixture({ current: [
    { claimId: 'corrected-industry', predicate: 'industry', value: 'Veterinary Clinics', valid: true, correctionType: 'corrected' },
  ] });
  const result = await prepareProspectCampaignClaims(f.db, actor, { contact: f.contact, job: f.job }, f.deps);

  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['industry_existing_claim_requires_review']);
  assert.deepEqual(result.claims.map(({ predicate, value }) => ({ predicate, value })), [{ predicate: 'country', value: 'Canada' }]);
  assert.deepEqual(f.calls.creations.map(({ predicate }) => predicate), ['country']);
  assert.equal(f.calls.creations.some(({ predicate }) => predicate === 'industry'), false);
});

