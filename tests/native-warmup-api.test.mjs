import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-native-api-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test'; process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'native-activity-fixture-private-setup-12345';
process.env.ODD_AUTH_COOKIE_SECURE = 'false'; process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
const uuid = '10c50862-d13a-4eea-877e-2171f085cad1';
let upstreamFailure = false; const upstream = [];
const fixture = http.createServer((req, res) => {
  upstream.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
  assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer native-api-fixture-secret');
  if (upstreamFailure) { res.writeHead(503); return res.end('secret-provider-details'); }
  res.setHeader('content-type', 'application/json');
  if (req.url === `/v1/emails/${uuid}`) return res.end(JSON.stringify({ id: uuid, email: 'sender@example.test', warmup: null, warmup_paused_at: '2026-10-18T12:00:00Z', password: 'never-return' }));
  const url = new URL(req.url, 'http://fixture');
  assert.equal(url.pathname, '/v1/analytics/warmup'); assert.equal(url.searchParams.get('email_id'), uuid);
  res.end(JSON.stringify({ email_account_id: uuid, date_range: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
    summary: { total_sent: 4, total_received: 6, total_replied: 2, days_active: 2 },
    daily_stats: [{ date: url.searchParams.get('to'), emails_sent: 4, emails_received: 6, emails_replied: 2, target_volume: 8 }] }));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
process.env.WARMBLY_BASE_URL = `http://127.0.0.1:${fixture.address().port}`;
process.env.WARMBLY_API_KEY = 'native-api-fixture-secret';
const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
db.exec("INSERT INTO mailboxes(id,email,domain,warmup_status,daily_limit,active) VALUES(81,'sender@example.test','example.test','warming',0,1)");
const { server } = await import('../server.js');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const endpoint = '/api/sending/mailboxes/81/native-warmup';
let auth = {}; let session; let csrf;
async function request(route, method = 'GET', body, headers = auth) {
  const response = await fetch(base + route, { method, headers: { origin: base, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
after(async () => {
  server.closeAllConnections(); fixture.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => fixture.close(resolve))]);
  closeDb(); rmSync(directory, { recursive: true, force: true });
});

test('native activity APIs enforce normal owner login and CSRF, persist observations and never activate or send', async () => {
  assert.equal((await request(endpoint)).status, 401);
  const created = await request('/api/auth/bootstrap', 'POST', { email: 'native-owner@example.test', password: 'Native-fixture-password-81!', bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN });
  assert.equal(created.status, 201);
  const cookie = created.headers.get('set-cookie');
  session = cookie.match(/odd_session=([^;,]+)/)[1]; csrf = cookie.match(/odd_csrf=([^;,]+)/)[1];
  auth = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };
  assert.equal((await request(endpoint, 'PUT', { account_id: uuid }, { cookie: auth.cookie })).status, 403);
  assert.equal(upstream.length, 0);
  assert.equal((await request(endpoint, 'PUT', { account_id: 'not-a-uuid' })).status, 422);
  const before = db.prepare('SELECT * FROM mailboxes WHERE id=81').get();
  assert.equal((await request(endpoint, 'PUT', { account_id: uuid })).status, 200);
  const refreshed = await request(endpoint + '/refresh', 'POST', {});
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.observation.account.state, 'paused');
  assert.equal(refreshed.body.observation.summary.total_received, 6);
  assert.equal((await request(endpoint + '/refresh', 'POST', {})).status, 429);
  assert.equal((await request(endpoint + '/start', 'POST', {})).status, 404, 'no native activation route exists');
  assert.equal(JSON.stringify(refreshed.body).includes('never-return'), false);
  assert.deepEqual(db.prepare('SELECT * FROM mailboxes WHERE id=81').get(), before);
  const reopened = new Database(process.env.ODD_DB_PATH, { readonly: true });
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM native_warmup_observations').get().n, 1); reopened.close();
  db.prepare("UPDATE native_warmup_links SET last_attempt_at='2020-01-01T00:00:00Z' WHERE mailbox_id=81").run();
  upstreamFailure = true;
  const failed = await request(endpoint + '/refresh', 'POST', {});
  assert.equal(failed.status, 502);
  assert.equal(JSON.stringify(failed.body).includes('secret-provider-details'), false);
  const retained = await request(endpoint);
  assert.equal(retained.body.observation.stale, true);
  assert.equal(retained.body.observation.summary.total_sent, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  upstreamFailure = false;
});

test('invited operator and reviewer can view observations but cannot link, unlink or refresh native accounts', async () => {
  const before = upstream.length;
  for (const role of ['operator', 'reviewer']) {
    const email = `native-${role}@example.test`;
    const invitation = await request('/api/workspace/invitations', 'POST', { email, role });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const accepted = await request('/api/auth/invitations/accept', 'POST', { email, password: 'Native-member-fixture-password-81!', invitationToken: invitation.body.invitation.token }, {});
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const cookie = accepted.headers.get('set-cookie');
    const session = cookie.match(/odd_session=([^;,]+)/)[1]; const csrf = cookie.match(/odd_csrf=([^;,]+)/)[1];
    const member = { cookie: `odd_session=${session}; odd_csrf=${csrf}`, 'x-csrf-token': csrf };
    const view = await request(endpoint, 'GET', undefined, member);
    assert.equal(view.status, 200); assert.equal(view.body.can_manage, false);
    for (const [route, method] of [[endpoint, 'PUT'], [endpoint, 'DELETE'], [endpoint + '/refresh', 'POST']]) {
      const denied = await request(route, method, method === 'DELETE' ? undefined : { account_id: uuid }, member);
      assert.equal(denied.status, 403, `${role} ${method} ${route}`);
    }
  }
  assert.equal(upstream.length, before);
});

test('actual Mailboxes UI links, refreshes, reloads and unlinks without browser alerts or worker mutations', async () => {
  // Move the disposable fixture beyond its previously tested retry interval.
  db.prepare("UPDATE native_warmup_links SET last_attempt_at='2020-01-01T00:00:00Z' WHERE mailbox_id=81").run();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  try {
    const context = await browser.newContext();
    await context.addCookies([
      { name: 'odd_session', value: session, url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: csrf, url: base, sameSite: 'Strict' },
    ]);
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = []; const dialogs = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.goto(base + '/#mailboxes', { waitUntil: 'domcontentloaded' });
    const panel = page.locator('[data-native-warmup]');
    await panel.getByText('Last saved observation · stale', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Verify & link account' }).click();
    await panel.getByText('Account verified and linked. Refresh to load its activity.', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Refresh activity' }).click();
    await panel.getByText('Activity refreshed from Warmbly.', { exact: true }).waitFor();
    assert.match(await panel.innerText(), /Native worker: paused/);
    assert.match(await panel.innerText(), /Received · Warmbly records\s+6/);
    assert.match(await panel.innerText(), /do not prove inbox placement/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await panel.getByText('Last saved observation', { exact: true }).waitFor();
    assert.equal(await panel.locator('tbody tr').count(), 1);
    const historyBefore = db.prepare('SELECT COUNT(*) AS n FROM native_warmup_observations').get().n;
    const requestsBefore = upstream.length;
    await panel.getByRole('button', { name: 'Unlink from this app' }).click();
    await panel.getByText('No recorded warm-up activity has been loaded. Counts are unknown.', { exact: true }).waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_warmup_observations').get().n, historyBefore);
    assert.equal(upstream.length, requestsBefore);
    assert.equal(db.prepare('SELECT warmup_status FROM mailboxes WHERE id=81').get().warmup_status, 'warming');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
  } finally { await browser.close(); }
});
