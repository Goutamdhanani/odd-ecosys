import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

// Replace every transport before importing the guard; a broken guard cannot reach a real network.
const delegated = { tcp: [], tls: [], lookup: [], resolve: [], udp: [], udpConnect: [], udpBind: [], http: [], listen: [] };
net.Socket.prototype.connect = function (...args) { delegated.tcp.push(args); return this; };
net.Server.prototype.listen = function (...args) { delegated.listen.push(args); return this; };
tls.connect = (...args) => { delegated.tls.push(args); return { synthetic: true }; };
dns.lookup = (host, options, callback) => {
  if (typeof options === 'function') callback = options;
  delegated.lookup.push(host);
  if (callback) callback(null, host === '::1' ? '::1' : '127.0.0.1', host === '::1' ? 6 : 4);
};
dns.promises.lookup = async host => { delegated.lookup.push(host); return { address: host, family: host === '::1' ? 6 : 4 }; };
dns.promises.resolve4 = async host => { delegated.resolve.push(host); return ['127.0.0.1']; };
for (const ResolverClass of new Set([dns.Resolver, dns.promises.Resolver])) {
  for (const name of ['resolve','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','resolve4','resolve6','reverse']) {
    if (typeof ResolverClass?.prototype?.[name] !== 'function') continue;
    ResolverClass.prototype[name] = function (host, ...args) {
      delegated.resolve.push(host);
      const callback = args.find(value => typeof value === 'function');
      if (callback) return callback(null, []);
      return Promise.resolve([]);
    };
  }
}
dns.lookupService = (address, _port, callback) => { delegated.resolve.push(address); callback(null, 'localhost', '53'); };
dns.promises.lookupService = async address => { delegated.resolve.push(address); return { hostname: 'localhost', service: '53' }; };
dgram.Socket.prototype.send = function (...args) { delegated.udp.push(args); return true; };
dgram.Socket.prototype.connect = function (...args) { delegated.udpConnect.push(args); return this; };
dgram.Socket.prototype.bind = function (...args) { delegated.udpBind.push(args); return this; };
globalThis.fetch = async input => { delegated.http.push(String(input)); return new Response('synthetic loopback'); };
syncBuiltinESMExports();
await import(new URL('./support/astra-qa-egress-guard.mjs?selfcheck=portable', import.meta.url).href);
const netExports = await import('node:net');
const tlsExports = await import('node:tls');
const dnsExports = await import('node:dns');

function blocked(call) {
  assert.throws(call, error => error.code === 'EQA_EGRESS_BLOCKED');
}
async function promiseBlocked(call) {
  await assert.rejects(call, error => error.code === 'EQA_EGRESS_BLOCKED');
}

blocked(() => new net.Socket().connect(443, 'example.test'));
blocked(() => new net.Socket().connect({ port: 443, host: 'example.test' }));
blocked(() => new net.Socket().connect([[443, 'example.test']]));
blocked(() => tls.connect(443, 'example.test'));
blocked(() => tls.connect({ host: 'example.test', port: 443 }));
blocked(() => netExports.connect(443, 'example.test'));
blocked(() => tlsExports.connect(443, 'example.test'));
assert.equal(delegated.tcp.length, 0);
assert.equal(delegated.tls.length, 0);

new net.Socket().connect(443, '127.0.0.1');
new net.Socket().connect({ port: 443, host: '::1' });
new net.Socket().connect([[443, '127.0.0.1']]);
tls.connect(443, '127.0.0.1');
tls.connect({ host: '::1', port: 443 });
netExports.connect(443, '127.0.0.1');
tlsExports.connect(443, '127.0.0.1');
assert.equal(delegated.tcp.length, 4);
assert.equal(delegated.tls.length, 3);

function connectWithLookup(lookup) {
  const socket = new net.Socket();
  socket.connect({ host: 'shop.example.test', port: 8080, lookup });
  return delegated.tcp.at(-1)[0].lookup;
}
const singleLookup = connectWithLookup((_hostname, options, callback) => callback(null, '127.0.0.1', 4));
await new Promise((resolve, reject) => singleLookup('shop.example.test', (error, address, family) => {
  try { assert.ifError(error); assert.equal(address, '127.0.0.1'); assert.equal(family, 4); resolve(); } catch (failure) { reject(failure); }
}));
const allLookup = connectWithLookup((_hostname, options, callback) => callback(null, [{ address: '::1', family: 6 }]));
await new Promise((resolve, reject) => allLookup('shop.example.test', { all: true }, (error, addresses) => {
  try { assert.ifError(error); assert.deepEqual(addresses, [{ address: '::1', family: 6 }]); resolve(); } catch (failure) { reject(failure); }
}));
const externalLookup = connectWithLookup((_hostname, options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]));
await new Promise((resolve, reject) => externalLookup('shop.example.test', { all: true }, error => {
  try { assert.equal(error?.code, 'EQA_EGRESS_BLOCKED'); resolve(); } catch (failure) { reject(failure); }
}));
assert.equal(delegated.tcp.length, 7);

await new Promise(resolve => dns.lookup('example.test', error => { assert.equal(error.code, 'EQA_EGRESS_BLOCKED'); resolve(); }));
await promiseBlocked(() => dns.promises.lookup('example.test'));
await promiseBlocked(() => dns.promises.resolve4('example.test'));
await new Promise(resolve => dns.resolveAny('example.test', error => { assert.equal(error.code, 'EQA_EGRESS_BLOCKED'); resolve(); }));
await new Promise(resolve => dns.lookupService('8.8.8.8', 53, error => { assert.equal(error.code, 'EQA_EGRESS_BLOCKED'); resolve(); }));
await promiseBlocked(() => dns.promises.lookupService('8.8.8.8', 53));
await new Promise(resolve => new dns.Resolver().resolve4('example.test', error => { assert.equal(error.code, 'EQA_EGRESS_BLOCKED'); resolve(); }));
await promiseBlocked(() => new dns.promises.Resolver().resolve4('example.test'));
await new Promise(resolve => dnsExports.lookup('example.test', error => { assert.equal(error.code, 'EQA_EGRESS_BLOCKED'); resolve(); }));
assert.deepEqual(delegated.lookup, []);
assert.deepEqual(delegated.resolve, []);
await new Promise((resolve, reject) => dns.lookup('127.0.0.1', error => error ? reject(error) : resolve()));
await dns.promises.lookup('::1');
assert.deepEqual(delegated.lookup, ['127.0.0.1', '::1']);

const udp = new dgram.Socket('udp4');
blocked(() => udp.send(Buffer.from('x'), 53, '8.8.8.8', () => {}));
blocked(() => udp.send(Buffer.from('x'), 0, 1, 53, '8.8.8.8', () => {}));
blocked(() => udp.send(Buffer.from('x'), { port: 53, address: '8.8.8.8' }, () => {}));
blocked(() => udp.connect(53, '8.8.8.8'));
assert.equal(delegated.udp.length, 0);
assert.equal(delegated.udpConnect.length, 0);
udp.connect(53, '127.0.0.1');
udp.send(Buffer.from('x'), () => {});
udp.send(Buffer.from('x'), 53, '127.0.0.1', () => {});
assert.equal(delegated.udp.length, 2);
assert.equal(delegated.udpConnect.length, 1);
udp.bind(0, '0.0.0.0');
assert.deepEqual(delegated.udpBind[0], [0, '127.0.0.1']);

await assert.rejects(fetch('https://example.test/'), error => error.code === 'EQA_EGRESS_BLOCKED');
assert.equal((await fetch('http://127.0.0.1:8080/')).status, 200);
assert.deepEqual(delegated.http, ['http://127.0.0.1:8080/']);

const listener = new net.Server();
listener.listen(8080, () => {});
assert.deepEqual(delegated.listen[0][0], { port: 8080, host: '127.0.0.1' });
const udpListener = new dgram.Socket('udp4');
udpListener.bind(5353);
assert.deepEqual(delegated.udpBind[1][0], { port: 5353, address: '127.0.0.1' });
console.log('egress guard self-check passed; all underlying transports were stubbed before guard import');
