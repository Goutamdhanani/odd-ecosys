import test from 'node:test';
import assert from 'node:assert/strict';
import { countryClaimToIsoCode } from '../pipeline/astra-country-code.js';

test('canonicalizes only exact supported country names, aliases, and codes', () => {
  for (const [raw, expected] of [
    ['India', 'IN'], [' india ', 'IN'], ['IN', 'IN'], ['in', 'IN'],
    ['JP', 'JP'], ['SG', 'SG'], ['BR', 'BR'],
    ['United States', 'US'], ['USA', 'US'], ['us', 'US'],
    ['Canada', 'CA'], ['United Kingdom', 'GB'], ['UK', 'GB'],
    ['Australia', 'AU'], ['Germany', 'DE'], ['France', 'FR'],
  ]) assert.equal(countryClaimToIsoCode(raw), expected, raw);
});

test('unknown and containing text do not produce a country code', () => {
  for (const raw of ['India in Asia', 'West Indies', 'Not India', 'Indian', 'Unknownland', 'ZZ', 'India JP', '', '   ', null, 7]) {
    assert.equal(countryClaimToIsoCode(raw), null, String(raw));
  }
});

test('canonicalization leaves the raw claim provenance object unchanged', () => {
  const claim = Object.freeze({
    value: 'India', claimId: 'claim-1', predicate: 'country', subjectKey: 'example.test',
    proof: Object.freeze({ evidenceId: 'evidence-1', contentSha256: 'a'.repeat(64), exactExcerpt: 'We are based in India.' }),
  });
  const originalValue = claim.value;
  const originalProof = claim.proof;
  assert.equal(countryClaimToIsoCode(claim.value), 'IN');
  assert.equal(claim.value, originalValue);
  assert.equal(claim.proof, originalProof);
  assert.deepEqual(claim, {
    value: 'India', claimId: 'claim-1', predicate: 'country', subjectKey: 'example.test',
    proof: { evidenceId: 'evidence-1', contentSha256: 'a'.repeat(64), exactExcerpt: 'We are based in India.' },
  });
});
