// ============================================================
//  ODD-ECOSYS — API Client
//  All UI data flows through here. Failures are explicit:
//  every caller gets a rejected promise with a typed ApiError
//  (offline / http / unauthorized / timeout) — never a silently
//  substituted empty success shape. A global 'api:error' event
//  is dispatched so the shell can surface an honest error state.
// ============================================================

const BASE = () => (typeof window !== 'undefined' && window.API_BASE) || '';

export class ApiError extends Error {
  constructor(message, { code, status, path } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'API_ERROR';
    this.status = status ?? null;
    this.path = path || '';
  }
}

function announce(err) {
  try {
    window.dispatchEvent(new CustomEvent('api:error', { detail: { code: err.code, status: err.status, message: err.message, path: err.path } }));
  } catch { /* non-DOM context */ }
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(BASE() + path, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
  } catch (e) {
    const err = new ApiError(`Network request failed: ${e.message}`, { code: 'NETWORK_ERROR', status: 0, path });
    announce(err);
    throw err;
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body unreadable */ }
    const code = res.status === 401 ? 'UNAUTHORIZED'
      : res.status === 403 ? 'FORBIDDEN'
      : res.status === 404 ? 'NOT_FOUND'
      : res.status === 429 ? 'RATE_LIMITED'
      : res.status >= 500 ? 'SERVER_ERROR'
      : 'HTTP_ERROR';
    const err = new ApiError(`API ${path} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { code, status: res.status, path });
    announce(err);
    throw err;
  }

  try {
    return await res.json();
  } catch (e) {
    const err = new ApiError(`API ${path} returned invalid JSON: ${e.message}`, { code: 'INVALID_RESPONSE', status: res.status, path });
    announce(err);
    throw err;
  }
}

// ── Batches ─────────────────────────────────────────────────
export const Batches = {
  list:   () => api('/api/batches'),
  get:    (id) => api(`/api/batches/${id}`),
  create: (body) => api('/api/batches', { method: 'POST', body: JSON.stringify(body) }),
  close:  (id) => api(`/api/batches/${id}/close`, { method: 'POST' }),
  archive:(id) => api(`/api/batches/${id}/archive`, { method: 'POST' }),
  archiveStats: () => api('/api/stats/archive'),
};

// ── Replies & Tracking (Phase 8) ────────────────────────────
export const Replies = {
  ingest:    (body) => api('/api/replies/ingest', { method: 'POST', body: JSON.stringify(body) }),
  sentiment: () => api('/api/replies/sentiment-breakdown'),
};

// ── CRM Control Plane (Phase 9) ─────────────────────────────
export const CRM = {
  status:          () => api('/api/crm/status'),
  syncLead:        (id) => api(`/api/crm/sync/${id}`, { method: 'POST' }),
  killSwitch:      (reason) => api('/api/crm/kill-switch', { method: 'POST', body: JSON.stringify({ reason }) }),
  blacklistDomain: (domain, reason) => api('/api/crm/blacklist-domain', { method: 'POST', body: JSON.stringify({ domain, reason }) }),
};

// ── Lead Scraper & Discovery (1-Click Pipeline) ─────────────
export const Scraper = {
  start:  (body) => api('/api/scrape/start', { method: 'POST', body: JSON.stringify(body) }),
  status: () => api('/api/scrape/status'),
  cancel: () => api('/api/scrape/cancel', { method: 'POST' }),
};

// ── Leads ────────────────────────────────────────────────────
export const Leads = {
  list: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/leads${q ? '?' + q : ''}`);
  },
  get: (id) => api(`/api/leads/${id}`),
  funnel: () => api('/api/stats/funnel'),
  discovery: () => api('/api/stats/discovery'),
};

// ── Stats ─────────────────────────────────────────────────────
export const Stats = {
  funnel:    () => api('/api/stats/funnel'),
  discovery: () => api('/api/stats/discovery'),
  sends:     () => api('/api/sending/stats'),
  analytics: () => api('/api/stats/analytics'),
};

// ── Qualification ────────────────────────────────────────────
export const Qualify = {
  startBatch:   (id, body = {}) => api(`/api/qualify/batch/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  cancel:        () => api('/api/qualify/cancel', { method: 'POST' }),
  status:        () => api('/api/qualify/status'),
  results:       (id) => api(`/api/qualify/results/${id}`),
  distribution:  () => api('/api/leads/site-status-distribution'),
  staleCount:    () => api('/api/qualify/stale-count'),
  recheckStale:  () => api('/api/qualify/recheck-stale', { method: 'POST' }),
  spotCheck:     (id) => api(`/api/qualify/spot-check/${id}`),
  requalifyLead: (id) => api(`/api/qualify/lead/${id}`, { method: 'POST' }),
};

// ── Verification ─────────────────────────────────────────────
export const Verify = {
  startBatch:   (id, body = {}) => api(`/api/verify/batch/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  cancel:        () => api('/api/verify/cancel', { method: 'POST' }),
  status:        () => api('/api/verify/status'),
  results:       (id) => api(`/api/verify/results/${id}`),
  distribution:  () => api('/api/verify/distribution'),
  reVerify:      (id) => api(`/api/verify/email/${id}`, { method: 'POST' }),
  verifySingle:  (email) => api('/api/verify/single', { method: 'POST', body: JSON.stringify({ email }) }),
};

// ── Personalization ───────────────────────────────────────────
export const Personalize = {
  startBatch:  (id, body = {}) => api(`/api/personalize/batch/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  cancel:       () => api('/api/personalize/cancel', { method: 'POST' }),
  status:       () => api('/api/personalize/status'),
  list:         (params = {}) => { const q = new URLSearchParams(params).toString(); return api(`/api/personalize/list${q ? '?' + q : ''}`); },
  awaiting:     (batchId) => api(`/api/personalize/awaiting${batchId ? '?batch_id=' + batchId : ''}`),
  stats:        (batchId) => api(`/api/personalize/stats${batchId ? '?batch_id=' + batchId : ''}`),
  approve:      (id) => api(`/api/personalize/approve/${id}`, { method: 'POST' }),
  reject:       (id, reason) => api(`/api/personalize/reject/${id}`, { method: 'POST', body: JSON.stringify({ reason }) }),
  edit:         (id, body) => api(`/api/personalize/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  ollamaTest:   () => api('/api/personalize/ollama-test'),
};

// ── Sending ───────────────────────────────────────────────────
export const Sending = {
  mailboxes:       () => api('/api/sending/mailboxes'),
  addMailbox:      (body) => api('/api/sending/mailboxes', { method: 'POST', body: JSON.stringify(body) }),
  updateMailbox:   (id, body) => api(`/api/sending/mailboxes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMailbox:   (id) => api(`/api/sending/mailboxes/${id}`, { method: 'DELETE' }),
  verifyDns:       (id) => api(`/api/sending/mailboxes/${id}/verify-dns`, { method: 'POST' }),
  testSmtp:        (id) => api(`/api/sending/mailboxes/${id}/test-smtp`, { method: 'POST' }),
  sendTest:        (id, body) => api(`/api/sending/mailboxes/${id}/send-test`, { method: 'POST', body: JSON.stringify(body) }),
  pause:           (id) => api(`/api/sending/mailboxes/${id}/pause`, { method: 'POST' }),
  activate:        (id) => api(`/api/sending/mailboxes/${id}/activate`, { method: 'POST' }),
  retire:          (id) => api(`/api/sending/mailboxes/${id}/retire`, { method: 'POST' }),
  recomputeHealth: () => api('/api/sending/health-recompute', { method: 'POST' }),
  warmupCheck:     () => api('/api/sending/warmup-check', { method: 'POST' }),
  stats:           () => api('/api/sending/stats'),
  status:          () => api('/api/sending/status'),
  process:         (body = {}) => api('/api/sending/process', { method: 'POST', body: JSON.stringify(body) }),
  cancelSend:      () => api('/api/sending/cancel', { method: 'POST' }),
  queueSends:      (campaignId, body = {}) => api(`/api/sending/queue/${campaignId}`, { method: 'POST', body: JSON.stringify(body) }),
  thresholdCheck:  () => api('/api/sending/threshold-check', { method: 'POST' }),
};

// ── Campaigns ─────────────────────────────────────────────────
export const Campaigns = {
  list:      () => api('/api/sending/campaigns'),
  create:    (body) => api('/api/sending/campaigns', { method: 'POST', body: JSON.stringify(body) }),
  variants:  (id) => api(`/api/sending/campaigns/${id}/variants`),
  timeline:  (id, days = 14) => api(`/api/sending/campaigns/${id}/timeline?days=${days}`),
  assignVariant: (id) => api(`/api/sending/ab/assign/${id}`),
  autoPromote: () => api('/api/sending/ab/auto-promote', { method: 'POST' }),
};

// ── Events ─────────────────────────────────────────────────────
export const Events = {
  recent: (limit = 20) => api(`/api/events?limit=${limit}`),
};

// ── Utility ─────────────────────────────────────────────────
export const relTime = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

export const fmtNum = (n) => {
  if (n == null) return '—';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
};

export const fmtPct = (n, dec = 1) => {
  if (n == null) return '—';
  return (n * 100).toFixed(dec) + '%';
};
