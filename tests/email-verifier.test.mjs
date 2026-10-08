import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditResult, validateSyntax } from '../pipeline/email-verifier.js';

test('B26: unusual but syntactically valid local parts proceed to evidence-based checks', () => {
  for (const email of [
    'alex12345@example.test',
    'bcdfghjklm@example.test',
    'aaaaa@example.test',
  ]) {
    const result = validateSyntax(email);
    assert.equal(result.is_valid_syntax, true, `${email} must not be rejected by a name heuristic`);
    assert.equal(result.username, email.split('@')[0]);
    assert.equal(result.domain, 'example.test');
    assert.equal('mx' in result, false, 'syntax analysis must not claim MX evidence');
  }
});

test('B26: malformed addresses still fail the syntax gate', () => {
  for (const email of ['missing-at.example.test', 'a@@example.test', 'a@-bad.example']) {
    assert.equal(validateSyntax(email).is_valid_syntax, false, `${email} must fail syntax validation`);
  }
});

test('B26: Reacher output stays unconfirmed without SMTP evidence and never fabricates MX data', () => {
  const email = 'alex12345@example.test';
  const observed = {
    syntax: { is_valid_syntax: true, username: 'alex12345', domain: 'example.test' },
    mx: { accepts_mail: true, records: ['mx.example.test'] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { is_deliverable: null, is_catch_all: false },
  };
  const unconfirmed = buildAuditResult(email, observed, {});
  assert.equal(unconfirmed.verification_status, 'risky');
  assert.equal(unconfirmed.checks.smtp, null);
  assert.equal(unconfirmed.mx_host, 'mx.example.test');
  assert.ok(unconfirmed.reasons.includes('smtp_unconfirmed'));

  const confirmed = buildAuditResult(email, {
    ...observed,
    smtp: { is_deliverable: true, is_catch_all: false },
  }, {});
  assert.equal(confirmed.verification_status, 'deliverable');
  assert.equal(confirmed.checks.smtp, true);
});
