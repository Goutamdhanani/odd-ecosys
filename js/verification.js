// ============================================================
//  ODD-ECOSYS — Verification Dashboard (Stage 5)
//  Email verification controls, status cards, results table,
//  quick-verify tool, and domain health view
// ============================================================

import { Batches, relTime } from './api.js';
import { icon } from './ui.js';

// ── State ────────────────────────────────────────────────────
let _pollInterval = null;
let _selectedBatch = null;
let _activeFilter = null;
let _batches = [];

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
    _selectedBatch = parseInt(e.target.value);
    loadResults();
  });

  window.__verifyRun = startVerification;
  window.__verifyCancel = cancelVerification;
  window.__verifyQuick = quickVerify;
  window.__verifyFilter = filterResults;

  // Initial load
  loadResults();
  loadDistribution();
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
    await fetch(`/api/verify/batch/${_selectedBatch}`, { method: 'POST' });
    startPolling();
  } catch (err) {
    console.error('Failed to start verification:', err);
    if (runBtn) runBtn.style.display = 'inline-flex';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'none';
  }
}

async function cancelVerification() {
  try {
    await fetch(`/api/verify/batch/${_selectedBatch}/cancel`, { method: 'POST' });
  } catch { /* ignore */ }
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

async function pollStatus() {
  try {
    const res = await fetch('/api/verify/status');
    const data = await res.json();

    if (!data.active && data.processed > 0) {
      stopPolling();
      loadResults();
      loadDistribution();
      return;
    }

    if (!data.active) return;

    const fill = document.getElementById('verify-progress-fill');
    const text = document.getElementById('verify-progress-text');
    const current = document.getElementById('verify-progress-current');
    const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;

    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `${data.processed}/${data.total} emails verified (${pct}%)`;
    if (current) current.textContent = data.currentEmail ? `Checking: ${data.currentEmail}` : '';

    // Also refresh results periodically
    if (data.processed > 0 && data.processed % 5 === 0) {
      loadResults();
      loadDistribution();
    }
  } catch { /* ignore */ }
}

// ── Load Results ─────────────────────────────────────────────
async function loadResults() {
  if (!_selectedBatch) return;

  try {
    let url = `/api/verify/results/${_selectedBatch}?limit=200`;
    if (_activeFilter) url += `&status=${_activeFilter}`;

    const res = await fetch(url);
    const data = await res.json();

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
    console.error('Failed to load results:', err);
  }
}

function renderResultRow(r) {
  const statusClass = {
    deliverable: 'badge-deliverable',
    risky: 'badge-risky',
    undeliverable: 'badge-undeliverable',
    unknown: 'badge-unknown',
  }[r.verification_status] || 'badge-unknown';

  const statusIcon = {
    deliverable: '✓',
    risky: '⚠',
    undeliverable: '✗',
    unknown: '?',
  }[r.verification_status] || '?';

  // Parse flags
  const flags = [];
  if (r.is_role_account) flags.push('<span class="flag-tag role">Role</span>');
  if (r.is_free_provider) flags.push('<span class="flag-tag free">Free</span>');
  if (r.is_disposable) flags.push('<span class="flag-tag disposable">Disposable</span>');
  if (r.is_catch_all) flags.push('<span class="flag-tag catchall">Catch-all</span>');

  // Parse checks
  let checks = {};
  try { checks = JSON.parse(r.verification_json || '{}').checks || {}; } catch { /* */ }

  const checkIcons = ['regex', 'mx', 'disposable', 'smtp'].map(k => {
    const v = checks[k];
    if (v === true) return `<span class="check-dot pass" title="${k}: pass">✓</span>`;
    if (v === false) return `<span class="check-dot fail" title="${k}: fail">✗</span>`;
    return `<span class="check-dot skip" title="${k}: skipped">–</span>`;
  }).join('');

  const timeAgo = r.verified_at ? relTime(r.verified_at) : '—';

  return `
    <tr class="verify-row" data-id="${r.id}">
      <td class="cell-email">
        <span class="email-text">${r.email}</span>
      </td>
      <td>${r.business_name || '—'}</td>
      <td>
        <span class="status-badge ${statusClass}">
          ${statusIcon} ${r.verification_status || 'unknown'}
        </span>
      </td>
      <td class="cell-mx">${r.mx_host || '—'}</td>
      <td class="cell-checks">${checkIcons}</td>
      <td class="cell-flags">${flags.join('') || '—'}</td>
      <td class="cell-time">${timeAgo}</td>
      <td>
        <button class="btn-xs" onclick="window.__reverifyEmail(${r.id})" title="Re-verify">↻</button>
      </td>
    </tr>`;
}

// ── Load Distribution ────────────────────────────────────────
async function loadDistribution() {
  try {
    const url = _selectedBatch ? `/api/verify/distribution?batch_id=${_selectedBatch}` : '/api/verify/distribution';
    const res = await fetch(url);
    const data = await res.json();

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
    const rRes = await fetch('/api/verify/reacher-status');
    const rData = await rRes.json();
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
    const res = await fetch('/api/verify/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    const r = data.result;

    const statusClass = {
      deliverable: 'badge-deliverable',
      risky: 'badge-risky',
      undeliverable: 'badge-undeliverable',
      unknown: 'badge-unknown',
    }[r.verification_status] || 'badge-unknown';

    const smtpDisplay = r.checks.smtp === true
      ? '<span style="color:var(--system-green);font-weight:600">✓ Accepted (250 OK)</span>'
      : r.checks.smtp === false
        ? '<span style="color:var(--system-red);font-weight:600">✗ Rejected (Mailbox Does Not Exist)</span>'
        : '<span style="color:var(--system-orange)">⚠ Unconfirmed (Port 25 Socket Blocked)</span>';

    const score = r.score ?? (r.verification_status === 'deliverable' ? 95 : r.verification_status === 'risky' ? 65 : 0);
    const scoreColor = score >= 80 ? 'var(--system-green)' : score >= 50 ? 'var(--system-orange)' : 'var(--system-red)';
    const attrs = r.attributes || {
      free: r.is_free_provider || false,
      role: r.is_role_account || false,
      disposable: r.is_disposable || false,
      accept_all: r.is_catch_all || false,
      tag: false,
      numerical_characters: 0,
      alphabetical_characters: (r.email.split('@')[0] || '').length,
      unicode_symbols: 0,
      mailbox_full: false,
      no_reply: false,
      secure_email_gateway: false,
    };
    const ms = r.mail_server || {
      smtp_provider: r.is_free_provider ? 'Google' : 'Custom Mail Server',
      mx_record: r.mx_host || '—',
      implicit_mx_record: false,
    };

    resultEl.innerHTML = `
      <div class="audit-card-container" style="background:var(--bg-elevated);border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:16px;margin-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">Deliverability Audit Score</div>
            <div style="font-size:2.2rem;font-weight:800;color:${scoreColor};font-family:var(--mono);line-height:1">
              ${score} <span style="font-size:0.95rem;color:var(--text-secondary);font-weight:500">/ 100 (${r.score_multiplier || '0.95x'})</span>
            </div>
          </div>
          <div style="text-align:right">
            <span class="status-badge ${statusClass}" style="font-size:0.85rem;padding:6px 14px;letter-spacing:0.04em">${(r.general?.state || r.verification_status).toUpperCase()}</span>
            <div style="font-size:0.75rem;color:var(--text-secondary);margin-top:5px">Reason: <strong style="color:var(--text-primary)">${r.general?.reason || 'Accepted Email'}</strong></div>
          </div>
        </div>

        <div class="grid cols-3 gap-12" style="font-size:0.78rem">
          <!-- General & Domain -->
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:var(--radius-sm);padding:12px">
            <div style="font-weight:700;margin-bottom:8px;color:var(--system-blue);font-size:0.82rem">General & Domain</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>Domain:</strong> ${r.general?.domain || (r.email.split('@')[1])}</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>State:</strong> ${r.general?.state || 'Deliverable'}</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>Reason:</strong> ${r.general?.reason || 'Accepted Email'}</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>Syntax:</strong> ${r.checks.regex ? '✓ Valid RFC' : '✗ Invalid Format'}</div>
          </div>

          <!-- Attributes -->
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:var(--radius-sm);padding:12px">
            <div style="font-weight:700;margin-bottom:8px;color:var(--system-purple);font-size:0.82rem">Attributes</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Free:</strong> ${attrs.free ? 'Yes' : 'No'} (${r.score_multiplier || '0.95x'})</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Role:</strong> ${attrs.role ? 'Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Disposable:</strong> ${attrs.disposable ? '⚠ Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Accept-All:</strong> ${attrs.accept_all ? 'Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Tag (+):</strong> ${attrs.tag ? 'Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Alphabetical Chars:</strong> ${attrs.alphabetical_characters ?? 0}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Numerical Chars:</strong> ${attrs.numerical_characters ?? 0}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Unicode Symbols:</strong> ${attrs.unicode_symbols ?? 0}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Mailbox Full:</strong> ${attrs.mailbox_full ? 'Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>No Reply:</strong> ${attrs.no_reply ? 'Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:3px"><strong>Secure Gateway:</strong> ${attrs.secure_email_gateway ? 'Yes' : 'No'}</div>
          </div>

          <!-- Mail Server -->
          <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:var(--radius-sm);padding:12px">
            <div style="font-weight:700;margin-bottom:8px;color:var(--system-green);font-size:0.82rem">Mail Server</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>SMTP Provider:</strong> ${ms.smtp_provider || 'Google'}</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>MX Record:</strong> ${ms.mx_record || r.mx_host || '—'}</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>Implicit MX Record:</strong> ${ms.implicit_mx_record ? 'Yes' : 'No'}</div>
            <div class="quick-detail" style="margin-bottom:4px"><strong>SMTP Socket:</strong> ${smtpDisplay}</div>
          </div>
        </div>
      </div>`;
    resultEl.style.display = 'block';
  } catch (err) {
    resultEl.innerHTML = `<div class="quick-result-error">Error: ${err.message}</div>`;
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
  try {
    await fetch(`/api/verify/email/${id}`, { method: 'POST' });
    loadResults();
    loadDistribution();
  } catch (err) {
    console.error('Re-verify error:', err);
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
