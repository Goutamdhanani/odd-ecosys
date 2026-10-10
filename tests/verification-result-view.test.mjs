import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderQuickVerificationError, renderQuickVerificationResult, renderVerificationResultRow } from '../js/verification-result-view.js';

test('sparse verifier responses show unknown evidence without guessed scores, providers, or SMTP causes', () => {
  const html = renderQuickVerificationResult({ email: 'person@example.test', verification_status: 'risky', checks: { smtp: null } });
  assert.match(html, /Verifier score:<\/strong> Not scored/);
  assert.match(html, /no evidence/i);
  assert.match(html, /No classifications returned/);
  assert.doesNotMatch(html, /95|0\.95x|Google|Custom Mail Server|Port 25 Socket Blocked|Mailbox Does Not Exist/);
  assert.match(html, /SMTP mailbox response/);
});

test('reported checks and classifications display only the returned values and omit provider heuristics', () => {
  const html = renderQuickVerificationResult({
    email: 'a@example.test', verification_status: 'deliverable', engine: 'reacher_docker',
    score: 95, score_multiplier: '0.95x',
    general: { domain: 'example.test', reason: 'SMTP response accepted' },
    mail_server: { smtp_provider: 'Google', mx_record: 'mx.example.test' },
    checks: { regex: true, mx: true, disposable: null, smtp: true },
    attributes: { role: true, free: false },
  });
  assert.match(html, /Syntax:.*Passed/s);
  assert.match(html, /MX acceptance:.*Passed/s);
  assert.match(html, /SMTP mailbox response:.*Passed/s);
  assert.match(html, /Role account:<\/strong> Yes/);
  assert.match(html, /Free provider:<\/strong> No/);
  assert.match(html, /Verifier score:<\/strong> 95\/100/);
  assert.match(html, /not a calibrated probability/);
  assert.match(html, /mx\.example\.test/);
  assert.doesNotMatch(html, /0\.95x|Google/);
});

test('free Gmail provider classification reads as identification, not as a risk flag', () => {
  const html = renderQuickVerificationResult({
    email: 'person@gmail.com', verification_status: 'risky', score: 50,
    general: { domain: 'gmail.com', reason: 'SMTP Connection Unavailable' },
    attributes: { free: true, role: false, disposable: false },
    checks: { regex: true, mx: true, disposable: true, smtp: null },
  });
  assert.match(html, /Free provider:<\/strong> Yes/);
  assert.match(html, /Role account:<\/strong> No/);
  assert.match(html, /SMTP Connection Unavailable/);
  assert.doesNotMatch(html, /Flagged|Not flagged|Port 25 Blocked/);
});

test('legacy Port 25 Blocked copy is suppressed unless an unavailable connection was actually recorded', () => {
  const withoutConnectionEvidence = renderQuickVerificationResult({
    email: 'person@gmail.com', verification_status: 'risky',
    general: { reason: 'Unconfirmed Mailbox (Port 25 Blocked)' },
    checks: { smtp: null },
  });
  assert.match(withoutConnectionEvidence, /Mailbox Not Confirmed/);
  assert.doesNotMatch(withoutConnectionEvidence, /Port 25 Blocked/);

  const withConnectionEvidence = renderQuickVerificationResult({
    email: 'person@gmail.com', verification_status: 'risky',
    general: { reason: 'Unconfirmed Mailbox (Port 25 Blocked)' },
    checks: { smtp: null }, reacher: { smtp: { can_connect_smtp: false } },
  });
  assert.match(withConnectionEvidence, /SMTP Connection Unavailable/);
  assert.doesNotMatch(withConnectionEvidence, /Port 25 Blocked/);
});

test('unsupported, missing, or out-of-range scores stay visibly unscored', () => {
  for (const score of [undefined, -1, 101, Number.NaN, '95']) {
    const html = renderQuickVerificationResult({ email: 'person@example.test', verification_status: 'unknown', score });
    assert.match(html, /Verifier score:<\/strong> Not scored/);
    assert.doesNotMatch(html, /Verifier score:<\/strong> (?:-1|101|95\/100)/);
  }
  assert.match(renderVerificationResultRow({ id: 1, email: 'person@example.test', confidence_score: 93 }), /93\/100/);
  assert.match(renderVerificationResultRow({ id: 1, email: 'person@example.test', confidence_score: 101 }), /Not scored/);
});

test('verifier and contact text is escaped in result and error HTML', () => {
  const attack = '<img src=x onerror=alert(1)>';
  const quick = renderQuickVerificationResult({
    email: attack, verification_status: '</span><img src=x>',
    general: { reason: attack }, mx_host: attack, engine: attack,
  });
  assert.doesNotMatch(quick, /<img src=x/);
  assert.match(quick, /&lt;img src=x onerror=alert\(1\)&gt;/);

  const row = renderVerificationResultRow({
    id: 7, email: attack, business_name: attack, mx_host: attack,
    verification_status: '</td><img src=x>', verification_json: '{malformed',
  });
  assert.doesNotMatch(row, /<img src=x/);
  assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(renderQuickVerificationError(attack), /&lt;img src=x onerror=alert\(1\)&gt;/);
});
