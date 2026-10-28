import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parse } from 'csv-parse/sync';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-list-export-backpressure-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'fixture-private-bootstrap-token-0123456789';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
delete process.env.HOST;

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const insertLead = db.prepare(`
  INSERT INTO leads (id,business_name,email,city,country,phone,website_url,status)
  VALUES (?,?,?,?,?,?,?,'discovered')
`);
const insertMember = db.prepare('INSERT INTO contact_list_members (list_id,lead_id) VALUES (?,?)');

const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

let owner;
let listId;

before(async () => {
  await createSyntheticList();
});

async function request(route, { method = 'GET', body, cookie = '', csrf = '' } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  return fetch(`${base}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function bootstrapOwner() {
  const response = await request('/api/auth/bootstrap', {
    method: 'POST',
    body: {
      email: 'csv-owner@example.test',
      password: 'Fixture-only-password-9!',
      bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(response.status, 201);
  const cookieHeader = response.headers.get('set-cookie') || '';
  const session = cookieHeader.match(/(?:^|,\s*)odd_session=([^;,]+)/)?.[1];
  const csrfCookie = cookieHeader.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)?.[1];
  assert.ok(session, 'bootstrap must issue an owner session cookie');
  assert.ok(csrfCookie, 'bootstrap must issue a CSRF cookie');
  return { cookie: `odd_session=${session}; odd_csrf=${csrfCookie}`, csrf: decodeURIComponent(csrfCookie) };
}

async function createSyntheticList() {
  owner = await bootstrapOwner();
  const created = await request('/api/lists', {
    method: 'POST', cookie: owner.cookie, csrf: owner.csrf,
    body: { name: 'CSV backpressure fixture', description: 'Synthetic contacts only' },
  });
  assert.equal(created.status, 201);
  listId = (await created.json()).id;

  const addFixture = db.transaction(() => {
    for (let id = 1; id <= 3000; id++) {
      const name = id === 1 ? '=HYPERLINK("https://evil.test","open"), Inc.' : `Synthetic Contact ${String(id).padStart(4, '0')}`;
      const email = id === 1 ? '=SUM(1,2)' : `person${id}@example.test`;
      const city = id === 2 ? 'Pune, Maharashtra' : `City ${id}`;
      const country = id === 3 ? '"Quoted" Republic' : 'Exampleland';
      const phone = id === 4 ? '+1,555-0100' : `+1-555-${String(id).padStart(4, '0')}`;
      const website = id === 5 ? 'https://example.test/path?a=1&b=2' : `https://site${id}.example.test`;
      insertLead.run(id, name, email, city, country, phone, website);
      insertMember.run(listId, id);
    }
  });
  addFixture();
}

function routeResponseFor(res) {
  return String(res.req?.url || '').match(new RegExp(`^/api/lists/${listId}/export(?:$|\\?)`)) !== null;
}

async function withResponseInstrumentation(instrument, run) {
  const originalWrite = http.ServerResponse.prototype.write;
  const originalEnd = http.ServerResponse.prototype.end;
  const captures = [];
  http.ServerResponse.prototype.write = function (...args) {
    if (!routeResponseFor(this)) return originalWrite.apply(this, args);
    let capture = captures.find(entry => entry.res === this);
    if (!capture) {
      capture = { res: this, writes: 0, endCalls: 0, drained: 0, initialErrors: this.listenerCount('error') };
      captures.push(capture);
    }
    capture.writes++;
    return instrument.call(this, capture, originalWrite, args);
  };
  http.ServerResponse.prototype.end = function (...args) {
    const capture = captures.find(entry => entry.res === this);
    if (capture) capture.endCalls++;
    return originalEnd.apply(this, args);
  };
  try {
    return await run(captures);
  } finally {
    http.ServerResponse.prototype.write = originalWrite;
    http.ServerResponse.prototype.end = originalEnd;
  }
}

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

test('authenticated saved-list export streams all 3,000 contacts with the established CSV contract', async () => {
  const anonymous = await request(`/api/lists/${listId}/export`);
  assert.equal(anonymous.status, 401, 'the export requires a normal authenticated session');
  await anonymous.arrayBuffer();

  const response = await request(`/api/lists/${listId}/export`, { cookie: owner.cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="contact-list-${listId}.csv"`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  assert.ok(text.startsWith('\uFEFF"contact_id","business_name","email","verification_status","category","city","country","phone","website_url","status","added_at"\r\n'));
  assert.ok(text.endsWith('\r\n'));

  const records = parse(text, { bom: true, columns: true, record_delimiter: '\r\n' });
  assert.equal(records.length, 3000);
  assert.deepEqual(Object.keys(records[0]), ['contact_id','business_name','email','verification_status','category','city','country','phone','website_url','status','added_at']);
  assert.deepEqual(records.map(row => Number(row.contact_id)).sort((a, b) => a - b), Array.from({ length: 3000 }, (_, index) => index + 1));
  assert.equal(records[0].business_name, "'=HYPERLINK(\"https://evil.test\",\"open\"), Inc.");
  assert.equal(records[0].email, "'=SUM(1,2)");
  assert.equal(records[1].city, 'Pune, Maharashtra');
  assert.equal(records[2].country, '"Quoted" Republic');
  assert.equal(records[3].phone, "'+1,555-0100");
  assert.equal(records[4].website_url, 'https://example.test/path?a=1&b=2');
  assert.equal(records[0].verification_status, 'unknown');
});

test('forced backpressure cycles release drain, close, and error listeners on the actual route response', async () => {
  const result = await withResponseInstrumentation(function (capture, originalWrite, args) {
    originalWrite.apply(this, args);
    setImmediate(() => {
      capture.drained++;
      this.emit('drain');
    });
    return false;
  }, async captures => {
    const response = await request(`/api/lists/${listId}/export`, { cookie: owner.cookie });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await waitFor(() => captures.length === 1 && captures[0].drained >= 11, 'expected more than ten controlled backpressure cycles');
    const capture = captures[0];
    return {
      cycles: capture.drained,
      initialErrors: capture.initialErrors,
      retainedErrors: capture.res.listenerCount('error'),
      retainedDrains: capture.res.listenerCount('drain'),
      retainedCloses: capture.res.listenerCount('close'),
      writes: capture.writes,
    };
  });
  assert.ok(result.cycles > 10, `expected >10 forced cycles; got ${result.cycles}`);
  assert.equal(result.retainedErrors, result.initialErrors, `error listeners accumulated across ${result.cycles} drains`);
  assert.equal(result.retainedDrains, 0);
  assert.equal(result.retainedCloses, 0);
});

test('close or response error while awaiting drain settles and stops further export writes', async () => {
  for (const ending of ['close', 'error', 'write-throw']) {
    const result = await withResponseInstrumentation(function (capture, originalWrite, args) {
      if (ending === 'write-throw' && capture.writes === 1) throw new Error('controlled response write failure');
      originalWrite.apply(this, args);
      if (capture.writes === 1) setImmediate(() => {
        if (ending === 'close') this.destroy();
        else if (ending === 'error') {
          this.emit('error', new Error('controlled client response error'));
          this.destroy();
        }
      });
      return false;
    }, async captures => {
      await assert.rejects(async () => {
        const response = await request(`/api/lists/${listId}/export`, { cookie: owner.cookie });
        await response.arrayBuffer();
      }, /fetch failed|socket|terminated/i);
      await waitFor(() => captures.length === 1 && captures[0].res.destroyed, `${ending} did not destroy the test response`);
      await new Promise(resolve => setTimeout(resolve, 25));
      const capture = captures[0];
      return { writes: capture.writes, endCalls: capture.endCalls, errors: capture.res.listenerCount('error'), drains: capture.res.listenerCount('drain'), closes: capture.res.listenerCount('close') };
    });
    assert.equal(result.writes, 1, `${ending} must stop before generating the next CSV chunk`);
    assert.equal(result.endCalls, 0, `${ending} must not try to finish a partial CSV response`);
    assert.equal(result.errors, 0);
    assert.equal(result.drains, 0);
    assert.equal(result.closes, 0);
  }
  const fresh = await request(`/api/lists/${listId}/export`, { cookie: owner.cookie });
  assert.equal(fresh.status, 200);
  assert.equal(parse(await fresh.text(), { bom: true, columns: true }).length, 3000);
});
