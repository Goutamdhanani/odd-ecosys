import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSyntax, verifyEmail } from '../pipeline/email-verifier.js';

test('F025: IDN domains normalize to DNS A-labels while preserving local-part case', () => {
  const result = validateSyntax('  Sales.Team@BÜCHER.Example  ');

  assert.equal(result.is_valid_syntax, true);
  assert.equal(result.originalEmail, '  Sales.Team@BÜCHER.Example  ');
  assert.equal(result.username, 'Sales.Team');
  assert.equal(result.domain, 'xn--bcher-kva.example');
  assert.equal(result.asciiDomain, 'xn--bcher-kva.example');
  assert.equal(result.normalizedEmail, 'Sales.Team@xn--bcher-kva.example');
  assert.deepEqual(result.normalization, ['trimmed_outer_whitespace', 'idn_domain_to_ascii']);
  assert.equal(result.requiresSmtpUtf8, false);
  assert.equal('mx' in result, false, 'syntax validation must not claim DNS evidence');
});

test('F025: Unicode local parts are syntactically valid but require SMTPUTF8', () => {
  const result = validateSyntax('δοκιμή@παράδειγμα.δοκιμή');

  assert.equal(result.is_valid_syntax, true);
  assert.equal(result.username, 'δοκιμή');
  assert.equal(result.domain, 'xn--hxajbheg2az3al.xn--jxalpdlp');
  assert.equal(result.normalizedEmail, 'δοκιμή@xn--hxajbheg2az3al.xn--jxalpdlp');
  assert.equal(result.requiresSmtpUtf8, true);
  assert.equal(validateSyntax('A\u00a0B@example.test').is_valid_syntax, true,
    'non-ASCII UTF-8 characters follow the SMTPUTF8 syntax extension');
  assert.equal(validateSyntax('\u00a0A@example.test').normalizedEmail, '\u00a0A@example.test',
    'Unicode local-part characters are not stripped as outer input whitespace');
});

test('F025: generic syntax does not invent provider-specific mailbox constraints', () => {
  for (const email of [
    'a@gmail.com',
    'A+B@gmail.com',
    '-a@yahoo.com',
    'x@outlook.com',
    'a..b@example.test',
    '.a@example.test',
  ]) {
    assert.equal(validateSyntax(email).is_valid_syntax, !email.includes('..') && !email.startsWith('.'), email);
  }
  assert.equal(validateSyntax('"a b"@example.test').is_valid_syntax, true);
  assert.equal(validateSyntax('"unterminated@example.test').is_valid_syntax, false);
});

test('F025: SMTPUTF8 addresses stay unknown until a capable verifier is established', async () => {
  const result = await verifyEmail('δοκιμή@παράδειγμα.δοκιμή', { mode: 'syntax_dns' });

  assert.equal(result.email, 'δοκιμή@xn--hxajbheg2az3al.xn--jxalpdlp');
  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.engine, 'smtp_utf8_capability_gate');
  assert.equal(result.checks.regex, true);
  assert.equal(result.checks.mx, null);
  assert.equal(result.checks.smtp, null);
  assert.equal(result.reacher.mx.accepts_mail, null);
  assert.equal(result.reacher.smtp.is_deliverable, null);
  assert.equal(result.reacher.smtp.can_connect_smtp, null);
  assert.equal(result.is_disposable, null, 'offline no-match does not complete an unsupported verifier check');
  assert.equal(result.checks.disposable, null);
  assert.equal(result.attributes.disposable, null);
  assert.equal(result.attributes.mailbox_full, null);
  assert.equal(result.mail_server.implicit_mx_record, null);
  assert.ok(result.reasons.includes('smtp_utf8_required_probe_unsupported'));
});

test('F025: invalid syntax is not represented as negative DNS or SMTP evidence', async () => {
  const result = await verifyEmail('A@@Example.test', { mode: 'syntax_dns' });

  assert.equal(result.verification_status, 'undeliverable');
  assert.equal(result.checks.mx, null);
  assert.equal(result.checks.smtp, null);
  assert.equal(result.reacher.mx.accepts_mail, null);
  assert.equal(result.reacher.smtp.is_deliverable, null);
  assert.equal(result.reacher.smtp.can_connect_smtp, null);
  assert.equal(result.attributes.free, null);
  assert.equal(result.attributes.mailbox_full, null);
});

test('F025: local-part and full-address byte limits are enforced', () => {
  assert.equal(validateSyntax(`${'a'.repeat(64)}@example.test`).is_valid_syntax, true);
  assert.equal(validateSyntax(`${'a'.repeat(65)}@example.test`).reason, 'local_part_too_long');
  assert.equal(validateSyntax(`a@${'x'.repeat(64)}.test`).reason, 'domain_label_too_long');
});
