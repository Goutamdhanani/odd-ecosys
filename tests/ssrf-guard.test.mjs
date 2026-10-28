import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createSafeFetcher, isPublicAddress, validateUrl } from '../pipeline/ssrf-guard.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(`http://shop.example.test:${port}`, server);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

const fixtureResolver = async hostname => {
  if (hostname === 'shop.example.test' || hostname === 'other.example.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'metadata.example.test') return [{ address: '169.254.169.254', family: 4 }];
  throw new Error('synthetic DNS lookup failure');
};

const fixtureAddressPolicy = address => address === '127.0.0.1' || isPublicAddress(address);

test('public address policy rejects private, special, mapped and documentation networks', () => {
  for (const address of [
    '0.1.2.3', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.168.1.1', '192.175.48.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.5', '224.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', 'fc00::1', 'fe80::1', '2001:db8::1',
    '2001::1', '2002::1', '3fff::1', 'ff02::1',
  ]) assert.equal(isPublicAddress(address), false, `${address} must be denied`);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, `${address} must be allowed`);
  }
});

test('URL validation fails closed for protocols, credentials, local names, DNS errors and mixed A/AAAA answers', async () => {
  const acceptsPublicFixture = address => isPublicAddress(address);
  for (const input of ['file:///etc/passwd', 'ftp://example.com', 'http://user:pass@example.com', 'http://localhost/', 'http://printer/']) {
    assert.equal((await validateUrl(input)).safe, false, input);
  }
  assert.equal((await validateUrl('https://shop.example.test', { resolver: async () => { throw new Error('NXDOMAIN'); } })).safe, false);
  assert.equal((await validateUrl('https://shop.example.test', { resolver: async () => [], addressPolicy: acceptsPublicFixture })).safe, false);
  const mixed = await validateUrl('https://shop.example.test', {
    resolver: async () => [{ address: '1.1.1.1', family: 4 }, { address: 'fd00::1', family: 6 }],
  });
  assert.equal(mixed.safe, false);
  assert.match(mixed.reason, /non-public/);
});

test('safe fetch pins a synthetic hostname to the validated local fixture and returns a fetch-like response', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`host=${req.headers.host};path=${req.url};remote=${req.socket.remoteAddress}`);
  }, async baseUrl => {
    const safeFetch = createSafeFetcher({ resolver: fixtureResolver, addressPolicy: fixtureAddressPolicy });
    const response = await safeFetch(`${baseUrl}/hello?x=1`, { headers: { 'user-agent': 'fixture' } });
    assert.equal(response.status, 200);
    assert.equal(response.url, `${baseUrl}/hello?x=1`);
    assert.equal(await response.text(), `host=${new URL(baseUrl).host};path=/hello?x=1;remote=127.0.0.1`);
  });
});

test('opt-in local fetch reaches only literal IPv4 or IPv6 loopback and leaves default policy unchanged', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`local=${req.socket.localAddress};path=${req.url}`);
  }, async (_fixtureUrl, server) => {
    const port = server.address().port;
    const localFetch = createSafeFetcher({ allowLoopback: true });
    const response = await localFetch(`http://127.0.0.1:${port}/health`, { redirect: 'error' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /path=\/health/);
    await assert.rejects(createSafeFetcher()(`http://127.0.0.1:${port}/health`), /non-public address/);
    await assert.rejects(localFetch(`http://127.0.0.2:${port}/health`), /non-public address/);
    await assert.rejects(localFetch(`http://localhost:${port}/health`), /local hostnames/);
    await assert.rejects(localFetch(`http://metadata.example.test:${port}/health`), /could not be resolved/);
  });
});

test('each redirect target is re-resolved and private redirect destinations are blocked before connecting', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests += 1;
    res.writeHead(302, { location: 'http://metadata.example.test/latest/meta-data/' });
    res.end();
  }, async baseUrl => {
    const safeFetch = createSafeFetcher({ resolver: fixtureResolver, addressPolicy: fixtureAddressPolicy });
    await assert.rejects(safeFetch(baseUrl), /non-public address/);
    assert.equal(requests, 1, 'the unsafe redirect host must never receive a connection');
  });
});

test('safe redirects are validated and cross-origin credentials are stripped', async () => {
  const seenAuthorization = [];
  await withServer((req, res) => {
    if (req.url === '/start') {
      const port = req.headers.host.split(':').at(-1);
      res.writeHead(302, { location: `http://other.example.test:${port}/done` });
      res.end();
      return;
    }
    seenAuthorization.push(req.headers.authorization || null);
    res.end('complete');
  }, async baseUrl => {
    const safeFetch = createSafeFetcher({ resolver: fixtureResolver, addressPolicy: fixtureAddressPolicy });
    const response = await safeFetch(`${baseUrl}/start`, { headers: { authorization: 'secret-fixture' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'complete');
    assert.deepEqual(seenAuthorization, [null]);
  });
});

test('safe fetch enforces timeout, streaming byte cap and supported methods', async () => {
  await withServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 400);
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('1234');
      setTimeout(() => res.end('5678'), 20);
      return;
    }
    if (req.url === '/oversized') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2048' });
      res.end('x'.repeat(2048));
      return;
    }
    if (req.url === '/head') {
      res.writeHead(200, { 'content-length': '100000' });
      res.end();
      return;
    }
    if (req.url === '/not-modified') {
      res.writeHead(304);
      res.end();
      return;
    }
    res.end('ok');
  }, async baseUrl => {
    const safeFetch = createSafeFetcher({ resolver: fixtureResolver, addressPolicy: fixtureAddressPolicy });
    await assert.rejects(safeFetch(`${baseUrl}/slow`, { timeoutMs: 150 }), /timed out/);
    await assert.rejects(safeFetch(`${baseUrl}/stream`, { maxBytes: 5 }), /byte limit/);
    await assert.rejects(safeFetch(`${baseUrl}/oversized`, { maxBytes: 1024, timeoutMs: 500 }), /byte limit/);
    assert.equal((await safeFetch(`${baseUrl}/head`, { method: 'HEAD', maxBytes: 1 })).status, 200);
    assert.equal((await safeFetch(`${baseUrl}/not-modified`)).status, 304);
    await assert.rejects(safeFetch(baseUrl, { method: 'POST' }), /only permits GET and HEAD/);
  });
});

test('DNS resolution is included in the request deadline and respects cancellation', async () => {
  const safeFetch = createSafeFetcher({ resolver: () => new Promise(() => {}) });
  await assert.rejects(safeFetch('https://shop.example.test', { timeoutMs: 120 }), /timed out/);
  const controller = new AbortController();
  const pending = safeFetch('https://shop.example.test', { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('host concurrency and rolling request budgets reject excess work and recover after completion', async () => {
  let releaseSlow;
  let slowStarted;
  const slowStartedPromise = new Promise(resolve => { slowStarted = resolve; });
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  await withServer(async (req, res) => {
    if (req.url === '/hold') {
      slowStarted();
      await slowGate;
    }
    res.end('ok');
  }, async baseUrl => {
    const safeFetch = createSafeFetcher({ resolver: fixtureResolver, addressPolicy: fixtureAddressPolicy, maxConcurrency: 1, maxRequests: 3 });
    const first = safeFetch(`${baseUrl}/hold`);
    await slowStartedPromise;
    const otherPort = Number(new URL(baseUrl).port) + 1;
    await assert.rejects(safeFetch(`http://shop.example.test:${otherPort}/busy`), /concurrency limit/);
    releaseSlow();
    assert.equal((await first).status, 200);
    assert.equal((await safeFetch(`${baseUrl}/ok`)).status, 200);
    assert.equal((await safeFetch(`${baseUrl}/ok2`)).status, 200);
    await assert.rejects(safeFetch(`${baseUrl}/over`), /request budget exceeded/);
  });
});

test('redirect mode, redirect count and redirect loops fail safely', async () => {
  await withServer((req, res) => {
    if (req.url === '/large-start') {
      res.writeHead(302, { location: '/large-target', 'content-length': '4' });
      res.end('1234');
      return;
    }
    if (req.url === '/large-target') {
      res.writeHead(200, { 'content-length': '4' });
      res.end('5678');
      return;
    }
    res.writeHead(302, { location: `${req.url === '/a' ? '/b' : '/a'}` });
    res.end();
  }, async baseUrl => {
    const safeFetch = createSafeFetcher({ resolver: fixtureResolver, addressPolicy: fixtureAddressPolicy });
    const manual = await safeFetch(`${baseUrl}/a`, { redirect: 'manual' });
    assert.equal(manual.status, 302);
    await assert.rejects(safeFetch(`${baseUrl}/a`, { redirect: 'error' }), /redirect rejected/);
    await assert.rejects(safeFetch(`${baseUrl}/a`, { maxRedirects: 1 }), /redirect limit/);
    await assert.rejects(safeFetch(`${baseUrl}/large-start`, { maxBytes: 6 }), /redirect chain exceeds byte limit/);
  });
});
