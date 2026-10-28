import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const transportProbe = String.raw`
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const delegated = { tcp: [], tls: [] };
net.Socket.prototype.connect = function (...args) { delegated.tcp.push(args); return this; };
tls.connect = function (...args) { delegated.tls.push(args); return { stubbed: true }; };
await import(pathToFileURL(resolve('tests/support/astra-qa-egress-guard.mjs')).href);

const result = { actualNetwork: false, blockedLiterals: [], lookups: 0 };
const literalLookup = (_hostname, _options, callback) => {
  result.lookups++;
  callback(null, '127.0.0.1', 4);
};
for (const host of ['8.8.8.8', '2001:4860:4860::8888']) {
  for (const [kind, request] of [
    ['tcp', () => new net.Socket().connect({ host, port: 443, lookup: literalLookup })],
    ['tls', () => tls.connect({ host, port: 443, lookup: literalLookup })],
  ]) {
    try { request(); }
    catch (error) { result.blockedLiterals.push({ kind, host, code: error.code }); }
  }
}

const loopbackLookup = (_hostname, _options, callback) => callback(null, '127.0.0.1', 4);
new net.Socket().connect({ host: 'synthetic.example.test', port: 80, lookup: loopbackLookup });
const tcpResult = await new Promise((resolve, reject) =>
  delegated.tcp.at(-1)[0].lookup('synthetic.example.test', {}, (error, address, family) =>
    error ? reject(error) : resolve({ address, family })));
tls.connect({ host: 'synthetic.example.test', port: 443, lookup: loopbackLookup });
const tlsResult = await new Promise((resolve, reject) =>
  delegated.tls.at(-1)[0].lookup('synthetic.example.test', {}, (error, address, family) =>
    error ? reject(error) : resolve({ address, family })));

const externalLookupResults = [];
const externalLookup = (_hostname, _options, callback) => callback(null, '203.0.113.7', 4);
new net.Socket().connect({ host: 'external.example.test', port: 80, lookup: externalLookup });
try {
  await new Promise((resolve, reject) => delegated.tcp.at(-1)[0].lookup('external.example.test', {}, error =>
    error ? reject(error) : resolve()));
} catch (error) { externalLookupResults.push({ kind: 'tcp', code: error.code }); }
tls.connect({ host: 'external.example.test', port: 443, lookup: externalLookup });
try {
  await new Promise((resolve, reject) => delegated.tls.at(-1)[0].lookup('external.example.test', {}, error =>
    error ? reject(error) : resolve()));
} catch (error) { externalLookupResults.push({ kind: 'tls', code: error.code }); }

new net.Socket().connect({ host: '127.0.0.1', port: 80 });
tls.connect({ host: '::1', port: 443 });
result.delegatedCounts = { tcp: delegated.tcp.length, tls: delegated.tls.length };
result.tcpLoopbackLookup = tcpResult;
result.tlsLoopbackLookup = tlsResult;
result.externalLookupResults = externalLookupResults;
result.finalTcpHost = delegated.tcp.at(-1)[0].host;
result.finalTlsHost = delegated.tls.at(-1)[0].host;
process.stdout.write(JSON.stringify(result));
`;

test('non-loopback literal IPs are rejected before lookup or TCP/TLS delegation', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', transportProbe], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    // The probe controls import order: transport stubs must exist before the
    // guard is imported, even when the parent suite uses the guard as a preload.
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.status, 0, `stubbed transport probe failed: ${child.stderr}`);
  const result = JSON.parse(child.stdout);

  assert.equal(result.actualNetwork, false);
  assert.deepEqual(result.blockedLiterals, [
    { kind: 'tcp', host: '8.8.8.8', code: 'EQA_EGRESS_BLOCKED' },
    { kind: 'tls', host: '8.8.8.8', code: 'EQA_EGRESS_BLOCKED' },
    { kind: 'tcp', host: '2001:4860:4860::8888', code: 'EQA_EGRESS_BLOCKED' },
    { kind: 'tls', host: '2001:4860:4860::8888', code: 'EQA_EGRESS_BLOCKED' },
  ]);
  assert.equal(result.lookups, 0, 'literal addresses must be blocked before custom lookup is called');
  assert.deepEqual(result.tcpLoopbackLookup, { address: '127.0.0.1', family: 4 });
  assert.deepEqual(result.tlsLoopbackLookup, { address: '127.0.0.1', family: 4 });
  assert.deepEqual(result.externalLookupResults, [
    { kind: 'tcp', code: 'EQA_EGRESS_BLOCKED' },
    { kind: 'tls', code: 'EQA_EGRESS_BLOCKED' },
  ]);
  assert.equal(result.finalTcpHost, '127.0.0.1');
  assert.equal(result.finalTlsHost, '::1');
  assert.deepEqual(result.delegatedCounts, { tcp: 3, tls: 3 });
});
