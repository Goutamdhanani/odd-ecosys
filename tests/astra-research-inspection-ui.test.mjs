import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const identityWaiters = [];
let evidenceReads = 0;
let holdInspectionIdentities = false;
const evidenceById = new Map();
const identityFor = evidence => ({ id: `account-${evidence.id}`, normalizedDomain: evidence.normalizedDomain });
const candidateFor = evidence => ({
  id: `candidate-${evidence.id}`, displayValue: `claim-${evidence.id}`, candidateType: 'claim',
  verificationState: 'unverified', evidenceId: evidence.id, contentSha256: evidence.contentSha256,
});
let snapshotNumber = 0;

function evidence(id, domain = `${id}.example.test`) {
  const row = {
    id, documentTitle: `Document ${id}`, normalizedDomain: domain, coverageStatus: 'complete',
    sourceUrl: `https://${domain}/source`, rightsPolicy: 'owned', rightsExpiresAt: null,
    sourceContentUntrusted: true, contentSha256: `sha-${id}`, capturedAt: '2026-10-25T00:00:00.000Z', byteLength: 32,
  };
  evidenceById.set(id, row);
  return row;
}

function heldIdentity() {
  return new Promise(resolve => identityWaiters.push(resolve));
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('Astra evidence inspection keeps only the newest result in its current tenant', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is required for the guarded browser inspection regression.');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type }); res.end(type.includes('json') ? JSON.stringify(body) : body);
    };
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/auth/status') return send(200, { authenticated: true, user: { role: 'owner' } });
      const contextMatch = url.pathname.match(/^\/api\/astra\/tenants\/([^/]+)\/context$/);
      if (contextMatch) return send(200, { tenant: { id: contextMatch[1], name: 'Synthetic UI tenant', role: 'owner', status: 'active' } });
      if (url.pathname.endsWith('/research/snapshots') && req.method === 'POST') {
        const row = evidence(`snapshot-${++snapshotNumber}`, 'same.example.test');
        return send(201, { data: { evidence: row } });
      }
      if (url.pathname.endsWith('/research/evidence') && req.method === 'GET') {
        return send(200, { data: [...evidenceById.values()], count: evidenceById.size });
      }
      if (/\/research\/evidence\/[^/]+$/.test(url.pathname)) {
        evidenceReads++;
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        return send(evidenceById.has(id) ? 200 : 404, evidenceById.has(id) ? { data: evidenceById.get(id) } : { error: 'missing synthetic evidence' });
      }
      if (url.pathname.endsWith('/research/identities') && url.searchParams.has('limit')) {
        if (holdInspectionIdentities && evidenceReads > 0) {
          const resolve = await heldIdentity();
          return send(200, { data: resolve });
        }
        return send(200, { data: [] });
      }
      const candidateMatch = url.pathname.match(/\/research\/identities\/([^/]+)\/candidates$/);
      if (candidateMatch) {
        const accountId = decodeURIComponent(candidateMatch[1]);
        const row = [...evidenceById.values()].find(item => `account-${item.id}` === accountId);
        return send(200, { data: row ? [candidateFor(row)] : [] });
      }
      return send(200, {});
    }
    const relative = url.pathname === '/' ? 'astra.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`) && file !== path.join(root, 'astra.html')) return send(404, 'missing', 'text/plain');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'missing', 'text/plain');
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    send(200, fs.readFileSync(file), type);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem('odd-astra-tenant-id', 'tenant-ui'));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('#tenant-context')?.textContent.includes('Synthetic UI tenant'));

    // The snapshot submit path automatically inspects its saved evidence. Hold both
    // identity responses by request order, then explicitly inspect that exact ID.
    holdInspectionIdentities = true;
    await page.locator('#snapshot-form [name="sourceUrl"]').fill('https://same.example.test/snapshot');
    await page.locator('#snapshot-form [name="rightsPolicy"]').selectOption('synthetic_fixture');
    await page.locator('#snapshot-form [name="rightsAttested"]').check();
    await page.locator('#snapshot-form [name="robotsAllowed"]').check();
    await page.locator('#snapshot-form [name="html"]').fill('<html><title>Synthetic same evidence</title></html>');
    const snapshotResponse = page.waitForResponse(response => response.url().endsWith('/research/snapshots') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Capture immutable snapshot' }).click();
    const saved = await (await snapshotResponse).json();
    const sameId = saved.data.evidence.id;
    await waitFor(() => evidenceReads === 1, `automatic inspection request for ${sameId} did not arrive`);
    await page.locator(`#evidence-list [data-action="inspect-evidence"][data-evidence-id="${sameId}"]`).click();
    await waitFor(() => identityWaiters.length === 2, `both identity requests for evidence ${sameId} were not held`);
    identityWaiters.splice(0, 2).forEach(resolve => resolve([identityFor(evidenceById.get(sameId))]));
    await page.waitForFunction(id => document.querySelector('#research-selected')?.textContent.includes(`Evidence ID ${id}`), sameId);
    assert.equal(await page.locator('#research-selected [data-action="select-account"]').count(), 1, 'same-evidence overlap renders one account action');
    assert.equal(await page.locator('#candidates-list [data-action="select-verification-candidate"]').count(), 1, 'same-evidence overlap renders one candidate');

    // Start A, hold its identity lookup, then let B finish first. A resolves last.
    const evidenceA = evidence('out-of-order-a');
    const evidenceB = evidence('out-of-order-b');
    await page.evaluate(({ a, b }) => {
      const list = document.querySelector('#evidence-list');
      for (const item of [a, b]) {
        const row = document.createElement('div'); row.className = 'record';
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = 'inspect-evidence'; button.dataset.evidenceId = item.id; button.textContent = `Inspect ${item.id}`;
        row.append(button); list.append(row);
      }
    }, { a: evidenceA, b: evidenceB });
    await page.locator('#evidence-list [data-evidence-id="out-of-order-a"]').click();
    await waitFor(() => identityWaiters.length === 1, 'identity request for out-of-order-a was not held');
    await page.locator('#evidence-list [data-evidence-id="out-of-order-b"]').click();
    await waitFor(() => identityWaiters.length === 2, 'identity request for out-of-order-b was not held');
    identityWaiters.splice(1, 1)[0]([identityFor(evidenceB)]);
    await page.waitForFunction(() => document.querySelector('#research-selected')?.textContent.includes('Evidence ID out-of-order-b'));
    identityWaiters.splice(0, 1)[0]([identityFor(evidenceA)]);
    await page.waitForTimeout(50);
    assert.match(await page.locator('#research-selected').innerText(), /Evidence ID out-of-order-b/, 'late A result does not replace selected evidence B');
    assert.doesNotMatch(await page.locator('#research-selected').innerText(), /Evidence ID out-of-order-a|Research account ID account-out-of-order-a/, 'late A result contributes no stale detail');
    assert.equal(await page.locator('#research-selected [data-action="select-account"]').count(), 1, 'current result has one account action');
    assert.equal(await page.locator('#candidates-list [data-action="select-verification-candidate"]').count(), 1, 'current result has one candidate');
    assert.equal(await page.locator('#audit-form [name="evidenceId"]').inputValue(), 'out-of-order-b', 'audit form follows the current evidence');
    assert.equal(await page.locator('#claim-form [name="evidenceId"]').inputValue(), 'out-of-order-b', 'claim form follows the current evidence');

    const noAccountEvidence = evidence('selected-no-account', 'no-account.example.test');
    await page.evaluate(item => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.action = 'inspect-evidence'; button.dataset.evidenceId = item.id; button.textContent = `Inspect ${item.id}`;
      document.querySelector('#evidence-list').append(button);
    }, noAccountEvidence);
    holdInspectionIdentities = false;
    await page.locator('#evidence-list [data-evidence-id="selected-no-account"]').click();
    await page.waitForFunction(() => document.querySelector('#research-selected')?.textContent.includes('Evidence ID selected-no-account'));
    assert.equal(await page.locator('#candidates-list [data-action="select-verification-candidate"]').count(), 0, 'selecting evidence with no matching account clears previous candidates');
    assert.equal(await page.locator('#candidate-count').innerText(), '0 shown', 'candidate count follows evidence with no matching account');
    assert.match(await page.locator('#candidates-list').innerText(), /No candidates extracted from this snapshot\./, 'empty candidate state identifies the selected evidence result');

    const staleTenantEvidence = evidence('tenant-switch-stale');
    await page.evaluate(item => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.action = 'inspect-evidence'; button.dataset.evidenceId = item.id; button.textContent = `Inspect ${item.id}`;
      document.querySelector('#evidence-list').append(button);
    }, staleTenantEvidence);
    holdInspectionIdentities = true;
    await page.locator('#evidence-list [data-evidence-id="tenant-switch-stale"]').click();
    await waitFor(() => identityWaiters.length === 1, 'identity request for tenant-switch-stale was not held');
    holdInspectionIdentities = false;
    await page.locator('#tenant-id').fill('tenant-other');
    await page.locator('#load-tenant').click();
    await page.waitForFunction(() => document.querySelector('#tenant-context')?.textContent.includes('tenant-other'));
    identityWaiters.splice(0, 1)[0]([identityFor(staleTenantEvidence)]);
    await page.waitForTimeout(50);
    assert.match(await page.locator('#research-selected').innerText(), /No evidence selected\./, 'result from the previous tenant remains cleared');
    assert.equal(await page.locator('#audit-form [name="evidenceId"]').inputValue(), '', 'previous-tenant evidence cannot repopulate the audit form');
    assert.equal(await page.locator('#claim-form [name="evidenceId"]').inputValue(), '', 'previous-tenant evidence cannot repopulate the claim form');
    assert.deepEqual(pageErrors, [], 'guarded browser run has no uncaught errors');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Astra inspection errors keep notices current without hiding current failures', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is required for the guarded browser notice regression.');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });

  evidence('stale-error-a');
  evidence('fresh-notice-b');
  evidence('current-error');
  let lastInspectionId = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type }); res.end(type.includes('json') ? JSON.stringify(body) : body);
    };
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/auth/status') return send(200, { authenticated: true, user: { role: 'owner' } });
      const contextMatch = url.pathname.match(/^\/api\/astra\/tenants\/([^/]+)\/context$/);
      if (contextMatch) return send(200, { tenant: { id: contextMatch[1], name: 'Synthetic notice tenant', role: 'owner', status: 'active' } });
      if (url.pathname.endsWith('/research/evidence') && url.searchParams.has('limit')) return send(200, { data: [...evidenceById.values()] });
      const item = url.pathname.match(/^\/api\/astra\/tenants\/[^/]+\/research\/evidence\/([^/]+)$/);
      if (item) {
        lastInspectionId = decodeURIComponent(item[1]);
        const row = evidenceById.get(lastInspectionId);
        return send(row ? 200 : 404, row ? { data: row } : { error: 'missing synthetic evidence' });
      }
      if (url.pathname.endsWith('/research/identities') && url.searchParams.has('limit')) {
        if (lastInspectionId === 'current-error') {
          lastInspectionId = '';
          return send(503, { error: 'current synthetic identity failure' });
        }
        return send(200, { data: [] });
      }
      return send(200, {});
    }
    const relative = url.pathname === '/' ? 'astra.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`) && file !== path.join(root, 'astra.html')) return send(404, 'missing', 'text/plain');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'missing', 'text/plain');
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    send(200, fs.readFileSync(file), type);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem('odd-astra-tenant-id', 'tenant-notice'));
    await page.addInitScript(() => {
      window.__noticeRace = { armed: false, events: [] };
      new MutationObserver(records => {
        const notice = document.querySelector('#notice');
        if (notice && records.some(record => record.target === notice || notice.contains(record.target)))
          window.__noticeRace.events.push({ kind: 'notice-dom', text: notice.textContent || '', className: notice.className || '' });
      }).observe(document, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(input, location.href);
        if (url.pathname.endsWith('/research/evidence/fresh-notice-b')) window.__noticeRace.events.push({ kind: 'B-request-start' });
        if (window.__noticeRace.armed && url.pathname.endsWith('/research/identities') && url.searchParams.has('limit')) {
          window.__noticeRace.armed = false;
          return {
            ok: false,
            status: 503,
            text() {
              return { then(resolve) {
                resolve(JSON.stringify({ error: 'synthetic stale identity failure' }));
                queueMicrotask(() => document.querySelector('[data-evidence-id="fresh-notice-b"]').click());
              } };
            },
          };
        }
        return originalFetch(input, init);
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('#tenant-context')?.textContent.includes('Synthetic notice tenant'));
    await page.waitForLoadState('networkidle');

    assert.equal(await page.locator('#evidence-list [data-evidence-id="stale-error-a"]').count(), 1, 'A uses the app-rendered evidence control');
    assert.equal(await page.locator('#evidence-list [data-evidence-id="fresh-notice-b"]').count(), 1, 'B uses the app-rendered evidence control');
    await page.evaluate(() => { window.__noticeRace.events = []; window.__noticeRace.armed = true; });
    await page.locator('#evidence-list [data-evidence-id="stale-error-a"]').click();
    await page.waitForFunction(() => window.__noticeRace.events.some(item => item.kind === 'B-request-start')
      && document.querySelector('#research-selected')?.textContent.includes('Evidence ID fresh-notice-b'));
    await page.waitForTimeout(40);
    const trace = await page.evaluate(() => window.__noticeRace.events);
    const bRequestIndex = trace.findIndex(item => item.kind === 'B-request-start');
    assert.notEqual(bRequestIndex, -1, 'B request start was observed in the DOM regression');
    assert.equal(trace.slice(bRequestIndex + 1).some(item => item.kind === 'notice-dom' && item.text.includes('synthetic stale identity failure')), false,
      'A failure never changes the notice after B starts');
    assert.match(await page.locator('#notice').innerText(), /Evidence loaded\./, 'the current B success notice remains visible');

    await page.locator('#evidence-list [data-evidence-id="current-error"]').click();
    await page.waitForFunction(() => document.querySelector('#notice')?.textContent.includes('current synthetic identity failure'));
    assert.match(await page.locator('#notice').getAttribute('class'), /notice show error/, 'current inspection failure remains visibly styled as an error');
    assert.deepEqual(pageErrors, [], 'guarded browser notice run has no uncaught errors');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

after(() => { identityWaiters.length = 0; evidenceById.clear(); });
