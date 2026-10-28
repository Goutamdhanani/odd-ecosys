import { isCampaignLoadCurrent } from './astra-campaign-draft.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const STORE_KEY = 'odd-astra-tenant-id';
const state = { tenantId: '', role: '', tenantRole: '', busy: false, selectedEvidence: null, campaign: null, composer: null, composerScope: null, draftTemplateIds: [] };
let inspectionRequestId = 0;
let campaignSelectionEpoch = 0;

function campaignRequestIsCurrent(scope) {
  return isCampaignLoadCurrent(scope, { tenantId: state.tenantId, epoch: campaignSelectionEpoch }, state.campaignId, scope.campaignId);
}

function setNotice(message = '', kind = '') {
  const box = $('#notice');
  box.textContent = message;
  box.className = `notice${message ? ` show ${kind}` : ''}`;
}

function csrfToken() {
  const item = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('odd_csrf='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice('odd_csrf='.length)); } catch { return ''; }
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
  if (!['GET', 'HEAD'].includes(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin',
    ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 500) }; } }
  if (!response.ok) {
    const detail = data.error || data.message || `HTTP ${response.status}`;
    const statusNote = response.status === 503 && /tenant mode|astra_tenant_mode/i.test(String(detail))
      ? ' Astra tenant mode is disabled.'
      : response.status === 503 && /storage|database|configured|unavailable/i.test(String(detail))
        ? ' Astra storage or the staged offer store is not configured.' : '';
    throw new Error(`${detail}${statusNote}`);
  }
  return data;
}

function pathFor(resource = '') { return `/api/astra/tenants/${encodeURIComponent(state.tenantId)}${resource}`; }
function escapeText(value) { return value == null ? '—' : String(value); }
function node(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value !== undefined) el.textContent = escapeText(value);
  return el;
}
function button(label, action, dataset = {}) {
  const el = node('button', 'button secondary', label);
  el.type = 'button'; el.dataset.action = action;
  for (const [key, value] of Object.entries(dataset)) el.dataset[key] = String(value);
  return el;
}
function record(title, meta = '', hash = '') {
  const item = node('div', 'record');
  const top = node('div', 'record-top'); top.append(node('div', 'record-title', title)); item.append(top);
  if (meta) item.append(node('div', 'record-meta', meta));
  if (hash) item.append(node('div', 'record-hash', `SHA-256 ${hash}`));
  return item;
}
function renderList(target, rows, emptyText, renderRow) {
  const container = $(target); container.replaceChildren();
  if (!rows?.length) { container.className = 'data-list empty'; container.textContent = emptyText; return; }
  container.className = 'data-list';
  rows.forEach(row => container.append(renderRow(row)));
}
function setCount(id, rows) { $(id).textContent = rows.length ? `${rows.length} shown` : '0 shown'; }
function tenantRequired() {
  if (!state.tenantId) { setNotice('Select or create a tenant workspace first.', 'error'); return false; }
  return true;
}

function clearInvitationReveal() {
  const box = $('#invitation-link-result');
  if (!box) return;
  box.hidden = true;
  $('#invitation-link').value = '';
}

async function refreshMemberships() {
  if (!state.tenantId) return;
  const canManage = ['owner', 'admin'].includes(state.tenantRole);
  $('#membership-invite-form').hidden = !canManage;
  const ownerOption = $('#membership-invite-form').elements.role.querySelector('option[value="owner"]');
  ownerOption.hidden = state.tenantRole !== 'owner';
  ownerOption.disabled = state.tenantRole !== 'owner';
  const members = await request(pathFor('/memberships'));
  const rows = members.memberships || [];
  setCount('#membership-count', rows);
  renderList('#members-list', rows, 'No tenant membership records.', member => {
    const row = record(`${member.userId} · ${member.role}`, `${member.revokedAt ? `revoked ${member.revokedAt}` : `active · granted by ${member.grantedByUserId}`} · ${member.createdAt}`);
    if (canManage && !member.revokedAt && (state.tenantRole === 'owner' || member.role !== 'owner')) {
      const actions = node('div', 'record-actions');
      const select = node('select', 'membership-role-select');
      select.setAttribute('aria-label', `Role for member ${member.userId}`);
      for (const role of ['owner', 'admin', 'operator', 'reviewer']) {
        if (role === 'owner' && state.tenantRole !== 'owner') continue;
        const option = node('option', '', role); option.value = role; option.selected = role === member.role; select.append(option);
      }
      const save = button('Change role', 'membership-role', { userId: member.userId });
      const revoke = button('Revoke access', 'membership-revoke', { userId: member.userId });
      actions.append(select, save, revoke); row.append(actions);
    }
    return row;
  });

  if (!canManage) {
    setCount('#invitation-count', []);
    renderList('#invitations-list', [], 'Invitations are visible to tenant owners and admins.', () => node('div'));
    return;
  }
  const invitations = await request(pathFor('/memberships/invitations'));
  const invites = invitations.invitations || [];
  setCount('#invitation-count', invites);
  renderList('#invitations-list', invites, 'No invitations have been created.', invitation => {
    const status = invitation.acceptedAt ? `accepted ${invitation.acceptedAt}`
      : invitation.revokedAt ? `revoked ${invitation.revokedAt}`
        : new Date(invitation.expiresAt).getTime() <= Date.now() ? `expired ${invitation.expiresAt}` : `pending · expires ${invitation.expiresAt}`;
    const row = record(`${invitation.email} · ${invitation.role}`, `${status} · created by ${invitation.createdByUserId}`);
    if (!invitation.acceptedAt && !invitation.revokedAt && new Date(invitation.expiresAt).getTime() > Date.now()
      && (state.tenantRole === 'owner' || invitation.role !== 'owner')) {
      const actions = node('div', 'record-actions');
      actions.append(button('Revoke invitation', 'invitation-revoke', { invitationId: invitation.id })); row.append(actions);
    }
    return row;
  });
}

async function checkSession() {
  try {
    const status = await request('/api/auth/status');
    state.role = status?.user?.role || status?.role || '';
    $('#session-state').textContent = status?.authenticated === false ? 'Sign-in required' : 'Authenticated session';
  } catch (error) {
    $('#session-state').textContent = 'Session unavailable';
    setNotice(`Could not verify the current session. ${error.message}`, 'error');
  }
}

async function selectTenant(id) {
  const nextTenantId = String(id || '').trim();
  if (state.tenantId && state.tenantId !== nextTenantId) clearData();
  clearInvitationReveal();
  state.tenantId = nextTenantId;
  $('#tenant-id').value = state.tenantId;
  if (!state.tenantId) return;
  try {
    const result = await request(pathFor('/context'));
    const tenant = result.tenant || {};
    state.role = tenant.role || state.role;
    state.tenantRole = tenant.role || '';
    localStorage.setItem(STORE_KEY, tenant.id || state.tenantId);
    state.tenantId = tenant.id || state.tenantId;
    $('#tenant-id').value = state.tenantId;
    $('#tenant-context').textContent = `${tenant.name || 'Tenant'} · ${tenant.role || 'membership'} · ${tenant.status || 'active'} · ${state.tenantId}`;
    setNotice('Tenant context verified.', 'success');
    await refreshAll();
  } catch (error) {
    $('#tenant-context').textContent = 'Tenant context could not be verified. The saved ID is retained for retry.';
    setNotice(error.message, 'error');
    clearData();
  }
}

function clearData() {
  inspectionRequestId++;
  campaignSelectionEpoch++;
  state.tenantRole = '';
  clearInvitationReveal();
  $('#membership-invite-form').hidden = true;
  state.selectedEvidence = null;
  state.campaignId = null; state.campaign = null; state.composer = null; state.composerScope = null; state.draftTemplateIds = []; state.researchIdentities = [];
  for (const id of ['#members-list', '#invitations-list', '#events-list', '#outcomes-list', '#offers-list', '#workflows-list', '#evidence-list', '#source-collection-jobs', '#candidates-list', '#claims-list', '#permissions-list', '#suppressions-list', '#mailboxes-list', '#messages-list', '#reply-tasks-list', '#mappings-list', '#outbox-list', '#audit-result', '#campaigns-list', '#campaign-plans', '#experiments-list', '#connectors-list', '#connector-jobs-list', '#decisions-list', '#authorizations-list', '#exceptions-list', '#eval-datasets-list', '#eval-runs-list', '#lifecycle-list', '#radar-watches-list', '#radar-signals-list', '#learning-artifacts-list', '#postsale-projects-list', '#benchmark-cohorts-list', '#benchmark-quotes-list', '#launch-releases-list']) renderList(id, [], 'Tenant data is unavailable.', () => node('div'));
  $('#ai-status').textContent = 'Tenant gateway status is unavailable.';
  $('#research-selected').textContent = 'No evidence selected.'; $('#permission-evaluation').textContent = 'No permission evaluation run.';
  $('#campaign-detail').textContent = 'Select a campaign for qualification, draft, approval, and offline planning.';
  resetCampaignDraft();
  $('#generation-status').textContent = 'Generation status is unavailable.'; $('#generation-job-status').textContent = 'No generation job loaded.';
  $('#operations-status').textContent = 'Operations status is unavailable.';
  $('#evaluation-status').textContent = 'Evaluation status is unavailable.';
  $('#lifecycle-status').textContent = 'Lifecycle data is unavailable.'; $('#lifecycle-inventory').textContent = 'Inventory is unavailable.';
  $('#radar-status').textContent = 'Radar data is unavailable.'; $('#learning-status').textContent = 'Learning data is unavailable.';
  $('#economics-status').textContent = 'Economics data is unavailable.'; $('#launch-status').textContent = 'Launch data is unavailable.'; $('#launch-validation').textContent = 'Validation reports are unavailable.';
  $('#source-collection-status').textContent = 'Source collection data is unavailable.';
  $('#customer-approval-status').textContent = 'No customer key or approval action submitted.';
  $('#benchmark-status').textContent = 'No benchmark selected.';
  for (const id of ['#source-fetch-form', '#source-search-form', '#customer-key-enroll-form', '#customer-key-confirm-form', '#customer-challenge-form', '#customer-signature-form', '#customer-approval-status-form', '#benchmark-prepare-form', '#benchmark-actions-form', '#benchmark-quote-form', '#benchmark-quote-review-form', '#launch-validation-form', '#learning-optimizer-form', '#learning-optimizer-action-form']) $(id).reset();
  $('#automation-status').textContent = 'Worker status is unavailable.'; $('#memory-result').textContent = 'No memory recall loaded.'; $('#analytics-result').textContent = 'Analytics are unavailable.'; $('#experiment-analysis').textContent = 'No experiment analysis loaded.';
  $('#audit-form').elements.evidenceId.value = ''; $('#claim-form').elements.evidenceId.value = ''; $('#claim-form').elements.contentSha256.value = '';
  for (const id of ['#membership-count', '#invitation-count', '#event-count', '#outcome-count', '#offer-count', '#workflow-count', '#evidence-count', '#candidate-count', '#claim-count', '#permission-count', '#suppression-count', '#mailbox-count', '#message-count', '#reply-count', '#mapping-count', '#outbox-count', '#campaign-count', '#experiment-count', '#connector-count', '#connector-job-count', '#decision-count', '#authorization-count', '#exception-count', '#eval-dataset-count', '#eval-run-count', '#lifecycle-count', '#radar-watch-count', '#radar-signal-count', '#learning-count', '#postsale-project-count', '#launch-release-count']) $(id).textContent = '—';
}

async function refreshLedger() {
  const [eventsResult, outcomesResult] = await Promise.all([
    request(pathFor('/events?limit=100')),
    request(pathFor('/outcomes?limit=100')),
  ]);
  const events = eventsResult.data || [], outcomes = outcomesResult.data || [];
  setCount('#event-count', events); setCount('#outcome-count', outcomes);
  renderList('#events-list', events, 'No events recorded for this tenant.', event => {
    const item = record(`${event.sequence || '?'} · ${event.eventType}`, `event ${event.id} · ${event.entityType}:${event.entityId} · ${event.occurredAt} · ${event.provenance?.source || 'source unknown'}`, event.eventHash);
    const payload = node('div', 'record-meta', JSON.stringify(event.payload || {})); item.append(payload);
    return item;
  });
  renderList('#outcomes-list', outcomes, 'No outcome projections recorded for this tenant.', outcome => {
    const stateText = JSON.stringify(outcome.state || {});
    const item = record(`${outcome.entityType}:${outcome.entityId}`, `Latest sequence ${outcome.latestSequence || '—'} · event ${outcome.latestEventId || '—'} · updated ${outcome.updatedAt || '—'}`);
    item.append(node('div', 'record-meta', stateText)); return item;
  });
}

function offerRecord(offer) {
  const item = record(`${offer.name} · offer ${offer.id}`, `Version ${offer.latest_version ?? '—'} · ${offer.latest_status || 'no status'} · created ${offer.created_at || '—'}`, offer.latest_content_hash);
  const actions = node('div', 'record-actions');
  if (offer.latest_version_id) {
    const approve = button('Approve latest', 'approve-offer', { offerId: offer.id, versionId: offer.latest_version_id });
    approve.disabled = !['owner', 'admin'].includes(state.role);
    approve.title = approve.disabled ? 'Tenant owner or admin membership required' : '';
    actions.append(approve);
    if (offer.latest_status === 'approved') actions.append(button('Use approved version', 'select-approved-offer', { versionId: offer.latest_version_id }));
  }
  const use = button('Use for new version', 'version-prefill', { offerId: offer.id }); actions.append(use);
  item.append(actions); return item;
}

async function refreshOffers() {
  const result = await request(pathFor('/offers'));
  const offers = result.offers || [];
  setCount('#offer-count', offers); renderList('#offers-list', offers, 'No tenant offers yet.', offerRecord);
}

function workflowRecord(workflow) {
  const item = record(`${workflow.taskType || workflow.task_type || 'Workflow'} · ${workflow.id}`, `${workflow.state} · ${workflow.taskClass || 'standard'} · ${workflow.availableAt || workflow.createdAt || '—'}`);
  const selection = node('label', 'check-label');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'benchmarkWorkflow'; checkbox.value = workflow.id;
  checkbox.setAttribute('aria-label', `Select existing workflow ${workflow.id} as a benchmark observation input`);
  selection.append(checkbox, node('span', '', 'Select for benchmark observation')); item.append(selection);
  if (['queued', 'checkpointed'].includes(workflow.state)) {
    const actions = node('div', 'record-actions');
    const cancel = button('Cancel queued workflow', 'cancel-workflow', { workflowId: workflow.id });
    cancel.disabled = !['owner', 'admin', 'operator'].includes(state.role);
    actions.append(cancel); item.append(actions);
  }
  return item;
}

async function refreshWorkflows() {
  const result = await request(pathFor('/workflows?limit=50'));
  const rows = result.data || [];
  setCount('#workflow-count', rows); renderList('#workflows-list', rows, 'No workflows are queued for this tenant.', workflowRecord);
}

async function refreshAi() {
  const result = await request(pathFor('/ai'));
  const status = result.data || {};
  const p = status.policy || {}, g = status.global || {};
  const box = $('#ai-status'); box.replaceChildren(); box.className = 'status-box';
  const grid = node('div', 'status-lines');
  const pairs = [
    ['Tenant policy', p.enabled ? 'Enabled' : 'Disabled'], ['Global gateway', g.enabled ? 'Enabled' : 'Disabled'],
    ['Egress', status.egressEnabled ? 'Enabled' : 'Disabled'], ['Breaker', g.breakerState || 'unknown'],
    ['Provider', status.provider || '—'], ['Model', status.model || '—'],
    ['Allowed tasks', (p.allowedTasks || []).join(', ') || 'None'], ['Daily budget (micro-USD)', p.dailyBudgetMicrousd ?? 0],
  ];
  pairs.forEach(([label, value]) => { const cell = node('div'); cell.append(node('strong', '', label), node('span', '', value)); grid.append(cell); });
  box.append(grid);
  const form = $('#ai-policy-form');
  form.elements.enabled.checked = Boolean(p.enabled);
  for (const option of form.elements.allowedTasks.options) option.selected = (p.allowedTasks || []).includes(option.value);
  form.elements.dailyBudgetMicrousd.value = p.dailyBudgetMicrousd ?? 0;
  form.elements.reservationMicrousd.value = p.reservationMicrousd ?? 0;
  form.elements.maxInputTokens.value = p.maxInputTokens ?? 0;
  form.elements.maxOutputTokens.value = p.maxOutputTokens ?? 0;
}

async function inspectEvidence(evidenceId) {
  const requestId = ++inspectionRequestId;
  const tenantId = state.tenantId;
  const tenantPath = `/api/astra/tenants/${encodeURIComponent(tenantId)}`;
  const isCurrent = () => requestId === inspectionRequestId && tenantId === state.tenantId;
  try {
    const result = await request(`${tenantPath}/research/evidence/${encodeURIComponent(evidenceId)}`);
    if (!isCurrent()) return;
    const evidence = result.data;
    const identities = await request(`${tenantPath}/research/identities?limit=100`);
    if (!isCurrent()) return;
    const account = (identities.data || []).find(row => row.normalizedDomain === evidence.normalizedDomain);
    let candidates = [];
    if (account) {
      const candidateResult = await request(`${tenantPath}/research/identities/${encodeURIComponent(account.id)}/candidates`);
      if (!isCurrent()) return;
      candidates = candidateResult.data || [];
    }

    if (!isCurrent()) return;
    state.selectedEvidence = evidence;
    $('#research-selected').replaceChildren(); $('#research-selected').className = 'status-box';
    $('#research-selected').append(
      node('div', 'record-title', `${evidence.documentTitle || evidence.normalizedDomain} · ${evidence.coverageStatus}`),
        node('div', 'record-meta', `Evidence ID ${evidence.id}`),
      node('div', 'record-meta', `Source ${evidence.sourceUrl} · rights ${evidence.rightsPolicy}${evidence.rightsExpiresAt ? ` through ${evidence.rightsExpiresAt}` : ''} · sourceContentUntrusted=${evidence.sourceContentUntrusted}`),
      node('div', 'record-hash', `SHA-256 ${evidence.contentSha256}`),
    );
    $('#audit-form').elements.evidenceId.value = evidence.id;
    const claim = $('#claim-form').elements;
    claim.evidenceId.value = evidence.id;
    claim.contentSha256.value = evidence.contentSha256;
    claim.exactExcerpt.value = '';
    if (account) {
      $('#research-selected').append(node('div', 'record-meta', `Research account ID ${account.id} · ${account.normalizedDomain}`));
        const actions = node('div', 'record-actions');
        actions.append(
          button('Add account ID to campaign / experiment', 'select-account', { accountId: account.id }),
          button('Use as memory source', 'select-memory-source', { evidenceId: evidence.id, accountId: account.id }),
        );
        $('#research-selected').append(actions);
    }
    setCount('#candidate-count', candidates);
    renderList('#candidates-list', candidates, 'No candidates extracted from this snapshot.', candidate => {
      const item = record(candidate.displayValue, `candidate ${candidate.id} · ${candidate.candidateType} · ${candidate.verificationState} · evidence ${candidate.evidenceId}`, candidate.contentSha256);
      if (candidate.exactExcerpt) item.append(node('div', 'record-meta', candidate.exactExcerpt));
      const actions = node('div', 'record-actions'); actions.append(button('Use for campaign verification', 'select-verification-candidate', { candidateId: candidate.id, evidenceId: candidate.evidenceId })); item.append(actions);
      return item;
    });
    setNotice('Evidence loaded. Extracted content remains untrusted and candidates are unverified.', 'success');
  } catch (error) {
    // Keep the current failure useful while making the identity check and notice
    // mutation one synchronous operation; callers cannot reopen a stale-error gap.
    if (isCurrent()) setNotice(error.message, 'error');
  }
}

$('#research-selected').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="select-account"]'); if (!target) return;
  for (const selector of ['#qualification-form input[name="accountIds"]', '#assignment-form input[name="accountIds"]']) {
    const input = $(selector), entries = input.value.split(',').map(value => value.trim()).filter(Boolean);
    if (!entries.includes(target.dataset.accountId)) entries.push(target.dataset.accountId);
    input.value = entries.join(', ');
  }
  setNotice(`Account ${target.dataset.accountId} added to campaign qualification and experiment assignment forms.`, 'success');
});

$('#research-selected').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="select-memory-source"]'); if (!target) return;
  const form = $('#memory-form');
  form.elements.sourceKind.value = 'evidence';
  form.elements.sourceId.value = target.dataset.evidenceId;
  form.elements.subjectType.value = 'account';
  form.elements.subjectId.value = target.dataset.accountId;
  if (state.selectedEvidence) {
    form.elements.rightsPolicy.value = state.selectedEvidence.rightsPolicy || '';
    form.elements.rightsExpiresAt.value = state.selectedEvidence.rightsExpiresAt ? localDateInput(Date.parse(state.selectedEvidence.rightsExpiresAt)) : '';
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setNotice('Evidence source, account, and rights copied. Select the matching active permission decision before saving memory.', 'success');
});

$('#candidates-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="select-verification-candidate"]'); if (!target) return;
  $('#verification-form').elements.candidateId.value = target.dataset.candidateId;
  $('#verification-form').elements.evidenceId.value = target.dataset.evidenceId;
  $('#verification-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setNotice('Candidate and its captured evidence loaded. Only negative or unknown classifications are accepted.', 'success');
});

function researchItem(evidence) {
  const item = record(evidence.documentTitle || evidence.normalizedDomain || evidence.sourceUrl,
    `${evidence.coverageStatus} · ${evidence.rightsPolicy} · ${evidence.capturedAt} · ${evidence.byteLength} bytes${evidence.sourceContentUntrusted ? ' · untrusted' : ''}`, evidence.contentSha256);
  const actions = node('div', 'record-actions');
  const selectLabel = node('label', 'check-label');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'selectedEvidence'; checkbox.value = evidence.id; checkbox.setAttribute('aria-label', `Select evidence ${evidence.id} for bounded research`);
  selectLabel.append(checkbox, node('span', '', 'Queue input')); actions.append(selectLabel);
  actions.append(button('Inspect / candidates', 'inspect-evidence', { evidenceId: evidence.id }));
  item.append(actions); return item;
}

async function refreshResearch() {
  const [evidenceResult, claimsResult] = await Promise.all([
    request(pathFor('/research/evidence?limit=50')),
    request(pathFor('/research/claims?limit=50')),
  ]);
  const evidence = evidenceResult.data || [], claims = claimsResult.data || [];
  setCount('#evidence-count', evidence); setCount('#claim-count', claims);
  renderList('#evidence-list', evidence, 'No snapshots captured for this tenant.', researchItem);
  renderList('#claims-list', claims, 'No claims recorded for this tenant.', claim => {
    return record(`${claim.subjectKey} · ${claim.predicate} = ${claim.value}`, `${claim.status}${claim.abstainReason ? ` · ${claim.abstainReason}` : ''} · expires ${claim.expiresAt} · evidence ${claim.evidenceId}`, claim.contentSha256);
  });
  state.researchIdentities = (await request(pathFor('/research/identities?limit=100'))).data || [];
}

async function refreshSourceCollection() {
  const box = $('#source-collection-status');
  try {
    const result = await request(pathFor('/collection/jobs?limit=50'));
    const jobs = result.jobs || [];
    renderList('#source-collection-jobs', jobs, 'No source collection jobs recorded.', job => {
      const blockers = job.blockedReason || job.errorCode || 'none reported';
      const row = record(`${job.jobType || 'source'} · ${job.status || 'unknown'}`, `job ${job.id} · blocker ${blockers} · results ${job.resultCount ?? 'unknown'} · evidence ${job.evidenceId || 'none'} · ${job.updatedAt || job.createdAt || 'time unknown'}`);
      if (job.status === 'queued' && ['operator'].includes(state.tenantRole)) {
        const actions = node('div', 'record-actions');
        actions.append(button('Run this job once', 'source-collection-run', { jobId: job.id }));
        row.append(actions);
      }
      return row;
    });
    const blocked = jobs.filter(job => job.status === 'blocked').length;
    box.className = 'status-box';
    box.textContent = `Loaded ${jobs.length} jobs · ${blocked} blocked · ${jobs.filter(job => job.status === 'queued').length} queued · ${jobs.filter(job => job.status === 'running').length} running. Block reasons are server reported; remote transport remains server gated and releaseReady=false.`;
  } catch (error) {
    renderList('#source-collection-jobs', [], 'Source collection job status is unavailable.', () => node('div'));
    box.className = 'status-box blocked-note';
    box.textContent = `Source collection status unavailable: ${error.message}`;
    throw error;
  }
}

async function refreshPermissions() {
  const [permissionsResult, suppressionResult] = await Promise.all([
    request(pathFor('/permissions')), request(pathFor('/suppressions')),
  ]);
  const permissions = permissionsResult.items || [], suppressions = suppressionResult.items || [];
  setCount('#permission-count', permissions); setCount('#suppression-count', suppressions);
  renderList('#permissions-list', permissions, 'No permission decisions recorded.', entry => record(
    `${entry.subject_type}:${entry.subject_value} · ${entry.decision}`,
    `decision ${entry.id} · ${entry.purpose} · ${entry.lawful_basis} · ${entry.geography} · ${entry.consent_expires_at || 'no expiry'}`,
  ));
  renderList('#suppressions-list', suppressions, 'No suppression decisions recorded.', entry => record(
    `${entry.scope}:${entry.scope_value}`, `${entry.reason} · ${entry.created_at}`,
  ));
}

async function refreshInbox() {
  const [mailboxResult, messageResult, taskResult, mappingResult, outboxResult] = await Promise.all([
    request(pathFor('/mailboxes')), request(pathFor('/inbox/messages?limit=50')),
    request(pathFor('/reply-tasks?limit=50')), request(pathFor('/crm/mappings')),
    request(pathFor('/crm/outbox?limit=50')),
  ]);
  const mailboxes = mailboxResult.items || [], messages = messageResult.items || [], tasks = taskResult.items || [];
  const mappings = mappingResult.items || [], outbox = outboxResult.items || [];
  setCount('#mailbox-count', mailboxes); setCount('#message-count', messages); setCount('#reply-count', tasks);
  setCount('#mapping-count', mappings); setCount('#outbox-count', outbox);
  renderList('#mailboxes-list', mailboxes, 'No manual mailboxes created.', mailbox => {
    const item = record(`${mailbox.displayName} · ${mailbox.id}`, `${mailbox.provider} · config ${mailbox.configurationStatus} · receive ${mailbox.capabilities?.receive} · send ${mailbox.capabilities?.send}`);
    const actions = node('div', 'record-actions'); actions.append(button('Use for message ingest', 'select-mailbox', { mailboxId: mailbox.id })); item.append(actions); return item;
  });
  renderList('#messages-list', messages, 'No inbox messages ingested.', message => {
    const item = record(message.subject || '(no subject)', `${message.sender || 'unknown sender'} · ${message.receivedAt} · ${message.threadId}`, message.contentHash || '');
    item.append(node('div', 'record-meta', message.bodyText || ''));
    const actions = node('div', 'record-actions'); actions.append(button('Create deterministic reply task', 'create-reply-task', { messageId: message.id })); item.append(actions); return item;
  });
  renderList('#reply-tasks-list', tasks, 'No reply tasks waiting for review.', task => {
    const item = record(`${task.classification} · ${task.status}`, `${task.classificationMethod} · ${task.createdAt} · ${task.message?.sender || ''} · ${task.message?.subject || ''}`);
    item.append(node('div', 'record-meta', task.message?.bodyText || ''), node('div', 'record-meta', JSON.stringify(task.proposal || {})));
    if (task.status === 'needs_review') {
      const note = document.createElement('input'); note.placeholder = 'Review note (optional)'; note.setAttribute('aria-label', 'Reply task review note');
      const actions = node('div', 'record-actions'); actions.append(note, button('Approve', 'review-reply', { taskId: task.id, decision: 'approved' }), button('Reject', 'review-reply', { taskId: task.id, decision: 'rejected' })); item.append(actions);
    }
    return item;
  });
  renderList('#mappings-list', mappings, 'No CRM mappings recorded.', mapping => record(`${mapping.entity_type}:${mapping.entity_id} → ${mapping.external_id}`, `${mapping.provider} · ${mapping.created_at}`));
  renderList('#outbox-list', outbox, 'No CRM proposals recorded.', proposal => record(`${proposal.entity_type}:${proposal.entity_id} · ${proposal.state}`, `${proposal.operation} · ${proposal.provider} · ${proposal.created_at} · outbound transport disabled`));
}

async function refreshCampaigns() {
  const result = await request(pathFor('/campaigns?limit=50'));
  const campaigns = result.items || [];
  setCount('#campaign-count', campaigns);
  renderList('#campaigns-list', campaigns, 'No campaign records in this tenant.', campaign => {
    const item = record(`${campaign.name} · ${campaign.state} · v${campaign.version}`, `Offer v${campaign.offerVersionId} · mailbox ${campaign.mailboxId} · ${campaign.currency} ${campaign.spendLimitMinor} · ${campaign.scheduleAt || 'unscheduled'}`, campaign.offerContentHash);
    const actions = node('div', 'record-actions'); actions.append(button('Select campaign', 'select-campaign', { campaignId: campaign.id })); item.append(actions); return item;
  });
}

function resetCampaignDraft() {
  const form = $('#draft-form');
  if (!form) return;
  form.reset();
  state.draftTemplateIds = []; state.draftBodySnapshot = '';
  $('#draft-template-list').className = 'data-list empty';
  $('#draft-template-list').textContent = 'Select a campaign to load current copy templates.';
  $('#draft-validation').className = 'status-box empty';
  $('#draft-validation').textContent = 'Select a campaign to load current copy validation.';
  form.querySelector('[type="submit"]').disabled = true;
  $('#approval-form').querySelector('[type="submit"]').disabled = true;
}

function campaignDraftAssessment() {
  const composer = state.composer;
  const form = $('#draft-form');
  const bound = Boolean(composer && state.composerScope && campaignRequestIsCurrent(state.composerScope)
    && composer.campaignId === state.campaignId);
  if (!bound) return { valid: false, saved: false, lines: [], bodyTemplates: [] };
  const templates = composer?.templates || [];
  const subject = form.elements.subject.value;
  const body = form.elements.body.value;
  const subjectTemplate = templates.find(item => item.placement === 'subject' && item.renderedText === subject);
  const lines = body ? body.split('\n') : [];
  const bodyTemplates = lines.map((line, index) => templates.find(item => item.placement === 'body'
    && item.templateId === state.draftTemplateIds[index] && item.renderedText === line));
  const valid = Boolean(composer && subjectTemplate && lines.length > 0 && lines.length <= 50
    && lines.every(line => line.length > 0) && bodyTemplates.every(Boolean)
    && new Set(bodyTemplates.map(item => item.templateId)).size === bodyTemplates.length);
  const saved = Boolean(valid && composer.validation?.status === 'verified' && composer.validation?.eligible === true
    && composer.subject === subject && composer.body === body);
  return { valid, saved, lines, bodyTemplates };
}

function renderCampaignDraft({ resetEditor = true } = {}) {
  const composer = state.composer;
  if (!composer) { resetCampaignDraft(); return; }
  const form = $('#draft-form');
  if (resetEditor) {
    form.elements.subject.value = composer.subject || 'Research note';
    form.elements.body.value = composer.body || '';
    const lines = form.elements.body.value ? form.elements.body.value.split('\n') : [];
    const proofIds = Array.isArray(composer.validation?.proofs) ? composer.validation.proofs.map(item => item.templateId) : [];
    state.draftTemplateIds = lines.map((line, index) => {
      if (proofIds[index]) return proofIds[index];
      const matches = (composer.templates || []).filter(item => item.placement === 'body' && item.renderedText === line);
      return matches.length === 1 ? matches[0].templateId : null;
    });
    state.draftBodySnapshot = form.elements.body.value;
  }
  const templates = (composer.templates || []).filter(item => item.placement === 'body');
  const list = $('#draft-template-list');
  list.replaceChildren();
  if (!templates.length) {
    list.className = 'data-list empty';
    list.textContent = 'No current source-attributed copy templates are available for this campaign.';
  } else {
    list.className = 'data-list';
    templates.forEach(template => {
      const item = node('div', 'record');
      item.append(node('div', 'record-title', template.renderedText));
      const source = template.source || {};
      item.append(node('div', 'record-meta', `Source: ${source.url || 'unavailable'} · Exact excerpt: ${source.exactExcerpt || 'unavailable'}`));
      const actions = node('div', 'record-actions');
      actions.append(button('Insert exact sentence', 'insert-copy-template', { templateId: template.templateId }));
      item.append(actions); list.append(item);
    });
  }
  const { valid, saved } = campaignDraftAssessment();
  const validation = $('#draft-validation');
  const serverReasons = Array.isArray(composer.validation?.reasons) ? composer.validation.reasons.join(', ') : '';
  validation.className = `status-box${saved ? '' : ' empty'}`;
  validation.textContent = saved
    ? `Verified and saved against current source evidence · campaign version ${composer.version}.`
    : valid
      ? `Exact source templates selected. Save this copy against campaign version ${composer.version} before approval.${composer.validation?.status === 'unverified' ? ` Current saved copy is unverified${serverReasons ? `: ${serverReasons}` : '.'}` : ''}`
      : `Unverified: subject and every body line must match the current server-provided source templates exactly.${serverReasons ? ` Current server validation: ${serverReasons}.` : ''} Campaign version ${composer.version}.`;
  form.querySelector('[type="submit"]').disabled = !valid || saved;
  $('#approval-form').querySelector('[type="submit"]').disabled = !saved;
}

async function selectCampaign(campaignId) {
  const scope = { tenantId: state.tenantId, epoch: ++campaignSelectionEpoch, campaignId: String(campaignId) };
  state.campaignId = scope.campaignId;
  state.campaign = null; state.composer = null; state.composerScope = null; state.draftTemplateIds = [];
  resetCampaignDraft();
  $('#qualification-result').textContent = 'No qualification run.';
  $('#campaign-detail').textContent = 'Loading current campaign and copy evidence…';
  const result = await request(pathFor(`/campaigns/${encodeURIComponent(scope.campaignId)}`));
  if (!campaignRequestIsCurrent(scope)) return;
  const campaign = result.campaign;
  const composerResult = await request(pathFor(`/campaigns/${encodeURIComponent(scope.campaignId)}/composer`));
  const composer = composerResult.composer || null;
  if (!campaignRequestIsCurrent(scope) || composer?.campaignId !== scope.campaignId) return;
  const { approvals = [], dispatchPlans = [] } = result;
  state.campaign = campaign;
  state.composer = composer;
  state.composerScope = scope;
  renderCampaignDraft();
  $('#campaign-detail').className = 'status-box';
  $('#campaign-detail').textContent = JSON.stringify({ campaign, approvals, dispatchPlans }, null, 2);
  renderList('#campaign-plans', [...approvals.map(item => ({ kind: 'approval', ...item })), ...dispatchPlans.map(item => ({ kind: 'plan', ...item }))], 'No approvals or offline plans for this campaign.', item => {
    const content = item.kind === 'approval' ? item : item.plan || item;
    const title = item.kind === 'approval' ? `Approval ${item.current ? 'current' : 'expired or stale'}` : `Offline plan ${content.status || 'prepared'}`;
    const meta = item.kind === 'approval' ? `${item.id} · expires ${item.expiresAt}` : `${item.id} · ${content.liveTransport || 'disabled'} · ${content.blockers?.join(', ') || 'no recorded blockers'}`;
    const row = record(title, meta, item.approvalHash || item.planHash);
    if (item.kind === 'plan') {
      const actions = node('div', 'record-actions'); actions.append(button('Select plan for quarantine', 'select-plan', { planId: item.id })); row.append(actions);
    }
    return row;
  });
  for (const id of ['#authorization-form', '#authorization-action-form', '#exception-form', '#exception-approve-form', '#generation-campaign-form']) {
    const field = $(id).elements.campaignId;
    if (field) field.value = campaignId;
  }
  await refreshAutonomyCampaign(campaignId);
}

function parseJsonField(form, name, label, fallback = undefined) {
  const value = form.elements[name].value.trim();
  if (!value && fallback !== undefined) return fallback;
  try { return JSON.parse(value); } catch { throw new Error(`${label} JSON could not be parsed.`); }
}

async function refreshConnectors() {
  const [connectorsResult, jobsResult, generationResult] = await Promise.all([
    request(pathFor('/connectors')), request(pathFor('/connectors/jobs?limit=100')), request(pathFor('/generation')),
  ]);
  const connectors = connectorsResult.items || [], jobs = jobsResult.items || [];
  setCount('#connector-count', connectors); setCount('#connector-job-count', jobs);
  renderList('#connectors-list', connectors, 'No provider connectors configured.', connector => {
    const item = record(`${connector.provider} · ${connector.connector_key} · ${connector.state}`, `ID ${connector.id} · ${connector.endpoint_host || 'endpoint host not set'} · ${connector.approvalBlocker || (connector.transportApprovalReady ? 'approval evidence ready' : 'transport disabled or approval incomplete')}`);
    const actions = node('div', 'record-actions'); actions.append(button('Use connector ID', 'select-connector', { connectorId: connector.id })); item.append(actions); return item;
  });
  renderList('#connector-jobs-list', jobs, 'No connector tasks queued.', job => record(
    `${job.jobType} · ${job.state}`, `job ${job.id} · connector ${job.connectorId} · ${job.diagnosticCode || 'no diagnostic'} · ${job.updatedAt || job.createdAt}`,
  ));
  const generation = generationResult.data || generationResult;
  $('#generation-status').className = 'status-box';
  $('#generation-status').textContent = JSON.stringify(generation, null, 2);
  const policy = generation.policy || {};
  const form = $('#generation-policy-form');
  form.elements.enabled.checked = policy.enabled === true;
  for (const option of form.elements.allowedTasks.options) option.selected = (policy.allowedTasks || []).includes(option.value);
  form.elements.dailyBudgetMicrousd.value = Number(policy.dailyBudgetMicrousd || 0);
  form.elements.reservationMicrousd.value = Number(policy.reservationMicrousd || 0);
  form.elements.maxInputTokens.value = Number(policy.maxInputTokens || 0);
  form.elements.maxOutputTokens.value = Number(policy.maxOutputTokens || 0);
}

async function loadGenerationJob(jobId) {
  const result = await request(pathFor(`/generation/jobs/${encodeURIComponent(jobId)}`));
  const job = result.data || result;
  $('#generation-job-status').className = 'status-box';
  $('#generation-job-status').textContent = JSON.stringify(job, null, 2);
  $('#generation-run-form').elements.jobId.value = job.id || jobId;
  return job;
}

async function refreshDecisions() {
  const result = await request(pathFor('/decisions?limit=100'));
  const items = result.items || [];
  setCount('#decision-count', items);
  renderList('#decisions-list', items, 'No structured decisions recorded.', item => record(
    `${item.action} · policy ${item.policyStatus || 'unknown'}`, `decision ${item.id} · ${item.target || 'no target'} · ${item.basis || 'unknown basis'} · ${item.createdAt || ''}`, item.decisionHash,
  ));
  if (state.campaignId) await refreshAutonomyCampaign(state.campaignId);
}

async function refreshAutonomyCampaign(campaignId) {
  if (!campaignId) return;
  const [authorizationResult, exceptionResult] = await Promise.all([
    request(pathFor(`/autonomy/campaigns/${encodeURIComponent(campaignId)}/authorizations`)),
    request(pathFor(`/autonomy/campaigns/${encodeURIComponent(campaignId)}/exceptions`)),
  ]);
  const authorizations = authorizationResult.items || [], exceptions = exceptionResult.items || [];
  setCount('#authorization-count', authorizations); setCount('#exception-count', exceptions);
  renderList('#authorizations-list', authorizations, 'No campaign authorization envelopes recorded.', item => record(
    `Envelope v${item.version} · ${item.state || (item.approved ? 'approved' : 'pending approval')} · ${item.mode || ''}`,
    `${item.id} · expires ${item.expiresAt || item.expires_at || 'unknown'} · ${item.envelopeHash || item.envelope_hash || 'hash unavailable'}`,
    item.envelopeHash || item.envelope_hash,
  ));
  renderList('#exceptions-list', exceptions, 'No exact exception reviews recorded.', item => record(
    `${item.state || item.status || 'pending'} · ${item.id}`, `recipient ${item.recipientId || item.recipient_id || '—'} · authorization ${item.authorizationId || item.authorization_id || '—'} · ${item.reason || 'owner review required'}`,
  ));
}

async function refreshEvaluation() {
  const [datasetsResult, candidatesResult, scorersResult, runsResult] = await Promise.all([
    request(pathFor('/evaluation/datasets?limit=50')), request(pathFor('/evaluation/candidates?limit=50')),
    request(pathFor('/evaluation/scorers?limit=50')), request(pathFor('/evaluation/runs?limit=50')),
  ]);
  const datasets = datasetsResult.items || [], candidates = candidatesResult.items || [], scorers = scorersResult.items || [], runs = runsResult.items || [];
  setCount('#eval-dataset-count', datasets); setCount('#eval-run-count', runs);
  renderList('#eval-datasets-list', datasets, 'No frozen evaluation datasets.', dataset => record(
    `${dataset.name} · ${dataset.status} · ${dataset.exampleCount} examples`, `dataset ${dataset.id} · ${dataset.holdoutCount} holdout · manifest ${dataset.manifestSha256}`, dataset.manifestSha256,
  ));
  renderList('#eval-runs-list', runs, 'No offline evaluation runs.', run => {
    const item = record(`${run.state} · ${run.id}`, `dataset ${run.datasetId} · scorer ${run.scorerId} · report ${run.reportSha256 || 'pending'} · ${run.errorCode || 'no error'}`, run.snapshotSha256);
    const actions = node('div', 'record-actions'); actions.append(button('Load report/status', 'load-eval-run', { runId: run.id })); item.append(actions); return item;
  });
  $('#evaluation-status').className = 'status-box';
  $('#evaluation-status').textContent = JSON.stringify({ executionMode: candidatesResult.executionMode || scorersResult.executionMode, providerCalls: candidatesResult.providerCalls ?? scorersResult.providerCalls, releaseReady: runsResult.releaseReady, candidates, scorers }, null, 2);
}

async function refreshFeaturePanels() {
  const jobs = await Promise.allSettled([refreshConnectors(), refreshDecisions()]);
  const errors = jobs.flatMap((item, index) => item.status === 'rejected' ? [`${index ? 'decisions' : 'connectors'}: ${item.reason.message}`] : []);
  if (errors.length) setNotice(errors.join('\n'), 'error');
}

async function refreshOperations() {
  const result = await request(pathFor('/operations'));
  const data = result.data || result;
  $('#operations-status').className = 'status-box';
  $('#operations-status').textContent = JSON.stringify(data, null, 2);
}

$('#connector-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const approval = { schemaVersion: 1, decisionReferences: parseJsonField(event.currentTarget, 'decisionReferences', 'Decision references', []), documents: parseJsonField(event.currentTarget, 'documents', 'Approval documents', []) };
    const body = { provider: f.provider.value, connectorKey: f.connectorKey.value.trim(), publicConfig: parseJsonField(event.currentTarget, 'publicConfig', 'Public config'), credentials: parseJsonField(event.currentTarget, 'credentials', 'Credentials'), approval,
      ...(f.endpointHost.value.trim() ? { endpointHost: f.endpointHost.value.trim() } : {}) };
    const result = await request(pathFor('/connectors'), { method: 'POST', body });
    f.credentials.value = '';
    setNotice(`Connector saved: ${result.connector?.provider} · ${result.connector?.id}. ${result.connector?.transportApprovalReady ? 'Transport approval complete.' : (result.connector?.approvalBlocker || 'Transport remains blocked by approval and S01 gates.')}`, 'success'); await refreshConnectors();
  } catch (error) { f.credentials.value = ''; setNotice(error.message, 'error'); }
});

$('#connectors-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="select-connector"]'); if (!target) return;
  $('#connector-bind-form').elements.connectorId.value = target.dataset.connectorId;
  $('#connector-job-form').elements.connectorId.value = target.dataset.connectorId;
  $('#connector-bind-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('#connector-bind-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor(`/connectors/${encodeURIComponent(f.connectorId.value.trim())}/mailboxes/${encodeURIComponent(f.mailboxId.value.trim())}`), { method: 'POST', body: { providerMailboxId: f.providerMailboxId.value.trim() } });
    setNotice(`Mailbox connector binding ${result.binding?.duplicate ? 'already existed' : 'saved'} for tenant mailbox ${result.binding?.mailboxId}.`, 'success'); await refreshConnectors();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#connector-job-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, connectorId = f.connectorId.value.trim(), mailboxId = f.mailboxId.value.trim();
  try {
    const suffix = `/connectors/${encodeURIComponent(connectorId)}/mailboxes/${encodeURIComponent(mailboxId)}/${f.action.value}`;
    const result = await request(pathFor(suffix), { method: 'POST', body: f.action.value === 'sync' ? { limit: Number(f.limit.value) } : {} });
    setNotice(`Connector task ${result.taskId || ''} was recorded. Its post-commit worker persists blocked state while local preview or S01 disables provider access. Refresh jobs for the durable outcome.`, 'success'); await refreshConnectors();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#connector-verify-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const candidateId = event.currentTarget.elements.candidateId.value.trim();
    const result = await request(pathFor(`/connectors/verify/${encodeURIComponent(candidateId)}`), { method: 'POST', body: {} });
    setNotice(`Verification task ${result.taskId || ''} was recorded. Provider access stays behind the connector and S01 gates.`, 'success'); await refreshConnectors();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#generation-policy-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { enabled: f.enabled.checked, allowedTasks: [...f.allowedTasks.selectedOptions].map(option => option.value), dailyBudgetMicrousd: Number(f.dailyBudgetMicrousd.value), reservationMicrousd: Number(f.reservationMicrousd.value), maxInputTokens: Number(f.maxInputTokens.value), maxOutputTokens: Number(f.maxOutputTokens.value) };
    const result = await request(pathFor('/generation/policy'), { method: 'PATCH', body });
    setNotice(`Tenant generation policy saved. Provider egress remains disabled (${result.data?.egressEnabled ? 'enabled' : 'disabled'}).`, 'success'); await refreshConnectors();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#generation-campaign-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor(`/generation/campaigns/${encodeURIComponent(f.campaignId.value.trim())}/jobs`), { method: 'POST', body: { idempotencyKey: f.idempotencyKey.value.trim() } });
    const job = result.data || result, id = job.id || job.requestId;
    if (id) { $('#generation-run-form').elements.jobId.value = id; await loadGenerationJob(id); }
    setNotice(`Campaign generation job ${id || ''} is durably ${job.state || 'queued'}. Use Run once to request the explicit gated worker step.`, 'success'); await refreshConnectors();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#generation-reply-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor(`/generation/replies/${encodeURIComponent(f.messageId.value.trim())}/jobs`), { method: 'POST', body: { idempotencyKey: f.idempotencyKey.value.trim() } });
    const job = result.data?.job || result.data || result, id = job.id || job.requestId;
    if (id) { $('#generation-run-form').elements.jobId.value = id; await loadGenerationJob(id); }
    setNotice(`Reply intelligence job ${id || ''} is durably ${job.state || 'queued'} and has no automatic reply action. Use Run once for the explicit gated worker step.`, 'success'); await refreshConnectors();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#generation-run-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try { await loadGenerationJob(event.currentTarget.elements.jobId.value.trim()); setNotice('Generation job status loaded.', 'success'); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#generation-run-once').addEventListener('click', async () => {
  if (!tenantRequired()) return;
  const jobId = $('#generation-run-form').elements.jobId.value.trim();
  if (!jobId) { setNotice('Enter or create a generation job before requesting run once.', 'error'); return; }
  try {
    const result = await request(pathFor(`/generation/jobs/${encodeURIComponent(jobId)}/run-once`), { method: 'POST', body: {} });
    $('#generation-job-status').className = 'status-box'; $('#generation-job-status').textContent = JSON.stringify(result.data || result, null, 2);
    setNotice('Generation execution requested after the job request committed. Loading its durable status…', 'success');
    await Promise.all([loadGenerationJob(jobId), refreshConnectors()]);
  } catch (error) { setNotice(error.message, 'error'); try { await loadGenerationJob(jobId); } catch {} }
});

$('#operations-kill-switch-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const form = event.currentTarget;
  try {
    const result = await request(pathFor('/operations'), { method: 'POST', body: {
      action: 'kill_switch.set', scope: 'tenant', enabled: form.elements.enabled.value === 'true',
      reasonCode: form.elements.reasonCode.value.trim(),
    } });
    setNotice(`Tenant dispatch ${result.data?.enabled ? 'stopped' : 'resumed'}.`, 'success');
    await refreshOperations();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#decision-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const conditioning = parseJsonField(event.currentTarget, 'conditioning', 'Conditioning', {});
    const uncertainty = parseJsonField(event.currentTarget, 'uncertainty', 'Uncertainty', null);
    const risk = parseJsonField(event.currentTarget, 'risk', 'Risk', null);
    const sourceRef = f.sourceRef.value.trim();
    const body = { action: f.action.value, target: f.target.value.trim() || null, horizon: f.horizon.value.trim() || null, basis: f.basis.value.trim(), reversibility: f.reversibility.value,
      conditioning, sourceRefs: sourceRef ? [sourceRef] : [], support: sourceRef ? [{ status: f.supportStatus.value, sourceRef }] : [], uncertainty, prediction: null, utility: null, risk,
      idempotencyKey: f.idempotencyKey.value.trim() };
    const result = await request(pathFor('/decisions'), { method: 'POST', body });
    setNotice(`Structured decision saved: ${result.decision?.action || body.action} · policy status ${result.decision?.policyStatus || 'unknown'}.`, 'success'); await refreshDecisions();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#authorization-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, campaignId = f.campaignId.value.trim();
  try {
    const body = { mode: f.mode.value, audience: { kind: f.audienceKind.value, accountIds: f.accountIds.value.split(',').map(value => value.trim()).filter(Boolean) },
      offer: {}, mailboxId: state.campaign?.mailboxId || '', modelPolicy: f.modelPolicy.value.trim(), purpose: f.purpose.value.trim(), geography: f.geography.value.split(',').map(value => value.trim().toUpperCase()).filter(Boolean),
      sequence: parseJsonField(event.currentTarget, 'sequence', 'Sequence'), copyConstraints: parseJsonField(event.currentTarget, 'copyConstraints', 'Copy constraints'),
      schedule: parseJsonField(event.currentTarget, 'schedule', 'Schedule'), budget: parseJsonField(event.currentTarget, 'budget', 'Budget'), capacity: Number(f.capacity.value), expiresAt: fromLocalDate(f.expiresAt.value), versionPins: parseJsonField(event.currentTarget, 'versionPins', 'Version pins') };
    const result = await request(pathFor(`/autonomy/campaigns/${encodeURIComponent(campaignId)}/authorizations`), { method: 'POST', body });
    if (result.authorization?.version) $('#authorization-action-form').elements.version.value = result.authorization.version;
    setNotice(`Authorization envelope v${result.authorization?.version || ''} created and awaiting owner approval.`, 'success'); await refreshAutonomyCampaign(campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#authorization-action-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, campaignId = f.campaignId.value.trim(), version = f.version.value;
  try {
    const action = f.action.value;
    const result = await request(pathFor(`/autonomy/campaigns/${encodeURIComponent(campaignId)}/authorizations/${encodeURIComponent(version)}/${action}`), { method: 'POST', body: action === 'revoke' ? { reason: f.reason.value.trim() } : {} });
    setNotice(`Authorization envelope v${version} ${result.authorization?.state || action + 'd'}.`, 'success'); await refreshAutonomyCampaign(campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#exception-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, campaignId = f.campaignId.value.trim();
  try {
    const result = await request(pathFor(`/autonomy/campaigns/${encodeURIComponent(campaignId)}/exceptions`), { method: 'POST', body: { recipientId: f.recipientId.value.trim(), intent: parseJsonField(event.currentTarget, 'intent', 'Exact intent') } });
    $('#exception-approve-form').elements.requestId.value = result.review?.id || '';
    setNotice(`Exact exception request ${result.review?.id || ''} recorded for owner review.`, 'success'); await refreshAutonomyCampaign(campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#exception-approve-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, campaignId = f.campaignId.value.trim();
  try {
    const result = await request(pathFor(`/autonomy/campaigns/${encodeURIComponent(campaignId)}/exceptions/${encodeURIComponent(f.requestId.value.trim())}/approve`), { method: 'POST', body: {} });
    setNotice(`Owner-reviewed exception request ${result.review?.id || f.requestId.value.trim()} is ${result.review?.state || 'approved'}.`, 'success'); await refreshAutonomyCampaign(campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

async function refreshAutomation() {
  const result = await request(pathFor('/automation/status'));
  $('#automation-status').className = 'status-box';
  const status = result.data || result;
  $('#automation-status').textContent = JSON.stringify(status, null, 2);
  const research = status.capabilities?.research;
  const queueButton = $('#research-queue-form button[type="submit"]');
  queueButton.disabled = research?.enabled !== true;
  $('#research-queue-status').textContent = research?.enabled
    ? `Queue accepts up to ${research.maxEvidenceRecords || 6} selected source records. Run-once is a separate operator action.`
    : 'Bounded research queue is currently unavailable according to worker status.';
  const runButton = $('#automation-form button[type="submit"]');
  runButton.disabled = status.workerConfigured !== true;
  $('#automation-form .quiet').textContent = status.workerConfigured
    ? 'No background poller starts automatically. Each run-once request asks the configured bounded local worker for one pass.'
    : 'Worker database is not configured. Queueing may still work; run-once will remain unavailable.';
}

async function refreshInsights() {
  const [experimentsResult, funnelResult] = await Promise.all([
    request(pathFor('/experiments?limit=50')), request(pathFor('/analytics/funnel')),
  ]);
  const experiments = experimentsResult.data || [];
  setCount('#experiment-count', experiments);
  renderList('#experiments-list', experiments, 'No fixed experiment plans recorded.', experiment => {
    const item = record(`${experiment.name} · ${experiment.status}`, `${experiment.primaryMetric} · ${experiment.assignedAccounts} assigned account(s) · fixed plan`, experiment.planSha256);
    const arms = Array.isArray(experiment.arms) ? experiment.arms : [];
    arms.forEach(arm => item.append(node('div', 'record-meta', `Arm ${arm.id} · ${arm.control ? 'control' : 'variant'} · weight ${arm.weight} · ${JSON.stringify(arm.variant || {})} · variant SHA-256 ${arm.variantHash || '—'}`)));
    const actions = node('div', 'record-actions');
    actions.append(button('Use for assignment', 'select-experiment', { experimentId: experiment.id }), button('Load analysis', 'analyze-experiment', { experimentId: experiment.id }));
    item.append(actions); return item;
  });
  $('#analytics-result').className = 'status-box'; $('#analytics-result').textContent = JSON.stringify(funnelResult.data || funnelResult, null, 2);
}

async function refreshLifecycle() {
  const results = await Promise.allSettled([
    request(pathFor('/lifecycle/requests?limit=50')),
    request(pathFor('/lifecycle/exports?limit=50')),
    request(pathFor('/lifecycle/inventory')),
  ]);
  const [requestsResult, exportsResult, inventoryResult] = results;
  const requests = requestsResult.status === 'fulfilled' ? (requestsResult.value.items || []) : [];
  const exports = exportsResult.status === 'fulfilled' ? (exportsResult.value.items || []) : [];
  const rows = [...requests.map(row => ({ kind: 'request', ...row })), ...exports.map(row => ({ kind: 'export', ...row }))];
  setCount('#lifecycle-count', rows);
  renderList('#lifecycle-list', rows, 'No lifecycle requests or exports recorded.', item => {
    const row = record(item.kind === 'request' ? `${item.type} · ${item.status}` : `Export · ${item.status}`,
      `${item.id} · ${item.kind === 'request' ? `legal hold ${item.legalHold ? 'yes' : 'no'}` : `expires ${item.expiresAt || 'unknown'}`}`);
    const actions = node('div', 'record-actions');
    if (item.kind === 'request' && item.status === 'prepared') {
      actions.append(button('Prepare plan', 'lifecycle-plan', { requestId: item.id }));
      actions.append(button('Cancel request', 'lifecycle-cancel', { requestId: item.id }));
    }
    if (item.kind === 'export' && item.status === 'completed') actions.append(button('Download artifact', 'lifecycle-download', { exportId: item.id }));
    if (actions.childElementCount) row.append(actions);
    return row;
  });
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${['requests','exports','inventory'][i]}: ${r.reason.message}`] : []);
  $('#lifecycle-status').className = `status-box${errors.length ? ' blocked-note' : ''}`;
  $('#lifecycle-status').textContent = errors.length ? errors.join('\n') : `Requests and exports are tenant scoped. ${exports.some(x => x.status === 'queued') ? 'An export may remain queued until the dedicated worker is configured.' : 'No destructive erase action is available.'}`;
  $('#lifecycle-inventory').className = `status-box${inventoryResult.status === 'rejected' ? ' blocked-note' : ''}`;
  $('#lifecycle-inventory').textContent = inventoryResult.status === 'fulfilled'
    ? JSON.stringify(inventoryResult.value.inventory || inventoryResult.value, null, 2)
    : `Inventory unavailable: ${inventoryResult.reason.message}`;
}

async function refreshRadar() {
  const results = await Promise.allSettled([request(pathFor('/radar/watches?limit=50')), request(pathFor('/radar/signals?limit=50'))]);
  const watches = results[0].status === 'fulfilled' ? (results[0].value.watches || []) : [];
  const signals = results[1].status === 'fulfilled' ? (results[1].value.signals || []) : [];
  setCount('#radar-watch-count', watches); setCount('#radar-signal-count', signals);
  renderList('#radar-watches-list', watches, 'No stored-snapshot watches configured.', watch => {
    const row = record(`${watch.status || watch.state || 'watch'} · ${watch.sourceId || watch.source_id || 'source unavailable'}`,
      `${watch.id} · cadence ${watch.cadenceMinutes ?? watch.cadence_minutes ?? 'unknown'} min · next due ${watch.nextDueAt || watch.next_due_at || 'unknown'}`);
    const actions = node('div', 'record-actions');
    const watchId = watch.id;
    actions.append(button('Refresh once', 'radar-refresh', { watchId }));
    actions.append(button((watch.status || watch.state) === 'paused' ? 'Resume' : 'Pause', (watch.status || watch.state) === 'paused' ? 'radar-resume' : 'radar-pause', { watchId }));
    row.append(actions); return row;
  });
  renderList('#radar-signals-list', signals, 'No signals recorded from stored snapshots.', signal => record(
    `${signal.signalType || signal.kind || 'Signal'} · ${signal.status || 'recorded'}`,
    `${signal.id || '—'} · ${signal.sourceUrl || 'source unknown'} · ${signal.observedAt || 'time unknown'} · ${signal.title || 'No title supplied.'}${signal.exactExcerpt ? ` · ${signal.exactExcerpt}` : ''}`,
    signal.contentSha256 || signal.content_sha256 || ''));
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${i ? 'signals' : 'watches'}: ${r.reason.message}`] : []);
  $('#radar-status').className = `status-box${errors.length ? ' blocked-note' : ''}`;
  $('#radar-status').textContent = errors.length ? errors.join('\n') : 'Refresh requests are explicit one-shot jobs after commit. Network fetch is disabled; counts and unknown source states are shown as returned.';
}

async function refreshLearning() {
  const result = await request(pathFor('/learning/artifacts?limit=50'));
  const items = result.items || [];
  setCount('#learning-count', items);
  renderList('#learning-artifacts-list', items, 'No learning artifacts recorded.', item => record(
    `${item.name} · ${item.version} · ${item.status}`, `${item.id} · source dataset ${item.sourceDatasetId || 'unknown'} · release ${item.sourceReleaseId || 'unknown'}`, item.artifactHash));
  $('#learning-status').className = 'status-box';
  $('#learning-status').textContent = JSON.stringify({ releaseReady: result.releaseReady ?? false, artifacts: items.length,
    datasets: 'Load frozen datasets in Evaluation; training requires an approved release artifact and eligible adjudicated dataset.',
    optimizer: 'Execution unavailable until the optional engine/license is verified; S01 egress remains DENY.',
    skills: 'Candidate creation requires a completed frozen evaluation run; the current API does not expose a skill listing route.' }, null, 2);
}

async function refreshEconomics() {
  const results = await Promise.allSettled([request(pathFor('/economics')), request(pathFor('/post-sale/projects'))]);
  const projectsResult = results[1]; const projects = projectsResult.status === 'fulfilled' ? (projectsResult.value.items || projectsResult.value.projects || []) : [];
  setCount('#postsale-project-count', projects);
  renderList('#postsale-projects-list', projects, 'No delivery projects recorded.', project => {
    const row = record(`${project.name || project.projectName || 'Project'} · ${project.status || 'recorded'}`, `${project.id} · account ${project.accountId || 'unknown'} · ${project.currentEvidenceCount ?? 0} current evidence item(s)`);
    const actions = node('div', 'record-actions'); actions.append(button('Use project', 'postsale-select-project', { projectId: project.id })); row.append(actions); return row;
  });
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${i ? 'projects' : 'economics'}: ${r.reason.message}`] : []);
  $('#economics-status').className = `status-box${errors.length ? ' blocked-note' : ''}`;
  $('#economics-status').textContent = errors.length ? errors.join('\n') : JSON.stringify({ economics: results[0].value, projectCount: projects.length,
    interpretation: 'Vendor invoices remain separate from usage totals; uncertain and missing costs are not treated as savings.', quotaHooks: 'Generation worker reservations are enforced only when a tenant quota is explicitly enabled.' }, null, 2);
}

async function refreshBenchmarks() {
  const result = await request(pathFor('/economics/benchmarks'));
  const rows = result.benchmarks || [];
  renderList('#benchmark-cohorts-list', rows, 'No frozen benchmark cohorts prepared.', cohort => {
    const item = record(`${cohort.status || 'unknown'} · ${cohort.id}`, `permitted ${cohort.permittedAccounts ?? 'unknown'} / target ${cohort.targetAccounts ?? 'unknown'} · eligible ${cohort.eligibleAccounts ?? 'unknown'} · shortfall ${cohort.shortfall ?? 'unknown'} · observations ${cohort.workflowObservations ?? 'unknown'} · reports ${cohort.reportCount ?? 'unknown'}`, cohort.manifestSha256);
    item.append(node('div', 'record-meta', `Evidence age ${cohort.evidenceAgeDays ?? 'unknown'} days · releaseReady=false`));
    item.append(button('Use cohort', 'benchmark-select', { benchmarkId: cohort.id }));
    return item;
  });
  if (rows.length) setBenchmarkInputs(rows[0].id);
}

function setBenchmarkInputs(benchmarkId) {
  for (const selector of ['#benchmark-actions-form', '#benchmark-quote-form', '#benchmark-quote-review-form']) {
    const field = $(selector)?.elements?.benchmarkId;
    if (field && benchmarkId) field.value = benchmarkId;
  }
}

function renderBenchmarkDetail(result) {
  const quotes = result.quotes || [];
  renderList('#benchmark-quotes-list', quotes, 'No quote evidence has been recorded for this cohort.', quote => {
    const item = record(`${quote.vendor} · ${quote.status || 'unknown'} · ${quote.amountMinor ?? 'unknown'} ${quote.currency || ''} ${quote.unit || ''}`,
      `quote ${quote.id} · ${quote.evidenceReference || 'evidence reference unavailable'} · reviews ${quote.reviewCount ?? 'unknown'} · ${quote.effectiveFrom || 'date unknown'}${quote.effectiveUntil ? ` to ${quote.effectiveUntil}` : ''}`, quote.evidenceSha256);
    const actions = node('div', 'record-actions'); actions.append(button('Select for review', 'benchmark-quote-select', { benchmarkId: result.cohort?.id || '', quoteId: quote.id })); item.append(actions);
    return item;
  });
  $('#benchmark-status').className = 'status-box'; $('#benchmark-status').textContent = JSON.stringify(result, null, 2);
}

async function refreshLaunch() {
  const results = await Promise.allSettled([request(pathFor('/launch/releases?limit=50')), request(pathFor('/launch/validation?limit=50'))]);
  const releases = results[0].status === 'fulfilled' ? (results[0].value.items || []) : [];
  const validations = results[1].status === 'fulfilled' ? (results[1].value.items || []) : [];
  setCount('#launch-release-count', releases);
  renderList('#launch-releases-list', releases, 'No launch manifests prepared.', release => {
    const blockers = release.manifest?.blockingEvidence || [];
    const row = record(`${release.name} · ${release.version} · ${release.status}`, `${release.id} · ${blockers.length} evidence blocker(s) · live ${release.manifest?.rollout?.livePilotAllowed === true ? 'unknown' : 'disabled'}`, release.manifestSha256);
    const actions = node('div', 'record-actions'); actions.append(button('Use for signoff', 'launch-select-release', { releaseId: release.id })); row.append(actions); return row;
  });
  $('#launch-validation').className = `status-box${results[1].status === 'rejected' ? ' blocked-note' : ''}`;
  $('#launch-validation').textContent = results[1].status === 'fulfilled'
    ? JSON.stringify({ reports: validations, releaseReady: false, deployment: false, livePilotAllowed: false }, null, 2)
    : `Validation unavailable: ${results[1].reason.message}`;
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${i ? 'validation' : 'releases'}: ${r.reason.message}`] : []);
  $('#launch-status').className = `status-box${errors.length ? ' blocked-note' : ''}`;
  $('#launch-status').textContent = errors.length ? errors.join('\n') : 'Launch APIs report releaseReady=false. Signoff requires separate owner and reviewer memberships and complete evidence; rollout preparation is synthetic only.';
}

async function refreshAll() {
  if (!state.tenantId) return;
  const jobs = [['memberships', refreshMemberships], ['ledger', refreshLedger], ['offers', refreshOffers], ['workflows', refreshWorkflows], ['ai', refreshAi], ['research', refreshResearch], ['sourceCollection', refreshSourceCollection], ['permissions', refreshPermissions], ['inbox', refreshInbox], ['campaigns', refreshCampaigns], ['connectors', refreshConnectors], ['operations', refreshOperations], ['decisions', refreshDecisions], ['evaluation', refreshEvaluation], ['automation', refreshAutomation], ['insights', refreshInsights], ['lifecycle', refreshLifecycle], ['radar', refreshRadar], ['learning', refreshLearning], ['economics', refreshEconomics], ['benchmarks', refreshBenchmarks], ['launch', refreshLaunch]];
  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${jobs[index][0]}: ${result.reason.message}`] : []);
  if (errors.length) setNotice(errors.join('\n'), 'error');
}

function fromLocalDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '' : date.toISOString(); }
function toggleOutcomeFields() {
  const stage = $('#outcome-form').elements.stage.value;
  $$('.conditional:not(.memory-conditional)').forEach(field => {
    const active = field.dataset.for.split(' ').includes(stage);
    field.hidden = !active;
    const input = field.querySelector('input'); if (input) input.required = active;
  });
}
function toggleMemoryStrategyFields() {
  const active = $('#memory-form').elements.kind.value === 'strategy';
  $$('.memory-conditional').forEach(field => { field.hidden = !active; const input = field.querySelector('input'); if (input) input.required = active; });
}

$('#load-tenant').addEventListener('click', () => selectTenant($('#tenant-id').value));
$('#tenant-id').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); selectTenant(event.currentTarget.value); } });
$('#create-tenant').addEventListener('submit', async event => {
  event.preventDefault();
  const buttonEl = event.submitter; buttonEl.disabled = true; setNotice('Creating tenant workspace…');
  try {
    const result = await request('/api/astra/tenants', { method: 'POST', body: { name: $('#tenant-name').value.trim() } });
    $('#tenant-name').value = '';
    await selectTenant(result.tenant?.id || '');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { buttonEl.disabled = false; }
});

$('#membership-invite-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const form = event.currentTarget, f = form.elements, submit = event.submitter;
  submit.disabled = true; clearInvitationReveal();
  try {
    const result = await request(pathFor('/memberships/invitations'), { method: 'POST', body: {
      email: f.email.value.trim(), role: f.role.value, expiresInDays: Number(f.expiresInDays.value),
    } });
    const inviteUrl = new URL(location.pathname, location.origin);
    inviteUrl.hash = new URLSearchParams({ invitation: result.invitation?.token || '' }).toString();
    $('#invitation-link').value = inviteUrl.href;
    $('#invitation-link-result').hidden = false;
    setTimeout(clearInvitationReveal, 120000);
    form.reset(); f.expiresInDays.value = '7';
    setNotice(`Invitation created for ${result.invitation?.email || 'the selected address'}. Copy the one-time local link now; no email was sent.`, 'success');
    await refreshMemberships();
  } catch (error) { setNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

$('#members-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]'); if (!target || !tenantRequired()) return;
  const userId = target.dataset.userId;
  target.disabled = true;
  try {
    if (target.dataset.action === 'membership-role') {
      const role = target.closest('.record').querySelector('.membership-role-select')?.value;
      await request(pathFor(`/memberships/${encodeURIComponent(userId)}`), { method: 'PATCH', body: { role } });
      setNotice(`Tenant membership role updated for ${userId}.`, 'success');
    } else if (target.dataset.action === 'membership-revoke') {
      if (!window.confirm(`Revoke tenant access for user ${userId}?`)) return;
      await request(pathFor(`/memberships/${encodeURIComponent(userId)}`), { method: 'DELETE' });
      setNotice(`Tenant access revoked for ${userId}.`, 'success');
    } else return;
    await refreshMemberships();
  } catch (error) { setNotice(error.message, 'error'); }
  finally { target.disabled = false; }
});

$('#invitations-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="invitation-revoke"]'); if (!target || !tenantRequired()) return;
  if (!window.confirm('Revoke this pending tenant invitation?')) return;
  target.disabled = true;
  try {
    await request(pathFor(`/memberships/invitations/${encodeURIComponent(target.dataset.invitationId)}`), { method: 'DELETE' });
    setNotice('Tenant invitation revoked.', 'success'); await refreshMemberships();
  } catch (error) { setNotice(error.message, 'error'); }
  finally { target.disabled = false; }
});

$('#accept-invitation-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, tokenField = form.elements.token, submit = event.submitter;
  let token = tokenField.value.trim();
  if (token.includes('#')) {
    try { token = new URL(token, location.origin).hash.slice(1); token = new URLSearchParams(token).get('invitation') || ''; }
    catch { token = ''; }
  }
  submit.disabled = true;
  try {
    const result = await request('/api/astra/invitations/accept', { method: 'POST', body: { token } });
    tokenField.value = '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    setNotice('Invitation accepted. Tenant membership is active.', 'success');
    await selectTenant(result.membership?.tenantId || '');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

$('#conformance-manifest-load').addEventListener('click', async () => {
  if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/conformance/manifest'));
    $('#conformance-manifest').className = 'status-box';
    $('#conformance-manifest').textContent = JSON.stringify(result, null, 2);
  } catch (error) { $('#conformance-manifest').textContent = `Manifest unavailable: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#conformance-run-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const form = event.currentTarget, f = form.elements, submit = event.submitter;
  submit.disabled = true;
  try {
    const result = await request(pathFor('/conformance/runs'), { method: 'POST', body: {
      idempotencyKey: f.idempotencyKey.value.trim(), syntheticDatasetConsent: f.syntheticDatasetConsent.checked,
      tenantRights: { basis: 'synthetic_fixture', attested: f.syntheticDatasetConsent.checked },
    } });
    const run = result.run || {};
    const box = $('#conformance-run-status'); box.className = 'status-box'; box.replaceChildren(node('pre', '', JSON.stringify(result, null, 2)));
    if (run.id && state.tenantRole === 'operator' && run.state === 'queued') box.append(button('Execute once', 'conformance-execute', { runId: run.id }));
    if (run.id) f.idempotencyKey.value = `manual-${crypto.randomUUID()}`;
    setNotice(`Conformance run ${run.id || ''} queued. Execution remains an explicit operator action.`, 'success');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

$('#conformance-run-status').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="conformance-execute"]'); if (!target || !tenantRequired()) return;
  target.disabled = true;
  try {
    const result = await request(pathFor(`/conformance/runs/${encodeURIComponent(target.dataset.runId)}/execute`), { method: 'POST', body: {} });
    $('#conformance-run-status').replaceChildren(node('pre', '', JSON.stringify(result, null, 2)));
    setNotice('One-shot conformance execution was requested. Provider calls and release readiness remain disabled.', 'success');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { target.disabled = false; }
});

async function refreshBanditLanes() {
  if (!tenantRequired()) return;
  const result = await request(pathFor('/bandits/lanes'));
  const rows = result.items || [];
  renderList('#bandit-lanes', rows, 'No fixed offline bandit lanes are prepared.', lane => {
    const row = record(`${lane.experimentId} · ${lane.id}`, `fixed lane · exploration cap ${lane.maxExplorationFraction} · live allocation disabled`);
    const actions = node('div', 'record-actions'); actions.append(button('Use for evaluation', 'bandit-select-lane', { laneId: lane.id })); row.append(actions); return row;
  });
}

$('#bandit-lanes-load').addEventListener('click', async () => {
  try { await refreshBanditLanes(); setNotice('Fixed offline lanes refreshed.', 'success'); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#bandit-lane-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, submit = event.submitter; submit.disabled = true;
  try {
    const result = await request(pathFor('/bandits/lanes'), { method: 'POST', body: {
      experimentId: f.experimentId.value.trim(), seed: f.seed.value.trim(), maxExplorationFraction: Number(f.maxExplorationFraction.value),
    } });
    $('#bandit-diagnostic').className = 'status-box'; $('#bandit-diagnostic').textContent = JSON.stringify(result, null, 2);
    if (result.lane?.id) $('#bandit-evaluate-form').elements.laneId.value = result.lane.id;
    await refreshBanditLanes(); setNotice('Fixed offline lane prepared. Campaign traffic and sends were not changed.', 'success');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

$('#bandit-lanes').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="bandit-select-lane"]'); if (!target) return;
  $('#bandit-evaluate-form').elements.laneId.value = target.dataset.laneId;
});

$('#bandit-evaluate-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, submit = event.submitter; submit.disabled = true;
  try {
    const result = await request(pathFor(`/bandits/lanes/${encodeURIComponent(f.laneId.value.trim())}/evaluate`), { method: 'POST', body: { maxWeight: Number(f.maxWeight.value) } });
    $('#bandit-diagnostic').className = 'status-box'; $('#bandit-diagnostic').textContent = JSON.stringify(result, null, 2);
    setNotice('Offline diagnostic saved. Estimates are descriptive only; no causal claim or promotion is available.', 'success');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

function domainHarnessPath() {
  const f = $('#domain-harness-form').elements;
  return pathFor(`/automation/domain-jobs/${encodeURIComponent(f.kind.value)}/${encodeURIComponent(f.jobId.value.trim())}`);
}

$('#domain-harness-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const submit = event.submitter; submit.disabled = true;
  try {
    const result = await request(domainHarnessPath(), { method: 'POST', body: {} });
    $('#domain-harness-result').className = 'status-box'; $('#domain-harness-result').textContent = JSON.stringify(result, null, 2);
    setNotice(`Existing ${$('#domain-harness-form').elements.kind.value} job linked to a workflow. Automatic execution remains off.`, 'success');
  } catch (error) { setNotice(error.message, 'error'); }
  finally { submit.disabled = false; }
});

$('#domain-harness-status').addEventListener('click', async event => {
  if (!tenantRequired()) return;
  event.currentTarget.disabled = true;
  try {
    const result = await request(domainHarnessPath());
    $('#domain-harness-result').className = 'status-box'; $('#domain-harness-result').textContent = JSON.stringify(result, null, 2);
  } catch (error) { setNotice(error.message, 'error'); }
  finally { event.currentTarget.disabled = false; }
});

const invitationFragment = new URLSearchParams(location.hash.slice(1)).get('invitation');
if (invitationFragment) {
  $('#invitation-token').value = invitationFragment;
  history.replaceState(null, '', location.pathname + location.search);
}

$('#outcome-form').elements.stage.addEventListener('change', toggleOutcomeFields);
toggleOutcomeFields();
$('#memory-form').elements.kind.addEventListener('change', toggleMemoryStrategyFields);
toggleMemoryStrategyFields();
$('#outcome-form').elements.occurredAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const localDateInput = timestamp => new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
$('#claim-form').elements.expiresAt.value = localDateInput(Date.now() + 30 * 24 * 60 * 60 * 1000);
if (location.port === '3211') $('.back-link').href = 'http://127.0.0.1:3210';
function updateConsentRequirement() {
  const f = $('#permission-form').elements;
  f.consentExpiresAt.required = f.decision.value === 'granted' && f.lawfulBasis.value === 'consent';
}
$('#permission-form').elements.decision.addEventListener('change', updateConsentRequirement);
$('#permission-form').elements.lawfulBasis.addEventListener('change', updateConsentRequirement);
updateConsentRequirement();
$('#outcome-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const form = event.currentTarget, f = form.elements, stage = f.stage.value;
  const body = {
    stage, entity: { type: f.entityType.value, id: f.entityId.value.trim() }, occurredAt: fromLocalDate(f.occurredAt.value),
    idempotencyKey: `astra-ui:${crypto.randomUUID()}`,
    provenance: { source: f.source.value.trim(), confidence: f.confidence.value, fieldAuthority: f.fieldAuthority.value, evidenceRef: f.evidenceRef.value.trim() || null },
  };
  if (stage === 'revenue_paid' || stage === 'revenue_refunded') {
    body.amountMinor = Number(f.amountMinor.value); body.currency = f.currency.value.trim().toUpperCase();
    body.invoiceRef = f.invoiceRef.value.trim() || null;
  }
  if (stage === 'label') body.label = f.label.value.trim();
  try { const result = await request(pathFor('/outcomes'), { method: 'POST', body }); setNotice(`Outcome recorded${result.data?.duplicate ? ' (idempotent duplicate)' : ''}.`, 'success'); await refreshLedger(); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#offer-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const f = event.currentTarget.elements;
    const result = await request(pathFor('/offers'), { method: 'POST', body: { name: f.name.value.trim(), content: JSON.parse(f.content.value) } });
    setNotice(`Offer ${result.offer?.id ?? ''} created with immutable version ${result.offer?.version?.version ?? ''}.`, 'success');
    event.currentTarget.reset(); await refreshOffers();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Offer content JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#version-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const f = event.currentTarget.elements, offerId = encodeURIComponent(f.offerId.value);
    const result = await request(pathFor(`/offers/${offerId}/versions`), { method: 'POST', body: { content: JSON.parse(f.content.value) } });
    setNotice(`Immutable offer version ${result.version?.version ?? result.version?.id ?? ''} created. SHA-256 ${result.version?.contentHash || 'unavailable'}.`, 'success');
    await refreshOffers();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Offer content JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#proof-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const f = event.currentTarget.elements, file = f.proofFile.files[0];
    const expiresAt = fromLocalDate(f.expiresAt.value);
    if (!expiresAt || Date.parse(expiresAt) <= Date.now()) throw new Error('Choose a valid future proof expiry date and time.');
    if (!file) throw new Error('Choose a proof file.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Proof files must be no larger than 10 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const bytesBase64 = btoa(binary);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const contentHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    const url = pathFor(`/offers/${encodeURIComponent(f.offerId.value)}/versions/${encodeURIComponent(f.versionId.value)}/proofs`);
    const result = await request(url, { method: 'POST', body: { proofId: f.proofId.value.trim(), bytesBase64, mimeType: file.type || 'application/octet-stream', contentHash, expiresAt } });
    setNotice(`Proof uploaded and linked. Stored hash ${result.proof?.contentHash || contentHash}.`, 'success');
    event.currentTarget.reset(); await refreshOffers();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#offers-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]'); if (!target) return;
  if (target.dataset.action === 'version-prefill') {
    $('#version-form').elements.offerId.value = target.dataset.offerId;
    $('#version-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#version-form').elements.content.focus(); return;
  }
  if (target.dataset.action === 'select-approved-offer') {
    $('#campaign-form').elements.offerVersionId.value = target.dataset.versionId;
    $('#campaign-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
  }
  if (target.dataset.action === 'approve-offer') {
    if (!tenantRequired()) return;
    target.disabled = true;
    try {
      const result = await request(pathFor(`/offers/${encodeURIComponent(target.dataset.offerId)}/versions/${encodeURIComponent(target.dataset.versionId)}/approve`), { method: 'POST', body: {} });
      setNotice(`Offer version approved. SHA-256 ${result.version?.contentHash || 'unchanged'}.`, 'success'); await refreshOffers();
    } catch (error) { setNotice(error.message, 'error'); target.disabled = false; }
  }
});

$('#workflow-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const f = event.currentTarget.elements;
    const result = await request(pathFor('/workflows'), { method: 'POST', body: { task: JSON.parse(f.task.value), priority: Number(f.priority.value), taskClass: f.taskClass.value, maxAttempts: Number(f.maxAttempts.value) } });
    setNotice(`Workflow ${result.data?.id || ''} is ${result.data?.state || 'queued'}${result.data?.duplicate ? ' (existing identical task)' : ''}.`, 'success'); await refreshWorkflows();
  } catch (error) { setNotice(error instanceof SyntaxError ? `HarnessTask JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#workflows-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="cancel-workflow"]'); if (!target || !tenantRequired()) return;
  target.disabled = true;
  try { await request(pathFor(`/workflows/${encodeURIComponent(target.dataset.workflowId)}/cancel`), { method: 'POST', body: {} }); setNotice('Queued workflow cancelled.', 'success'); await refreshWorkflows(); }
  catch (error) { setNotice(error.message, 'error'); target.disabled = false; }
});

$('#ai-policy-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  const body = {
    enabled: f.enabled.checked, allowedTasks: [...f.allowedTasks.selectedOptions].map(option => option.value),
    dailyBudgetMicrousd: Number(f.dailyBudgetMicrousd.value), reservationMicrousd: Number(f.reservationMicrousd.value),
    maxInputTokens: Number(f.maxInputTokens.value), maxOutputTokens: Number(f.maxOutputTokens.value),
  };
  try { await request(pathFor('/ai/policy'), { method: 'PATCH', body }); setNotice('Tenant AI policy saved. No provider request was sent.', 'success'); await refreshAi(); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#snapshot-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  const body = { sourceUrl: f.sourceUrl.value.trim(), html: f.html.value, mediaType: 'text/html; charset=utf-8', rightsPolicy: f.rightsPolicy.value, rightsAttested: f.rightsAttested.checked, robotsAllowed: f.robotsAllowed.checked, ...(f.rightsExpiresAt.value ? { rightsExpiresAt: fromLocalDate(f.rightsExpiresAt.value) } : {}) };
  try {
    const result = await request(pathFor('/research/snapshots'), { method: 'POST', body });
    const evidence = result.data?.evidence;
    setNotice(`Snapshot stored as ${evidence?.id || 'evidence'} · ${evidence?.byteLength ?? '—'} bytes · SHA-256 ${evidence?.contentSha256 || 'unavailable'}. Supplied content is untrusted; no URL fetch was performed.`, 'success');
    await refreshResearch(); if (evidence?.id) await inspectEvidence(evidence.id);
  } catch (error) { setNotice(error.message, 'error'); }
});

function sourceRightsFromForm(form) {
  const f = form.elements;
  return {
    rightsPolicy: f.rightsPolicy.value,
    rightsAttested: f.rightsAttested.checked,
    rightsEvidenceReference: f.rightsEvidenceReference.value.trim(),
    robotsAllowed: f.robotsAllowed.checked,
    robotsEvidenceReference: f.robotsEvidenceReference.value.trim(),
    rightsReviewedAt: fromLocalDate(f.rightsReviewedAt.value),
    rightsExpiresAt: fromLocalDate(f.rightsExpiresAt.value),
  };
}

function parseSourceApprovalReferences(form) {
  const value = JSON.parse(form.elements.approvalReferences.value);
  if (!Array.isArray(value)) throw new TypeError('S01 approval references must be a JSON array.');
  return value;
}

$('#source-fetch-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { sourceUrl: f.sourceUrl.value.trim(), sourceRights: sourceRightsFromForm(event.currentTarget), approvalReferences: parseSourceApprovalReferences(event.currentTarget) };
    const result = await request(pathFor('/collection/fetch'), { method: 'POST', body });
    $('#source-collection-status').className = 'status-box';
    $('#source-collection-status').textContent = JSON.stringify({ job: result.job, execution: result.execution, remoteTransportDefault: result.remoteTransportDefault, releaseReady: result.releaseReady }, null, 2);
    setNotice(`Source fetch request recorded as ${result.job?.status || 'unknown'}; blocker ${result.job?.blockedReason || 'none reported'}. Check the server status before any run-once action.`, 'success'); await refreshSourceCollection();
  } catch (error) { setNotice(error instanceof SyntaxError ? `S01 approval reference JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#source-search-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { category: f.category.value.trim(), country: f.country.value.trim(), city: f.city.value.trim(), sourceRights: sourceRightsFromForm(event.currentTarget), approvalReferences: parseSourceApprovalReferences(event.currentTarget) };
    const result = await request(pathFor('/collection/search'), { method: 'POST', body });
    $('#source-collection-status').className = 'status-box';
    $('#source-collection-status').textContent = JSON.stringify({ job: result.job, execution: result.execution, remoteTransportDefault: result.remoteTransportDefault, releaseReady: result.releaseReady }, null, 2);
    setNotice(`Public-category search request recorded as ${result.job?.status || 'unknown'}; blocker ${result.job?.blockedReason || 'none reported'}. Candidate results remain unverified.`, 'success'); await refreshSourceCollection();
  } catch (error) { setNotice(error instanceof SyntaxError ? `S01 approval reference JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#source-collection-refresh').addEventListener('click', async () => {
  if (!tenantRequired()) return;
  try { await refreshSourceCollection(); setNotice('Source collection job status refreshed.', 'success'); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#source-collection-jobs').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="source-collection-run"]'); if (!target || !tenantRequired()) return;
  try {
    const result = await request(pathFor(`/collection/jobs/${encodeURIComponent(target.dataset.jobId)}/run-once`), { method: 'POST', body: {} });
    $('#source-collection-status').className = 'status-box'; $('#source-collection-status').textContent = JSON.stringify(result, null, 2);
    setNotice(`Explicit source worker response: ${result.execution || result.status || result.job?.status || 'accepted'}.`, 'success'); await refreshSourceCollection();
  } catch (error) { $('#source-collection-status').className = 'status-box blocked-note'; $('#source-collection-status').textContent = `Run-once was not accepted: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#evidence-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="inspect-evidence"]'); if (!target) return;
  await inspectEvidence(target.dataset.evidenceId);
});

$('#audit-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const created = await request(pathFor('/research/audits'), { method: 'POST', body: { evidenceId: event.currentTarget.elements.evidenceId.value.trim() } });
    const audit = created.data, item = record(`Audit ${audit.id} · ${audit.coverageStatus}`, `Version ${audit.auditVersion} · ${audit.createdAt}`);
    (audit.findings || []).forEach(finding => item.append(node('div', 'record-meta', `${finding.signal}: ${finding.outcome} · ${finding.detail}`)));
    renderList('#audit-result', [item], '', value => value);
    setNotice(`Audit complete with ${audit.findings?.length || 0} reported findings. Unknown findings remain unknown.`, 'success');
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#claim-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  if (!f.evidenceId.value || !f.contentSha256.value) { setNotice('Inspect an evidence snapshot before submitting a claim.', 'error'); return; }
  try {
    const body = { evidenceId: f.evidenceId.value, contentSha256: f.contentSha256.value, subjectKey: f.subjectKey.value.trim(), predicate: f.predicate.value.trim(), value: f.value.value.trim(), exactExcerpt: f.exactExcerpt.value.trim(), expiresAt: fromLocalDate(f.expiresAt.value) };
    const result = await request(pathFor('/research/claims'), { method: 'POST', body });
    setNotice(`Claim ${result.data?.status || 'recorded'}${result.data?.abstainReason ? `: ${result.data.abstainReason}` : ''}.`, result.data?.status === 'supported' ? 'success' : 'error'); await refreshResearch();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#permission-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { subject: { type: f.subjectType.value, value: f.subjectValue.value.trim() }, purpose: f.purpose.value.trim(), lawfulBasis: f.lawfulBasis.value, geography: f.geography.value.trim(), decision: f.decision.value, sourceProof: JSON.parse(f.sourceProof.value), ...(f.consentExpiresAt.value ? { consentExpiresAt: fromLocalDate(f.consentExpiresAt.value) } : {}) };
    const result = await request(pathFor('/permissions'), { method: 'POST', body });
    setNotice(`Permission decision recorded: ${result.permission?.decision || body.decision}.`, 'success'); await refreshPermissions();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Source proof JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#evaluate-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, body = { purpose: f.purpose.value.trim() };
  for (const key of ['recipient', 'domain', 'account', 'channel']) if (f[key].value.trim()) body[key] = f[key].value.trim();
  try {
    const result = await request(pathFor('/permissions/evaluate'), { method: 'POST', body });
    const evaluation = result.evaluation || result;
    $('#permission-evaluation').className = 'status-box'; $('#permission-evaluation').textContent = JSON.stringify(evaluation, null, 2);
    setNotice(evaluation.allowed ? 'Permission gate allows this purpose at the current check.' : `Permission gate did not allow this purpose: ${evaluation.reason || 'see result'}.`, evaluation.allowed ? 'success' : 'error');
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#suppression-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor('/suppressions'), { method: 'POST', body: { scope: f.scope.value, value: f.value.value.trim(), reason: f.reason.value.trim(), evidence: JSON.parse(f.evidence.value) } });
    setNotice(`Suppression recorded for ${result.suppression?.scope}:${result.suppression?.value}. Removal supported: ${result.removalSupported === true ? 'yes' : 'no'}.`, 'success'); await refreshPermissions();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Suppression evidence JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#mailbox-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor('/mailboxes'), { method: 'POST', body: { displayName: f.displayName.value.trim(), provider: 'manual', ...(f.providerMailboxId.value.trim() ? { providerMailboxId: f.providerMailboxId.value.trim() } : {}) } });
    setNotice(`Manual mailbox created: ${result.mailbox?.id}. Receive is manual ingest only; send is disabled.`, 'success'); await refreshInbox();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#message-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { mailboxId: f.mailboxId.value.trim(), externalThreadId: f.externalThreadId.value.trim(), externalMessageId: f.externalMessageId.value.trim(), bodyText: f.bodyText.value, recipients: f.recipients.value.split(',').map(value => value.trim()).filter(Boolean), ...(f.inReplyTo.value.trim() ? { inReplyTo: f.inReplyTo.value.trim() } : {}), ...(f.sender.value.trim() ? { sender: f.sender.value.trim() } : {}), ...(f.subject.value.trim() ? { subject: f.subject.value.trim() } : {}) };
    const result = await request(pathFor('/inbox/messages'), { method: 'POST', body });
    setNotice(`Message ${result.message?.duplicate ? 'was already ingested' : 'ingested'} · ${result.message?.id}.`, 'success'); await refreshInbox();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#mailboxes-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="select-mailbox"]'); if (!target) return;
  $('#message-form').elements.mailboxId.value = target.dataset.mailboxId; $('#message-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#campaign-form').elements.mailboxId.value = target.dataset.mailboxId;
});

$('#messages-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="create-reply-task"]'); if (!target || !tenantRequired()) return;
  target.disabled = true;
  try { const result = await request(pathFor('/reply-tasks'), { method: 'POST', body: { messageId: target.dataset.messageId } }); setNotice(`Reply task ${result.task?.classification || ''} · ${result.task?.status || 'created'} · deterministic classification.`, 'success'); await refreshInbox(); }
  catch (error) { setNotice(error.message, 'error'); target.disabled = false; }
});

$('#reply-tasks-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="review-reply"]'); if (!target || !tenantRequired()) return;
  const note = target.parentElement.querySelector('input')?.value || ''; target.disabled = true;
  try { await request(pathFor(`/reply-tasks/${encodeURIComponent(target.dataset.taskId)}/review`), { method: 'POST', body: { decision: target.dataset.decision, ...(note ? { note } : {}) } }); setNotice(`Reply task ${target.dataset.decision}. No reply was sent.`, 'success'); await refreshInbox(); }
  catch (error) { setNotice(error.message, 'error'); target.disabled = false; }
});

$('#mapping-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { entityType: f.entityType.value, entityId: f.entityId.value.trim(), externalId: f.externalId.value.trim(), fieldAuthority: f.fieldAuthority.value.trim() ? JSON.parse(f.fieldAuthority.value) : {}, provenance: f.provenance.value.trim() ? JSON.parse(f.provenance.value) : {} };
    const result = await request(pathFor('/crm/mappings'), { method: 'POST', body }); setNotice(`CRM identity mapping ${result.mapping?.duplicate ? 'already existed' : 'recorded'}.`, 'success'); await refreshInbox();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Mapping JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#outbox-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { entityType: f.entityType.value, entityId: f.entityId.value.trim(), idempotencyKey: f.idempotencyKey.value.trim(), payload: JSON.parse(f.payload.value), fieldAuthority: JSON.parse(f.fieldAuthority.value), provenance: JSON.parse(f.provenance.value) };
    const result = await request(pathFor('/crm/outbox'), { method: 'POST', body }); setNotice(`CRM proposal ${result.proposal?.state || 'recorded'} · transport enabled: ${result.transportEnabled === true ? 'yes' : 'no'}${result.proposal?.gate ? ` · ${result.proposal.gate}` : ''}.`, 'success'); await refreshInbox();
  } catch (error) { setNotice(error instanceof SyntaxError ? `CRM proposal JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#eval-dataset-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/evaluation/datasets'), { method: 'POST', body: JSON.parse(event.currentTarget.elements.dataset.value) });
    setNotice(`Frozen evaluation dataset ${result.dataset?.id || ''} saved with ${result.dataset?.exampleCount ?? 'reported'} examples.`, 'success'); await refreshEvaluation();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Dataset JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#eval-candidate-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/evaluation/candidates'), { method: 'POST', body: JSON.parse(event.currentTarget.elements.candidate.value) });
    setNotice(`Deterministic candidate ${result.candidate?.id || ''} registered (${result.candidate?.variantId || 'variant unknown'}).`, 'success'); await refreshEvaluation();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Candidate JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#eval-scorer-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/evaluation/scorers'), { method: 'POST', body: JSON.parse(event.currentTarget.elements.scorer.value) });
    setNotice(`Deterministic scorer ${result.scorer?.id || ''} registered.`, 'success'); await refreshEvaluation();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Scorer JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#eval-label-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { [f.action.value]: JSON.parse(f.labels.value) };
    const result = await request(pathFor(`/evaluation/datasets/${encodeURIComponent(f.datasetId.value.trim())}/${f.action.value}`), { method: 'POST', body });
    setNotice(`${f.action.value === 'annotations' ? 'Annotations' : 'Adjudications'} recorded: ${(result[f.action.value] || []).length}.`, 'success'); await refreshEvaluation();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Label JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#eval-run-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/evaluation/runs'), { method: 'POST', body: JSON.parse(event.currentTarget.elements.run.value) });
    const runId = result.run?.id;
    if (runId) $('#eval-execute-form').elements.runId.value = runId;
    setNotice(`Offline evaluation run ${runId || ''} was durably ${result.run?.state || 'queued'}; execution remains a separate owner request.`, 'success'); await refreshEvaluation();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Evaluation run JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#eval-execute-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const runId = event.currentTarget.elements.runId.value.trim();
  try {
    const result = await request(pathFor(`/evaluation/runs/${encodeURIComponent(runId)}/execute`), { method: 'POST', body: {} });
    $('#evaluation-status').className = 'status-box'; $('#evaluation-status').textContent = JSON.stringify(result, null, 2);
    setNotice(`Offline evaluation execution requested for ${runId}; no provider calls are part of this harness.`, 'success'); await refreshEvaluation();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#eval-runs-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="load-eval-run"]'); if (!target || !tenantRequired()) return;
  try {
    const result = await request(pathFor(`/evaluation/runs/${encodeURIComponent(target.dataset.runId)}`));
    $('#evaluation-status').className = 'status-box'; $('#evaluation-status').textContent = JSON.stringify(result, null, 2);
    $('#eval-execute-form').elements.runId.value = target.dataset.runId;
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#campaign-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = { name: f.name.value.trim(), offerVersionId: Number(f.offerVersionId.value), mailboxId: f.mailboxId.value.trim(), purpose: f.purpose.value.trim(), geography: f.geography.value.split(',').map(value => value.trim().toUpperCase()).filter(Boolean), spendLimitMinor: Number(f.spendLimitMinor.value), currency: f.currency.value.trim().toUpperCase(), ...(f.scheduleAt.value ? { scheduleAt: fromLocalDate(f.scheduleAt.value) } : {}) };
    const result = await request(pathFor('/campaigns'), { method: 'POST', body });
    setNotice(`Campaign record created: ${result.campaign?.name} · ${result.campaign?.id}. Live dispatch is disabled.`, 'success'); await refreshCampaigns(); if (result.campaign?.id) await selectCampaign(result.campaign.id);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#campaigns-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="select-campaign"]'); if (!target) return;
  try { await selectCampaign(target.dataset.campaignId); } catch (error) { setNotice(error.message, 'error'); }
});

$('#qualification-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired() || !state.campaignId) { if (!state.campaignId) setNotice('Select a campaign first.', 'error'); return; }
  const accountIds = event.currentTarget.elements.accountIds.value.split(',').map(value => value.trim()).filter(Boolean);
  try {
    const result = await request(pathFor(`/campaigns/${encodeURIComponent(state.campaignId)}/qualification`), { method: 'POST', body: { accountIds } });
    const qualification = result.qualification || {};
    const rows = qualification.results || [];
    renderList('#qualification-result', rows, 'No account qualification results returned.', row => {
      const item = record(`${row.domain || row.accountId} · ${row.status}`, `${row.reasons?.join(', ') || 'No blockers reported'} · candidate ${row.candidateId || '—'} · ${row.email || 'no email candidate'}`);
      return item;
    });
    setNotice(`Qualification completed for ${rows.length} account(s); ${qualification.fitCount ?? 0} fit. This is evidence screening, not send readiness.`, 'success'); await selectCampaign(state.campaignId);
    // Keep the results visible after refreshing the selected campaign detail.
    renderList('#qualification-result', rows, 'No account qualification results returned.', row => {
      const item = record(`${row.domain || row.accountId} · ${row.status}`, `${row.reasons?.join(', ') || 'No blockers reported'} · candidate ${row.candidateId || '—'} · ${row.email || 'no email candidate'}`);
      return item;
    });
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#verification-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired() || !state.campaignId) { if (!state.campaignId) setNotice('Select a campaign first.', 'error'); return; }
  const f = event.currentTarget.elements;
  try {
    const body = { candidateId: f.candidateId.value.trim(), evidenceId: f.evidenceId.value.trim(), source: f.source.value.trim(), classification: f.classification.value, expiresAt: fromLocalDate(f.expiresAt.value), note: f.note.value.trim() };
    const result = await request(pathFor(`/campaigns/${encodeURIComponent(state.campaignId)}/verification`), { method: 'POST', body });
    setNotice(`Verification evidence recorded as ${result.verification?.classification}; it is not positive delivery verification.`, 'success'); await selectCampaign(state.campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#draft-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired() || !state.campaignId) { if (!state.campaignId) setNotice('Select a campaign first.', 'error'); return; }
  const f = event.currentTarget.elements;
  const assessment = campaignDraftAssessment();
  if (!assessment.valid || !state.composer) {
    renderCampaignDraft({ resetEditor: false });
    setNotice('Draft remains unverified. Use exact current source templates before saving.', 'error');
    return;
  }
  const claimsMap = assessment.lines.map((sentence, index) => ({ sentence,
    claimIds: [assessment.bodyTemplates[index].claimId], templateId: assessment.bodyTemplates[index].templateId }));
  try {
    const body = { expectedVersion: state.composer.version, subject: f.subject.value, body: f.body.value, claimsMap };
    const result = await request(pathFor(`/campaigns/${encodeURIComponent(state.campaignId)}/draft`), { method: 'PUT', body });
    setNotice(`Validated draft v${result.draft?.copyVersion ?? '—'} saved · SHA-256 ${result.draft?.copyHash || 'unavailable'}.`, 'success'); await selectCampaign(state.campaignId);
  } catch (error) {
    setNotice(error.message, 'error');
    if (/changed since|version conflict/i.test(error.message)) await selectCampaign(state.campaignId);
  }
});

$('#draft-form [name="body"]').addEventListener('input', event => {
  reconcileDraftTemplateIds(event.currentTarget.value);
  renderCampaignDraft({ resetEditor: false });
});

function reconcileDraftTemplateIds(nextBody) {
  const nextLines = nextBody ? nextBody.split('\n') : [];
  const templates = state.composer?.templates || [];
  const usedPrevious = new Set();
  const previousBody = state.draftBodySnapshot || '';
  const previousLines = previousBody ? previousBody.split('\n') : [];
  state.draftTemplateIds = nextLines.map((line, index) => {
    if (previousLines[index] === line && state.draftTemplateIds[index]) return state.draftTemplateIds[index];
    const previousMatches = previousLines.map((previousLine, previousIndex) => ({ previousLine, previousIndex }))
      .filter(item => item.previousLine === line && !usedPrevious.has(item.previousIndex) && state.draftTemplateIds[item.previousIndex]);
    if (previousMatches.length === 1) {
      usedPrevious.add(previousMatches[0].previousIndex);
      return state.draftTemplateIds[previousMatches[0].previousIndex];
    }
    const matches = templates.filter(item => item.placement === 'body' && item.renderedText === line);
    return matches.length === 1 ? matches[0].templateId : null;
  });
  state.draftBodySnapshot = nextBody;
}

$('#draft-template-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="insert-copy-template"]');
  if (!target || !state.composer) return;
  const template = state.composer.templates?.find(item => item.placement === 'body' && item.templateId === target.dataset.templateId);
  if (!template) return;
  const body = $('#draft-form').elements.body;
  const lines = body.value ? body.value.split('\n') : [];
  if (lines.includes(template.renderedText)) { setNotice('This exact source sentence is already in the draft.', 'error'); return; }
  body.value = [...lines.filter(Boolean), template.renderedText].join('\n');
  state.draftTemplateIds = [...state.draftTemplateIds, template.templateId];
  state.draftBodySnapshot = body.value;
  renderCampaignDraft({ resetEditor: false });
});

$('#approval-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired() || !state.campaignId) { if (!state.campaignId) setNotice('Select a campaign first.', 'error'); return; }
  if (!campaignDraftAssessment().saved || !state.composer) { setNotice('Save a currently verified source-template draft before approval.', 'error'); renderCampaignDraft(); return; }
  try {
    const expiresAt = fromLocalDate(event.currentTarget.elements.expiresAt.value);
    const result = await request(pathFor(`/campaigns/${encodeURIComponent(state.campaignId)}/approvals`), { method: 'POST', body: { expectedVersion: state.composer.version, expiresAt } });
    setNotice(`Campaign approved immutably through ${result.approval?.expiresAt || expiresAt}.`, 'success'); await selectCampaign(state.campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#plan-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired() || !state.campaignId) { if (!state.campaignId) setNotice('Select a campaign first.', 'error'); return; }
  try {
    const result = await request(pathFor(`/campaigns/${encodeURIComponent(state.campaignId)}/dispatch-plans`), { method: 'POST', body: { idempotencyKey: event.currentTarget.elements.idempotencyKey.value.trim() } });
    const plan = result.plan || {};
    setNotice(`Offline plan ${plan.id || ''} prepared · live transport ${plan.liveTransport || 'disabled'} · blockers: ${plan.blockers?.join(', ') || 'none reported'}.`, 'success'); await selectCampaign(state.campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#campaign-plans').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="select-plan"]'); if (!target) return;
  $('#plan-claim-form').elements.planId.value = target.dataset.planId;
  $('#plan-claim-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('#plan-claim-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired() || !state.campaignId) { if (!state.campaignId) setNotice('Select a campaign first.', 'error'); return; }
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor(`/campaigns/${encodeURIComponent(state.campaignId)}/dispatch-plans/${encodeURIComponent(f.planId.value.trim())}/claim`), { method: 'POST', body: { idempotencyKey: f.idempotencyKey.value.trim() } });
    setNotice(`Durable plan claim state: ${result.claim?.state || 'quarantined'} · blockers ${result.claim?.blockers?.join(', ') || 'see claim'}. No transport occurred.`, 'success'); await selectCampaign(state.campaignId);
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#research-queue-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const evidenceIds = $$('#evidence-list input[name="selectedEvidence"]:checked').map(input => input.value);
  if (!evidenceIds.length || evidenceIds.length > 6) { setNotice('Select between one and six evidence snapshots.', 'error'); return; }
  try {
    const result = await request(pathFor('/automation/research'), { method: 'POST', body: { evidenceIds } });
    setNotice(`Research workflow ${result.data?.id || ''} queued (${result.data?.state || 'queued'}). Run once separately to request a bounded pass.`, 'success'); await refreshWorkflows();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#automation-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/automation/run-once'), { method: 'POST', body: {} });
    setNotice(`Bounded workflow pass accepted: ${result.data?.state || 'request queued'} · worker ${result.data?.worker || 'manual-run-only'}.`, 'success'); await refreshAutomation();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#memory-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, authority = f.authority.value;
  const provenance = { source: f.provenanceSource.value.trim(), confidence: f.provenanceConfidence.value, fieldAuthority: f.provenanceAuthority.value };
  if (f.kind.value === 'strategy') Object.assign(provenance, { experimentId: f.experimentId.value.trim(), armId: f.armId.value.trim(), planSha256: f.planSha256.value.trim() });
  const body = {
    kind: f.kind.value, subject: { type: f.subjectType.value, id: f.subjectId.value.trim() }, purpose: f.purpose.value.trim(), key: f.key.value.trim(), value: f.value.value,
    validFrom: fromLocalDate(f.validFrom.value), confidence: f.confidence.value, authority, sensitivity: f.sensitivity.value,
    permissionDecisionId: f.permissionDecisionId.value.trim(), permissionSubjectType: f.permissionSubjectType.value, permissionSubjectValue: f.permissionSubjectValue.value.trim(),
    provenance,
    ...(f.validTo.value ? { validTo: fromLocalDate(f.validTo.value) } : {}),
    ...(f.expiresAt.value ? { expiresAt: fromLocalDate(f.expiresAt.value) } : {}),
    ...(f.sourceKind.value === 'event' ? { sourceEventId: f.sourceId.value.trim(), rightsPolicy: 'internal_event' } : { sourceEvidenceId: f.sourceId.value.trim(), rightsPolicy: f.rightsPolicy.value, ...(f.rightsExpiresAt.value ? { rightsExpiresAt: fromLocalDate(f.rightsExpiresAt.value) } : {}) }),
  };
  try {
    const result = await request(pathFor('/memory/items'), { method: 'POST', body });
    setNotice(`Permission-bound memory record captured: ${result.data?.id}.`, 'success');
    if (f.subjectId.value.trim()) await recallMemory(f.subjectType.value, f.subjectId.value.trim(), f.purpose.value.trim(), f.key.value.trim());
  } catch (error) { setNotice(error.message, 'error'); }
});

async function recallMemory(subjectType, subjectId, purpose, queryText) {
  const query = new URLSearchParams({ subjectType, subjectId, purpose, q: queryText });
  const result = await request(pathFor(`/memory/recall?${query}`));
  $('#memory-result').className = 'status-box'; $('#memory-result').textContent = JSON.stringify(result.data || result, null, 2);
  return result.data;
}

$('#recall-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await recallMemory(f.subjectType.value, f.subjectId.value.trim(), f.purpose.value.trim(), f.q.value.trim());
    setNotice(`Memory recall: ${result?.status || 'unknown'}${result?.abstain ? ` · ${result.reason || 'abstained'}` : ''}.`, result?.status === 'found' && !result?.abstain ? 'success' : 'error');
  } catch (error) { setNotice(error.message, 'error'); }
});

async function canonicalJson(value) {
  const stable = item => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return JSON.stringify(stable(value));
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

$('#arm-builder').addEventListener('submit', async event => {
  event.preventDefault();
  const f = event.currentTarget.elements;
  try {
    const variant = JSON.parse(f.variant.value);
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) throw new Error('Variant must be a JSON object.');
    const arm = { id: f.id.value.trim(), label: f.label.value.trim(), variant, variantHash: await sha256Hex(await canonicalJson(variant)), weight: Number(f.weight.value), control: f.control.checked };
    const planField = $('#experiment-form').elements.plan;
    const plan = planField.value.trim() ? JSON.parse(planField.value) : { arms: [] };
    if (!Array.isArray(plan.arms)) throw new Error('The plan JSON must contain an arms array.');
    if (plan.arms.some(existing => existing.id === arm.id)) throw new Error('This arm ID already exists in the plan.');
    plan.arms.push(arm); planField.value = JSON.stringify(plan, null, 2);
    setNotice(`Arm ${arm.id} added with canonical SHA-256 ${arm.variantHash}. Review and fill the fixed plan fields before creating it.`, 'success');
  } catch (error) { setNotice(error instanceof SyntaxError ? `Variant or plan JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#experiment-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const result = await request(pathFor('/experiments'), { method: 'POST', body: JSON.parse(event.currentTarget.elements.plan.value) });
    setNotice(`Fixed experiment plan created: ${result.data?.id} · SHA-256 ${result.data?.planSha256}. Assignment is an experiment record, not outreach.`, 'success'); await refreshInsights();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Experiment plan JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#experiments-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]'); if (!target || !tenantRequired()) return;
  if (target.dataset.action === 'select-experiment') {
    $('#assignment-form').elements.experimentId.value = target.dataset.experimentId;
    $('#assignment-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
  }
  if (target.dataset.action === 'analyze-experiment') {
    try {
      const result = await request(pathFor(`/experiments/${encodeURIComponent(target.dataset.experimentId)}/analysis`));
      $('#experiment-analysis').className = 'status-box'; $('#experiment-analysis').textContent = JSON.stringify(result.data || result, null, 2);
      setNotice('Descriptive experiment analysis loaded. It does not establish causal lift.', 'success');
    } catch (error) { setNotice(error.message, 'error'); }
  }
});

$('#assignment-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const observedAt = fromLocalDate(f.observedAt.value);
    const accounts = f.accountIds.value.split(',').map(value => value.trim()).filter(Boolean).map(accountId => ({
      accountId, eligible: true, stratum: f.stratum.value.trim(), eligibility: { source: f.source.value.trim(), observedAt, decision: 'eligible' },
    }));
    const result = await request(pathFor(`/experiments/${encodeURIComponent(f.experimentId.value.trim())}/assignments`), { method: 'POST', body: { accounts } });
    const assignments = result.data?.assignments || [];
    $('#experiment-analysis').className = 'status-box'; $('#experiment-analysis').textContent = JSON.stringify(result.data || result, null, 2);
    setNotice(`${assignments.length} account assignment(s) recorded. Sticky assignment is not evidence of exposure or a send.`, 'success'); await refreshInsights();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#lifecycle-export-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const rowLimit = Number(event.currentTarget.elements.rowLimit.value);
    const result = await request(pathFor('/lifecycle/exports'), { method: 'POST', body: { rowLimit } });
    setNotice(`Export request ${result.export?.id || ''} recorded as ${result.export?.status || 'queued'}. Dedicated worker required; no data is downloaded until the stored artifact is complete.`, 'success'); await refreshLifecycle();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#lifecycle-request-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try {
    const f = event.currentTarget.elements, body = JSON.parse(f.request.value);
    body.type = f.type.value; body.legalHold = f.legalHold.value === 'true';
    const result = await request(pathFor('/lifecycle/requests'), { method: 'POST', body });
    setNotice(`Plan-only ${result.request?.type || body.type} request ${result.request?.id || ''} saved. Physical deletion is not performed.`, 'success'); await refreshLifecycle();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Lifecycle JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#lifecycle-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]'); if (!target || !tenantRequired()) return;
  const id = encodeURIComponent(target.dataset.requestId || target.dataset.exportId || '');
  try {
    if (target.dataset.action === 'lifecycle-plan') {
      const result = await request(pathFor(`/lifecycle/requests/${id}/plan`), { method: 'POST', body: {} });
      setNotice(`Plan prepared: ${result.request?.status || 'recorded'}. No physical deletion occurred.`, 'success'); await refreshLifecycle();
    } else if (target.dataset.action === 'lifecycle-cancel') {
      await request(pathFor(`/lifecycle/requests/${id}/cancel`), { method: 'POST', body: {} }); setNotice('Prepared lifecycle request cancelled.', 'success'); await refreshLifecycle();
    } else if (target.dataset.action === 'lifecycle-download') {
      const artifact = await request(pathFor(`/lifecycle/exports/${id}/download`));
      const bytes = Uint8Array.from(atob(artifact.contentBase64 || ''), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: artifact.contentType || 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = artifact.filename || 'astra-export.json'; link.click(); URL.revokeObjectURL(url);
      setNotice(`Downloaded stored export ${artifact.filename || ''} · ${artifact.byteLength ?? bytes.length} bytes.`, 'success');
    }
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#radar-watch-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  const body = { sourceId: f.sourceId.value.trim(), cadenceMinutes: Number(f.cadenceMinutes.value), minCadenceMinutes: Number(f.minCadenceMinutes.value), maxCadenceMinutes: Number(f.maxCadenceMinutes.value), maxObservationsPerDay: Number(f.maxObservationsPerDay.value) };
  try { const result = await request(pathFor('/radar/watches'), { method: 'POST', body }); setNotice(`Stored-snapshot watch ${result.watch?.id || ''} created. No network fetch was performed.`, 'success'); await refreshRadar(); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#radar-watches-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action]'); if (!target || !tenantRequired()) return;
  const id = encodeURIComponent(target.dataset.watchId || '');
  try {
    if (target.dataset.action === 'radar-refresh') {
      const result = await request(pathFor(`/radar/watches/${id}/refresh`), { method: 'POST', body: {} });
      setNotice(`Explicit refresh ${result.refresh?.id || ''} queued after commit. Network fetch remains disabled.`, 'success');
    } else if (target.dataset.action === 'radar-pause' || target.dataset.action === 'radar-resume') {
      const verb = target.dataset.action === 'radar-pause' ? 'pause' : 'resume';
      await request(pathFor(`/radar/watches/${id}/${verb}`), { method: 'POST', body: {} }); setNotice(`Radar watch ${verb}d.`, 'success'); await refreshRadar();
    }
  } catch (error) { setNotice(error.message, 'error'); }
});

for (const [formId, endpoint, label] of [['learning-train-form', '/learning/artifacts', 'Training request'], ['learning-allocation-form', '/allocation/plan', 'Allocation plan'], ['learning-skill-form', '/skills', 'Skill candidate']]) {
  $( `#${formId}`).addEventListener('submit', async event => {
    event.preventDefault(); if (!tenantRequired()) return;
    try {
      const result = await request(pathFor(endpoint), { method: 'POST', body: JSON.parse(event.currentTarget.elements.body.value) });
      $('#learning-status').className = 'status-box'; $('#learning-status').textContent = JSON.stringify(result, null, 2);
      const execution = result.execution ? ` · execution ${result.execution}` : '';
      setNotice(`${label} submitted${execution}. Server returned the authoritative status; release readiness remains false.`, 'success'); await refreshLearning();
    } catch (error) { setNotice(error instanceof SyntaxError ? `${label} JSON could not be parsed: ${error.message}` : error.message, 'error'); }
  });
}

$('#learning-optimizer-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  const iterations = Number(f.iterations.value), maxDevExamples = Number(f.maxDevExamples.value);
  const maxProviderCalls = Number(f.maxProviderCalls.value);
  if (maxProviderCalls < iterations * maxDevExamples) { setNotice('Maximum provider calls must cover iterations × development examples.', 'error'); return; }
  const body = { datasetId: f.datasetId.value.trim(), candidatePrompt: f.candidatePrompt.value, engine: f.engine.value,
    budget: { iterations, maxDevExamples, maxProviderCalls, deadlineMs: Number(f.deadlineMs.value) } };
  try {
    const result = await request(pathFor('/learning/optimizer/prepare'), { method: 'POST', body });
    const jobId = result.job?.id || result.id || '';
    if (jobId) $('#learning-optimizer-action-form').elements.jobId.value = jobId;
    setNotice(`Bounded optimizer job ${jobId || ''} prepared. Execution is a separate explicit action; no approval or release readiness is implied.`, 'success');
    await refreshLearning();
    $('#learning-status').className = 'status-box'; $('#learning-status').textContent = JSON.stringify(result, null, 2);
  } catch (error) { $('#learning-status').className = 'status-box blocked-note'; $('#learning-status').textContent = `Optimizer preparation failed: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#learning-optimizer-action-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const form = event.currentTarget, jobId = form.elements.jobId.value.trim();
  const action = event.submitter?.dataset.action;
  try {
    const result = action === 'optimizer-execute'
      ? await request(pathFor(`/learning/optimizer/${encodeURIComponent(jobId)}/execute`), { method: 'POST', body: {} })
      : await request(pathFor(`/learning/optimizer/${encodeURIComponent(jobId)}`));
    $('#learning-status').className = 'status-box'; $('#learning-status').textContent = JSON.stringify(result, null, 2);
    setNotice(action === 'optimizer-execute' ? `Optimizer run requested for job ${jobId}; inspect server-owned status and diagnostics.` : `Optimizer status loaded for job ${jobId}.`, 'success');
  } catch (error) { $('#learning-status').className = 'status-box blocked-note'; $('#learning-status').textContent = `Optimizer ${action === 'optimizer-execute' ? 'execution' : 'status'} failed: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#learning-skill-action-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor(`/skills/${encodeURIComponent(f.skillId.value.trim())}/transition`), { method: 'POST', body: { status: f.status.value, reason: f.reason.value.trim() } });
    setNotice(`Skill transition recorded as ${result.skill?.status || f.status.value}; release readiness remains false.`, 'success'); await refreshLearning();
  } catch (error) { setNotice(error.message, 'error'); }
});

$('#economics-quota-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try { const result = await request(pathFor('/economics/quota'), { method: 'PUT', body: JSON.parse(event.currentTarget.elements.body.value) }); setNotice(`Tenant quota saved (${result.quota?.enabled ? 'enabled for future wired entries' : 'disabled'}).`, 'success'); await refreshEconomics(); }
  catch (error) { setNotice(error instanceof SyntaxError ? `Quota JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

for (const [formId, endpoint, label] of [['economics-bill-form', '/economics/vendor-bills', 'Vendor bill'], ['economics-effort-form', '/economics/reviewer-effort', 'Reviewer effort'], ['postsale-project-form', '/post-sale/projects', 'Delivery project']]) {
  $(`#${formId}`).addEventListener('submit', async event => {
    event.preventDefault(); if (!tenantRequired()) return;
    try { const result = await request(pathFor(endpoint), { method: 'POST', body: JSON.parse(event.currentTarget.elements.body.value) }); setNotice(`${label} recorded.`, 'success'); await refreshEconomics(); if (result.project?.id) $('#postsale-proof-form').elements.projectId.value = result.project.id; }
    catch (error) { setNotice(error instanceof SyntaxError ? `${label} JSON could not be parsed: ${error.message}` : error.message, 'error'); }
  });
}

$('#postsale-proof-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, projectId = encodeURIComponent(f.projectId.value.trim()), action = f.action.value;
  const endpoint = action === 'comparison' ? `/post-sale/projects/${projectId}/comparison` : action === 'milestones' || action === 'evidence' || action === 'case-studies' || action === 'renewal-signals' ? `/post-sale/projects/${projectId}/${action}` : '';
  try {
    const result = action === 'comparison'
      ? await request(pathFor(endpoint))
      : await request(pathFor(endpoint), { method: 'POST', body: JSON.parse(f.body.value) });
    $('#economics-status').className = 'status-box'; $('#economics-status').textContent = JSON.stringify(result, null, 2);
    if (action === 'case-studies' && result.caseStudy?.id) $('#customer-challenge-form').elements.caseStudyId.value = result.caseStudy.id;
    setNotice(action === 'comparison' ? 'Stored post-sale proof comparison loaded.' : `${action} recorded. No outreach or CRM mutation was performed.`, 'success'); await refreshEconomics();
  } catch (error) { setNotice(error instanceof SyntaxError ? `Proof JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

function showCustomerApprovalResult(value, kind = '') {
  const box = $('#customer-approval-status');
  box.className = `status-box${kind ? ` ${kind}` : ''}`;
  box.textContent = JSON.stringify(value, null, 2);
}

$('#customer-key-enroll-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const publicKeyPem = f.publicKeyPem.value.trim();
    if (!publicKeyPem.includes('-----BEGIN PUBLIC KEY-----') || /-----BEGIN [^-]*PRIVATE KEY-----/.test(publicKeyPem)) {
      f.publicKeyPem.value = '';
      throw new Error('Paste only an Ed25519 PUBLIC KEY PEM. Private-key material is rejected locally and is never submitted.');
    }
    const result = await request(pathFor('/customer-approvals/keys'), { method: 'POST', body: {
      projectId: f.projectId.value.trim(),
      publicKey: { pem: publicKeyPem },
      identityRightsEvidence: { identity: f.identityEvidence.value.trim(), rights: f.rightsEvidence.value.trim() },
    } });
    showCustomerApprovalResult({ enrollment: result.key, privateKeySentToServer: false, nextStep: 'A different authenticated reviewer must confirm this key using its ID.' });
    if (result.key?.id) $('#customer-key-confirm-form').elements.keyId.value = result.key.id;
    setNotice(`Customer public key enrolled as ${result.key?.state || 'pending review'}. A separate reviewer must confirm it.`, 'success');
  } catch (error) { showCustomerApprovalResult({ error: error.message }, 'blocked-note'); setNotice(error.message, 'error'); }
});

$('#customer-key-confirm-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const keyId = event.currentTarget.elements.keyId.value.trim();
  try {
    const result = await request(pathFor(`/customer-approvals/keys/${encodeURIComponent(keyId)}/confirm`), { method: 'POST', body: {} });
    showCustomerApprovalResult({ key: result.key, nextStep: 'Use this confirmed key ID to create an offline challenge for a case-study version.' });
    if (result.key?.id) $('#customer-challenge-form').elements.customerKeyId.value = result.key.id;
    setNotice(`Customer key ${result.key?.state || 'confirmation'} recorded by the reviewer.`, 'success');
  } catch (error) { showCustomerApprovalResult({ error: error.message }, 'blocked-note'); setNotice(error.message, 'error'); }
});

$('#customer-challenge-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor('/customer-approvals/challenges'), { method: 'POST', body: {
      caseStudyId: f.caseStudyId.value.trim(), customerKeyId: f.customerKeyId.value.trim(), action: f.action.value,
      expiresInSeconds: Number(f.expiresInSeconds.value),
    } });
    if (result.challenge?.id) $('#customer-signature-form').elements.challengeId.value = result.challenge.id;
    showCustomerApprovalResult({ challenge: result.challenge, instruction: 'Forward the exact challenge string to the customer. They sign its UTF-8 bytes offline with their private key and return a canonical 64-byte Ed25519 base64 signature. The private key is never uploaded.' });
    setNotice(`Offline challenge ${result.challenge?.id || ''} created; it expires ${result.challenge?.expiresAt || 'as returned by server'}. No signature or publication occurred.`, 'success');
  } catch (error) { showCustomerApprovalResult({ error: error.message }, 'blocked-note'); setNotice(error.message, 'error'); }
});

$('#customer-signature-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, challengeId = f.challengeId.value.trim();
  try {
    const result = await request(pathFor(`/customer-approvals/challenges/${encodeURIComponent(challengeId)}/signature`), { method: 'POST', body: { signature: f.signature.value.trim() } });
    showCustomerApprovalResult({ receipt: result.receipt, publishable: result.receipt?.publishable ?? false, contactPermission: result.receipt?.contactPermission ?? false });
    setNotice(`Detached customer signature verification recorded (${result.receipt?.action || 'unknown action'}). No publishing or contact permission was granted.`, 'success');
  } catch (error) { showCustomerApprovalResult({ error: error.message }, 'blocked-note'); setNotice(error.message, 'error'); }
});

$('#customer-approval-status-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const caseStudyId = event.currentTarget.elements.caseStudyId.value.trim();
  try {
    const result = await request(pathFor(`/post-sale/case-studies/${encodeURIComponent(caseStudyId)}/customer-approval`));
    showCustomerApprovalResult(result);
    setNotice(`Customer approval state: ${result.state || 'unknown'}; publishable=${result.publishable === true}, contactPermission=${result.contactPermission === true}.`, 'success');
  } catch (error) { showCustomerApprovalResult({ error: error.message }, 'blocked-note'); setNotice(error.message, 'error'); }
});

$('#postsale-projects-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="postsale-select-project"]'); if (!target) return;
  $('#postsale-proof-form').elements.projectId.value = target.dataset.projectId;
  $('#customer-key-enroll-form').elements.projectId.value = target.dataset.projectId;
});

$('#benchmark-prepare-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const result = await request(pathFor('/economics/benchmarks'), { method: 'POST', body: { targetAccounts: Number(f.targetAccounts.value), evidenceAgeDays: Number(f.evidenceAgeDays.value) } });
    const cohort = result.cohort;
    if (cohort?.id) setBenchmarkInputs(cohort.id);
    renderBenchmarkDetail(cohort ? { cohort, report: null, quotes: [] } : result);
    setNotice(`Frozen benchmark cohort ${cohort?.id || ''} prepared: ${cohort?.permittedAccounts ?? 'unknown'} permitted, shortfall ${cohort?.shortfall ?? 'unknown'}. No workflow was run.`, 'success');
    await refreshBenchmarks();
  } catch (error) { $('#benchmark-status').className = 'status-box blocked-note'; $('#benchmark-status').textContent = `Benchmark cohort preparation failed: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#benchmark-refresh').addEventListener('click', async () => {
  if (!tenantRequired()) return;
  try { await refreshBenchmarks(); setNotice('Benchmark cohorts refreshed.', 'success'); }
  catch (error) { $('#benchmark-status').className = 'status-box blocked-note'; $('#benchmark-status').textContent = `Benchmark list unavailable: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#benchmark-cohorts-list').addEventListener('click', async event => {
  const target = event.target.closest('button[data-action="benchmark-select"]'); if (!target) return;
  const benchmarkId = target.dataset.benchmarkId;
  setBenchmarkInputs(benchmarkId);
  if (!tenantRequired()) return;
  try {
    const result = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(benchmarkId)}`));
    renderBenchmarkDetail(result);
    setNotice(`Benchmark cohort ${benchmarkId} loaded. Reports and costs remain provisional until server requirements are met.`, 'success');
  } catch (error) { $('#benchmark-status').className = 'status-box blocked-note'; $('#benchmark-status').textContent = `Benchmark cohort unavailable: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#benchmark-quotes-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="benchmark-quote-select"]'); if (!target) return;
  setBenchmarkInputs(target.dataset.benchmarkId);
  $('#benchmark-quote-review-form').elements.quoteId.value = target.dataset.quoteId || '';
  setNotice(`Quote ${target.dataset.quoteId || ''} selected for an independently authorized review.`, 'success');
});

$('#benchmark-actions-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const form = event.currentTarget, id = form.elements.benchmarkId.value.trim(), action = event.submitter?.dataset.action;
  try {
    let result;
    if (action === 'benchmark-inspect') result = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(id)}`));
    else if (action === 'benchmark-report') result = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(id)}/report`), { method: 'POST', body: {} });
    else {
      const workflowIds = $$('#workflows-list input[name="benchmarkWorkflow"]:checked').map(input => input.value);
      if (!workflowIds.length || workflowIds.length > 100) { setNotice('Select between one and 100 existing workflows from the Workflows section.', 'error'); return; }
      result = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(id)}/collect`), { method: 'POST', body: { workflowIds } });
    }
    const detail = action === 'benchmark-inspect' ? result : await request(pathFor(`/economics/benchmarks/${encodeURIComponent(id)}`));
    renderBenchmarkDetail(detail);
    const summary = action === 'benchmark-collect' ? 'Existing selected workflows were recorded; no job was scheduled.' : action === 'benchmark-report' ? 'Server-derived benchmark report stored.' : 'Persisted benchmark state loaded.';
    setNotice(`${summary} releaseReady=false.`, 'success'); await refreshBenchmarks();
  } catch (error) { $('#benchmark-status').className = 'status-box blocked-note'; $('#benchmark-status').textContent = `Benchmark action failed: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#benchmark-quote-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, amountMinor = Number(f.amountMinor.value), benchmarkId = f.benchmarkId.value.trim();
  if (!Number.isSafeInteger(amountMinor)) { setNotice('Quote amount must be a safe integer in minor currency units.', 'error'); return; }
  const body = { vendor: f.vendor.value.trim(), evidenceReference: f.evidenceReference.value.trim(), evidenceSha256: f.evidenceSha256.value.trim(),
    provenance: { kind: f.provenanceKind.value.trim(), source: f.provenanceSource.value.trim() }, amountMinor, currency: f.currency.value.trim(), unit: f.unit.value.trim(), effectiveFrom: f.effectiveFrom.value,
    ...(f.effectiveUntil.value ? { effectiveUntil: f.effectiveUntil.value } : {}) };
  try {
    const result = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(benchmarkId)}/quotes`), { method: 'POST', body });
    if (result.quote?.id) $('#benchmark-quote-review-form').elements.quoteId.value = result.quote.id;
    setNotice(`Vendor quote evidence ${result.quote?.id || ''} stored as unverified; owner and independent review are required.`, 'success');
    const state = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(benchmarkId)}`)); renderBenchmarkDetail(state);
  } catch (error) { $('#benchmark-status').className = 'status-box blocked-note'; $('#benchmark-status').textContent = `Quote evidence was not accepted: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#benchmark-quote-review-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements, benchmarkId = f.benchmarkId.value.trim(), quoteId = f.quoteId.value.trim();
  try {
    const result = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(benchmarkId)}/quotes/${encodeURIComponent(quoteId)}/reviews`), { method: 'POST', body: { verdict: f.verdict.value, rationaleCode: f.rationaleCode.value.trim() } });
    const state = await request(pathFor(`/economics/benchmarks/${encodeURIComponent(benchmarkId)}`));
    renderBenchmarkDetail({ ...state, latestReview: result.review });
    setNotice(`Quote review recorded (${result.review?.verdict || f.verdict.value}). Independent-review rules remain enforced by the server.`, 'success');
  } catch (error) { $('#benchmark-status').className = 'status-box blocked-note'; $('#benchmark-status').textContent = `Quote review was not accepted: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#launch-release-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  try { const result = await request(pathFor('/launch/releases'), { method: 'POST', body: JSON.parse(event.currentTarget.elements.body.value) }); setNotice(`Release manifest ${result.release?.id || ''} prepared as ${result.release?.status || 'pending_approval'}; no deployment occurred.`, 'success'); await refreshLaunch(); }
  catch (error) { setNotice(error instanceof SyntaxError ? `Launch JSON could not be parsed: ${error.message}` : error.message, 'error'); }
});

$('#launch-signoff-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try { const result = await request(pathFor(`/launch/releases/${encodeURIComponent(f.releaseId.value.trim())}/signoff`), { method: 'POST', body: { decision: f.decision.value, reasonCode: f.reasonCode.value.trim() } }); setNotice(`Signoff recorded: ${result.status || 'pending'}. No deployment occurred; release readiness remains false.`, 'success'); await refreshLaunch(); }
  catch (error) { setNotice(error.message, 'error'); }
});

$('#launch-validation-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!tenantRequired()) return;
  const f = event.currentTarget.elements;
  try {
    const body = {
      baselineRunId: f.baselineRunId.value.trim(), candidateRunId: f.candidateRunId.value.trim(),
      baselineCandidateId: f.baselineCandidateId.value.trim(), candidateCandidateId: f.candidateCandidateId.value.trim(),
      ...(f.outcomeReportId.value.trim() ? { outcomeReportId: f.outcomeReportId.value.trim() } : {}),
    };
    const result = await request(pathFor('/launch/validation/compare'), { method: 'POST', body });
    $('#launch-validation').className = 'status-box'; $('#launch-validation').textContent = JSON.stringify({ validation: result.validation, releaseReady: false, deployment: false }, null, 2);
    setNotice(`Frozen validation report ${result.validation?.id || ''} stored. Outcomes and unknowns are derived from referenced records; no promotion occurred.`, 'success'); await refreshLaunch();
  } catch (error) { $('#launch-validation').className = 'status-box blocked-note'; $('#launch-validation').textContent = `Validation comparison was not accepted: ${error.message}`; setNotice(error.message, 'error'); }
});

$('#launch-releases-list').addEventListener('click', event => {
  const target = event.target.closest('button[data-action="launch-select-release"]'); if (!target) return;
  $('#launch-signoff-form').elements.releaseId.value = target.dataset.releaseId;
});

$$('[data-refresh]').forEach(control => control.addEventListener('click', async () => {
  if (!tenantRequired()) return;
  const runs = { memberships: refreshMemberships, ledger: refreshLedger, offers: refreshOffers, workflows: refreshWorkflows, ai: refreshAi, research: refreshResearch, sourceCollection: refreshSourceCollection, permissions: refreshPermissions, inbox: refreshInbox, campaigns: refreshCampaigns, connectors: refreshConnectors, operations: refreshOperations, decisions: refreshDecisions, evaluation: refreshEvaluation, automation: refreshAutomation, insights: refreshInsights, lifecycle: refreshLifecycle, radar: refreshRadar, learning: refreshLearning, economics: refreshEconomics, benchmarks: refreshBenchmarks, launch: refreshLaunch };
  try { await runs[control.dataset.refresh](); setNotice('Section refreshed.', 'success'); }
  catch (error) { setNotice(error.message, 'error'); }
}));

checkSession().then(() => {
  const saved = localStorage.getItem(STORE_KEY);
  if (saved) selectTenant(saved);
});
