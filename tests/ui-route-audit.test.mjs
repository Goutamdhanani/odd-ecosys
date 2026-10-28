import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-ui-route-audit-'));
process.env.ODD_DB_PATH = path.join(directory, 'audit.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'synthetic-route-audit-token-0123456789';
process.env.ODD_AUTH_RECOVERY_TOKEN = 'synthetic-route-audit-recovery-0123456789';
process.env.ODD_REPLY_INGEST_TOKEN = 'synthetic-route-audit-reply-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.ODD_PERSONALIZATION_BEDROCK_ENABLED = 'false';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { createWebsiteEmailDiscovery } = await import('../pipeline/website-email-discovery.js');
const { setWebsiteEmailDiscoveryTestManager, server } = await import('../server.js');
const websiteScanRequests = [];
const websiteEmailDiscovery = createWebsiteEmailDiscovery({
  db,
  minimumRequestIntervalMs: 0,
  wait: async () => {},
  fetchImpl: async (input, options) => {
    const url = new URL(input);
    websiteScanRequests.push({ url: url.href, options });
    if (url.hostname !== 'contact-ui.example.test') throw new Error('Unexpected synthetic website host.');
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nCrawl-delay: 0', {
      status: 200, headers: { 'content-type': 'text/plain' },
    });
    if (url.pathname === '/') return new Response('<html><body><a href="mailto:hello@contact-ui.example.test">Email</a></body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    if (url.pathname === '/contact') return new Response('<html><body>Support: support@contact-ui.example.test</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    if (url.pathname === '/about') return new Response('<html><body>About this synthetic company.</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  },
});
setWebsiteEmailDiscoveryTestManager(websiteEmailDiscovery);
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

test('all authenticated workspace routes render without browser errors at desktop, tablet and short mobile sizes', async t => {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!process.env.ODD_CHROMIUM_EXECUTABLE_PATH && !((await import('node:fs')).existsSync(edgePath))) {
    return t.skip('No local Edge runtime is installed on this host.');
  }
  const { chromium } = await import('playwright');
  const executablePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || edgePath;
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  const serverErrors = [];
  const unexpectedOrigins = [];
  let delayedLeadRequests = 0;
  let failNextSendControlRead = false;
  let failNextCampaignCreate = false;
  let expectedLogoutFailure = false;
  let expectedCampaignError = false;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() < 500) return;
    const request = response.request();
    const route = new URL(response.url()).pathname;
    if (expectedCampaignError && request.method() === 'POST' && route === '/api/sending/campaigns') {
      expectedCampaignError = false;
      return;
    }
    if (expectedLogoutFailure && request.method() === 'POST' && route === '/api/auth/logout') {
      expectedLogoutFailure = false;
      return;
    }
    serverErrors.push(`${response.status()} ${route}`);
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    unexpectedOrigins.push(url.origin);
    return route.abort();
  });
  // Keep the self-hosted inference probe out of this UI-only audit.
  await context.route('**/api/personalize/ollama-test*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ connected: false, available: false, status: 'not-tested-in-ui-audit' }),
  }));
  await context.route('**/api/leads*', async route => {
    if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/leads') {
      delayedLeadRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 320));
    }
    await route.continue();
  });
  await context.route('**/api/sending/campaigns', async route => {
    if (failNextCampaignCreate && route.request().method() === 'POST') {
      failNextCampaignCreate = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic campaign service outage' }) });
      return;
    }
    await route.continue();
  });
  await context.route('**/api/sending/control', async route => {
    if (failNextSendControlRead && route.request().method() === 'GET') {
      failNextSendControlRead = false;
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown sending route: GET /api/sending/control' }) });
      return;
    }
    await route.continue();
  });

  try {
    const bootstrap = await fetch(`${base}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ui-audit@example.test',
        password: 'Synthetic-only-password-9!',
        bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
      }),
    });
    assert.equal(bootstrap.status, 201, 'create a disposable UI-test administrator only in the temporary database');
    const cookieHeader = bootstrap.headers.get('set-cookie') || '';
    const session = cookieHeader.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
    const csrf = cookieHeader.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
    assert.ok(session && csrf, 'the real auth flow must issue a disposable browser session');
    const browserCookie = `odd_session=${session}; odd_csrf=${decodeURIComponent(csrf)}`;
    const batchSeed = await fetch(`${base}/api/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: browserCookie, 'x-csrf-token': decodeURIComponent(csrf) },
      body: JSON.stringify({ name: 'Synthetic UI cohort', phase: 'discovery' }),
    });
    assert.equal(batchSeed.status, 201, 'create a synthetic batch through the real API for card-layout verification');
    const seededBatch = await batchSeed.json();
    assert.equal(seededBatch.name, 'Synthetic UI cohort');
    const contactSeed = await fetch(`${base}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: browserCookie, 'x-csrf-token': decodeURIComponent(csrf) },
      body: JSON.stringify({ batch_id: seededBatch.id, business_name: 'Synthetic list contact', email: 'list-contact@example.test', city: 'Pune', website_url: 'https://contact-ui.example.test' }),
    });
    assert.equal(contactSeed.status, 201, 'create an isolated contact through the real API for list interaction coverage');
    const seededContact = (await contactSeed.json()).contact;
    const inboxContactResponse = await fetch(`${base}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: browserCookie, 'x-csrf-token': decodeURIComponent(csrf) },
      body: JSON.stringify({ batch_id: seededBatch.id, business_name: 'Synthetic Inbox contact', email: 'inbox-contact@example.test', city: 'Pune' }),
    });
    assert.equal(inboxContactResponse.status, 201, 'create a dedicated synthetic contact for inbox and unsubscribe UI checks');
    const inboxContact = (await inboxContactResponse.json()).contact;
    const inboxReply = db.prepare(`INSERT INTO events(lead_id,event_type,event_at,meta_json)
      VALUES (?,'replied',datetime('now'),?)`).run(inboxContact.id, JSON.stringify({
      from: inboxContact.email,
      to: 'sender@workspace.example.test',
      receivedTo: 'sender@workspace.example.test',
      subject: 'Re: A synthetic inbox check',
      bodyText: 'Thanks for the note. Please send the details for review.',
      bodySnippet: 'Thanks for the note. Please send the details for review.',
      sentiment: 'interested',
      sendAttribution: 'unmatched',
      messageId: '<synthetic-ui-inbox-reply@example.test>',
    }));
    const inboxReplyId = Number(inboxReply.lastInsertRowid);
    const { generateUnsubscribeToken } = await import('../pipeline/compliance.js');
    const inboxUnsubscribeToken = generateUnsubscribeToken(inboxContact.email, inboxContact.id);
    const sessionCheck = await fetch(`${base}/api/auth/status`, { headers: { cookie: browserCookie } });
    assert.equal(sessionCheck.status, 200);
    assert.equal((await sessionCheck.json()).authenticated, true, 'the disposable session is accepted by the actual API before launching the browser');
    await context.addCookies([
      { name: 'odd_session', value: session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: decodeURIComponent(csrf), domain: '127.0.0.1', path: '/', sameSite: 'Strict' },
    ]);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#workspace-navigation').waitFor();
    await page.getByRole('heading', { name: 'Good conversations start here.' }).waitFor();
    if (process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) {
      mkdirSync(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, 'dashboard-desktop.png'), fullPage: false });
    }

    const routes = ['dashboard', 'leads', 'lists', 'campaigns', 'inbox', 'mailboxes', 'analytics', 'settings', 'qualification', 'verification', 'personalization', 'batches'];
    const audit = [];
    for (const routeId of routes) {
      const navButton = page.locator(`#workspace-navigation [data-view="${routeId}"]`);
      await navButton.click();
      if (routeId === 'leads') {
        await page.waitForFunction(() => document.getElementById('main-content')?.getAttribute('aria-busy') === 'true');
        await page.waitForTimeout(220);
        assert.equal(await page.locator('#main-content').getAttribute('aria-busy'), 'true', 'the delayed lead response keeps the real loading state visible');
      }
      await page.waitForFunction(id => {
        const main = document.getElementById('main-content');
        return main?.getAttribute('aria-busy') === 'false'
          && document.querySelector(`#workspace-navigation [data-view="${id}"].active`);
      }, routeId, { timeout: 12_000 });
      if (routeId === 'inbox') {
        assert.equal(await page.locator('#notification-region .studio-toast').count(), 0,
          'navigating away from campaigns clears its stale result notifications');
        const replyRow = page.locator(`[data-inbox-reply="${inboxReplyId}"]`);
        await replyRow.getByText('Synthetic Inbox contact', { exact: true }).waitFor();
        await replyRow.click();
        const thread = page.locator('[data-inbox-thread]');
        await thread.getByRole('heading', { name: 'Synthetic Inbox contact' }).waitFor();
        await thread.getByText('Thanks for the note. Please send the details for review.', { exact: true }).waitFor();
        await thread.getByRole('button', { name: 'Mark unread' }).waitFor();
        assert.ok(db.prepare('SELECT read_at FROM reply_inbox_state WHERE event_id=?').get(inboxReplyId)?.read_at,
          'opening a reply persists its read state through the actual API');
        await thread.getByRole('button', { name: 'Mark unread' }).click();
        await thread.getByRole('button', { name: 'Mark read' }).waitFor();
        await page.getByText('1 unread', { exact: true }).waitFor();
        assert.equal(db.prepare('SELECT read_at FROM reply_inbox_state WHERE event_id=?').get(inboxReplyId)?.read_at, null,
          'Mark unread persists a null read timestamp and updates the visible unread count');

        const unsubscribePage = await context.newPage();
        await unsubscribePage.goto(`${base}/api/unsubscribe?token=${encodeURIComponent(inboxUnsubscribeToken)}`);
        await unsubscribePage.getByRole('heading', { name: 'Stop future emails?' }).waitFor();
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM suppression_list WHERE email=?').get(inboxContact.email).count, 0,
          'opening the unsubscribe confirmation page does not suppress the address');
        await unsubscribePage.getByRole('button', { name: 'Unsubscribe' }).click();
        await unsubscribePage.waitForFunction(() => document.body.innerText.includes('"status":"unsubscribed"'));
        assert.equal(db.prepare('SELECT reason FROM suppression_list WHERE email=?').get(inboxContact.email).reason, 'one_click_unsubscribe',
          'confirming the actual unsubscribe form writes durable suppression state');
        await unsubscribePage.close();
      }
      if (routeId === 'lists') {
        await page.getByRole('button', { name: 'New list' }).click();
        const cancelledListDialog = page.getByRole('dialog', { name: 'Create a contact list' });
        await cancelledListDialog.getByRole('button', { name: 'Cancel' }).click();
        await cancelledListDialog.waitFor({ state: 'hidden' });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_lists').get().count, 0,
          'Cancel closes the list form without creating a list');
        await page.getByRole('button', { name: 'New list' }).click();
        const listDialog = page.getByRole('dialog', { name: 'Create a contact list' });
        const listName = listDialog.getByRole('textbox', { name: 'List name' });
        await listName.fill('   ');
        await listDialog.getByRole('button', { name: /Create list/ }).click();
        assert.equal(await listName.getAttribute('aria-invalid'), 'true', 'empty list names get inline validation instead of an alert');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_lists').get().count, 0, 'invalid list names do not create data');
        await listName.fill('Synthetic UI audience');
        await listDialog.getByRole('textbox', { name: 'Description' }).fill('Created only for the isolated UI audit.');
        await listDialog.getByRole('button', { name: /Create list/ }).click();
        await page.getByRole('heading', { name: 'Synthetic UI audience', exact: true }).waitFor();
        const seededList = db.prepare('SELECT id, name FROM contact_lists').get();
        assert.equal(seededList.name, 'Synthetic UI audience', 'the actual list form persists through the API');

        await page.getByRole('button', { name: 'Add contacts' }).click();
        const picker = page.getByRole('dialog', { name: 'Add contacts' });
        const contactRow = picker.locator('.contact-picker-row').filter({ hasText: 'Synthetic list contact' });
        await contactRow.waitFor();
        await contactRow.locator('input[type="checkbox"]').check();
        await picker.getByRole('button', { name: /Add selected contacts/ }).click();
        await page.getByRole('cell', { name: 'Synthetic list contact', exact: true }).waitFor();
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_list_members WHERE list_id=? AND lead_id=?').get(seededList.id, seededContact.id).count, 1,
          'the picker adds the selected existing contact through the actual API');

        await page.getByRole('button', { name: 'Archive list' }).click();
        await page.getByText('ARCHIVED LIST', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Restore list' }).click();
        await page.getByText('CONTACT AUDIENCE', { exact: true }).waitFor();
        await page.getByRole('cell', { name: 'Synthetic list contact', exact: true }).waitFor();
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_list_members WHERE list_id=?').get(seededList.id).count, 1,
          'archive and restore preserve the list membership');

        await page.getByRole('button', { name: 'Remove Synthetic list contact from this list' }).click();
        await page.getByRole('heading', { name: 'This list is empty' }).waitFor();
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contact_list_members WHERE list_id=?').get(seededList.id).count, 0,
          'removal deletes only list membership');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads WHERE id=?').get(seededContact.id).count, 1,
          'removing a list member preserves the underlying contact');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(seededContact.id).count, 0,
          'list interactions never start email sending');
      }
      if (routeId === 'leads') {
        assert.ok(delayedLeadRequests > 0, 'the test exercised the actual lead API behind a delayed local response');
        const readyAnimation = await page.locator('#main-content .page-view').evaluate(node => node.getAnimations().map(animation => ({ name: animation.animationName, playState: animation.playState })));
        assert.ok(readyAnimation.some(animation => animation.name === 'workspace-content-ready' && animation.playState === 'running'),
          `loaded content should ease in after the route's loading state: ${JSON.stringify(readyAnimation)}`);
        await page.locator('#lead-import-contacts').click();
        const importDialog = page.getByRole('dialog', { name: 'Import contacts' });
        const csv = Buffer.from('business_name,email,city\nSynthetic CSV contact,csv-contact@example.test,Pune\n');
        await importDialog.locator('[name="csv"]').setInputFiles({ name: 'synthetic-contacts.csv', mimeType: 'text/csv', buffer: csv });
        await importDialog.getByRole('button', { name: 'Preview columns and rows' }).click();
        await importDialog.getByText('1 data row(s)').waitFor();
        await importDialog.getByText('Synthetic CSV contact', { exact: true }).waitFor();
        assert.equal(await importDialog.locator('[data-import-map="business_name"]').inputValue(), 'business_name',
          'CSV preview infers the company-name mapping for review');
        assert.equal(await importDialog.locator('[data-import-map="email"]').inputValue(), 'email',
          'CSV preview infers the email mapping for review');
        await importDialog.getByRole('button', { name: /Import contacts/ }).click();
        await page.locator('#notification-region').getByText(/Import completed: 1 added, 0 duplicates, 0 invalid/).waitFor();
        const importedContact = db.prepare("SELECT id FROM leads WHERE business_name='Synthetic CSV contact'").get();
        assert.ok(importedContact?.id, 'CSV import persists the mapped contact through the real worker and API');
        assert.equal(websiteScanRequests.length, 0, 'CSV import never performs an implicit website scan');
        assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(importedContact.id).verification_status, 'unknown',
          'CSV import does not initiate background email probes');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(importedContact.id).count, 0,
          'CSV import never queues or sends mail');

        await page.locator('#lead-import-osm').click();
        const osmDialog = page.getByRole('dialog', { name: 'Import OpenStreetMap export' });
        const osmExport = Buffer.from(JSON.stringify({
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', id: 'way/8801', properties: {
              '@id': 'way/8801', '@timestamp': '2026-10-09T12:00:00Z', name: 'Synthetic OSM contact', shop: 'books',
              'addr:city': 'Pune', website: 'https://synthetic-osm.example.test', email: 'osm-ui@example.test',
            }, geometry: null },
            { type: 'Feature', id: 'way/8801', properties: { '@id': 'way/8801', name: 'Duplicate OSM contact' }, geometry: null },
            { type: 'Feature', id: 'node/8802', properties: { '@id': 'node/8802', shop: 'books' }, geometry: null },
          ],
        }));
        await osmDialog.locator('[name="osm_export"]').setInputFiles({ name: 'synthetic-region.geojson', mimeType: 'application/geo+json', buffer: osmExport });
        await osmDialog.getByRole('button', { name: 'Preview export' }).click();
        await osmDialog.getByText(/Confirm the source and attribution requirements to preview/).waitFor();
        assert.equal(await osmDialog.locator('[type="submit"]').isDisabled(), true, 'the import stays disabled until attribution and a preview are confirmed');
        await osmDialog.locator('[name="attribution_acknowledged"]').check();
        await osmDialog.getByRole('button', { name: 'Preview export' }).click();
        await osmDialog.getByText('Synthetic OSM contact', { exact: true }).waitFor();
        await osmDialog.getByRole('link', { name: 'way/8801' }).waitFor();
        const osmRejectionDownloadWait = page.waitForEvent('download');
        await osmDialog.getByRole('button', { name: /Import reviewed places/ }).click();
        const osmRejectionDownload = await osmRejectionDownloadWait;
        assert.equal(osmRejectionDownload.suggestedFilename(), 'synthetic-region-rejected.csv');
        await page.locator('#notification-region').getByText(/OpenStreetMap import completed: 1 added, 1 duplicates, 1 rejected/).waitFor();
        const importedOsm = db.prepare("SELECT id,source,source_url,source_details FROM leads WHERE business_name='Synthetic OSM contact'").get();
        assert.ok(importedOsm?.id);
        assert.equal(importedOsm.source, 'openstreetmap');
        assert.equal(importedOsm.source_url, 'https://www.openstreetmap.org/way/8801');
        assert.match(importedOsm.source_details, /ODbL.*2026-10-09T12:00:00Z/);
        assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(importedOsm.id).verification_status, 'unknown');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(importedOsm.id).count, 0,
          'OSM import persists a contact but never verifies or sends its email');

        await page.locator('#lead-add-contact').click();
        const contactDialog = page.getByRole('dialog', { name: 'Add a contact' });
        const businessName = contactDialog.locator('[name="business_name"]');
        await businessName.fill('   ');
        await contactDialog.getByRole('button', { name: /Create contact/ }).click();
        assert.equal(await businessName.getAttribute('aria-invalid'), 'true', 'contact names containing only spaces are rejected inline');
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM leads WHERE business_name='Synthetic manual contact'").get().count, 0,
          'invalid contact input creates no record');
        await businessName.fill('Synthetic manual contact');
        await contactDialog.locator('[name="email"]').fill('manual-contact@example.test');
        await contactDialog.getByRole('button', { name: /Create contact/ }).click();
        await page.locator('#drawer-title').getByText('Synthetic manual contact', { exact: true }).waitFor();
        const manualContact = db.prepare("SELECT id, batch_id FROM leads WHERE business_name='Synthetic manual contact'").get();
        assert.ok(manualContact?.id, 'the actual contact form persists a contact to its open batch');
        assert.equal(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').get(manualContact.id).verification_status, 'unknown',
          'new email addresses remain unverified after creation');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(manualContact.id).count, 0,
          'creating a contact neither queues nor sends email');

        await page.evaluate(id => window.__leadDetail(id), seededContact.id);
        const websiteScanButton = page.getByRole('button', { name: 'Find public emails once' });
        await websiteScanButton.waitFor();
        await websiteScanButton.click();
        await page.getByText('hello@contact-ui.example.test', { exact: true }).waitFor();
        await page.getByText('support@contact-ui.example.test', { exact: true }).waitFor();
        assert.equal(await page.locator('.contact-email-source a').count(), 2,
          'the detail panel displays both page-level evidence links after the real action');
        assert.equal(await page.getByRole('button', { name: 'Find public emails once' }).count(), 0,
          'the completed contact cannot start a second scan from the UI');
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_website_email_scans WHERE lead_id=? AND status='completed'").get(seededContact.id).count, 1);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=? AND source='website_scan' AND verification_status='unknown'").get(seededContact.id).count, 2);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(seededContact.id).count, 0,
          'website discovery does not create campaign or SMTP work');
        assert.ok(websiteScanRequests.length >= 4 && websiteScanRequests.every(item => new URL(item.url).origin === 'https://contact-ui.example.test'));
        assert.ok(websiteScanRequests.every(item => item.options.redirect === 'manual'));
      }
      const routeState = await page.evaluate(() => {
        const main = document.getElementById('main-content');
        return {
          text: main?.innerText?.trim() || '',
          viewCount: main?.querySelectorAll('.page-view').length || 0,
          horizontalPageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          mainClientWidth: main?.clientWidth || 0,
          mainScrollWidth: main?.scrollWidth || 0,
        };
      });
      assert.equal(routeState.viewCount, 1, `${routeId} leaves one active page view`);
      assert.ok(routeState.text.length > 0, `${routeId} renders visible content`);
      assert.doesNotMatch(routeState.text, /This view couldn’t load|Your workspace is unreachable\./, `${routeId} does not end in an error screen`);
      assert.equal(routeState.horizontalPageOverflow, false, `${routeId} does not create document-level horizontal scrolling`);
      audit.push({ routeId, chars: routeState.text.length, mainClientWidth: routeState.mainClientWidth, mainScrollWidth: routeState.mainScrollWidth });
      if (routeId === 'batches' && process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, 'batches-desktop.png'), fullPage: false });
      }
      if (routeId === 'campaigns') {
        await page.getByRole('button', { name: 'New campaign' }).click();
        const dialog = page.getByRole('dialog', { name: 'Create campaign draft' });
        const nameField = dialog.getByRole('textbox', { name: 'Campaign name' });
        await nameField.fill('   ');
        await nameField.press('Enter');
        assert.equal(await nameField.getAttribute('aria-invalid'), 'true', 'blank campaign names receive an inline keyboard-accessible field error');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count, 0, 'invalid input creates no draft');
        await nameField.fill('Synthetic UI campaign');
        await nameField.press('Enter');
        await page.locator('[data-campaign-workspace]').getByRole('heading', { name: 'Synthetic UI campaign', exact: true }).waitFor();
        assert.equal(db.prepare('SELECT name FROM campaigns').get().name, 'Synthetic UI campaign', 'the actual UI action persists the draft through the API');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0, 'creating a draft does not send or queue email');
        await page.locator('[data-campaign-workspace] [data-cw-close]').click();
        const campaignCard = page.locator('.campaign-card').filter({ hasText: 'Synthetic UI campaign' });
        await campaignCard.locator('[data-campaign-audience]').click();
        const audiencePanel = page.locator('#campaign-audience-panel');
        await audiencePanel.getByRole('heading', { name: 'Recipient eligibility' }).waitFor();
        await audiencePanel.getByRole('button', { name: /Add contacts/ }).click();
        const contactPicker = page.getByRole('dialog', { name: 'Choose contacts' });
        const audienceContact = contactPicker.locator('.campaign-contact-option').filter({ hasText: 'Synthetic list contact' });
        await audienceContact.waitFor();
        await audienceContact.locator('input[data-contact-id]').check();
        await contactPicker.getByRole('button', { name: 'Add 1 selected' }).click();
        await audiencePanel.getByRole('cell', { name: 'Synthetic list contact', exact: true }).waitFor();
        const campaignId = db.prepare("SELECT id FROM campaigns WHERE name='Synthetic UI campaign'").get().id;
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaign_enrollments WHERE campaign_id=? AND lead_id=?').get(campaignId, seededContact.id).count, 1,
          'the real campaign audience picker persists an explicit recipient enrollment');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(seededContact.id).count, 0,
          'campaign enrollment does not queue or send email');
        const recipientSearch = audiencePanel.locator('[data-audience-search]');
        await recipientSearch.fill('recipient-does-not-exist');
        await audiencePanel.getByRole('heading', { name: 'No matching recipients' }).waitFor();
        await audiencePanel.locator('[data-audience-search]').fill('Synthetic list contact');
        await audiencePanel.getByRole('cell', { name: 'Synthetic list contact', exact: true }).waitFor();
        await page.waitForFunction(id => {
          const card = [...document.querySelectorAll('.campaign-card')].find(node =>
            Number(node.querySelector('[data-campaign-audience]')?.dataset.campaignAudience) === id);
          return /1 recipients/.test(card?.querySelector('.campaign-meta')?.textContent || '');
        }, campaignId);
        assert.match(await campaignCard.locator('.campaign-meta').innerText(), /1 recipients/,
          'the campaign card updates its enrolled-recipient total immediately');
        assert.equal(await page.locator('#notification-region .studio-toast').count(), 1,
          'the latest desktop action feedback replaces the draft-created toast instead of stacking over the audience table');
        await campaignCard.locator('[data-campaign-sequence]').click();
        const sequencePanel = page.locator('#campaign-sequence-panel');
        await sequencePanel.locator('.campaign-sequence-head h2').getByText('Synthetic UI campaign', { exact: true }).waitFor();
        await sequencePanel.getByRole('button', { name: /Add step/ }).click();
        const sequenceStep = sequencePanel.locator('[data-sequence-step]');
        await sequenceStep.waitFor();
        const stepId = Number(await sequenceStep.getAttribute('data-sequence-step'));
        const sequenceSubject = sequenceStep.locator('[data-sequence-variant="A"] [data-sequence-subject]');
        const sequenceBody = sequenceStep.locator('[data-sequence-variant="A"] [data-sequence-body]');
        await sequenceSubject.fill('A note for {{business_name}}');
        await sequenceBody.fill('Hi {{first_name|there}} at {{business_name}}.');
        await sequenceStep.getByRole('button', { name: 'Save step' }).click();
        await page.locator('#notification-region').getByText('Sequence step saved.').waitFor();
        const savedVariant = db.prepare('SELECT subject_line, body_text FROM campaign_step_variants WHERE step_id=? AND variant_key=?').get(stepId, 'A');
        assert.deepEqual(savedVariant, { subject_line: 'A note for {{business_name}}', body_text: 'Hi {{first_name|there}} at {{business_name}}.' },
          'sequence copy persists through the UI and API');
        assert.equal(Number(await sequencePanel.locator('[data-sequence-preview-contact]').inputValue()), seededContact.id,
          'sequence preview binds the recipient API’s lead_id into the contact picker');
        await sequencePanel.getByRole('button', { name: 'Preview' }).click();
        await page.waitForFunction(() => {
          const result = document.querySelector('#campaign-sequence-panel [data-sequence-preview-result]');
          return result && !result.innerText.includes('Rendering preview…') && result.innerText.trim().length > 0;
        });
        const sequencePreview = await sequencePanel.locator('[data-sequence-preview-result]').innerText();
        assert.match(sequencePreview, /is-ready|complete/i, `sequence preview returned an unresolved state: ${sequencePreview}`);
        assert.equal(sequencePreview.includes('A note for Synthetic list contact'), true,
          'merge preview resolves against the selected enrolled contact');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0,
          'saving and previewing sequence copy never submits email');
        await sequencePanel.getByRole('button', { name: 'Close sequence editor' }).click();
        await campaignCard.locator('[data-campaign-sequence]').click();
        await sequencePanel.locator('[data-sequence-variant="A"] [data-sequence-subject]').waitFor();
        assert.equal(await sequencePanel.locator('[data-sequence-variant="A"] [data-sequence-subject]').inputValue(), 'A note for {{business_name}}',
          'saved sequence copy remains after closing and reopening the editor');
        await sequencePanel.getByRole('button', { name: 'Close sequence editor' }).click();
        await campaignCard.locator('[data-campaign-queue]').click();
        const preflight = page.getByRole('dialog', { name: 'Campaign launch review' });
        await preflight.getByText('Queueing is blocked until the items below are resolved.').waitFor();
        assert.match(await preflight.innerText(), /No sender is assigned to this campaign/, 'launch review explains the missing sender');
        assert.match(await preflight.innerText(), /verification_required/, 'launch review explains that the contact needs verification');
        assert.equal(await preflight.getByRole('button', { name: 'Queue reviewed recipients' }).count(), 0,
          'blocked preflight does not render a queue action');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE campaign_id=?').get(campaignId).count, 0,
          'campaign preflight never creates a send row when blocked');
        await preflight.getByRole('button', { name: 'Close dialog' }).click();
        await page.locator('#campaign-audience-panel [data-audience-close]').click();
        await campaignCard.scrollIntoViewIfNeeded();
        const cardLayout = await page.locator('.campaign-card').evaluate(node => ({
          width: node.clientWidth,
          scrollWidth: node.scrollWidth,
          metricDisplay: getComputedStyle(node.querySelector('.campaign-metrics')).display,
          metricColumns: getComputedStyle(node.querySelector('.campaign-metrics')).gridTemplateColumns.split(' ').length,
        }));
        assert.ok(cardLayout.width > 0 && cardLayout.scrollWidth <= cardLayout.width,
          `campaign card content fits its viewport: ${JSON.stringify(cardLayout)}`);
        assert.equal(cardLayout.metricDisplay, 'grid', 'campaign metrics use a responsive grid instead of a vertical text stack');
        assert.equal(cardLayout.metricColumns, 4, 'desktop campaign metrics form four balanced columns');
        if (process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) {
          await page.locator('#notification-region .studio-toast-dismiss').click().catch(() => {});
          await page.locator('#main-content').evaluate(node => { node.scrollTop = 0; });
          await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, 'campaigns-desktop.png'), fullPage: false });
        }

        await page.getByRole('button', { name: 'New campaign' }).click();
        const failedDialog = page.getByRole('dialog', { name: 'Create campaign draft' });
        await failedDialog.getByRole('textbox', { name: 'Campaign name' }).fill('Retry after outage');
        await page.evaluate(() => window.addEventListener('api:error', event => { window.__uiAuditApiError = event.detail; }, { once: true }));
        expectedCampaignError = true;
        failNextCampaignCreate = true;
        await failedDialog.getByRole('textbox', { name: 'Campaign name' }).press('Enter');
        const failureToast = page.locator('#notification-region .studio-toast.is-error');
        await failureToast.getByText(/service is temporarily unavailable/i).waitFor();
        const failureCopy = await failureToast.innerText();
        assert.doesNotMatch(failureCopy, /Synthetic campaign service outage|API \/api\/|HTTP 503|\{"error"/,
          'the user-facing toast does not expose raw endpoint or server JSON diagnostics');
        const diagnostic = await page.evaluate(() => window.__uiAuditApiError);
        assert.equal(diagnostic.code, 'SERVER_ERROR', 'the API error event retains a typed diagnostic code');
        assert.equal(diagnostic.path, '/api/sending/campaigns', 'the API error event retains the failing endpoint');
        assert.match(diagnostic.message, /Synthetic campaign service outage/, 'the API error event retains the response detail for troubleshooting');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count, 1, 'a failed create does not invent a saved campaign');
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0, 'failed draft creation still does not send email');
      }
    }

    for (const viewport of [{ width: 768, height: 900 }, { width: 390, height: 360 }]) {
      await page.setViewportSize(viewport);
      for (const routeId of routes) {
        const menu = page.getByRole('button', { name: 'Open navigation' });
        if (viewport.width <= 700) {
          await menu.click();
          assert.equal(await menu.getAttribute('aria-expanded'), 'true');
        }
        const navButton = page.locator(`#workspace-navigation [data-view="${routeId}"]`);
        await navButton.click();
        await page.waitForFunction(id => document.getElementById('main-content')?.getAttribute('aria-busy') === 'false'
          && document.querySelector(`#workspace-navigation [data-view="${id}"].active`), routeId, { timeout: 12_000 });
      const routePresentation = await page.locator('.page-view').evaluate(node => {
        const style = getComputedStyle(node);
        return { transform: style.transform, animationFillMode: style.animationFillMode };
      });
      assert.equal(routePresentation.transform, 'none', `${routeId} route animation must not create a containing block for fixed dialogs and drawers`);
      assert.equal(routePresentation.animationFillMode, 'none', `${routeId} animation must release its stacking context after fading in`);
        if (viewport.width <= 700) {
          await page.locator('#workspace-navigation').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
          assert.equal(await menu.getAttribute('aria-expanded'), 'false', `${routeId} closes the mobile navigation after routing`);
        }
      if (routeId === 'leads' && viewport.width === 390) {
        const firstLead = page.locator('.lead-row').first();
        await firstLead.locator('.lead-biz-name').click();
        const drawer = page.locator('#lead-detail-drawer');
        await drawer.waitFor({ state: 'visible' });
        await drawer.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
        const bounds = await drawer.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return { position: getComputedStyle(node).position, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        assert.equal(bounds.position, 'fixed', 'lead details stay attached to the viewport after route entrance');
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 360,
          `the lead details drawer fits a short mobile viewport: ${JSON.stringify(bounds)}`);
        if (process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, 'lead-drawer-390.png'), fullPage: false });
        }
        await drawer.locator('.drawer-close').click();
        await drawer.waitFor({ state: 'hidden' });
      }
      if (routeId === 'personalization' && viewport.width === 390) {
        db.prepare("UPDATE leads SET status='awaiting_approval' WHERE id=?").run(seededContact.id);
        db.prepare(`INSERT INTO personalizations
          (lead_id,subject_variant,subject_line,body_variant,body_text,model_used,guardrail_passed,fact_check_passed,approved)
          VALUES (?,'A','A considered introduction','A','Hello from the synthetic UI audit.','synthetic-ui-test',1,1,0)`)
          .run(seededContact.id);
        await page.locator('.verify-tab[data-filter="awaiting"]').click();
        const card = page.locator('.pers-card').filter({ hasText: 'Synthetic list contact' });
        await card.waitFor({ state: 'visible' });
        const editButton = card.getByRole('button', { name: /Edit/ }).first();
        await editButton.click();
        const editor = page.getByRole('dialog', { name: 'Edit Email Copy' });
        await editor.waitFor({ state: 'visible' });
        const editorLayout = await editor.evaluate(node => {
          const content = node.querySelector('.pers-modal-content').getBoundingClientRect();
          const body = node.querySelector('.pers-modal-body');
          return {
            x: content.x, y: content.y, width: content.width, height: content.height,
            bodyOverflowY: getComputedStyle(body).overflowY,
            bodyClientHeight: body.clientHeight,
            bodyScrollHeight: body.scrollHeight,
          };
        });
        assert.ok(editorLayout.x >= 0 && editorLayout.y >= 0
          && editorLayout.x + editorLayout.width <= 390 && editorLayout.y + editorLayout.height <= 360,
        `the personalization editor stays within a short mobile viewport: ${JSON.stringify(editorLayout)}`);
        assert.equal(editorLayout.bodyOverflowY, 'auto', 'the personalization editor keeps its body scrollable');
        assert.equal(await editor.getAttribute('aria-modal'), 'true', 'the copy editor exposes modal semantics to assistive technology');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'edit-subject', 'opening the editor focuses its first field');
        if (process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, 'personalization-editor-390.png'), fullPage: false });
        }
        await page.keyboard.press('Escape');
        await editor.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '✎ Edit',
          'Escape closes the editor and restores focus to its opener');
        await editButton.click();
        await editor.waitFor({ state: 'visible' });
        await page.mouse.click(2, 2);
        await editor.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '✎ Edit',
          'backdrop click closes the editor and restores focus to its opener');
      }
        const layout = await page.evaluate(() => ({
          viewport: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          shellWidth: document.getElementById('app')?.getBoundingClientRect().width || 0,
          mainWidth: document.getElementById('main-content')?.getBoundingClientRect().width || 0,
          navigationOpen: document.body.classList.contains('navigation-open'),
          text: document.getElementById('main-content')?.innerText?.trim() || '',
        }));
        assert.ok(layout.text.length > 0, `${routeId} remains usable at ${viewport.width}px`);
        assert.ok(layout.documentWidth <= viewport.width, `${routeId} has no page-width overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(layout)}`);
        assert.ok(layout.shellWidth > 0 && layout.mainWidth > 0, `${routeId} shell remains visible at ${viewport.width}px`);
        assert.equal(layout.navigationOpen, false, `${routeId} leaves the navigation overlay closed`);
        if (routeId === 'campaigns') {
          const cardLayout = await page.locator('.campaign-card').evaluate(node => ({
            width: node.clientWidth,
            scrollWidth: node.scrollWidth,
            metricDisplay: getComputedStyle(node.querySelector('.campaign-metrics')).display,
            metricColumns: getComputedStyle(node.querySelector('.campaign-metrics')).gridTemplateColumns.split(' ').length,
          }));
          assert.ok(cardLayout.width > 0 && cardLayout.scrollWidth <= cardLayout.width,
            `${viewport.width}px campaign card content fits: ${JSON.stringify(cardLayout)}`);
          assert.equal(cardLayout.metricDisplay, 'grid');
          assert.equal(cardLayout.metricColumns, viewport.width > 1000 ? 4 : 2,
            `campaign metrics adapt to ${viewport.width}px`);
        }
        if (routeId === 'batches') {
          const cardLayout = await page.locator('.batch-card').evaluate(node => ({
            width: node.clientWidth,
            scrollWidth: node.scrollWidth,
            statDisplay: getComputedStyle(node.querySelector('.batch-card-stats')).display,
            statColumns: getComputedStyle(node.querySelector('.batch-card-stats')).gridTemplateColumns.split(' ').length,
          }));
          assert.ok(cardLayout.width > 0 && cardLayout.scrollWidth <= cardLayout.width,
            `${viewport.width}px batch card content fits: ${JSON.stringify(cardLayout)}`);
          assert.equal(cardLayout.statDisplay, 'grid');
          assert.equal(cardLayout.statColumns, viewport.width > 1000 ? 4 : 2,
            `batch statistics adapt to ${viewport.width}px`);
        }
        if (routeId === 'mailboxes' && viewport.width === 390) {
          await page.getByRole('button', { name: /Connect mailbox/ }).click();
          const mailboxModal = page.locator('#modal-add-mailbox');
          await mailboxModal.locator('#new-mb-email').waitFor();
          const modalGeometry = await mailboxModal.evaluate(node => {
            const content = node.querySelector('.pers-modal-content');
            const body = node.querySelector('.pers-modal-body');
            const firstGrid = node.querySelector('.mailbox-connection-fields');
            const hostGrid = node.querySelector('.mailbox-connection-host-port');
            const contentBounds = content.getBoundingClientRect();
            return {
              contentMaxHeight: getComputedStyle(content).maxHeight,
              contentBox: { x: contentBounds.x, y: contentBounds.y, width: contentBounds.width, height: contentBounds.height, opacity: getComputedStyle(content).opacity },
              bodyOverflowY: getComputedStyle(body).overflowY,
              bodyClientHeight: body.clientHeight,
              bodyScrollHeight: body.scrollHeight,
              fieldColumns: getComputedStyle(firstGrid).gridTemplateColumns.split(' ').length,
              hostColumns: getComputedStyle(hostGrid).gridTemplateColumns.split(' ').length,
            };
          });
          assert.equal(modalGeometry.bodyOverflowY, 'auto', 'the mailbox editor body owns scrolling on short mobile screens');
          assert.ok(modalGeometry.bodyScrollHeight > modalGeometry.bodyClientHeight,
            `long mailbox settings remain reachable inside the modal: ${JSON.stringify(modalGeometry)}`);
          assert.equal(modalGeometry.fieldColumns, 1, 'mailbox identity fields stack on mobile');
          assert.equal(modalGeometry.hostColumns, 1, 'SMTP host and port fields fit the mobile modal');
          assert.ok(modalGeometry.contentBox.width > 0 && modalGeometry.contentBox.height > 0,
            `mailbox dialog content remains inside the viewport: ${JSON.stringify(modalGeometry)}`);
          assert.ok(modalGeometry.contentBox.x >= 0 && modalGeometry.contentBox.y >= 0
            && modalGeometry.contentBox.x + modalGeometry.contentBox.width <= viewport.width
            && modalGeometry.contentBox.y + modalGeometry.contentBox.height <= viewport.height,
          `the complete mailbox dialog stays within the short viewport: ${JSON.stringify(modalGeometry)}`);
          if (process.env.ODD_UI_AUDIT_SCREENSHOT_DIR) {
            mkdirSync(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, { recursive: true });
            await page.waitForTimeout(280);
            audit.push({ routeId: 'mailbox-dialog', ...modalGeometry });
            await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, 'mailbox-dialog-390.png'), fullPage: false });
          }
          await mailboxModal.locator('#new-mb-email').fill('   ');
          await mailboxModal.locator('#btn-save-mailbox').click();
          await mailboxModal.locator('#new-mb-email + .field-error').waitFor();
          assert.equal(await mailboxModal.locator('#new-mb-email').getAttribute('aria-invalid'), 'true',
            'an invalid mailbox address gets field-linked validation');
          assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mailboxes').get().count, 0,
            'invalid mailbox input does not start a network request or create a record');
          await mailboxModal.locator('.pers-modal-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
          const passwordPosition = await mailboxModal.locator('#new-mb-pass').evaluate(node => {
            const bounds = node.getBoundingClientRect();
            const body = node.closest('.pers-modal-body').getBoundingClientRect();
            return { top: bounds.top, bottom: bounds.bottom, bodyTop: body.top, bodyBottom: body.bottom };
          });
          assert.ok(passwordPosition.top >= passwordPosition.bodyTop && passwordPosition.bottom <= passwordPosition.bodyBottom,
            `the last credential field can be scrolled fully into view: ${JSON.stringify(passwordPosition)}`);
          await mailboxModal.locator('.pers-modal-footer button').getByText('Cancel').click();
          await page.getByRole('button', { name: /Connect mailbox/ }).click();
          await page.locator('#modal-add-mailbox').waitFor({ state: 'visible' });
          await page.evaluate(() => window.__nav('dashboard'));
          await page.locator('#modal-add-mailbox').waitFor({ state: 'detached' });
          assert.equal(await page.locator('body > .pers-modal').count(), 0,
            'navigating away restores/removes a portaled mailbox modal instead of leaving an orphan overlay');
        }
        if (routeId === 'campaigns' && viewport.width === 390) {
          const content = page.locator('#main-content');
          const scroll = await content.evaluate(node => ({ overflowY: getComputedStyle(node).overflowY, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
          assert.equal(scroll.overflowY, 'auto', 'short mobile workspace content owns its vertical scrolling');
          assert.ok(scroll.scrollHeight > scroll.clientHeight, 'campaign details extend into a real scrollable area on the short viewport');
          await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
          assert.ok(await content.evaluate(node => node.scrollTop > 0), 'mobile campaign content can be scrolled to its lower controls');
          await content.evaluate(node => { node.scrollTop = 0; });
          await page.evaluate(async () => {
            const { notify } = await import('/js/ui.js');
            notify('Synthetic success message', 'success');
            notify('Latest actionable error', 'error');
          });
          assert.equal(await page.locator('#notification-region .studio-toast').count(), 1, 'compact screens retain only the newest actionable toast');
          const toastStyle = await page.locator('#notification-region .studio-toast').evaluate(node => ({
            regionPointerEvents: getComputedStyle(node.parentElement).pointerEvents,
            toastPointerEvents: getComputedStyle(node).pointerEvents,
            dismissPointerEvents: getComputedStyle(node.querySelector('.studio-toast-dismiss')).pointerEvents,
          }));
          assert.deepEqual(toastStyle, { regionPointerEvents: 'none', toastPointerEvents: 'none', dismissPointerEvents: 'auto' },
            'mobile toast surfaces let workspace actions receive clicks while keeping dismiss controls operable');
          const action = page.locator('[data-campaign-create]');
          const actionBounds = await action.boundingBox();
          const toastBounds = await page.locator('#notification-region .studio-toast').boundingBox();
          assert.ok(actionBounds && toastBounds && (actionBounds.y + actionBounds.height <= toastBounds.y
            || actionBounds.y >= toastBounds.y + toastBounds.height), 'the mobile toast sits clear of the primary campaign action');
          await action.evaluate(node => {
            const parent = node.parentElement;
            const next = node.nextSibling;
            window.__uiAuditCampaignActionPlacement = { parent, next };
            document.body.append(node);
            Object.assign(node.style, { position: 'fixed', inset: 'auto 12px 12px auto', zIndex: '1500' });
          });
          const overlappingAction = await action.boundingBox();
          const overlappingToast = await page.locator('#notification-region .studio-toast').boundingBox();
          assert.ok(overlappingAction && overlappingToast && overlappingAction.x < overlappingToast.x + overlappingToast.width
            && overlappingAction.x + overlappingAction.width > overlappingToast.x
            && overlappingAction.y < overlappingToast.y + overlappingToast.height
            && overlappingAction.y + overlappingAction.height > overlappingToast.y, 'the fixture places a real campaign action underneath the toast surface');
          await action.click();
          const prompt = page.getByRole('dialog', { name: 'Create campaign draft' });
          await prompt.waitFor();
          await prompt.getByRole('button', { name: 'Cancel' }).click();
          assert.equal(db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count, 1, 'click-through does not submit a campaign');
          await action.evaluate(node => {
            const placement = window.__uiAuditCampaignActionPlacement;
            node.removeAttribute('style');
            if (placement?.parent?.isConnected) placement.parent.insertBefore(node,
              placement.next?.parentNode === placement.parent ? placement.next : null);
            delete window.__uiAuditCampaignActionPlacement;
          });
          await page.locator('#notification-region .studio-toast-dismiss').click();
          assert.equal(await page.locator('#notification-region .studio-toast').count(), 0, 'the latest notification can be dismissed');
        }
        if (process.env.ODD_UI_AUDIT_SCREENSHOT_DIR
          && (viewport.width === 390 || ['campaigns', 'dashboard', 'batches'].includes(routeId))) {
          await page.screenshot({ path: path.join(process.env.ODD_UI_AUDIT_SCREENSHOT_DIR, `${routeId}-${viewport.width}.png`), fullPage: false });
        }
      }
    }
    await page.setViewportSize({ width: 1366, height: 900 });

    // Exercise the two worker cancel controls and quick verification through the authenticated UI.
    // These requests must carry the session CSRF token; mutation routes are intercepted so no
    // verifier or personalization provider is started during this browser-only regression.
    let quickVerifyCsrf = '';
    let verifyCancelCsrf = '';
    let personalizeStartCsrf = '';
    let personalizeCancelCsrf = '';
    let failPersonalizeCancel = true;
    let verificationCancelled = false;
    await page.route('**/api/verify/single', async route => {
      quickVerifyCsrf = route.request().headers()['x-csrf-token'] || '';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        result: { email: 'quick-check@example.test', verification_status: 'risky', engine: 'synthetic UI fixture',
          general: { domain: 'example.test', reason: 'Mailbox unconfirmed' },
          verification_evidence: { syntax_status: 'valid', dns_status: 'mail_route_present', provider: 'Other',
            smtp_status: 'rcpt_accepted', mailbox_status: 'unconfirmed', checked_at: '2026-10-12T00:00:00Z',
            diagnostic_reason: 'smtp_rcpt_accepted_not_mailbox_proof' },
          checks: { regex: true, mx: true, smtp: true } },
      }) });
    });
    await page.route('**/api/verify/status*', async route => {
      const data = verificationCancelled
        ? { active: false, jobId: 71, batchId: seededBatch.id, status: 'cancelled', total: 1, processed: 0 }
        : { active: true, jobId: 71, batchId: seededBatch.id, status: 'running', total: 1, processed: 0, currentEmail: 'synthetic@example.test' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.route(`**/api/verify/batch/${seededBatch.id}/cancel`, async route => {
      verifyCancelCsrf = route.request().headers()['x-csrf-token'] || '';
      verificationCancelled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cancelling: true, status: 'cancel_requested' }) });
    });
    await page.locator('#workspace-navigation [data-view="verification"]').click();
    await page.locator('#verify-quick-btn').waitFor();
    await page.locator('#verify-evidence-summary .verify-evidence-metric').first().waitFor();
    const evidenceSummary = await page.locator('#verify-evidence-summary').innerText();
    assert.match(evidenceSummary, /Mailboxes confirmed/);
    assert.match(evidenceSummary, /accepted SMTP recipient does not confirm/i);
    await page.locator('#verify-engine-health summary').waitFor();
    await page.locator('#verify-engine-health summary').click();
    const healthText = await page.locator('#verify-engine-health').innerText();
    assert.match(healthText, /Reacher endpoint contract verified/);
    assert.match(healthText, /Outbound SMTP \/ TCP 25\s+Not tested/);
    assert.match(healthText, /SMTP capability\s+Not determined by API health/);
    await page.locator('#verify-quick-input').fill('quick-check@example.test');
    await page.locator('#verify-quick-btn').click();
    await page.locator('.audit-card-container').waitFor();
    const quickEvidence = await page.locator('.audit-card-container').innerText();
    assert.match(quickEvidence, /Mailbox status: unconfirmed/);
    assert.match(quickEvidence, /not mailbox confirmation/);
    assert.equal(quickVerifyCsrf, decodeURIComponent(csrf), 'Quick Verify sends the active CSRF token');
    await page.locator('#verify-cancel-btn').waitFor({ state: 'visible' });
    await page.locator('#verify-cancel-btn').click();
    await page.locator('#notification-region').getByText(/Cancellation requested/).waitFor();
    assert.equal(verifyCancelCsrf, decodeURIComponent(csrf), 'Cancel verification reaches its authenticated batch route');
    await page.unroute('**/api/verify/single');
    await page.unroute('**/api/verify/status*');
    await page.unroute(`**/api/verify/batch/${seededBatch.id}/cancel`);

    await page.route(`**/api/personalize/batch/${seededBatch.id}`, async route => {
      personalizeStartCsrf = route.request().headers()['x-csrf-token'] || '';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: true, batchId: seededBatch.id, total: 1, processed: 0 }) });
    });
    await page.route('**/api/personalize/cancel', async route => {
      personalizeCancelCsrf = route.request().headers()['x-csrf-token'] || '';
      if (failPersonalizeCancel) {
        failPersonalizeCancel = false;
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'CSRF token was not accepted.' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cancelled: true }) });
    });
    await page.locator('#workspace-navigation [data-view="personalization"]').click();
    const personalizeRunButton = page.locator('#pers-run-btn');
    await personalizeRunButton.waitFor();
    await personalizeRunButton.click();
    await page.locator('#pers-cancel-btn').waitFor({ state: 'visible' });
    await page.locator('#pers-cancel-btn').click();
    await page.locator('#notification-region').getByText('You do not have permission to complete this action.').waitFor();
    assert.equal(await page.locator('#pers-cancel-btn').isEnabled(), true, 'a rejected cancel action remains available for retry');
    await page.locator('#pers-cancel-btn').click();
    await page.locator('#notification-region').getByText('Personalization cancellation requested.').waitFor();
    assert.equal(personalizeStartCsrf, decodeURIComponent(csrf), 'Personalize sends include the active CSRF token');
    assert.equal(personalizeCancelCsrf, decodeURIComponent(csrf), 'Cancel personalization reaches its authenticated route');
    await page.unroute(`**/api/personalize/batch/${seededBatch.id}`);
    await page.unroute('**/api/personalize/cancel');

    failNextSendControlRead = true;
    await page.locator('#workspace-navigation [data-view="settings"]').click();
    await page.locator('.studio-error').waitFor();
    const routeErrorCopy = await page.locator('.studio-error p').innerText();
    assert.match(routeErrorCopy, /workspace service required by this view is unavailable/i,
      'a missing route dependency receives a clear recovery message');
    assert.doesNotMatch(routeErrorCopy, /API \/api\/|Unknown sending route|HTTP 404|\{"error"/,
      'the full-page error state does not expose raw transport details');
    await page.locator('.studio-error [data-retry]').click();
    await page.locator('.settings-control-card').waitFor();
    const scheduleTimezone = page.locator('#send-schedule-timezone');
    await scheduleTimezone.fill('Not/A_Real_Timezone');
    await page.locator('#workspace-send-schedule-save').click();
    const timezoneError = page.locator('#send-schedule-timezone + .field-error');
    await timezoneError.waitFor();
    assert.match(await timezoneError.innerText(), /valid IANA time zone/i,
      'schedule validation explains the invalid timezone beside the field');
    assert.equal(await scheduleTimezone.getAttribute('aria-invalid'), 'true',
      'schedule validation marks the invalid timezone for screen readers and styling');
    assert.equal(await page.locator('#workspace-send-schedule-error').isVisible(), false,
      'a field-specific validation failure does not appear in the unrelated form-level error area');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sending_schedule_events').get().count, 0,
      'invalid schedule input does not create a saved schedule or audit event');
    await scheduleTimezone.fill('Asia/Kolkata');
    await page.locator('#workspace-send-schedule-save').click();
    await page.locator('#notification-region').getByText('Send schedule saved and is now enforced by the worker.').waitFor();
    assert.equal(db.prepare('SELECT timezone FROM sending_schedule_settings WHERE id=1').get().timezone, 'Asia/Kolkata',
      'the corrected schedule persists through the actual Settings API');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sending_schedule_events').get().count, 1,
      'the valid schedule creates one durable audit record');
    await page.locator('#send-schedule-start').fill('20');
    await page.locator('#send-schedule-end').fill('10');
    await page.locator('#workspace-send-schedule-save').click();
    const endHourError = page.locator('#send-schedule-end + .field-error');
    await endHourError.waitFor();
    assert.match(await endHourError.innerText(), /send window/i,
      'a window-order validation error is attached to the end-hour field that must change');
    await page.locator('#send-schedule-end').fill('22');
    await page.locator('#workspace-send-schedule-save').click();
    await page.locator('#notification-region').getByText('Send schedule saved and is now enforced by the worker.').waitFor();
    await page.locator('#send-schedule-min').fill('30');
    await page.locator('#send-schedule-max').fill('10');
    await page.locator('#workspace-send-schedule-save').click();
    const maximumSpacingError = page.locator('#send-schedule-max + .field-error');
    await maximumSpacingError.waitFor();
    assert.match(await maximumSpacingError.innerText(), /pacing/i,
      'a pacing-order validation error is attached to the maximum-spacing field');
    await page.locator('#send-schedule-max').fill('60');
    await page.locator('#workspace-send-schedule-save').click();
    await page.locator('#notification-region').getByText('Send schedule saved and is now enforced by the worker.').waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sending_schedule_events').get().count, 3,
      'only valid timezone, send-window and pacing submissions create audit entries');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0,
      'schedule form validation and all three valid saves never queue or submit a message');

    const pauseReason = page.locator('#workspace-pause-reason');
    await page.locator('#workspace-send-control').click();
    await page.getByText('Add a short reason so the pause is clear in the audit history.', { exact: true }).waitFor();
    assert.equal(db.prepare('SELECT paused FROM sending_control WHERE id=1').get().paused, 0,
      'a missing pause reason is rejected before the real control API is called');
    await pauseReason.fill('Synthetic UI settings audit');
    await page.locator('#workspace-send-control').click();
    const pauseDialog = page.getByRole('alertdialog', { name: 'Pause all campaign sending' });
    await pauseDialog.getByRole('button', { name: 'Pause sending' }).click();
    await page.getByRole('heading', { name: 'All campaign sending is paused' }).waitFor();
    assert.equal(db.prepare('SELECT paused FROM sending_control WHERE id=1').get().paused, 1,
      'the Settings control persists its pause through the real API');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sending_control_events WHERE paused=1 AND reason=?').get('Synthetic UI settings audit').count, 1,
      'the pause reason and operator action are recorded in durable audit history');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0,
      'exercising a workspace pause control does not create or submit a message');
    await page.locator('#workspace-send-control').click();
    const resumeDialog = page.getByRole('alertdialog', { name: 'Resume campaign sending' });
    await resumeDialog.getByRole('button', { name: 'Resume sending' }).click();
    await page.getByRole('heading', { name: 'Campaign sending is enabled' }).waitFor();
    assert.equal(db.prepare('SELECT paused FROM sending_control WHERE id=1').get().paused, 0,
      'the same UI persists resume and leaves the disposable workspace in its original state');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sending_control_events').get().count, 2,
      'pause and resume each create exactly one visible audit event');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends').get().count, 0,
      'resuming this test control still does not send email');

    expectedLogoutFailure = true;
    await page.route('**/api/auth/logout', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic logout outage' }),
    }));
    const logoutButton = page.locator('#workspace-logout');
    await logoutButton.click();
    await page.locator('#notification-region').getByText(/Could not end this session/).waitFor();
    assert.equal(await logoutButton.isEnabled(), true,
      'a temporary logout failure restores the Sign out control for retry');
    assert.equal((await fetch(`${base}/api/auth/status`, { headers: { cookie: browserCookie } }).then(response => response.json())).authenticated, true,
      'a failed logout leaves the authenticated session intact');
    await page.unroute('**/api/auth/logout');
    const logoutResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/logout');
    await logoutButton.click();
    const logoutResponse = await logoutResponsePromise;
    assert.equal(logoutResponse.status(), 200, 'the real logout endpoint accepts the authenticated request');
    await page.waitForFunction(() => location.pathname === '/login', { timeout: 3_000 }).catch(() => {});
    assert.equal(new URL(page.url()).pathname, '/login', `successful logout routes to login (current URL: ${page.url()})`);
    assert.equal((await fetch(`${base}/api/auth/status`, { headers: { cookie: browserCookie } }).then(response => response.json())).authenticated, false,
      'Sign out revokes the actual disposable session before routing to login');

    assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(serverErrors, [], `server errors: ${serverErrors.join('; ')}`);
    assert.ok(unexpectedOrigins.every(origin => ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://accounts.google.com'].includes(origin)),
      `unexpected network origins were blocked: ${unexpectedOrigins.join(', ')}`);
    t.diagnostic(`Audited real SPA routes on disposable SQLite: ${JSON.stringify(audit)}; browser errors=${pageErrors.length}; HTTP 5xx=${serverErrors.length}; external requests blocked=${unexpectedOrigins.length}.`);
  } finally {
    await context.close();
    await browser.close();
  }
});
