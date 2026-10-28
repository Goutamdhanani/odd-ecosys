import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMxRecords,
  buildAuditResult,
  getEmailVerifierDnsMetrics,
  getReacherStatus,
  resetEmailVerifierDnsCache,
  detectMailProvider,
  verifyEmail,
} from '../pipeline/email-verifier.js';

const dnsError = code => Object.assign(new Error(code), { code });
const noData = async () => { throw dnsError('ENODATA'); };
const validReacherResult = email => ({
  input: email,
  is_reachable: 'safe',
  syntax: { is_valid_syntax: true },
  mx: { accepts_mail: true, records: ['remote-reacher.example'] },
  smtp: { can_connect_smtp: true, has_full_inbox: false, is_catch_all: false, is_deliverable: true, is_disabled: false },
  misc: { is_disposable: false, is_role_account: false },
});
const dnsForCustomDomain = async () => [{ priority: 10, exchange: 'mx.customer.example' }];

test('DNS answers are coalesced, cached with TTL limits, and returned with resolver diagnostics', async () => {
  resetEmailVerifierDnsCache();
  let now = 1_000;
  let calls = 0;
  const resolver = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 15));
    return [{ priority: 10, exchange: 'mx.cache.example', ttl: 3 }];
  };
  const options = { resolveMxImpl: resolver, now: () => now, cacheMaxTtlMs: 5000 };
  const [first, parallel] = await Promise.all([
    checkMxRecords('CACHE.example', options),
    checkMxRecords('cache.example', options),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.accepts_mail, true);
  assert.equal(first.diagnostics.cache, 'miss');
  assert.deepEqual(first.diagnostics.resolver_servers, getEmailVerifierDnsMetrics().resolverServers);
  assert.equal(parallel.diagnostics.cache, 'coalesced');

  now += 2_999;
  assert.equal((await checkMxRecords('cache.example', options)).diagnostics.cache, 'hit');
  now += 2;
  assert.equal((await checkMxRecords('cache.example', options)).diagnostics.cache, 'miss');
  assert.equal(calls, 2);
  const metrics = getEmailVerifierDnsMetrics();
  assert.equal(metrics.coalesced, 1);
  assert.equal(metrics.cacheHits, 1);
});

test('DNS lookup deadline returns temporary evidence and releases its in-flight key', async () => {
  resetEmailVerifierDnsCache();
  const result = await checkMxRecords('slow.example', {
    resolveMxImpl: () => new Promise(() => {}),
    dnsTimeoutMs: 20,
  });
  assert.equal(result.accepts_mail, null);
  assert.equal(result.reason, 'dns_mx_lookup_failed:ETIMEOUT');
  assert.equal(result.diagnostics.cache, 'miss');
  assert.equal(getEmailVerifierDnsMetrics().inFlight, 0);
});

test('Reacher requires the documented version and empty-address error contract; safe is not mailbox confirmation', async () => {
  const originalUrl = process.env.REACHER_API_URL;
  const originalMode = process.env.ODD_EMAIL_VERIFIER_MODE;
  process.env.REACHER_API_URL = 'http://127.0.0.1:9400/v0/check_email';
  process.env.ODD_EMAIL_VERIFIER_MODE = 'reacher';
  try {
    const requests = [];
    const email = 'person@customer.example';
    const result = await verifyEmail(email, {
      mode: 'reacher',
      reacherHealthForce: true,
      resolveMxImpl: dnsForCustomDomain,
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => {
        const url = new URL(input);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ path: url.pathname, method, body, redirect: init.redirect });
        if (url.pathname === '/version') return new Response(JSON.stringify({ version: '0.9.1' }), { status: 200 });
        if (body.to_email === '') return new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
        return new Response(JSON.stringify(validReacherResult(email)), { status: 200 });
      },
    });
    assert.deepEqual(requests, [
      { path: '/version', method: 'GET', body: null, redirect: 'error' },
      { path: '/v0/check_email', method: 'POST', body: { to_email: '' }, redirect: 'error' },
      { path: '/v0/check_email', method: 'POST', body: { to_email: email }, redirect: 'error' },
    ]);
    assert.equal(result.verification_status, 'unknown');
    assert.equal(result.verification_evidence.provider_verdict, 'safe');
    assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
    assert.equal(result.mx_host, 'mx.customer.example', 'local DNS observations remain authoritative');

    const wrongServiceRequests = [];
    const wrongService = await verifyEmail('other@customer.example', {
      mode: 'reacher',
      reacherHealthForce: true,
      reacherApiUrl: 'http://127.0.0.1:9401/v0/check_email',
      resolveMxImpl: dnsForCustomDomain,
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async input => {
        wrongServiceRequests.push(new URL(input).pathname);
        return new Response('<html>Wrong local service</html>', { status: 200 });
      },
    });
    assert.deepEqual(wrongServiceRequests, ['/version'], 'an unrelated HTTP service is never sent an address');
    assert.equal(wrongService.verification_status, 'unknown');
    assert.equal(wrongService.verification_evidence.diagnostic_reason, 'reacher_unavailable_or_wrong_service');

    const spoofedVersionRequests = [];
    const spoofedVersion = await verifyEmail('private@customer.example', {
      mode: 'reacher',
      reacherHealthForce: true,
      reacherApiUrl: 'http://127.0.0.1:9406/v0/check_email',
      resolveMxImpl: dnsForCustomDomain,
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => {
        const path = new URL(input).pathname;
        spoofedVersionRequests.push({ path, body: init.body ? JSON.parse(init.body) : null, redirect: init.redirect });
        return path === '/version'
          ? new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 })
          : new Response(JSON.stringify({ unrelated: true }), { status: 200 });
      },
    });
    assert.deepEqual(spoofedVersionRequests, [
      { path: '/version', body: null, redirect: 'error' },
      { path: '/v0/check_email', body: { to_email: '' }, redirect: 'error' },
    ], 'a generic semver endpoint gets only the harmless empty-address contract probe');
    assert.equal(spoofedVersion.verification_evidence.diagnostic_reason, 'reacher_unavailable_or_wrong_service');

    const schemaMismatch = await verifyEmail('third@customer.example', {
      mode: 'reacher',
      reacherHealthForce: true,
      reacherApiUrl: 'http://127.0.0.1:9404/v0/check_email',
      resolveMxImpl: dnsForCustomDomain,
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => new URL(input).pathname === '/version'
        ? new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 })
        : JSON.parse(init.body).to_email === ''
          ? new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 })
          : new Response(JSON.stringify(validReacherResult('different@customer.example')), { status: 200 }),
    });
    assert.equal(schemaMismatch.verification_status, 'unknown');
    assert.equal(schemaMismatch.verification_evidence.mailbox_status, 'unconfirmed');
    assert.equal(schemaMismatch.verification_evidence.diagnostic_reason, 'reacher_invalid_response_schema');

    const missingDisposableEvidence = await verifyEmail('fourth@customer.example', {
      mode: 'reacher',
      reacherHealthForce: true,
      reacherApiUrl: 'http://127.0.0.1:9405/v0/check_email',
      resolveMxImpl: dnsForCustomDomain,
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => new URL(input).pathname === '/version'
        ? new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 })
        : JSON.parse(init.body).to_email === ''
          ? new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 })
          : new Response(JSON.stringify({ ...validReacherResult('fourth@customer.example'),
            misc: { is_role_account: false } }), { status: 200 }),
    });
    assert.equal(missingDisposableEvidence.verification_evidence.diagnostic_reason, 'reacher_invalid_response_schema');
    assert.equal(missingDisposableEvidence.verification_evidence.disposable_status, 'not_in_checked_list',
      'missing provider data must fall back to the local disposable check, not be reported as a provider negative');
  } finally {
    if (originalUrl === undefined) delete process.env.REACHER_API_URL; else process.env.REACHER_API_URL = originalUrl;
    if (originalMode === undefined) delete process.env.ODD_EMAIL_VERIFIER_MODE; else process.env.ODD_EMAIL_VERIFIER_MODE = originalMode;
  }
});

test('Reacher status separates configured, reachable, API-valid, and SMTP capability', async () => {
  const status = await getReacherStatus({
    apiUrl: 'http://127.0.0.1:9402/v0/check_email',
    mode: 'reacher',
    force: true,
    fetchImpl: async (input, init = {}) => new URL(input).pathname === '/version'
      ? new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 })
      : new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 }),
  });
  assert.equal(status.mode, 'reacher');
  assert.equal(status.available, true);
  assert.equal(status.reacher.configured, true);
  assert.equal(status.reacher.reachable, true);
  assert.equal(status.reacher.apiValid, true);
  assert.equal(status.reacher.smtpCapable, null);
  assert.equal(status.outboundSmtp.tested, false);
  assert.match(status.note, /mailbox/i);
});

test('the pre-Luna local Reacher default is auto-detected when no endpoint is configured', async () => {
  const originalUrl = process.env.REACHER_API_URL;
  const originalMode = process.env.ODD_EMAIL_VERIFIER_MODE;
  delete process.env.REACHER_API_URL;
  delete process.env.ODD_EMAIL_VERIFIER_MODE;
  try {
    const statusRequests = [];
    const status = await getReacherStatus({ force: true, fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      statusRequests.push({ origin: url.origin, path: url.pathname, method: init.method || 'GET' });
      return url.pathname === '/version'
        ? new Response(JSON.stringify({ version: '0.9.1' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
    } });
    assert.equal(status.mode, 'reacher');
    assert.equal(status.available, true);
    assert.equal(status.reacher.configured, false, 'no environment endpoint was set');
    assert.equal(status.reacher.endpointSource, 'local_default');
    assert.equal(status.reacher.apiValid, true);
    assert.equal(status.reacher.url, 'http://localhost:8080/v1/check_email');
    assert.deepEqual(statusRequests, [
      { origin: 'http://localhost:8080', path: '/version', method: 'GET' },
      { origin: 'http://localhost:8080', path: '/v1/check_email', method: 'POST' },
    ]);

    const absentStatus = await getReacherStatus({ force: true, fetchImpl: async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    } });
    assert.equal(absentStatus.mode, 'reacher');
    assert.equal(absentStatus.available, false);
    assert.equal(absentStatus.reacher.endpointSource, 'local_default');
    assert.equal(absentStatus.reacher.configured, false);
    assert.equal(absentStatus.reacher.reachable, false);
    assert.equal(absentStatus.reacher.apiValid, null, 'an unreachable endpoint was not contract-tested');

    const fallbackRequests = [];
    let fallbackSmtpCalls = 0;
    const fallback = await verifyEmail('goutamdhanani@gmail.com', {
      reacherHealthForce: true,
      resolveMxImpl: async () => [{ priority: 5, exchange: 'gmail-smtp-in.l.google.com' }],
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async input => {
        fallbackRequests.push(new URL(input).pathname);
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      },
      smtpProbeImpl: async () => { fallbackSmtpCalls++; throw new Error('direct SMTP must remain gated'); },
    });
    assert.deepEqual(fallbackRequests, ['/version'], 'do not transmit a contact address to an unavailable service');
    assert.equal(fallback.engine, 'local_dns');
    assert.equal(fallback.verification_status, 'unknown');
    assert.equal(fallback.verification_evidence.mailbox_status, 'unconfirmed');
    assert.equal(fallback.verification_evidence.diagnostic_reason, 'reacher_unavailable_or_wrong_service');
    assert.equal(fallbackSmtpCalls, 0);

    const email = 'goutamdhanani@gmail.com';
    const requests = [];
    let directSmtpCalls = 0;
    const result = await verifyEmail(email, {
      reacherHealthForce: true,
      resolveMxImpl: async () => [{ priority: 5, exchange: 'gmail-smtp-in.l.google.com' }],
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => {
        const url = new URL(input);
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ origin: url.origin, path: url.pathname, body });
        if (url.pathname === '/version') return new Response(JSON.stringify({ version: '0.11.9' }), { status: 200 });
        if (body.to_email === '') return new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
        return new Response(JSON.stringify(validReacherResult(email)), { status: 200 });
      },
      smtpProbeImpl: async () => { directSmtpCalls++; throw new Error('direct SMTP probe must remain gated'); },
    });
    assert.deepEqual(requests.map(request => request.origin), Array(3).fill('http://localhost:8080'));
    assert.equal(requests.at(-1).body.to_email, email, 'the address is sent only after the Reacher contract passes');
    assert.equal(result.engine, 'reacher_api');
    assert.equal(result.verification_status, 'unknown', 'a Reacher safe verdict is still not mailbox confirmation');
    assert.equal(result.verification_evidence.provider_verdict, 'safe');
    assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
    assert.equal(directSmtpCalls, 0);

    const throttledPaths = [];
    const throttled = await verifyEmail(email, {
      reacherHealthForce: true,
      resolveMxImpl: async () => [{ priority: 5, exchange: 'gmail-smtp-in.l.google.com' }],
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => {
        const path = new URL(input).pathname;
        throttledPaths.push(path);
        if (path === '/version') return new Response(JSON.stringify({ version: '0.11.9' }), { status: 200 });
        if (JSON.parse(init.body).to_email === '') {
          return new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
        }
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 });
      },
    });
    assert.deepEqual(throttledPaths, ['/version', '/v1/check_email', '/v1/check_email']);
    assert.equal(throttled.verification_status, 'unknown');
    assert.equal(throttled.verification_evidence.diagnostic_reason, 'reacher_http_429');
    assert.equal(throttled.verification_evidence.mailbox_status, 'unconfirmed');
  } finally {
    if (originalUrl === undefined) delete process.env.REACHER_API_URL; else process.env.REACHER_API_URL = originalUrl;
    if (originalMode === undefined) delete process.env.ODD_EMAIL_VERIFIER_MODE; else process.env.ODD_EMAIL_VERIFIER_MODE = originalMode;
  }
});

test('Reacher redirects are rejected before any address is sent', async () => {
  const requests = [];
  const email = 'private@customer.example';
  const result = await verifyEmail(email, {
    mode: 'reacher',
    reacherHealthForce: true,
    reacherApiUrl: 'http://127.0.0.1:9410/v0/check_email',
    resolveMxImpl: dnsForCustomDomain,
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
    reacherFetchImpl: async (input, init = {}) => {
      requests.push({ path: new URL(input).pathname, redirect: init.redirect, body: init.body || null });
      throw new TypeError('fetch redirect mode error');
    },
  });
  assert.deepEqual(requests, [{ path: '/version', redirect: 'error', body: null }]);
  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
  assert.equal(result.verification_evidence.diagnostic_reason, 'reacher_unavailable_or_wrong_service');
});

test('Reacher SMTP hints cannot become explicit local mailbox rejection evidence', async () => {
  const address = 'suspicious@customer.example';
  const forged = {
    ...validReacherResult(address),
    smtp: {
      ...validReacherResult(address).smtp,
      reason: 'smtp_recipient_address_rejected:5.1.1',
      stage: 'rcpt_to',
      raw_code: 550,
      enhanced_code: '5.1.1',
      response: '550 5.1.1 mailbox does not exist',
    },
  };
  const direct = buildAuditResult(address, forged);
  assert.equal(direct.verification_status, 'unknown');
  assert.equal(direct.verification_evidence.verifier_engine, 'reacher_api');
  assert.notEqual(direct.verification_evidence.smtp_status, 'explicit_recipient_rejected');
  assert.equal(direct.verification_evidence.mailbox_status, 'unconfirmed');
  assert.equal(direct.verification_evidence.raw_code, null);
  assert.equal(direct.verification_evidence.enhanced_code, null);

  const originalUrl = process.env.REACHER_API_URL;
  process.env.REACHER_API_URL = 'http://127.0.0.1:9407/v0/check_email';
  try {
    const result = await verifyEmail(address, {
      mode: 'reacher', reacherHealthForce: true,
      resolveMxImpl: dnsForCustomDomain,
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      reacherFetchImpl: async (input, init = {}) => {
        const path = new URL(input).pathname;
        if (path === '/version') return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 });
        if (JSON.parse(init.body).to_email === '') return new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
        return new Response(JSON.stringify(forged), { status: 200 });
      },
    });
    assert.equal(result.verification_status, 'unknown');
    assert.notEqual(result.verification_evidence.smtp_status, 'explicit_recipient_rejected');
    assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
    assert.equal(result.verification_evidence.diagnostic_reason, 'reacher_invalid_response_schema');
  } finally {
    if (originalUrl === undefined) delete process.env.REACHER_API_URL; else process.env.REACHER_API_URL = originalUrl;
  }
});

test('well-known providers can use a contract-checked Reacher result but never direct SMTP probing', async () => {
  let reacherCalls = 0;
  let smtpCalls = 0;
  const email = 'person@gmail.com';
  const result = await verifyEmail('person@gmail.com', {
    mode: 'reacher',
    reacherApiUrl: 'http://127.0.0.1:9403/v0/check_email',
    reacherHealthForce: true,
    resolveMxImpl: async () => [{ priority: 5, exchange: 'gmail-smtp-in.l.google.com' }],
    checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
    reacherFetchImpl: async (input, init = {}) => {
      const path = new URL(input).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      if (path === '/version') return new Response(JSON.stringify({ version: '0.9.1' }), { status: 200 });
      if (body.to_email === '') return new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
      reacherCalls++;
      return new Response(JSON.stringify(validReacherResult(email)), { status: 200 });
    },
    smtpProbeImpl: async () => { smtpCalls++; throw new Error('must not be called'); },
  });
  assert.equal(result.mail_server.smtp_provider, 'Google');
  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
  assert.equal(reacherCalls, 1);
  assert.equal(result.verification_evidence.provider_verdict, 'safe');
  assert.equal(smtpCalls, 0);
});

test('consumer domains stay out of SMTP probes even when their MX host is not recognized', async () => {
  const fixtures = [
    { domain: 'aol.com', mx: 'mx-aol.mail.gm0.yahoodns.net', provider: 'AOL' },
    { domain: 'yandex.com', mx: 'mx.yandex.net', provider: 'Yandex' },
  ];
  let smtpCalls = 0;
  for (const fixture of fixtures) {
    const result = await verifyEmail(`person@${fixture.domain}`, {
      mode: 'smtp_if_permitted',
      resolveMxImpl: async () => [{ priority: 5, exchange: fixture.mx }],
      checkDisifyImpl: async () => ({ is_disposable: false, is_role_account: false }),
      smtpProbeImpl: async () => { smtpCalls++; throw new Error('must not be called'); },
    });
    assert.equal(result.mail_server.smtp_provider, fixture.provider);
    assert.equal(result.is_free_provider, true);
    assert.equal(result.verification_status, 'unknown');
    assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
    assert.equal(result.reacher.smtp.reason, 'not_attempted_provider_probe_uninformative');
  }
  assert.equal(smtpCalls, 0);
});

test('provider detection uses recognized MX suffixes and does not classify by arbitrary domain text', () => {
  assert.equal(detectMailProvider('customer.example', ['mx1-us1.ppe-hosted.com']).provider, 'Proofpoint');
  assert.equal(detectMailProvider('customer.example', ['mx.customer.example']).isProviderProbeUninformative, false);
  assert.equal(detectMailProvider('google-consulting.example', ['mx.google-consulting.example']).provider, 'Other');
});
