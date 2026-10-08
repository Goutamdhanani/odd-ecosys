// ============================================================
//  ODD-ECOSYS — Utilities & Global State
// ============================================================

// ── Global State ────────────────────────────────────────────
export const state = {
  currentView: 'dashboard',
  approvalActions: {},   // leadId -> 'approved' | 'rejected'
  mailboxActions: {},    // mailboxId -> 'paused' | 'active'
  batchActions: {},      // batchId -> 'closed'
};

// ── Counter Animation ────────────────────────────────────────
export function animateCounter(el, target, duration = 800, decimals = 0, suffix = '') {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = from + (target - from) * eased;
    const formatted = decimals > 0
      ? current.toFixed(decimals)
      : Math.round(current).toLocaleString();
    el.textContent = formatted + suffix;
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

// ── Relative time ────────────────────────────────────────────
export function relTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr);
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

// ── Format helpers ────────────────────────────────────────────
export function fmtNum(n) { return n?.toLocaleString() ?? '—'; }
export function fmtPct(n) { return n != null ? n.toFixed(1) + '%' : '—'; }
