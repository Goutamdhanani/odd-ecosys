import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderQuickVerificationResult, renderVerificationResultRow } from '../js/verification-result-view.js';

const evidence = (overrides = {}) => ({
  source: 'local_disposable_dataset',
  dataset_commit: '3ebb7fef055e3757dfc9bb46b1297ee2b0d11fe7',
  dataset_sha256: 'ba19d6735fc2224db58d3eaa9bb294de43437a488133c4271fb07d0ad4436fc7',
  matched_domain: null,
  checked_at: '2026-10-22T12:00:00.000Z',
  dataset_available: true,
  match: false,
  ...overrides,
});

test('legacy verification results render without a fabricated dataset classification', () => {
  const html = renderQuickVerificationResult({ email: 'person@example.test', verification_status: 'unknown' });
  assert.doesNotMatch(html, /data-classification-evidence|Offline disposable-domain evidence/);
});

test('a no-match explains the pinned snapshot scope and does not claim a clean or deliverable address', () => {
  const html = renderQuickVerificationResult({ classification_evidence: evidence() });
  assert.match(html, /No match in this pinned snapshot/);
  assert.match(html, /does not guarantee a non-disposable or deliverable address/);
  assert.match(html, /Dataset revision 3ebb7fef055e3757dfc9bb46b1297ee2b0d11fe7/);
  assert.doesNotMatch(html, /No disposable domains found|Guaranteed clean|Deliverable/);
});

test('a real match, unknown classification, and unavailable dataset remain distinguishable', () => {
  const match = renderQuickVerificationResult({ classification_evidence: evidence({ match: true, matched_domain: 'mailinator.com' }) });
  assert.match(match, /Disposable-domain match: mailinator\.com/);

  const unresolvedDomain = renderQuickVerificationResult({ classification_evidence: evidence({ match: null }) });
  assert.match(unresolvedDomain, /Classification unknown for this domain/);
  assert.doesNotMatch(unresolvedDomain, /No match in this pinned snapshot/);

  const unavailable = renderQuickVerificationResult({ classification_evidence: evidence({ dataset_available: false, match: null }) });
  assert.match(unavailable, /Classification unknown: the pinned dataset is unavailable/);
  assert.doesNotMatch(unavailable, /No match in this pinned snapshot/);
});

test('saved evidence is read from verification_json and escaped in the historical result row', () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const row = renderVerificationResultRow({
    id: 3,
    email: unsafe,
    verification_json: JSON.stringify({ classification_evidence: evidence({ match: true, matched_domain: 'mailinator.com' }) }),
  });
  assert.doesNotMatch(row, /<img src=x/);
  assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(row, /data-classification-evidence/);
  assert.match(row, /Disposable-domain match: mailinator\.com/);
});

test('legacy JSON null, arrays, primitives, and malformed text render unknown without throwing', () => {
  for (const verification_json of ['null', '[]', '"legacy"', '1', 'false', '{malformed']) {
    const row = renderVerificationResultRow({ id: 4, email: 'review@example.test', verification_json });
    assert.match(row, /class="check-dot skip"/);
    assert.doesNotMatch(row, /data-classification-evidence/);
  }
});

test('only canonical real ISO timestamps are accepted in quick and saved evidence', () => {
  const accepted = evidence({ checked_at: new Date('2026-10-22T12:00:00.000Z').toISOString() });
  assert.match(renderQuickVerificationResult({ classification_evidence: accepted }), /data-classification-evidence/);
  const savedRow = renderVerificationResultRow({
    id: 9,
    email: 'review@example.test',
    verification_json: JSON.stringify({ classification_evidence: accepted }),
  });
  assert.match(savedRow, /data-classification-evidence/);

  for (const checked_at of ['1', '0', 'October 22, 2026', '2026-02-31T00:00:00.000Z', '2026-10-22T12:00:00Z']) {
    const quick = renderQuickVerificationResult({ classification_evidence: evidence({ checked_at }) });
    const row = renderVerificationResultRow({
      id: 10,
      email: 'review@example.test',
      verification_json: JSON.stringify({ classification_evidence: evidence({ checked_at }) }),
    });
    assert.doesNotMatch(quick, /data-classification-evidence/, checked_at);
    assert.doesNotMatch(row, /data-classification-evidence/, checked_at);
  }
});

test('untrusted or internally inconsistent evidence is omitted', () => {
  const mismatchedCommit = renderQuickVerificationResult({ classification_evidence: evidence({ dataset_commit: 'arbitrary' }) });
  const falseMatch = renderQuickVerificationResult({ classification_evidence: evidence({ matched_domain: 'mailinator.com' }) });
  const unavailableHit = renderQuickVerificationResult({ classification_evidence: evidence({ dataset_available: false, match: true, matched_domain: 'mailinator.com' }) });
  for (const html of [mismatchedCommit, falseMatch, unavailableHit]) {
    assert.doesNotMatch(html, /data-classification-evidence/);
  }
});
