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
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>', activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', link: '<path d="m9 15 6-6M7 13l-2 2a4 4 0 0 0 6 6l3-3M10 6l3-3a4 4 0 0 1 6 6l-2 2"/>',
};
export function icon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
}
export function notify(message, tone = 'success') {
  let region = document.getElementById('notification-region');
  if (!region) { region = document.createElement('div'); region.id = 'notification-region'; region.setAttribute('aria-live', 'polite'); document.body.append(region); }
  const toast = document.createElement('div');
  toast.className = `studio-toast ${tone === 'error' ? 'is-error' : ''}`;
  toast.innerHTML = `${icon(tone === 'error' ? 'activity' : 'check')}<span>${escapeHtml(message)}</span>`;
  region.append(toast); setTimeout(() => toast.remove(), 5000);
}
export function openDialog({ title, eyebrow = 'WORKSPACE', body, submitLabel, onSubmit }) {
  document.querySelector('.studio-dialog')?.close();
  const trigger = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog'; dialog.setAttribute('aria-labelledby', 'studio-dialog-title');
  dialog.innerHTML = `<form class="studio-dialog-form"><header class="studio-dialog-header"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2 id="studio-dialog-title">${escapeHtml(title)}</h2></div><button type="button" class="icon-btn" data-close aria-label="Close dialog">${icon('close')}</button></header><div class="studio-dialog-body">${body}<p class="form-error" role="alert" hidden></p></div>${submitLabel ? `<footer class="studio-dialog-footer"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}${icon('arrow', 16)}</button></footer>` : ''}</form>`;
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); else document.getElementById('main-content')?.focus(); });
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); if (!onSubmit) return;
    const submit = dialog.querySelector('[type="submit"]'); const error = dialog.querySelector('.form-error');
    submit.disabled = true; error.hidden = true;
    try { await onSubmit(new FormData(event.target)); dialog.close(); }
    catch (failure) { error.textContent = failure.message || 'Something went wrong. Please try again.'; error.hidden = false; }
    finally { if (submit.isConnected) submit.disabled = false; }
  });
  document.body.append(dialog); dialog.showModal(); return dialog;
}
