import http from 'node:http';

const MAX_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 12_000;

// This is operator configuration, never a request-supplied network allowlist.
// A literal loopback address avoids DNS rebinding and localhost resolver changes.
export function localSearxngEndpoint(value = process.env.ODD_SEARXNG_LOCAL_BASE_URL) {
  if (value === undefined || value === '') return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { /* Report configuration without its contents. */ }
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || Number(url.port) < 1024 || url.username || url.password || url.search || url.hash) {
    throw new Error('ODD_SEARXNG_LOCAL_BASE_URL must be an HTTP literal loopback URL with a port from 1024 to 65535 and no credentials, query or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href.replace(/\/$/, '');
}

export function createLocalSearxngFetcher(endpoint) {
  const base = localSearxngEndpoint(endpoint);
  if (!base) throw new Error('An operator-approved local SearXNG endpoint is required.');
  const allowed = new URL('search', `${base}/`);
  let requestTimes = [];
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== allowed.origin || url.pathname !== allowed.pathname || url.username || url.password
      || url.hash || (options.method && options.method !== 'GET')) {
      throw new Error('Local SearXNG requests must use the exact operator-approved search route.');
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Number(options.timeoutMs) || MAX_TIMEOUT_MS);
    const maxBytes = Math.min(MAX_BYTES, Number(options.maxBytes) || MAX_BYTES);
    if (timeoutMs < 1 || maxBytes < 1) throw new Error('Invalid local search request limits.');
    const now = Date.now();
    requestTimes = requestTimes.filter(time => now - time < 60_000);
    if (requestTimes.length >= 20) throw Object.assign(new Error('Local SearXNG request budget reached.'), { statusCode: 429 });
    requestTimes.push(now);
    return new Promise((resolve, reject) => {
      let timer;
      let response;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          response?.destroy();
          request.destroy();
          reject(error);
        } else resolve(result);
      };
      const request = http.request(url, { method: 'GET', agent: false, headers: options.headers }, incoming => {
        response = incoming;
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
          return finish(new Error('Local SearXNG redirects are not allowed.'));
        }
        if (Number(incoming.headers['content-length']) > maxBytes) {
          return finish(new Error('Local SearXNG response exceeds the size limit.'));
        }
        const chunks = [];
        let bytes = 0;
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(new Error('Local SearXNG response exceeds the size limit.'));
          chunks.push(chunk);
        });
        incoming.on('aborted', () => finish(new Error('Local SearXNG response was interrupted.')));
        incoming.on('error', error => finish(error));
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          finish(null, {
            ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
            status: incoming.statusCode,
            headers,
            json: async () => JSON.parse(body),
          });
        });
      });
      request.on('error', error => finish(error));
      // Bound the complete response, including a stalled or continuously streaming body.
      timer = setTimeout(() => finish(new Error('Local SearXNG request timed out.')), timeoutMs);
      request.end();
    });
  };
}
