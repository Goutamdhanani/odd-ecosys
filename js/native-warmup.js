import { Sending } from './api.js';
import { escapeHtml } from './ui.js';

const e = escapeHtml;
const utc = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not checked';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
function messageFor(error) {
  try { const detail = JSON.parse(error.message.slice(error.message.indexOf(' — ') + 3)); if (typeof detail.error === 'string') return detail.error; } catch {}
  return 'The connection could not be checked. Your saved observations are retained; try again.';
}

export function mountNativeWarmup(root, mailboxes) {
  if (!root) return;
  root.innerHTML = `<div class="glass-panel mb-16">
    <div class="panel-header"><span class="panel-title">Warm-up activity · Warmbly</span><span class="panel-hint">Recorded activity, separate from the calendar ramp</span></div>
    <div class="panel-body">
      <p>Connect the same mailbox in your Warmbly console, then link it here to see its recorded activity. Warmbly runs the warm-up worker.</p>
      ${mailboxes.length ? `<label class="form-label" for="native-warmup-mailbox">Mailbox</label><select class="filter-select" id="native-warmup-mailbox" style="max-width:100%;width:100%">${mailboxes.map(m => `<option value="${Number(m.id)}">${e(m.email)}</option>`).join('')}</select>
      <div data-native-content aria-live="polite" style="margin-top:16px"></div>` : '<p>Connect a mailbox first.</p>'}
      <p class="panel-hint" style="margin-top:12px">Recorded sends and replies do not prove inbox placement or approve campaign sending. This connection only reads activity; manage the native worker in Warmbly.</p>
    </div></div>`;
  const select = root.querySelector('select');
  const content = root.querySelector('[data-native-content]');
  if (!select) return;
  let generation = 0;
  function display(data, message = '') {
    const obs = data.observation;
    content.innerHTML = `
      ${!data.configured ? '<p role="status">Warmbly is not connected to this app. The server operator must configure its private connection; no activity is available yet.</p>' : ''}
      ${data.requires_relink ? '<p role="status">The mailbox address or Warmbly server changed. Verify and link the account again before refreshing.</p>' : ''}
      ${data.can_manage ? `<form data-link-form style="margin:12px 0">
        <label class="form-label" for="native-warmup-account">Warmbly mailbox account ID</label>
        <input id="native-warmup-account" name="account" class="filter-input" autocomplete="off" spellcheck="false" required value="${e(data.account_id || '')}" placeholder="Copy the mailbox UUID from Warmbly" style="width:100%" ${data.configured ? '' : 'disabled'}>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
          <button type="submit" class="btn btn-primary btn-sm" ${data.configured ? '' : 'disabled'}>Verify & link account</button>
          <button type="button" data-native-refresh class="btn btn-ghost btn-sm" ${data.configured && data.linked && !data.requires_relink ? '' : 'disabled'}>Refresh activity</button>
          ${data.linked ? '<button type="button" data-native-unlink class="btn btn-ghost btn-sm">Unlink from this app</button>' : ''}
        </div></form>` : '<p>Ask the workspace owner or admin to link or refresh this account.</p>'}
      <p data-native-feedback role="status">${e(message || data.error || (!data.linked ? 'No account linked. Activity is unknown.' : !obs ? 'Account linked. Refresh to load recorded activity.' : ''))}</p>
      ${obs ? `<div data-native-observation>
        <p><strong>${obs.stale ? 'Last saved observation · stale' : 'Last saved observation'}</strong> · ${e(utc(obs.observed_at))}</p>
        <p>Native worker: <strong>${e(obs.account?.state || 'unknown')}</strong> · ${e(obs.from)} to ${e(obs.to)} (UTC)</p>
        <div class="kpi-grid-4">
          ${[['Sent', obs.summary?.total_sent], ['Received', obs.summary?.total_received], ['Replies', obs.summary?.total_replied], ['Days active', obs.summary?.days_active]].map(([label, value]) => `<div class="kpi-card"><div class="kpi-label">${label} · Warmbly records</div><div class="kpi-value">${count(value)}</div></div>`).join('')}
        </div>
        <p class="panel-hint">— means the native server did not provide that value.</p>
        ${obs.daily_stats?.length ? `<div style="overflow-x:auto"><table class="data-table" style="width:100%"><caption>Daily warm-up activity from Warmbly</caption><thead><tr><th scope="col">UTC day</th><th scope="col">Sent</th><th scope="col">Received</th><th scope="col">Replies</th><th scope="col">Planned volume</th></tr></thead><tbody>${obs.daily_stats.map(day => `<tr><th scope="row">${e(day.date)}</th><td>${count(day.emails_sent)}</td><td>${count(day.emails_received)}</td><td>${count(day.emails_replied)}</td><td>${count(day.target_volume)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No daily records returned for this period.</p>'}
      </div>` : '<p data-native-empty>No recorded warm-up activity has been loaded. Counts are unknown.</p>'}`;
    const form = content.querySelector('[data-link-form]');
    form?.addEventListener('submit', event => {
      event.preventDefault(); const uuid = new FormData(form).get('account').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) { content.querySelector('[data-native-feedback]').textContent = 'Copy the mailbox UUID from Warmbly, including its hyphens.'; return; }
      void action(id => Sending.linkNativeWarmup(id, uuid), 'Account verified and linked. Refresh to load its activity.');
    });
    content.querySelector('[data-native-refresh]')?.addEventListener('click', () => void action(id => Sending.refreshNativeWarmup(id), 'Activity refreshed from Warmbly.'));
    content.querySelector('[data-native-unlink]')?.addEventListener('click', () => void action(id => Sending.unlinkNativeWarmup(id), 'Unlinked from this app. Saved observations are retained; the native worker was not changed.'));
  }
  async function action(operation, message) {
    const request = ++generation; const id = select.value;
    content.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
    content.setAttribute('aria-busy', 'true');
    content.querySelector('[data-native-feedback]').textContent = 'Checking…';
    try {
      const result = await operation(id);
      if (request === generation && root.isConnected) display(result, message);
    } catch (error) {
      try {
        const result = await Sending.nativeWarmup(id);
        if (request === generation && root.isConnected) display(result, messageFor(error));
      } catch {
        if (request === generation && root.isConnected) { display({ configured: false, can_manage: false }, messageFor(error)); }
      }
    } finally { if (request === generation) content.removeAttribute('aria-busy'); }
  }
  async function load() {
    const request = ++generation;
    content.textContent = 'Loading saved warm-up activity…';
    try {
      const result = await Sending.nativeWarmup(select.value);
      if (request === generation && root.isConnected) display(result);
    } catch (error) {
      if (request === generation && root.isConnected) content.textContent = `Could not load warm-up activity: ${error.message}`;
    }
  }
  select.addEventListener('change', () => void load());
  void load();
}
