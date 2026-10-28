import test from 'node:test';
import assert from 'node:assert/strict';
import { auditResearchAccount } from '../pipeline/astra-research.js';
import { researchSha256 } from '../pipeline/astra-evidence.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const accountId = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000003';
const evidenceId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-10-27T12:00:00.000Z');

async function reportFor({ capturedAt = now, rightsExpiresAt = null, expired = false, revokedAt = null } = {}) {
  const html = Buffer.from('<html><head><title>Supplied synthetic page</title></head><body><h1>Our services</h1></body></html>');
  const contentSha256 = researchSha256(html);
  const row = { accountId, accountDomain: 'research-dates.example.test', displayDomain: 'research-dates.example.test',
    evidenceId, evidenceSourceId: sourceId, evidenceDomain: 'research-dates.example.test',
    sourceId, sourceDomain: 'research-dates.example.test', sourceUrl: 'https://research-dates.example.test/about',
    capturedAt, rightsExpiresAt, rightsPolicy: 'user_provided', robotsAllowed: true, rightsAttested: true,
    html, contentSha256, blobSha256: contentSha256 };
  const db = { async query(sql, params = []) {
    if (sql.includes('FROM astra.research_accounts a')) return { rows: [row] };
    if (sql.includes('FROM astra.research_sources s')) return { rows: [{ ...row, expired, revokedAt }] };
    if (sql.includes('INSERT INTO astra.research_audits')) return { rows: [{ id: params[1], evidenceId,
      createdAt: now, auditVersion: params[3], coverageStatus: 'partial', findings: JSON.parse(params[4]) }] };
    if (sql.includes('WITH current_audit AS')) return { rows: [] };
    throw new Error('Unexpected query in isolated research-date fixture');
  } };
  return auditResearchAccount(db, { tenantId, userId: '1' }, accountId, { now });
}

test('saved research keeps an absent rights expiry null and preserves the actual capture timestamp', async () => {
  const report = await reportFor();
  assert.equal(report.sourceCoverage.pages[0].rightsExpiresAt, null);
  assert.equal(report.sourceCoverage.pages[0].capturedAt, now.toISOString());
  assert.equal(report.sourceCoverage.pages[0].status, 'usable');
  assert.doesNotMatch(JSON.stringify(report.sourceCoverage), /1970-01-01/);
});

test('saved research retains explicit expiry and rejects expired or revoked sources', async () => {
  const expiry = new Date('2026-11-27T12:00:00.000Z');
  const valid = await reportFor({ rightsExpiresAt: expiry });
  assert.equal(valid.sourceCoverage.pages[0].rightsExpiresAt, expiry.toISOString());
  const expired = await reportFor({ rightsExpiresAt: now, expired: true });
  assert.equal(expired.sourceCoverage.pages[0].status, 'rights_expired');
  const revoked = await reportFor({ revokedAt: now });
  assert.equal(revoked.sourceCoverage.pages[0].status, 'rights_revoked');
});

test('missing or invalid capture times stay unknown and cannot become usable evidence', async () => {
  for (const capturedAt of [null, '', 'invalid-date']) {
    const report = await reportFor({ capturedAt });
    assert.equal(report.sourceCoverage.pages[0].capturedAt, null);
    assert.equal(report.sourceCoverage.pages[0].status, 'stale');
  }
});
