import { appendTemplateLines, campaignCopyForEditor, composerCanApprove, composerEditorCanApprove, exactTemplateMappings, isCampaignLoadCurrent } from './astra-campaign-draft.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { workspaces: [], workspace: null, workspaceVerified: false, capabilities: {}, epoch: 0, accounts: [], evidence: [], claims: [], campaigns: [], offers: [], mailboxes: [], outcomes: [], crmMappings: [], crmOutbox: [], businessGoals: [], goalResume: null, goalStopPolling: null, prospectingReady: null, prospectingCanCreate: false, prospectingAvailability: 'unavailable', aiAvailability: null, prospectingJobs: [], prospectingContacts: [], prospectingDetailId: null, prospectingDetail: null, prospectingDetailToken: 0, prospectingPollTimer: null, prospectingPollCounts: new Map(), selectedCampaign: null, composer: null, composerGeneration: 0, campaignReview: null, campaignReviewGeneration: 0, role: '', busy: false, dataLoaded: false, dataError: '', resourceErrors: {} };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const formWriteTokens = new WeakMap();
let nextWriteToken = 0;
let sourceRightsReadToken = 0;
let sourceRightsActiveWriteToken = null;
const sourceRightsIdempotencyKeys = new Map();

function text(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}
function csrfToken() {
  const item = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('odd_csrf='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice('odd_csrf='.length)); } catch { return ''; }
}
function tenantPath(tenantId, resource) {
  if (!tenantId) throw new Error('Choose a workspace first.');
  return `/api/astra/tenants/${encodeURIComponent(tenantId)}${resource}`;
}
function captureScope() {
  if (!state.workspace?.id) throw new Error('Choose a workspace first.');
  return { tenantId: state.workspace.id, epoch: state.epoch };
}
function scopeIsCurrent(scope) { return Boolean(scope && state.epoch === scope.epoch && state.workspace?.id === scope.tenantId); }
function assertCurrentScope(scope) {
  if (!scopeIsCurrent(scope)) throw Object.assign(new Error('Workspace changed while this action was in progress.'), { stale: true });
}
function scopedPath(resource, scope = captureScope()) { return tenantPath(scope.tenantId, resource); }
function beginWrite(form, label, scope = captureScope()) {
  const token = ++nextWriteToken;
  formWriteTokens.set(form, token);
  setBusy(form, true, label);
  return { token, scope };
}
function finishWrite(form, token) {
  if (formWriteTokens.get(form) !== token) return;
  formWriteTokens.delete(form);
  setBusy(form, false);
}
function cancelWorkspaceWrites() {
  for (const form of $$('form')) {
    if (!formWriteTokens.has(form)) continue;
    formWriteTokens.set(form, ++nextWriteToken);
    setBusy(form, false);
  }
}
async function request(path, { method = 'GET', body, epoch = state.epoch, scope: suppliedScope = null, idempotencyKey = '' } = {}) {
  const tenantMatch = path.match(/^\/api\/astra\/tenants\/([^/]+)/);
  const scope = tenantMatch ? (suppliedScope || { tenantId: decodeURIComponent(tenantMatch[1]), epoch }) : null;
  if (scope && (decodeURIComponent(tenantMatch[1]) !== scope.tenantId || !scopeIsCurrent(scope))) {
    throw Object.assign(new Error('Workspace changed while this action was in progress.'), { stale: true });
  }
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (!['GET', 'HEAD'].includes(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  const response = await fetch(path, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = await response.text();
  let data = {};
  if (raw) { try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 500) }; } }
  if (scope && !scopeIsCurrent(scope)) throw Object.assign(new Error('Workspace changed while this action was in progress.'), { stale: true });
  if (!response.ok) {
    const reason = data.error || data.message || `Request failed (${response.status}).`;
    throw Object.assign(new Error(String(reason)), { status: response.status, code: data.code || '', reconciliationRequired: data.reconciliationRequired === true, commitState: data.commitState || null });
  }
  return data;
}
function setNotice(message = '', kind = 'info') {
  const box = $('#notice');
  box.textContent = message;
  box.className = `notice${message ? ` show ${kind}` : ''}`;
}
function setBusy(form, busy, label) {
  const submit = form.querySelector('[type="submit"]');
  if (!submit) return;
  if (busy) { submit.dataset.originalLabel = submit.textContent; submit.textContent = label || 'Working…'; }
  else if (submit.dataset.originalLabel) { submit.textContent = submit.dataset.originalLabel; delete submit.dataset.originalLabel; }
  submit.disabled = busy;
}
function listMessage(target, message, error = false) {
  const box = $(target);
  box.replaceChildren();
  box.className = 'list empty';
  box.textContent = message;
  if (error) box.dataset.state = 'error'; else delete box.dataset.state;
}
function itemCard(title, description = '', tag = '') {
  const card = text('article', 'data-card');
  card.append(text('h4', '', title));
  if (description) card.append(text('p', '', description));
  if (tag) card.append(text('span', `tag ${tag.toLowerCase().includes('blocked') ? 'blocked' : tag.toLowerCase().includes('unknown') ? 'unknown' : ''}`, tag));
  return card;
}
function renderBusinessGoalList() {
  const box = $('#goal-saved-list');
  if (!box) return;
  box.replaceChildren();
  const goals = Array.isArray(state.businessGoals) ? state.businessGoals : [];
  if (!goals.length) { listMessage('#goal-saved-list', 'No saved goals in this workspace yet.'); return; }
  box.className = 'list';
  for (const goal of goals) {
    const status = String(goal.status || 'saved').replaceAll('_', ' ');
    const card = itemCard(goal.brief || 'Business goal', `Saved ${safeDate(goal.createdAt)} · revision ${Number(goal.stateRevision) || 1}`, status);
    const open = text('button', 'button subtle', 'View saved goal');
    open.type = 'button'; open.dataset.loadGoal = String(goal.id || '');
    card.append(open);
    box.append(card);
  }
}
function safeDate(value) {
  if (!value) return 'Date not recorded';
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString() : 'Date not recorded';
}
function countValue(rows) { return Array.isArray(rows) ? String(rows.length) : '0'; }
function isWriter() { return ['owner', 'admin', 'operator'].includes(state.role); }
function isAdmin() { return ['owner', 'admin'].includes(state.role); }
function applyRoleGates() {
  const canWrite = isWriter();
  for (const formId of ['#goal-form', '#search-form', '#snapshot-form', '#claim-form', '#campaign-form', '#qualification-form', '#draft-form', '#plan-form', '#outcome-form', '#mailbox-form', '#message-import-form', '#crm-mapping-form', '#crm-proposal-form', '#create-workspace-form']) {
    const form = $(formId);
    if (form) form.hidden = !canWrite && formId !== '#create-workspace-form';
  }
  $('#advanced-link').hidden = !(document.body.classList.contains('pro-mode') && state.capabilities.operatorWorkspace && ['owner', 'admin', 'operator'].includes(state.role));
  const canManageSourceRights = isAdmin();
  $('#source-rights-panel').hidden = !canManageSourceRights;
  $('#source-rights-form').hidden = !canManageSourceRights;
  if ($('#offer-form')) $('#offer-form').hidden = !isAdmin();
  if ($('#approval-form')) $('#approval-form').hidden = !isAdmin();
  if ($('#approval-form [type="submit"]')) {
    const draftForm = $('#draft-form');
    const editorMatchesSaved = composerEditorCanApprove(state.composer?.validation, {
      campaignId: $('#campaign-select')?.value,
      subject: draftForm?.elements.subject.value.trim(),
      body: draftForm?.elements.body.value.trim(),
    }, state.composer, draftForm?.dataset.dirty === 'true');
    const reviewMatches = Boolean(state.campaignReview?.review?.campaignId === $('#campaign-select')?.value
      && state.campaignReview.review.version !== undefined
      && state.campaignReview.review.approval?.ready === true
      && String($('#approval-form')?.elements.expectedVersion.value) === String(state.campaignReview.review.version));
    $('#approval-form [type="submit"]').disabled = !editorMatchesSaved || !reviewMatches || !isAdmin();
  }
  if ($('#prospecting-form')) $('#prospecting-form').hidden = state.role !== 'owner';
  for (const disclosure of $$('details.task-disclosure')) {
    const forms = $$('form', disclosure);
    disclosure.hidden = forms.length > 0 && forms.every(form => form.hidden);
  }
  for (const button of $$('#campaign-prerequisites [data-open-task], #campaign-prerequisites [data-open-tasks]')) {
    const ids = (button.dataset.openTasks || button.dataset.openTask || '').split(',').map(value => value.trim()).filter(Boolean);
    const targets = ids.map(id => document.getElementById(id)).filter(Boolean);
    button.hidden = targets.length > 0 && !targets.some(form => !form.hidden && !form.closest('details.task-disclosure')?.hidden);
  }
  $('#role-badge').textContent = state.role || 'No access';
}
function setTabOrientation() {
  $('.section-nav').setAttribute('aria-orientation', window.matchMedia('(min-width: 861px)').matches ? 'vertical' : 'horizontal');
  requestAnimationFrame(ensureSelectedTabVisible);
}
function ensureSelectedTabVisible() {
  const nav = $('.section-nav');
  if (!nav || nav.getAttribute('aria-orientation') === 'vertical') return;
  const selected = $('[role="tab"][aria-selected="true"]', nav);
  if (!selected) return;
  const navBounds = nav.getBoundingClientRect();
  const tabBounds = selected.getBoundingClientRect();
  const leftEdge = navBounds.left + nav.clientLeft;
  const rightEdge = leftEdge + nav.clientWidth;
  const delta = tabBounds.left < leftEdge ? tabBounds.left - leftEdge : tabBounds.right > rightEdge ? tabBounds.right - rightEdge : 0;
  if (delta) nav.scrollBy({ left: delta, top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}
function setView(name, { updateHash = false } = {}) {
  if (!$(`#view-${name}`)) name = 'overview';
  for (const tab of $$('.section-nav [role="tab"]')) {
    const active = tab.dataset.view === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.id = `tab-${tab.dataset.view}`;
  }
  for (const view of $$('.view')) view.hidden = view.id !== `view-${name}`;
  ensureSelectedTabVisible();
  if (updateHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name !== 'discover') { stopProspectingPolling(); state.goalStopPolling?.(); }
  else {
    if (state.prospectingDetail?.job?.id) scheduleProspectingPolling(captureScope(), state.prospectingDetail.job.id);
    state.goalResume?.();
  }
  if (name === 'settings') { renderSettingsAvailability(); loadAiAvailability(); }
}
async function openProspectingCampaignPrep(businessName = '', accountId = '', contactId = '') {
  const scope = captureScope();
  let preparation = null;
  if (contactId && isWriter()) {
    try {
      const response = await request(scopedPath(`/prospecting/contacts/${encodeURIComponent(contactId)}/campaign-proof`, scope), { method: 'POST', scope, body: {} });
      assertCurrentScope(scope); preparation = response.preparation;
    } catch (error) { if (error.stale || !scopeIsCurrent(scope)) return; setNotice(`Campaign proof needs attention. ${error.message}`, 'error'); return; }
  }
  if (accountId && !state.accounts.some(item => item.id === accountId)) { await refreshAll(scope.epoch); if (!scopeIsCurrent(scope)) return; }
  state.prospectingCampaignAccountId = accountId || null;
  setView('campaigns', { updateHash: true });
  const form = $('#campaign-form');
  if (!form) return;
  const label = String(businessName || 'evidence-qualified business').slice(0, 120);
  if (!form.elements.name.value) form.elements.name.value = `Review offer for ${label}`;
  if (!form.elements.purpose.value) form.elements.purpose.value = `Human review of an approved offer for ${label}`;
  if (accountId && $('#qualification-form')) $('#qualification-form').elements.accountId.value = accountId;
  if (accountId) setNotice(preparation?.ready ? 'Current website industry and country proof saved for this prospect. Choose an approved offer and mailbox; campaign approval and contact verification remain separate.' : preparation?.blockers?.length ? `Prospect selected. Evidence needs review: ${preparation.blockers.join(', ').replaceAll('_', ' ')}.` : 'Saved prospect selected. Choose an approved offer and mailbox to prepare a draft; qualification and sending approval remain separate.', 'info');
  requestAnimationFrame(() => {
    form.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    form.elements.offerVersionId.focus({ preventScroll: true });
  });
}
async function openSavedProspect(accountId) {
  const scope = captureScope();
  setView('customers', { updateHash: true });
  if (!state.accounts.some(item => item.id === accountId)) {
    try { await refreshAll(scope.epoch); } catch (error) { if (!error.stale) setNotice('Saved business records could not be refreshed.', 'error'); }
  }
  if (!scopeIsCurrent(scope)) return;
  requestAnimationFrame(() => {
    if (!scopeIsCurrent(scope)) return;
    const card = $$('#customer-list [data-account-id]').find(item => item.dataset.accountId === String(accountId));
    const target = card || $('#customer-list');
    if (card) card.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}
function openWorkflowTasks(button) {
  if (button.dataset.go) setView(button.dataset.go, { updateHash: true });
  const ids = (button.dataset.openTasks || button.dataset.openTask || '').split(',').map(value => value.trim()).filter(Boolean);
  const targets = ids.map(id => document.getElementById(id)).filter(form => form && !form.hidden).map(form => {
    const disclosure = form.closest('details.task-disclosure');
    if (disclosure?.hidden) return null;
    if (disclosure) disclosure.open = true;
    return disclosure?.querySelector('summary') || form;
  }).filter(Boolean);
  requestAnimationFrame(() => {
    const target = targets[0];
    if (target) {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target.focus?.({ preventScroll: true });
      if (target.matches('form')) target.querySelector('input:not([type="hidden"]),select,textarea,button')?.focus({ preventScroll: true });
    } else if (button.dataset.go) $(`#view-${button.dataset.go}`)?.focus({ preventScroll: true });
  });
}
function applyProMode(enabled) {
  document.body.classList.toggle('pro-mode', enabled);
  const button = $('#pro-mode-toggle');
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', `${enabled ? 'Disable' : 'Enable'} Pro mode`);
  try { localStorage.setItem('odd-growth-pro-mode', enabled ? 'on' : 'off'); } catch { /* optional presentation preference */ }
  applyRoleGates();
}
function syncAdvancedWorkspaceHandoff() {
  const workspaceId = state.workspace?.id;
  const canOpen = Boolean(workspaceId && UUID_PATTERN.test(workspaceId) && state.capabilities.operatorWorkspace && ['owner', 'admin', 'operator'].includes(state.role) && document.body.classList.contains('pro-mode'));
  if (!canOpen) return 'The advanced workspace is available only to authorized operators in Pro mode.';
  try { localStorage.setItem('odd-astra-tenant-id', workspaceId); }
  catch { return 'The advanced workspace was not opened because the selected workspace could not be handed off safely. Check browser storage access and try again.'; }
  return '';
}
function workspaceLabel(workspace) { return workspace?.name || 'Workspace'; }
function refreshSelectOptions(selector, rows, { placeholder, label, value = row => row.id } = {}) {
  const select = $(selector);
  if (!select) return;
  const prior = select.value;
  select.replaceChildren(new Option(placeholder, ''));
  for (const row of rows) {
    const option = new Option(label(row), String(value(row)));
    select.append(option);
  }
  if ([...select.options].some(option => option.value === prior)) select.value = prior;
}
function optionData() {
  refreshSelectOptions('#campaign-form [name="offerVersionId"]', state.offers.filter(offer => offer.latest_status === 'approved' && offer.latest_version_id), {
    placeholder: state.offers.length ? 'Choose approved offer' : 'No approved offers yet',
    label: offer => `${offer.name} · v${offer.latest_version}`,
    value: offer => offer.latest_version_id,
  });
  refreshSelectOptions('#campaign-form [name="mailboxId"]', state.mailboxes, {
    placeholder: state.mailboxes.length ? 'Choose mailbox' : 'No mailbox set up', label: mailbox => `${mailbox.displayName} · ${mailbox.capabilities?.send === 'disabled' ? 'sending disabled' : 'ready'}`,
  });
  refreshSelectOptions('#message-import-form [name="mailboxId"]', state.mailboxes.filter(mailbox => mailbox.provider === 'manual'), {
    placeholder: state.mailboxes.some(mailbox => mailbox.provider === 'manual') ? 'Choose a manual inbox' : 'Create a manual inbox first',
    label: mailbox => `${mailbox.displayName} · manual import only`,
  });
  for (const selector of ['#crm-mapping-form [name="accountId"]', '#crm-proposal-form [name="accountId"]']) {
    refreshSelectOptions(selector, state.accounts, { placeholder: state.accounts.length ? 'Choose a business' : 'No evidence-backed businesses yet', label: account => account.displayDomain || account.normalizedDomain });
  }
  refreshSelectOptions('#qualification-form [name="campaignId"]', state.campaigns, { placeholder: 'Choose campaign', label: campaign => `${campaign.name} · ${campaign.state}` });
  refreshSelectOptions('#qualification-form [name="accountId"]', state.accounts, { placeholder: 'Choose business', label: account => account.displayDomain || account.normalizedDomain });
  refreshSelectOptions('#outcome-form [name="accountId"]', state.accounts, { placeholder: 'Choose business', label: account => account.displayDomain || account.normalizedDomain });
  refreshSelectOptions('#campaign-select', state.campaigns, { placeholder: 'Choose a campaign', label: campaign => `${campaign.name} · ${campaign.state}` });
  refreshSelectOptions('#claim-form [name="evidenceId"]', state.evidence, { placeholder: state.evidence.length ? 'Choose a saved page' : 'No saved pages yet', label: evidence => `${evidence.documentTitle || evidence.normalizedDomain} · ${safeDate(evidence.capturedAt)}` });
  const rightableSources = state.evidence.filter(source => UUID_PATTERN.test(source.sourceId || ''));
  refreshSelectOptions('#source-rights-form [name="sourceId"]', rightableSources, { placeholder: rightableSources.length ? 'Choose a saved source' : 'No captured sources yet', label: source => sourceOptionLabel(source), value: source => source.sourceId });
  renderCampaignPrerequisites();
}
function renderCampaignPrerequisites() {
  if (!$('#campaign-prerequisites')) return;
  const approvedOffers = state.offers.filter(offer => offer.latest_status === 'approved' && offer.latest_version_id);
  const manualMailboxes = state.mailboxes.filter(mailbox => mailbox.provider === 'manual');
  const supportedClaims = state.claims.filter(claim => claim.status === 'supported' && claim.latestCorrection !== 'retracted');
  const status = (selector, resource, value) => {
    const target = $(selector);
    if (!target) return;
    if (!state.workspace) target.textContent = 'Choose a workspace to load saved records.';
    else if (state.dataError) target.textContent = 'Workspace data could not be verified. Check access and refresh to retry.';
    else if (!state.dataLoaded) target.textContent = 'Loading saved workspace records…';
    else if (state.resourceErrors[resource]) target.textContent = `${resource[0].toUpperCase()}${resource.slice(1)} status unavailable. Refresh to retry.`;
    else target.textContent = value;
  };
  status('#prereq-offer-status', 'offers', approvedOffers.length
    ? `${approvedOffers.length} approved offer${approvedOffers.length === 1 ? '' : 's'} available.`
    : 'No approved offer is saved yet.');
  status('#prereq-mailbox-status', 'mailboxes', manualMailboxes.length
    ? `${manualMailboxes.length} manual inbox${manualMailboxes.length === 1 ? '' : 'es'} saved.`
    : 'No manual inbox is saved in this workspace yet.');
  status('#prereq-campaign-status', 'campaigns', state.campaigns.length
    ? `${state.campaigns.length} saved campaign${state.campaigns.length === 1 ? '' : 's'} in this workspace.`
    : 'No campaign draft is saved yet.');
  status('#prereq-qualification-status', 'accounts', state.accounts.length
    ? `${state.accounts.length} evidence-backed business${state.accounts.length === 1 ? '' : 'es'} available for review.`
    : 'No evidence-backed businesses are saved yet.');
  status('#prereq-copy-status', 'claims', supportedClaims.length
    ? `${supportedClaims.length} supported fact${supportedClaims.length === 1 ? '' : 's'} available for copy.`
    : 'No supported page facts are saved yet.');
  const mailboxAction = $('#prereq-open-mailbox');
  if (mailboxAction) mailboxAction.textContent = manualMailboxes.length ? 'Open Inbox' : 'Set up manual inbox';
  const offerAction = $('#prereq-open-offer');
  if (offerAction) offerAction.textContent = approvedOffers.length ? 'Review offers' : 'Create offer';
}
function sourceOptionLabel(source) {
  const account = state.accounts.find(item => item.normalizedDomain === source.normalizedDomain);
  return `${account?.displayDomain || source.documentTitle || source.normalizedDomain || 'Captured source'} · ${source.sourceUrl || 'URL unavailable'} · captured ${safeDate(source.capturedAt)}`;
}
function accountOptionState() {
  for (const selector of ['#qualification-form [name="accountId"]', '#outcome-form [name="accountId"]']) {
    const select = $(selector);
    if (!select) continue;
    select.disabled = !state.accounts.length;
  }
}
function sourceRightsBox(message, status = 'pending') {
  const box = $('#source-rights-result');
  if (!box) return;
  box.replaceChildren(text('p', '', message));
  box.className = 'result-box source-rights-result';
  box.dataset.state = status;
}
function renderSourceRights(rights) {
  const box = $('#source-rights-result');
  if (!box) return;
  box.replaceChildren();
  box.className = 'result-box source-rights-result';
  const stateName = String(rights?.effectiveRightsStatus || 'unavailable');
  box.dataset.state = stateName;
  const usable = rights?.usable === true;
  const statusLine = text('p', 'source-rights-status', `Current saved status: ${stateName}. ${usable ? 'Future use is currently permitted by the saved source policy.' : 'Future use is not permitted by the saved source policy.'}`);
  box.append(statusLine);
  if (rights?.rightsPolicy) box.append(text('p', '', `Saved rights basis: ${rights.rightsPolicy}`));
  if (rights?.rightsExpiresAt) box.append(text('p', '', `Saved expiry: ${safeDate(rights.rightsExpiresAt)}`));
  if (stateName === 'revoked') {
    box.append(text('p', '', `Future use of this captured source is blocked. Its capture and history are retained${rights.revokedAt ? ` · recorded ${safeDate(rights.revokedAt)}` : ''}.`));
    if (rights.reason) box.append(text('p', '', `Recorded reason: ${rights.reason}`));
  } else if (stateName === 'expired') {
    box.append(text('p', '', 'The saved rights period has expired. The existing capture and history are retained.'));
  } else if (stateName === 'permitted') {
    box.append(text('p', 'quiet', 'This status comes from the saved source-rights record; it is not a legal approval.'));
  }
  const submit = $('#source-rights-form [type="submit"]');
  if (submit && sourceRightsActiveWriteToken === null) submit.disabled = stateName === 'revoked' || stateName === 'unavailable';
}
function sourceRightsError(error) {
  const box = $('#source-rights-result');
  if (!box) return;
  box.replaceChildren(text('p', '', `Could not verify the saved rights status. ${error.message} The capture and its history were not changed by this read.`));
  box.className = 'result-box source-rights-result';
  box.dataset.state = 'error';
  const submit = $('#source-rights-form [type="submit"]');
  if (submit && sourceRightsActiveWriteToken === null) submit.disabled = false;
}
async function loadSourceRights(sourceId, suppliedScope = null) {
  const select = $('#source-rights-form [name="sourceId"]');
  const readToken = ++sourceRightsReadToken;
  if (!sourceId) {
    sourceRightsBox('Choose a captured source to read its saved rights status.', 'pending');
    const submit = $('#source-rights-form [type="submit"]'); if (submit && sourceRightsActiveWriteToken === null) submit.disabled = false;
    return null;
  }
  if (!isAdmin() || !state.evidence.some(item => item.sourceId === sourceId)) return null;
  const scope = suppliedScope || captureScope();
  sourceRightsBox('Reading saved source rights…', 'pending');
  const submit = $('#source-rights-form [type="submit"]'); if (submit) submit.disabled = true;
  try {
    const result = await request(scopedPath(`/research/sources/${encodeURIComponent(sourceId)}/rights`, scope), { scope });
    if (!scopeIsCurrent(scope) || sourceRightsReadToken !== readToken || select.value !== sourceId) return null;
    if (!result?.data || result.data.sourceId !== sourceId) throw new Error('The service did not return rights for the selected captured source.');
    renderSourceRights(result.data);
    return result.data;
  } catch (error) {
    if (error.stale || !scopeIsCurrent(scope) || sourceRightsReadToken !== readToken || select.value !== sourceId) return null;
    sourceRightsError(error);
    return null;
  }
}
async function handleSourceRightsSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!isAdmin()) return;
  const scope = captureScope();
  const sourceId = form.elements.sourceId.value;
  const reason = form.elements.reason.value.trim();
  if (!state.evidence.some(item => item.sourceId === sourceId)) { sourceRightsError(new Error('Choose a saved captured source in this workspace.')); return; }
  if (!reason || reason.length > 1000) { sourceRightsError(new Error('Enter a reason of 1 to 1,000 characters.')); return; }
  const keyScope = `${scope.tenantId}:${sourceId}:${reason}`;
  let idempotencyKey = sourceRightsIdempotencyKeys.get(keyScope);
  if (!idempotencyKey) {
    if (!globalThis.crypto?.randomUUID) { sourceRightsError(new Error('A secure retry key could not be created. Reload this page and try again.')); return; }
    idempotencyKey = `source-rights-${crypto.randomUUID()}`;
    sourceRightsIdempotencyKeys.set(keyScope, idempotencyKey);
  }
  const { token } = beginWrite(form, 'Recording stop…', scope);
  sourceRightsActiveWriteToken = token;
  sourceRightsBox('Recording the stop request…', 'pending');
  try {
    await request(scopedPath(`/research/sources/${encodeURIComponent(sourceId)}/rights-revocations`, scope), {
      method: 'POST', scope, body: { reason, idempotencyKey },
    });
    assertCurrentScope(scope);
    if (form.elements.sourceId.value !== sourceId) return;
    sourceRightsBox('Request saved. Checking the persisted rights status…', 'pending');
    const persisted = await loadSourceRights(sourceId, scope);
    if (scopeIsCurrent(scope) && form.elements.sourceId.value === sourceId && persisted?.effectiveRightsStatus === 'revoked') {
      sourceRightsIdempotencyKeys.delete(keyScope);
      form.elements.reason.value = '';
    }
  } catch (error) {
    if (error.stale || !scopeIsCurrent(scope) || form.elements.sourceId.value !== sourceId) return;
    if (error.status === 409) {
      sourceRightsIdempotencyKeys.delete(keyScope);
      const persisted = await loadSourceRights(sourceId, scope);
      if (scopeIsCurrent(scope) && form.elements.sourceId.value === sourceId) {
        const box = $('#source-rights-result');
        box?.prepend(text('p', '', `The retry key conflicted with an earlier request. The saved status above was reread. ${persisted?.effectiveRightsStatus === 'revoked' ? 'A prior request already stopped future use; the capture and history are retained.' : `No new stop request was recorded. ${error.message}`}`));
        if (box && persisted?.effectiveRightsStatus !== 'revoked') box.dataset.state = 'conflict';
        if (persisted?.effectiveRightsStatus === 'revoked') form.elements.reason.value = '';
      }
    } else sourceRightsError(error);
  } finally {
    if (formWriteTokens.get(form) !== token) return;
    sourceRightsActiveWriteToken = null;
    finishWrite(form, token);
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = $('#source-rights-result')?.dataset.state === 'revoked' || $('#source-rights-result')?.dataset.state === 'unavailable';
  }
}
function showWorkspaceSummary() {
  $('#workspace-title').textContent = state.workspace ? `Good to see you, ${workspaceLabel(state.workspace)}.` : 'Your next step, in view.';
  $('#workspace-subtitle').textContent = state.workspace ? 'A clear view of what you know, what is ready, and what still needs attention.' : 'Create a workspace or accept an invitation to get started.';
  $('#settings-name').textContent = state.workspace ? workspaceLabel(state.workspace) : 'No workspace selected';
  $('#settings-role').textContent = state.workspace ? `${state.role} access · ${state.workspace.status || 'active'}` : 'Select a workspace to view access.';
  $('#pro-workspace-id').textContent = state.workspace?.id ? String(state.workspace.id) : 'No active workspace';
  $('#pro-workspace-status').textContent = state.workspace?.status || (state.workspace ? 'active' : 'Not loaded');
  $('#settings-capabilities').textContent = state.workspace
    ? `Customer console available · ${state.capabilities.operatorWorkspace ? 'Operator workspace access available' : 'No operator workspace access'} · Release readiness: not approved.`
    : 'Choose a workspace to load its capabilities.';
}
function setAvailabilityRow(name, status, detail, label = status) {
  const badge = $(`#settings-${name}-state`);
  const description = $(`#settings-${name}-detail`);
  if (badge) { badge.dataset.state = status; badge.textContent = label; }
  if (description) description.textContent = detail;
}
function renderSettingsAvailability() {
  const refresh = $('#refresh-settings-availability');
  if (!state.workspace) {
    setAvailabilityRow('research', 'unavailable', 'Choose a workspace to check public research.', 'Unavailable');
    setAvailabilityRow('inbox', 'unavailable', 'Choose a workspace to check saved inboxes.', 'Unavailable');
    setAvailabilityRow('records', 'unavailable', 'Choose a workspace to check saved business data.', 'Unavailable');
    setAvailabilityRow('ai', 'unavailable', 'Choose a workspace to check AI task availability.', 'Unavailable');
    if (refresh) refresh.disabled = true;
    return;
  }
  if (refresh) refresh.disabled = state.aiAvailability?.status === 'checking';
  const research = state.prospectingAvailability;
  if (research === 'available') setAvailabilityRow('research', research, 'This workspace allows approved public research tasks. Each task still checks its saved approvals and source rules.', 'Available');
  else if (research === 'paused') setAvailabilityRow('research', research, 'Public research is paused for this workspace; analyze a supplied page while setup is completed.', 'Paused');
  else if (research === 'checking') setAvailabilityRow('research', research, 'Checking whether this workspace allows public research.', 'Checking');
  else setAvailabilityRow('research', 'unavailable', 'Public research availability could not be confirmed for this workspace.', 'Unavailable');

  if (!state.dataLoaded) {
    setAvailabilityRow('inbox', 'checking', 'Checking saved inboxes.', 'Checking');
    setAvailabilityRow('records', 'checking', 'Checking saved business records.', 'Checking');
  } else {
    if (state.resourceErrors.mailboxes) setAvailabilityRow('inbox', 'unavailable', 'Saved inbox information could not be loaded.', 'Unavailable');
    else {
      const manualCount = state.mailboxes.filter(mailbox => mailbox?.provider === 'manual').length;
      setAvailabilityRow('inbox', manualCount ? 'available' : 'setup', manualCount ? `${manualCount} manual inbox${manualCount === 1 ? '' : 'es'} saved. Messages are imported by hand; no sending or sync connection is checked here.` : 'No manual inbox is saved yet. Inbox data is imported by hand.', manualCount ? 'Manual imports only' : 'Not set up');
    }
    if (state.resourceErrors.evidence || state.resourceErrors.accounts) setAvailabilityRow('records', 'unavailable', 'Saved business records could not be fully loaded.', 'Unavailable');
    else {
      const pages = state.evidence.length;
      const businesses = state.accounts.length;
      setAvailabilityRow('records', pages || businesses ? 'available' : 'setup', pages || businesses ? `${businesses} business${businesses === 1 ? '' : 'es'} and ${pages} saved page${pages === 1 ? '' : 's'} are available in this workspace.` : 'No saved businesses or pages yet. Add a supplied page in Discover to create workspace records.', pages || businesses ? 'Available' : 'No saved records');
    }
  }

  const ai = state.aiAvailability;
  if (!ai || ai.epoch !== state.epoch || ai.tenantId !== state.workspace.id) setAvailabilityRow('ai', 'checking', 'Status is checked when Settings opens.', 'Not checked');
  else setAvailabilityRow('ai', ai.status, ai.detail, ai.label);
}
function aiBlockerExplanation(blocker) {
  const explanations = {
    local_preview_egress_denied: 'AI requests are not enabled in this local workspace.',
    application_egress_disabled: 'AI requests are disabled for this application.',
    provider_credentials_unavailable: 'AI provider setup is unavailable for this workspace.',
    approval_register_unavailable: 'AI approval settings could not be confirmed.',
    global_budget_disabled: 'AI requests are paused by a workspace-wide usage gate.',
    tenant_policy_disabled: 'AI requests are paused by this workspace’s policy.',
    circuit_breaker_open: 'AI requests are temporarily paused after a service issue.',
    provider_receipt_schema_unavailable: 'AI requests are paused while required task records are unavailable.',
    commercial_entitlement_unavailable: 'AI task access could not be confirmed for this workspace.',
  };
  return explanations[blocker] || 'AI requests are paused by a workspace approval or policy setting.';
}
async function loadAiAvailability({ force = false } = {}) {
  if (!state.workspace || !state.workspaceVerified) { renderSettingsAvailability(); return; }
  const scope = captureScope();
  const cached = state.aiAvailability;
  if (cached?.tenantId === scope.tenantId && cached.epoch === scope.epoch) {
    if (cached.promise) return cached.promise;
    if (!force) { renderSettingsAvailability(); return; }
  }
  const entry = { tenantId: scope.tenantId, epoch: scope.epoch, status: 'checking', label: 'Checking', detail: 'Checking whether approved AI tasks are available.', promise: null };
  state.aiAvailability = entry;
  renderSettingsAvailability();
  entry.promise = (async () => {
    try {
      const response = await request(scopedPath('/ai', scope), { scope });
      if (!scopeIsCurrent(scope) || state.aiAvailability !== entry) return;
      const data = response?.data;
      if (!data || typeof data !== 'object' || typeof data.egressEnabled !== 'boolean') {
        entry.status = 'unavailable'; entry.label = 'Unavailable'; entry.detail = 'AI task availability could not be confirmed from the workspace response.';
      } else if (data.egressEnabled) {
        entry.status = 'available'; entry.label = 'Available'; entry.detail = 'Available for approved tasks. This check does not test live provider connectivity.';
      } else {
        entry.status = 'paused'; entry.label = 'Paused'; entry.detail = aiBlockerExplanation(data.egressBlocker);
      }
    } catch (error) {
      if (error.stale || !scopeIsCurrent(scope) || state.aiAvailability !== entry) return;
      entry.status = 'unavailable'; entry.label = 'Unavailable'; entry.detail = 'AI task availability could not be loaded. Refresh to try again.';
    } finally {
      entry.promise = null;
      if (scopeIsCurrent(scope) && state.aiAvailability === entry) renderSettingsAvailability();
    }
  })();
  return entry.promise;
}
async function loadWorkspaces(preferredId = '') {
  const select = $('#workspace-select');
  select.replaceChildren(new Option('Loading your workspaces…', ''));
  try {
    const result = await request('/api/astra/workspaces');
    state.workspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
    state.capabilities = result.capabilities || {};
    select.replaceChildren(new Option(state.workspaces.length ? 'Choose a workspace' : 'No workspaces yet', ''));
    for (const workspace of state.workspaces) select.append(new Option(`${workspace.name} · ${workspace.role}`, workspace.id));
    const remembered = preferredId || sessionStorage.getItem('odd-growth-workspace') || '';
    const candidate = state.workspaces.find(item => item.id === remembered) || state.workspaces[0];
    if (candidate) { select.value = candidate.id; await activateWorkspace(candidate.id); }
    else {
      state.workspace = null; state.role = ''; state.epoch++;
      showWorkspaceSummary(); applyRoleGates(); clearWorkspaceData('Create a workspace or accept an invitation to continue.');
    }
  } catch (error) {
    select.replaceChildren(new Option('Could not load workspaces', ''));
    setNotice(`Your workspaces could not be loaded. ${error.message} Retry when your connection is available.`, 'error');
    clearWorkspaceData('Workspace access is unavailable.');
  }
}
function clearWorkspaceData(message) {
  state.dataLoaded = false; state.dataError = state.workspace && /could not be verified|unavailable/i.test(message) ? message : ''; state.resourceErrors = {};
  const isWorkspaceLoad = /loading this workspace/i.test(message);
  state.workspaceVerified = false;
  state.aiAvailability = null;
  sourceRightsReadToken++;
  sourceRightsActiveWriteToken = null;
  state.goalStopPolling?.(); state.businessGoals = []; renderBusinessGoalList();
  if ($('#goal-content')) { $('#goal-content').replaceChildren(); $('#goal-content').hidden = true; }
  if ($('#goal-status')) { $('#goal-status').className = 'result-box empty'; $('#goal-status').textContent = message; }
  state.accounts = []; state.evidence = []; state.claims = []; state.campaigns = []; state.offers = []; state.mailboxes = []; state.outcomes = []; state.crmMappings = []; state.crmOutbox = [];
  state.prospectingJobs = []; state.prospectingContacts = []; state.prospectingDetailId = null;
  state.prospectingDetail = null; state.prospectingCanCreate = false; state.prospectingCampaignAccountId = null; state.prospectingDetailToken++;
  stopProspectingPolling(); state.prospectingPollCounts.clear(); resetProspectingStages();
  state.prospectingReady = null;
  state.prospectingAvailability = isWorkspaceLoad ? 'checking' : 'unavailable';
  const prospectingForm = $('#prospecting-form');
  if (prospectingForm) prospectingForm.querySelector('[type="submit"]').disabled = true;
  const prospectingDetails = $('#prospecting-research-details');
  if (prospectingDetails) prospectingDetails.open = false;
  state.selectedCampaign = null; state.composer = null; state.composerGeneration++;
  delete $('#draft-form').dataset.campaignId;
  $('#draft-form').dataset.dirty = 'false';
  if ($('#draft-reload')) $('#draft-reload').disabled = true;
  $('#draft-account').textContent = 'Select a campaign to see its qualified business.';
  for (const form of $$('form')) if (form.id !== 'create-workspace-form') form.reset();
  if ($('#outcome-form')) handleRevenueFields();
  for (const id of ['#evidence-list', '#campaign-list', '#inbox-list', '#mailbox-list', '#customer-list', '#outcome-list', '#crm-mapping-list', '#crm-outbox-list']) if ($(id)) listMessage(id, message);
  if ($('#claim-result')) { $('#claim-result').className = 'result-box empty'; $('#claim-result').textContent = message; }
  sourceRightsBox(message, 'pending');
  if ($('#source-rights-form [type="submit"]')) $('#source-rights-form [type="submit"]').disabled = false;
  $('#overview-attention').replaceChildren(text('p', 'quiet', message));
  for (const id of ['#metric-evidence', '#metric-accounts', '#metric-campaigns', '#metric-outcomes']) $(id).textContent = '—';
  $('#funnel-list').textContent = message;
  $('#funnel-list').className = 'funnel-list empty';
  $('#crm-status').textContent = message;
  if ($('#inbox-write-result')) { $('#inbox-write-result').className = 'result-box empty'; $('#inbox-write-result').textContent = message; }
  for (const selector of ['#prospecting-status', '#prospecting-jobs', '#prospecting-job-detail', '#prospecting-contacts']) {
    const box = $(selector); if (box) { box.className = 'result-box empty'; box.textContent = message; if (selector === '#prospecting-status') box.dataset.state = isWorkspaceLoad ? 'checking' : 'unavailable'; }
  }
  $('#campaign-detail').textContent = message;
  $('#campaign-detail').className = 'result-box empty';
  for (const id of ['#search-result', '#snapshot-result', '#qualification-result', '#offer-result']) {
    const box = $(id); if (box) { box.className = 'result-box empty'; box.textContent = message; }
  }
  if ($('#claim-result')) { $('#claim-result').className = 'result-box empty'; $('#claim-result').textContent = message; }
  for (const box of $$('#search-result, #snapshot-result, #claim-result, #offer-result, #qualification-result, #inbox-write-result, #campaign-detail')) {
    delete box.dataset.workspaceLoadEpoch;
    if (isWorkspaceLoad) box.dataset.workspaceLoadEpoch = String(state.epoch);
  }
  optionData();
  renderDraftFacts(); renderDraftTemplates(); renderDraftSupport();
  renderFirstSuccessGuide();
  renderSettingsAvailability();
}
function settleWorkspaceLoadingResults(epoch) {
  const idleResults = [
    ['#search-result', 'No search request yet.', null, 'Search availability is unavailable.'],
    ['#snapshot-result', 'Your report will appear here after the page is saved.', null, 'Report status is unavailable.'],
    ['#claim-result', 'Choose a saved page and run this task to see a result.', 'claims', 'Evidence notes are unavailable.'],
    ['#offer-result', 'Run offer setup to see its result.', 'offers', 'Offer state is unavailable.'],
    ['#qualification-result', 'Run qualification to see its result.', 'accounts', 'Qualification inputs are unavailable.'],
    ['#inbox-write-result', 'Create a manual inbox, then import a message using its external message and thread references.', 'mailboxes', 'Manual inbox state is unavailable.'],
    ['#campaign-detail', 'Select a campaign to view its saved state and offline plans.', 'campaigns', 'Campaign state is unavailable.'],
  ];
  for (const [selector, emptyMessage, resource, unavailableMessage] of idleResults) {
    const box = $(selector);
    if (!box || box.dataset.workspaceLoadEpoch !== String(epoch)) continue;
    delete box.dataset.workspaceLoadEpoch;
    if (box.textContent !== 'Loading this workspace…') continue;
    const unavailable = resource && state.resourceErrors[resource];
    box.className = `result-box${unavailable ? '' : ' empty'}`;
    box.textContent = unavailable ? unavailableMessage : emptyMessage;
  }
}
async function activateWorkspace(id) {
  const selected = state.workspaces.find(workspace => workspace.id === id);
  if (!selected || !UUID_PATTERN.test(selected.id)) return;
  clearCampaignReview('Select a campaign, then load its saved review.');
  state.epoch++;
  state.dataLoaded = false; state.dataError = ''; state.resourceErrors = {};
  cancelWorkspaceWrites();
  const currentEpoch = state.epoch;
  state.workspace = selected;
  state.role = selected.role;
  sessionStorage.setItem('odd-growth-workspace', selected.id);
  showWorkspaceSummary(); applyRoleGates(); clearWorkspaceData('Loading this workspace…');
  $('#session-state').textContent = 'Workspace selected';
  $('#release-state').textContent = 'Release readiness has not been approved.';
  try {
    const context = await request(`/api/astra/tenants/${encodeURIComponent(selected.id)}/context`);
    if (currentEpoch !== state.epoch) return;
    if (context.tenant?.id !== selected.id) throw new Error('The server returned a different workspace context.');
    state.workspaceVerified = true;
    $('#workspace-title').textContent = `Good to see you, ${context.tenant.name}.`;
    if (!$('#view-settings').hidden) loadAiAvailability();
    refreshAll(currentEpoch).catch(error => {
      if (!error.stale && currentEpoch === state.epoch) setNotice(`Workspace data could not be refreshed. ${error.message}`, 'error');
    });
  } catch (error) {
    if (error.stale || currentEpoch !== state.epoch) return;
    $('#session-state').textContent = 'Workspace could not be verified';
    clearWorkspaceData('This workspace could not be verified. Check your access and retry.');
    setNotice(`Workspace context could not be verified. ${error.message}`, 'error');
  }
}
async function settled(tenantId, epoch, path, label, mapper) {
  try { return mapper(await request(tenantPath(tenantId, path), { epoch })) || []; }
  catch (error) { if (error.stale) throw error; return { error: `${label}: ${error.message}` }; }
}
function renderProspectingContacts(contacts = []) {
  const box = $('#prospecting-contacts'); if (!box) return;
  box.replaceChildren();
  if (!contacts.length) { listMessage('#prospecting-contacts', 'No evidence-qualified businesses yet. Unsupported candidates remain in their job record for review.'); return; }
  box.className = 'list';
  const seen = new Set();
  for (const row of contacts) {
    const contact = row.contact || {};
    const qualification = row.qualification || contact.qualification || {};
    const research = row.research || contact.research || {};
    const crm = row.crm || contact.crm || qualification.crm || {};
    const key = String(row.candidateKey || contact.candidateKey || crm.accountId || contact.normalizedDomain || contact.website || contact.name || '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const signals = qualification.signals || {};
    const verification = contact.emailCandidates?.length || contact.phoneCandidates?.length ? 'Contact candidates found · verification unknown and held' : 'No site contact candidate found';
    const card = itemCard(contact.displayName || contact.name || 'Business name not recorded', `${contact.website || 'Source URL not recorded'} · ${verification}`, crm.kind === 'workspace_prospect' ? 'Saved workspace prospect' : 'Evidence-qualified business');
    if (crm.kind === 'workspace_prospect' && crm.savedAt) card.append(text('p', 'source-line', `Workspace business saved ${safeDate(crm.savedAt)}`));
    if (displayScore(qualification)) card.append(text('strong', 'qualification-score', displayScore(qualification)));
    for (const [label, signal] of [['Category', signals.category], ['Location', signals.location], ['Opportunity signal', signals.opportunity]]) {
      if (signal?.exactExcerpt) card.append(text('p', 'quiet', `${label}: “${signal.exactExcerpt}”`));
    }
    for (const opportunity of (research.opportunities || [])) {
      if (opportunity.title) card.append(text('h4', '', opportunity.title));
      if (opportunity.rationale) card.append(text('p', 'quiet', opportunity.rationale));
      if (opportunity.evidenceExcerpt) card.append(text('blockquote', 'evidence-quote', `“${opportunity.evidenceExcerpt}”`));
      if (opportunity.sourceUrl) card.append(text('p', 'source-line', `${opportunity.sourceUrl}${opportunity.capturedAt ? ` · observed ${safeDate(opportunity.capturedAt)}` : ''}`));
    }
    for (const candidate of contact.emailCandidates || []) card.append(text('p', 'quiet', `Email candidate (unverified): ${candidate.value}`));
    for (const candidate of contact.phoneCandidates || []) card.append(text('p', 'quiet', `Phone candidate (unverified): ${candidate.value}`));
    card.append(text('p', 'source-line', `Prospect saved ${safeDate(row.createdAt)} · source evidence retained · sending requires separate authorization`));
    if (crm.kind === 'workspace_prospect' && crm.accountId) {
      const button = text('button', 'button subtle', 'Open saved business in Customers'); button.type = 'button'; button.dataset.openSavedProspect = crm.accountId; card.append(button);
    }
    if (isWriter()) {
      const button = text('button', 'button subtle', 'Open Campaigns to review an approved offer'); button.type = 'button';
      button.dataset.prospectingCampaignFor = row.id || ''; button.dataset.prospectingBusinessName = contact.displayName || contact.name || ''; button.dataset.prospectingAccountId = crm.accountId || '';  card.append(button);
    }
    box.append(card);
  }
}
const PROSPECTING_STAGES = [
  ['search', 'Public search'], ['sites', 'Website research'], ['research', 'AI research'], ['qualification', 'Evidence qualification'], ['crm', 'Saved prospect'],
];
function resetProspectingStages() {
  for (const [stage] of PROSPECTING_STAGES) {
    const item = $(`#prospecting-stage-list [data-stage="${stage}"]`);
    if (item) { item.dataset.state = 'waiting'; item.querySelector('em').textContent = 'Waiting'; }
  }
}
function stopProspectingPolling() {
  if (state.prospectingPollTimer) clearTimeout(state.prospectingPollTimer);
  state.prospectingPollTimer = null;
}
function statusText(value) {
  if (typeof value !== 'string') return '';
  return value.replaceAll(/[_-]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
}
function prospectingStageState(result) {
  const job = result?.job || {};
  const checkpoint = job.checkpoint && typeof job.checkpoint === 'object' ? job.checkpoint : {};
  const current = String(checkpoint.phase || checkpoint.currentStage || checkpoint.stage || job.progress?.stage || job.stage || '').toLowerCase().replaceAll('-', '_');
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  const outcomes = (result?.outcomes || []).map(item => item?.outcome || item).filter(Boolean);
  const contacts = Array.isArray(result?.contacts) ? result.contacts : [];
  const hasResearch = outcomes.some(item => item.type === 'prospecting.researched' && item.research?.status === 'completed' && item.research?.responseVerified === true) || contacts.some(row => (row?.research || row?.contact?.research)?.status === 'completed');
  const hasQualification = outcomes.some(item => ['prospecting.evidence_qualified', 'prospecting.quarantined'].includes(item.type)) || contacts.some(row => row?.qualification?.status);
  const hasCrm = contacts.some(row => { const crm = row?.crm || row?.contact?.crm || row?.qualification?.crm; return crm?.kind === 'workspace_prospect' && crm.accountId; });
  const hasSite = evidence.some(row => row?.evidence?.kind === 'business_website_page') || outcomes.some(item => item.type === 'prospecting.website_researched');
  const done = {
    search: evidence.length > 0 || outcomes.some(item => item.type === 'prospecting.search_completed'),
    sites: hasSite,
    research: hasResearch,
    qualification: hasQualification,
    crm: hasCrm,
  };
  const stageAliases = {
    search: ['search', 'discovery', 'public_search'],
    sites: ['site', 'sites', 'website', 'website_research', 'collection'],
    research: ['research', 'ai_research', 'inference'],
    qualification: ['qualification', 'qualify', 'evidence_qualification'],
    crm: ['crm', 'save_prospect', 'workspace_prospect'],
  };
  const activeStage = PROSPECTING_STAGES.find(([key]) => stageAliases[key].some(alias => current.includes(alias)))?.[0];
  const blocked = ['failed', 'cancelled', 'blocked', 'uncertain'].includes(String(job.state || '').toLowerCase());
  const hasHeld = outcomes.some(item => item.type === 'prospecting.quarantined' || /blocked|failed|uncertain/i.test(item.type || ''));
  return Object.fromEntries(PROSPECTING_STAGES.map(([key]) => {
    const value = done[key] ? 'complete' : activeStage === key && ['queued', 'running'].includes(String(job.state || '').toLowerCase()) ? 'active'
      : key === 'qualification' && hasHeld ? 'blocked'
        : blocked && activeStage === key ? 'blocked' : 'waiting';
    return [key, value];
  }));
}
function renderProspectingStages(result) {
  const statuses = prospectingStageState(result);
  for (const [key] of PROSPECTING_STAGES) {
    const item = $(`#prospecting-stage-list [data-stage="${key}"]`);
    if (!item) continue;
    const value = statuses[key];
    item.dataset.state = value;
    item.querySelector('em').textContent = ({ complete: 'Saved', active: 'In progress', blocked: 'Needs review', waiting: 'Waiting' })[value];
  }
}
function prospectingJobActive(job) { return ['queued', 'running'].includes(String(job?.state || '').toLowerCase()); }
function scheduleProspectingPolling(scope, jobId) {
  stopProspectingPolling();
  const job = state.prospectingDetail?.job;
  if (!scopeIsCurrent(scope) || state.prospectingDetailId !== jobId || !prospectingJobActive(job) || $('#view-discover').hidden || document.visibilityState !== 'visible') return;
  const attempts = state.prospectingPollCounts.get(jobId) || 0;
  if (attempts >= 60) {
    const note = $('#prospecting-poll-note');
    if (note) note.textContent = 'Live updates paused after several checks. Refresh saved work to read the latest checkpoint.';
    return;
  }
  state.prospectingPollTimer = setTimeout(async () => {
    state.prospectingPollTimer = null;
    if (!scopeIsCurrent(scope) || state.prospectingDetailId !== jobId || $('#view-discover').hidden || document.visibilityState !== 'visible') return;
    state.prospectingPollCounts.set(jobId, attempts + 1);
    try { await loadProspectingDetail(jobId, scope, { automatic: true }); }
    catch (error) {
      if (!error.stale && scopeIsCurrent(scope)) {
        const note = $('#prospecting-poll-note');
        if (note) note.textContent = 'The latest saved checkpoint could not be read. Updates will retry while this page remains open.';
      }
      scheduleProspectingPolling(scope, jobId);
    }
  }, 2500);
}
function accessibleProspectingBlocker(item) {
  if (typeof item?.message === 'string' && item.message.trim()) return item.message;
  return 'This candidate is held for source or evidence review. No prospect was saved.';
}
function displayScore(qualification) {
  const value = Number(qualification?.score);
  if (!Number.isFinite(value)) return '';
  return `Evidence coverage · ${value} / ${Number(qualification.scoreMax) > 0 ? Number(qualification.scoreMax) : 100}`;
}
function renderProspectingCandidate(record, parent, outcomeList = []) {
  const { contact = {}, evidence = {}, research = {}, qualification = {}, crm = {}, outcomes = [] } = record;
  const candidateTitle = contact.displayName || evidence.title || contact.name || research.opportunities?.[0]?.title || 'Business candidate';
  const status = crm.kind === 'workspace_prospect' ? 'Saved workspace prospect'
    : outcomes.some(item => item.type === 'prospecting.quarantined') || ['held', 'blocked', 'uncertain', 'failed'].includes(String(qualification.status || research.status || '').toLowerCase())
      ? 'Held for review' : evidence.kind === 'business_website_page' ? 'Website evidence collected' : 'Candidate discovered';
  const card = itemCard(candidateTitle, '', status);
  const sourceUrl = evidence.sourceUrl || research.opportunities?.find(item => item.sourceUrl)?.sourceUrl || contact.website;
  const capturedAt = evidence.capturedAt || research.opportunities?.find(item => item.capturedAt || item.sourceCapturedAt)?.capturedAt || research.updatedAt;
  if (sourceUrl) card.append(text('p', 'source-line', `${sourceUrl}${capturedAt ? ` · observed ${safeDate(capturedAt)}` : ''}`));
  else if (capturedAt) card.append(text('p', 'source-line', `Observed ${safeDate(capturedAt)}`));
  if (evidence.snippet) card.append(text('p', 'quiet', `Search lead only: “${evidence.snippet}”`));
  if (evidence.exactPageExcerpt) card.append(text('blockquote', 'evidence-quote', `“${evidence.exactPageExcerpt}”`));
  const opportunities = Array.isArray(research.opportunities) ? research.opportunities : [];
  for (const opportunity of opportunities) {
    const section = text('section', 'opportunity-evidence');
    section.append(text('h4', '', opportunity.title || 'Research finding'));
    if (opportunity.rationale) section.append(text('p', 'quiet', opportunity.rationale));
    if (opportunity.evidenceExcerpt) section.append(text('blockquote', 'evidence-quote', `“${opportunity.evidenceExcerpt}”`));
    const opportunityUrl = opportunity.sourceUrl;
    const opportunityDate = opportunity.capturedAt || opportunity.sourceCapturedAt;
    if (opportunityUrl) section.append(text('p', 'source-line', `${opportunityUrl}${opportunityDate ? ` · observed ${safeDate(opportunityDate)}` : ''}`));
    card.append(section);
  }
  if (research.status) {
    const researchLabel = ['blocked', 'failed', 'uncertain'].includes(String(research.status).toLowerCase())
      ? 'AI research was not saved; review the job status and its source record.'
      : 'Source-backed AI research is saved for this candidate.';
    card.append(text('p', 'quiet', researchLabel));
  }
  if (research.responseVerified === true && typeof research.actualModel === 'string' && research.actualModel.trim()) {
    card.append(text('p', 'source-line', `Verified provider result · ${research.actualModel.trim()}`));
  }
  const score = displayScore(qualification);
  if (score) card.append(text('strong', 'qualification-score', score));
  const breakdown = Array.isArray(qualification.scoreBreakdown) ? qualification.scoreBreakdown : [];
  if (breakdown.length) {
    const list = text('ul', 'qualification-breakdown');
    for (const item of breakdown) {
      const name = statusText(item.key) || 'Evidence factor';
      const points = Number.isFinite(Number(item.points)) && Number.isFinite(Number(item.maxPoints)) ? ` · ${item.points} / ${item.maxPoints}` : '';
      const reason = item.reason ? ` · ${item.reason}` : '';
      list.append(text('li', '', `${name}${points}${reason}`));
      if (item.evidenceExcerpt) list.append(text('blockquote', 'evidence-quote', `“${item.evidenceExcerpt}”`));
    }
    card.append(list);
  }
  for (const reason of qualification.reasons || []) {
    const value = typeof reason === 'string' ? statusText(reason) : reason?.message || reason?.reason;
    if (value) card.append(text('p', 'quiet', value));
  }
  for (const unknown of qualification.unknowns || []) {
    const value = typeof unknown === 'string' ? statusText(unknown) : unknown?.label || unknown?.reason;
    if (value) card.append(text('p', 'quiet', `Still unknown: ${value}`));
  }
  if (evidence.kind === 'business_website_page' && !evidence.exactPageExcerpt && !opportunities.some(item => item.evidenceExcerpt)) {
    card.append(text('p', 'quiet', 'No exact website excerpt was saved for this candidate.'));
  }
  for (const outcome of outcomes.filter(item => item.type === 'prospecting.quarantined' || /blocked|failed|uncertain/i.test(item.type || ''))) {
    card.append(text('p', 'safety-note', accessibleProspectingBlocker(outcome)));
  }
  if (crm.kind === 'workspace_prospect' && crm.accountId) {
    card.append(text('p', 'source-line', `Saved to Customers · ${safeDate(crm.savedAt)}`));
    const button = text('button', 'button subtle', 'Open saved business in Customers');
    button.type = 'button'; button.dataset.openSavedProspect = crm.accountId; card.append(button);
  }
  for (const candidate of contact.emailCandidates || []) card.append(text('p', 'quiet', `Email candidate · unverified: ${candidate.value}`));
  for (const candidate of contact.phoneCandidates || []) card.append(text('p', 'quiet', `Phone candidate · unverified: ${candidate.value}`));
  parent.append(card);
  return card;
}
function renderConnectedProspectingDetail(result) {
  const box = $('#prospecting-job-detail'); if (!box) return;
  box.replaceChildren();
  const job = result?.job;
  if (!job) { box.className = 'result-box empty'; box.textContent = 'Select a saved job to read its source-backed results.'; resetProspectingStages(); return; }
  box.className = 'result-box';
  const stateLabel = ({ queued: 'Queued for the approved worker', running: 'In progress', paused: 'Paused', succeeded: 'Completed', completed: 'Completed', failed: 'Stopped after an error', blocked: 'Blocked by a workspace or source check', cancelled: 'Stopped' })[String(job.state || '').toLowerCase()] || 'Saved job status';
  box.append(text('h4', '', `${job.payload?.category || 'Business research'} · ${stateLabel}`));
  box.append(text('p', 'quiet', `${job.payload?.city ? `${job.payload.city}, ` : ''}${job.payload?.country || 'Location unavailable'} · ${job.payload?.goal || ''}`));
  renderProspectingStages(result);
  const note = text('p', 'source-line'); note.id = 'prospecting-poll-note'; box.append(note);
  const outcomes = (result.outcomes || []).map(item => item?.outcome || item).filter(Boolean);
  for (const outcome of outcomes.filter(item => item.type !== 'campaign.preparation_blocked' && /blocked|failed|uncertain/i.test(item.type || ''))) {
    box.append(text('p', 'safety-note', accessibleProspectingBlocker(outcome)));
  }
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  const contacts = Array.isArray(result.contacts) ? result.contacts : [];
  const outcomeByKey = new Map();
  for (const outcome of outcomes) if (outcome.candidateKey) outcomeByKey.set(outcome.candidateKey, [...(outcomeByKey.get(outcome.candidateKey) || []), outcome]);
  const renderedEvidence = new Set();
  for (const row of contacts) {
    const contact = row?.contact || {};
    const resultEvidence = evidence.find(item => row.evidenceIds?.includes(item.id)) || evidence.find(item => item.evidence?.kind === 'business_website_page' && item.evidence?.sourceUrl === contact.website);
    const key = row.candidateKey || contact.candidateKey || resultEvidence?.evidence?.candidateKey || '';
    if (resultEvidence) renderedEvidence.add(resultEvidence);
    const ev = resultEvidence?.evidence || resultEvidence || {};
    renderProspectingCandidate({
      contact, evidence: ev,
      research: row.research || contact.research || outcomeByKey.get(key)?.find(item => item.research)?.research || {},
      qualification: row.qualification || contact.qualification || outcomeByKey.get(key)?.find(item => item.qualification)?.qualification || {},
      crm: row.crm || contact.crm || outcomeByKey.get(key)?.find(item => item.crm)?.crm || {},
      outcomes: outcomeByKey.get(key) || [],
    }, box);
  }
  const groupedEvidence = new Map();
  for (const row of evidence) {
    const key = row.evidence?.candidateKey || row.id;
    if (!groupedEvidence.has(key) || row.evidence?.kind === 'business_website_page') groupedEvidence.set(key, row);
  }
  for (const row of groupedEvidence.values()) {
    if (renderedEvidence.has(row)) continue;
    const item = row?.evidence || row || {};
    const matches = outcomes.filter(outcome => outcome.candidateKey && outcome.candidateKey === item.candidateKey);
    const research = matches.find(outcome => outcome.research)?.research || {};
    const qualification = matches.find(outcome => outcome.qualification)?.qualification || {};
    const crm = matches.find(outcome => outcome.crm)?.crm || {};
    renderProspectingCandidate({ contact: {}, evidence: item, research, qualification, crm, outcomes: matches }, box);
  }
  if (!contacts.length && !evidence.length) box.append(text('p', 'quiet', prospectingJobActive(job) ? 'The job is saved. The approved worker has not saved a candidate checkpoint yet.' : 'No candidate evidence was saved for this job. Check the recorded status above.'));
  for (const outcome of outcomes.filter(item => item.type === 'campaign.preparation_blocked')) {
    const panel = text('div', 'safety-note', 'No campaign draft was created. Review the business and choose an approved offer in Campaigns before preparing any copy. Nothing was sent.');
    const button = text('button', 'button subtle', 'Open Campaigns'); button.type = 'button'; button.dataset.prospectingCampaignFor = ''; panel.append(button); box.append(panel);
  }
  scheduleProspectingPolling(captureScope(), job.id);
}
function renderProspectingJobs(jobs = []) {
  const box = $('#prospecting-jobs'); if (!box) return;
  box.replaceChildren();
  if (!jobs.length) { listMessage('#prospecting-jobs', 'No guided prospecting jobs saved for this workspace.'); return; }
  box.className = 'list';
  for (const job of jobs) {
    const payload = job.payload || {};
    const stateLabel = ({ queued: 'Queued', running: 'In progress', paused: 'Paused', succeeded: 'Completed', completed: 'Completed', failed: 'Needs review', blocked: 'Needs review', cancelled: 'Stopped' })[String(job.state || '').toLowerCase()] || 'Saved';
    const card = itemCard(`${payload.category || 'Business search'} · ${payload.city ? `${payload.city}, ` : ''}${payload.country || 'location not recorded'}`, `${stateLabel} · ${payload.goal || 'Research goal not recorded'} · updated ${safeDate(job.updatedAt)}`, stateLabel);
    const view = text('button', 'button subtle', 'View research'); view.type = 'button'; view.dataset.prospectingView = job.id; card.append(view);
    if (['queued', 'running', 'paused'].includes(job.state)) {
      const action = job.state === 'paused' ? 'resume' : 'pause';
      const control = text('button', 'button subtle', action === 'resume' ? 'Resume' : 'Pause');
      control.type = 'button'; control.dataset.prospectingAction = action; control.dataset.jobId = job.id; control.dataset.jobVersion = String(job.version); card.append(control);
      const stop = text('button', 'button subtle', 'Stop'); stop.type = 'button'; stop.dataset.prospectingAction = 'cancel'; stop.dataset.jobId = job.id; stop.dataset.jobVersion = String(job.version); card.append(stop);
    }
    box.append(card);
  }
}
async function refreshProspecting(epoch = state.epoch) {
  if (!state.workspace || !$('#prospecting-status')) return;
  const scope = captureScope();
  if (scope.epoch !== epoch) return;
  const statusBox = $('#prospecting-status');
  const submit = $('#prospecting-form [type="submit"]');
  stopProspectingPolling(); state.prospectingDetailToken++;
  state.prospectingReady = null;
  state.prospectingCanCreate = false;
  state.prospectingAvailability = 'checking';
  renderSettingsAvailability();
  if (submit) submit.disabled = true;
  statusBox.className = 'result-box'; statusBox.dataset.state = 'checking'; statusBox.textContent = 'Checking prospecting availability for this workspace…';
  const status = await settled(scope.tenantId, epoch, '/prospecting/status', 'Prospecting status', result => result.prospecting || {});
  if (!scopeIsCurrent(scope)) return;
  if (status?.error) {
    state.prospectingReady = false;
    state.prospectingCanCreate = false;
    state.prospectingAvailability = 'unavailable';
    renderSettingsAvailability();
    statusBox.className = 'result-box'; statusBox.dataset.state = 'unavailable'; statusBox.textContent = 'Research availability could not be checked. Saved jobs will still be loaded if this workspace permits read access.';
  } else {
    state.prospectingReady = status?.ready === true;
    state.prospectingCanCreate = status?.canCreate === true || status?.ready === true;
    state.prospectingAvailability = status?.ready === true ? 'available' : status?.ready === false ? 'paused' : 'unavailable';
    renderSettingsAvailability();
    if (submit) submit.disabled = !state.prospectingCanCreate;
    if (submit && !formWriteTokens.has($('#prospecting-form'))) submit.textContent = state.prospectingReady ? 'Start research' : state.prospectingCanCreate ? 'Save request for approval' : 'Start research';
    statusBox.className = `result-box${state.prospectingReady ? '' : ' empty'}`;
    statusBox.dataset.state = state.prospectingReady ? 'ready' : status?.ready === false ? 'paused' : 'unavailable';
    statusBox.textContent = state.prospectingReady
      ? 'This workspace allows approved research jobs. Each start still checks the saved search permission and source rules before public requests.'
      : state.prospectingCanCreate
        ? `${status.reason || 'Public research is paused for this workspace.'} You may save a job to record the setup block; the service will not bypass source checks.`
        : status?.ready === false
          ? 'Public research is paused for this workspace. Analyze a supplied page while setup is completed.'
          : 'This workspace has not confirmed whether a research job can be saved.';
  }
  const [jobs, contacts] = await Promise.all([
    settled(scope.tenantId, epoch, '/prospecting/jobs', 'Prospecting jobs', result => result.jobs || []),
    settled(scope.tenantId, epoch, '/prospecting/contacts', 'Qualified prospects', result => result.contacts || []),
  ]);
  if (!scopeIsCurrent(scope)) return;
  state.prospectingJobs = Array.isArray(jobs) ? jobs : [];
  state.prospectingContacts = Array.isArray(contacts) ? contacts : [];
  renderProspectingJobs(state.prospectingJobs);
  renderProspectingContacts(state.prospectingContacts);
  if (jobs?.error) listMessage('#prospecting-jobs', jobs.error, true);
  if (contacts?.error) listMessage('#prospecting-contacts', contacts.error, true);
  const selected = state.prospectingJobs.find(job => job.id === state.prospectingDetailId)
    || state.prospectingJobs.find(prospectingJobActive);
  if (selected) await loadProspectingDetail(selected.id, scope);
  else {
    const detail = $('#prospecting-job-detail');
    state.prospectingDetail = null; state.prospectingDetailId = null; resetProspectingStages();
    detail.className = 'result-box empty';
    detail.textContent = jobs?.error ? 'Saved job history is unavailable. No job is selected.' : state.prospectingJobs.length ? 'Choose a saved job to read its source-backed results.' : 'No research job has been saved in this workspace yet.';
  }
}
async function loadProspectingDetail(jobId, scope = captureScope(), { automatic = false } = {}) {
  stopProspectingPolling();
  const requestToken = ++state.prospectingDetailToken;
  const result = await request(scopedPath(`/prospecting/jobs/${encodeURIComponent(jobId)}`, scope), { scope });
  assertCurrentScope(scope);
  if (requestToken !== state.prospectingDetailToken || state.prospectingDetailId && state.prospectingDetailId !== jobId && automatic) return null;
  state.prospectingDetailId = jobId;
  state.prospectingDetail = result;
  renderConnectedProspectingDetail(result);
  return result;
}
async function handleProspectingStart(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!state.prospectingCanCreate) {
    setNotice('This workspace has not confirmed that a research job can be saved.', 'info');
    return;
  }
  const { token, scope } = beginWrite(form, state.prospectingReady ? 'Starting bounded prospecting…' : 'Saving research request…');
  const output = $('#prospecting-status'); output.className = 'result-box'; output.textContent = 'Saving an owner-started prospecting job…';
  try {
    const data = new FormData(form);
    const expiry = new Date(`${data.get('rightsExpiresAt')}T23:59:59.000Z`);
    if (!Number.isFinite(expiry.valueOf()) || expiry.valueOf() <= Date.now()) throw new Error('Choose a future date through which you are allowed to use this source.');
    form.dataset.prospectingIdempotency ||= crypto.randomUUID();
    const result = await request(scopedPath('/prospecting/jobs', scope), {
      method: 'POST', scope, idempotencyKey: form.dataset.prospectingIdempotency,
      body: {
        category: data.get('category').trim(), country: data.get('country').trim(), city: data.get('city').trim(),
        goal: data.get('goal').trim(), targetCount: Number(data.get('targetCount')),
        sourceRights: {
          rightsEvidenceReference: data.get('rightsEvidenceReference').trim(), robotsEvidenceReference: data.get('robotsEvidenceReference').trim(),
          rightsExpiresAt: expiry.toISOString(), rightsAttested: data.get('rightsAttested') === 'on', robotsAllowed: data.get('robotsAllowed') === 'on',
        },
      },
    });
    assertCurrentScope(scope);
    output.className = 'result-box'; output.textContent = result.replayed ? 'Saved job confirmed. Its durable checkpoint will be read from the workspace.' : 'Research job saved. The page will show the worker’s actual saved checkpoints and any policy or source blocks.';
    delete form.dataset.prospectingIdempotency;
    form.reset();
    $('#prospecting-permission-details').open = false;
    if (result.job?.id) { state.prospectingDetailId = result.job.id; state.prospectingPollCounts.set(result.job.id, 0); }
    await refreshAll(scope.epoch);
  } catch (error) {
    if (!error.stale && scopeIsCurrent(scope)) { output.className = 'result-box'; output.textContent = error.reconciliationRequired ? `${error.message} This form will reuse the same request key when you retry.` : error.message; }
  } finally { finishWrite(form, token); }
}
async function handleProspectingJobAction(button) {
  const scope = captureScope();
  const action = button.dataset.prospectingAction;
  stopProspectingPolling();
  state.prospectingPollCounts.set(button.dataset.jobId, 0);
  button.disabled = true;
  try {
    await request(scopedPath(`/prospecting/jobs/${encodeURIComponent(button.dataset.jobId)}/actions`, scope), {
      method: 'POST', scope, idempotencyKey: crypto.randomUUID(),
      body: { action, version: Number(button.dataset.jobVersion) },
    });
    assertCurrentScope(scope);
    await refreshProspecting(scope.epoch);
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(error.message, 'error'); }
  finally { if (scopeIsCurrent(scope)) button.disabled = false; }
}
async function refreshAll(epoch = state.epoch) {
  if (!state.workspace) return;
  const tenantId = state.workspace.id;
  for (const [target, message] of [['#evidence-list','Evidence is unavailable.'],['#customer-list','Customer records are unavailable.'],['#campaign-list','Campaigns are unavailable.'],['#inbox-list','Inbox is unavailable.'],['#mailbox-list','Mailboxes are unavailable.'],['#outcome-list','Outcomes are unavailable.'],['#funnel-list','Analytics are unavailable.'],['#crm-mapping-list','CRM mappings are unavailable.'],['#crm-outbox-list','Proposal statuses are unavailable.']]) if ($(target)) listMessage(target, 'Refreshing…');
  const results = await Promise.all([
    settled(tenantId, epoch, '/research/evidence?limit=100', 'Evidence', result => result.data || []),
    settled(tenantId, epoch, '/research/identities?limit=100', 'Businesses', result => result.data || []),
    settled(tenantId, epoch, '/research/claims?limit=100', 'Evidence notes', result => result.data || []),
    settled(tenantId, epoch, '/campaigns?limit=100', 'Campaigns', result => result.items || []),
    settled(tenantId, epoch, '/offers', 'Offers', result => result.offers || []),
    settled(tenantId, epoch, '/mailboxes', 'Mailboxes', result => result.items || []),
    settled(tenantId, epoch, '/inbox/messages?limit=100', 'Inbox', result => result.items || []),
    settled(tenantId, epoch, '/outcomes?limit=100', 'Outcomes', result => result.data || []),
    settled(tenantId, epoch, '/analytics/funnel', 'Analytics', result => result.data || result),
    settled(tenantId, epoch, '/crm/mappings', 'CRM mappings', result => result.items || []),
    settled(tenantId, epoch, '/crm/outbox?limit=100', 'CRM proposals', result => result.items || []),
    settled(tenantId, epoch, '/business-goals?limit=100', 'Saved goals', result => result.items || []),
  ]);
  if (epoch !== state.epoch) return;
  const [evidence, accounts, claims, campaigns, offers, mailboxes, inbox, outcomes, analytics, crmMappings, crmOutbox, businessGoals] = results;
  state.resourceErrors = { evidence: Boolean(evidence?.error), accounts: Boolean(accounts?.error), claims: Boolean(claims?.error), campaigns: Boolean(campaigns?.error), offers: Boolean(offers?.error), mailboxes: Boolean(mailboxes?.error), outcomes: Boolean(outcomes?.error) };
  state.dataLoaded = true; state.dataError = '';
  state.evidence = Array.isArray(evidence) ? evidence : [];
  state.accounts = Array.isArray(accounts) ? accounts : [];
  state.claims = Array.isArray(claims) ? claims : [];
  state.campaigns = Array.isArray(campaigns) ? campaigns : [];
  state.offers = Array.isArray(offers) ? offers : [];
  if (state.offers.length) {
    const versions = await Promise.all(state.offers.map(async offer => {
      try {
        const detail = await request(tenantPath(tenantId, `/offers/${encodeURIComponent(offer.id)}`), { epoch });
        const latest = (detail.offer?.versions || []).find(version => Number(version.id) === Number(offer.latest_version_id));
        return { ...offer, latest_content: latest?.content || null };
      } catch (error) { return { ...offer, detailError: error.message }; }
    }));
    if (epoch !== state.epoch) return;
    state.offers = versions;
  }
  state.mailboxes = Array.isArray(mailboxes) ? mailboxes : [];
  state.outcomes = Array.isArray(outcomes) ? outcomes : [];
  state.crmMappings = Array.isArray(crmMappings) ? crmMappings : [];
  state.crmOutbox = Array.isArray(crmOutbox) ? crmOutbox : [];
  state.businessGoals = Array.isArray(businessGoals) ? businessGoals : [];
  optionData(); accountOptionState(); renderDraftFacts(); renderDraftSupport();
  renderEvidence(); renderCustomers(); renderCampaigns(); renderInbox(inbox); renderMailboxes(); renderCrm(); renderOutcomes(outcomes); renderAnalytics(analytics);
  renderBusinessGoalList();
  if (businessGoals?.error) listMessage('#goal-saved-list', businessGoals.error, true);
  if (evidence?.error) listMessage('#evidence-list', evidence.error, true);
  if (accounts?.error) listMessage('#customer-list', accounts.error, true);
  if (claims?.error && $('#claim-result')) { $('#claim-result').className = 'result-box'; $('#claim-result').textContent = claims.error; }
  if (campaigns?.error) listMessage('#campaign-list', campaigns.error, true);
  if (mailboxes?.error) listMessage('#mailbox-list', mailboxes.error, true);
  if (crmMappings?.error) listMessage('#crm-mapping-list', crmMappings.error, true);
  if (crmOutbox?.error) listMessage('#crm-outbox-list', crmOutbox.error, true);
  settleWorkspaceLoadingResults(epoch);
  if ($('#crm-status')) $('#crm-status').textContent = crmMappings?.error || crmOutbox?.error ? 'Some local CRM records could not be loaded. Refresh to retry.' : 'Local workspace records only · no provider verification or external sync.';
  if ($('#crm-transport-state')) $('#crm-transport-state').textContent = 'External CRM transport is disabled. Proposals are saved locally and may be held by policy.';
  const selectedSourceId = $('#source-rights-form [name="sourceId"]')?.value;
  if (isAdmin() && selectedSourceId && state.evidence.some(item => item.sourceId === selectedSourceId)) loadSourceRights(selectedSourceId, { tenantId, epoch }).catch(() => {});
  else if (isAdmin()) sourceRightsBox('Choose a captured source to read its saved rights status.', 'pending');
  renderOverview({ evidence, accounts, campaigns, offers, mailboxes, inbox, outcomes, analytics });
  renderSettingsAvailability();
  state.goalResume?.();
  await refreshProspecting(epoch);
  if (!$('#view-settings').hidden) loadAiAvailability();
}
function errorsText(value) { return value?.error ? value.error : ''; }
function renderEvidence() {
  const box = $('#evidence-list'); box.replaceChildren();
  if (!state.evidence.length) { listMessage('#evidence-list', 'No page evidence yet. Use a supplied HTML export in Discover to start.'); return; }
  box.className = 'list';
  for (const evidence of state.evidence) {
    const card = itemCard(evidence.documentTitle || evidence.normalizedDomain || 'Saved page', `${evidence.sourceUrl || 'Source unavailable'} · captured ${safeDate(evidence.capturedAt)} · ${evidence.coverageStatus || 'coverage not recorded'}`, evidence.sourceContentUntrusted ? 'Untrusted source text' : evidence.coverageStatus || 'Saved');
    card.dataset.evidenceId = evidence.id;
    card.append(text('p', 'source-line', `${Number(evidence.byteLength || 0).toLocaleString()} bytes · source identity retained with the capture`));
    box.append(card);
  }
}
function renderCustomers() {
  const box = $('#customer-list'); box.replaceChildren();
  if (!state.accounts.length) { box.className = 'customer-grid list empty'; box.textContent = 'No businesses are in this workspace yet. Add a page export from Discover to create the first evidence-backed account.'; return; }
  box.className = 'customer-grid list';
  for (const account of state.accounts) {
    const card = itemCard(account.displayDomain || account.normalizedDomain, `${account.evidenceCount || 0} captured page(s) · ${account.candidateCount || 0} contact candidate(s)`);
    card.dataset.accountId = String(account.id || ''); card.tabIndex = -1;
    const button = text('button', 'button subtle', 'Audit saved pages'); button.type = 'button'; button.dataset.auditAccount = account.id;
    card.append(button);
    if (Number(account.candidateCount) > 0) card.append(text('span', 'tag unknown', 'Address candidates are unverified'));
    box.append(card);
  }
  if ($('#crm-status')) $('#crm-status').textContent = 'Local workspace records only · no provider verification or external sync.';
}
function renderCrm() {
  const mappings = $('#crm-mapping-list');
  if (mappings) {
    mappings.replaceChildren();
    if (!state.crmMappings.length) listMessage('#crm-mapping-list', 'No manual CRM identity mappings are saved in this workspace.');
    else {
      mappings.className = 'list';
      for (const mapping of state.crmMappings) {
        const account = state.accounts.find(row => row.id === mapping.entityId);
        const card = itemCard(`${account?.displayDomain || account?.normalizedDomain || mapping.entityType} · ${mapping.externalId}`, `External ID entered manually · ${mapping.provider || 'local mapping'} · ${safeDate(mapping.updatedAt || mapping.createdAt)}`, 'Manual · unverified');
        mappings.append(card);
      }
    }
  }
  const proposals = $('#crm-outbox-list');
  if (proposals) {
    proposals.replaceChildren();
    if (!state.crmOutbox.length) listMessage('#crm-outbox-list', 'No company proposals are saved yet.');
    else {
      proposals.className = 'list';
      for (const proposal of state.crmOutbox) {
        const account = state.accounts.find(row => row.id === proposal.entityId);
        const company = proposal.payload?.name || proposal.entityId || 'Company';
        proposals.append(itemCard(`${company} · ${proposal.state || 'status unavailable'}`, `${account?.displayDomain || account?.normalizedDomain || 'Workspace record'} · ${proposal.operation || 'proposal'} · ${safeDate(proposal.createdAt)} · external transport disabled`, proposal.state || 'Unknown'));
      }
    }
  }
}
function renderCampaigns() {
  const box = $('#campaign-list'); box.replaceChildren();
  if (!state.campaigns.length) { listMessage('#campaign-list', 'No campaigns saved. Create a campaign draft after adding an approved offer and mailbox.'); return; }
  box.className = 'list';
  for (const campaign of state.campaigns) {
    const card = itemCard(campaign.name, `${campaign.state} · ${campaign.purpose || 'Purpose not set'} · updated ${safeDate(campaign.updatedAt || campaign.createdAt)}`, campaign.state);
    const button = text('button', 'button subtle', 'View details'); button.type = 'button'; button.dataset.selectCampaign = campaign.id;
    card.append(button); box.append(card);
  }
}
function renderInbox(result) {
  const box = $('#inbox-list'); box.replaceChildren();
  if (result?.error) { listMessage('#inbox-list', result.error, true); return; }
  if (!result.length) { listMessage('#inbox-list', 'No messages have been imported to this workspace. No mailbox sync runs here.'); return; }
  box.className = 'list';
  for (const message of result) {
    const card = text('article', 'message-card');
    const head = document.createElement('header'); head.append(text('h4', '', message.subject || '(no subject)'), text('time', '', safeDate(message.receivedAt)));
    card.append(head, text('p', 'sender', `From ${message.sender || 'unknown sender'} · ${Array.isArray(message.recipients) ? message.recipients.join(', ') : ''}`), text('div', 'body', message.bodyText || 'No message text.'));
    box.append(card);
  }
}
function renderMailboxes() {
  const box = $('#mailbox-list'); box.replaceChildren();
  if (!state.mailboxes.length) { listMessage('#mailbox-list', 'No mailboxes are connected. Outbound sending is disabled.'); return; }
  box.className = 'list';
  for (const mailbox of state.mailboxes) box.append(itemCard(mailbox.displayName, `${mailbox.provider || 'unknown provider'} · receive ${mailbox.capabilities?.receive || 'unknown'} · send ${mailbox.capabilities?.send || 'disabled'}`, mailbox.configurationStatus || 'unknown'));
}
function renderOutcomes(result) {
  const box = $('#outcome-list'); box.replaceChildren();
  if (result?.error) { listMessage('#outcome-list', result.error, true); return; }
  if (!result.length) { listMessage('#outcome-list', 'No outcome records have been saved.'); return; }
  box.className = 'list';
  for (const row of result) {
    const milestones = row.state?.milestones || [];
    box.append(itemCard(`${row.entityType || 'Record'} · ${milestones.length ? milestones.length + ' milestone(s)' : 'saved record'}`, milestones.slice(-3).map(item => `${item.stage} · ${safeDate(item.occurredAt)}`).join('  /  ') || 'No milestone details', row.state?.latestStage || 'Saved'));
  }
}
function renderAnalytics(result) {
  const box = $('#funnel-list'); box.replaceChildren();
  if (result?.error) { box.className = 'funnel-list empty'; box.textContent = result.error; $('#analytics-basis').textContent = 'Analytics could not be loaded.'; return; }
  const funnel = result?.funnel || {};
  const rows = Object.entries(funnel);
  if (!rows.length) { box.className = 'funnel-list empty'; box.textContent = 'No observed outcome events yet. The chart will use saved events as its source.'; }
  else {
    box.className = 'funnel-list';
    const maximum = Math.max(1, ...rows.map(([, count]) => Number(count) || 0));
    for (const [stage, count] of rows) {
      const row = text('div', 'funnel-row'); row.append(text('span', '', stage.replaceAll('.', ' ')));
      const bar = text('span', 'funnel-bar'); const fill = document.createElement('span'); fill.style.width = `${Math.round((Number(count) || 0) / maximum * 100)}%`; bar.append(fill);
      row.append(bar, text('strong', '', Number(count) || 0)); box.append(row);
    }
  }
  $('#analytics-basis').textContent = `Basis: ${String(result?.basis || 'saved workspace outcomes').replaceAll('_', ' ')}. ${result?.attribution || 'No attribution or causal lift is calculated.'}`;
}
function renderFirstSuccessGuide() {
  const list = $('#first-success-steps');
  const summary = $('#first-success-summary');
  const badge = $('#first-success-progress');
  const next = $('#first-success-next');
  if (!list || !summary || !badge || !next) return;
  list.replaceChildren(); next.replaceChildren();
  if (!state.workspace) {
    summary.textContent = 'Choose or create a workspace to see saved progress.';
    badge.textContent = 'No workspace';
    list.hidden = true;
    next.textContent = 'Your workspace records will appear here after you select a workspace.';
    return;
  }
  if (state.dataError) {
    summary.textContent = 'Workspace access could not be verified. Progress is unavailable.';
    badge.textContent = 'Unavailable';
    list.hidden = true;
    next.textContent = 'Check workspace access, then refresh to try again.';
    return;
  }
  if (!state.dataLoaded) {
    summary.textContent = 'Loading saved progress for this workspace…';
    badge.textContent = 'Checking records';
    list.hidden = true;
    next.textContent = 'This guide uses saved workspace records and will update when they load.';
    return;
  }
  list.hidden = false;
  const approvedOffers = state.offers.filter(offer => offer.latest_status === 'approved' && offer.latest_version_id);
  const manualMailboxes = state.mailboxes.filter(mailbox => mailbox.provider === 'manual');
  const supportedClaims = state.claims.filter(claim => claim.status === 'supported' && claim.latestCorrection !== 'retracted');
  const draftCampaigns = state.campaigns.filter(campaign => campaign.state === 'draft');
  const pageAndBusinessError = state.resourceErrors.evidence || state.resourceErrors.accounts;
  const steps = [
    {
      title: 'Page + business',
      unavailable: pageAndBusinessError,
      complete: !pageAndBusinessError && state.evidence.length > 0 && state.accounts.length > 0,
      detail: pageAndBusinessError ? 'Page or business records could not be loaded.' : state.evidence.length && state.accounts.length ? `${state.evidence.length} page${state.evidence.length === 1 ? '' : 's'} · ${state.accounts.length} business${state.accounts.length === 1 ? '' : 'es'} saved` : [!state.evidence.length ? 'No page saved' : '', !state.accounts.length ? 'No business saved' : ''].filter(Boolean).join(' · '),
    },
    {
      title: 'Supported fact',
      unavailable: state.resourceErrors.claims,
      complete: !state.resourceErrors.claims && supportedClaims.length > 0,
      detail: state.resourceErrors.claims ? 'Page facts could not be loaded.' : `${supportedClaims.length} supported fact${supportedClaims.length === 1 ? '' : 's'} saved`,
    },
    {
      title: 'Offer + inbox',
      unavailable: state.resourceErrors.offers || state.resourceErrors.mailboxes,
      complete: !state.resourceErrors.offers && !state.resourceErrors.mailboxes && approvedOffers.length > 0 && manualMailboxes.length > 0,
      detail: state.resourceErrors.offers || state.resourceErrors.mailboxes ? 'Offer or inbox records could not be loaded.' : `${approvedOffers.length} approved offer${approvedOffers.length === 1 ? '' : 's'} · ${manualMailboxes.length} manual inbox${manualMailboxes.length === 1 ? '' : 'es'}`,
    },
    {
      title: 'Campaign draft',
      unavailable: state.resourceErrors.campaigns,
      complete: !state.resourceErrors.campaigns && draftCampaigns.length > 0,
      detail: state.resourceErrors.campaigns ? 'Campaign records could not be loaded.' : `${draftCampaigns.length} draft${draftCampaigns.length === 1 ? '' : 's'} saved`,
    },
    {
      title: 'Observed outcome',
      unavailable: state.resourceErrors.outcomes,
      complete: !state.resourceErrors.outcomes && state.outcomes.length > 0,
      detail: state.resourceErrors.outcomes ? 'Outcome records could not be loaded.' : `${state.outcomes.length} real milestone${state.outcomes.length === 1 ? '' : 's'} recorded`,
    },
  ];
  const completedCount = steps.filter(step => step.complete).length;
  summary.textContent = 'As you work, save research, prepare a draft, and record observed results. Sending requires separate authorization.';
  badge.textContent = `${completedCount} of ${steps.length} saved`;
  steps.forEach((step, index) => {
    const row = text('li', '', '');
    row.dataset.state = step.unavailable ? 'unavailable' : step.complete ? 'complete' : 'pending';
    row.append(text('span', 'first-success-step-title', `${String(index + 1).padStart(2, '0')} · ${step.title}`));
    row.append(text('span', 'first-success-step-status', step.unavailable ? 'Status unavailable' : step.complete ? `Saved · ${step.detail}` : step.detail));
    list.append(row);
  });
  const nextIndex = steps.findIndex(step => !step.complete);
  if (nextIndex < 0) {
    next.append(text('p', '', 'An observed outcome is saved. Continue recording real milestones as they happen. A campaign draft does not send messages.'));
    return;
  }
  const step = steps[nextIndex];
  if (step.unavailable) {
    next.append(text('p', '', 'Some workspace records could not be read, so the next step is uncertain. Refresh the workspace data to try again.'));
    const refresh = text('button', 'button subtle', 'Refresh workspace data'); refresh.type = 'button'; refresh.dataset.journeyRefresh = 'true'; next.append(refresh);
    return;
  }
  let action = null;
  if (nextIndex === 0 && isWriter()) action = { label: 'Analyze a page', view: 'discover', form: 'snapshot-form', description: 'Save an HTML page you are allowed to use; it creates the first evidence-backed business.' };
  else if (nextIndex === 1 && isWriter()) action = { label: 'Save a supported fact', view: 'discover', form: 'claim-form', description: 'Choose a saved page and copy a literal value with its exact supporting excerpt.' };
  else if (nextIndex === 2 && !approvedOffers.length && isAdmin()) action = { label: 'Create an offer with proof', view: 'campaigns', form: 'offer-form', description: 'Save and approve an offer with proof before building a campaign.' };
  else if (nextIndex === 2 && approvedOffers.length && !manualMailboxes.length && isWriter()) action = { label: 'Set up a manual inbox', view: 'inbox', form: 'mailbox-form', description: 'Create a local inbox for later manual message imports; syncing and sending stay disabled.' };
  else if (nextIndex === 3 && isWriter()) action = { label: 'Create a campaign draft', view: 'campaigns', form: 'campaign-form', description: 'Prepare an offline draft from an approved offer and workspace mailbox.' };
  else if (nextIndex === 4 && isWriter()) action = { label: 'Log an observed outcome', view: 'analytics', form: 'outcome-form', description: 'Record a real meeting, opportunity, or revenue milestone for a saved business.' };
  const accessNeeded = nextIndex === 2 && !approvedOffers.length ? 'A workspace owner or admin needs to approve an offer with proof next.' : 'A workspace member with editing access needs to complete this step next.';
  const copy = text('p', '', '');
  copy.append(text('strong', '', action ? `Next: ${step.title}. ` : `Next: ${step.title}. `));
  copy.append(document.createTextNode(action ? action.description : accessNeeded));
  next.append(copy);
  if (action) {
    const button = text('button', 'button primary', action.label); button.type = 'button'; button.dataset.go = action.view; button.dataset.openTask = action.form; next.append(button);
  }
}
function renderOverview(results) {
  $('#metric-evidence').textContent = Array.isArray(results.evidence) ? countValue(results.evidence) : '—';
  $('#metric-accounts').textContent = Array.isArray(results.accounts) ? countValue(results.accounts) : '—';
  $('#metric-campaigns').textContent = Array.isArray(results.campaigns) ? countValue(results.campaigns) : '—';
  $('#metric-outcomes').textContent = Array.isArray(results.outcomes) ? countValue(results.outcomes) : '—';
  const box = $('#overview-attention'); box.replaceChildren(); box.className = 'list';
  const notices = [];
  if (!Array.isArray(results.evidence)) notices.push(results.evidence.error);
  else if (!results.evidence.length) notices.push('Add a supplied page export to start an evidence-backed account.');
  if (!Array.isArray(results.campaigns)) notices.push(results.campaigns.error);
  else if (!results.campaigns.length) notices.push('No campaign drafts saved yet.');
  if (results.offers?.error) notices.push(results.offers.error);
  if (results.mailboxes?.error) notices.push(results.mailboxes.error);
  if (!Array.isArray(results.inbox)) notices.push(results.inbox.error);
  else if (!results.inbox.length) notices.push('No imported inbox messages yet.');
  if (!notices.length) notices.push('Your latest workspace reads are available below.');
  for (const note of notices.slice(0, 4)) box.append(itemCard(note));
  if (results.analytics?.error) box.append(itemCard(`Analytics unavailable: ${results.analytics.error}`));
  renderFirstSuccessGuide();
}
function focusReportResult(container, scope) {
  if (!container) return;
  container.tabIndex = -1;
  requestAnimationFrame(() => {
    if ((scope && !scopeIsCurrent(scope)) || $('#view-discover')?.hidden) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
    container.focus({ preventScroll: true });
  });
}
function reportFindingText(finding) {
  const signal = String(finding.signal || 'Finding').replaceAll('_', ' ');
  const outcome = String(finding.outcome || 'unknown').replaceAll('_', ' ');
  return `${signal}: ${outcome}${finding.detail ? ` — ${finding.detail}` : ''}`;
}
function appendFindingList(parent, findings, label) {
  const list = document.createElement('ul');
  list.setAttribute('aria-label', label);
  for (const finding of findings) list.append(text('li', '', reportFindingText(finding)));
  parent.append(list);
}
function sourceRightsNote(page) {
  const status = String(page.sourceRightsStatus || page.effectiveRightsStatus || page.rightsStatus || '').toLowerCase();
  const expiry = page.rightsExpiresAt ? new Date(page.rightsExpiresAt) : null;
  const expiredByDate = expiry && Number.isFinite(expiry.valueOf()) && expiry.valueOf() <= Date.now();
  if (status.includes('revok') || page.rightsRevokedAt) {
    return { text: `Source use revoked${page.rightsRevokedAt ? ` · recorded ${safeDate(page.rightsRevokedAt)}` : ''}.`, warning: true };
  }
  if (status.includes('expir') || expiredByDate) {
    return { text: `Source review expired${expiry && Number.isFinite(expiry.valueOf()) ? ` · ${safeDate(page.rightsExpiresAt)}` : ''}.`, warning: true };
  }
  if (status && status !== 'unavailable') return { text: `Source-use status · ${status.replaceAll('_', ' ')}${page.rightsExpiresAt ? ` through ${safeDate(page.rightsExpiresAt)}` : ''}.`, warning: false };
  if (page.rightsExpiresAt) return { text: `Source review date · ${safeDate(page.rightsExpiresAt)}.`, warning: false };
  return null;
}
function reportSourceUrlKey(sourceUrl) {
  const value = String(sourceUrl || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch { return value; }
}
function renderReportSource(container, page) {
  const source = text('div', 'report-source');
  source.append(text('strong', 'report-source-title', page.documentTitle || page.title || 'Captured page'));
  if (page.sourceUrl || page.url) source.append(text('span', 'report-source-url', page.sourceUrl || page.url));
  const capturedAt = page.capturedAt || page.fetchedAt || page.lastFetchedAt;
  source.append(text('span', 'report-source-date', capturedAt ? `Captured ${safeDate(capturedAt)}` : 'Capture date not recorded'));
  const rightsNote = sourceRightsNote(page);
  if (rightsNote && !rightsNote.warning) source.append(text('span', 'report-source-rights', rightsNote.text));
  container.append(source);
}
function revealReport(result, container, scope = null) {
  container.replaceChildren(); container.className = 'result-box report-result';
  const audit = result?.data || result;
  const coverage = String(audit.coverageStatus || 'coverage unknown').replaceAll('_', ' ');
  container.append(text('h4', 'report-heading', `Evidence report · ${coverage}`));
  if (result?.account?.displayDomain) container.append(text('p', 'source-line report-business', result.account.displayDomain));
  const coveragePages = Array.isArray(audit.sourceCoverage?.pages) ? audit.sourceCoverage.pages : [];
  const sources = [...coveragePages, result?.evidence, ...(Array.isArray(result?.evidenceSources) ? result.evidenceSources : [])]
    .filter(source => source && typeof source === 'object');
  const pages = [];
  for (const source of sources) {
    const sourceUrl = source.sourceUrl || source.url || '';
    const sourceUrlKey = reportSourceUrlKey(sourceUrl);
    const existing = pages.find(page => (source.id && page.id === source.id) || (sourceUrlKey && reportSourceUrlKey(page.sourceUrl || page.url) === sourceUrlKey));
    if (existing) Object.assign(existing, source);
    else pages.push({ ...source, sourceUrl });
  }
  if (pages.length) {
    const capturedCount = Number.isFinite(audit.sourceCoverage?.captured_page_count) ? audit.sourceCoverage.captured_page_count : (coveragePages.length || pages.length);
    container.append(text('h4', 'report-section-heading', `Source coverage · ${capturedCount} ${capturedCount === 1 ? 'page' : 'pages'} captured`));
    renderReportSource(container, pages[0]);
    const warnings = pages.map(page => ({ page, note: sourceRightsNote(page) })).filter(item => item.note?.warning);
    for (const item of warnings) container.append(text('p', 'report-source-warning', `${item.page.documentTitle || item.page.title || item.page.sourceUrl || 'Source page'} · ${item.note.text}`));
    if (pages.length > 1) {
      const details = document.createElement('details'); details.className = 'report-disclosure';
      details.append(text('summary', '', `View all ${pages.length} captured pages`));
      const extraSources = text('div', 'report-source-list');
      for (const page of pages.slice(1)) renderReportSource(extraSources, page);
      details.append(extraSources); container.append(details);
    }
  } else if (audit.sourceUrl) {
    container.append(text('h4', 'report-section-heading', 'Source page'), text('p', 'report-source-url', audit.sourceUrl));
  }

  const findings = Array.isArray(audit.findings) ? audit.findings : [];
  const observed = findings.filter(finding => String(finding.outcome || '').toLowerCase() === 'observed');
  const otherFindings = findings.filter(finding => String(finding.outcome || '').toLowerCase() !== 'observed');
  container.append(text('h4', 'report-section-heading', `What the page showed · ${observed.length}`));
  if (observed.length) {
    const visible = observed.slice(0, 4);
    appendFindingList(container, visible, 'Observed findings');
    if (observed.length > visible.length) {
      const details = document.createElement('details'); details.className = 'report-disclosure';
      details.append(text('summary', '', `Show ${observed.length - visible.length} more observed findings`));
      appendFindingList(details, observed.slice(visible.length), 'More observed findings'); container.append(details);
    }
  } else container.append(text('p', 'quiet report-empty-state', 'No findings were marked observed in this capture.'));
  if (otherFindings.length) {
    container.append(text('p', 'quiet report-unknown-note', 'Unknown means not observed in this captured material; it does not mean the business lacks these features.'));
    const visibleUnknown = otherFindings.slice(0, 1);
    appendFindingList(container, visibleUnknown, 'Findings not established in this capture');
    if (otherFindings.length > visibleUnknown.length) {
      const details = document.createElement('details'); details.className = 'report-disclosure';
      details.append(text('summary', '', `Show ${otherFindings.length - visibleUnknown.length} more items not established in this capture`));
      appendFindingList(details, otherFindings.slice(visibleUnknown.length), 'More findings not established in this capture'); container.append(details);
    }
  }
  const opportunities = Array.isArray(audit.opportunities) ? audit.opportunities : [];
  if (opportunities.length) {
    container.append(text('h4', 'report-section-heading', `Review opportunities · ${opportunities.length}`));
    const renderOpportunities = rows => {
      const list = document.createElement('ul'); list.setAttribute('aria-label', 'Review opportunities');
      for (const opportunity of rows) list.append(text('li', '', `${opportunity.title || 'Review opportunity'}${opportunity.reason ? ` — ${opportunity.reason}` : ''}`));
      return list;
    };
    const visible = opportunities.slice(0, 2);
    container.append(renderOpportunities(visible));
    if (opportunities.length > visible.length) {
      const details = document.createElement('details'); details.className = 'report-disclosure report-opportunities';
      details.append(text('summary', '', `Show ${opportunities.length - visible.length} more review opportunities`));
      details.append(renderOpportunities(opportunities.slice(visible.length))); container.append(details);
    }
  }
  container.append(text('p', 'report-caveat', 'This report covers captured source material only. Unknown means not observed in this capture; it does not establish site-wide absence or financial impact.'));
  if (result?.singlePageFallback) container.append(text('p', 'quiet', 'The account-level report service is unavailable. This is the existing single-page evidence report, clearly scoped to the saved page above.'));
  focusReportResult(container, scope);
}
async function createAudit(accountId, resultTarget, scope = captureScope()) {
  assertCurrentScope(scope);
  const account = state.accounts.find(item => item.id === accountId);
  if (!account) throw new Error('This business is no longer available in the selected workspace. Refresh and try again.');
  let result;
  const evidenceSources = state.evidence.filter(item => item.normalizedDomain === account.normalizedDomain);
  result = await request(scopedPath('/research/audits', scope), { method: 'POST', body: { accountId }, scope });
  assertCurrentScope(scope);
  const audit = result?.data;
  if (!audit || typeof audit !== 'object' || !Array.isArray(audit.findings)) throw new Error('The report service returned an invalid account audit. Refresh and try again.');
  const report = { ...audit, account, evidenceSources };
  if (resultTarget) revealReport(report, $(resultTarget), scope);
  return report;
}
function renderCollectionJob(job, container, { execution = '' } = {}) {
  container.replaceChildren(); container.className = 'result-box';
  const status = String(job?.status || 'unknown');
  container.append(text('h4', '', `Search request ${status}`));
  if (job?.blockedReason) container.append(text('p', 'source-line', `Blocked reason: ${job.blockedReason}`));
  if (job?.errorCode) container.append(text('p', 'source-line', `Service error: ${job.errorCode}`));
  if (execution) container.append(text('p', 'source-line', `Execution: ${execution}`));
  const candidates = Array.isArray(job?.candidates) ? job.candidates : [];
  if (candidates.length) {
    container.append(text('p', 'quiet', `${candidates.length} candidate business result(s) returned by the source service. These are unverified leads; they do not establish identity, contact permission, or address validity.`));
    const list = document.createElement('ul'); list.setAttribute('aria-label', 'Returned business candidates');
    for (const candidate of candidates) {
      const title = candidate.title || candidate.canonicalDomain || 'Candidate business';
      const details = [candidate.canonicalDomain, candidate.sourceUrl, candidate.snippet].filter(Boolean).join(' · ');
      const item = text('li', '', title); if (details) item.append(text('p', 'source-line', details));
      item.append(text('span', 'tag unknown', 'Candidate only · unverified')); list.append(item);
    }
    container.append(list);
  } else if (['queued', 'running'].includes(status)) {
    container.append(text('p', 'quiet', 'No results are available yet. The request is still in progress; check its status again when the source service has finished.'));
  } else if (status === 'blocked') {
    container.append(text('p', 'quiet', 'No businesses were added because this request is blocked by current source policy.'));
  } else if (status === 'completed') {
    container.append(text('p', 'quiet', 'The source service completed this request without returning business candidates.'));
  } else if (status === 'failed') {
    container.append(text('p', 'quiet', 'The source request failed. No candidate results are available.'));
  } else {
    container.append(text('p', 'quiet', 'The source service returned no business candidates for this request state.'));
  }
  if (job?.id && ['queued', 'running'].includes(status)) {
    const button = text('button', 'button subtle compact-top', 'Check request status'); button.type = 'button'; button.dataset.refreshCollectionJob = job.id; container.append(button);
  }
}
async function loadCollectionJob(jobId, scope = captureScope(), container = $('#search-result')) {
  assertCurrentScope(scope);
  if (!UUID_PATTERN.test(jobId)) throw new Error('The collection service returned an invalid job reference.');
  const result = await request(scopedPath(`/collection/jobs/${encodeURIComponent(jobId)}`, scope), { scope });
  assertCurrentScope(scope);
  if (!result?.job || typeof result.job !== 'object') throw new Error('The collection service returned an invalid job status.');
  renderCollectionJob(result.job, container);
  return result.job;
}
async function handleSearch(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Checking policy…');
  const out = $('#search-result'); out.className = 'result-box'; out.textContent = 'Submitting a real workspace search request…';
  try {
    const data = new FormData(form);
    const expiry = new Date(`${data.get('rightsExpiresAt')}T23:59:59.000Z`);
    if (!Number.isFinite(expiry.valueOf()) || expiry.valueOf() <= Date.now()) throw new Error('Choose a future date through which you are allowed to use this source.');
    assertCurrentScope(scope);
    const result = await request(scopedPath('/collection/search', scope), { method: 'POST', scope, body: { category: data.get('category').trim(), country: data.get('country').trim(), city: data.get('city').trim(), approvalMode: 'server', sourceRights: { rightsPolicy: 'public_terms_permitted', rightsAttested: data.get('rightsAttested') === 'on', rightsEvidenceReference: data.get('rightsReference').trim(), robotsAllowed: data.get('robotsAllowed') === 'on', robotsEvidenceReference: data.get('robotsReference').trim(), rightsReviewedAt: new Date().toISOString(), rightsExpiresAt: expiry.toISOString() } } });
    assertCurrentScope(scope);
    const job = result.job || {};
    if (!job.id) renderCollectionJob(job, out, { execution: result.execution || '' });
    else {
      try { await loadCollectionJob(job.id, scope, out); }
      catch (error) {
        if (error.stale) throw error;
        assertCurrentScope(scope); renderCollectionJob({ ...job, detailError: error.message }, out, { execution: result.execution || '' });
        out.append(text('p', 'quiet', `Latest job details could not be loaded. ${error.message}`));
      }
    }
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) { out.className = 'result-box'; out.replaceChildren(text('h4', '', 'Search unavailable'), text('p', '', error.message)); } }
  finally { finishWrite(form, token); }
}
async function handleSnapshot(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Saving evidence…');
  const out = $('#snapshot-result'); out.className = 'result-box'; out.textContent = 'Reading and saving the page export…';
  try {
    const data = new FormData(form); const file = data.get('htmlFile');
    if (!(file instanceof File) || !file.size) throw new Error('Choose a non-empty HTML export.');
    if (file.size > 1024 * 1024) throw new Error('This HTML export is larger than 1 MB. Choose a smaller file.');
    const html = await file.text();
    assertCurrentScope(scope);
    const saved = await request(scopedPath('/research/snapshots', scope), { method: 'POST', scope, body: { sourceUrl: data.get('sourceUrl').trim(), rightsPolicy: data.get('rightsPolicy'), rightsAttested: data.get('rightsAttested') === 'on', robotsAllowed: data.get('robotsAllowed') === 'on', html, mediaType: 'text/html; charset=utf-8' } });
    assertCurrentScope(scope);
    const snapshot = saved?.data;
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.evidence?.id || !snapshot.account?.id) throw new Error('The page was saved but its evidence/account details were not returned. Refresh evidence before creating a report.');
    const evidence = snapshot.evidence; const account = snapshot.account;
    state.accounts = [...state.accounts.filter(item => item.id !== account.id), { ...account, evidenceCount: 1, candidateCount: Array.isArray(snapshot.candidates) ? snapshot.candidates.length : 0 }];
    await refreshAll(scope.epoch);
    assertCurrentScope(scope);
    const auditResponse = await request(scopedPath('/research/audits', scope), { method: 'POST', scope, body: { accountId: account.id } });
    assertCurrentScope(scope);
    const audit = auditResponse?.data;
    if (!audit || typeof audit !== 'object' || !Array.isArray(audit.findings)) throw new Error('The report service returned an invalid account audit.');
    revealReport({ ...audit, account, evidence, evidenceSources: [evidence] }, out, scope);
    form.reset(); setNotice('Page saved with its source. The report reflects only captured page evidence.', 'success');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) { out.className = 'result-box'; out.replaceChildren(text('h4', '', 'Could not save or report this page'), text('p', '', error.message)); setNotice(error.message, 'error'); } }
  finally { finishWrite(form, token); }
}
async function handleClaim(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Checking excerpt…');
  try {
    const f = form.elements, evidence = state.evidence.find(item => item.id === f.evidenceId.value);
    if (!evidence) throw new Error('Choose a saved page from this workspace.');
    assertCurrentScope(scope);
    const result = await request(scopedPath('/research/claims', scope), { method: 'POST', scope, body: { evidenceId: evidence.id, contentSha256: evidence.contentSha256, subjectKey: evidence.normalizedDomain, predicate: f.predicate.value, value: f.value.value.trim(), exactExcerpt: f.exactExcerpt.value.trim(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } });
    assertCurrentScope(scope);
    const claim = result.data || {};
    $('#claim-result').className = 'result-box';
    $('#claim-result').replaceChildren(text('h4', '', claim.status === 'supported' ? 'Supported literal fact saved' : 'Fact saved for review'), text('p', '', `${claim.predicate || f.predicate.value}: ${claim.value || f.value.value} · ${claim.status || 'unknown'}${claim.abstainReason ? ` · ${claim.abstainReason.replaceAll('_', ' ')}` : ''}`));
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope); setNotice(claim.status === 'supported' ? 'The page excerpt supports this literal value.' : 'This fact was saved as unverified because its proof did not meet the service checks.', claim.status === 'supported' ? 'success' : 'info');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) { $('#claim-result').className = 'result-box'; $('#claim-result').textContent = error.message; setNotice(error.message, 'error'); } }
  finally { finishWrite(form, token); }
}
function fillOfferContent(form, proofFile) {
  const get = name => form.elements[name].value.trim();
  const now = new Date(); const expires = new Date(now.valueOf() + 180 * 86400000);
  const countryCodes = get('includedCountries').toUpperCase().split(/[\s,]+/).filter(Boolean);
  const amountMinor = value => Math.round(Number(value) * 100);
  return { name: get('name'), content: { service: get('service'), scope: get('scope'), price: { minMinor: amountMinor(get('minPrice')), maxMinor: amountMinor(get('maxPrice')), currency: get('currency').toUpperCase() }, proofAssets: [{ proofId: 'customer-proof', reference: `${proofFile.name} · customer supplied`, contentHash: '', observedAt: now.toISOString(), expiresAt: expires.toISOString(), rightsBasis: get('rightsBasis') }], audienceExclusions: get('exclusions').split('\n').map(item => item.trim()).filter(Boolean), geography: { includedCountries: countryCodes, excludedCountries: [] }, capacity: Number(get('capacity')), egress: { mode: 'NO_MODEL_EGRESS', allowedDestinations: [] } } };
}
async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function handleOffer(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Saving offer…');
  try {
    const file = form.elements.proofFile.files[0];
    if (!file || file.size > 10 * 1024 * 1024) throw new Error('Choose an offer proof file of 10 MB or less.');
    if (!isAdmin()) throw new Error('Only workspace owners and admins can create or approve offers.');
    const body = fillOfferContent(form, file); body.content.proofAssets[0].contentHash = await sha256Hex(file);
    assertCurrentScope(scope);
    const created = await request(scopedPath('/offers', scope), { method: 'POST', scope, body });
    assertCurrentScope(scope);
    const offerId = created.offer?.id, versionId = created.offer?.version?.id;
    if (!offerId || !versionId) throw new Error('The offer was created but its saved version was not returned. Refresh offers before continuing.');
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    assertCurrentScope(scope);
    await request(scopedPath(`/offers/${encodeURIComponent(offerId)}/versions/${encodeURIComponent(versionId)}/proofs`, scope), { method: 'POST', scope, body: { proofId: 'customer-proof', bytesBase64: btoa(binary), mimeType: file.type || 'application/octet-stream', expiresAt: body.content.proofAssets[0].expiresAt, contentHash: body.content.proofAssets[0].contentHash } });
    assertCurrentScope(scope);
    const approval = await request(scopedPath(`/offers/${encodeURIComponent(offerId)}/versions/${encodeURIComponent(versionId)}/approve`, scope), { method: 'POST', scope, body: {} });
    assertCurrentScope(scope);
    $('#offer-result').replaceChildren(text('h4', '', `Offer ${approval.version?.status || 'saved'}`), text('p', '', `${body.name} · version ${approval.version?.version || 'saved'} · proof attached and rights approved.`));
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope); setNotice('Offer, proof, and approval were saved. Campaign setup is still separate.', 'success');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) { $('#offer-result').className = 'result-box'; $('#offer-result').replaceChildren(text('h4', '', 'Offer setup needs attention'), text('p', '', error.message)); setNotice(error.message, 'error'); } }
  finally { finishWrite(form, token); }
}
async function handleCampaignCreate(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Creating draft…');
  try {
    const f = form.elements; const offer = state.offers.find(item => String(item.latest_version_id) === f.offerVersionId.value);
    if (!offer) throw new Error('Choose an approved offer from this workspace.');
    const currency = offer.latest_content?.price?.currency || (await request(scopedPath(`/offers/${encodeURIComponent(offer.id)}`, scope), { scope })).offer?.versions?.[0]?.content?.price?.currency;
    assertCurrentScope(scope);
    if (!currency) throw new Error('The approved offer currency could not be loaded. Refresh offers and try again.');
    const geography = f.geography.value.toUpperCase().split(/[\s,]+/).filter(Boolean);
    const result = await request(scopedPath('/campaigns', scope), { method: 'POST', scope, body: { name: f.name.value.trim(), offerVersionId: Number(f.offerVersionId.value), mailboxId: f.mailboxId.value, purpose: f.purpose.value.trim(), geography, spendLimitMinor: Math.round(Number(f.spendLimit.value) * 100), currency } });
    assertCurrentScope(scope);
    if (!result.campaign?.id) throw new Error('The campaign was not returned by the service.');
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope); $('#campaign-select').value = result.campaign.id; await loadCampaign(result.campaign.id, scope); assertCurrentScope(scope);
    if (state.prospectingCampaignAccountId) { const qualificationForm = $('#qualification-form'); qualificationForm.elements.campaignId.value = result.campaign.id; qualificationForm.elements.accountId.value = state.prospectingCampaignAccountId; qualificationForm.closest('details').open = true; qualificationForm.scrollIntoView({block: 'center'}); setNotice('Campaign draft saved for the selected prospect. Review its evidence qualification next. No approval or message was created.', 'success'); } else setNotice('Campaign draft saved. No audience was qualified and no message was sent.', 'success');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(error.message, 'error'); }
  finally { finishWrite(form, token); }
}
async function handleDraft(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Saving draft…');
  const campaignId = $('#campaign-select').value, generation = state.composerGeneration;
  try {
    if (!campaignId) throw new Error('Choose a campaign first.');
    const subject = form.elements.subject.value.trim(), body = form.elements.body.value.trim();
    if (!isWriter()) throw new Error('Your workspace role cannot save campaign copy.');
    if (!state.composer || state.composer.campaignId !== campaignId) throw new Error('Load the current campaign templates before saving.');
    if (!subject || !body) throw new Error('Enter both a subject and body before saving.');
    const claimsMap = exactTemplateMappings(subject, body, state.composer.templates);
    const saved = await request(scopedPath(`/campaigns/${encodeURIComponent(campaignId)}/draft`, scope), { method: 'PUT', scope, body: { expectedVersion: state.composer.version, subject, body, claimsMap } });
    assertCurrentScope(scope);
    if (!isCampaignLoadCurrent(scope, { tenantId: state.workspace?.id, epoch: state.epoch }, $('#campaign-select').value, campaignId) || state.composerGeneration !== generation) return;
    clearCampaignReview('The saved copy changed. Load the review again to inspect the current persisted version.');
    const editsRemain = form.elements.subject.value.trim() !== subject || form.elements.body.value.trim() !== body;
    form.dataset.dirty = editsRemain ? 'true' : 'false';
    $('#campaign-select').value = campaignId;
    await loadCampaign(campaignId, scope, { hydrateDraft: !editsRemain }); assertCurrentScope(scope); setNotice(`Draft saved as version ${saved.draft?.copyVersion || saved.draft?.version || 'updated'}. ${saved.validation?.status === 'verified' ? 'The service verified the submitted copy.' : 'The service marked the submitted copy unverified; approval remains unavailable.'}${editsRemain ? ' Newer unsaved edits remain in the editor.' : ''}`, saved.validation?.status === 'verified' ? 'success' : 'info');
  } catch (error) {
    if (!error.stale && scopeIsCurrent(scope) && $('#campaign-select').value === campaignId) {
      if (error.status === 409 || error.code === 'draft_version_conflict') {
        $('#draft-support-status').replaceChildren(text('strong', '', 'A newer draft was saved elsewhere. Your unsaved text is still here.'), text('p', 'quiet', 'Reload the latest saved copy when you are ready. This editor will not overwrite it automatically.'));
        $('#draft-reload').disabled = false;
        setNotice('Draft conflict: your edits were preserved. Choose “Reload saved copy” to replace them with the latest version.', 'error');
      } else setNotice(error.message, 'error');
    }
  }
  finally { finishWrite(form, token); renderDraftSupport(); }
}
function clearCampaignReview(message = 'Review unavailable. Load the saved review for the selected campaign.') {
  state.campaignReview = null;
  state.campaignReviewGeneration++;
  const content = $('#campaign-review-content');
  if (content) { content.replaceChildren(); content.hidden = true; }
  const status = $('#campaign-review-status');
  if (status) { status.className = 'result-box empty'; status.textContent = message; }
  const refresh = $('#campaign-review-refresh');
  if (refresh) refresh.disabled = !$('#campaign-select')?.value;
  const approval = $('#approval-form');
  if (approval) approval.elements.expectedVersion.value = '';
  applyRoleGates();
}
function reviewLabel(value) {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).replaceAll('_', ' ');
}
function reviewSection(title, entries) {
  const section = text('section', 'review-fact-group');
  section.append(text('h5', '', title));
  const list = document.createElement('dl');
  for (const [label, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    list.append(text('dt', '', label), text('dd', '', reviewLabel(value)));
  }
  section.append(list);
  return section;
}
function reviewReasons(title, reasons = []) {
  const section = text('section', 'review-reasons');
  section.append(text('h5', '', title));
  if (!Array.isArray(reasons) || !reasons.length) section.append(text('p', 'quiet', 'None reported.'));
  else {
    const list = document.createElement('ul');
    for (const reason of reasons) list.append(text('li', '', typeof reason === 'string' ? reviewLabel(reason) : reviewLabel(reason?.code || reason?.reason || 'Review required')));
    section.append(list);
  }
  return section;
}
function renderCampaignReview(payload) {
  const review = payload?.review;
  const content = $('#campaign-review-content');
  const status = $('#campaign-review-status');
  content.replaceChildren();
  if (!review || review.campaignId !== $('#campaign-select').value) {
    content.hidden = true;
    status.className = 'result-box'; status.textContent = 'The service did not return a review for the selected campaign.';
    return;
  }
  state.campaignReview = payload;
  status.className = `result-box review-readiness ${review.approval?.ready === true ? 'ready' : 'held'}`;
  status.textContent = review.approval?.ready === true
    ? `Approval ready · campaign version ${review.version} · copy version ${review.copyVersion}. This readiness applies to the saved copy shown below.`
    : `Approval held · campaign version ${review.version} · copy version ${review.copyVersion}. ${Array.isArray(review.approval?.blockers) && review.approval.blockers.length ? review.approval.blockers.map(reviewLabel).join('; ') : 'The service has not marked this version ready.'}`;
  const copy = review.copy || {};
  const copyBox = text('section', 'review-saved-copy');
  copyBox.append(text('h5', '', 'Exact persisted copy'));
  const subject = text('p', 'review-subject', copy.subject || '(No saved subject)');
  subject.setAttribute('aria-label', 'Persisted subject');
  const body = text('pre', 'review-body', copy.body || '(No saved body)');
  body.setAttribute('aria-label', 'Persisted body');
  copyBox.append(text('strong', '', 'Subject'), subject, text('strong', '', 'Body'), body);
  const validation = copy.validation || {};
  copyBox.append(text('p', `review-validation ${validation.status === 'verified' ? 'ready' : 'held'}`, `Current copy validation: ${reviewLabel(validation.status || 'not available')}`));
  if (Array.isArray(validation.reasons) && validation.reasons.length) copyBox.append(reviewReasons('Validation reasons', validation.reasons));
  const proofs = Array.isArray(validation.proofs) ? validation.proofs : [];
  if (proofs.length) {
    const proofList = document.createElement('ul'); proofList.className = 'review-proof-list';
    for (const proof of proofs) {
      const source = proof?.source || {};
      const sourceLabel = source.url || source.sourceId || source.evidenceId || source.hash || 'Source evidence recorded';
      proofList.append(text('li', '', `${proof?.businessDomain || 'Business'} · ${proof?.renderedText || 'Supported copy'} · ${sourceLabel}`));
    }
    const proofGroup = text('section', 'review-reasons');
    proofGroup.append(text('h5', '', 'Current source validation evidence'), proofList);
    copyBox.append(proofGroup);
  }
  content.append(copyBox);

  const audience = review.audience || {};
  const rows = Array.isArray(audience.rows) ? audience.rows : [];
  const fitCount = Number.isFinite(audience.fitCount) ? audience.fitCount : rows.filter(row => row.status === 'fit').length;
  const heldCount = Number.isFinite(audience.blockedCount) ? audience.blockedCount : rows.filter(row => row.status !== 'fit').length;
  const offer = review.offer || {};
  const offerFacts = offer.snapshot || {};
  const limits = review.limits || {};
  const spend = Number.isFinite(limits.spendLimitMinor) ? `${(limits.spendLimitMinor / 100).toFixed(2)} ${limits.currency || ''}`.trim() : 'Not recorded';
  const mailbox = review.mailbox || {};
  const capability = mailbox.capabilityEvidence || {};
  const capabilityEntries = capability && typeof capability === 'object'
    ? Object.entries(capability).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    : [];
  content.append(reviewSection('Audience fit', [['Audience rows', audience.count ?? rows.length], ['Fit', fitCount], ['Held or not fit', heldCount]]));
  const approvedPrice = limits.approvedPrice || offerFacts.price || {};
  const priceCurrency = approvedPrice.currency || limits.currency || '';
  const priceRange = Number.isFinite(approvedPrice.minMinor) || Number.isFinite(approvedPrice.maxMinor)
    ? `${Number.isFinite(approvedPrice.minMinor) ? (approvedPrice.minMinor / 100).toFixed(2) : 'No minimum'} – ${Number.isFinite(approvedPrice.maxMinor) ? (approvedPrice.maxMinor / 100).toFixed(2) : 'No maximum'} ${priceCurrency}`.trim()
    : (approvedPrice.amount ?? approvedPrice.value ?? (typeof approvedPrice === 'string' ? approvedPrice : undefined));
  const offerGeography = offerFacts.geography || {};
  const geographySummary = Array.isArray(offerGeography) ? offerGeography.join(', ')
    : [Array.isArray(offerGeography.includedCountries) ? `Included: ${offerGeography.includedCountries.join(', ')}` : '', Array.isArray(offerGeography.excludedCountries) && offerGeography.excludedCountries.length ? `Excluded: ${offerGeography.excludedCountries.join(', ')}` : ''].filter(Boolean).join(' · ');
  content.append(reviewSection('Approved offer bounds', [['Offer version', offer.versionId], ['Offer snapshot', offer.current === true ? 'Current' : 'Changed or unavailable'], ['Approved offer', offerFacts.name || offerFacts.service || offerFacts.description], ['Offer capacity', limits.approvedOfferCapacity ?? offerFacts.capacity], ['Approved price range', priceRange], ['Price currency', priceCurrency], ['Allowed geography', geographySummary]]));
  content.append(reviewSection('Workspace mailbox capability', [['Mailbox', mailbox.displayName || mailbox.name || 'Selected workspace mailbox'], ['Provider', mailbox.provider], ['Configuration', mailbox.configurationStatus], ...capabilityEntries.map(([key, value]) => [key.replaceAll('_', ' '), value])]));
  const campaignGeography = limits.geography || {};
  const campaignGeographySummary = Array.isArray(campaignGeography) ? campaignGeography.join(', ')
    : [Array.isArray(campaignGeography.includedCountries) ? `Included: ${campaignGeography.includedCountries.join(', ')}` : '', Array.isArray(campaignGeography.excludedCountries) && campaignGeography.excludedCountries.length ? `Excluded: ${campaignGeography.excludedCountries.join(', ')}` : ''].filter(Boolean).join(' · ');
  content.append(reviewSection('Campaign bounds and schedule', [['Purpose', limits.purpose], ['Campaign geography', campaignGeographySummary], ['Campaign spend limit', spend], ['Currency', limits.currency], ['Schedule at', limits.scheduleAt ? safeDate(limits.scheduleAt) : 'Not scheduled'], ['Approved offer capacity', limits.approvedOfferCapacity]]));
  content.append(reviewReasons('Approval blockers', review.approval?.blockers));
  const currentApproval = review.approval?.current;
  content.append(reviewSection('Current approval', [['Status', currentApproval ? (currentApproval.current ? 'current' : 'superseded or expired') : 'None recorded'], ['Version', currentApproval?.campaignVersion], ['Expires', currentApproval?.expiresAt], ['Approved by', currentApproval?.approvedBy]]));
  content.append(reviewSection('Delivery checks', [['Delivery ready', review.delivery?.ready], ['Recipient permission and verification', review.delivery?.recipientChecks || 'not_evaluated_in_review']]));
  content.append(reviewReasons('Delivery remains blocked', review.delivery?.blockers?.length ? review.delivery.blockers : ['delivery_not_enabled']));
  content.hidden = false;
  $('#approval-form').elements.expectedVersion.value = String(review.version ?? '');
  applyRoleGates();
}
async function loadCampaignReview() {
  const campaignId = $('#campaign-select').value;
  if (!campaignId || !UUID_PATTERN.test(campaignId)) return;
  const scope = captureScope();
  clearCampaignReview('Loading the current saved campaign review…');
  const requestGeneration = state.campaignReviewGeneration;
  const button = $('#campaign-review-refresh'); button.disabled = true; button.textContent = 'Loading…';
  try {
    const result = await request(scopedPath(`/campaigns/${encodeURIComponent(campaignId)}/review`, scope), { scope });
    if (!scopeIsCurrent(scope) || requestGeneration !== state.campaignReviewGeneration || $('#campaign-select').value !== campaignId) return;
    renderCampaignReview(result);
  } catch (error) {
    if (!error.stale && scopeIsCurrent(scope) && $('#campaign-select').value === campaignId && requestGeneration === state.campaignReviewGeneration) {
      $('#campaign-review-status').className = 'result-box';
      $('#campaign-review-status').textContent = `Saved review could not be loaded. ${error.message} Use “Load review” to retry.`;
    }
  } finally {
    if (scopeIsCurrent(scope) && $('#campaign-select').value === campaignId && requestGeneration === state.campaignReviewGeneration) { button.disabled = false; button.textContent = 'Refresh review'; }
  }
}
async function handleApproval(event) {
  event.preventDefault(); const form = event.currentTarget, campaignId = $('#campaign-select').value;
  if (!campaignId) { setNotice('Choose a campaign to review.', 'error'); return; }
  if (!isAdmin()) { setNotice('Only workspace owners and admins can approve a campaign version.', 'error'); return; }
  const { token, scope } = beginWrite(form, 'Recording approval…');
  try {
    const shownReview = state.campaignReview?.review;
    if (!shownReview || shownReview.campaignId !== campaignId || shownReview.approval?.ready !== true
      || String(form.elements.expectedVersion.value) !== String(shownReview.version)) {
      throw new Error('Load the current campaign review and confirm its displayed version before approving.');
    }
    const expiry = new Date(`${form.elements.expiresAt.value}T23:59:59.000Z`);
    if (!Number.isFinite(expiry.valueOf()) || expiry.valueOf() <= Date.now()) throw new Error('Choose a future approval expiry date.');
    const result = await request(scopedPath(`/campaigns/${encodeURIComponent(campaignId)}/approvals`, scope), { method: 'POST', scope, body: { expectedVersion: shownReview.version, expiresAt: expiry.toISOString() } });
    assertCurrentScope(scope); clearCampaignReview('Approval was recorded. Load the review again to see the current approval and delivery blockers.'); await loadCampaign(campaignId, scope); assertCurrentScope(scope); setNotice(`Campaign version approval recorded through ${safeDate(result.approval?.expiresAt)}. This does not enable sending.`, 'success');
  } catch (error) {
    if (!error.stale && scopeIsCurrent(scope)) {
      if (error.status === 409) {
        clearCampaignReview('The saved version changed after this review. Your editor contents are preserved. Refresh the review explicitly before deciding whether to approve the new version.');
        $('#campaign-review-refresh').textContent = 'Refresh review';
        setNotice('Approval was not recorded because the campaign version changed. Review the current saved copy before trying again.', 'error');
      } else setNotice(error.message, 'error');
    }
  }
  finally { finishWrite(form, token); applyRoleGates(); }
}
async function loadCampaign(id, scope = captureScope(), { hydrateDraft = false } = {}) {
  if (!UUID_PATTERN.test(id) || !scopeIsCurrent(scope)) return;
  const generation = ++state.composerGeneration;
  const out = $('#campaign-detail'); out.className = 'result-box'; out.textContent = 'Loading campaign details…';
  try {
    const data = await request(scopedPath(`/campaigns/${encodeURIComponent(id)}`, scope), { scope });
    if (!isCampaignLoadCurrent(scope, { tenantId: state.workspace?.id, epoch: state.epoch }, $('#campaign-select').value, id) || generation !== state.composerGeneration) return;
    state.selectedCampaign = data.campaign;
    out.replaceChildren(text('h4', '', data.campaign.name), text('p', '', `${data.campaign.state} · ${data.campaign.purpose} · ${data.campaign.currency || ''}`));
    out.append(text('p', 'quiet', data.campaign.subject ? `Draft saved: ${data.campaign.subject}` : 'No campaign copy draft is saved.'));
    renderCampaignAccount(data.campaign);
    const form = $('#draft-form');
    if (hydrateDraft || form.dataset.campaignId !== id) { form.dataset.campaignId = id; form.dataset.dirty = 'false'; }
    for (const plan of data.dispatchPlans || []) out.append(text('p', 'source-line', `Offline plan · ${plan.plan?.status || plan.status || 'saved'} · ${plan.plan?.blockers?.join(', ') || 'See recorded plan blockers.'}`));
    if (!(data.dispatchPlans || []).length) out.append(text('p', 'quiet', 'No offline plans saved.'));
    if ((data.approvals || []).length) out.append(text('p', 'source-line', `${data.approvals.length} approval record(s) · current approval status is shown by the service.`));
    const composerData = await request(scopedPath(`/campaigns/${encodeURIComponent(id)}/composer`, scope), { scope });
    if (!isCampaignLoadCurrent(scope, { tenantId: state.workspace?.id, epoch: state.epoch }, $('#campaign-select').value, id) || generation !== state.composerGeneration) return;
    state.composer = composerData.composer?.campaignId === id ? composerData.composer : null;
    if (!state.composer) throw new Error('The service did not return the selected campaign composer.');
    $('#draft-reload').disabled = false;
    if ((hydrateDraft || form.dataset.campaignId !== id || form.dataset.dirty !== 'true') && (hydrateDraft || form.dataset.dirty !== 'true')) {
      const savedCopy = campaignCopyForEditor(state.composer);
      form.elements.subject.value = savedCopy.subject; form.elements.body.value = savedCopy.body; form.dataset.dirty = 'false';
    }
    renderDraftFacts(); renderDraftTemplates(); renderDraftSupport(); applyRoleGates();
  } catch (error) { if (!error.stale && scopeIsCurrent(scope) && $('#campaign-select').value === id) { out.className = 'result-box'; out.textContent = `Campaign details unavailable. ${error.message}`; } }
}

function renderCampaignAccount(campaign) {
  const box = $('#draft-account'); box.replaceChildren();
  const audience = Array.isArray(campaign.audience) ? campaign.audience : [];
  const fits = audience.filter(item => item.status === 'fit');
  if (!fits.length) { box.textContent = 'No currently fit business is recorded for this campaign. Qualify a business before editing source-backed copy.'; return; }
  const list = document.createElement('ul'); list.className = 'draft-qualified-accounts';
  for (const item of fits) list.append(text('li', '', `${item.domain || 'Business'} · fit recorded${item.reasons?.length ? ` · ${item.reasons.join(', ')}` : ''}`));
  box.append(text('strong', '', 'Qualified businesses'), list);
}

function renderDraftFacts() {
  renderDraftTemplates();
}

function renderDraftTemplates() {
  const box = $('#draft-fact-picker'); if (!box) return;
  box.replaceChildren();
  const templates = Array.isArray(state.composer?.templates) ? state.composer.templates : [];
  if (!templates.length) { box.append(text('p', 'quiet', $('#campaign-select')?.value ? 'Loading current templates…' : 'Choose a campaign to load its current templates.')); $('#draft-insert-facts').disabled = true; return; }
  box.append(text('p', 'quiet', 'Select an exact template. Each source link and freshness date comes from the service.'));
  for (const template of templates) {
    const label = text('label', 'draft-fact'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = template.templateId; checkbox.dataset.placement = template.placement;
    const detail = document.createElement('span'); detail.append(text('strong', '', template.placement === 'subject' ? 'Subject template' : `${template.businessDomain || 'Business'} · body template`));
    detail.append(text('small', 'draft-template-copy', template.renderedText));
    const sourceInfo = template.source;
    if (sourceInfo?.url) {
      try { const sourceUrl = new URL(sourceInfo.url); if (sourceUrl.protocol === 'https:') { const source = text('a', 'source-line', `${template.businessDomain || 'Source page'} · view evidence ↗`); source.href = sourceUrl.href; source.target = '_blank'; source.rel = 'noopener noreferrer'; detail.append(source); } }
      catch { /* malformed source URLs are not rendered as links */ }
    }
    if (sourceInfo) {
      const expiresAt = sourceInfo.expiresAt || sourceInfo.rightsExpiresAt;
      const expired = expiresAt && new Date(expiresAt).valueOf() <= Date.now();
      detail.append(text('small', expired ? 'draft-source-state expired' : 'draft-source-state', `${expired ? 'Expired' : 'Current source snapshot'} · expires ${safeDate(expiresAt)}${sourceInfo.hash ? ` · ${String(sourceInfo.hash).slice(0, 12)}` : ''}`));
      if (sourceInfo.exactExcerpt) detail.append(text('small', 'quiet', `Evidence excerpt: “${sourceInfo.exactExcerpt}”`));
    } else detail.append(text('small', 'draft-source-state', 'Fixed subject template · no business claim'));
    label.append(checkbox, detail); box.append(label);
  }
}

function renderDraftSupport() {
  const box = $('#draft-support-status'); const form = $('#draft-form');
  box.replaceChildren();
  const savedValidation = state.composer?.validation;
  const dirty = form.dataset.dirty === 'true';
  if (dirty) {
    box.append(text('strong', '', 'Edited copy is not yet verified'));
    box.append(text('p', 'quiet', 'A familiar word or phrase does not prove a claim. Save to ask the service to validate the exact subject and body against current evidence.'));
    const attributed = exactTemplateMappings(form.elements.subject.value, form.elements.body.value, state.composer?.templates);
    const lines = [...form.elements.subject.value.split(/\r?\n/), ...form.elements.body.value.split(/\r?\n/)].map(line => line.trim()).filter(Boolean);
    const mapped = new Set(attributed.map(item => `${item.sentence}\0${item.templateId}`));
    if (lines.length) {
      const list = document.createElement('ul'); list.className = 'draft-sentence-checks';
      for (const line of lines) list.append(Object.assign(text('li', 'unsupported'), { textContent: line }));
      box.append(text('small', 'quiet', `${mapped.size} exact template line(s) recognized in this edited draft. This count is not a validation result.`), list);
    }
  } else if (!state.composer) {
    box.textContent = 'Select a campaign to load saved copy, templates, and its server validation result.';
  } else {
    const eligible = composerCanApprove(savedValidation);
    box.append(text('strong', eligible ? 'draft-verified' : 'draft-unverified', eligible ? 'Service verified this saved copy' : 'Service marks this saved copy unverified'));
    if (savedValidation?.reasons?.length) {
      const list = document.createElement('ul'); list.className = 'draft-validation-reasons';
      for (const reason of savedValidation.reasons) list.append(text('li', '', String(reason).replaceAll('_', ' ')));
      box.append(list);
    } else if (!eligible) box.append(text('p', 'quiet', 'No server eligibility result is available for this saved copy.'));
  }
  const hasText = form.elements.subject.value.trim() && form.elements.body.value.trim();
  form.querySelector('[type="submit"]').disabled = !isWriter() || state.busy || formWriteTokens.has(form) || !hasText || !$('#campaign-select').value || !state.composer || state.composer.campaignId !== $('#campaign-select').value;
  applyRoleGates();
}
async function handleQualification(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Checking evidence…');
  try {
    const campaignId = form.elements.campaignId.value, accountId = form.elements.accountId.value;
    const data = await request(scopedPath(`/campaigns/${encodeURIComponent(campaignId)}/qualification`, scope), { method: 'POST', scope, body: { accountIds: [accountId] } }); assertCurrentScope(scope);
    if ($('#campaign-select').value === campaignId) clearCampaignReview('Audience qualification changed. Load the review again to inspect current fit and held counts.');
    const result = data.qualification?.results?.[0]; const out = $('#qualification-result'); out.replaceChildren(); out.className = 'result-box';
    out.append(text('h4', '', result?.status === 'fit' ? 'Evidence fit recorded' : 'Not ready for this campaign'), text('p', '', `${result?.domain || 'Selected business'} · ${result?.status || 'no result'}`));
    out.append(text('p', 'report-caveat', 'Qualification is an evidence screen. It is not address verification, permission, campaign approval, or send readiness.'));
    if (result?.reasons?.length) { const list = document.createElement('ul'); for (const reason of result.reasons) list.append(text('li', '', String(reason).replaceAll('_', ' '))); out.append(list); }
    await refreshAll(scope.epoch); assertCurrentScope(scope); setNotice(`Qualification saved: ${result?.status || 'unknown'}.`, result?.status === 'fit' ? 'success' : 'info');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) { $('#qualification-result').textContent = error.message; setNotice(error.message, 'error'); } }
  finally { finishWrite(form, token); }
}
async function handlePlan(event) {
  event.preventDefault(); const form = event.currentTarget; const campaignId = $('#campaign-select').value;
  if (!campaignId) { setNotice('Select a campaign before preparing its offline plan.', 'error'); return; }
  const { token, scope } = beginWrite(form, 'Preparing plan…');
  try {
    const result = await request(scopedPath(`/campaigns/${encodeURIComponent(campaignId)}/dispatch-plans`, scope), { method: 'POST', scope, body: { idempotencyKey: `customer-plan-${crypto.randomUUID()}` } }); assertCurrentScope(scope);
    const plan = result.plan || {}; setNotice(`Offline plan saved · ${plan.liveTransport || 'live transport disabled'} · ${plan.blockers?.join(', ') || 'review the saved plan details'}.`, 'info');
    await loadCampaign(campaignId, scope); assertCurrentScope(scope);
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(error.message, 'error'); }
  finally { finishWrite(form, token); }
}
function handleRevenueFields() {
  const show = ['revenue_paid', 'revenue_refunded'].includes($('#outcome-form [name="stage"]').value);
  for (const field of $$('.revenue-fields')) { field.hidden = !show; field.querySelector('input').required = show; }
}
async function handleOutcome(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Saving outcome…');
  try {
    const f = form.elements, stage = f.stage.value;
    const occurredAt = new Date(f.occurredAt.value);
    if (!Number.isFinite(occurredAt.valueOf())) throw new Error('Choose when the event happened.');
    const body = { stage, entity: { type: 'account', id: f.accountId.value }, occurredAt: occurredAt.toISOString(), idempotencyKey: `customer-outcome-${crypto.randomUUID()}`, provenance: { source: 'customer_console', confidence: 'high', fieldAuthority: 'human', evidenceRef: 'Customer-entered workspace outcome' } };
    if (stage === 'revenue_paid' || stage === 'revenue_refunded') { body.amountMinor = Math.round(Number(f.amount.value) * 100); body.currency = f.currency.value.toUpperCase(); }
    const result = await request(scopedPath('/outcomes', scope), { method: 'POST', scope, body }); assertCurrentScope(scope);
    await refreshAll(scope.epoch); assertCurrentScope(scope); setNotice(`Outcome saved${result.data?.duplicate ? ' (already recorded)' : ''}. Analytics use observed events only.`, 'success'); form.reset(); handleRevenueFields();
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(error.message, 'error'); }
  finally { finishWrite(form, token); }
}
function writeResult(target, title, detail, error = false) {
  const box = $(target); box.replaceChildren(); box.className = 'result-box';
  box.append(text('h4', '', title), text('p', '', detail));
  if (error) box.dataset.state = 'error'; else delete box.dataset.state;
}
async function handleMailboxCreate(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Creating inbox…');
  try {
    const displayName = form.elements.displayName.value.trim();
    const result = await request(scopedPath('/mailboxes', scope), { method: 'POST', scope, body: { displayName, provider: 'manual' } });
    assertCurrentScope(scope);
    if (!result.mailbox?.id || result.mailbox.provider !== 'manual') throw new Error('The service did not return a manual inbox. Refresh and try again.');
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope);
    writeResult('#inbox-write-result', 'Manual inbox created', `${result.mailbox.displayName} · manual import only · outbound sending disabled.`);
  } catch (error) {
    if (!error.stale && scopeIsCurrent(scope)) writeResult('#inbox-write-result', 'Inbox setup failed', error.message, true);
  } finally { finishWrite(form, token); }
}
async function handleMessageImport(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Importing message…');
  try {
    const f = form.elements;
    const mailbox = state.mailboxes.find(item => item.id === f.mailboxId.value && item.provider === 'manual');
    if (!mailbox) throw new Error('Choose a manual inbox in this workspace.');
    const recipients = f.recipients.value.split(',').map(value => value.trim()).filter(Boolean);
    const body = { mailboxId: mailbox.id, externalThreadId: f.externalThreadId.value.trim(), externalMessageId: f.externalMessageId.value.trim(), sender: f.sender.value.trim(), recipients, subject: f.subject.value.trim() || null, bodyText: f.bodyText.value };
    if (f.receivedAt.value) {
      const receivedAt = new Date(f.receivedAt.value);
      if (!Number.isFinite(receivedAt.valueOf())) throw new Error('Enter a valid received date and time.');
      body.receivedAt = receivedAt.toISOString();
    }
    const result = await request(scopedPath('/inbox/messages', scope), { method: 'POST', scope, body });
    assertCurrentScope(scope);
    if (!result.message?.id) throw new Error('The import service did not return a saved message. Refresh and try again.');
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope);
    writeResult('#inbox-write-result', result.message.duplicate ? 'Message already imported' : 'Message imported', `${body.externalMessageId} · ${result.message.duplicate ? 'identical content was already saved' : 'saved to ' + mailbox.displayName}. Duplicate references with changed content are rejected.`);
  } catch (error) {
    if (!error.stale && scopeIsCurrent(scope)) writeResult('#inbox-write-result', 'Message import failed', error.message, true);
  } finally { finishWrite(form, token); }
}
async function handleCrmMapping(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Saving mapping…');
  try {
    const accountId = form.elements.accountId.value;
    const account = state.accounts.find(item => item.id === accountId);
    if (!account) throw new Error('Choose an evidence-backed business in this workspace.');
    const body = { entityType: 'company', entityId: account.id, accountId: account.id, externalId: form.elements.externalId.value.trim(), fieldAuthority: { externalId: 'human' }, provenance: { source: 'customer_console_manual_assertion', confidence: 'low', fieldAuthority: 'human', verification: 'manual_unverified' } };
    const result = await request(scopedPath('/crm/mappings', scope), { method: 'POST', scope, body }); assertCurrentScope(scope);
    if (!result.mapping?.entityId || result.mapping.entityId !== account.id) throw new Error('The service did not confirm the selected business mapping.');
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope);
    setNotice(result.mapping.duplicate ? 'This manual CRM mapping was already saved.' : 'Manual CRM mapping saved. The identity has not been provider-verified.', 'success');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(`CRM mapping was not saved. ${error.message}`, 'error'); }
  finally { finishWrite(form, token); }
}
async function handleCrmProposal(event) {
  event.preventDefault(); const form = event.currentTarget; const { token, scope } = beginWrite(form, 'Saving proposal…');
  try {
    const f = form.elements, account = state.accounts.find(item => item.id === f.accountId.value);
    if (!account) throw new Error('Choose an evidence-backed business in this workspace.');
    const payload = { name: f.name.value.trim() };
    const domainName = f.domainName.value.trim(); if (domainName) payload.domainName = domainName;
    const result = await request(scopedPath('/crm/outbox', scope), { method: 'POST', scope, body: {
      entityType: 'company', entityId: account.id, accountId: account.id, operation: 'create_company', idempotencyKey: `customer-company-${crypto.randomUUID()}`,
      payload, fieldAuthority: Object.fromEntries(Object.keys(payload).map(field => [field, 'human'])),
      provenance: { source: 'customer_console_manual_proposal', confidence: 'low', fieldAuthority: 'human', verification: 'manual_unverified' },
    } }); assertCurrentScope(scope);
    if (!result.proposal?.id || !result.proposal.state) throw new Error('The proposal service did not return a saved status. Refresh and try again.');
    form.reset(); await refreshAll(scope.epoch); assertCurrentScope(scope);
    setNotice(`Company proposal saved · ${result.proposal.state} · external transport disabled.`, result.proposal.state === 'held' ? 'info' : 'success');
  } catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(`Company proposal was not saved. ${error.message}`, 'error'); }
  finally { finishWrite(form, token); }
}
async function createWorkspace(form) {
  const name = form.elements.name.value.trim(); if (!name) return;
  const startingEpoch = state.epoch; const token = ++nextWriteToken; formWriteTokens.set(form, token); setBusy(form, true, 'Creating workspace…');
  try {
    const result = await request('/api/astra/tenants', { method: 'POST', body: { name } });
    if (state.epoch !== startingEpoch) throw Object.assign(new Error('Workspace changed while this action was in progress.'), { stale: true });
    const id = result.tenant?.id;
    if (!id) throw new Error('Workspace was created but the service did not return its workspace. Refresh the list.');
    form.reset(); await loadWorkspaces(id); if (state.epoch !== startingEpoch + 1 && state.workspace?.id !== id) return; setView('overview'); setNotice('Workspace created. You are its owner.', 'success');
  } catch (error) { if (!error.stale && state.epoch === startingEpoch) setNotice(error.message, 'error'); }
  finally { finishWrite(form, token); }
}
function bindEvents() {
  setTabOrientation();
  window.addEventListener('resize', setTabOrientation, { passive: true });
  for (const tab of $$('.section-nav [role="tab"]')) tab.addEventListener('click', () => setView(tab.dataset.view, { updateHash: true }));
  $('.section-nav').addEventListener('keydown', event => {
    const vertical = $('.section-nav').getAttribute('aria-orientation') === 'vertical';
    const forward = vertical ? ['ArrowDown', 'ArrowRight'] : ['ArrowRight', 'ArrowDown'];
    const backward = vertical ? ['ArrowUp', 'ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
    if (![...forward, ...backward].includes(event.key)) return;
    const tabs = $$('.section-nav [role="tab"]'); const active = tabs.indexOf(document.activeElement);
    const next = (active + (forward.includes(event.key) ? 1 : -1) + tabs.length) % tabs.length; tabs[next].focus(); tabs[next].click(); event.preventDefault();
  });
  $$('[data-go], [data-open-task], [data-open-tasks]').forEach(button => button.addEventListener('click', () => openWorkflowTasks(button)));
  $('#first-success-guide').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.journeyRefresh) {
      refreshAll(state.epoch).catch(error => { if (!error.stale) setNotice(`Workspace data could not be refreshed. ${error.message}`, 'error'); });
    } else if (button.dataset.openTask || button.dataset.openTasks) openWorkflowTasks(button);
  });
  $$('[data-discover-action]').forEach(button => button.addEventListener('click', () => {
      const target = button.dataset.discoverAction === 'analyze-page' ? $('#snapshot-form') : $('#prospecting-form');
    setView('discover', { updateHash: true });
    const disclosure = target?.closest('details.task-disclosure');
    if (disclosure) disclosure.open = true;
    requestAnimationFrame(() => {
      target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target?.querySelector('input:not([type="hidden"]),select,textarea,button')?.focus({ preventScroll: true });
    });
  }));
  $('#pro-mode-toggle').addEventListener('click', () => applyProMode(!document.body.classList.contains('pro-mode')));
  for (const details of $$('details.task-disclosure')) details.addEventListener('toggle', () => {
    const hint = $('summary .disclosure-hint', details);
    if (hint) hint.textContent = details.open ? 'Close task' : 'Open task';
  });
  $('#workspace-select').addEventListener('change', event => { setNotice(''); if (event.target.value) activateWorkspace(event.target.value); });
  $('#refresh-settings-availability').addEventListener('click', () => {
    const epoch = state.epoch;
    Promise.all([refreshAll(epoch), loadAiAvailability({ force: true })]).catch(error => {
      if (!error.stale && state.epoch === epoch) setNotice('Workspace availability could not be refreshed. Try again.', 'error');
    });
  });
  $('#new-workspace-button').addEventListener('click', () => { setView('settings'); $('#create-workspace-form [name="name"]').focus(); });
  $('#create-workspace-form').addEventListener('submit', event => { event.preventDefault(); createWorkspace(event.currentTarget); });
  const advancedLink = $('#advanced-link');
  const prepareAdvancedHandoff = event => {
    const error = syncAdvancedWorkspaceHandoff();
    if (!error) return;
    event.preventDefault();
    setNotice(error, 'error');
  };
  advancedLink.addEventListener('click', prepareAdvancedHandoff);
  advancedLink.addEventListener('auxclick', event => { if (event.button === 1) prepareAdvancedHandoff(event); });
  advancedLink.addEventListener('contextmenu', prepareAdvancedHandoff);
  $$('[data-refresh]').forEach(button => button.addEventListener('click', () => refreshAll(state.epoch).catch(error => { if (!error.stale) setNotice(error.message, 'error'); })));
  $('#search-form').addEventListener('submit', handleSearch);
  $('#prospecting-form').addEventListener('submit', handleProspectingStart);
  // ---- Guided goal panel: durable create -> asynchronous planning -> answers -> owner confirmation.
  let goalDraft = null;
  let goalSelectedId = '';
  let goalDetailToken = 0;
  let goalPollTimer = null;
  let goalPollCount = 0;
  let goalMutationPending = false;
  let goalSubmitPending = false;
  const GOAL_POLL_LIMIT = 30;
  const GOAL_POLL_DELAY = 2000;

  function goalPath(resource = '', scope = captureScope()) {
    return scopedPath(`/business-goals${resource}`, scope);
  }
  function goalSelectionKey(scope = captureScope()) { return `odd-growth-selected-goal:${scope.tenantId}`; }
  function goalSubmitKey(scope = captureScope()) { return `odd-growth-goal-submit:${scope.tenantId}`; }
  function stopGoalPolling() {
    if (goalPollTimer) clearTimeout(goalPollTimer);
    goalPollTimer = null;
  }
  state.goalStopPolling = () => { stopGoalPolling(); goalDetailToken++; goalSelectedId = ''; goalDraft = null; goalPollCount = 0; };
  function setGoalStatus(message, kind = 'empty') {
    const status = $('#goal-status');
    status.className = `result-box${kind === 'empty' ? ' empty' : ` ${kind}`}`;
    status.textContent = message;
  }
  function appendGoalList(parent, items, renderItem) {
    const list = text('ul', 'goal-list');
    for (const item of items) list.append(renderItem(item));
    parent.append(list);
  }
  function renderGoal() {
    const goal = goalDraft;
    if (!goal) return;
    const status = $('#goal-status');
    const box = $('#goal-content');
    box.replaceChildren();
    box.hidden = false;
    const revision = Number(goal.stateRevision) || 1;
    const stateLabel = String(goal.status || 'saved').replaceAll('_', ' ');
    if (goal.status === 'blocked') {
      status.className = 'result-box error';
      status.replaceChildren(text('strong', '', 'Planning is blocked.'), text('p', '', 'The goal and its history are saved. Review the reason before changing anything.'));
      const reasons = Array.isArray(goal.blockedReasons) ? goal.blockedReasons : [];
      appendGoalList(status, reasons, reason => text('li', '', [reason?.code, reason?.message].filter(Boolean).join(' — ') || String(reason)));
    } else if (['draft', 'planning'].includes(goal.status)) {
      setGoalStatus('Goal saved. Planning is in progress. No research has started yet.', 'empty');
    } else if (goal.status === 'awaiting_confirmation') {
      setGoalStatus(`Review the saved plan. It is waiting for your confirmation (revision ${revision}).`, '');
    } else if (goal.status === 'planned') {
      setGoalStatus(`Plan ready for your review (revision ${revision}). Research starts only after an owner confirms it.`, 'ok');
    } else if (goal.status === 'running' && goal.startRef?.state === 'starting') {
      setGoalStatus('The confirmed plan was accepted. The saved research job is being created; nothing is sent to anyone.', 'empty');
    } else if (goal.status === 'running') {
      setGoalStatus('The confirmed plan has started its saved research journey. Nothing is sent to anyone.', 'ok');
    } else {
      setGoalStatus(`Saved goal status: ${stateLabel} (revision ${revision}).`, 'empty');
    }

    box.append(text('p', 'goal-brief', goal.brief || 'Business goal'));
    const plan = goal.plan && typeof goal.plan === 'object' ? goal.plan : null;
    if (plan) {
      const fields = [
        ['Offer', plan.offerSummary], ['Industry', plan.targetIndustry], ['Country', plan.country],
        ['City', plan.city], ['Objective', plan.objective], ['Target count', plan.targetCount],
      ].filter(([, value]) => value !== null && value !== undefined && value !== '');
      if (fields.length) appendGoalList(box, fields, ([label, value]) => {
        const item = text('li'); item.append(text('strong', '', `${label}: `), document.createTextNode(String(value))); return item;
      });
      const unknowns = Array.isArray(plan.unknownCommercialFacts) ? plan.unknownCommercialFacts : [];
      if (unknowns.length) {
        const section = text('section', 'goal-unknowns'); section.append(text('h4', '', 'Still unknown'));
        appendGoalList(section, unknowns, item => text('li', '', typeof item === 'string' ? item : JSON.stringify(item)));
        box.append(section);
      }
      const assumptions = plan.assumptions && typeof plan.assumptions === 'object' ? Object.entries(plan.assumptions) : [];
      if (assumptions.length) {
        const section = text('section', 'goal-assumptions'); section.append(text('h4', '', 'Planning assumptions'));
        appendGoalList(section, assumptions, ([key, value]) => text('li', '', `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`));
        box.append(section);
      }
    }

    const questions = Array.isArray(goal.questions) ? goal.questions.slice(0, 3) : [];
    if (questions.length && isWriter() && ['awaiting_confirmation', 'planned'].includes(goal.status)) {
      const answersById = new Map((Array.isArray(goal.answers) ? goal.answers : []).map(answer => [answer.questionId, answer.answer]));
      const form = text('form', 'form-stack goal-answers-form'); form.id = 'goal-answers-form';
      form.append(text('p', 'quiet', 'Answer only what you know. Uncertain commercial details stay marked as unknown.'));
      for (const question of questions) {
        const label = text('label', '', question.question || 'Follow-up question');
        const input = text('input'); input.type = 'text'; input.maxLength = 2000; input.autocomplete = 'off';
        input.dataset.questionId = String(question.questionId || ''); input.value = String(answersById.get(question.questionId) || '');
        label.append(input); form.append(label);
      }
      const submit = text('button', 'button secondary', 'Save answers and update plan'); submit.type = 'submit';
      form.append(submit); box.append(form);
    } else if (questions.length) {
      box.append(text('p', 'quiet', 'This saved plan has follow-up questions. A workspace editor can answer them.'));
    }

    if (['planned', 'awaiting_confirmation'].includes(goal.status) && state.role === 'owner') {
      const start = text('button', 'button primary', 'Confirm plan and start research');
      start.type = 'button'; start.id = 'goal-start-button'; start.disabled = goalMutationPending;
      box.append(start);
      box.append(text('p', 'safety-note', 'Starting creates a bounded research job after workspace source permission is checked. Nothing is sent. Unknown facts remain held for review.'));
    }
    if (goal.status === 'running') {
      const jobId = goal.startRef?.kind === 'prospecting_job' && typeof goal.startRef.id === 'string' ? goal.startRef.id : '';
      if (UUID_PATTERN.test(jobId)) {
        const open = text('button', 'button secondary', 'Open linked research progress');
        open.type = 'button'; open.dataset.openGoalJob = jobId; box.append(open);
      } else if (goal.startRef?.state === 'starting') {
        box.append(text('p', 'quiet', 'The research job is being created. Refresh this saved goal to open its progress once the service returns the job reference.'));
      }
    }
    if (goal.status === 'blocked' && (goal.blockedReasons || []).some(reason => /source.?right|grant/i.test(`${reason?.code || ''} ${reason?.message || ''}`))) {
      const action = text('button', 'button subtle', 'Review public-search permissions'); action.type = 'button'; action.dataset.openSourcePermissions = 'true';
      box.append(action);
    }
    const saved = state.businessGoals.find(item => item.id === goal.id);
    if (saved) { saved.status = goal.status; saved.stateRevision = goal.stateRevision; saved.startRef = goal.startRef; }
    renderBusinessGoalList();
  }
  function goalCanPoll(goal) {
    return ['draft', 'planning'].includes(String(goal?.status || ''))
      || (goal?.status === 'running' && goal?.startRef?.kind === 'prospecting_job' && goal?.startRef?.state === 'starting');
  }
  function scheduleGoalPolling(scope, goalId) {
    stopGoalPolling();
    if (!scopeIsCurrent(scope) || goalSelectedId !== goalId || !goalCanPoll(goalDraft) || $('#view-discover').hidden || document.visibilityState !== 'visible') return;
    if (goalPollCount >= GOAL_POLL_LIMIT) {
      setGoalStatus('Planning is still in progress. Live checks paused after several minutes; use Refresh goals to check the saved state.', 'empty');
      return;
    }
    goalPollTimer = setTimeout(async () => {
      goalPollTimer = null;
      if (!scopeIsCurrent(scope) || goalSelectedId !== goalId || $('#view-discover').hidden || document.visibilityState !== 'visible') return;
      goalPollCount++;
      try {
        const response = await request(goalPath(`/${encodeURIComponent(goalId)}`, scope), { scope });
        if (!scopeIsCurrent(scope) || goalSelectedId !== goalId) return;
        const updated = response.goal || response;
        const openingReadyJob = goalDraft?.status === 'running' && goalDraft?.startRef?.state === 'starting'
          && updated?.status === 'running' && updated?.startRef?.kind === 'prospecting_job' && UUID_PATTERN.test(String(updated?.startRef?.id || ''));
        if (Number(updated.stateRevision) >= Number(goalDraft?.stateRevision || 0)) { goalDraft = updated; renderGoal(); }
        if (openingReadyJob) { await openGoalProgress(updated, scope); return; }
      } catch (error) {
        if (!error.stale && scopeIsCurrent(scope)) setGoalStatus(`The latest saved planning state could not be read. ${error.message}`, 'error');
      }
      scheduleGoalPolling(scope, goalId);
    }, GOAL_POLL_DELAY);
  }
  async function loadGoal(goalId, scope = captureScope()) {
    if (!goalId || !scopeIsCurrent(scope)) return;
    stopGoalPolling();
    goalSelectedId = goalId;
    const token = ++goalDetailToken;
    goalPollCount = 0;
    try { sessionStorage.setItem(goalSelectionKey(scope), goalId); } catch { /* session persistence is optional */ }
    setGoalStatus('Loading the saved goal…');
    $('#goal-content').hidden = true;
    const response = await request(goalPath(`/${encodeURIComponent(goalId)}`, scope), { scope });
    if (!scopeIsCurrent(scope) || token !== goalDetailToken || goalSelectedId !== goalId) return;
    goalDraft = response.goal || response;
    renderGoal();
    scheduleGoalPolling(scope, goalId);
  }
  async function refreshGoalList(scope = captureScope()) {
    const response = await request(goalPath('?limit=100', scope), { scope });
    if (!scopeIsCurrent(scope)) return;
    state.businessGoals = Array.isArray(response.items) ? response.items : [];
    renderBusinessGoalList();
    const savedId = (() => { try { return sessionStorage.getItem(goalSelectionKey(scope)) || ''; } catch { return ''; } })();
    if (goalSelectedId && !state.businessGoals.some(goal => goal.id === goalSelectedId)) {
      goalSelectedId = ''; goalDraft = null; stopGoalPolling(); $('#goal-content').hidden = true;
      setGoalStatus('The selected goal is no longer in this workspace. Choose a saved goal or start a new one.');
    }
    if (savedId && state.businessGoals.some(goal => goal.id === savedId)) {
      const summary = state.businessGoals.find(goal => goal.id === savedId);
      if (goalSelectedId !== savedId || !goalDraft || goalDraft.id !== savedId || Number(summary?.stateRevision) > Number(goalDraft?.stateRevision || 0)) await loadGoal(savedId, scope);
    }
  }
  state.goalResume = () => {
    if (!state.workspace || $('#view-discover').hidden || document.visibilityState !== 'visible') return;
    const scope = captureScope();
    let savedId = '';
    try { savedId = sessionStorage.getItem(goalSelectionKey(scope)) || ''; } catch { /* optional persistence */ }
    if (savedId && state.businessGoals.some(goal => goal.id === savedId)) {
      const summary = state.businessGoals.find(goal => goal.id === savedId);
      if (goalSelectedId !== savedId || !goalDraft || goalDraft.id !== savedId || Number(summary?.stateRevision) > Number(goalDraft?.stateRevision || 0)) {
        loadGoal(savedId, scope).catch(error => { if (!error.stale && scopeIsCurrent(scope)) setGoalStatus(`Saved goal could not be loaded. ${error.message}`, 'error'); });
        return;
      }
    }
    if (goalSelectedId && goalCanPoll(goalDraft)) scheduleGoalPolling(scope, goalSelectedId);
  };
  async function reconcileGoal(goal, scope, token) {
    if (!scopeIsCurrent(scope) || token !== goalDetailToken || goalSelectedId !== goal?.id) return;
    goalDraft = goal;
    renderGoal();
    scheduleGoalPolling(scope, goal.id);
  }
  async function handleGoalSubmit(event) {
    event.preventDefault();
    if (goalSubmitPending) return;
    const form = event.currentTarget;
    const brief = String(form.elements.brief.value || '').trim();
    if (!brief || !state.workspace) { setNotice(brief ? 'Choose a workspace first.' : 'Describe your goal first.', 'error'); return; }
    const { token, scope } = beginWrite(form, 'Saving goal…');
    const status = $('#goal-status');
    setGoalStatus('Saving your goal. Planning will begin after it is recorded. No research has started.', 'empty');
    $('#goal-content').hidden = true;
    goalSubmitPending = true;
    try {
      let retry = null;
      try { retry = JSON.parse(sessionStorage.getItem(goalSubmitKey(scope)) || 'null'); } catch { retry = null; }
      const idempotencyKey = retry?.brief === brief && retry?.key ? retry.key : crypto.randomUUID();
      try { sessionStorage.setItem(goalSubmitKey(scope), JSON.stringify({ brief, key: idempotencyKey })); } catch { /* API key still deduplicates this attempt */ }
      const data = await request(goalPath('', scope), { method: 'POST', scope, body: { brief }, idempotencyKey });
      if (!scopeIsCurrent(scope) || formWriteTokens.get(form) !== token) return;
      try { sessionStorage.removeItem(goalSubmitKey(scope)); } catch { /* optional persistence */ }
      const goal = data.goal || data;
      // A detail request for the previously selected goal must not repaint this new selection.
      goalDetailToken++;
      goalSelectedId = goal.id;
      goalDraft = goal;
      goalPollCount = 0;
      try { sessionStorage.setItem(goalSelectionKey(scope), goal.id); } catch { /* optional persistence */ }
      state.businessGoals = [goal, ...state.businessGoals.filter(item => item.id !== goal.id)];
      renderBusinessGoalList(); renderGoal();
      scheduleGoalPolling(scope, goal.id);
    } catch (error) {
      if (!error.stale && scopeIsCurrent(scope)) { status.className = 'result-box error'; status.textContent = error.message || 'Could not save the goal.'; }
    } finally {
      goalSubmitPending = false; finishWrite(form, token);
    }
  }
  async function runGoalMutation(form, action, answers = []) {
    if (goalMutationPending || !goalDraft?.id) return;
    const scope = captureScope(); const goal = goalDraft; const token = goalDetailToken;
    const expectedVersion = Number(goal.stateRevision);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      setGoalStatus('This saved goal has no current revision. Refresh its saved state before continuing.', 'error');
      try { await loadGoal(goal.id, scope); } catch (error) { if (!error.stale) setGoalStatus(`The saved goal could not be refreshed. ${error.message}`, 'error'); }
      return;
    }
    goalMutationPending = true;
    for (const button of $$('#goal-content button')) button.disabled = true;
    try {
      const body = { expectedVersion };
      if (action === 'answers') body.answers = answers;
      // Source permission is an existing workspace grant selected by the service.
      // Never ask customers to type rights references into a routine goal flow.
      const response = await request(goalPath(`/${encodeURIComponent(goal.id)}/${action}`, scope), { method: 'POST', scope, body });
      if (!scopeIsCurrent(scope) || goalSelectedId !== goal.id) return;
      let updated = response.goal || response;
      if (updated.id !== goal.id || !Number.isInteger(Number(updated.stateRevision)) || Number(updated.stateRevision) < 1) {
        const refreshed = await request(goalPath(`/${encodeURIComponent(goal.id)}`, scope), { scope });
        updated = refreshed.goal || refreshed;
      }
      await reconcileGoal(updated, scope, token);
      if (action === 'start' && goalDraft?.status === 'running') await openGoalProgress(goalDraft, scope);
    } catch (error) {
      if (error.stale || !scopeIsCurrent(scope)) return;
      if (error.status === 409) {
        try { await loadGoal(goal.id, scope); } catch (reloadError) { if (!reloadError.stale) setGoalStatus(`The goal changed. Refresh its saved state before trying again. ${reloadError.message}`, 'error'); }
      } else setGoalStatus(error.message || 'This goal action could not be completed.', 'error');
    } finally {
      goalMutationPending = false;
      if (goalDraft) renderGoal();
    }
  }
  async function openGoalProgress(goal, scope) {
    const reference = goal?.startRef;
    const jobId = reference?.kind === 'prospecting_job' && typeof reference.id === 'string' && UUID_PATTERN.test(reference.id) ? reference.id : '';
    if (!jobId || !scopeIsCurrent(scope)) return;
    setView('discover', { updateHash: true });
    state.prospectingDetailId = jobId;
    try {
      await refreshProspecting(scope.epoch);
      if (!scopeIsCurrent(scope)) return;
      await loadProspectingDetail(jobId, scope);
      $('#prospecting-job-detail').scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (error) {
      if (!error.stale && scopeIsCurrent(scope)) setNotice(`The saved goal started, but its linked research progress could not be opened yet. Refresh saved work to try again. ${error.message}`, 'info');
    }
  }
  $('#goal-form').addEventListener('submit', handleGoalSubmit);
  $('#goal-answers-form')?.addEventListener('submit', event => event.preventDefault());
  $('#goal-content').addEventListener('submit', event => {
    if (event.target.id !== 'goal-answers-form') return;
    event.preventDefault();
    const answers = [...event.currentTarget.querySelectorAll('input[data-question-id]')]
      .map(input => ({ questionId: input.dataset.questionId, answer: String(input.value || '').trim() }))
      .filter(answer => answer.answer);
    if (!answers.length) { setGoalStatus('Add at least one answer before updating the plan.', 'error'); return; }
    runGoalMutation(event.currentTarget, 'answers', answers);
  });
  $('#goal-content').addEventListener('click', event => {
    const start = event.target.closest('#goal-start-button');
    if (start) return runGoalMutation(null, 'start');
    const job = event.target.closest('[data-open-goal-job]');
    if (job && goalDraft) return openGoalProgress(goalDraft, captureScope());
    const discover = event.target.closest('[data-go="discover"]');
    if (discover) setView('discover', { updateHash: true });
    const permissions = event.target.closest('[data-open-source-permissions]');
    if (permissions) {
      setView('discover', { updateHash: true });
      const form = $('#search-form'); const disclosure = form?.closest('details.task-disclosure');
      if (disclosure) disclosure.open = true;
      requestAnimationFrame(() => { form?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); form?.querySelector('input')?.focus({ preventScroll: true }); });
    }
  });
  $('#goal-saved-list').addEventListener('click', event => {
    const button = event.target.closest('[data-load-goal]'); if (!button) return;
    loadGoal(button.dataset.loadGoal).catch(error => { if (!error.stale && scopeIsCurrent(captureScope())) setGoalStatus(`Saved goal could not be loaded. ${error.message}`, 'error'); });
  });
  $('#refresh-goals').addEventListener('click', () => refreshGoalList().catch(error => { if (!error.stale) setGoalStatus(`Saved goals could not be refreshed. ${error.message}`, 'error'); }));

  $('#refresh-prospecting').addEventListener('click', () => refreshProspecting(state.epoch).catch(error => { if (!error.stale) setNotice(error.message, 'error'); }));
  $('#refresh-prospecting-contacts').addEventListener('click', () => refreshProspecting(state.epoch).catch(error => { if (!error.stale) setNotice(error.message, 'error'); }));
  $('#prospecting-jobs').addEventListener('click', async event => {
    const saved = event.target.closest('[data-open-saved-prospect]');
    if (saved) return openSavedProspect(saved.dataset.openSavedProspect);
    const campaignButton = event.target.closest('[data-prospecting-campaign-for]');
    if (campaignButton) return openProspectingCampaignPrep(campaignButton.dataset.prospectingBusinessName, campaignButton.dataset.prospectingAccountId, campaignButton.dataset.prospectingCampaignFor);
    const actionButton = event.target.closest('[data-prospecting-action]');
    if (actionButton) return handleProspectingJobAction(actionButton);
    const viewButton = event.target.closest('[data-prospecting-view]'); if (!viewButton) return;
    const scope = captureScope(); viewButton.disabled = true;
    try { await loadProspectingDetail(viewButton.dataset.prospectingView, scope); }
    catch (error) { if (!error.stale && scopeIsCurrent(scope)) { const detail = $('#prospecting-job-detail'); detail.className = 'result-box'; detail.textContent = error.message; } }
    finally { if (scopeIsCurrent(scope)) viewButton.disabled = false; }
  });
  $('#prospecting-job-detail').addEventListener('click', event => {
    const saved = event.target.closest('[data-open-saved-prospect]');
    if (saved) return openSavedProspect(saved.dataset.openSavedProspect);
    const button = event.target.closest('[data-prospecting-campaign-for]');
    if (button) openProspectingCampaignPrep(button.dataset.prospectingBusinessName, button.dataset.prospectingAccountId, button.dataset.prospectingCampaignFor);
  });
  $('#prospecting-contacts').addEventListener('click', event => {
    const saved = event.target.closest('[data-open-saved-prospect]');
    if (saved) return openSavedProspect(saved.dataset.openSavedProspect);
    const button = event.target.closest('[data-prospecting-campaign-for]');
    if (button) openProspectingCampaignPrep(button.dataset.prospectingBusinessName, button.dataset.prospectingAccountId, button.dataset.prospectingCampaignFor);
  });
  $('#search-result').addEventListener('click', async event => {
    const button = event.target.closest('[data-refresh-collection-job]'); if (!button) return;
    const scope = captureScope(); button.disabled = true;
    try { await loadCollectionJob(button.dataset.refreshCollectionJob, scope); }
    catch (error) { if (!error.stale && scopeIsCurrent(scope)) { const out = $('#search-result'); out.replaceChildren(text('h4', '', 'Search status unavailable'), text('p', '', error.message)); } }
  });
  $('#snapshot-form').addEventListener('submit', handleSnapshot);
  $('#source-rights-form').addEventListener('submit', handleSourceRightsSubmit);
  $('#source-rights-form [name="sourceId"]').addEventListener('change', event => {
    const scope = captureScope();
    loadSourceRights(event.currentTarget.value, scope);
  });
  $('#claim-form').addEventListener('submit', handleClaim);
  $('#qualification-form').addEventListener('submit', handleQualification);
  $('#campaign-form').addEventListener('submit', handleCampaignCreate);
  $('#offer-form').addEventListener('submit', handleOffer);
  $('#draft-form').addEventListener('submit', handleDraft);
  for (const field of [$('#draft-form').elements.subject, $('#draft-form').elements.body]) field.addEventListener('input', () => { $('#draft-form').dataset.dirty = 'true'; clearCampaignReview('The editor has unsaved changes. Load a review again after saving the exact copy you want reviewed.'); renderDraftSupport(); });
  $('#draft-fact-picker').addEventListener('change', () => {
    $('#draft-insert-facts').disabled = !$$('input[type="checkbox"]:checked', $('#draft-fact-picker')).length;
  });
  $('#draft-insert-facts').addEventListener('click', () => {
    const selected = $$('input[type="checkbox"]:checked', $('#draft-fact-picker')).map(input => state.composer?.templates?.find(item => item.templateId === input.value)).filter(Boolean);
    const placement = $('#draft-template-placement').value;
    const insertable = selected.filter(item => item.placement === placement).map(item => item.renderedText);
    const target = placement === 'subject' ? $('#draft-form').elements.subject : $('#draft-form').elements.body;
    if (placement === 'subject' && insertable.length) target.value = insertable[0];
    else target.value = appendTemplateLines(target.value, insertable);
    $$('input[type="checkbox"]:checked', $('#draft-fact-picker')).forEach(input => { input.checked = false; });
    $('#draft-insert-facts').disabled = true; $('#draft-form').dataset.dirty = 'true'; clearCampaignReview('The editor has unsaved changes. Load a review again after saving the exact copy you want reviewed.'); renderDraftSupport(); target.focus();
  });
  $('#draft-reload').addEventListener('click', () => {
    const campaignId = $('#campaign-select').value; if (!campaignId) return;
    $('#draft-reload').disabled = true; loadCampaign(campaignId, captureScope(), { hydrateDraft: true });
  });
  $('#campaign-review-refresh').addEventListener('click', loadCampaignReview);
  $('#approval-form').addEventListener('submit', handleApproval);
  $('#plan-form').addEventListener('submit', handlePlan);
  $('#outcome-form').addEventListener('submit', handleOutcome);
  $('#mailbox-form').addEventListener('submit', handleMailboxCreate);
  $('#message-import-form').addEventListener('submit', handleMessageImport);
  $('#crm-mapping-form').addEventListener('submit', handleCrmMapping);
  $('#crm-proposal-form').addEventListener('submit', handleCrmProposal);
  $('#outcome-form [name="stage"]').addEventListener('change', handleRevenueFields);
  $('#campaign-select').addEventListener('change', event => {
    clearCampaignReview(event.target.value ? 'Load the saved review for this campaign to see its current persisted copy and readiness.' : 'Select a campaign, then load its saved review.');
    const form = $('#draft-form'); form.elements.subject.value = ''; form.elements.body.value = ''; delete form.dataset.campaignId;
    form.dataset.dirty = 'false'; state.selectedCampaign = null; state.composer = null; state.composerGeneration++;
    $('#draft-account').textContent = event.target.value ? 'Loading qualified business details…' : 'Select a campaign to see its qualified business.';
    renderDraftFacts(); renderDraftTemplates(); renderDraftSupport();
    if (event.target.value) loadCampaign(event.target.value); else { $('#draft-account').textContent = 'Select a campaign to see its qualified business.'; renderDraftSupport(); }
  });
  $('#campaign-list').addEventListener('click', event => { const button = event.target.closest('[data-select-campaign]'); if (button) { $('#campaign-select').value = button.dataset.selectCampaign; clearCampaignReview('Load the saved review for this campaign to see its current persisted copy and readiness.'); $('#draft-form').elements.subject.value = ''; $('#draft-form').elements.body.value = ''; delete $('#draft-form').dataset.campaignId; $('#draft-form').dataset.dirty = 'false'; state.composer = null; state.selectedCampaign = null; state.composerGeneration++; renderDraftTemplates(); renderDraftSupport(); loadCampaign(button.dataset.selectCampaign); setView('campaigns'); } });
  $('#customer-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-audit-account]'); if (!button) return;
    const scope = captureScope();
    button.disabled = true; button.textContent = 'Creating report…';
    try { const result = await createAudit(button.dataset.auditAccount, null, scope); assertCurrentScope(scope); setNotice(`Evidence report saved: ${result.coverageStatus || 'coverage unknown'}.`, 'success'); setView('discover'); revealReport(result, $('#snapshot-result'), scope); }
    catch (error) { if (!error.stale && scopeIsCurrent(scope)) setNotice(error.message, 'error'); }
    finally { if (scopeIsCurrent(scope)) { button.disabled = false; button.textContent = 'Audit saved pages'; } }
  });
  $('#campaign-form [name="offerVersionId"]').addEventListener('change', event => {
    const offer = state.offers.find(item => String(item.latest_version_id) === event.target.value);
    const spend = $('#campaign-form [name="spendLimit"]');
    if (offer) { spend.value = '0'; spend.setAttribute('aria-label', `Maximum spend in ${offer.latest_content?.price?.currency || 'offer'} currency units`); }
  });
  $('#campaign-select').addEventListener('change', () => setNotice(''));
  $$('form').forEach(form => form.addEventListener('invalid', event => {
    setNotice('Complete the required fields before continuing.', 'error');
    if (form.id === 'prospecting-form') {
      const permissions = event.target.closest('#prospecting-permission-details');
      if (permissions) permissions.open = true;
    }
  }, true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') stopProspectingPolling();
    else {
      if (!$('#view-discover').hidden && state.prospectingDetail?.job?.id) scheduleProspectingPolling(captureScope(), state.prospectingDetail.job.id);
      state.goalResume?.();
    }
  });
}
function init() {
  bindEvents();
  let pro = false;
  try { pro = localStorage.getItem('odd-growth-pro-mode') === 'on'; } catch { /* optional presentation preference */ }
  applyProMode(pro);
  const initialSection = location.hash.match(/^#(overview|discover|campaigns|inbox|customers|analytics|settings)$/)?.[1] || 'overview';
  setView(initialSection);
  window.addEventListener('hashchange', () => {
    const section = location.hash.match(/^#(overview|discover|campaigns|inbox|customers|analytics|settings)$/)?.[1];
    if (section) setView(section);
  });
  $('#session-state').textContent = document.cookie.includes('odd_session=') ? 'Signed in' : 'Sign in required';
  loadWorkspaces();
}

init();
