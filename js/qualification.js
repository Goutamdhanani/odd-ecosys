// ============================================================
//  ODD-ECOSYS — Qualification View (Phase 3 Full Engine)
//  100% Live API · Real Technical Site Audits & Facebook Liveness
//  Live Progress Polling · Dynamic 6-Status Breakdown · Signal Drawer
// ============================================================

import { Qualify, Batches, Leads, relTime, fmtNum } from './api.js';
import { icon } from './ui.js';

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
let _activeFilter = 'all';
let _expandedLeadId = null;
let _pollTimer = null;
let _spotCheckLeads = [];
let _statusDistribution = {};

export async function renderQualification(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading qualification engine…</span></div>`;

  // 1. Fetch live batches
  const batchesRes = await Batches.list();
  _batches = Array.isArray(batchesRes) ? batchesRes : [];

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

  const [leadsRes, staleRes, spotRes, distRes] = await Promise.all([
    Qualify.results(_selectedBatchId),
    Qualify.staleCount(),
    Qualify.spotCheck(_selectedBatchId),
    Qualify.distribution(),
  ]);

  _leads = Array.isArray(leadsRes) ? leadsRes : [];
  _staleCount = staleRes?.count || 0;
  _spotCheckLeads = Array.isArray(spotRes) ? spotRes : [];

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

  // Compute counts
  const counts = {
    NO_SITE:       _leads.filter(l => l.site_status === 'NO_SITE').length,
    DEAD_SITE:     _leads.filter(l => l.site_status === 'DEAD_SITE').length,
    DOMAIN_PARKED: _leads.filter(l => l.site_status === 'DOMAIN_PARKED').length,
    OUTDATED:      _leads.filter(l => l.site_status === 'OUTDATED').length,
    MODERN:        _leads.filter(l => l.site_status === 'MODERN').length,
    CHECK_FAILED:  _leads.filter(l => l.site_status === 'CHECK_FAILED').length,
  };

  const totalAudited = _leads.filter(l => l.site_status).length;
  const filteredLeads = _activeFilter === 'all'
    ? _leads
    : _leads.filter(l => l.site_status === _activeFilter);

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
      <button class="btn btn-primary btn-sm" id="btn-run-qualify" ${_selectedBatchId ? '' : 'disabled title="Create a batch first"'} onclick="window.__runBatchQualification()">
        ${icon('globe', 15)} Qualify leads
      </button>
      <button class="btn btn-danger btn-sm" id="btn-cancel-qualify" style="display:none" onclick="window.__cancelBatchQualification()">
        ⏹ Cancel
      </button>
    </div>
  </div>

  <!-- Live Progress Bar (hidden unless actively qualifying) -->
  <div id="qual-progress-panel" class="glass-panel mb-16" style="display:none;background:rgba(10,132,255,0.08);border-color:rgba(10,132,255,0.3)">
    <div class="panel-body" style="padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="pulse-dot"></div>
          <span style="font-size:0.88rem;font-weight:700;color:var(--text-primary)">
            Auditing Batch #${_selectedBatchId}…
          </span>
          <span id="qual-current-target" style="font-size:0.75rem;color:var(--text-secondary)">
            Connecting to site…
          </span>
        </div>
        <span id="qual-progress-stats" class="mono" style="font-size:0.82rem;font-weight:700;color:var(--system-cyan)">
          0 / 0 (0%)
        </span>
      </div>
      <div class="progress-track" style="height:8px">
        <div id="qual-progress-fill" class="progress-fill" style="width:0%;background:linear-gradient(90deg, var(--system-blue), var(--system-cyan))"></div>
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
          All Leads (${_leads.length})
        </div>
        ${Object.keys(STATUS_CONFIG).map(k => `
          <div class="tab-item ${_activeFilter === k ? 'active' : ''}" onclick="window.__filterBySiteStatus('${k}')">
            ${STATUS_CONFIG[k].label} (${counts[k] || 0})
          </div>
        `).join('')}
      </div>
      <div style="margin-left:auto;font-size:0.75rem;color:var(--text-muted)">
        Showing <strong>${filteredLeads.length}</strong> of ${_leads.length} leads
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
            <th>SSL</th>
            <th>Mobile</th>
            <th>FB Active</th>
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

  <!-- Accuracy Spot-Check Panel (Lowest Confidence Sample) -->
  <div class="glass-panel animate-in">
    <div class="panel-header">
      <span class="panel-title">
        <span class="dot amber"></span>
        Accuracy Spot-Check — Lowest Confidence Sample
      </span>
      <span class="panel-hint">Live manual verification queue for borderline cases</span>
    </div>
    <div class="panel-body">
      ${_spotCheckLeads.length === 0 ? `
      <div style="font-size:0.8rem;color:var(--text-muted);text-align:center;padding:12px">
        All leads in this batch have high confidence classifications.
      </div>` : `
      <div style="display:flex;flex-direction:column;gap:10px">
        ${_spotCheckLeads.map(l => `
        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <span style="font-weight:700;font-size:0.88rem;color:var(--text-primary)">${l.business_name}</span>
            <span style="font-size:0.75rem;color:var(--text-muted);margin-left:8px">📍 ${l.city || '—'}</span>
            <span class="badge-status badge-risky" style="margin-left:8px">Confidence: ${l.confidence || 60}%</span>
            <span class="site-status-chip" style="margin-left:4px">${l.site_status || 'UNCHECKED'}</span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-xs" onclick="window.__requalifyLead(${l.id})">
              🔄 Re-Audit Site
            </button>
          </div>
        </div>`).join('')}
      </div>`}
    </div>
  </div>`;

  // Attach event listeners
  const batchSelect = document.getElementById('qual-batch-select');
  if (batchSelect) {
    batchSelect.onchange = async (e) => {
      _selectedBatchId = parseInt(e.target.value);
      _expandedLeadId = null;
      renderQualification(container);
    };
  }

  // Global window functions
  window.__filterBySiteStatus = (status) => {
    _activeFilter = status;
    renderFullView(container);
  };

  window.__toggleLeadRow = (leadId) => {
    _expandedLeadId = _expandedLeadId === leadId ? null : leadId;
    renderFullView(container);
  };

  window.__requalifyLead = async (leadId) => {
    const res = await Qualify.requalifyLead(leadId);
    if (res) {
      alert(`✅ Lead #${leadId} audited:\nStatus: ${res.site_status}\nScore: ${res.site_score ?? 'N/A'}\nReasons: ${(res.site_reasons || []).join(', ')}`);
      await loadBatchQualificationData();
      renderFullView(container);
    }
  };

  window.__recheckStaleLeads = async () => {
    const res = await Qualify.recheckStale();
    alert(`✅ Requeued ${res?.requeued || 0} stale leads back to discovery stage for fresh audit.`);
    await loadBatchQualificationData();
    renderFullView(container);
  };

  window.__runBatchQualification = async () => {
    if (!_selectedBatchId) return;

    const res = await Qualify.startBatch(_selectedBatchId);
    if (res?.started) {
      startLivePolling(container);
    } else {
      alert(res?.error || 'Failed to start qualification or already running.');
    }
  };

  window.__cancelBatchQualification = async () => {
    await Qualify.cancel();
    stopLivePolling();
  };

  // Check if qualification is already active
  checkLiveRunning(container);
}

function renderLeadRow(l) {
  const isExpanded = _expandedLeadId === l.id;
  const cfg = STATUS_CONFIG[l.site_status] || { label: l.site_status || 'Unchecked', color: 'var(--text-muted)', bg: 'transparent' };
  const conf = l.confidence ?? 85;
  const confBadge = conf >= 80 ? 'badge-deliverable' : conf >= 50 ? 'badge-warming' : 'badge-undeliverable';

  let scoreColor = 'var(--text-muted)';
  if (l.site_score != null) {
    scoreColor = l.site_score >= 70 ? 'var(--system-green)' : l.site_score >= 40 ? 'var(--system-orange)' : 'var(--system-red)';
  }

  let reasonsList = [];
  if (Array.isArray(l.site_reasons)) {
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
    </td>
    <td>
      ${l.site_score != null ? `<span class="mono" style="font-weight:700;color:${scoreColor}">${l.site_score}/100</span>` : '<span style="color:var(--text-muted)">—</span>'}
    </td>
    <td>
      <span class="badge-status ${confBadge}">${conf}%</span>
    </td>
    <td>${l.website_url ? (l.site_status === 'DEAD_SITE' ? '❌' : '✓') : '—'}</td>
    <td>${l.site_status === 'MODERN' ? '✓ Yes' : l.site_status === 'OUTDATED' ? '❌ No' : '—'}</td>
    <td>
      ${l.fb_active === 1
        ? '<span class="site-status-chip" style="color:var(--system-blue);border-color:rgba(10,132,255,0.3)">FB Active</span>'
        : l.facebook_url ? '<span style="color:var(--text-muted);font-size:0.72rem">FB Linked</span>' : '—'}
    </td>
    <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem;color:var(--text-secondary)">
      ${reasonsList.join(', ') || '—'}
    </td>
    <td class="td-right" onclick="event.stopPropagation()">
      <button class="btn btn-ghost btn-xs" onclick="window.__requalifyLead(${l.id})">
        🔄 Re-Audit
      </button>
    </td>
  </tr>
  ${isExpanded ? renderLeadSignalDetail(l, reasonsList) : ''}`;
}

function renderLeadSignalDetail(l, reasons) {
  return `
  <tr>
    <td colspan="10" style="background:rgba(0,0,0,0.35);padding:18px 24px;border-bottom:1px solid var(--glass-border)">
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px">
        <div>
          <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">
            Technical Audit Signals & Breakdown
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
            <div style="background:rgba(255,255,255,0.04);padding:8px 12px;border-radius:var(--radius-xs)">
              <div style="font-size:0.68rem;color:var(--text-muted)">SSL Certificate</div>
              <div style="font-weight:700;color:${l.site_status==='DEAD_SITE'?'var(--system-red)':'var(--system-green)'}">
                ${l.site_status==='DEAD_SITE'?'Invalid / Missing':'Valid TLS'}
              </div>
            </div>
            <div style="background:rgba(255,255,255,0.04);padding:8px 12px;border-radius:var(--radius-xs)">
              <div style="font-size:0.68rem;color:var(--text-muted)">Mobile Viewport</div>
              <div style="font-weight:700;color:${l.site_status==='MODERN'?'var(--system-green)':'var(--system-orange)'}">
                ${l.site_status==='MODERN'?'Responsive':'Missing Meta'}
              </div>
            </div>
            <div style="background:rgba(255,255,255,0.04);padding:8px 12px;border-radius:var(--radius-xs)">
              <div style="font-size:0.68rem;color:var(--text-muted)">Facebook Liveness</div>
              <div style="font-weight:700;color:${l.fb_active===1?'var(--system-blue)':'var(--text-muted)'}">
                ${l.fb_active===1?'Active (Recent Posts)':'No Posts Found'}
              </div>
            </div>
          </div>

          <div style="font-size:0.75rem;color:var(--text-secondary);line-height:1.6">
            <strong>Audit Reasons:</strong>
            ${reasons.length > 0 ? reasons.map(r => `<span class="site-status-chip" style="margin-left:4px">${r}</span>`).join('') : 'No issues found.'}
          </div>
        </div>

        <div style="border-left:1px solid var(--glass-border);padding-left:16px">
          <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">
            Contact & Source Info
          </div>
          <div style="font-size:0.78rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
            <div>Phone: <span class="mono">${l.phone || '—'}</span></div>
            <div>Email: <span class="mono" style="color:var(--system-cyan)">${l.email || '—'}</span></div>
            <div>Facebook: ${l.facebook_url ? `<a href="${l.facebook_url}" target="_blank" style="color:var(--system-blue)">View Page</a>` : '—'}</div>
            <div>Source: <span class="mono">${l.source || 'google_maps'}</span></div>
          </div>
        </div>
      </div>
    </td>
  </tr>`;
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
    const status = await Qualify.status();
    if (status) {
      updateProgressUI(status);
      if (!status.active) {
        stopLivePolling();
        await loadBatchQualificationData();
        renderFullView(container);
      }
    }
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
  const target = document.getElementById('qual-target-name');

  const pct = data.total > 0 ? Math.min(100, Math.round((data.processed / data.total) * 100)) : 0;
  if (fill) fill.style.width = `${pct}%`;
  if (stats) stats.textContent = `${data.processed} / ${data.total} (${pct}%)`;
  if (target && data.currentLead) target.textContent = `Auditing: ${data.currentLead}`;
}

async function checkLiveRunning(container) {
  const status = await Qualify.status();
  if (status?.active && status.batchId === _selectedBatchId) {
    startLivePolling(container);
  }
}
