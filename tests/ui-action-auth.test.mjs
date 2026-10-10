import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('verification and personalization writes use the CSRF-aware API client', async () => {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  const requests = [];
  globalThis.window = { API_BASE: '', dispatchEvent() {} };
  globalThis.document = { cookie: 'odd_csrf=ui-action-csrf-token' };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const { Verify, Personalize, Leads } = await import('../js/api.js');
    await Verify.startBatch(7);
    await Verify.cancelBatch(7);
    await Verify.verifySingle('person@example.test');
    await Verify.reVerify(18);
    await Personalize.startBatch(9);
    await Personalize.cancel();
    await Personalize.approve(21);
    await Personalize.reject(22, 'human_rejected');
    await Personalize.edit(23, { subject_line: 'Subject', body_text: 'Body' });
    await Leads.discoverWebsiteEmails(24);

    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
      ['/api/verify/batch/7', 'POST'],
      ['/api/verify/batch/7/cancel', 'POST'],
      ['/api/verify/single', 'POST'],
      ['/api/verify/email/18', 'POST'],
      ['/api/personalize/batch/9', 'POST'],
      ['/api/personalize/cancel', 'POST'],
      ['/api/personalize/approve/21', 'POST'],
      ['/api/personalize/reject/22', 'POST'],
      ['/api/personalize/23', 'PATCH'],
      ['/api/leads/24/website-email-scan', 'POST'],
    ]);
    for (const { options } of requests) {
      assert.equal(options.headers['X-CSRF-Token'], 'ui-action-csrf-token',
        'every authenticated write includes the active workspace CSRF token');
    }
    assert.equal(requests[6].options.body, undefined,
      'empty actions do not invent request data');
    assert.deepEqual(JSON.parse(requests[7].options.body), { reason: 'human_rejected' });
    assert.deepEqual(JSON.parse(requests[8].options.body), { subject_line: 'Subject', body_text: 'Body' });
    assert.deepEqual(JSON.parse(requests[9].options.body), {});

    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'CSRF token was not accepted.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(Personalize.cancel(), error => error.status === 403 && error.code === 'FORBIDDEN',
      'a rejected action is surfaced to the UI instead of being reported as success');
  } finally {
    if (original.window === undefined) delete globalThis.window; else globalThis.window = original.window;
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    globalThis.fetch = original.fetch;
  }
});

test('verification and personalization screens do not bypass shared API error and CSRF handling', () => {
  for (const file of ['verification.js', 'personalization.js']) {
    const source = fs.readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} sends all API reads and writes through js/api.js`);
  }
});
