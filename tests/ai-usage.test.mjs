import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-ai-usage-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.ODD_AI_RATE_CARDS_PATH = path.join(directory, 'rates.json');
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
const rateRetrievedAt = new Date().toISOString();
writeFileSync(process.env.ODD_AI_RATE_CARDS_PATH, JSON.stringify({
  schemaVersion: 1,
  cards: [{
    id: 'fixture-bedrock-card-v1', provider: 'bedrock', model: 'fixture-sonnet', region: 'us-east-1',
    effectiveFrom: '2026-01-01', retrievedAt: rateRetrievedAt, source: 'https://pricing.example.test/fixture',
    currency: 'USD', unit: 'per_1m_tokens', inputUsdPerMillion: 10, outputUsdPerMillion: 30,
  }],
}));

const { initDb, closeDb } = await import('../pipeline/database.js');
const db = initDb();
const { personalizeBatch } = await import('../pipeline/personalizer.js');
const { beginAiUsageRequest, finishAiUsageRequest, getAiUsageAnalytics } = await import('../pipeline/ai-usage.js');
const { renderAICostHtml } = await import('../js/analytics.js');

const ollamaRequests = [];
const ollamaSink = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const request = JSON.parse(raw);
    ollamaRequests.push(request);
    let response;
    if (request.prompt.startsWith('Compare this email against the fact bundle')) {
      response = 'CLEAN';
    } else if (request.prompt.startsWith('Given this cold email opener and body:')) {
      response = 'A practical website note for Synthetic contact';
    } else {
      response = `SUBJECT: A clearer website question for Synthetic contact\nBODY:\nHi {{business_name}} team,\n\nI read that your website is currently missing, so nearby customers may not find your services online. A clear one-page site can explain your offer, show your opening hours, and make it simple to get in touch. We can share examples and a short plan tailored to local businesses. Would a brief conversation next week be useful?`;
    }
    const requestNumber = ollamaRequests.length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response, prompt_eval_count: 100 + requestNumber, eval_count: 20 + requestNumber }));
  });
});
await new Promise((resolve, reject) => {
  ollamaSink.once('error', reject);
  ollamaSink.listen(0, '127.0.0.1', resolve);
});

const originalFetch = globalThis.fetch;
const ollamaSinkUrl = `http://127.0.0.1:${ollamaSink.address().port}`;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== 'localhost' || url.port !== '11434' || url.pathname !== '/api/generate') {
    return Promise.reject(new Error(`Unexpected outbound fetch in AI usage test: ${url.origin}${url.pathname}`));
  }
  return originalFetch(`${ollamaSinkUrl}${url.pathname}`, init);
};

let serverChild = null;
after(async () => {
  globalThis.fetch = originalFetch;
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill();
    await new Promise(resolve => {
      if (serverChild.exitCode !== null) return resolve();
      serverChild.once('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
  }
  await new Promise(resolve => ollamaSink.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('B08: actual Ollama response usage is durable, attributed, and visible through analytics', async () => {
  const batchId = db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Synthetic usage batch','P05','open')").run().lastInsertRowid;
  db.prepare(`INSERT INTO leads(id,batch_id,business_name,category,email,city,site_status,status)
    VALUES (1,?,'Synthetic contact','Fixture','contact@example.test','Test City','NO_SITE','verified')`).run(batchId);
  db.prepare(`INSERT INTO lead_emails(lead_id,email,verification_status,is_primary)
    VALUES (1,'contact@example.test','deliverable',1)`).run();

  await personalizeBatch(batchId, { limit: 1 });
  assert.equal(ollamaRequests.length, 6, 'two variants each issue draft, polish, and fact-check requests');
  const events = db.prepare(`SELECT provider,operation,model_id,status,input_tokens,output_tokens,usage_source,
      rate_card_id,cost_usd FROM ai_usage_events ORDER BY id`).all();
  assert.equal(events.length, 6);
  assert.ok(events.every(event => event.provider === 'ollama' && event.status === 'succeeded'));
  assert.deepEqual(events.map(event => event.operation).sort(), [
    'fact_check', 'fact_check', 'personalization_draft', 'personalization_draft', 'subject_polish', 'subject_polish',
  ]);
  assert.equal(events[0].usage_source, 'provider_response');
  assert.ok(events.every((event, index) => event.input_tokens === 101 + index && event.output_tokens === 21 + index));
  assert.ok(events.every(event => event.rate_card_id === null && event.cost_usd === null), 'self-hosted inference has no assumed zero-dollar or per-token cost');
  const eventColumns = db.prepare('PRAGMA table_info(ai_usage_events)').all().map(column => column.name);
  assert.ok(!eventColumns.some(column => /prompt|response_body|credential|secret/i.test(column)), 'usage persistence excludes prompt and response content');

  const bedrockId = beginAiUsageRequest({ provider: 'bedrock', operation: 'subject_polish', modelId: 'fixture-sonnet', region: 'us-east-1', db });
  assert.equal(finishAiUsageRequest(bedrockId, { inputTokens: 1200, outputTokens: 500, providerRequestId: 'fixture-request', db }), true);
  const bedrockEvent = db.prepare('SELECT * FROM ai_usage_events WHERE id=?').get(bedrockId);
  assert.equal(bedrockEvent.cost_usd, 0.027);
  assert.equal(bedrockEvent.rate_card_id, 'fixture-bedrock-card-v1');
  assert.equal(bedrockEvent.rate_card_effective_from, '2026-01-01');
  assert.equal(bedrockEvent.rate_card_source, 'https://pricing.example.test/fixture');

  const report = getAiUsageAnalytics(db);
  assert.equal(report.request_count, 7);
  assert.equal(report.ollama_calls, 6);
  assert.equal(report.bedrock_calls, 1);
  assert.equal(report.usage_status, 'measured');
  assert.equal(report.total_tokens, events.reduce((sum, event) => sum + event.input_tokens + event.output_tokens, 0) + 1700);
  assert.equal(report.bedrock_tokens, 1700);
  assert.equal(report.bedrock_usd, 0.027);
  assert.equal(report.cost_usd, null, 'overall spend remains unknown because the Ollama rate is not configured');
  assert.equal(report.cost_status, 'partial', 'the dated card covers only Bedrock, so total workspace spend remains unknown');
  assert.equal(report.rate_cards[0].id, 'fixture-bedrock-card-v1');

  globalThis.fetch = originalFetch;
  const port = await reservePort();
  serverChild = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverError = '';
  serverChild.stderr.on('data', chunk => { serverError += chunk; });
  let analyticsResponse = null;
  for (let i = 0; i < 50 && !analyticsResponse; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/stats/analytics`);
      if (response.status < 500) analyticsResponse = response;
    } catch { /* wait for isolated local server startup */ }
    if (serverChild.exitCode !== null) break;
  }
  assert.ok(analyticsResponse, `analytics server did not start: ${serverError}`);
  assert.equal(analyticsResponse.status, 200);
  const apiReport = (await analyticsResponse.json()).aiCost;
  assert.equal(apiReport.request_count, 7);
  assert.equal(apiReport.providers.ollama.total_tokens, events.reduce((sum, event) => sum + event.input_tokens + event.output_tokens, 0));
  assert.equal(apiReport.tasks.find(task => task.operation === 'fact_check').requests, 2);
  assert.equal(apiReport.tasks.find(task => task.provider === 'bedrock').cost_usd, 0.027);
  assert.equal(apiReport.cost_status, 'partial');

  const markup = renderAICostHtml(apiReport);
  assert.match(markup, /Ollama requests/);
  assert.match(markup, /Measured AI tokens/);
  assert.match(markup, /No complete dated rate card/);
  assert.match(markup, /2 requests/);
  assert.doesNotMatch(markup, /Attributed output rows/);
});
