import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const edgePath = process.env.ODD_CHROMIUM_EXECUTABLE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const contentType = file => file.endsWith('.js') ? 'text/javascript; charset=utf-8'
  : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
const result = {
  name: 'Regional workflow automation buyers',
  icp: {
    summary: 'B2B service companies with repeatable intake workflows.',
    industries: ['Business services'], company_size: ['20–200 employees'], geography: ['United States'],
    must_have_signals: ['An operations owner'], exclude_signals: ['No workflow owner'],
    qualification_questions: ['Who owns the process?', 'How often does it occur?', 'How is fit evidenced?'],
  },
  personas: [
    { name: 'Operations champion', buying_role: 'champion', seniority: 'Manager', job_titles: ['Operations Manager'], must_have_skills: ['Process design'], technology_signals: ['Workflow software'], pain_points: ['Manual handoffs'], buying_triggers: ['New operations hire'], search_terms: ['operations manager workflow'], confidence: 'medium' },
    { name: 'Technical evaluator', buying_role: 'evaluator', seniority: 'Lead', job_titles: ['Systems Lead'], must_have_skills: ['Systems integration'], technology_signals: ['CRM integration'], pain_points: ['Disconnected tools'], buying_triggers: ['Platform migration'], search_terms: ['systems integration lead'], confidence: 'low' },
    { name: 'Economic buyer', buying_role: 'economic buyer', seniority: 'Director', job_titles: ['Operations Director'], must_have_skills: ['Budget ownership'], technology_signals: ['Business process platform'], pain_points: ['Unmeasured costs'], buying_triggers: ['Annual planning'], search_terms: ['operations director'], confidence: 'low' },
  ],
  search_plan: [
    { source: 'operator_csv', approach: 'Use a licensed operator-supplied list.', query_terms: ['business services'] },
    { source: 'osm_export', approach: 'Filter a supplied regional export and keep attribution.', query_terms: ['business services'] },
  ],
  scoring_rubric: [
    { criterion: 'Industry fit', weight: 30, positive_signals: ['Relevant category'] },
    { criterion: 'Workflow evidence', weight: 30, positive_signals: ['Published workflow'] },
    { criterion: 'Role match', weight: 25, positive_signals: ['Relevant job title'] },
    { criterion: 'Readiness', weight: 15, positive_signals: ['Owner can validate'] },
  ],
  hypotheses_notice: 'AI-generated targeting hypotheses. Validate them against current, source-backed account evidence before outreach.',
};
let saved = [];
let providerSettings = {
  provider: 'openai-compatible', baseUrl: 'https://ai.fixture.test/v1', model: 'fixture-model',
  apiKeyConfigured: false, source: 'workspace', scope: 'personal', canEdit: true, canManageWorkspace: false,
  personalConfigured: false, personalApiKeyConfigured: false, workspaceApiKeyConfigured: false,
  personal: { provider: 'openai-compatible', baseUrl: 'https://ai.fixture.test/v1', model: 'fixture-model', apiKeyConfigured: false, configured: false },
  workspace: { provider: 'openai-compatible', baseUrl: 'https://ai.fixture.test/v1', model: 'fixture-model', apiKeyConfigured: false, configured: true },
  encryptionAvailable: true,
};
let savedProviderSettingsPayload = null;
let failProviderSettingsSave = false;
let clearProviderSettingsCalls = 0;
const appSource = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/observatory.css"><link rel="stylesheet" href="/css/lead-strategy.css"></head><body><main id="main-content"></main><script type="module">import {renderLeads} from '/js/leads.js'; window.__workspaceRole='operator'; await renderLeads(document.querySelector('#main-content'));</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': contentType('index.html') }); res.end(appSource); return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/batches') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-tags') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-segments') return res.end('[]');
    if (req.method === 'GET' && url.pathname === '/api/contact-fields') return res.end(JSON.stringify({ fields: [] }));
    if (req.method === 'GET' && url.pathname === '/api/leads') return res.end(JSON.stringify({ leads: [], pagination: { total: 0, hasMore: false, nextCursor: null } }));
    if (req.method === 'GET' && url.pathname === '/api/lead-strategies') {
      return res.end(JSON.stringify({ provider: { provider: providerSettings.provider, model: providerSettings.model, ready: true, endpointConfigured: true, apiKeyConfigured: providerSettings.apiKeyConfigured, connection: 'not_checked', note: 'Configuration is present.' }, settings: providerSettings, strategies: saved }));
    }
    if (req.method === 'POST' && url.pathname === '/api/lead-strategies/provider-check') {
      await new Promise(resolve => setTimeout(resolve, 120));
      return res.end(JSON.stringify({ connection: 'connected', connected: true, modelAvailable: true, provider: providerSettings.provider, model: providerSettings.model }));
    }
    if (req.method === 'PUT' && url.pathname === '/api/lead-strategies/provider-settings') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      savedProviderSettingsPayload = JSON.parse(Buffer.concat(chunks).toString());
      if (failProviderSettingsSave) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: 'Set ODD_CREDENTIAL_ENCRYPTION_KEY before saving mailbox credentials. Generate a private 32-byte key and keep it outside the database.' }));
      }
      providerSettings = {
        provider: savedProviderSettingsPayload.provider,
        baseUrl: savedProviderSettingsPayload.baseUrl,
        model: savedProviderSettingsPayload.model,
        apiKeyConfigured: Boolean(savedProviderSettingsPayload.apiKey) || (providerSettings.apiKeyConfigured && !savedProviderSettingsPayload.clearApiKey),
        source: savedProviderSettingsPayload.scope || 'personal', scope: savedProviderSettingsPayload.scope || 'personal',
        canEdit: true, canManageWorkspace: false, personalConfigured: true,
        personalApiKeyConfigured: Boolean(savedProviderSettingsPayload.apiKey) || providerSettings.personalApiKeyConfigured,
        workspaceApiKeyConfigured: providerSettings.workspaceApiKeyConfigured,
        personal: { provider: savedProviderSettingsPayload.provider, baseUrl: savedProviderSettingsPayload.baseUrl, model: savedProviderSettingsPayload.model,
          apiKeyConfigured: Boolean(savedProviderSettingsPayload.apiKey) || providerSettings.personalApiKeyConfigured, configured: true },
        workspace: providerSettings.workspace,
        encryptionAvailable: true,
      };
      return res.end(JSON.stringify({ settings: providerSettings, provider: { provider: providerSettings.provider, model: providerSettings.model, ready: true, endpointConfigured: true, apiKeyConfigured: providerSettings.apiKeyConfigured } }));
    }
    if (req.method === 'DELETE' && url.pathname === '/api/lead-strategies/provider-settings') {
      clearProviderSettingsCalls++;
      providerSettings = {
        ...providerSettings.workspace, provider: providerSettings.workspace.provider, baseUrl: providerSettings.workspace.baseUrl,
        model: providerSettings.workspace.model, apiKeyConfigured: providerSettings.workspace.apiKeyConfigured,
        source: 'workspace', scope: 'personal', canEdit: true, canManageWorkspace: false,
        personalConfigured: false, personalApiKeyConfigured: false,
        workspaceApiKeyConfigured: providerSettings.workspace.apiKeyConfigured, personal: { ...providerSettings.workspace, configured: false },
        workspace: providerSettings.workspace, encryptionAvailable: true,
      };
      return res.end(JSON.stringify({ settings: providerSettings, provider: { provider: providerSettings.provider, model: providerSettings.model, ready: true, endpointConfigured: true, apiKeyConfigured: providerSettings.apiKeyConfigured } }));
    }
    if (req.method === 'POST' && url.pathname === '/api/lead-strategies') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const brief = JSON.parse(Buffer.concat(chunks).toString());
      const profile = { id: 41, name: result.name, brief, result, provider: 'openai-compatible', model_id: 'fixture-model', input_tokens: 120, output_tokens: 240, created_at: '2026-10-10 10:00:00' };
      saved = [profile, ...saved]; res.statusCode = 201; return res.end(JSON.stringify(profile));
    }
    const strategy = url.pathname.match(/^\/api\/lead-strategies\/(\d+)$/);
    if (req.method === 'GET' && strategy) {
      const profile = saved.find(item => item.id === Number(strategy[1]));
      if (profile) return res.end(JSON.stringify(profile));
      res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' }));
    }
    res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' }));
  }
  const assetPath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': contentType(assetPath) }); fs.createReadStream(assetPath).pipe(res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

test('Contacts AI targeting studio creates multiple personas, displays skill signals, and reloads saved plans', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  saved = [];
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const targeting = page.getByRole('button', { name: '✦ AI targeting' });
    await targeting.waitFor();
    await targeting.click();
    const dialog = page.getByRole('dialog', { name: 'Build an AI targeting strategy' });
    await dialog.waitFor();
    assert.match(await dialog.locator('.lead-strategy-provider').textContent(), /openai-compatible/);
    assert.equal(await dialog.getByRole('button', { name: '✦ Generate strategy' }).isDisabled(), true, 'generation stays disabled until the endpoint and selected model pass a connection check');
    await dialog.getByRole('button', { name: 'Check connection' }).click();
    await dialog.getByText(/Connected · model available/).waitFor();
    await dialog.locator('[name="offer"]').fill('Workflow automation for regional B2B service teams');
    await dialog.locator('[name="targetMarket"]').fill('B2B service companies with repeatable intake workflows');
    await dialog.locator('[name="geography"]').fill('United States');
    await dialog.getByRole('button', { name: '✦ Generate strategy' }).click();
    await dialog.getByRole('heading', { name: 'Regional workflow automation buyers' }).waitFor();
    await dialog.getByText('Operations champion', { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /3 buyer personas/);
    assert.match(await dialog.innerText(), /Process design/);
    assert.match(await dialog.innerText(), /Your CSV imports/);
    assert.match(await dialog.innerText(), /did not create leads or send email/);
    const select = dialog.locator('#lead-strategy-saved');
    assert.equal(await select.inputValue(), '41');
    await select.selectOption('');
    await select.selectOption('41');
    await dialog.getByText('Technical evaluator', { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('operators can save their personal AI provider and the connection feedback stays stable', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  providerSettings = {
    provider: 'openai-compatible', baseUrl: 'https://ai.fixture.test/v1', model: 'fixture-model',
    apiKeyConfigured: false, source: 'workspace', scope: 'personal', canEdit: true, canManageWorkspace: false,
    personalConfigured: false, personalApiKeyConfigured: false, workspaceApiKeyConfigured: false,
    personal: { provider: 'openai-compatible', baseUrl: 'https://ai.fixture.test/v1', model: 'fixture-model', apiKeyConfigured: false, configured: false },
    workspace: { provider: 'openai-compatible', baseUrl: 'https://ai.fixture.test/v1', model: 'fixture-model', apiKeyConfigured: false, configured: true },
    encryptionAvailable: true,
  };
  savedProviderSettingsPayload = null;
  failProviderSettingsSave = false;
  clearProviderSettingsCalls = 0;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '✦ AI targeting' }).click();
    let dialog = page.getByRole('dialog', { name: 'Build an AI targeting strategy' });
    await dialog.waitFor();
    await dialog.locator('.lead-strategy-settings-details summary').click();
    await dialog.locator('[name="strategyModel"]').fill('fixture-model-v2');
    await dialog.locator('[name="strategyApiKey"]').fill('synthetic-provider-secret');
    await dialog.getByRole('button', { name: 'Save provider settings' }).click();
    const saveFeedback = dialog.locator('#lead-strategy-provider-save-status');
    await saveFeedback.waitFor({ state: 'visible' });
    await page.waitForFunction(() => Boolean(document.querySelector('#lead-strategy-provider-save-status')?.textContent.trim()), null, { timeout: 5000 });
    assert.match(await saveFeedback.innerText(), /selected model is stored/, `the save feedback explains the result: ${await saveFeedback.innerText()}`);
    assert.equal(savedProviderSettingsPayload.model, 'fixture-model-v2');
    assert.equal(savedProviderSettingsPayload.scope, 'personal');
    assert.equal(savedProviderSettingsPayload.apiKey, 'synthetic-provider-secret', 'the secret is sent only to the server save endpoint');
    assert.equal(await dialog.locator('.studio-dialog-form').innerText().then(text => text.includes('synthetic-provider-secret')), false, 'the saved credential is not rendered back into the dialog');
    assert.equal(providerSettings.apiKeyConfigured, true);

    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: '✦ AI targeting' }).click();
    dialog = page.getByRole('dialog', { name: 'Build an AI targeting strategy' });
    await dialog.locator('.lead-strategy-settings-details summary').click();
    assert.equal(await dialog.locator('[name="strategyModel"]').inputValue(), 'fixture-model-v2', 'the next API read repopulates the durable selected model');
    assert.equal(await dialog.locator('[name="strategyApiKey"]').inputValue(), '', 'the saved API key is never returned to the browser');

    await dialog.locator('[name="strategyModel"]').fill('model-that-must-not-save');
    failProviderSettingsSave = true;
    await dialog.getByRole('button', { name: 'Save provider settings' }).click();
    await dialog.getByRole('alert').getByText(/Set ODD_CREDENTIAL_ENCRYPTION_KEY on the app server/).waitFor();
    assert.equal(providerSettings.model, 'fixture-model-v2', 'a rejected save does not appear persisted');
    failProviderSettingsSave = false;
    await dialog.locator('[name="strategyModel"]').fill('fixture-model-v2');
    await dialog.getByRole('button', { name: 'Save provider settings' }).click();
    await dialog.locator('#lead-strategy-provider-save-status').getByText(/selected model is stored/).waitFor();

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      const check = dialog.getByRole('button', { name: 'Check connection' });
      await check.click();
      await check.waitFor({ state: 'visible' });
      await check.evaluate(node => node.getAttribute('aria-busy') === 'true' || new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (node.getAttribute('aria-busy') === 'true') { observer.disconnect(); resolve(true); }
        });
        observer.observe(node, { attributes: true, attributeFilter: ['aria-busy'] });
      }));
      assert.equal(await check.locator('span').nth(1).innerText(), 'Check connection', 'the action label remains fixed while its progress spinner is shown');
      assert.equal(await check.locator('.lead-strategy-action-spinner').isVisible(), true);
      const geometry = await dialog.evaluate(node => {
        const status = node.querySelector('#lead-strategy-provider-status').getBoundingClientRect();
        const button = node.querySelector('#lead-strategy-check-provider').getBoundingClientRect();
        const spinner = node.querySelector('#lead-strategy-check-provider .lead-strategy-action-spinner').getBoundingClientRect();
        const label = node.querySelector('#lead-strategy-check-provider span:last-child').getBoundingClientRect();
        const intersects = status.left < button.right && status.right > button.left && status.top < button.bottom && status.bottom > button.top;
        const spinnerOverlapsLabel = spinner.width > 0 && label.width > 0
          && spinner.left < label.right && spinner.right > label.left
          && spinner.top < label.bottom && spinner.bottom > label.top;
        return { intersects, spinnerOverlapsLabel, spinnerRight: spinner.right, labelLeft: label.left,
          buttonRight: button.right, dialogRight: node.getBoundingClientRect().right };
      });
      assert.equal(geometry.intersects, false, `provider status and check action do not overlap at ${width}px`);
      assert.equal(geometry.spinnerOverlapsLabel, false, `connection spinner and label do not overlap at ${width}px`);
      assert.ok(geometry.spinnerRight <= geometry.labelLeft, `connection spinner has a clear gap before its label at ${width}px`);
      assert.ok(geometry.buttonRight <= geometry.dialogRight, `check action stays within the dialog at ${width}px`);
      await dialog.getByText('Connected · model available').waitFor();
      await page.waitForFunction(() => document.querySelector('#lead-strategy-check-provider')?.getAttribute('aria-busy') === null);
      assert.equal(await check.getAttribute('aria-busy'), null);
    }
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: '✦ AI targeting' }).click();
    dialog = page.getByRole('dialog', { name: 'Build an AI targeting strategy' });
    await dialog.locator('.lead-strategy-settings-details summary').click();
    await dialog.getByRole('button', { name: 'Use workspace default' }).click();
    await page.waitForTimeout(250);
    assert.equal(clearProviderSettingsCalls, 1, `personal settings reset made a request; status=${await dialog.locator('#lead-strategy-provider-save-status').innerText()}`);
    const clearFeedback = await dialog.locator('#lead-strategy-provider-save-status').innerText();
    assert.match(clearFeedback, /Personal provider removed/, `reset feedback is visible: ${clearFeedback}`);
    assert.equal(providerSettings.personalConfigured, false, 'removing the personal override restores the workspace provider');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});

test('operators can create a personal override while service environment settings remain the fallback', async t => {
  if (!fs.existsSync(edgePath)) return t.skip('No local Chromium-compatible browser is installed on this host.');
  providerSettings = {
    provider: 'freeinference', baseUrl: 'https://ai.fixture.test/v1', model: 'managed-model',
    apiKeyConfigured: true, source: 'environment', scope: 'personal', canEdit: true, canManageWorkspace: false,
    personalConfigured: false, personalApiKeyConfigured: false, workspaceApiKeyConfigured: true,
    personal: { provider: 'freeinference', baseUrl: 'https://ai.fixture.test/v1', model: 'managed-model', apiKeyConfigured: false, configured: false },
    workspace: { provider: 'freeinference', baseUrl: 'https://ai.fixture.test/v1', model: 'managed-model', apiKeyConfigured: true, configured: true },
    encryptionAvailable: true,
  };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: edgePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '✦ AI targeting' }).click();
    const dialog = page.getByRole('dialog', { name: 'Build an AI targeting strategy' });
    await dialog.locator('.lead-strategy-settings-details summary').click();
    await dialog.getByText(/[Ww]orkspace provider is the fallback/).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Save provider settings' }).count(), 1);
    assert.equal(await dialog.locator('[name="strategyScope"]').getAttribute('type'), 'hidden', 'operators can save only their personal settings');
    assert.equal(await dialog.locator('[name="strategyApiKey"]').getAttribute('required') !== null, true, 'the fallback key is not copied into the personal account');
  } finally {
    await browser.close();
  }
});
