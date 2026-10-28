import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tenantId = '11000000-0000-4000-8000-000000000011';
const campaignId = '22000000-0000-4000-8000-000000000022';
let browser;
let server;

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test('campaign review shows persisted copy, gates versioned approval, and requires explicit refresh after stale conflict', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  await import('./support/astra-qa-egress-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const files = new Map([
      ['/growth.html', ['growth.html', 'text/html; charset=utf-8']],
      ['/css/main.css', ['css/main.css', 'text/css']],
      ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css']],
      ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript']],
      ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript']],
    ]);
    const file = files.get(pathname);
    if (!file) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8`, 'cache-control': 'no-store' });
    fs.createReadStream(path.join(root, file[0])).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.setDefaultTimeout(8000);
  const reviewReads = [];
  const approvalPosts = [];
  let reviewVersion = 7;
  page.on('pageerror', error => { throw error; });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (pathname === '/api/astra/workspaces') return json({ workspaces: [{ id: tenantId, name: 'Review fixture', role: 'owner', status: 'active' }, { id: '33000000-0000-4000-8000-000000000033', name: 'Second fixture', role: 'reviewer', status: 'active' }], capabilities: {}, releaseReady: false });
    if (pathname.endsWith('/context')) { const second = pathname.includes('33000000-0000-4000-8000-000000000033'); return json({ tenant: { id: second ? '33000000-0000-4000-8000-000000000033' : tenantId, name: second ? 'Second fixture' : 'Review fixture', status: 'active', role: second ? 'reviewer' : 'owner' } }); }
    if (pathname.endsWith('/campaigns') && req.method() === 'GET') return json({ items: [{ id: campaignId, name: 'Synthetic review', state: 'draft', purpose: 'Review fixture', offerVersionId: 15, createdAt: '2026-01-01T00:00:00Z' }] });
    if (pathname.endsWith(`/campaigns/${campaignId}/review`)) {
      reviewReads.push(reviewVersion);
      return json({ review: {
        campaignId, version: reviewVersion, copyVersion: 3,
        copy: { subject: reviewVersion === 7 ? 'Persisted subject v7' : 'Persisted subject v8', body: reviewVersion === 7 ? 'Persisted body v7' : 'Persisted body v8', validation: { status: 'verified', eligible: true, reasons: ['current_source_proof_present'] } },
        offer: { versionId: 15, contentHash: 'synthetic-hash', snapshot: { service: 'Web design', price: { minMinor: 12500, maxMinor: 25000, currency: 'USD' }, geography: { includedCountries: ['CA'], excludedCountries: [] } }, current: true, blockers: [] },
        mailbox: { id: 'manual-fixture', provider: 'manual', configurationStatus: 'manual_only', capabilityEvidence: { receive: 'manual_ingest_only', send: 'disabled' } },
        audience: { rows: [{ status: 'fit' }, { status: 'blocked', reasons: ['missing_evidence'] }], count: 2, fitCount: 1, blockedCount: 1 },
        limits: { purpose: 'Review fixture', geography: { includedCountries: ['CA'], excludedCountries: [] }, scheduleAt: null, spendLimitMinor: 2500, currency: 'USD', approvedOfferCapacity: 4, approvedPrice: { minMinor: 12500, maxMinor: 25000, currency: 'USD' } },
        approval: { ready: true, blockers: [], current: null },
        delivery: { ready: false, recipientChecks: 'not_evaluated_in_review', blockers: ['mailbox_send_disabled', 'live_delivery_disabled', 'recipient_permission_and_verification_not_evaluated'] },
      } });
    }
    if (pathname.endsWith(`/campaigns/${campaignId}/approvals`) && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}'); approvalPosts.push(body);
      return json({ error: 'Campaign version changed. Refresh the review before approving.' }, 409);
    }
    if (pathname.endsWith(`/campaigns/${campaignId}/composer`)) return json({ composer: { campaignId, version: 4, subject: 'Persisted subject v7', body: 'Persisted body v7', templates: [], validation: { status: 'verified', eligible: true, reasons: [] } } });
    if (pathname.endsWith(`/campaigns/${campaignId}`)) return json({ campaign: { id: campaignId, name: 'Synthetic review', state: 'draft', purpose: 'Review fixture', currency: 'USD', subject: 'Persisted subject v7', audience: [] }, approvals: [], dispatchPlans: [] });
    if (pathname.endsWith('/offers')) return json({ offers: [] });
    if (pathname.endsWith('/mailboxes')) return json({ items: [] });
    if (pathname.endsWith('/research/evidence?limit=100') || pathname.endsWith('/research/identities?limit=100') || pathname.endsWith('/research/claims?limit=100') || pathname.endsWith('/inbox/messages?limit=100') || pathname.endsWith('/outcomes?limit=100') || pathname.endsWith('/crm/mappings') || pathname.endsWith('/crm/outbox?limit=100')) return json({ items: [], data: [] });
    if (pathname.endsWith('/analytics/funnel')) return json({ data: { funnel: {} } });
    return json({});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/growth.html`);
  await page.getByRole('heading', { name: 'Good to see you, Review fixture.' }).waitFor();
  await page.getByRole('tab', { name: 'Campaigns' }).click();
  await page.locator('#campaign-select').selectOption(campaignId);
  await page.waitForFunction(() => document.querySelector('#draft-form')?.elements.subject.value === 'Persisted subject v7');
  await page.locator('#copy-editor-disclosure summary').click();
  const approve = page.locator('#approval-form [type="submit"]');
  assert.equal(await approve.isDisabled(), true, 'approval remains disabled before the user loads a saved review');
  assert.equal(reviewReads.length, 0, 'campaign selection does not silently fetch a review');
  await page.getByRole('button', { name: 'Load review' }).click();
  await page.getByText('Approval ready · campaign version 7 · copy version 3.', { exact: false }).waitFor();
  assert.equal(await page.locator('[aria-label="Persisted subject"]').textContent(), 'Persisted subject v7');
  assert.equal(await page.locator('[aria-label="Persisted body"]').textContent(), 'Persisted body v7');
  await page.getByText('Fit', { exact: true }).waitFor();
  await page.getByText('mailbox send disabled', { exact: false }).waitFor();
  assert.equal(await approve.isDisabled(), false, 'ready review of the saved editor version enables approval');
  await page.locator('#approval-form').evaluate(form => { form.closest('details').open = true; });
  await page.locator('#approval-form [name="expiresAt"]').fill('2099-12-31');
  await approve.click();
  await page.getByText('saved version changed after this review', { exact: false }).waitFor();
  assert.deepEqual(approvalPosts, [{ expectedVersion: 7, expiresAt: '2099-12-31T23:59:59.000Z' }]);
  assert.equal(reviewReads.length, 1, 'a 409 does not fetch and approve a newer review automatically');
  assert.equal(await approve.isDisabled(), true, 'stale review cannot be submitted again');
  assert.equal(await page.locator('#draft-form [name="subject"]').inputValue(), 'Persisted subject v7', 'editor contents remain intact after stale conflict');
  reviewVersion = 8;
  await page.getByRole('button', { name: 'Refresh review' }).click();
  await page.locator('[aria-label="Persisted subject"]').getByText('Persisted subject v8').waitFor();
  assert.equal(reviewReads.length, 2, 'new version is shown only after explicit refresh');
  await page.locator('#draft-form [name="subject"]').fill('unsaved editor text');
  assert.equal(await page.locator('#campaign-review-content').isHidden(), true, 'unsaved edits clear the prior saved-copy preview');
  assert.equal(await approve.isDisabled(), true, 'unsaved edits disable approval');
  assert.equal(reviewReads.length, 2, 'dirty edits do not auto-refresh the review');
  assert.equal(await page.locator('#campaign-review-status').textContent(), 'The editor has unsaved changes. Load a review again after saving the exact copy you want reviewed.');
  await page.getByRole('button', { name: 'Refresh review' }).click();
  await page.locator('[aria-label="Persisted subject"]').getByText('Persisted subject v8').waitFor();
  assert.equal(reviewReads.length, 3);
  await page.locator('#workspace-select').selectOption('33000000-0000-4000-8000-000000000033');
  await page.getByRole('heading', { name: 'Good to see you, Second fixture.' }).waitFor();
  assert.equal(await page.locator('#campaign-review-content').isHidden(), true, 'workspace changes clear the previously shown copy preview');
  assert.equal(await approve.isDisabled(), true, 'workspace changes keep approval gated');
  assert.equal(reviewReads.length, 3, 'workspace changes do not refresh or expose a saved review automatically');
});
