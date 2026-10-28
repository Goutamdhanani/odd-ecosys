import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { domainToASCII } from 'node:url';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Retain a source-evaluation check that does not import the app or touch a database.
function evaluateSyntaxSource(source) {
  const start = source.indexOf('export function validateSyntax(email) {');
  const end = source.indexOf('\n// ═', start);
  assert.ok(start >= 0 && end > start, 'validateSyntax source block is present');
  const declaration = source.slice(start, end).trim().replace(/^export /, '');
  return new Function('domainToASCII', 'Buffer', `return (${declaration})`)(domainToASCII, Buffer);
}

const evidenceDir = path.resolve('orchestration/evidence/VERIFIER-M1-INPUT-001');
const r3Dir = path.join(evidenceDir, 'r3');
const fixtureDir = path.join(r3Dir, 'fixtures');
mkdirSync(fixtureDir, { recursive: true });
mkdirSync(path.join(r3Dir, 'logs'), { recursive: true });
const fixtureRunDir = path.join(fixtureDir, `run-${process.pid}-${Date.now()}`);
mkdirSync(fixtureRunDir, { recursive: true });
const dbPath = path.join(fixtureRunDir, 'verifier-domain-input.sqlite');
const sourceText = readFileSync('pipeline/email-verifier.js', 'utf8');
const validateSyntaxSource = evaluateSyntaxSource(sourceText);
const numericCoercionCases = ['Owner@127.1', 'Owner@0x7f000001', 'Owner@0177.0.0.1', 'Owner@2130706433', 'Owner@１２７.１'];

const beforeValidateSyntax = evaluateSyntaxSource(readFileSync('tests/support/verifier-syntax-before-f30490b.mjs', 'utf8'));
for (const input of ['Owner@example.test/path', 'Owner@example.test#frag', 'Owner@%65xample.test', 'Owner@exa\nmple.test']) {
  assert.equal(beforeValidateSyntax(input).is_valid_syntax, true, `frozen before source reproduces acceptance for ${JSON.stringify(input)}`);
}

// Fail closed before importing verifier/server modules. Native fetch is retained
// only for the helper below, which validates the literal ephemeral app origin.
process.env.ODD_DB_PATH = dbPath;
process.env.NODE_ENV = 'test';
process.env.ODD_AUTH_ENFORCE_TESTS = 'true';
process.env.ODD_AUTH_BOOTSTRAP_TOKEN = 'verifier-input-disposable-bootstrap-token-20261022';
process.env.ODD_AUTH_COOKIE_SECURE = 'false';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
const capturedNativeFetch = globalThis.fetch;
const transportAttempts = { fetch: [], socket: [], tls: [], dnsCallback: [], dnsPromise: [], literalListenerBinding: [] };
globalThis.fetch = async (input) => {
  transportAttempts.fetch.push(String(input));
  throw new Error('Blocked by verifier input test: app global fetch is not an allowed transport');
};
const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const option = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (allowedOrigin && option && typeof option === 'object') {
    const parsed = new URL(allowedOrigin);
    const requestedHost = option.host || option.hostname || option.servername;
    const requestedPort = option.port || option.localPort;
    if ((requestedHost === '127.0.0.1' || requestedHost === '::ffff:127.0.0.1') && Number(requestedPort) === Number(parsed.port)) {
      transportAttempts.socket.push(`allowed:${requestedHost}:${option.port}`);
      return originalSocketConnect.apply(this, args);
    }
  }
  transportAttempts.socket.push(JSON.stringify({ arg: option, allowedOrigin }) || String(args[0]));
  throw new Error('Blocked by verifier input test: client sockets are disabled');
};
const originalTlsConnect = tls.connect;
tls.connect = function (...args) {
  transportAttempts.tls.push(String(args[0]));
  throw new Error('Blocked by verifier input test: TLS clients are disabled');
};
const dnsCallbackMethods = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'reverse'];
const originalDnsLookup = dns.lookup;
for (const name of dnsCallbackMethods) {
  if (typeof dns[name] !== 'function') continue;
  dns[name] = (...args) => {
    if (name === 'lookup' && args[0] === '127.0.0.1') {
      transportAttempts.literalListenerBinding.push(args[0]);
      return originalDnsLookup(...args);
    }
    transportAttempts.dnsCallback.push(name);
    throw new Error(`Blocked by verifier input test: DNS ${name} is disabled`);
  };
}
for (const name of dnsCallbackMethods) {
  if (typeof dns.promises[name] !== 'function') continue;
  dns.promises[name] = async (...args) => {
    transportAttempts.dnsPromise.push(name);
    throw new Error(`Blocked by verifier input test: promise DNS ${name} is disabled`);
  };
}

let allowedOrigin = null;
const appFetch = async (url, init = {}) => {
  const parsed = new URL(url);
  assert.ok(allowedOrigin, 'app origin is set only after the ephemeral listener binds');
  assert.equal(parsed.origin, allowedOrigin, 'test API helper is restricted to the ephemeral app origin');
  assert.equal(parsed.protocol, 'http:');
  assert.equal(parsed.hostname, '127.0.0.1');
  return capturedNativeFetch(parsed, init);
};

const { validateSyntax, verifyEmail } = await import('../pipeline/email-verifier.js');
const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { server } = await import('../server.js');
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
allowedOrigin = new URL(base).origin;
let ownerSession;
let ownerCsrf;

after(async () => {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  closeDb();
  writeFileSync(path.join(r3Dir, 'logs', 'transport-attempts-r3.json'), JSON.stringify(transportAttempts, null, 2) + '\n');
  net.Socket.prototype.connect = originalSocketConnect;
  tls.connect = originalTlsConnect;
});

function syntaxCases() {
  return [
    'Owner@example.test/path',
    'Owner@example.test\\path',
    'Owner@example.test?query',
    'Owner@example.test#frag',
    'Owner@%65xample.test',
    'Owner@exa\nmple.test',
    'Owner@exa\tmple.test',
    'Owner@exa\rmple.test',
    'Owner@exa\u0000mple.test',
    'Owner@exa mple.test',
    'Owner@exa\u00a0mple.test',
    'Owner@example.test:25',
    'Owner@[2001:db8::1]',
    'Owner@127.1',
    'Owner@0x7f000001',
    'Owner@0177.0.0.1',
    'Owner@2130706433',
    'Owner@１２７.１',
  ];
}

test('raw-domain input is rejected before IDNA while supported address forms remain intact', async () => {
  assert.equal(validateSyntax('  Sales.Team+tag@BÜCHER.Example\t').normalizedEmail, 'Sales.Team+tag@xn--bcher-kva.example');
  assert.deepEqual(validateSyntax('  Sales.Team+tag@BÜCHER.Example\t').normalization,
    ['trimmed_outer_whitespace', 'idn_domain_to_ascii']);
  assert.equal(validateSyntax('A.B+tag@EXAMPLE.TEST').normalizedEmail, 'A.B+tag@example.test');
  assert.equal(validateSyntax('"quoted space"@example.test').normalizedEmail, '"quoted space"@example.test');
  assert.equal(validateSyntax('δοκιμή@παράδειγμα.δοκιμή').requiresSmtpUtf8, true);
  assert.equal(validateSyntax('Owner@BÜCHER.Example').normalizedEmail, 'Owner@xn--bcher-kva.example');
  assert.equal(validateSyntax('Owner@XN--BCHER-KVA.EXAMPLE').normalizedEmail, 'Owner@xn--bcher-kva.example');
  assert.equal(validateSyntax('Owner@127.0.0.1').normalizedEmail, 'Owner@127.0.0.1',
    'canonical dotted IPv4 stays unchanged rather than being rejected or rewritten');
  assert.equal(validateSyntax('Owner@127.0.0.1.example').normalizedEmail, 'Owner@127.0.0.1.example',
    'numeric labels inside an ordinary DNS name remain valid');

  for (const raw of syntaxCases()) {
    const syntax = validateSyntax(raw);
    assert.equal(syntax.is_valid_syntax, false, JSON.stringify(raw));
    assert.equal(syntax.originalEmail, raw, 'the exact supplied input remains evidence');
    assert.equal(syntax.reason, 'invalid_domain_input_characters', JSON.stringify(raw));
  }

  const calls = { reacherHealth: 0, reacherFetch: 0, mx: 0, a: 0, aaaa: 0, disify: 0, smtp: 0 };
  for (const raw of syntaxCases()) {
    const result = await verifyEmail(raw, {
      isReacherAvailableImpl: async () => { calls.reacherHealth++; return true; },
      reacherFetchImpl: async () => { calls.reacherFetch++; throw new Error('unexpected Reacher call'); },
      resolveMxImpl: async () => { calls.mx++; throw new Error('unexpected MX lookup'); },
      resolve4Impl: async () => { calls.a++; throw new Error('unexpected A lookup'); },
      resolve6Impl: async () => { calls.aaaa++; throw new Error('unexpected AAAA lookup'); },
      checkDisifyImpl: async () => { calls.disify++; throw new Error('unexpected Disify call'); },
      smtpProbeImpl: async () => { calls.smtp++; throw new Error('unexpected SMTP probe'); },
    });
    assert.equal(result.engine, 'local_syntax_gate');
    assert.equal(result.verification_status, 'undeliverable');
    assert.equal(result.reacher.syntax.originalEmail, raw);
    assert.equal(result.reacher.syntax.is_valid_syntax, false);
    assert.equal(result.checks.mx, null);
    assert.equal(result.checks.smtp, null);
  }
  const smtpUtf8 = await verifyEmail('δοκιμή@παράδειγμα.δοκιμή', {
    isReacherAvailableImpl: async () => { calls.reacherHealth++; return true; },
    reacherFetchImpl: async () => { calls.reacherFetch++; throw new Error('unexpected Reacher call'); },
    resolveMxImpl: async () => { calls.mx++; throw new Error('unexpected MX lookup'); },
    resolve4Impl: async () => { calls.a++; throw new Error('unexpected A lookup'); },
    resolve6Impl: async () => { calls.aaaa++; throw new Error('unexpected AAAA lookup'); },
    checkDisifyImpl: async () => { calls.disify++; throw new Error('unexpected Disify call'); },
    smtpProbeImpl: async () => { calls.smtp++; throw new Error('unexpected SMTP probe'); },
  });
  assert.equal(smtpUtf8.verification_status, 'unknown');
  assert.equal(smtpUtf8.engine, 'smtp_utf8_capability_gate');
  assert.deepEqual(calls, { reacherHealth: 0, reacherFetch: 0, mx: 0, a: 0, aaaa: 0, disify: 0, smtp: 0 });
});

test('authenticated single-check API returns the actual local syntax result without provider or DNS calls', async () => {
  const anonymous = await appFetch(`${base}/api/leads`);
  assert.equal(anonymous.status, 401, 'auth is enforced in the disposable server');
  const password = 'Disposable-verifier-owner-password-22!';
  const bootstrap = await appFetch(`${base}/api/auth/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'verifier-owner@example.test', password, bootstrapToken: process.env.ODD_AUTH_BOOTSTRAP_TOKEN }),
  });
  assert.equal(bootstrap.status, 201);
  const login = await appFetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: 'verifier-owner@example.test', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  const session = cookie.match(/(?:^|,\s*)odd_session=([^;,]+)/)[1];
  const csrf = cookie.match(/(?:^|,\s*)odd_csrf=([^;,]+)/)[1];
  ownerSession = session;
  ownerCsrf = csrf;
  const headers = {
    cookie: `odd_session=${session}; odd_csrf=${csrf}`,
    'x-csrf-token': decodeURIComponent(csrf),
    origin: base,
    'content-type': 'application/json',
  };

  for (const raw of syntaxCases()) {
    const response = await appFetch(`${base}/api/verify/single`, {
      method: 'POST', headers, body: JSON.stringify({ email: raw }),
    });
    assert.equal(response.status, 200, JSON.stringify(raw));
    const payload = await response.json();
    const result = payload.result;
    assert.equal(result.engine, 'local_syntax_gate');
    assert.equal(result.verification_status, 'undeliverable');
    assert.equal(result.reacher.syntax.originalEmail, raw);
    assert.equal(result.reacher.syntax.reason, 'invalid_domain_input_characters');
  }
  const validIdnUtf8 = await appFetch(`${base}/api/verify/single`, {
    method: 'POST', headers, body: JSON.stringify({ email: 'δοκιμή@BÜCHER.Example' }),
  });
  assert.equal(validIdnUtf8.status, 200);
  const validIdnResult = (await validIdnUtf8.json()).result;
  assert.equal(validIdnResult.engine, 'smtp_utf8_capability_gate');
  assert.equal(validIdnResult.verification_status, 'unknown');
  assert.equal(validIdnResult.email, 'δοκιμή@xn--bcher-kva.example');
  assert.equal((await appFetch(`${base}/api/verify/status`, { headers })).status, 200);
  assert.deepEqual(transportAttempts.fetch, [], 'application provider fetches are blocked and none were attempted');
  assert.ok(transportAttempts.socket.every(entry => entry.startsWith('allowed:127.0.0.1:')),
    'only the literal ephemeral app socket is allowed');
  assert.deepEqual(transportAttempts.tls, []);
  assert.deepEqual(transportAttempts.dnsCallback, []);
  assert.deepEqual(transportAttempts.dnsPromise, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 0,
    'single check follows the existing quick-check contract and creates no contact');
});

test('Edge renders a malformed single-check API result and blocks every other origin', async t => {
  const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  if (!existsSync(edgePath)) { t.skip(`Edge executable unavailable at ${edgePath}`); return; }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([
      { name: 'odd_session', value: ownerSession, url: base, httpOnly: true, sameSite: 'Strict' },
      { name: 'odd_csrf', value: ownerCsrf, url: base, sameSite: 'Strict' },
    ]);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      // The shell starts independent Reacher/Ollama health checks; abort those optional
      // probes so the renderer test exercises only the real verification API result.
      if (url.origin !== allowedOrigin || url.pathname === '/api/verify/reacher-status'
        || url.pathname === '/api/personalize/ollama-test') return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#verification`, { waitUntil: 'domcontentloaded' });
    const input = page.locator('#verify-quick-input');
    await input.waitFor();
    for (const raw of numericCoercionCases) {
      await page.waitForFunction(() => !document.querySelector('#verify-quick-btn')?.disabled);
      if (raw.endsWith('１２７.１')) {
        // Chromium's native type=email sanitizes IDNA width characters to ASCII
        // before application code sees them. Keep the real handler and renderer,
        // but expose the supplied raw string to that handler for this regression.
        await input.fill(raw);
        assert.equal(await input.inputValue(), 'Owner@127.1', 'native email control performs width mapping before app code');
        await input.evaluate((element, value) => Object.defineProperty(element, 'value', {
          configurable: true, get: () => value,
        }), raw);
      } else {
        await input.fill(raw);
      }
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url());
        if (url.origin !== allowedOrigin || url.pathname !== '/api/verify/single' || response.request().method() !== 'POST') return false;
        try { return response.request().postDataJSON()?.email === raw; } catch { return false; }
      });
      await page.locator('#verify-quick-btn').click();
      const response = await responsePromise;
      assert.equal(response.status(), 200, `actual verification API accepted ${JSON.stringify(raw)}`);
      const payload = await response.json();
      assert.equal(payload.result.engine, 'local_syntax_gate', JSON.stringify(raw));
      assert.equal(payload.result.reacher.syntax.originalEmail, raw);
      await page.waitForFunction(expected => document.querySelector('#verify-quick-result')?.innerText.includes(expected), raw);
      await page.locator('#verify-quick-btn').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#verify-quick-btn')?.disabled);
      const result = await page.locator('#verify-quick-result').innerText();
      assert.match(result, /UNDELIVERABLE/i, JSON.stringify(raw));
      assert.match(result, /local_syntax_gate/i, `actual renderer identifies local syntax gate for ${JSON.stringify(raw)}`);
      assert.ok(result.includes(raw), `renderer retains ${JSON.stringify(raw)}`);
      if (raw.endsWith('１２７.１')) {
        await page.screenshot({ path: path.join(r3Dir, 'verifier-domain-input-edge-r3.png'), fullPage: true });
      }
    }
    await input.evaluate(element => { delete element.value; });
    await page.waitForFunction(() => !document.querySelector('#verify-quick-btn')?.disabled);
    await input.fill('δοκιμή@xn--bcher-kva.example');
    const validIdnResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === allowedOrigin && url.pathname === '/api/verify/single' && response.request().method() === 'POST';
    });
    await page.locator('#verify-quick-btn').click();
    const validResponse = await validIdnResponse;
    assert.equal(validResponse.status(), 200);
    const validPayload = await validResponse.json();
    assert.equal(validPayload.result.engine, 'smtp_utf8_capability_gate');
    assert.equal(validPayload.result.verification_status, 'unknown');
    await page.waitForFunction(() => /UNKNOWN/i.test(document.querySelector('#verify-quick-result')?.innerText || ''));
    assert.match(await page.locator('#verify-quick-result').innerText(), /UNKNOWN/);
    await page.screenshot({ path: path.join(r3Dir, 'verifier-domain-input-valid-idn-edge-r3.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});
