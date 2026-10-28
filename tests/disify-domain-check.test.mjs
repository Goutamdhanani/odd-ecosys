import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDisifyAndDisposable,
  resetDisposableDomainCache,
  verifyEmail,
} from '../pipeline/email-verifier.js';
// This suite explicitly opts into its stubbed domain-only transport. Production defaults offline.
process.env.ODD_DISIFY_DOMAIN_CHECK = 'true';

const rules = { role_account_prefixes: ['info', 'admin'] };
const dns = async () => [{ priority: 10, exchange: 'mx.company.example' }];
const response = (domain, disposable, extras = {}) => new Response(JSON.stringify({
  format: true, domain, disposable, dns: false, ...extras,
}), { status: 200 });

test('domain-only Disify signal flags a disposable contact without disclosing its full address or overriding DNS', async () => {
  resetDisposableDomainCache();
  const requests = [];
  const result = await verifyEmail('Owner@business.org', {
    mode: 'syntax_dns', resolveMxImpl: dns,
    disifyOptions: { fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method, redirect: init.redirect });
      return response('business.org', true);
    } },
    smtpProbeImpl: async () => { throw new Error('disposable gate must prevent an SMTP probe'); },
  });
  assert.deepEqual(requests, [{
    url: 'https://disify.com/api/domain/business.org', method: 'GET', redirect: 'error',
  }]);
  assert.equal(result.verification_status, 'risky');
  assert.equal(result.valid, false);
  assert.equal(result.verification_evidence.disposable_status, 'known_disposable');
  assert.equal(result.verification_evidence.disposable_evidence_source, 'disify_domain');
  assert.equal(result.verification_evidence.disposable_external_status, 'checked');
  assert.equal(result.verification_evidence.dns_status, 'mail_route_present');
  assert.equal(result.checks.smtp, null);
});

test('a clean domain verdict remains mailbox-unconfirmed and does not replace local DNS', async () => {
  resetDisposableDomainCache();
  const result = await verifyEmail('person@business.org', {
    mode: 'syntax_dns', resolveMxImpl: dns,
    disifyOptions: { fetchImpl: async () => response('business.org', false) },
  });
  assert.equal(result.verification_status, 'unknown');
  assert.equal(result.mx_host, 'mx.company.example');
  assert.equal(result.verification_evidence.mailbox_status, 'unconfirmed');
  assert.equal(result.verification_evidence.disposable_evidence_source, 'local_disposable_dataset_and_disify_domain');
  assert.equal(result.verification_evidence.disposable_external_status, 'checked');
});

test('unavailable, mismatched and malformed provider replies retain only local-list evidence', async () => {
  for (const fetchImpl of [
    async () => response('different.example', true),
    async () => new Response('{bad json', { status: 200 }),
    async () => { throw new Error('network down'); },
    async () => new Response(JSON.stringify({ format: true, domain: 'business.org' }), { status: 200 }),
    async () => new Response(JSON.stringify({ format: true, domain: 'business.org', disposable: true, padding: 'x'.repeat(20_000) }), { status: 200 }),
  ]) {
    resetDisposableDomainCache();
    const result = await checkDisifyAndDisposable('person@business.org', 'business.org', rules, { fetchImpl });
    assert.equal(result.is_disposable, false);
    assert.equal(result.disposableSource, 'local_disposable_dataset');
    assert.equal(result.disifyStatus, 'unavailable');
  }
});

test('provider rate limits pause checks for other domains without claiming a clean result', async () => {
  resetDisposableDomainCache();
  let clock = 1_000;
  let calls = 0;
  const options = {
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } })
        : response('second.org', false);
    },
  };
  const first = await checkDisifyAndDisposable('one@first.org', 'first.org', rules, options);
  assert.equal(first.disifyStatus, 'rate_limited');
  assert.equal(first.disposableSource, 'local_disposable_dataset');
  const held = await checkDisifyAndDisposable('two@second.org', 'second.org', rules, options);
  assert.equal(held.disifyStatus, 'rate_limited');
  assert.equal(calls, 1, 'a second domain must not retry during the provider cooldown');
  clock += 120_001;
  const after = await checkDisifyAndDisposable('two@second.org', 'second.org', rules, options);
  assert.equal(after.disifyStatus, 'checked');
  assert.equal(calls, 2);
});

test('network failure opens a short circuit across domains while preserving local evidence', async () => {
  resetDisposableDomainCache();
  let clock = 1_000;
  let calls = 0;
  const options = {
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error('network unavailable');
      return response('second.org', false);
    },
  };
  const failed = await checkDisifyAndDisposable('one@first.org', 'first.org', rules, options);
  const held = await checkDisifyAndDisposable('two@second.org', 'second.org', rules, options);
  assert.equal(failed.disifyStatus, 'unavailable');
  assert.equal(held.disifyStatus, 'unavailable');
  assert.equal(held.disposableSource, 'local_disposable_dataset');
  assert.equal(calls, 1);
  clock += 60_001;
  const recovered = await checkDisifyAndDisposable('two@second.org', 'second.org', rules, options);
  assert.equal(recovered.disifyStatus, 'checked');
  assert.equal(calls, 2);
});

test('local disposable matches and consumer-provider domains do not call the external service', async () => {
  resetDisposableDomainCache();
  const neverFetch = async () => { throw new Error('unexpected external request'); };
  const local = await checkDisifyAndDisposable('admin@mailinator.com', 'mailinator.com', rules, { fetchImpl: neverFetch });
  assert.equal(local.is_disposable, true);
  assert.equal(local.is_role_account, true);
  assert.equal(local.disifyStatus, 'skipped_local_match');
  const gmail = await checkDisifyAndDisposable('owner@gmail.com', 'gmail.com', rules, { fetchImpl: neverFetch });
  assert.equal(gmail.is_disposable, false);
  assert.equal(gmail.disifyStatus, 'skipped_consumer_provider');
  const synthetic = await checkDisifyAndDisposable('person@company.test', 'company.test', rules, { fetchImpl: neverFetch });
  assert.equal(synthetic.disifyStatus, 'skipped_special_use_domain');
  const unsafeDomain = await checkDisifyAndDisposable('person@business.org', 'person@business.org', rules, { fetchImpl: neverFetch });
  assert.equal(unsafeDomain.disifyStatus, 'invalid_domain', 'a caller cannot leak a full address through the domain endpoint');
  const disabled = await checkDisifyAndDisposable('person@business.org', 'business.org', rules, {
    enabled: false, fetchImpl: neverFetch,
  });
  assert.equal(disabled.disifyStatus, 'disabled');
  const previous = process.env.ODD_DISIFY_DOMAIN_CHECK;
  process.env.ODD_DISIFY_DOMAIN_CHECK = 'false';
  try {
    const envDisabled = await checkDisifyAndDisposable('person@business.org', 'business.org', rules, {
      fetchImpl: neverFetch,
    });
    assert.equal(envDisabled.disifyStatus, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.ODD_DISIFY_DOMAIN_CHECK;
    else process.env.ODD_DISIFY_DOMAIN_CHECK = previous;
  }
});

test('same-domain checks coalesce and cache a typed verdict for a bounded period', async () => {
  resetDisposableDomainCache();
  let calls = 0;
  let clock = 1_000;
  const options = {
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return response('business.org', true);
    },
  };
  const [first, second] = await Promise.all([
    checkDisifyAndDisposable('first@business.org', 'business.org', rules, options),
    checkDisifyAndDisposable('second@business.org', 'business.org', rules, options),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.is_disposable, true);
  assert.equal(second.is_disposable, true);
  await checkDisifyAndDisposable('third@business.org', 'business.org', rules, options);
  assert.equal(calls, 1);
  clock += 600_001;
  await checkDisifyAndDisposable('fourth@business.org', 'business.org', rules, options);
  assert.equal(calls, 2);
});
