// Sandboxed screenshot capture and static-JavaScript site rendering.
// All HTTP(S) requests are fetched through the DNS-pinned research guard.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetch } from './ssrf-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'screenshots');
const DEFAULT_RENDER_TIMEOUT_MS = 12_000;
const MAX_RENDER_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REQUESTS = 40;
const MAX_ALLOWED_REQUESTS = 60;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ALLOWED_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_QUEUED_RENDER_JOBS = 3;

let playwrightPromise;
let activeRender = false;
const renderQueue = [];

function boundedInteger(value, fallback, maximum, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(Math.floor(parsed), maximum)) : fallback;
}

function normalizePageUrl(input) {
  let value = typeof input === 'string' ? input.trim() : '';
  if (!value) throw new Error('A website URL is required for browser rendering.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS pages can be rendered.');
  return url.href;
}

async function loadPlaywright() {
  if (!playwrightPromise) {
    playwrightPromise = import('playwright').catch(() => null);
  }
  return playwrightPromise;
}

async function acquireRenderSlot() {
  if (!activeRender) {
    activeRender = true;
    return releaseRenderSlot;
  }
  if (renderQueue.length >= MAX_QUEUED_RENDER_JOBS) throw new Error('Browser render capacity is busy.');
  await new Promise((resolve, reject) => renderQueue.push({ resolve, reject }));
  return releaseRenderSlot;
}

function releaseRenderSlot() {
  const next = renderQueue.shift();
  if (next) next.resolve();
  else activeRender = false;
}

function sanitizeResponseHeaders(headers) {
  const filtered = {};
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
  for (const [name, value] of headers.entries()) {
    if (!hopByHop.has(name.toLowerCase())) filtered[name] = value;
  }
  return filtered;
}

async function renderPage(input, options = {}) {
  const initialUrl = normalizePageUrl(input);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_RENDER_TIMEOUT_MS, MAX_RENDER_TIMEOUT_MS, 500);
  const maxRequests = boundedInteger(options.maxRequests, DEFAULT_MAX_REQUESTS, MAX_ALLOWED_REQUESTS, 1);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, MAX_ALLOWED_BYTES, 1024);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), timeoutMs);
  let browser;
  let context;
  let page;
  let releaseSlot = () => {};
  let requestsSeen = 0;
  let bytesFetched = 0;
  let reservedBytes = 0;
  let blockedRequests = 0;
  let pendingRouteRequests = 0;
  let resolveRouteIdle = () => {};
  let routeIdlePromise = Promise.resolve();

  async function waitForRouteIdle() {
    while (pendingRouteRequests > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      let timer;
      const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(false), remainingMs); });
      const idle = routeIdlePromise.then(() => true);
      const idleReached = await Promise.race([idle, timedOut]);
      clearTimeout(timer);
      if (!idleReached) return false;
    }
    return true;
  }

  try {
    releaseSlot = await acquireRenderSlot();
    if (abortController.signal.aborted) throw new Error('Browser render timed out while waiting for capacity.');
    const playwright = await loadPlaywright();
    if (!playwright?.chromium) return null;
    const executablePath = options.executablePath || process.env.ODD_CHROMIUM_EXECUTABLE_PATH;
    browser = await playwright.chromium.launch({
      headless: true,
      chromiumSandbox: true,
      timeout: Math.min(timeoutMs, 5000),
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-domain-reliability', '--no-first-run'],
      ...(executablePath ? { executablePath } : {}),
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
    });
    if (typeof context.routeWebSocket !== 'function') throw new Error('Browser runtime cannot enforce WebSocket egress blocking.');

    await context.routeWebSocket(() => true, websocket => websocket.close({ code: 1008, reason: 'WebSockets are disabled in isolated research rendering.' }));
    await context.addInitScript(() => {
      const disabled = function DisabledNetworkFeature() {
        throw new DOMException('This API is disabled in isolated research rendering.', 'NotAllowedError');
      };
      for (const feature of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        try { Object.defineProperty(window, feature, { value: disabled, configurable: false }); } catch { /* unavailable in this browser */ }
      }
      try { Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: false }); } catch { /* unavailable in this browser */ }
    });

    const fetcher = options.safeFetch || safeFetch;
    const bootstrapResponses = new Map();
    async function guardedRequest(inputUrl, method, accept, origin) {
      let currentUrl = inputUrl;
      let redirects = 0;
      while (true) {
        const remainingMs = deadline - Date.now();
        const remainingBytes = maxBytes - bytesFetched - reservedBytes;
        if (remainingMs <= 0 || remainingBytes <= 0 || requestsSeen >= maxRequests) throw new Error('Browser render request, byte, or time budget exceeded.');
        const reservation = Math.min(remainingBytes, MAX_RESPONSE_BYTES);
        reservedBytes += reservation;
        requestsSeen += 1;
        let response;
        let body;
        try {
          response = await fetcher(currentUrl, {
            method,
            headers: { 'user-agent': 'OddEcosys-Isolated-Research/1.0', accept, ...(origin ? { origin } : {}) },
            redirect: 'manual',
            timeoutMs: Math.min(remainingMs, 10_000),
            maxBytes: reservation,
            maxRedirects: 0,
            signal: abortController.signal,
          });
          body = Buffer.from(await response.arrayBuffer());
          if (bytesFetched + body.length > maxBytes) throw new Error('Browser render byte budget exceeded.');
          bytesFetched += body.length;
        } finally {
          reservedBytes -= reservation;
        }
        const location = response.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) return { response, body, url: currentUrl };
        if (redirects >= 4) throw new Error('Browser render redirect limit exceeded.');
        currentUrl = new URL(location, currentUrl).href;
        redirects += 1;
      }
    }

    const bootstrap = await guardedRequest(initialUrl, 'GET', 'text/html,application/xhtml+xml');
    bootstrapResponses.set(bootstrap.url, bootstrap);
    await context.route(() => true, async route => {
      if (pendingRouteRequests === 0) routeIdlePromise = new Promise(resolve => { resolveRouteIdle = resolve; });
      pendingRouteRequests += 1;
      try {
        const request = route.request();
        const method = request.method().toUpperCase();
        let target;
        try { target = new URL(request.url()); } catch { target = null; }
        if (!target || !['http:', 'https:'].includes(target.protocol) || !['GET', 'HEAD'].includes(method)) {
          blockedRequests += 1;
          await route.abort('blockedbyclient').catch(() => {});
          return;
        }
        let guarded = bootstrapResponses.get(target.href);
        if (guarded) bootstrapResponses.delete(target.href);
        else {
          const browserHeaders = request.headers();
          guarded = await guardedRequest(target.href, method, browserHeaders.accept || '*/*', browserHeaders.origin);
        }
        const headers = sanitizeResponseHeaders(guarded.response.headers);
        const requestOrigin = request.headers().origin;
        if (requestOrigin && guarded.url !== target.href && new URL(guarded.url).origin !== target.origin) {
          const allowedOrigin = guarded.response.headers.get('access-control-allow-origin');
          if (allowedOrigin !== '*' && allowedOrigin !== requestOrigin) headers['access-control-allow-origin'] = 'https://blocked-redirect.invalid';
        }
        await route.fulfill({
          status: guarded.response.status,
          headers,
          body: guarded.body,
        });
      } catch {
        blockedRequests += 1;
        await route.abort('blockedbyclient').catch(() => {});
      } finally {
        pendingRouteRequests -= 1;
        if (pendingRouteRequests === 0) resolveRouteIdle();
      }
    });

    page = await context.newPage();
    context.on('page', popup => {
      if (popup !== page) popup.close().catch(() => {});
    });
    await page.goto(bootstrap.url, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
    const settleMs = boundedInteger(options.settleMs, 200, 1000, 0);
    if (settleMs) await page.waitForTimeout(Math.min(settleMs, Math.max(0, deadline - Date.now())));
    if (!await waitForRouteIdle()) throw new Error('Browser render did not finish network activity before its deadline.');
    if (Date.now() >= deadline || abortController.signal.aborted) throw new Error('Browser render timed out.');

    const pageData = await page.evaluate(maxChars => ({
      html: document.documentElement?.outerHTML?.slice(0, maxChars) || '',
      text: document.body?.innerText?.slice(0, maxChars) || '',
    }), MAX_OUTPUT_CHARS);
    let screenshotPath = null;
    if (options.screenshotPath) {
      try {
        await fs.promises.mkdir(path.dirname(options.screenshotPath), { recursive: true });
        await page.screenshot({ path: options.screenshotPath, fullPage: false, timeout: Math.max(1, deadline - Date.now()) });
        screenshotPath = options.screenshotPath;
      } catch { /* screenshot failure must not discard a successfully rendered DOM */ }
    }
    return {
      ...pageData,
      url: page.url(),
      requestsSeen,
      bytesFetched,
      blockedRequests,
      screenshotPath,
      renderedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(abortTimer);
    abortController.abort();
    try { await context?.close(); } catch { /* release browser resources even when a page crashed */ }
    try { await browser?.close(); } catch { /* close is best effort after a crashed browser */ }
    releaseSlot();
  }
}

/**
 * Get the expected screenshot path for a lead.
 * @param {number} leadId
 * @returns {string} Absolute path to screenshot file
 */
export function getScreenshotPath(leadId) {
  return path.join(SCREENSHOTS_DIR, `${leadId}.png`);
}

/**
 * Capture a bounded screenshot using isolated Chromium and guarded HTTP(S) egress.
 * @param {{id: number, website_url?: string}} lead
 * @param {{screenshotDir?: string, timeoutMs?: number, safeFetch?: Function, executablePath?: string}} options
 * @returns {Promise<string|null>}
 */
export async function captureScreenshot(lead, options = {}) {
  if (!lead?.website_url || !Number.isSafeInteger(Number(lead.id))) return null;
  const outputPath = path.join(options.screenshotDir || SCREENSHOTS_DIR, `${Number(lead.id)}.png`);
  if (fs.existsSync(outputPath)) return outputPath;
  try {
    const rendered = await renderPage(lead.website_url, { ...options, screenshotPath: outputPath });
    return rendered?.screenshotPath || null;
  } catch {
    return null;
  }
}

/**
 * Render an SPA in an isolated browser context. Network requests are intercepted
 * and fetched only by the DNS-pinned, redirect-safe research fetcher.
 * @param {string} url
 * @param {{timeoutMs?: number, maxRequests?: number, maxBytes?: number, settleMs?: number, safeFetch?: Function, executablePath?: string}} options
 * @returns {Promise<{html: string, text: string, url: string, requestsSeen: number, bytesFetched: number, blockedRequests: number}|null>}
 */
export async function getRenderedPage(url, options = {}) {
  try {
    return await renderPage(url, options);
  } catch {
    return null;
  }
}
