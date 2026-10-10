import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createSafeFetcher, isPublicAddress } from '../pipeline/ssrf-guard.js';
import { captureScreenshot, getRenderedPage } from '../pipeline/screenshot.js';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function browserExecutable() {
  const configured = process.env.ODD_CHROMIUM_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  if (process.platform === 'win32' && fs.existsSync(EDGE_PATH)) return EDGE_PATH;
  try {
    const { chromium } = await import('playwright');
    const bundled = chromium.executablePath();
    if (fs.existsSync(bundled)) return bundled;
  } catch { /* browser runtime may be unavailable in test hosts */ }
  return null;
}

async function withLocalSite(run) {
  const state = { requested: [], cookiesForwarded: [], originsSeen: [], websocketUpgrades: 0, slowScriptStarted: false };
  const server = http.createServer((req, res) => {
    state.requested.push(req.url);
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://other.example.test:${server.address().port}/spa`, 'set-cookie': 'fixture-secret=never-forward; Path=/' });
      res.end();
      return;
    }
    if (req.url === '/spa') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'fixture-secret=never-forward; Path=/' });
      res.end(`<!doctype html><html><head><title>Fixture SPA</title></head><body><main id="app">Loading content</main><script>
        fetch('/app.js').then(response => response.text()).then(source => (0, eval)(source)).catch(() => {});
        fetch('http://shop.example.test:${server.address().port}/cors').then(response => response.text()).then(text => { document.body.dataset.cors = text; }).catch(() => {});
        fetch('http://metadata.example.test/private').catch(() => { document.body.dataset.privateBlocked = 'yes'; });
        fetch('/submit', {method:'POST', body:'must-not-leave'}).catch(() => { document.body.dataset.postBlocked = 'yes'; });
        try { new RTCPeerConnection(); } catch { document.body.dataset.webrtcBlocked = 'yes'; }
        const ws = new WebSocket('ws://shop.example.test:${server.address().port}/socket');
        ws.onerror = () => { document.body.dataset.websocketBlocked = 'yes'; };
      </script></body></html>`);
      return;
    }
    if (req.url === '/app.js') {
      state.cookiesForwarded.push(req.headers.cookie || null);
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`document.querySelector('#app').textContent = 'Rendered content loaded from the safe local fixture. '.repeat(5);`);
      return;
    }
    if (req.url === '/cors') {
      state.originsSeen.push(req.headers.origin || null);
      res.writeHead(200, { 'content-type': 'text/plain', ...(req.headers.origin ? { 'access-control-allow-origin': req.headers.origin } : {}) });
      res.end('cross-origin access allowed by the local site fixture');
      return;
    }
    if (req.url === '/slow.js') {
      state.slowScriptStarted = true;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(`document.body.textContent='late';`);
      }, 1000);
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><body><script src="/slow.js"></script></body>`);
      return;
    }
    if (req.url === '/budget') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><body><script>fetch('/large.js').catch(() => {});</script><p>budget fixture</p></body>`);
      return;
    }
    if (req.url === '/large.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': '2048' });
      res.end('x'.repeat(2048));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.on('upgrade', (_req, socket) => {
    state.websocketUpgrades += 1;
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    await run({ port, state });
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

test('isolated Chromium renders an SPA and keeps every external request behind the guarded local fetcher', async t => {
  const executablePath = await browserExecutable();
  if (!executablePath) return t.skip('No Playwright-compatible Chromium executable is installed on this host.');
  await withLocalSite(async ({ port, state }) => {
    const resolver = async hostname => {
      if (hostname === 'shop.example.test' || hostname === 'other.example.test') return [{ address: '127.0.0.1', family: 4 }];
      if (hostname === 'metadata.example.test') return [{ address: '169.254.169.254', family: 4 }];
      throw new Error('unexpected fixture DNS query');
    };
    const guardedFetch = createSafeFetcher({ resolver, addressPolicy: address => address === '127.0.0.1' || isPublicAddress(address) });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-ecosys-spa-'));
    try {
      const rendered = await getRenderedPage(`http://shop.example.test:${port}/redirect`, {
        executablePath,
        safeFetch: guardedFetch,
        timeoutMs: 8000,
        settleMs: 300,
        screenshotPath: path.join(tempDir, 'spa.png'),
      });
      assert.ok(rendered, 'the real browser runtime should return rendered output');
      assert.match(rendered.text, /Rendered content loaded from the safe local fixture/);
      assert.match(rendered.html, /Fixture SPA/);
      assert.equal(new URL(rendered.url).hostname, 'other.example.test', 'the browser should follow the guarded cross-origin redirect');
      assert.ok(rendered.requestsSeen >= 3, 'the document and its script requests should be recorded');
      assert.ok(rendered.bytesFetched > 100);
      assert.ok(rendered.blockedRequests >= 2, 'private-host and POST requests should be denied');
      assert.match(rendered.html, /cross-origin access allowed by the local site fixture/, 'CORS remains functional for an allowed local response');
      assert.deepEqual(state.originsSeen, [`http://other.example.test:${port}`]);
      assert.equal(state.requested.includes('/private'), false, 'the metadata address must never reach the local sink');
      assert.equal(state.requested.includes('/submit'), false, 'the POST request must never reach the local sink');
      assert.deepEqual(state.cookiesForwarded, [null], 'browser cookies are not forwarded by the research transport');
      assert.equal(state.websocketUpgrades, 0, 'WebSockets must not leave the browser context');
      assert.equal(fs.readFileSync(path.join(tempDir, 'spa.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('browser timeout closes the render session and the next local render recovers', async t => {
  const executablePath = await browserExecutable();
  if (!executablePath) return t.skip('No Playwright-compatible Chromium executable is installed on this host.');
  await withLocalSite(async ({ port, state }) => {
    const resolver = async hostname => {
      if (hostname !== 'shop.example.test') throw new Error('unexpected fixture DNS query');
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const safeFetch = createSafeFetcher({ resolver, addressPolicy: address => address === '127.0.0.1' || isPublicAddress(address) });
    const timedOut = await getRenderedPage(`http://shop.example.test:${port}/slow`, {
      executablePath,
      safeFetch,
      timeoutMs: 700,
      settleMs: 0,
    });
    assert.equal(timedOut, null, 'a parser-blocking subresource must stop at the overall render deadline');
    assert.equal(state.slowScriptStarted, true, 'the local fixture actually began the delayed subresource response');
    const recovered = await getRenderedPage(`http://shop.example.test:${port}/spa`, {
      executablePath,
      safeFetch,
      timeoutMs: 8000,
      settleMs: 300,
    });
    assert.ok(recovered, 'a timed-out page must release the browser slot and allow a later render');
    assert.match(recovered.text, /Rendered content loaded from the safe local fixture/);
  });
});

test('render-level request and aggregate byte budgets stop an oversized subresource', async t => {
  const executablePath = await browserExecutable();
  if (!executablePath) return t.skip('No Playwright-compatible Chromium executable is installed on this host.');
  await withLocalSite(async ({ port, state }) => {
    const resolver = async hostname => {
      if (hostname !== 'shop.example.test') throw new Error('unexpected fixture DNS query');
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const safeFetch = createSafeFetcher({ resolver, addressPolicy: address => address === '127.0.0.1' || isPublicAddress(address) });
    const rendered = await getRenderedPage(`http://shop.example.test:${port}/budget`, {
      executablePath,
      safeFetch,
      timeoutMs: 8000,
      maxRequests: 2,
      maxBytes: 1024,
      settleMs: 200,
    });
    assert.ok(rendered, 'the document remains renderable when a child resource is correctly denied');
    assert.equal(rendered.requestsSeen, 2, 'the overall network request cap is enforced');
    assert.ok(rendered.bytesFetched < 1024, 'the oversized content-length is rejected before its body is read');
    assert.ok(rendered.blockedRequests >= 1);
    assert.equal(state.requested.includes('/large.js'), true, 'the browser attempted the oversized local resource through the guard');
  });
});

test('screenshot API produces a real PNG in a caller-owned temporary directory', async t => {
  const executablePath = await browserExecutable();
  if (!executablePath) return t.skip('No Playwright-compatible Chromium executable is installed on this host.');
  await withLocalSite(async ({ port }) => {
    const resolver = async hostname => {
      if (hostname !== 'shop.example.test') throw new Error('unexpected fixture DNS query');
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const safeFetch = createSafeFetcher({ resolver, addressPolicy: address => address === '127.0.0.1' || isPublicAddress(address) });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-ecosys-shot-'));
    try {
      const screenshot = await captureScreenshot({ id: 99173, website_url: `http://shop.example.test:${port}/spa` }, {
        executablePath,
        safeFetch,
        screenshotDir: tempDir,
        timeoutMs: 8000,
        settleMs: 300,
      });
      assert.equal(screenshot, path.join(tempDir, '99173.png'));
      assert.equal(fs.readFileSync(screenshot).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
