import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGateway, classifyFailure, nextReset, validateKey, validateChat } from '../tools/freeinference/gateway.mjs';

test('gateway rejects masked keys and wrong models; reset is UTC midnight', () => {
  assert.equal(validateKey('hyi-SkCZ4Z6p*********************'), false);
  assert.equal(validateKey(''), false);
  assert.equal(validateKey('fixture-not-a-real-credential-123456789'), true);
  assert.throws(() => validateChat({ model: 'glm-5.3', messages: [{}] }, 'glm-5.3-flash'));
  assert.equal(validateChat({ model: 'glm-5.3-flash', messages: [{}], max_tokens: 131000 }, 'glm-5.3-flash').max_tokens, 8192);
  assert.equal(nextReset(new Date('2026-10-06T22:30:00Z')), '2026-10-07T00:00:00.000Z');
  assert.equal(classifyFailure(403, 'concurrent request limit'), 'concurrency');
  assert.equal(classifyFailure(403, 'daily quota exhausted'), 'quota');
  assert.equal(classifyFailure(401), 'credentials');
});
test('gateway serializes actual HTTP requests and never forwards local token as provider credential', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-gateway-'));
  const keyPath = path.join(directory, 'fixture.key');
  const key = 'fixture-not-a-real-credential-123456789', token = 'local-fixture-token-1234567890123456';
  fs.writeFileSync(keyPath, key);
  let active = 0, peak = 0, calls = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    active++; peak = Math.max(active, peak); calls++;
    for await (const chunk of req) {}
    await new Promise(resolve => setTimeout(resolve, 30));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }] })); active--;
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startGateway({ keyPath, token, stateDir: directory, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, port: 0 });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/v1/unknown`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    const requests = await Promise.all(Array.from({ length: 3 }, () => fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })));
    await Promise.all(requests.map(res => res.json()));
    assert.equal(peak, 1);
    assert.equal(calls, 3);
    fs.writeFileSync(keyPath, 'masked**********');
    const failure = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(failure.status, 503);
    assert.equal(calls, 3);
  } finally {
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider quota is the daily stop when the optional local estimate cap is disabled', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-gateway-quota-'));
  const keyPath = path.join(directory, 'fixture.key');
  fs.writeFileSync(keyPath, 'fixture-not-a-real-credential-123456789');
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {}
    calls++;
    if (calls === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fixture-completion', choices: [{ message: { content: 'fixture' } }] }));
      return;
    }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'daily quota exhausted' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startGateway({ keyPath, token: 'local-fixture-token-1234567890123456', stateDir: directory, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, port: 0, dailyLimit: null });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const request = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer local-fixture-token-1234567890123456', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'fixture' }], max_tokens: 8 }),
  });
  try {
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 403);
    const stopped = await request();
    assert.equal(stopped.status, 429);
    assert.equal(calls, 2, 'the gateway must stop forwarding after the provider rejects daily quota');
    const health = await (await fetch(`${base}/health`, { headers: { Authorization: 'Bearer local-fixture-token-1234567890123456' } })).json();
    assert.equal(health.blockedUntil, nextReset());
    assert.equal(health.requests, 2);
    assert.ok(health.reservedDollars > 0, 'estimated request cost remains observable without acting as a second quota');
  } finally {
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
