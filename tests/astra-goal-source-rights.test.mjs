import test from 'node:test';
import assert from 'node:assert/strict';
import { createAstraGoalSourceRightsResolver } from '../pipeline/astra-goal-source-rights.js';

const actor = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const plan = { targetIndustry: 'Packaging manufacturers', country: 'IN', city: 'Ahmedabad' };
const now = Date.parse('2026-10-28T10:00:00.000Z');
const grant = { tenantId: actor.tenantId, status: 'approved', ...plan,
  rightsAttested: true, robotsAllowed: true, rightsEvidenceReference: 'Operator public-use review 17',
  robotsEvidenceReference: 'Operator robots review 17', rightsReviewedAt: '2026-10-28T09:00:00.000Z',
  rightsExpiresAt: '2026-10-28T11:00:00.000Z' };
const resolve = (grants, extra = {}) => createAstraGoalSourceRightsResolver({
  env: { ASTRA_GOAL_SOURCE_RIGHTS_JSON: JSON.stringify({ version: 1, grants, ...extra }) }, now: () => now,
});

test('only the exact tenant and reviewed plan scope receives the original current rights descriptor', async () => {
  const rights = await resolve([grant])({ actor, plan });
  assert.deepEqual(rights, { rightsAttested: true, robotsAllowed: true,
    rightsEvidenceReference: grant.rightsEvidenceReference, robotsEvidenceReference: grant.robotsEvidenceReference,
    rightsExpiresAt: grant.rightsExpiresAt });
  assert.equal(await resolve([grant])({ actor: { tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, plan }), null);
  for (const changed of [{ country: 'US' }, { city: '' }, { targetIndustry: '*' }]) {
    assert.equal(await resolve([grant])({ actor, plan: { ...plan, ...changed } }), null);
  }
});

test('expired, revoked, ambiguous, malformed and future reviews fail closed without fabricating permission', async () => {
  for (const changed of [{ status: 'revoked' }, { rightsAttested: false }, { robotsAllowed: false },
    { rightsExpiresAt: '2026-10-28T10:00:00.000Z' }, { rightsReviewedAt: '2026-10-29T00:00:00.000Z' },
    { rightsReviewedAt: '2026-02-30T09:00:00.000Z' }, { rightsEvidenceReference: '' }, { unknown: true }]) {
    assert.equal(await resolve([{ ...grant, ...changed }])({ actor, plan }), null, JSON.stringify(changed));
  }
  assert.equal(await resolve([grant, { ...grant, status: 'revoked' }])({ actor, plan }), null);
  assert.equal(await resolve([grant], { unknown: true })({ actor, plan }), null);
  assert.equal(await createAstraGoalSourceRightsResolver({ env: {} })({ actor, plan }), null);
  assert.equal(await createAstraGoalSourceRightsResolver({ env: { ASTRA_GOAL_SOURCE_RIGHTS_JSON: '{' } })({ actor, plan }), null);
});
