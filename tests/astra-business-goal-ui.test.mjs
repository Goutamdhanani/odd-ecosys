import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '11000000-0000-4000-8000-000000000011';
const goalId = '20000000-0000-4000-8000-000000000002';
const raceGoalId = '22000000-0000-4000-8000-000000000022';
const blockedGoalId = '21000000-0000-4000-8000-000000000012';
const jobId = '30000000-0000-4000-8000-000000000003';
let browser;
let server;

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test('guided goal UI creates once, polls persisted plan, answers by keyboard, starts with CAS, and reloads linked work', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('Microsoft Edge is required; set ODD_CHROMIUM_EXECUTABLE_PATH to its executable.');
  const { chromium } = await import('playwright');
  const { installLoopbackBrowserGuard } = await import('./support/loopback-browser-guard.mjs');
  installLoopbackBrowserGuard({ chromium });
  await import('./support/astra-qa-egress-guard.mjs');

  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const files = new Map([
      ['/growth.html', ['growth.html', 'text/html; charset=utf-8']],
      ['/css/main.css', ['css/main.css', 'text/css']],
      ['/css/astra-growth.css', ['css/astra-growth.css', 'text/css']],
      ['/js/astra-growth.js', ['js/astra-growth.js', 'text/javascript']],
      ['/js/astra-campaign-draft.js', ['js/astra-campaign-draft.js', 'text/javascript']],
    ]);
    const entry = files.get(pathname);
    if (!entry) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
    fs.createReadStream(path.join(root, entry[0])).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  const calls = [];
  page.on('pageerror', error => errors.push(error.message));
  let postCount = 0;
  let detailReads = 0;
  let startPollReads = 0;
  let releaseGoalCreate;
  let goalCreateStarted;
  const goalCreateStartedPromise = new Promise(resolve => { goalCreateStarted = resolve; });
  let delayOldGoalDetail = false;
  let releaseOldGoalDetail;
  let oldGoalDetailStarted;
  const oldGoalDetailStartedPromise = new Promise(resolve => { oldGoalDetailStarted = resolve; });
  let oldGoalDetailCompleted;
  const oldGoalDetailCompletedPromise = new Promise(resolve => { oldGoalDetailCompleted = resolve; });
  let raceGoal = null;
  let answersBody;
  let startBody;
  let goal = null;
  const plan = {
    offerSummary: 'Plumbing growth audits', targetIndustry: 'Plumbing', country: 'US', city: 'Austin',
    objective: 'Find businesses for review', targetCount: 5,
    unknownCommercialFacts: ['Price is not known'], assumptions: { region: 'Austin metro' },
  };
  const json = (route, payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  await page.route('**/api/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    const method = request.method(); const pathName = url.pathname;
    const body = method === 'POST' ? JSON.parse(request.postData() || '{}') : null;
    calls.push({ method, path: pathName, body, idempotencyKey: request.headers()['idempotency-key'] || '' });
    if (pathName === '/api/astra/workspaces') return json(route, { workspaces: [{ id: tenantId, name: 'North Studio', role: 'owner', status: 'active' }, { id: otherTenantId, name: 'South Studio', role: 'reviewer', status: 'active' }], capabilities: { customerConsole: true }, releaseReady: false });
    if (pathName.endsWith('/context')) {
      const isNorth = pathName.includes(tenantId);
      return json(route, { tenant: { id: isNorth ? tenantId : otherTenantId, name: isNorth ? 'North Studio' : 'South Studio', status: 'active', role: isNorth ? 'owner' : 'reviewer' } });
    }
    if (pathName.endsWith('/business-goals') && method === 'POST') {
      postCount++;
      if (postCount === 1) { goalCreateStarted(); await new Promise(resolve => { releaseGoalCreate = resolve; }); }
      const created = { id: postCount === 1 ? goalId : raceGoalId, brief: body.brief, status: 'draft', stateRevision: 1, plan: null, questions: [], answers: [], blockedReasons: [], startRef: null };
      if (postCount === 1) goal = created; else raceGoal = created;
      return json(route, { goal: created }, 201);
    }
    if (pathName.endsWith('/business-goals') && method === 'GET') return json(route, { items: pathName.includes(otherTenantId) || !goal ? [] : [
      ...(raceGoal ? [{ id: raceGoal.id, brief: raceGoal.brief, status: raceGoal.status, stateRevision: raceGoal.stateRevision, blockedReasons: raceGoal.blockedReasons, startRef: raceGoal.startRef, createdAt: '2026-10-29T00:00:00Z' }] : []),
      { id: goal.id, brief: goal.brief, status: goal.status, stateRevision: goal.stateRevision, blockedReasons: goal.blockedReasons, startRef: goal.startRef, createdAt: '2026-10-28T00:00:00Z' },
      { id: blockedGoalId, brief: 'Blocked test goal', status: 'blocked', stateRevision: 2, blockedReasons: [{ code: 'source_policy_unknown', message: 'Workspace grant <not found>.' }], createdAt: '2026-10-27T00:00:00Z' },
    ] });
    if (pathName.endsWith(`/business-goals/${goalId}/answers`) && method === 'POST') {
      answersBody = body;
      goal = { ...goal, status: 'planned', stateRevision: 3, plan, questions: [{ questionId: 'customer-count', question: 'How many customers should we research?' }], answers: body.answers, blockedReasons: [] };
      return json(route, { goal });
    }
    if (pathName.endsWith(`/business-goals/${goalId}/start`) && method === 'POST') {
      startBody = body;
      goal = { ...goal, status: 'running', stateRevision: 4, startRef: { kind: 'prospecting_job', state: 'starting' }, blockedReasons: [] };
      return json(route, { goal });
    }
    if (pathName.endsWith(`/business-goals/${goalId}`) && method === 'GET') {
      detailReads++;
      const savedGoal = goal;
      if (delayOldGoalDetail) {
        oldGoalDetailStarted();
        await new Promise(resolve => { releaseOldGoalDetail = resolve; });
        oldGoalDetailCompleted();
        return json(route, { goal: savedGoal });
      }
      if (goal?.status === 'draft' && detailReads >= 2) goal = { ...goal, status: 'awaiting_confirmation', stateRevision: 2, plan, questions: [{ questionId: 'customer-count', question: 'How many customers should we research?' }], blockedReasons: [] };
      if (goal?.status === 'running' && goal.startRef?.state === 'starting' && ++startPollReads >= 1) goal = { ...goal, stateRevision: 5, startRef: { kind: 'prospecting_job', id: jobId, state: 'queued' } };
      return json(route, { goal });
    }
    if (pathName.endsWith(`/business-goals/${blockedGoalId}`) && method === 'GET') return json(route, { goal: {
      id: blockedGoalId, brief: 'Blocked test goal', status: 'blocked', stateRevision: 2, plan: null, questions: [], answers: [],
      blockedReasons: [{ code: 'source_policy_unknown', message: 'Workspace grant <not found>.' }], startRef: null,
    } });
    if (pathName.endsWith('/prospecting/status')) return json(route, { prospecting: { ready: false, canCreate: true, reason: 'Synthetic fixture' } });
    if (pathName.endsWith('/prospecting/jobs')) return json(route, { jobs: goal?.startRef?.id === jobId ? [{ id: jobId, state: 'queued', version: 1, payload: { category: 'Plumbing', country: 'US', city: 'Austin', goal: 'Find businesses for review' } }] : [] });
    if (pathName.endsWith(`/prospecting/jobs/${jobId}`)) return json(route, { job: { id: jobId, state: 'queued', version: 1, payload: { category: 'Plumbing', country: 'US', city: 'Austin', goal: 'Find businesses for review' } }, evidence: [], outcomes: [], contacts: [] });
    if (pathName.endsWith('/prospecting/contacts')) return json(route, { contacts: [] });
    if (pathName.endsWith('/research/evidence') || pathName.endsWith('/research/identities') || pathName.endsWith('/research/claims')
      || pathName.endsWith('/campaigns') || pathName.endsWith('/offers') || pathName.endsWith('/mailboxes')
      || pathName.endsWith('/inbox/messages') || pathName.endsWith('/outcomes') || pathName.endsWith('/crm/mappings') || pathName.endsWith('/crm/outbox')) return json(route, { data: [], items: [], offers: [] });
    if (pathName.endsWith('/analytics/funnel')) return json(route, { data: { funnel: {}, attribution: 'none' } });
    return json(route, { error: `Unexpected fixture API ${method} ${pathName}` }, 404);
  });

  await page.goto(`${base}/growth.html`);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByLabel('Your goal').fill('I sell SEO audits to plumbers in Austin.');
  const createRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/business-goals'));
  await page.getByLabel('Your goal').press('Enter');
  await goalCreateStartedPromise;
  await createRequest;
  await page.getByLabel('Your goal').press('Enter');
  releaseGoalCreate();
  await page.getByText('Goal saved. Planning is in progress. No research has started yet.').waitFor();
  assert.equal(postCount, 1, 'double submit path creates one durable goal');
  assert.match(await page.locator('#goal-saved-list').innerText(), /I sell SEO audits to plumbers in Austin/);
  assert.doesNotMatch(await page.locator('#goal-status').innerText(), /plan drafted/i, 'draft is never presented as a completed plan');
  await page.getByText('Review the saved plan.', { exact: false }).waitFor({ timeout: 10000 });
  assert.equal(detailReads >= 2, true, 'the UI polls the saved goal until planning completes');
  assert.match(await page.locator('#goal-content').innerText(), /Price is not known/);
  assert.match(await page.locator('#goal-content').innerText(), /Austin metro/);
  const question = page.locator('#goal-answers-form input');
  await question.fill('5');
  await question.press('Enter');
  await page.getByRole('button', { name: 'Confirm plan and start research' }).waitFor();
  assert.equal(answersBody.expectedVersion, 2, 'answers use the last persisted revision');
  assert.deepEqual(answersBody.answers, [{ questionId: 'customer-count', answer: '5' }], 'native form submit handles keyboard answers');
  await page.getByRole('button', { name: 'Confirm plan and start research' }).click();
  await page.getByRole('button', { name: 'Open linked research progress' }).waitFor();
  assert.deepEqual(startBody, { expectedVersion: 3 }, 'owner confirmation uses CAS and sends no manual IDs or rights text');
  await page.locator('#prospecting-job-detail').getByText(/Plumbing · Queued for the approved worker/).waitFor();
  assert.ok(calls.some(call => call.method === 'GET' && call.path.endsWith(`/prospecting/jobs/${jobId}`)), 'the actual referenced prospecting job opens in the existing progress widget');

  const readsBeforeReload = detailReads;
  await page.reload();
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.getByText('The confirmed plan has started its saved research journey.', { exact: false }).waitFor();
  assert.ok(detailReads >= readsBeforeReload + 1, 'the selected goal is reloaded from the saved list after page reload');
  await page.locator('#goal-saved-list article').filter({ hasText: 'Blocked test goal' }).getByRole('button', { name: 'View saved goal' }).click();
  await page.getByText('Planning is blocked.').waitFor();
  assert.match(await page.locator('#goal-status').innerText(), /source_policy_unknown.*Workspace grant <not found>\./s, 'saved blocker code and message are preserved verbatim as text');
  assert.equal(await page.locator('#goal-status script').count(), 0, 'blocked reason content cannot inject markup');
  await page.locator('#workspace-select').selectOption(otherTenantId);
  await page.getByRole('heading', { name: 'Good to see you, South Studio.' }).waitFor();
  await page.getByText('No saved goals in this workspace yet.').waitFor();
  assert.equal(await page.locator('#goal-form').isVisible(), false, 'read-only reviewer cannot create a goal');
  assert.equal(await page.locator('#goal-content').innerText(), '', 'workspace transition clears the previously selected tenant goal');
  assert.equal(await page.locator('#goal-form input').evaluateAll(inputs => inputs.some(input => /uuid|json|hash|rights|tenant.?id/i.test(`${input.name} ${input.placeholder}`))), false, 'routine goal entry does not ask for internal IDs, JSON, hashes, or rights text');

  await page.locator('#workspace-select').selectOption(tenantId);
  await page.getByRole('heading', { name: 'Good to see you, North Studio.' }).waitFor();
  await page.getByRole('tab', { name: 'Discover' }).click();
  await page.locator('#goal-saved-list article').filter({ hasText: 'I sell SEO audits to plumbers in Austin.' }).waitFor();
  delayOldGoalDetail = true;
  await page.locator('#goal-saved-list article').filter({ hasText: 'I sell SEO audits to plumbers in Austin.' }).getByRole('button', { name: 'View saved goal' }).click();
  await oldGoalDetailStartedPromise;
  await page.getByLabel('Your goal').fill('I want a fresh plan for independent bakeries in Portland.');
  await page.getByRole('button', { name: 'Save goal and plan' }).click();
  await page.locator('#goal-content .goal-brief').getByText('I want a fresh plan for independent bakeries in Portland.', { exact: true }).waitFor();
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/business-goals/${goalId}`));
  releaseOldGoalDetail();
  await staleResponse;
  await oldGoalDetailCompletedPromise;
  assert.equal(await page.locator('#goal-content .goal-brief').innerText(), 'I want a fresh plan for independent bakeries in Portland.', 'a delayed detail response for the previous goal cannot overwrite the newly created selection');
  assert.ok(calls.some(call => call.method === 'POST' && call.path.endsWith('/business-goals')), 'the race fixture uses a real delayed browser request and a separate create request');
  assert.equal(errors.length, 0, `browser script errors: ${errors.join('; ')}`);
  assert.ok(calls.every(call => call.path.startsWith('/api/astra/')), 'fixture made no calls to providers, public search, or outreach endpoints');
});
