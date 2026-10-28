import { createHmac, timingSafeEqual } from 'node:crypto';
const BASE_URL = 'https://freeinference.org/v1';
const PREFERRED_MODELS = Object.freeze(['glm-5.3', 'glm-5.3-flash']);
export const FREEINFERENCE_CANONICAL_MODEL = 'glm-5.3-flash';
const MAX_MESSAGES = 128;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const MIN_POST_INTERVAL_MS = 250;
const MAX_POST_QUEUE_DEPTH = 16;
const MAX_RATE_WAIT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const SAFE_HEADERS = Object.freeze([
  'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  'x-quota-limit', 'x-quota-remaining', 'x-quota-reset',
]);

export class FreeInferenceError extends Error {
  constructor(code, message, { status = null, retryable = false, uncertain = false, headers = {} } = {}) {
    super(message);
    this.name = 'FreeInferenceError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
    this.headers = headers;
  }
}

function boundedInt(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new FreeInferenceError('invalid_request', `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function safeHeaders(headers) {
  const result = {};
  for (const name of SAFE_HEADERS) {
    const value = headers?.get?.(name);
    if (typeof value === 'string' && value.length <= 100 && /^[\w.,:/+ -]+$/.test(value)) result[name] = value;
  }
  return result;
}

function safeModelList(payload, approvedModel = null) {
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : null;
  if (!entries || entries.length > 10_000) throw new FreeInferenceError('invalid_catalog', 'FreeInference returned an invalid model catalog.');
  const ids = entries.map(item => item?.id).filter(id => typeof id === 'string' && id.length <= 100);
  const selected = approvedModel || PREFERRED_MODELS.find(id => ids.includes(id));
  if (!selected || !ids.includes(selected)) throw new FreeInferenceError('model_unavailable', 'The account catalog does not include the approved model.');
  return { selected, ids };
}

function normalizeUsage(usage) {
  const input = Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && usage.prompt_tokens <= 1_000_000 ? usage.prompt_tokens : null;
  const output = Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0 && usage.completion_tokens <= 1_000_000 ? usage.completion_tokens : null;
  const reasoning = Number.isSafeInteger(usage?.completion_tokens_details?.reasoning_tokens)
    && usage.completion_tokens_details.reasoning_tokens >= 0 && usage.completion_tokens_details.reasoning_tokens <= 1_000_000
    ? usage.completion_tokens_details.reasoning_tokens : null;
  const actualCostMicrousd = Number.isSafeInteger(usage?.cost_microusd) && usage.cost_microusd >= 0 && usage.cost_microusd <= 9_000_000_000_000_000
    ? usage.cost_microusd : null;
  return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning,
    totalTokens: input !== null && output !== null ? input + output : null, actualCostMicrousd,
    actualCostSource: actualCostMicrousd === null ? null : 'provider_usage.cost_microusd' };
}

const SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const FORBIDDEN_SCHEMA_KEYS = new Set(['$ref', '$dynamicRef', '$recursiveRef', '$anchor', '$dynamicAnchor', '__proto__', 'prototype', 'constructor']);
const SCHEMA_APPLICATORS = new Set(['allOf', 'anyOf', 'oneOf']);
const SCHEMA_OBJECT_MAPS = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const SCHEMA_ARRAYS = new Set(['prefixItems', 'allOf', 'anyOf', 'oneOf']);
const SCHEMA_BOOLEANS = new Set(['uniqueItems', 'readOnly', 'writeOnly', 'deprecated']);
const SCHEMA_NUMBERS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
const SCHEMA_COUNTS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains']);
const SAFE_SCHEMA_METADATA = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', 'const', 'enum', 'type', 'format', 'pattern', 'contentEncoding', 'contentMediaType', 'contentSchema', 'items', 'prefixItems', 'contains', 'minContains', 'maxContains', 'properties', 'patternProperties', 'additionalProperties', 'required', 'dependentRequired', 'dependentSchemas', 'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'uniqueItems', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'readOnly', 'writeOnly', 'deprecated']);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function invalidTool(message = 'The tool or schema declaration is invalid.') {
  return new FreeInferenceError('invalid_request', message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonSchema(root, label, { requireObjectRoot = false } = {}) {
  if (requireObjectRoot && (!isPlainObject(root) || root.type !== 'object')) throw invalidTool(`${label} must have an object root schema.`);
  const active = new WeakSet();
  let nodes = 0;
  function visit(schema, depth) {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) throw invalidTool(`${label} exceeds the schema complexity limit.`);
    if (typeof schema === 'boolean') return;
    if (!isPlainObject(schema) || active.has(schema)) throw invalidTool(`${label} must be a non-circular JSON Schema object.`);
    active.add(schema);
    try {
      const keys = Object.keys(schema);
      if (keys.length > 64) throw invalidTool(`${label} has too many schema keywords.`);
      for (const key of keys) {
        if (FORBIDDEN_SCHEMA_KEYS.has(key) || !SAFE_SCHEMA_METADATA.has(key)) throw invalidTool(`${label} contains an unsupported or unsafe schema keyword.`);
      }
      if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.length || types.length > SCHEMA_TYPES.size || types.some(type => !SCHEMA_TYPES.has(type)) || new Set(types).size !== types.length) throw invalidTool(`${label} has an invalid schema type.`);
      }
      if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 100)) throw invalidTool(`${label} has an invalid enum.`);
      if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 256 || schema.required.some(key => typeof key !== 'string' || key.length > 128 || FORBIDDEN_SCHEMA_KEYS.has(key)) || new Set(schema.required).size !== schema.required.length)) throw invalidTool(`${label} has an invalid required list.`);
      if (schema.description !== undefined && (typeof schema.description !== 'string' || schema.description.length > 1024)) throw invalidTool(`${label} has an invalid description.`);
      if (schema.title !== undefined && (typeof schema.title !== 'string' || schema.title.length > 256)) throw invalidTool(`${label} has an invalid title.`);
      if (schema.format !== undefined && (typeof schema.format !== 'string' || schema.format.length > 128)) throw invalidTool(`${label} has an invalid format.`);
      if (schema.pattern !== undefined) {
        if (typeof schema.pattern !== 'string' || schema.pattern.length > 256) throw invalidTool(`${label} has an invalid pattern.`);
        try { new RegExp(schema.pattern); } catch { throw invalidTool(`${label} has an invalid pattern.`); }
      }
      for (const key of SCHEMA_BOOLEANS) if (schema[key] !== undefined && typeof schema[key] !== 'boolean') throw invalidTool(`${label} has an invalid ${key} value.`);
      for (const key of SCHEMA_NUMBERS) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) || (key === 'multipleOf' && schema[key] <= 0))) throw invalidTool(`${label} has an invalid ${key} value.`);
      for (const key of SCHEMA_COUNTS) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 1_000_000)) throw invalidTool(`${label} has an invalid ${key} value.`);
      for (const key of ['$schema', '$id', 'contentEncoding', 'contentMediaType']) if (schema[key] !== undefined && (typeof schema[key] !== 'string' || schema[key].length > 512)) throw invalidTool(`${label} has an invalid ${key} value.`);
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isPlainObject(schema.additionalProperties)) throw invalidTool(`${label} has invalid additionalProperties.`);
      if (schema.properties !== undefined && !isPlainObject(schema.properties)) throw invalidTool(`${label} properties must be an object.`);
      if (schema.patternProperties !== undefined && !isPlainObject(schema.patternProperties)) throw invalidTool(`${label} patternProperties must be an object.`);
      if (schema.dependentSchemas !== undefined && !isPlainObject(schema.dependentSchemas)) throw invalidTool(`${label} dependentSchemas must be an object.`);
      if (schema.dependentRequired !== undefined) {
        if (!isPlainObject(schema.dependentRequired)) throw invalidTool(`${label} dependentRequired must be an object.`);
        for (const deps of Object.values(schema.dependentRequired)) if (!Array.isArray(deps) || deps.length > 256 || deps.some(dep => typeof dep !== 'string')) throw invalidTool(`${label} has invalid dependentRequired entries.`);
      }
      for (const key of SCHEMA_OBJECT_MAPS) if (schema[key] !== undefined) {
        const entries = Object.entries(schema[key]);
        if (entries.length > 256) throw invalidTool(`${label} has too many schema properties.`);
        for (const [name, child] of entries) {
          if (FORBIDDEN_SCHEMA_KEYS.has(name) || name.length > 256) throw invalidTool(`${label} contains an unsafe property name.`);
          if (key === 'patternProperties') { try { new RegExp(name); } catch { throw invalidTool(`${label} has an invalid pattern property.`); } }
          visit(child, depth + 1);
        }
      }
      for (const key of ['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema', 'additionalProperties']) {
        if (schema[key] !== undefined) {
          if (key === 'items' && Array.isArray(schema[key])) {
            if (schema[key].length > 256) throw invalidTool(`${label} has too many tuple items.`);
            for (const child of schema[key]) visit(child, depth + 1);
          } else visit(schema[key], depth + 1);
        }
      }
      for (const key of SCHEMA_ARRAYS) if (schema[key] !== undefined) {
        if (!Array.isArray(schema[key]) || schema[key].length < (SCHEMA_APPLICATORS.has(key) ? 1 : 0) || schema[key].length > 256) throw invalidTool(`${label} has invalid ${key}.`);
        for (const child of schema[key]) visit(child, depth + 1);
      }
      for (const key of ['enum', 'const', 'default', 'examples']) if (schema[key] !== undefined) validateJsonData(schema[key], label);
    } finally { active.delete(schema); }
  }
  visit(root, 0);
}

function validateJsonData(value, label) {
  const active = new WeakSet();
  let nodes = 0;
  function visit(item, depth) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw invalidTool(`${label} contains a non-JSON value.`); return; }
    if (!item || typeof item !== 'object' || depth > 32 || ++nodes > 10_000 || active.has(item)) throw invalidTool(`${label} contains invalid or circular JSON data.`);
    active.add(item);
    try {
      if (Array.isArray(item)) { if (item.length > 10_000) throw invalidTool(`${label} contains too many values.`); for (const child of item) visit(child, depth + 1); }
      else {
        if (!isPlainObject(item)) throw invalidTool(`${label} contains a non-plain JSON object.`);
        for (const [key, child] of Object.entries(item)) { if (FORBIDDEN_SCHEMA_KEYS.has(key)) throw invalidTool(`${label} contains an unsafe key.`); visit(child, depth + 1); }
      }
    } finally { active.delete(item); }
  }
  visit(value, 0);
}

function validateToolsAndChoice(tools, toolChoice) {
  const declared = new Set();
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length > 32) throw invalidTool('tools must contain at most 32 function declarations.');
    for (const tool of tools) {
      if (!isPlainObject(tool) || tool.type !== 'function' || Object.keys(tool).some(key => !['type', 'function'].includes(key)) || !isPlainObject(tool.function)) throw invalidTool('Each tool must be a function declaration.');
      const fn = tool.function;
      if (Object.keys(fn).some(key => !['name', 'description', 'parameters', 'strict'].includes(key)) || typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name) || declared.has(fn.name)) throw invalidTool('Each function needs a unique supported name.');
      if (fn.description !== undefined && (typeof fn.description !== 'string' || fn.description.length > 1024)) throw invalidTool('Function description exceeds its supported bound.');
      if (typeof fn.strict !== 'undefined' && typeof fn.strict !== 'boolean') throw invalidTool('Function strict must be boolean.');
      if (fn.parameters === undefined) throw invalidTool('Function parameters must be a JSON Schema object.');
      validateJsonSchema(fn.parameters, 'Function parameters', { requireObjectRoot: true });
      declared.add(fn.name);
    }
  }
  if (toolChoice === undefined) return;
  if (typeof toolChoice === 'string') {
    if (!['auto', 'none', 'required'].includes(toolChoice) || (toolChoice === 'required' && declared.size === 0)) throw invalidTool('tool_choice must be auto, none, required with declared tools, or a declared function.');
    return;
  }
  if (!isPlainObject(toolChoice) || toolChoice.type !== 'function' || Object.keys(toolChoice).some(key => !['type', 'function'].includes(key)) || !isPlainObject(toolChoice.function) || Object.keys(toolChoice.function).some(key => key !== 'name') || typeof toolChoice.function.name !== 'string' || !declared.has(toolChoice.function.name)) throw invalidTool('tool_choice must identify a declared function.');
}

function validateResponseFormat(format) {
  if (!isPlainObject(format) || !['json_object', 'json_schema'].includes(format.type)) throw invalidTool('response_format must be json_object or json_schema.');
  if (format.type === 'json_object') {
    if (Object.keys(format).some(key => key !== 'type')) throw invalidTool('json_object response_format accepts only its type field.');
    return;
  }
  if (Object.keys(format).some(key => !['type', 'json_schema'].includes(key)) || !isPlainObject(format.json_schema)) throw invalidTool('json_schema response_format needs a json_schema wrapper.');
  const wrapper = format.json_schema;
  if (Object.keys(wrapper).some(key => !['name', 'description', 'strict', 'schema'].includes(key)) || typeof wrapper.name !== 'string' || !TOOL_NAME.test(wrapper.name) || typeof wrapper.strict !== 'boolean' || wrapper.schema === undefined) throw invalidTool('json_schema requires a valid name, schema, and boolean strict flag.');
  if (wrapper.description !== undefined && (typeof wrapper.description !== 'string' || wrapper.description.length > 1024)) throw invalidTool('json_schema description exceeds its supported bound.');
  validateJsonSchema(wrapper.schema, 'Response JSON Schema', { requireObjectRoot: true });
}

function validateChatRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new FreeInferenceError('invalid_request', 'A chat request object is required.');
  const allowed = new Set(['messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'stream', 'presence_penalty', 'frequency_penalty', 'seed']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw new FreeInferenceError('invalid_request', 'The chat request contains unsupported fields.');
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > MAX_MESSAGES) throw new FreeInferenceError('invalid_request', 'messages must contain between 1 and 128 entries.');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(request), 'utf8'); } catch { throw new FreeInferenceError('invalid_request', 'The request must be JSON serializable.'); }
  if (bytes > MAX_INPUT_BYTES) throw new FreeInferenceError('input_too_large', 'Serialized request exceeds the 256 KiB input limit.');
  for (const message of request.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new FreeInferenceError('invalid_request', 'Each message needs a supported role.');
    if (typeof message.content !== 'string' && !Array.isArray(message.content) && message.content !== null) throw new FreeInferenceError('invalid_request', 'Message content must be text, text parts, or null.');
    if (typeof message.content === 'string' && Buffer.byteLength(message.content, 'utf8') > MAX_INPUT_BYTES) throw new FreeInferenceError('input_too_large', 'A message exceeds the input limit.');
  }
  const output = request.max_tokens ?? request.max_completion_tokens ?? 2048;
  boundedInt(output, 'max_tokens', 1, MAX_OUTPUT_TOKENS);
  if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined) throw new FreeInferenceError('invalid_request', 'Specify only one output token limit.');
  validateToolsAndChoice(request.tools, request.tool_choice);
  if (request.reasoning_effort !== undefined && !['low', 'high', 'max'].includes(request.reasoning_effort)) throw new FreeInferenceError('invalid_request', 'reasoning_effort must be low, high, or max.');
  if (request.response_format !== undefined) validateResponseFormat(request.response_format);
  const { max_completion_tokens: _alias, ...body } = request;
  return { ...body, max_tokens: output, stream: request.stream === true };
}

async function readBounded(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new FreeInferenceError('response_too_large', 'Provider response exceeded the configured size limit.', { uncertain: true });
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) throw new FreeInferenceError('response_too_large', 'Provider response exceeded the configured size limit.', { uncertain: true });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
      total += chunk.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* ignore stream close failure */ }
        throw new FreeInferenceError('response_too_large', 'Provider response exceeded the configured size limit.', { uncertain: true });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    if (error instanceof FreeInferenceError) throw error;
    throw new FreeInferenceError('invalid_response', 'FreeInference response could not be read.', { uncertain: true });
  }
}

function providerError(response, headers, { catalog = false } = {}) {
  const status = response.status;
  if (status === 401 || status === 403) return new FreeInferenceError('auth_failed', 'FreeInference rejected the configured credential.', { status, headers });
  if (status === 429) return new FreeInferenceError('rate_limited', 'FreeInference rate limited the request.', { status, retryable: catalog, uncertain: false, headers });
  return new FreeInferenceError('provider_failed', 'FreeInference returned an unsuccessful response.', { status, retryable: status >= 500, headers, uncertain: true });
}

function parseSseEvent(event) {
  const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { throw new FreeInferenceError('invalid_stream', 'FreeInference returned malformed streaming data.', { uncertain: true }); }
}

function applySseChunk(chunk, state) {
  if (!chunk) return;
  state.id ||= typeof chunk.id === 'string' ? chunk.id.slice(0, 200) : null;
  if (typeof chunk.model === 'string') {
    if (state.actualModel && state.actualModel !== chunk.model) throw new FreeInferenceError('model_identity_mismatch', 'FreeInference returned inconsistent model identities in the stream.', { uncertain: true });
    state.actualModel = chunk.model.slice(0, 100);
  }
  state.usage = chunk.usage || state.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta;
  if (typeof delta?.content === 'string') state.content += delta.content;
  for (const call of delta?.tool_calls || []) {
    const index = Number.isSafeInteger(call.index) ? call.index : 0;
    const existing = state.toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (call.id) existing.id += call.id;
    if (call.type) existing.type = call.type;
    if (call.function?.name) existing.function.name += call.function.name;
    if (call.function?.arguments) existing.function.arguments += call.function.arguments;
    state.toolCalls.set(index, existing);
  }
}

async function consumeSse(response, { signal, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!response.body?.getReader) throw new FreeInferenceError('invalid_stream', 'Streaming response body is unavailable.', { uncertain: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = { buffer: '', received: 0, content: '', usage: null, id: null, actualModel: null, finishReason: null, toolCalls: new Map() };
  try {
    while (true) {
      if (signal?.aborted) throw new FreeInferenceError('aborted', 'The provider request was aborted.', { uncertain: true });
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      state.received += bytes.byteLength;
      if (state.received > maxBytes) throw new FreeInferenceError('response_too_large', 'Provider stream exceeded the configured size limit.', { uncertain: true });
      state.buffer += typeof value === 'string' ? value : decoder.decode(bytes, { stream: true });
      let index;
      while ((index = state.buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = state.buffer.slice(0, index);
        const sep = state.buffer.slice(index).match(/^\r?\n\r?\n/)[0];
        state.buffer = state.buffer.slice(index + sep.length);
        applySseChunk(parseSseEvent(event), state);
      }
    }
    state.buffer += decoder.decode();
    if (state.buffer.trim()) applySseChunk(parseSseEvent(state.buffer), state);
  } catch (error) {
    try { await reader.cancel(); } catch { /* ignore stream close failure */ }
    throw error;
  }
  const message = { role: 'assistant', content: state.content };
  if (state.toolCalls.size) message.tool_calls = [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return { id: state.id, model: state.actualModel, choices: [{ index: 0, message, finish_reason: state.finishReason }], usage: state.usage || null };
}

/**
 * Native FreeInference client. The first network operation is an authenticated GET /models;
 * the selected model ID is frozen for this client instance and never silently changed.
 * Inject fetchImpl only for local compatibility tests. Credentials are read only from env.
 */
function retryAfterDuration(headers, now = Date.now()) {
  const raw = headers?.['retry-after'];
  if (typeof raw !== 'string') return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(raw.trim())) ms = Number(raw.trim()) * 1000;
  else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    ms = at - now;
  }
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(ms));
}

function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new FreeInferenceError('aborted', 'The provider request was aborted.'));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new FreeInferenceError('aborted', 'The provider request was aborted.'));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createFreeInferenceClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  maxRetries = MAX_RETRIES,
  circuitThreshold = 3,
  circuitResetMs = 60_000,
  onCheckpoint = null,
  approvedModel = null,
  catalogReceipt = null,
  minPostIntervalMs = MIN_POST_INTERVAL_MS,
  maxPostQueueDepth = MAX_POST_QUEUE_DEPTH,
  maxRateWaitMs = MAX_RATE_WAIT_MS,
} = {}) {
  const apiKey = process.env.FREEINFERENCE_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new FreeInferenceError('credential_missing', 'FREEINFERENCE_API_KEY is not configured.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  boundedInt(timeoutMs, 'timeoutMs', 100, MAX_TIMEOUT_MS);
  boundedInt(maxRetries, 'maxRetries', 0, MAX_RETRIES);
  boundedInt(circuitThreshold, 'circuitThreshold', 1, 10);
  boundedInt(circuitResetMs, 'circuitResetMs', 100, 10 * 60_000);
  if (approvedModel !== null && !PREFERRED_MODELS.includes(approvedModel)) throw new FreeInferenceError('invalid_request', 'approvedModel must be an explicitly supported GLM model ID.');
  boundedInt(minPostIntervalMs, 'minPostIntervalMs', 0, 60_000);
  boundedInt(maxPostQueueDepth, 'maxPostQueueDepth', 1, 64);
  boundedInt(maxRateWaitMs, 'maxRateWaitMs', 0, MAX_RETRY_AFTER_MS);
  if (onCheckpoint !== null && typeof onCheckpoint !== 'function') throw new TypeError('onCheckpoint must be a function.');
  let selectionPromise = null;
  let selectedModel = null;
  if (catalogReceipt !== null) {
    const { model, verifiedAt, expiresAt, accountBinding } = catalogReceipt;
    const signed = JSON.stringify({ model, verifiedAt, expiresAt });
    const expected = createHmac('sha256', apiKey).update(signed).digest();
    const received = Buffer.from(typeof accountBinding === 'string' ? accountBinding : '', 'hex');
    if (!PREFERRED_MODELS.includes(model) || model !== approvedModel || Date.parse(verifiedAt) > Date.now()
      || !Number.isFinite(Date.parse(verifiedAt)) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()
      || Date.parse(expiresAt) - Date.parse(verifiedAt) > 4 * 60 * 60_000
      || received.length !== expected.length || !timingSafeEqual(expected, received)) {
      throw new FreeInferenceError('invalid_catalog_receipt', 'The saved account catalog receipt is invalid or expired.');
    }
    selectedModel = model;
  }
  let failures = 0, circuitUntil = 0, halfOpen = false;
  let lastPostAt = 0, rateLimitedUntil = 0, rateLimitHeaders = {};
  let postActive = false, queuedPosts = 0;

  function backpressureError(waitMs) {
    const error = new FreeInferenceError('rate_limited', 'FreeInference requests are temporarily backpressured.', {
      status: 429, retryable: false, uncertain: false, headers: rateLimitHeaders,
    });
    error.retryAfterMs = Math.max(0, waitMs);
    return error;
  }

  async function acquirePostSlot(signal) {
    if (queuedPosts >= maxPostQueueDepth) throw new FreeInferenceError('client_backpressure', 'The FreeInference request queue is full.', { retryable: false, uncertain: false });
    queuedPosts += 1;
    let acquired = false;
    try {
      while (postActive) await abortableDelay(10, signal);
      postActive = true;
      acquired = true;
      const now = Date.now();
      const waitMs = Math.max(rateLimitedUntil - now, lastPostAt ? minPostIntervalMs - (now - lastPostAt) : 0, 0);
      if (waitMs > maxRateWaitMs) throw backpressureError(waitMs);
      await abortableDelay(waitMs, signal);
      if (signal?.aborted) throw new FreeInferenceError('aborted', 'The provider request was aborted.');
      lastPostAt = Date.now();
      return () => { postActive = false; };
    } catch (error) {
      if (acquired) postActive = false;
      throw error;
    } finally {
      queuedPosts -= 1;
    }
  }

  function noteRateLimit(headers) {
    const waitMs = retryAfterDuration(headers) ?? 1000;
    rateLimitHeaders = headers || {};
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + waitMs);
  }

  async function fetchWithTimeout(url, init, externalSignal, consume = response => response, onRequestStart = null) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
      if (externalSignal?.aborted) throw new FreeInferenceError('aborted', 'The provider request was aborted.');
      if (onRequestStart) onRequestStart();
      if (externalSignal?.aborted) abort();
      const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
      return await consume(response, controller.signal);
    } catch (error) {
      if (error instanceof FreeInferenceError) throw error;
      throw new FreeInferenceError(externalSignal?.aborted ? 'aborted' : 'network_error', 'FreeInference transport did not return a response.', { retryable: true, uncertain: init.method === 'POST' });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  async function discoverModels({ signal } = {}) {
    if (selectedModel) return selectedModel;
    selectionPromise ||= (async () => {
      let lastError;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response;
        try {
          response = await fetchWithTimeout(`${BASE_URL}/models`, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Cache-Control': 'no-store' } }, signal, async response => {
            if (!response.ok) return { response };
            try { return { response, payload: JSON.parse(await readBounded(response, 512 * 1024)) }; }
            catch (error) { if (error instanceof FreeInferenceError) throw error; throw new FreeInferenceError('invalid_catalog', 'FreeInference returned an invalid model catalog.'); }
          });
        } catch (error) {
          lastError = error;
          if (!error.retryable || attempt === maxRetries) throw error;
          continue;
        }
        const headers = safeHeaders(response.response?.headers || response.headers);
        if (response.response && !response.response.ok) {
          const error = providerError(response.response, headers, { catalog: true });
          error.uncertain = false; // Catalog GET has no inference submission to reconcile.
          if (!error.retryable || attempt === maxRetries) throw error;
          lastError = error;
          const retryAfterMs = retryAfterDuration(headers);
          await abortableDelay(retryAfterMs === null ? 100 * (attempt + 1) : Math.min(1000, retryAfterMs), signal);
          continue;
        }
        const choice = safeModelList(response.payload, approvedModel);
        selectedModel = choice.selected;
        return selectedModel;
      }
      throw lastError || new FreeInferenceError('catalog_unavailable', 'FreeInference model catalog is unavailable.');
    })();
    try { return await selectionPromise; } catch (error) { selectionPromise = null; throw error; }
  }

  function checkCircuit() {
    if (circuitUntil > Date.now()) {
      const error = new FreeInferenceError('circuit_open', 'FreeInference circuit breaker is open.', { headers: rateLimitHeaders });
      error.retryAfterMs = circuitUntil - Date.now();
      throw error;
    }
    if (circuitUntil && circuitUntil <= Date.now()) {
      if (halfOpen) throw new FreeInferenceError('circuit_open', 'A FreeInference circuit recovery probe is already active.', { headers: rateLimitHeaders });
      halfOpen = true;
    }
  }
  function recordFailure() {
    failures += 1;
    if (halfOpen || failures >= circuitThreshold) circuitUntil = Date.now() + circuitResetMs;
    halfOpen = false;
  }
  function recordSuccess() { failures = 0; circuitUntil = 0; halfOpen = false; rateLimitedUntil = 0; rateLimitHeaders = {}; }

  async function complete(request, { signal, idempotencyKey = null, onCheckpoint: requestCheckpoint = null, onRequestStart = null } = {}) {
    const normalized = validateChatRequest(request);
    const model = await discoverModels({ signal });
    checkCircuit();
    if (signal?.aborted) throw new FreeInferenceError('aborted', 'The provider request was aborted.');
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[\w:.-]{8,200}$/.test(idempotencyKey))) throw new FreeInferenceError('invalid_request', 'idempotencyKey must be 8–200 safe characters.');
    if (onRequestStart !== null && typeof onRequestStart !== 'function') throw new TypeError('onRequestStart must be a function.');
    const payload = { ...normalized, model };
    if (payload.stream) payload.stream_options = { include_usage: true };
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: payload.stream ? 'text/event-stream' : 'application/json', 'Cache-Control': 'no-store' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const emitCheckpoint = async state => {
      if (onCheckpoint) await onCheckpoint(state);
      if (requestCheckpoint && requestCheckpoint !== onCheckpoint) await requestCheckpoint(state);
    };
    const releasePostSlot = await acquirePostSlot(signal);
    let attempted = false;
    try {
      await emitCheckpoint(Object.freeze({ state: 'dispatching', provider: 'freeinference', model, endpoint: FREEINFERENCE_ENDPOINTS.chatCompletions, idempotencyKey }));
      if (signal?.aborted) throw new FreeInferenceError('aborted', 'The provider request was aborted.');
      const { response, data } = await fetchWithTimeout(`${BASE_URL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload) }, signal, async (response, requestSignal) => {
        const quota = safeHeaders(response.headers);
        if (!response.ok) throw providerError(response, quota);
        let data;
        if (payload.stream) data = await consumeSse(response, { signal: requestSignal });
        else {
          let text;
          try { text = await readBounded(response); }
          catch (error) { if (error instanceof FreeInferenceError) throw error; throw new FreeInferenceError('invalid_response', 'FreeInference returned an invalid response.', { uncertain: true }); }
          try { data = JSON.parse(text); } catch { throw new FreeInferenceError('invalid_response', 'FreeInference returned an invalid response.', { uncertain: true }); }
        }
        return { response, data };
      }, () => {
        attempted = true;
        onRequestStart?.(Object.freeze({ state: 'post_sending', provider: 'freeinference', model,
          endpoint: FREEINFERENCE_ENDPOINTS.chatCompletions, idempotencyKey }));
      });
      const quota = safeHeaders(response.headers);
      if (typeof data?.model !== 'string' || data.model !== model) throw new FreeInferenceError('model_identity_mismatch', 'FreeInference returned a different model identity than the selected model.', { uncertain: true });
      if (!Array.isArray(data?.choices) || data.choices.length !== 1) throw new FreeInferenceError('invalid_response', 'FreeInference returned an invalid completion shape.', { uncertain: true });
      const choice = data.choices[0];
      const hasText = typeof choice?.message?.content === 'string' && choice.message.content.trim().length > 0;
      const hasTools = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0;
      if (!hasText && !hasTools) throw new FreeInferenceError('empty_response', 'FreeInference returned no assistant content or tool calls.', { uncertain: true });
      if (choice.finish_reason === 'length') throw new FreeInferenceError('output_truncated', 'FreeInference ended the completion at the token limit.', { uncertain: true });
      if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw new FreeInferenceError('incomplete_response', 'FreeInference did not provide a completion finish reason.', { uncertain: true });
      recordSuccess();
      const usage = normalizeUsage(data.usage);
      const result = { id: typeof data.id === 'string' ? data.id.slice(0, 200) : null, provider: 'freeinference', actualProvider: 'freeinference', model, actualModel: data.model,
        endpoint: FREEINFERENCE_ENDPOINTS.chatCompletions,
        message: choice.message, finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        usage, quota, outcome: 'succeeded' };
      await emitCheckpoint(Object.freeze({ state: 'settled', provider: 'freeinference', model,
        endpoint: FREEINFERENCE_ENDPOINTS.chatCompletions, requestId: result.id, outcome: 'succeeded', usage, quota }));
      return result;
    } catch (error) {
      if (attempted) recordFailure();
      const safe = error instanceof FreeInferenceError ? error : new FreeInferenceError('request_failed', 'FreeInference request failed.', { uncertain: attempted });
      if (safe.status === 429) noteRateLimit(safe.headers);
      await emitCheckpoint(Object.freeze({ state: safe.uncertain ? 'uncertain' : 'failed', provider: 'freeinference', model,
        endpoint: FREEINFERENCE_ENDPOINTS.chatCompletions, outcome: safe.code, status: safe.status, quota: safe.headers }));
      if (safe.retryAfterMs === undefined && rateLimitedUntil > Date.now()) safe.retryAfterMs = rateLimitedUntil - Date.now();
      throw safe;
    } finally {
      releasePostSlot();
    }
  }

  return Object.freeze({ discoverModels, complete, get model() { return selectedModel; }, get circuitState() { return circuitUntil > Date.now() ? 'open' : failures ? 'closed-with-failures' : 'closed'; } });
}

export const FREEINFERENCE_ENDPOINTS = Object.freeze({ models: `${BASE_URL}/models`, chatCompletions: `${BASE_URL}/chat/completions` });
