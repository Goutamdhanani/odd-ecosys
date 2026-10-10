import { Stats, Batches, Events, Sending, relTime, fmtNum } from './api.js';
import { escapeHtml, icon, notify, openDialog } from './ui.js';
import { dashboardLeadTotal } from './dashboard-metrics.js';

const stages = [['discovered', 'Discovered', '01'], ['site_checked', 'Qualified', '02'], ['verified', 'Verified', '03'], ['awaiting_approval', 'In review', '04'], ['queued', 'Queued', '05'], ['sent', 'Sent', '06'], ['replied', 'Replied', '07'], ['won', 'Won', '08']];
const eventsConfig = {
  replied: ['mail', 'Reply received'], opened: ['activity', 'Open signal'], delivered: ['check', 'Delivery confirmed'], sent: ['send', 'Email accepted'], send_submission_uncertain: ['activity', 'SMTP outcome unknown — review required'], verified: ['shield', 'Email verified'], site_check: ['globe', 'Site checked'], approved: ['check', 'Copy approved'], discovered: ['people', 'Lead discovered'], hard_bounce: ['activity', 'Hard bounce'], soft_bounce: ['activity', 'Soft bounce'], spam_complaint: ['shield', 'Complaint'], send_failed: ['activity', 'Send failed'],
};

export async function renderDashboard(container) {
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Bringing your workspace into view…</span></div>';
  const [funnel, sending, batches, events, mailboxResult] = await Promise.all([
    Stats.funnel(), Stats.sends(), Batches.list(), Events.recent(8),
    Sending.mailboxes().then(data => ({ data, error: null })).catch(error => ({ data: null, error })),
  ]);
  if (!container.isConnected || location.hash && location.hash !== '#dashboard') return;
  const f = funnel || {}; const s = sending || {};
  const batchList = Array.isArray(batches) ? batches : [];
  const eventList = Array.isArray(events) ? events : [];
  const mailboxes = Array.isArray(mailboxResult.data) ? mailboxResult.data : mailboxResult.data?.mailboxes;
  const mailboxCount = Array.isArray(mailboxes) ? mailboxes.length : null;
  const totalLeads = dashboardLeadTotal(f);
  const sentCount = Number(s.sent) || 0; const replyCount = Number(f.replied) || 0;
  const replyRate = sentCount ? `${(replyCount / sentCount * 100).toFixed(1)}%` : '—';
  const activeBatches = batchList.filter(batch => !['closed', 'archived'].includes(batch.status));
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const maxStage = Math.max(1, ...stages.map(([key]) => Number(f[key]) || 0));
  container.innerHTML = `
  <div class="overview-topline"><div class="eyebrow"><span class="tiny-dot"></span> YOUR OUTBOUND WORKSPACE</div><span class="workspace-date">${escapeHtml(date)}</span></div>
  <section class="orbit-hero" aria-labelledby="dashboard-title">
    <div class="hero-grid" aria-hidden="true"></div>
    <div class="hero-copy"><div class="hero-label">A little signal. A lot of possibility.</div><h1 id="dashboard-title">Good conversations<br>start <span>here.</span></h1><p>Your people, your message, your next opportunity.<br class="desktop-break"> One considered space to bring them together.</p><div class="hero-actions"><button class="btn btn-primary" id="dash-new-batch">${icon('plus', 17)}Create a batch</button><button class="btn btn-outline" data-nav="leads">Explore leads${icon('diagonal', 16)}</button></div><div class="hero-caption"><span class="caption-rule"></span> RESEARCH. PERSONALIZE. CONNECT.</div></div>
    <div class="hero-orbit" aria-hidden="true"><div class="orbit-aura"></div><div class="orbit-track track-one"></div><div class="orbit-track track-two"></div><div class="orbit-track track-three"></div><div class="orbit-core"><div class="core-rim"><div class="core-face">${icon('send', 41)}</div></div></div><div class="orbit-node node-research">${icon('globe', 16)}<span>Discover<span class="node-sub">Find your people</span></span></div><div class="orbit-node node-copy">${icon('sparkle', 16)}<span>Personalize<span class="node-sub">Make it meaningful</span></span></div><div class="orbit-node node-connect">${icon('mail', 16)}<span>Connect<span class="node-sub">Start a conversation</span></span></div><span class="orbital-star star-one"></span><span class="orbital-star star-two"></span><span class="orbital-star star-three"></span><span class="orbit-coordinate">OUTBOUND / IN ORBIT</span></div>
    <div class="hero-bottom"><span><span class="tiny-dot"></span>Built around your next connection</span><button data-nav="campaigns">Your campaigns ${icon('arrow', 16)}</button></div>
  </section>
  <div class="overview-section-heading"><div><span class="eyebrow">THE BIG PICTURE</span><h2>A pulse on your pipeline.</h2></div><span class="observed-label">${icon('activity', 14)}From your workspace</span></div>
  <section class="metric-strip" aria-label="Pipeline metrics">
    ${[
      ['People in your pipeline', fmtNum(totalLeads), `${batchList.length} ${batchList.length === 1 ? 'batch' : 'batches'} in your workspace`, 'people', 'leads'],
      ['Emails sent today', fmtNum(Number(s.today_sent) || 0), `${fmtNum(sentCount)} accepted in total`, 'send', 'campaigns'],
      ['Reply rate', replyRate, sentCount ? `${fmtNum(replyCount)} leads have replied` : 'Available after your first send', 'mail', 'analytics'],
      ['Ready for your review', fmtNum(Number(f.awaiting_approval) || 0), 'A human touch before the next step', 'sparkle', 'personalization'],
    ].map(([label, value, hint, symbol, route], index) => `<button class="metric-card" data-nav="${route}"><div class="metric-top"><span>${label}</span>${icon(symbol, 18)}</div><div class="metric-value">${value}<span class="metric-link">${icon('diagonal', 16)}</span></div><div class="metric-note">${hint}</div><span class="metric-index">0${index + 1}</span></button>`).join('')}
  </section>
  <div class="observatory-grid">
    <section class="studio-panel pipeline-panel"><header class="studio-panel-header"><div><span class="eyebrow">FROM FIRST LOOK TO FIRST REPLY</span><h2>The connection journey</h2></div><button class="icon-btn" data-nav="leads" aria-label="Explore lead pipeline">${icon('diagonal')}</button></header><div class="journey-summary"><span>${fmtNum(totalLeads)}<small>people, at every stage</small></span><div class="journey-legend"><span class="tiny-dot"></span>Current lead status</div></div><div class="journey-bars">${stages.map(([key, label, number], index) => { const count = Number(f[key]) || 0; return `<div class="journey-stage"><div class="journey-bar-space"><div class="journey-bar ${count ? 'has-value' : ''}" style="--bar-height:${count / maxStage * 100}%;--bar-tone:${index}"></div><span class="journey-value">${fmtNum(count)}</span></div><div class="journey-label">${label}</div><span class="journey-number">${number}</span></div>`; }).join('')}</div><footer class="studio-panel-footer"><span>${totalLeads ? 'A snapshot of where each lead stands.' : 'Your journey will take shape as you add leads.'}</span><button data-nav="leads">View pipeline ${icon('arrow', 14)}</button></footer></section>
    <section class="studio-panel activity-panel"><header class="studio-panel-header"><div><span class="eyebrow">THE LATEST SIGNALS</span><h2>Workspace activity</h2></div><span class="subtle-counter">${eventList.length.toString().padStart(2, '0')}</span></header>${eventList.length ? `<div class="studio-activity">${eventList.map(event => { const [symbol, label] = eventsConfig[event.event_type] || ['activity', event.event_type || 'Activity']; return `<div class="studio-activity-row"><span class="activity-symbol">${icon(symbol, 16)}</span><div><strong>${escapeHtml(event.business_name || 'Workspace event')}</strong><span>${escapeHtml(label)}</span></div><time>${escapeHtml(relTime(event.event_at))}</time></div>`; }).join('')}</div>` : `<div class="signal-empty"><div class="signal-rings">${icon('activity', 23)}</div><h3>Quiet, for now.</h3><p>Your first import, review or conversation<br>will leave a signal here.</p><button class="text-action" data-nav="batches">Start with a batch ${icon('arrow', 15)}</button></div>`}<footer class="studio-panel-footer"><span>Recorded workspace events</span>${icon('clock', 14)}</footer></section>
  </div>
  <div class="workspace-lower-grid">
    <section class="studio-panel batches-panel"><header class="studio-panel-header"><div><span class="eyebrow">WORK IN MOTION</span><h2>Your active batches <span class="heading-count">${activeBatches.length}</span></h2></div><button class="text-action" data-nav="batches">View all ${icon('arrow', 15)}</button></header>${activeBatches.length ? `<div class="studio-batch-list">${activeBatches.slice(0, 4).map(batch => `<button class="studio-batch-row" data-nav="batches"><span class="batch-symbol">${icon('layers')}</span><span class="studio-batch-info"><strong>${escapeHtml(batch.name || batch.label || `Batch ${batch.id}`)}</strong><small>${escapeHtml(batch.phase || 'discovery')} · ${fmtNum(Number(batch.lead_count ?? batch.actual_leads) || 0)} leads</small></span><span class="studio-status">${escapeHtml(batch.status)}</span>${icon('diagonal', 14)}</button>`).join('')}</div>` : `<div class="batch-empty"><span class="batch-empty-symbol">${icon('layers', 26)}</span><div><h3>A fresh start.</h3><p>Group your prospects into a batch. Take the next step together.</p></div><button class="btn btn-outline btn-sm" id="dash-create-second">${icon('plus', 15)}New batch</button></div>`}</section>
    <section class="studio-panel fleet-panel"><header class="studio-panel-header"><div><span class="eyebrow">YOUR SENDING FOUNDATION</span><h2>Mailbox fleet</h2></div>${icon('mail', 19)}</header><div class="fleet-content"><div class="fleet-value">${mailboxCount === null ? '—' : fmtNum(mailboxCount)}<span>${mailboxCount === 1 ? 'mailbox' : 'mailboxes'} configured</span></div><p>${mailboxCount === null ? 'Mailbox information is unavailable. Try refreshing.' : mailboxCount ? 'Review your senders and their connection health.' : 'Bring your email accounts into one place.'}</p><button class="text-action" data-nav="mailboxes">${mailboxCount ? 'Manage mailboxes' : 'Connect a mailbox'} ${icon('arrow', 15)}</button></div></section>
  </div>
  <footer class="workspace-footer"><span class="footer-brand">odd<span>ecosys</span></span><span>Thoughtful outreach. Meaningful connections.</span><span class="footer-location">YOUR WORKSPACE, IN FOCUS ${icon('globe', 13)}</span></footer>`;
  container.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => window.__nav(button.dataset.nav)));
  const newBatch = () => openDialog({
    title: 'Start a new batch', eyebrow: 'A NEW CONNECTION JOURNEY', submitLabel: 'Create batch',
    body: `<p class="dialog-description">Give your prospect group a name, then choose where its journey begins.</p><label class="studio-field">Batch name<input name="name" required maxlength="120" placeholder="e.g. Independent studios — London" autocomplete="off" autofocus></label><label class="studio-field">Starting phase<select name="phase"><option value="discovery">Discovery</option><option value="qualification">Qualification</option><option value="sending">Sending</option></select></label>`,
    onSubmit: async values => { const name = values.get('name').trim(); if (!name) throw new Error('Please give your batch a name.'); await Batches.create({ name, phase: values.get('phase') }); notify('Your batch is ready.'); await renderDashboard(container); },
  });
  container.querySelector('#dash-new-batch')?.addEventListener('click', newBatch);
  container.querySelector('#dash-create-second')?.addEventListener('click', newBatch);
  window.__dashNewBatch = newBatch;
}
