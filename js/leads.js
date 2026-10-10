// ============================================================
//  Leads View — 100% live API
// ============================================================
import { Leads, Qualify, Scraper, relTime, fmtNum } from './api.js';
import { openDialog, notify, icon, escapeHtml } from './ui.js';

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
  <div class="section-header mb-16" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <div>
      <h1 class="section-title">Lead Pipeline</h1>
      <div class="section-sub">${fmtNum(total)} total leads across ${_batches.length} batches</div>
    </div>
    <div style="display:flex; gap:10px; align-items:center;">
      <button class="btn btn-primary" id="btn-1click-scraper" style="display:inline-flex; align-items:center; gap:8px; font-weight:600; padding:10px 18px; border-radius:10px; background:linear-gradient(135deg, #0A84FF, #5E5CE6); box-shadow:0 4px 16px rgba(10,132,255,0.35);">
        ${icon('sparkle', 16)} 1-Click Lead Scraper
      </button>
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
                <div style="display:flex; align-items:center; gap:5px; margin-top:4px; flex-wrap:wrap;">
                  ${l.price_level ? `
                    <span class="badge-tiny" style="color:#30D158; border-color:rgba(48,209,88,0.3); background:rgba(48,209,88,0.08); font-weight:700; padding:1px 5px; font-size:0.68rem;">
                      ${l.price_level}
                    </span>` : ''}
                  ${l.rating ? `
                    <a href="${l.place_id ? `https://www.google.com/maps/place/?q=place_id:${l.place_id}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.business_name + ' ' + (l.city || ''))}`}" target="_blank" onclick="event.stopPropagation()" class="lead-rating" style="text-decoration:none; display:inline-flex; align-items:center; gap:3px;" title="View Google Maps profile">
                      ★ ${l.rating} <span style="font-size:0.7rem; color:var(--text-muted);">(${l.reviews || 0})</span>
                    </a>` : ''}
                  ${l.website_url ? `
                    <a href="${l.website_url}" target="_blank" onclick="event.stopPropagation()" class="badge-tiny" style="color:var(--system-blue); border-color:rgba(10,132,255,0.3); text-decoration:none; padding:1px 6px; border-radius:4px; font-size:0.68rem; background:rgba(10,132,255,0.08);" title="${l.website_url}">
                      🌐 Web
                    </a>` : ''}
                  ${l.booking_url ? `
                    <a href="${l.booking_url}" target="_blank" onclick="event.stopPropagation()" class="badge-tiny" style="color:var(--system-purple); border-color:rgba(175,82,222,0.35); text-decoration:none; padding:1px 6px; border-radius:4px; font-size:0.68rem; background:rgba(175,82,222,0.08);" title="Online Booking: ${l.booking_url}">
                      📅 Book
                    </a>` : ''}
                  ${l.facebook_url ? `
                    <a href="${l.facebook_url}" target="_blank" onclick="event.stopPropagation()" class="badge-tiny" style="color:#1877F2; border-color:rgba(24,119,242,0.35); text-decoration:none; padding:1px 6px; border-radius:4px; font-size:0.68rem; background:rgba(24,119,242,0.1); display:inline-flex; align-items:center; gap:3px;" title="${l.facebook_url}">
                      <span style="font-weight:700;">ⓕ</span> FB${l.fb_active === 1 ? ' <span style="color:var(--system-green); font-size:0.6rem;">●</span>' : ''}
                    </a>` : ''}
                  ${l.instagram_url ? `
                    <a href="${l.instagram_url}" target="_blank" onclick="event.stopPropagation()" class="badge-tiny" style="color:#E1306C; border-color:rgba(225,48,108,0.35); text-decoration:none; padding:1px 5px; border-radius:4px; font-size:0.68rem; background:rgba(225,48,108,0.08);" title="Instagram: ${l.instagram_url}">
                      📸 IG
                    </a>` : ''}
                  ${l.linkedin_url ? `
                    <a href="${l.linkedin_url}" target="_blank" onclick="event.stopPropagation()" class="badge-tiny" style="color:#0A66C2; border-color:rgba(10,102,194,0.35); text-decoration:none; padding:1px 5px; border-radius:4px; font-size:0.68rem; background:rgba(10,102,194,0.08);" title="LinkedIn: ${l.linkedin_url}">
                      in LI
                    </a>` : ''}
                  ${l.phone ? `
                    <a href="tel:${l.phone}" onclick="event.stopPropagation()" class="badge-tiny" style="color:var(--text-muted); border-color:rgba(255,255,255,0.1); text-decoration:none; padding:1px 5px; border-radius:4px; font-size:0.68rem;" title="Call ${l.phone}">
                      📞 ${l.phone}
                    </a>` : ''}
                </div>
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

  const scraperBtn = container.querySelector('#btn-1click-scraper');
  if (scraperBtn) {
    scraperBtn.addEventListener('click', () => openScraperModal(container));
  }
}

function openScraperModal(container) {
  let pollInterval = null;

  const modalBody = `
    <div class="scraper-form-wrap" style="padding-top:4px;">
      <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:18px; line-height:1.5;">
        Scrapes B2B listings directly from Google Maps, deep-crawls websites, decodes Cloudflare & JSON-LD schema, validates DNS MX records, and automatically deposits contacts into your pipeline.
      </div>

      <div class="form-group mb-12">
        <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Business Niche / Category</label>
        <input id="scrape-niche" class="filter-input" style="width:100%" placeholder="e.g. Dentists, Roofing Contractors, Plumbers" value="Dentists" />
        <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-niche').value='Dentists'">Dentists</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-niche').value='Roofers'">Roofers</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-niche').value='Plumbers'">Plumbers</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-niche').value='HVAC Services'">HVAC</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-niche').value='Marketing Agencies'">Agencies</button>
        </div>
      </div>

      <div class="form-group mb-12">
        <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Target Location</label>
        <input id="scrape-geo" class="filter-input" style="width:100%" placeholder="e.g. Austin TX, Miami FL, Dallas TX" value="Austin TX" />
        <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-geo').value='Austin TX'">Austin TX</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-geo').value='Dallas TX'">Dallas TX</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-geo').value='Miami FL'">Miami FL</button>
          <button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById('scrape-geo').value='Chicago IL'">Chicago IL</button>
        </div>
      </div>

      <div class="form-group mb-12">
        <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Scraping Method</label>
        <select id="scrape-method" class="filter-select" style="width:100%">
          <option value="combined" selected>🚀 Combined Multi-Engine (Google Maps + Facebook + Web — Maximum Leads)</option>
          <option value="google_maps">📍 Google Maps Multi-Query Native Engine (High-Precision Local B2B)</option>
          <option value="facebook">ⓕ Facebook Business Engine (Active FB Pages, High-Converting No-Website Leads)</option>
          <option value="web_search">🔍 Web Search Query Scraper (Direct B2B Listings)</option>
        </select>
      </div>

      <div class="form-group mb-16">
        <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">Target Lead Count</label>
        <select id="scrape-limit" class="filter-select" style="width:100%">
          <option value="15">15 Leads (Quick sprint)</option>
          <option value="25" selected>25 Leads (Standard cohort)</option>
          <option value="50">50 Leads (Deep multi-scrape)</option>
          <option value="100">100 Leads (Mass market campaign)</option>
        </select>
      </div>

      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:16px;">
        <div style="font-size:0.85rem; font-weight:700; margin-bottom:8px; color:var(--text-primary); display:flex; align-items:center; gap:6px;">
          <span>🌐 Deep City Scan & Filtering</span>
        </div>
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; margin-bottom:10px;">
          <input type="checkbox" id="scrape-deep-scan" checked style="accent-color:var(--system-purple); width:16px; height:16px; margin-top:2px;">
          <div>
            <span style="font-size:0.83rem; font-weight:600;">Deep City Grid Scan (Multi-Quadrant Neighborhoods)</span>
            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">Tiles geographic queries across Downtown and cardinal suburbs (North, South, East, West) for 3-5x more unique local leads</div>
          </div>
        </label>
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
          <input type="checkbox" id="scrape-filter-closed" checked style="accent-color:var(--system-blue); width:16px; height:16px; margin-top:2px;">
          <div>
            <span style="font-size:0.83rem; font-weight:600;">Filter Permanently Closed Businesses</span>
            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">Filters out inactive or closed places so your cohort only contains active prospects</div>
          </div>
        </label>
      </div>

      <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:12px; margin-bottom:16px;">
        <div style="font-size:0.85rem; font-weight:700; margin-bottom:8px; color:var(--text-primary); display:flex; align-items:center; gap:6px;">
          <span>⚡ Send to Next Pipeline Steps Automatically</span>
        </div>
        <label style="display:flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:8px;">
          <input type="checkbox" id="scrape-auto-qualify" checked style="accent-color:var(--system-blue); width:16px; height:16px;">
          <span style="font-size:0.83rem; font-weight:600;">Auto-Qualify Leads (Site Health, Tech Stack & ICP Score)</span>
        </label>
        <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
          <input type="checkbox" id="scrape-auto-verify" checked style="accent-color:var(--system-green); width:16px; height:16px;">
          <span style="font-size:0.83rem; font-weight:600;">Auto-Verify Emails (DNS, MX, SMTP & Deliverability Check)</span>
        </label>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:6px;">
          Discovered contacts will be qualified and emails verified on-the-fly, ready immediately for AI personalization and outreach.
        </div>
      </div>

      <div id="scrape-progress-box" style="display:none; margin-top:16px; background:rgba(10,132,255,0.06); border:1px solid rgba(10,132,255,0.2); border-radius:12px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span id="scrape-step-label" style="font-size:0.88rem; font-weight:600; color:var(--system-cyan);">Initializing scraper…</span>
          <span id="scrape-percent-label" style="font-size:0.82rem; font-family:monospace; color:var(--text-muted);">0%</span>
        </div>
        <div style="width:100%; height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; margin-bottom:12px;">
          <div id="scrape-progress-bar" style="width:0%; height:100%; background:linear-gradient(90deg, #0A84FF, #30D158); transition:width 0.4s ease;"></div>
        </div>
        <div id="scrape-stats-grid" style="display:grid; grid-template-columns:repeat(5, 1fr); gap:6px; font-size:0.75rem; text-align:center;">
          <div style="background:rgba(0,0,0,0.3); padding:8px 2px; border-radius:6px;">
            <div style="color:var(--text-muted); font-size:0.7rem;">Scraped</div>
            <div id="stat-scraped-count" style="font-weight:700; font-size:0.95rem; margin-top:2px;">0</div>
          </div>
          <div style="background:rgba(0,0,0,0.3); padding:8px 2px; border-radius:6px;">
            <div style="color:var(--text-muted); font-size:0.7rem;">Emails</div>
            <div id="stat-emails-count" style="font-weight:700; font-size:0.95rem; color:var(--system-cyan); margin-top:2px;">0</div>
          </div>
          <div style="background:rgba(0,0,0,0.3); padding:8px 2px; border-radius:6px;">
            <div style="color:var(--text-muted); font-size:0.7rem;">Saved</div>
            <div id="stat-inserted-count" style="font-weight:700; font-size:0.95rem; color:var(--system-blue); margin-top:2px;">0</div>
          </div>
          <div style="background:rgba(0,0,0,0.3); padding:8px 2px; border-radius:6px;">
            <div style="color:var(--text-muted); font-size:0.7rem;">Qualified</div>
            <div id="stat-qualified-count" style="font-weight:700; font-size:0.95rem; color:var(--system-yellow); margin-top:2px;">0</div>
          </div>
          <div style="background:rgba(0,0,0,0.3); padding:8px 2px; border-radius:6px;">
            <div style="color:var(--text-muted); font-size:0.7rem;">Deliverable</div>
            <div id="stat-deliverable-count" style="font-weight:700; font-size:0.95rem; color:var(--system-green); margin-top:2px;">0</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const dialog = openDialog({
    title: '⚡ 1-Click Multi-Engine Lead Scraper',
    eyebrow: 'B2B LEAD DISCOVERY & OUTREACH PIPELINE',
    body: modalBody,
    submitLabel: 'Start Scrape & Pipeline',
  });

  const form = dialog.querySelector('form');
  const submitBtn = dialog.querySelector('[type="submit"]');

  form.onsubmit = async (e) => {
    e.preventDefault();
    const niche = dialog.querySelector('#scrape-niche').value.trim();
    const geography = dialog.querySelector('#scrape-geo').value.trim();
    const limit = parseInt(dialog.querySelector('#scrape-limit').value, 10) || 25;
    const method = dialog.querySelector('#scrape-method').value || 'combined';
    const autoQualify = dialog.querySelector('#scrape-auto-qualify').checked;
    const autoVerify = dialog.querySelector('#scrape-auto-verify').checked;
    const deepScan = dialog.querySelector('#scrape-deep-scan')?.checked !== false;
    const filterClosed = dialog.querySelector('#scrape-filter-closed')?.checked !== false;

    if (!niche || !geography) {
      notify('Please enter both a niche and a location.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `${icon('refresh', 16)} Scraping & Ingesting…`;
    const progressBox = dialog.querySelector('#scrape-progress-box');
    if (progressBox) progressBox.style.display = 'block';

    try {
      await Scraper.start({
        niche,
        geography,
        limit,
        method,
        autoQualify,
        autoVerify,
        deepScan,
        filterClosed,
      });

      pollInterval = setInterval(async () => {
        try {
          const status = await Scraper.status();
          const stepLabel = dialog.querySelector('#scrape-step-label');
          const percentLabel = dialog.querySelector('#scrape-percent-label');
          const progressBar = dialog.querySelector('#scrape-progress-bar');
          const statScraped = dialog.querySelector('#stat-scraped-count');
          const statEmails = dialog.querySelector('#stat-emails-count');
          const statInserted = dialog.querySelector('#stat-inserted-count');
          const statQualified = dialog.querySelector('#stat-qualified-count');
          const statDeliverable = dialog.querySelector('#stat-deliverable-count');

          if (stepLabel) {
            const stepNames = {
              scraping: '🔍 Scraping B2B Leads (Google Maps & Search)…',
              enriching: '✉️ Crawling websites, decoding schemas & discovering emails…',
              deduping: '🔄 Deduplicating contacts against database…',
              inserting: '💾 Ingesting leads into database…',
              qualifying: '🔬 Step 4/5: Auto-qualifying site health & ICP score…',
              verifying: '🛡️ Step 5/5: Auto-verifying emails & MX deliverability…',
              done: '✅ All pipeline steps completed successfully!',
              error: '❌ Scrape error',
              cancelled: '⏹️ Cancelled',
            };
            stepLabel.textContent = stepNames[status.step] || status.step;
          }

          if (progressBar) progressBar.style.width = `${status.progress || 10}%`;
          if (percentLabel) percentLabel.textContent = `${status.progress || 10}%`;
          if (statScraped) statScraped.textContent = status.scrapedCount || 0;
          if (statEmails) statEmails.textContent = status.emailsFoundCount || 0;
          if (statInserted) statInserted.textContent = status.insertedCount || 0;
          if (statQualified) statQualified.textContent = status.qualifiedCount || 0;
          if (statDeliverable) statDeliverable.textContent = status.deliverableCount || 0;

          if (status.step === 'done') {
            clearInterval(pollInterval);
            notify(`🎉 Success! Saved ${status.insertedCount} leads with ${status.emailsFoundCount} emails found!`);
            submitBtn.innerHTML = `✓ View ${status.insertedCount} Discovered Leads`;
            submitBtn.disabled = false;
            submitBtn.onclick = () => {
              dialog.close();
            };

            // Reload batches and select the new batch in the view
            try {
              const r = await fetch('/api/batches');
              _batches = await r.json();
              if (status.batchId) _filters.batch_id = String(status.batchId);
              _page = 0;
              await _renderLeadsView(container);
            } catch {}
          } else if (status.step === 'error') {
            clearInterval(pollInterval);
            notify(`Scraper error: ${status.error || 'Failed'}`, 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Retry Scrape';
          }
        } catch (err) {
          console.warn('Poll status error:', err);
        }
      }, 1000);

    } catch (err) {
      notify(err.message || 'Failed to start scraper', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Scrape & Pipeline';
    }
  };

  dialog.addEventListener('close', () => {
    if (pollInterval) clearInterval(pollInterval);
  });
}

function renderLeadDetail(lead) {
  const site = SITE_STATUS_BADGE[lead.site_status];
  const mapsUrl = lead.place_id
    ? `https://www.google.com/maps/place/?q=place_id:${lead.place_id}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.business_name + ' ' + (lead.city || ''))}`;

  return `
  ${lead.photo_url ? `
  <div style="width:100%; height:140px; border-radius:12px; overflow:hidden; margin-bottom:16px; position:relative; border:1px solid rgba(255,255,255,0.1); background:#1a1a24;">
    <img src="${escapeHtml(lead.photo_url)}" alt="${escapeHtml(lead.business_name)}" style="width:100%; height:100%; object-fit:cover;" onerror="this.parentElement.style.display='none'" />
    <div style="position:absolute; bottom:8px; right:8px; display:flex; gap:6px;">
      ${lead.price_level ? `<span style="background:rgba(0,0,0,0.75); backdrop-filter:blur(6px); color:#30D158; font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; border:1px solid rgba(48,209,88,0.3);">${lead.price_level}</span>` : ''}
      ${lead.rating ? `<span style="background:rgba(0,0,0,0.75); backdrop-filter:blur(6px); color:#f59e0b; font-weight:700; font-size:0.75rem; padding:2px 8px; border-radius:6px; border:1px solid rgba(245,158,11,0.3);">★ ${lead.rating}</span>` : ''}
    </div>
  </div>` : ''}

  <div class="detail-section">
    <div class="detail-grid-2">
      <div><label>Category</label><div>${lead.category || '—'}</div></div>
      <div><label>City</label><div>${lead.city || '—'} ${lead.country || ''}</div></div>
      <div><label>Phone</label><div>${lead.phone ? `<a href="tel:${lead.phone}" style="color:var(--text-primary); text-decoration:none;">${lead.phone}</a>` : '—'}</div></div>
      <div><label>Rating & Status</label><div>${lead.rating ? `★ ${lead.rating} (${lead.reviews || 0} reviews)` : '—'}${lead.hours_status ? ` · <span style="color:var(--text-muted); font-size:0.8rem;">${escapeHtml(lead.hours_status)}</span>` : ''}</div></div>
    </div>
  </div>

  ${lead.booking_url ? `
  <div class="detail-section" style="background:rgba(175,82,222,0.06); border:1px solid rgba(175,82,222,0.25); border-radius:10px; padding:12px;">
    <div class="detail-label" style="color:var(--system-purple);">Direct Online Booking & Scheduling</div>
    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:6px; flex-wrap:wrap;">
      <span style="font-size:0.8rem; color:var(--text-secondary); word-break:break-all;">${escapeHtml(lead.booking_url)}</span>
      <a href="${escapeHtml(lead.booking_url)}" target="_blank" class="btn btn-sm" style="background:var(--system-purple); color:#fff; text-decoration:none; padding:4px 12px; border-radius:6px; font-weight:600; font-size:0.78rem;">
        📅 Open Booking Link
      </a>
    </div>
  </div>` : ''}

  <div class="detail-section">
    <div class="detail-label">Google Maps Presence</div>
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <a href="${mapsUrl}" target="_blank" class="detail-link" style="color:var(--system-blue); font-weight:600;">
        📍 View on Google Maps
      </a>
      ${lead.place_id ? `<span style="font-size:0.7rem; color:var(--text-muted); font-family:monospace;">Place ID: ${lead.place_id.substring(0, 16)}…</span>` : ''}
    </div>
    ${lead.address ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">${escapeHtml(lead.address)}</div>` : ''}
  </div>

  <div class="detail-section">
    <div class="detail-label">Verified Business Channels & Socials</div>
    <div style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
      ${lead.website_url ? `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <a href="${escapeHtml(lead.website_url)}" target="_blank" class="detail-link" style="display:inline-flex; align-items:center; gap:5px;">
          🌐 ${escapeHtml(lead.website_url)}
        </a>
        <div style="display:flex; align-items:center; gap:6px;">
          ${site ? `<span class="site-status-chip" style="color:${site.color};border-color:${site.color}44">${site.label}</span>` : ''}
          ${lead.site_score ? `<span style="font-size:0.72rem;color:var(--text-muted)">Score: ${lead.site_score}/10</span>` : ''}
        </div>
      </div>` : '<div style="color:var(--text-muted); font-size:0.78rem;">No standalone website detected</div>'}

      ${lead.facebook_url ? `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <a href="${escapeHtml(lead.facebook_url)}" target="_blank" class="detail-link" style="color:#1877F2; font-weight:600;">
          ⓕ ${escapeHtml(lead.facebook_url)}
        </a>
        ${lead.fb_active === 1 ? `<span class="badge-tiny" style="color:var(--emerald); border-color:rgba(16,185,129,0.3); background:rgba(16,185,129,0.1);">● Active Page</span>` :
          lead.fb_active === 0 ? `<span class="badge-tiny" style="color:var(--rose); border-color:rgba(244,63,94,0.3); background:rgba(244,63,94,0.1);">✕ Inactive</span>` :
          `<span class="badge-tiny" style="color:var(--text-muted); border-color:rgba(255,255,255,0.1);">Verified Link</span>`}
      </div>` : ''}

      ${lead.instagram_url ? `
      <div>
        <a href="${escapeHtml(lead.instagram_url)}" target="_blank" class="detail-link" style="color:#E1306C; font-weight:600;">
          📸 ${escapeHtml(lead.instagram_url)}
        </a>
      </div>` : ''}

      ${lead.linkedin_url ? `
      <div>
        <a href="${escapeHtml(lead.linkedin_url)}" target="_blank" class="detail-link" style="color:#0A66C2; font-weight:600;">
          💼 ${escapeHtml(lead.linkedin_url)}
        </a>
      </div>` : ''}

      ${lead.twitter_url ? `
      <div>
        <a href="${escapeHtml(lead.twitter_url)}" target="_blank" class="detail-link" style="color:var(--text-primary); font-weight:600;">
          𝕏 ${escapeHtml(lead.twitter_url)}
        </a>
      </div>` : ''}
    </div>
  </div>

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
