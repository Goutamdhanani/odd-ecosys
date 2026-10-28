import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditResult, validateSyntax, verifyEmail } from '../pipeline/email-verifier.js';

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
  assert.equal(unconfirmed.verification_status, 'unknown');
  assert.equal(unconfirmed.checks.smtp, null);
  assert.equal(unconfirmed.mx_host, 'mx.example.test');
  assert.equal(unconfirmed.verification_evidence.mailbox_status, 'unconfirmed');
  assert.ok(unconfirmed.reasons.includes('mailbox_unconfirmed'));

  const confirmed = buildAuditResult(email, {
    ...observed,
    smtp: { is_deliverable: true, is_catch_all: false },
  }, {});
  assert.equal(confirmed.verification_status, 'unknown', 'a provider SMTP label is not mailbox confirmation');
  assert.equal(confirmed.checks.smtp, null);
  assert.equal(confirmed.verification_evidence.mailbox_status, 'unconfirmed');
});

test('Gmail with a valid MX route but no mailbox evidence is unknown, not risky or deliverable', () => {
  const result = buildAuditResult('operator@gmail.com', {
    syntax: { is_valid_syntax: true, username: 'operator', domain: 'gmail.com' },
    mx: { accepts_mail: true, records: [{ exchange: 'gmail-smtp-in.l.google.com' }] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: false, is_deliverable: null, is_catch_all: null, reason: 'smtp_connection_failed:ECONNREFUSED' },
  }, {});

  assert.equal(result.verification_status, 'unknown', 'provider recognition must not be mistaken for mailbox-existence proof or a risk signal');
  assert.equal(result.is_free_provider, true);
  assert.equal(result.mail_server.smtp_provider, 'Google');
  assert.equal(result.mx_host, 'gmail-smtp-in.l.google.com');
  assert.equal(result.checks.smtp, null);
  assert.equal(result.general.reason, 'Google mail route · mailbox unconfirmed');
  assert.ok(result.reasons.includes('smtp_connection_unavailable'));
});

test('a fresh syntax-and-DNS check for the signed-in Gmail address does not call it risky or confirmed', async () => {
  let smtpCalls = 0;
  const result = await verifyEmail('goutamdhanani@gmail.com', {
    mode: 'syntax_dns',
    resolveMxImpl: async () => [{ priority: 5, exchange: 'gmail-smtp-in.l.google.com' }],
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
    smtpProbeImpl: async () => { smtpCalls++; throw new Error('Gmail mailbox-enumeration SMTP must be skipped'); },
  });

  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.general.state, 'Unconfirmed');
  assert.equal(result.general.reason, 'Google mail route · mailbox unconfirmed');
  assert.equal(result.is_free_provider, true, 'provider classification is retained as descriptive metadata');
  assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
  assert.equal(result.reacher.smtp.reason, 'not_attempted_provider_probe_uninformative');
  assert.equal(smtpCalls, 0);
});

test('explicit provider and mailbox-risk signals remain risky', () => {
  const providerRisk = buildAuditResult('person@business.example', {
    is_reachable: 'risky',
    syntax: { is_valid_syntax: true, username: 'person', domain: 'business.example' },
    mx: { accepts_mail: true, records: ['mx.business.example'] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: true, is_deliverable: null, is_catch_all: false },
  });
  const catchAll = buildAuditResult('sales@business.example', {
    is_reachable: 'safe',
    syntax: { is_valid_syntax: true, username: 'sales', domain: 'business.example' },
    mx: { accepts_mail: true, records: ['mx.business.example'] },
    misc: { is_disposable: false, is_role_account: false },
    smtp: { can_connect_smtp: true, is_deliverable: null, is_catch_all: true },
  });

  assert.equal(providerRisk.verification_status, 'risky');
  assert.equal(catchAll.verification_status, 'risky');
  assert.equal(providerRisk.valid, false);
  assert.equal(catchAll.valid, false);
});

test('a known disposable domain is risky evidence, not proof that the mailbox is undeliverable', async () => {
  const providerResult = buildAuditResult('person@disposable.example', {
    is_reachable: 'safe',
    syntax: { is_valid_syntax: true, username: 'person', domain: 'disposable.example' },
    mx: { accepts_mail: true, records: ['mx.disposable.example'] },
    misc: { is_disposable: true, is_role_account: false },
    smtp: { can_connect_smtp: null, is_deliverable: null, is_catch_all: false },
  });
  assert.equal(providerResult.verification_status, 'risky');
  assert.equal(providerResult.reacher.is_reachable, 'safe', 'raw provider verdict remains separate from the audit classification');
  assert.equal(providerResult.verification_evidence.mailbox_status, 'unconfirmed');

  const localResult = await verifyEmail('person@disposable.example', {
    mode: 'syntax_dns',
    resolveMxImpl: async () => [{ priority: 10, exchange: 'mx.disposable.example' }],
    checkDisifyImpl: async () => ({ is_disposable: true, is_role_account: false }),
  });
  assert.equal(localResult.verification_status, 'risky');
  assert.equal(localResult.reacher.is_reachable, 'risky');
  assert.equal(localResult.general.state, 'Risky');
  assert.equal(localResult.is_disposable, true);
  assert.equal(localResult.checks.mx, true);
  assert.equal(localResult.checks.smtp, null);
  assert.equal(localResult.valid, false);
});

test('local SMTP verification reports its engine without treating accepted RCPT as mailbox proof', async () => {
  const result = await verifyEmail('owner@custom.example', {
    mode: 'smtp_if_permitted',
    resolveMxImpl: async () => [{ priority: 5, exchange: 'mx.custom.example' }],
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false, disifyData: null }),
    smtpProbeImpl: async () => ({ can_connect_smtp: true, is_deliverable: null,
      recipient_accepted: true, reason: 'smtp_rcpt_accepted_not_mailbox_proof' }),
  });

  assert.equal(result.engine, 'local_smtp_probe');
  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.score, null);
  assert.equal(result.is_free_provider, false);
  assert.equal(result.mail_server.smtp_provider, 'Other');
  assert.equal(result.checks.mx, true);
  assert.equal(result.checks.smtp, true);
  assert.equal(result.reacher.smtp.reason, 'smtp_rcpt_accepted_not_mailbox_proof');
  assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
  assert.ok(result.reasons.includes('smtp_rcpt_accepted_not_mailbox_proof'));
});
