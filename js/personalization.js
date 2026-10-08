// ============================================================
//  ODD-ECOSYS — Personalization Dashboard (Phase 5)
//  Ollama connection status, batch controls, approval queue,
//  copy editor, guardrail details, fact-check results
// ============================================================
import { Batches, Personalize, relTime, fmtNum } from './api.js';

let _batches = [];
let _selectedBatch = null;
let _activeFilter = 'awaiting';
let _pollInterval = null;
let _editingId = null;

export async function renderPersonalization(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading personalization engine…</span></div>`;

  _batches = await Batches.list() || [];
  if (!_selectedBatch && _batches.length > 0) {
    const active = _batches.find(b => b.status === 'processing' || b.status === 'open');
    _selectedBatch = active ? active.id : _batches[0].id;
  }

  container.innerHTML = `
  <div class="view-personalization">

    <!-- Header -->
    <div class="pers-header">
      <div class="pers-header-left">
        <h2 class="section-title">
          <svg width="22" height="22" fill="none" viewBox="0 0 22 22" style="vertical-align:-3px;margin-right:8px;">
            <path d="M4 6h14M4 10h10M4 14h7" stroke="var(--indigo-light)" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="17" cy="14" r="4" fill="var(--bg)" stroke="var(--violet)" stroke-width="1.5"/>
            <path d="M15.5 14l1 1 2-2" stroke="var(--violet)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Make every word count.
        </h2>
        <span style="font-size:0.78rem;color:var(--text-muted);margin-left:30px;">
          Draft with context. Check the facts. Add your human touch.
        </span>
      </div>
      <div class="pers-header-right">
        <div id="ollama-status" class="ollama-status-pill" onclick="window.__checkOllama()">
          <span class="pulse-dot muted"></span> checking Ollama…
        </div>
        <select id="pers-batch-select" class="batch-select">
          ${_batches.length ? '' : '<option value="">Create a batch to begin</option>'}
          ${_batches.map(b => `<option value="${b.id}" ${b.id === _selectedBatch ? 'selected' : ''}>${b.name || 'Batch #' + b.id}</option>`).join('')}
        </select>
        <button id="pers-run-btn" class="btn btn-primary btn-sm" ${_selectedBatch ? '' : 'disabled title="Create a batch first"'} onclick="window.__persRun()">
          <span class="btn-icon">🤖</span> Personalize Batch
        </button>
        <button id="pers-cancel-btn" class="btn-danger" onclick="window.__persCancel()" style="display:none;">
          <span class="btn-icon">⏹</span> Cancel
        </button>
      </div>
    </div>

    <!-- Progress bar -->
    <div id="pers-progress-wrap" class="verify-progress-wrap" style="display:none;">
      <div class="verify-progress-bar">
        <div id="pers-progress-fill" class="verify-progress-fill" style="background:linear-gradient(90deg,var(--violet),var(--indigo))"></div>
      </div>
      <div class="verify-progress-info">
        <span id="pers-progress-text">0/0 leads personalized</span>
        <span id="pers-progress-lead" class="verify-progress-current"></span>
      </div>
    </div>

    <!-- Stats cards -->
    <div id="pers-stats-cards" class="pers-stats-grid">
      ${renderStatsCards({ total: 0, approved: 0, awaiting: 0, guardrail_failed: 0, factcheck_failed: 0 })}
    </div>

    <!-- Filter tabs -->
    <div class="verify-tabs">
      <button class="verify-tab" data-filter="all" onclick="window.__persFilter(this,'all')">All</button>
      <button class="verify-tab active" data-filter="awaiting" onclick="window.__persFilter(this,'awaiting')">
        <span class="dot amber"></span> Awaiting Approval
      </button>
      <button class="verify-tab" data-filter="approved" onclick="window.__persFilter(this,'approved')">
        <span class="dot emerald"></span> Approved
      </button>
      <button class="verify-tab" data-filter="failed" onclick="window.__persFilter(this,'failed')">
        <span class="dot rose"></span> Guardrail Failed
      </button>
    </div>

    <!-- Personalization list -->
    <div id="pers-list" class="pers-list">
      <div class="empty-state">
        <div class="empty-icon">🤖</div>
        <p>Select a batch and click <strong>Personalize Batch</strong> to generate AI copy</p>
        <p class="empty-hint">Ollama generates 2 variant drafts per lead → guardrail check → subject line polish → fact-check → human approval gate</p>
      </div>
    </div>

    <!-- Edit modal (hidden) -->
    <div id="pers-edit-modal" class="pers-modal" style="display:none;">
      <div class="pers-modal-content">
        <div class="pers-modal-header">
          <span class="pers-modal-title">Edit Email Copy</span>
          <button onclick="window.__persCloseEdit()" style="background:none;border:none;color:var(--text-muted);font-size:1.2rem;cursor:pointer;">✕</button>
        </div>
        <div class="pers-modal-body">
          <label class="pers-field-label">Subject Line</label>
          <input id="edit-subject" type="text" class="quick-tool-input" style="width:100%;margin-bottom:12px;" />
          <label class="pers-field-label">Email Body</label>
          <textarea id="edit-body" class="pers-textarea" rows="10"></textarea>
          <div id="edit-word-count" style="font-size:0.7rem;color:var(--text-muted);text-align:right;margin-top:4px;"></div>
        </div>
        <div class="pers-modal-footer">
          <button class="btn-secondary" onclick="window.__persCloseEdit()">Cancel</button>
          <button class="btn-primary" onclick="window.__persSaveEdit()">Save & Approve</button>
        </div>
      </div>
    </div>

  </div>`;

  // Wire events
  document.getElementById('pers-batch-select')?.addEventListener('change', e => {
    _selectedBatch = parseInt(e.target.value);
    loadList();
    loadStats();
  });

  window.__persRun = startPersonalization;
  window.__persCancel = cancelPersonalization;
  window.__persFilter = filterList;
  window.__checkOllama = checkOllamaStatus;
  window.__persApprove = approveItem;
  window.__persReject = rejectItem;
  window.__persEdit = openEdit;
  window.__persCloseEdit = closeEdit;
  window.__persSaveEdit = saveEdit;

  // Auto-update word count in textarea
  document.getElementById('edit-body')?.addEventListener('input', updateWordCount);

  // Initial load
  checkOllamaStatus();
  loadList();
  loadStats();
}

// ── Ollama Status ─────────────────────────────────────────────
async function checkOllamaStatus() {
  const el = document.getElementById('ollama-status');
  if (!el) return;
  el.innerHTML = `<span class="pulse-dot warning"></span> checking…`;

  try {
    const res = await fetch('/api/personalize/ollama-test');
    const data = await res.json();

    if (data.connected) {
      const models = data.models.join(', ') || 'no models';
      el.innerHTML = `<span class="pulse-dot" style="background:var(--emerald)"></span> Ollama online · ${data.models.length} model(s)`;
      el.style.borderColor = 'rgba(16,185,129,0.3)';
      el.title = `Models: ${models}`;
    } else {
      el.innerHTML = `<span class="pulse-dot warning"></span> Ollama offline — template fallback active`;
      el.style.borderColor = 'rgba(245,158,11,0.3)';
    }
  } catch {
    el.innerHTML = `<span class="pulse-dot warning"></span> Ollama offline`;
  }
}

// ── Stats Cards ───────────────────────────────────────────────
function renderStatsCards(stats) {
  const cards = [
    { key: 'total',           label: 'Total Generated', color: 'var(--indigo-light)', icon: '🤖' },
    { key: 'approved',        label: 'Approved',        color: 'var(--emerald)',       icon: '✓' },
    { key: 'awaiting',        label: 'Awaiting Review', color: 'var(--amber)',         icon: '⏳' },
    { key: 'guardrail_failed',label: 'Guardrail Issues', color: 'var(--rose)',         icon: '✗' },
  ];

  return cards.map(c => `
    <div class="verify-status-card" style="--card-accent:${c.color}">
      <div class="verify-card-icon" style="color:${c.color};font-size:1.4rem;">${c.icon}</div>
      <div class="verify-card-body">
        <div class="verify-card-count" data-target="${stats[c.key] || 0}">0</div>
        <div class="verify-card-label">${c.label}</div>
      </div>
    </div>`).join('');
}

// ── Start Personalization ─────────────────────────────────────
async function startPersonalization() {
  const runBtn = document.getElementById('pers-run-btn');
  const cancelBtn = document.getElementById('pers-cancel-btn');
  const progressWrap = document.getElementById('pers-progress-wrap');

  if (runBtn) runBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  if (progressWrap) progressWrap.style.display = 'block';

  try {
    await fetch(`/api/personalize/batch/${_selectedBatch}`, { method: 'POST' });
    startPolling();
  } catch (err) {
    if (runBtn) runBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'none';
  }
}

async function cancelPersonalization() {
  await fetch('/api/personalize/cancel', { method: 'POST' }).catch(() => {});
}

// ── Polling ───────────────────────────────────────────────────
function startPolling() {
  if (_pollInterval) clearInterval(_pollInterval);
  _pollInterval = setInterval(pollStatus, 1500);
}

async function pollStatus() {
  try {
    const res = await fetch('/api/personalize/status');
    const data = await res.json();

    if (!data.active && data.processed > 0) {
      stopPolling();
      loadList();
      loadStats();
      return;
    }

    if (!data.active) return;

    const fill = document.getElementById('pers-progress-fill');
    const text = document.getElementById('pers-progress-text');
    const lead = document.getElementById('pers-progress-lead');
    const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;

    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${data.processed}/${data.total} leads personalized (${pct}%)`;
    if (lead) lead.textContent = data.currentLead ? `✍ ${data.currentLead}` : '';

    if (data.processed > 0 && data.processed % 3 === 0) {
      loadList();
      loadStats();
    }
  } catch { /* ignore */ }
}

function stopPolling() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  const runBtn = document.getElementById('pers-run-btn');
  const cancelBtn = document.getElementById('pers-cancel-btn');
  if (runBtn) runBtn.style.display = 'inline-flex';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

// ── Load List ─────────────────────────────────────────────────
async function loadList() {
  const container = document.getElementById('pers-list');
  if (!container) return;

  try {
    let url = `/api/personalize/list?limit=100`;
    if (_selectedBatch) url += `&batch_id=${_selectedBatch}`;
    if (_activeFilter && _activeFilter !== 'all') url += `&status=${_activeFilter}`;

    const res = await fetch(url);
    const items = await res.json();

    if (!items || items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🤖</div>
          <p>No personalizations yet for this filter</p>
          <p class="empty-hint">Click <strong>Personalize Batch</strong> to start generating email copy</p>
        </div>`;
      return;
    }

    // Group by lead
    const byLead = {};
    for (const item of items) {
      if (!byLead[item.lead_id]) byLead[item.lead_id] = { lead: item, variants: [] };
      byLead[item.lead_id].variants.push(item);
    }

    container.innerHTML = Object.values(byLead).map(({ lead, variants }) =>
      renderPersonalizationCard(lead, variants)
    ).join('');

  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p style="color:var(--rose)">Error loading: ${err.message}</p></div>`;
  }
}

// ── Load Stats ────────────────────────────────────────────────
async function loadStats() {
  try {
    let url = '/api/personalize/stats';
    if (_selectedBatch) url += `?batch_id=${_selectedBatch}`;

    const res = await fetch(url);
    const stats = await res.json();

    const cardsEl = document.getElementById('pers-stats-cards');
    if (cardsEl) {
      cardsEl.innerHTML = renderStatsCards(stats);
      cardsEl.querySelectorAll('.verify-card-count').forEach(el => {
        const target = parseInt(el.dataset.target) || 0;
        animCounterInline(el, target, 600);
      });
    }
  } catch { /* ignore */ }
}

function animCounterInline(el, target, duration = 600) {
  const start = performance.now();
  const from = parseInt(el.textContent) || 0;
  const tick = (now) => {
    const p = Math.min((now - start) / duration, 1);
    el.textContent = Math.round(from + (target - from) * p);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Filter ────────────────────────────────────────────────────
function filterList(tabEl, filter) {
  _activeFilter = filter;
  document.querySelectorAll('.verify-tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  loadList();
}

// ── Render card ───────────────────────────────────────────────
function renderPersonalizationCard(lead, variants) {
  const statusBadge = lead.lead_status === 'awaiting_approval'
    ? '<span class="status-badge badge-risky">⏳ Awaiting Review</span>'
    : lead.lead_status === 'queued'
      ? '<span class="status-badge badge-deliverable">✓ Queued to Send</span>'
      : `<span class="status-badge badge-unknown">${lead.lead_status}</span>`;

  return `
  <div class="pers-card" data-lead-id="${lead.lead_id}">
    <div class="pers-card-header">
      <div class="pers-card-business">
        <span class="pers-card-name">${lead.business_name}</span>
        <span class="pers-card-meta">${lead.category || ''} · ${lead.city || ''}</span>
        ${lead.rating ? `<span class="pers-card-rating">★ ${lead.rating} (${lead.reviews})</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${statusBadge}
        <span class="pers-card-email">${lead.recipient_email || '—'}</span>
      </div>
    </div>

    <div class="pers-variants">
      ${variants.map(v => renderVariantBlock(v)).join('')}
    </div>
  </div>`;
}

function renderVariantBlock(v) {
  const guardrailBadge = v.guardrail_passed
    ? '<span class="check-dot pass" title="Guardrail passed">✓</span>'
    : '<span class="check-dot fail" title="Guardrail failed">✗</span>';
  const factBadge = v.fact_check_passed
    ? '<span class="check-dot pass" title="Fact-check passed">✓</span>'
    : '<span class="check-dot fail" title="Fact-check issues">✗</span>';
  const approvedBadge = v.approved
    ? '<span class="flag-tag role" style="background:rgba(16,185,129,0.15);color:var(--emerald);border-color:rgba(16,185,129,0.3);">Approved</span>'
    : '';

  const canApprove = v.guardrail_passed && !v.approved;
  const variantColor = v.subject_variant === 'A' ? 'var(--indigo-light)' : 'var(--violet)';

  return `
  <div class="pers-variant ${v.approved ? 'approved' : ''} ${!v.guardrail_passed ? 'failed' : ''}">
    <div class="pers-variant-header">
      <span class="pers-variant-label" style="color:${variantColor}">Variant ${v.subject_variant || 'A'}</span>
      <div class="pers-variant-checks">
        <span style="font-size:0.65rem;color:var(--text-muted)">Guard</span>${guardrailBadge}
        <span style="font-size:0.65rem;color:var(--text-muted)">Facts</span>${factBadge}
        ${approvedBadge}
      </div>
    </div>
    <div class="pers-subject">
      <span class="pers-subject-label">Subject:</span>
      <span class="pers-subject-text">${v.subject_line || '—'}</span>
    </div>
    <div class="pers-body">${(v.body_text || '').replace(/\n/g, '<br>')}</div>
    <div class="pers-variant-actions">
      ${canApprove ? `
        <button class="btn-xs" style="color:var(--emerald);border-color:rgba(16,185,129,0.3)" onclick="window.__persApprove(${v.id})">✓ Approve</button>
        <button class="btn-xs" style="color:var(--rose);border-color:rgba(244,63,94,0.3)" onclick="window.__persReject(${v.id})">✗ Reject</button>
      ` : ''}
      <button class="btn-xs" onclick="window.__persEdit(${v.id},'${escHtml(v.subject_line)}',\`${escHtml(v.body_text)}\`)">✎ Edit</button>
      <span style="font-size:0.65rem;color:var(--text-muted);margin-left:auto">${v.model_used || ''}</span>
    </div>
  </div>`;
}

function escHtml(str) {
  return (str || '').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

// ── Approve / Reject ──────────────────────────────────────────
async function approveItem(id) {
  await fetch(`/api/personalize/approve/${id}`, { method: 'POST' }).catch(() => {});
  loadList();
  loadStats();
}

async function rejectItem(id) {
  await fetch(`/api/personalize/reject/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'human_rejected' }) }).catch(() => {});
  loadList();
  loadStats();
}

// ── Edit Modal ────────────────────────────────────────────────
function openEdit(id, subject, body) {
  _editingId = id;
  const modal = document.getElementById('pers-edit-modal');
  const subjectInput = document.getElementById('edit-subject');
  const bodyInput = document.getElementById('edit-body');

  if (subjectInput) subjectInput.value = subject;
  if (bodyInput) { bodyInput.value = body; updateWordCount(); }
  if (modal) modal.style.display = 'flex';
}

function closeEdit() {
  _editingId = null;
  const modal = document.getElementById('pers-edit-modal');
  if (modal) modal.style.display = 'none';
}

async function saveEdit() {
  if (!_editingId) return;
  const subject = document.getElementById('edit-subject')?.value;
  const body = document.getElementById('edit-body')?.value;

  try {
    await fetch(`/api/personalize/${_editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_line: subject, body_text: body }),
    });
    closeEdit();
    loadList();
    loadStats();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

function updateWordCount() {
  const body = document.getElementById('edit-body')?.value || '';
  const el = document.getElementById('edit-word-count');
  if (el) {
    const words = body.trim().split(/\s+/).length;
    const color = words > 130 ? 'var(--rose)' : words < 40 ? 'var(--amber)' : 'var(--emerald)';
    el.innerHTML = `<span style="color:${color}">${words} words</span> (target: 40–130)`;
  }
}
