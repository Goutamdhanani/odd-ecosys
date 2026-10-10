// ============================================================
//  Leads View — 100% live API
// ============================================================
import { Leads, Batches, ContactTags, ContactSegments, ContactFields, Lists, Qualify, MetaLeadAds, LeadStrategies, relTime, fmtNum } from './api.js';
import { clearFieldError, confirmAction, escapeHtml, icon, notify, openDialog, showFieldError, userFacingError } from './ui.js';
import { downloadRejectedContacts, downloadImportRejections } from './contact-import.js';
import { MAX_CONTACT_SELECTION, toggleContactSelection, setContactPageSelection, getContactPageSelection } from './contact-selection.js';

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

function emptyLeadFilters() {
  return { status: '', batch_id: '', search: '', tag_id: '', email_status: '', suppression_status: '', custom_field_key: '', custom_field_value: '' };
}

function safeHttpHref(value) {
  try {
    const candidate = new URL(value);
    return ['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password ? candidate.href : '';
  } catch { return ''; }
}

function safeFacebookHref(value) {
  const href = safeHttpHref(value);
  if (!href) return '';
  try { return ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(new URL(href).hostname.toLowerCase()) ? href : ''; }
  catch { return ''; }
}

function hasCustomFieldValue(value) {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
}

let _filters = emptyLeadFilters();
let _sortBy = 'discovered_at';
let _sortOrder = 'desc';
let _segments = [];
let _activeSegmentId = '';
let _segmentDirty = false;
let _page = 0;
let _pageCursors = [null];
const _selectedContactIds = new Set();
const PAGE_SIZE = 50;
let _batches = [];
let _tags = [];
let _customFields = [];

function resetLeadPaging() {
  _page = 0;
  _pageCursors = [null];
  _selectedContactIds.clear();
}

function renderLeadSortHeader(label, key) {
  const active = _sortBy === key;
  const ariaSort = active ? (_sortOrder === 'asc' ? 'ascending' : 'descending') : 'none';
  const indicator = active ? (_sortOrder === 'asc' ? '↑' : '↓') : '↕';
  return `<th aria-sort="${ariaSort}"><button class="lead-sort-button" type="button" aria-label="Sort by ${label}${active ? `, currently ${ariaSort}` : ''}" onclick="window.__leadSort('${key}')">${label}<span aria-hidden="true">${indicator}</span></button></th>`;
}

export async function renderLeads(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading leads…</span></div>`;

  // Load batches for filter dropdown
  try {
    const r = await fetch('/api/batches');
    _batches = await r.json();
  } catch { _batches = []; }
  try { _tags = await ContactTags.list(); } catch { _tags = []; }
  try { _segments = await ContactSegments.list(); } catch { _segments = []; }
  try { _customFields = (await ContactFields.list(true)).fields || []; } catch { _customFields = []; }

  await _renderLeadsView(container);
}

async function _renderLeadsView(container) {
  const params = { limit: PAGE_SIZE, sort_by: _sortBy, sort_order: _sortOrder };
  if (_pageCursors[_page]) params.cursor = _pageCursors[_page];
  if (_filters.status)   params.status   = _filters.status;
  if (_filters.batch_id) params.batch_id = _filters.batch_id;
  if (_filters.tag_id) params.tag_id = _filters.tag_id;
  if (_filters.email_status) params.email_status = _filters.email_status;
  if (_filters.suppression_status) params.suppression_status = _filters.suppression_status;
  if (_filters.search)   params.search   = _filters.search;
  if (_filters.custom_field_key && hasCustomFieldValue(_filters.custom_field_value)) {
    params.custom_field_key = _filters.custom_field_key;
    params.custom_field_value = _filters.custom_field_value;
  }

  const data = await Leads.list(params);
  const leads = data?.leads || [];
  const total = data?.pagination?.total || 0;
  const hasMore = Boolean(data?.pagination?.hasMore);
  const nextCursor = data?.pagination?.nextCursor || null;
  const canManageContacts = window.__workspaceRole !== 'reviewer';
  const hasContactFilter = Boolean(_activeSegmentId || Object.values(_filters).some(value => String(value || '').trim()));
  const activeSegment = _segments.find(segment => String(segment.id) === String(_activeSegmentId));
  const customFilterIncomplete = Boolean(_filters.custom_field_key) && !hasCustomFieldValue(_filters.custom_field_value);
  const contactsSummary = hasContactFilter
    ? `${fmtNum(total)} contacts match ${activeSegment ? `“${escapeHtml(activeSegment.name)}”` : 'the current filters'}`
    : `${fmtNum(total)} total contacts in the workspace`;
  if (!leads.length && _page > 0) {
    _page = Math.max(0, _page - 1);
    _pageCursors.length = _page + 1;
    return _renderLeadsView(container);
  }

  container.innerHTML = `
  <!-- Header -->
  <div class="section-header mb-16">
    <div>
      <h1 class="section-title">Lead Pipeline</h1>
      <div class="section-sub">${contactsSummary}</div>
    </div>
    <div class="contact-header-actions">
      <select id="lead-segment-filter" class="filter-select" aria-label="Choose a saved contact segment" onchange="window.__leadSegment(this.value)">
        <option value="">All contacts</option>
        ${_segments.map(segment => `<option value="${segment.id}" ${String(_activeSegmentId) === String(segment.id) ? 'selected' : ''}>${escapeHtml(segment.name)}</option>`).join('')}
      </select>
      ${window.__workspaceRole === 'reviewer' ? '' : `<button id="lead-save-segment" type="button" class="btn btn-ghost btn-sm" ${customFilterIncomplete ? 'disabled title="Choose an exact custom-field value first"' : ''}>${_activeSegmentId ? (_segmentDirty ? 'Save segment changes' : 'Update segment') : 'Save segment'}</button>${_activeSegmentId ? '<button id="lead-delete-segment" type="button" class="btn btn-ghost btn-sm">Delete segment</button>' : ''}`}
      ${window.__workspaceRole === 'reviewer' ? '' : `<button id="lead-ai-targeting" type="button" class="btn btn-ghost btn-sm">✦ AI targeting</button><button id="lead-fields-manage" type="button" class="btn btn-ghost btn-sm">Custom fields</button><button id="lead-import-contacts" type="button" class="btn btn-ghost btn-sm">${icon('upload', 15)} Import CSV</button><button id="lead-import-osm" type="button" class="btn btn-ghost btn-sm">Import OSM</button>${['owner','admin'].includes(window.__workspaceRole) ? '<button id="lead-import-meta" type="button" class="btn btn-ghost btn-sm">Import Meta leads</button>' : ''}<button id="lead-search-businesses" type="button" class="btn btn-ghost btn-sm">Search businesses</button><button id="lead-find-businesses" type="button" class="btn btn-ghost btn-sm">Find businesses</button><button id="lead-add-contact" type="button" class="btn btn-primary btn-sm">${icon('plus', 15)} Add contact</button>`}
    </div>
  </div>

  <!-- Filters -->
  <div class="filter-bar mb-16">
    <input
      id="lead-search"
      class="filter-input"
      placeholder="Search business, email, location, category, website, source…"
      maxlength="120"
      value="${escapeHtml(_filters.search)}"
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
      ${_batches.map(b => `<option value="${b.id}" ${_filters.batch_id == b.id ? 'selected' : ''}>${escapeHtml(b.name || b.label || 'Batch #'+b.id)}</option>`).join('')}
    </select>
    <select id="lead-tag-filter" class="filter-select" onchange="window.__leadFilter('tag_id', this.value)">
      <option value="">All tags</option>
      ${_tags.map(tag => `<option value="${tag.id}" ${_filters.tag_id == tag.id ? 'selected' : ''}>${escapeHtml(tag.name)} · ${fmtNum(tag.contact_count)} contacts</option>`).join('')}
    </select>
    <select id="lead-email-status-filter" class="filter-select" aria-label="Filter by primary email verification" onchange="window.__leadFilter('email_status', this.value)">
      <option value="">All email evidence</option>
      <option value="deliverable" ${_filters.email_status === 'deliverable' ? 'selected' : ''}>Deliverable</option>
      <option value="risky" ${_filters.email_status === 'risky' ? 'selected' : ''}>Risky</option>
      <option value="undeliverable" ${_filters.email_status === 'undeliverable' ? 'selected' : ''}>Undeliverable</option>
      <option value="unknown" ${_filters.email_status === 'unknown' ? 'selected' : ''}>Not verified</option>
      <option value="no_email" ${_filters.email_status === 'no_email' ? 'selected' : ''}>No primary email</option>
    </select>
    <select id="lead-suppression-filter" class="filter-select" aria-label="Filter by global email suppression" onchange="window.__leadFilter('suppression_status', this.value)">
      <option value="">All suppression states</option>
      <option value="suppressed" ${_filters.suppression_status === 'suppressed' ? 'selected' : ''}>Has suppressed email</option>
      <option value="not_suppressed" ${_filters.suppression_status === 'not_suppressed' ? 'selected' : ''}>No suppressed email</option>
    </select>
    ${renderCustomFieldFilter()}
    <button class="btn btn-ghost btn-sm" onclick="window.__leadReset()">Reset</button>
  </div>

  <!-- Table -->
  <div class="glass-panel">
    <div class="contact-bulk-toolbar">
      <label class="contact-select-page-control"><input id="lead-select-page" type="checkbox" ${canManageContacts && leads.length ? '' : 'disabled'}><span>Select this page (${fmtNum(leads.length)})</span></label>
      <span id="lead-selected-count" class="contact-selected-count" aria-live="polite">${fmtNum(_selectedContactIds.size)} selected across pages</span>
      <div class="contact-bulk-actions">
        <button id="lead-bulk-add-list" type="button" class="btn btn-ghost btn-sm" ${canManageContacts && _selectedContactIds.size ? '' : 'disabled'}>Add to list</button>
        <button id="lead-bulk-assign-tags" type="button" class="btn btn-ghost btn-sm" ${canManageContacts && _selectedContactIds.size && _tags.length ? '' : 'disabled'}>Assign tags</button>
        <button id="lead-clear-selection" type="button" class="btn btn-ghost btn-sm" ${canManageContacts && _selectedContactIds.size ? '' : 'disabled'}>Clear selection</button>
      </div>
    </div>
    <div class="leads-table-wrap">
      <table class="leads-table">
        <thead>
          <tr>
            <th aria-label="Selection"></th>
            ${renderLeadSortHeader('Business', 'business_name')}
            ${renderLeadSortHeader('Category', 'category')}
            ${renderLeadSortHeader('City', 'city')}
            <th>Site Status</th>
            <th>Email</th>
            ${renderLeadSortHeader('Stage', 'status')}
            ${renderLeadSortHeader('Discovered', 'discovered_at')}
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${leads.length === 0 ? `
          <tr><td colspan="9" class="empty-row">
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
              <td class="contact-select-cell" onclick="event.stopPropagation()"><input type="checkbox" class="lead-select-contact" data-lead-id="${l.id}" aria-label="Select ${escapeHtml(l.business_name)}" ${_selectedContactIds.has(Number(l.id)) ? 'checked' : ''} ${canManageContacts ? '' : 'disabled'}></td>
              <td>
                <div class="lead-biz-name">${escapeHtml(l.business_name)}</div>
                ${safeHttpHref(l.source_url) ? `<a class="lead-source-link" href="${escapeHtml(safeHttpHref(l.source_url))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(l.source_details || 'View source record')}">${escapeHtml(l.source === 'openstreetmap' ? 'OpenStreetMap' : l.source || 'Source')} ↗</a>` : ''}
                ${l.rating ? `<div class="lead-rating">★ ${l.rating} (${l.reviews || 0})</div>` : ''}
              </td>
              <td><span class="lead-cat">${escapeHtml(l.category || '—')}</span></td>
              <td><span class="lead-city">${escapeHtml(l.city || '—')}</span></td>
              <td>
                ${site ? `<span class="site-status-chip" style="color:${site.color};border-color:${site.color}44">${site.label}</span>` : '<span style="color:var(--text-muted)">—</span>'}
              </td>
              <td>
                <span class="lead-email">${escapeHtml(l.email || '—')}</span>
                <span class="contact-email-evidence is-${['deliverable','risky','undeliverable','unknown','no_email'].includes(l.primary_email_status) ? l.primary_email_status : 'unknown'}">${({ deliverable: 'Deliverable', risky: 'Risky', undeliverable: 'Undeliverable', unknown: 'Not verified', no_email: 'No primary email' })[l.primary_email_status] || 'Not verified'}</span>
                ${l.has_suppressed_email ? '<span class="contact-suppression-badge" title="At least one primary or alias address is globally blocked">Suppressed address</span>' : ''}
              </td>
              <td>
                <span class="lead-status-badge" style="color:${stColor};border-color:${stColor}44">
                  ${stIcon} ${escapeHtml(l.status?.replace(/_/g,' '))}
                </span>
              </td>
              <td class="lead-time">${escapeHtml(relTime(l.discovered_at))}</td>
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
    ${_page > 0 || hasMore ? `
    <div class="pagination">
      ${_page > 0 ? `<button class="btn btn-ghost btn-sm" onclick="window.__leadPage(${_page - 1})">← Prev</button>` : ''}
      <span style="font-size:0.78rem;color:var(--text-muted)">Page ${_page + 1} · ${fmtNum(total)} total matching contacts</span>
      ${hasMore ? `<button class="btn btn-ghost btn-sm" onclick="window.__leadPage(${_page + 1})">Next →</button>` : ''}
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
  const visibleContactIds = leads.map(lead => Number(lead.id));
  const updateSelectionControls = () => {
    const selectPage = container.querySelector('#lead-select-page');
    const state = getContactPageSelection(_selectedContactIds, visibleContactIds);
    if (selectPage) {
      selectPage.checked = state.allSelected;
      selectPage.indeterminate = state.indeterminate;
    }
    const count = container.querySelector('#lead-selected-count');
    if (count) count.textContent = `${fmtNum(_selectedContactIds.size)} selected across pages`;
    const assign = container.querySelector('#lead-bulk-assign-tags');
    if (assign) assign.disabled = !canManageContacts || !_selectedContactIds.size || !_tags.length;
    const addToList = container.querySelector('#lead-bulk-add-list');
    if (addToList) addToList.disabled = !canManageContacts || !_selectedContactIds.size;
    const clear = container.querySelector('#lead-clear-selection');
    if (clear) clear.disabled = !canManageContacts || !_selectedContactIds.size;
  };
  container.querySelector('#lead-select-page')?.addEventListener('change', event => {
    if (!setContactPageSelection(_selectedContactIds, visibleContactIds, event.currentTarget.checked)) {
      notify(`Select up to ${MAX_CONTACT_SELECTION} contacts at a time.`, 'error');
    }
    updateSelectionControls();
  });
  container.querySelectorAll('.lead-select-contact').forEach(input => input.addEventListener('change', event => {
    if (!toggleContactSelection(_selectedContactIds, event.currentTarget.dataset.leadId, event.currentTarget.checked)) {
      event.currentTarget.checked = false;
      notify(`Select up to ${MAX_CONTACT_SELECTION} contacts at a time.`, 'error');
    }
    updateSelectionControls();
  }));
  container.querySelectorAll('.lead-source-link').forEach(link => link.addEventListener('click', event => event.stopPropagation()));
  container.querySelector('#lead-clear-selection')?.addEventListener('click', () => {
    _selectedContactIds.clear();
    container.querySelectorAll('.lead-select-contact').forEach(input => { input.checked = false; });
    updateSelectionControls();
  });
  container.querySelector('#lead-bulk-add-list')?.addEventListener('click', () => openBulkContactListEditor(container).catch(error => notify(error.message || 'Could not add contacts to the list.', 'error')));
  container.querySelector('#lead-bulk-assign-tags')?.addEventListener('click', () => openBulkContactTagEditor(container).catch(error => notify(error.message || 'Could not assign contact tags.', 'error')));
  updateSelectionControls();

  container.querySelector('#lead-fields-manage')?.addEventListener('click', () => openContactFieldManager(container).catch(error => notify(error.message, 'error')));
  container.querySelector('#lead-ai-targeting')?.addEventListener('click', () => openLeadStrategyStudio().catch(error => notify(error.message || 'AI targeting is unavailable.', 'error')));
  container.querySelector('#lead-add-contact')?.addEventListener('click', () => openContactCreator(container).catch(error => notify(error.message, 'error')));
  container.querySelector('#lead-import-contacts')?.addEventListener('click', () => openContactImporter(container).catch(error => notify(error.message, 'error')));
  container.querySelector('#lead-import-osm')?.addEventListener('click', () => openOpenStreetMapImporter(container).catch(error => notify(error.message, 'error')));
  container.querySelector('#lead-import-meta')?.addEventListener('click', () => openMetaLeadAdsImporter(container).catch(error => notify(error.message, 'error')));
  container.querySelector('#lead-find-businesses')?.addEventListener('click', () => openWebsiteDiscoveryDialog(container).catch(error => notify(error.message || 'Could not open website discovery.', 'error')));
  container.querySelector('#lead-search-businesses')?.addEventListener('click', () => openBusinessSearchDialog(container).catch(error => notify(error.message || 'Could not open business search.', 'error')));
  container.querySelector('#lead-save-segment')?.addEventListener('click', () => saveContactSegment(container));
  container.querySelector('#lead-delete-segment')?.addEventListener('click', () => deleteContactSegment(container));
  let searchTimer;
  window.__leadSearch = (val) => {
    _filters.search = val;
    _segmentDirty = Boolean(_activeSegmentId);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      resetLeadPaging();
      _renderLeadsView(container);
    }, 350);
  };
  window.__leadFilter = (key, val) => {
    _filters[key] = val;
    _segmentDirty = Boolean(_activeSegmentId);
    resetLeadPaging();
    _renderLeadsView(container);
  };
  window.__leadCustomField = (fieldKey) => {
    _filters.custom_field_key = fieldKey;
    _filters.custom_field_value = '';
    _segmentDirty = Boolean(_activeSegmentId);
    resetLeadPaging();
    _renderLeadsView(container);
  };
  window.__leadCustomValue = (value) => {
    _filters.custom_field_value = value;
    _segmentDirty = Boolean(_activeSegmentId);
    resetLeadPaging();
    _renderLeadsView(container);
  };
  window.__leadSort = (sortBy) => {
    if (!['discovered_at', 'business_name', 'category', 'city', 'status'].includes(sortBy)) return;
    if (_sortBy === sortBy) _sortOrder = _sortOrder === 'asc' ? 'desc' : 'asc';
    else {
      _sortBy = sortBy;
      _sortOrder = sortBy === 'discovered_at' ? 'desc' : 'asc';
    }
    _segmentDirty = Boolean(_activeSegmentId);
    resetLeadPaging();
    _renderLeadsView(container);
  };
  window.__leadReset = () => {
    _filters = emptyLeadFilters();
    _sortBy = 'discovered_at';
    _sortOrder = 'desc';
    _activeSegmentId = '';
    _segmentDirty = false;
    resetLeadPaging();
    _renderLeadsView(container);
  };
  window.__leadSegment = (id) => {
    const segment = _segments.find(item => String(item.id) === String(id));
    _activeSegmentId = segment ? String(segment.id) : '';
    _filters = { ...emptyLeadFilters(), ...(segment?.filters || {}) };
    _sortBy = segment?.filters?.sort_by || 'discovered_at';
    _sortOrder = segment?.filters?.sort_order || 'desc';
    _segmentDirty = false;
    resetLeadPaging();
    _renderLeadsView(container);
  };
  window.__leadPage = (p) => {
    const target = Number(p);
    if (!Number.isSafeInteger(target) || target < 0 || target > _page + 1) return;
    if (target < _page) {
      _page = target;
      _pageCursors.length = target + 1;
    } else if (target === _page + 1 && nextCursor) {
      _pageCursors[target] = nextCursor;
      _page = target;
    } else return;
    _renderLeadsView(container);
  };
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
    body.querySelector('[data-edit-contact]')?.addEventListener('click', () => openContactEditor(lead, container).catch(error => notify(error.message, 'error')));
    body.querySelector('[data-edit-tags]')?.addEventListener('click', () => openContactTagEditor(lead, container).catch(error => notify(error.message, 'error')));
    body.querySelector('[data-delete-contact]')?.addEventListener('click', () => openContactDeleteDialog(lead, container));
    body.querySelector('[data-website-email-scan]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Checking site rules…';
      try {
        const result = await Leads.discoverWebsiteEmails(id);
        notify(result.message, result.scan?.status === 'completed' ? 'success' : 'error');
      } catch (error) {
        notify(error.status === 409 ? 'This contact already has a recorded website scan.' : error.message, 'error');
      }
      await window.__leadDetail(id);
    });
    body.querySelector('[data-website-email-refresh]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Refreshing saved pages…';
      try {
        const result = await Leads.refreshWebsiteEmailScan(id);
        const status = result.scan?.status;
        notify(status === 'completed'
          ? `Refresh complete · ${Number(result.scan?.latest_refresh?.page_count) || 0} page(s) checked. Existing email verification was not changed.`
          : `Refresh ${status || 'stopped'} safely. Existing source evidence was preserved.`, status === 'completed' ? 'success' : 'error');
      } catch (error) {
        notify(error.message || 'The saved website pages could not be refreshed.', 'error');
      }
      await window.__leadDetail(id);
    });
  };
  window.__requalify = async (id) => {
    await Qualify.requalifyLead(id);
    _renderLeadsView(container);
  };
}

const STRATEGY_SOURCE_LABELS = {
  operator_csv: 'Your CSV imports',
  osm_export: 'Operator-supplied OpenStreetMap export',
  meta_lead_ads: 'Your own Meta Lead Ads forms',
  website_scan: 'One-time company website scan',
};

function leadStrategyProviderSaveError(error) {
  const detail = String(error?.message ?? error ?? '');
  if (/ODD_CREDENTIAL_ENCRYPTION_KEY|credential_encryption_key_required|credential_key_invalid/i.test(detail)) {
    return 'The app cannot store this API key until its private credential-encryption key is configured correctly. Set ODD_CREDENTIAL_ENCRYPTION_KEY on the app server, restart it, then retry. Keep that key private and out of this form.';
  }
  if (/AI provider settings are controlled by the service environment/i.test(detail)) {
    return 'The app service environment controls this AI provider. Update its local configuration and restart the app to change the model.';
  }
  return userFacingError(error, 'AI provider settings were not saved. Review the fields and try again.');
}

async function openLeadStrategyStudio() {
  const payload = await LeadStrategies.list();
  let provider = payload.provider || {};
  let settings = payload.settings || {};
  let selectedProviderScope = 'personal';
  const strategies = payload.strategies || [];
  const dialog = openDialog({
    title: 'Build an AI targeting strategy',
    eyebrow: 'ICP & BUYER PERSONAS',
    body: `<p class="lead-strategy-intro">Describe what you sell and who it helps. The AI will shape an ideal account profile, several buying personas, role and skill signals, and a practical source-aware search plan. It creates strategy suggestions only—never contact records or email addresses. Only this brief is sent to the selected AI provider; CRM contacts and mailbox messages are not included.</p>
      <div class="lead-strategy-provider-row"><div id="lead-strategy-provider-status" class="lead-strategy-provider" role="status"><span class="lead-strategy-provider-dot"></span><div><strong>${escapeHtml(provider.provider || 'AI provider')}</strong><span>${escapeHtml(provider.model || (provider.ready ? 'Model configured' : 'Model not configured'))} · ${provider.apiKeyConfigured ? 'credential configured' : 'no API credential configured'} · connection not checked</span></div></div><button id="lead-strategy-check-provider" type="button" class="btn btn-ghost btn-sm" aria-controls="lead-strategy-provider-status" ${provider.ready ? '' : 'disabled'}><span class="lead-strategy-action-spinner" aria-hidden="true" hidden></span><span>Check connection</span></button></div>
      <p id="lead-strategy-config-note" class="lead-strategy-config-note">${escapeHtml(provider.note || 'AI provider status is unavailable.')}</p>
      <section id="lead-strategy-provider-settings" class="lead-strategy-settings"></section>
      <div id="lead-strategy-brief" class="lead-strategy-form" autocomplete="off">
        <label class="lead-strategy-field lead-strategy-field-wide"><span>What do you offer? <b>*</b></span><textarea name="offer" maxlength="800" rows="3" required placeholder="Product or service, the problem it solves, and who benefits"></textarea></label>
        <label class="lead-strategy-field"><span>Target market <b>*</b></span><textarea name="targetMarket" maxlength="500" rows="2" required placeholder="Industries, company types, or use cases"></textarea></label>
        <label class="lead-strategy-field"><span>Geography</span><input name="geography" maxlength="200" placeholder="Countries, regions, or cities"></label>
        <label class="lead-strategy-field"><span>Company size</span><input name="companySize" maxlength="200" placeholder="Employee count or business size"></label>
        <label class="lead-strategy-field"><span>Buyer-role hint</span><input name="buyerHint" maxlength="300" placeholder="Roles or skills you think are relevant"></label>
        <label class="lead-strategy-field"><span>Proof or differentiator</span><textarea name="evidence" maxlength="500" rows="2" placeholder="Evidence you can honestly support; leave blank if unknown"></textarea></label>
        <label class="lead-strategy-field lead-strategy-field-wide"><span>Who should be excluded?</span><textarea name="exclusions" maxlength="500" rows="2" placeholder="Industries, company types, or circumstances that are a poor fit"></textarea></label>
      </div>
      <div class="lead-strategy-actions"><button id="lead-strategy-generate" type="button" class="btn btn-primary btn-sm" ${provider.ready && provider.connection === 'connected' ? '' : 'disabled'}>✦ Generate strategy</button><span class="lead-strategy-hypothesis-note">All fit, skill, pain and buying-trigger suggestions are hypotheses to validate from sources.</span></div>
      ${strategies.length ? `<label class="lead-strategy-saved"><span>Saved strategies</span><select id="lead-strategy-saved" class="filter-select"><option value="">Choose a saved strategy…</option>${strategies.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${escapeHtml(item.created_at)}</option>`).join('')}</select></label>` : '<div id="lead-strategy-saved-wrap"></div>'}
      <div id="lead-strategy-result" class="lead-strategy-result" aria-live="polite"><div class="lead-strategy-empty">Your saved targeting plan will appear here after generation.</div></div>`,
  });
  dialog.classList.add('lead-strategy-dialog');
  const generateButton = dialog.querySelector('#lead-strategy-generate');
  const result = dialog.querySelector('#lead-strategy-result');
  const providerStatus = dialog.querySelector('#lead-strategy-provider-status');
  const providerCheckButton = dialog.querySelector('#lead-strategy-check-provider');
  const providerSettingsPanel = dialog.querySelector('#lead-strategy-provider-settings');
  const setProviderSaveFeedback = (message, kind = 'success') => {
    const status = providerSettingsPanel.querySelector('#lead-strategy-provider-save-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', kind === 'error');
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  };
  const updateProviderDisplay = (result = null) => {
    const current = result || provider;
    providerStatus.querySelector('strong').textContent = current.provider || settings.provider || 'AI provider';
    const currentModel = current.model || settings.model || 'Model not configured';
    const credentialConfigured = selectedProviderScope === 'workspace'
      ? Boolean(settings.workspaceApiKeyConfigured)
      : Boolean(settings.personalApiKeyConfigured || (!settings.personalConfigured && settings.apiKeyConfigured));
    const connectionText = current.connection === 'connected' ? 'Connected · model available'
      : current.connection === 'model_unavailable' ? 'Endpoint connected · model unavailable'
        : current.connection === 'not_checked' ? 'Connection not checked'
          : settings.source === 'environment' && !settings.personalConfigured ? 'Using service default'
            : 'Saved · connection not checked';
    providerStatus.querySelector('div span').textContent = `${currentModel} · ${credentialConfigured ? 'credential configured' : 'no API credential'} · ${connectionText}`;
    providerStatus.querySelector('.lead-strategy-provider-dot')?.classList.toggle('is-ready', current.modelAvailable === true || current.connection === 'connected');
  };
  const mountProviderSettings = () => {
    const keepSettingsOpen = providerSettingsPanel.querySelector('.lead-strategy-settings-details')?.open === true;
    const canEdit = settings.canEdit;
    if (!canEdit) {
      providerSettingsPanel.innerHTML = '<p class="lead-strategy-config-note">Sign in as an owner, admin, or operator to save a personal AI provider. Your key is private to your account.</p>';
      return;
    }
    const scopeSettings = selectedProviderScope === 'workspace' ? (settings.workspace || settings) : (settings.personal || settings);
    const savedKeyForScope = selectedProviderScope === 'workspace'
      ? Boolean(settings.workspaceApiKeyConfigured)
      : Boolean(settings.personalApiKeyConfigured);
    const apiKeyRequired = scopeSettings.provider === 'freeinference' && !savedKeyForScope;
    const scopeControl = settings.canManageWorkspace
      ? `<label class="lead-strategy-field"><span>Save settings for</span><select name="strategyScope"><option value="personal" ${selectedProviderScope === 'personal' ? 'selected' : ''}>My account only</option><option value="workspace" ${selectedProviderScope === 'workspace' ? 'selected' : ''}>Workspace default</option></select></label>`
      : '<input type="hidden" name="strategyScope" value="personal">';
    const scopeSummary = selectedProviderScope === 'personal'
      ? (settings.personalConfigured ? 'Your personal provider' : 'Workspace provider is the fallback until you save a personal provider')
      : 'Shared workspace provider used when a member has no personal override';
    providerSettingsPanel.innerHTML = `<details class="lead-strategy-settings-details"><summary>AI provider settings <span>${settings.personalConfigured ? 'personal override saved' : 'using shared fallback'}</span></summary>
      <div class="lead-strategy-provider-form">
        ${scopeControl}
        <label class="lead-strategy-field"><span>Provider</span><select name="strategyProvider"><option value="ollama" ${scopeSettings.provider === 'ollama' ? 'selected' : ''}>Local Ollama</option><option value="freeinference" ${scopeSettings.provider === 'freeinference' ? 'selected' : ''}>FreeInference</option><option value="openai-compatible" ${scopeSettings.provider === 'openai-compatible' ? 'selected' : ''}>Custom OpenAI-compatible</option></select></label>
        <label class="lead-strategy-field"><span>Endpoint base URL</span><input name="strategyBaseUrl" type="url" maxlength="500" value="${escapeHtml(scopeSettings.baseUrl || '')}" placeholder="http://localhost:11434 or https://provider.example/v1" ${scopeSettings.provider === 'ollama' ? '' : 'required'}></label>
        <label class="lead-strategy-field"><span>Model name</span><input name="strategyModel" maxlength="160" value="${escapeHtml(scopeSettings.model || '')}" placeholder="Model ID" required></label>
        <label class="lead-strategy-field"><span>API key ${savedKeyForScope ? '(leave blank to keep this saved key)' : '(required by FreeInference)'}</span><input name="strategyApiKey" type="password" maxlength="4096" autocomplete="new-password" placeholder="Never returned after saving" ${apiKeyRequired ? 'required' : ''}></label>
        ${savedKeyForScope ? '<label class="lead-strategy-clear-key"><input name="strategyClearApiKey" type="checkbox"><span>Remove this saved API key</span></label>' : ''}
      </div><p class="lead-strategy-config-note">${escapeHtml(scopeSummary)}. Personal keys are encrypted at rest and never shared with other accounts. Remote endpoints must use HTTPS; local Ollama can use loopback HTTP. Only this product brief is sent for generation.</p>
      <div class="lead-strategy-provider-actions"><button id="lead-strategy-save-provider" type="button" class="btn btn-ghost btn-sm"><span class="lead-strategy-action-spinner" aria-hidden="true" hidden></span><span>Save provider settings</span></button>${settings.personalConfigured ? '<button id="lead-strategy-clear-personal" type="button" class="btn btn-ghost btn-sm">Use workspace default</button>' : ''}</div></details><p id="lead-strategy-provider-save-status" class="lead-strategy-save-status" role="status" aria-live="polite"></p>`;
    const details = providerSettingsPanel.querySelector('.lead-strategy-settings-details');
    details.open = keepSettingsOpen;
    if (!canEdit) return;
    const markProviderSettingsDirty = () => {
      providerSettingsPanel.dataset.dirty = 'true';
      providerCheckButton.disabled = true;
      generateButton.disabled = true;
      setProviderSaveFeedback('Save these changes before checking the selected model.', 'info');
    };
    providerSettingsPanel.querySelector('[name="strategyProvider"]')?.addEventListener('change', event => {
      const endpoint = providerSettingsPanel.querySelector('[name="strategyBaseUrl"]');
      const apiKey = providerSettingsPanel.querySelector('[name="strategyApiKey"]');
      if (endpoint) endpoint.required = event.currentTarget.value !== 'ollama';
      if (apiKey) apiKey.required = event.currentTarget.value === 'freeinference' && !savedKeyForScope;
      markProviderSettingsDirty();
    });
    providerSettingsPanel.querySelector('[name="strategyScope"]')?.addEventListener('change', event => {
      selectedProviderScope = event.currentTarget.value;
      markProviderSettingsDirty();
      mountProviderSettings();
    });
    providerSettingsPanel.querySelectorAll('input,select').forEach(field => {
      field.addEventListener('input', markProviderSettingsDirty);
      field.addEventListener('change', markProviderSettingsDirty);
      field.addEventListener('input', () => { if (field.getAttribute('aria-invalid') === 'true') clearFieldError(field); });
    });
    providerSettingsPanel.querySelector('#lead-strategy-save-provider')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const spinner = button.querySelector('.lead-strategy-action-spinner');
      const fields = providerSettingsPanel.querySelectorAll('input,select');
      fields.forEach(clearFieldError);
      const invalid = [...fields].find(field => field.name !== 'strategyClearApiKey' && (!field.checkValidity() || (field.required && !field.value.trim())));
      if (invalid) {
        showFieldError(invalid, invalid.required && !invalid.value.trim() ? 'Enter a value before saving.' : invalid.validationMessage || 'Check this value and try again.');
        invalid.focus();
        setProviderSaveFeedback('Review the highlighted provider setting.', 'error');
        return;
      }
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      spinner.hidden = false;
      setProviderSaveFeedback('Saving the model and provider settings…', 'info');
      try {
        const form = name => providerSettingsPanel.querySelector(`[name="${name}"]`);
        const updated = await LeadStrategies.saveProviderSettings({
          scope: selectedProviderScope,
          provider: form('strategyProvider').value,
          baseUrl: form('strategyBaseUrl').value.trim(),
          model: form('strategyModel').value.trim(),
          apiKey: form('strategyApiKey').value,
          clearApiKey: form('strategyClearApiKey')?.checked === true,
        });
        if (!updated?.settings || updated.settings.model !== form('strategyModel').value.trim()) {
          throw new Error('The server did not confirm the selected model. Reload settings and try again.');
        }
        settings = updated.settings;
        provider = updated.provider;
        providerCheckButton.disabled = !updated.provider.ready;
        generateButton.disabled = true;
        dialog.querySelector('#lead-strategy-config-note').textContent = 'Provider settings saved. Check the endpoint and selected model before generating.';
        updateProviderDisplay({ ...updated.provider, connection: 'not_checked' });
        mountProviderSettings();
        setProviderSaveFeedback('Provider settings saved. The selected model is stored; check its connection before generating.', 'success');
        notify('AI provider settings saved securely. Test the selected model before generating.', 'success');
      } catch (error) {
        const message = leadStrategyProviderSaveError(error);
        setProviderSaveFeedback(message, 'error');
        notify(message, 'error');
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
          spinner.hidden = true;
        }
      }
    });
    providerSettingsPanel.querySelector('#lead-strategy-clear-personal')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const updated = await LeadStrategies.clearPersonalProviderSettings();
        settings = updated.settings;
        provider = updated.provider;
        selectedProviderScope = 'personal';
        providerSettingsPanel.dataset.dirty = '';
        providerCheckButton.disabled = !updated.provider.ready;
        generateButton.disabled = true;
        updateProviderDisplay({ ...updated.provider, connection: 'not_checked' });
        mountProviderSettings();
        setProviderSaveFeedback('Personal provider removed. The workspace/default provider is active again.', 'success');
      } catch (error) {
        setProviderSaveFeedback(userFacingError(error, 'Personal provider could not be removed.'), 'error');
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  };
  mountProviderSettings();
  providerCheckButton?.addEventListener('click', async () => {
    providerCheckButton.disabled = true;
    providerCheckButton.setAttribute('aria-busy', 'true');
    providerCheckButton.querySelector('.lead-strategy-action-spinner').hidden = false;
    try {
      const check = await LeadStrategies.checkProvider(selectedProviderScope);
      const label = check.connection === 'connected' ? 'Connected · configured model available'
        : check.connection === 'model_unavailable' ? 'Endpoint connected · configured model not listed'
          : check.connection === 'timeout' ? 'Provider check timed out'
            : check.connection === 'rejected' ? 'Provider rejected the connection check'
              : check.connection === 'not_configured' ? 'Provider is not configured'
                : 'Provider could not be reached';
      updateProviderDisplay(check);
      dialog.querySelector('#lead-strategy-config-note').textContent = check.modelAvailable
        ? 'The provider returned its model list and the selected model is available. Strategy generation uses the product context you submit here.'
        : 'Check the local AI service or endpoint/model credentials, then try again. No brief or contact data was sent by this connection check.';
      generateButton.disabled = check.modelAvailable !== true;
    } catch (error) {
      providerStatus.querySelector('div span').textContent = 'Provider connection could not be checked';
      dialog.querySelector('#lead-strategy-config-note').textContent = error.message || 'Check provider configuration and try again.';
      generateButton.disabled = true;
    } finally {
      providerCheckButton.disabled = false;
      providerCheckButton.removeAttribute('aria-busy');
      providerCheckButton.querySelector('.lead-strategy-action-spinner').hidden = true;
    }
  });
  generateButton?.addEventListener('click', async () => {
    const form = dialog.querySelector('#lead-strategy-brief');
    const briefFields = [...form.querySelectorAll('input,textarea,select')];
    const invalid = briefFields.find(field => !field.checkValidity() || (field.required && !field.value.trim()));
    if (invalid) { invalid.reportValidity(); invalid.focus(); return; }
    const buttonText = generateButton.textContent;
    generateButton.disabled = true;
    generateButton.textContent = 'Building personas…';
    result.innerHTML = '<div class="lead-strategy-empty" role="status">Creating and validating a structured targeting plan…</div>';
    try {
      const profile = await LeadStrategies.generate(Object.fromEntries(new FormData(dialog.querySelector('.studio-dialog-form'))));
      result.innerHTML = renderLeadStrategyProfile(profile);
      let select = dialog.querySelector('#lead-strategy-saved');
      if (!select) {
        const wrap = dialog.querySelector('#lead-strategy-saved-wrap');
        wrap.outerHTML = '<label class="lead-strategy-saved" id="lead-strategy-saved-wrap"><span>Saved strategies</span><select id="lead-strategy-saved" class="filter-select"><option value="">Choose a saved strategy…</option></select></label>';
        select = dialog.querySelector('#lead-strategy-saved');
        select.addEventListener('change', async () => {
          if (!select.value) return;
          try { result.innerHTML = renderLeadStrategyProfile(await LeadStrategies.get(select.value)); }
          catch (error) { result.innerHTML = `<p class="lead-strategy-error">${escapeHtml(error.message)}</p>`; }
        });
      }
      const option = document.createElement('option');
      option.value = String(profile.id);
      option.textContent = `${profile.name} · ${profile.created_at}`;
      select.insertBefore(option, select.options[1] || null);
      select.value = String(profile.id);
      notify('AI targeting strategy saved. Review its hypotheses before using them.', 'success');
    } catch (error) {
      result.innerHTML = `<p class="lead-strategy-error">${escapeHtml(error.message || 'Could not generate a targeting strategy.')}</p>`;
    } finally {
      generateButton.disabled = false;
      generateButton.textContent = buttonText;
    }
  });
  dialog.querySelector('#lead-strategy-saved')?.addEventListener('change', async event => {
    if (!event.currentTarget.value) return;
    result.innerHTML = '<div class="lead-strategy-empty" role="status">Loading saved targeting plan…</div>';
    try { result.innerHTML = renderLeadStrategyProfile(await LeadStrategies.get(event.currentTarget.value)); }
    catch (error) { result.innerHTML = `<p class="lead-strategy-error">${escapeHtml(error.message)}</p>`; }
  });
}

function strategyList(items) {
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderLeadStrategyProfile(profile) {
  const plan = profile.result;
  const meta = `${escapeHtml(profile.provider)} · ${escapeHtml(profile.model_id)} · saved ${escapeHtml(profile.created_at)}${profile.input_tokens !== null || profile.output_tokens !== null ? ` · tokens in/out ${profile.input_tokens ?? '—'}/${profile.output_tokens ?? '—'}` : ''}`;
  return `<article class="lead-strategy-profile"><header class="lead-strategy-profile-header"><div><span class="eyebrow">SAVED TARGETING PLAN</span><h3>${escapeHtml(plan.name)}</h3></div><span class="lead-strategy-provenance">${meta}</span></header>
    <p class="lead-strategy-summary">${escapeHtml(plan.icp.summary)}</p>
    <section class="lead-strategy-section"><h4>Ideal customer profile</h4><div class="lead-strategy-columns"><div><b>Industries</b>${strategyList(plan.icp.industries)}</div><div><b>Company size</b>${strategyList(plan.icp.company_size)}</div><div><b>Geography</b>${strategyList(plan.icp.geography)}</div><div><b>Good-fit signals</b>${strategyList(plan.icp.must_have_signals)}</div><div><b>Exclude</b>${strategyList(plan.icp.exclude_signals)}</div><div><b>Qualification questions</b>${strategyList(plan.icp.qualification_questions)}</div></div></section>
    <section class="lead-strategy-section"><h4>${plan.personas.length} buyer personas</h4><div class="lead-strategy-personas">${plan.personas.map(persona => `<article class="lead-strategy-persona"><div class="lead-strategy-persona-heading"><div><h5>${escapeHtml(persona.name)}</h5><span>${escapeHtml(persona.buying_role)} · ${escapeHtml(persona.seniority)}</span></div><span class="lead-strategy-confidence">${escapeHtml(persona.confidence)} hypothesis</span></div><b>Job titles</b>${strategyList(persona.job_titles)}<div class="lead-strategy-columns"><div><b>Skill signals</b>${strategyList(persona.must_have_skills)}</div><div><b>Technology signals</b>${strategyList(persona.technology_signals)}</div><div><b>Pain to validate</b>${strategyList(persona.pain_points)}</div><div><b>Buying triggers to validate</b>${strategyList(persona.buying_triggers)}</div></div><b>Search phrases</b>${strategyList(persona.search_terms)}</article>`).join('')}</div></section>
    <section class="lead-strategy-section"><h4>Discovery plan</h4><div class="lead-strategy-columns">${plan.search_plan.map(item => `<div class="lead-strategy-source"><b>${escapeHtml(STRATEGY_SOURCE_LABELS[item.source] || item.source)}</b><p>${escapeHtml(item.approach)}</p>${strategyList(item.query_terms)}</div>`).join('')}</div></section>
    <section class="lead-strategy-section"><h4>Suggested fit scorecard · 100 points</h4><div class="lead-strategy-rubric">${plan.scoring_rubric.map(item => `<div><b>${item.weight} points · ${escapeHtml(item.criterion)}</b>${strategyList(item.positive_signals)}</div>`).join('')}</div></section>
    <p class="lead-strategy-hypothesis-note">${escapeHtml(plan.hypotheses_notice)} This plan is not a verified fact source and did not create leads or send email.</p></article>`;
}

function currentContactFilters() {
  const filters = {
    status: _filters.status,
    batch_id: _filters.batch_id,
    search: _filters.search,
    tag_id: _filters.tag_id,
    email_status: _filters.email_status,
    suppression_status: _filters.suppression_status,
  };
  if (_filters.custom_field_key && hasCustomFieldValue(_filters.custom_field_value)) {
    filters.custom_field_key = _filters.custom_field_key;
    filters.custom_field_value = _filters.custom_field_value;
  }
  if (_sortBy !== 'discovered_at' || _sortOrder !== 'desc') {
    filters.sort_by = _sortBy;
    filters.sort_order = _sortOrder;
  }
  return filters;
}

function renderCustomFieldFilter() {
  const field = _customFields.find(item => item.fieldKey === _filters.custom_field_key);
  const options = _customFields.map(item => {
    const archived = item.status === 'archived';
    const retained = archived && item.fieldKey === _filters.custom_field_key;
    return `<option value="${escapeHtml(item.fieldKey)}" ${item.fieldKey === _filters.custom_field_key ? 'selected' : ''} ${archived && !retained ? 'disabled' : ''}>${escapeHtml(item.name)}${archived ? ' · archived' : ''}</option>`;
  }).join('');
  let valueControl = '';
  if (field?.type === 'boolean' || field?.type === 'select') {
    const values = field.type === 'boolean'
      ? [['true', 'Yes'], ['false', 'No']]
      : field.options.map(value => [value, value]);
    valueControl = `<select id="lead-custom-field-value" class="filter-select" aria-label="Exact value for ${escapeHtml(field.name)}" onchange="window.__leadCustomValue(this.value)"><option value="">Choose exact value…</option>${values.map(([value, label]) => `<option value="${escapeHtml(value)}" ${String(_filters.custom_field_value) === value && _filters.custom_field_value !== '' ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
  } else if (field) {
    const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
    const extra = field.type === 'number' ? ' step="any" min="-1000000000000" max="1000000000000"' : field.type === 'text' ? ' maxlength="5000"' : '';
    valueControl = `<input id="lead-custom-field-value" class="filter-input" type="${type}" aria-label="Exact value for ${escapeHtml(field.name)}" placeholder="Exact ${escapeHtml(field.name)}…" value="${escapeHtml(_filters.custom_field_value ?? '')}"${extra} onchange="window.__leadCustomValue(this.value)" autocomplete="off" />`;
  }
  return `<select id="lead-custom-field-filter" class="filter-select" aria-label="Filter by custom field" onchange="window.__leadCustomField(this.value)"><option value="">Custom field…</option>${options}</select>${valueControl}${field?.status === 'archived' ? '<span class="filter-hint" role="status">Archived field filter retained for this saved segment.</span>' : ''}`;
}

async function saveContactSegment(container) {
  if (_filters.custom_field_key && !hasCustomFieldValue(_filters.custom_field_value)) {
    notify('Choose an exact custom-field value before saving this segment.', 'error');
    return;
  }
  try {
    if (_activeSegmentId) {
      const saved = await ContactSegments.update(_activeSegmentId, { filters: currentContactFilters() });
      _segments = await ContactSegments.list();
      _activeSegmentId = String(saved.id);
      _segmentDirty = false;
      await _renderLeadsView(container);
      notify(`Updated segment “${saved.name}”.`);
      return;
    }
    openDialog({
      title: 'Save contact segment', eyebrow: 'REUSABLE CONTACT FILTER', submitLabel: 'Save segment',
      body: '<p class="contact-picker-intro">Save the current filters, exact custom-field value and sort order. The segment updates as contacts change.</p><label class="contact-edit-field"><span class="form-label">Segment name *</span><input class="form-input" name="name" maxlength="80" required autocomplete="off"></label>',
      onSubmit: async form => {
        const saved = await ContactSegments.create({ name: form.get('name'), filters: currentContactFilters() });
        _segments = await ContactSegments.list();
        _activeSegmentId = String(saved.id);
        _segmentDirty = false;
        await _renderLeadsView(container);
        notify(`Saved segment “${saved.name}”.`);
      },
    });
  } catch (error) {
    notify(error.message || 'Could not save this segment.', 'error');
  }
}

async function deleteContactSegment(container) {
  const segment = _segments.find(item => String(item.id) === String(_activeSegmentId));
  if (!segment || !await confirmAction({ title: `Delete segment “${segment.name}”?`, message: 'Contacts and campaign history are unchanged.', confirmLabel: 'Delete segment', danger: true })) return;
  try {
    await ContactSegments.remove(segment.id);
    _segments = await ContactSegments.list();
    _activeSegmentId = '';
    _segmentDirty = false;
    _filters = emptyLeadFilters();
    _sortBy = 'discovered_at';
    _sortOrder = 'desc';
    resetLeadPaging();
    await _renderLeadsView(container);
    notify(`Deleted segment “${segment.name}”. Contacts and campaign history are unchanged.`);
  } catch (error) {
    notify(error.message || 'Could not delete this segment.', 'error');
  }
}

function renderCustomFieldInput(field, value) {
  const inputName = `custom_field__${field.fieldKey}`;
  const label = `${escapeHtml(field.name)}${field.required ? ' *' : ''}`;
  const required = field.required ? ' required' : '';
  if (field.type === 'boolean' || field.type === 'select') {
    const options = field.type === 'boolean' ? [['true', 'Yes'], ['false', 'No']] : field.options.map(option => [option, option]);
    return `<label class="contact-edit-field"><span class="form-label">${label}</span><select class="filter-select" name="${inputName}"${required}><option value="">Choose…</option>${options.map(([option, text]) => `<option value="${escapeHtml(option)}" ${String(value) === option ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
  const extra = field.type === 'number' ? ' step="any" min="-1000000000000" max="1000000000000"' : field.type === 'text' ? ' maxlength="5000"' : '';
  return `<label class="contact-edit-field"><span class="form-label">${label}</span><input class="form-input" type="${type}" name="${inputName}" value="${escapeHtml(value ?? '')}"${extra}${required} autocomplete="off"></label>`;
}

async function openContactFieldManager(container) {
  const list = await ContactFields.list(true);
  let definitions = list.fields || [];
  _customFields = definitions;
  let definitionsChanged = false;
  const dialog = openDialog({
    title: 'Custom contact fields', eyebrow: 'CONTACT DATA MODEL',
    body: '<p class="contact-picker-intro">Custom fields are stored separately from lifecycle, suppression, verification and send-system fields. Field types and stable keys cannot be changed after creation; existing contact values remain attached when a field is archived.</p><div data-contact-field-manager></div>',
  });
  const root = dialog.querySelector('[data-contact-field-manager]');

  function render() {
    const activeCount = definitions.filter(field => field.status === 'active').length;
    root.innerHTML = `<div class="contact-field-create"><h3>Add a field</h3><div class="contact-field-manager-grid"><label><span class="form-label">Field name *</span><input class="form-input" name="new_name" maxlength="50" autocomplete="off"></label><label><span class="form-label">Type *</span><select class="filter-select" name="new_type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option><option value="select">Single select</option></select></label><label class="contact-field-options" hidden><span class="form-label">Options (one per line, 2–30)</span><textarea class="form-input" name="new_options" rows="3" maxlength="3029"></textarea></label><label class="contact-field-required"><input type="checkbox" name="new_required"><span>Required on new contacts and imports</span></label><button type="button" class="btn btn-primary btn-sm" data-create-field ${activeCount >= 30 ? 'disabled' : ''}>Create field</button></div><p class="contact-field-limit">${activeCount} of 30 active fields</p></div><div class="contact-field-list">${definitions.length ? definitions.map(field => `<article class="contact-field-card ${field.status === 'archived' ? 'is-archived' : ''}" data-field-card="${field.id}"><div class="contact-field-card-head"><strong>${escapeHtml(field.name)}</strong><span>${escapeHtml(field.type)}${field.required ? ' · required' : ''}${field.status === 'archived' ? ' · archived' : ''}</span></div>${field.status === 'active' ? `<div class="contact-field-manager-grid"><label><span class="form-label">Display name</span><input class="form-input" data-field-name value="${escapeHtml(field.name)}" maxlength="50"></label>${field.type === 'select' ? `<label><span class="form-label">Options (one per line)</span><textarea class="form-input" data-field-options rows="3" maxlength="3029">${escapeHtml(field.options.join('\n'))}</textarea></label>` : ''}<label class="contact-field-required"><input type="checkbox" data-field-required ${field.required ? 'checked' : ''}><span>Required</span></label><div class="contact-field-actions"><button type="button" class="btn btn-ghost btn-sm" data-save-field>Save changes</button><button type="button" class="btn btn-ghost btn-sm" data-archive-field>Archive</button></div></div>` : '<p class="contact-field-archived-note">Archived fields stay visible on existing contacts and can no longer be edited or assigned.</p>'}</article>`).join('') : '<p class="text-muted">No custom fields yet.</p>'}</div>`;
    const typePicker = root.querySelector('[name="new_type"]');
    const options = root.querySelector('.contact-field-options');
    typePicker.addEventListener('change', () => { options.hidden = typePicker.value !== 'select'; });
    root.querySelector('[data-create-field]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const type = typePicker.value;
        const values = {
          name: root.querySelector('[name="new_name"]').value,
          type,
          required: root.querySelector('[name="new_required"]').checked,
          ...(type === 'select' ? { options: root.querySelector('[name="new_options"]').value.split(/\r?\n/) } : {}),
        };
        await ContactFields.create(values);
        definitions = (await ContactFields.list(true)).fields || [];
        _customFields = definitions;
        definitionsChanged = true;
        render();
        notify('Custom field created.');
      } catch (error) { notify(error.message || 'Could not create the custom field.', 'error'); }
      finally { if (button.isConnected) button.disabled = false; }
    });
    root.querySelectorAll('[data-field-card]').forEach(card => {
      const id = card.dataset.fieldCard;
      card.querySelector('[data-save-field]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const field = definitions.find(item => String(item.id) === id);
          const updates = {
            name: card.querySelector('[data-field-name]').value,
            required: card.querySelector('[data-field-required]').checked,
            ...(field.type === 'select' ? { options: card.querySelector('[data-field-options]').value.split(/\r?\n/) } : {}),
          };
          await ContactFields.update(id, updates);
          definitions = (await ContactFields.list(true)).fields || [];
          _customFields = definitions;
          definitionsChanged = true;
          render();
          notify('Custom field updated.');
        } catch (error) { notify(error.message || 'Could not update the custom field.', 'error'); }
        finally { if (button.isConnected) button.disabled = false; }
      });
      card.querySelector('[data-archive-field]')?.addEventListener('click', async event => {
        if (!await confirmAction({ title: 'Archive contact field', message: 'Its stored contact values will be retained and remain visible on existing contacts.', confirmLabel: 'Archive field', danger: true })) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await ContactFields.archive(id);
          definitions = (await ContactFields.list(true)).fields || [];
          _customFields = definitions;
          definitionsChanged = true;
          render();
          notify('Custom field archived; existing values were retained.');
        } catch (error) { notify(error.message || 'Could not archive the custom field.', 'error'); }
        finally { if (button.isConnected) button.disabled = false; }
      });
    });
  }

  dialog.addEventListener('close', () => {
    if (!definitionsChanged || !container.isConnected) return;
    _customFields = definitions;
    void _renderLeadsView(container);
  }, { once: true });
  render();
}

async function openContactCreator(container) {
  const customFields = (await ContactFields.list()).fields || [];
  const openBatches = _batches.filter(batch => batch.status === 'open');
  const fields = [
    ['business_name', 'Business name', '', 'text', true],
    ['email', 'Email address', '', 'email', false],
    ['category', 'Category', '', 'text', false],
    ['phone', 'Phone', '', 'tel', false],
    ['city', 'City', '', 'text', false],
    ['state', 'State / region', '', 'text', false],
    ['country', 'Country', '', 'text', false],
    ['address', 'Street address', '', 'text', false],
    ['website_url', 'Website', '', 'url', false],
    ['facebook_url', 'Facebook page', '', 'url', false],
  ];
  const provenanceFields = [
    ['source_details', 'Source details', '', 'text'],
    ['source_url', 'Source URL', '', 'url'],
    ['consent_recorded_at', 'Consent evidence date', '', 'date'],
    ['consent_method', 'Consent method / context', '', 'text'],
    ['consent_evidence_url', 'Consent evidence URL', '', 'url'],
  ];
  const batchPicker = openBatches.length
    ? `<label class="contact-edit-field"><span class="form-label">Open batch *</span><select class="filter-select" name="batch_id" required>${openBatches.map(batch => `<option value="${batch.id}">${escapeHtml(batch.name || `Batch #${batch.id}`)}</option>`).join('')}</select></label>`
    : `<div class="contact-create-no-batch"><p>No open batch is available. Contacts are added to an open batch to preserve their workflow history.</p><button type="button" class="btn btn-ghost btn-sm" onclick="window.__nav('batches')">Go to batches</button></div>`;

  openDialog({
    title: 'Add a contact', eyebrow: 'CONTACT RECORD', submitLabel: 'Create contact',
    body: `<p class="contact-picker-intro">Add the contact to an open batch. Email addresses are saved as unverified; this form does not run verification or send mail. Source and consent evidence are operator-entered and are not independently verified. An empty consent date means no evidence was recorded; these fields do not override suppression.</p><div class="contact-edit-grid">${batchPicker}${fields.map(([name, label, value, type, required]) => `<label class="contact-edit-field"><span class="form-label">${label}${required ? ' *' : ''}</span><input class="form-input" type="${type}" name="${name}" value="${escapeHtml(value)}" maxlength="${name === 'address' || name.endsWith('_url') ? 2000 : name === 'email' ? 320 : 500}" ${required ? 'required' : ''} autocomplete="off"></label>`).join('')}${provenanceFields.map(([name, label, value, type]) => `<label class="contact-edit-field"><span class="form-label">${label}</span><input class="form-input" type="${type}" name="${name}" value="${escapeHtml(value)}" maxlength="${name.endsWith('_url') ? 2000 : name === 'source_details' ? 500 : 160}" autocomplete="off"></label>`).join('')}${customFields.map(field => renderCustomFieldInput(field, null)).join('')}</div>`,
    onSubmit: async form => {
      if (!openBatches.length) throw new Error('Create an open batch before adding a contact.');
      const contact = Object.fromEntries([...fields, ...provenanceFields].map(([name]) => [name, form.get(name)]));
      contact.batch_id = Number(form.get('batch_id'));
      contact.custom_fields = Object.fromEntries(customFields.map(field => [field.fieldKey, form.get(`custom_field__${field.fieldKey}`) ?? '']));
      const created = await Leads.create(contact);
      _filters = { ...emptyLeadFilters(), batch_id: String(created.contact.batch_id) };
      _activeSegmentId = '';
      _segmentDirty = false;
      resetLeadPaging();
      await _renderLeadsView(container);
      await window.__leadDetail(created.contact.id);
      notify(created.verificationRequired
        ? 'Contact created. Its email is unverified; verify it before campaign sending.'
        : 'Contact created without an email address.');
    },
  });
}

function businessSearchJobHtml(job, selectedResultIds = new Set()) {
  const results = (job.results || []).map(result => {
    const href = safeHttpHref(result.url);
    const selected = selectedResultIds.has(Number(result.id));
    return `<article class="business-search-result"><label><input type="checkbox" data-search-result-check value="${Number(result.id)}" ${selected ? 'checked' : ''} ${result.imported_lead_id ? 'disabled' : ''}><span><strong>${escapeHtml(result.title)}</strong><small>Page ${fmtNum(result.page_number || job.page_number || 1)} · ${escapeHtml(result.canonical_domain)}${result.engine ? ` · ${escapeHtml(result.engine)}` : ''}${result.imported_lead_id ? ' · already imported' : ''}</small></span></label>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ''}<p>${escapeHtml(result.snippet || 'No search-result summary provided.')}</p></article>`;
  }).join('');
  const canImport = job.status === 'completed' && (selectedResultIds.size > 0 || (job.results || []).some(result => !result.imported_lead_id));
  const pageHistory = job.pages?.length > 1 ? `<div class="business-search-pages" aria-label="Search result pages">${job.pages.map(page => `<button type="button" class="btn btn-ghost btn-sm" data-open-search-page="${Number(page.id)}" aria-current="${Number(page.id) === Number(job.id) ? 'page' : 'false'}">Page ${fmtNum(page.page_number)} · ${escapeHtml(page.status)} · ${fmtNum(page.result_count)} new</button>`).join('')}</div>` : '';
  const more = job.status === 'completed' && job.has_more
    ? `<div class="business-search-import"><small>The provider returned results for this page. Continue when you want more candidates.</small><button type="button" class="btn btn-secondary btn-sm" data-next-search-page="${Number(job.id)}">Load results page ${Number(job.next_page_number || job.page_number + 1)}</button></div>` : '';
  return `<section class="business-search-job"><div class="website-discovery-progress-top"><div><strong>${escapeHtml(job.status)} · page ${fmtNum(job.page_number || 1)}</strong><span>Query: ${escapeHtml(job.query)}</span></div><span>${fmtNum(job.result_count || 0)} public website candidate(s) on this page · ${fmtNum(job.rejected_result_count || 0)} skipped</span></div>${pageHistory}${job.error_code ? `<p class="contact-import-preview-error" role="status">Search stopped: ${escapeHtml(job.error_code.replaceAll('_', ' '))}</p>` : ''}${results ? `<div class="business-search-results">${results}</div>` : `<p class="website-discovery-none">${job.status === 'completed' ? 'No new eligible public websites were returned on this page.' : 'No result records were saved for this run.'}</p>`}${more}${canImport ? `<div class="business-search-import"><small>Selections are kept as you review pages in this search. Import starts a polite, robots-aware scan; addresses remain unverified.</small><button type="button" class="btn btn-primary btn-sm" data-import-search-results="${Number(job.id)}">Add ${selectedResultIds.size ? `${fmtNum(selectedResultIds.size)} selected and scan` : 'selected and scan'}</button></div>` : ''}</section>`;
}

async function openBusinessSearchDialog(container) {
  const openBatches = _batches.filter(batch => batch.status === 'open');
  const selectedBatch = openBatches.find(batch => String(batch.id) === String(_filters.batch_id)) || openBatches[0];
  const [provider, jobs] = await Promise.all([
    Leads.getSearchProvider(),
    Leads.listBusinessSearchJobs(selectedBatch?.id, 8),
  ]);
  const canManageProvider = ['owner', 'admin'].includes(window.__workspaceRole);
  const batchPicker = openBatches.length
    ? `<label class="contact-edit-field"><span class="form-label">Open batch *</span><select class="filter-select" name="batch_id" required>${openBatches.map(batch => `<option value="${batch.id}" ${selectedBatch?.id === batch.id ? 'selected' : ''}>${escapeHtml(batch.name || `Batch #${batch.id}`)}</option>`).join('')}</select></label>`
    : `<div class="contact-create-no-batch"><p>Create an open batch before collecting search results.</p><button type="button" class="btn btn-ghost btn-sm" onclick="window.__nav('batches')">Go to batches</button></div>`;
  const savedJobs = jobs.length
    ? `<section class="website-discovery-saved"><h3>Recent business searches</h3><div class="website-discovery-job-list">${jobs.map(job => `<button type="button" class="website-discovery-job-link" data-open-search-job="${job.id}"><span><strong>Search #${job.id} · ${fmtNum(job.page_count || 1)} page(s)</strong><small>${escapeHtml(job.query)} · ${fmtNum(job.result_count_saved || 0)} websites · ${fmtNum(job.imported_count || 0)} imported</small></span><b>${escapeHtml(job.status)}</b></button>`).join('')}</div></section>`
    : '';
  const dialog = openDialog({
    title: 'Search for businesses', eyebrow: 'SELF-HOSTED PUBLIC SEARCH',
    body: `<p class="contact-picker-intro">Search through your configured SearXNG instance. The query is sent to that instance and its enabled search engines. Results are saved for review; nothing enters Contacts until you select websites. Selected sites go through the existing robots and network-safety checks. Search results and extracted addresses are not consent to email.</p><section class="business-search-provider"><div class="business-search-provider-heading"><div><h3>SearXNG connection</h3><p data-search-provider-status role="status"></p></div>${canManageProvider ? '<button type="button" class="btn btn-ghost btn-sm" data-test-search-provider>Test JSON search</button>' : ''}</div>${canManageProvider ? `<label class="contact-edit-field"><span class="form-label">HTTPS instance base URL</span><input class="form-input" type="url" name="search_endpoint" maxlength="2048" autocomplete="url" placeholder="https://search.your-domain.example" value="${escapeHtml(provider.endpoint_url || '')}"><small>Use your own HTTPS SearXNG instance. Enable JSON under <code>search.formats</code>.</small></label><label class="contact-edit-field"><span class="form-label">Optional proxy bearer token</span><input class="form-input" type="password" name="search_api_token" maxlength="2048" autocomplete="new-password" placeholder="Leave blank to keep the saved token"><small>The token is encrypted at rest and never returned to the browser. Changing the instance clears the old token.</small></label><label class="business-search-clear-token"><input type="checkbox" name="clear_search_api_token"> Clear the saved token</label><div class="business-search-provider-actions"><button type="button" class="btn btn-secondary btn-sm" data-save-search-provider>Save connection</button></div>` : '<p class="website-discovery-policy-note">Only workspace owners and admins can change the SearXNG endpoint.</p>'}</section><section class="business-search-query"><h3>Find company websites</h3><div class="business-search-start-grid">${batchPicker}<label class="contact-edit-field"><span class="form-label">Industry, location, and business keywords</span><textarea class="form-input" name="search_query" rows="3" maxlength="300" placeholder="packaging manufacturers Ahmedabad India"></textarea></label></div><button type="button" class="btn btn-primary btn-sm" data-run-business-search ${openBatches.length ? '' : 'disabled'}>Search public web</button></section><section data-business-search-current aria-live="polite"><p class="website-discovery-none">Run one bounded query. Up to 30 distinct public website candidates are saved per page; selections carry across reviewed pages.</p></section>${savedJobs}`,
  });
  const statusNode = dialog.querySelector('[data-search-provider-status]');
  const renderProvider = value => {
    const authentication = value.authentication === 'bearer_configured' ? 'Bearer token saved' : 'No token';
    statusNode.textContent = value.configured ? `Configured · ${value.endpoint_url} · ${authentication}` : 'Not configured. Add your own HTTPS SearXNG instance to begin.';
  };
  renderProvider(provider);
  const current = dialog.querySelector('[data-business-search-current]');
  let activeJob = null;
  let busy = false;
  let selectedSearchRootId = null;
  const selectedSearchResultIds = new Set();
  const showSearchPage = async id => {
    const page = await Leads.getBusinessSearchJob(id);
    const rootId = Number(page.root_job_id || page.id);
    if (selectedSearchRootId !== null && selectedSearchRootId !== rootId) selectedSearchResultIds.clear();
    selectedSearchRootId = rootId;
    activeJob = page;
    current.innerHTML = businessSearchJobHtml(activeJob, selectedSearchResultIds);
  };

  dialog.querySelector('[data-save-search-provider]')?.addEventListener('click', async event => {
    if (busy) return;
    busy = true;
    const button = event.currentTarget; button.disabled = true;
    try {
      const token = dialog.querySelector('[name="search_api_token"]').value;
      const response = await Leads.saveSearchProvider({
        endpoint_url: dialog.querySelector('[name="search_endpoint"]').value,
        ...(token ? { api_token: token } : {}),
        clear_api_token: dialog.querySelector('[name="clear_search_api_token"]').checked,
      });
      renderProvider(response.settings);
      dialog.querySelector('[name="search_api_token"]').value = '';
      dialog.querySelector('[name="clear_search_api_token"]').checked = false;
      notify('SearXNG connection saved.');
    } catch (error) { notify(error.message || 'Search connection could not be saved.', 'error'); }
    finally { busy = false; button.disabled = false; }
  });

  dialog.querySelector('[data-test-search-provider]')?.addEventListener('click', async event => {
    if (busy) return;
    busy = true;
    const button = event.currentTarget; button.disabled = true;
    try {
      const result = await Leads.testSearchProvider();
      notify(`SearXNG JSON search works; ${fmtNum(result.accepted_results)} public websites passed the result filter.`);
    } catch (error) { notify(error.message || 'SearXNG connection test failed.', 'error'); }
    finally { busy = false; button.disabled = false; }
  });

  dialog.querySelector('[data-run-business-search]')?.addEventListener('click', async event => {
    if (busy) return;
    const batchId = Number(dialog.querySelector('[name="batch_id"]')?.value);
    const query = dialog.querySelector('[name="search_query"]')?.value || '';
    if (!Number.isSafeInteger(batchId) || batchId < 1) { notify('Choose an open batch first.', 'error'); return; }
    if (query.trim().length < 3) { notify('Enter at least three characters for a business search.', 'error'); return; }
    busy = true;
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Searching…';
    try {
      activeJob = await Leads.searchBusinesses({ batch_id: batchId, query });
      selectedSearchResultIds.clear();
      selectedSearchRootId = Number(activeJob.root_job_id || activeJob.id);
      current.innerHTML = businessSearchJobHtml(activeJob, selectedSearchResultIds);
      if (activeJob.status === 'completed') notify(`${fmtNum(activeJob.result_count)} public website candidate(s) saved for review.`);
      else notify(`Search did not finish: ${String(activeJob.error_code || 'provider failure').replaceAll('_', ' ')}.`, 'error');
      const refreshed = await Leads.listBusinessSearchJobs(batchId, 8);
      dialog.querySelector('.website-discovery-saved')?.remove();
      if (refreshed.length) {
        const history = document.createElement('section');
        history.className = 'website-discovery-saved';
        history.innerHTML = `<h3>Recent business searches</h3><div class="website-discovery-job-list">${refreshed.map(job => `<button type="button" class="website-discovery-job-link" data-open-search-job="${job.id}"><span><strong>Search #${job.id} · ${fmtNum(job.page_count || 1)} page(s)</strong><small>${escapeHtml(job.query)} · ${fmtNum(job.result_count_saved || 0)} websites · ${fmtNum(job.imported_count || 0)} imported</small></span><b>${escapeHtml(job.status)}</b></button>`).join('')}</div>`;
        dialog.querySelector('.business-search-query').after(history);
      }
    } catch (error) { notify(error.message || 'Business search could not be completed.', 'error'); }
    finally { busy = false; button.disabled = false; button.textContent = 'Search public web'; }
  });

  dialog.addEventListener('click', async event => {
    const nextPageButton = event.target.closest('[data-next-search-page]');
    if (nextPageButton && !busy) {
      busy = true; nextPageButton.disabled = true; nextPageButton.textContent = 'Loading…';
      try {
        activeJob = await Leads.nextBusinessSearchPage(nextPageButton.dataset.nextSearchPage);
        const rootId = Number(activeJob.root_job_id || activeJob.id);
        if (selectedSearchRootId !== null && selectedSearchRootId !== rootId) selectedSearchResultIds.clear();
        selectedSearchRootId = rootId;
        current.innerHTML = businessSearchJobHtml(activeJob, selectedSearchResultIds);
        notify(`Search page ${fmtNum(activeJob.page_number)} saved with ${fmtNum(activeJob.result_count)} new website candidate(s).`);
      } catch (error) { notify(error.message || 'Next search page could not be loaded.', 'error'); }
      finally { busy = false; if (nextPageButton.isConnected) { nextPageButton.disabled = false; nextPageButton.textContent = `Load results page ${Number(activeJob?.next_page_number || 2)}`; } }
      return;
    }
    const openJobButton = event.target.closest('[data-open-search-job]');
    if (openJobButton && !busy) {
      busy = true; openJobButton.disabled = true;
      try { await showSearchPage(openJobButton.dataset.openSearchJob); }
      catch (error) { notify(error.message || 'Saved search could not be opened.', 'error'); }
      finally { busy = false; openJobButton.disabled = false; }
      return;
    }
    const openPageButton = event.target.closest('[data-open-search-page]');
    if (openPageButton && !busy) {
      busy = true; openPageButton.disabled = true;
      try { await showSearchPage(openPageButton.dataset.openSearchPage); }
      catch (error) { notify(error.message || 'Search results page could not be opened.', 'error'); }
      finally { busy = false; openPageButton.disabled = false; }
      return;
    }
    const importButton = event.target.closest('[data-import-search-results]');
    if (!importButton || busy || !activeJob) return;
    const selected = [...selectedSearchResultIds];
    if (!selected.length) { notify('Select at least one public website to scan.', 'error'); return; }
    if (selected.length > 25) { notify('Select no more than 25 websites per scan job.', 'error'); return; }
    busy = true; importButton.disabled = true; importButton.textContent = 'Adding sites…';
    try {
      const result = await Leads.importBusinessSearchResults(importButton.dataset.importSearchResults, selected);
      if (!result.website_discovery_job) {
        notify(`${fmtNum(result.already_imported_count)} selected website(s) were already imported.`);
        activeJob = await Leads.getBusinessSearchJob(activeJob.id);
        current.innerHTML = businessSearchJobHtml(activeJob, selectedSearchResultIds);
        return;
      }
      selectedSearchResultIds.clear();
      const jobId = result.website_discovery_job.id;
      dialog.close();
      notify(`${fmtNum(result.imported_count)} selected website(s) were added to Contacts and scanning began.`);
      await openWebsiteDiscoveryProgress(container, jobId);
    } catch (error) { notify(error.message || 'Selected search results could not be imported.', 'error'); }
    finally { busy = false; if (importButton.isConnected) { importButton.disabled = false; importButton.textContent = 'Add selected and scan'; } }
  });
  dialog.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-search-result-check]');
    if (!checkbox) return;
    const id = Number(checkbox.value);
    if (checkbox.checked) selectedSearchResultIds.add(id);
    else selectedSearchResultIds.delete(id);
    const importButton = current.querySelector('[data-import-search-results]');
    if (importButton) importButton.textContent = `Add ${selectedSearchResultIds.size ? `${fmtNum(selectedSearchResultIds.size)} selected and scan` : 'selected and scan'}`;
  });
}

async function openWebsiteDiscoveryDialog(container) {
  const openBatches = _batches.filter(batch => batch.status === 'open');
  const selectedBatch = openBatches.find(batch => String(batch.id) === String(_filters.batch_id)) || openBatches[0];
  const [jobs, epchJobs] = await Promise.all([
    Leads.listWebsiteDiscoveryJobs(selectedBatch?.id, 12),
    Leads.listDirectoryJobs(selectedBatch?.id, 8),
  ]);
  const batchPicker = openBatches.length
    ? `<label class="contact-edit-field"><span class="form-label">Open batch *</span><select class="filter-select" name="batch_id" required>${openBatches.map(batch => `<option value="${batch.id}" ${selectedBatch?.id === batch.id ? 'selected' : ''}>${escapeHtml(batch.name || `Batch #${batch.id}`)}</option>`).join('')}</select></label>`
    : `<div class="contact-create-no-batch"><p>Create an open batch before collecting business records.</p><button type="button" class="btn btn-ghost btn-sm" onclick="window.__nav('batches')">Go to batches</button></div>`;
  const savedJobs = jobs.length
    ? `<section class="website-discovery-saved"><h3>Recent collection jobs</h3><div class="website-discovery-job-list">${jobs.map(job => `<button type="button" class="website-discovery-job-link" data-open-discovery-job="${job.id}"><span><strong>Job #${job.id}</strong><small>${fmtNum(job.completed_count || 0)} of ${fmtNum(job.task_count)} sites complete · ${fmtNum(job.failed_count || 0)} failed · ${escapeHtml(job.created_at || '')}</small></span><b>${escapeHtml(job.status.replaceAll('_', ' '))}</b></button>`).join('')}</div></section>`
    : '';
  const savedEpchJobs = epchJobs.length
    ? `<section class="website-discovery-saved"><h3>Recent directory imports</h3><div class="website-discovery-job-list">${epchJobs.map(job => `<button type="button" class="website-discovery-job-link" data-open-epch-job="${job.id}"><span><strong>${escapeHtml(job.source_name || 'Business directory')} · job #${job.id}</strong><small>${fmtNum(job.pages_completed || 0)} pages · ${fmtNum(job.businesses_created || 0)} businesses · ${fmtNum(job.emails_created || 0)} addresses</small></span><b>${escapeHtml(job.status.replaceAll('_', ' '))}</b></button>`).join('')}</div></section>`
    : '';
  const dialog = openDialog({
    title: 'Find businesses', eyebrow: 'PUBLIC BUSINESS RESEARCH', submitLabel: openBatches.length ? 'Start discovery' : undefined,
    body: `<p class="contact-picker-intro">Queue public company websites for a polite one-time scan. Each business is saved to the selected batch, robots.txt is checked, requests stay on the supplied public site, and extracted addresses remain unverified. No email is sent. Use one business per line in this format:</p><code class="website-discovery-format">Business name | https://company.example | category | city | state | country</code><div class="website-discovery-start-grid">${batchPicker}<label class="contact-edit-field website-discovery-seeds"><span class="form-label">Businesses and websites *</span><textarea class="form-input" name="businesses" rows="7" required placeholder="North Star Workshop | https://northstar.example\nExample Exporters | https://exporters.example | Textiles | Jaipur | Rajasthan | India"></textarea><small>No per-job site-count cap. Each request is limited to 5 MiB; job results are reviewed 100 sites at a time.</small></label></div><section class="website-discovery-saved"><h3>Public business directories</h3><p class="website-discovery-policy-note">Import either directory explicitly. Each adapter checks robots.txt, uses bounded same-origin requests, and stops on denial, throttling, or layout change. Published emails remain unverified, and a public listing is not consent to send. Imports do not scan company websites.</p><label class="contact-edit-field"><span class="form-label">Maximum EPCH pages</span><input class="form-input" name="epch_page_limit" type="number" min="1" max="50" step="1" value="5" required><small>1–50 pages per EPCH run. Continue adds five pages at a time.</small></label><div class="website-discovery-controls"><button type="button" class="btn btn-secondary btn-sm" data-import-epch ${openBatches.length ? '' : 'disabled'}>Import EPCH member directory</button><button type="button" class="btn btn-secondary btn-sm" data-import-cbam ${openBatches.length ? '' : 'disabled'}>Import EEPC CBAM advisory directory</button></div></section>${savedJobs}${savedEpchJobs}`,
    onSubmit: async form => {
      if (!openBatches.length) throw new Error('Create an open batch before starting discovery.');
      const lines = String(form.get('businesses') || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (!lines.length) throw new Error('Add at least one business website line.');
      const businesses = lines.map((line, index) => {
        const columns = line.split('|').map(value => value.trim());
        if (columns.length < 2 || columns.length > 6 || !columns[0] || !columns[1]) {
          throw new Error(`Line ${index + 1} must use “Business name | Website URL” with up to four optional profile fields.`);
        }
        return {
          business_name: columns[0], website_url: columns[1], category: columns[2] || undefined,
          city: columns[3] || undefined, state: columns[4] || undefined, country: columns[5] || undefined,
        };
      });
      const batch_id = Number(form.get('batch_id'));
      if (new TextEncoder().encode(JSON.stringify({ batch_id, businesses })).byteLength > 5 * 1024 * 1024) {
        throw new Error('This request exceeds the 5 MiB safety limit. Split the site list across multiple discovery jobs.');
      }
      const job = await Leads.createWebsiteDiscoveryJob({ batch_id, businesses });
      notify(`Discovery job #${job.id} started. Contacts are saved as each site finishes.`);
      setTimeout(() => { void openWebsiteDiscoveryProgress(container, job.id).catch(error => notify(error.message, 'error')); }, 0);
    },
  });
  dialog.querySelectorAll('[data-open-discovery-job]').forEach(button => button.addEventListener('click', () => {
    void openWebsiteDiscoveryProgress(container, button.dataset.openDiscoveryJob).catch(error => notify(error.message, 'error'));
  }));
  dialog.querySelectorAll('[data-open-epch-job]').forEach(button => button.addEventListener('click', () => {
    void openEpchDirectoryProgress(container, button.dataset.openEpchJob).catch(error => notify(error.message, 'error'));
  }));
  dialog.querySelector('[data-import-epch]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const batchId = Number(dialog.querySelector('[name="batch_id"]')?.value);
    const pageLimit = Number(dialog.querySelector('[name="epch_page_limit"]')?.value);
    if (!Number.isSafeInteger(batchId) || batchId < 1) { notify('Choose an open batch first.', 'error'); return; }
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) {
      notify('Choose an EPCH page cap from 1 to 50.', 'error'); return;
    }
    button.disabled = true;
    try {
      const job = await Leads.createDirectoryJob({ batch_id: batchId, page_limit: pageLimit, source_id: 'epch' });
      notify(`EPCH directory job #${job.id} queued. It will stop safely if source rules are unavailable.`);
      void openEpchDirectoryProgress(container, job.id).catch(error => notify(error.message, 'error'));
    } catch (error) {
      notify(error.message || 'EPCH directory import could not be started.', 'error');
      button.disabled = false;
    }
  });
  dialog.querySelector('[data-import-cbam]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const batchId = Number(dialog.querySelector('[name="batch_id"]')?.value);
    if (!Number.isSafeInteger(batchId) || batchId < 1) { notify('Choose an open batch first.', 'error'); return; }
    button.disabled = true;
    try {
      const job = await Leads.createDirectoryJob({ batch_id: batchId, source_id: 'eepc_cbam' });
      notify(`EEPC CBAM directory job #${job.id} queued. The import will stop if robots or source checks fail.`);
      void openEpchDirectoryProgress(container, job.id).catch(error => notify(error.message, 'error'));
    } catch (error) {
      notify(error.message || 'EEPC CBAM directory import could not be started.', 'error');
      button.disabled = false;
    }
  });
}

function epchRecordHtml(record, selectedLeadIds = new Set()) {
  const emails = record.emails || [];
  const websiteHref = safeHttpHref(record.website_url);
  const leadId = Number(record.lead_id);
  const selectable = websiteHref && Number.isSafeInteger(leadId) && leadId > 0
    ? `<label class="website-discovery-select"><input type="checkbox" data-epch-select-website="${leadId}" aria-label="Select ${escapeHtml(record.business_name || 'directory record')} for website email scan" ${selectedLeadIds.has(leadId) ? 'checked' : ''}><span>Select for website scan</span></label>` : '';
  const scanAction = websiteHref && Number.isSafeInteger(leadId) && leadId > 0
    ? `<button type="button" class="btn btn-ghost btn-sm" data-epch-scan-website="${leadId}">Find emails from website</button>` : '';
  return `<article class="website-discovery-task"><div class="website-discovery-task-heading"><div><strong>${escapeHtml(record.business_name || 'Directory record')}</strong>${record.contact_person_name ? `<small>${escapeHtml(record.contact_person_name)}${record.contact_title ? ` · ${escapeHtml(record.contact_title)}` : ''}</small>` : record.contact_title ? `<small>${escapeHtml(record.contact_title)}</small>` : ''}${websiteHref ? `<a href="${escapeHtml(websiteHref)}" target="_blank" rel="noopener noreferrer">Company website ↗</a>` : ''}${selectable}${scanAction}<a href="${escapeHtml(safeHttpHref(record.source_url) || '#')}" ${safeHttpHref(record.source_url) ? 'target="_blank" rel="noopener noreferrer"' : ''}>View source record</a></div><span class="website-discovery-status is-completed">${escapeHtml(record.status)}</span></div><small>${escapeHtml([record.city, record.state, record.country].filter(Boolean).join(', ') || 'Location not listed')}${record.category ? ` · ${escapeHtml(record.category)}` : ''}</small>${emails.length ? `<ul class="website-discovery-email-list">${emails.map(email => `<li><strong>${escapeHtml(email)}</strong><span class="website-discovery-unverified">unknown · not verified · do not send without separate authorization</span></li>`).join('')}</ul>` : '<p class="website-discovery-none">No unsuppressed email address was imported for this record.</p>'}<small>${escapeHtml(record.raw_excerpt || '')}</small></article>`;
}

async function openEpchDirectoryProgress(container, jobId) {
  const initial = await Leads.getDirectoryJob(jobId);
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
  const sourceTitle = initial.source_id === 'eepc_cbam' ? 'EEPC CBAM directory' : 'EPCH directory';
  const dialog = openDialog({
    title: `${sourceTitle} job #${initial.id}`, eyebrow: 'PUBLIC DIRECTORY IMPORT',
    body: '<section class="website-discovery-progress" data-epch-directory-progress aria-live="polite"></section>',
  });
  const root = dialog.querySelector('[data-epch-directory-progress]');
  let busy = false;
  let stopped = false;
  let latestJob = initial;
  let cooldownTimer = null;
  const selectedLeadIds = new Set();
  const render = job => {
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = null;
    latestJob = job;
    const progress = job.progress || {};
    const status = ['queued', 'running', 'pause_requested', 'cancel_requested'].includes(job.status);
    const selectableIds = new Set((job.records || []).filter(record => safeHttpHref(record.website_url)
      && Number.isSafeInteger(Number(record.lead_id)) && Number(record.lead_id) > 0).map(record => Number(record.lead_id)));
    for (const leadId of selectedLeadIds) if (!selectableIds.has(leadId)) selectedLeadIds.delete(leadId);
    const selectedCount = selectedLeadIds.size;
    const rateLimited = job.error_code === 'source_rate_limited';
    const retryAfterAt = rateLimited && Number.isFinite(Date.parse(job.retry_after_at || '')) ? Date.parse(job.retry_after_at) : NaN;
    const cooldownActive = Number.isFinite(retryAfterAt) && retryAfterAt > Date.now();
    const retryNote = rateLimited && Number.isFinite(retryAfterAt)
      ? `<p class="contact-import-preview-error" role="status">The directory host requested a pause. Retry is available after ${escapeHtml(new Date(retryAfterAt).toLocaleString())}. No requests will be made before then.</p>` : '';
    const controls = status
      ? `${job.status === 'running' ? '<button type="button" class="btn btn-ghost btn-sm" data-epch-pause>Pause</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" data-epch-cancel>Cancel after current page</button>`
      : job.status === 'paused' ? '<button type="button" class="btn btn-primary btn-sm" data-epch-resume>Resume</button><button type="button" class="btn btn-ghost btn-sm" data-epch-cancel>Cancel</button>'
        : job.can_extend_pages ? '<button type="button" class="btn btn-primary btn-sm" data-epch-resume>Continue next 5 pages</button>'
          : ['failed', 'partial'].includes(job.status) && ['robots_unavailable', 'member_page_unavailable', 'directory_page_unavailable', 'source_rate_limited'].includes(job.error_code)
          ? `<button type="button" class="btn btn-primary btn-sm" data-epch-retry ${cooldownActive ? 'disabled' : ''}>${cooldownActive ? 'Retry after cooldown' : 'Retry network failure'}</button>` : '';
    const percent = job.status === 'completed' ? 100 : job.page_limit ? Math.min(100, Math.round(100 * progress.pages_completed / job.page_limit)) : 0;
    root.innerHTML = `<div class="website-discovery-progress-top"><div><strong>${escapeHtml(job.status.replaceAll('_', ' '))}</strong><span>${fmtNum(progress.pages_completed || 0)} pages · ${fmtNum(progress.businesses_created || 0)} new businesses · ${fmtNum(progress.emails_created || 0)} new addresses</span></div><span>${fmtNum(progress.duplicates || 0)} duplicates · ${fmtNum(progress.suppressed_emails_skipped || 0)} suppressed skipped</span></div><progress max="100" value="${percent}" aria-label="${percent}% of the page limit processed"></progress>${job.error_code ? `<p class="contact-import-preview-error" role="status">Stopped: ${escapeHtml(job.error_code.replaceAll('_', ' '))}</p>` : ''}${retryNote}<p class="website-discovery-policy-note">Only source pages that pass robots checks are imported. Emails remain unknown. Publication freshness and permission to email are not established. This job never verifies or sends mail.</p><div class="website-discovery-controls"><button type="button" class="btn btn-ghost btn-sm" data-epch-export>Export evidence CSV</button><button type="button" class="btn btn-secondary btn-sm" data-epch-scan-selected ${selectedCount ? '' : 'disabled'}>Find emails from ${fmtNum(selectedCount)} selected sites</button>${controls}</div><p class="website-discovery-policy-note">Select up to 25 saved company websites to queue a guarded email scan. Scans begin only after you click the button.</p><div class="website-discovery-task-list">${job.records?.map(record => epchRecordHtml(record, selectedLeadIds)).join('') || '<p class="website-discovery-none">No directory records imported yet.</p>'}</div>`;
    if (cooldownActive) {
      cooldownTimer = setTimeout(() => { if (dialog.open) render(latestJob); }, Math.min(retryAfterAt - Date.now(), 2_147_000_000));
    }
  };
  render(initial);
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    busy = true;
    button.disabled = true;
    try {
      if (button.matches('[data-epch-pause]')) await Leads.pauseDirectoryJob(jobId);
      else if (button.matches('[data-epch-resume]')) await Leads.resumeDirectoryJob(jobId);
      else if (button.matches('[data-epch-cancel]')) await Leads.cancelDirectoryJob(jobId);
      else if (button.matches('[data-epch-retry]')) await Leads.retryDirectoryJob(jobId);
      else if (button.matches('[data-epch-scan-selected]')) {
        const records = [...selectedLeadIds].map(leadId => (latestJob.records || []).find(item => Number(item.lead_id) === leadId));
        if (!records.length || records.length > 25 || records.some(record => !record || !safeHttpHref(record.website_url))) {
          throw new Error('Select between 1 and 25 records that still have saved company websites.');
        }
        const batchId = Number(latestJob.batch_id);
        if (!Number.isSafeInteger(batchId) || batchId < 1) throw new Error('This directory job has no valid batch.');
        const discoveryJob = await Leads.createWebsiteDiscoveryJob({
          batch_id: batchId,
          businesses: records.map(record => ({
            lead_id: Number(record.lead_id),
            business_name: record.business_name,
            website_url: safeHttpHref(record.website_url),
            category: record.category || undefined,
            city: record.city || undefined,
            state: record.state || undefined,
            country: record.country || undefined,
          })),
        });
        selectedLeadIds.clear();
        dialog.close();
        notify(`Website email discovery for ${records.length} selected businesses queued. Source access checks still apply.`);
        await openWebsiteDiscoveryProgress(container, discoveryJob.id);
        return;
      }
      else if (button.matches('[data-epch-scan-website]')) {
        const leadId = Number(button.dataset.epchScanWebsite);
        const record = (latestJob.records || []).find(item => Number(item.lead_id) === leadId);
        const websiteUrl = safeHttpHref(record?.website_url);
        const batchId = Number(latestJob.batch_id);
        if (!record || !websiteUrl || !Number.isSafeInteger(leadId) || leadId < 1 || !Number.isSafeInteger(batchId) || batchId < 1) {
          throw new Error('This directory record no longer has a valid saved business website. Refresh and try again.');
        }
        const discoveryJob = await Leads.createWebsiteDiscoveryJob({
          batch_id: batchId,
          businesses: [{
            lead_id: leadId,
            business_name: record.business_name,
            website_url: websiteUrl,
            category: record.category || undefined,
            city: record.city || undefined,
            state: record.state || undefined,
            country: record.country || undefined,
          }],
        });
        notify(`Website email discovery for ${record.business_name} queued. Source access checks still apply.`);
        await openWebsiteDiscoveryProgress(container, discoveryJob.id);
        return;
      }
      else if (button.matches('[data-epch-export]')) {
        const { blob, filename } = await Leads.exportDirectoryEvidence(jobId);
        const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify('Directory evidence exported.');
      }
      render(await Leads.getDirectoryJob(jobId));
    } catch (error) { notify(error.message || 'Directory action failed.', 'error'); button.disabled = false; }
    finally { busy = false; }
  });
  root.addEventListener('change', event => {
    const checkbox = event.target.closest('[data-epch-select-website]');
    if (!checkbox) return;
    const leadId = Number(checkbox.dataset.epchSelectWebsite);
    if (checkbox.checked && selectedLeadIds.size >= 25) {
      checkbox.checked = false;
      notify('Select no more than 25 company websites per scan job.', 'error');
      return;
    }
    if (checkbox.checked && Number.isSafeInteger(leadId) && leadId > 0) selectedLeadIds.add(leadId);
    else selectedLeadIds.delete(leadId);
    const button = root.querySelector('[data-epch-scan-selected]');
    if (button) {
      button.disabled = selectedLeadIds.size === 0;
      button.textContent = `Find emails from ${fmtNum(selectedLeadIds.size)} selected sites`;
    }
  });
  const refresh = async () => {
    if (busy || stopped || !dialog.open) return;
    busy = true;
    try {
      const job = await Leads.getDirectoryJob(jobId); render(job);
      if (terminal.has(job.status)) {
        stopped = true; clearInterval(timer);
        if (container.isConnected) { _filters = { ...emptyLeadFilters(), batch_id: String(job.batch_id) }; resetLeadPaging(); await _renderLeadsView(container); }
      }
    } catch (error) { root.innerHTML = `<p class="contact-import-preview-error" role="alert">${escapeHtml(error.message || 'Could not refresh directory progress.')}</p>`; }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void refresh(); }, 1500);
  dialog.addEventListener('close', () => { stopped = true; clearInterval(timer); if (cooldownTimer) clearTimeout(cooldownTimer); }, { once: true });
  if (terminal.has(initial.status)) { stopped = true; clearInterval(timer); }
}

function websiteDiscoveryTaskHtml(task) {
  const refreshLabels = { present: 'Seen on last successful refresh', not_present: 'Not seen on last successful refresh',
    not_rechecked: 'Not rechecked during the latest refresh',
    blocked: 'Not rechecked · access or robots restriction', unavailable: 'Not rechecked · source unavailable',
    missing: 'Not rechecked · source page missing', unsupported: 'Not rechecked · unsupported page type' };
  const emails = new Map();
  for (const item of task.emails || []) {
    const key = String(item.email || '').toLowerCase();
    if (!emails.has(key)) emails.set(key, []);
    emails.get(key).push(item);
  }
  const sourceConflictFor = sources => sources.find(source => source.source_conflict)?.source_conflict;
  const refreshHistoryHtml = source => source.refresh_history?.length
    ? `<details class="contact-source-history"><summary>Refresh history · ${fmtNum(source.refresh_history.length)} generation(s)</summary>${source.refresh_history.map(history => `<span class="contact-email-excerpt">Generation ${Number(history.generation)} · ${escapeHtml(history.status)} · ${escapeHtml(history.state)}${history.observed_at ? ` · ${escapeHtml(relTime(history.observed_at))}` : ''}${history.prior_content_hash ? `<br>Prior content ${escapeHtml(history.prior_content_hash.slice(0, 16))} · ${escapeHtml(history.prior_extractor_version || 'extractor unknown')}` : ''}${history.prior_excerpt ? `<br>Prior excerpt: ${escapeHtml(history.prior_excerpt)}` : ''}${history.current_content_hash ? `<br>Current content ${escapeHtml(history.current_content_hash.slice(0, 16))} · ${escapeHtml(history.current_extractor_version || 'extractor unknown')}` : ''}${history.current_excerpt ? `<br>Current excerpt: ${escapeHtml(history.current_excerpt)}` : ''}</span>`).join('')}</details>`
    : '';
  const evidence = [...emails.entries()].map(([email, sources]) => {
    const conflict = sourceConflictFor(sources);
    const conflictNote = conflict
      ? `<p class="contact-source-conflict" role="status"><strong>Source disagreement · refresh ${Number(conflict.generation)}</strong><br>This address was absent from one successfully refreshed page and present on another. The address remains saved and unverified.</p>`
      : '';
    return `<li><strong>${escapeHtml(email)}</strong><span class="website-discovery-unverified">${escapeHtml(sources[0]?.verification_status || 'unknown')} · not verified</span>${conflictNote}${sources.map(source => `<small>${safeHttpHref(source.source_url) ? `Source: <a href="${escapeHtml(safeHttpHref(source.source_url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.source_url)}</a>` : escapeHtml(source.source_url || 'Source unavailable')}${source.refresh_state ? `<br>${escapeHtml(refreshLabels[source.refresh_state] || 'Not rechecked')}${source.refresh_generation ? ` · generation ${Number(source.refresh_generation)}` : ''}` : ''}${refreshHistoryHtml(source)}${source.contact_points?.map(point => `<br>Contact type: ${escapeHtml(point.contact_type || 'not listed')}${point.contact_name ? ` · Contact: ${escapeHtml(point.contact_name)}` : ''}${point.contact_title ? ` · Role: ${escapeHtml(point.contact_title)}` : ''}`).join('') || ''}${source.raw_excerpt ? `<br>${escapeHtml(source.raw_excerpt)}` : ''}</small>`).join('')}</li>`;
  }).join('');
  const contactFormOutcome = (task.contact_forms || []).map(source => {
    const href = safeHttpHref(source.source_url);
    const result = emails.size
      ? 'A public contact form was observed. No fields were submitted or values collected.'
      : 'No public email was found in scanned pages; a public contact form was observed. No fields were submitted or values collected.';
    return `<p class="website-discovery-contact-form" role="status">${escapeHtml(result)}${href ? ` Source: <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.source_url)}</a>` : ''}${source.content_hash ? ` · Content ${escapeHtml(String(source.content_hash).slice(0, 16))}` : ''}</p>`;
  }).join('');
  const retryAfterAt = task.retry_after_at || task.scan_retry_after_at || null;
  const retryAtMs = retryAfterAt ? Date.parse(retryAfterAt) : NaN;
  const rateLimitNote = Number.isFinite(retryAtMs)
    ? `<p class="website-discovery-contact-form" role="status">${retryAtMs > Date.now() ? `This host requested a pause. Retry is available after ${escapeHtml(new Date(retryAtMs).toLocaleString())}.` : 'The host cooldown elapsed. You can explicitly retry this site.'}</p>`
    : '';
  const retryLabel = task.scan_error_code === 'scan_request_budget_reached' ? 'Continue scan'
    : ['site_rate_limited', 'robots_rate_limited'].includes(task.scan_error_code) ? 'Retry rate-limited site' : 'Retry network failure';
  const retry = task.retryable ? `<button type="button" class="btn btn-ghost btn-sm" data-discovery-retry="${task.id}">${retryLabel}</button>` : '';
  const facebookHref = safeFacebookHref(task.facebook_url);
  const profileLocation = [task.category, task.address, [task.city, task.state, task.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const refresh = task.latest_refresh ? `<p class="website-discovery-contact-form" role="status">Latest source refresh: ${escapeHtml(task.latest_refresh.status)}${task.latest_refresh.generation ? ` · generation ${Number(task.latest_refresh.generation)}` : ''}. Historical source evidence is retained.</p>` : '';
  return `<article class="website-discovery-task"><div class="website-discovery-task-heading"><div><strong>${escapeHtml(task.business_name)}</strong><a href="${escapeHtml(safeHttpHref(task.website_url) || '#')}" ${safeHttpHref(task.website_url) ? 'target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(task.website_url)}</a></div><span class="website-discovery-status is-${escapeHtml(task.status)}">${escapeHtml(task.status.replaceAll('_', ' '))}</span></div><small>${fmtNum(task.page_count || 0)} public page(s) · ${fmtNum(new Set((task.emails || []).map(item => String(item.email).toLowerCase())).size)} address(es)${profileLocation ? ` · ${escapeHtml(profileLocation)}` : ''}${task.phone ? ` · Public phone: ${escapeHtml(task.phone)}` : ''}${facebookHref ? ` · <a href="${escapeHtml(facebookHref)}" target="_blank" rel="noopener noreferrer">Facebook page ↗</a>` : ''}${task.error_code ? ` · ${escapeHtml(task.error_code.replaceAll('_', ' '))}` : ''}</small>${refresh}${rateLimitNote}${evidence ? `<ul class="website-discovery-email-list">${evidence}</ul>` : '<p class="website-discovery-none">No public email evidence recorded yet.</p>'}${contactFormOutcome}${retry}</article>`;
}

async function openWebsiteDiscoveryProgress(container, jobId) {
  let taskOffset = 0;
  const taskLimit = 100;
  const initial = await Leads.getWebsiteDiscoveryJob(jobId, { offset: taskOffset, limit: taskLimit });
  const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
  const dialog = openDialog({
    title: `Discovery job #${initial.id}`, eyebrow: 'WEBSITE COLLECTION',
    body: '<section class="website-discovery-progress" data-website-discovery-progress aria-live="polite"></section>',
  });
  const root = dialog.querySelector('[data-website-discovery-progress]');
  let busy = false;
  let stopped = false;
  const render = job => {
    const progress = job.progress || {};
    const done = (progress.completed || 0) + (progress.blocked || 0) + (progress.failed || 0) + (progress.skipped || 0);
    const percent = progress.total ? Math.round(done * 100 / progress.total) : 100;
    const controls = ['queued', 'running', 'pause_requested', 'cancel_requested'].includes(job.status)
      ? `${job.status === 'running' || job.status === 'cancel_requested' ? '<button type="button" class="btn btn-ghost btn-sm" data-discovery-pause>Pause</button>' : ''}<button type="button" class="btn btn-ghost btn-sm" data-discovery-cancel>Cancel remaining</button>`
      : job.status === 'paused' ? '<button type="button" class="btn btn-primary btn-sm" data-discovery-resume>Resume</button><button type="button" class="btn btn-ghost btn-sm" data-discovery-cancel>Cancel remaining</button>' : '';
    const page = job.task_pagination || { offset: 0, limit: taskLimit, total: job.task_count || 0, hasMore: false };
    const firstTask = page.total ? Number(page.offset) + 1 : 0;
    const lastTask = Number(page.offset) + (job.tasks?.length || 0);
    const pagination = page.total > page.limit
      ? `<div class="website-discovery-pagination"><span>Sites ${fmtNum(firstTask)}–${fmtNum(lastTask)} of ${fmtNum(page.total)}</span><div><button type="button" class="btn btn-ghost btn-sm" data-discovery-page-prev ${page.offset <= 0 ? 'disabled' : ''}>Previous</button><button type="button" class="btn btn-ghost btn-sm" data-discovery-page-next ${page.hasMore ? '' : 'disabled'}>Next</button></div></div>`
      : '';
    root.innerHTML = `<div class="website-discovery-progress-top"><div><strong>${escapeHtml(job.status.replaceAll('_', ' '))}</strong><span>${fmtNum(progress.completed || 0)} complete · ${fmtNum(progress.queued || 0)} queued · ${fmtNum(progress.blocked || 0)} blocked · ${fmtNum(progress.failed || 0)} failed</span></div><span>${fmtNum(progress.found_emails || 0)} observed email(s)</span></div><progress max="100" value="${percent}" aria-label="${percent}% of website discovery tasks complete"></progress><p class="website-discovery-policy-note">Observed addresses are attached to public source excerpts and content hashes. They remain unverified and are not consent to send. A pause or cancel lets the current site finish safely, then stops before the next one. Sites that reach the per-run request limit keep their pending links for an explicit Continue scan action.</p><div class="website-discovery-controls"><button type="button" class="btn btn-ghost btn-sm" data-discovery-export>Export evidence CSV</button>${controls}</div><div class="website-discovery-task-list">${job.tasks?.map(websiteDiscoveryTaskHtml).join('') || '<p class="website-discovery-none">No sites in this job.</p>'}</div>${pagination}`;
  };
  render(initial);
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    busy = true;
    button.disabled = true;
    try {
      let pageChanged = false;
      if (button.matches('[data-discovery-page-prev]')) {
        taskOffset = Math.max(0, taskOffset - taskLimit);
        pageChanged = true;
      } else if (button.matches('[data-discovery-page-next]')) {
        taskOffset += taskLimit;
        pageChanged = true;
      } else if (button.matches('[data-discovery-pause]')) await Leads.pauseWebsiteDiscoveryJob(jobId);
      else if (button.matches('[data-discovery-resume]')) await Leads.resumeWebsiteDiscoveryJob(jobId);
      else if (button.matches('[data-discovery-cancel]')) await Leads.cancelWebsiteDiscoveryJob(jobId);
      else if (button.matches('[data-discovery-retry]')) await Leads.retryWebsiteDiscoveryTask(jobId, button.dataset.discoveryRetry);
      else if (button.matches('[data-discovery-export]')) {
        const { blob, filename } = await Leads.exportWebsiteDiscoveryEvidence(jobId);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify('Website source evidence exported.');
      }
      const updated = await Leads.getWebsiteDiscoveryJob(jobId, { offset: taskOffset, limit: taskLimit });
      render(updated);
      if (terminal.has(updated.status) && !pageChanged) {
        _filters = { ...emptyLeadFilters(), batch_id: String(updated.batch_id) };
        resetLeadPaging();
        await _renderLeadsView(container);
      }
    } catch (error) { notify(error.message || 'Discovery action failed.', 'error'); }
    finally { busy = false; }
  });
  const refresh = async () => {
    if (busy || stopped || !dialog.open) return;
    busy = true;
    try {
      const job = await Leads.getWebsiteDiscoveryJob(jobId, { offset: taskOffset, limit: taskLimit });
      render(job);
      if (terminal.has(job.status)) {
        stopped = true;
        clearInterval(timer);
        if (container.isConnected) {
          _filters = { ...emptyLeadFilters(), batch_id: String(job.batch_id) };
          resetLeadPaging();
          await _renderLeadsView(container);
        }
      }
    } catch (error) {
      root.innerHTML = `<p class="contact-import-preview-error" role="alert">${escapeHtml(error.message || 'Could not refresh discovery progress.')}</p>`;
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void refresh(); }, 1500);
  dialog.addEventListener('close', () => { stopped = true; clearInterval(timer); }, { once: true });
  if (terminal.has(initial.status)) { stopped = true; clearInterval(timer); }
}

async function openOpenStreetMapImporter(container) {
  const openBatches = _batches.filter(batch => batch.status === 'open');
  const batchPicker = openBatches.length
    ? `<label class="contact-edit-field"><span class="form-label">Open batch *</span><select class="filter-select" name="batch_id" required>${openBatches.map(batch => `<option value="${batch.id}">${escapeHtml(batch.name || `Batch #${batch.id}`)}</option>`).join('')}</select></label>`
    : `<div class="contact-create-no-batch"><p>No open batch is available. Create one before importing contacts.</p><button type="button" class="btn btn-ghost btn-sm" onclick="window.__nav('batches')">Go to batches</button></div>`;
  let reviewedFile = null;
  let reviewedBatchId = null;
  const dialog = openDialog({
    title: 'Import OpenStreetMap export', eyebrow: 'SOURCED LEAD IMPORT', submitLabel: 'Import reviewed places',
    body: `<p class="contact-picker-intro">Import a regional GeoJSON or CSV export that you already have. This action does not query Overpass, Nominatim, social networks, or any other website. Source object links and source timestamps are retained. Imported email addresses remain unverified and are not consent to send.</p><div class="contact-edit-grid">${batchPicker}<label class="contact-edit-field"><span class="form-label">GeoJSON or OSM CSV export *</span><input class="form-input" type="file" name="osm_export" accept=".geojson,.json,.csv,application/geo+json,text/csv" required></label></div><label class="contact-osm-attribution"><input type="checkbox" name="attribution_acknowledged" required><span>I have the right to use this export and will comply with the OpenStreetMap ODbL and attribution requirements. I understand that applicable ODbL obligations may also apply to the imported database.</span></label><p class="contact-osm-license">Attribution: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors · ODbL</a></p><div class="contact-import-preview-actions"><button type="button" class="btn btn-ghost" data-osm-preview>Preview export</button><span class="contact-import-progress" data-osm-progress role="status"></span></div><div class="contact-import-preview contact-osm-preview" data-osm-preview-panel hidden></div>`,
    onSubmit: async form => {
      const file = form.get('osm_export');
      const batchId = Number(form.get('batch_id'));
      if (!openBatches.length) throw new Error('Create an open batch before importing contacts.');
      if (!(file instanceof File) || !file.size) throw new Error('Choose a non-empty GeoJSON or CSV export.');
      if (file.size > 5 * 1024 * 1024) throw new Error('OpenStreetMap exports must be 5 MB or smaller.');
      if (form.get('attribution_acknowledged') !== 'on') throw new Error('Confirm the source and attribution requirements before importing.');
      if (file !== reviewedFile || batchId !== reviewedBatchId) throw new Error('Preview this exact file and batch before importing.');
      const result = await Leads.importOsm({ batch_id: batchId, export: await file.text(), attribution_acknowledged: true });
      let rejectionReport = null;
      let rejectionReportError = false;
      if (result.rejections?.length) {
        try {
          rejectionReport = downloadRejectedContacts(result.rejections, file.name);
          if (!rejectionReport) throw new Error('Browser download unavailable.');
        } catch { rejectionReportError = true; }
      }
      _filters = { ...emptyLeadFilters(), batch_id: String(batchId) };
      _activeSegmentId = '';
      _segmentDirty = false;
      resetLeadPaging();
      await _renderLeadsView(container);
      const summary = `OpenStreetMap import completed: ${fmtNum(result.counts.inserted)} added, ${fmtNum(result.counts.duplicates)} duplicates, ${fmtNum(result.counts.invalid)} rejected.`;
      if (rejectionReportError) notify(`${summary} The rejection report could not be downloaded; do not repeat the import.`, 'error');
      else notify(rejectionReport ? `${summary} Downloaded ${fmtNum(rejectionReport.rows)} rejection rows as ${rejectionReport.filename}.` : summary);
    },
  });
  const form = dialog.querySelector('form');
  const fileInput = form.querySelector('[name="osm_export"]');
  const batchInput = form.querySelector('[name="batch_id"]');
  const attributionInput = form.querySelector('[name="attribution_acknowledged"]');
  const previewButton = form.querySelector('[data-osm-preview]');
  const submitButton = form.querySelector('[type="submit"]');
  const progress = form.querySelector('[data-osm-progress]');
  const panel = form.querySelector('[data-osm-preview-panel]');
  submitButton.disabled = true;

  const resetReview = () => {
    reviewedFile = null;
    reviewedBatchId = null;
    submitButton.disabled = true;
    panel.hidden = true;
    panel.textContent = '';
    progress.textContent = 'Preview the selected export and confirm attribution before importing.';
  };
  fileInput.addEventListener('change', resetReview);
  batchInput?.addEventListener('change', resetReview);
  attributionInput.addEventListener('change', () => {
    if (!attributionInput.checked) resetReview();
  });
  previewButton.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    const batchId = Number(batchInput?.value || 0);
    if (!(file instanceof File) || !file.size) { progress.textContent = 'Choose a non-empty GeoJSON or CSV export first.'; return; }
    if (file.size > 5 * 1024 * 1024) { progress.textContent = 'OpenStreetMap exports must be 5 MB or smaller.'; return; }
    if (!attributionInput.checked) { progress.textContent = 'Confirm the source and attribution requirements to preview.'; attributionInput.focus(); return; }
    previewButton.disabled = true;
    submitButton.disabled = true;
    progress.textContent = 'Reading and reviewing the supplied export…';
    try {
      const preview = await Leads.previewOsm({ batch_id: batchId, export: await file.text(), attribution_acknowledged: true });
      if (!dialog.isConnected || fileInput.files?.[0] !== file || Number(batchInput?.value || 0) !== batchId) return;
      panel.innerHTML = `<div class="contact-import-summary">${fmtNum(preview.featureCount)} source feature(s) · ${fmtNum(preview.candidateCount)} named contact(s) · ${fmtNum(preview.existingSourceDuplicates)} already imported by OSM object URL · ${fmtNum(preview.rejections.length)} invalid or duplicate feature(s). Import also checks existing email, website and phone duplicates.</div><div class="contact-import-sample-wrap"><table class="contact-import-sample"><thead><tr><th>Business</th><th>Category</th><th>City</th><th>Email</th><th>Source</th></tr></thead><tbody>${preview.sample.map(record => `<tr><td>${escapeHtml(record.business_name)}</td><td>${escapeHtml(record.category || '—')}</td><td>${escapeHtml(record.city || '—')}</td><td>${escapeHtml(record.email || '—')}</td><td><a href="${escapeHtml(record.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.osm_id)}</a><br><small>${escapeHtml(record.source_details)}</small></td></tr>`).join('') || '<tr><td colspan="5">No importable business records in this export.</td></tr>'}</tbody></table></div>${preview.rejections.length ? `<div class="contact-osm-rejections"><strong>Preview rejections</strong><ul>${preview.rejections.slice(0, 20).map(row => `<li>Feature ${fmtNum(row.row)}${row.osm_id ? ` · ${escapeHtml(row.osm_id)}` : ''}: ${escapeHtml(row.reason)}</li>`).join('')}</ul>${preview.rejections.length > 20 ? `<small>Showing the first 20 of ${fmtNum(preview.rejections.length)} source rejections.</small>` : ''}</div>` : ''}<p class="contact-osm-license">${escapeHtml(preview.attribution.label)} · <a href="${escapeHtml(preview.attribution.url)}" target="_blank" rel="noopener noreferrer">Attribution and license</a></p>`;
      panel.hidden = false;
      reviewedFile = file;
      reviewedBatchId = batchId;
      submitButton.disabled = !preview.candidateCount;
      progress.textContent = preview.candidateCount ? 'Review complete. Imported email addresses will stay unverified.' : 'No named business records are eligible to import.';
    } catch (error) {
      reviewedFile = null;
      reviewedBatchId = null;
      panel.hidden = false;
      panel.innerHTML = `<p class="contact-import-preview-error" role="alert">${escapeHtml(error.message || 'Could not preview this export.')}</p>`;
      progress.textContent = '';
    } finally {
      if (previewButton.isConnected) previewButton.disabled = false;
    }
  });
}

async function openMetaLeadAdsImporter(container) {
  const openBatches = _batches.filter(batch => batch.status === 'open');
  const batchPicker = openBatches.length
    ? `<label class="contact-edit-field"><span class="form-label">Open batch *</span><select class="filter-select" name="batch_id" required>${openBatches.map(batch => `<option value="${batch.id}">${escapeHtml(batch.name || `Batch #${batch.id}`)}</option>`).join('')}</select></label>`
    : `<div class="contact-create-no-batch"><p>Create an open batch before importing leads.</p><button type="button" class="btn btn-ghost btn-sm" onclick="window.__nav('batches')">Go to batches</button></div>`;
  const initial = await MetaLeadAds.status();
  let status = initial;
  let forms = [];
  let formsHasMore = false;
  let formsLoading = false;
  const statusLabel = value => value === 'provider_verified' ? 'Page access tested' : value === 'provider_unverified' ? 'Connection needs a successful test' : 'Not connected';
  const batchControls = batchPicker;
  const dialog = openDialog({
    title: 'Import Meta Lead Ads', eyebrow: 'OWNER-AUTHORIZED SOURCE',
    body: `<p class="contact-picker-intro">Import form submissions only from a Meta Page you control, using the official Graph API. Each import is operator-triggered and bounded; use the saved checkpoint to continue larger forms. No page scraping or background sync runs. Imported emails stay unverified and a form submission is not treated as permission for cold email.</p><div class="meta-lead-connection"><div class="meta-lead-state" data-meta-state role="status"></div><div class="contact-edit-grid"><label class="contact-edit-field"><span class="form-label">Meta Page ID *</span><input class="form-input" name="page_id" required inputmode="numeric" pattern="[0-9]{1,32}" maxlength="32" autocomplete="off" value="${escapeHtml(status.pageId || '')}"></label><label class="contact-edit-field"><span class="form-label">Graph API version *</span><input class="form-input" name="graph_version" required pattern="v[0-9]{1,2}\\.[0-9]{1,2}" maxlength="8" placeholder="vNN.N" autocomplete="off" value="${escapeHtml(status.graphVersion || '')}"></label><label class="contact-edit-field meta-token-field"><span class="form-label">Page access token ${status.tokenPresent ? '(leave blank to keep saved token)' : '*'}</span><input class="form-input" type="password" name="access_token" ${status.tokenPresent ? '' : 'required'} maxlength="5000" autocomplete="new-password" spellcheck="false" value=""></label></div><p class="meta-lead-helper">The token is encrypted at rest with the workspace credential key and never returned to the browser. Set ODD_CREDENTIAL_ENCRYPTION_KEY before saving.</p><div class="contact-import-preview-actions"><button type="button" class="btn btn-ghost" data-meta-save>Save connection</button><button type="button" class="btn btn-ghost" data-meta-test ${status.tokenPresent ? '' : 'disabled'}>Test Page access</button><button type="button" class="btn btn-ghost" data-meta-load-forms ${status.connectionStatus === 'provider_verified' ? '' : 'disabled'}>Load forms</button><span class="contact-import-progress" data-meta-message role="status"></span></div></div><section class="meta-lead-import" data-meta-import hidden><h3>Choose a form and map its fields</h3>${batchControls}<label class="contact-edit-field"><span class="form-label">Lead form *</span><select class="filter-select" name="form_id" required><option value="">Load forms first</option></select></label><div class="contact-import-preview-actions"><button type="button" class="btn btn-ghost btn-sm" data-meta-load-more-forms hidden>Load more forms</button><span class="contact-import-progress" data-meta-forms-progress role="status"></span></div><div class="meta-lead-mapping" data-meta-mapping></div><p class="meta-lead-helper">Up to 250 submissions are requested per click. Duplicate Meta lead IDs are ignored. No verification, consent record, campaign enrollment or send is created.</p></section>`,
  });
  const form = dialog.querySelector('form');
  const dialogFooter = document.createElement('footer');
  dialogFooter.className = 'studio-dialog-footer';
  dialogFooter.innerHTML = '<button type="button" class="btn btn-ghost" data-meta-cancel>Cancel</button><button type="button" class="btn btn-primary" data-meta-done>Done</button>';
  form.append(dialogFooter);
  dialogFooter.querySelector('[data-meta-cancel]').addEventListener('click', () => dialog.close());
  dialogFooter.querySelector('[data-meta-done]').addEventListener('click', () => dialog.close());
  const pageId = form.querySelector('[name="page_id"]');
  const version = form.querySelector('[name="graph_version"]');
  const token = form.querySelector('[name="access_token"]');
  const state = form.querySelector('[data-meta-state]');
  const rateStatus = document.createElement('p');
  rateStatus.className = 'meta-lead-helper';
  rateStatus.dataset.metaRateStatus = '';
  rateStatus.setAttribute('role', 'status');
  state.insertAdjacentElement('afterend', rateStatus);
  const message = form.querySelector('[data-meta-message]');
  const saveButton = form.querySelector('[data-meta-save]');
  const testButton = form.querySelector('[data-meta-test]');
  const formsButton = form.querySelector('[data-meta-load-forms]');
  const loadMoreFormsButton = form.querySelector('[data-meta-load-more-forms]');
  const formsProgress = form.querySelector('[data-meta-forms-progress]');
  const importPanel = form.querySelector('[data-meta-import]');
  const formPicker = form.querySelector('[name="form_id"]');
  const mappingPanel = form.querySelector('[data-meta-mapping]');
  const batchField = form.querySelector('[name="batch_id"]');
  const webhookPanel = document.createElement('section');
  webhookPanel.className = 'meta-webhook-panel';
  webhookPanel.innerHTML = `<div><h3>Live form notifications</h3><p class="meta-lead-helper">To receive live leads, add the Webhooks product in your Meta developer app, set Object to Page and subscribe to leadgen. Paste the HTTPS callback and the same private verify token below in Meta, then save the App Secret and verify token here. After Meta verifies the callback, subscribe the Page with the button. The app secret is encrypted; signatures are checked before notification IDs are queued.</p></div><div class="contact-edit-grid"><label class="contact-edit-field"><span class="form-label">Meta App Secret</span><input class="form-input" type="password" data-meta-app-secret maxlength="5000" autocomplete="new-password" spellcheck="false" placeholder="Leave blank to keep saved"></label><label class="contact-edit-field"><span class="form-label">Webhook verify token</span><input class="form-input" type="password" data-meta-verify-token maxlength="512" autocomplete="new-password" spellcheck="false" placeholder="Leave blank to keep saved"></label></div><div class="contact-import-preview-actions"><button type="button" class="btn btn-ghost" data-meta-save-webhook>Save webhook settings</button><button type="button" class="btn btn-ghost" data-meta-subscribe-webhook disabled>Subscribe Page to leadgen</button><button type="button" class="btn btn-ghost" data-meta-refresh-webhooks>Refresh notifications</button><button type="button" class="btn btn-ghost" data-meta-process-webhooks>Retry pending/failed</button><span class="contact-import-progress" data-meta-webhook-status role="status"></span></div><p class="meta-lead-helper" data-meta-webhook-url></p><ul class="meta-webhook-events" data-meta-webhook-events aria-label="Recent Meta lead notifications"></ul>`;
  importPanel.insertAdjacentElement('beforebegin', webhookPanel);
  const appSecretField = webhookPanel.querySelector('[data-meta-app-secret]');
  const verifyTokenField = webhookPanel.querySelector('[data-meta-verify-token]');
  const webhookMessage = webhookPanel.querySelector('[data-meta-webhook-status]');
  const webhookUrl = webhookPanel.querySelector('[data-meta-webhook-url]');
  const webhookEvents = webhookPanel.querySelector('[data-meta-webhook-events]');
  const saveWebhookButton = webhookPanel.querySelector('[data-meta-save-webhook]');
  const subscribeWebhookButton = webhookPanel.querySelector('[data-meta-subscribe-webhook]');
  const refreshWebhooksButton = webhookPanel.querySelector('[data-meta-refresh-webhooks]');
  const processWebhooksButton = webhookPanel.querySelector('[data-meta-process-webhooks]');
  let rateRefreshTimer = null;
  dialog.addEventListener('close', () => clearTimeout(rateRefreshTimer), { once: true });
  const saveMappingButton = document.createElement('button');
  saveMappingButton.type = 'button';
  saveMappingButton.className = 'btn btn-ghost';
  saveMappingButton.textContent = 'Save mapping for live leads';
  saveMappingButton.dataset.metaSaveMapping = '';
  importPanel.append(saveMappingButton);
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.className = 'btn btn-primary';
  importButton.dataset.metaImportPage = '';
  importButton.textContent = 'Import next 250 submissions';
  importButton.disabled = true;
  importPanel.append(importButton);
  let webhookInfo = null;

  function metaCooldownActive() {
    const until = Date.parse(status.rateLimitUntil || '');
    return Number.isFinite(until) && until > Date.now();
  }

  function scheduleRateLimitRefresh() {
    clearTimeout(rateRefreshTimer);
    if (!dialog.isConnected) return;
    const until = Date.parse(status.rateLimitUntil || '');
    if (!Number.isFinite(until) || until <= Date.now()) return;
    rateRefreshTimer = setTimeout(() => updateStatus(), Math.min(2_147_000_000, until - Date.now() + 25));
  }

  async function refreshMetaStatusAfterFailure() {
    try { status = await MetaLeadAds.status(); } catch { /* Keep the provider error visible if status refresh is unavailable. */ }
    updateStatus();
  }

  function updateImportButton() {
    const businessName = mappingPanel.querySelector('[data-meta-map="business_name"]')?.value;
    const enabled = Boolean(openBatches.length && formPicker.value && businessName
      && status.connectionStatus === 'provider_verified' && !metaCooldownActive());
    importButton.disabled = !enabled;
    saveMappingButton.disabled = !enabled;
  }

  function renderWebhookInfo(info) {
    webhookInfo = info;
    const counts = info?.counts || {};
    const configured = info?.configured ? 'Signature verification is configured.' : 'Webhook signature verification is not configured.';
    webhookMessage.textContent = `${configured} ${fmtNum(counts.pending || 0)} pending · ${fmtNum(counts.processing || 0)} processing · ${fmtNum(counts.imported || 0)} imported · ${fmtNum(counts.failed || 0)} need retry or a mapping.`;
    webhookUrl.textContent = info?.webhookUrl
      ? `Webhook callback URL: ${info.webhookUrl}`
      : 'Set ODD_PUBLIC_BASE_URL to the public HTTPS app URL to display the callback address.';
    subscribeWebhookButton.disabled = status.connectionStatus !== 'provider_verified' || metaCooldownActive() || !info?.configured || !info?.webhookUrl;
    if (info?.lastPageSubscriptionAt) {
      webhookMessage.textContent += ` Page subscription last confirmed ${relTime(info.lastPageSubscriptionAt)}.`;
    }
    processWebhooksButton.disabled = status.connectionStatus !== 'provider_verified' || metaCooldownActive() || !(counts.pending || counts.failed);
    webhookEvents.replaceChildren();
    for (const item of (info?.recent || []).slice(0, 8)) {
      const entry = document.createElement('li');
      entry.textContent = `Form ${item.form_id} · lead ${item.lead_id} · ${item.status}${item.attempts ? ` · ${item.attempts} attempt(s)` : ''}${item.last_error_code ? ` · ${item.last_error_code}` : ''}`;
      webhookEvents.append(entry);
    }
  }

  async function refreshWebhookInfo() {
    refreshWebhooksButton.disabled = true;
    try { renderWebhookInfo(await MetaLeadAds.webhookStatus()); }
    catch (error) { webhookMessage.textContent = error.message || 'Webhook status could not be loaded.'; }
    finally { refreshWebhooksButton.disabled = false; }
  }

  function updateStatus() {
    const usage = status.rateUsage || {};
    const appUsage = usage.app || {};
    const useCaseUsage = Array.isArray(usage.businessUseCase) ? usage.businessUseCase : [];
    const usageLabel = [
      Number.isFinite(appUsage.callCount) ? `app calls ${appUsage.callCount}%` : '',
      Number.isFinite(appUsage.totalTime) ? `app time ${appUsage.totalTime}%` : '',
      Number.isFinite(appUsage.totalCpuTime) ? `app CPU ${appUsage.totalCpuTime}%` : '',
      ...useCaseUsage.slice(0, 2).map(item => `${item.type || 'Meta use'} ${Number.isFinite(item.callCount) ? `${item.callCount}% calls` : Number.isFinite(item.totalTime) ? `${item.totalTime}% time` : 'usage observed'}`),
    ].filter(Boolean).join(' · ');
    const until = Date.parse(status.rateLimitUntil || '');
    const active = Number.isFinite(until) && until > Date.now();
    state.textContent = `${statusLabel(status.connectionStatus)}${status.pageId ? ` · Page ${status.pageId}` : ''}${status.lastTestAt ? ` · tested ${relTime(status.lastTestAt)}` : ''}`;
    state.dataset.state = status.connectionStatus;
    testButton.disabled = !status.tokenPresent || active;
    formsButton.disabled = status.connectionStatus !== 'provider_verified' || active;
    loadMoreFormsButton.hidden = !formsHasMore;
    loadMoreFormsButton.disabled = status.connectionStatus !== 'provider_verified' || active || formsLoading || !formsHasMore;
    loadMoreFormsButton.textContent = formsLoading ? 'Loading forms…' : 'Load more forms';
    if (active) {
      rateStatus.textContent = `Meta rate limit active until ${new Date(until).toLocaleString()}. No requests will run during this cooldown; retry manually after it expires.${usageLabel ? ` Latest observed usage: ${usageLabel}.` : ''}`;
      rateStatus.dataset.state = 'cooldown';
    } else if (status.rateLimitRecoveryRequired) {
      rateStatus.textContent = `The Meta cooldown has expired${status.rateLimitUntil ? ` (${new Date(until).toLocaleString()})` : ''}. Background webhook retrieval remains paused until you choose an explicit Meta action.${usageLabel ? ` Latest usage: ${usageLabel}.` : ''}`;
      rateStatus.dataset.state = 'recovery-required';
    } else {
      rateStatus.textContent = usageLabel ? `Latest Meta rate usage: ${usageLabel}.${status.rateUsageObservedAt ? ` Observed ${relTime(status.rateUsageObservedAt)}.` : ''}` : '';
      rateStatus.dataset.state = usageLabel ? 'observed' : '';
    }
    scheduleRateLimitRefresh();
    updateImportButton();
    subscribeWebhookButton.disabled = status.connectionStatus !== 'provider_verified' || active
      || !webhookInfo?.configured || !webhookInfo?.webhookUrl;
    processWebhooksButton.disabled = status.connectionStatus !== 'provider_verified' || active
      || !((webhookInfo?.counts?.pending || 0) || (webhookInfo?.counts?.failed || 0));
  }

  function renderMapping(selectedForm) {
    const fields = selectedForm?.fields || [];
    if (!fields.length) {
      mappingPanel.innerHTML = '<p class="meta-lead-helper">Meta did not return this form’s question names. Choose another form or confirm its permissions and API version.</p>';
      updateImportButton();
      return;
    }
    const preferred = (target, aliases) => fields.find(field => aliases.includes(field.key.toLowerCase()))?.key || '';
    const definitions = [
      ['business_name', 'Business or respondent name *', true, preferred('business_name', ['company_name', 'business_name', 'company', 'full_name', 'name'])],
      ['email', 'Email address', false, preferred('email', ['email', 'email_address'])],
      ['phone', 'Phone', false, preferred('phone', ['phone_number', 'phone', 'mobile_phone'])],
      ['website_url', 'Website', false, preferred('website_url', ['website', 'website_url'])],
      ['category', 'Industry or category', false, preferred('category', ['industry', 'category'])],
      ['address', 'Street address', false, preferred('address', ['street_address', 'address', 'full_address'])],
      ['city', 'City', false, preferred('city', ['city'])],
      ['state', 'State or province', false, preferred('state', ['state', 'province', 'region', 'state_province'])],
      ['country', 'Country', false, preferred('country', ['country'])],
    ];
    const options = `<option value="">Do not map</option>${fields.map(field => `<option value="${escapeHtml(field.key)}">${escapeHtml(field.label)}</option>`).join('')}`;
    mappingPanel.innerHTML = definitions.map(([key, label, required, selected]) => `<label class="contact-edit-field"><span class="form-label">${label}</span><select class="filter-select" data-meta-map="${key}" ${required ? 'required' : ''}>${options}</select></label>`).join('');
    for (const [key, , , selected] of definitions) {
      const picker = mappingPanel.querySelector(`[data-meta-map="${key}"]`);
      const choice = selectedForm.savedFieldMap?.[key] || selected;
      if (choice && fields.some(field => field.key === choice)) picker.value = choice;
    }
    if (selectedForm.savedBatchId && [...(batchField?.options || [])].some(option => option.value === String(selectedForm.savedBatchId))) {
      batchField.value = String(selectedForm.savedBatchId);
    }
    updateImportButton();
  }

  importButton.addEventListener('click', async () => {
    const formId = formPicker.value;
    const selectedForm = forms.find(item => item.id === formId);
    const batchId = Number(form.querySelector('[name="batch_id"]')?.value);
    if (!selectedForm || !Number.isSafeInteger(batchId) || batchId < 1) {
      message.textContent = 'Choose an open batch and a form before importing.';
      return;
    }
    const mapping = Object.fromEntries([...mappingPanel.querySelectorAll('[data-meta-map]')]
      .map(select => [select.dataset.metaMap, select.value]).filter(([, value]) => value));
    if (!mapping.business_name) {
      message.textContent = 'Map a form field to Business or respondent name before importing.';
      return;
    }
    importButton.disabled = true;
    message.textContent = 'Importing up to 250 submissions and saving their source IDs…';
    try {
      const result = await MetaLeadAds.importForm({ batch_id: batchId, form_id: formId, field_map: mapping });
      selectedForm.continuationAvailable = result.hasMore;
      selectedForm.moreResultsLastSeen = result.hasMore;
      const option = formPicker.selectedOptions[0];
      if (option) option.textContent = `${selectedForm.name} · ${selectedForm.status}${result.hasMore ? ' · more results available' : ' · current results imported'}`;
      _filters = { ...emptyLeadFilters(), batch_id: String(result.batchId) };
      _activeSegmentId = '';
      _segmentDirty = false;
      resetLeadPaging();
      await _renderLeadsView(container);
      const progress = result.hasMore
        ? 'More submissions remain; click Import next 250 submissions to continue from the saved checkpoint.'
        : 'Meta reported no further submissions at the saved checkpoint.';
      const checkpoint = result.cursorAdvanced ? 'Paging checkpoint saved.' : 'Paging checkpoint was not advanced because some rows need correction.';
      message.textContent = `This run: ${fmtNum(result.inserted)} added, ${fmtNum(result.duplicates)} duplicates, ${fmtNum(result.rejected)} rejected. ${progress} ${checkpoint} Emails remain unverified; no send work was created.`;
    } catch (error) {
      message.textContent = error.message || 'Meta lead import failed. The saved checkpoint was kept so you can retry.';
      await refreshMetaStatusAfterFailure();
    } finally {
      updateImportButton();
    }
  });

  updateStatus();
  void refreshWebhookInfo();
  const clearLoadedForms = () => {
    forms = [];
    formsHasMore = false;
    formPicker.innerHTML = '<option value="">Load forms first</option>';
    importPanel.hidden = true;
    formsProgress.textContent = '';
    updateStatus();
  };
  const renderFormOptions = selectedId => {
    formPicker.innerHTML = `<option value="">Choose a form…</option>${forms.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.status)}${item.continuationAvailable ? ' · more results available' : ''}${item.savedBatchId ? ' · live mapping saved' : ''}</option>`).join('')}`;
    if (selectedId && forms.some(item => item.id === selectedId)) formPicker.value = selectedId;
  };
  pageId.addEventListener('input', () => { status = { ...status, connectionStatus: 'provider_unverified' }; clearLoadedForms(); });
  version.addEventListener('input', () => { status = { ...status, connectionStatus: 'provider_unverified' }; clearLoadedForms(); });
  saveButton.addEventListener('click', async () => {
    message.textContent = 'Saving encrypted Page connection…';
    saveButton.disabled = true;
    try {
      status = await MetaLeadAds.save({ page_id: pageId.value.trim(), graph_version: version.value.trim(), access_token: token.value });
      token.value = '';
      if (status.tokenPresent) token.removeAttribute('required');
      clearLoadedForms();
      message.textContent = 'Connection saved. Test Page access before importing.';
      updateStatus();
    } catch (error) { message.textContent = error.message || 'Could not save the Meta connection.'; }
    finally { saveButton.disabled = false; }
  });
  testButton.addEventListener('click', async () => {
    message.textContent = 'Testing Page access with Meta…';
    testButton.disabled = true;
    try {
      status = await MetaLeadAds.test();
      message.textContent = `Connected to ${status.pageName}.`;
      updateStatus();
    } catch (error) {
      status = { ...status, connectionStatus: 'provider_unverified' };
      const providerMessage = error.message || 'Meta Page access could not be confirmed.';
      await refreshMetaStatusAfterFailure();
      message.textContent = providerMessage;
      updateStatus();
    }
  });
  saveWebhookButton.addEventListener('click', async () => {
    saveWebhookButton.disabled = true;
    webhookMessage.textContent = 'Saving encrypted webhook verification settings…';
    try {
      renderWebhookInfo(await MetaLeadAds.saveWebhook({ app_secret: appSecretField.value, verify_token: verifyTokenField.value }));
      appSecretField.value = '';
      verifyTokenField.value = '';
      webhookMessage.textContent = 'Webhook verification settings saved. Configure the displayed HTTPS callback in your Meta app.';
    } catch (error) {
      webhookMessage.textContent = error.message || 'Webhook settings could not be saved.';
    } finally { saveWebhookButton.disabled = false; }
  });
  subscribeWebhookButton.addEventListener('click', async () => {
    subscribeWebhookButton.disabled = true;
    webhookMessage.textContent = 'Requesting the leadgen subscription for this Page from Meta…';
    try {
      const result = await MetaLeadAds.subscribeWebhook();
      renderWebhookInfo(result);
      webhookMessage.textContent = `Meta confirmed the leadgen subscription for Page ${result.pageId}. You can refresh later to see new notifications.`;
    } catch (error) {
      webhookMessage.textContent = error.message || 'Meta did not confirm the Page subscription.';
      await refreshMetaStatusAfterFailure();
    } finally {
      subscribeWebhookButton.disabled = status.connectionStatus !== 'provider_verified' || metaCooldownActive() || !webhookInfo?.configured || !webhookInfo?.webhookUrl;
    }
  });
  refreshWebhooksButton.addEventListener('click', () => refreshWebhookInfo());
  processWebhooksButton.addEventListener('click', async () => {
    processWebhooksButton.disabled = true;
    webhookMessage.textContent = 'Retrying pending and previously failed signed notifications…';
    try {
      const result = await MetaLeadAds.processWebhooks(true);
      await refreshWebhookInfo();
      webhookMessage.textContent = `Processed ${fmtNum(result.imported)} notification(s): ${fmtNum(result.inserted)} contacts added, ${fmtNum(result.duplicates)} duplicates, ${fmtNum(result.failed)} still need attention. No send work was created.`;
    } catch (error) {
      webhookMessage.textContent = error.message || 'Webhook notifications could not be processed.';
      await refreshMetaStatusAfterFailure();
    } finally { processWebhooksButton.disabled = metaCooldownActive() || status.connectionStatus !== 'provider_verified'; }
  });
  saveMappingButton.addEventListener('click', async () => {
    const formId = formPicker.value;
    const selectedForm = forms.find(item => item.id === formId);
    const batchId = Number(batchField?.value);
    const mapping = Object.fromEntries([...mappingPanel.querySelectorAll('[data-meta-map]')]
      .map(select => [select.dataset.metaMap, select.value]).filter(([, value]) => value));
    if (!selectedForm || !Number.isSafeInteger(batchId) || batchId < 1 || !mapping.business_name) {
      message.textContent = 'Choose a form, open batch and business-name mapping before saving for live notifications.';
      return;
    }
    saveMappingButton.disabled = true;
    message.textContent = 'Checking this mapping against the Page form and saving its open batch…';
    try {
      await MetaLeadAds.saveWebhookForm(formId, { batch_id: batchId, field_map: mapping });
      selectedForm.savedBatchId = batchId;
      selectedForm.savedFieldMap = mapping;
      message.textContent = 'Mapping saved. Signed notifications for this form can now be retrieved and imported.';
      await refreshWebhookInfo();
    } catch (error) {
      message.textContent = error.message || 'The live lead mapping could not be saved.';
      await refreshMetaStatusAfterFailure();
    } finally { updateImportButton(); }
  });
  formsButton.addEventListener('click', async () => {
    message.textContent = 'Loading forms from the configured Page…';
    formsButton.disabled = true;
    try {
      const result = await MetaLeadAds.forms();
      status = await MetaLeadAds.status();
      forms = result.forms || [];
      formsHasMore = Boolean(result.hasMore);
      renderFormOptions('');
      importPanel.hidden = !forms.length;
      formsProgress.textContent = formsHasMore ? 'More forms are available. Load them when you are ready.' : '';
      message.textContent = forms.length ? `${forms.length} form(s) loaded${result.hasMore ? ' · more available' : ''}.` : 'No forms were returned for this Page.';
      updateStatus();
    } catch (error) {
      message.textContent = error.message || 'Could not load Meta lead forms.';
      await refreshMetaStatusAfterFailure();
    }
    finally { formsButton.disabled = status.connectionStatus !== 'provider_verified' || metaCooldownActive(); }
  });
  loadMoreFormsButton.addEventListener('click', async () => {
    if (formsLoading || !formsHasMore || status.connectionStatus !== 'provider_verified' || metaCooldownActive()) return;
    const selectedId = formPicker.value;
    formsLoading = true;
    updateStatus();
    formsProgress.textContent = 'Loading the next saved page of forms…';
    try {
      const result = await MetaLeadAds.nextForms();
      status = await MetaLeadAds.status();
      const byId = new Map(forms.map(item => [item.id, item]));
      for (const item of result.forms || []) if (!byId.has(item.id)) byId.set(item.id, item);
      forms = [...byId.values()];
      formsHasMore = Boolean(result.hasMore);
      renderFormOptions(selectedId);
      importPanel.hidden = !forms.length;
      formsProgress.textContent = formsHasMore ? `${forms.length} unique forms loaded. More forms are available.` : `${forms.length} unique forms loaded. All forms for this Page are shown.`;
      updateStatus();
    } catch (error) {
      formsProgress.textContent = error.message || 'Could not load the next Meta forms page. The saved page can be retried.';
      await refreshMetaStatusAfterFailure();
    } finally {
      formsLoading = false;
      updateStatus();
    }
  });
  formPicker.addEventListener('change', () => {
    const selected = forms.find(item => item.id === formPicker.value);
    renderMapping(selected);
  });
  mappingPanel.addEventListener('change', () => {
    updateImportButton();
  });
  form.querySelector('[name="batch_id"]')?.addEventListener('change', updateImportButton);
}

async function openContactImporter(container) {
  const customFields = (await ContactFields.list()).fields || [];
  const openBatches = _batches.filter(batch => batch.status === 'open');
  const batchPicker = openBatches.length
    ? `<label class="contact-edit-field"><span class="form-label">Open batch *</span><select class="filter-select" name="batch_id" required>${openBatches.map(batch => `<option value="${batch.id}">${escapeHtml(batch.name || `Batch #${batch.id}`)}</option>`).join('')}</select></label>`
    : `<div class="contact-create-no-batch"><p>No open batch is available. Create one before importing contacts.</p><button type="button" class="btn btn-ghost btn-sm" onclick="window.__nav('batches')">Go to batches</button></div>`;

  let previewedFileKey = '';
  let resumeJob = null;
  let activeImportJobId = null;
  let importRequestKey = '';
  const dialog = openDialog({
    title: 'Import contacts', eyebrow: 'BULK CONTACT IMPORT', submitLabel: 'Import contacts',
    body: `<p class="contact-picker-intro">Preview a sample, then import in bounded chunks. Progress survives a restart, interruptions can resume from this same file, and cancellation stops at a saved row boundary. Imported addresses stay unverified. Import does not probe mail servers or send email. Files are limited to 100 MB and 250,000 rows.</p><div class="contact-edit-grid">${batchPicker}<label class="contact-edit-field"><span class="form-label">CSV file *</span><input class="form-input" type="file" name="csv" accept=".csv,text/csv" required></label></div><div class="contact-import-preview-actions"><button type="button" class="btn btn-ghost" data-import-preview>Preview columns and rows</button><button type="button" class="btn btn-ghost" data-import-cancel hidden>Cancel import</button><span class="contact-import-progress" data-import-progress role="status"></span></div><div class="contact-import-jobs" data-import-jobs aria-live="polite"></div><div class="contact-import-preview" data-import-preview-panel hidden></div>`,
    onSubmit: async form => {
      if (!openBatches.length) throw new Error('Create an open batch before importing contacts.');
      const file = form.get('csv');
      if (!(file instanceof File) || !file.size) throw new Error('Choose a non-empty CSV file.');
      if (file.size > 100 * 1024 * 1024) throw new Error('CSV files must be 100 MB or smaller.');
      const batchId = Number(form.get('batch_id'));
      let job = resumeJob;
      if (!job && activeImportJobId) {
        const current = await Leads.getImportJob(activeImportJobId);
        if (current.status === 'uploading') job = current;
      }
      if (job) {
        if (job.batchId !== batchId || job.fileBytes !== file.size || job.fileName !== file.name) {
          throw new Error('Select the same CSV file and batch as the interrupted import to resume it.');
        }
      } else {
        if (previewedFileKey !== importFileKey(batchId, file)) throw new Error('Preview this file and batch before importing.');
        const columnMap = Object.fromEntries([...form.entries()]
          .filter(([key]) => key.startsWith('columnMap__'))
          .map(([key, value]) => [key.slice('columnMap__'.length), String(value)]));
        const unmappedRequired = customFields.filter(field => field.required && !columnMap[`custom__${field.fieldKey}`]);
        if (unmappedRequired.length) {
          throw new Error(`Map a CSV column to each required custom field: ${unmappedRequired.map(field => field.name).join(', ')}.`);
        }
        job = await Leads.createImportJob({
          batch_id: batchId,
          file_name: file.name,
          file_bytes: file.size,
          columnMap,
          request_key: importRequestKey || (importRequestKey = crypto.randomUUID()),
        });
      }
      activeImportJobId = job.id;
      void renderImportJobs();
      cancelButton.hidden = false;
      progress.textContent = `Uploading ${fmtNum(job.uploadedBytes)} of ${fmtNum(job.fileBytes)} bytes…`;
      const chunkSize = 256 * 1024;
      for (let start = 0; start < file.size; start += chunkSize) {
        const endExclusive = Math.min(file.size, start + chunkSize);
        const result = await Leads.uploadImportChunk(job.id, start, endExclusive - 1, file.size, file.slice(start, endExclusive));
        job = result.job;
        void renderImportJobs();
        progress.textContent = job.status === 'uploading'
          ? `Upload ${Math.min(100, Math.floor((job.uploadedBytes / job.fileBytes) * 100))}% · verifying saved chunks…`
          : `CSV validated · imported ${fmtNum(job.processedRows)} of ${fmtNum(job.totalRows)} rows…`;
        if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error || `Import ${job.status}.`);
      }
      while (['validating', 'queued', 'processing'].includes(job.status)) {
        await new Promise(resolve => setTimeout(resolve, 300));
        job = await Leads.getImportJob(job.id);
        if (job.status === 'validating') progress.textContent = 'Verifying CSV structure and full-file digest…';
        else if (job.status === 'queued' || job.status === 'processing') progress.textContent = `Importing ${fmtNum(job.processedRows)} of ${fmtNum(job.totalRows)} rows…`;
        if (jobsPanel.isConnected) void renderImportJobs();
      }
      cancelButton.hidden = true;
      if (job.status !== 'completed') {
        if (['failed', 'cancelled'].includes(job.status)) {
          activeImportJobId = null;
          resumeJob = null;
          importRequestKey = '';
        }
        throw new Error(job.error || `Import ${job.status}.`);
      }
      activeImportJobId = null;
      resumeJob = null;
      importRequestKey = '';
      let rejectDownload = null;
      let rejectDownloadError = false;
      if (job.rejectionCount) {
        try {
          rejectDownload = downloadImportRejections(job.id);
          if (!rejectDownload) throw new Error('Browser download unavailable.');
        }
        catch { rejectDownloadError = true; }
      }
      _filters = { ...emptyLeadFilters(), batch_id: String(job.batchId) };
      _activeSegmentId = '';
      _segmentDirty = false;
      resetLeadPaging();
      await _renderLeadsView(container);
      const summary = `Import completed: ${fmtNum(job.counts.inserted)} added, ${fmtNum(job.counts.duplicates)} duplicates, ${fmtNum(job.counts.invalid)} invalid.`;
      if (rejectDownloadError) notify(`${summary} The rejection report could not be downloaded; do not repeat the import.`, 'error');
      else notify(rejectDownload ? `${summary} Downloaded all ${fmtNum(job.rejectionCount)} rejection rows as ${rejectDownload.filename}.` : summary);
    },
  });
  const form = dialog.querySelector('form');
  const fileInput = form.querySelector('[name="csv"]');
  const previewButton = form.querySelector('[data-import-preview]');
  const submitButton = form.querySelector('[type="submit"]');
  const cancelButton = form.querySelector('[data-import-cancel]');
  const panel = form.querySelector('[data-import-preview-panel]');
  const progress = form.querySelector('[data-import-progress]');
  const jobsPanel = form.querySelector('[data-import-jobs]');
  const fieldLabels = {
    business_name: 'Business name', category: 'Category', address: 'Address', city: 'City', state: 'State', country: 'Country',
    phone: 'Phone', website_url: 'Website', facebook_url: 'Facebook URL', email: 'Email', rating: 'Rating', reviews: 'Review count',
    source_details: 'Source details', source_url: 'Source URL', consent_recorded_at: 'Consent evidence date',
    consent_method: 'Consent method / context', consent_evidence_url: 'Consent evidence URL',
  };
  for (const field of customFields) fieldLabels[`custom__${field.fieldKey}`] = `${field.name}${field.required ? ' *' : ''}`;
  function selectedMapping() {
    return Object.fromEntries([...form.querySelectorAll('[data-import-map]')]
      .map(select => [select.dataset.importMap, select.value]));
  }
  function renderPreview(preview, batchId, file) {
    const fields = Object.keys(fieldLabels).filter(field => Object.hasOwn(preview.mapping, field));
    const sampleFields = [...['business_name', 'email', 'category', 'city', 'source_details', 'source_url', 'consent_recorded_at', 'consent_method', 'consent_evidence_url'].filter(field => fields.includes(field)), ...fields.filter(field => field.startsWith('custom__'))];
    panel.innerHTML = `<div class="contact-import-summary">${file.size > 5 * 1024 * 1024 ? 'Preview sample from the first 5 MB; import totals below come from the full-file job.' : `${fmtNum(preview.totalRows)} data row(s)`} · showing up to ${Math.min(5, preview.sample.length)} preview row(s). Check the mapping and sample before importing.</div><div class="contact-import-mapping">${fields.map(field => `<label><span>${escapeHtml(fieldLabels[field])}</span><select class="filter-select" name="columnMap__${field}" data-import-map="${field}"><option value="">Do not map</option>${preview.headers.map(header => `<option value="${escapeHtml(header)}">${escapeHtml(header)}</option>`).join('')}</select></label>`).join('')}</div>${sampleFields.length ? `<div class="contact-import-sample-wrap"><table class="contact-import-sample"><thead><tr>${sampleFields.map(field => `<th>${escapeHtml(fieldLabels[field])}</th>`).join('')}</tr></thead><tbody>${preview.sample.map(row => `<tr>${sampleFields.map(field => `<td>${escapeHtml(row[field] || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}`;
    panel.hidden = false;
    for (const select of panel.querySelectorAll('[data-import-map]')) {
      select.value = preview.mapping[select.dataset.importMap] || '';
      select.addEventListener('change', () => runPreview(true));
    }
    previewedFileKey = importFileKey(batchId, file);
  }
  async function runPreview(updateMapping = false) {
    const file = fileInput.files?.[0];
    if (!openBatches.length) { progress.textContent = 'Create an open batch first.'; return; }
    if (!(file instanceof File) || !file.size) { progress.textContent = 'Choose a non-empty CSV file first.'; return; }
    if (file.size > 100 * 1024 * 1024) { progress.textContent = 'CSV files must be 100 MB or smaller.'; return; }
    const batchId = Number(form.querySelector('[name="batch_id"]')?.value || 0);
    previewButton.disabled = true;
    submitButton.disabled = true;
    panel.querySelectorAll('[data-import-map]').forEach(select => { select.disabled = true; });
    progress.textContent = 'Reading rows…';
    try {
      const columnMap = updateMapping ? selectedMapping() : Object.fromEntries(customFields.map(field => [`custom__${field.fieldKey}`, '']));
      const csvSample = await file.slice(0, 5 * 1024 * 1024).text();
      const preview = file.size > 5 * 1024 * 1024
        ? await Leads.previewCsvSample({ batch_id: batchId, csv: csvSample, columnMap })
        : await Leads.previewCsv({ batch_id: batchId, csv: csvSample, columnMap });
      if (!dialog.isConnected || fileInput.files?.[0] !== file || Number(form.querySelector('[name="batch_id"]')?.value || 0) !== batchId) return;
      renderPreview(preview, batchId, file);
      progress.textContent = 'Preview ready. Mapping changes refresh the sample.';
    } catch (error) {
      previewedFileKey = '';
      if (!dialog.isConnected) return;
      panel.hidden = false;
      panel.innerHTML = `<p class="contact-import-preview-error" role="alert">${escapeHtml(error.message || 'Could not preview this CSV.')}</p>`;
      progress.textContent = '';
    } finally {
      if (previewButton.isConnected) previewButton.disabled = false;
      if (submitButton.isConnected) submitButton.disabled = false;
    }
  }
  previewButton.addEventListener('click', () => runPreview(false));
  fileInput.addEventListener('change', () => {
    previewedFileKey = '';
    panel.hidden = true;
    panel.textContent = '';
    if (resumeJob) {
      const file = fileInput.files?.[0];
      if (file && (file.name !== resumeJob.fileName || file.size !== resumeJob.fileBytes)) {
        resumeJob = null;
        progress.textContent = 'The selected file does not match this interrupted import.';
      } else progress.textContent = 'Choose the same CSV file to resume, then submit.';
    } else {
      importRequestKey = '';
      progress.textContent = 'Preview the selected file before importing.';
    }
  });
  form.querySelector('[name="batch_id"]')?.addEventListener('change', () => {
    previewedFileKey = '';
    resumeJob = null;
    if (!activeImportJobId) importRequestKey = '';
    panel.hidden = true;
    progress.textContent = 'Preview this batch and file before importing.';
    void renderImportJobs();
  });

  async function renderImportJobs() {
    if (!jobsPanel.isConnected) return;
    const batchId = Number(form.querySelector('[name="batch_id"]')?.value || 0);
    if (!batchId) { jobsPanel.textContent = ''; return; }
    try {
      const { jobs } = await Leads.listImportJobs(batchId, 12);
      if (!jobsPanel.isConnected) return;
      const visible = jobs;
      jobsPanel.innerHTML = visible.length ? `<div class="contact-import-summary">Recent imports</div><div class="contact-import-job-list">${visible.map(job => `<div class="contact-import-job"><div><strong>${escapeHtml(job.fileName)}</strong><span>${escapeHtml(job.status)} · ${job.status === 'uploading' ? `${fmtNum(job.uploadedBytes)} / ${fmtNum(job.fileBytes)} bytes` : `${fmtNum(job.processedRows)} / ${fmtNum(job.totalRows)} rows · ${fmtNum(job.counts.inserted)} added · ${fmtNum(job.rejectionCount)} rejected`}</span></div><progress max="100" value="${job.progress}"></progress>${job.status === 'uploading' ? `<button type="button" class="btn btn-ghost btn-sm" data-import-resume="${job.id}">Resume upload</button>` : job.resumable ? `<button type="button" class="btn btn-ghost btn-sm" data-import-retry="${job.id}">Resume</button>` : ''}${['uploading', 'validating', 'queued', 'processing'].includes(job.status) ? `<button type="button" class="btn btn-ghost btn-sm" data-import-cancel-job="${job.id}">Cancel</button>` : ''}</div>`).join('')}</div>` : '<div class="contact-import-summary">No imports for this batch yet.</div>';
      for (const button of jobsPanel.querySelectorAll('[data-import-resume]')) {
        button.addEventListener('click', () => {
          resumeJob = jobs.find(job => String(job.id) === button.dataset.importResume);
          fileInput.click();
          progress.textContent = 'Choose the same CSV file to resume. Saved chunks will be checked before upload continues.';
        });
      }
      for (const button of jobsPanel.querySelectorAll('[data-import-retry]')) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await Leads.resumeImportJob(button.dataset.importRetry);
            let job = await Leads.getImportJob(button.dataset.importRetry);
            while (['queued', 'processing', 'validating'].includes(job.status)) {
              progress.textContent = `Resuming ${job.fileName} at ${fmtNum(job.processedRows)} of ${fmtNum(job.totalRows)} rows…`;
              await new Promise(resolve => setTimeout(resolve, 300));
              job = await Leads.getImportJob(button.dataset.importRetry);
            }
            if (job.status !== 'completed') throw new Error(job.error || `Import ${job.status}.`);
            _filters = { ...emptyLeadFilters(), batch_id: String(job.batchId) };
            resetLeadPaging();
            await _renderLeadsView(container);
            const report = job.rejectionCount ? downloadImportRejections(job.id) : null;
            notify(`Import resumed and completed: ${fmtNum(job.counts.inserted)} added, ${fmtNum(job.counts.duplicates)} duplicates, ${fmtNum(job.counts.invalid)} invalid.${report ? ` Downloaded ${fmtNum(job.rejectionCount)} rejection rows as ${report.filename}.` : ''}`);
            await renderImportJobs();
          } catch (error) {
            progress.textContent = error.message || 'Import could not be resumed.';
            await renderImportJobs();
          } finally { if (button.isConnected) button.disabled = false; }
        });
      }
      for (const button of jobsPanel.querySelectorAll('[data-import-cancel-job]')) {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await Leads.cancelImportJob(button.dataset.importCancelJob);
            await renderImportJobs();
            progress.textContent = 'Cancellation requested; the active row batch will finish at its durable checkpoint.';
          } catch (error) {
            progress.textContent = error.message || 'Could not cancel this import.';
          } finally { button.disabled = false; }
        });
      }
    } catch (error) {
      if (jobsPanel.isConnected) jobsPanel.textContent = error.message || 'Import status could not be loaded.';
    }
  }

  cancelButton.addEventListener('click', async () => {
    if (!activeImportJobId) return;
    cancelButton.disabled = true;
    try {
      await Leads.cancelImportJob(activeImportJobId);
      progress.textContent = 'Cancellation requested; the active row batch will finish at its durable checkpoint.';
      await renderImportJobs();
    } catch (error) {
      progress.textContent = error.message || 'Could not cancel this import.';
    } finally { cancelButton.disabled = false; }
  });
  void renderImportJobs();
}

function importFileKey(batchId, file) {
  return file ? `${batchId}:${file.name}:${file.size}:${file.lastModified}` : '';
}

async function openContactEditor(lead, container) {
  const customFields = ((await ContactFields.list()).fields || []);
  const savedValues = new Map((lead.customFields || []).map(field => [field.fieldKey, field.value]));
  const fields = [
    ['business_name', 'Business name', lead.business_name || '', 'text', true],
    ['email', 'Email address', lead.email || '', 'email', false],
    ['category', 'Category', lead.category || '', 'text', false],
    ['phone', 'Phone', lead.phone || '', 'tel', false],
    ['city', 'City', lead.city || '', 'text', false],
    ['state', 'State / region', lead.state || '', 'text', false],
    ['country', 'Country', lead.country || '', 'text', false],
    ['address', 'Street address', lead.address || '', 'text', false],
    ['website_url', 'Website', lead.website_url || '', 'url', false],
    ['facebook_url', 'Facebook page', lead.facebook_url || '', 'url', false],
    ['source_details', 'Source details', lead.source_details || '', 'text', false],
    ['source_url', 'Source URL', lead.source_url || '', 'url', false],
    ['consent_recorded_at', 'Consent evidence date', lead.consent_recorded_at || '', 'date', false],
    ['consent_method', 'Consent method / context', lead.consent_method || '', 'text', false],
    ['consent_evidence_url', 'Consent evidence URL', lead.consent_evidence_url || '', 'url', false],
  ];
  openDialog({
    title: 'Edit contact', eyebrow: 'CONTACT RECORD', submitLabel: 'Save contact',
    body: `<p class="contact-picker-intro">Profile changes cancel queued messages and require a fresh copy review. New email addresses remain unverified until you run verification. Source and consent evidence are operator-entered and not independently verified; empty consent fields mean no evidence was recorded, and these fields do not override suppression.</p><div class="contact-edit-grid">${fields.map(([name, label, value, type, required]) => `<label class="contact-edit-field"><span class="form-label">${label}${required ? ' *' : ''}</span><input class="form-input" type="${type}" name="${name}" value="${escapeHtml(value)}" maxlength="${name === 'address' || name.endsWith('_url') ? 2000 : name === 'email' ? 320 : name === 'source_details' ? 500 : 160}" ${required ? 'required' : ''} autocomplete="off"></label>`).join('')}${customFields.map(field => renderCustomFieldInput(field, savedValues.get(field.fieldKey))).join('')}</div>`,
    onSubmit: async form => {
      const updates = Object.fromEntries(fields.map(([name]) => [name, form.get(name)]));
      updates.custom_fields = Object.fromEntries(customFields.map(field => [field.fieldKey, form.get(`custom_field__${field.fieldKey}`) ?? '']));
      const result = await Leads.update(lead.id, updates);
      await _renderLeadsView(container);
      await window.__leadDetail(lead.id);
      notify(result.reviewRequired
        ? `Contact saved. ${result.cancelledSends} queued message(s) cancelled${result.inFlightSends ? `; ${result.inFlightSends} SMTP submission(s) already in progress may still finish` : ''}; copy needs review${result.verificationRequired ? ' and the new email needs verification' : ''}.`
        : 'Contact details saved.');
    },
  });
}

function openContactDeleteDialog(lead, container) {
  openDialog({
    title: 'Permanently delete contact', eyebrow: 'REMOVE CONTACT DATA', submitLabel: 'Delete contact',
    body: `<p class="contact-delete-warning">This permanently removes <strong>${escapeHtml(lead.business_name)}</strong>, its email verification rows, tags, list memberships, unsent campaign enrollment, and contact activity. Existing suppression entries stay in place. Contacts with any send history cannot be deleted, so SMTP evidence is retained.</p><label class="contact-edit-field"><span class="form-label">Type the contact name to confirm</span><input class="form-input" name="confirm_name" autocomplete="off" required></label>`,
    onSubmit: async form => {
      if (form.get('confirm_name') !== lead.business_name) throw new Error('Enter the contact name exactly as shown to confirm deletion.');
      await Leads.remove(lead.id);
      await _renderLeadsView(container);
      notify(`${lead.business_name} was deleted. Suppression records were preserved.`);
    },
  });
}

async function openBulkContactTagEditor(container) {
  const leadIds = [..._selectedContactIds];
  if (!leadIds.length) return;
  const tags = await ContactTags.list();
  _tags = tags;
  if (!tags.length) {
    await _renderLeadsView(container);
    notify('Create an active tag from a contact’s Edit tags panel before assigning tags in bulk.', 'error');
    return;
  }
  openDialog({
    title: `Assign tags to ${fmtNum(leadIds.length)} contacts`, eyebrow: 'BULK CONTACT ORGANIZATION', submitLabel: 'Assign tags',
    body: `<p class="contact-picker-intro">Selected tags are added to every selected contact. Existing tags are kept. This does not change verification, suppression, campaign enrollment, contact fields, or sending history.</p><div class="contact-tag-options">${tags.map(tag => `<label class="contact-tag-option"><input type="checkbox" name="tagId" value="${tag.id}"><span>${escapeHtml(tag.name)}</span><small>${fmtNum(tag.contact_count)} contacts</small></label>`).join('')}</div>`,
    onSubmit: async form => {
      const tagIds = form.getAll('tagId').map(Number);
      if (!tagIds.length) throw new Error('Select at least one active tag.');
      const result = await ContactTags.assignMany(leadIds, tagIds);
      _selectedContactIds.clear();
      _tags = await ContactTags.list();
      await _renderLeadsView(container);
      notify(`Added ${fmtNum(result.assignmentsAdded)} tag assignment(s) across ${fmtNum(result.changedContacts)} contact(s).`);
    },
  });
}

async function openBulkContactListEditor(container) {
  const leadIds = [..._selectedContactIds];
  if (!leadIds.length) return;
  const result = await Lists.list({ include_archived: false, limit: 200 });
  const lists = (result.items || []).filter(item => item.status === 'active');
  if (!lists.length) {
    notify('Create an active saved list on the Contact Lists page before adding contacts.', 'error');
    return;
  }
  let availableLists = lists;
  let searchVersion = 0;
  let searchTimer;
  let searching = false;
  const dialog = openDialog({
    title: `Add ${fmtNum(leadIds.length)} contacts to a list`, eyebrow: 'BULK CONTACT ORGANIZATION', submitLabel: 'Add contacts',
    body: `<p class="contact-picker-intro">This adds the selected contacts to one active saved list. Existing memberships are left unchanged. Contact records, suppression, verification, campaign enrollment and sending history are not changed.</p><label class="contact-edit-field"><span class="form-label">Find an active list</span><input class="form-input" type="search" data-bulk-list-search placeholder="Search list names…" autocomplete="off"></label><label class="contact-edit-field"><span class="form-label">Active saved list *</span><select class="filter-select" name="listId" required><option value="">Choose a list</option>${lists.map(list => `<option value="${list.id}">${escapeHtml(list.name)} · ${fmtNum(list.contact_count)} contacts</option>`).join('')}</select></label><p class="contact-picker-intro" data-bulk-list-search-note>${result.pagination?.hasMore ? 'More than 200 active lists match. Type a name to narrow the choices.' : `${fmtNum(lists.length)} active list(s)`}</p>`,
    onSubmit: async form => {
      if (searching) throw new Error('Wait for the active list search to finish.');
      const listId = Number(form.get('listId'));
      if (!Number.isSafeInteger(listId) || listId < 1) throw new Error('Choose an active saved list.');
      const selectedList = availableLists.find(list => Number(list.id) === listId);
      if (!selectedList) throw new Error('That list is no longer available. Refresh the Contacts page and try again.');
      const added = await Lists.addMembers(listId, leadIds);
      _selectedContactIds.clear();
      await _renderLeadsView(container);
      notify(`${fmtNum(added.added)} added to ${selectedList.name} · ${fmtNum(added.alreadyMember)} already on the list.`);
    },
  });
  const search = dialog.querySelector('[data-bulk-list-search]');
  const select = dialog.querySelector('[name="listId"]');
  const note = dialog.querySelector('[data-bulk-list-search-note]');
  const submit = dialog.querySelector('[type="submit"]');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const version = ++searchVersion;
    searching = true;
    select.disabled = true;
    submit.disabled = true;
    note.textContent = 'Searching active lists…';
    searchTimer = setTimeout(async () => {
      const previous = select.value;
      try {
        const response = await Lists.list({ include_archived: false, search: search.value.trim(), limit: 200 });
        if (version !== searchVersion || !dialog.isConnected) return;
        availableLists = (response.items || []).filter(item => item.status === 'active');
        select.innerHTML = `<option value="">${availableLists.length ? 'Choose a list' : 'No active lists match'}</option>${availableLists.map(list => `<option value="${list.id}">${escapeHtml(list.name)} · ${fmtNum(list.contact_count)} contacts</option>`).join('')}`;
        if (availableLists.some(list => String(list.id) === previous)) select.value = previous;
        select.disabled = availableLists.length === 0;
        note.textContent = response.pagination?.hasMore
          ? 'More than 200 active lists match. Type more of the name to narrow the choices.'
          : `${fmtNum(availableLists.length)} active list(s)`;
      } catch (error) {
        if (version === searchVersion && dialog.isConnected) {
          availableLists = [];
          select.innerHTML = '<option value="">Search failed</option>';
          select.disabled = true;
          note.textContent = error.message || 'Could not search active lists.';
        }
      } finally {
        if (version === searchVersion && dialog.isConnected) {
          searching = false;
          submit.disabled = false;
        }
      }
    }, 180);
  });
  dialog.addEventListener('close', () => clearTimeout(searchTimer), { once: true });
}

async function openContactTagEditor(lead, container) {
  const tags = await ContactTags.list();
  const selected = new Set((lead.tags || []).map(tag => Number(tag.id)));
  openDialog({
    title: 'Edit contact tags', eyebrow: 'CONTACT ORGANIZATION', submitLabel: 'Save tags',
    body: `<p class="contact-picker-intro">Tags help filter contacts. Assignments are saved with this contact and do not alter list membership, verification, or sending history.</p><div class="contact-tag-options">${tags.length ? tags.map(tag => `<label class="contact-tag-option"><input type="checkbox" name="tagId" value="${tag.id}" ${selected.has(Number(tag.id)) ? 'checked' : ''}><span>${escapeHtml(tag.name)}</span><small>${fmtNum(tag.contact_count)} contacts</small></label>`).join('') : '<p class="text-muted">No tags yet. Create the first one below.</p>'}</div><label class="contact-edit-field"><span class="form-label">Create and assign a new tag (optional)</span><input class="form-input" name="createTag" maxlength="50" placeholder="e.g. Summer event"></label><p class="contact-picker-intro">Leave every tag unchecked and the new-tag field empty to remove all active tags.</p>`,
    onSubmit: async form => {
      const result = await ContactTags.assign(lead.id, form.getAll('tagId').map(Number), form.get('createTag') || '');
      _tags = await ContactTags.list();
      await _renderLeadsView(container);
      await window.__leadDetail(lead.id);
      notify(`${result.tags.length} tag(s) saved on ${lead.business_name}.`);
    },
  });
}

export function renderLeadDetail(lead) {
  const site = SITE_STATUS_BADGE[lead.site_status];
  const emailDiscovery = lead.email_discovery;
  const refreshStatus = emailDiscovery?.latest_refresh;
  const refreshStateLabels = {
    present: 'Seen on last successful refresh',
    not_present: 'Not seen on last successful refresh',
    not_rechecked: 'Not rechecked during the latest refresh',
    blocked: 'Not rechecked · access or robots restriction',
    unavailable: 'Not rechecked · source unavailable',
    missing: 'Not rechecked · source page missing',
    unsupported: 'Not rechecked · unsupported page type',
  };
  let websiteHref = '';
  try { const candidate = new URL(lead.website_url); if (['http:', 'https:'].includes(candidate.protocol)) websiteHref = candidate.href; } catch { /* display stored value as text only */ }
  const customFields = lead.customFields || [];
  const scanStatusText = emailDiscovery ? ({
    running: 'The one-time scan is in progress.',
    completed: emailDiscovery.error_code === 'contact_form_only'
      ? 'No public email was found; this site exposes a public contact form only. No fields were submitted or values collected; see its saved source evidence below.'
      : emailDiscovery.error_code === 'email_not_found'
        ? 'The scanned public pages did not expose an email address.'
        : emailDiscovery.error_code === 'no_public_html_pages'
          ? 'No public HTML page was available to scan.'
          : emailDiscovery.error_code === 'rendered_fallback_unavailable'
            ? 'The JavaScript page fallback could not load within its safety limits; no address was confirmed from rendered content.'
          : emailDiscovery.error_code === 'pdf_no_company_match'
            ? 'A linked PDF was read, but no address could be confidently matched to this business.'
            : emailDiscovery.error_code === 'pdf_no_text_layer'
              ? 'A linked PDF has no selectable text. OCR is not enabled, so no address was inferred from images.'
              : emailDiscovery.error_code === 'pdf_extraction_limit_reached'
                ? `PDF extraction reached its page or text limit; ${Number(emailDiscovery.found_count) || 0} matched address(es) were retained.`
                : ['pdf_text_extraction_failed', 'pdf_parse_timeout', 'pdf_size_limit', 'pdf_parser_busy', 'pdf_signature_invalid']
                  .includes(emailDiscovery.error_code)
                  ? `A linked PDF could not be safely read (${emailDiscovery.error_code.replaceAll('_', ' ')}).`
          : `Scan complete · ${Number(emailDiscovery.found_count) || 0} address(es) found.`,
    blocked: 'Scan stopped because the site or its robots policy restricted access.',
    failed: 'The one-time scan stopped safely. No automatic retry was made.',
    interrupted: 'The scan was interrupted and will not be repeated automatically.',
  }[emailDiscovery.status] || 'A website scan attempt is recorded.') : '';
  return `
  <div class="detail-section contact-detail-actions"><button type="button" class="btn btn-primary btn-sm" data-edit-contact>${icon('diagonal', 14)} Edit contact</button><button type="button" class="btn btn-danger btn-sm" data-delete-contact>Delete contact</button></div>
  <div class="detail-section"><div class="contact-tag-heading"><div class="detail-label">Tags</div><button type="button" class="btn btn-ghost btn-sm" data-edit-tags>Edit tags</button></div><div class="contact-tag-list">${lead.tags?.length ? lead.tags.map(tag => `<span class="contact-tag-pill">${escapeHtml(tag.name)}</span>`).join('') : '<span class="text-muted">No tags assigned</span>'}</div></div>
  ${customFields.length ? `<div class="detail-section"><div class="detail-label">Custom fields</div><div class="detail-grid-2">${customFields.map(field => {
    const value = field.value === null || field.value === undefined || field.value === '' ? '—' : field.type === 'boolean' ? (field.value ? 'Yes' : 'No') : String(field.value);
    return `<div class="contact-custom-value"><label>${escapeHtml(field.name)}${field.status === 'archived' ? ' · archived' : ''}</label><div>${escapeHtml(value)}</div></div>`;
  }).join('')}</div></div>` : ''}
  <div class="detail-section"><div class="detail-label">Source and consent evidence</div><div class="detail-grid-2">
    <div><label>Added via</label><div>${escapeHtml(lead.source || 'Unknown')}</div></div>
    <div><label>Source details</label><div>${escapeHtml(lead.source_details || 'Not recorded')}</div></div>
    ${lead.source_url ? `<div><label>Source URL</label><div>${safeHttpHref(lead.source_url) ? `<a href="${escapeHtml(safeHttpHref(lead.source_url))}" rel="noopener noreferrer" target="_blank" class="detail-link">${escapeHtml(lead.source_url)}</a>` : escapeHtml(lead.source_url)}</div></div>` : ''}
    <div><label>Consent evidence date</label><div>${escapeHtml(lead.consent_recorded_at || 'Not recorded')}</div></div>
    <div><label>Consent method / context</label><div>${escapeHtml(lead.consent_method || 'Not recorded')}</div></div>
    ${lead.consent_evidence_url ? `<div><label>Consent evidence URL</label><div>${safeHttpHref(lead.consent_evidence_url) ? `<a href="${escapeHtml(safeHttpHref(lead.consent_evidence_url))}" rel="noopener noreferrer" target="_blank" class="detail-link">${escapeHtml(lead.consent_evidence_url)}</a>` : escapeHtml(lead.consent_evidence_url)}</div></div>` : ''}
    <small>Operator-entered evidence is not independently verified and does not override global suppression or establish permission to send.</small>
  </div></div>
  ${lead.profile_source_evidence?.length ? `<div class="detail-section"><div class="detail-label">Business profile source evidence</div>${lead.profile_source_evidence.map(source => `<div class="contact-email-source">${safeHttpHref(source.source_url) ? `<a href="${escapeHtml(safeHttpHref(source.source_url))}" rel="noopener noreferrer" target="_blank">${escapeHtml(source.source_url)}</a>` : escapeHtml(source.source_url)} · ${escapeHtml(source.evidence_type)}${source.observed_at ? ` · ${escapeHtml(relTime(source.observed_at))}` : ''}${source.raw_excerpt ? `<span class="contact-email-excerpt">Observed: ${escapeHtml(source.raw_excerpt)}</span>` : ''}<small>Content ${escapeHtml(String(source.content_hash || '').slice(0, 16))} · ${escapeHtml(source.extractor_version || 'extractor version unknown')}</small></div>`).join('')}</div>` : ''}
  <div class="detail-section">
    <div class="detail-grid-2">
      <div><label>Category</label><div>${escapeHtml(lead.category || '—')}</div></div>
      <div><label>City</label><div>${escapeHtml(lead.city || '—')}</div></div>
      <div><label>State / region</label><div>${escapeHtml(lead.state || '—')}</div></div>
      <div><label>Country</label><div>${escapeHtml(lead.country || '—')}</div></div>
      <div><label>Business address</label><div>${escapeHtml(lead.address || '—')}</div></div>
      <div><label>Phone</label><div>${escapeHtml(lead.phone || '—')}</div></div>
      ${safeFacebookHref(lead.facebook_url) ? `<div><label>Facebook business page</label><div><a href="${escapeHtml(safeFacebookHref(lead.facebook_url))}" rel="noopener noreferrer" target="_blank" class="detail-link">${escapeHtml(safeFacebookHref(lead.facebook_url))}</a></div></div>` : ''}
      <div><label>Rating</label><div>${lead.rating ? `★ ${lead.rating} (${lead.reviews} reviews)` : '—'}</div></div>
    </div>
  </div>

  ${lead.website_url ? `
  <div class="detail-section">
    <div class="detail-label">Website</div>
    ${websiteHref ? `<a href="${escapeHtml(websiteHref)}" rel="noopener noreferrer" target="_blank" class="detail-link">${escapeHtml(lead.website_url)}</a>` : `<span class="detail-link">${escapeHtml(lead.website_url)}</span>`}
    ${site ? `<span class="site-status-chip ml-8" style="color:${site.color};border-color:${site.color}44">${site.label}</span>` : ''}
    ${lead.site_score ? `<span style="font-size:0.72rem;color:var(--text-muted);margin-left:8px">Score: ${lead.site_score}/10</span>` : ''}
  </div>` : ''}

  <div class="detail-section">
    <div class="detail-label">Public website email discovery</div>
    ${lead.website_url
      ? emailDiscovery
        ? `<p class="text-muted" role="status">${escapeHtml(scanStatusText)} This result is not email verification or permission to send.</p>${refreshStatus ? `<p class="text-muted" role="status">Latest refresh: ${escapeHtml(refreshStatus.status)}${refreshStatus.generation ? ` · generation ${Number(refreshStatus.generation)}` : ''}${refreshStatus.completed_at ? ` · ${escapeHtml(relTime(refreshStatus.completed_at))}` : ''}. Historical evidence is retained; pages that were blocked or unavailable remain unchecked.</p>` : ''}${emailDiscovery.refreshable ? `<p class="text-muted">Refresh checks only ${fmtNum(emailDiscovery.refresh_page_count)} previously saved public page(s), subject to current site rules. It does not verify addresses or send messages.</p><button type="button" class="btn btn-secondary btn-sm" data-website-email-refresh>Refresh ${fmtNum(emailDiscovery.refresh_page_count)} saved pages</button>` : ''}`
        : `<p class="text-muted">Run one low-rate scan of this contact’s website. It checks robots.txt and records the page source. Found addresses stay unverified.</p><button type="button" class="btn btn-secondary btn-sm" data-website-email-scan>Find public emails once</button>`
      : '<p class="text-muted">Add a public website to this contact before scanning.</p>'}
  </div>

  ${lead.emails?.length ? `
  <div class="detail-section">
    <div class="detail-label">Email Addresses</div>
    ${lead.emails.map(e => `
    <div class="detail-email-row">
      <span class="detail-email">${escapeHtml(e.email)}</span>
      ${e.source_conflict ? `<p class="contact-source-conflict" role="status"><strong>Source disagreement · refresh ${Number(e.source_conflict.generation)}</strong><br>This address was absent from one successfully refreshed page and present on another. The contact and saved source evidence are retained; the address remains unverified.</p>` : ''}
      <span class="badge-tiny" style="color:${e.verification_status === 'deliverable' ? 'var(--emerald)' : 'var(--amber)'}">
        ${escapeHtml(e.verification_status || 'unverified')}
      </span>
      ${e.is_suppressed ? `<span class="contact-suppression-badge" title="This address is globally blocked from sending">Suppressed · ${escapeHtml(String(e.suppression_reason || 'global suppression').slice(0, 200))}</span>` : ''}
      ${e.source_evidence?.map(source => safeHttpHref(source.source_url)
        ? `<small class="contact-email-source">Source: <a href="${escapeHtml(safeHttpHref(source.source_url))}" rel="noopener noreferrer" target="_blank">${escapeHtml(source.source_url)}</a>${source.evidence_type ? ` · ${escapeHtml(source.evidence_type.replaceAll('_', ' '))}` : ''}${source.observed_at ? ` · ${escapeHtml(relTime(source.observed_at))}` : ''}${source.refresh_state ? `<span class="contact-email-excerpt">${escapeHtml(refreshStateLabels[source.refresh_state] || 'Not rechecked')}</span>` : ''}${source.refresh_history?.length ? `<details class="contact-source-history"><summary>Refresh history · ${fmtNum(source.refresh_history.length)} generation(s)</summary>${source.refresh_history.map(history => `<span class="contact-email-excerpt">Generation ${Number(history.generation)} · ${escapeHtml(history.status)} · ${escapeHtml(history.state)}${history.observed_at ? ` · ${escapeHtml(relTime(history.observed_at))}` : ''}${history.prior_content_hash ? `<br>Prior content ${escapeHtml(history.prior_content_hash.slice(0, 16))} · ${escapeHtml(history.prior_extractor_version || 'extractor unknown')}` : ''}${history.prior_excerpt ? `<br>Prior excerpt: ${escapeHtml(history.prior_excerpt)}` : ''}${history.current_content_hash ? `<br>Current content ${escapeHtml(history.current_content_hash.slice(0, 16))} · ${escapeHtml(history.current_extractor_version || 'extractor unknown')}` : ''}${history.current_excerpt ? `<br>Current excerpt: ${escapeHtml(history.current_excerpt)}` : ''}</span>`).join('')}</details>` : ''}${source.contact_points?.map(point => `<span class="contact-email-excerpt">Contact type: ${escapeHtml(point.contact_type || 'not listed')}${point.contact_name ? ` · Contact: ${escapeHtml(point.contact_name)}` : ''}${point.contact_title ? ` · Role: ${escapeHtml(point.contact_title)}` : ''}</span>`).join('') || ''}${source.raw_excerpt ? `<span class="contact-email-excerpt">Observed: ${escapeHtml(source.raw_excerpt)}</span>` : ''}</small>`
        : '').join('') || ''}
    </div>`).join('')}
  </div>` : ''}

  ${lead.events?.length ? `
  <div class="detail-section">
    <div class="detail-label">Event History</div>
    <div class="detail-events">
      ${lead.events.map(e => `
      <div class="detail-event-row">
        <span class="detail-event-type">${escapeHtml(e.event_type)}</span>
        <span class="detail-event-time">${escapeHtml(relTime(e.event_at))}</span>
      </div>`).join('')}
    </div>
  </div>` : ''}`;
}
