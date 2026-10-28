import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const blockedBackendFetches = [];
globalThis.fetch = async (input, options = {}) => {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url || String(input);
  const attempt = { url, method: options.method || 'GET', blocked: true };
  blockedBackendFetches.push(attempt);
  throw new Error('INBOX-ID-001 test guard denied backend fetch egress');
};

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-inbox-identifiers-'));
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_DB_PATH = path.join(directory, 'workspace.db');
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'inbox-identifiers-synthetic-bootstrap-token-2026';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
delete process.env.ODD_PUBLIC_BASE_URL;
delete process.env.APP_URL;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
for (const id of [7, 1001, 1002]) {
  db.prepare(`INSERT INTO leads(id,business_name,email,status) VALUES(?,?,?,'sent')`)
    .run(id, `Synthetic contact ${id}`, `contact${id}@recipient.test`);
}
db.prepare(`INSERT INTO mailboxes(id,email,domain,imap_host,imap_user,imap_pass)
  VALUES(1001,'synthetic1001@example.test','example.test','127.0.0.1','synthetic-user','synthetic-no-connect-secret')`).run();
db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,status,sent_at,subject_snapshot,body_snapshot)
  VALUES(1001,1001,1001,'sent',datetime('now','-2 hours'),'Synthetic accepted subject 1001','Synthetic accepted send 1001')`).run();
db.prepare(`INSERT INTO sends(id,lead_id,mailbox_id,status,sent_at,subject_snapshot,body_snapshot)
  VALUES(1002,1002,1001,'sent',datetime('now','-1 hour'),'Synthetic accepted subject 1002','Synthetic accepted send 1002')`).run();
for (const id of [7, 1001, 1002]) {
  db.prepare(`INSERT INTO events(id,send_id,lead_id,event_type,event_at,meta_json)
    VALUES(?,?,?,'replied',datetime('now',?),?)`)
    .run(id, [1001, 1002].includes(id) ? id : null, id,
      id === 1001 ? '-2 minutes' : id === 1002 ? '-1 minute' : '-3 minutes', JSON.stringify({
      from: `contact${id}@recipient.test`, to: 'synthetic1001@example.test',
      receivedTo: 'synthetic1001@example.test', subject: `Synthetic reply subject ${id}`,
      bodyText: `Synthetic persisted reply body ${id}`, bodySnippet: `Synthetic persisted reply body ${id}`,
      messageId: `<inbox-identifiers-${id}@recipient.test>`, sentiment: 'interested',
    }));
}

const { server } = await import('../server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const owner = { email: 'inbox-owner@example.test', password: 'Inbox-fixture-password-2026!' };

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('installed Edge preserves high Inbox identifiers through authenticated thread and read actions', async () => {
  assert.ok(fs.existsSync(EDGE_PATH), `installed Edge is required for this proof: ${EDGE_PATH}`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: EDGE_PATH });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const observed = [];
  const blockedExternalRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === base) observed.push({
      method: request.method(), path: url.pathname, search: url.search,
      hasCsrf: Boolean(request.headers()['x-csrf-token']),
    });
    else blockedExternalRequests.push(request.url());
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Create your workspace account' }).waitFor();
    await page.locator('[name="email"]').fill(owner.email);
    await page.locator('[name="bootstrapToken"]').fill(process.env.ODD_AUTH_BOOTSTRAP_TOKEN);
    await page.locator('[name="password"]').fill(owner.password);
    await page.locator('[name="confirmPassword"]').fill(owner.password);
    await page.getByRole('button', { name: 'Create local account' }).click();
    await page.getByRole('button', { name: owner.email }).waitFor({ timeout: 20000 });
    assert.equal((await page.evaluate(async () => (await fetch('/api/auth/status')).json())).user.role, 'owner');
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await page.locator('[data-inbox-reply="1001"]').waitFor({ timeout: 10000 });
    await page.locator('[data-inbox-reply="1002"]').waitFor({ timeout: 10000 });
    const before = await page.locator('[data-inbox-reply]').evaluateAll(rows => rows.map(row => ({
      dataId: row.dataset.inboxReply, label: row.innerText,
    })));
    const mailbox = page.locator('[data-inbox-mailbox]');
    const mailboxOptions = await mailbox.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent })));
    await mailbox.selectOption('1001');
    const selectedMailbox = await mailbox.inputValue();
    await page.locator('[data-inbox-reply="1001"]').evaluate(button => { button.dataset.inboxReply = '1e3'; });
    const requestsBeforeInvalidClick = observed.length;
    await page.locator('[data-inbox-reply="1e3"]').click();
    await page.waitForTimeout(150);
    assert.equal(observed.length, requestsBeforeInvalidClick, 'malformed control identity causes no request');
    await page.locator('[data-inbox-reply="1e3"]').evaluate(button => { button.dataset.inboxReply = '1001'; });

    await page.locator('[data-inbox-reply="1001"]').click();
    await page.locator('[data-inbox-thread]').getByText('Synthetic persisted reply body 1001', { exact: true }).waitFor({ timeout: 10000 });
    const firstReadState = db.prepare('SELECT event_id,read_at FROM reply_inbox_state ORDER BY event_id').all();
    assert.equal(firstReadState.length, 1);
    assert.equal(firstReadState[0].event_id, 1001);
    assert.ok(firstReadState[0].read_at);
    assert.equal(await page.locator('[data-inbox-thread]').getByText('Synthetic persisted reply body 1002', { exact: true }).count(), 0);

    await page.locator('[data-inbox-reply="1002"]').click();
    await page.locator('[data-inbox-thread]').getByText('Synthetic persisted reply body 1002', { exact: true }).waitFor({ timeout: 10000 });
    const finalReadState = db.prepare('SELECT event_id,read_at FROM reply_inbox_state ORDER BY event_id').all();
    assert.deepEqual(finalReadState.map(row => row.event_id), [1001, 1002]);
    assert.ok(finalReadState.every(row => row.read_at));
    await page.locator('[data-inbox-reply="7"]').click();
    await page.locator('[data-inbox-thread]').getByText('Synthetic persisted reply body 7', { exact: true }).waitFor({ timeout: 10000 });
    const lowIdReadState = db.prepare('SELECT event_id,read_at FROM reply_inbox_state ORDER BY event_id').all();
    assert.deepEqual(lowIdReadState.map(row => row.event_id), [7, 1001, 1002]);
    assert.ok(lowIdReadState.every(row => row.read_at));
    const expectedActionRequests = [
      'POST /api/inbox/replies/1001/read', 'GET /api/inbox/replies/1001',
      'POST /api/inbox/replies/1002/read', 'GET /api/inbox/replies/1002',
      'POST /api/inbox/replies/7/read', 'GET /api/inbox/replies/7',
    ];
    const actionRequests = observed.filter(item => /^\/(?:api\/inbox\/replies\/\d+\/(?:read|unread)|api\/inbox\/replies\/\d+)$/.test(item.path))
      .map(item => `${item.method} ${item.path}`);
    assert.deepEqual(actionRequests, expectedActionRequests);
    assert.ok(observed.filter(item => item.method === 'POST' && /\/read$/.test(item.path)).every(item => item.hasCsrf),
      'both read-state mutations carry the authenticated browser CSRF header');
    const counts = {
      total: await page.locator('[data-inbox-count]').innerText(),
      unread: await page.locator('[data-inbox-unread]').innerText(),
    };
    console.log(`INBOX_ID_AFTER=${JSON.stringify({
      browser: 'Microsoft Edge', ownerRole: 'owner',
      before, afterIds: await page.locator('[data-inbox-reply]').evaluateAll(rows => rows.map(row => row.dataset.inboxReply)),
      mailboxOptions, selectedMailbox, actionRequests, firstReadState, finalReadState, counts,
      blockedExternalRequests, blockedBackendFetches,
      persistedReplyIds: db.prepare("SELECT id FROM events WHERE event_type='replied' ORDER BY id").all().map(row => row.id),
    })}`);
    assert.deepEqual(before.map(row => row.dataId).sort(), ['1001', '1002', '7']);
    assert.equal(selectedMailbox, '1001');
    assert.ok(mailboxOptions.some(option => option.value === '1001'));
    assert.deepEqual(db.prepare("SELECT id FROM events WHERE event_type='replied' ORDER BY id").all().map(row => row.id), [7, 1001, 1002]);
    assert.ok(blockedBackendFetches.every(attempt => attempt.blocked), 'every Node backend fetch attempt is blocked before network dispatch');
  } finally {
    await context.close();
    await browser.close();
  }
});
