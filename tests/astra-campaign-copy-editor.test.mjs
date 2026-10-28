import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignCopyForEditor, isCampaignLoadCurrent } from '../js/astra-campaign-draft.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const future = new Date(Date.now() + 60_000).toISOString();
test('campaign switching and workspace epochs fence stale detail responses', () => {
  const requestScope = { tenantId: 'workspace-a', epoch: 4 };
  assert.equal(isCampaignLoadCurrent(requestScope, requestScope, 'campaign-a', 'campaign-a'), true);
  assert.equal(isCampaignLoadCurrent(requestScope, { tenantId: 'workspace-b', epoch: 5 }, 'campaign-a', 'campaign-a'), false);
  assert.equal(isCampaignLoadCurrent(requestScope, requestScope, 'campaign-b', 'campaign-a'), false);
});

test('saved subject and body hydrate the editor on campaign selection', () => {
  assert.deepEqual(campaignCopyForEditor({ subject: 'Saved subject', body: 'Saved body.' }), {
    subject: 'Saved subject', body: 'Saved body.',
  });
  assert.deepEqual(campaignCopyForEditor({ subject: null, body: null }), { subject: '', body: '' });
});

test('workspace switch clears rendered fact links and unsaved copy before context resolves', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is required for the guarded campaign editor DOM regression.');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });
  const ids = { a: '10000000-0000-4000-8000-000000000001', b: '20000000-0000-4000-8000-000000000002', campaign: '60000000-0000-4000-8000-000000000006' };
  let releaseContext;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const file = path.resolve(root, pathname === '/' ? 'growth.html' : `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('missing'); return; }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(7000);
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()); const path = url.pathname;
      const tenant = path.includes(ids.b) ? ids.b : ids.a;
      const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (path === '/api/astra/workspaces') return json({ workspaces: [{ id: ids.a, name: 'Dental', role: 'owner', status: 'active' }, { id: ids.b, name: 'Other', role: 'owner', status: 'active' }] });
      if (path.endsWith('/context')) {
        if (tenant === ids.b) await new Promise(resolve => { releaseContext = resolve; });
        return json({ tenant: { id: tenant, name: tenant === ids.a ? 'Dental' : 'Other', status: 'active', role: 'owner' } });
      }
      if (path.endsWith('/research/claims')) return json({ data: tenant === ids.a ? [{
        id: '90000000-0000-4000-8000-000000000009', predicate: 'industry', value: 'Dental Clinic', currentValue: 'Dental Clinic',
        status: 'supported', currentClaimStatus: 'supported', currentClaimBlockers: [], expiresAt: future,
        currentProof: { sourceUrl: 'https://manya.example/about', domain: 'manya.example', exactExcerpt: 'Dental Clinic' },
      }] : [] });
      if (path.endsWith('/campaigns') && route.request().method() === 'GET') return json({ items: tenant === ids.a ? [{ id: ids.campaign, name: 'Dental campaign', state: 'draft' }] : [] });
      if (path.endsWith('/composer')) return json({ composer: { campaignId: ids.campaign, version: 1, copyVersion: 0, subject: '', body: '', validation: { status: 'unverified', eligible: false, reasons: ['no_saved_copy'] }, templates: tenant === ids.a ? [{ templateId: 'body:dental-v1', claimId: '90000000-0000-4000-8000-000000000009', renderedText: 'Your page lists Dental Clinic.', placement: 'body', businessDomain: 'manya.example', source: { url: 'https://manya.example/about', hash: 'abc123', expiresAt: future, exactExcerpt: 'Dental Clinic' } }] : [] } });
      if (path.endsWith(`/campaigns/${ids.campaign}`)) return json({ campaign: { id: ids.campaign, name: 'Dental campaign', state: 'draft', subject: null, body: null,
        audience: [{ accountId: 'account-a', domain: 'manya.example', status: 'fit', reasons: [] }] }, approvals: [], dispatchPlans: [] });
      return json({ data: [], items: [], offers: [], results: [] });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/growth.html#campaigns`);
    await page.waitForFunction(id => document.querySelector('#workspace-select')?.value === id, ids.a);
    await page.waitForFunction(id => [...document.querySelector('#campaign-select').options].some(option => option.value === id), ids.campaign);
    await page.locator('#campaign-select').selectOption(ids.campaign);
    await page.locator('#copy-editor-disclosure > summary').click();
    await page.waitForFunction(() => document.querySelectorAll('#draft-fact-picker .draft-fact').length === 1);
    await page.waitForFunction(() => document.querySelector('#draft-support-status')?.textContent.includes('Service marks this saved copy unverified'));
    assert.match(await page.locator('#draft-support-status').innerText(), /no saved copy/i);
    await page.locator('#draft-form [name="subject"]').fill('Dental Clinic');
    await page.locator('#draft-form [name="body"]').fill('Your website lists Dental Clinic.');
    await page.locator('#workspace-select').selectOption(ids.b);
    await page.waitForFunction(() => document.querySelector('#draft-fact-picker')?.textContent.includes('Choose a campaign')
      || document.querySelector('#draft-fact-picker')?.textContent.includes('No current templates'));
    assert.equal(await page.locator('#draft-fact-picker .draft-fact').count(), 0);
    assert.equal(await page.locator('#draft-fact-picker').evaluate(element => element.innerHTML.includes('manya.example')), false);
    assert.equal(await page.locator('#draft-form [name="subject"]').inputValue(), '');
    assert.equal(await page.locator('#draft-form [name="body"]').inputValue(), '');
    assert.equal(await page.locator('#draft-form [type="submit"]').isDisabled(), true);
    assert.equal(await page.locator('#draft-insert-facts').isDisabled(), true);
  } finally {
    releaseContext?.(); await browser.close(); await new Promise(resolve => server.close(resolve));
  }
});
