import { test } from 'node:test';
import assert from 'node:assert/strict';

test('browser API client adds the readable CSRF cookie only to same-origin mutations', async () => {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  const requests = [];
  globalThis.window = { API_BASE: '', dispatchEvent() {} };
  globalThis.document = { cookie: 'theme=dark; odd_csrf=csrf%2Ffixture-token' };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const { Auth, Batches } = await import('../js/api.js');
    await Auth.logout();
    assert.equal(requests[0].url, '/api/auth/logout');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.equal(requests[0].options.headers['X-CSRF-Token'], 'csrf/fixture-token',
      'logout includes the active session CSRF token required by the server');

    await Auth.recover({ email: 'fixture@example.test', password: 'long-enough-fixture-password', recoveryToken: 'fixture-token' });
    assert.equal(requests[1].options.headers['X-CSRF-Token'], undefined,
      'public recovery handshake does not consume a stale CSRF cookie');

    await Auth.googleNonce();
    assert.equal(requests[2].url, '/api/auth/google/nonce');
    await Auth.googleLogin({ credential: 'fixture-id-token' });
    assert.equal(requests[3].url, '/api/auth/google');
    assert.equal(requests[3].options.method, 'POST');
    assert.equal(requests[3].options.headers['X-CSRF-Token'], undefined,
      'the provider handshake uses its own one-time nonce instead of an existing workspace CSRF token');

    await Batches.create({ name: 'fixture' });
    assert.equal(requests[4].url, '/api/batches');
    assert.equal(requests[4].options.method, 'POST');
    assert.equal(requests[4].options.headers['X-CSRF-Token'], 'csrf/fixture-token');
  } finally {
    if (original.window === undefined) delete globalThis.window; else globalThis.window = original.window;
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    globalThis.fetch = original.fetch;
  }
});
