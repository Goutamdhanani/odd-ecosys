// ============================================================
//  ODD-ECOSYS — Verification Dashboard (Stage 5)
//  Email verification controls, status cards, results table,
//  quick-verify tool, and domain health view
// ============================================================

import { Batches, Verify, relTime } from './api.js';
import { icon, notify, userFacingError } from './ui.js';
import { downloadBlobFile } from './download.js';
import { renderQuickVerificationError, renderQuickVerificationResult, renderVerificationResultRow } from './verification-result-view.js';

// ── State ────────────────────────────────────────────────────
let _pollInterval = null;
let _selectedBatch = null;
let _activeFilter = null;
let _batches = [];
let _activeVerificationBatch = null;

// ── Render ───────────────────────────────────────────────────
export async function renderVerification(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading verification engine…</span></div>`;

  _batches = await Batches.list() || [];
  if (!_selectedBatch && _batches.length > 0) {
    const active = _batches.find(b => b.status === 'processing' || b.status === 'open');
    _selectedBatch = active ? active.id : _batches[0].id;
  }


  container.innerHTML = `
  <div class="view-verification">

    <!-- ─── Header bar ─────────────────────────────── -->
    <div class="verify-header">
      <div class="verify-header-left">
        <h2 class="section-title">
          <svg width="22" height="22" fill="none" viewBox="0 0 22 22" style="vertical-align:-3px;margin-right:6px;">
            <rect x="2" y="4" width="18" height="14" rx="2.5" stroke="var(--emerald)" stroke-width="1.5"/>
            <path d="M2 7l9 6 9-6" stroke="var(--emerald)" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="17" cy="6" r="4" fill="var(--bg)" stroke="var(--emerald)" stroke-width="1.5"/>
            <path d="M15.5 6l1 1 2-2" stroke="var(--emerald)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          A better signal, before you send.
        </h2>
        <span class="header-subtitle">Review verification results and their evidence. Unknown isn’t a pass.</span>
      </div>
      <div class="verify-header-right">
        <select id="verify-batch-select" class="batch-select">
          ${_batches.length ? '' : '<option value="">Create a batch to begin</option>'}
          ${_batches.map(b => `<option value="${b.id}" ${b.id === _selectedBatch ? 'selected' : ''}>${b.name || 'Batch #'+b.id} (${b.lead_count || 0} leads)</option>`).join('')}
        </select>
        <button id="verify-run-btn" class="btn btn-primary btn-sm" ${_selectedBatch ? '' : 'disabled title="Create a batch first"'} onclick="window.__verifyRun()">
          ${icon('shield', 15)} Verify emails
        </button>
        <button id="verify-export-btn" class="btn btn-ghost btn-sm" type="button" ${_selectedBatch ? '' : 'disabled'} onclick="window.__verifyExport()" title="Export all matching batch results, including rows beyond this page">${icon('download', 15)} Export CSV</button>
        <button id="verify-cancel-btn" class="btn-danger" onclick="window.__verifyCancel()" style="display:none;">
          <span class="btn-icon">⏹</span> Cancel
        </button>
      </div>
    </div>

    <!-- ─── Progress bar ───────────────────────────── -->
    <div id="verify-progress-wrap" class="verify-progress-wrap" style="display:none;">
      <div class="verify-progress-bar">
        <div id="verify-progress-fill" class="verify-progress-fill"></div>
      </div>
      <div class="verify-progress-info">
        <span id="verify-progress-text">0/0 emails verified</span>
        <span id="verify-progress-current" class="verify-progress-current"></span>
      </div>
    </div>

    <!-- ─── Status cards ───────────────────────────── -->
    <div class="verify-cards" id="verify-cards">
      ${renderStatusCards({ deliverable: 0, risky: 0, undeliverable: 0, unknown: 0 })}
    </div>

    <!-- ─── Quick verify tool ──────────────────────── -->
    <div class="verify-quick-tool">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div class="quick-tool-title" style="margin-bottom:0;">
          <svg width="16" height="16" fill="none" viewBox="0 0 18 18" style="vertical-align:-2px;margin-right:4px;">
            <circle cx="9" cy="9" r="7" stroke="var(--indigo-light)" stroke-width="1.5"/>
            <path d="M6 9l2 2 4-4" stroke="var(--indigo-light)" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          Quick Verify
        </div>
        <div id="reacher-engine-badge" style="font-size:0.72rem;padding:3px 10px;border-radius:12px;background:rgba(52,199,89,0.15);color:var(--system-green);border:1px solid rgba(52,199,89,0.3);font-weight:600;display:flex;align-items:center;gap:5px;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--system-green)"></span> Reacher Engine (Docker :8080)
        </div>
      </div>
      <div class="quick-tool-form">
        <input id="verify-quick-input" type="email" placeholder="user@example.com" class="quick-tool-input" />
        <button id="verify-quick-btn" class="btn-secondary" onclick="window.__verifyQuick()">Verify</button>
      </div>
      <div id="verify-quick-result" class="quick-tool-result" style="display:none;"></div>
    </div>

    <!-- ─── Filter tabs ────────────────────────────── -->
    <div class="verify-tabs">
      <button class="verify-tab active" data-filter="" onclick="window.__verifyFilter(this, '')">All</button>
      <button class="verify-tab" data-filter="deliverable" onclick="window.__verifyFilter(this, 'deliverable')">
        <span class="dot emerald"></span> Deliverable
      </button>
      <button class="verify-tab" data-filter="risky" onclick="window.__verifyFilter(this, 'risky')">
        <span class="dot amber"></span> Risky
      </button>
      <button class="verify-tab" data-filter="undeliverable" onclick="window.__verifyFilter(this, 'undeliverable')">
        <span class="dot rose"></span> Undeliverable
      </button>
      <button class="verify-tab" data-filter="unknown" onclick="window.__verifyFilter(this, 'unknown')">
        <span class="dot muted"></span> Unknown
      </button>
    </div>

    <!-- ─── Results table ──────────────────────────── -->
    <div class="verify-results" id="verify-results">
      <div class="empty-state">
        <div class="empty-icon">✉</div>
        <p>Select a batch and click <strong>Verify Emails</strong> to start</p>
        <p class="empty-hint">Emails will be checked for syntax, MX records, SMTP deliverability, and classified as deliverable / risky / undeliverable</p>
      </div>
    </div>

    <!-- ─── Domain health ──────────────────────────── -->
    <div class="verify-domain-health" id="verify-domain-health" style="display:none;">
      <h3 class="subsection-title">Domain Health Summary</h3>
      <div id="verify-domain-table"></div>
    </div>
  </div>`;

  // Wire up events
  document.getElementById('verify-batch-select')?.addEventListener('change', (e) => {
    _selectedBatch = parseInt(e.target.value) || null;
    const exportButton = document.getElementById('verify-export-btn');
    if (exportButton) exportButton.disabled = !_selectedBatch;
    loadResults();
    loadDistribution();
    refreshVerificationStatus();
  });

  window.__verifyRun = startVerification;
  window.__verifyCancel = cancelVerification;
  window.__verifyExport = exportVerificationResults;
  window.__verifyQuick = quickVerify;
  window.__verifyFilter = filterResults;

  // Initial load
  loadResults();
  loadDistribution();
  refreshVerificationStatus();
}

// ── Status Cards ─────────────────────────────────────────────
function renderStatusCards(counts) {
  const cards = [
    { key: 'deliverable',   label: 'Deliverable',   color: 'var(--emerald)', icon: '✓', desc: 'Ready to send' },
    { key: 'risky',         label: 'Risky',         color: 'var(--amber)',   icon: '⚠', desc: 'Catch-all / free / unconfirmed' },
    { key: 'undeliverable', label: 'Undeliverable', color: 'var(--rose)',    icon: '✗', desc: 'Bad / disposable / no MX' },
    { key: 'unknown',       label: 'Unknown',       color: '#64748b',        icon: '?', desc: 'Pending verification' },
  ];
  const total = Object.values(counts).reduce((s, v) => s + v, 0) || 1;

  return cards.map(c => {
    const count = counts[c.key] || 0;
    const pct = ((count / total) * 100).toFixed(1);
    return `
    <div class="verify-status-card" style="--card-accent:${c.color}">
      <div class="verify-card-icon" style="color:${c.color}">${c.icon}</div>
      <div class="verify-card-body">
        <div class="verify-card-count" data-target="${count}">0</div>
        <div class="verify-card-label">${c.label}</div>
        <div class="verify-card-pct">${pct}%</div>
        <div class="verify-card-desc">${c.desc}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Start Verification ───────────────────────────────────────
async function startVerification() {
  if (!_selectedBatch) return;

  const runBtn = document.getElementById('verify-run-btn');
  const cancelBtn = document.getElementById('verify-cancel-btn');
  const progressWrap = document.getElementById('verify-progress-wrap');

  if (runBtn) runBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.style.display = 'inline-flex';
  if (progressWrap) progressWrap.style.display = 'block';

  try {
    const result = await Verify.startBatch(_selectedBatch);
    renderVerificationProgress(result);
    if (result.active) startPolling();
    else { stopPolling(); loadResults(); loadDistribution(); }
  } catch (err) {
    console.error('Failed to start verification:', err);
    if (runBtn) runBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'block';
    const current = document.getElementById('verify-progress-current');
    if (current) current.textContent = userFacingError(err, 'Verification could not start. Try again.');
  }
}

async function exportVerificationResults() {
  if (!_selectedBatch) return;
  const button = document.getElementById('verify-export-btn');
  if (button) button.disabled = true;
  try {
    const { blob, filename } = await Verify.exportCsv(_selectedBatch, _activeFilter || undefined);
    downloadBlobFile(blob, filename);
    notify('Verification results exported.');
  } catch (error) {
    notify(error.message || 'Could not export verification results.', 'error');
  } finally {
    if (button) button.disabled = !_selectedBatch;
  }
}
async function cancelVerification() {
  try {
    const batchId = _activeVerificationBatch || _selectedBatch;
    const result = await Verify.cancelBatch(batchId);
    notify(result?.cancelling
      ? 'Cancellation requested. The active check will stop at its next safe checkpoint.'
      : 'There is no active verification job to cancel.', result?.cancelling ? 'info' : 'warning');
    await pollStatus();
  } catch (error) {
    const current = document.getElementById('verify-progress-current');
    if (current) current.textContent = userFacingError(error, 'Could not cancel verification. Try again.');
  }
}

// ── Polling ──────────────────────────────────────────────────
function startPolling() {
  if (_pollInterval) clearInterval(_pollInterval);
  _pollInterval = setInterval(pollStatus, 1200);
}

function stopPolling() {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
  const runBtn = document.getElementById('verify-run-btn');
  const cancelBtn = document.getElementById('verify-cancel-btn');
  if (runBtn) runBtn.style.display = 'inline-flex';
  if (cancelBtn) cancelBtn.style.display = 'none';
}

async function refreshVerificationStatus() {
  try {
    const data = await Verify.status(_selectedBatch);
    renderVerificationProgress(data);
    if (data.active) startPolling();
    else stopPolling();
  } catch (error) {
    const current = document.getElementById('verify-progress-current');
    if (current) current.textContent = error.message;
  }
}

function renderVerificationProgress(data) {
  const runBtn = document.getElementById('verify-run-btn');
  const cancelBtn = document.getElementById('verify-cancel-btn');
  const progressWrap = document.getElementById('verify-progress-wrap');
  const fill = document.getElementById('verify-progress-fill');
  const text = document.getElementById('verify-progress-text');
  const current = document.getElementById('verify-progress-current');
  const active = data.active === true;
  _activeVerificationBatch = active ? Number(data.batchId) : null;
  if (runBtn) runBtn.disabled = !_selectedBatch || active;
  if (cancelBtn) cancelBtn.style.display = active ? 'inline-flex' : 'none';
  if (progressWrap) progressWrap.style.display = data.jobId ? 'block' : 'none';
  if (!data.jobId) return;

  const total = Number(data.total) || 0;
  const processed = Number(data.processed) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : (data.status === 'completed' ? 100 : 0);
  if (fill) fill.style.width = `${pct}%`;
  const label = data.status === 'completed' ? 'Completed'
    : data.status === 'cancel_requested' ? 'Cancellation requested'
      : data.status === 'cancelled' ? 'Cancelled'
        : data.status === 'interrupted' ? 'Interrupted after restart'
          : data.status === 'failed' ? 'Failed'
            : active ? 'In progress' : data.status || 'Verification';
  if (text) text.textContent = `${label} · ${processed}/${total} contacts · ${pct}%`;
  if (current) {
    if (data.errorMessage) current.textContent = data.errorMessage;
    else if (active && data.currentEmail) current.textContent = `Checking: ${data.currentEmail}`;
    else if (active && Number(data.batchId) !== Number(_selectedBatch)) current.textContent = `This job is running for batch #${data.batchId}.`;
    else if (data.status === 'interrupted') current.textContent = 'The interrupted job was not restarted to avoid repeating provider checks. Start a new run to process remaining contacts.';
    else current.textContent = '';
  }
}

async function pollStatus() {
  try {
    const data = await Verify.status(_selectedBatch);
    renderVerificationProgress(data);
    if (!data.active) {
      stopPolling();
      if (data.jobId) {
        loadResults();
        loadDistribution();
      }
      return;
    }

    // Also refresh results periodically
    if (data.processed > 0 && data.processed % 5 === 0) {
      loadResults();
      loadDistribution();
    }
  } catch (error) {
    const current = document.getElementById('verify-progress-current');
    if (current) current.textContent = userFacingError(error, 'Could not read verification progress.');
  }
}

// ── Load Results ─────────────────────────────────────────────
async function loadResults() {
  if (!_selectedBatch) return;

  try {
    const data = await Verify.results(_selectedBatch, { limit: 200, status: _activeFilter || undefined });

    const container = document.getElementById('verify-results');
    if (!container) return;

    if (!data.results || data.results.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✉</div>
          <p>No verification results yet</p>
          <p class="empty-hint">Click <strong>Verify Emails</strong> to start checking email deliverability</p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <table class="data-table verify-results-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Business</th>
            <th>Status</th>
            <th>Verifier score</th>
            <th>MX</th>
            <th>Checks</th>
            <th>Flags</th>
            <th>Verified</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${data.results.map(r => renderResultRow(r)).join('')}
        </tbody>
      </table>
      <div class="table-footer">
        <span class="table-count">${data.total} results${_activeFilter ? ` (${_activeFilter})` : ''}</span>
      </div>`;

  } catch (err) {
    const container = document.getElementById('verify-results');
    if (container) container.innerHTML = `<div class="empty-state"><p>${userFacingError(err, 'Verification results could not load.')}</p></div>`;
  }
}

function renderResultRow(r) {
  return renderVerificationResultRow(r, relTime);
}

// ── Load Distribution ────────────────────────────────────────
async function loadDistribution() {
  try {
    const data = await Verify.distribution(_selectedBatch);

    const counts = { deliverable: 0, risky: 0, undeliverable: 0, unknown: 0 };
    for (const row of data) {
      if (counts.hasOwnProperty(row.verification_status)) {
        counts[row.verification_status] = row.count;
      }
    }

    const cardsEl = document.getElementById('verify-cards');
    if (cardsEl) {
      cardsEl.innerHTML = renderStatusCards(counts);
      // Animate counters
      cardsEl.querySelectorAll('.verify-card-count').forEach(el => {
        const target = parseInt(el.dataset.target) || 0;
        animCounterInline(el, target, 600);
      });
    }
  } catch { /* ignore */ }

  // Update Reacher status badge
  try {
    const rData = await Verify.reacherStatus();
    const badge = document.getElementById('reacher-engine-badge');
    if (badge) {
      if (rData.available) {
        badge.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--system-green)"></span> Reacher Engine (Docker :8080 Active)`;
        badge.style.background = 'rgba(52,199,89,0.15)';
        badge.style.color = 'var(--system-green)';
        badge.style.borderColor = 'rgba(52,199,89,0.3)';
      } else {
        badge.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--system-orange)"></span> Local Fallback Engine`;
        badge.style.background = 'rgba(255,159,10,0.15)';
        badge.style.color = 'var(--system-orange)';
        badge.style.borderColor = 'rgba(255,159,10,0.3)';
      }
    }
  } catch { /* ignore */ }
}

// ── Quick Verify ─────────────────────────────────────────────
async function quickVerify() {
  const input = document.getElementById('verify-quick-input');
  const resultEl = document.getElementById('verify-quick-result');
  const btn = document.getElementById('verify-quick-btn');
  if (!input?.value || !resultEl) return;

  const email = input.value.trim();
  if (!email) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  resultEl.style.display = 'none';

  try {
    const data = await Verify.verifySingle(email);
    resultEl.innerHTML = renderQuickVerificationResult(data.result);
    resultEl.style.display = 'block';
  } catch (err) {
    resultEl.innerHTML = renderQuickVerificationError(userFacingError(err, 'Email verification could not be completed.'));
    resultEl.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
  }
}
// ── Filter ───────────────────────────────────────────────────
function filterResults(tabEl, filter) {
  _activeFilter = filter || null;
  document.querySelectorAll('.verify-tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  loadResults();
}

// ── Re-verify single ────────────────────────────────────────
window.__reverifyEmail = async function(id) {
  const trigger = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
  if (trigger) trigger.disabled = true;
  try {
    await Verify.reVerify(id);
    await Promise.all([loadResults(), loadDistribution()]);
    notify('Email verification completed.');
  } catch (err) {
    notify(userFacingError(err, 'Email could not be re-verified.'), 'error');
  } finally {
    if (trigger?.isConnected) trigger.disabled = false;
  }
};

// ── Helpers ──────────────────────────────────────────────────
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
