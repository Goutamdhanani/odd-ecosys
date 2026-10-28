import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bedrock = { status: 'disabled', enabled: false, modelId: 'us.anthropic.claude-sonnet-5', region: 'us-east-1', credentials: 'not_checked' };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><div id="bedrock-status" role="status" aria-live="polite"><span>checking</span></div><script type="module">import {checkBedrockStatus} from "/js/personalization.js"; window.checkBedrockStatus=checkBedrockStatus; await checkBedrockStatus();</script></body></html>');
    return;
  }
  if (url.pathname === '/api/personalize/status') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ providers: { bedrock } }));
    return;
  }
  const moduleName = url.pathname.match(/^\/js\/(personalization|api|ui)\.js$/)?.[1];
  if (moduleName) {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    fs.createReadStream(path.join(root, 'js', `${moduleName}.js`)).pipe(response);
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('Personalization screen clearly distinguishes disabled Bedrock from enabled-but-unverified', async t => {
  if (!fs.existsSync(EDGE_PATH)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const status = page.locator('#bedrock-status');
    await assert.doesNotReject(status.getByText('Bedrock polish disabled').waitFor());
    assert.match(await status.getAttribute('title'), /disabled in the private personalization configuration/);

    bedrock = { status: 'enabled_unverified', enabled: true, modelId: 'us.anthropic.claude-sonnet-5', region: 'us-east-1', credentials: 'not_checked' };
    await page.evaluate(() => window.checkBedrockStatus());
    await status.getByText('Bedrock enabled · credentials untested').waitFor();
    assert.match(await status.getAttribute('title'), /Credentials are checked only during a provider request/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await page.close();
    await browser.close();
  }
});
