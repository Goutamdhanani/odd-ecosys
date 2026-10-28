import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFreeInferenceClient, FreeInferenceError, FREEINFERENCE_ENDPOINTS } from '../pipeline/astra-freeinference-client.js';

const priorKey = process.env.FREEINFERENCE_API_KEY;
test.beforeEach(() => { process.env.FREEINFERENCE_API_KEY = 'local-mock-only-key'; });
test.after(() => {
  if (priorKey === undefined) delete process.env.FREEINFERENCE_API_KEY;
  else process.env.FREEINFERENCE_API_KEY = priorKey;
});

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function catalog(ids = ['glm-5.3-flash']) { return json({ data: ids.map(id => ({ id, object: 'model' })) }); }
function completion(model = 'glm-5.3-flash', overrides = {}) {
  return json({ id: 'req-mock-1', model, choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 3 } }, ...overrides },
  { headers: { 'x-ratelimit-remaining': '7', 'x-secret-like': 'must-not-pass' } });
}

test('discovers authenticated account catalog before inference and freezes preferred model', async () => {
  const calls = [];
  const client = createFreeInferenceClient({ fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, redirect: init.redirect, body: init.body && JSON.parse(init.body) });
    return url.endsWith('/models') ? catalog(['glm-5.3-flash', 'glm-5.3']) : completion('glm-5.3');
  } });
  const result = await client.complete({ messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 10 });
  assert.deepEqual(calls.map(call => call.url), [FREEINFERENCE_ENDPOINTS.models, FREEINFERENCE_ENDPOINTS.chatCompletions]);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls.map(call => call.redirect), ['error', 'error']);
  assert.equal(calls[1].body.model, 'glm-5.3');
  assert.equal(client.model, 'glm-5.3');
  assert.equal(result.actualModel, 'glm-5.3');
  assert.equal(result.usage.totalTokens, 18);
  assert.equal(result.usage.reasoningTokens, 3);
  assert.equal(result.usage.outputTokens, 8); // reasoning is a detail, not added a second time
  assert.equal(result.usage.actualCostMicrousd, null);
  assert.deepEqual(result.quota, { 'x-ratelimit-remaining': '7' });
  assert.equal(JSON.stringify(result).includes('must-not-pass'), false);
  assert.match(calls[0].auth, /^Bearer /);
});

test('chooses flash only when exact glm-5.3 is absent and rejects unavailable catalog', async () => {
  const client = createFreeInferenceClient({ fetchImpl: async () => catalog(['glm-5.3-flash', 'qwen3.6-35b']) });
  assert.equal(await client.discoverModels(), 'glm-5.3-flash');
  const unavailable = createFreeInferenceClient({ fetchImpl: async () => catalog(['glm-5.2']) });
  await assert.rejects(unavailable.discoverModels(), error => error.code === 'model_unavailable');
});

test('rejects returned model drift and never returns it as if selected identity', async () => {
  const client = createFreeInferenceClient({ fetchImpl: async url => url.endsWith('/models') ? catalog() : completion('qwen3.6-35b') });
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'model_identity_mismatch' && error.uncertain);
});

test('handles streaming content, tool-call deltas, usage trailer, and strict identity', async () => {
  const events = [
    { id: 'req-stream', model: 'glm-5.3-flash', choices: [{ delta: { content: 'ok', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"a"' } }] }, finish_reason: null }] },
    { id: 'req-stream', model: 'glm-5.3-flash', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
    { id: 'req-stream', model: 'glm-5.3-flash', choices: [{ delta: { content: ' tail' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } } },
  ];
  const stream = Readable.toWeb(Readable.from(events.map((event, index) => `data: ${JSON.stringify(event)}${index === events.length - 1 ? '' : '\n\n'}`)));
  let sent;
  const client = createFreeInferenceClient({ fetchImpl: async (url, init) => {
    if (url.endsWith('/models')) return catalog();
    sent = JSON.parse(init.body);
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const result = await client.complete({ messages: [{ role: 'user', content: 'synthetic' }], stream: true, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], tool_choice: 'auto' });
  assert.equal(sent.stream_options.include_usage, true);
  assert.equal(result.message.content, 'ok tail');
  assert.deepEqual(result.message.tool_calls[0], { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } });
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.usage.totalTokens, 10);
  assert.equal(result.usage.reasoningTokens, 2);
});

test('bounds requests and does not retry an ambiguous completion transport failure', async () => {
  let posts = 0;
  const client = createFreeInferenceClient({ fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    posts += 1;
    throw new Error('secret-containing transport error');
  }, maxRetries: 2 });
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'network_error' && error.uncertain && !error.message.includes('secret-containing'));
  assert.equal(posts, 1);
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 16_385 }), FreeInferenceError);
  assert.equal(posts, 1);
});

test('retries safe catalog GET within its bound but opens breaker after a failed inference', async () => {
  let catalogs = 0, posts = 0;
  const client = createFreeInferenceClient({ circuitThreshold: 1, fetchImpl: async url => {
    if (url.endsWith('/models')) { catalogs += 1; return catalogs === 1 ? json({}, { status: 503 }) : catalog(); }
    posts += 1;
    return json({}, { status: 500 });
  } });
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'provider_failed' && error.uncertain);
  assert.equal(catalogs, 2); // bounded retry applies to read-only catalog discovery
  assert.equal(posts, 1); // an ambiguous inference is never retried
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'circuit_open');
  assert.equal(posts, 1);
});

test('fails closed on redirects for catalog and inference requests', async () => {
  const observed = [];
  const redirect = () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.invalid/v1/chat/completions' } });
  const catalogClient = createFreeInferenceClient({ fetchImpl: async (url, init) => {
    observed.push({ url, redirect: init.redirect });
    return redirect();
  } });
  await assert.rejects(catalogClient.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'provider_failed' && error.status === 307);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].redirect, 'error');

  const inferenceClient = createFreeInferenceClient({ fetchImpl: async (url, init) => {
    observed.push({ url, redirect: init.redirect });
    return url.endsWith('/models') ? catalog() : redirect();
  } });
  await assert.rejects(inferenceClient.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'provider_failed' && error.status === 307);
  assert.equal(observed.at(-1).url, FREEINFERENCE_ENDPOINTS.chatCompletions);
  assert.equal(observed.at(-1).redirect, 'error');
});

test('does not treat unterminated empty, missing-finish, or length-limited output as success', async () => {
  const makeStream = payload => new Response(Readable.toWeb(Readable.from([`data: ${JSON.stringify(payload)}`])), { headers: { 'content-type': 'text/event-stream' } });
  const clientFor = payload => createFreeInferenceClient({ fetchImpl: async url => url.endsWith('/models') ? catalog() : makeStream(payload) });
  await assert.rejects(clientFor({ model: 'glm-5.3-flash', choices: [{ delta: { content: 'partial' } }] }).complete({ messages: [{ role: 'user', content: 'synthetic' }], stream: true }), error => error.code === 'incomplete_response' && error.uncertain);
  await assert.rejects(clientFor({ model: 'glm-5.3-flash', choices: [{ delta: { content: '   ' }, finish_reason: 'stop' }] }).complete({ messages: [{ role: 'user', content: 'synthetic' }], stream: true }), error => error.code === 'empty_response' && error.uncertain);
  await assert.rejects(clientFor({ model: 'glm-5.3-flash', choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }).complete({ messages: [{ role: 'user', content: 'synthetic' }], stream: true }), error => error.code === 'output_truncated' && error.uncertain);
});

test('rejects malformed tools, schemas, tool choices, and response formats before inference POST', async () => {
  const circular = { type: 'object' };
  circular.properties = { child: circular };
  const deep = { type: 'string' };
  let cursor = deep;
  for (let index = 0; index < 35; index += 1) { cursor.properties = { child: {} }; cursor = cursor.properties.child; }
  const invalidRequests = [
    { tools: ['malformed'] },
    { tools: [{ type: 'function', function: { name: 'bad name', parameters: { type: 'object' } } }] },
    { tools: [{ type: 'function', function: { name: 'missing_parameters' } }] },
    { tools: [{ type: 'function', function: { name: 'bad_schema', parameters: { type: 'mystery' } } }] },
    { tools: [{ type: 'function', function: { name: 'array_root', parameters: { type: 'array', items: { type: 'string' } } } }] },
    { tools: [{ type: 'function', function: { name: 'unsafe_ref', parameters: { type: 'object', properties: { value: { $ref: '#/definitions/secret' } } } } }] },
    { tools: [{ type: 'function', function: { name: 'circular', parameters: circular } }] },
    { tools: [{ type: 'function', function: { name: 'too_deep', parameters: deep } }] },
    { tools: [{ type: 'function', function: { name: 'declared', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'not_declared' } } },
    { tools: [{ type: 'function', function: { name: 'declared', parameters: { type: 'object' } } }], tool_choice: { type: 'function' } },
    { response_format: { type: 'json_schema', json_schema: { name: 'missing_schema', schema: { type: 'object' } } } },
    { response_format: { type: 'json_schema', json_schema: { name: 'bad_schema', strict: true, schema: { type: 'mystery' } } } },
    { response_format: { type: 'json_schema', json_schema: { name: 'scalar_root', strict: true, schema: { type: 'string' } } } },
    { response_format: { type: 'json_schema', json_schema: { name: 'unsafe_schema', strict: true, schema: { type: 'object', properties: { value: { $dynamicRef: '#anchor' } } } } } },
    { response_format: { type: 'text' } },
  ];
  for (const extra of invalidRequests) {
    let posts = 0;
    const client = createFreeInferenceClient({ fetchImpl: async url => {
      if (url.endsWith('/models')) return catalog();
      posts += 1;
      return completion();
    } });
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }], ...extra }), error => error.code === 'invalid_request');
    assert.equal(posts, 0, `invalid request reached POST: ${JSON.stringify(Object.keys(extra))}`);
  }
});

test('round-trips valid enum and anyOf tool schemas plus structured JSON schema wrapper', async () => {
  let toolPayload, jsonPayload;
  const toolClient = createFreeInferenceClient({ fetchImpl: async (url, init) => {
    if (url.endsWith('/models')) return catalog();
    toolPayload = JSON.parse(init.body);
    return completion('glm-5.3-flash', { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_valid', type: 'function', function: { name: 'select_mode', arguments: '{"mode":"fast","value":2}' } }] }, finish_reason: 'tool_calls' }] });
  } });
  const validTool = { type: 'function', function: { name: 'select_mode', description: 'Select a synthetic mode.', strict: true, parameters: {
    type: 'object', additionalProperties: false,
    properties: { mode: { enum: ['fast', 'safe'] }, value: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
    required: ['mode', 'value'],
  } } };
  const toolResult = await toolClient.complete({ messages: [{ role: 'user', content: 'synthetic' }], tools: [validTool], tool_choice: { type: 'function', function: { name: 'select_mode' } } });
  assert.equal(toolPayload.tool_choice.function.name, 'select_mode');
  assert.equal(toolResult.message.tool_calls[0].function.name, 'select_mode');

  const jsonClient = createFreeInferenceClient({ fetchImpl: async (url, init) => {
    if (url.endsWith('/models')) return catalog();
    jsonPayload = JSON.parse(init.body);
    return completion('glm-5.3-flash', { choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] });
  } });
  const responseFormat = { type: 'json_schema', json_schema: { name: 'probe_result', strict: true, schema: {
    type: 'object', additionalProperties: false, properties: { ok: { enum: [true, false] } }, required: ['ok'],
  } } };
  const jsonResult = await jsonClient.complete({ messages: [{ role: 'user', content: 'synthetic' }], response_format: responseFormat });
  assert.deepEqual(jsonPayload.response_format, responseFormat);
  assert.equal(jsonResult.message.content, '{"ok":true}');
});

test('requires process environment credential and durable dispatch callback precedes POST', async () => {
  const saved = process.env.FREEINFERENCE_API_KEY;
  delete process.env.FREEINFERENCE_API_KEY;
  assert.throws(() => createFreeInferenceClient({ apiKey: 'must-be-ignored' }), error => error.code === 'credential_missing');
  process.env.FREEINFERENCE_API_KEY = saved;
  const checkpoints = [];
  const client = createFreeInferenceClient({ onCheckpoint: async state => checkpoints.push(state.state), fetchImpl: async url => url.endsWith('/models') ? catalog() : completion() });
  await client.complete({ messages: [{ role: 'user', content: 'synthetic' }] });
  assert.deepEqual(checkpoints, ['dispatching', 'settled']);
});

test('canonical pin selects exact flash model and accepts only explicitly reported micro-USD cost', async () => {
  const calls = [];
  const client = createFreeInferenceClient({ approvedModel: 'glm-5.3-flash', fetchImpl: async (url, init) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.endsWith('/models')) return catalog(['glm-5.3', 'glm-5.3-flash']);
    return json({ id: 'req-cost-source', model: 'glm-5.3-flash', choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 }, cost_microusd: 17 } });
  } });
  const result = await client.complete({ messages: [{ role: 'user', content: 'synthetic' }] });
  assert.equal(calls[1].body.model, 'glm-5.3-flash');
  assert.equal(result.actualProvider, 'freeinference');
  assert.equal(result.actualModel, 'glm-5.3-flash');
  assert.equal(result.usage.actualCostMicrousd, 17);
  assert.equal(result.usage.actualCostSource, 'provider_usage.cost_microusd');

  let posts = 0;
  const unavailable = createFreeInferenceClient({ approvedModel: 'glm-5.3-flash', fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog(['glm-5.3']);
    posts += 1;
    return completion();
  } });
  await assert.rejects(unavailable.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => error.code === 'model_unavailable');
  assert.equal(posts, 0);
});

test('429 Retry-After creates bounded backpressure without retrying an inference POST', async () => {
  let posts = 0;
  const client = createFreeInferenceClient({ minPostIntervalMs: 0, maxRateWaitMs: 0, fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    posts += 1;
    return json({ error: 'synthetic rate limit' }, { status: 429, headers: { 'retry-after': '12' } });
  } });
  let firstError;
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error => {
    firstError = error;
    return error.code === 'rate_limited' && error.status === 429 && error.uncertain === false;
  });
  assert.equal(posts, 1);
  assert.ok(firstError.retryAfterMs >= 11_000);
  await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'synthetic' }] }), error =>
    error.code === 'rate_limited' && error.uncertain === false && error.retryAfterMs > 0);
  assert.equal(posts, 1);
});

test('catalog denial remains pre-dispatch and provider authentication rejection is definite', async () => {
  let catalogs = 0, posts = 0, starts = 0;
  const deniedCatalog = createFreeInferenceClient({ approvedModel: 'glm-5.3-flash', fetchImpl: async url => {
    catalogs += 1;
    return url.endsWith('/models') ? json({ error: 'synthetic forbidden' }, { status: 403 }) : (posts += 1, completion());
  } });
  await assert.rejects(deniedCatalog.complete({ messages: [{ role: 'user', content: 'synthetic' }] }, {
    onRequestStart: () => { starts += 1; },
  }), error => error.code === 'auth_failed' && error.status === 403 && error.uncertain === false);
  assert.equal(catalogs, 1);
  assert.equal(posts, 0);
  assert.equal(starts, 0);

  const deniedPost = createFreeInferenceClient({ approvedModel: 'glm-5.3-flash', fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    posts += 1;
    return json({ error: 'synthetic forbidden' }, { status: 403 });
  } });
  await assert.rejects(deniedPost.complete({ messages: [{ role: 'user', content: 'synthetic' }] }, {
    onRequestStart: state => { assert.equal(state.state, 'post_sending'); starts += 1; },
  }), error => error.code === 'auth_failed' && error.status === 403 && error.uncertain === false);
  assert.equal(posts, 1);
  assert.equal(starts, 1);
});

test('serializes concurrent POSTs through one client instance', async () => {
  let active = 0, maximumActive = 0, posts = 0;
  const client = createFreeInferenceClient({ minPostIntervalMs: 0, fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    posts += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return completion();
  } });
  await Promise.all(Array.from({ length: 4 }, () => client.complete({ messages: [{ role: 'user', content: 'synthetic' }] })));
  assert.equal(posts, 4);
  assert.equal(maximumActive, 1);
});

