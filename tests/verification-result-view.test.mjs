import { test } from 'node:test';
import assert from 'node:assert/strict';

test('saved SQLite integer flags remain visible and inconclusive checks explain their meaning', () => {
  const row = renderVerificationResultRow({ id: 1, email: 'sales@example.test', verified_at: '2026-10-19T08:00:00Z', is_role_account: 1, is_free_provider: 1, is_catch_all: 1, is_disposable: 1 });
  for (const flag of ['Role', 'Free', 'Catch-all', 'Disposable']) assert.match(row, new RegExp(`>${flag}<`));
  const unknown = renderQuickVerificationResult({ email: 'owner@example.test', verification_status: 'unknown', evidence: { mail_route: 'present', smtp_status: 'unavailable', mailbox_status: 'unconfirmed' } });
  assert.match(unknown, /This address has not been rejected/);
  assert.match(unknown, /Mailbox: unconfirmed/);
  assert.match(unknown, /does not prove inbox delivery/);
});
import { renderQuickVerificationError, renderQuickVerificationResult, renderVerificationResultRow, renderVerificationEvidenceSummary } from '../js/verification-result-view.js';

test('sparse verifier responses show unknown evidence without guessed scores, providers, or SMTP causes', () => {
  const html = renderQuickVerificationResult({ email: 'person@example.test', verification_status: 'risky', checks: { smtp: null } });
  assert.match(html, /Verifier score:<\/strong> Not scored/);
  assert.match(html, /no evidence/i);
  assert.match(html, /No classifications returned/);
  assert.doesNotMatch(html, /95|0\.95x|Google|Custom Mail Server|Port 25 Socket Blocked|Mailbox Does Not Exist/);
  assert.match(html, /SMTP recipient response/);
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
  assert.match(html, /SMTP recipient response:.*Recipient accepted.*not mailbox confirmation/s);
  assert.match(html, /Role account:<\/strong> Yes/);
  assert.match(html, /Free provider:<\/strong> No/);
  assert.match(html, /Verifier score:<\/strong> 95\/100/);
  assert.match(html, /not a calibrated probability/);
  assert.match(html, /mx\.example\.test/);
  assert.doesNotMatch(html, /0\.95x|Google/);
});

test('unconfirmed Gmail renders as unknown while retaining its provider classification', () => {
  const html = renderQuickVerificationResult({
    email: 'person@gmail.com', verification_status: 'unknown',
    general: { domain: 'gmail.com', reason: 'Google mail route · mailbox unconfirmed' },
    attributes: { free: true, role: false, disposable: false },
    checks: { regex: true, mx: true, disposable: true, smtp: null },
  });
  assert.match(html, /UNKNOWN/);
  assert.match(html, /Verifier score:<\/strong> Not scored/);
  assert.match(html, /Free provider:<\/strong> Yes/);
  assert.match(html, /Role account:<\/strong> No/);
  assert.match(html, /Google mail route · mailbox unconfirmed/);
  assert.doesNotMatch(html, /Flagged|Not flagged|Port 25 Blocked/);
});

test('legacy free-provider Risky labels are shown as Unknown when saved evidence proves only a mail route', () => {
  const oldGmailResult = {
    email: 'goutamdhanani@gmail.com',
    verification_status: 'risky',
    engine: 'local_dns',
    general: { domain: 'gmail.com', reason: 'Google mail route · mailbox unconfirmed' },
    attributes: { free: true, role: false, disposable: false, accept_all: null, mailbox_full: null },
    is_free_provider: true,
    is_role_account: false,
    is_disposable: false,
    is_catch_all: null,
    checks: { regex: true, mx: true, disposable: true, smtp: null },
    verification_evidence: {
      syntax_status: 'valid',
      dns_status: 'mail_route_present',
      provider: 'Google',
      smtp_status: 'not_attempted',
      mailbox_status: 'unconfirmed',
      disposable_status: 'not_in_checked_list',
      disposable_evidence_source: 'local_known_domain_list',
      role_account: false,
      disposable: false,
      verifier_engine: 'local_dns',
      provider_verdict: null,
    },
  };
  const html = renderQuickVerificationResult(oldGmailResult);
  assert.match(html, /INBOX UNCONFIRMED/);
  assert.match(html, /Verification status: unknown/);
  assert.match(html, /This does not mean the address is invalid/);
  assert.match(html, /Quick Verify does not save this result to a contact/);
  assert.doesNotMatch(html, /Saved evidence/);
  assert.match(html, /could not confirm this exact inbox/i);
  assert.match(html, /not marked risky just because it uses a free email provider/i);
  assert.doesNotMatch(html, />RISKY</);

  const row = renderVerificationResultRow({
    id: 81,
    email: oldGmailResult.email,
    verification_status: 'risky',
    is_free_provider: 1,
    is_role_account: 0,
    is_disposable: 0,
    is_catch_all: 0,
    verification_json: JSON.stringify(oldGmailResult),
  });
  assert.match(row, /\? unknown/);
  assert.match(row, /Inbox not confirmed by this check/);

  const explicitRisk = renderQuickVerificationResult({
    ...oldGmailResult,
    verification_evidence: { ...oldGmailResult.verification_evidence, provider_verdict: 'risky' },
  });
  assert.match(explicitRisk, />RISKY</);

  const incompleteLegacyEvidence = renderQuickVerificationResult({
    ...oldGmailResult,
    verification_evidence: {
      ...oldGmailResult.verification_evidence,
      disposable_evidence_source: undefined,
    },
  });
  assert.match(incompleteLegacyEvidence, />RISKY</,
    'a schema-less record without the complete known-list evidence must not be adjusted');

  const nonLocalLegacyEvidence = renderQuickVerificationResult({
    ...oldGmailResult,
    engine: 'reacher_api',
    verification_evidence: {
      ...oldGmailResult.verification_evidence,
      verifier_engine: 'reacher_api',
    },
  });
  assert.match(nonLocalLegacyEvidence, />RISKY</,
    'the legacy correction applies only to evidence from the local DNS engine');
});

test('legacy Port 25 Blocked copy is suppressed unless an unavailable connection was actually recorded', () => {
  const withoutConnectionEvidence = renderQuickVerificationResult({
    email: 'person@gmail.com', verification_status: 'unknown',
    general: { reason: 'Unconfirmed Mailbox (Port 25 Blocked)' },
    checks: { smtp: null },
  });
  assert.match(withoutConnectionEvidence, /Mailbox Not Confirmed/);
  assert.doesNotMatch(withoutConnectionEvidence, /Port 25 Blocked/);

  const withConnectionEvidence = renderQuickVerificationResult({
    email: 'person@gmail.com', verification_status: 'unknown',
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

test('saved evidence view separates DNS, SMTP recipient response, suppression and mailbox confirmation', () => {
  const html = renderQuickVerificationResult({
    email: 'person@example.test', verification_status: 'unknown', engine: 'local_dns',
    verification_evidence: {
      dns_status: 'mail_route_present', mailbox_status: 'unconfirmed', provider: 'Other',
      smtp_status: 'rcpt_accepted', checked_at: '2026-10-12T00:00:00.000Z',
      diagnostic_reason: 'smtp_rcpt_accepted_not_mailbox_proof',
      disposable_evidence_source: 'local_known_domain_list_and_disify_domain',
      disposable_external_status: 'checked',
    },
    checks: { regex: true, mx: true, smtp: true },
  });
  assert.match(html, /DNS route:<\/strong> mail_route_present/);
  assert.match(html, /Mailbox status:<\/strong> unconfirmed/);
  assert.match(html, /External disposable check:<\/strong> Checked by Disify \(domain only\)/);
  assert.match(html, /SMTP recipient response:.*not mailbox confirmation/s);
  assert.match(html, /do not confirm a mailbox/i);

  const summary = renderVerificationEvidenceSummary({ counts: {
    sourceBacked: 100, mailRoutePresent: 98, mailboxConfirmed: 0, mailboxUnconfirmed: 94,
    mailboxUnknown: 6, suppressed: 3, smtpRecipientAccepted: 7,
  } });
  assert.match(summary, /Source-backed email records/);
  assert.match(summary, /<strong>0<\/strong>/);
  assert.match(summary, /Mailbox status unknown<\/span><strong>6<\/strong>/);
  assert.match(summary, /counts cover saved contact emails only/);
  assert.match(summary, /Quick Verify does not save its result/);
});

test('mail-route-only evidence changes the explanation, not the unknown status or mailbox claim', () => {
  const html = renderQuickVerificationResult({
    email: 'owner@example.test', verification_status: 'unknown',
    verification_evidence: { dns_status: 'mail_route_present', mailbox_status: 'unconfirmed' },
  });
  assert.match(html, /INBOX UNCONFIRMED/);
  assert.match(html, /Verification status: unknown/);
  assert.doesNotMatch(html, /badge-deliverable|mailbox confirmed/i);

  const noRoute = renderQuickVerificationResult({
    email: 'owner@example.test', verification_status: 'unknown',
    verification_evidence: { dns_status: 'temporary_failure', mailbox_status: 'unknown' },
  });
  assert.match(noRoute, />UNKNOWN<\/span>/);
  assert.doesNotMatch(noRoute, /INBOX UNCONFIRMED/);
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
