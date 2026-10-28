import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 4;
const HARD_MAX_REDIRECTS = 5;
const DEFAULT_HOST_CONCURRENCY = 4;
const DEFAULT_HOST_REQUESTS = 120;
const DEFAULT_BUDGET_WINDOW_MS = 60_000;

const IPV4_DENYLIST = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, prefix]) => [ipv4ToBigInt(base), prefix]);

const IPV6_DENYLIST = [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
].map(([base, prefix]) => [ipv6ToBigInt(base), prefix]);

function ipv4ToBigInt(address) {
  return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (net.isIP(normalized) !== 6) throw new Error('Invalid IPv6 address');
  let parts = normalized.split('::');
  let left = parts[0] ? parts[0].split(':') : [];
  let right = parts[1] ? parts[1].split(':') : [];
  if (left.some(part => part.includes('.')) || right.some(part => part.includes('.'))) {
    const tail = right.length ? right.pop() : left.pop();
    if (!tail || net.isIP(tail) !== 4) throw new Error('Invalid IPv4-mapped IPv6 address');
    const v4 = ipv4ToBigInt(tail);
    const pair = [Number((v4 >> 16n) & 0xffffn).toString(16), Number(v4 & 0xffffn).toString(16)];
    if (parts.length > 1) right.push(...pair);
    else left.push(...pair);
  }
  const missing = 8 - left.length - right.length;
  if (parts.length > 1 && missing < 1) throw new Error('Invalid IPv6 address');
  const words = [...left, ...Array(parts.length > 1 ? missing : 0).fill('0'), ...right];
  if (words.length !== 8) throw new Error('Invalid IPv6 address');
  return words.reduce((value, word) => (value << 16n) | BigInt(parseInt(word || '0', 16)), 0n);
}

function inCidr(address, base, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return (address >> shift) === (base >> shift);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const numeric = ipv4ToBigInt(address);
    return !IPV4_DENYLIST.some(([base, prefix]) => inCidr(numeric, base, prefix, 32));
  }
  if (family !== 6) return false;
  const numeric = ipv6ToBigInt(address);
  // Publicly routable IPv6 unicast currently resides in 2000::/3. Deny known
  // transition, documentation, protocol-assignment and special-purpose ranges.
  if (!inCidr(numeric, ipv6ToBigInt('2000::'), 3, 128)) return false;
  return !IPV6_DENYLIST.some(([base, prefix]) => inCidr(numeric, base, prefix, 128));
}

function isLiteralLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1';
}

function parseTarget(input, { allowLoopback = false } = {}) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    throw new Error('SSRF blocked: invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SSRF blocked: only HTTP and HTTPS are allowed');
  if (url.username || url.password) throw new Error('SSRF blocked: URL credentials are not allowed');
  url.hash = '';
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const localLoopback = allowLoopback && isLiteralLoopback(hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('SSRF blocked: local hostnames are not allowed');
  }
  if (net.isIP(hostname) === 0 && !hostname.includes('.')) throw new Error('SSRF blocked: single-label hosts are not allowed');
  return { url, hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), localLoopback };
}

async function defaultResolve(hostname) {
  return dns.lookup(hostname, { all: true, order: 'verbatim' });
}

function normalizeAddresses(records) {
  const values = Array.isArray(records) ? records : [records];
  const seen = new Set();
  const addresses = [];
  for (const record of values) {
    const address = typeof record === 'string' ? record : record?.address;
    const family = net.isIP(address || '');
    if (!family || (record && typeof record === 'object' && record.family && record.family !== family)) continue;
    if (!seen.has(address)) {
      seen.add(address);
      addresses.push({ address, family });
    }
  }
  return addresses;
}

async function resolveAndCheck(target, resolver, addressPolicy) {
  let records;
  if (net.isIP(target.hostname)) records = [{ address: target.hostname, family: net.isIP(target.hostname) }];
  else {
    try {
      records = await resolver(target.hostname);
    } catch {
      throw new Error('SSRF blocked: hostname could not be resolved');
    }
  }
  const addresses = normalizeAddresses(records);
  if (!addresses.length) throw new Error('SSRF blocked: hostname returned no usable addresses');
  if (target.localLoopback) {
    if (addresses.length !== 1 || addresses[0].address !== target.hostname) {
      throw new Error('SSRF blocked: local endpoint must use a literal loopback address');
    }
  } else if (addresses.some(({ address }) => !addressPolicy(address))) {
    throw new Error('SSRF blocked: hostname resolves to a non-public address');
  }
  return addresses;
}

export async function validateUrl(input, { resolver = defaultResolve, addressPolicy = isPublicAddress } = {}) {
  try {
    const target = parseTarget(input);
    const addresses = await resolveAndCheck(target, resolver, addressPolicy);
    return { safe: true, resolvedIp: addresses[0].address, resolvedIps: addresses.map(item => item.address) };
  } catch (error) {
    return { safe: false, reason: error.message, resolvedIp: null, resolvedIps: [] };
  }
}

function boundedInteger(value, fallback, maximum, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(Math.floor(parsed), maximum)) : fallback;
}

function makeHostKey(target) {
  return target.hostname;
}

function acquireHostBudget(hostBudgets, hostKey, now, limits) {
  const windowStartedAt = now - limits.windowMs;
  if (hostBudgets.size >= 4096 && !hostBudgets.has(hostKey)) {
    for (const [staleHost, staleBudget] of hostBudgets) {
      staleBudget.requests = staleBudget.requests.filter(timestamp => timestamp > windowStartedAt);
      if (staleBudget.active === 0 && staleBudget.requests.length === 0) hostBudgets.delete(staleHost);
      if (hostBudgets.size < 4096) break;
    }
    if (hostBudgets.size >= 4096) throw new Error('Research host tracking capacity exceeded');
  }
  let budget = hostBudgets.get(hostKey);
  if (!budget) {
    budget = { requests: [], active: 0 };
    hostBudgets.set(hostKey, budget);
  }
  budget.requests = budget.requests.filter(timestamp => timestamp > windowStartedAt);
  if (budget.requests.length >= limits.maxRequests) throw new Error('Research host request budget exceeded');
  if (budget.active >= limits.maxConcurrency) throw new Error('Research host concurrency limit exceeded');
  budget.requests.push(now);
  budget.active += 1;
  return () => {
    budget.active = Math.max(0, budget.active - 1);
    if (budget.active === 0 && budget.requests.length === 0) hostBudgets.delete(hostKey);
  };
}

function requestPinned(url, address, { method, headers, signal, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const family = net.isIP(address);
    const requestHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!['host', 'accept-encoding'].includes(name.toLowerCase())) requestHeaders[name] = value;
    }
    requestHeaders.host = url.host;
    requestHeaders['accept-encoding'] = 'identity';
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      agent: false,
      servername: net.isIP(hostname) ? undefined : hostname,
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, response => {
      const declaredLength = Number(response.headers['content-length']);
      if (method !== 'HEAD' && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        // Settle explicitly before destroying either stream. Destroying the
        // response first can suppress the request error on some Node versions,
        // leaving callers waiting until their outer deadline expires.
        fail(new Error('Research response exceeds byte limit'));
        response.destroy();
        request.destroy();
        return;
      }
      const chunks = [];
      let byteLength = 0;
      response.on('data', chunk => {
        byteLength += chunk.length;
        if (byteLength > maxBytes) {
          response.destroy(new Error('Research response exceeds byte limit'));
          request.destroy(new Error('Research response exceeds byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('end', () => {
        const body = method === 'HEAD' || [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks);
        try {
          const result = new Response(body, { status: response.statusCode, statusText: response.statusMessage, headers: response.headers });
          Object.defineProperty(result, 'url', { value: url.href, configurable: true });
          Object.defineProperty(result, '_bodyByteLength', { value: byteLength, configurable: true });
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      request.destroy(new Error('Research request aborted'));
      fail(new Error('Research request aborted'));
    };
    request.once('error', fail);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      request.destroy(new Error('Research request timed out'));
      fail(new Error('Research request timed out'));
    }, timeoutMs);
    timer.unref?.();
    request.once('close', cleanup);
    request.end();
  });
}

export function createSafeFetcher({
  resolver = defaultResolve,
  addressPolicy = isPublicAddress,
  allowLoopback = false,
  now = Date.now,
  maxConcurrency = DEFAULT_HOST_CONCURRENCY,
  maxRequests = DEFAULT_HOST_REQUESTS,
  budgetWindowMs = DEFAULT_BUDGET_WINDOW_MS,
} = {}) {
  const hostBudgets = new Map();
  const limits = {
    maxConcurrency: boundedInteger(maxConcurrency, DEFAULT_HOST_CONCURRENCY, 100, 1),
    maxRequests: boundedInteger(maxRequests, DEFAULT_HOST_REQUESTS, 10_000, 1),
    windowMs: boundedInteger(budgetWindowMs, DEFAULT_BUDGET_WINDOW_MS, 3_600_000, 100),
  };

  return async function safeFetch(input, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw new Error('Research fetch only permits GET and HEAD');
    const headerEntries = options.headers instanceof Headers
      ? [...options.headers.entries()]
      : Array.isArray(options.headers) ? options.headers : Object.entries(options.headers || {});
    const headers = Object.fromEntries(headerEntries);
    const redirectMode = options.redirect || 'follow';
    if (!['follow', 'manual', 'error'].includes(redirectMode)) throw new Error('Unsupported research redirect mode');
    const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 100);
    const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES, 1);
    const maxRedirects = boundedInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, HARD_MAX_REDIRECTS, 0);
    let target = parseTarget(input, { allowLoopback });
    let redirects = 0;
    const deadline = Date.now() + timeoutMs;
    let totalBytes = 0;

    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error('Research request timed out');
      const addresses = await awaitBounded(resolveAndCheck(target, resolver, addressPolicy), remainingMs, options.signal);
      const requestRemainingMs = deadline - Date.now();
      if (requestRemainingMs <= 0) throw new Error('Research request timed out');
      const release = acquireHostBudget(hostBudgets, makeHostKey(target), now(), limits);
      let response;
      try {
        response = await requestPinned(target.url, addresses[0].address, { method, headers, signal: options.signal, timeoutMs: requestRemainingMs, maxBytes });
      } finally {
        release();
      }
      totalBytes += response._bodyByteLength || 0;
      if (totalBytes > maxBytes) throw new Error('Research redirect chain exceeds byte limit');
      const location = response.headers.get('location');
      const isRedirect = [301, 302, 303, 307, 308].includes(response.status) && location;
      if (!isRedirect || redirectMode === 'manual') return response;
      if (redirectMode === 'error') throw new Error('Research redirect rejected');
      if (redirects >= maxRedirects) throw new Error('Research redirect limit exceeded');
      const previousOrigin = target.url.origin;
      try {
        target = parseTarget(new URL(location, target.url), { allowLoopback });
      } catch (error) {
        if (error.message.includes('SSRF blocked')) throw error;
        throw new Error('SSRF blocked: invalid redirect target');
      }
      if (target.url.origin !== previousOrigin) {
        for (const name of Object.keys(headers)) if (['authorization', 'proxy-authorization', 'cookie', 'cookie2'].includes(name.toLowerCase())) delete headers[name];
      }
      redirects += 1;
    }
  };
}

export const safeFetch = createSafeFetcher();

function awaitBounded(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Research request aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Research request timed out'));
    }, timeoutMs);
    promise.then(value => {
      cleanup();
      resolve(value);
    }, error => {
      cleanup();
      reject(error);
    });
  });
}
