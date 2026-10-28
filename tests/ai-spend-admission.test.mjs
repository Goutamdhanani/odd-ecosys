import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-admission-service-'));
process.env.NODE_ENV = 'test';
process.env.ODD_DB_PATH = path.join(directory, 'template.db');
const { initDb, closeDb } = await import('../pipeline/database.js');
initDb(); closeDb();
const { approveSpendPolicy, getSpendBudget, claimSpendIntent, settleSpendIntent, markSpendUncertain, SPEND_BOUNDS, MAX_NANO_USD } = await import('../pipeline/ai-spend-admission.js');
let serial = 0;
const connections = [];
after(() => { for (const db of connections) if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
const provider = { enabled: true, modelId: SPEND_BOUNDS.modelId, region: SPEND_BOUNDS.region };
const actor = { id: 1, role: 'owner' };
function policy(overrides = {}) {
  return { expectedRevision: null, enabled: true, capNanoUsd: '10001000', modelId: provider.modelId, region: provider.region,
    rateVersion: 'synthetic-max-v1', inputNanoUsdPerToken: '1', outputNanoUsdPerToken: '1', priceSource: 'Synthetic maximum-rate fixture',
    approvalNote: 'Synthetic only; maxima include tiers, cache and all applicable per-token premiums.', approveMaximumRates: true, ...overrides };
}
function fixture() {
  const filename = path.join(directory, `fixture-${++serial}.db`);
  copyFileSync(process.env.ODD_DB_PATH, filename);
  const db = new Database(filename);
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=5000');
  for (let id = 1; id <= 10; id++) db.prepare('INSERT INTO leads(id,business_name) VALUES(?,?)').run(id,`Synthetic ${id}`);
  connections.push(db);
  return { db, filename };
}
function body(content = 'Synthetic subject') {
  return JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, thinking: { type: 'disabled' }, messages: [{ role: 'user', content }] });
}
function claim(db, overrides = {}) { return claimSpendIntent({ db, leadId: 1, variant: 'A', body: body(), ...provider, ...overrides }); }
function budget(db) { return getSpendBudget({ db, config: provider }); }
function workerClaim(filename, leadId = 1) {
  return new Worker(`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{
    process.env.ODD_DB_PATH=workerData.filename;
    const {getDb}=await import(workerData.databaseUrl);
    const {claimSpendIntent}=await import(workerData.serviceUrl);
    parentPort.postMessage(claimSpendIntent({db:getDb(),...workerData.request}));
  })().catch(error=>{throw error});`, { eval: true, workerData: { filename,
    databaseUrl: new URL('../pipeline/database.js', import.meta.url).href, serviceUrl: new URL('../pipeline/ai-spend-admission.js', import.meta.url).href,
    request: { leadId, variant: 'A', body: body(), ...provider } } });
}
async function answer(worker) {
  return new Promise((resolve,reject) => { worker.once('message',resolve); worker.once('error',reject); });
}

test('no policy/default price, unsupported provider, invalid context and unsafe payload cannot claim', () => {
  const { db } = fixture();
  assert.equal(claim(db).reason,'approval_missing');
  assert.equal(claim(db,{ leadId: 999 }).reason,'stable_context_missing');
  approveSpendPolicy(policy(),actor,db);
  for (const request of [{ enabled: false }, { modelId: 'different' }, { region: 'us-west-2' }]) assert.equal(claim(db,request).allowed,false);
  for (const invalid of [body('é'.repeat(9000)), body('a'.repeat(17000))]) assert.equal(claim(db,{ body: invalid }).reason,'payload_oversized');
  const value = JSON.parse(body()); value.system = 'Unbounded option';
  assert.equal(claim(db,{ body: JSON.stringify(value) }).reason,'payload_invalid');
  value.system = undefined; value.thinking.type='enabled';
  assert.equal(claim(db,{ body: JSON.stringify(value) }).reason,'payload_invalid');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_events').get().n,0);
});

test('all invalid/zero/overflow monetary forms reject atomically with no history or executor', () => {
  const { db } = fixture();
  const invalid = ['0','-1','01','+1','1.0','1e3',' 1','',null,1,1.2,'1000000000000001','9223372036854775808'];
  for (const field of ['capNanoUsd','inputNanoUsdPerToken','outputNanoUsdPerToken']) for (const value of invalid) assert.throws(() => approveSpendPolicy(policy({ [field]: value }),actor,db));
  assert.throws(() => approveSpendPolicy(policy({ inputNanoUsdPerToken: '1000000001' }),actor,db));
  assert.throws(() => approveSpendPolicy(policy({ inputNanoUsdPerToken: '1000000000' }),actor,db), /Unsafe monetary arithmetic/);
  for (const bad of [{ approveMaximumRates: false },{ rateVersion: '' },{ priceSource: '' },{ approvalNote: '' },{ expectedRevision: '1' },{ unknown: true },{ modelId: 'other' }]) assert.throws(() => approveSpendPolicy(policy(bad),actor,db));
  assert.throws(() => approveSpendPolicy(policy(),{ id: 2, role: 'operator' },db), error => error.statusCode === 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_spend_approvals').get().n,0);
  assert.equal(claim(db).allowed,false);
});

test('separate worker connections compete atomically for cap and duplicate one executor', async () => {
  const first = fixture(); approveSpendPolicy(policy({ capNanoUsd: '2000200' }),actor,first.db);
  const workers = Array.from({length: 8},(_,i) => workerClaim(first.filename,i+1));
  const results = await Promise.all(workers.map(answer));
  await Promise.all(workers.map(worker => worker.terminate()));
  assert.equal(results.filter(row => row.allowed).length,2);
  assert.equal(budget(first.db).totals.heldNanoUsd,'2000200');
  const second = fixture(); approveSpendPolicy(policy(),actor,second.db);
  const duplicates = Array.from({length: 8},() => workerClaim(second.filename));
  const attempts = await Promise.all(duplicates.map(answer));
  await Promise.all(duplicates.map(worker => worker.terminate()));
  assert.equal(attempts.filter(row => row.allowed).length,1);
  assert.equal(new Set(attempts.map(row => row.intentId)).size,1);
  assert.equal(second.db.prepare('SELECT COUNT(*) n FROM ai_usage_events').get().n,1);
});

test('process termination/reopen retains a claim; approval/rate/cap changes never mint retries or release holds', async () => {
  const { db,filename } = fixture(); approveSpendPolicy(policy(),actor,db);
  const worker = workerClaim(filename); const granted = await answer(worker); await worker.terminate();
  assert.equal(granted.allowed,true);
  db.close();
  const reopened = new Database(filename); reopened.pragma('foreign_keys=ON'); connections.push(reopened);
  assert.equal(claim(reopened).reason,'duplicate_in_flight');
  assert.equal(budget(reopened).totals.heldNanoUsd,'1000100');
  markSpendUncertain(granted.intentId,'provider_timeout',reopened);
  for (const override of [{ capNanoUsd: '1' },{ enabled: false },{ inputNanoUsdPerToken: '2', outputNanoUsdPerToken: '9', capNanoUsd: '9000000' }]) {
    approveSpendPolicy(policy({ expectedRevision: budget(reopened).policy.revision, ...override }),actor,reopened);
    assert.equal(claim(reopened).reason,'uncertain_no_retry');
    assert.equal(budget(reopened).totals.heldNanoUsd,'1000100');
  }
  assert.equal(claim(reopened,{body:body('Changed input')}).allowed,true);
  assert.equal(claim(reopened,{modelId:'other'}).allowed,false);
  assert.throws(() => reopened.prepare('DELETE FROM ai_spend_intents').run(),/cannot be deleted/);
  assert.throws(() => reopened.prepare('UPDATE ai_spend_approvals SET enabled=0').run(),/immutable/);
  assert.throws(() => reopened.prepare('DELETE FROM ai_spend_approvals').run(),/immutable/);
  reopened.prepare('DELETE FROM leads WHERE id=1').run();
  assert.equal(budget(reopened).totals.heldNanoUsd,'3001000');
});

test('attributable settlement is linked once at frozen rates and successful replay cannot mismatch changed input', () => {
  const { db } = fixture(); approveSpendPolicy(policy({inputNanoUsdPerToken:'3',outputNanoUsdPerToken:'7'}),actor,db);
  const intent = claim(db);
  approveSpendPolicy(policy({expectedRevision:1,inputNanoUsdPerToken:'20',outputNanoUsdPerToken:'30'}),actor,db);
  assert.equal(settleSpendIntent(intent.intentId,{usage:{input_tokens:12,output_tokens:7},providerRequestId:'synthetic-request',replaySubject:'A practical idea'},db),true);
  assert.equal(settleSpendIntent(intent.intentId,{usage:{input_tokens:1,output_tokens:1},providerRequestId:'synthetic-again'},db),false);
  assert.equal(budget(db).totals.spentNanoUsd,'85');
  assert.equal(budget(db).totals.heldNanoUsd,'0');
  assert.equal(claim(db).replaySubject,'A practical idea');
  const next = claim(db,{body:body('Different')}); assert.equal(next.allowed,false,'new higher-rate work still requires enough lifetime capacity');
  const event = db.prepare('SELECT * FROM ai_usage_events WHERE id=?').get(intent.usageId);
  assert.equal(event.provider_request_id,'synthetic-request'); assert.equal(event.input_tokens,12); assert.equal(event.cost_usd,null);
  const row = db.prepare('SELECT * FROM ai_spend_intents WHERE id=?').get(intent.intentId);
  assert.equal(row.approval_revision,1); assert.equal(row.input_token_bound,1_000_000);
  assert.throws(() => db.prepare('UPDATE ai_spend_intents SET state=? WHERE id=?').run('claimed',intent.intentId),/immutable/);
});

test('missing, malformed, over-bound, cache-bearing and unlinked usage retain full uncertainty and unknown analytics', () => {
  const invalid = [undefined,{}, {input_tokens:1}, {input_tokens:-1,output_tokens:1}, {input_tokens:1.5,output_tokens:1},
    {input_tokens:1_000_001,output_tokens:1}, {input_tokens:1,output_tokens:101}, {input_tokens:'1',output_tokens:1},
    {input_tokens:1,output_tokens:1,cache_read_input_tokens:1}, {input_tokens:1,output_tokens:1,cache_creation_input_tokens:5},
    {input_tokens:1,output_tokens:1,cache_creation_input_tokens:null}, {input_tokens:1,output_tokens:1,unknown:0}];
  for (const usage of invalid) {
    const {db}=fixture(); approveSpendPolicy(policy(),actor,db); const intent=claim(db);
    assert.equal(settleSpendIntent(intent.intentId,{usage,providerRequestId:'synthetic'},db),false);
    assert.equal(budget(db).totals.heldNanoUsd,'1000100'); assert.equal(budget(db).totals.uncertainCount,1);
    assert.equal(claim(db).reason,'uncertain_no_retry');
    const event=db.prepare('SELECT input_tokens,output_tokens,cost_usd FROM ai_usage_events').get();
    assert.deepEqual(event,{input_tokens:null,output_tokens:null,cost_usd:null});
  }
  const {db}=fixture(); approveSpendPolicy(policy(),actor,db); const intent=claim(db);
  db.prepare("UPDATE ai_usage_events SET model_id='wrong' WHERE id=?").run(intent.usageId);
  assert.equal(settleSpendIntent(intent.intentId,{usage:{input_tokens:1,output_tokens:1},providerRequestId:'synthetic'},db),false);
  assert.equal(budget(db).totals.heldNanoUsd,'1000100');
});

test('exact supported ceiling, cap decrease and zero-cache usage settle with no rounding', () => {
  const {db}=fixture(); approveSpendPolicy(policy({capNanoUsd:String(MAX_NANO_USD),inputNanoUsdPerToken:'999999999',outputNanoUsdPerToken:'10000'}),actor,db);
  const intent=claim(db); assert.equal(intent.heldNanoUsd,String(MAX_NANO_USD));
  assert.equal(claim(db,{leadId:2}).reason,'cap_exhausted');
  approveSpendPolicy(policy({expectedRevision:1,capNanoUsd:'1'}),actor,db);
  assert.equal(budget(db).totals.remainingNanoUsd,'0'); assert.equal(budget(db).totals.heldNanoUsd,String(MAX_NANO_USD));
  assert.equal(settleSpendIntent(intent.intentId,{usage:{input_tokens:1_000_000,output_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0},providerRequestId:'synthetic-exact'},db),true);
  assert.equal(budget(db).totals.spentNanoUsd,String(MAX_NANO_USD));
  assert.equal(budget(db).totals.heldNanoUsd,'0');
  assert.equal(claim(db,{leadId:2}).reason,'cap_exhausted');
});

test('ledger coverage preserves earlier subject usage and unrelated operations without inventing historical prices', async () => {
  const {db}=fixture();
  db.prepare(`INSERT INTO ai_usage_events(provider,operation,model_id,region,status,input_tokens,output_tokens,started_at)
    VALUES('bedrock','subject_polish',?,'us-east-1','succeeded',40,10,'2026-10-01T00:00:00Z')`).run(SPEND_BOUNDS.modelId);
  db.prepare(`INSERT INTO ai_usage_events(provider,operation,model_id,status,input_tokens,output_tokens,started_at)
    VALUES('ollama','fact_check','synthetic-local','succeeded',30,5,'2026-10-01T00:00:00Z')`).run();
  approveSpendPolicy(policy(),actor,db);
  assert.deepEqual(budget(db).coverage,{basis:'admitted_budget_ledger',earlierUsageExcluded:true,otherOperationsExcluded:true});
  assert.equal(budget(db).totals.spentNanoUsd,'0');
  const intent=claim(db);
  assert.equal(settleSpendIntent(intent.intentId,{usage:{input_tokens:12,output_tokens:7},providerRequestId:'synthetic-ledger'},db),true);
  assert.equal(budget(db).totals.spentNanoUsd,'19');
  const {getAiUsageAnalytics}=await import('../pipeline/ai-usage.js');
  const analytics=getAiUsageAnalytics(db);
  assert.equal(analytics.request_count,3); assert.equal(analytics.cost_usd,null); assert.equal(analytics.cost_status,'rate_card_missing');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_events WHERE cost_usd IS NULL').get().n,3);
});

test('complete UTF8 serialization boundary is exact; reused provider response cannot settle another intent', () => {
  const {db}=fixture(); approveSpendPolicy(policy(),actor,db);
  const overhead=Buffer.byteLength(body(''));
  const room=SPEND_BOUNDS.maxPayloadBytes-overhead;
  const content='é'.repeat(Math.floor(room/2))+'x'.repeat(room%2);
  assert.equal(Buffer.byteLength(body(content)),SPEND_BOUNDS.maxPayloadBytes);
  const first=claim(db,{body:body(content)}); assert.equal(first.allowed,true);
  assert.equal(claim(db,{body:body(content+'x')}).reason,'payload_oversized');
  assert.equal(settleSpendIntent(first.intentId,{usage:{input_tokens:12,output_tokens:7},providerRequestId:'synthetic-unique'},db),true);
  const second=claim(db,{leadId:2});
  assert.equal(settleSpendIntent(second.intentId,{usage:{input_tokens:12,output_tokens:7},providerRequestId:'synthetic-unique'},db),false);
  assert.equal(budget(db).totals.spentNanoUsd,'19'); assert.equal(budget(db).totals.heldNanoUsd,'1000100');
  assert.equal(claim(db,{leadId:2}).reason,'uncertain_no_retry');
});
