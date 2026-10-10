import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RATE_CARD_PATH = path.join(__dirname, '..', 'config', 'ai-rate-cards.json');
const OPERATION_LABELS = {
  personalization_draft: 'Cold-email draft generation',
  subject_polish: 'Subject-line polish',
  fact_check: 'Copy fact-check',
};

function readRateCards() {
  const configuredPath = process.env.ODD_AI_RATE_CARDS_PATH || DEFAULT_RATE_CARD_PATH;
  try {
    const parsed = JSON.parse(fs.readFileSync(configuredPath, 'utf8'));
    return Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch {
    return [];
  }
}

function matchingRateCard({ provider, modelId, region, startedAt }) {
  const requestDate = startedAt.slice(0, 10);
  return readRateCards().find(card => {
    if (card?.provider !== provider || card?.model !== modelId) return false;
    if ((card.region || null) !== (region || null)) return false;
    if (typeof card.id !== 'string' || !card.id.trim()) return false;
    if (typeof card.source !== 'string' || !card.source.trim()) return false;
    if (typeof card.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(card.effectiveFrom)) return false;
    if (card.effectiveFrom > requestDate) return false;
    if (!Number.isFinite(Date.parse(card.retrievedAt))) return false;
    if (!Number.isFinite(card.inputUsdPerMillion) || card.inputUsdPerMillion < 0) return false;
    if (!Number.isFinite(card.outputUsdPerMillion) || card.outputUsdPerMillion < 0) return false;
    return card.currency === 'USD' && card.unit === 'per_1m_tokens';
  }) || null;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeErrorCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().slice(0, 64);
  return /^[A-Za-z0-9_.:-]+$/.test(code) ? code : null;
}

export function beginAiUsageRequest({ provider, operation, modelId, region = null, db = getDb() }) {
  if (!['ollama', 'bedrock'].includes(provider)) throw new TypeError('Unsupported AI provider usage event.');
  const safeOperation = String(operation || '').trim().slice(0, 80);
  const safeModelId = String(modelId || '').trim().slice(0, 200);
  if (!safeOperation || !safeModelId) throw new TypeError('AI usage operation and model are required.');
  const startedAt = new Date().toISOString();
  const rateCard = matchingRateCard({ provider, modelId: safeModelId, region, startedAt });
  const result = db.prepare(`INSERT INTO ai_usage_events(
    provider,operation,model_id,region,status,
    rate_card_id,rate_card_source,rate_card_effective_from,rate_card_retrieved_at,
    input_usd_per_million,output_usd_per_million,started_at
  ) VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?)`).run(
    provider, safeOperation, safeModelId, region,
    rateCard?.id || null, rateCard?.source || null, rateCard?.effectiveFrom || null,
    rateCard?.retrievedAt || null, rateCard?.inputUsdPerMillion ?? null,
    rateCard?.outputUsdPerMillion ?? null, startedAt,
  );
  return Number(result.lastInsertRowid);
}

export function finishAiUsageRequest(id, {
  status = 'succeeded', inputTokens = null, outputTokens = null,
  providerRequestId = null, errorCode = null, db = getDb(),
} = {}) {
  if (!['succeeded', 'failed'].includes(status)) throw new TypeError('Invalid AI usage outcome.');
  const input = tokenCount(inputTokens);
  const output = tokenCount(outputTokens);
  const row = db.prepare(`SELECT input_usd_per_million,output_usd_per_million
    FROM ai_usage_events WHERE id=? AND status='pending'`).get(id);
  if (!row) return false;

  const canPrice = status === 'succeeded' && input !== null && output !== null
    && row.input_usd_per_million !== null && row.output_usd_per_million !== null;
  const cost = canPrice
    ? Math.round(((input * row.input_usd_per_million + output * row.output_usd_per_million) / 1_000_000) * 1e12) / 1e12
    : null;
  return db.prepare(`UPDATE ai_usage_events SET status=?,input_tokens=?,output_tokens=?,
      usage_source=?,provider_request_id=?,error_code=?,cost_usd=?,completed_at=datetime('now')
    WHERE id=? AND status='pending'`).run(
    status,
    status === 'succeeded' ? input : null,
    status === 'succeeded' ? output : null,
    status === 'succeeded' && input !== null && output !== null ? 'provider_response' : null,
    typeof providerRequestId === 'string' ? providerRequestId.slice(0, 200) : null,
    safeErrorCode(errorCode), cost, id,
  ).changes === 1;
}

export function getAiUsageAnalytics(db = getDb()) {
  const rows = db.prepare(`SELECT provider,operation,model_id,region,
      COUNT(*) AS requests,
      SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      COUNT(input_tokens) AS input_measured_requests,
      SUM(COALESCE(input_tokens,0)) AS measured_input_tokens,
      COUNT(output_tokens) AS output_measured_requests,
      SUM(COALESCE(output_tokens,0)) AS measured_output_tokens,
      COUNT(cost_usd) AS priced_requests,
      SUM(COALESCE(cost_usd,0)) AS measured_cost_usd,
      MIN(started_at) AS first_request_at,
      MAX(started_at) AS last_request_at
    FROM ai_usage_events
    GROUP BY provider,operation,model_id,region
    ORDER BY provider,operation,model_id,region`).all();

  function summarize(buckets) {
    const requests = buckets.reduce((sum, row) => sum + row.requests, 0);
    const succeeded = buckets.reduce((sum, row) => sum + row.succeeded, 0);
    const failed = buckets.reduce((sum, row) => sum + row.failed, 0);
    const pending = buckets.reduce((sum, row) => sum + row.pending, 0);
    const inputMeasured = buckets.reduce((sum, row) => sum + row.input_measured_requests, 0);
    const outputMeasured = buckets.reduce((sum, row) => sum + row.output_measured_requests, 0);
    const measuredInputTokens = buckets.reduce((sum, row) => sum + row.measured_input_tokens, 0);
    const measuredOutputTokens = buckets.reduce((sum, row) => sum + row.measured_output_tokens, 0);
    const pricedRequests = buckets.reduce((sum, row) => sum + row.priced_requests, 0);
    const measuredCostUsd = buckets.reduce((sum, row) => sum + row.measured_cost_usd, 0);
    const tokensComplete = requests > 0 && inputMeasured === requests && outputMeasured === requests;
    const costComplete = requests > 0 && pricedRequests === requests;
    return {
      requests, succeeded, failed, pending,
      input_tokens: tokensComplete ? measuredInputTokens : null,
      output_tokens: tokensComplete ? measuredOutputTokens : null,
      total_tokens: tokensComplete ? measuredInputTokens + measuredOutputTokens : null,
      measured_input_tokens: inputMeasured ? measuredInputTokens : null,
      measured_output_tokens: outputMeasured ? measuredOutputTokens : null,
      tokens_complete: tokensComplete,
      cost_usd: costComplete ? measuredCostUsd : null,
      cost_complete: costComplete,
      priced_requests: pricedRequests,
      first_request_at: buckets.map(row => row.first_request_at).filter(Boolean).sort()[0] || null,
      last_request_at: buckets.map(row => row.last_request_at).filter(Boolean).sort().at(-1) || null,
    };
  }

  const providers = {};
  for (const provider of ['ollama', 'bedrock']) {
    const summary = summarize(rows.filter(row => row.provider === provider));
    providers[provider] = {
      ...summary,
      token_status: summary.tokens_complete ? 'measured' : summary.requests ? 'partial_or_missing' : 'not_recorded',
      cost_status: summary.cost_complete ? 'measured' : summary.requests && summary.priced_requests ? 'partial' : summary.requests ? 'rate_card_missing' : 'not_recorded',
    };
  }

  const rateCards = db.prepare(`SELECT DISTINCT rate_card_id AS id,rate_card_source AS source,
      rate_card_effective_from AS effective_from,rate_card_retrieved_at AS retrieved_at
    FROM ai_usage_events WHERE rate_card_id IS NOT NULL ORDER BY rate_card_effective_from DESC,rate_card_id`).all();
  const overall = summarize(rows);
  const tasks = rows.map(row => {
    const taskSummary = summarize([row]);
    return {
      provider: row.provider,
      tier: row.provider,
      operation: row.operation,
      name: OPERATION_LABELS[row.operation] || row.operation,
      model: row.model_id,
      region: row.region,
      calls: row.requests,
      requests: row.requests,
      succeeded: row.succeeded,
      failed: row.failed,
      pending: row.pending,
      input_tokens: taskSummary.input_tokens,
      output_tokens: taskSummary.output_tokens,
      measured_input_tokens: taskSummary.measured_input_tokens,
      measured_output_tokens: taskSummary.measured_output_tokens,
      tokens_complete: taskSummary.tokens_complete,
      cost_usd: taskSummary.cost_usd,
      priced_requests: taskSummary.priced_requests,
      first_request_at: row.first_request_at,
      last_request_at: row.last_request_at,
    };
  });

  return {
    tracking_since: overall.first_request_at,
    request_count: overall.requests,
    succeeded_requests: overall.succeeded,
    failed_requests: overall.failed,
    pending_requests: overall.pending,
    input_tokens: overall.input_tokens,
    output_tokens: overall.output_tokens,
    total_tokens: overall.total_tokens,
    measured_input_tokens: overall.measured_input_tokens,
    measured_output_tokens: overall.measured_output_tokens,
    tokens_complete: overall.tokens_complete,
    usage_status: overall.tokens_complete ? 'measured' : overall.requests ? 'partial_or_missing' : 'unknown',
    usage_note: overall.requests
      ? 'Request counts and available token totals are provider-response evidence since tracking began. Earlier calls cannot be reconstructed.'
      : 'No AI provider requests have been recorded yet. Earlier calls cannot be reconstructed.',
    cost_usd: overall.cost_usd,
    cost_per_lead: null,
    cost_status: overall.cost_complete ? 'measured' : overall.requests && overall.priced_requests ? 'partial' : overall.requests ? 'rate_card_missing' : 'not_recorded',
    rate_card_note: overall.cost_complete
      ? 'Costs use the dated rate-card snapshots attached to each request.'
      : 'No matching complete dated rate card is configured; cost remains unknown.',
    rate_cards: rateCards,
    ollama_calls: providers.ollama.requests,
    bedrock_calls: providers.bedrock.requests,
    bedrock_tokens: providers.bedrock.total_tokens,
    bedrock_usd: providers.bedrock.cost_usd,
    providers,
    tasks,
  };
}
