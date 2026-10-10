// Frontend primitives; operational data comes from the real API.
export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const paths = {
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', diagonal: '<path d="M6 18 18 6M6 6h12v12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-4-5.65"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',
  sparkle: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3ZM20 2v4M18 4h4"/>',
  send: '<path d="m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  chart: '<path d="M4 4v16h16M8 15v-4M13 15V7M18 15v-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>', activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', link: '<path d="m9 15 6-6M7 13l-2 2a4 4 0 0 0 6 6l3-3M10 6l3-3a4 4 0 0 1 6 6l-2 2"/>',
};
export function icon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
}
function notificationCopy(message) {
  const text = String(message ?? '');
  const apiFailure = text.match(/^API \S+ failed: HTTP (\d{3})(?: — ([\s\S]*))?$/);
  if (!apiFailure) return text;
  const status = Number(apiFailure[1]);
  if (status === 401) return 'Your session has expired. Sign in and try again.';
  if (status === 403) return 'You do not have permission to complete this action.';
  if (status === 404) return 'This item is no longer available. Refresh and try again.';
  if (status === 409) return 'This item changed. Refresh and try again.';
  if (status === 413) return 'This file is too large. Choose a smaller file and try again.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The service is temporarily unavailable. Please try again.';
  if ([400, 422].includes(status)) {
    try {
      const body = JSON.parse(apiFailure[2] || '');
      const detail = body?.error ?? body?.message;
      if (typeof detail === 'string' && detail.trim() && detail.length <= 180) return detail.trim();
    } catch { /* Keep malformed server details out of the interface. */ }
    return 'Some information needs your attention. Review it and try again.';
  }
  return 'That request could not be completed. Review your changes and try again.';
}
export function userFacingError(error, fallback = 'This view could not load. Please try again.') {
  if (error?.code === 'NETWORK_ERROR' || error?.status === 0) return 'The workspace could not be reached. Check your connection and try again.';
  if (error?.status === 401 || error?.code === 'UNAUTHORIZED') return 'Your session has expired. Sign in and try again.';
  if (error?.status === 403 || error?.code === 'FORBIDDEN') return 'You do not have permission to open this view.';
  if (error?.status === 404 || error?.code === 'NOT_FOUND') return 'A workspace service required by this view is unavailable. Reload or restart the app, then try again.';
  const raw = String(error?.message ?? error ?? '');
  const copy = notificationCopy(raw);
  return copy === raw ? fallback : copy;
}
export function notify(message, tone = 'success') {
  let region = document.getElementById('notification-region');
  if (!region) { region = document.createElement('div'); region.id = 'notification-region'; region.setAttribute('aria-live', 'polite'); region.setAttribute('aria-relevant', 'additions'); document.body.append(region); }
  region.replaceChildren();
  const toast = document.createElement('div');
  const safeTone = ['error', 'warning', 'info'].includes(tone) ? tone : 'success';
  toast.className = `studio-toast is-${safeTone}`;
  toast.setAttribute('role', safeTone === 'error' ? 'alert' : 'status');
  toast.innerHTML = `${icon(safeTone === 'error' ? 'activity' : safeTone === 'success' ? 'check' : 'info')}<span>${escapeHtml(notificationCopy(message))}</span><button type="button" class="studio-toast-dismiss" aria-label="Dismiss notification">${icon('close', 14)}</button>`;
  toast.querySelector('.studio-toast-dismiss').addEventListener('click', () => toast.remove());
  region.append(toast);
  setTimeout(() => toast.remove(), safeTone === 'error' ? 8000 : 5200);
}

function restoreDialogFocus(dialog, trigger) {
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (trigger?.isConnected) trigger.focus();
    else document.getElementById('main-content')?.focus();
  }, { once: true });
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}

export function confirmAction({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', eyebrow = 'CONFIRM ACTION', danger = false } = {}) {
  return new Promise(resolve => {
    const trigger = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'studio-dialog studio-confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', 'studio-dialog-title');
    if (message) dialog.setAttribute('aria-describedby', 'studio-dialog-description');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `<form class="studio-dialog-form"><header class="studio-dialog-header"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2 id="studio-dialog-title">${escapeHtml(title || 'Confirm this action')}</h2></div><button type="button" class="icon-btn" data-cancel aria-label="Close dialog">${icon('close')}</button></header><div class="studio-dialog-body"><p class="dialog-description" id="studio-dialog-description">${escapeHtml(message || '')}</p></div><footer class="studio-dialog-footer"><button type="button" class="btn btn-ghost" data-cancel>${escapeHtml(cancelLabel)}</button><button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${escapeHtml(confirmLabel)}</button></footer></form>`;
    let result = false;
    dialog.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); result = true; dialog.close(); });
    dialog.addEventListener('close', () => resolve(result), { once: true });
    closeOnBackdrop(dialog);
    restoreDialogFocus(dialog, trigger);
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-cancel]')?.focus();
  });
}

export function promptText({ title, message, label = 'Name', value = '', placeholder = '', submitLabel = 'Save', maxLength = 200, eyebrow = 'WORKSPACE' } = {}) {
  return new Promise(resolve => {
    const trigger = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'studio-dialog studio-prompt-dialog';
    dialog.setAttribute('aria-labelledby', 'studio-dialog-title');
    if (message) dialog.setAttribute('aria-describedby', 'studio-dialog-description');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `<form class="studio-dialog-form"><header class="studio-dialog-header"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2 id="studio-dialog-title">${escapeHtml(title || 'Enter a value')}</h2></div><button type="button" class="icon-btn" data-cancel aria-label="Close dialog">${icon('close')}</button></header><div class="studio-dialog-body">${message ? `<p class="dialog-description" id="studio-dialog-description">${escapeHtml(message)}</p>` : ''}<label class="studio-field"><span>${escapeHtml(label)}</span><input name="value" type="text" maxlength="${Math.max(1, Math.min(500, Number(maxLength) || 200))}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" required autocomplete="off"></label><p class="form-error" role="alert" hidden></p></div><footer class="studio-dialog-footer"><button type="button" class="btn btn-ghost" data-cancel>${escapeHtml('Cancel')}</button><button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}${icon('arrow', 16)}</button></footer></form>`;
    let result = null;
    dialog.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const field = dialog.querySelector('[name="value"]');
      const cleanValue = field.value.trim();
      if (!cleanValue) { showFieldError(field, 'Enter a value before continuing.'); field.focus(); return; }
      result = cleanValue;
      dialog.close();
    });
    dialog.addEventListener('close', () => resolve(result), { once: true });
    closeOnBackdrop(dialog);
    restoreDialogFocus(dialog, trigger);
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[name="value"]')?.focus();
    dialog.querySelector('[name="value"]')?.select();
  });
}

export function showFieldError(field, message) {
  if (!field) return;
  const parent = field.parentElement;
  let error = parent?.querySelector(':scope > .field-error');
  if (!error) {
    error = document.createElement('span');
    error.className = 'field-error';
    error.id = `field-error-${Math.random().toString(36).slice(2, 10)}`;
    error.setAttribute('role', 'alert');
    field.insertAdjacentElement('afterend', error);
    field.addEventListener('input', () => clearFieldError(field), { once: true });
    field.addEventListener('change', () => clearFieldError(field), { once: true });
  }
  error.textContent = message;
  field.classList.add('is-invalid');
  field.setAttribute('aria-invalid', 'true');
  const describedBy = new Set((field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  describedBy.add(error.id);
  field.setAttribute('aria-describedby', [...describedBy].join(' '));
}

export function clearFieldError(field) {
  if (!field) return;
  const error = field.parentElement?.querySelector(':scope > .field-error');
  error?.remove();
  field.classList.remove('is-invalid');
  field.removeAttribute('aria-invalid');
  const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== error?.id);
  if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
  else field.removeAttribute('aria-describedby');
}
export function openDialog({ title, eyebrow = 'WORKSPACE', body, submitLabel, onSubmit }) {
  document.querySelector('.studio-dialog')?.close();
  const trigger = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog'; dialog.setAttribute('aria-labelledby', 'studio-dialog-title');
  dialog.innerHTML = `<form class="studio-dialog-form"><header class="studio-dialog-header"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2 id="studio-dialog-title">${escapeHtml(title)}</h2></div><button type="button" class="icon-btn" data-close aria-label="Close dialog">${icon('close')}</button></header><div class="studio-dialog-body">${body}<p class="form-error" role="alert" hidden></p></div>${submitLabel ? `<footer class="studio-dialog-footer"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}${icon('arrow', 16)}</button></footer>` : ''}</form>`;
  const form = dialog.querySelector('form');
  form.noValidate = true;
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
  restoreDialogFocus(dialog, trigger);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!onSubmit) return;
    const invalidField = Array.from(form.elements).find(field => !field.checkValidity()
      || (field.required && typeof field.value === 'string' && !field.value.trim()));
    if (invalidField) {
      const whitespaceOnly = invalidField.required && typeof invalidField.value === 'string' && !invalidField.value.trim();
      showFieldError(invalidField, whitespaceOnly ? 'Enter a value before continuing.' : invalidField.validationMessage || 'Check this field and try again.');
      invalidField.focus();
      return;
    }
    const submit = dialog.querySelector('[type="submit"]'); const error = dialog.querySelector('.form-error');
    submit.disabled = true; error.hidden = true;
    try { await onSubmit(new FormData(event.target)); dialog.close(); }
    catch (failure) { error.textContent = failure.message || 'Something went wrong. Please try again.'; error.hidden = false; }
    finally { if (submit.isConnected) submit.disabled = false; }
  });
  document.body.append(dialog); dialog.showModal(); return dialog;
}
