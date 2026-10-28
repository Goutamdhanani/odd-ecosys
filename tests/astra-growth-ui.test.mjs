import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ids = {
  a: '10000000-0000-4000-8000-000000000001', b: '20000000-0000-4000-8000-000000000002',
  account: '30000000-0000-4000-8000-000000000003', evidence: '40000000-0000-4000-8000-000000000004', audit: '50000000-0000-4000-8000-000000000005',
  campaign: '60000000-0000-4000-8000-000000000006', mailbox: '70000000-0000-4000-8000-000000000007',
  mailbox2: '71000000-0000-4000-8000-000000000007', message: '72000000-0000-4000-8000-000000000007', proposal: '73000000-0000-4000-8000-000000000007',
  job: '80000000-0000-4000-8000-000000000008',
};
let browser, server;
const apiTrace = [];
const externalTrace = [];
let auditBehavior = null;
let snapshotEnvelope = 'valid';
let holdNextSearch = null;
let searchMode = 'blocked';
let holdSouthContext = false;
let releaseSouthContext = null;
let mailboxRows = [{ id: ids.mailbox, displayName: 'Manual inbox', provider: 'manual', configurationStatus: 'unknown', capabilities: { receive: 'manual_ingest_only', send: 'disabled' } }];
let messageRows = [];
let mappingRows = [];
let proposalRows = [];

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test('customer console renders actual UI, isolates workspace changes, and saves real-shaped evidence requests', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  await import('./support/astra-qa-egress-guard.mjs');
  const { chromium } = await import('playwright');
  installLoopbackBrowserGuard({ chromium });
  globalThis[Symbol.for('odd-ecosys.qa-browser-guard.trace')] = externalTrace;

  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const files = new Map([
      ['/growth.html', ['growth.html', 'text/html; charset=utf-8']],
      ['/css/main.css', ['css/main.css', 'text/css']],
      ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css']],
      ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript']],
      ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript']],
    ]);
    const entry = files.get(pathname);
    if (!entry) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    fs.createReadStream(path.join(root, entry[0])).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => document.addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"][data-view]');
    if (tab) requestAnimationFrame(() => document.querySelectorAll(`#view-${tab.dataset.view} details.task-disclosure`).forEach(detail => { detail.open = true; }));
  }));
  page.setDefaultTimeout(7000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    const path = url.pathname; const body = method === 'POST' ? JSON.parse(request.postData() || '{}') : null;
    apiTrace.push({ method, path, body });
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    const result = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/astra/workspaces') return json({ workspaces: [{ id: ids.a, name: 'North Studio', role: 'owner', status: 'active' }, { id: ids.b, name: 'South Studio', role: 'reviewer', status: 'active' }], capabilities: { customerConsole: true, operatorWorkspace: true }, releaseReady: false });
    if (path.endsWith('/context')) {
      if (path.includes(ids.b) && holdSouthContext) await new Promise(resolve => { releaseSouthContext = resolve; });
      return json({ tenant: { id: path.includes(ids.a) ? ids.a : ids.b, name: path.includes(ids.a) ? 'North Studio' : 'South Studio', status: 'active', role: path.includes(ids.a) ? 'owner' : 'reviewer' } });
    }
    if (path.endsWith('/research/evidence')) {
      if (path.includes(ids.a)) await new Promise(resolve => setTimeout(resolve, 900));
      return json({ data: path.includes(ids.a) ? [{ id: ids.evidence, sourceUrl: 'https://north.example/about', normalizedDomain: 'north.example', documentTitle: 'North page', contentSha256: 'a'.repeat(64), capturedAt: '2026-01-01T00:00:00.000Z', coverageStatus: 'single_page_snapshot', sourceContentUntrusted: true, byteLength: 120 }] : [] });
    }
    if (path.endsWith('/research/identities')) return json({ data: path.includes(ids.a) ? [{ id: ids.account, normalizedDomain: 'north.example', displayDomain: 'north.example', evidenceCount: 1, candidateCount: 0 }] : [] });
    if (path.endsWith('/research/claims')) return json({ data: [] });
    if (path.endsWith('/research/snapshots')) {
      const snapshot = { evidence: { id: ids.evidence, sourceUrl: body.sourceUrl, contentSha256: 'b'.repeat(64), coverageStatus: 'single_page_snapshot', sourceContentUntrusted: true, byteLength: body.html.length }, account: { id: ids.account, displayDomain: 'new.example', normalizedDomain: 'new.example' }, candidates: [{ id: 'candidate-1' }] };
      return result(201, snapshotEnvelope === 'valid' ? { data: snapshot } : snapshot);
    }
    if (path.endsWith('/research/audits')) {
      if (holdNextSearch?.audit) { const hold = holdNextSearch; holdNextSearch = null; await new Promise(resolve => setTimeout(resolve, hold.delay)); if (hold.status >= 400) return result(hold.status, { error: hold.error || 'Audit rejected by policy.' }); }
      if (auditBehavior) { const behavior = auditBehavior; auditBehavior = null; return result(behavior.status, { error: behavior.error }); }
      return result(201, { data: { id: ids.audit, auditVersion: 'astra-account-audit/1', coverageStatus: 'partial', sourceCoverage: { captured_page_count: 1, page_roles: { home: 1 } }, findings: [{ signal: 'document_title', outcome: 'observed', evidenceId: ids.evidence, detail: 'Home' }, { signal: 'pricing_page', outcome: 'unknown', evidenceId: ids.evidence, detail: 'Not inspected' }], opportunities: [{ id: 'review-pricing-coverage', title: 'Review pricing page coverage', priority: 'review' }] } });
    }
    if (path.endsWith('/qualification') && method === 'POST') return json({ qualification: { fitCount: 0, results: [{ accountId: ids.account, domain: 'north.example', status: 'blocked', reasons: ['current_industry_evidence_missing'], permission: 'not_evaluated' }] } });
    if (path.endsWith('/campaigns') && method === 'POST') return result(201, { campaign: { id: ids.campaign, name: body.name, state: 'draft' } });
    if (path.endsWith('/campaigns')) return json({ items: path.includes(ids.a) ? [{ id: ids.campaign, name: 'North campaign', state: 'draft', purpose: 'Introduce design', offerVersionId: 12, createdAt: '2026-01-01T00:00:00Z' }] : [] });
    if (path.endsWith(`/campaigns/${ids.campaign}`)) return json({ campaign: { id: ids.campaign, name: 'North campaign', state: 'draft', purpose: 'Introduce design', currency: 'USD', subject: null }, approvals: [], dispatchPlans: [] });
    if (path.endsWith(`/campaigns/${ids.campaign}/composer`)) return json({ composer: { campaignId: ids.campaign, version: 1, copyVersion: 0, subject: '', body: '', validation: { status: 'unverified', eligible: false, reasons: ['no_saved_copy'] }, templates: [] } });
    if (path.endsWith('/offers/1')) return json({ offer: { versions: [{ id: 12, version: 1, status: 'approved', content: { service: 'Web design', price: { currency: 'USD' } } }] } });
    if (path.endsWith('/offers')) return json({ offers: [{ id: 1, name: 'Web design', latest_version_id: 12, latest_version: 1, latest_status: 'approved' }] });
    if (path.endsWith('/mailboxes') && method === 'POST') { const mailbox = { id: ids.mailbox2, displayName: body.displayName, provider: 'manual', configurationStatus: 'unknown', capabilities: { receive: 'manual_ingest_only', send: 'disabled' } }; mailboxRows.push(mailbox); return result(201, { mailbox }); }
    if (path.endsWith('/mailboxes')) return json({ items: mailboxRows, outboundTransport: 'disabled' });
    if (path.endsWith('/inbox/messages') && method === 'POST') { const prior = messageRows.find(row => row.mailboxId === body.mailboxId && row.externalMessageId === body.externalMessageId); if (prior) { const identical = ['externalThreadId','sender','subject','bodyText'].every(key => prior[key] === body[key]) && JSON.stringify(prior.recipients) === JSON.stringify(body.recipients); return identical ? result(200, { message: { id: prior.id, threadId: prior.threadId, duplicate: true } }) : result(409, { error: 'Message identity already exists with different content.' }); } const message = { id: ids.message, threadId: 'thread-row', duplicate: false }; messageRows.push({ ...message, ...body, receivedAt: body.receivedAt || '2026-01-01T00:00:00Z' }); return result(201, { message }); }
    if (path.endsWith('/inbox/messages')) return json({ items: messageRows });
    if (path.endsWith('/crm/mappings') && method === 'POST') { const mapping = { entityType: body.entityType, entityId: body.entityId, provider: 'twenty', externalId: body.externalId, createdAt: '2026-01-02T00:00:00Z', duplicate: false }; mappingRows.push(mapping); return result(201, { mapping }); }
    if (path.endsWith('/crm/mappings')) return json({ items: mappingRows, provider: 'twenty' });
    if (path.endsWith('/crm/outbox') && method === 'POST') { const proposal = { id: ids.proposal, entityType: body.entityType, entityId: body.entityId, operation: 'create_company', payload: body.payload, state: 'held', createdAt: '2026-01-03T00:00:00Z' }; proposalRows.push(proposal); return result(201, { proposal, transportEnabled: false }); }
    if (path.endsWith('/crm/outbox')) return json({ items: proposalRows, transportEnabled: false });
    if (path.endsWith('/outcomes')) return json({ data: [] });
    if (path.endsWith('/analytics/funnel')) return json({ data: { basis: 'correction_aware_astra_outcome_projection', funnel: {}, attribution: 'none_in_tenant_funnel' } });
    if (path.endsWith(`/collection/jobs/${ids.job}`) && method === 'GET') {
      return json({ job: searchMode === 'completed'
        ? { id: ids.job, jobType: 'search', status: 'completed', resultCount: 1, candidates: [{ id: 'candidate-1', title: 'Returned design studio', canonicalDomain: 'returned.example', sourceUrl: 'https://returned.example/', snippet: 'Source result text', verified: false, candidateOnly: true, independentConfirmation: false, sourceContentUntrusted: true }] }
        : { id: ids.job, jobType: 'search', status: 'blocked', blockedReason: 's01_approval_unknown_or_expired', candidates: [] } });
    }
    if (path.endsWith('/collection/search')) {
      if (holdNextSearch) { const hold = holdNextSearch; holdNextSearch = null; await new Promise(resolve => setTimeout(resolve, hold.delay)); if (hold.status >= 400) return result(hold.status, { error: hold.error || 'Search policy rejected.' }); return result(202, { job: { id: 'late-search', status: 'blocked', blockedReason: 'late_fixture_result' } }); }
      return result(202, { job: { id: ids.job, status: searchMode === 'completed' ? 'queued' : 'blocked', blockedReason: searchMode === 'completed' ? null : 's01_approval_unknown_or_expired' }, execution: searchMode === 'completed' ? 'explicit_one_shot_after_commit' : 'worker_unavailable', releaseReady: false });
    }
    return result(404, { error: `Unexpected API route ${method} ${path}` });
  });
  await page.goto(`${base}/growth.html`);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Inbox' }).click();
  await page.getByLabel('Mailbox name').fill('Returns mailbox');
  await page.getByRole('button', { name: 'Create manual inbox' }).click();
  await page.getByText('Manual inbox created').waitFor();
  const mailboxCreateCall = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/mailboxes'));
  assert.deepEqual(mailboxCreateCall.body, { displayName: 'Returns mailbox', provider: 'manual' });
  await page.locator('#message-import-form [name="mailboxId"]').selectOption(ids.mailbox2);
  await page.getByLabel('External thread reference').fill('thread-sample-42');
  await page.getByLabel('External message reference').fill('message-sample-42');
  await page.getByLabel('From').fill('buyer@example.test');
  await page.getByLabel('To addresses').fill('returns@example.test');
  await page.locator('#message-import-form [name="subject"]').fill('Return question');
  await page.getByLabel('Message text').fill('<script>operator supplied text</script>');
  await page.getByRole('button', { name: 'Import message' }).click();
  await page.getByText('Message imported').waitFor();
  const messageImport = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/inbox/messages'));
  assert.equal(messageImport.body.externalMessageId, 'message-sample-42');
  assert.equal(messageImport.body.externalThreadId, 'thread-sample-42');
  assert.equal(messageImport.body.mailboxId, ids.mailbox2);
  assert.equal(messageImport.body.bodyText, '<script>operator supplied text</script>');
  assert.equal(await page.locator('#inbox-list script').count(), 0, 'imported message content is rendered as text');
  await page.locator('#message-import-form [name="mailboxId"]').selectOption(ids.mailbox2);
  await page.getByLabel('External thread reference').fill('thread-sample-42');
  await page.getByLabel('External message reference').fill('message-sample-42');
  await page.getByLabel('From').fill('buyer@example.test');
  await page.getByLabel('To addresses').fill('returns@example.test');
  await page.locator('#message-import-form [name="subject"]').fill('Return question');
  await page.getByLabel('Message text').fill('<script>operator supplied text</script>');
  await page.getByRole('button', { name: 'Import message' }).click();
  await page.getByText('Message already imported').waitFor();
  await page.locator('#message-import-form [name="mailboxId"]').selectOption(ids.mailbox2);
  await page.getByLabel('External thread reference').fill('thread-sample-42');
  await page.getByLabel('External message reference').fill('message-sample-42');
  await page.getByLabel('From').fill('buyer@example.test');
  await page.getByLabel('To addresses').fill('returns@example.test');
  await page.locator('#message-import-form [name="subject"]').fill('Changed subject');
  await page.getByLabel('Message text').fill('different content');
  await page.getByRole('button', { name: 'Import message' }).click();
  await page.getByText(/Message import failed.*different content/i).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  const inputs = await page.locator('input').evaluateAll(nodes => nodes.map(node => ({ type: node.type, name: node.name, placeholder: node.placeholder })));
  assert.equal(inputs.some(item => /tenant.?id|evidence.?id|workflow.?id|hash|raw.?json/i.test(`${item.name} ${item.placeholder}`)), false, 'everyday forms must not ask for internal record identifiers or raw JSON');

  await page.getByLabel('Website address').fill('https://new.example/about');
  await page.getByLabel('HTML page export').setInputFiles({ name: 'about.html', mimeType: 'text/html', buffer: Buffer.from('<html><title>Home</title><h1>Welcome</h1></html>') });
  await page.getByLabel('Why can this page be used?').selectOption('user_provided');
  await page.getByLabel(/I have permission to provide this page/).check();
  await page.getByLabel(/I checked the site’s robots rules/).check();
  await page.getByRole('button', { name: 'Save page and create report' }).click();
  await page.getByText('Evidence report · partial').waitFor();
  assert.match(await page.locator('#snapshot-result').innerText(), /pricing page: unknown/i);
  assert.match(await page.locator('#snapshot-result').innerText(), /does not establish site-wide absence/i);
  assert.match(await page.locator('#snapshot-result').innerText(), /Review pricing page coverage/i);
  assert.match(await page.locator('#snapshot-result').innerText(), /Source coverage/i);
  const snapshotCall = apiTrace.find(item => item.path.endsWith('/research/snapshots'));
  const auditCall = apiTrace.find(item => item.path.endsWith('/research/audits'));
  assert.equal(snapshotCall.body.sourceUrl, 'https://new.example/about');
  assert.equal(snapshotCall.body.rightsPolicy, 'user_provided');
  assert.equal(snapshotCall.body.robotsAllowed, true);
  assert.equal(auditCall.body.accountId, ids.account, 'the returned internal account ID is used without being entered by the user');
  assert.equal('evidenceId' in auditCall.body, false);

  snapshotEnvelope = 'invalid';
  await page.getByLabel('Website address').fill('https://malformed.example/about');
  await page.getByLabel('HTML page export').setInputFiles({ name: 'malformed.html', mimeType: 'text/html', buffer: Buffer.from('<html><title>Malformed envelope</title></html>') });
  await page.getByLabel('Why can this page be used?').selectOption('user_provided');
  await page.getByLabel(/I have permission to provide this page/).check();
  await page.getByLabel(/I checked the site’s robots rules/).check();
  const auditCountBeforeMalformed = apiTrace.filter(item => item.path.endsWith('/research/audits')).length;
  await page.getByRole('button', { name: 'Save page and create report' }).click();
  await page.locator('#snapshot-result').getByText(/saved but its evidence\/account details were not returned/i).waitFor();
  assert.equal(apiTrace.filter(item => item.path.endsWith('/research/audits')).length, auditCountBeforeMalformed, 'malformed snapshot envelopes do not create an audit with missing IDs');
  snapshotEnvelope = 'valid';

  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByLabel('Business type or category').fill('Design studios');
  await page.locator('#search-form [name="country"]').fill('Canada');
  await page.getByLabel('Public-use basis reference').fill('terms page reviewed by owner');
  await page.getByLabel('Robots rules reference').fill('robots.txt checked');
  const futureDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('Source rights valid through').fill(futureDate);
  await page.getByLabel(/I have a permitted basis to search/).check();
  await page.getByLabel(/I checked the robots rules/).check();
  await page.getByRole('button', { name: 'Check availability' }).click();
  await page.getByText(/s01_approval_unknown_or_expired/).waitFor();
  assert.match(await page.locator('#search-result').innerText(), /No businesses were added because this request is blocked/i);
  const searchCall = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/collection/search'));
  assert.equal(searchCall.body.approvalMode, 'server');
  assert.equal('approvalReferences' in searchCall.body, false, 'server mode resolves approved references without client-supplied IDs');
  assert.equal(searchCall.body.sourceRights.rightsExpiresAt, `${futureDate}T23:59:59.000Z`, 'the selected future rights date is sent to policy');
  assert.match(await page.locator('#search-result').innerText(), /No businesses were added because this request is blocked/i);

  searchMode = 'completed';
  await page.getByRole('button', { name: 'Check availability' }).click();
  await page.getByText('Returned design studio').waitFor();
  assert.match(await page.locator('#search-result').innerText(), /Candidate only · unverified/i);
  assert.match(await page.locator('#search-result').innerText(), /returned\.example/i);
  assert.doesNotMatch(await page.locator('#search-result').innerText(), /No businesses were added/i, 'completed service candidates render as returned candidates');
  searchMode = 'blocked';

  await page.getByRole('tab', { name: 'Customers' }).click();
  await page.locator('#crm-mapping-form [name="accountId"]').selectOption(ids.account);
  await page.getByLabel('External CRM company ID').fill('twenty-company-42');
  await page.getByRole('button', { name: 'Save manual mapping' }).click();
  await page.getByText(/twenty-company-42/).waitFor();
  const mappingCall = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/crm/mappings'));
  assert.equal(mappingCall.body.accountId, ids.account);
  assert.equal(mappingCall.body.entityId, ids.account);
  assert.equal(mappingCall.body.provenance.verification, 'manual_unverified');
  await page.locator('#crm-proposal-form [name="accountId"]').selectOption(ids.account);
  await page.getByLabel('Company name').fill('North Studio Ltd');
  await page.getByLabel('Company website domain (optional)').fill('north.example');
  await page.getByRole('button', { name: 'Save company proposal' }).click();
  await page.getByText(/Company proposal saved · held/).waitFor();
  assert.match(await page.locator('#crm-outbox-list').innerText(), /North Studio Ltd · held/i);
  const proposalCall = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/crm/outbox'));
  assert.equal(proposalCall.body.accountId, ids.account);
  assert.equal(proposalCall.body.entityId, ids.account);
  assert.equal(proposalCall.body.provenance.verification, 'manual_unverified');
  assert.equal(proposalCall.body.payload.name, 'North Studio Ltd');
  assert.match(await page.locator('#crm-transport-state').innerText(), /transport is disabled/i);
  auditBehavior = { status: 404, error: 'Account was not found in this workspace.' };
  const auditCountBeforeRejectedTarget = apiTrace.filter(item => item.path.endsWith('/research/audits')).length;
  await page.getByRole('button', { name: 'Audit saved pages' }).click();
  await page.getByText(/Account was not found in this workspace/).waitFor();
  const rejectedAuditCalls = apiTrace.filter(item => item.path.endsWith('/research/audits')).slice(auditCountBeforeRejectedTarget);
  assert.equal(rejectedAuditCalls.length, 1, 'a rejected account target is not silently retried as an evidence audit');
  assert.deepEqual(rejectedAuditCalls[0].body, { accountId: ids.account });

  await page.getByRole('tab', { name: 'Campaigns' }).click();
  await page.getByLabel('Campaign name').fill('North campaign');
  await page.getByLabel('Approved offer').selectOption('12');
  await page.getByLabel('Workspace mailbox').selectOption(ids.mailbox);
  await page.getByLabel('Purpose').fill('Introduce design');
  await page.locator('#campaign-form [name="geography"]').fill('US');
  await page.getByLabel(/Maximum spend/).fill('75');
  const invalidCampaignFields = await page.locator('#campaign-form').evaluate(form => [...form.elements].filter(element => !element.checkValidity()).map(element => `${element.name}:${element.value}`));
  assert.deepEqual(invalidCampaignFields, [], 'campaign form should be valid after selecting its named services');
  await page.getByRole('button', { name: 'Create campaign draft' }).click();
  await page.locator('#campaign-detail').getByText('North campaign').waitFor();
  const campaignCall = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/campaigns'));
  assert.ok(campaignCall, `campaign creation API call should run; trace: ${JSON.stringify(apiTrace.map(item => [item.method, item.path]))}; notice: ${await page.locator('#notice').innerText()}`);
  assert.deepEqual(campaignCall.body, { name: 'North campaign', offerVersionId: 12, mailboxId: ids.mailbox, purpose: 'Introduce design', geography: ['US'], spendLimitMinor: 7500, currency: 'USD' });
  assert.match(await page.locator('#campaign-detail').innerText(), /No offline plans saved/);
  await page.locator('#qualification-form [name="campaignId"]').selectOption(ids.campaign);
  await page.locator('#qualification-form [name="accountId"]').selectOption(ids.account);
  await page.getByRole('button', { name: 'Run qualification' }).click();
  await page.getByText('Not ready for this campaign').waitFor();
  const qualificationCall = apiTrace.find(item => item.method === 'POST' && item.path.endsWith('/qualification'));
  assert.deepEqual(qualificationCall.body, { accountIds: [ids.account] }, 'selection sends the exact returned account ID internally');

  // A workspace switch while file.text() is pending must prevent the snapshot POST.
  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByLabel('Website address').fill('https://pending-file.example/about');
  await page.getByLabel('HTML page export').setInputFiles({ name: 'pending.html', mimeType: 'text/html', buffer: Buffer.from('<html>pending file</html>') });
  await page.getByLabel('Why can this page be used?').selectOption('user_provided');
  await page.getByLabel(/I have permission to provide this page/).check();
  await page.getByLabel(/I checked the site’s robots rules/).check();
  await page.evaluate(() => { window.__originalFileText = File.prototype.text; File.prototype.text = function () { return new Promise(resolve => setTimeout(() => window.__originalFileText.call(this).then(resolve), 600)); }; });
  const snapshotsBeforeFileDelay = apiTrace.filter(item => item.path.endsWith('/research/snapshots')).length;
  await page.getByRole('button', { name: 'Save page and create report' }).click();
  await page.waitForTimeout(80);
  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await page.waitForTimeout(750);
  assert.equal(apiTrace.filter(item => item.path.endsWith('/research/snapshots')).length, snapshotsBeforeFileDelay, 'a late file read cannot submit against a newly selected tenant');
  assert.equal(await page.locator('#snapshot-result').innerText(), 'Your report will appear here after the page is saved.', 'workspace switch clears the old write result instead of painting a stale error');
  await page.evaluate(() => { if (window.__originalFileText) File.prototype.text = window.__originalFileText; });

  // The same pinning applies while hashing an offer proof before its first POST.
  await page.getByLabel('Choose workspace').selectOption(ids.a);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Campaigns' }).click();
  await page.getByLabel('Offer name').fill('Proof offer');
  await page.locator('#offer-form [name="service"]').fill('Design service');
  await page.getByLabel(/What.s included/).fill('A synthetic offer for browser testing.');
  await page.getByLabel('Minimum price').fill('10');
  await page.getByLabel('Maximum price').fill('20');
  await page.locator('#offer-form [name="currency"]').fill('USD');
  await page.locator('#offer-form [name="includedCountries"]').fill('US');
  await page.locator('#offer-form [name="capacity"]').fill('1');
  await page.getByLabel('Offer proof file').setInputFiles({ name: 'proof.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic proof') });
  await page.getByLabel('Why can this proof be used?').fill('Synthetic fixture only.');
  await page.evaluate(() => { const original = crypto.subtle.digest.bind(crypto.subtle); window.__originalDigest = original; Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: (...args) => new Promise((resolve, reject) => setTimeout(() => original(...args).then(resolve, reject), 600)) }); });
  const offersBeforeHashDelay = apiTrace.filter(item => item.method === 'POST' && item.path.endsWith('/offers')).length;
  await page.getByRole('button', { name: 'Save proof and approve offer' }).click();
  await page.waitForTimeout(80);
  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await page.waitForTimeout(750);
  assert.equal(apiTrace.filter(item => item.method === 'POST' && item.path.endsWith('/offers')).length, offersBeforeHashDelay, 'a late hash cannot begin an offer write in another tenant');
  await page.evaluate(() => { if (window.__originalDigest) Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: window.__originalDigest }); });

  // Delayed successful and failed responses must not change the next workspace's UI.
  await page.getByLabel('Choose workspace').selectOption(ids.a);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Customers' }).click();
  holdNextSearch = { audit: true, delay: 600, status: 201 };
  const delayedAuditRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/research/audits'));
  await page.getByRole('button', { name: 'Audit saved pages' }).click();
  await delayedAuditRequest;
  await page.waitForTimeout(80);
  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await page.waitForTimeout(750);
  assert.equal(await page.locator('#notice').innerText(), '', 'a delayed successful audit cannot add a stale success notice');
  assert.equal(await page.locator('#snapshot-result').innerText(), 'Your report will appear here after the page is saved.');

  await page.getByLabel('Choose workspace').selectOption(ids.a);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByLabel('Business type or category').fill('Design studios');
  await page.locator('#search-form [name="country"]').fill('Canada');
  await page.getByLabel('Public-use basis reference').fill('terms reviewed');
  await page.getByLabel('Robots rules reference').fill('robots checked');
  await page.getByLabel('Source rights valid through').fill(futureDate);
  await page.getByLabel(/I have a permitted basis to search/).check();
  await page.getByLabel(/I checked the robots rules/).check();
  holdNextSearch = { delay: 600, status: 403, error: 'late source policy rejection' };
  const delayedSearchRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/collection/search'));
  await page.getByRole('button', { name: 'Check availability' }).click();
  await delayedSearchRequest;
  await page.waitForTimeout(80);
  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await page.waitForTimeout(750);
  assert.equal(await page.locator('#notice').innerText(), '', 'a delayed policy error cannot add a stale error notice');
  assert.equal(await page.locator('#search-result').innerText(), 'No search request yet.', 'a delayed policy error cannot overwrite the neutral result after the workspace load');

  // Dirty every workspace-scoped form, then hold workspace B's context response.
  // Drafts must already be gone while that request is still pending; the global
  // workspace-creation form keeps its value.
  await page.getByLabel('Choose workspace').selectOption(ids.a);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('#create-workspace-form [name="name"]').fill('Global workspace draft');
  const dirtyWorkspaceForms = await page.locator('form').evaluateAll(forms => {
    const snapshot = [];
    for (const form of forms) {
      if (form.id === 'create-workspace-form') continue;
      const fields = [];
      for (const field of form.elements) {
        if (['button', 'submit', 'reset', 'file', 'hidden'].includes(field.type)) continue;
        const record = { name: field.name, type: field.type };
        if (field instanceof HTMLSelectElement) {
          record.defaultSelected = [...field.options].findIndex(option => option.defaultSelected);
          if (field.options.length > 1) field.selectedIndex = field.options.length - 1;
        } else if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) {
          record.defaultChecked = field.defaultChecked; field.checked = !field.checked;
        } else {
          record.defaultValue = field.defaultValue;
          const values = { email: 'draft@example.test', url: 'https://draft.example', date: '2026-10-27', 'datetime-local': '2026-10-27T10:00', number: '7', time: '10:00', month: '2026-10', week: '2026-W43', color: '#123456' };
          field.value = values[field.type] || `workspace-draft-${form.id}`;
        }
        fields.push(record);
      }
      snapshot.push({ id: form.id, fields });
    }
    return snapshot;
  });
  assert.ok(dirtyWorkspaceForms.some(form => form.id === 'mailbox-form'));
  assert.ok(dirtyWorkspaceForms.some(form => form.id === 'message-import-form'));
  assert.ok(dirtyWorkspaceForms.some(form => form.id === 'crm-mapping-form'));
  assert.ok(dirtyWorkspaceForms.some(form => form.id === 'crm-proposal-form'));
  await page.getByRole('button', { name: 'Enable Pro mode' }).click();
  assert.equal(await page.locator('#pro-workspace-id').innerText(), ids.a, 'Pro shows the currently selected workspace before switching');
  holdSouthContext = true;
  const southContextRequest = page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname.endsWith(`/tenants/${ids.b}/context`));
  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await southContextRequest;
  assert.equal(await page.locator('#pro-workspace-id').innerText(), ids.b, 'Pro context updates synchronously and never retains the previous tenant ID while the new context is held');
  assert.equal(await page.locator('#pro-workspace-status').innerText(), 'active', 'Pro status is updated from the selected workspace summary during context load');
  const workspaceFormReset = await page.locator('form').evaluateAll((forms, baseline) => {
    const mismatches = [];
    for (const form of forms) {
      if (form.id === 'create-workspace-form') continue;
      const expected = baseline.find(item => item.id === form.id);
      for (const field of form.elements) {
        if (['button', 'submit', 'reset', 'file', 'hidden'].includes(field.type)) continue;
        const record = expected?.fields.find(item => item.name === field.name && item.type === field.type);
        if (!record) continue;
        if (field instanceof HTMLSelectElement) {
          const expectedIndex = record.defaultSelected >= 0 ? record.defaultSelected : (field.options.length ? 0 : -1);
          if (field.selectedIndex !== expectedIndex) mismatches.push(`${form.id}.${field.name}`);
        } else if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) {
          if (field.checked !== record.defaultChecked) mismatches.push(`${form.id}.${field.name}`);
        } else if (field.value !== record.defaultValue) mismatches.push(`${form.id}.${field.name}`);
      }
    }
    return { mismatches, mailbox: document.querySelector('#mailbox-form [name="displayName"]').value,
      message: document.querySelector('#message-import-form [name="bodyText"]').value,
      mapping: document.querySelector('#crm-mapping-form [name="externalId"]').value,
      proposal: document.querySelector('#crm-proposal-form [name="name"]').value,
      globalWorkspace: document.querySelector('#create-workspace-form [name="name"]').value };
  }, dirtyWorkspaceForms);
  assert.deepEqual(workspaceFormReset.mismatches, [], 'all workspace-scoped form controls reset before the selected workspace context returns');
  assert.equal(workspaceFormReset.mailbox, '');
  assert.equal(workspaceFormReset.message, '');
  assert.equal(workspaceFormReset.mapping, '');
  assert.equal(workspaceFormReset.proposal, '');
  assert.equal(workspaceFormReset.globalWorkspace, 'Global workspace draft', 'workspace creation is global and keeps its draft');
  holdSouthContext = false; releaseSouthContext?.(); releaseSouthContext = null;
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();

  // Leave a delayed read in North, switch to a reviewer workspace, and prove that
  // its response cannot paint North's source data into South's UI.
  await page.getByLabel('Choose workspace').selectOption(ids.a);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Refresh workspace data' }).click();
  await page.waitForTimeout(80);
  await page.getByLabel('Choose workspace').selectOption(ids.b);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#evidence-list').innerText(), 'No page evidence yet. Use a supplied HTML export in Discover to start.');
  assert.equal(await page.locator('#advanced-link').isVisible(), false, 'advanced link must be hidden for reviewer membership');
  assert.equal(await page.locator('#snapshot-form').isVisible(), false, 'reviewer cannot submit evidence writes');
  for (const selector of ['#mailbox-form', '#message-import-form', '#crm-mapping-form', '#crm-proposal-form']) {
    assert.equal(await page.locator(selector).evaluate(form => form.hidden), true, `reviewer cannot submit ${selector}`);
    assert.equal(await page.locator(selector).evaluate(form => form.parentElement.hidden), true, `reviewer does not see an empty task disclosure for ${selector}`);
  }
  for (const selector of ['#offer-form', '#approval-form']) {
    assert.equal(await page.locator(selector).evaluate(form => form.hidden), true, `reviewer cannot submit ${selector}`);
    assert.equal(await page.locator(selector).evaluate(form => form.parentElement.hidden), true, `reviewer does not see an empty task disclosure for ${selector}`);
  }
  await page.getByRole('tab', { name: 'Campaigns' }).click();
  for (const selector of ['#prereq-open-offer', '#prereq-open-mailbox', '[data-open-task="campaign-form"]', '[data-open-task="qualification-form"]', '[data-open-tasks]']) {
    assert.equal(await page.locator(selector).evaluate(button => button.hidden), true, `reviewer cannot open a task whose form is role-hidden: ${selector}`);
  }
  assert.deepEqual(pageErrors, [], 'the customer UI should not raise browser errors');
  assert.equal(externalTrace.some(item => item.type === 'blocked'), false, 'no external browser requests were attempted');
  assert.ok(apiTrace.every(item => new URL(`http://127.0.0.1${item.path}`).hostname === '127.0.0.1'));
});
