// ============================================================
//  ODD-ECOSYS — Qualification View (Phase 3 Full Engine)
//  100% Live API · Real Technical Site Audits & Facebook Liveness
//  Live Progress Polling · Dynamic 6-Status Breakdown · Signal Drawer
// ============================================================

import { Qualify, Batches, Leads, relTime, fmtNum } from './api.js';
import { escapeHtml, icon, notify, openDialog } from './ui.js';

const STATUS_CONFIG = {
  NO_SITE:       { label: 'No Site',       color: 'var(--text-muted)', bg: 'rgba(142,142,147,0.15)', border: 'rgba(142,142,147,0.3)', dot: '#8E8E93', desc: 'No web address found' },
  DEAD_SITE:     { label: 'Dead Site',     color: 'var(--system-red)',   bg: 'rgba(255,69,58,0.15)',   border: 'rgba(255,69,58,0.3)',   dot: '#FF453A', desc: 'HTTP 404 / 500 / timeout' },
  DOMAIN_PARKED: { label: 'Parked Domain', color: 'var(--system-purple)',bg: 'rgba(191,90,242,0.15)',  border: 'rgba(191,90,242,0.3)',  dot: '#BF5AF2', desc: 'Squatted / parking lander' },
  OUTDATED:      { label: 'Outdated Site', color: 'var(--system-orange)',bg: 'rgba(255,159,10,0.15)',  border: 'rgba(255,159,10,0.3)',  dot: '#FF9F0A', desc: 'Prime cold outreach target' },
  MODERN:        { label: 'Modern Site',   color: 'var(--system-green)', bg: 'rgba(48,209,88,0.15)',   border: 'rgba(48,209,88,0.3)',   dot: '#30D158', desc: 'Disqualified (site modern)' },
  CHECK_FAILED:  { label: 'Check Failed',  color: 'var(--system-cyan)',  bg: 'rgba(100,210,255,0.15)', border: 'rgba(100,210,255,0.3)', dot: '#64D2FF', desc: 'SPA / SSRF / circuit open' },
};

let _batches = [];
let _selectedBatchId = null;
let _leads = [];
let _staleCount = 0;
let _qualificationJob = null;
let _activeFilter = 'all';
let _expandedLeadId = null;
let _pollTimer = null;
let _spotCheckLeads = [];
let _statusDistribution = {};
let _leadTotal = 0;
let _scoringProfile = null;
let _resultOffset = 0;
const RESULT_PAGE_SIZE = 100;
let _reviewQueueTotal = 0;
let _reviewQueueOffset = 0;
const REVIEW_QUEUE_PAGE_SIZE = 50;
const _scoringReplayByLeadId = {};
const SCORING_SIGNAL_LABELS = {
  ssl_valid: 'Valid TLS certificate',
  viewport_meta: 'Mobile viewport metadata',
  copyright_recent: 'Recent copyright year',
  has_analytics: 'Analytics detected',
  modern_cms: 'Modern CMS detected',
  responsive_images: 'Responsive images',
  fast_load: 'Page under 2 MB',
  structured_data: 'Structured data',
  custom_domain_email: 'Matching domain email',
  social_links: 'At least two social links',
  last_modified_recent: 'Recently modified',
  https_redirect: 'HTTPS used or enforced',
};
const QUALIFICATION_REASON_LABELS = {
  source_access_unknown_http_401: 'Website requires access (HTTP 401); site availability is unknown.',
  source_access_unknown_http_403: 'Website denied automated access (HTTP 403); site availability is unknown.',
  source_access_unknown_http_407: 'Website network proxy denied access (HTTP 407); site availability is unknown.',
  source_access_unknown_http_408: 'Website request timed out (HTTP 408); site availability is unknown.',
  source_access_unknown_http_423: 'Website is temporarily locked (HTTP 423); site availability is unknown.',
  source_access_unknown_http_429: 'Website rate-limited the audit (HTTP 429); site availability is unknown.',
  source_access_unknown_http_451: 'Website is legally restricted (HTTP 451); availability is unknown.',
  facebook_access_restricted_http_401: 'Facebook requires authentication (HTTP 401); page availability is unknown.',
  facebook_access_restricted_http_403: 'Facebook denied automated access (HTTP 403); page availability is unknown.',
  facebook_rate_limited_http_429: 'Facebook rate-limited the check (HTTP 429); page availability is unknown.',
  facebook_network_unavailable: 'Facebook could not be reached; page availability is unknown.',
  facebook_source_policy_blocked: 'The Facebook check was blocked by outbound safety policy; page availability is unknown.',
  facebook_check_unavailable: 'The Facebook check failed; page availability is unknown.',
  facebook_check_unknown: 'Facebook returned no definitive availability result.',
};

function formatQualificationReason(reason) {
  const text = String(reason ?? '');
  const sourceAccess = text.match(/^source_access_unknown_http_(\d+)$/);
  if (sourceAccess) {
    const status = Number(sourceAccess[1]);
    if (status === 401) return 'Website requires authentication (HTTP 401); site availability is unknown.';
    if (status === 403) return 'Website denied automated access (HTTP 403); site availability is unknown.';
    if (status === 429) return 'Website rate-limited the audit (HTTP 429); site availability is unknown.';
    return `Website access could not be verified (HTTP ${sourceAccess[1]}); site availability is unknown.`;
  }
  if (text.startsWith('facebook_check_unknown:')) return formatQualificationReason(text.slice('facebook_check_unknown:'.length));
  const sourceResponse = text.match(/^source_response_unknown_http_(\d+)$/);
  if (sourceResponse) return `Website returned HTTP ${sourceResponse[1]}; site availability is unknown.`;
  const facebookResponse = text.match(/^facebook_response_unknown_http_(\d+)$/);
  if (facebookResponse) return `Facebook returned HTTP ${facebookResponse[1]}; page availability is unknown.`;
  if (text === 'site_fetch_unknown') return 'The website could not be fetched; site availability is unknown.';
  return QUALIFICATION_REASON_LABELS[text] || text;
}

export async function renderQualification(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading qualification engine…</span></div>`;

  // 1. Fetch live batches
  const batchesRes = await Batches.list();
  _batches = Array.isArray(batchesRes) ? batchesRes : [];
  try { _scoringProfile = (await Qualify.scoring()).active; } catch { _scoringProfile = null; }

  if (!_selectedBatchId && _batches.length > 0) {
    // Pick the first processing or open batch, fallback to first batch
    const active = _batches.find(b => b.status === 'processing' || b.status === 'open');
    _selectedBatchId = active ? active.id : _batches[0].id;
  }

  // 2. Fetch live data for selected batch in parallel
  await loadBatchQualificationData();

  renderFullView(container);
}

async function loadBatchQualificationData() {
  if (!_selectedBatchId) return;

  const [leadsRes, staleRes, spotRes, distRes, jobRes] = await Promise.all([
    Qualify.results(_selectedBatchId, {
      limit: RESULT_PAGE_SIZE,
      offset: _resultOffset,
      siteStatus: _activeFilter === 'all' ? undefined : _activeFilter,
    }),
    Qualify.staleCount(),
    Qualify.reviewQueue({ batchId: _selectedBatchId, limit: REVIEW_QUEUE_PAGE_SIZE, offset: _reviewQueueOffset }),
    Qualify.distribution(_selectedBatchId),
    Qualify.status(_selectedBatchId),
  ]);

  _leads = Array.isArray(leadsRes?.results) ? leadsRes.results : Array.isArray(leadsRes) ? leadsRes : [];
  _leadTotal = Number(leadsRes?.total) || _leads.length;
  _staleCount = staleRes?.count || 0;
  _qualificationJob = jobRes || null;
  _spotCheckLeads = Array.isArray(spotRes?.results) ? spotRes.results : [];
  _reviewQueueTotal = Number(spotRes?.total) || 0;

  // Parse distribution map
  _statusDistribution = {};
  if (Array.isArray(distRes)) {
    distRes.forEach(d => {
      _statusDistribution[d.site_status] = d.count;
    });
  }
}

function renderFullView(container) {
  const selectedBatch = _batches.find(b => b.id === _selectedBatchId);
  const qualificationActive = Boolean(_qualificationJob?.active);
  const retryableCount = Number(_qualificationJob?.retryableCount) || 0;
  const retryLabel = ['cancelled', 'interrupted', 'failed'].includes(_qualificationJob?.status) || Number(_qualificationJob?.failedCount) > 0;
  const qualifyButtonLabel = retryableCount > 0
    ? `${retryLabel ? 'Retry' : 'Qualify'} remaining (${retryableCount})`
    : 'Qualify leads';

  // Compute counts
  const counts = {
    NO_SITE:       Number(_statusDistribution.NO_SITE) || 0,
    DEAD_SITE:     Number(_statusDistribution.DEAD_SITE) || 0,
    DOMAIN_PARKED: Number(_statusDistribution.DOMAIN_PARKED) || 0,
    OUTDATED:      Number(_statusDistribution.OUTDATED) || 0,
    MODERN:        Number(_statusDistribution.MODERN) || 0,
    CHECK_FAILED:  Number(_statusDistribution.CHECK_FAILED) || 0,
  };

  const totalAudited = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const filteredLeads = _leads;
  const pageStart = _leadTotal > 0 ? _resultOffset + 1 : 0;
  const pageEnd = Math.min(_resultOffset + filteredLeads.length, _leadTotal);

  container.innerHTML = `
  <!-- Header -->
  <div class="dash-header">
    <div>
      <h1 class="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="vertical-align:-4px">
          <circle cx="12" cy="12" r="9" stroke="var(--system-blue)" stroke-width="1.8"/>
          <path d="M12 7v5l3 3" stroke="var(--system-blue)" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        Know who’s worth a closer look.
      </h1>
      <div class="section-sub">
        Explore site quality and research signals before taking the next step.
      </div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <select class="filter-select" id="qual-batch-select" style="min-width:200px">
        ${_batches.length ? '' : '<option value="">Create a batch to begin</option>'}
        ${_batches.map(b => `<option value="${b.id}" ${b.id === _selectedBatchId ? 'selected' : ''}>Batch #${b.id}: ${b.name || 'Cohort'}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" id="btn-recheck-stale" onclick="window.__recheckStaleLeads()">
        ${icon('refresh', 15)} Recheck stale (${_staleCount})
      </button>
      <button class="btn btn-primary btn-sm" id="btn-run-qualify" ${!_selectedBatchId || qualificationActive || retryableCount < 1 ? 'disabled' : ''} title="${!_selectedBatchId ? 'Create a batch first' : qualificationActive ? 'A qualification run is already active' : retryableCount < 1 ? 'There are no discovered leads to qualify in this batch' : ''}" onclick="window.__runBatchQualification()">
        ${icon('globe', 15)} ${qualifyButtonLabel}
      </button>
      <button class="btn btn-danger btn-sm" id="btn-cancel-qualify" style="display:${qualificationActive ? 'inline-flex' : 'none'}" onclick="window.__cancelBatchQualification()">
        ⏹ Cancel
      </button>
    </div>
  </div>

  <!-- Persisted run status remains visible after completion and restart -->
  <div id="qual-progress-panel" class="glass-panel mb-16" style="display:${_qualificationJob?.jobId ? 'block' : 'none'};background:rgba(10,132,255,0.08);border-color:rgba(10,132,255,0.3)">
    <div class="panel-body" style="padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px">
          ${qualificationActive ? '<div class="pulse-dot"></div>' : ''}
          <span style="font-size:0.88rem;font-weight:700;color:var(--text-primary)">
            ${qualificationActive ? `Auditing Batch #${Number(_qualificationJob.batchId)}…` : `Last qualification run · ${escapeHtml(_qualificationJob?.status || 'unknown')}`}
          </span>
          <span id="qual-current-target" style="font-size:0.75rem;color:var(--text-secondary)">
            ${escapeHtml(_qualificationJob?.currentLead ? `Auditing: ${_qualificationJob.currentLead}` : _qualificationJob?.errorMessage || (retryableCount ? `${retryableCount} discovered lead(s) can be retried` : 'No discovered leads remain'))}
          </span>
        </div>
        <span id="qual-progress-stats" class="mono" style="font-size:0.82rem;font-weight:700;color:var(--system-cyan)">
          ${Number(_qualificationJob?.processed) || 0} / ${Number(_qualificationJob?.total) || 0} (${_qualificationJob?.total ? Math.round((_qualificationJob.processed / _qualificationJob.total) * 100) : 100}%) · ${Number(_qualificationJob?.failedCount) || 0} failed
        </span>
      </div>
      <div class="progress-track" style="height:8px">
        <div id="qual-progress-fill" class="progress-fill" style="width:${_qualificationJob?.total ? Math.min(100, Math.round((_qualificationJob.processed / _qualificationJob.total) * 100)) : 100}%;background:linear-gradient(90deg, var(--system-blue), var(--system-cyan))"></div>
      </div>
    </div>
  </div>

  <!-- 6 Status Breakdown Cards -->
  <div class="grid cols-6 mb-16" id="qual-cards-grid">
    ${Object.keys(STATUS_CONFIG).map(key => {
      const cfg = STATUS_CONFIG[key];
      const count = counts[key] || 0;
      const pct = totalAudited > 0 ? Math.round((count / totalAudited) * 100) : 0;
      const isActive = _activeFilter === key;

      return `
      <div class="qual-status-card ${isActive ? 'active' : ''}"
           style="--accent:${cfg.color};--accent-bg:${cfg.bg};cursor:pointer"
           onclick="window.__filterBySiteStatus('${key}')">
        <div class="qual-card-top">
          <span class="qual-card-dot" style="background:${cfg.dot}"></span>
          <span class="qual-card-title">${cfg.label}</span>
        </div>
        <div class="qual-card-val">${count}</div>
        <div class="qual-card-sub">
          <span>${pct}% of cohort</span>
          <span class="qual-card-desc">${cfg.desc}</span>
        </div>
      </div>`;
    }).join('')}
  </div>

  <!-- Main Results Table Panel -->
  <div class="glass-panel mb-16 animate-in">
    <div class="panel-header" style="flex-wrap:wrap;gap:12px">
      <div class="tabs">
        <div class="tab-item ${_activeFilter === 'all' ? 'active' : ''}" onclick="window.__filterBySiteStatus('all')">
          All Leads (${totalAudited})
        </div>
        ${Object.keys(STATUS_CONFIG).map(k => `
          <div class="tab-item ${_activeFilter === k ? 'active' : ''}" onclick="window.__filterBySiteStatus('${k}')">
            ${STATUS_CONFIG[k].label} (${counts[k] || 0})
          </div>
        `).join('')}
      </div>
      <div style="margin-left:auto;font-size:0.75rem;color:var(--text-muted)">
        Showing <strong>${pageStart}–${pageEnd}</strong> of ${_leadTotal} matching leads · score profile v${Number(_scoringProfile?.version) || '—'}
      </div>
    </div>

    <div class="panel-body" style="padding:0;overflow-x:auto">
      ${filteredLeads.length === 0 ? `
      <div class="empty-state" style="padding:36px">
        <p>No leads found matching filter "${_activeFilter}"</p>
        <p class="empty-hint">Click <strong>▶ Run Qualification</strong> to audit this batch</p>
      </div>` : `
      <table class="data-table">
        <thead>
          <tr>
            <th>Business & URL</th>
            <th>Location</th>
            <th>Site Status</th>
            <th>Score</th>
            <th>Confidence</th>
            <th>TLS signal</th>
            <th>Viewport signal</th>
            <th>Facebook response</th>
            <th>Audit Signals / Reasons</th>
            <th class="td-right">Action</th>
          </tr>
        </thead>
        <tbody>
          ${filteredLeads.map(l => renderLeadRow(l)).join('')}
        </tbody>
      </table>`}
    </div>
  </div>
  ${_leadTotal > RESULT_PAGE_SIZE ? `<nav class="qual-pagination" aria-label="Qualification result pages">
    <button class="btn btn-ghost btn-sm" type="button" ${_resultOffset <= 0 ? 'disabled' : ''} onclick="window.__changeQualificationPage(-1)">Previous</button>
    <span>Page ${Math.floor(_resultOffset / RESULT_PAGE_SIZE) + 1} of ${Math.ceil(_leadTotal / RESULT_PAGE_SIZE)}</span>
    <button class="btn btn-ghost btn-sm" type="button" ${_resultOffset + RESULT_PAGE_SIZE >= _leadTotal ? 'disabled' : ''} onclick="window.__changeQualificationPage(1)">Next</button>
  </nav>` : ''}

  <!-- Evidence Review Panel (Unreviewed Low-Confidence Sample) -->
  <div class="glass-panel animate-in">
    <div class="panel-header">
      <span class="panel-title">
        <span class="dot amber"></span>
        Evidence review queue
      </span>
      <span class="panel-hint">Unreviewed website audits with confidence at or below 70 · human decisions are audited and do not change send eligibility</span>
    </div>
    <div class="panel-body">
      ${_spotCheckLeads.length === 0 ? `
      <div style="font-size:0.8rem;color:var(--text-muted);text-align:center;padding:12px">
        No unreviewed low-confidence site audits are waiting in this batch.
      </div>` : `
      <div style="display:flex;flex-direction:column;gap:10px">
        ${_spotCheckLeads.map(l => `
        <div class="qual-review-row">
          <div>
            <strong>${escapeHtml(l.businessName)}</strong>
            <span class="qual-review-meta">${escapeHtml(l.siteStatus)} · score ${l.siteScore ?? '—'} · confidence ${l.confidence}% · ${Array.isArray(l.siteEvidence?.scoring?.unresolvedSignals) ? l.siteEvidence.scoring.unresolvedSignals.length : 0} unresolved signal(s)</span>
            ${l.siteReasons?.length ? `<span class="qual-review-reasons">${l.siteReasons.slice(0, 3).map(reason => escapeHtml(reason)).join(' · ')}</span>` : ''}
          </div>
          <div class="qual-review-actions">
            <button class="btn btn-secondary btn-sm" type="button" onclick="window.__reviewQualificationEvidence(${Number(l.id)})">
              Review evidence
            </button>
          </div>
        </div>`).join('')}
      </div>`}
      ${_reviewQueueTotal > REVIEW_QUEUE_PAGE_SIZE ? `<nav class="qual-pagination" aria-label="Evidence review queue pages">
        <button class="btn btn-ghost btn-sm" type="button" ${_reviewQueueOffset <= 0 ? 'disabled' : ''} onclick="window.__changeReviewQueuePage(-1)">Previous review page</button>
        <span>Page ${Math.floor(_reviewQueueOffset / REVIEW_QUEUE_PAGE_SIZE) + 1} of ${Math.ceil(_reviewQueueTotal / REVIEW_QUEUE_PAGE_SIZE)} · ${_reviewQueueTotal} waiting</span>
        <button class="btn btn-ghost btn-sm" type="button" ${_reviewQueueOffset + REVIEW_QUEUE_PAGE_SIZE >= _reviewQueueTotal ? 'disabled' : ''} onclick="window.__changeReviewQueuePage(1)">Next review page</button>
      </nav>` : ''}
    </div>
  </div>`;

  // Attach event listeners
  const batchSelect = document.getElementById('qual-batch-select');
  if (batchSelect) {
    batchSelect.onchange = async (e) => {
      stopLivePolling();
      _selectedBatchId = parseInt(e.target.value);
      _resultOffset = 0;
      _expandedLeadId = null;
      renderQualification(container);
    };
  }

  // Global window functions
  window.__filterBySiteStatus = (status) => {
    _activeFilter = status;
    _resultOffset = 0;
    loadBatchQualificationData().then(() => renderFullView(container)).catch(error => notify(error.message || 'Could not load qualification results.', 'error'));
  };

  window.__changeQualificationPage = (direction) => {
    const next = _resultOffset + (Number(direction) * RESULT_PAGE_SIZE);
    _resultOffset = Math.max(0, Math.min(next, Math.floor(Math.max(0, _leadTotal - 1) / RESULT_PAGE_SIZE) * RESULT_PAGE_SIZE));
    loadBatchQualificationData().then(() => renderFullView(container)).catch(error => notify(error.message || 'Could not load qualification results.', 'error'));
  };

  window.__changeReviewQueuePage = (direction) => {
    const next = _reviewQueueOffset + (Number(direction) * REVIEW_QUEUE_PAGE_SIZE);
    _reviewQueueOffset = Math.max(0, Math.min(next, Math.floor(Math.max(0, _reviewQueueTotal - 1) / REVIEW_QUEUE_PAGE_SIZE) * REVIEW_QUEUE_PAGE_SIZE));
    loadBatchQualificationData().then(() => renderFullView(container)).catch(error => notify(error.message || 'Could not load the review queue.', 'error'));
  };

  window.__reviewQualificationEvidence = (leadId) => {
    const lead = _spotCheckLeads.find(item => Number(item.id) === Number(leadId));
    if (!lead) return notify('This review item is no longer on the current page. Refresh the queue and try again.', 'warning');
    const statusOptions = Object.keys(STATUS_CONFIG).map(status => `<option value="${status}" ${status === lead.siteStatus ? 'selected' : ''}>${escapeHtml(STATUS_CONFIG[status].label)}</option>`).join('');
    const reasons = lead.siteReasons?.length ? lead.siteReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('') : '<li>No textual reasons were saved.</li>';
    openDialog({
      title: `Review ${lead.businessName}`,
      eyebrow: `LOW-CONFIDENCE SITE AUDIT · ${lead.confidence}%`,
      submitLabel: 'Save review decision',
      body: `<div class="qual-review-dialog-evidence">
          <p><strong>Automated result:</strong> ${escapeHtml(lead.siteStatus)} · ${lead.siteScore ?? 'No score'}/100 · checked ${escapeHtml(lead.siteCheckedAt || 'time unavailable')}</p>
          ${renderScoringSignals(lead.siteEvidence?.signals)}
          <strong>Recorded audit reasons</strong><ul>${reasons}</ul>
        </div>
        <p class="settings-permission-note">A human decision is saved as a separate audit event. It does not rewrite the automated result or change campaign/send eligibility.</p>
        <label>Decision<select name="decision" required><option value="confirm">Confirm the automated classification</option><option value="override">Override the classification</option></select></label>
        <label>Reviewed classification<select name="siteStatus" required>${statusOptions}</select></label>
        <label>Reason for this review<textarea name="reason" minlength="8" maxlength="500" rows="3" required placeholder="Describe the evidence that supports this decision."></textarea></label>`,
      onSubmit: async data => {
        const result = await Qualify.submitReview(lead.id, {
          decision: String(data.get('decision') || ''),
          siteStatus: String(data.get('siteStatus') || ''),
          reason: String(data.get('reason') || '').trim(),
        });
        notify(result.review.decision === 'override'
          ? `Human override recorded: ${result.review.originalSiteStatus} → ${result.review.effectiveSiteStatus}. Automated evidence and send eligibility are unchanged.`
          : 'Evidence review recorded; the automated classification remains active.', 'success');
        _reviewQueueOffset = 0;
        await loadBatchQualificationData();
        renderFullView(container);
      },
    });
  };

  window.__viewQualificationReviewHistory = async (leadId) => {
    try {
      const { reviews } = await Qualify.reviewHistory(leadId);
      const content = reviews.length ? `<ol class="qual-review-history">${reviews.map(review => {
        const when = String(review.reviewedAt || '');
        const timestamp = when ? new Date(`${when.replace(' ', 'T')}Z`).toLocaleString() : 'Time unavailable';
        return `<li><strong>${review.decision === 'override' ? `${escapeHtml(review.originalSiteStatus)} → ${escapeHtml(review.effectiveSiteStatus)}` : `Confirmed ${escapeHtml(review.originalSiteStatus)}`}</strong>
          <span>${escapeHtml(review.reason)}</span><small>${escapeHtml(review.reviewedByRole)} account #${Number(review.reviewedByUserId)} · ${escapeHtml(timestamp)}${review.evidenceMatchesCurrent ? ' · current audit' : ' · previous audit'}</small></li>`;
      }).join('')}</ol>` : '<p>No human review events have been recorded for this lead.</p>';
      openDialog({ title: 'Qualification review history', eyebrow: `LEAD #${Number(leadId)}`, body: content });
    } catch (error) { notify(error.message || 'Could not load review history.', 'error'); }
  };

  window.__toggleLeadRow = (leadId) => {
    _expandedLeadId = _expandedLeadId === leadId ? null : leadId;
    renderFullView(container);
  };

  window.__requalifyLead = async (leadId) => {
    try {
      const res = await Qualify.requalifyLead(leadId);
      if (!res) throw new Error('The audit did not return a result.');
      notify(`Lead #${leadId} audit complete · ${res.site_status} · score ${res.site_score ?? 'N/A'} · ${(res.site_reasons || []).join(', ') || 'No additional reasons recorded.'}`, 'success');
      await loadBatchQualificationData();
      renderFullView(container);
    } catch (error) { notify(error.message || 'Could not audit this lead.', 'error'); }
  };

  window.__replayLeadScoring = async (leadId) => {
    try {
      const replay = await Qualify.replayScoring(leadId);
      _scoringReplayByLeadId[leadId] = replay;
      renderFullView(container);
      notify(`Saved signals replayed with profile v${replay.profile.version}: ${replay.replayed.site_status}, ${replay.replayed.site_score}/100, confidence ${replay.replayed.confidence}%.`, 'success');
    } catch (error) { notify(error.message || 'Could not replay saved scoring evidence.', 'error'); }
  };

  window.__recheckStaleLeads = async () => {
    try {
      const res = await Qualify.recheckStale();
      notify(`Requeued ${res?.requeued || 0} stale lead(s) for a fresh audit.`, 'success');
      await loadBatchQualificationData();
      renderFullView(container);
    } catch (error) { notify(error.message || 'Could not recheck stale leads.', 'error'); }
  };

  window.__runBatchQualification = async () => {
    if (!_selectedBatchId) return;

    try {
      const res = await Qualify.startBatch(_selectedBatchId);
      if (res?.started) startLivePolling(container);
      else notify(res?.error || 'Could not start qualification; it may already be running.', 'error');
    } catch (error) { notify(error.message || 'Could not start qualification.', 'error'); }
  };

  window.__cancelBatchQualification = async () => {
    try {
      const result = await Qualify.cancel(_selectedBatchId);
      if (!result?.cancelling) return notify('There is no active qualification run to cancel.', 'info');
      notify('Cancellation requested. The in-progress site checks will finish safely before the run stops.', 'warning');
    } catch (error) { notify(error.message || 'Could not cancel qualification.', 'error'); }
  };

  // Check if qualification is already active
  checkLiveRunning(container);
}

function renderLeadRow(l) {
  const isExpanded = _expandedLeadId === l.id;
  const cfg = STATUS_CONFIG[l.site_status] || { label: l.site_status || 'Unchecked', color: 'var(--text-muted)', bg: 'transparent' };
  const conf = l.confidence;
  const confBadge = conf == null ? 'badge-warming' : conf >= 80 ? 'badge-deliverable' : conf >= 50 ? 'badge-warming' : 'badge-undeliverable';
  const scoring = leadScoringEvidence(l)?.scoring;
  const humanReview = l.human_review;
  const thresholds = scoring?.thresholds || { outdated_max: 40, modern_min: 70 };

  let scoreColor = 'var(--text-muted)';
  if (l.site_score != null) {
    scoreColor = l.site_score >= thresholds.modern_min ? 'var(--system-green)'
      : l.site_score < thresholds.outdated_max ? 'var(--system-red)' : 'var(--system-orange)';
  }

  let reasonsList = [];
  const savedReasons = leadScoringEvidence(l)?.reasons;
  if (Array.isArray(savedReasons)) {
    reasonsList = savedReasons;
  } else if (Array.isArray(l.site_reasons)) {
    reasonsList = l.site_reasons;
  } else if (typeof l.site_reasons === 'string') {
    try { reasonsList = JSON.parse(l.site_reasons); } catch { reasonsList = [l.site_reasons]; }
  }

  return `
  <tr class="lead-row ${isExpanded ? 'expanded' : ''}" onclick="window.__toggleLeadRow(${l.id})">
    <td class="td-name">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:0.7rem;color:var(--text-muted)">${isExpanded ? '▼' : '▶'}</span>
        <div>
          <div class="lead-biz-name">${l.business_name}</div>
          <div style="font-size:0.72rem;color:var(--system-cyan);font-family:var(--mono)">
            ${l.website_url ? `<a href="${l.website_url}" target="_blank" onclick="event.stopPropagation()">${l.website_url}</a>` : '<span style="color:var(--text-muted)">No Website</span>'}
          </div>
        </div>
      </div>
    </td>
    <td>${l.city || '—'}</td>
    <td>
      <span class="lead-status-badge" style="background:${cfg.bg};color:${cfg.color};border-color:${cfg.border}">
        ${cfg.label}
      </span>
      ${humanReview ? `<small class="qual-human-review-chip">Human ${humanReview.decision === 'override' ? `override · ${escapeHtml(humanReview.effectiveSiteStatus)}` : 'confirmed'}</small>` : ''}
    </td>
    <td>
      ${l.site_score != null ? `<span class="mono" style="font-weight:700;color:${scoreColor}">${l.site_score}/100</span><small class="qual-score-version">${scoring?.version ? `Profile v${Number(scoring.version)}` : 'Legacy profile'}</small>` : '<span style="color:var(--text-muted)">—</span>'}
    </td>
    <td>
      <span class="badge-status ${confBadge}">${conf == null ? '—' : `${conf}%`}</span>
    </td>
    <td>${renderSignalCell(l, 'ssl_valid', 'TLS signal')}</td>
    <td>${renderSignalCell(l, 'viewport_meta', 'Viewport signal')}</td>
    <td>
      ${renderFacebookCell(l)}
    </td>
    <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem;color:var(--text-secondary)">
      ${reasonsList.map(reason => escapeHtml(formatQualificationReason(reason))).join(', ') || '—'}
    </td>
    <td class="td-right" onclick="event.stopPropagation()">
      <button class="btn btn-ghost btn-xs" onclick="window.__requalifyLead(${l.id})">
        🔄 Re-Audit
      </button>
    </td>
  </tr>
  ${isExpanded ? renderLeadSignalDetail(l, reasonsList) : ''}`;
}

function leadScoringEvidence(lead) {
  if (lead?.site_evidence && typeof lead.site_evidence === 'object') return lead.site_evidence;
  try { return JSON.parse(lead?.site_reasons_json || 'null'); } catch { return null; }
}

function renderSignalCell(lead, key, label) {
  const value = leadScoringEvidence(lead)?.signals?.[key];
  const text = value === true ? 'Detected' : value === false ? 'Not detected' : 'Not observed';
  const marker = value === true ? '✓' : value === false ? '×' : '—';
  return `<span aria-label="${label}: ${text}" title="${label}: ${text}">${marker}</span>`;
}

function renderFacebookCell(lead) {
  if (!lead.facebook_url && lead.fb_active === null) return '—';
  if (lead.fb_active === 1) return '<span class="site-status-chip" style="color:var(--system-blue);border-color:rgba(10,132,255,0.3)" aria-label="Facebook page reachable">Reachable</span>';
  if (lead.fb_active === 0) return '<span class="site-status-chip" aria-label="Facebook page not reachable">Unavailable</span>';
  const reason = leadScoringEvidence(lead)?.signals?.facebook_check_reason;
  const detail = reason ? formatQualificationReason(reason) : 'Facebook page availability was not observed.';
  return `<span class="qual-source-unknown" title="${escapeHtml(detail)}" aria-label="Facebook page availability unknown">Unknown</span>`;
}

function renderLeadSignalDetail(l, reasons) {
  const evidence = leadScoringEvidence(l);
  const scoring = evidence?.scoring;
  const humanReview = l.human_review;
  const replay = _scoringReplayByLeadId[l.id];
  const reviewDetails = humanReview ? `<div class="qual-scoring-evidence qual-human-review-evidence">
    <strong>Human review · ${humanReview.decision === 'override' ? `${escapeHtml(humanReview.originalSiteStatus)} → ${escapeHtml(humanReview.effectiveSiteStatus)}` : `confirmed ${escapeHtml(humanReview.originalSiteStatus)}`}</strong>
    <span>${escapeHtml(humanReview.reason)} · ${escapeHtml(humanReview.reviewedByRole)} account #${Number(humanReview.reviewedByUserId)}</span>
    <span>Automated evidence remains unchanged; this review does not change sending eligibility.</span>
    <button class="btn btn-ghost btn-xs" type="button" onclick="event.stopPropagation();window.__viewQualificationReviewHistory(${Number(l.id)})">View review history</button>
  </div>` : `<div class="qual-scoring-evidence"><strong>Human review</strong><span>No decision is recorded for this exact audit.</span><button class="btn btn-ghost btn-xs" type="button" onclick="event.stopPropagation();window.__viewQualificationReviewHistory(${Number(l.id)})">View review history</button></div>`;
  const scoringDetails = scoring?.applicable ? `<div class="qual-scoring-evidence">
    <strong>Scoring evidence</strong><span>Profile v${Number(scoring.version)} · SHA-256 ${String(scoring.configHash || '').slice(0, 16)}</span>
    <span>Weighted points ${Number(scoring.rawScore)} / ${Number(scoring.maxScore)} · ${Array.isArray(scoring.unresolvedSignals) ? scoring.unresolvedSignals.length : 0} unresolved</span>
    <button class="btn btn-ghost btn-xs" type="button" onclick="event.stopPropagation();window.__replayLeadScoring(${Number(l.id)})">Replay saved signals with current profile</button>
    ${replay ? `<span class="qual-scoring-replay">Profile v${Number(replay.profile.version)} → ${replay.replayed.site_status}, ${Number(replay.replayed.site_score)}/100 · confidence ${Number(replay.replayed.confidence)}%</span>` : ''}
  </div>` : scoring ? `<div class="qual-scoring-evidence">
    <strong>Scoring not applied</strong><span>Profile v${Number(scoring.version)} was recorded, but source evidence was insufficient for a site score.</span>
    <span>Classification remains ${escapeHtml(l.site_status || 'unknown')} with confidence ${l.confidence == null ? 'unknown' : `${Number(l.confidence)}%`}.</span>
  </div>` : '<div class="qual-scoring-evidence"><strong>Scoring evidence</strong><span>No versioned score evidence is stored for this result.</span></div>';
  return `
  <tr>
    <td colspan="10" style="background:rgba(0,0,0,0.35);padding:18px 24px;border-bottom:1px solid var(--glass-border)">
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px">
        <div>
          ${reviewDetails}
          ${scoringDetails}
          ${renderScoringSignals(evidence?.signals)}

          <div style="font-size:0.75rem;color:var(--text-secondary);line-height:1.6">
            <strong>Audit Reasons:</strong>
            ${reasons.length > 0 ? reasons.map(r => `<span class="site-status-chip" style="margin-left:4px">${escapeHtml(formatQualificationReason(r))}</span>`).join('') : 'No issues found.'}
          </div>
        </div>

        <div style="border-left:1px solid var(--glass-border);padding-left:16px">
          <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">
            Contact & Source Info
          </div>
          <div style="font-size:0.78rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
            <div>Phone: <span class="mono">${l.phone || '—'}</span></div>
            <div>Email: <span class="mono" style="color:var(--system-cyan)">${l.email || '—'}</span></div>
            <div>Facebook page response: ${l.fb_active === 1 ? 'Reachable' : l.fb_active === 0 ? 'Not reachable' : `Unknown · ${escapeHtml(formatQualificationReason(evidence?.signals?.facebook_check_reason || 'facebook_check_unknown'))}`}</div>
            <div>Facebook: ${l.facebook_url ? `<a href="${l.facebook_url}" target="_blank" style="color:var(--system-blue)">View Page</a>` : '—'}</div>
            <div>Source: <span class="mono">${l.source || 'google_maps'}</span></div>
          </div>
        </div>
      </div>
    </td>
  </tr>`;
}

function renderScoringSignals(signals) {
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) {
    return '<div class="qual-scoring-evidence"><strong>Technical site signals</strong><span>No saved signal evidence is available.</span></div>';
  }
  const rows = Object.entries(SCORING_SIGNAL_LABELS).map(([key, label]) => {
    const value = signals[key];
    const text = value === true ? 'Detected' : value === false ? 'Not detected' : 'Not observed';
    const color = value === true ? 'var(--system-green)' : value === false ? 'var(--text-secondary)' : 'var(--text-muted)';
    return `<div class="qual-signal-row"><span>${label}</span><strong style="color:${color}">${text}</strong></div>`;
  }).join('');
  return `<section class="qual-signal-evidence" aria-label="Saved technical site signals"><h4>Technical site signals</h4><div>${rows}</div></section>`;
}

function startLivePolling(container) {
  const panel = document.getElementById('qual-progress-panel');
  const runBtn = document.getElementById('btn-run-qualify');
  const cancelBtn = document.getElementById('btn-cancel-qualify');

  if (panel) panel.style.display = 'block';
  if (runBtn) runBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  if (_pollTimer) clearInterval(_pollTimer);

  _pollTimer = setInterval(async () => {
    try {
      const status = await Qualify.status(_selectedBatchId);
      if (status) {
        _qualificationJob = status;
        updateProgressUI(status);
        if (!status.active) {
          stopLivePolling();
          await loadBatchQualificationData();
          renderFullView(container);
        }
      }
    } catch { /* preserve the last durable progress display through transient API failures */ }
  }, 1000);
}

function stopLivePolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;

  const panel = document.getElementById('qual-progress-panel');
  const runBtn = document.getElementById('btn-run-qualify');
  const cancelBtn = document.getElementById('btn-cancel-qualify');

  if (panel) panel.style.display = 'none';
  if (runBtn) runBtn.style.display = 'inline-flex';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function updateProgressUI(data) {
  const fill = document.getElementById('qual-progress-fill');
  const stats = document.getElementById('qual-progress-stats');
  const target = document.getElementById('qual-current-target');

  const pct = data.total > 0 ? Math.min(100, Math.round((data.processed / data.total) * 100)) : 0;
  if (fill) fill.style.width = `${pct}%`;
  if (stats) stats.textContent = `${data.processed} / ${data.total} (${pct}%)`;
  if (target) target.textContent = data.currentLead ? `Auditing: ${data.currentLead}` : data.errorMessage || `${Number(data.retryableCount) || 0} discovered lead(s) can be retried`;
}

async function checkLiveRunning(container) {
  const status = await Qualify.status(_selectedBatchId);
  if (status?.active && status.batchId === _selectedBatchId) {
    startLivePolling(container);
  }
}
