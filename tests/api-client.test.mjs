import test from 'node:test';
import assert from 'node:assert/strict';

const originalGlobals = {};
function installBrowser(fetchImpl) {
  originalGlobals.fetch ??= globalThis.fetch;
  originalGlobals.window ??= globalThis.window;
  originalGlobals.document ??= globalThis.document;
  originalGlobals.CustomEvent ??= globalThis.CustomEvent;
  globalThis.window = { API_BASE: 'http://api.fixture', events: [], dispatchEvent(event) { this.events.push(event); } };
  globalThis.document = { cookie: 'odd_csrf=csrf-fixture' };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  globalThis.fetch = fetchImpl;
}

function restoreBrowser() {
  globalThis.fetch = originalGlobals.fetch;
  if (originalGlobals.window === undefined) delete globalThis.window; else globalThis.window = originalGlobals.window;
  if (originalGlobals.document === undefined) delete globalThis.document; else globalThis.document = originalGlobals.document;
  if (originalGlobals.CustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = originalGlobals.CustomEvent;
}

const { Batches } = await import('../js/api.js');

test('successful empty, zero-count and explicitly partial API data passes through unchanged', async () => {
  const payloads = [[], { items: [], total: 0 }, { items: [{ id: 1 }], partial: true, nextCursor: 'cursor-2' }];
  let index = 0;
  installBrowser(async () => new Response(JSON.stringify(payloads[index++]), { status: 200 }));
  try {
    for (const payload of payloads) assert.deepEqual(await Batches.list(), payload);
  } finally { restoreBrowser(); }
});

test('offline, HTTP, authorization and invalid-JSON failures stay typed errors', async () => {
  const { ApiError } = await import('../js/api.js');
  installBrowser(async () => { throw new TypeError('offline fixture'); });
  try {
    await assert.rejects(Batches.list(), error => error instanceof ApiError && error.code === 'NETWORK_ERROR' && error.status === 0);

    const expectedCodes = new Map([[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [503, 'SERVER_ERROR']]);
    for (const [status, code] of expectedCodes) {
      globalThis.fetch = async () => new Response('{"error":"fixture"}', { status, headers: { 'Content-Type': 'application/json' } });
      await assert.rejects(Batches.list(), error => error instanceof ApiError && error.status === status && error.code === code);
    }

    globalThis.fetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(Batches.list(), error => error instanceof ApiError && error.code === 'INVALID_RESPONSE' && error.status === 200);
    assert.equal(window.events.some(event => event.type === 'api:error' && event.detail.code === 'UNAUTHORIZED'), true);
  } finally { restoreBrowser(); }
});

test('request timeout aborts the network operation and renders distinct user-facing guidance', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const { ApiError } = await import('../js/api.js');
  const { userFacingError } = await import('../js/ui.js');
  installBrowser(async (_url, { signal }) => new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }));
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 15_000);
    queueMicrotask(callback);
    return 1;
  };
  globalThis.clearTimeout = () => {};
  try {
    await assert.rejects(Batches.list(), error => error instanceof ApiError && error.code === 'TIMEOUT' && error.status === 0);
    assert.equal(window.events.at(-1).detail.code, 'TIMEOUT');
    assert.equal(userFacingError({ code: 'TIMEOUT', status: 0 }), 'The request took too long to finish. Try again.');
    assert.equal(userFacingError({ code: 'UNAUTHORIZED', status: 401 }), 'Your session has expired. Sign in and try again.');
    assert.equal(userFacingError({ code: 'NETWORK_ERROR', status: 0 }), 'The workspace could not be reached. Check your connection and try again.');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    restoreBrowser();
  }
});
