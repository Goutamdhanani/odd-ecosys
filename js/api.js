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

function csrfCookie() {
  if (typeof document === 'undefined') return '';
  const encoded = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('odd_csrf='));
  if (!encoded) return '';
  try { return decodeURIComponent(encoded.slice('odd_csrf='.length)); } catch { return ''; }
}

async function api(path, opts = {}) {
  let res;
  const method = String(opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const publicAuthMutation = path.startsWith('/api/auth/')
    && path !== '/api/auth/logout'
    && !path.startsWith('/api/auth/mfa/');
  const mfaChallenge = path === '/api/auth/mfa/challenge';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !publicAuthMutation && !mfaChallenge) {
    const csrf = csrfCookie();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  try {
    res = await fetch(BASE() + path, {
      ...opts,
      method,
      headers,
      credentials: 'same-origin',
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

export const Auth = {
  status: () => api('/api/auth/status'),
  mfaStatus: () => api('/api/auth/mfa/status'),
  beginMfaEnrollment: () => api('/api/auth/mfa/enroll', { method: 'POST', body: '{}' }),
  confirmMfaEnrollment: (code) => api('/api/auth/mfa/enroll/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  completeMfaChallenge: (challengeToken, code) => api('/api/auth/mfa/challenge', {
    method: 'POST', body: JSON.stringify({ challengeToken, code }),
  }),
  regenerateMfaRecoveryCodes: (body) => api('/api/auth/mfa/recovery-codes', { method: 'POST', body: JSON.stringify(body) }),
  disableMfa: (body) => api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify(body) }),
  googleNonce: () => api('/api/auth/google/nonce'),
  googleLogin: (body) => api('/api/auth/google', { method: 'POST', body: JSON.stringify(body) }),
  events: (limit = 50) => api(`/api/auth/events?limit=${encodeURIComponent(limit)}`),
  bootstrap: (body) => api('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(body) }),
  acceptInvitation: (body) => api('/api/auth/invitations/accept', { method: 'POST', body: JSON.stringify(body) }),
  login: (body) => api('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  recover: (body) => api('/api/auth/recover', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => api('/api/auth/logout', { method: 'POST' }),
};

export const Workspace = {
  members: () => api('/api/workspace/members'),
  invitations: () => api('/api/workspace/invitations'),
  invite: (body) => api('/api/workspace/invitations', { method: 'POST', body: JSON.stringify(body) }),
  cancelInvitation: (id) => api(`/api/workspace/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  changeRole: (id, role) => api(`/api/workspace/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  deactivateMember: (id) => api(`/api/workspace/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

async function apiFile(path) {
  let res;
  try {
    res = await fetch(BASE() + path);
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
  const disposition = res.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([A-Za-z0-9._-]+)"/i)?.[1] || 'contacts.csv';
  return { blob: await res.blob(), filename };
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

// ── Leads ────────────────────────────────────────────────────
export const Leads = {
  list: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/leads${q ? '?' + q : ''}`);
  },
  get: (id) => api(`/api/leads/${id}`),
  create: (body) => api('/api/leads', { method: 'POST', body: JSON.stringify(body) }),
  previewCsv: (body) => api('/api/leads/import/preview', { method: 'POST', body: JSON.stringify(body) }),
  previewCsvSample: (body) => api('/api/leads/import/preview-sample', { method: 'POST', body: JSON.stringify(body) }),
  importCsv: (body) => api('/api/leads/import', { method: 'POST', body: JSON.stringify(body) }),
  previewOsm: (body) => api('/api/leads/import/openstreetmap/preview', { method: 'POST', body: JSON.stringify(body) }),
  importOsm: (body) => api('/api/leads/import/openstreetmap', { method: 'POST', body: JSON.stringify(body) }),
  createImportJob: (body) => api('/api/leads/import-jobs', { method: 'POST', body: JSON.stringify(body) }),
  listImportJobs: (batchId, limit = 20) => api(`/api/leads/import-jobs?batch_id=${encodeURIComponent(batchId)}&limit=${encodeURIComponent(limit)}`),
  getImportJob: (id) => api(`/api/leads/import-jobs/${encodeURIComponent(id)}`),
  uploadImportChunk: (id, start, end, total, blob) => api(`/api/leads/import-jobs/${encodeURIComponent(id)}/chunks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${total}` },
    body: blob,
  }),
  cancelImportJob: (id) => api(`/api/leads/import-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  resumeImportJob: (id) => api(`/api/leads/import-jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  importJobRejections: (id, limit = 500, offset = 0) => api(`/api/leads/import-jobs/${encodeURIComponent(id)}/rejections?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`),
  listWebsiteDiscoveryJobs: (batchId, limit = 20) => api(`/api/leads/website-discovery-jobs?${new URLSearchParams({ ...(batchId ? { batch_id: batchId } : {}), limit: String(limit) })}`),
  getSearchProvider: () => api('/api/leads/search-provider'),
  saveSearchProvider: (body) => api('/api/leads/search-provider', { method: 'PUT', body: JSON.stringify(body) }),
  testSearchProvider: () => api('/api/leads/search-provider/test', { method: 'POST', body: '{}' }),
  listBusinessSearchJobs: (batchId, limit = 20) => api(`/api/leads/search-jobs?${new URLSearchParams({ ...(batchId ? { batch_id: batchId } : {}), limit: String(limit) })}`),
  searchBusinesses: (body) => api('/api/leads/search-jobs', { method: 'POST', body: JSON.stringify(body) }),
  getBusinessSearchJob: (id) => api(`/api/leads/search-jobs/${encodeURIComponent(id)}`),
  nextBusinessSearchPage: (id) => api(`/api/leads/search-jobs/${encodeURIComponent(id)}/next-page`, { method: 'POST', body: '{}' }),
  importBusinessSearchResults: (id, resultIds) => api(`/api/leads/search-jobs/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify({ result_ids: resultIds }) }),
  createWebsiteDiscoveryJob: (body) => api('/api/leads/website-discovery-jobs', { method: 'POST', body: JSON.stringify(body) }),
  getWebsiteDiscoveryJob: (id, { offset = 0, limit = 100 } = {}) => api(`/api/leads/website-discovery-jobs/${encodeURIComponent(id)}?${new URLSearchParams({ offset: String(offset), limit: String(limit) })}`),
  pauseWebsiteDiscoveryJob: (id) => api(`/api/leads/website-discovery-jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeWebsiteDiscoveryJob: (id) => api(`/api/leads/website-discovery-jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  cancelWebsiteDiscoveryJob: (id) => api(`/api/leads/website-discovery-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  retryWebsiteDiscoveryTask: (id, taskId) => api(`/api/leads/website-discovery-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ task_id: taskId }) }),
  exportWebsiteDiscoveryEvidence: (id) => apiFile(`/api/leads/website-discovery-jobs/${encodeURIComponent(id)}/export`),
  listDirectoryJobs: (batchId, limit = 20) => api(`/api/leads/directory-jobs?${new URLSearchParams({ ...(batchId ? { batch_id: batchId } : {}), limit: String(limit) })}`),
  createDirectoryJob: (body) => api('/api/leads/directory-jobs', { method: 'POST', body: JSON.stringify(body) }),
  getDirectoryJob: (id) => api(`/api/leads/directory-jobs/${encodeURIComponent(id)}`),
  pauseDirectoryJob: (id) => api(`/api/leads/directory-jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeDirectoryJob: (id) => api(`/api/leads/directory-jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  cancelDirectoryJob: (id) => api(`/api/leads/directory-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  retryDirectoryJob: (id) => api(`/api/leads/directory-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  exportDirectoryEvidence: (id) => apiFile(`/api/leads/directory-jobs/${encodeURIComponent(id)}/export`),
  update: (id, body) => api(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id) => api(`/api/leads/${id}`, { method: 'DELETE' }),
  discoverWebsiteEmails: (id) => api(`/api/leads/${id}/website-email-scan`, { method: 'POST', body: JSON.stringify({}) }),
  refreshWebsiteEmailScan: (id) => api(`/api/leads/${id}/website-email-scan/refresh`, { method: 'POST', body: JSON.stringify({}) }),
  funnel: () => api('/api/stats/funnel'),
  discovery: () => api('/api/stats/discovery'),
};

export const LeadStrategies = {
  list: (limit = 25) => api(`/api/lead-strategies?limit=${encodeURIComponent(limit)}`),
  get: (id) => api(`/api/lead-strategies/${encodeURIComponent(id)}`),
  generate: (brief) => api('/api/lead-strategies', { method: 'POST', body: JSON.stringify(brief) }),
  checkProvider: (scope = 'effective') => api('/api/lead-strategies/provider-check', { method: 'POST', body: JSON.stringify({ scope }) }),
  saveProviderSettings: (settings) => api('/api/lead-strategies/provider-settings', { method: 'PUT', body: JSON.stringify(settings) }),
  clearPersonalProviderSettings: () => api('/api/lead-strategies/provider-settings', { method: 'DELETE' }),
};

export const MetaLeadAds = {
  status: () => api('/api/leads/sources/meta'),
  save: (body) => api('/api/leads/sources/meta', { method: 'PUT', body: JSON.stringify(body) }),
  test: () => api('/api/leads/sources/meta/test', { method: 'POST', body: '{}' }),
  forms: () => api('/api/leads/sources/meta/forms'),
  nextForms: () => api('/api/leads/sources/meta/forms/next', { method: 'POST', body: '{}' }),
  importForm: (body) => api('/api/leads/sources/meta/import', { method: 'POST', body: JSON.stringify(body) }),
  webhookStatus: () => api('/api/leads/sources/meta/webhook-status'),
  saveWebhook: (body) => api('/api/leads/sources/meta/webhook-config', { method: 'PUT', body: JSON.stringify(body) }),
  subscribeWebhook: () => api('/api/leads/sources/meta/webhook-subscribe', { method: 'POST', body: '{}' }),
  saveWebhookForm: (formId, body) => api(`/api/leads/sources/meta/webhook-forms/${encodeURIComponent(formId)}`, { method: 'PUT', body: JSON.stringify(body) }),
  processWebhooks: (retryFailed = false) => api('/api/leads/sources/meta/webhooks/process', { method: 'POST', body: JSON.stringify({ retry_failed: retryFailed }) }),
};

export const ContactTags = {
  list: (includeArchived = false) => api(`/api/contact-tags${includeArchived ? '?include_archived=true' : ''}`),
  create: (name) => api('/api/contact-tags', { method: 'POST', body: JSON.stringify({ name }) }),
  rename: (id, name) => api(`/api/contact-tags/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  archive: (id) => api(`/api/contact-tags/${id}`, { method: 'DELETE' }),
  restore: (id) => api(`/api/contact-tags/${id}/restore`, { method: 'POST' }),
  assign: (leadId, tagIds, createTag = '') => api(`/api/leads/${leadId}/tags`, {
    method: 'PUT', body: JSON.stringify({ tagIds, createTag }),
  }),
  assignMany: (leadIds, tagIds) => api('/api/leads/bulk/tags', {
    method: 'PUT', body: JSON.stringify({ leadIds, tagIds }),
  }),
};

export const ContactSegments = {
  list: () => api('/api/contact-segments'),
  create: (body) => api('/api/contact-segments', { method: 'POST', body: JSON.stringify(body) }),
  update: (id, body) => api(`/api/contact-segments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id) => api(`/api/contact-segments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const ContactFields = {
  list: (includeArchived = false) => api(`/api/contact-fields${includeArchived ? '?include_archived=true' : ''}`),
  create: (body) => api('/api/contact-fields', { method: 'POST', body: JSON.stringify(body) }),
  update: (id, body) => api(`/api/contact-fields/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archive: (id) => api(`/api/contact-fields/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

// ── Contact lists ──────────────────────────────────────────
export const Lists = {
  list: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/lists${q ? '?' + q : ''}`);
  },
  get: (id) => api(`/api/lists/${id}`),
  exportCsv: (id) => apiFile(`/api/lists/${id}/export`),
  create: (body) => api('/api/lists', { method: 'POST', body: JSON.stringify(body) }),
  update: (id, body) => api(`/api/lists/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  members: (id, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/lists/${id}/members${q ? '?' + q : ''}`);
  },
  addMembers: (id, leadIds) => api(`/api/lists/${id}/members`, { method: 'POST', body: JSON.stringify({ leadIds }) }),
  removeMember: (id, leadId) => api(`/api/lists/${id}/members/${leadId}`, { method: 'DELETE' }),
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
  scoring:       () => api('/api/qualify/scoring'),
  updateScoring: (body) => api('/api/qualify/scoring', { method: 'PUT', body: JSON.stringify(body) }),
  replayScoring: (leadId, version) => api(`/api/qualify/lead/${encodeURIComponent(leadId)}/scoring-replay${version ? `?version=${encodeURIComponent(version)}` : ''}`),
  reviewQueue: ({ batchId, maxConfidence = 70, limit = 50, offset = 0 } = {}) => {
    const params = new URLSearchParams({ batch_id: String(batchId), max_confidence: String(maxConfidence), limit: String(limit), offset: String(offset) });
    return api(`/api/qualify/review-queue?${params}`);
  },
  submitReview: (leadId, body) => api(`/api/qualify/review/${encodeURIComponent(leadId)}`, { method: 'POST', body: JSON.stringify(body) }),
  reviewHistory: (leadId) => api(`/api/qualify/lead/${encodeURIComponent(leadId)}/review-history`),
  startBatch:   (id, body = {}) => api(`/api/qualify/batch/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  cancel:        (batchId) => api(batchId ? `/api/qualify/batch/${encodeURIComponent(batchId)}/cancel` : '/api/qualify/cancel', { method: 'POST' }),
  status:        (batchId) => api(`/api/qualify/status${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ''}`),
  results:       (id, { limit = 100, offset = 0, siteStatus } = {}) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (siteStatus) params.set('site_status', siteStatus);
    return api(`/api/qualify/results/${encodeURIComponent(id)}?${params}`);
  },
  distribution:  (batchId) => api(`/api/leads/site-status-distribution${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ''}`),
  staleCount:    () => api('/api/qualify/stale-count'),
  recheckStale:  () => api('/api/qualify/recheck-stale', { method: 'POST' }),
  spotCheck:     (id) => api(`/api/qualify/spot-check/${id}`),
  requalifyLead: (id) => api(`/api/qualify/lead/${id}`, { method: 'POST' }),
};

// ── Verification ─────────────────────────────────────────────
export const Verify = {
  startBatch:   (id, body = {}) => api(`/api/verify/batch/${id}`, { method: 'POST', body: JSON.stringify(body) }),
  cancel:        () => api('/api/verify/cancel', { method: 'POST' }),
  cancelBatch:   (id) => api(`/api/verify/batch/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  status:        (batchId) => api(`/api/verify/status${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ''}`),
  results:       (id, { limit = 200, status } = {}) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    return api(`/api/verify/results/${encodeURIComponent(id)}?${params}`);
  },
  exportCsv:     (id, status) => apiFile(`/api/verify/results/${encodeURIComponent(id)}/export${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  distribution:  (batchId) => api(`/api/verify/distribution${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ''}`),
  reacherStatus: () => api('/api/verify/reacher-status'),
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
  credentialStorage: () => api('/api/sending/credential-storage'),
  control:         () => api('/api/sending/control'),
  setControl:      (body) => api('/api/sending/control', { method: 'PUT', body: JSON.stringify(body) }),
  schedule:        () => api('/api/sending/schedule'),
  setSchedule:     (body) => api('/api/sending/schedule', { method: 'PUT', body: JSON.stringify(body) }),
  imapSync:        () => api('/api/sending/imap-sync'),
  setImapSync:     (body) => api('/api/sending/imap-sync', { method: 'PUT', body: JSON.stringify(body) }),
  mailboxes:       () => api('/api/sending/mailboxes'),
  addMailbox:      (body) => api('/api/sending/mailboxes', { method: 'POST', body: JSON.stringify(body) }),
  updateMailbox:   (id, body) => api(`/api/sending/mailboxes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMailbox:   (id) => api(`/api/sending/mailboxes/${id}`, { method: 'DELETE' }),
  verifyDns:       (id) => api(`/api/sending/mailboxes/${id}/verify-dns`, { method: 'POST' }),
  testSmtp:        (id) => api(`/api/sending/mailboxes/${id}/test-smtp`, { method: 'POST' }),
  testImap:        (id) => api(`/api/sending/mailboxes/${id}/test-imap`, { method: 'POST' }),
  syncImap:        (id, body = {}) => api(`/api/sending/mailboxes/${id}/sync-imap`, { method: 'POST', body: JSON.stringify(body) }),
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
  list:      (status = '') => api(`/api/sending/campaigns${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  create:    (body) => api('/api/sending/campaigns', { method: 'POST', body: JSON.stringify(body) }),
  clone:     (id, name) => api(`/api/sending/campaigns/${id}/clone`, { method: 'POST', body: JSON.stringify({ name }) }),
  updateDraft: (id, body) => api(`/api/sending/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveDraft: (id) => api(`/api/sending/campaigns/${id}/archive`, { method: 'POST' }),
  restoreDraft: (id) => api(`/api/sending/campaigns/${id}/restore`, { method: 'POST' }),
  senders: (id) => api(`/api/sending/campaigns/${id}/senders`),
  setSenders: (id, mailboxIds) => api(`/api/sending/campaigns/${id}/senders`, { method: 'PUT', body: JSON.stringify({ mailboxIds }) }),
  sequence: (id) => api(`/api/sending/campaigns/${id}/sequence`),
  addSequenceStep: (id, body = {}) => api(`/api/sending/campaigns/${id}/sequence/steps`, { method: 'POST', body: JSON.stringify(body) }),
  updateSequenceStep: (id, stepId, body) => api(`/api/sending/campaigns/${id}/sequence/steps/${stepId}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteSequenceStep: (id, stepId) => api(`/api/sending/campaigns/${id}/sequence/steps/${stepId}`, { method: 'DELETE' }),
  reorderSequenceSteps: (id, stepIds) => api(`/api/sending/campaigns/${id}/sequence/order`, { method: 'PUT', body: JSON.stringify({ stepIds }) }),
  previewSequenceStep: (id, stepId, body) => api(`/api/sending/campaigns/${id}/sequence/steps/${stepId}/preview`, { method: 'POST', body: JSON.stringify(body) }),
  templates: (includeArchived = false) => api(`/api/sending/templates${includeArchived ? '?include_archived=true' : ''}`),
  createTemplate: (body) => api('/api/sending/templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTemplate: (id, body) => api(`/api/sending/templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveTemplate: (id) => api(`/api/sending/templates/${id}/archive`, { method: 'POST' }),
  restoreTemplate: (id) => api(`/api/sending/templates/${id}/restore`, { method: 'POST' }),
  pause:     (id) => api(`/api/sending/campaigns/${id}/pause`, { method: 'POST' }),
  resume:    (id) => api(`/api/sending/campaigns/${id}/resume`, { method: 'POST' }),
  stop:      (id) => api(`/api/sending/campaigns/${id}/stop`, { method: 'POST' }),
  audience:  (id, params = {}) => { const q = new URLSearchParams(params).toString(); return api(`/api/sending/campaigns/${id}/audience${q ? '?' + q : ''}`); },
  preflight: (id) => api(`/api/sending/campaigns/${id}/preflight`),
  addList:   (id, listId) => api(`/api/sending/campaigns/${id}/audience`, { method: 'POST', body: JSON.stringify({ listId }) }),
  addContacts: (id, leadIds) => api(`/api/sending/campaigns/${id}/audience`, { method: 'POST', body: JSON.stringify({ leadIds }) }),
  removeRecipient: (id, leadId) => api(`/api/sending/campaigns/${id}/audience/${leadId}`, { method: 'DELETE' }),
  reactivateOOO: (id, leadId) => api(`/api/sending/campaigns/${id}/audience/${leadId}/reactivate`, { method: 'POST' }),
  variants:  (id, stepId = null) => api(`/api/sending/campaigns/${id}/variants${stepId ? `?stepId=${encodeURIComponent(stepId)}` : ''}`),
  timeline:  (id, days = 14) => api(`/api/sending/campaigns/${id}/timeline?days=${days}`),
  assignVariant: (id, leadId, stepId) => api(`/api/sending/ab/assign/${id}?leadId=${encodeURIComponent(leadId)}&stepId=${encodeURIComponent(stepId)}`),
  autoPromote: () => api('/api/sending/ab/auto-promote', { method: 'POST' }),
};

// ── Inbox: replies actually persisted from the inbound webhook ───────────
export const Inbox = {
  replies: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return api(`/api/inbox/replies${q ? `?${q}` : ''}`);
  },
  thread: (replyId) => api(`/api/inbox/replies/${encodeURIComponent(replyId)}`),
  markRead: (replyId) => api(`/api/inbox/replies/${encodeURIComponent(replyId)}/read`, { method: 'POST' }),
  markUnread: (replyId) => api(`/api/inbox/replies/${encodeURIComponent(replyId)}/unread`, { method: 'POST' }),
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
