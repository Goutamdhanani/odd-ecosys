// Workspace-wide admission for this one optional paid operation. Amounts are
// approved maximum-rate nanoUSD, not invoices or the legacy analytics rate card.
import { createHash } from 'node:crypto';
import { getDb } from './database.js';
import { beginAiUsageRequest, finishAiUsageRequest } from './ai-usage.js';

export const SPEND_SCOPE = 'workspace_bedrock_subject_polish';
export const SPEND_BOUNDS = Object.freeze({
  version: 'sonnet5-us-east1-full-context-v1', inputTokens: 1_000_000,
  outputTokens: 100, maxPayloadBytes: 16_384,
  modelId: 'us.anthropic.claude-sonnet-5', region: 'us-east-1',
});
export const MAX_NANO_USD = 1_000_000_000_000_000n;
export const MAX_RATE = 1_000_000_000n;
const PROMPT_VERSION = 'subject-polish-text-v1';

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function money(value, max = MAX_NANO_USD, positive = true) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw fail('Monetary values must be canonical integer strings.');
  const amount = BigInt(value);
  if (amount > max || (positive && amount === 0n)) throw fail('Monetary value is outside the supported positive range.');
  return amount;
}
function integer(value) {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_NANO_USD || value > 9_223_372_036_854_775_807n) throw fail('Unsafe monetary arithmetic.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || BigInt(result) !== value) throw fail('Unsafe monetary storage.');
  return result;
}
function stored(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('Unsafe stored monetary value.');
  const result = BigInt(value);
  integer(result);
  return result;
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`Invalid ${name}.`);
  return value.trim();
}
function reservation(input, output) {
  const amount = BigInt(SPEND_BOUNDS.inputTokens) * input + BigInt(SPEND_BOUNDS.outputTokens) * output;
  integer(amount);
  return amount;
}
function validatePolicy(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Budget policy must be an object.');
  const allowed = ['expectedRevision','enabled','capNanoUsd','modelId','region','rateVersion','inputNanoUsdPerToken','outputNanoUsdPerToken','priceSource','approvalNote','approveMaximumRates'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw fail('Unknown budget policy field.');
  if (body.expectedRevision !== null && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)) throw fail('Expected revision must be null or a positive integer.');
  if (typeof body.enabled !== 'boolean' || body.approveMaximumRates !== true) throw fail('Explicit approval of maximum rates is required.');
  if (body.modelId !== SPEND_BOUNDS.modelId || body.region !== SPEND_BOUNDS.region) throw fail('Unsupported Bedrock model or source region.');
  const cap = money(body.capNanoUsd);
  const input = money(body.inputNanoUsdPerToken, MAX_RATE);
  const output = money(body.outputNanoUsdPerToken, MAX_RATE);
  reservation(input, output);
  return { cap, input, output, rateVersion: text(body.rateVersion, 'rate version', 120),
    priceSource: text(body.priceSource, 'price source', 1000), approvalNote: text(body.approvalNote, 'approval note', 2000) };
}
function current(db) {
  return db.prepare('SELECT a.* FROM ai_spend_current_policy p JOIN ai_spend_approvals a ON a.revision=p.revision WHERE p.id=1').get() || null;
}
function totals(db) {
  let spent = 0n, held = 0n, uncertainCount = 0, claimedCount = 0;
  // BigInt before addition also guards corrupted storage, without SQLite SUM's
  // overflow or implicit REAL promotion at an arithmetic boundary.
  for (const row of db.prepare('SELECT state,held_nano_usd,settled_nano_usd FROM ai_spend_intents').iterate()) {
    spent += stored(row.settled_nano_usd ?? 0);
    held += stored(row.held_nano_usd);
    integer(spent + held);
    if (row.state === 'uncertain') uncertainCount++;
    if (row.state === 'claimed') claimedCount++;
  }
  return { spent, held, uncertainCount, claimedCount };
}
function operationAdmission(policy, sums, config) {
  if (!policy) return { state: 'unconfigured', reason: 'approval_missing', maximumReservationNanoUsd: null };
  let maximum;
  try {
    maximum = reservation(money(String(policy.input_nano_usd_per_token), MAX_RATE), money(String(policy.output_nano_usd_per_token), MAX_RATE));
    money(String(policy.cap_nano_usd));
    if (policy.model_id !== SPEND_BOUNDS.modelId || policy.region !== SPEND_BOUNDS.region || policy.bounds_version !== SPEND_BOUNDS.version) throw fail('Unsafe policy');
  } catch { return { state: 'blocked', reason: 'unsafe_policy', maximumReservationNanoUsd: null }; }
  let reason = null;
  if (!policy.enabled) reason = 'policy_disabled';
  else if (config?.enabled !== true) reason = 'provider_disabled';
  else if (!config.modelId || !config.region) reason = 'configuration_missing';
  else if (config.modelId !== SPEND_BOUNDS.modelId || config.region !== SPEND_BOUNDS.region) reason = 'unsupported_model_region';
  else if (sums.spent + sums.held + maximum > stored(policy.cap_nano_usd)) reason = 'cap_exhausted';
  return { state: reason === 'policy_disabled' ? 'disabled' : reason ? 'blocked' : 'ready', reason, maximumReservationNanoUsd: String(maximum) };
}
function policyView(row) {
  return row ? { revision: row.revision, enabled: Boolean(row.enabled), capNanoUsd: String(row.cap_nano_usd),
    modelId: row.model_id, region: row.region, rateVersion: row.rate_version,
    inputNanoUsdPerToken: String(row.input_nano_usd_per_token), outputNanoUsdPerToken: String(row.output_nano_usd_per_token),
    priceSource: row.price_source, approvalNote: row.approval_note, approvedByUserId: row.approved_by_user_id, approvedAt: row.approved_at } : null;
}
export function getSpendBudget({ db = getDb(), canManage = false, config } = {}) {
  return db.transaction(() => {
    const policy = current(db), sums = totals(db);
    const available = policy ? stored(policy.cap_nano_usd) - sums.spent - sums.held : 0n;
    return { scope: SPEND_SCOPE, canManage: canManage === true, policy: policyView(policy),
      coverage: { basis: 'admitted_budget_ledger', earlierUsageExcluded: true, otherOperationsExcluded: true },
      totals: { spentNanoUsd: String(sums.spent), heldNanoUsd: String(sums.held), remainingNanoUsd: String(available > 0n ? available : 0n), uncertainCount: sums.uncertainCount, claimedCount: sums.claimedCount },
      admission: operationAdmission(policy, sums, config), bounds: { ...SPEND_BOUNDS },
      recent: db.prepare('SELECT id,state,held_nano_usd,settled_nano_usd,reason,created_at,updated_at FROM ai_spend_intents ORDER BY created_at DESC,id DESC LIMIT 20').all().map(row => ({
        intentId: row.id, state: row.state, heldNanoUsd: String(row.held_nano_usd), settledNanoUsd: row.settled_nano_usd === null ? null : String(row.settled_nano_usd), reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    };
  })();
}
export function approveSpendPolicy(body, actor, db = getDb()) {
  if (!actor || !['owner','admin'].includes(actor.role) || !Number.isSafeInteger(actor.id) || actor.id < 1) throw fail('Only an owner or admin may approve the workspace budget.', 403);
  const fields = validatePolicy(body);
  return db.transaction(() => {
    const previous = current(db);
    if ((previous?.revision ?? null) !== body.expectedRevision) throw fail('Budget policy changed. Reload before saving.', 409);
    if (previous && previous.revision >= Number.MAX_SAFE_INTEGER) throw fail('Policy revision limit reached.');
    const revision = (previous?.revision || 0) + 1;
    db.prepare(`INSERT INTO ai_spend_approvals(revision,enabled,cap_nano_usd,model_id,region,rate_version,input_nano_usd_per_token,output_nano_usd_per_token,price_source,approval_note,approved_by_user_id,approved_by_role,approved_at,bounds_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(revision, Number(body.enabled), integer(fields.cap), body.modelId, body.region, fields.rateVersion, integer(fields.input), integer(fields.output), fields.priceSource, fields.approvalNote, actor.id, actor.role, new Date().toISOString(), SPEND_BOUNDS.version);
    db.prepare('INSERT INTO ai_spend_current_policy(id,revision) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision').run(revision);
    return revision;
  }).immediate();
}
function decision(row, reason) {
  return { state: row?.state || 'denied', reason, intentId: row?.id || null,
    heldNanoUsd: String(row?.held_nano_usd || 0) };
}
export function claimSpendIntent({ db = getDb(), leadId, variant, body, modelId, region, enabled }) {
  if (!Number.isSafeInteger(leadId) || leadId < 1 || typeof variant !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(variant)
    ) return { allowed: false, ...decision(null, 'stable_context_missing') };
  if (typeof body !== 'string' || !body) return { allowed: false, ...decision(null, 'payload_invalid') };
  if (Buffer.byteLength(body, 'utf8') > SPEND_BOUNDS.maxPayloadBytes) return { allowed: false, ...decision(null, 'payload_oversized') };
  // Only the canonical, fixed text-only request can acquire this bound.
  try {
    const value = JSON.parse(body);
    if (value.anthropic_version !== 'bedrock-2023-05-31' || value.max_tokens !== SPEND_BOUNDS.outputTokens
      || value.thinking?.type !== 'disabled' || Object.keys(value.thinking).length !== 1
      || Object.keys(value).sort().join(',') !== 'anthropic_version,max_tokens,messages,thinking'
      || !Array.isArray(value.messages) || value.messages.length !== 1 || value.messages[0].role !== 'user'
      || typeof value.messages[0].content !== 'string' || Object.keys(value.messages[0]).sort().join(',') !== 'content,role') throw fail('Unsafe payload');
  } catch { return { allowed: false, ...decision(null, 'payload_invalid') }; }
  // The executor must not start until the WAL claim is durably synchronized.
  // Existing database defaults optimize other operations with NORMAL mode.
  db.pragma('synchronous = FULL');
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM leads WHERE id=?').get(leadId)) return { allowed: false, ...decision(null, 'stable_context_missing') };
    const workspace = db.prepare('SELECT identity FROM ai_spend_workspace WHERE id=1').get()?.identity;
    if (typeof workspace !== 'string' || !workspace) return { allowed: false, ...decision(null, 'unsafe_policy') };
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    const id = createHash('sha256').update(JSON.stringify([workspace,leadId,variant,digest,PROMPT_VERSION,SPEND_BOUNDS.version,modelId,region])).digest('hex');
    const existing = db.prepare('SELECT * FROM ai_spend_intents WHERE id=?').get(id);
    if (existing) return { allowed: false, ...decision(existing, existing.state === 'settled' ? 'settled_replay_unavailable' : existing.state === 'uncertain' ? 'uncertain_no_retry' : 'duplicate_in_flight'),
      replaySubject: existing.state === 'settled' ? existing.result_subject : null };
    const policy = current(db), sums = totals(db);
    const admission = operationAdmission(policy, sums, { enabled, modelId, region });
    if (admission.state !== 'ready') return { allowed: false, ...decision(null, admission.reason) };
    const hold = money(admission.maximumReservationNanoUsd);
    integer(sums.spent + sums.held + hold);
    const usageId = beginAiUsageRequest({ provider: 'bedrock', operation: 'subject_polish', modelId, region, db });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_spend_intents(id,workspace_identity,lead_id,variant,payload_sha256,prompt_version,bounds_version,model_id,region,approval_revision,input_nano_usd_per_token,output_nano_usd_per_token,input_token_bound,output_token_bound,reservation_nano_usd,held_nano_usd,state,usage_event_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?,?)`).run(id,workspace,leadId,variant,digest,PROMPT_VERSION,SPEND_BOUNDS.version,modelId,region,policy.revision,policy.input_nano_usd_per_token,policy.output_nano_usd_per_token,SPEND_BOUNDS.inputTokens,SPEND_BOUNDS.outputTokens,integer(hold),integer(hold),usageId,now,now);
    return { allowed: true, ...decision({ id, state: 'claimed', held_nano_usd: integer(hold) }, null), usageId };
  }).immediate();
}
function attributableUsage(usage, providerRequestId) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || typeof providerRequestId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(providerRequestId)) return false;
  const allowed = ['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'];
  if (Object.keys(usage).some(key => !allowed.includes(key))) return false;
  if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || usage.input_tokens > SPEND_BOUNDS.inputTokens
    || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || usage.output_tokens > SPEND_BOUNDS.outputTokens) return false;
  // Implicit caching exists even without directives. Until combined attribution
  // is implemented, any cache-bearing or unknown category keeps the full hold.
  return ['cache_creation_input_tokens','cache_read_input_tokens'].every(key => !Object.hasOwn(usage,key) || usage[key] === 0);
}
export function markSpendUncertain(id, reason = 'provider_outcome_uncertain', db = getDb()) {
  const safeReason = typeof reason === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(reason) ? reason : 'provider_outcome_uncertain';
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM ai_spend_intents WHERE id=? AND state='claimed'").get(id);
    if (!row) return false;
    finishAiUsageRequest(row.usage_event_id, { status: 'failed', errorCode: safeReason, db });
    return db.prepare("UPDATE ai_spend_intents SET state='uncertain',reason=?,updated_at=? WHERE id=? AND state='claimed'").run(safeReason,new Date().toISOString(),id).changes === 1;
  }).immediate();
}
export function settleSpendIntent(id, { usage, providerRequestId, replaySubject = null, reason = null } = {}, db = getDb()) {
  if (!attributableUsage(usage,providerRequestId)) { markSpendUncertain(id,'usage_unattributable',db); return false; }
  if (replaySubject !== null && (typeof replaySubject !== 'string' || replaySubject.length > 60 || !replaySubject || /[\u0000-\u001f\u007f]/.test(replaySubject))) throw fail('Unsafe replay result.');
  db.pragma('synchronous = FULL');
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM ai_spend_intents WHERE id=? AND state='claimed'").get(id);
    if (!row) return false;
    const event = db.prepare("SELECT * FROM ai_usage_events WHERE id=? AND status='pending'").get(row.usage_event_id);
    if (!event || event.provider !== 'bedrock' || event.operation !== 'subject_polish' || event.model_id !== row.model_id || event.region !== row.region) { markSpendUncertain(id,'usage_link_invalid',db); return false; }
    if (db.prepare('SELECT 1 FROM ai_spend_intents WHERE provider_request_id=? AND id!=?').get(providerRequestId,id)) { markSpendUncertain(id,'provider_request_reused',db); return false; }
    const cost = BigInt(usage.input_tokens) * stored(row.input_nano_usd_per_token) + BigInt(usage.output_tokens) * stored(row.output_nano_usd_per_token);
    integer(cost);
    if (cost > stored(row.reservation_nano_usd)) { markSpendUncertain(id,'usage_bound_exceeded',db); return false; }
    if (!finishAiUsageRequest(row.usage_event_id, { status: 'succeeded', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, providerRequestId, db })) throw fail('Usage settlement failed.');
    return db.prepare("UPDATE ai_spend_intents SET state='settled',held_nano_usd=0,settled_nano_usd=?,provider_request_id=?,result_subject=?,reason=?,updated_at=? WHERE id=? AND state='claimed'")
      .run(integer(cost),providerRequestId,replaySubject,reason,new Date().toISOString(),id).changes === 1;
  }).immediate();
}
