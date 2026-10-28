import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installLoopbackBrowserGuard, isLoopbackBrowserUrl } from './support/loopback-browser-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('browser guard admits only literal loopback HTTP(S) and preserves test-owned route fulfillment', async () => {
  assert.equal(isLoopbackBrowserUrl('http://localhost:3000/login'), true);
  assert.equal(isLoopbackBrowserUrl('https://127.0.0.1:8443/'), true);
  assert.equal(isLoopbackBrowserUrl('http://[::1]:3000/'), true);
  for (const url of ['http://example.test/', 'https://127.0.0.2/', 'file:///tmp/page', 'data:text/plain,x']) {
    assert.equal(isLoopbackBrowserUrl(url), false, url);
  }

  const routes = [];
  const context = {
    async route(pattern, handler) { routes.push({ pattern, handler }); },
    async newPage() { return { on() {}, marker: 'page' }; },
  };
  const browser = {
    async newContext() { return context; },
    async newPage() { throw new Error('newPage must route through a guarded context'); },
  };
  const chromium = {
    async launch(options) { assert.equal(options.chromiumSandbox, true); return browser; },
  };
  installLoopbackBrowserGuard({ chromium });
  const launched = await chromium.launch({ chromiumSandbox: true });
  const page = await launched.newPage();
  assert.equal(page.marker, 'page');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, '**/*');
  const result = [];
  await routes[0].handler({
    request: () => ({ url: () => 'https://accounts.google.com/gsi/client' }),
    abort: async code => result.push(`guard:${code}`),
    continue: async () => result.push('continue'),
  });
  assert.deepEqual(result, ['guard:blockedbyclient']);
  await routes[0].handler({
    request: () => ({ url: () => 'http://127.0.0.1:3000/api/login' }),
    abort: async code => result.push(`guard:${code}`),
    continue: async () => result.push('continue'),
  });
  assert.equal(result.at(-1), 'continue');
});

test('real delivery UI fixture aborts remote font transport before local DOMContentLoaded', t => {
  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!existsSync(edgePath)) return t.skip('Microsoft Edge is unavailable on this host.');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'odd-qa-browser-guard-'));
  try {
    const tracePath = path.join(scratch, 'browser-guard-trace.json');
    const guardUrl = pathToFileURL(path.join(root, 'tests/support/astra-qa-egress-guard.mjs')).href;
    const fixturePath = path.join(root, 'tests/delivery-reports-ui.test.mjs');
    const cleanEnv = { ...process.env, ASTRA_QA_BROWSER_GUARD_TRACE: tracePath };
    delete cleanEnv.NODE_OPTIONS;
    delete cleanEnv.NODE_PATH;
    for (const key of Object.keys(cleanEnv)) {
      if (/^(?:GOOGLE|OPENAI|ANTHROPIC|AWS|AZURE|DATABASE_URL|SMTP|MAIL|TOKEN|SECRET|API_KEY)/i.test(key)) delete cleanEnv[key];
    }
    const child = spawnSync(process.execPath, [`--import=${guardUrl}`, fixturePath], {
      cwd: root, env: cleanEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const fontBlock = trace.find(item => item.type === 'blocked'
      && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(item.host));
    const localDocument = trace.find(item => item.type === 'domcontentloaded'
      && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):/.test(item.url));
    assert.ok(fontBlock, `expected remote font request abort; observed ${JSON.stringify(trace)}`);
    assert.ok(localDocument, `expected local app DOMContentLoaded; observed ${JSON.stringify(trace)}`);
    assert.ok(fontBlock.sequence < localDocument.sequence,
      `font request must abort before DOMContentLoaded: ${JSON.stringify(trace)}`);
    assert.match(child.stderr, /\[qa-browser-egress-guard\] aborted external browser request to fonts\./);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
