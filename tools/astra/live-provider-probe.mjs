#!/usr/bin/env node
import { createFreeInferenceClient, FreeInferenceError } from '../../pipeline/astra-freeinference-client.js';

const args = new Set(process.argv.slice(2));
function value(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}
function report(status, details = {}) {
  process.stdout.write(`${JSON.stringify({ provider: 'freeinference', status, ...details }, null, 2)}\n`);
}
function parsePositive(name, max) {
  const raw = value(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : null;
}

if (!args.has('--live')) {
  report('NOT_RUN', { reason: 'Explicit --live flag is required.', usage: 'node tools/astra/live-provider-probe.mjs --live --max-requests N --max-tokens N' });
  process.exitCode = 2;
} else {
  const maxRequests = parsePositive('--max-requests', 3);
  const maxTokens = parsePositive('--max-tokens', 1024);
  if (!maxRequests || !maxTokens) {
    report('BLOCKED', { reason: 'Explicit valid --max-requests (1–3) and --max-tokens (1–1024) caps are required.' });
    process.exitCode = 2;
  } else if (maxTokens < maxRequests) {
    report('BLOCKED', { reason: '--max-tokens must be at least --max-requests to preserve a positive per-request output cap.' });
    process.exitCode = 2;
  } else if (!process.env.FREEINFERENCE_API_KEY?.trim()) {
    report('BLOCKED', { reason: 'FREEINFERENCE_API_KEY is unset in this process.' });
    process.exitCode = 2;
  } else {
    try {
      const client = createFreeInferenceClient();
      const model = await client.discoverModels();
      const perRequestTokens = Math.max(1, Math.floor(maxTokens / maxRequests));
      const calls = [];
      let completionTokensUsed = 0;
      for (let index = 0; index < maxRequests; index += 1) {
        const phase = ['nonstream-text', 'stream-text', 'structured-tool'][index];
        const request = {
          messages: [
            { role: 'system', content: 'Reply with the exact word READY. This is a synthetic connectivity probe; do not infer, request, or reveal real data.' },
            { role: 'user', content: index === 2 ? 'Call confirm_probe with the synthetic value {"ok":true}.' : 'Return READY.' },
          ],
          max_tokens: perRequestTokens,
          reasoning_effort: 'low',
        };
        if (index === 1) request.stream = true;
        if (index === 2) {
          request.tools = [{ type: 'function', function: { name: 'confirm_probe', description: 'Echo a synthetic probe confirmation only.', parameters: {
            type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } },
          } } }];
          request.tool_choice = { type: 'function', function: { name: 'confirm_probe' } };
        }
        const response = await client.complete(request, { idempotencyKey: `probe:synthetic:${index + 1}` });
        if (index < 2 && response.message.content?.trim() !== 'READY') throw new FreeInferenceError('probe_shape_mismatch', 'A synthetic text probe did not return its expected fixed response.', { uncertain: true });
        if (index === 2) {
          let args;
          try { args = JSON.parse(response.message.tool_calls?.[0]?.function?.arguments || ''); } catch { /* shape check below */ }
          if (response.message.tool_calls?.[0]?.function?.name !== 'confirm_probe' || args?.ok !== true) throw new FreeInferenceError('probe_shape_mismatch', 'The structured-tool probe did not return its expected synthetic shape.', { uncertain: true });
        }
        if (response.usage.outputTokens === null) throw new FreeInferenceError('probe_usage_unknown', 'Provider did not return completion-token usage; the token cap cannot be confirmed.', { uncertain: true });
        completionTokensUsed += response.usage.outputTokens;
        if (completionTokensUsed > maxTokens) throw new FreeInferenceError('probe_token_cap_exceeded', 'Provider completion usage exceeded the requested synthetic probe token cap.', { uncertain: true });
        calls.push({ phase, outcome: response.outcome, actualModel: response.actualModel, usage: response.usage, quota: response.quota });
      }
      report('LIVE_RESULT', { selectedModel: model, maxRequests, maxCompletionTokens: maxTokens, completionTokensUsed, calls });
    } catch (error) {
      const safe = error instanceof FreeInferenceError ? error : null;
      report(safe?.code === 'credential_missing' ? 'BLOCKED' : 'LIVE_FAILED', {
        code: safe?.code || 'probe_failed',
        uncertain: safe?.uncertain === true,
        status: safe?.status ?? null,
        quota: safe?.headers || {},
      });
      process.exitCode = safe?.uncertain ? 3 : 1;
    }
  }
}
