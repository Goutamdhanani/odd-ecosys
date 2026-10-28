import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const collectorPath = new URL('../pipeline/astra-source-collection.js', import.meta.url);
const prospectingPath = new URL('../pipeline/astra-prospecting.js', import.meta.url);

test('collector routes search, robots, and page HTTP dispatch through the trusted admission hook with the abort signal', async () => {
  const source = await readFile(collectorPath, 'utf8');
  for (const operation of ['search', 'robots', 'page']) {
    assert.match(source, new RegExp(`operation: '${operation}'[\\s\\S]{0,180}reserveRequest`), `${operation} request must carry a durable reservation callback`);
    assert.match(source, new RegExp(`operation: '${operation}'[\\s\\S]{0,100}signal`), `${operation} request must retain AbortSignal`);
  }
  assert.match(source, /withRequestAdmission\([\s\S]{0,240}, dispatch\)\s*:\s*dispatch\(\)/,
    'the actual safe fetch dispatch is executed inside the trusted admission wrapper');
  assert.match(source, /maxBytes: 128 \* 1024, timeoutMs: 8000, signal/);
  assert.match(source, /maxBytes: MAX_HTML_BYTES, timeoutMs: 10_000, signal/);
  assert.match(source, /maxBytes: MAX_SEARCH_BYTES, timeoutMs: 10_000, signal/);
});

test('live admission holds the shared transaction lock through dispatch and collector compatibility stays opt-in', async () => {
  const source = await readFile(prospectingPath, 'utf8');
  const lockAt = source.indexOf("pg_advisory_xact_lock(hashtextextended('astra-live-public-source-v1', 0))");
  const sleepAt = source.indexOf("await db.query('SELECT pg_sleep(1)')", lockAt);
  const reserveAt = source.indexOf('await context.reserveRequest(', sleepAt);
  const dispatchAt = source.indexOf('return dispatch(); // PostgreSQL advisory xact lock remains held through actual safeFetch completion.', reserveAt);
  assert.ok(lockAt >= 0 && sleepAt > lockAt && reserveAt > sleepAt && dispatchAt > reserveAt,
    'shared lock, interval, durable request checkpoint, and HTTP dispatch must occur in one transaction callback in this order');
  assert.match(source, /if \(typeof reserveRequest !== 'function' \|\| typeof beforeRequest !== 'function'\) throw fail\(/,
    'the live prospecting adapter fails closed when trusted durable admission callbacks are missing');

  const collector = await readFile(collectorPath, 'utf8');
  assert.doesNotMatch(collector, /if \(typeof args\?\.withRequestAdmission !== 'function'\) throw/,
    'legacy source collection calls retain prior S01-gated behavior when no live admission wrapper is supplied');
  assert.match(collector, /const blocked = policyBlock\(claimed\);[\s\S]*?if \(blocked\)/,
    'legacy collection still rechecks source rights and S01 before transport');
});

test('only a proven no-reservation, no-dispatch pause or stale fence creates a bounded immutable successor', async () => {
  const collector = await readFile(collectorPath, 'utf8');
  assert.match(collector, /!transportAttempted && !requestReservationAttempted && \['job_paused', 'lease_lost'\]\.includes\(cause\?\.code\)/,
    'safe deferral requires both negative dispatch and request-reservation provenance, and excludes cancellation');
  assert.match(collector, /status: 'deferred', retrySafe: true/);
  assert.match(collector, /UPDATE astra\.source_collection_runs SET status='failed'/,
    'the interrupted attempt remains in durable run history with explicit retry-safe evidence');
  assert.match(collector, /UPDATE astra\.source_collection_jobs SET status='failed',[\s\S]*?latest_run_id=\$3/,
    'the original bound job is terminal and cannot violate the strict25 transition guard');
  assert.match(collector, /async function createRetrySuccessor[\s\S]*?proof\.status !== 'deferred'[\s\S]*?proof\.requestReservationAttempted !== false/,
    'successor creation requires exact immutable no-reservation, no-transport attempt proof');
  assert.match(collector, /original\.request\?\.retryLineage\?\.protocol === 'pre-dispatch-successor-v1'/,
    'a successor cannot create another successor chain');
  assert.match(collector, /requestReservationAttempted = true;[\s\S]*?return reserveRequest\(context\)/,
    'a started durable reservation callback conservatively prevents deferral even when its commit outcome is uncertain');
  assert.doesNotMatch(collector, /UPDATE astra\.source_collection_jobs SET status='queued'/,
    'no running source job is returned to queued');
});

test('running search and fetch handovers durably wait before any blocked or held terminal outcome', async () => {
  const prospecting = await readFile(prospectingPath, 'utf8');
  assert.match(prospecting, /if \(searchJob\?\.status === 'running'\)[\s\S]{0,380}waitForSource\([\s\S]{0,220}waiting_for_source/,
    'a running search stays pending and returns a visible nonterminal handoff after bounded waiting');
  assert.match(prospecting, /if \(fetchJob\?\.status === 'running'\)[\s\S]{0,420}waitForSource\([\s\S]{0,240}waiting_for_source/,
    'a running fetch stays pending and returns a visible nonterminal handoff after bounded waiting');
  assert.match(prospecting, /pendingSourceJobId: sourceJob\.id[\s\S]{0,300}sourceWaitDeadline/,
    'the same SQL pointer and bounded wait deadline remain in the durable parent checkpoint');
  assert.match(prospecting, /if \(latestSource && \['completed', 'failed'\]\.includes\(latestSource\.status\)\)/,
    'only explicit terminal source states resolve a handover; missing and unfamiliar states stay pending');
  assert.match(prospecting, /const SOURCE_WAIT_POLL_MS = 500;[\s\S]{0,100}const SOURCE_WAIT_MAX_MS = 30_000/,
    'polling uses a capped interval and maximum wait instead of a tight loop');
});
