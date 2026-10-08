// ============================================================
//  Leads View — 100% live API
// ============================================================
import { Leads, Qualify, relTime, fmtNum } from './api.js';

const STATUS_COLOR = {
  discovered: '#6366f1', enriching: '#818cf8', site_checked: '#38bdf8',
  verifying: '#f59e0b', personalizing: '#a78bfa', awaiting_approval: '#f59e0b',
  queued: '#10b981', sent: '#64748b', replied: '#10b981', won: '#f43f5e',
  disqualified: '#475569', lost: '#475569',
};
const STATUS_ICON = {
  discovered: '◈', enriching: '⟳', site_checked: '◎',
  verifying: '✉', personalizing: '✍', awaiting_approval: '⏳',
  queued: '→', sent: '✓', replied: '↩', won: '★',
  disqualified: '✗', lost: '✗',
};
const SITE_STATUS_BADGE = {
  NO_SITE:      { label: 'No Site',     color: '#f43f5e' },
  DEAD_SITE:    { label: 'Dead',        color: '#f59e0b' },
  OUTDATED:     { label: 'Outdated',    color: '#f59e0b' },
  MODERN:       { label: 'Modern',      color: '#10b981' },
  DOMAIN_PARKED:{ label: 'Parked',      color: '#94a3b8' },
  CHECK_FAILED: { label: 'Failed',      color: '#ef4444' },
};

let _filters = { status: '', batch_id: '', search: '' };
let _page = 0;
const PAGE_SIZE = 50;
let _batches = [];

export async function renderLeads(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading leads…</span></div>`;

  // Load batches for filter dropdown
  try {
    const r = await fetch('/api/batches');
    _batches = await r.json();
  } catch { _batches = []; }

  await _renderLeadsView(container);
}

async function _renderLeadsView(container) {
  const params = { limit: PAGE_SIZE, offset: _page * PAGE_SIZE };
  if (_filters.status)   params.status   = _filters.status;
  if (_filters.batch_id) params.batch_id = _filters.batch_id;
  if (_filters.search)   params.search   = _filters.search;

  const data = await Leads.list(params);
  const leads = data?.leads || [];
  const total = data?.pagination?.total || 0;
  const pages = Math.ceil(total / PAGE_SIZE);

  container.innerHTML = `
  <!-- Header -->
  <div class="section-header mb-16">
    <div>
      <h1 class="section-title">Lead Pipeline</h1>
      <div class="section-sub">${fmtNum(total)} total leads across ${_batches.length} batches</div>
    </div>
  </div>

  <!-- Filters -->
  <div class="filter-bar mb-16">
    <input
      id="lead-search"
      class="filter-input"
      placeholder="Search business, city, email…"
      value="${_filters.search}"
      oninput="window.__leadSearch(this.value)"
    />
    <select id="lead-status-filter" class="filter-select" onchange="window.__leadFilter('status', this.value)">
      <option value="">All statuses</option>
      ${['discovered','site_checked','verified','awaiting_approval','queued','sent','replied','won','disqualified'].map(s =>
        `<option value="${s}" ${_filters.status === s ? 'selected' : ''}>${s.replace('_',' ')}</option>`
      ).join('')}
    </select>
    <select id="lead-batch-filter" class="filter-select" onchange="window.__leadFilter('batch_id', this.value)">
      <option value="">All batches</option>
      ${_batches.map(b => `<option value="${b.id}" ${_filters.batch_id == b.id ? 'selected' : ''}>${b.name || b.label || 'Batch #'+b.id}</option>`).join('')}
    </select>
    <button class="btn btn-ghost btn-sm" onclick="window.__leadReset()">Reset</button>
  </div>

  <!-- Table -->
  <div class="glass-panel">
    <div class="leads-table-wrap">
      <table class="leads-table">
        <thead>
          <tr>
            <th>Business</th>
            <th>Category</th>
            <th>City</th>
            <th>Site Status</th>
            <th>Email</th>
            <th>Stage</th>
            <th>Discovered</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${leads.length === 0 ? `
          <tr><td colspan="8" class="empty-row">
            <div class="empty-state" style="padding:32px">
              <div class="empty-icon">◈</div>
              <p>No leads match your filters</p>
              <p class="empty-hint">Try adjusting the search or status filter</p>
            </div>
          </td></tr>` : leads.map(l => {
            const stColor = STATUS_COLOR[l.status] || '#64748b';
            const stIcon  = STATUS_ICON[l.status]  || '•';
            const site    = SITE_STATUS_BADGE[l.site_status];
            return `
            <tr class="lead-row" onclick="window.__leadDetail(${l.id})">
              <td>
                <div class="lead-biz-name">${l.business_name}</div>
                ${l.rating ? `<div class="lead-rating">★ ${l.rating} (${l.reviews || 0})</div>` : ''}
              </td>
              <td><span class="lead-cat">${l.category || '—'}</span></td>
              <td><span class="lead-city">${l.city || '—'}</span></td>
              <td>
                ${site ? `<span class="site-status-chip" style="color:${site.color};border-color:${site.color}44">${site.label}</span>` : '<span style="color:var(--text-muted)">—</span>'}
              </td>
              <td>
                <span class="lead-email">${l.email || '—'}</span>
              </td>
              <td>
                <span class="lead-status-badge" style="color:${stColor};border-color:${stColor}44">
                  ${stIcon} ${l.status?.replace(/_/g,' ')}
                </span>
              </td>
              <td class="lead-time">${relTime(l.discovered_at)}</td>
              <td onclick="event.stopPropagation()">
                <div style="display:flex;gap:6px">
                  ${l.status === 'site_checked' || l.status === 'discovered' ? `
                  <button class="btn-xs" onclick="window.__requalify(${l.id})" title="Re-qualify">◎</button>` : ''}
                  <button class="btn-xs" onclick="window.__leadDetail(${l.id})" title="View detail">→</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    ${total > PAGE_SIZE ? `
    <div class="pagination">
      <button class="btn btn-ghost btn-sm" onclick="window.__leadPage(${_page - 1})" ${_page === 0 ? 'disabled' : ''}>← Prev</button>
      <span style="font-size:0.78rem;color:var(--text-muted)">Page ${_page + 1} of ${pages} · ${fmtNum(total)} total</span>
      <button class="btn btn-ghost btn-sm" onclick="window.__leadPage(${_page + 1})" ${_page >= pages - 1 ? 'disabled' : ''}>Next →</button>
    </div>` : ''}
  </div>

  <!-- Lead Detail Drawer -->
  <div id="lead-detail-drawer" class="detail-drawer" style="display:none">
    <div class="detail-drawer-inner">
      <div class="detail-drawer-header">
        <span id="drawer-title" class="detail-drawer-title">Lead Detail</span>
        <button onclick="document.getElementById('lead-detail-drawer').style.display='none'" class="drawer-close">✕</button>
      </div>
      <div id="drawer-body" class="detail-drawer-body">Loading…</div>
    </div>
  </div>`;

  // Wire interactions
  let searchTimer;
  window.__leadSearch = (val) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      _filters.search = val;
      _page = 0;
      _renderLeadsView(container);
    }, 350);
  };
  window.__leadFilter = (key, val) => {
    _filters[key] = val;
    _page = 0;
    _renderLeadsView(container);
  };
  window.__leadReset = () => {
    _filters = { status: '', batch_id: '', search: '' };
    _page = 0;
    _renderLeadsView(container);
  };
  window.__leadPage = (p) => { _page = Math.max(0, p); _renderLeadsView(container); };
  window.__leadDetail = async (id) => {
    const drawer = document.getElementById('lead-detail-drawer');
    const body   = document.getElementById('drawer-body');
    const title  = document.getElementById('drawer-title');
    drawer.style.display = 'flex';
    body.innerHTML = '<div class="loading-state" style="padding:24px"><div class="spinner"></div></div>';
    const lead = await Leads.get(id);
    if (!lead) { body.innerHTML = '<p style="padding:24px;color:var(--rose)">Lead not found</p>'; return; }
    title.textContent = lead.business_name;
    body.innerHTML = renderLeadDetail(lead);
  };
  window.__requalify = async (id) => {
    await Qualify.requalifyLead(id);
    _renderLeadsView(container);
  };
}

function renderLeadDetail(lead) {
  const site = SITE_STATUS_BADGE[lead.site_status];
  return `
  <div class="detail-section">
    <div class="detail-grid-2">
      <div><label>Category</label><div>${lead.category || '—'}</div></div>
      <div><label>City</label><div>${lead.city || '—'} ${lead.country || ''}</div></div>
      <div><label>Phone</label><div>${lead.phone || '—'}</div></div>
      <div><label>Rating</label><div>${lead.rating ? `★ ${lead.rating} (${lead.reviews} reviews)` : '—'}</div></div>
    </div>
  </div>

  ${lead.website_url ? `
  <div class="detail-section">
    <div class="detail-label">Website</div>
    <a href="${lead.website_url}" target="_blank" class="detail-link">${lead.website_url}</a>
    ${site ? `<span class="site-status-chip ml-8" style="color:${site.color};border-color:${site.color}44">${site.label}</span>` : ''}
    ${lead.site_score ? `<span style="font-size:0.72rem;color:var(--text-muted);margin-left:8px">Score: ${lead.site_score}/10</span>` : ''}
  </div>` : ''}

  ${lead.emails?.length ? `
  <div class="detail-section">
    <div class="detail-label">Email Addresses</div>
    ${lead.emails.map(e => `
    <div class="detail-email-row">
      <span class="detail-email">${e.email}</span>
      <span class="badge-tiny" style="color:${e.verification_status === 'deliverable' ? 'var(--emerald)' : 'var(--amber)'}">
        ${e.verification_status || 'unverified'}
      </span>
    </div>`).join('')}
  </div>` : ''}

  ${lead.events?.length ? `
  <div class="detail-section">
    <div class="detail-label">Event History</div>
    <div class="detail-events">
      ${lead.events.map(e => `
      <div class="detail-event-row">
        <span class="detail-event-type">${e.event_type}</span>
        <span class="detail-event-time">${relTime(e.event_at)}</span>
      </div>`).join('')}
    </div>
  </div>` : ''}`;
}
