import { escapeHtml } from './ui.js';
import { relTime as relativeTime } from './api.js';
import { deriveVerificationClassification } from '../shared/verification-classification.js';

const STATUS = new Set(['deliverable', 'risky', 'undeliverable', 'unknown']);
const CHECKS = [
  ['regex', 'Syntax'],
  ['mx', 'MX acceptance'],
  ['disposable', 'Known disposable-domain list'],
  ['smtp', 'SMTP recipient response'],
];

function text(value, fallback = 'Not reported') {
  return typeof value === 'string' && value.trim() ? escapeHtml(value.trim()) : escapeHtml(fallback);
}

function checkMarkup(value, label, key) {
  if (key === 'smtp' && value === true) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-pass">Recipient accepted</span> <span class="evidence-unknown">(not mailbox confirmation)</span></div>`;
  if (key === 'smtp' && value === false) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-fail">Recipient response was negative</span></div>`;
  if (key === 'disposable' && value === true) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-pass">No match in checked list</span> <span class="evidence-unknown">(not a complete disposable-domain guarantee)</span></div>`;
  if (key === 'disposable' && value === false) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-fail">Matched a known disposable signal</span></div>`;
  if (value === true) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-pass">Passed</span></div>`;
  if (value === false) return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-fail">Verifier reported a negative result</span></div>`;
  return `<div class="quick-detail"><strong>${label}:</strong> <span class="evidence-unknown">Not checked / no evidence</span></div>`;
}

function classification(attributes, result, key, legacyKey) {
  if (typeof attributes?.[key] === 'boolean') return attributes[key];
  if (typeof result?.[legacyKey] === 'boolean') return result[legacyKey];
  return null;
}

function disposableCheckLabel(status) {
  return {
    checked: 'Checked by Disify (domain only)',
    disabled: 'Off; local list used',
    skipped_consumer_provider: 'Skipped for consumer mail provider',
    skipped_local_match: 'Local disposable list matched',
    skipped_special_use_domain: 'Skipped example or test domain',
    invalid_domain: 'Domain could not be checked',
    rate_limited: 'Provider rate limited; local list used',
    configuration_error: 'Provider configuration needs attention; local list used',
    unavailable: 'Provider unavailable; local list used',
  }[status] || status;
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function classificationEvidenceMarkup(evidence) {
  const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.source !== 'local_disposable_dataset'
    || evidence.dataset_commit !== '3ebb7fef055e3757dfc9bb46b1297ee2b0d11fe7'
    || evidence.dataset_sha256 !== 'ba19d6735fc2224db58d3eaa9bb294de43437a488133c4271fb07d0ad4436fc7'
    || typeof evidence.dataset_available !== 'boolean'
    || !(evidence.match === null || typeof evidence.match === 'boolean')
    || (evidence.matched_domain !== null && (typeof evidence.matched_domain !== 'string' || !domainPattern.test(evidence.matched_domain)))
    || !isCanonicalIsoTimestamp(evidence.checked_at)
    || (evidence.dataset_available === false && (evidence.match !== null || evidence.matched_domain !== null))
    || (evidence.match === true && (!evidence.dataset_available || evidence.matched_domain === null))
    || (evidence.match !== true && evidence.matched_domain !== null)) return '';

  const detail = evidence.dataset_available === false
    ? 'Classification unknown: the pinned dataset is unavailable.'
    : evidence.match === true
      ? `Disposable-domain match: ${text(evidence.matched_domain)}.`
      : evidence.match === false
        ? 'No match in this pinned snapshot. No-match does not guarantee a non-disposable or deliverable address.'
        : 'Classification unknown for this domain.';
  return `<section class="quick-detail" data-classification-evidence><strong>Offline disposable-domain evidence:</strong> ${detail} <span>Dataset revision ${text(evidence.dataset_commit)} · checked ${text(evidence.checked_at)}.</span></section>`;
}

export function renderQuickVerificationResult(result) {
  const r = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const classificationResult = deriveVerificationClassification(r.verification_status, r);
  const status = STATUS.has(classificationResult.status) ? classificationResult.status : 'unknown';
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
    ['Known disposable-domain match', classification(attributes, r, 'disposable', 'is_disposable')],
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
  const evidence = r.verification_evidence && typeof r.verification_evidence === 'object' ? r.verification_evidence : null;
  const hasMailRouteWithoutInboxProof = status === 'unknown'
    && evidence?.dns_status === 'mail_route_present'
    && evidence?.mailbox_status === 'unconfirmed';
  const statusLabel = hasMailRouteWithoutInboxProof ? 'INBOX UNCONFIRMED' : status.toUpperCase();
  const routeNote = hasMailRouteWithoutInboxProof
    ? '<div class="quick-detail" role="note">This domain has a mail route, but this check did not test or prove this exact inbox. This does not mean the address is invalid.</div>'
    : '';
  const classificationNote = classificationResult.adjustment === 'legacy_free_provider_risky'
    ? '<div class="quick-detail verifier-legacy-note" role="note">This domain receives email, but this check could not confirm this exact inbox. It is not marked risky just because it uses a free email provider.</div>'
    : '';
  const evidenceDetails = evidence ? [
    ['DNS route', evidence.dns_status],
    ['Mailbox status', evidence.mailbox_status],
    ['Provider', evidence.provider],
    ['SMTP status', evidence.smtp_status],
    ['Disposable signal', evidence.disposable_status],
    ['Disposable source', evidence.disposable_evidence_source],
    ['External disposable check', evidence.disposable_external_status
      ? disposableCheckLabel(evidence.disposable_external_status) : null],
    ['Last checked', evidence.checked_at],
    ['Evidence note', evidence.diagnostic_reason],
  ].filter(([, value]) => typeof value === 'string' && value.length)
    .map(([label, value]) => `<div class="quick-detail"><strong>${label}:</strong> ${text(value)}</div>`).join('') : '';

  return `
    <div class="audit-card-container" style="background:var(--bg-elevated);border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:16px;margin-top:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">Verifier result</div>
          <div class="quick-detail">${text(r.email)}</div>
        </div>
        <div style="text-align:right">
          <span class="status-badge ${statusClass}" aria-label="Verification status: ${escapeHtml(status)}" style="font-size:0.85rem;padding:6px 14px;letter-spacing:0.04em">${statusLabel}</span>
          <div class="quick-detail">Reason: <strong>${text(reason, 'No reason supplied')}</strong></div>
          ${routeNote}
          ${classificationNote}
        </div>
      </div>
      ${status === 'unknown' ? '<p class="quick-detail evidence-unknown">This address has not been rejected. The mailbox check is incomplete; a working address can have this result.</p>' : ''}
      ${r.evidence ? `<p class="quick-detail" data-verification-evidence>Mail route: ${text(r.evidence.mail_route)} · SMTP: ${text(r.evidence.smtp_status)} · Mailbox: ${text(r.evidence.mailbox_status)}. Recipient acceptance does not prove inbox delivery.</p>` : ''}
      ${classificationEvidenceMarkup(r.classification_evidence)}
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
          ${CHECKS.map(([key, label]) => checkMarkup(checks[key], label, key)).join('')}
        </div>
      </div>
      ${evidenceDetails ? `<div class="quick-detail" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)"><strong>Evidence from this check</strong><div class="quick-detail">Quick Verify does not save this result to a contact.</div><div class="grid cols-3 gap-8">${evidenceDetails}</div><div class="quick-detail">DNS routing, provider labels and SMTP recipient acceptance do not confirm a mailbox.</div></div>` : ''}
    </div>`;
}

export function renderQuickVerificationError(message) {
  return `<div class="quick-result-error">${escapeHtml(message || 'Verification failed.')}</div>`;
}

export function renderVerificationResultRow(row, relTime = relativeTime) {
  const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  let checks = {};
  let evidence = null;
  let saved = {};
  try {
    const parsed = JSON.parse(r.verification_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
    checks = saved.checks && typeof saved.checks === 'object' && !Array.isArray(saved.checks) ? saved.checks : {};
    evidence = saved.verification_evidence || null;
  } catch { /* malformed historical evidence remains unknown */ }
  const classificationResult = deriveVerificationClassification(r.stored_verification_status ?? r.verification_status, {
    ...saved,
    ...r,
    verification_evidence: evidence || r.verification_evidence || null,
  });
  const allowedStatus = STATUS.has(classificationResult.status) ? classificationResult.status : 'unknown';
  const statusClass = {
    deliverable: 'badge-deliverable',
    risky: 'badge-risky',
    undeliverable: 'badge-undeliverable',
    unknown: 'badge-unknown',
  }[allowedStatus];
  const statusIcon = { deliverable: '✓', risky: '⚠', undeliverable: '✗', unknown: '?' }[allowedStatus];
  const flags = [];
  if (r.is_role_account === true || r.is_role_account === 1) flags.push('<span class="flag-tag role">Role</span>');
  if (r.is_free_provider === true || r.is_free_provider === 1) flags.push('<span class="flag-tag free">Free</span>');
  if (r.is_disposable === true || r.is_disposable === 1) flags.push('<span class="flag-tag disposable">Disposable</span>');
  if (r.is_catch_all === true || r.is_catch_all === 1) flags.push('<span class="flag-tag catchall">Catch-all</span>');

  let savedVerification = {};
  try {
    const parsed = JSON.parse(r.verification_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) savedVerification = parsed;
  } catch { /* malformed historical evidence remains unknown */ }
  const checkIcons = ['regex', 'mx', 'disposable', 'smtp'].map(key => {
    const value = checks[key];
    if (value === true) return `<span class="check-dot pass" title="${key === 'smtp' ? 'SMTP recipient accepted; this does not confirm a mailbox' : `${key}: pass`}">✓</span>`;
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
      <td><span class="status-badge ${statusClass}">${statusIcon} ${escapeHtml(allowedStatus)}</span>${classificationResult.adjustment || r.classification_adjustment ? '<small class="score-unavailable" title="The domain accepts email, but this result could not confirm this exact inbox.">Inbox not confirmed by this check</small>' : ''}</td>
      <td class="cell-score">${score === null ? '<span class="score-unavailable">Not scored</span>' : `<span class="score-value" title="Verifier signal; not a calibrated probability">${score}/100</span>`}</td>
      <td class="cell-mx">${text(r.mx_host, '—')}</td>
      <td class="cell-checks" aria-label="${evidence ? `DNS ${text(evidence.dns_status)}; mailbox ${text(evidence.mailbox_status)}; SMTP ${text(evidence.smtp_status)}` : 'Verification check evidence'}">${checkIcons}</td>
      <td class="cell-flags">${flags.join('') || '—'}${classificationEvidenceMarkup(savedVerification.classification_evidence)}</td>
      <td class="cell-time">${text(timeAgo, '—')}</td>
      <td><button class="btn-xs" ${safeId ? `onclick="window.__verificationHistory(${safeId})"` : 'disabled'} aria-label="Verification history for ${text(r.email, 'contact')}">History</button> <button class="btn-xs" ${safeId ? `onclick="window.__reverifyEmail(${safeId})"` : 'disabled'} title="Re-verify" aria-label="Re-verify ${text(r.email, 'contact')}">↻</button></td>
    </tr>`;
}

export function renderVerificationEvidenceSummary(summary) {
  const counts = summary?.counts && typeof summary.counts === 'object' ? summary.counts : {};
  const items = [
    ['Source-backed email records', counts.sourceBacked],
    ['Mail routes found', counts.mailRoutePresent],
    ['Mailboxes confirmed', counts.mailboxConfirmed],
    ['Mailboxes unconfirmed', counts.mailboxUnconfirmed],
    ['Mailbox status unknown', counts.mailboxUnknown],
    ['Suppressed records', counts.suppressed],
    ['SMTP recipients accepted', counts.smtpRecipientAccepted],
  ];
  return `<div class="verify-evidence-summary" role="status" aria-label="Saved verification evidence">
    ${items.map(([label, value]) => `<div class="verify-evidence-metric"><span>${label}</span><strong>${Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '—'}</strong></div>`).join('')}
    <p class="quick-detail">These counts cover saved contact emails only. Quick Verify does not save its result. A mail route or accepted SMTP recipient does not confirm that a mailbox exists.</p>
  </div>`;
}

export function renderVerifierHealth(status) {
  const health = status && typeof status === 'object' ? status : {};
  const reacher = health.reacher && typeof health.reacher === 'object' ? health.reacher : {};
  const yesNo = value => value === true ? 'Yes' : value === false ? 'No' : 'Not tested / unknown';
  const defaultLocal = reacher.endpointSource === 'local_default';
  const resolvers = Array.isArray(health.dns?.resolverServers) && health.dns.resolverServers.length
    ? health.dns.resolverServers.map(value => text(String(value))).join(', ') : 'System default';
  const rows = [
    ['Verification mode', health.mode || 'Unknown'],
    ['Reacher configured', defaultLocal ? 'Checking local default automatically' : yesNo(reacher.configured)],
    ['Reacher endpoint', reacher.url ? `${defaultLocal ? 'Local default' : 'Configured'} · ${reacher.url}` : 'Not configured'],
    ['Endpoint reachable', yesNo(reacher.reachable)],
    ['Reacher endpoint contract verified', yesNo(reacher.apiValid)],
    ['Reacher version', reacher.version || 'Not reported'],
    ['Disposable-domain check', health.disposableDomainCheck?.enabled === true
      ? 'Enabled · domain only; availability shown per result'
      : 'Local list only'],
    ['SMTP capability', 'Not determined by API health'],
    ['Outbound SMTP / TCP 25', health.outboundSmtp?.tested === true ? 'Tested' : 'Not tested'],
    ['System DNS resolvers', resolvers],
    ['DNS query deadline', Number.isSafeInteger(health.dns?.queryTimeoutMs) ? `${health.dns.queryTimeoutMs} ms` : 'Not reported'],
  ];
  return `<details class="verify-engine-health"><summary>Verification setup and diagnostics</summary>
    <div class="verify-engine-health-grid">${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${text(String(value))}</strong></div>`).join('')}</div>
    <p class="quick-detail">${text(health.note, 'Health information is unavailable.')}</p>
  </details>`;
}
