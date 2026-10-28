import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const allowed = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
function normalizedHost(value) {
  return String(value ?? '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}
function permitted(host) { return allowed.has(normalizedHost(host)); }
function isLoopbackAddress(value) {
  const address = normalizedHost(value);
  const family = net.isIP(address);
  if (family === 4) return Number(address.split('.')[0]) === 127;
  return family === 6 && address === '::1';
}
function isNonLoopbackLiteral(value) {
  const address = normalizedHost(value);
  return net.isIP(address) !== 0 && !isLoopbackAddress(address);
}
function customLookupFrom(args) {
  return normalizeArgs(args).find(value => value && typeof value === 'object' && typeof value.lookup === 'function')?.lookup;
}
function guardedLookup(lookup) {
  return function (hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    if (typeof callback !== 'function') return lookup.call(this, hostname, options, callback);
    let called = false;
    const verify = (error, ...results) => {
      if (called) return;
      called = true;
      if (error) return callback(error);
      const validAddress = (address, family) => isLoopbackAddress(address) && (!family || family === net.isIP(normalizedHost(address)));
      const valid = options.all
        ? Array.isArray(results[0]) && results[0].length > 0 && results[0].every(record => record && validAddress(record.address, record.family))
        : validAddress(results[0], results[1]);
      if (!valid) return callback(denied('DNS', hostname));
      return callback(null, ...results);
    };
    return lookup.call(this, hostname, options, verify);
  };
}
function denied(kind, host) {
  const message = `[qa-egress-guard] blocked ${kind} to ${host || '<unknown>'}`;
  process.stderr.write(message + '\n');
  const error = new Error(message);
  error.code = 'EQA_EGRESS_BLOCKED';
  return error;
}
function normalizeArgs(args) {
  return Array.from(args).flat(Infinity);
}
function hostFrom(args) {
  const values = normalizeArgs(args);
  const first = values[0];
  if (first && typeof first === 'object') {
    return String(first.host ?? first.hostname ?? first.path ?? '');
  }
  if (typeof first === 'string') return first;
  if (typeof first === 'number') {
    if (typeof values[1] === 'string') return values[1];
    if (values[1] && typeof values[1] === 'object') {
      return String(values[1].host ?? values[1].hostname ?? values[1].path ?? '');
    }
  }
  return '';
}

const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const values = normalizeArgs(args);
  const first = values[0];
  if (first && typeof first === 'object') {
    const host = normalizedHost(first.host);
    if (!first.path && (!host || host === '0.0.0.0' || host === '::')) values[0] = { ...first, host: '127.0.0.1' };
    else if (!first.path && host && !permitted(host)) throw denied('TCP-LISTEN', host);
  } else if (typeof first === 'number') {
    if (typeof values[1] === 'string') {
      const host = normalizedHost(values[1]);
      if (!host || host === '0.0.0.0' || host === '::') values[1] = '127.0.0.1';
      else if (!permitted(host)) throw denied('TCP-LISTEN', host);
    } else {
      const options = { port: first, host: '127.0.0.1' };
      const backlog = values.slice(1).find(value => typeof value === 'number');
      if (backlog !== undefined) options.backlog = backlog;
      values.splice(0, values.length, options, ...values.filter(value => typeof value === 'function'));
    }
  }
  return origListen.apply(this, values);
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const host = hostFrom(args);
  const values = normalizeArgs(args);
  const lookup = customLookupFrom(values);
  if (host && isNonLoopbackLiteral(host)) throw denied('TCP', host);
  if (host && !permitted(host) && !lookup) throw denied('TCP', host);
  if (values[0] && typeof values[0] === 'object' && !values[0].path) {
    values[0] = {
      ...values[0],
      lookup: lookup ? guardedLookup(lookup) : (hostname, options, callback) => {
        if (typeof options === 'function') callback = options;
        if (!permitted(hostname)) return process.nextTick(callback, denied('DNS', hostname));
        const address = normalizedHost(hostname) === 'localhost' ? '127.0.0.1' : hostname;
        if (options?.all) return process.nextTick(callback, null, [{ address, family: net.isIP(address) }]);
        return process.nextTick(callback, null, address, net.isIP(address));
      },
    };
  }
  return origConnect.apply(this, values);
};

const origTls = tls.connect;
tls.connect = function (...args) {
  const values = normalizeArgs(args);
  const host = hostFrom(values);
  const lookup = customLookupFrom(values);
  if (host && isNonLoopbackLiteral(host)) throw denied('TLS', host);
  if (host && !permitted(host) && !lookup) throw denied('TLS', host);
  if (values[0] && typeof values[0] === 'object' && !values[0].path && lookup) {
    values[0] = { ...values[0], lookup: guardedLookup(lookup) };
  }
  return origTls.apply(this, values);
};

const origFetch = globalThis.fetch;
globalThis.fetch = async function (input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!permitted(url.hostname)) throw denied('HTTP', url.hostname);
  return origFetch.call(this, input, ...args);
};

const originalLookup = dns.lookup;
const promiseDns = dns.promises;
dns.lookup = function (host, ...args) {
  if (!permitted(host)) {
    const callback = args.find(value => typeof value === 'function');
    const error = denied('DNS', host);
    if (callback) return process.nextTick(callback, error);
    throw error;
  }
  if (normalizedHost(host) === 'localhost') {
    const callback = args.find(value => typeof value === 'function');
    const options = args.find(value => value && typeof value === 'object') || {};
    if (callback) {
      if (options.all) return process.nextTick(callback, null, [{ address: '127.0.0.1', family: 4 }]);
      return process.nextTick(callback, null, '127.0.0.1', 4);
    }
    return Promise.resolve(options.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 });
  }
  return originalLookup.call(this, host, ...args);
};
for (const name of ['resolve','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','resolve4','resolve6','reverse']) {
  const original = dns[name];
  if (typeof original !== 'function') continue;
  dns[name] = function (host, ...args) {
    const callback = args.find(value => typeof value === 'function');
    const error = denied('DNS', host);
    if (callback) return process.nextTick(callback, error);
    throw error;
  };
}
const dnsResolverClasses = new Set([dns.Resolver, promiseDns.Resolver].filter(value => typeof value === 'function'));
for (const ResolverClass of dnsResolverClasses) {
  for (const name of ['resolve','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','resolve4','resolve6','reverse']) {
    const original = ResolverClass.prototype[name];
    if (typeof original !== 'function') continue;
    ResolverClass.prototype[name] = function (host, ...args) {
      const callback = args.find(value => typeof value === 'function');
      const error = denied('DNS', host);
      if (callback) return process.nextTick(callback, error);
      return Promise.reject(error);
    };
  }
}
dns.lookupService = function (address, _port, callback) {
  return process.nextTick(callback, denied('DNS', address));
};
promiseDns.lookupService = function (address) {
  return Promise.reject(denied('DNS', address));
};
const originalPromiseLookup = promiseDns.lookup.bind(promiseDns);
promiseDns.lookup = function (host, options = {}) {
  if (!permitted(host)) return Promise.reject(denied('DNS', host));
  if (normalizedHost(host) === 'localhost') {
    return Promise.resolve(options?.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 });
  }
  return originalPromiseLookup(host, options);
};
for (const name of ['resolve','resolveAny','resolveCaa','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','resolve4','resolve6','reverse']) {
  if (typeof promiseDns[name] !== 'function') continue;
  promiseDns[name] = host => Promise.reject(denied('DNS', host));
}

const connectedUdpHosts = new WeakMap();
const originalUdpBind = dgram.Socket.prototype.bind;
dgram.Socket.prototype.bind = function (...args) {
  const values = normalizeArgs(args);
  const first = values[0];
  if (first && typeof first === 'object') {
    const address = normalizedHost(first.address);
    if (!address || address === '0.0.0.0' || address === '::') values[0] = { ...first, address: '127.0.0.1' };
    else if (!permitted(address)) throw denied('UDP-BIND', address);
  } else if (typeof first === 'number') {
    if (typeof values[1] === 'string') {
      const address = normalizedHost(values[1]);
      if (!address || address === '0.0.0.0' || address === '::') values[1] = '127.0.0.1';
      else if (!permitted(address)) throw denied('UDP-BIND', address);
    } else {
      const options = { port: first, address: '127.0.0.1' };
      values.splice(0, values.length, options, ...values.filter(value => typeof value === 'function'));
    }
  } else if (first === undefined) {
    values.splice(0, values.length, { port: 0, address: '127.0.0.1' }, ...values.filter(value => typeof value === 'function'));
  }
  return originalUdpBind.apply(this, values);
};
const originalUdpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function (...args) {
  const values = normalizeArgs(args);
  const host = typeof values[1] === 'string' ? values[1] : String(values[1]?.address ?? values[1]?.host ?? '');
  if (host && !permitted(host)) throw denied('UDP', host);
  if (host) connectedUdpHosts.set(this, host);
  return originalUdpConnect.apply(this, values);
};
const originalUdpDisconnect = dgram.Socket.prototype.disconnect;
if (typeof originalUdpDisconnect === 'function') dgram.Socket.prototype.disconnect = function (...args) {
  connectedUdpHosts.delete(this);
  return originalUdpDisconnect.apply(this, args);
};
const originalSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  let host = '';
  const options = args[1];
  if (options && typeof options === 'object') host = String(options.address ?? options.host ?? '');
  else {
    for (let index = args.length - 1; index >= 1; index--) {
      if (typeof args[index] === 'string' && typeof args[index - 1] === 'number') {
        host = args[index];
        break;
      }
    }
  }
  if (!host) host = connectedUdpHosts.get(this) || '';
  if (host && !permitted(host)) throw denied('UDP', host);
  return originalSend.apply(this, args);
};

syncBuiltinESMExports();

// Chromium runs outside Node's socket hooks. Install a browser request guard only
// in the ordinary project test workers that actually use Playwright; helper
// children and the native-transport self-check must stay lightweight.
const browserTestFiles = new Set([
  'api-client-errors.test.mjs', 'auth-mfa.test.mjs', 'click-tracking.test.mjs',
  'delivery-reports-ui.test.mjs', 'google-login-ui.test.mjs', 'lead-discovery-ui.test.mjs',
  'lead-search.test.mjs', 'lead-strategy-ui.test.mjs', 'mailbox-warmup-review.test.mjs',
  'meta-lead-ads.test.mjs', 'personalization-provider-ui.test.mjs',
  'qualification-jobs.test.mjs', 'qualification-review.test.mjs',
  'qualification-scoring-api.test.mjs', 'qualification-source-access.test.mjs',
  'searxng-search-ui.test.mjs', 'spa-renderer.test.mjs', 'ui-feedback.test.mjs',
  'ui-route-audit.test.mjs', 'website-discovery-ui.test.mjs',
  'website-rendered-fallback.test.mjs',
]);
const currentTestFile = process.argv.find(argument => /\.test\.mjs$/i.test(argument));
if (currentTestFile && browserTestFiles.has(currentTestFile.split(/[\\/]/).at(-1))) {
  const [{ installLoopbackBrowserGuard }, playwright] = await Promise.all([
    import('./loopback-browser-guard.mjs'), import('playwright'),
  ]);
  installLoopbackBrowserGuard(playwright);
  if (process.env.ASTRA_QA_BROWSER_GUARD_TRACE) {
    const fs = await import('node:fs');
    globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')] = [];
    process.on('exit', () => {
      fs.writeFileSync(process.env.ASTRA_QA_BROWSER_GUARD_TRACE,
        JSON.stringify(globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')], null, 2));
    });
  }
}
