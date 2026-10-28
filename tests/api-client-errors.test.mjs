import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const apiEvents = [];
globalThis.window = {
  API_BASE: '',
  dispatchEvent(event) { apiEvents.push(event); return true; },
};
globalThis.document = { cookie: '' };

const { ApiError, Batches, Leads } = await import('../js/api.js');
const { userFacingError } = await import('../js/ui.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserServer = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body><main id="api-error" data-ready="false"></main>
      <script type="module">
        import { Batches } from '/js/api.js';
        import { userFacingError } from '/js/ui.js';
        try { await Batches.list(); }
        catch (error) {
          const status = document.querySelector('#api-error');
          status.dataset.code = error.code;
          status.textContent = userFacingError(error);
          status.dataset.ready = 'true';
        }
      </script></body></html>`);
    return;
  }
  if (pathname === '/api/batches') {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'synthetic service outage' }));
    return;
  }
  if (pathname === '/js/api.js' || pathname === '/js/ui.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    response.end(fs.readFileSync(path.join(root, pathname.slice(1))));
    return;
  }
  response.writeHead(404).end();
});
browserServer.listen(0, '127.0.0.1');
await once(browserServer, 'listening');
const browserUrl = `http://127.0.0.1:${browserServer.address().port}/`;

after(() => {
  browserServer.close();
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

test('successful zero-result responses remain successful data, not fallbacks', async () => {
  const result = { rows: [], count: 0, hasMore: false };
  globalThis.fetch = async () => new Response(JSON.stringify(result), { status: 200 });

  assert.deepEqual(await Batches.list(), result);
});

test('network failures reject with an explicit offline ApiError and event', async () => {
  globalThis.fetch = async () => { throw new TypeError('connection refused'); };

  await assert.rejects(Batches.list(), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.status, 0);
    assert.equal(error.path, '/api/batches');
    return true;
  });
  assert.equal(apiEvents.at(-1).detail.code, 'NETWORK_ERROR');
});

test('HTTP failures retain distinct authorization, route, rate-limit, and server codes', async () => {
  const cases = [
    [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'], [503, 'SERVER_ERROR'], [422, 'HTTP_ERROR'],
  ];
  for (const [status, code] of cases) {
    globalThis.fetch = async () => new Response('failure detail', { status });
    await assert.rejects(Batches.list(), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  }
});

test('invalid JSON is an explicit response error', async () => {
  globalThis.fetch = async () => new Response('not-json', { status: 200 });

  await assert.rejects(Batches.list(), error => error.code === 'INVALID_RESPONSE' && error.status === 200);
});

test('JSON and file requests classify timeouts separately from offline failures', async () => {
  globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });

  await assert.rejects(Batches.list({ timeoutMs: 5 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(userFacingError(error), 'The request took too long to finish. Try again.');
    return true;
  });
  await assert.rejects(Leads.exportDirectoryEvidence(12, { timeoutMs: 5 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.path, '/api/leads/directory-jobs/12/export');
    return true;
  });

  globalThis.fetch = async (_url, { signal }) => {
    const response = new Response('{}', { status: 200 });
    response.json = () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return response;
  };
  await assert.rejects(Batches.list({ timeoutMs: 5 }), error => error.code === 'TIMEOUT',
    'the timeout remains active while reading a slow JSON body');

  globalThis.fetch = async (_url, { signal }) => {
    const response = new Response('file');
    response.blob = () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return response;
  };
  await assert.rejects(Leads.exportDirectoryEvidence(12, { timeoutMs: 5 }), error => error.code === 'TIMEOUT',
    'the timeout remains active while reading an exported file');
});

test('user-facing API error copy distinguishes offline, auth, forbidden, missing, and server errors', () => {
  assert.match(userFacingError({ code: 'NETWORK_ERROR' }), /could not be reached/i);
  assert.match(userFacingError({ code: 'UNAUTHORIZED', status: 401 }), /session has expired/i);
  assert.match(userFacingError({ code: 'FORBIDDEN', status: 403 }), /do not have permission/i);
  assert.match(userFacingError({ code: 'NOT_FOUND', status: 404 }), /service required by this view/i);
  assert.match(userFacingError({ code: 'SERVER_ERROR', status: 503 }), /could not complete/i);
  assert.match(userFacingError({ code: 'INVALID_RESPONSE' }), /unreadable response/i);
});

test('browser shows the failed-view state for an actual HTTP server error', async () => {
  const { chromium } = await import('playwright');
  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  try {
    const page = await browser.newPage();
    await page.goto(browserUrl);
    await page.waitForFunction(() => document.querySelector('#api-error')?.dataset.ready === 'true');
    assert.equal(await page.locator('#api-error').getAttribute('data-code'), 'SERVER_ERROR');
    assert.match(await page.locator('#api-error').innerText(), /workspace could not complete/i);
    assert.doesNotMatch(await page.locator('#api-error').innerText(), /\[object Object\]/);
  } finally {
    await browser.close();
  }
});
