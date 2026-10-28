import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ids = { a: '10000000-0000-4000-8000-000000000001', b: '20000000-0000-4000-8000-000000000002', c: '90000000-0000-4000-8000-000000000009' };
let browser;
let server;
let releaseA;
let releaseAudit;
let holdNextAudit = false;
let failBStatus = false;
const failedResources = new Set();
let recordFixture = { evidence: [], accounts: [], claims: [], campaigns: [], offers: [], mailboxes: [], outcomes: [] };

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test('Discover leads with real availability, two direct choices, and tenant-safe status', async t => {
  try { await fs.access(edgePath); } catch { return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.'); }
  const { chromium } = await import('playwright');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method;
    const reply = (status, value, type = 'application/json') => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    if (url.pathname === '/api/astra/workspaces') return reply(200, { workspaces: [{ id: ids.a, name: 'North Studio', role: 'owner' }, { id: ids.b, name: 'South Studio', role: 'owner' }, { id: ids.c, name: 'View only', role: 'reviewer' }] });
    const context = url.pathname.match(/^\/api\/astra\/tenants\/([^/]+)\/context$/);
    if (context) return reply(200, { tenant: { id: context[1], name: context[1] === ids.a ? 'North Studio' : context[1] === ids.b ? 'South Studio' : 'View only', status: 'active' } });
    const status = url.pathname.match(/^\/api\/astra\/tenants\/([^/]+)\/prospecting\/status$/);
    if (status && status[1] === ids.a) {
      await new Promise(resolve => { releaseA = resolve; });
      return reply(200, { prospecting: { ready: true } });
    }
    if (status && failBStatus) return reply(503, { error: 'Prospecting status is temporarily unavailable.' });
    if (status) return reply(200, { prospecting: { ready: false, reason: 'Waiting for coordinator approval.' } });
    for (const resource of failedResources) if (url.pathname.endsWith(`/${resource}`)) return reply(503, { error: `${resource} records are temporarily unavailable.` });
    if (url.pathname.endsWith('/research/evidence')) return reply(200, { data: recordFixture.evidence });
    if (url.pathname.endsWith('/research/identities')) return reply(200, { data: recordFixture.accounts });
    if (url.pathname.endsWith('/research/claims')) return reply(200, { data: recordFixture.claims });
    if (url.pathname.endsWith('/campaigns')) return reply(200, { items: recordFixture.campaigns });
    if (url.pathname.endsWith('/offers') && !url.pathname.split('/').filter(Boolean).at(-1)?.match(/^\d+$/)) return reply(200, { offers: recordFixture.offers });
    if (url.pathname.endsWith('/mailboxes')) return reply(200, { items: recordFixture.mailboxes });
    if (url.pathname.endsWith('/outcomes')) return reply(200, { data: recordFixture.outcomes });
    if (url.pathname.endsWith('/research/snapshots') && method === 'POST') return reply(201, { data: {
      evidence: { id: '30000000-0000-4000-8000-000000000003', sourceUrl: 'https://synthetic.example/about', documentTitle: 'About our studio', contentSha256: 'a'.repeat(64), sourceRightsStatus: 'revoked', rightsRevokedAt: '2026-10-26T08:00:00.000Z' },
      account: { id: '40000000-0000-4000-8000-000000000004', displayDomain: 'synthetic.example', normalizedDomain: 'synthetic.example' },
      candidates: [],
    } });
    if (url.pathname.endsWith('/research/audits') && method === 'POST') {
      if (holdNextAudit) { holdNextAudit = false; await new Promise(resolve => { releaseAudit = resolve; }); }
      return reply(201, { data: {
      id: '50000000-0000-4000-8000-000000000005', auditVersion: 'internal-version', coverageStatus: 'partial',
      sourceCoverage: { captured_page_count: 2, pages: [
        { id: '30000000-0000-4000-8000-000000000003', title: 'About our studio', sourceUrl: 'https://synthetic.example/about', capturedAt: '2026-10-27T09:00:00.000Z', sourceRightsStatus: 'revoked', rightsRevokedAt: '2026-10-26T08:00:00.000Z' },
        { id: '31000000-0000-4000-8000-000000000003', title: 'About uppercase path', sourceUrl: 'https://synthetic.example/About', capturedAt: '2026-10-27T09:30:00.000Z', sourceRightsStatus: 'expired', rightsExpiresAt: '2026-10-25T23:59:59.000Z' },
      ] },
      findings: [
        { signal: 'document_title', outcome: 'observed', detail: 'About our studio' },
        { signal: 'primary_service', outcome: 'observed', detail: 'Website design' },
        { signal: 'service_area', outcome: 'observed', detail: 'North America' },
        { signal: 'business_name', outcome: 'observed', detail: 'Synthetic Studio' },
        { signal: 'contact_page', outcome: 'observed', detail: 'Not captured in the supplied page' },
        { signal: 'pricing_page', outcome: 'unknown', detail: 'Not inspected' },
        { signal: 'accessibility', outcome: 'unknown', detail: 'Not measured' },
        { signal: 'performance', outcome: 'unknown', detail: 'Not measured' },
        { signal: 'analytics', outcome: 'unknown', detail: 'Not observed' },
        { signal: 'conversion_flow', outcome: 'unknown', detail: 'Not inspected' },
      ],
      opportunities: [
        { id: 'op-1', title: 'Review pricing page coverage' },
        { id: 'op-2', title: 'Review accessibility details' },
        { id: 'op-3', title: 'Review page performance' },
        { id: 'op-4', title: 'Review contact options' },
        { id: 'op-5', title: 'Review analytics coverage' },
        { id: 'op-6', title: 'Review conversion flow' },
      ],
    } });
    }
    if (url.pathname === '/growth.html') return reply(200, await fs.readFile(path.join(root, 'growth.html'), 'utf8'), 'text/html; charset=utf-8');
    const files = new Map([
      ['/css/main.css', ['css/main.css', 'text/css']],
      ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css']],
      ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript']],
      ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript']],
    ]);
    const file = files.get(url.pathname);
    if (file) return reply(200, await fs.readFile(path.join(root, file[0]), 'utf8'), file[1]);
    if (url.pathname.startsWith('/api/astra/tenants/')) return reply(200, { data: [], items: [], offers: [], jobs: [], contacts: [] });
    return reply(404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const statusRequest = page.waitForRequest(request => request.url().includes(`/tenants/${ids.a}/prospecting/status`));
  await page.goto(`http://127.0.0.1:${server.address().port}/growth.html`);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  await statusRequest;
  assert.equal(await page.locator('#prospecting-form [type="submit"]').isDisabled(), true, 'checking never enables public prospecting');

  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.locator('#prospecting-status[data-state="paused"]').getByText(/Public research is paused/).waitFor();
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  assert.equal(await page.locator('#prospecting-form [type="submit"]').isDisabled(), true, 'a false ready value disables the start action');
  assert.equal(await page.locator('#prospecting-research-details').evaluate(node => node.open), false, 'public prospecting inputs stay behind a collapsed disclosure');
  await page.getByText('No research job has been saved in this workspace yet.').waitFor();
  const summaryBeforeForm = await page.locator('#prospecting-status').evaluate((status, form) => Boolean(status.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING), await page.locator('#prospecting-form').elementHandle());
  assert.equal(summaryBeforeForm, true, 'availability is presented before the research form');

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByText('0 of 5 saved').waitFor();
  await page.getByRole('button', { name: 'Analyze a page' }).click();
  await page.locator('#view-discover:not([hidden])').waitFor();
  await page.waitForFunction(() => document.querySelector('#snapshot-form input[name="sourceUrl"]') === document.activeElement);

  recordFixture = {
    evidence: [{ id: '30000000-0000-4000-8000-000000000003', sourceUrl: 'https://synthetic.example/about', documentTitle: 'About' }],
    accounts: [{ id: '40000000-0000-4000-8000-000000000004', displayDomain: 'synthetic.example', normalizedDomain: 'synthetic.example' }],
    claims: [{ id: '50000000-0000-4000-8000-000000000005', status: 'supported', predicate: 'industry', currentValue: 'Design' }],
    campaigns: [{ id: '60000000-0000-4000-8000-000000000006', name: 'Synthetic draft', state: 'draft' }],
    offers: [{ id: 91, name: 'Synthetic offer', latest_status: 'approved', latest_version_id: 92, latest_version: 1 }],
    mailboxes: [{ id: '70000000-0000-4000-8000-000000000007', displayName: 'Manual inbox', provider: 'manual' }],
    outcomes: [{ id: '80000000-0000-4000-8000-000000000008', stage: 'meeting_booked' }],
  };
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Refresh workspace data' }).click();
  await page.getByText('5 of 5 saved').waitFor();
  await page.getByText(/An observed outcome is saved/).waitFor();
  failedResources.add('outcomes');
  await page.getByRole('button', { name: 'Refresh workspace data' }).click();
  await page.locator('#first-success-steps li[data-state="unavailable"]').getByText('Observed outcome').waitFor();
  assert.equal(await page.locator('#first-success-progress').innerText(), '4 of 5 saved', 'an unreadable outcome resource is not shown as complete');
  assert.equal(await page.locator('#first-success-next button').innerText(), 'Refresh workspace data', 'the next action is refresh when its saved state cannot be read');
  failedResources.delete('outcomes');

  releaseA?.();
  await page.waitForTimeout(80);
  assert.match(await page.locator('#prospecting-status').innerText(), /Public research is paused/);
  assert.equal(await page.locator('#prospecting-form [type="submit"]').isDisabled(), true, 'a late ready response from the prior workspace cannot enable prospecting');

  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByRole('button', { name: 'Analyze a page' }).click();
  await page.locator('#snapshot-form input[name="sourceUrl"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#snapshot-form input[name="sourceUrl"]') === document.activeElement);
  assert.equal(await page.locator('#snapshot-form input[name="sourceUrl"]').evaluate(node => node === document.activeElement), true, 'page analysis opens and focuses the existing snapshot form');
  await page.getByLabel('Website address').fill('https://synthetic.example/about');
  await page.getByLabel('HTML page export').setInputFiles({ name: 'about.html', mimeType: 'text/html', buffer: Buffer.from('<html><title>About our studio</title><h1>Our work</h1></html>') });
  await page.getByLabel('Why can this page be used?').selectOption('user_provided');
  await page.getByLabel(/I have permission to provide this page/).check();
  await page.getByLabel(/I checked the site’s robots rules/).check();
  await page.getByRole('button', { name: 'Save page and create report' }).click();
  const report = page.locator('#snapshot-result');
  await report.getByText('Source coverage · 2 pages captured').waitFor();
  await page.waitForFunction(() => document.querySelector('#snapshot-result') === document.activeElement);
  const reportTop = await report.evaluate(node => node.getBoundingClientRect().top);
  assert.ok(reportTop >= 0 && reportTop < 300, `successful page analysis scrolls the report into view (top ${reportTop})`);
  const reportLayout = await report.evaluate(node => {
    const tasks = document.querySelector('#view-discover .discovery-grid');
    return { sameParent: node.parentElement === tasks.parentElement, reportWidth: node.getBoundingClientRect().width, taskWidth: tasks.getBoundingClientRect().width };
  });
  assert.equal(reportLayout.sameParent, true, 'the saved report sits beneath the two task cards');
  assert.ok(reportLayout.reportWidth >= reportLayout.taskWidth - 2, `the completed report uses the full Discover content width: ${JSON.stringify(reportLayout)}`);
  const reportText = await report.innerText();
  assert.match(reportText, /About our studio/);
  assert.match(reportText, /https:\/\/synthetic\.example\/about/);
  assert.match(reportText, /Captured .*2026/);
  assert.match(reportText, /Source review expired/);
  assert.equal((reportText.match(/synthetic\.example\/about/g) || []).length, 1, 'the same evidence source is shown once');
  assert.match(reportText, /Source use revoked/ , 'a source-rights warning remains visible outside collapsed details');
  assert.doesNotMatch(reportText, /internal-version|contentSha256|30000000-0000|50000000-0000|\{"|[a-f0-9]{64}/i, 'customer report omits internal versions, IDs, hashes, and JSON');
  const observationsLead = await report.evaluate(node => {
    const observations = [...node.querySelectorAll('h4')].find(item => item.textContent.startsWith('What the page showed'));
    const opportunities = node.querySelector('.report-opportunities');
    return Boolean(observations && opportunities && (observations.compareDocumentPosition(opportunities) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  assert.equal(observationsLead, true, 'observations lead the report before opportunities');
  assert.equal(await report.locator('.report-source').count(), 2, 'case-sensitive paths remain separate covered pages');
  assert.equal(await report.locator('details.report-disclosure').count(), 4, 'extra sources, findings, and opportunities are progressively disclosed');
  await report.getByText('View all 2 captured pages').click();
  await report.locator('.report-source-title').filter({ hasText: 'About uppercase path' }).waitFor();
  await report.getByText(/Show 4 more items not established in this capture/).click();
  await report.getByText(/does not mean the business lacks/).waitFor();
  assert.equal(await report.locator('[aria-label*="not established in this capture"] li').count(), 5, 'all unknown findings remain available with their qualifier');
  await report.getByText(/Show 4 more review opportunities/).click();
  const opportunities = await report.locator('[aria-label="Review opportunities"] li').allInnerTexts();
  assert.equal(opportunities.length, 6, 'all returned opportunities are retained without adding scores');
  assert.ok(opportunities.includes('Review pricing page coverage'));
  assert.equal(opportunities.some(value => /op-\d/.test(value)), false, 'internal opportunity identifiers are not shown');
  await page.getByRole('tab', { name: 'Customers' }).click();
  await page.locator('#customer-list [data-audit-account]').click();
  await page.waitForFunction(() => document.querySelector('#snapshot-result') === document.activeElement);
  assert.equal(await page.locator('.section-nav [aria-selected="true"]').getAttribute('data-view'), 'discover', 'a customer audit opens Discover with its report focused');

  await page.getByRole('button', { name: 'Research public businesses' }).click();
  assert.equal(await page.locator('#prospecting-form').evaluate(form => form.closest('details').open), true, 'public research opens the connected policy-gated workflow');

  failBStatus = true;
  await page.locator('#refresh-prospecting').click();
  await page.locator('#prospecting-status[data-state="unavailable"]').getByText(/could not be checked/).waitFor();
  assert.equal(await page.locator('#prospecting-form [type="submit"]').isDisabled(), true, 'a failed status read keeps the start action disabled');
  assert.deepEqual(await page.locator('.section-nav [role="tab"]').allTextContents(), ['Overview', 'Discover', 'Campaigns', 'Inbox', 'Customers', 'Analytics', 'Settings']);
  await page.getByRole('tab', { name: 'Customers' }).click();
  holdNextAudit = true;
  const delayedAudit = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/research/audits'));
  await page.locator('#customer-list [data-audit-account]').click();
  await delayedAudit;
  recordFixture = { evidence: [], accounts: [], claims: [], campaigns: [], offers: [], mailboxes: [], outcomes: [] };
  await page.getByLabel('Choose workspace').selectOption(ids.c);
  await page.getByRole('heading', { name: 'Good to see you, View only.' }).waitFor();
  releaseAudit?.();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.section-nav [aria-selected="true"]').getAttribute('data-view'), 'customers', 'a report response from the previous workspace cannot navigate or steal focus');
  assert.doesNotMatch(await page.locator('#snapshot-result').innerText(), /Business X-Ray/, 'the previous workspace report does not remain visible');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByText('0 of 5 saved').waitFor();
  assert.equal(await page.locator('#snapshot-form').evaluate(form => form.hidden), true, 'the read-only member does not receive a write-form next action');
  assert.equal(await page.locator('#first-success-next button').count(), 0, 'the progress guide respects the selected member role');
  assert.match(await page.locator('#first-success-next').innerText(), /editing access/);
  await page.setViewportSize({ width: 375, height: 820 });
  await page.waitForTimeout(60);
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(60);
  const navBounds = await page.locator('.section-nav').evaluate(nav => { const rect = nav.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, width: nav.clientWidth }; });
  assert.ok(navBounds.top >= 0 && navBounds.bottom <= 820, `mobile navigation remains visible after vertical scrolling: ${JSON.stringify(navBounds)}`);
  await page.locator('#tab-settings').click();
  const lastTabBounds = await page.locator('#tab-settings').evaluate(tab => { const rect = tab.getBoundingClientRect(); const nav = tab.closest('.section-nav').getBoundingClientRect(); return { left: rect.left, right: rect.right, navLeft: nav.left, navRight: nav.right }; });
  assert.ok(lastTabBounds.left >= lastTabBounds.navLeft && lastTabBounds.right <= lastTabBounds.navRight, `last section tab can be reached horizontally: ${JSON.stringify(lastTabBounds)}`);
  const mobileWidth = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].map(node => ({ node, right: node.getBoundingClientRect().right, left: node.getBoundingClientRect().left })).filter(item => item.right > innerWidth + 1 || item.left < -1).sort((a, b) => b.right - a.right).slice(0, 15).map(({ node, right }) => `${node.tagName.toLowerCase()}#${node.id}.${node.className} right=${Math.round(right)}`) }));
  assert.ok(mobileWidth.scrollWidth <= mobileWidth.width + 1, `Discover choices fit a 375px screen: ${JSON.stringify(mobileWidth)}`);
});
