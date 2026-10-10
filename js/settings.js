import { Auth, Qualify, Sending } from './api.js';
import { clearFieldError, confirmAction, escapeHtml, icon, notify, openDialog, showFieldError, userFacingError } from './ui.js';

const SCORING_PENALTY_KEYS = ['ssl_check_failed', 'html_truncated', 'unresolved_signal', 'near_threshold', 'threshold_proximity'];

function readableTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Not recorded';
}

export async function renderSettings(root) {
  root.innerHTML = '<section class="settings-page"><p class="settings-loading">Loading workspace controls…</p></section>';
  const [auth, control, scheduleSettings, credentialStorage, mfa, qualificationScoring] = await Promise.all([
    Auth.status(), Sending.control(), Sending.schedule(), Sending.credentialStorage(), Auth.mfaStatus(), Qualify.scoring(),
  ]);
  const canManage = ['owner', 'admin'].includes(auth.user?.role);
  const schedule = scheduleSettings.schedule;
  const history = Array.isArray(control.history) ? control.history : [];
  const statusLabel = control.paused ? 'All campaign sending is paused' : 'Campaign sending is enabled';
  const stateClass = control.paused ? 'is-paused' : 'is-enabled';
  const historyHtml = history.length ? history.map(event => `<li class="settings-audit-row">
    <span class="settings-audit-state ${event.paused ? 'is-paused' : 'is-enabled'}">${event.paused ? 'Paused' : 'Resumed'}</span>
    <span class="settings-audit-reason">${escapeHtml(event.reason || 'No reason recorded')}</span>
    <time datetime="${escapeHtml(event.changedAt || '')}">${escapeHtml(readableTime(event.changedAt))}</time>
    <span class="settings-audit-actor">${event.actorRole ? `${escapeHtml(event.actorRole)} account` : 'System'}</span>
  </li>`).join('') : '<li class="settings-audit-empty">No workspace send-control changes have been recorded.</li>';
  const scheduleHistory = Array.isArray(scheduleSettings.history) ? scheduleSettings.history : [];
  const scheduleHistoryHtml = scheduleHistory.length ? scheduleHistory.map(event => {
    const item = event.schedule || {};
    return `<li class="settings-audit-row">
      <span class="settings-audit-state is-enabled">Saved</span>
      <span class="settings-audit-reason">${escapeHtml(item.timezone || 'Time zone')}, ${escapeHtml(`${item.startHour}:00–${item.endHour}:00`)} · ${item.weekdaysOnly ? 'weekdays' : 'every day'} · ${escapeHtml(`${item.minIntervalMs / 1000}–${item.maxIntervalMs / 1000}s`)} spacing</span>
      <time datetime="${escapeHtml(event.changedAt || '')}">${escapeHtml(readableTime(event.changedAt))}</time>
      <span class="settings-audit-actor">${event.actorRole ? `${escapeHtml(event.actorRole)} account` : 'System'}</span>
    </li>`;
  }).join('') : '<li class="settings-audit-empty">No workspace schedule changes have been recorded.</li>';
  const credentialStatusText = {
    ready: 'Encryption key configured',
    encrypted: 'Stored credentials are encrypted',
    key_required: 'Encryption key required before saving SMTP passwords',
    legacy_plaintext: `${credentialStorage.legacyCredentialCount} saved SMTP password(s) still use legacy plaintext storage`,
    migration_pending: 'Saved legacy credentials are being encrypted',
    key_unavailable: `${credentialStorage.unreadableCredentialCount} encrypted credential(s) cannot be opened with the configured keys`,
  }[credentialStorage.status] || 'Credential storage status is unknown';
  const credentialStatusClass = ['key_unavailable', 'legacy_plaintext', 'key_required'].includes(credentialStorage.status)
    ? 'is-paused' : 'is-enabled';
  const scoringProfile = qualificationScoring.active;
  const scoringConfig = scoringProfile.config;
  const scoringWeightLabels = {
    ssl_valid: 'Valid TLS', viewport_meta: 'Mobile viewport', copyright_recent: 'Recent copyright year',
    has_analytics: 'Analytics present', modern_cms: 'Modern CMS', responsive_images: 'Responsive images',
    fast_load: 'Fast response size', structured_data: 'Structured data', custom_domain_email: 'Domain email link',
    social_links: 'Social links', last_modified_recent: 'Recent Last-Modified', https_redirect: 'HTTPS redirect',
  };
  const scoringHistoryHtml = (qualificationScoring.history || []).map(profile => `<li class="settings-audit-row">
    <span class="settings-audit-state is-enabled">v${Number(profile.version)}</span>
    <span class="settings-audit-reason">${escapeHtml(profile.changeNote || 'Scoring profile')} · ${escapeHtml(String(profile.configHash || '').slice(0, 12))}</span>
    <time>${escapeHtml(readableTime(profile.createdAt))}</time>
    <span class="settings-audit-actor">${profile.createdByUserId ? `Account #${Number(profile.createdByUserId)}` : 'System default'}</span>
  </li>`).join('') || '<li class="settings-audit-empty">No scoring profile history is available.</li>';

  root.innerHTML = `<section class="settings-page">
    <header class="section-header settings-heading">
      <div><span class="eyebrow">WORKSPACE CONTROLS</span><h1>Settings</h1><p>Configure the enforced sender schedule and manage the outbound safety boundary.</p></div>
    </header>
    <section class="settings-credential-card ${credentialStatusClass}" aria-labelledby="credential-storage-heading">
      <div class="settings-control-topline"><span class="settings-control-icon">${icon('shield', 22)}</span><span class="eyebrow">MAILBOX SECRETS</span></div>
      <h2 id="credential-storage-heading">${escapeHtml(credentialStatusText)}</h2>
      <p class="settings-control-description">SMTP and IMAP passwords are encrypted with AES-256-GCM before new mailbox credentials are saved. The private key stays in the server environment, never in the database or browser. Keep it backed up separately.</p>
      ${credentialStorage.activeKeyConfigured ? '' : '<p class="settings-credential-instructions">Set <code>ODD_CREDENTIAL_ENCRYPTION_KEY</code> to a private 64-character hex key, then restart the app. Generate it on the server with <code>node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"</code>. Do not paste the key into chat or commit it.</p>'}
      ${credentialStorage.productionEncryptionRequired && !credentialStorage.activeKeyConfigured ? '<p class="settings-action-error">Production sending is blocked until encrypted credential storage is configured.</p>' : ''}
      <p class="settings-credential-counts">${Number(credentialStorage.encryptedCredentialCount) || 0} encrypted · ${Number(credentialStorage.legacyCredentialCount) || 0} legacy · ${Number(credentialStorage.unreadableCredentialCount) || 0} unavailable</p>
    </section>
    <section class="settings-mfa-card ${mfa.enabled ? 'is-enabled' : ''}" aria-labelledby="mfa-heading">
      <div class="settings-control-topline"><span class="settings-control-icon">${icon('shield', 22)}</span><span class="eyebrow">ACCOUNT SECURITY</span></div>
      <h2 id="mfa-heading">${mfa.enabled ? 'Authenticator sign-in is enabled' : 'Add authenticator sign-in'}</h2>
      <p class="settings-control-description">Use a time-based authenticator code after your password or Google sign-in. Recovery codes are shown once and stored only as hashes.</p>
      ${!mfa.eligible ? '<p class="settings-permission-note">Authenticator MFA can be managed by workspace owners and admins.</p>'
        : mfa.configurationValid === false ? '<p class="settings-action-error">MFA storage is incomplete. Sign-in remains protected; a workspace operator must repair the account state before MFA can be changed.</p>'
        : mfa.enabled ? `<p class="settings-mfa-count">${Number(mfa.recoveryCodesRemaining) || 0} unused recovery code${Number(mfa.recoveryCodesRemaining) === 1 ? '' : 's'} remaining</p>
          <div class="settings-mfa-actions"><button class="btn btn-secondary" id="mfa-regenerate" type="button">Replace recovery codes</button><button class="btn btn-danger" id="mfa-disable" type="button">Disable authenticator MFA</button></div>`
          : mfa.encryptionAvailable ? `<p class="settings-mfa-count">Setup takes a few minutes. Keep your recovery codes somewhere private.</p>
            ${mfa.pendingEnrollmentExpiresAt ? `<p class="settings-mfa-pending">An unfinished setup expires ${escapeHtml(readableTime(mfa.pendingEnrollmentExpiresAt))}.</p>` : ''}
            <button class="btn btn-primary" id="mfa-enroll" type="button">Set up authenticator</button>`
            : `<p class="settings-action-error">Configure the server-only <code>ODD_CREDENTIAL_ENCRYPTION_KEY</code> before enrolling MFA. The authenticator secret is encrypted with this key.</p>`}
    </section>
    <section class="settings-scoring-card" aria-labelledby="qualification-scoring-heading">
      <div class="settings-audit-heading"><div><span class="eyebrow">QUALIFICATION POLICY</span><h2 id="qualification-scoring-heading">Website scoring · version ${Number(scoringProfile.version)}</h2></div><code class="settings-scoring-hash">${escapeHtml(String(scoringProfile.configHash || '').slice(0, 16))}</code></div>
      <p class="settings-control-description">Each audit stores the immutable profile version and signal evidence used for its score. Scores at or above the modern threshold are Modern; the low-score cutoff distinguishes low from marginal results below that threshold. Saving creates a new profile and leaves past results intact.</p>
      ${canManage ? `<form id="qualification-scoring-form" class="settings-scoring-form">
        <fieldset><legend>Classification thresholds</legend>
          <label>Low-score cutoff (below)<input name="outdatedMax" type="number" min="0" max="99" step="1" required value="${Number(scoringConfig.thresholds.outdated_max)}"></label>
          <label>Modern at or above<input name="modernMin" type="number" min="1" max="100" step="1" required value="${Number(scoringConfig.thresholds.modern_min)}"></label>
        </fieldset>
        <fieldset><legend>Signal weights · points</legend><div class="settings-scoring-fields">${Object.entries(scoringConfig.signal_weights).map(([key, weight]) => `<label>${escapeHtml(scoringWeightLabels[key] || key)}<input name="weight:${escapeHtml(key)}" type="number" min="0" max="100" step="1" required value="${Number(weight)}"></label>`).join('')}</div></fieldset>
        <fieldset><legend>Confidence penalties · points</legend><div class="settings-scoring-fields settings-scoring-penalties">${SCORING_PENALTY_KEYS.map(key => `<label>${key === 'ssl_check_failed' ? 'TLS check failed before HTTP fallback' : key === 'html_truncated' ? 'HTML evidence truncated' : key === 'unresolved_signal' ? 'Each unresolved signal' : key === 'near_threshold' ? 'Near a decision threshold' : 'Threshold proximity window'}<input name="penalty:${key}" type="number" min="0" max="100" step="1" required value="${Number(scoringConfig.confidence_penalties[key])}"></label>`).join('')}</div></fieldset>
        <fieldset><legend>Signal freshness windows</legend>
          <label>Copyright year recency (years)<input name="copyrightYears" type="number" min="0" max="10" step="1" required value="${Number(scoringConfig.copyright_year_recent_within)}"></label>
          <label>Last-Modified recency (days)<input name="lastModifiedDays" type="number" min="1" max="3650" step="1" required value="${Number(scoringConfig.last_modified_recent_days)}"></label>
        </fieldset>
        <label class="settings-scoring-note">Change note<input name="changeNote" type="text" maxlength="240" placeholder="What changed and why?" autocomplete="off"></label>
        <div class="settings-schedule-submit"><button class="btn btn-primary" id="qualification-scoring-save" type="submit" ${canManage ? '' : 'disabled'}>Save as new version</button><p class="settings-action-error" id="qualification-scoring-error" role="alert" hidden></p></div>
      </form>` : '<p class="settings-permission-note">Only workspace owners and admins can change scoring policy.</p>'}
      <ol class="settings-audit-list settings-scoring-history">${scoringHistoryHtml}</ol>
    </section>
    <section class="settings-schedule-card" aria-labelledby="send-schedule-heading">
      <div class="settings-audit-heading"><div><span class="eyebrow">DURABLE SEND SCHEDULE</span><h2 id="send-schedule-heading">Allowed send window and pacing</h2></div><span>${scheduleSettings.source === 'workspace' ? 'Workspace setting' : 'Configuration default'}</span></div>
      <p class="settings-control-description">The worker enforces this IANA time zone window and per-mailbox spacing at submission. Saved changes persist across restart and invalidate campaign launch reviews.</p>
      ${canManage ? `<form id="workspace-send-schedule" class="settings-schedule-form">
        <label>Time zone<input id="send-schedule-timezone" name="timezone" type="text" maxlength="64" autocomplete="off" required value="${escapeHtml(schedule.timezone)}"><small>Use an IANA zone, such as America/New_York.</small></label>
        <label>Start hour<input id="send-schedule-start" name="startHour" type="number" min="0" max="23" step="1" required value="${Number(schedule.startHour)}"><small>Local time, 0–23.</small></label>
        <label>End hour<input id="send-schedule-end" name="endHour" type="number" min="1" max="24" step="1" required value="${Number(schedule.endHour)}"><small>Exclusive end; 24 means midnight.</small></label>
        <label class="settings-schedule-check"><input id="send-schedule-weekdays" name="weekdaysOnly" type="checkbox" ${schedule.weekdaysOnly ? 'checked' : ''}> Weekdays only</label>
        <label>Minimum spacing (seconds)<input id="send-schedule-min" name="minIntervalSeconds" type="number" min="5" max="3600" step="1" required value="${Number(schedule.minIntervalMs) / 1000}"><small>At least five seconds.</small></label>
        <label>Maximum spacing (seconds)<input id="send-schedule-max" name="maxIntervalSeconds" type="number" min="5" max="3600" step="1" required value="${Number(schedule.maxIntervalMs) / 1000}"></label>
        <div class="settings-schedule-submit"><button class="btn btn-primary" id="workspace-send-schedule-save" type="submit">Save schedule</button><p class="settings-action-error" id="workspace-send-schedule-error" role="alert" hidden></p></div>
      </form>` : '<p class="settings-permission-note">Only workspace owners and admins can change the send schedule.</p>'}
      <ol class="settings-audit-list">${scheduleHistoryHtml}</ol>
    </section>
    <section class="settings-control-card ${stateClass}" aria-labelledby="send-control-heading">
      <div class="settings-control-topline"><span class="settings-control-icon">${icon('shield', 22)}</span><span class="eyebrow">OUTBOUND SAFETY</span></div>
      <h2 id="send-control-heading">${escapeHtml(statusLabel)}</h2>
      <p class="settings-control-description">${control.paused
        ? `Reason: ${escapeHtml(control.reason || 'Paused by a workspace administrator.')}`
        : 'The existing worker may submit only rows that pass campaign, recipient, sender, compliance, schedule, and SMTP checks.'}</p>
      <p class="settings-control-updated">Last changed ${escapeHtml(readableTime(control.updatedAt))}${control.updatedByRole ? ` by a ${escapeHtml(control.updatedByRole)}` : ''}.</p>
      <div class="settings-pause-note"><strong>What the pause does</strong><span>It blocks new campaign queueing and SMTP submissions. Scheduled rows remain saved for later. A submission already in SMTP may finish.</span></div>
      ${canManage ? `<div class="settings-control-actions">
        ${control.paused ? '' : '<label for="workspace-pause-reason">Reason for pausing</label><textarea id="workspace-pause-reason" rows="2" maxlength="300" placeholder="For example: investigating unexpected sending activity"></textarea>'}
        <button class="btn ${control.paused ? 'btn-primary' : 'btn-danger'}" id="workspace-send-control" type="button">${control.paused ? 'Resume campaign sending' : 'Pause all campaign sending'}</button>
        <p class="settings-action-error" id="workspace-send-control-error" role="alert" hidden></p>
      </div>` : '<p class="settings-permission-note">Only workspace owners and admins can change this control.</p>'}
    </section>
    <section class="settings-audit-card" aria-labelledby="send-control-history-heading">
      <div class="settings-audit-heading"><div><span class="eyebrow">AUDIT HISTORY</span><h2 id="send-control-history-heading">Sending control changes</h2></div><span>${history.length} recent ${history.length === 1 ? 'change' : 'changes'}</span></div>
      <ol class="settings-audit-list">${historyHtml}</ol>
    </section>
  </section>`;

  const scheduleForm = root.querySelector('#workspace-send-schedule');
  scheduleForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = root.querySelector('#workspace-send-schedule-save');
    const error = root.querySelector('#workspace-send-schedule-error');
    scheduleForm.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
    error.textContent = '';
    error.hidden = true;
    const minIntervalSeconds = Number(root.querySelector('#send-schedule-min').value);
    const maxIntervalSeconds = Number(root.querySelector('#send-schedule-max').value);
    button.disabled = true;
    try {
      await Sending.setSchedule({
        timezone: root.querySelector('#send-schedule-timezone').value.trim(),
        startHour: Number(root.querySelector('#send-schedule-start').value),
        endHour: Number(root.querySelector('#send-schedule-end').value),
        weekdaysOnly: root.querySelector('#send-schedule-weekdays').checked,
        minIntervalMs: minIntervalSeconds * 1000,
        maxIntervalMs: maxIntervalSeconds * 1000,
      });
      notify('Send schedule saved and is now enforced by the worker.', 'success');
      await renderSettings(root);
    } catch (failure) {
      const message = userFacingError(failure, 'Could not save the send schedule. Review the values and try again.');
      const timezone = root.querySelector('#send-schedule-timezone');
      const startHour = root.querySelector('#send-schedule-start');
      const endHour = root.querySelector('#send-schedule-end');
      const minimumSpacing = root.querySelector('#send-schedule-min');
      const maximumSpacing = root.querySelector('#send-schedule-max');
      const field = /valid IANA time zone/i.test(message) ? timezone
        : /send window/i.test(message) ? (Number(startHour.value) >= Number(endHour.value) ? endHour : startHour)
          : /pacing/i.test(message) ? (Number(maximumSpacing.value) < Number(minimumSpacing.value) ? maximumSpacing : minimumSpacing)
            : null;
      if (field) {
        showFieldError(field, message);
        field.focus();
      } else {
        error.textContent = message;
        error.hidden = false;
      }
      button.disabled = false;
    }
  });

  root.querySelector('#qualification-scoring-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const error = root.querySelector('#qualification-scoring-error');
    const button = root.querySelector('#qualification-scoring-save');
    const config = {
      ...scoringConfig,
      thresholds: {
        outdated_max: Number(data.get('outdatedMax')),
        modern_min: Number(data.get('modernMin')),
      },
      signal_weights: Object.fromEntries(Object.keys(scoringConfig.signal_weights).map(key => [key, Number(data.get(`weight:${key}`))])),
      confidence_penalties: {
        ...scoringConfig.confidence_penalties,
        ...Object.fromEntries(SCORING_PENALTY_KEYS.map(key => [key, Number(data.get(`penalty:${key}`))])),
      },
      copyright_year_recent_within: Number(data.get('copyrightYears')),
      last_modified_recent_days: Number(data.get('lastModifiedDays')),
    };
    button.disabled = true;
    try {
      await Qualify.updateScoring({ config, changeNote: String(data.get('changeNote') || '').trim() });
      notify('A new immutable qualification scoring profile is active.', 'success');
      await renderSettings(root);
    } catch (failure) {
      error.textContent = failure.message || 'Could not save the scoring profile.';
      error.hidden = false;
      button.disabled = false;
    }
  });

  const showRecoveryCodes = (codes, heading = 'Save your recovery codes') => {
    const safeCodes = Array.isArray(codes) ? codes : [];
    const dialog = openDialog({
      title: heading,
      eyebrow: 'SHOWN ONCE',
      body: `<p class="settings-control-description">Store these codes in a password manager or another secure place. Each code works once. This list cannot be displayed again.</p>
        <div class="settings-recovery-codes" aria-label="One-time recovery codes">${safeCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}</div>
        <button class="btn btn-secondary" type="button" data-copy-recovery>Copy codes</button>`,
    });
    dialog.querySelector('[data-copy-recovery]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(safeCodes.join('\n'));
        button.textContent = 'Copied';
      } catch {
        notify('Clipboard access is unavailable. Select and copy the codes manually.', 'warning');
      }
    });
  };

  root.querySelector('#mfa-enroll')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const enrollment = await Auth.beginMfaEnrollment();
      openDialog({
        title: 'Connect your authenticator',
        eyebrow: 'TOTP SETUP',
        submitLabel: 'Verify authenticator',
        body: `<p class="settings-control-description">Add this account to an authenticator app using the setup key. The app must generate the current six-digit code before setup expires.</p>
          <label class="settings-mfa-secret-label">Private setup key<code class="settings-mfa-secret">${escapeHtml(enrollment.secret)}</code></label>
          <p class="settings-mfa-pending">Manual entry is supported. This key is private; only enter it into your authenticator.</p>
          <label>Six-digit authenticator code<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus></label>`,
        onSubmit: async formData => {
          const result = await Auth.confirmMfaEnrollment(String(formData.get('code') || '').trim());
          setTimeout(() => showRecoveryCodes(result.recoveryCodes, 'Save your recovery codes'), 0);
          notify('Authenticator sign-in is enabled.', 'success');
          await renderSettings(root);
        },
      });
    } catch (failure) {
      notify(failure.message || 'Could not start authenticator setup.', 'error');
      button.disabled = false;
    }
  });

  root.querySelector('#mfa-regenerate')?.addEventListener('click', () => {
    openDialog({
      title: 'Replace recovery codes', eyebrow: 'ACCOUNT SECURITY', submitLabel: 'Replace codes',
      body: `<p class="settings-control-description">This invalidates every existing recovery code. Confirm with your account password and either the current authenticator code or an unused recovery code.</p>
        <label>Account password<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
        <label>Authenticator or recovery code<input name="code" type="text" autocomplete="one-time-code" maxlength="32" required></label>`,
      onSubmit: async formData => {
        const result = await Auth.regenerateMfaRecoveryCodes({ password: String(formData.get('password') || ''), code: String(formData.get('code') || '').trim() });
        setTimeout(() => showRecoveryCodes(result.recoveryCodes, 'Save your new recovery codes'), 0);
        notify('Recovery codes were replaced.', 'success');
        await renderSettings(root);
      },
    });
  });

  root.querySelector('#mfa-disable')?.addEventListener('click', () => {
    openDialog({
      title: 'Disable authenticator MFA', eyebrow: 'ACCOUNT SECURITY', submitLabel: 'Disable MFA',
      body: `<p class="settings-action-error">This removes the second sign-in step and invalidates every recovery code. Confirm with your account password and either the current authenticator code or an unused recovery code.</p>
        <label>Account password<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
        <label>Authenticator or recovery code<input name="code" type="text" autocomplete="one-time-code" maxlength="32" required></label>`,
      onSubmit: async formData => {
        await Auth.disableMfa({ password: String(formData.get('password') || ''), code: String(formData.get('code') || '').trim() });
        notify('Authenticator MFA is disabled.', 'success');
        await renderSettings(root);
      },
    });
  });

  const action = root.querySelector('#workspace-send-control');
  action?.addEventListener('click', async () => {
    const paused = !control.paused;
    const reason = paused
      ? root.querySelector('#workspace-pause-reason')?.value.trim() || ''
      : 'Campaign sending resumed by a workspace administrator.';
    const error = root.querySelector('#workspace-send-control-error');
    if (paused && reason.length < 4) {
      error.textContent = 'Add a short reason so the pause is clear in the audit history.';
      error.hidden = false;
      root.querySelector('#workspace-pause-reason')?.focus();
      return;
    }
    const verb = paused ? 'Pause all campaign sending' : 'Resume campaign sending';
    if (!await confirmAction({ title: verb, message: 'Scheduled campaign rows will remain saved.', confirmLabel: paused ? 'Pause sending' : 'Resume sending', danger: paused })) return;
    action.disabled = true;
    try {
      await Sending.setControl({ paused, reason });
      notify(paused ? 'Campaign sending is paused.' : 'Campaign sending resumed.', 'success');
      await renderSettings(root);
    } catch (failure) {
      if (error) { error.textContent = failure.message || 'Could not update the sending control.'; error.hidden = false; }
      action.disabled = false;
    }
  });
}
