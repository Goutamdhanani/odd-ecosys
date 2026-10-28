import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMxRecords, verifyEmail } from '../pipeline/email-verifier.js';

const dnsError = code => Object.assign(new Error(code), { code });
const noData = async () => { throw dnsError('ENODATA'); };

test('F026: MX lookup timeouts remain unknown and do not trigger address or SMTP probes', async () => {
  let addressLookups = 0;
  let smtpProbes = 0;
  const result = await verifyEmail('Owner@timeout.example', {
    resolveMxImpl: async () => { throw dnsError('ETIMEOUT'); },
    resolve4Impl: async () => { addressLookups++; return []; },
    resolve6Impl: async () => { addressLookups++; return []; },
    checkDisifyImpl: async () => { throw new Error('disposable lookup must not run'); },
    smtpProbeImpl: async () => { smtpProbes++; throw new Error('SMTP probe must not run'); },
  });

  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.engine, 'local_dns_gate');
  assert.equal(result.checks.regex, true);
  assert.equal(result.checks.mx, null);
  assert.equal(result.checks.smtp, null);
  assert.equal(result.verification_evidence.mailbox_status, 'unknown');
  assert.equal(result.reacher.mx.reason, 'dns_mx_lookup_failed:ETIMEOUT');
  assert.equal(result.reacher.smtp.can_connect_smtp, null);
  assert.equal(addressLookups, 0);
  assert.equal(smtpProbes, 0);
});

test('invalid syntax and a proven missing route do not count as unconfirmed mailboxes', async () => {
  const invalid = await verifyEmail('bad@@address', { mode: 'syntax_dns' });
  assert.equal(invalid.verification_status, 'undeliverable');
  assert.equal(invalid.verification_evidence.mailbox_status, 'unknown');

  const noRoute = await verifyEmail('person@missing.example', {
    mode: 'syntax_dns', resolveMxImpl: async () => { throw dnsError('ENOTFOUND'); },
  });
  assert.equal(noRoute.verification_status, 'undeliverable');
  assert.equal(noRoute.verification_evidence.mailbox_status, 'unknown');
  assert.equal(noRoute.verification_evidence.dns_status, 'nxdomain');
});

test('F026: authoritative NXDOMAIN and explicit Null MX are negative routing evidence', async () => {
  let addressLookups = 0;
  const missingDomain = await checkMxRecords('missing.example', {
    resolveMxImpl: async () => { throw dnsError('ENOTFOUND'); },
    resolve4Impl: async () => { addressLookups++; return []; },
    resolve6Impl: async () => { addressLookups++; return []; },
  });
  const nullMx = await checkMxRecords('nomail.example', {
    resolveMxImpl: async () => [{ priority: 0, exchange: '.' }],
    resolve4Impl: async () => { addressLookups++; return ['192.0.2.1']; },
    resolve6Impl: async () => { addressLookups++; return []; },
  });

  assert.equal(missingDomain.accepts_mail, false);
  assert.equal(missingDomain.reason, 'dns_domain_not_found');
  assert.equal(nullMx.accepts_mail, false);
  assert.equal(nullMx.reason, 'dns_null_mx');
  assert.equal(addressLookups, 0, 'authoritative negatives do not fall through to A/AAAA');
});

test('F026: empty MX answers use the implicit-MX A record fallback', async () => {
  let smtpTarget = null;
  let smtpAddress = null;
  const result = await verifyEmail('Owner@Example.test', {
    mode: 'smtp_if_permitted',
    resolveMxImpl: noData,
    resolve4Impl: async () => ['192.0.2.8'],
    resolve6Impl: noData,
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false, disifyData: null }),
    smtpProbeImpl: async (host, address) => {
      smtpTarget = host;
      smtpAddress = address;
      return { can_connect_smtp: false, is_deliverable: null, is_catch_all: false, reason: 'test_smtp_unavailable' };
    },
  });

  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.checks.mx, true);
  assert.equal(result.checks.smtp, null);
  assert.equal(result.mx_host, 'example.test');
  assert.equal(result.mail_server.implicit_mx_record, true);
  assert.equal(result.reacher.mx.address_record_types[0], 'A');
  assert.equal(smtpTarget, 'example.test');
  assert.equal(smtpAddress, 'Owner@example.test', 'local-part case is preserved for the SMTP probe');
});

test('F026: AAAA fallback is sufficient and no-address answers mean no route', async () => {
  const ipv6 = await checkMxRecords('v6.example', {
    resolveMxImpl: async () => [],
    resolve4Impl: noData,
    resolve6Impl: async () => ['2001:db8::7'],
  });
  const noRoute = await checkMxRecords('empty.example', {
    resolveMxImpl: noData,
    resolve4Impl: noData,
    resolve6Impl: noData,
  });

  assert.equal(ipv6.accepts_mail, true);
  assert.equal(ipv6.implicit_mx_record, true);
  assert.deepEqual(ipv6.address_record_types, ['AAAA']);
  assert.equal(noRoute.accepts_mail, false);
  assert.equal(noRoute.reason, 'dns_no_mx_or_address_records');
});

test('F026: temporary address-query failures remain unknown rather than proving no route', async () => {
  const result = await checkMxRecords('uncertain.example', {
    resolveMxImpl: noData,
    resolve4Impl: noData,
    resolve6Impl: async () => { throw dnsError('ESERVFAIL'); },
  });

  assert.equal(result.accepts_mail, null);
  assert.equal(result.implicit_mx_record, null);
  assert.equal(result.reason, 'dns_address_lookup_inconclusive:no_data,ESERVFAIL');
});
