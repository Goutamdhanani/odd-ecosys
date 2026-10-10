import { escapeHtml } from './ui.js';

const STATUS = new Set(['deliverable', 'risky', 'undeliverable', 'unknown']);
const CHECKS = [
  ['regex', 'Syntax'],
  ['mx', 'MX acceptance'],
  ['disposable', 'Disposable-domain check'],
  ['smtp', 'SMTP mailbox response'],
];

function text(value, fallback = 'Not reported') {
  return typeof value === 'string' && value.trim() ? escapeHtml(value.trim()) : escapeHtml(fallback);
}

function checkMarkup(value, label) {
  if (value === true) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-pass">Passed</span></div>`;
  if (value === false) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-fail">Verifier reported a negative result</span></div>`;
  return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-unknown">Not checked / no evidence</span></div>`;
}

function classification(attributes, result, key, legacyKey) {
  if (typeof attributes?.[key] === 'boolean') return attributes[key];
  if (typeof result?.[legacyKey] === 'boolean') return result[legacyKey];
  return null;
}

export function renderQuickVerificationResult(result) {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const status = STATUS.has(r.verification_status) ? r.verification_status : 'unknown';
  const statusClass = {
    deliverable: 'badge-deliverable',
    risky: 'badge-risky',
    undeliverable: 'badge-undeliverable',
    unknown: 'badge-unknown',
  }[status];
  const checks = r.checks && typeof r.checks === 'object' ? r.checks : {};
  const attributes = r.attributes && typeof r.attributes === 'object' ? r.attributes : {};
  const flags = [
    ['Free provider', classification(attributes, r, 'free', 'is_free_provider')],
    ['Role account', classification(attributes, r, 'role', 'is_role_account')],
    ['Disposable', classification(attributes, r, 'disposable', 'is_disposable')],
    ['Accept-all', classification(attributes, r, 'accept_all', 'is_catch_all')],
  ];
  const flagRows = flags.filter(([, value]) => value !== null).map(([label, value]) =>
    `<div class="quick-detail"><strong>${label}:</strong> ${value ? 'Yes' : 'No'}</div>`
  ).join('');
  const mxHost = typeof r.mx_host === 'string' ? r.mx_host : r.mail_server?.mx_record;
  let reason = typeof r.general?.reason === 'string' ? r.general.reason
    : Array.isArray(r.reasons) ? r.reasons.filter(item => typeof item === 'string').join(', ') : '';
  if (/port\s*25\s*blocked/i.test(reason) || (Array.isArray(r.reasons) && r.reasons.includes('smtp_unconfirmed_port25_blocked'))) {
    reason = r.reacher?.smtp?.can_connect_smtp === false
      ? 'SMTP Connection Unavailable'
      : 'Mailbox Not Confirmed';
  }
  const domain = typeof r.general?.domain === 'string' ? r.general.domain : '';
  const score = typeof r.score === 'number' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 100
    ? Math.round(r.score)
    : null;

  return `
    <div class="audit-card-container" style="background:var(--bg-elevated);border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:16px;margin-top:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">Verifier result</div>
          <div class="quick-detail">${text(r.email)}</div>
        </div>
        <div style="text-align:right">
          <span class="status-badge ${statusClass}" style="font-size:0.85rem;padding:6px 14px;letter-spacing:0.04em">${escapeHtml(status.toUpperCase())}</span>
          <div class="quick-detail">Reason: <strong>${text(reason, 'No reason supplied')}</strong></div>
        </div>
      </div>
      <p class="quick-detail" data-verifier-score>${score === null
        ? '<strong>Verifier score:</strong> Not scored; the verifier returned no supported numeric score.'
        : `<strong>Verifier score:</strong> ${score}/100 <span>(a verifier signal, not a calibrated probability)</span>`}</p>
      <div class="grid cols-3 gap-12" style="font-size:0.78rem">
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:var(--radius-sm);padding:12px">
          <div style="font-weight:700;margin-bottom:8px;color:var(--system-blue);font-size:0.82rem">Verifier details</div>
          <div class="quick-detail"><strong>Domain:</strong> ${text(domain)}</div>
          <div class="quick-detail"><strong>Engine:</strong> ${text(r.engine)}</div>
          <div class="quick-detail"><strong>MX host:</strong> ${text(mxHost, 'No MX host recorded')}</div>
        </div>
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:var(--radius-sm);padding:12px">
          <div style="font-weight:700;margin-bottom:8px;color:var(--system-purple);font-size:0.82rem">Verifier classifications</div>
          ${flagRows || '<div class="quick-detail">No classifications returned.</div>'}
        </div>
        <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:var(--radius-sm);padding:12px">
          <div style="font-weight:700;margin-bottom:8px;color:var(--system-green);font-size:0.82rem">Checks</div>
          ${CHECKS.map(([key, label]) => checkMarkup(checks[key], label)).join('')}
        </div>
      </div>
    </div>`;
}

export function renderQuickVerificationError(message) {
  return `<div class="quick-result-error">${escapeHtml(message || 'Verification failed.')}</div>`;
}

export function renderVerificationResultRow(row, relTime = () => '—') {
  const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  const allowedStatus = STATUS.has(r.verification_status) ? r.verification_status : 'unknown';
  const statusClass = {
    deliverable: 'badge-deliverable',
    risky: 'badge-risky',
    undeliverable: 'badge-undeliverable',
    unknown: 'badge-unknown',
  }[allowedStatus];
  const statusIcon = { deliverable: '✓', risky: '⚠', undeliverable: '✗', unknown: '?' }[allowedStatus];
  const flags = [];
  if (r.is_role_account === true) flags.push('<span class="flag-tag role">Role</span>');
  if (r.is_free_provider === true) flags.push('<span class="flag-tag free">Free</span>');
  if (r.is_disposable === true) flags.push('<span class="flag-tag disposable">Disposable</span>');
  if (r.is_catch_all === true) flags.push('<span class="flag-tag catchall">Catch-all</span>');

  let checks = {};
  try { checks = JSON.parse(r.verification_json || '{}').checks || {}; } catch { /* malformed historical evidence remains unknown */ }
  const checkIcons = ['regex', 'mx', 'disposable', 'smtp'].map(key => {
    const value = checks[key];
    if (value === true) return `<span class="check-dot pass" title="${key}: pass">✓</span>`;
    if (value === false) return `<span class="check-dot fail" title="${key}: negative verifier result">✗</span>`;
    return `<span class="check-dot skip" title="${key}: not checked or unknown">–</span>`;
  }).join('');
  const id = Number(r.id);
  const safeId = Number.isSafeInteger(id) && id > 0 ? id : null;
  const timeAgo = r.verified_at ? relTime(r.verified_at) : '—';
  const score = typeof r.confidence_score === 'number' && Number.isFinite(r.confidence_score)
    && r.confidence_score >= 0 && r.confidence_score <= 100
    ? Math.round(r.confidence_score)
    : null;

  return `
    <tr class="verify-row" data-id="${safeId ?? ''}">
      <td class="cell-email"><span class="email-text">${text(r.email, '—')}</span></td>
      <td>${text(r.business_name, '—')}</td>
      <td><span class="status-badge ${statusClass}">${statusIcon} ${escapeHtml(allowedStatus)}</span></td>
      <td class="cell-score">${score === null ? '<span class="score-unavailable">Not scored</span>' : `<span class="score-value" title="Verifier signal; not a calibrated probability">${score}/100</span>`}</td>
      <td class="cell-mx">${text(r.mx_host, '—')}</td>
      <td class="cell-checks">${checkIcons}</td>
      <td class="cell-flags">${flags.join('') || '—'}</td>
      <td class="cell-time">${text(timeAgo, '—')}</td>
      <td><button class="btn-xs" ${safeId ? `onclick="window.__reverifyEmail(${safeId})"` : 'disabled'} title="Re-verify" aria-label="Re-verify ${text(r.email, 'contact')}">↻</button></td>
    </tr>`;
}
