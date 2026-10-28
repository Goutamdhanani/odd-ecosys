// Release checks must never open the operator's database or contact real SMTP/HTTP services.
// Load with node --import ./tests/support/loopback-only.mjs --test ...
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sandbox = mkdtempSync(path.join(tmpdir(), 'odd-release-check-'));
if (!process.env.ODD_DB_PATH) process.env.ODD_DB_PATH = path.join(sandbox, 'fallback.db');
const resolvedDb = path.resolve(process.env.ODD_DB_PATH);
if (!resolvedDb.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Release tests require a disposable database under the temporary directory.');
process.once('exit', () => { try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* OS may still hold a closing test handle. */ } });

const local = host => host === 'localhost' || host === '::1' || host === '[::1]'
  || /^127\.\d+\.\d+\.\d+$/.test(host) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(host);
const denied = host => Object.assign(new Error(`External network disabled during release tests: ${host}`), { code: 'TEST_EXTERNAL_NETWORK_BLOCKED' });
const fetchImpl = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) return Promise.reject(denied(url.hostname));
  return fetchImpl(input, options);
};
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first
    : typeof first === 'number' || (typeof first === 'string' && first.trim() !== '' && Number.isFinite(Number(first)) && Number(first) >= 0)
      ? { port: Number(first), host: typeof args[1] === 'string' ? args[1] : 'localhost' } : { path: first };
  if (!options.path && !local(options.host || 'localhost')) {
    // Literal IP destinations skip Node's lookup hook entirely.
    if (net.isIP(options.host)) throw denied(options.host);
    // Guard the actual resolved destination, allowing test fixtures that pin a
    // synthetic public hostname to their loopback server via an injected lookup.
    const lookup = options.lookup || dns.lookup;
    const guarded = { ...options, lookup(hostname, settings, callback) {
      return lookup(hostname, settings, (error, address, family) => {
        if (error) return callback(error);
        const addresses = Array.isArray(address) ? address.map(item => item.address) : [address];
        if (!addresses.length || !addresses.every(local)) return callback(denied(hostname));
        callback(null, address, family);
      });
    } };
    if (Array.isArray(args[0])) args[0][0] = guarded;
    else args[0] = guarded;
  }
  return Reflect.apply(socketConnect, this, args);
};
syncBuiltinESMExports();
