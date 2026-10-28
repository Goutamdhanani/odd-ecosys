import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLocalSearxngFetcher, localSearxngEndpoint } from '../pipeline/searxng-local-transport.js';

let calls = 0;
let mode = 'json';
const sockets = new Set();
const server = http.createServer((req, res) => {
  calls++;
  if (mode === 'redirect') { res.writeHead(302, { location: '/private-target' }); return res.end(); }
  if (mode === 'oversize-header') { res.writeHead(200, { 'content-length': 1_048_577 }); return res.end(); }
  if (mode === 'oversize-chunks') { res.writeHead(200); res.end(Buffer.alloc(1_048_577)); return; }
  if (mode === 'stall') return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: [], query: new URL(req.url, 'http://fixture').searchParams.get('q') }));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/searxng`;
after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});

test('local search trust only permits an explicit literal loopback HTTP base on an unprivileged port', () => {
  assert.equal(localSearxngEndpoint(''), null);
  assert.equal(localSearxngEndpoint(`${endpoint}/`), endpoint);
  assert.equal(localSearxngEndpoint('http://[::1]:8888/'), 'http://[::1]:8888');
  for (const value of ['http://localhost:8888', 'http://127.0.0.2:8888', 'http://127.0.0.1',
    'http://127.0.0.1:80', 'http://169.254.169.254:8888', 'http://192.168.1.2:8888',
    'https://search.example.test', 'http://user:secret@127.0.0.1:8888',
    `${endpoint}?q=other`, `${endpoint}#fragment`, 'http://[::ffff:127.0.0.1]:8888']) {
    assert.throws(() => localSearxngEndpoint(value), /ODD_SEARXNG_LOCAL_BASE_URL/);
  }
});

test('the actual HTTP request is restricted to the trusted origin and exact search path', async () => {
  const fetcher = createLocalSearxngFetcher(endpoint);
  const before = calls;
  for (const target of [endpoint, `${endpoint}/private`, `${endpoint}/search/extra`,
    'http://127.0.0.1:9999/searxng/search', 'https://example.test/searxng/search']) {
    await assert.rejects(fetcher(target), /exact operator-approved search route/);
  }
  await assert.rejects(fetcher(`${endpoint}/search`, { method: 'POST' }), /exact operator-approved/);
  assert.equal(calls, before);
  const response = await fetcher(`${endpoint}/search?q=Ontario&format=json`);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { results: [], query: 'Ontario' });
  assert.equal(calls, before + 1);
});

test('redirects never make a second request or forward a bearer token', async () => {
  mode = 'redirect';
  const before = calls;
  await assert.rejects(createLocalSearxngFetcher(endpoint)(`${endpoint}/search`, {
    headers: { authorization: 'Bearer fixture-only' },
  }), /redirects are not allowed/);
  assert.equal(calls, before + 1);
});

test('both declared and streamed oversized responses are bounded', async () => {
  for (mode of ['oversize-header', 'oversize-chunks']) {
    await assert.rejects(createLocalSearxngFetcher(endpoint)(`${endpoint}/search`), /size limit/);
  }
});

test('a stalled response reaches its total deadline and releases the socket', async () => {
  mode = 'stall';
  const before = sockets.size;
  await assert.rejects(createLocalSearxngFetcher(endpoint)(`${endpoint}/search`, { timeoutMs: 40 }), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(sockets.size <= before);
});

test('local requests retain the 20-per-minute provider budget', async () => {
  mode = 'json';
  const fetcher = createLocalSearxngFetcher(endpoint);
  const before = calls;
  for (let i = 0; i < 20; i++) await fetcher(`${endpoint}/search`);
  await assert.rejects(fetcher(`${endpoint}/search`), error => error.statusCode === 429);
  assert.equal(calls, before + 20);
});
