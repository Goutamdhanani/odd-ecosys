import { Auth, Campaigns, Leads, Personalize, Sending, Verify, fmtNum } from './api.js';
import { escapeHtml, icon, notify } from './ui.js';

const STEPS = [
  ['recipients', 'Recipients'], ['review', 'Verify & review copy'], ['sequence', 'Sequence'],
  ['senders', 'Senders & timing'], ['ready', 'Final review'], ['activity', 'Activity'],
];
const READINESS_LABELS = {
  eligible: 'Ready for final review', verification_required: 'Needs email verification', missing_email: 'Missing email address',
  suppressed: 'Suppressed email', contact_not_ready: 'Contact needs review', personalization_required: 'No saved message yet',
  copy_review_required: 'Message needs a guardrail correction', approval_required: 'Message needs approval', copy_incomplete: 'Message is incomplete',
  already_queued: 'Already queued', already_sent: 'SMTP accepted', sequence_running: 'Waiting for the next sequence step',
  sequence_failed: 'Sequence stopped after a send failure', submission_uncertain: 'SMTP result needs review',
  out_of_office_deferred: 'Deferred while out of office', out_of_office_review: 'Out-of-office reply needs review',
  stopped: 'Stopped', completed: 'Sequence complete', not_active: 'Campaign enrollment is inactive', not_enrolled: 'Not enrolled',
};
let workspaceGeneration = 0;
let activeViewRevision = 0;
let activeWorkspaceId = null;
let activeStep = 'recipients';
let latestAudience = null;
let focusedCampaignId = null;
// Draft text stays in this page's memory and keeps the version it was edited from.
const editorBuffers = new Map();
const pendingSaves = new Map();
const copyFeedback = new Map();
window.addEventListener('beforeunload', event => {
  if (!editorBuffers.size && !pendingSaves.size) return;
  event.preventDefault(); event.returnValue = '';
});

function setWorkspaceView(container, host, showWorkspace) {
  const overview = container?.querySelector('[data-campaign-overview]');
  if (overview) overview.hidden = showWorkspace;
  if (host) host.hidden = !showWorkspace;
}

const idOf = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const jsonHash = async value => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
async function loadCompleteAudience(campaignId) {
  const pageSize = 200;
  let offset = 0;
  let first = null;
  const items = [];
  while (true) {
    const page = await Campaigns.audience(campaignId, { limit: pageSize, offset });
    if (!first) first = page;
    if (!Array.isArray(page.items) || !page.pagination) throw new Error('Recipient list pagination is unavailable. Retry before reviewing copy.');
    items.push(...page.items);
    offset += page.items.length;
    if (!page.pagination.hasMore) {
      if (Number.isFinite(Number(page.counts?.total)) && items.length !== Number(page.counts.total)) throw new Error('Recipient list changed while loading. Retry to review the complete current audience.');
      return { ...first, items, pagination: { ...page.pagination, offset: 0, limit: items.length, hasMore: false } };
    }
    if (!page.items.length || offset > 10000) throw new Error('Recipient list exceeded the supported review page. Narrow the campaign audience and retry.');
  }
}

const editorKey = (campaignId, leadId) => `${campaignId}:${leadId}`;
function copyVersion(item = {}) {
  const current = latestCopy(item);
  const id = idOf(current?.personalization_id ?? current?.personalizationId ?? item.latest_personalization_id ?? item.latestPersonalizationId);
  const subject = String(current?.subject_line ?? current?.subjectLine ?? item.subject_line ?? '');
  const body = String(current?.body_text ?? current?.bodyText ?? item.body_text ?? '');
  const approved = current?.approved ?? item.approved;
  const guardrailPassed = current?.guardrail_passed ?? current?.guardrailPassed ?? item.guardrail_passed ?? item.guardrailPassed;
  const fingerprint = id ? [id, subject, body, approved, guardrailPassed] : null;
  return { id, subject, body, fingerprint, hash: current?.latestCopyHash ?? current?.latest_copy_hash ?? item.latestCopyHash ?? item.latest_copy_hash ?? null };
}
function sameVersion(left, right) {
  return left.id === right.id && JSON.stringify(left.fingerprint) === JSON.stringify(right.fingerprint);
}
function captureEditor(card) {
  const baseline = card.__cwBaseline;
  const campaignId = idOf(card.dataset.cwCampaign), leadId = idOf(card.dataset.cwContact);
  if (!baseline || !campaignId || !leadId) return null;
  const subject = card.querySelector('[data-cw-subject]')?.value;
  const body = card.querySelector('[data-cw-body]')?.value;
  if (subject === undefined || body === undefined) return null;
  const key = editorKey(campaignId, leadId);
  const previous = editorBuffers.get(key);
  if (subject === baseline.subject && body === baseline.body && !previous?.rejected && !pendingSaves.has(key)) {
    editorBuffers.delete(key); return null;
  }
  const buffer = { ...previous, subject, body, baseline: previous?.baseline || baseline };
  editorBuffers.set(key, buffer);
  return buffer;
}
function captureEditors(host) {
  if (!host) return;
  host.querySelectorAll('[data-cw-contact]').forEach(card => {
    captureEditor(card);
  });
}
function updateEditorState(card, item) {
  const key = editorKey(card.dataset.cwCampaign, card.dataset.cwContact);
  const buffer = editorBuffers.get(key);
  const node = card.querySelector('[data-cw-editor-state]');
  if (!node) return;
  node.replaceChildren();
  if (!buffer) return;
  const current = copyVersion(item);
  const conflict = !sameVersion(buffer.baseline, current) || buffer.rejected;
  const text = document.createElement('p');
  text.textContent = conflict
    ? 'Your unsaved edits are preserved. The saved review changed or could not accept this edit. Compare the current saved copy before deciding what to keep.'
    : 'Unsaved edits are kept while you use this campaign workspace. Save them before closing this page.';
  node.append(text);
  if (conflict) {
    const details = document.createElement('details'); details.open = true;
    const summary = document.createElement('summary'); summary.textContent = 'Compare with current saved version'; details.append(summary);
    const version = document.createElement('p');
    version.textContent = `Your edit started from ${buffer.baseline.id ? `version #${buffer.baseline.id}` : 'no saved copy'}. Current saved copy: ${current.id ? `version #${current.id}` : 'none'}${current.fingerprint?.[3] ? ' · approved' : ' · not approved'}.`;
    const subject = document.createElement('p'); subject.textContent = `Saved subject: ${current.subject || '(empty)'}`;
    const body = document.createElement('p'); body.textContent = `Saved message: ${current.body || '(empty)'}`;
    details.append(version, subject, body); node.append(details);
  }
  const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'btn btn-ghost btn-sm'; discard.dataset.cwDiscard = '';
  discard.textContent = 'Discard this contact’s edits and load latest'; discard.disabled = pendingSaves.has(key);
  discard.addEventListener('click', () => {
    if (pendingSaves.has(key) || !card.isConnected || activeWorkspaceId !== Number(card.dataset.cwCampaign) || activeStep !== 'review') return;
    editorBuffers.delete(key);
    // Avoid recapturing the deliberately discarded text during the next render.
    card.querySelector('[data-cw-subject]').value = card.__cwBaseline.subject;
    card.querySelector('[data-cw-body]').value = card.__cwBaseline.body;
    void renderWorkspace(card.closest('[data-campaign-workspace]'), Number(card.dataset.cwCampaign));
  });
  node.append(discard);
  if (buffer.rejected) card.querySelector('[data-cw-copy-status]').textContent = buffer.rejected;
}
function reviewContext(host, button, campaignId) {
  const revision = activeViewRevision, generation = workspaceGeneration;
  return () => host.isConnected && button.isConnected && host.contains(button)
    && activeWorkspaceId === campaignId && host.dataset.cwRenderedCampaign === String(campaignId)
    && activeViewRevision === revision && workspaceGeneration === generation && activeStep === 'review';
}
function guardrailInstruction(reason) {
  const value = String(reason);
  if (/^body_too_short:\d+_words$/.test(value)) return 'The message is too short. Add useful detail before saving a correction.';
  if (/^body_too_long:\d+_words$/.test(value)) return 'The message is too long. Shorten it before saving a correction.';
  if (/^subject_too_long:\d+_chars$/.test(value)) return 'The subject is too long. Shorten the subject line.';
  if (value === 'missing_subject') return 'Add a subject line.';
  if (value === 'missing_body') return 'Add a message body.';
  if (value.startsWith('spam_word:')) return `Remove or rephrase the flagged wording: ${value.slice('spam_word:'.length)}.`;
  if (value.startsWith('banned_opener:')) return `Rewrite the flagged opening: ${value.slice('banned_opener:'.length)}.`;
  if (value === 'excessive_caps') return 'Use normal capitalization in the message.';
  if (/^excessive_exclamations:\d+$/.test(value)) return 'Reduce the number of exclamation marks.';
  if (value === 'missing_business_name_reference') return 'Include this contact’s business name in the message.';
  return `Review the saved guardrail warning: ${value}`;
}
function setWorkspaceStep(step) {
  if (activeStep !== step) activeViewRevision++;
  activeStep = step;
  const url = new URL(location.href);
  if (activeWorkspaceId) url.searchParams.set('campaign', String(activeWorkspaceId));
  url.searchParams.set('step', step);
  url.hash = 'campaigns';
  history.replaceState(null, '', url);
}

export function openCampaignWorkspace(campaignId, step = 'recipients') {
  const id = idOf(campaignId);
  if (!id) return;
  captureEditors(document.querySelector('[data-campaign-workspace]'));
  const url = new URL(window.location.href);
  url.searchParams.set('campaign', String(id));
  url.searchParams.set('step', STEPS.some(([key]) => key === step) ? step : 'recipients');
  url.hash = 'campaigns';
  history.replaceState(null, '', url);
  const nextStep = STEPS.some(([key]) => key === step) ? step : 'recipients';
  if (activeWorkspaceId !== id || activeStep !== nextStep) activeViewRevision++;
  activeWorkspaceId = id;
  activeStep = nextStep;
  const host = document.querySelector('[data-campaign-workspace]');
  setWorkspaceView(host?.parentElement, host, true);
  if (host) void renderWorkspace(host, id);
}

export function mountCampaignWorkspace(container, campaigns) {
  let host = container.querySelector('[data-campaign-workspace]');
  if (!host) {
    host = document.createElement('section');
    host.className = 'campaign-workspace';
    host.dataset.campaignWorkspace = '';
    host.setAttribute('aria-live', 'polite');
    container.append(host);
  }
  container.dataset.campaignRoot = '';
  window.__refreshCampaignWorkspace = () => {
    if (activeWorkspaceId && host.isConnected) void renderWorkspace(host, activeWorkspaceId);
  };
  const params = new URLSearchParams(location.search);
  const requested = params.get('campaign');
  const id = idOf(requested);
  const hasRequestedWorkspace = Boolean(requested);
  setWorkspaceView(container, host, hasRequestedWorkspace);
  if (id && String(id) === requested && campaigns.some(campaign => Number(campaign.id) === id)) {
    const nextStep = STEPS.some(([key]) => key === params.get('step')) ? params.get('step') : 'recipients';
    if (activeWorkspaceId !== id || activeStep !== nextStep) activeViewRevision++;
    activeWorkspaceId = id;
    activeStep = nextStep;
    void renderWorkspace(host, id);
  } else if (requested) {
    host.innerHTML = `<div class="campaign-workspace-error" role="alert"><h2>Saved campaign unavailable</h2><p>Campaign ${escapeHtml(requested)} is not in the current saved campaign list. Reload the campaign list and choose a saved campaign.</p><button class="btn btn-ghost" type="button" data-cw-clear>Show all campaigns</button></div>`;
    host.querySelector('[data-cw-clear]')?.addEventListener('click', () => {
      const url = new URL(location.href); url.searchParams.delete('campaign'); url.searchParams.delete('step'); history.replaceState(null, '', url);
      setWorkspaceView(container, host, false);
      host.replaceChildren();
    });
  }
  container.querySelectorAll('[data-campaign-workspace-open]').forEach(button => button.addEventListener('click', () => openCampaignWorkspace(button.dataset.campaignWorkspaceOpen)));
}

async function renderWorkspace(host, campaignId) {
  const generation = ++workspaceGeneration;
  captureEditors(host);
  const requestedStep = activeStep;
  host.innerHTML = `<div class="campaign-workspace-loading"><span class="spinner" aria-hidden="true"></span><span>Loading saved campaign state…</span></div>`;
  try {
    const [campaignList, audience, sequence, senderSelection, schedule, auth] = await Promise.all([
      Campaigns.list(), loadCompleteAudience(campaignId), Campaigns.sequence(campaignId),
      Campaigns.senders(campaignId), Sending.schedule(), Auth.status(),
    ]);
    if (generation !== workspaceGeneration || !host.isConnected || activeWorkspaceId !== campaignId) return;
    const campaign = campaignList.find(item => Number(item.id) === campaignId);
    if (!campaign) throw new Error('This saved campaign is no longer available.');
    latestAudience = audience;
    drawWorkspace(host, { campaign, audience, sequence, senderSelection, schedule, auth });
    host.dataset.cwRenderedCampaign = String(campaignId);
    bindWorkspace(host, campaignId, requestedStep);
    if (focusedCampaignId !== campaignId) {
      focusedCampaignId = campaignId;
      const heading = host.querySelector('.cw-heading h1');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus({ preventScroll: true });
      host.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  } catch (error) {
    if (generation !== workspaceGeneration || !host.isConnected || activeWorkspaceId !== campaignId) return;
    host.innerHTML = `<div class="campaign-workspace-error" role="alert"><span class="eyebrow">CAMPAIGN WORKSPACE</span><h2>Campaign state could not load</h2><p>${escapeHtml(error.message || 'The saved campaign data is unavailable.')}</p><button class="btn btn-primary" type="button" data-cw-retry>Try again</button><button class="btn btn-ghost" type="button" data-cw-back>All campaigns</button></div>`;
    host.querySelector('[data-cw-retry]')?.addEventListener('click', () => void renderWorkspace(host, campaignId));
    host.querySelector('[data-cw-back]')?.addEventListener('click', closeWorkspace);
  }
}

function drawWorkspace(host, state) {
  const { campaign, audience, sequence, senderSelection, schedule, auth } = state;
  const current = STEPS.find(([step]) => step === activeStep) || STEPS[0];
  const items = Array.isArray(audience.items) ? audience.items : [];
  const counts = audience.counts || null;
  const canWrite = ['owner', 'admin', 'operator'].includes(auth?.user?.role);
  const stateName = campaign.status === 'draft' ? 'Draft' : campaign.status === 'active' ? 'Active' : campaign.status;
  const summary = counts ? `${fmtNum(counts.total)} enrolled · ${fmtNum(counts.eligible)} eligible` : 'Recipient counts unavailable';
  const done = {
    recipients: counts ? Number(counts.total) > 0 : false,
    review: counts ? items.length === Number(counts.total) && items.length > 0 && items.every(item => hasApprovedCurrentCopy(item) && item.eligibility === 'eligible') : false,
    sequence: hasCompleteSequence(sequence),
    senders: Number.isFinite(Number(senderSelection.readyCount)) && Number(senderSelection.readyCount) > 0,
    ready: false,
    activity: false,
  };
  const nextStep = campaign.status !== 'draft' ? 'activity' : !done.recipients ? 'recipients' : !done.review ? 'review' : !done.sequence ? 'sequence' : !done.senders ? 'senders' : 'ready';
  const content = activeStep === 'recipients' ? recipientStep(campaign, audience)
    : activeStep === 'review' ? reviewStep(campaign, audience)
      : activeStep === 'sequence' ? sequenceStep(campaign, sequence, items)
        : activeStep === 'senders' ? senderStep(senderSelection, schedule, auth)
          : activeStep === 'ready' ? readyStep(campaign, counts, sequence, senderSelection)
            : activityStep(campaign);
  host.innerHTML = `
    <header class="cw-heading"><div><span class="eyebrow">SAVED CAMPAIGN WORKSPACE</span><h1>${escapeHtml(campaign.name)}</h1><p>${escapeHtml(stateName)} · ${escapeHtml(summary)}</p></div><button type="button" class="btn btn-ghost btn-sm" data-cw-close>All campaigns</button></header>
    <div class="cw-progress"><div class="cw-primary-action"><div><span class="eyebrow">NEXT ACTION</span><strong>${escapeHtml(nextLabel(nextStep))}</strong><span>${escapeHtml(nextWhy(nextStep, counts, sequence, senderSelection))}</span></div><button type="button" class="btn btn-primary" data-cw-next="${nextStep}">${escapeHtml(nextLabel(nextStep))} ${icon('arrow-right', 15)}</button></div>
      <nav class="cw-step-nav" aria-label="Campaign setup steps">${STEPS.map(([key, label], index) => `<button type="button" class="cw-step ${key === activeStep ? 'is-current' : ''} ${done[key] ? 'is-done' : ''}" data-cw-step="${key}" aria-current="${key === activeStep ? 'step' : 'false'}"><span>${done[key] ? '✓' : index + 1}</span><strong>${escapeHtml(label)}</strong></button>`).join('')}</nav>
    </div><section class="cw-content" aria-labelledby="cw-section-title"><h2 id="cw-section-title">${escapeHtml(current[1])}</h2>${canWrite ? '' : '<p class="cw-readonly" role="status">Read-only access. An owner, admin, or operator can prepare this campaign; an owner or admin manages the shared send schedule.</p>'}${content}</section>`;
  if (!canWrite) host.querySelectorAll('[data-cw-audience], [data-cw-contacts], [data-cw-verify], [data-cw-save-copy], [data-cw-approve], [data-cw-sequence], [data-cw-senders], [data-cw-process]').forEach(button => { button.disabled = true; button.title = 'Your workspace role is read-only.'; });
  if (!canWrite && nextStep !== 'ready') {
    const next = host.querySelector('[data-cw-next]');
    if (next) { next.disabled = true; next.textContent = 'Read-only access'; }
  }
}

function nextLabel(step) { return ({ recipients: 'Add recipients', review: 'Review contacts', sequence: 'Configure sequence', senders: 'Choose senders', ready: 'Review & queue' })[step] || 'Open activity'; }
function nextWhy(step, counts, sequence, senders) {
  if (step === 'recipients') return 'Start with a saved list or select contacts for an explicit audience snapshot.';
  if (step === 'review') return 'Verify the saved address and review the latest copy for each enrolled contact.';
  if (step === 'sequence') return 'The sequence controls the messages sent; review each contact’s current copy separately.';
  if (step === 'senders') return 'Choose the real mailbox pool and check the shared workspace send window.';
  if (step === 'ready') return 'Run the final launch check. Queueing and processing are separate actions.';
  return 'Inspect recorded campaign activity and workspace replies.';
}

function readinessLabel(value) { return READINESS_LABELS[value] || 'Status unavailable'; }

function recipientStep(campaign, audience) {
  const items = Array.isArray(audience.items) ? audience.items : [];
  return `<p class="cw-help">Start with the existing contact pipeline, then enroll saved contacts or lists. Enrollment stores a snapshot and never verifies or sends email.</p><div class="cw-actions"><a class="btn btn-ghost" href="#leads" data-cw-leads>Find or import contacts</a><button class="btn btn-primary" type="button" data-cw-audience="${campaign.id}">Add saved list</button><button class="btn btn-ghost" type="button" data-cw-contacts="${campaign.id}">Choose contacts</button><button class="btn btn-ghost" type="button" data-cw-open-audience="${campaign.id}">Open full recipient eligibility</button></div>${items.length ? `<div class="cw-contact-list">${items.map(item => `<article><div><strong>${escapeHtml(item.business_name || 'Unnamed contact')}</strong><span>${escapeHtml(item.email || 'Email unavailable')} · ${escapeHtml(item.source_list_name || 'Saved contact')}</span></div><span class="campaign-eligibility ${item.eligibility === 'eligible' ? 'is-ready' : 'is-blocked'}">${escapeHtml(readinessLabel(item.eligibility))}</span></article>`).join('')}</div>` : `<p class="cw-empty">${audience.counts ? 'No contacts enrolled yet.' : 'Recipient state is unavailable.'}</p>`}`;
}

function reviewStep(campaign, audience) {
  const items = Array.isArray(audience.items) ? audience.items : [];
  if (!items.length) return `<p class="cw-help">Add recipients first. Their saved verification and copy history will appear here.</p>`;
  return `<p class="cw-help">Each current message version is reviewed individually. Verification runs only when you select a saved email and click Reverify. Fact-check status is shown as unavailable when no result exists.</p><div class="cw-review-list">${items.map(item => {
    const latest = latestCopy(item);
    const personalizationId = idOf(latest?.personalization_id ?? latest?.personalizationId ?? item.latest_personalization_id ?? item.latestPersonalizationId);
    const buffer = editorBuffers.get(editorKey(campaign.id, item.lead_id));
    const subject = buffer?.subject ?? latest?.subject_line ?? latest?.subjectLine ?? item.subject_line ?? '';
    const body = buffer?.body ?? latest?.body_text ?? latest?.bodyText ?? item.body_text ?? '';
    const approved = latest?.approved ?? item.approved;
    const guardrailPassed = latest?.guardrail_passed ?? latest?.guardrailPassed ?? item.guardrail_passed ?? item.guardrailPassed;
    const reasonList = latest?.guardrail_failures ?? latest?.guardrailFailures ?? item.guardrail_failures ?? item.guardrailFailures;
    const failures = Array.isArray(reasonList) ? reasonList.filter(value => typeof value === 'string').slice(0, 30) : [];
    const feedback = copyFeedback.get(editorKey(campaign.id, item.lead_id));
    return `<article class="cw-review-card" data-cw-contact="${item.lead_id}" data-cw-campaign="${campaign.id}"><header><div><strong>${escapeHtml(item.business_name || 'Unnamed contact')}</strong><span>${escapeHtml(item.email || 'Saved email unavailable')}</span></div><span class="campaign-eligibility ${approved && guardrailPassed ? 'is-ready' : 'is-blocked'}">${approved && guardrailPassed ? 'Current copy approved' : personalizationId ? 'Review needed' : 'No saved copy'}</span></header>
      <div class="cw-verification"><span>Current readiness: <strong>${escapeHtml(readinessLabel(item.eligibility))}</strong></span><button type="button" class="btn btn-ghost btn-sm" data-cw-verify="${item.lead_id}">Reverify saved email</button><span data-cw-verify-status aria-live="polite"></span></div>
      <label>Subject<input class="form-input" data-cw-subject maxlength="998" value="${escapeHtml(subject)}" placeholder="Write a subject line"></label><label>Message body<textarea class="form-input" data-cw-body rows="5" maxlength="50000" placeholder="Write or correct this contact’s copy">${escapeHtml(body)}</textarea></label>
      <div class="cw-copy-meta"><span>Fact check: ${escapeHtml(latest?.fact_check_status ?? item.fact_check_status ?? 'unavailable')}</span><span>Guardrails: ${guardrailPassed === true || guardrailPassed === 1 ? 'passed' : personalizationId ? 'needs correction' : 'not checked'}</span>${personalizationId ? `<span>Version #${String(personalizationId)} · ${approved ? 'approved' : 'not approved'}</span>` : '<span>First manual version</span>'}</div>
      ${failures.length ? `<p class="cw-guardrail-warning" role="status">${failures.map(value => escapeHtml(guardrailInstruction(value))).join(' ')} Save a correction; then approve the new version separately.</p>` : ''}
      <div data-cw-editor-state role="status"></div><div class="cw-actions"><button class="btn btn-primary btn-sm" type="button" data-cw-save-copy="${item.lead_id}" data-latest-id="${personalizationId || ''}">Save new version</button>${personalizationId && !approved && (guardrailPassed === true || guardrailPassed === 1) ? `<button class="btn btn-ghost btn-sm" type="button" data-cw-approve="${personalizationId}">Approve this version</button>` : ''}<span data-cw-copy-status aria-live="polite">${feedback?.fingerprint === JSON.stringify(copyVersion(item).fingerprint) ? escapeHtml(feedback.text) : ''}</span></div></article>`;
  }).join('')}</div>`;
}

function latestCopy(item) { return item.latest_personalization || item.latestPersonalization || item.latest_copy || item.latestCopy || (item.personalization_id ? item : null); }
function hasApprovedCurrentCopy(item) {
  const latest = latestCopy(item);
  return Boolean((latest?.approved ?? item.approved) && (latest?.guardrail_passed ?? latest?.guardrailPassed ?? item.guardrail_passed ?? item.guardrailPassed));
}

function hasCompleteSequence(sequence) {
  if (!Array.isArray(sequence?.steps) || !sequence.steps.length) return false;
  return sequence.steps.every(step => {
    const variants = Array.isArray(step.variants) ? step.variants : [];
    const active = variants.filter(variant => Number(variant.allocationPct) > 0);
    return active.length > 0
      && variants.reduce((total, variant) => total + Number(variant.allocationPct), 0) === 100
      && active.every(variant => String(variant.subjectLine || '').trim() && String(variant.bodyText || '').trim());
  });
}

function sequenceStep(campaign, sequence, recipients) {
  const complete = hasCompleteSequence(sequence);
  return `<p class="cw-help"><strong>Sequence controls sent messages; review each contact.</strong> Step copy has merge preview and variant allocation. It does not replace the latest per-contact review gate.</p>${sequence.steps?.length ? `<p>${fmtNum(sequence.steps.length)} saved sequence step(s) · ${complete ? 'active variants have copy and valid allocations' : 'sequence copy or allocation still needs review'}. ${sequence.executionAvailable === true ? 'Sequence execution is enabled.' : 'Sequence execution is unavailable.'}</p>` : '<p class="cw-empty">No saved sequence steps.</p>'}<div class="cw-actions"><button class="btn btn-primary" type="button" data-cw-sequence="${campaign.id}">Edit sequence &amp; preview</button>${recipients.length ? '<span>Use the real first-step merge preview to populate the editor, then save sequence copy.</span>' : '<span>Add at least one recipient to preview copy.</span>'}</div>`;
}

function senderStep(selection, schedule, auth) {
  const senderCount = Array.isArray(selection.senderIds) ? selection.senderIds.length : 0;
  const readyCount = Number.isFinite(Number(selection.readyCount)) ? Number(selection.readyCount) : null;
  const value = schedule?.schedule;
  const scheduleText = value ? `${escapeHtml(value.startHour)}:00–${escapeHtml(value.endHour)}:00 ${escapeHtml(value.timezone)}${value.weekdaysOnly ? ' · weekdays' : ''}` : 'Shared schedule unavailable';
  const manager = ['owner', 'admin'].includes(auth?.user?.role);
  return `<p class="cw-help">Assigned sender pool: <strong>${fmtNum(senderCount)} selected${readyCount === null ? ' · readiness unavailable' : ` · ${fmtNum(readyCount)} ready`}</strong>. Mailbox health, warm-up, SMTP and suppression gates still apply at preflight.</p><div class="cw-shared-schedule"><strong>Shared workspace send window</strong><span>${scheduleText}</span><p>This setting applies across campaigns in this workspace. Changing it affects other campaigns too. Only workspace owners and admins can edit it.</p><a class="btn btn-ghost btn-sm" href="#settings" data-cw-settings>${manager ? 'Edit shared schedule in Settings' : 'View access and schedule in Settings'}</a></div><div class="cw-actions"><button type="button" class="btn btn-primary" data-cw-senders="${selection.campaign?.id || activeWorkspaceId}">Choose sender pool</button><a class="btn btn-ghost" href="#mailboxes" data-cw-mailboxes>Manage mailboxes</a></div>`;
}

function readyStep(campaign, counts, sequence, senders) {
  const readyCount = Number.isFinite(Number(senders.readyCount)) ? Number(senders.readyCount) : null;
  return `<p class="cw-help">Run a fresh final launch check to see current blockers and recipient reasons. Relevant campaign changes require a new review.</p><div class="cw-readiness-facts"><span>${counts ? `${fmtNum(counts.eligible)} eligible · ${fmtNum(counts.blocked)} blocked` : 'Recipient readiness unavailable'}</span><span>${Array.isArray(sequence.steps) ? `${sequence.steps.length} saved sequence step(s)` : 'Sequence unavailable'}</span><span>${readyCount === null ? 'Sender readiness unavailable' : `${fmtNum(readyCount)} sender(s) ready`}</span></div><div class="cw-actions"><button type="button" class="btn btn-primary" data-cw-preflight="${campaign.id}">Run final launch check</button><button type="button" class="btn btn-ghost" data-cw-process>Process already queued messages</button></div><p class="cw-warning">Queueing and processing are separate explicit actions. Processing asks the existing worker to handle already queued messages; this page does not start a worker on load.</p>`;
}

function activityStep(campaign) {
  return `<p class="cw-help">Activity is taken from the campaign timeline API. SMTP acceptance and an authenticated reply are separate recorded outcomes.</p><div data-cw-timeline>Loading campaign timeline…</div><div class="cw-actions"><a class="btn btn-ghost" href="#inbox" data-cw-inbox>Open workspace Inbox</a><button type="button" class="btn btn-ghost" data-cw-refresh>Refresh campaign activity</button></div>`;
}

function bindWorkspace(host, campaignId, requestedStep) {
  host.querySelectorAll('[data-cw-contact]').forEach(card => {
    const item = latestAudience?.items?.find(value => Number(value.lead_id) === Number(card.dataset.cwContact));
    card.__cwBaseline = editorBuffers.get(editorKey(campaignId, card.dataset.cwContact))?.baseline || copyVersion(item);
    card.querySelectorAll('[data-cw-subject], [data-cw-body]').forEach(field => field.addEventListener('input', () => {
      captureEditor(card); updateEditorState(card, item);
    }));
    updateEditorState(card, item);
    card.__cwCanSave = !card.querySelector('[data-cw-save-copy]').disabled;
    if (pendingSaves.has(editorKey(campaignId, card.dataset.cwContact))) {
      card.querySelector('[data-cw-save-copy]').disabled = true;
      card.querySelector('[data-cw-copy-status]').textContent = 'Saving a new version…';
    }
  });
  host.querySelector('[data-cw-close]')?.addEventListener('click', closeWorkspace);
  host.querySelectorAll('[data-cw-step]').forEach(button => button.addEventListener('click', () => { setWorkspaceStep(button.dataset.cwStep); void renderWorkspace(host, campaignId); }));
  host.querySelector('[data-cw-next]')?.addEventListener('click', () => {
    const step = host.querySelector('[data-cw-next]').dataset.cwNext;
    if (step === 'recipients') window.__campaignAudience?.(campaignId);
    else if (step === 'sequence') window.__campaignSequence?.(campaignId);
    else if (step === 'senders') window.__campaignSenders?.(campaignId);
    else if (step === 'ready') window.__queueSends?.(campaignId);
    else { setWorkspaceStep(step); void renderWorkspace(host, campaignId); }
  });
  host.querySelector('[data-cw-audience]')?.addEventListener('click', () => window.__campaignAudience?.(campaignId));
  host.querySelector('[data-cw-contacts]')?.addEventListener('click', () => window.__campaignAudience?.(campaignId));
  host.querySelector('[data-cw-open-audience]')?.addEventListener('click', () => window.__campaignAudience?.(campaignId));
  host.querySelector('[data-cw-sequence]')?.addEventListener('click', () => window.__campaignSequence?.(campaignId));
  host.querySelector('[data-cw-senders]')?.addEventListener('click', () => window.__campaignSenders?.(campaignId));
  host.querySelector('[data-cw-preflight]')?.addEventListener('click', () => window.__queueSends?.(campaignId));
  host.querySelector('[data-cw-process]')?.addEventListener('click', () => window.__processSends?.());
  host.querySelectorAll('[data-cw-settings], [data-cw-mailboxes], [data-cw-inbox], [data-cw-leads]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); window.__nav?.(link.getAttribute('href').slice(1)); }));
  host.querySelector('[data-cw-refresh]')?.addEventListener('click', () => void renderWorkspace(host, campaignId));
  host.querySelectorAll('[data-cw-save-copy]').forEach(button => button.addEventListener('click', () => saveManualCopy(host, button, campaignId)));
  host.querySelectorAll('[data-cw-approve]').forEach(button => button.addEventListener('click', () => approveCopy(host, button, campaignId)));
  host.querySelectorAll('[data-cw-verify]').forEach(button => button.addEventListener('click', () => verifySavedEmail(host, button, campaignId)));
  if (requestedStep === 'activity') void loadTimeline(host, campaignId);
}

async function saveManualCopy(host, button, campaignId) {
  const currentContext = reviewContext(host, button, campaignId);
  if (!currentContext()) return;
  const card = button.closest('[data-cw-contact]');
  const leadId = idOf(button.dataset.cwSaveCopy);
  if (!leadId || Number(card?.dataset.cwCampaign) !== campaignId || Number(card?.dataset.cwContact) !== leadId || !card.__cwBaseline) return;
  const key = editorKey(campaignId, leadId);
  if (pendingSaves.has(key)) return;
  captureEditor(card);
  const baseline = editorBuffers.get(key)?.baseline || card.__cwBaseline;
  const submittedSubject = card.querySelector('[data-cw-subject]').value;
  const submittedBody = card.querySelector('[data-cw-body]').value;
  const status = card.querySelector('[data-cw-copy-status]');
  const subjectLine = submittedSubject.trim();
  const bodyText = submittedBody.trim();
  const operation = { dispatched: false };
  pendingSaves.set(key, operation);
  button.disabled = true; status.textContent = 'Saving a new version…';
  try {
    const expectedLatestPersonalizationId = baseline.id;
    let expectedLatestCopyHash = baseline.hash;
    if (expectedLatestPersonalizationId && !expectedLatestCopyHash && baseline.fingerprint) {
      expectedLatestCopyHash = await jsonHash(baseline.fingerprint);
    }
    if (expectedLatestPersonalizationId && !/^[0-9a-f]{64}$/.test(expectedLatestCopyHash || '')) throw new Error('The current saved version fingerprint is unavailable. Reload recipients before saving to avoid overwriting a newer review.');
    if (!currentContext()) return;
    operation.dispatched = true;
    const result = await Campaigns.saveRecipientDraft(campaignId, leadId, { subjectLine, bodyText, expectedLatestPersonalizationId, expectedLatestCopyHash });
    captureEditors(host);
    const confirmed = {
      id: idOf(result.personalizationId), hash: result.latestCopyHash, subject: subjectLine, body: bodyText,
      fingerprint: [idOf(result.personalizationId), subjectLine, bodyText, 0, Number(result.guardrailPassed)],
    };
    const pending = editorBuffers.get(key);
    const hasNewTyping = pending && (pending.subject !== submittedSubject || pending.body !== submittedBody);
    if (hasNewTyping) editorBuffers.set(key, { subject: pending.subject, body: pending.body, baseline: confirmed });
    else editorBuffers.delete(key);
    // The server confirmed only this submission. Later typing and other cards remain dirty.
    const visibleCard = host.querySelector(`[data-cw-campaign="${campaignId}"][data-cw-contact="${leadId}"]`);
    if (visibleCard) {
      visibleCard.__cwBaseline = confirmed;
      if (!hasNewTyping) {
        visibleCard.querySelector('[data-cw-subject]').value = subjectLine;
        visibleCard.querySelector('[data-cw-body]').value = bodyText;
      }
    }
    const reasons = Array.isArray(result.guardrailFailures) ? result.guardrailFailures : [];
    copyFeedback.set(key, { fingerprint: JSON.stringify(confirmed.fingerprint), text: result.guardrailPassed
      ? 'New version saved. Approve it separately after review.'
      : `Saved as a blocked draft. ${reasons.map(guardrailInstruction).join(' ')} Save a correction; then approve it separately.` });
    pendingSaves.delete(key);
    if (host.isConnected && activeWorkspaceId === campaignId && activeStep === 'review') await renderWorkspace(host, campaignId);
  } catch (error) {
    const stale = Number(error.status) === 409 || /409|stale|changed/i.test(error.message || '');
    const message = stale ? 'This copy could not be saved against the reviewed version. Your edits are preserved. Compare the current saved copy before trying again.' : (error.message || 'Could not save copy.');
    captureEditors(host);
    const pending = editorBuffers.get(key) || { subject: submittedSubject, body: submittedBody, baseline };
    editorBuffers.set(key, { ...pending, rejected: message });
    pendingSaves.delete(key);
    if (!currentContext()) return;
    button.disabled = false; status.textContent = message;
    if (stale) {
      await renderWorkspace(host, campaignId);
    }
  } finally {
    if (pendingSaves.get(key) === operation) pendingSaves.delete(key);
    const visibleCard = host.querySelector(`[data-cw-campaign="${campaignId}"][data-cw-contact="${leadId}"]`);
    if (visibleCard?.__cwCanSave && !pendingSaves.has(key)) {
      visibleCard.querySelector('[data-cw-save-copy]').disabled = false;
      updateEditorState(visibleCard, latestAudience?.items?.find(item => Number(item.lead_id) === leadId));
      if (!operation.dispatched) visibleCard.querySelector('[data-cw-copy-status]').textContent = 'The review changed before saving. Your edits are kept; review and save again.';
    }
  }
}

async function approveCopy(host, button, campaignId) {
  const viewRevision = activeViewRevision;
  const currentContext = reviewContext(host, button, campaignId);
  if (!currentContext()) return;
  button.disabled = true;
  try { await Personalize.approve(Number(button.dataset.cwApprove)); if (!currentContext()) return; await renderWorkspace(host, campaignId); if (activeWorkspaceId === campaignId && activeViewRevision === viewRevision) notify('Current copy version approved. Queue eligibility is still checked by preflight.', 'success'); }
  catch (error) { if (currentContext()) { button.disabled = false; notify(error.message || 'Could not approve this copy version.', 'error'); } }
}

async function verifySavedEmail(host, button, campaignId) {
  const currentContext = reviewContext(host, button, campaignId);
  if (!currentContext()) return;
  const card = button.closest('[data-cw-contact]'); const leadId = idOf(button.dataset.cwVerify); const status = card.querySelector('[data-cw-verify-status]');
  button.disabled = true; status.textContent = 'Loading saved email records…';
  try {
    const lead = await Leads.get(leadId);
    const emails = Array.isArray(lead.emails) ? lead.emails : [];
    const displayed = card.querySelector('header span').textContent.trim();
    const normalized = value => String(value || '').trim().toLocaleLowerCase('en-US');
    const saved = emails.find(item => normalized(item.email) === normalized(lead.email)
      && normalized(item.email) === normalized(displayed));
    if (!saved?.id) throw new Error('The enrolled address is not available as the saved primary email. Review the contact record first.');
    if (!currentContext()) return;
    status.textContent = `Rechecking saved email ${saved.email}…`;
    await Verify.reVerify(saved.id);
    status.textContent = 'Reverification requested for this saved email. Refresh recipient status after the check completes.';
    notify('Reverification requested for the saved primary email.', 'success');
  } catch (error) { if (currentContext()) status.textContent = error.message || 'Saved email could not be reverified.'; }
  finally { if (currentContext()) button.disabled = false; }
}

async function loadTimeline(host, campaignId) {
  const node = host.querySelector('[data-cw-timeline]'); if (!node) return;
  try {
    const timeline = await Campaigns.timeline(campaignId, 30);
    if (!node.isConnected || activeWorkspaceId !== campaignId) return;
    const rows = Array.isArray(timeline) ? timeline : Array.isArray(timeline?.timeline) ? timeline.timeline : [];
    node.innerHTML = rows.length ? `<ol class="cw-timeline">${rows.map(day => `<li><span><strong>${escapeHtml(day.date || 'Date unavailable')}</strong> · ${String(day.sent ?? '—')} SMTP accepted · ${String(day.replied ?? '—')} replies · ${String(day.opened ?? '—')} opens · ${String(day.bounced ?? '—')} bounces</span></li>`).join('')}</ol>` : '<p class="cw-empty">No campaign timeline activity is recorded yet.</p>';
  } catch (error) { node.innerHTML = `<p class="cw-error" role="alert">Campaign activity unavailable: ${escapeHtml(error.message || 'retry required.')}</p><button type="button" class="btn btn-ghost btn-sm" data-cw-retry-activity>Try again</button>`; node.querySelector('[data-cw-retry-activity]')?.addEventListener('click', () => void loadTimeline(host, campaignId)); }
}

function closeWorkspace() {
  captureEditors(document.querySelector('[data-campaign-workspace]'));
  activeWorkspaceId = null; latestAudience = null; activeViewRevision++; workspaceGeneration++;
  focusedCampaignId = null;
  const url = new URL(location.href); url.searchParams.delete('campaign'); url.searchParams.delete('step'); history.replaceState(null, '', url);
  const host = document.querySelector('[data-campaign-workspace]');
  setWorkspaceView(host?.parentElement, host, false);
  host?.replaceChildren();
}
