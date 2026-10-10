// ============================================================
//  Campaigns + A/B Testing View — 100% live API
// ============================================================
import { Campaigns, Leads, Lists, Sending, ContactFields, fmtNum, relTime } from './api.js';
import { confirmAction, escapeHtml, icon, notify, openDialog, promptText } from './ui.js';

let _selectedCampaign = null;
let _showArchivedCampaigns = false;

export async function renderCampaigns(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading campaigns…</span></div>`;

  const [campaigns, sendStats] = await Promise.all([
    Campaigns.list(_showArchivedCampaigns ? 'archived' : ''),
    Sending.stats(),
  ]);

  const list = campaigns || [];

  container.innerHTML = `
  <div class="section-header mb-16">
    <div>
      <h1 class="section-title">Messages with a destination.</h1>
      <div class="section-sub">${list.length} ${_showArchivedCampaigns ? 'archived drafts' : 'campaigns'} · shape your outreach and learn which messages connect.</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" type="button" data-campaign-archived-toggle>${_showArchivedCampaigns ? 'Active campaigns' : 'Archived drafts'}</button>
      ${_showArchivedCampaigns ? '' : `<button class="btn btn-ghost btn-sm" type="button" onclick="window.__abAutoPromote()">${icon('chart', 15)} Check A/B tests</button><button class="btn btn-primary btn-sm" type="button" data-campaign-create>${icon('plus', 15)} New campaign</button>`}
    </div>
  </div>

  <!-- Send Engine Stats -->
  <div class="kpi-grid-4 mb-16">
    ${[
      { label: 'Total Sent',   val: fmtNum(sendStats?.sent || 0),      color: '#6366f1' },
      { label: 'Scheduled',   val: fmtNum(sendStats?.scheduled || 0), color: '#f59e0b' },
      { label: "Today's Sends",val: fmtNum(sendStats?.today_sent || 0),color: '#10b981' },
      { label: 'Failed',      val: fmtNum(sendStats?.failed || 0),    color: '#f43f5e' },
    ].map(k => `
    <div class="kpi-card" style="--accent-color:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.val}</div>
    </div>`).join('')}
  </div>

  <!-- Campaign cards -->
  <div id="campaign-list" class="campaign-list">
    ${list.length === 0 ? `
    <div class="glass-panel">
      <div class="panel-body empty-state">
        <div class="empty-orbit">${icon('send', 25)}</div>
        <h3>${_showArchivedCampaigns ? 'No archived drafts.' : 'A conversation waiting to happen.'}</h3>
        <p class="empty-hint">${_showArchivedCampaigns ? 'Archived drafts will appear here and can be restored.' : 'Create your first campaign, then prepare the people and messages behind it.'}</p>
      </div>
    </div>` : list.map(c => renderCampaignCard(c)).join('')}
  </div>

  <!-- A/B Detail Panel (hidden) -->
  <div id="ab-detail" class="glass-panel mt-16" style="display:none">
    <div class="panel-header">
      <span id="ab-detail-title" class="panel-title"></span>
      <button onclick="document.getElementById('ab-detail').style.display='none'" style="background:none;border:none;color:var(--text-muted);cursor:pointer">✕</button>
    </div>
    <div id="ab-detail-body" class="panel-body">Loading…</div>
  </div>`;

  container.insertAdjacentHTML('beforeend', `
  <div id="campaign-audience-panel" class="glass-panel mt-16 campaign-audience-panel" style="display:none" aria-live="polite"></div>`);
  container.insertAdjacentHTML('beforeend', `
  <div id="campaign-sequence-panel" class="glass-panel mt-16 campaign-sequence-panel" style="display:none" aria-live="polite"></div>`);

  // Wire
  container.querySelector('[data-campaign-create]')?.addEventListener('click', async event => {
    const trigger = event.currentTarget;
    const name = await promptText({
      title: 'Create campaign draft',
      message: 'This saves an unsent draft. You can add recipients, messages, and senders before reviewing it.',
      label: 'Campaign name', value: '', submitLabel: 'Create draft', maxLength: 200,
      eyebrow: 'CAMPAIGN MANAGEMENT',
    });
    if (name === null) return;
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    try {
      await Campaigns.create({ name });
      notify('Campaign draft created. No email was sent.', 'success');
      const main = container.closest('#main-content');
      if (main && container.isConnected) main.setAttribute('aria-busy', 'true');
      try {
        await renderCampaigns(container);
      } catch (error) {
        notify(`Draft created, but the campaign list could not refresh: ${error.message || 'workspace unavailable'}`, 'error');
        if (container.isConnected) container.innerHTML = `<section class="studio-error"><h2>Draft saved; list refresh failed.</h2><p>${escapeHtml(String(error.message || error).slice(0, 240))}</p><button class="btn btn-primary" type="button" data-campaign-refresh>Refresh campaigns</button></section>`;
        container.querySelector('[data-campaign-refresh]')?.addEventListener('click', () => { void renderCampaigns(container).catch(failure => notify(failure.message || 'Campaigns could not refresh.', 'error')); });
      } finally {
        if (main?.isConnected && container.isConnected) main.setAttribute('aria-busy', 'false');
      }
    } catch (error) {
      notify(error.message || 'Could not create the campaign draft.', 'error');
    } finally {
      if (trigger.isConnected) {
        trigger.disabled = false;
        trigger.removeAttribute('aria-busy');
      }
    }
  });
  container.querySelectorAll('[data-campaign-view-ab]').forEach(button => button.addEventListener('click', () => window.__viewAB(Number(button.dataset.campaignViewAb), button.dataset.campaignName)));
  container.querySelectorAll('[data-campaign-queue]').forEach(button => button.addEventListener('click', () => window.__queueSends(Number(button.dataset.campaignQueue))));
  container.querySelectorAll('[data-campaign-pause]').forEach(button => button.addEventListener('click', () => window.__pauseCampaign(Number(button.dataset.campaignPause))));
  container.querySelectorAll('[data-campaign-resume]').forEach(button => button.addEventListener('click', () => window.__resumeCampaign(Number(button.dataset.campaignResume))));
  container.querySelectorAll('[data-campaign-stop]').forEach(button => button.addEventListener('click', () => window.__stopCampaign(Number(button.dataset.campaignStop))));
  container.querySelectorAll('[data-campaign-audience]').forEach(button => button.addEventListener('click', () => window.__campaignAudience(Number(button.dataset.campaignAudience))));
  container.querySelectorAll('[data-campaign-sequence]').forEach(button => button.addEventListener('click', () => window.__campaignSequence(Number(button.dataset.campaignSequence))));
  container.querySelector('[data-campaign-archived-toggle]')?.addEventListener('click', async () => {
    _showArchivedCampaigns = !_showArchivedCampaigns;
    await renderCampaigns(container);
  });
  container.querySelectorAll('[data-campaign-edit-draft]').forEach(button => button.addEventListener('click', () => window.__editCampaignDraft(Number(button.dataset.campaignEditDraft))));
  container.querySelectorAll('[data-campaign-archive-draft]').forEach(button => button.addEventListener('click', () => window.__archiveCampaignDraft(Number(button.dataset.campaignArchiveDraft))));
  container.querySelectorAll('[data-campaign-restore-draft]').forEach(button => button.addEventListener('click', () => window.__restoreCampaignDraft(Number(button.dataset.campaignRestoreDraft))));
  container.querySelectorAll('[data-campaign-clone]').forEach(button => button.addEventListener('click', () => window.__cloneCampaign(Number(button.dataset.campaignClone), button.dataset.campaignName)));
  container.querySelectorAll('[data-campaign-launch-view]').forEach(button => button.addEventListener('click', () => {
    const detail = container.querySelector(`[data-campaign-launch-detail="${button.dataset.campaignLaunchView}"]`);
    if (!detail) return;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    detail.hidden = expanded;
  }));
  container.querySelectorAll('[data-campaign-senders]').forEach(button => button.addEventListener('click', () => window.__campaignSenders(Number(button.dataset.campaignSenders))));
  window.__cloneCampaign = async (id, sourceName) => {
    const suggested = `${sourceName || 'Campaign'} copy`.slice(0, 200);
    const name = await promptText({ title: 'Duplicate campaign draft', message: 'Recipients, senders, schedule, and delivery history will not be copied.', label: 'New campaign name', value: suggested, submitLabel: 'Create draft', eyebrow: 'CAMPAIGN MANAGEMENT' });
    if (name === null) return;
    try {
      const result = await Campaigns.clone(id, name);
      notify(`Draft created with ${result.sequenceStepCount} sequence step${result.sequenceStepCount === 1 ? '' : 's'}. Add recipients and choose senders before queueing.`);
      await renderCampaigns(container);
    } catch (error) {
      notify(error.message || 'Could not duplicate the campaign.');
    }
  };
  window.__abAutoPromote = async () => {
    try {
      const result = await Campaigns.autoPromote();
      const recommendations = result?.recommendations || [];
      if (recommendations.length) {
        openDialog({
          title: 'A/B winner recommendations', eyebrow: 'REVIEW REQUIRED',
          body: `<p class="dialog-description">These recommendations met the statistical eligibility rules. No campaign allocation was changed. Review each report before choosing a winner.</p><ul class="recommendation-list">${recommendations.map(item => `<li><strong>${escapeHtml(item.campaignName)}</strong><span>${item.stepPosition ? `Step ${item.stepPosition} · ` : ''}Variant ${escapeHtml(item.winner)}</span></li>`).join('')}</ul>`,
        });
      } else notify('No statistically eligible winner recommendations. Minimum sample or confidence thresholds may not be met.', 'info');
    } catch (error) { notify(error.message || 'Could not calculate A/B recommendations.', 'error'); }
  };
  const loadAB = async (id, name, stepId = null) => {
    const panel = document.getElementById('ab-detail');
    const body  = document.getElementById('ab-detail-body');
    const title = document.getElementById('ab-detail-title');
    panel.style.display = '';
    title.textContent = `A/B Analysis — ${name}`;
    body.innerHTML = '<div class="loading-state" style="padding:20px"><div class="spinner"></div></div>';
    panel.scrollIntoView({ behavior: 'smooth' });

    const [variants, timeline] = await Promise.all([
      Campaigns.variants(id, stepId),
      Campaigns.timeline(id, 14),
    ]);
    body.innerHTML = renderABPanel(variants, timeline);
    body.querySelector('[data-ab-step]')?.addEventListener('change', event => {
      const selectedStepId = Number(event.currentTarget.value);
      loadAB(id, name, selectedStepId);
    });
  };
  window.__viewAB = (id, name) => loadAB(id, name);
  let audienceState = { campaignId: null, search: '', offset: 0, items: [], counts: null, campaign: null, hasMore: false, loadVersion: 0 };
  const audiencePanel = document.getElementById('campaign-audience-panel');
  const refreshCampaignCardSummary = async campaignId => {
    let campaign;
    try {
      const campaigns = await Campaigns.list(_showArchivedCampaigns ? 'archived' : '');
      campaign = (campaigns || []).find(item => Number(item.id) === Number(campaignId));
    } catch { return false; }
    const card = [...container.querySelectorAll('.campaign-card')].find(node =>
      Number(node.querySelector('[data-campaign-audience]')?.dataset.campaignAudience) === Number(campaignId));
    const meta = card?.querySelector('.campaign-meta');
    if (!campaign || !meta) return false;
    const sequence = campaign.sequence_step_count
      ? `${fmtNum(campaign.sequence_step_count)}-step sequence · worker enabled`
      : `Step ${fmtNum(campaign.sequence_step || 1)}`;
    const senders = campaign.sender_count
      ? `${fmtNum(campaign.sender_ready_count || 0)}/${fmtNum(campaign.sender_count)} senders ready`
      : 'sender required';
    const uncertain = campaign.uncertain ? ` · ${fmtNum(campaign.uncertain)} SMTP outcome(s) need review` : '';
    meta.textContent = `${sequence} · ${fmtNum(campaign.audience_total || 0)} recipients · ${fmtNum(campaign.audience_eligible || 0)} ready · ${senders}${uncertain}`;
    return true;
  };
  const drawAudience = () => {
    const state = audienceState;
    const labels = {
      eligible: ['Ready to queue', 'is-ready'], already_queued: ['Already queued', 'is-queued'], already_sent: ['Accepted by SMTP', 'is-sent'],
      sequence_running: ['In sequence', 'is-queued'], sequence_failed: ['Sequence stopped after send failure', 'is-blocked'],
      out_of_office_deferred: ['Out of office · deferred', 'is-queued'], out_of_office_review: ['Out of office · review needed', 'is-blocked'],
      submission_uncertain: ['SMTP outcome unknown · quarantined', 'is-blocked'],
      suppressed: ['Suppressed', 'is-blocked'], verification_required: ['Verify before send', 'is-blocked'], missing_email: ['Missing email', 'is-blocked'],
      contact_not_ready: ['Contact not ready', 'is-blocked'], personalization_required: ['Personalization needed', 'is-blocked'],
      copy_review_required: ['Copy review needed', 'is-blocked'], approval_required: ['Awaiting approval', 'is-blocked'], copy_incomplete: ['Subject or body missing', 'is-blocked'],
      stopped: ['Stopped', 'is-blocked'], completed: ['Completed', 'is-sent'], not_active: ['Not active', 'is-blocked'],
    };
    const counts = state.counts || {};
    const reasons = counts.byReason || {};
    audiencePanel.innerHTML = `
      <header class="campaign-audience-head"><div><span class="eyebrow">CAMPAIGN RECIPIENTS</span><h2>${escapeHtml(state.campaign?.name || 'Campaign audience')}</h2><p>Recipients are snapshotted from a saved list. Each row shows the current send gate; no email is sent by enrollment.</p></div><button type="button" class="icon-btn" data-audience-close aria-label="Close campaign recipients">${icon('close', 16)}</button></header>
      <div class="campaign-audience-metrics">
        ${[
          ['Enrolled', counts.total || 0, ''], ['Ready to queue', counts.eligible || 0, 'is-ready'], ['Already queued', counts.alreadyQueued || 0, 'is-queued'], ['In sequence', counts.sequenceRunning || 0, 'is-queued'], ['OOO holds', counts.deferred || 0, 'is-queued'], ['Blocked / complete', counts.blocked || 0, 'is-blocked'],
        ].map(([label, value, tone]) => `<div class="campaign-audience-metric ${tone}"><span>${label}</span><strong>${fmtNum(value)}</strong></div>`).join('')}
      </div>
      <div class="campaign-audience-toolbar"><div><h3>Recipient eligibility</h3><span>${escapeHtml(state.campaign?.status || 'draft')} campaign · ${fmtNum(counts.acceptedSends || 0)} SMTP-accepted messages</span></div><div class="campaign-audience-tools"><label><span class="sr-only">Search recipients</span><input type="search" class="filter-input" data-audience-search placeholder="Search recipients…" value="${escapeHtml(state.search)}"></label>${state.campaign?.status === 'draft' ? `<button class="btn btn-ghost btn-sm" type="button" data-audience-select>${icon('people', 14)} Add contacts</button><button class="btn btn-primary btn-sm" type="button" data-audience-add>${icon('plus', 14)} Add saved list</button>` : '<span class="status-badge">Audience locked</span>'}</div></div>
      ${state.items.length ? `<div class="table-wrap campaign-audience-table"><table><thead><tr><th>Contact</th><th>Email</th><th>Added from</th><th>Eligibility</th><th>Next sequence step</th><th>Enrolled</th>${state.campaign?.status === 'draft' ? '<th>Action</th>' : ''}</tr></thead><tbody>
        ${state.items.map(item => { const [label, tone] = labels[item.eligibility] || [item.eligibility || 'Unknown', 'is-blocked']; const review = item.uncertainty; const nextStep = item.next_sequence_position ? item.eligibility === 'out_of_office_deferred' ? `Step ${fmtNum(item.next_sequence_position)} · held until ${item.defer_until?.slice(0, 10) || 'return + 1 day'}` : item.eligibility === 'out_of_office_review' ? `Step ${fmtNum(item.next_sequence_position)} · awaiting review` : `Step ${fmtNum(item.next_sequence_position)} · ${relTime(item.next_sequence_at)}` : item.eligibility === 'sequence_running' ? 'Processing' : '—'; const oooAction = item.eligibility === 'out_of_office_review' ? `<button type="button" class="btn btn-ghost btn-sm" data-ooo-reactivate="${state.campaignId}" data-lead-id="${item.lead_id}">Resume after review</button>` : ''; const removeAction = state.campaign?.status === 'draft' ? `<td><button type="button" class="btn btn-ghost btn-sm" data-audience-remove="${state.campaignId}" data-lead-id="${item.lead_id}">Remove</button></td>` : ''; return `<tr><td><span class="td-name">${escapeHtml(item.business_name || 'Unnamed contact')}</span></td><td>${escapeHtml(item.email || '—')}</td><td>${escapeHtml(item.source_list_name || 'Saved list')}</td><td><span class="campaign-eligibility ${tone}">${escapeHtml(label)}</span>${oooAction}${review ? `<details class="uncertain-submission-review"><summary>Review quarantine</summary><div class="uncertain-submission-review-body"><strong>SMTP result is unresolved</strong><p>${escapeHtml(review.blockedReason)}</p><dl><dt>Recorded reason</dt><dd>${escapeHtml(review.reason)}</dd><dt>Worker code</dt><dd>${escapeHtml(review.code)}</dd>${review.stage ? `<dt>SMTP stage</dt><dd>${escapeHtml(review.stage)}</dd>` : ''}<dt>Submission record</dt><dd>${review.sendId ? `#${fmtNum(review.sendId)}` : 'Unavailable'}</dd><dt>Evidence source</dt><dd>Application SMTP worker · ${escapeHtml(review.evidenceSource)}</dd><dt>Last recorded</dt><dd>${escapeHtml(review.recordedAt || 'No uncertainty event recorded')}</dd></dl><span class="uncertain-submission-review-note">No provider message-trace evidence is available. Automatic resend is disabled.</span></div></details>` : ''}</td><td class="text-muted">${escapeHtml(nextStep)}</td><td class="text-muted">${escapeHtml(relTime(item.enrolled_at))}</td>${removeAction}</tr>`; }).join('')}
      </tbody></table></div>${state.hasMore ? `<div class="contact-list-load-more"><button type="button" class="btn btn-ghost btn-sm" data-audience-more>Load more recipients</button></div>` : ''}` : `<div class="contact-list-empty contact-list-empty-main"><span>${icon('people', 25)}</span><h3>${state.search ? 'No matching recipients' : 'No recipients enrolled'}</h3><p>${state.search ? 'Try a different search.' : 'Add an active contact list to take an explicit recipient snapshot.'}</p></div>`}`;
    audiencePanel.querySelector('[data-audience-close]')?.addEventListener('click', () => { audiencePanel.style.display = 'none'; });
    audiencePanel.querySelector('[data-audience-search]')?.addEventListener('input', event => {
      clearTimeout(audienceSearchTimer);
      const search = event.currentTarget.value.trim();
      audienceSearchTimer = setTimeout(() => { audienceState.search = search; loadAudience(); }, 180);
    });
    audiencePanel.querySelector('[data-audience-more]')?.addEventListener('click', () => loadAudience({ append: true }));
    audiencePanel.querySelector('[data-audience-add]')?.addEventListener('click', openAudienceListDialog);
    audiencePanel.querySelector('[data-audience-select]')?.addEventListener('click', openAudienceContactDialog);
    audiencePanel.querySelectorAll('[data-ooo-reactivate]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await Campaigns.reactivateOOO(Number(button.dataset.oooReactivate), Number(button.dataset.leadId));
        notify('Follow-up released from review and made due. It will still pass through the normal worker and send checks.');
        await loadAudience();
      } catch (error) { button.disabled = false; notify(error.message, 'error'); }
    }));
    audiencePanel.querySelectorAll('[data-audience-remove]').forEach(button => button.addEventListener('click', async () => {
      const leadId = Number(button.dataset.leadId);
      if (!await confirmAction({ title: 'Remove campaign recipient', message: 'Remove this contact from the campaign recipient snapshot? The contact and saved-list membership will remain unchanged.', confirmLabel: 'Remove recipient', danger: true })) return;
      button.disabled = true;
      try {
        await Campaigns.removeRecipient(Number(button.dataset.audienceRemove), leadId);
        notify('Contact removed from this campaign draft.');
        await loadAudience();
        await refreshCampaignCardSummary(audienceState.campaignId);
      } catch (error) { button.disabled = false; notify(error.message, 'error'); }
    }));
  };
  let audienceSearchTimer;
  const loadAudience = async ({ append = false } = {}) => {
    if (!audienceState.campaignId) return;
    const version = ++audienceState.loadVersion;
    const offset = append ? audienceState.items.length : 0;
    try {
      const result = await Campaigns.audience(audienceState.campaignId, { search: audienceState.search, limit: 50, offset });
      if (version !== audienceState.loadVersion) return;
      audienceState.campaign = result.campaign;
      audienceState.counts = result.counts;
      audienceState.items = append ? [...audienceState.items, ...(result.items || [])] : (result.items || []);
      audienceState.offset = result.pagination?.offset + result.pagination?.limit || audienceState.items.length;
      audienceState.hasMore = result.pagination?.hasMore === true;
      drawAudience();
    } catch (error) {
      if (version !== audienceState.loadVersion) return;
      audiencePanel.innerHTML = `<div class="contact-list-empty contact-list-empty-main"><span>${icon('activity', 25)}</span><h3>Recipients could not load</h3><p>${escapeHtml(error.message)}</p><button type="button" class="btn btn-ghost btn-sm" data-audience-retry>Try again</button></div>`;
      audiencePanel.querySelector('[data-audience-retry]')?.addEventListener('click', () => loadAudience());
    }
  };
  const openAudienceListDialog = async () => {
    try {
      const result = await Lists.list({ include_archived: false, limit: 100 });
      const available = (result.items || []).filter(item => item.status === 'active');
      if (!available.length) {
        notify('Create an active contact list before adding campaign recipients.', 'error');
        window.__nav('lists');
        return;
      }
      openDialog({
        title: 'Add a saved list', eyebrow: 'SNAPSHOT CAMPAIGN AUDIENCE', submitLabel: 'Enroll contacts',
        body: `<p class="contact-picker-intro">Contacts are copied into this draft campaign once. Later list edits do not silently change its audience. Enrollment never sends email.</p><label class="form-label" for="campaign-list-select">Contact list</label><select id="campaign-list-select" class="form-select" name="listId" required>${available.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${fmtNum(item.contact_count)} contacts</option>`).join('')}</select>`,
        onSubmit: async form => {
          const added = await Campaigns.addList(audienceState.campaignId, Number(form.get('listId')));
          await loadAudience();
          const summaryUpdated = await refreshCampaignCardSummary(audienceState.campaignId);
          notify(`${added.added} enrolled · ${added.alreadyEnrolled} already enrolled.${summaryUpdated ? '' : ' Campaign summary will update when you reload this view.'}`);
        },
      });
    } catch (error) { notify(error.message, 'error'); }
  };
  const openAudienceContactDialog = () => {
    const campaignId = audienceState.campaignId;
    const selectedIds = new Set();
    const dialog = openDialog({
      title: 'Choose contacts', eyebrow: 'ADD TO CAMPAIGN DRAFT', submitLabel: 'Add selected contacts',
      body: `<p class="contact-picker-intro">Select up to 500 contacts for this campaign snapshot. This does not verify addresses or send email; each contact’s current send eligibility will appear after enrollment.</p><label class="form-label" for="campaign-contact-search">Find contacts</label><input id="campaign-contact-search" data-contact-search class="form-input" type="search" placeholder="Search name, email, or city"><p class="campaign-contact-picker-count" data-contact-count>Loading contacts…</p><div class="campaign-contact-picker-results" data-contact-results aria-live="polite"></div><button type="button" class="btn btn-ghost btn-sm" data-contact-more hidden>Load more contacts</button>`,
      onSubmit: async () => {
        const leadIds = [...selectedIds];
        if (!leadIds.length) throw new Error('Select at least one contact.');
        const result = await Campaigns.addContacts(campaignId, leadIds);
        await loadAudience();
        const summaryUpdated = await refreshCampaignCardSummary(campaignId);
        notify(`${result.added} enrolled · ${result.alreadyEnrolled} already in this campaign.${summaryUpdated ? '' : ' Campaign summary will update when you reload this view.'}`);
      },
    });
    const search = dialog.querySelector('[data-contact-search]');
    const results = dialog.querySelector('[data-contact-results]');
    const count = dialog.querySelector('[data-contact-count]');
    const more = dialog.querySelector('[data-contact-more]');
    const submit = dialog.querySelector('[type="submit"]');
    let currentItems = [];
    let currentTotal = 0;
    let requestVersion = 0;
    let searchTimer;
    const updateSelection = () => {
      count.textContent = `${selectedIds.size} selected · ${currentTotal} matching contacts`;
      submit.disabled = selectedIds.size === 0;
      submit.textContent = selectedIds.size ? `Add ${selectedIds.size} selected` : 'Select contacts';
    };
    results.addEventListener('change', event => {
      const checkbox = event.target.closest('input[data-contact-id]');
      if (!checkbox) return;
      const id = Number(checkbox.dataset.contactId);
      if (checkbox.checked) {
        if (selectedIds.size >= 500 && !selectedIds.has(id)) {
          checkbox.checked = false;
          notify('Select at most 500 contacts at a time.', 'error');
          return;
        }
        selectedIds.add(id);
      } else selectedIds.delete(id);
      updateSelection();
    });
    const loadContacts = async ({ append = false } = {}) => {
      const version = ++requestVersion;
      const offset = append ? currentItems.length : 0;
      if (!append) results.innerHTML = '<p class="contact-list-empty">Loading contacts…</p>';
      more.disabled = true;
      try {
        const response = await Leads.list({ search: search.value.trim(), limit: 50, offset });
        if (version !== requestVersion || !dialog.isConnected) return;
        const leads = response.leads || [];
        currentTotal = response.pagination?.total || 0;
        currentItems = append ? [...currentItems, ...leads] : leads;
        const options = leads.map(lead => `<label class="campaign-contact-option"><input type="checkbox" data-contact-id="${lead.id}" ${selectedIds.has(Number(lead.id)) ? 'checked' : ''}><span><strong>${escapeHtml(lead.business_name || 'Unnamed contact')}</strong><small>${escapeHtml(lead.email || 'No email')} · ${escapeHtml(lead.city || 'No city')}</small></span></label>`).join('');
        if (append) results.insertAdjacentHTML('beforeend', options);
        else results.innerHTML = options || '<p class="contact-list-empty">No contacts match this search.</p>';
        more.hidden = currentItems.length >= currentTotal;
        more.disabled = false;
        updateSelection();
      } catch (error) {
        if (version !== requestVersion || !dialog.isConnected) return;
        if (!append) results.innerHTML = `<p class="contact-list-empty">${escapeHtml(error.message || 'Contacts could not be loaded.')}</p>`;
        more.disabled = false;
      }
    };
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadContacts(), 180);
    });
    more.addEventListener('click', () => loadContacts({ append: true }));
    updateSelection();
    loadContacts();
  };
  window.__campaignAudience = async id => {
    audienceState = { campaignId: Number(id), search: '', offset: 0, items: [], counts: null, campaign: null, hasMore: false, loadVersion: audienceState.loadVersion + 1 };
    audiencePanel.style.display = '';
    audiencePanel.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading recipient eligibility…</span></div>`;
    audiencePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadAudience();
  };
  const sequencePanel = document.getElementById('campaign-sequence-panel');
  let sequenceState = { campaignId: null, sequence: null, recipients: [], templates: [], customFields: [], preview: null };
  const drawSequence = () => {
    const sequence = sequenceState.sequence;
    if (!sequence) return;
    const editable = !sequence.locked;
    const steps = sequence.steps || [];
    const stepOptions = steps.map(step => `<option value="${step.id}">Step ${step.position}</option>`).join('');
    const contactOptions = sequenceState.recipients.map(contact => `<option value="${contact.lead_id ?? contact.id}">${escapeHtml(contact.business_name || 'Unnamed contact')} · ${escapeHtml(contact.email || 'no email')}</option>`).join('');
    const customMergeFields = sequenceState.customFields.map(field => `<code>{{custom.${escapeHtml(field.fieldKey)}}}</code>`).join(', ');
    sequencePanel.innerHTML = `
      <header class="campaign-sequence-head"><div><span class="eyebrow">SEQUENCE DRAFT</span><h2>${escapeHtml(sequence.campaign.name)}</h2><p>Changes are saved to this campaign draft and survive reloads.</p></div><button type="button" class="icon-btn" data-sequence-close aria-label="Close sequence editor">${icon('close', 16)}</button></header>
      <div class="campaign-sequence-notice"><strong>${sequence.executionAvailable ? 'Sequence execution enabled' : 'Draft editor only'}</strong><span>${escapeHtml(sequence.executionNote)}</span></div>
      <div class="campaign-sequence-toolbar"><div><strong>${fmtNum(steps.length)} / 10 steps</strong><span>${editable ? 'Only draft campaigns with no send history can be edited.' : 'This campaign is locked because it is no longer an unsent draft.'}</span></div>${editable ? `<button type="button" class="btn btn-primary btn-sm" data-sequence-add>${icon('plus', 14)} Add step</button>` : ''}</div>
      ${steps.length ? `<div class="campaign-sequence-steps">${steps.map((step, index) => `
        <section class="campaign-sequence-step" data-sequence-step="${step.id}">
          <div class="campaign-sequence-step-head"><div><span class="campaign-sequence-step-number">${fmtNum(step.position)}</span><div><h3>Step ${fmtNum(step.position)}</h3><p>${step.position === 1 ? 'Initial message' : `Wait ${fmtNum(step.delayDays)} day(s) after the prior step`}</p></div></div><div class="campaign-sequence-step-actions">${editable ? `<button type="button" class="btn btn-ghost btn-sm" data-sequence-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move step up">↑</button><button type="button" class="btn btn-ghost btn-sm" data-sequence-down="${index}" ${index === steps.length - 1 ? 'disabled' : ''} aria-label="Move step down">↓</button><button type="button" class="btn btn-ghost btn-sm" data-sequence-delete="${step.id}">Delete</button>` : ''}</div></div>
          <div class="campaign-sequence-delay"><label>Delay after previous step <span>(days)</span><input class="form-input" type="number" data-sequence-delay min="${step.position === 1 ? 0 : 1}" max="365" value="${step.delayDays}" ${!editable || step.position === 1 ? 'disabled' : ''}></label><small>${step.position === 1 ? 'The first step starts at day 0.' : 'Follow-ups wait at least one full day.'}</small></div>
          <div class="campaign-sequence-variants">${step.variants.map(variant => `
            <div class="campaign-sequence-variant" data-sequence-variant="${escapeHtml(variant.variantKey)}">
              <div class="campaign-sequence-variant-head"><strong>Variant ${escapeHtml(variant.variantKey)}</strong><label>Allocation <input class="form-input" type="number" data-sequence-allocation min="0" max="100" value="${variant.allocationPct}" ${editable ? '' : 'disabled'}><span>%</span></label></div>
              ${editable ? `<div class="campaign-template-apply"><label><span class="sr-only">Saved copy template</span><select class="form-select" data-template-select><option value="">Choose saved template…</option>${sequenceState.templates.filter(template => template.status === 'active').map(template => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join('')}</select></label><button type="button" class="btn btn-ghost btn-sm" data-template-apply>Apply</button><button type="button" class="btn btn-ghost btn-sm" data-template-save>Save as template</button></div>` : ''}
              <label class="form-label">Subject <input class="form-input" type="text" data-sequence-subject maxlength="998" value="${escapeHtml(variant.subjectLine)}" placeholder="A useful subject line" ${editable ? '' : 'disabled'}></label>
              <label class="form-label">Message body <textarea class="form-input" data-sequence-body rows="5" maxlength="50000" placeholder="Write the message for this step…" ${editable ? '' : 'disabled'}>${escapeHtml(variant.bodyText)}</textarea></label>
            </div>`).join('')}</div>
          ${editable ? `<div class="campaign-sequence-save-row"><span>Variant allocations must total 100%.</span><button type="button" class="btn btn-primary btn-sm" data-sequence-save="${step.id}">Save step</button></div>` : ''}
        </section>`).join('')}</div>` : `<div class="contact-list-empty contact-list-empty-main"><span>${icon('send', 25)}</span><h3>No sequence steps yet</h3><p>Add the first message, then create follow-ups with their own wait time and A/B copy.</p></div>`}
      <section class="campaign-template-library"><header><div><span class="eyebrow">COPY LIBRARY</span><h3>Reusable email templates</h3><p>Templates store editable copy. Applying one copies its subject and body into the selected variant.</p></div><button type="button" class="btn btn-ghost btn-sm" data-template-create>${icon('plus', 14)} New template</button></header><div data-template-library-list></div></section>
      <section class="campaign-sequence-preview"><div><span class="eyebrow">MERGE PREVIEW</span><h3>Preview for an enrolled contact</h3><p>Supported fields include {{business_name}}, {{email}}, {{category}}, {{city}}, {{state}}, {{country}}, {{phone}}, and {{website}}. Add a fallback with {{first_name|there}}. Custom fields use ${customMergeFields || '<code>{{custom.field_key}}</code>'}; values are read from the enrolled contact and checked again before sending.</p></div>
        ${steps.length && contactOptions ? `<div class="campaign-sequence-preview-controls"><label>Contact<select class="form-select" data-sequence-preview-contact>${contactOptions}</select></label><label>Step<select class="form-select" data-sequence-preview-step>${stepOptions}</select></label><label>Variant<select class="form-select" data-sequence-preview-variant><option value="A">A</option><option value="B">B</option></select></label><button type="button" class="btn btn-ghost btn-sm" data-sequence-preview>Preview</button></div><div data-sequence-preview-result>${sequenceState.preview ? renderSequencePreview(sequenceState.preview) : ''}</div>` : `<p class="campaign-sequence-preview-empty">${steps.length ? 'Enroll at least one contact to preview personalized copy.' : 'Add a step and enroll a contact to preview personalized copy.'}</p>`}
      </section>`;

    const renderTemplateLibrary = () => {
      const library = sequencePanel.querySelector('[data-template-library-list]');
      if (!library) return;
      library.innerHTML = sequenceState.templates.length ? sequenceState.templates.map(template => `
        <article class="campaign-template-row" data-template-id="${template.id}">
          <div><strong>${escapeHtml(template.name)}</strong><span>${escapeHtml(template.status === 'active' ? template.subjectLine : `Archived · ${template.subjectLine}`)}</span></div>
          <div class="campaign-template-actions">${template.status === 'active' ? `<button type="button" class="btn btn-ghost btn-sm" data-template-edit="${template.id}">Edit</button><button type="button" class="btn btn-ghost btn-sm" data-template-archive="${template.id}">Archive</button>` : `<button type="button" class="btn btn-ghost btn-sm" data-template-restore="${template.id}">Restore</button>`}</div>
        </article>`).join('') : '<p class="campaign-sequence-preview-empty">No reusable copy templates yet.</p>';
      library.querySelectorAll('[data-template-edit]').forEach(button => button.addEventListener('click', () => openTemplateEditor(sequenceState.templates.find(template => template.id === Number(button.dataset.templateEdit)))));
      library.querySelectorAll('[data-template-archive], [data-template-restore]').forEach(button => button.addEventListener('click', async () => {
        const id = Number(button.dataset.templateArchive ?? button.dataset.templateRestore);
        const restoring = button.hasAttribute('data-template-restore');
        if (!restoring && !await confirmAction({ title: 'Archive copy template', message: 'Campaign steps already using it will keep their saved copy.', confirmLabel: 'Archive template', danger: true })) return;
        try {
          if (restoring) await Campaigns.restoreTemplate(id);
          else await Campaigns.archiveTemplate(id);
          await refreshTemplateData();
          notify(restoring ? 'Template restored.' : 'Template archived.');
        } catch (error) { notify(error.message, 'error'); }
      }));
    };
    const refreshTemplateData = async () => {
      sequenceState.templates = await Campaigns.templates(true);
      renderTemplateLibrary();
      sequencePanel.querySelectorAll('[data-template-select]').forEach(select => {
        const current = select.value;
        select.innerHTML = `<option value="">Choose saved template…</option>${sequenceState.templates.filter(template => template.status === 'active').map(template => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join('')}`;
        if ([...select.options].some(option => option.value === current)) select.value = current;
      });
    };
    const openTemplateEditor = (template = null, initialCopy = {}) => {
      openDialog({
        title: template ? 'Edit copy template' : 'Create copy template', eyebrow: 'REUSABLE EMAIL COPY', submitLabel: template ? 'Save template' : 'Create template',
        body: `<p class="contact-picker-intro">Merge fields such as {{business_name}} and {{email}} resolve against the enrolled contact. Custom contact values use {{custom.field_key}}.</p><label class="form-label">Template name<input class="form-input" name="name" maxlength="120" value="${escapeHtml(template?.name || '')}" required></label><label class="form-label">Subject<input class="form-input" name="subjectLine" maxlength="998" value="${escapeHtml(initialCopy.subjectLine ?? template?.subjectLine ?? '')}" required></label><label class="form-label">Message body<textarea class="form-input" name="bodyText" rows="8" maxlength="50000" required>${escapeHtml(initialCopy.bodyText ?? template?.bodyText ?? '')}</textarea></label>`,
        onSubmit: async form => {
          const body = { name: form.get('name'), subjectLine: form.get('subjectLine'), bodyText: form.get('bodyText') };
          if (template) await Campaigns.updateTemplate(template.id, body);
          else await Campaigns.createTemplate(body);
          await refreshTemplateData();
          notify(template ? 'Template updated.' : 'Template created.');
        },
      });
    };
    sequencePanel.querySelector('[data-template-create]')?.addEventListener('click', () => openTemplateEditor());
    sequencePanel.querySelectorAll('[data-template-apply]').forEach(button => button.addEventListener('click', () => {
      const variant = button.closest('[data-sequence-variant]');
      const template = sequenceState.templates.find(item => item.id === Number(variant.querySelector('[data-template-select]').value) && item.status === 'active');
      if (!template) { notify('Choose an active template to apply.', 'error'); return; }
      variant.querySelector('[data-sequence-subject]').value = template.subjectLine;
      variant.querySelector('[data-sequence-body]').value = template.bodyText;
      notify('Template copy applied. Save the sequence step to persist it.');
    }));
    sequencePanel.querySelectorAll('[data-template-save]').forEach(button => button.addEventListener('click', () => {
      const variant = button.closest('[data-sequence-variant]');
      openTemplateEditor(null, {
        subjectLine: variant.querySelector('[data-sequence-subject]').value,
        bodyText: variant.querySelector('[data-sequence-body]').value,
      });
    }));
    renderTemplateLibrary();
    const saveStepCard = async (card, stepId) => {
      const variants = [...card.querySelectorAll('[data-sequence-variant]')].map(row => ({
        variantKey: row.dataset.sequenceVariant,
        allocationPct: Number(row.querySelector('[data-sequence-allocation]').value),
        subjectLine: row.querySelector('[data-sequence-subject]').value,
        bodyText: row.querySelector('[data-sequence-body]').value,
      }));
      return Campaigns.updateSequenceStep(sequenceState.campaignId, stepId, {
        delayDays: Number(card.querySelector('[data-sequence-delay]').value), variants,
      });
    };
    const saveVisibleSteps = async () => {
      for (const step of steps) {
        const card = sequencePanel.querySelector(`[data-sequence-step="${step.id}"]`);
        if (card) await saveStepCard(card, step.id);
      }
    };
    sequencePanel.querySelector('[data-sequence-close]')?.addEventListener('click', () => { sequencePanel.style.display = 'none'; });
    sequencePanel.querySelector('[data-sequence-add]')?.addEventListener('click', async () => {
      try { await saveVisibleSteps(); await Campaigns.addSequenceStep(sequenceState.campaignId); await loadSequence(sequenceState.campaignId); notify('Sequence step added.'); }
      catch (error) { notify(error.message, 'error'); }
    });
    sequencePanel.querySelectorAll('[data-sequence-save]').forEach(button => button.addEventListener('click', async () => {
      const stepId = Number(button.dataset.sequenceSave);
      const card = button.closest('[data-sequence-step]');
      try {
        await saveStepCard(card, stepId);
        await loadSequence(sequenceState.campaignId);
        notify('Sequence step saved.');
      } catch (error) { notify(error.message, 'error'); }
    }));
    sequencePanel.querySelectorAll('[data-sequence-up], [data-sequence-down]').forEach(button => button.addEventListener('click', async () => {
      const index = Number(button.dataset.sequenceUp ?? button.dataset.sequenceDown);
      const order = steps.map(step => step.id);
      const target = index + (button.hasAttribute('data-sequence-up') ? -1 : 1);
      [order[index], order[target]] = [order[target], order[index]];
      try { await saveVisibleSteps(); await Campaigns.reorderSequenceSteps(sequenceState.campaignId, order); await loadSequence(sequenceState.campaignId); }
      catch (error) { notify(error.message, 'error'); }
    }));
    sequencePanel.querySelectorAll('[data-sequence-delete]').forEach(button => button.addEventListener('click', async () => {
      if (!await confirmAction({ title: 'Delete sequence step', message: 'Delete this draft step and its variants? This only affects the editable draft.', confirmLabel: 'Delete step', danger: true })) return;
      try { await saveVisibleSteps(); await Campaigns.deleteSequenceStep(sequenceState.campaignId, Number(button.dataset.sequenceDelete)); await loadSequence(sequenceState.campaignId); notify('Sequence step deleted.'); }
      catch (error) { notify(error.message, 'error'); }
    }));
    sequencePanel.querySelector('[data-sequence-preview-step]')?.addEventListener('change', event => {
      const selected = steps.find(step => step.id === Number(event.currentTarget.value));
      const variants = selected?.variants || [];
      const select = sequencePanel.querySelector('[data-sequence-preview-variant]');
      select.innerHTML = variants.map(variant => `<option value="${escapeHtml(variant.variantKey)}">${escapeHtml(variant.variantKey)}</option>`).join('');
    });
    sequencePanel.querySelector('[data-sequence-preview]')?.addEventListener('click', async () => {
      const stepId = Number(sequencePanel.querySelector('[data-sequence-preview-step]').value);
      const leadId = Number(sequencePanel.querySelector('[data-sequence-preview-contact]').value);
      const variantKey = sequencePanel.querySelector('[data-sequence-preview-variant]').value;
      const result = sequencePanel.querySelector('[data-sequence-preview-result]');
      result.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Rendering preview…</span></div>';
      try {
        const card = sequencePanel.querySelector(`[data-sequence-step="${stepId}"]`);
        if (card) await saveStepCard(card, stepId);
        sequenceState.preview = await Campaigns.previewSequenceStep(sequenceState.campaignId, stepId, { leadId, variantKey });
        result.innerHTML = renderSequencePreview(sequenceState.preview);
      } catch (error) {
        sequenceState.preview = null;
        result.innerHTML = `<div class="campaign-sequence-preview-error">${escapeHtml(error.message)}</div>`;
      }
    });
  };
  const loadSequence = async id => {
    sequenceState = { ...sequenceState, campaignId: Number(id), sequence: null, recipients: [], templates: [], customFields: [], preview: null };
    sequencePanel.style.display = '';
    sequencePanel.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading saved sequence…</span></div>`;
    try {
      const [sequence, audience] = await Promise.all([
        Campaigns.sequence(id), Campaigns.audience(id, { limit: 100 }),
      ]);
      sequenceState.sequence = sequence;
      sequenceState.recipients = audience.items || [];
      try { sequenceState.templates = await Campaigns.templates(true); }
      catch (error) { sequenceState.templates = []; notify(`Copy template library is unavailable: ${error.message}`, 'error'); }
      try { sequenceState.customFields = (await ContactFields.list()).fields || []; }
      catch (error) { sequenceState.customFields = []; notify(`Custom-field merge list is unavailable: ${error.message}`, 'error'); }
      drawSequence();
    } catch (error) {
      sequencePanel.innerHTML = `<div class="contact-list-empty contact-list-empty-main"><span>${icon('activity', 25)}</span><h3>Sequence could not load</h3><p>${escapeHtml(error.message)}</p><button type="button" class="btn btn-ghost btn-sm" data-sequence-retry>Try again</button><button type="button" class="icon-btn" data-sequence-close aria-label="Close sequence editor">${icon('close', 16)}</button></div>`;
      sequencePanel.querySelector('[data-sequence-retry]')?.addEventListener('click', () => loadSequence(id));
      sequencePanel.querySelector('[data-sequence-close]')?.addEventListener('click', () => { sequencePanel.style.display = 'none'; });
    }
  };
  window.__campaignSequence = async id => {
    await loadSequence(id);
    sequencePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  window.__queueSends = async (id) => {
    try {
      const review = await Campaigns.preflight(id);
      const reasonRows = Object.entries(review.counts.byReason || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => `<li><code>${escapeHtml(reason)}</code><span>${fmtNum(count)}</span></li>`).join('');
      const recipientRows = review.recipients.map(recipient => `<tr>
        <td>${escapeHtml(recipient.businessName || 'Unnamed contact')}</td>
        <td>${escapeHtml(recipient.email || 'No email')}</td>
        <td><span class="preflight-state is-${escapeHtml(recipient.status)}">${escapeHtml(recipient.status)}</span></td>
        <td><code>${escapeHtml(recipient.reason)}</code></td>
      </tr>`).join('');
      const senderRows = review.senders.length
        ? review.senders.map(sender => `<li><span>${escapeHtml(sender.email)}</span><code>${escapeHtml(sender.reason)}</code></li>`).join('')
        : '<li>No sender is assigned to this campaign.</li>';
      const blockers = review.blockers.map(blocker => `<li><strong>${escapeHtml(blocker.code)}</strong><span>${escapeHtml(blocker.message)}</span></li>`).join('');
      const sendWindowText = review.schedule.open
        ? `Open · ${review.schedule.startHour}:00–${review.schedule.endHour}:00 ${escapeHtml(review.schedule.timezone)}${review.schedule.weekdaysOnly ? ' · weekdays' : ''}`
        : `Next send time · ${new Date(review.schedule.nextAllowedAt).toLocaleString(undefined, { timeZone: review.schedule.timezone })} (${escapeHtml(review.schedule.timezone)})`;
      const body = `
        <div class="campaign-preflight-summary">
          <p>${review.ready ? 'Review these recipients and queue settings. A change to campaign, sender, or recipient readiness will invalidate this review.' : 'Queueing is blocked until the items below are resolved.'}</p>
          <div class="campaign-preflight-counts">
            <span><strong>${fmtNum(review.counts.eligible)}</strong> eligible</span>
            <span><strong>${fmtNum(review.counts.blocked)}</strong> blocked</span>
            <span><strong>${fmtNum(review.counts.deferred)}</strong> deferred</span>
            <span><strong>${fmtNum(review.counts.total)}</strong> enrolled</span>
          </div>
          <section class="campaign-preflight-section"><h3>Configured send window</h3><p>${sendWindowText}</p></section>
          ${blockers ? `<section class="campaign-preflight-section is-blocked"><h3>Campaign blockers</h3><ul>${blockers}</ul></section>` : ''}
          <section class="campaign-preflight-section"><h3>Assigned sender readiness</h3><ul>${senderRows}</ul></section>
          <section class="campaign-preflight-section"><h3>Recipient reasons</h3><ul>${reasonRows || '<li>No enrolled recipients.</li>'}</ul></section>
          <details class="campaign-preflight-recipients"><summary>Inspect all ${fmtNum(review.counts.total)} enrolled recipients</summary>
            <div class="campaign-preflight-table-wrap"><table><thead><tr><th>Contact</th><th>Email</th><th>Review</th><th>Reason</th></tr></thead><tbody>${recipientRows || '<tr><td colspan="4">No enrolled recipients.</td></tr>'}</tbody></table></div>
          </details>
          <p class="campaign-preflight-hash">Review fingerprint <code>${escapeHtml(review.reviewHash)}</code></p>
          ${review.ready ? '<label class="form-label" for="campaign-queue-limit">Maximum recipients to queue</label><input id="campaign-queue-limit" class="form-input" type="number" name="limit" min="1" max="500" value="50" required>' : ''}
        </div>`;
      openDialog({
        title: 'Campaign launch review', eyebrow: 'LIVE READINESS CHECK',
        submitLabel: review.ready ? 'Queue reviewed recipients' : undefined,
        body,
        onSubmit: async form => {
          const limit = Number(form.get('limit'));
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Queue between 1 and 500 recipients.');
          const result = await Sending.queueSends(id, { limit, reviewHash: review.reviewHash });
          notify(`Queued ${result.queued} recipient${result.queued === 1 ? '' : 's'}; ${result.skipped} skipped.`);
          await renderCampaigns(container);
        },
      });
    } catch (error) { notify(error.message || 'Campaign preflight could not be loaded.', 'error'); }
  };
  window.__editCampaignDraft = id => {
    const campaign = list.find(item => Number(item.id) === Number(id));
    if (!campaign || campaign.status !== 'draft') return;
    openDialog({
      title: 'Edit campaign draft', eyebrow: 'CAMPAIGN MANAGEMENT', submitLabel: 'Save draft',
      body: `<p class="contact-picker-intro">Only the draft name is editable here. Its recipient snapshot is preserved.</p><label class="form-label" for="campaign-draft-name">Campaign name</label><input id="campaign-draft-name" class="form-input" name="name" maxlength="200" value="${escapeHtml(campaign.name)}" required>`,
      onSubmit: async form => {
        const result = await Campaigns.updateDraft(id, { name: form.get('name') });
        notify(result.changed ? 'Campaign draft renamed.' : 'Campaign name is unchanged.');
        await renderCampaigns(container);
      },
    });
  };
  window.__archiveCampaignDraft = async id => {
    if (!await confirmAction({ title: 'Archive campaign draft', message: 'The campaign and its audience will be kept, and you can restore it later.', confirmLabel: 'Archive draft', danger: true })) return;
    try {
      await Campaigns.archiveDraft(id);
      notify('Draft archived. Its recipient snapshot was preserved.');
      await renderCampaigns(container);
    } catch (error) { notify(error.message, 'error'); }
  };
  window.__restoreCampaignDraft = async id => {
    try {
      await Campaigns.restoreDraft(id);
      _showArchivedCampaigns = false;
      notify('Draft restored to active campaigns.');
      await renderCampaigns(container);
    } catch (error) { notify(error.message, 'error'); }
  };
  window.__campaignSenders = async id => {
    try {
      const selection = await Campaigns.senders(id);
      if (selection.locked) {
        notify('Sender selection is locked after launch or send history.', 'error');
        return;
      }
      const selected = new Set(selection.senderIds || []);
      const statusLabel = readiness => readiness === 'ready' ? 'Ready' : readiness.replaceAll('_', ' ');
      openDialog({
        title: 'Choose campaign senders', eyebrow: 'SENDER SELECTION', submitLabel: 'Save sender pool',
        body: `<p class="contact-picker-intro">Choose one or more eligible mailboxes. Queueing will use only this pool and will not rotate to unselected mailboxes. Credentials are never shown here.</p><div class="campaign-sender-options">${selection.mailboxes.length ? selection.mailboxes.map(mailbox => `<label class="campaign-sender-option ${mailbox.readiness === 'ready' ? '' : 'is-unavailable'}"><input type="checkbox" name="mailboxId" value="${mailbox.id}" ${selected.has(mailbox.id) ? 'checked' : ''} ${mailbox.readiness !== 'ready' && !selected.has(mailbox.id) ? 'disabled' : ''}><span><strong>${escapeHtml(mailbox.email)}</strong><small>${escapeHtml(mailbox.domain || '')}</small></span><em>${escapeHtml(statusLabel(mailbox.readiness))}</em></label>`).join('') : '<div class="contact-list-empty"><h3>No mailboxes configured</h3><p>Add and prepare a sending mailbox before setting the campaign sender pool.</p></div>'}</div><p class="contact-picker-intro">${selection.readyCount ? `${fmtNum(selection.readyCount)} selected sender(s) are currently eligible.` : 'No selected sender is currently eligible. Configure SMTP, warm-up, and health before queueing.'}</p>`,
        onSubmit: async form => {
          const saved = await Campaigns.setSenders(id, form.getAll('mailboxId').map(Number));
          notify(`${fmtNum(saved.senderIds.length)} sender(s) saved. Queueing will use only eligible members of this pool.`);
          await renderCampaigns(container);
        },
      });
    } catch (error) { notify(error.message, 'error'); }
  };
  window.__pauseCampaign = async id => {
    try {
      const result = await Campaigns.pause(id);
      notify(`Campaign paused. ${result.pendingRetained || 0} scheduled message(s) will wait for resume.`);
      await renderCampaigns(container);
    } catch (error) { notify(error.message, 'error'); }
  };
  window.__resumeCampaign = async id => {
    try {
      await Campaigns.resume(id);
      notify('Campaign resumed. Existing recipient and sending checks still apply.');
      await renderCampaigns(container);
    } catch (error) { notify(error.message, 'error'); }
  };
  window.__stopCampaign = async id => {
    if (!await confirmAction({ title: 'Stop campaign', message: 'Queued messages will be cancelled. Messages already being submitted to SMTP may still be accepted.', confirmLabel: 'Stop campaign', danger: true })) return;
    try {
      const result = await Campaigns.stop(id);
      notify(`Campaign stopped. ${result.cancelled || 0} queued message(s) cancelled; ${result.inFlight || 0} SMTP submission(s) may still finish.`);
      await renderCampaigns(container);
    } catch (error) { notify(error.message, 'error'); }
  };
  window.__processSends = async () => {
    try {
      const result = await Sending.process();
      notify(result?.message || 'Send queue processing request completed. Check delivery evidence for actual SMTP acceptance.', 'info');
    } catch (error) { notify(error.message || 'Could not start send queue processing.', 'error'); }
  };
}

function renderCampaignCard(c) {
  const sent = c.sent || 0;
  const openRate  = sent > 0 ? ((c.opened  || 0) / sent * 100).toFixed(1) : '—';
  const replyRate = sent > 0 ? ((c.replied || 0) / sent * 100).toFixed(1) : '—';
  const bounceRate= sent > 0 ? ((c.bounced || 0) / sent * 100).toFixed(1) : '—';

  const statusColor = c.status === 'active' ? 'var(--emerald)' : ['draft', 'paused'].includes(c.status) ? 'var(--amber)' : 'var(--text-muted)';
  const statisticalCandidate = c.winner;

  return `
  <div class="glass-panel mb-14 animate-in campaign-card">
    <div class="campaign-card-header">
      <div>
        <div class="campaign-name">${escapeHtml(c.name)}</div>
        <div class="campaign-meta">${c.sequence_step_count ? `${fmtNum(c.sequence_step_count)}-step sequence · worker enabled` : `Step ${fmtNum(c.sequence_step || 1)}`} · ${fmtNum(c.audience_total || 0)} recipients · ${fmtNum(c.audience_eligible || 0)} ready · ${c.sender_count ? `${fmtNum(c.sender_ready_count || 0)}/${fmtNum(c.sender_count)} senders ready` : 'sender required'}${c.uncertain ? ` · ${fmtNum(c.uncertain)} SMTP outcome(s) need review` : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${statisticalCandidate ? `<span class="winner-chip">Statistical candidate · Variant ${c.winner}${c.sequence_step_count ? ' · step 1' : ''}</span>` : ''}
        <span class="status-badge" style="color:${statusColor};border-color:${statusColor}44">${c.status || 'draft'}</span>
      </div>
    </div>

    <!-- Metrics row -->
    <div class="campaign-metrics">
      ${[
        { label: 'Sent',     val: fmtNum(sent),           color: 'var(--indigo-light)' },
        { label: 'Open %',   val: openRate + (openRate !== '—' ? '%' : ''), color: 'var(--sky)' },
        { label: 'Reply %',  val: replyRate + (replyRate !== '—' ? '%' : ''), color: 'var(--emerald)' },
        { label: 'Bounce %', val: bounceRate + (bounceRate !== '—' ? '%' : ''), color: 'var(--rose)' },
      ].map(m => `
      <div class="camp-metric">
        <div class="camp-metric-val" style="color:${m.color}">${m.val}</div>
        <div class="camp-metric-label">${m.label}</div>
      </div>`).join('')}
    </div>

    <!-- Variant pills -->
    ${c.variants?.length > 0 ? `
    <div class="campaign-variants">
      ${c.variants.map(v => `
      <div class="variant-pill ${v.declared_winner ? 'winner' : ''}">
        <span class="variant-label">Var ${v.variant}</span>
        <span class="variant-rate">${v.sent > 0 ? (v.reply_rate * 100).toFixed(1) + '% reply' : 'no data'}</span>
        ${v.declared_winner ? '<span class="winner-star">★</span>' : ''}
        ${v.significance ? `<span class="confidence-badge">${(v.significance * 100).toFixed(0)}% conf.</span>` : ''}
      </div>`).join('')}
    </div>` : `<div style="font-size:0.72rem;color:var(--text-muted);padding:8px 0">No A/B data yet — queue sends to generate variant data</div>`}

    <!-- Actions -->
    <div class="campaign-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-campaign-audience="${c.id}">${icon('people', 14)} Recipients</button>
      <button class="btn btn-ghost btn-sm" type="button" data-campaign-sequence="${c.id}">Sequence${c.sequence_step_count ? ` · ${fmtNum(c.sequence_step_count)}` : ''}</button>
      ${c.launch_snapshot ? `<button class="btn btn-ghost btn-sm" type="button" data-campaign-launch-view="${c.id}" aria-expanded="false">Launch snapshot · v${fmtNum(c.launch_snapshot.version)}</button>` : ''}
      <button class="btn btn-ghost btn-sm" type="button" data-campaign-view-ab="${c.id}" data-campaign-name="${escapeHtml(c.name)}">📊 A/B Analysis</button>
      <button class="btn btn-ghost btn-sm" type="button" data-campaign-clone="${c.id}" data-campaign-name="${escapeHtml(c.name)}">Duplicate as draft</button>
      ${c.status === 'draft' && !c.sender_locked ? `<button class="btn btn-ghost btn-sm" type="button" data-campaign-senders="${c.id}">Choose senders</button>` : ''}
      ${['draft', 'active'].includes(c.status) ? `<button class="btn btn-ghost btn-sm" type="button" data-campaign-queue="${c.id}" title="Review recipients, sender readiness, compliance settings, and queue size before launch.">→ Review &amp; Queue</button>` : ''}
      ${c.status === 'active' ? `<button class="btn btn-ghost btn-sm" type="button" data-campaign-pause="${c.id}">Ⅱ Pause</button>` : ''}
      ${c.status === 'paused' ? `<button class="btn btn-primary btn-sm" type="button" data-campaign-resume="${c.id}">▶ Resume</button>` : ''}
      ${['active', 'paused'].includes(c.status) ? `<button class="btn btn-danger btn-sm" type="button" data-campaign-stop="${c.id}">Stop campaign</button>` : ''}
      ${c.status === 'active' && c.scheduled > 0 ? `<button class="btn btn-ghost btn-sm" type="button" onclick="window.__processSends()">▶ Process Queue</button>` : ''}
      ${c.status === 'draft' ? `<button class="btn btn-ghost btn-sm" type="button" data-campaign-edit-draft="${c.id}">Edit draft</button><button class="btn btn-ghost btn-sm" type="button" data-campaign-archive-draft="${c.id}">Archive draft</button>` : ''}
      ${c.status === 'archived' ? `<button class="btn btn-primary btn-sm" type="button" data-campaign-restore-draft="${c.id}">Restore draft</button>` : ''}
    </div>
    ${c.launch_snapshot ? `<section class="campaign-launch-detail" data-campaign-launch-detail="${c.id}" hidden aria-label="Immutable campaign launch snapshot">
      <strong>Immutable launch snapshot · version ${fmtNum(c.launch_snapshot.version)}</strong>
      <span>${fmtNum(c.launch_snapshot.recipientCount || 0)} recipients · ${fmtNum(c.launch_snapshot.senderCount || 0)} senders · ${fmtNum(c.launch_snapshot.sequenceStepCount || 0)} sequence steps · ${fmtNum(c.launch_snapshot.personalizedContactCount || 0)} contacts with reviewed copy</span>
      <code>SHA-256 ${escapeHtml(c.launch_snapshot.snapshotHash)}</code>
      <small>${c.launch_snapshot.integrityVerified ? 'Snapshot integrity verified.' : 'Snapshot integrity check failed; sending is blocked.'} Captured ${escapeHtml(c.launch_snapshot.createdAt)}. Configuration changes after launch are blocked before SMTP; recipient policy checks still run for every send.</small>
    </section>` : ''}
  </div>`;
}

function renderSequencePreview(preview) {
  const readyMessage = preview.ready
    ? '<strong class="is-ready">Preview is complete for this contact.</strong>'
    : `<strong class="is-blocked">Preview needs attention.</strong><span>${preview.missingContent?.length ? `Missing ${escapeHtml(preview.missingContent.join(' and '))}. ` : ''}${preview.unresolvedTokens?.length ? `Add a value or fallback for: ${escapeHtml(preview.unresolvedTokens.join(', '))}.` : ''}</span>`;
  return `<div class="campaign-sequence-preview-result">${readyMessage}<dl><dt>Subject · Variant ${escapeHtml(preview.variantKey)}</dt><dd><pre>${escapeHtml(preview.subject)}</pre></dd><dt>Message body</dt><dd><pre>${escapeHtml(preview.body)}</pre></dd></dl></div>`;
}

export function renderABPanel(variantData, timeline) {
  const variants = variantData?.variants || [];
  const comparisons = variantData?.comparisons || [];
  const stepOptions = (variantData?.sequenceSteps || []).length ? `
    <label class="campaign-ab-step-select">Compare sequence step
      <select class="form-select" data-ab-step>${variantData.sequenceSteps.map(step => `<option value="${step.id}" ${step.id === variantData.selectedStepId ? 'selected' : ''}>Step ${fmtNum(step.position)} · ${fmtNum(step.delayDays)} day delay</option>`).join('')}</select>
    </label>` : '';

  if (variants.length === 0) {
    return `${stepOptions}<div class="empty-state" style="padding:24px">
      <p>No SMTP-accepted variant messages for this step yet. Queue the campaign and wait for actual transport acceptance.</p>
    </div>`;
  }

  return `
  ${stepOptions}
  <!-- Variant comparison table -->
  <div class="ab-variants-grid">
    ${variants.map(v => {
      const color = v.variant === 'A' ? 'var(--indigo-light)' : 'var(--violet)';
      return `
      <div class="ab-variant-card ${v.declared_winner ? 'winner' : ''}">
        <div class="ab-variant-header">
          <span class="ab-variant-name" style="color:${color}">Variant ${v.variant}</span>
          ${v.declared_winner ? '<span class="ab-winner-badge">Statistical winner</span>' : ''}
        </div>
        <div class="ab-stats-grid">
          ${[
            { label: 'Sent',     val: fmtNum(v.sent) },
            { label: 'Opened',   val: fmtNum(v.opened) },
            { label: 'Replied',  val: fmtNum(v.replied) },
            { label: 'Interested', val: fmtNum(v.positive) },
            { label: 'Open %',   val: v.sent > 0 ? (v.open_rate * 100).toFixed(1) + '%' : '—' },
            { label: 'Reply %',  val: v.sent > 0 ? (v.reply_rate * 100).toFixed(1) + '%' : '—' },
          ].map(s => `
          <div class="ab-stat">
            <div class="ab-stat-val">${s.val}</div>
            <div class="ab-stat-label">${s.label}</div>
          </div>`).join('')}
        </div>
        <div class="ab-sample-bar">
          <div class="ab-sample-fill" style="width:${Math.min(100, (v.sample_progress || 0) * 100).toFixed(0)}%;background:${color}"></div>
        </div>
        <div style="font-size:0.65rem;color:var(--text-muted)">${fmtNum(v.sent)} / ${fmtNum(v.sample_target)} sample target</div>
      </div>`;
    }).join('')}
  </div>

  <!-- Statistical test results -->
  ${comparisons.length > 0 ? `
  <div class="ab-test-result" style="margin-top:16px">
    ${comparisons.map(c => `
    <div class="ab-z-result">
      <div>
        <strong>Variant ${c.variantA} vs ${c.variantB}</strong>
        <span style="color:var(--text-muted);font-size:0.72rem;margin-left:8px">on ${c.metric}</span>
      </div>
      <div class="ab-z-stats">
        ${c.sampleMet ? `<span>z = ${c.zScore?.toFixed(2)}</span><span>p = ${c.pValue?.toFixed(4)}</span><span style="color:${c.significant ? 'var(--emerald)' : 'var(--amber)'}">${(c.confidence * 100).toFixed(1)}% confidence</span>` : `<span>Sample ${fmtNum(variants.find(v => v.variant === c.variantA)?.sent || 0)} / ${fmtNum(c.sampleTarget)} and ${fmtNum(variants.find(v => v.variant === c.variantB)?.sent || 0)} / ${fmtNum(c.sampleTarget)} · too small to test</span>`}
        ${c.significant ? `<span style="color:var(--emerald)">✓ Significant</span>` : `<span style="color:var(--amber)">${c.sampleMet ? '⏳ Need more evidence' : 'Minimum sample not met'}</span>`}
        ${c.winner ? `<span style="color:var(--emerald)">Winner: Variant ${c.winner}</span>` : ''}
      </div>
    </div>`).join('')}
  </div>` : ''}`;
}
