import http from 'node:http';

const PRODUCTION_ORIGIN = 'http://127.0.0.1:8081';
const REQUEST_PATH = '/search';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TEST_TRANSPORTS = new WeakSet();

function transportError(message, code, statusCode = 502) {
  const failure = new Error(message);
  failure.code = code;
  failure.statusCode = statusCode;
  return failure;
}

function parseTestOrigin(value) {
  let origin;
  try { origin = new URL(value); } catch { throw new TypeError('testOrigin must be an explicit loopback HTTP origin.'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || Number(origin.port) < 1 || Number(origin.port) > 65535
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('testOrigin must be an explicit http://127.0.0.1:<port> origin.');
  }
  return origin;
}

function parseRequestUrl(input) {
  let url;
  try { url = new URL(String(input)); } catch { throw transportError('Local search request URL is invalid.', 'source_search_unavailable', 503); }
  const searchKeys = [...url.searchParams.keys()];
  if (url.origin !== PRODUCTION_ORIGIN || url.pathname !== REQUEST_PATH || url.username || url.password || url.hash
    || url.searchParams.get('format') !== 'json' || url.searchParams.get('engines') !== 'google cse'
    || url.searchParams.getAll('format').length !== 1 || url.searchParams.getAll('engines').length !== 1
    || url.searchParams.getAll('q').length !== 1 || searchKeys.some(key => !['q', 'format', 'engines'].includes(key))
    || !url.searchParams.get('q')) {
    throw transportError('Local search transport accepts only the pinned loopback search request.', 'source_search_unavailable', 503);
  }
  return url;
}

/**
 * Direct, proxy-independent transport for the one server-owned local SearXNG
 * endpoint. `testOrigin` is a trusted constructor seam for isolated loopback
 * fixtures; it cannot select a hostname other than the literal IPv4 loopback.
 */
export function createAstraLocalSearchTransport({ testOrigin } = {}) {
  const destination = testOrigin === undefined ? new URL(PRODUCTION_ORIGIN) : parseTestOrigin(testOrigin);

  const requestLocalSearch = async function requestLocalSearch(input, options = {}) {
    const url = parseRequestUrl(input);
    if ((options.method || 'GET').toUpperCase() !== 'GET' || options.redirect !== 'error') {
      throw transportError('Local search transport requires GET with redirects disabled.', 'source_search_unavailable', 503);
    }
    const requestedMaxBytes = Number(options.maxBytes);
    const maxBytes = Number.isInteger(requestedMaxBytes) && requestedMaxBytes > 0
      ? Math.min(requestedMaxBytes, MAX_RESPONSE_BYTES) : MAX_RESPONSE_BYTES;
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isInteger(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    const signal = options.signal;
    if (signal?.aborted) throw transportError('Local search request was cancelled.', 'job_cancelled', 499);

    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let byteCount = 0;
      const chunks = [];
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (failure, response) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure) reject(failure);
        else resolve(response);
      };
      const abort = () => request?.destroy(transportError('Local search request was cancelled.', 'job_cancelled', 499));
      const timer = setTimeout(() => request?.destroy(transportError('Local search request timed out.', 'search_timeout', 504)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });

      try { request = http.request({
        protocol: destination.protocol,
        hostname: destination.hostname,
        port: destination.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: { accept: 'application/json', 'user-agent': 'OddEcosysResearch/1.0', connection: 'close' },
      }, response => {
        if (REDIRECTS.has(response.statusCode)) {
          response.resume();
          finish(transportError('Local search redirects are not accepted.', 'redirect_policy_blocked', 403));
          return;
        }
        const declaredLength = response.headers['content-length'];
        if (declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) > maxBytes)) {
          response.resume();
          finish(transportError('Local search response exceeds the byte limit.', 'search_response_too_large', 413));
          return;
        }
        response.on('data', chunk => {
          byteCount += chunk.length;
          if (byteCount > maxBytes) {
            finish(transportError('Local search response exceeds the byte limit.', 'search_response_too_large', 413));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks, byteCount);
          let result;
          try {
            result = new Response(body.length ? body : null, {
              status: response.statusCode || 502,
              headers: response.headers,
            });
          } catch {
            finish(transportError('Local search returned an invalid HTTP response.', 'search_response_unavailable'));
            return;
          }
          finish(null, result);
        });
        response.on('error', cause => finish(transportError('Local search response could not be read.', 'search_response_unavailable', 502)));
      });
      } catch (cause) { finish(transportError('Local search could not start under the current request policy.', 'search_response_unavailable', 502)); return; }
      request.on('error', cause => finish(cause?.code === 'search_timeout' || cause?.code === 'job_cancelled'
        ? cause : transportError('Local search service is unavailable.', 'search_response_unavailable', 502)));
      request.end();
    });
  };
  if (testOrigin !== undefined) TEST_TRANSPORTS.add(requestLocalSearch);
  return requestLocalSearch;
}

export const ASTRA_LOCAL_SEARCH_ORIGIN = PRODUCTION_ORIGIN;
export const ASTRA_LOCAL_SEARCH_ENGINE = 'google cse';

/**
 * Resolve the narrow local capability from server-owned settings. The existing
 * origin setting is accepted in local mode only when it is the exact approved
 * loopback origin; callers cannot supply a destination to the transport.
 */
export function isAstraLocalSearchEnabled(env = process.env) {
  const setting = env?.ASTRA_SOURCE_COLLECTION_LOCAL_SEARCH_ENABLED;
  if (setting === undefined || setting === 'false') return false;
  if (setting !== 'true' || env?.ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN !== PRODUCTION_ORIGIN) {
    throw new TypeError('Local search requires the exact true opt-in and pinned loopback origin.');
  }
  return true;
}

export function isAstraLocalSearchTestTransport(transport) {
  return typeof transport === 'function' && TEST_TRANSPORTS.has(transport);
}
