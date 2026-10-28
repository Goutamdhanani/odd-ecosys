// ============================================================
//  ODD-ECOSYS — Mailboxes View (Phase 6 Full Engine)
//  100% Live API · Real DNS Resolution · Real SMTP Handshakes
//  Live Test Email Transmission · Mailbox Fleet Lifecycle
// ============================================================

import { Sending, fmtNum, relTime } from './api.js';
import { confirmAction, escapeHtml, icon, notify, showFieldError } from './ui.js';
import { mountNativeWarmup } from './native-warmup.js';

let _mailboxes = [];
let _activeMailboxForTest = null;
let _activeMailboxForImap = null;
let _activeDnsModalData = null;
const mailboxModalIds = ['modal-add-mailbox', 'modal-imap-config', 'modal-test-email', 'modal-dns-sheet'];
const mailboxModalOrigins = new WeakMap();

function presentMailboxModal(modal) {
  if (!modal) return;
  if (!mailboxModalOrigins.has(modal)) {
    const placeholder = document.createComment('mailbox-modal-origin');
    modal.parentNode?.insertBefore(placeholder, modal);
    mailboxModalOrigins.set(modal, placeholder);
    document.body.append(modal);
  }
  modal.style.display = 'flex';
}

function dismissMailboxModal(modalOrId) {
  const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return;
  modal.style.display = 'none';
  const placeholder = mailboxModalOrigins.get(modal);
  if (!placeholder) return;
  if (placeholder.parentNode) {
    placeholder.parentNode.insertBefore(modal, placeholder);
    placeholder.remove();
  } else {
    modal.remove();
  }
  mailboxModalOrigins.delete(modal);
}

function dismissAllMailboxModals() {
  mailboxModalIds.forEach(dismissMailboxModal);
}

export async function renderMailboxes(container) {
  window.__closeMailboxModals?.();
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading mailbox fleet…</span></div>`;

  const data = await Sending.mailboxes();
  _mailboxes = Array.isArray(data) ? data : [];

  const eligible = _mailboxes.filter(m => m.warmup_status === 'eligible' && m.warmup_review_approved === true);
  const warming  = _mailboxes.filter(m => ['warming', 'eligible'].includes(m.warmup_status) && m.warmup_review_approved !== true);
  const paused   = _mailboxes.filter(m => m.warmup_status === 'paused');
  const retired  = _mailboxes.filter(m => m.warmup_status === 'retired');

  const totalTodaySent = _mailboxes.reduce((s, m) => s + (m.today_sent || 0), 0);
  const totalTodayReserved = _mailboxes.reduce((s, m) => s + (m.today_reserved || 0), 0);
  const totalCapacity = eligible.reduce((s, m) => s + (m.daily_limit || 0), 0);
  const capacityUsedToday = totalTodaySent + totalTodayReserved;
  const avgHealth = eligible.length > 0
    ? Math.round(eligible.reduce((s, m) => s + (m.health_score || 0), 0) / eligible.length)
    : null;

  container.innerHTML = `
  <!-- Header -->
  <div class="dash-header">
    <div>
      <h1 class="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="vertical-align:-4px">
          <rect x="2" y="4" width="20" height="16" rx="4" stroke="var(--system-blue)" stroke-width="1.8"/>
          <path d="M2 7l10 7 10-7" stroke="var(--system-blue)" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        Mailbox Fleet
      </h1>
      <div class="section-sub">
        ${eligible.length} active · ${warming.length} warming · ${paused.length} paused · ${retired.length} retired
      </div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="window.__recomputeFleetHealth()">
        ${icon('refresh', 15)} Review health
      </button>
      <button class="btn btn-ghost btn-sm" onclick="window.__checkFleetWarmup()">
        ${icon('activity', 15)} Check ramp
      </button>
      <button class="btn btn-primary btn-sm" onclick="window.__openAddMailboxModal()">
        ${icon('plus', 15)} Connect mailbox
      </button>
    </div>
  </div>

  ${paused.length > 0 ? `
  <div class="notif-banner error mb-16">
    <span>⚠️</span>
    <div>
      <strong>${paused.length} mailbox(es) paused</strong> due to health or bounce threshold. Review DNS and reputation before reactivating.
    </div>
  </div>` : ''}

  <!-- KPI Strip -->
  <div class="kpi-grid-4 mb-16">
    ${[
      { label: 'Active Mailboxes',  val: eligible.length, sub: `${totalCapacity} daily capacity`, color: 'var(--system-green)', icon: '✓' },
      { label: "Today's Sends",     val: totalTodaySent,  sub: `${totalTodayReserved} reserved · ${totalCapacity > 0 ? Math.round((capacityUsedToday/totalCapacity)*100) : 0}% of daily cap used`, color: 'var(--system-blue)', icon: '→' },
      { label: 'Average health score', val: avgHealth ?? '—', sub: avgHealth === null ? 'No active mailbox observations' : 'Derived fleet score · not inbox placement', color: 'var(--system-cyan)', icon: '◎' },
      { label: 'Warming Mailboxes', val: warming.length,  sub: 'in warmup ramp', color: 'var(--system-orange)', icon: '⏳' },
    ].map(k => `
    <div class="kpi-card" style="--accent-color:${k.color}">
      <div class="kpi-icon-wrap" style="background:${k.color}22;color:${k.color}">${k.icon}</div>
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.val}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('')}
  </div>

  <section data-native-warmup></section>

  <!-- Send capacity and calendar volume-ramp schedule -->
  <div class="glass-panel mb-16 animate-in">
    <div class="panel-header">
      <span class="panel-title">
        <span class="dot indigo"></span>
        Sending capacity & calendar schedule
      </span>
      <span class="panel-hint">Schedule progress never enables sending</span>
    </div>
    <div class="panel-body">
      ${_mailboxes.length === 0 ? `
      <div class="empty-state" style="padding:24px">
        <div class="empty-orbit">${icon('mail', 25)}</div>
        <h3>Your next conversation needs a sender.</h3>
        <p class="empty-hint">Connect your first mailbox to bring your sending accounts into focus.</p>
      </div>` : `
      <div style="display:flex;flex-direction:column;gap:12px">
        ${eligible.map(m => {
          const used = (m.today_sent || 0) + (m.today_reserved || 0);
          const usedPct = m.daily_limit > 0 ? Math.min(100, Math.round((used / m.daily_limit) * 100)) : 0;
          const barColor = m.health_score >= 80 ? 'var(--system-green)' : m.health_score >= 50 ? 'var(--system-orange)' : 'var(--system-red)';
          return `
          <div>
            <div class="progress-label">
              <span class="mono" style="font-size:0.8rem;font-weight:600;color:var(--text-primary)">
                ${m.email}
                ${m.from_name ? `<span style="color:var(--text-muted);font-weight:400;margin-left:6px">("${m.from_name}")</span>` : ''}
              </span>
              <span style="font-size:0.75rem;color:var(--text-secondary)">
                ${m.today_sent || 0} accepted + ${m.today_reserved || 0} reserved / ${m.daily_limit} daily cap (${usedPct}%) · Score: <strong style="color:${barColor}">${m.health_score}</strong>
              </span>
            </div>
            <div class="progress-track" style="height:7px">
              <div class="progress-fill" style="width:${usedPct}%;background:${barColor}"></div>
            </div>
          </div>`;
        }).join('')}
        ${warming.map(m => {
          const totalDays = Math.max(1, Number(m.warmup_schedule?.totalDays) || 35);
          const warmupDay = Math.max(1, Number(m.warmup_schedule?.day) || 0);
          const rampPct = Math.min(100, Math.round((warmupDay / totalDays) * 100));
          return `
          <div>
            <div class="progress-label">
              <span class="mono" style="font-size:0.8rem;color:var(--text-secondary)">
                ${m.email} <span class="badge-status" style="color:var(--system-orange);border-color:rgba(255,159,10,0.3);margin-left:6px">Warming</span>
              </span>
              <span style="font-size:0.75rem;color:var(--system-orange)">
                Day ${warmupDay} of ${totalDays} calendar days (${rampPct}%) · Schedule only
              </span>
            </div>
            <div class="progress-track" style="height:7px">
              <div class="progress-fill" style="width:${rampPct}%;background:var(--system-orange);opacity:0.8"></div>
            </div>
          </div>`;
        }).join('')}
      </div>`}
    </div>
  </div>

  <!-- Mailbox Fleet Grid -->
  <div class="mailbox-grid">
    ${_mailboxes.map(m => renderMailboxCard(m)).join('')}
  </div>

  <!-- Add Mailbox Modal -->
  <div id="modal-add-mailbox" class="pers-modal" style="display:none">
    <div class="pers-modal-content">
      <div class="pers-modal-header">
        <span class="pers-modal-title">Connect New Outreach Mailbox</span>
        <button onclick="window.__closeAddMailboxModal()" class="drawer-close">✕</button>
      </div>
      <div class="pers-modal-body">
        <div class="mailbox-connection-fields">
          <div>
            <label class="form-label" for="new-mb-email">Email Address *</label>
            <input id="new-mb-email" type="email" class="filter-input" placeholder="outreach@yourdomain.com" style="width:100%" oninput="window.__onEmailChange(this.value)" />
          </div>
          <div>
            <label class="form-label" for="new-mb-fromname">From Display Name</label>
            <input id="new-mb-fromname" type="text" class="filter-input" placeholder="Alex Rivers" style="width:100%" />
          </div>
        </div>

        <div class="mailbox-connection-fields">
          <div>
            <label class="form-label" for="new-mb-provider">Email Provider Preset</label>
            <select id="new-mb-provider" class="filter-select" style="width:100%" onchange="window.__onProviderPresetChange(this.value)">
              <option value="gmail">Google Workspace / Gmail</option>
              <option value="outlook">Microsoft 365 / Outlook</option>
              <option value="smtp" selected>Custom SMTP Relay</option>
              <option value="postal">Postal Server</option>
            </select>
          </div>
          <div>
            <label class="form-label" for="new-mb-limit">Daily Send Limit</label>
            <input id="new-mb-limit" type="number" class="filter-input" value="40" style="width:100%" />
          </div>
        </div>

        <div style="background:rgba(0,0,0,0.25);border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:14px;margin-bottom:16px">
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-primary);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.05em">
            SMTP Transmission Credentials (Optional for Live Sending)
          </div>
          <p style="font-size:0.72rem;line-height:1.5;color:var(--text-secondary);margin:0 0 12px">The server encrypts saved passwords at rest. Configure its private credential key before saving a password; the key is never shown in this workspace.</p>
          <div class="mailbox-connection-host-port">
            <div>
              <label class="form-label" for="new-mb-host">SMTP Host</label>
              <input id="new-mb-host" type="text" class="filter-input" placeholder="smtp.yourdomain.com" style="width:100%" />
            </div>
            <div>
              <label class="form-label" for="new-mb-port">Port</label>
              <input id="new-mb-port" type="number" class="filter-input" value="587" style="width:100%" />
            </div>
          </div>
          <div class="mailbox-connection-fields mailbox-connection-credentials">
            <div>
              <label class="form-label" for="new-mb-user">SMTP Username</label>
              <input id="new-mb-user" type="text" class="filter-input" placeholder="username or email" style="width:100%" />
            </div>
            <div>
              <label class="form-label" for="new-mb-pass">SMTP Password / App Key</label>
              <input id="new-mb-pass" type="password" class="filter-input" placeholder="••••••••••••" style="width:100%" />
            </div>
          </div>
        </div>

        <div id="add-mb-feedback" style="display:none;font-size:0.78rem;padding:8px 12px;border-radius:var(--radius-xs);margin-bottom:10px"></div>
      </div>
      <div class="pers-modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="window.__closeAddMailboxModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-save-mailbox" onclick="window.__submitSaveMailbox()">
          Connect & Verify
        </button>
      </div>
    </div>
  </div>

  <!-- IMAP receive configuration -->
  <div id="modal-imap-config" class="pers-modal" style="display:none">
    <div class="pers-modal-content">
      <div class="pers-modal-header">
        <span class="pers-modal-title" id="imap-config-title">Configure inbound mail</span>
        <button onclick="window.__dismissMailboxModal('modal-imap-config')" class="drawer-close">✕</button>
      </div>
      <div class="pers-modal-body">
        <p style="font-size:0.78rem;line-height:1.55;color:var(--text-secondary);margin:0 0 14px">IMAP passwords are encrypted with the server credential key. Connections require a valid TLS certificate; STARTTLS is mandatory when selected. Manual Inbox sync reads messages without marking them as read.</p>
        <div class="mailbox-connection-host-port">
          <div><label class="form-label" for="imap-host">IMAP Host</label><input id="imap-host" class="filter-input" placeholder="imap.yourdomain.com" style="width:100%" /></div>
          <div><label class="form-label" for="imap-port">Port</label><input id="imap-port" type="number" min="1" max="65535" class="filter-input" value="993" style="width:100%" /></div>
        </div>
        <div style="margin-bottom:10px"><label class="form-label" for="imap-mode">TLS mode</label><select id="imap-mode" class="filter-select" style="width:100%"><option value="implicit">Implicit TLS (usually 993)</option><option value="starttls">Required STARTTLS (usually 143)</option></select></div>
        <div class="mailbox-connection-fields mailbox-connection-credentials">
          <div><label class="form-label" for="imap-user">IMAP Username</label><input id="imap-user" class="filter-input" autocomplete="username" style="width:100%" /></div>
          <div><label class="form-label" for="imap-pass">IMAP Password / App Key</label><input id="imap-pass" type="password" class="filter-input" autocomplete="new-password" placeholder="Leave blank to keep the saved password" style="width:100%" /></div>
        </div>
        <div style="margin-top:10px"><label class="form-label" for="imap-aliases">Mailbox aliases</label><textarea id="imap-aliases" class="pers-textarea" rows="2" placeholder="replies@yourdomain.com, team@yourdomain.com" style="width:100%"></textarea><small style="color:var(--text-secondary)">Separate addresses with commas or new lines. Replies addressed to these aliases are matched back to this mailbox.</small></div>
        <div id="imap-config-feedback" style="display:none;font-size:0.78rem;padding:8px 12px;border-radius:var(--radius-xs);margin-top:12px" role="status"></div>
      </div>
      <div class="pers-modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="window.__dismissMailboxModal('modal-imap-config')">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-save-imap-config" onclick="window.__saveImapConfig()">Save IMAP settings</button>
      </div>
    </div>
  </div>

  <!-- Send Test Email Modal -->
  <div id="modal-test-email" class="pers-modal" style="display:none">
    <div class="pers-modal-content">
      <div class="pers-modal-header">
        <span class="pers-modal-title" id="test-email-modal-title">Send Live Test Email</span>
        <button onclick="window.__dismissMailboxModal('modal-test-email')" class="drawer-close">✕</button>
      </div>
      <div class="pers-modal-body">
        <div style="margin-bottom:12px">
          <label class="form-label">Recipient Email Address *</label>
          <input id="test-recipient-email" type="email" class="filter-input" placeholder="your-personal@email.com" style="width:100%" />
        </div>
        <div style="margin-bottom:12px">
          <label class="form-label">Subject</label>
          <input id="test-email-subject" type="text" class="filter-input" value="oddecosys — Live Delivery Test" style="width:100%" />
        </div>
        <div style="margin-bottom:12px">
          <label class="form-label">Email Body</label>
          <textarea id="test-email-body" class="pers-textarea" rows="4">Hello! This is a real test email transmitted from oddecosys Phase 6 Sending Engine.</textarea>
        </div>
        <div id="test-email-result" style="display:none;padding:10px 14px;border-radius:var(--radius-xs);font-size:0.8rem;margin-top:10px"></div>
      </div>
      <div class="pers-modal-footer">
        <button class="btn btn-ghost btn-sm" onclick="window.__dismissMailboxModal('modal-test-email')">Cancel</button>
        <button class="btn btn-primary btn-sm" id="btn-send-test-action" onclick="window.__executeSendTest()">
          🚀 Transmit Email
        </button>
      </div>
    </div>
  </div>

  <!-- DNS Details Sheet / Modal -->
  <div id="modal-dns-sheet" class="pers-modal" style="display:none">
    <div class="pers-modal-content" style="max-width:600px">
      <div class="pers-modal-header">
        <span class="pers-modal-title" id="dns-modal-title">Live DNS Security Records</span>
        <button onclick="window.__dismissMailboxModal('modal-dns-sheet')" class="drawer-close">✕</button>
      </div>
      <div class="pers-modal-body" id="dns-modal-body">
        Loading DNS records…
      </div>
    </div>
  </div>`;

  // Global window bindings
  mountNativeWarmup(container.querySelector('[data-native-warmup]'), _mailboxes);
  window.__dismissMailboxModal = dismissMailboxModal;
  window.__closeMailboxModals = dismissAllMailboxModals;

  window.__recomputeFleetHealth = async () => {
    await Sending.recomputeHealth();
    renderMailboxes(container);
  };

  window.__checkFleetWarmup = async () => {
    try {
      const res = await Sending.warmupCheck();
      notify(`Schedule checked for ${res?.checked || 0} mailbox(es). No mailbox is enabled automatically.`, 'info');
      await renderMailboxes(container);
    } catch (error) { notify(error.message || 'Could not check mailbox warmup status.', 'error'); }
  };

  window.__reviewWarmup = async (mailboxId, decision) => {
    const mailbox = _mailboxes.find(item => Number(item.id) === Number(mailboxId));
    if (!mailbox || !mailbox.can_review_warmup) {
      notify('Only a workspace owner or admin can review campaign sending access.', 'error');
      return;
    }
    const evidence = mailbox.warmup_evidence || {};
    const isApprove = decision === 'approve';
    const confirmed = await confirmAction({
      title: isApprove ? 'Allow campaigns from this mailbox?' : 'Keep campaign sending blocked?',
      message: isApprove
        ? `Evidence on file: ${evidence.outbound?.count || 0} SMTP-accepted sends, ${evidence.inbound?.count || 0} inbound mailbox records, and ${evidence.imap?.fetched || 0} messages fetched by the last successful Inbox sync. These records show mailbox activity only; they do not prove inbox placement or future delivery. Approving allows campaign use under the separate campaign safeguards.`
        : `This keeps the mailbox blocked from campaign sending. Its stored activity and review history will be retained.`,
      confirmLabel: isApprove ? 'Approve campaign use' : 'Keep blocked',
      eyebrow: 'MAILBOX SENDING REVIEW',
    });
    if (!confirmed) return;
    try {
      const result = await Sending.reviewWarmup(mailboxId, {
        decision,
        acknowledgeEvidenceLimits: isApprove,
      });
      notify(result?.decision === 'approved' ? 'Mailbox approved for campaign use.' : 'Mailbox remains blocked from campaign sending.', 'success');
      await renderMailboxes(container);
    } catch (error) {
      notify(error.message || 'Could not save the mailbox sending review.', 'error');
      await renderMailboxes(container);
    }
  };

  window.__openAddMailboxModal = () => {
    presentMailboxModal(document.getElementById('modal-add-mailbox'));
  };

  window.__closeAddMailboxModal = () => {
    dismissMailboxModal('modal-add-mailbox');
  };

  window.__onEmailChange = (val) => {
    const domain = val.includes('@') ? val.split('@')[1] : '';
    const hostEl = document.getElementById('new-mb-host');
    if (hostEl && domain && !hostEl.value) {
      hostEl.value = `smtp.${domain}`;
    }
  };

  window.__onProviderPresetChange = (prov) => {
    const hostEl = document.getElementById('new-mb-host');
    const portEl = document.getElementById('new-mb-port');
    if (prov === 'gmail') {
      if (hostEl) hostEl.value = 'smtp.gmail.com';
      if (portEl) portEl.value = '465';
    } else if (prov === 'outlook') {
      if (hostEl) hostEl.value = 'smtp.office365.com';
      if (portEl) portEl.value = '587';
    } else if (prov === 'postal') {
      if (hostEl) hostEl.value = 'postal.yourdomain.com';
      if (portEl) portEl.value = '587';
    }
  };

  window.__submitSaveMailbox = async () => {
    const email    = document.getElementById('new-mb-email')?.value?.trim();
    const fromName = document.getElementById('new-mb-fromname')?.value?.trim();
    const provider = document.getElementById('new-mb-provider')?.value;
    const limit    = document.getElementById('new-mb-limit')?.value;
    const host     = document.getElementById('new-mb-host')?.value?.trim();
    const port     = document.getElementById('new-mb-port')?.value;
    const user     = document.getElementById('new-mb-user')?.value?.trim();
    const pass     = document.getElementById('new-mb-pass')?.value;
    const feedback = document.getElementById('add-mb-feedback');

    if (!email || !email.includes('@')) {
      showFieldError(document.getElementById('new-mb-email'), 'Enter a valid mailbox email address.');
      document.getElementById('new-mb-email')?.focus();
      return;
    }

    const btn = document.getElementById('btn-save-mailbox');
    if (btn) btn.textContent = 'Saving & Verifying DNS…';

    if (btn) btn.disabled = true;
    if (feedback) { feedback.style.display = 'none'; feedback.textContent = ''; }
    try {
      const result = await Sending.addMailbox({
        email,
        from_name: fromName,
        provider,
        daily_limit: parseInt(limit) || 40,
        smtp_host: host,
        smtp_port: parseInt(port) || 587,
        smtp_user: user,
        smtp_pass: pass,
      });
      if (!result?.ok) throw new Error(result?.error || 'Mailbox could not be saved.');
      window.__closeAddMailboxModal();
      await renderMailboxes(container);
    } catch (error) {
      if (feedback) {
        feedback.textContent = error.message || 'Mailbox could not be saved.';
        feedback.style.display = 'block';
        feedback.style.color = 'var(--system-red)';
        feedback.setAttribute('role', 'alert');
      }
    } finally {
      if (btn) { btn.textContent = 'Connect & Verify'; btn.disabled = false; }
    }
  };

  window.__toggleMailboxStatus = async (id, currentStatus) => {
    if (currentStatus === 'paused') {
      await Sending.activate(id);
    } else {
      await Sending.pause(id);
    }
    renderMailboxes(container);
  };

  window.__deleteMailbox = async (id, email) => {
    if (!await confirmAction({ title: 'Delete mailbox', message: `Delete ${email}? Saved send history and mailbox attribution will remain.` , confirmLabel: 'Delete mailbox', danger: true })) return;
    try {
      await Sending.deleteMailbox(id);
      notify(`Mailbox ${email} deleted.`, 'success');
      await renderMailboxes(container);
    } catch (error) { notify(error.message || 'Could not delete this mailbox.', 'error'); }
  };

  window.__runDnsCheck = async (id, domain) => {
    const modal = document.getElementById('modal-dns-sheet');
    const body  = document.getElementById('dns-modal-body');
    const title = document.getElementById('dns-modal-title');
    presentMailboxModal(modal);
    title.textContent = `Live DNS Security — ${domain}`;
    body.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Querying DNS TXT, MX & DNSBL…</span></div>';

    const result = await Sending.verifyDns(id);
    body.innerHTML = renderDnsSheetBody(result);
    // Refresh card stats
    const updated = await Sending.mailboxes();
    _mailboxes = Array.isArray(updated) ? updated : [];
  };

  window.__testSmtpHandshake = async (id, email) => {
    try {
      const res = await Sending.testSmtp(id);
      if (res.ok) notify(res.message || 'SMTP connection test succeeded.', 'success');
      else notify(`SMTP test failed: ${res.error || res.message || 'The server did not accept the test.'}`, 'error');
    } catch (error) { notify(`SMTP test failed: ${error.message || 'The connection could not be tested.'}`, 'error'); }
  };

  window.__openImapConfig = (id, email) => {
    const mailbox = _mailboxes.find(item => Number(item.id) === Number(id));
    if (!mailbox) return;
    _activeMailboxForImap = Number(id);
    document.getElementById('imap-config-title').textContent = `Inbound mail — ${email}`;
    document.getElementById('imap-host').value = mailbox.imap_host || '';
    document.getElementById('imap-port').value = mailbox.imap_port || (mailbox.imap_secure ? 993 : 143);
    document.getElementById('imap-mode').value = mailbox.imap_secure ? 'implicit' : 'starttls';
    document.getElementById('imap-user').value = mailbox.imap_user || '';
    document.getElementById('imap-pass').value = '';
    document.getElementById('imap-aliases').value = Array.isArray(mailbox.imap_aliases) ? mailbox.imap_aliases.join(', ') : '';
    const feedback = document.getElementById('imap-config-feedback');
    feedback.style.display = 'none';
    feedback.textContent = '';
    presentMailboxModal(document.getElementById('modal-imap-config'));
  };

  window.__saveImapConfig = async () => {
    if (!_activeMailboxForImap) return;
    const host = document.getElementById('imap-host').value.trim();
    const port = Number(document.getElementById('imap-port').value);
    const user = document.getElementById('imap-user').value.trim();
    const pass = document.getElementById('imap-pass').value;
    const aliases = document.getElementById('imap-aliases').value.split(/[;,\r\n]+/).map(address => address.trim()).filter(Boolean);
    const mode = document.getElementById('imap-mode').value;
    const feedback = document.getElementById('imap-config-feedback');
    const button = document.getElementById('btn-save-imap-config');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user) {
      feedback.textContent = 'Enter a valid IMAP host, port, and username.';
      feedback.style.display = 'block';
      feedback.style.color = 'var(--system-red)';
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving securely…';
    try {
      const settings = { imap_host: host, imap_port: port, imap_user: user, imap_secure: mode === 'implicit', imap_aliases: aliases };
      if (pass) settings.imap_pass = pass;
      await Sending.updateMailbox(_activeMailboxForImap, settings);
      dismissMailboxModal('modal-imap-config');
      await renderMailboxes(container);
    } catch (error) {
      feedback.textContent = error.message || 'IMAP settings could not be saved.';
      feedback.style.display = 'block';
      feedback.style.color = 'var(--system-red)';
    } finally {
      button.disabled = false;
      button.textContent = 'Save IMAP settings';
    }
  };

  window.__testImap = async (id) => {
    try {
      const result = await Sending.testImap(id);
      notify(`IMAP verified over ${result.tlsMode === 'implicit_tls' ? 'implicit TLS' : 'required STARTTLS'} with a valid server certificate. INBOX contains ${result.messageCount} messages.`, 'success');
    } catch (error) {
      notify(`IMAP connection failed: ${error.message || 'Check the server and credentials.'}`, 'error');
    }
  };

  window.__openSendTestModal = (id, email) => {
    _activeMailboxForTest = id;
    const modal = document.getElementById('modal-test-email');
    const title = document.getElementById('test-email-modal-title');
    const resultBox = document.getElementById('test-email-result');
    if (resultBox) resultBox.style.display = 'none';
    title.textContent = `Send Test Email from ${email}`;
    presentMailboxModal(modal);
  };

  window.__executeSendTest = async () => {
    if (!_activeMailboxForTest) return;
    const recipient = document.getElementById('test-recipient-email')?.value?.trim();
    const subject   = document.getElementById('test-email-subject')?.value?.trim();
    const body      = document.getElementById('test-email-body')?.value?.trim();
    const resultBox = document.getElementById('test-email-result');
    const btn       = document.getElementById('btn-send-test-action');

    if (!recipient) {
      showFieldError(document.getElementById('test-recipient-email'), 'Enter the address that should receive this test message.');
      document.getElementById('test-recipient-email')?.focus();
      return;
    }

    if (btn) { btn.textContent = 'Transmitting…'; btn.disabled = true; }
    try {
      const res = await Sending.sendTest(_activeMailboxForTest, { toEmail: recipient, subject, body });
      if (!resultBox) return;
      resultBox.style.display = 'block';
      if (res.ok) {
        resultBox.style.background = 'rgba(48,209,88,0.15)';
        resultBox.style.border = '1px solid rgba(48,209,88,0.3)';
        resultBox.style.color = 'var(--system-green)';
        resultBox.innerHTML = `✓ Transmitted successfully!<br><span class="mono" style="font-size:0.72rem;color:var(--text-secondary)">Message-ID: ${escapeHtml(res.messageId)} (${escapeHtml(res.mode)})</span>`;
      } else {
        resultBox.style.background = 'rgba(255,69,58,0.15)';
        resultBox.style.border = '1px solid rgba(255,69,58,0.3)';
        resultBox.style.color = 'var(--system-red)';
        resultBox.textContent = `Failed: ${res.error || 'Unknown transmission error'}`;
      }
    } catch (error) {
      if (resultBox) { resultBox.style.display = 'block'; resultBox.style.color = 'var(--system-red)'; resultBox.textContent = `Test failed: ${error.message || 'The server did not return a result.'}`; }
    } finally { if (btn) { btn.textContent = '🚀 Transmit Email'; btn.disabled = false; } }
  };

  // Animate health rings after paint
  requestAnimationFrame(() => setTimeout(() => {
    container.querySelectorAll('[data-ring-score]').forEach(el => {
      const score = parseFloat(el.dataset.ringScore);
      const r = 26;
      const circ = 2 * Math.PI * r;
      const offset = circ - (score / 100) * circ;
      el.style.strokeDashoffset = offset;
    });
  }, 100));
}

function renderWarmupReview(m) {
  const schedule = m.warmup_schedule || { day: 0, totalDays: 35, rampComplete: false };
  const evidence = m.warmup_evidence || {};
  const review = m.warmup_review || { decision: 'review_required', policyCurrent: false };
  const approval = m.warmup_approval || { allowed: false, blockers: ['Review the current sender evidence before enabling campaign use.'] };
  const reviewLabel = review.decision === 'approved' && review.policyCurrent
    ? 'Owner/admin approved'
    : review.decision === 'held' && review.policyCurrent ? 'Held · sending blocked' : 'Review required · sending blocked';
  const latestOutbound = evidence.outbound?.latest?.at ? ` · latest ${escapeHtml(relTime(evidence.outbound.latest.at))}` : '';
  const latestInbound = evidence.inbound?.latest?.at ? ` · latest ${escapeHtml(relTime(evidence.inbound.latest.at))}` : '';
  const latestImap = evidence.imap?.lastSuccessAt ? escapeHtml(relTime(evidence.imap.lastSuccessAt)) : 'none recorded';
  const blockers = (approval.blockers || []).slice(0, 3);
  const controls = m.can_review_warmup
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button class="btn-xs" onclick="window.__reviewWarmup(${Number(m.id)},'hold')">Keep blocked</button>
        <button class="btn-xs" ${approval.allowed && m.warmup_status !== 'paused' ? '' : 'disabled'} onclick="window.__reviewWarmup(${Number(m.id)},'approve')">Allow campaign use</button>
      </div>`
    : '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:8px">A workspace owner or admin must review campaign access.</div>';
  return `<div class="mailbox-warmup-review" style="margin-top:12px;padding:12px;border:1px solid var(--glass-border);border-radius:var(--radius-md);background:rgba(255,255,255,0.025)">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <strong style="font-size:0.8rem">Campaign sending access</strong>
      <span class="badge-status ${review.decision === 'approved' && review.policyCurrent ? 'badge-deliverable' : 'badge-warming'}">${escapeHtml(reviewLabel)}</span>
    </div>
    <div style="font-size:0.72rem;line-height:1.55;color:var(--text-secondary);margin-top:7px">
      Calendar schedule: day ${Math.max(1, Number(schedule.day) || 0)} of ${Math.max(1, Number(schedule.totalDays) || 35)}${schedule.rampComplete ? ' · schedule complete' : ''}. Schedule time alone never unlocks sending.<br>
      SMTP-accepted sends: ${fmtNum(evidence.outbound?.count || 0)}${latestOutbound}<br>
      Saved inbound mailbox records: ${fmtNum(evidence.inbound?.count || 0)}${latestInbound}<br>
      Last successful IMAP sync: ${latestImap} · ${fmtNum(evidence.imap?.fetched || 0)} messages fetched
    </div>
    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:6px">Activity records are not proof of inbox placement or guaranteed delivery.</div>
    ${blockers.length ? `<ul style="font-size:0.7rem;line-height:1.45;color:var(--text-muted);padding-left:18px;margin:7px 0 0">${blockers.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    ${controls}
  </div>`;
}

export function renderMailboxCard(m) {
  const score = Math.round(m.health_score || 100);
  const color = score >= 80 ? 'var(--system-green)' : score >= 50 ? 'var(--system-orange)' : 'var(--system-red)';
  const r = 26;
  const circ = 2 * Math.PI * r;
  const dkimAuthenticated = m.dkim_status === 'aligned_verified';
  const dkimRejected = m.dkim_status === 'unaligned_verified';
  const dkimEvidence = dkimAuthenticated ? true : dkimRejected ? false : null;
  const domainDnsblStatus = m.domain_dnsbl_status || m.blacklist_status || 'not_checked';
  const inboxSyncSummary = !m.imap_configured
    ? 'IMAP is not configured. Add inbound IMAP settings to receive messages.'
    : m.imap_last_sync_error
      ? `Last sync attempt failed${m.imap_last_sync_attempt_at ? ` ${relTime(m.imap_last_sync_attempt_at)}` : ''}: ${escapeHtml(m.imap_last_sync_error)}${m.imap_last_sync_success_at ? ` · Last successful sync ${relTime(m.imap_last_sync_success_at)}` : ''}`
      : m.imap_last_sync_success_at
        ? `Last successful sync ${relTime(m.imap_last_sync_success_at)} · ${fmtNum(m.imap_last_sync_imported || 0)} new · ${fmtNum(m.imap_last_sync_duplicates || 0)} already recorded · ${fmtNum(m.imap_last_sync_skipped || 0)} skipped`
        : 'No Inbox sync recorded yet. Open Inbox and sync this mailbox to retrieve messages.';

  const dnsItems = [
    { label: 'SPF', ok: !!m.spf_ok },
    { label: 'DKIM', ok: dkimEvidence, title: m.dkim_status === 'signature_unverified'
      ? 'A DNS selector key was observed; outgoing message signing and alignment are not verified.'
      : 'Outgoing DKIM signature and alignment have not been verified.' },
    { label: 'DMARC', ok: !!m.dmarc_ok },
    { label: 'A-RECORD DNSBL', ok: domainDnsblStatus === 'not_listed' ? true : domainDnsblStatus === 'listed' ? false : null,
      title: `Domain A-record DNSBL: ${domainDnsblStatus}. This does not establish the SMTP relay's outbound IP reputation.` },
  ];

  const isConfigured = !!(m.smtp_host || m.smtp_user);
  const statusBadge = m.warmup_status === 'eligible' && m.warmup_review_approved === true
    ? '<span class="badge-status badge-deliverable">Campaign sending allowed</span>'
    : m.warmup_status === 'eligible'
      ? '<span class="badge-status badge-warming">Review required</span>'
    : m.warmup_status === 'warming'
      ? '<span class="badge-status badge-warming">Warming</span>'
      : m.warmup_status === 'paused'
        ? '<span class="badge-status badge-undeliverable">Paused</span>'
        : '<span class="badge-status badge-retired">Retired</span>';

  return `
  <div class="mailbox-card">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
      <div class="health-ring-wrap">
        <svg width="60" height="60" class="health-ring-svg" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="${r}" class="health-ring-bg" stroke-width="5.5"/>
          <circle cx="32" cy="32" r="${r}" class="health-ring-fg"
            stroke="${color}" stroke-width="5.5"
            stroke-dasharray="${circ.toFixed(1)}"
            stroke-dashoffset="${circ.toFixed(1)}"
            data-ring-score="${score}"
            style="transition:stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1)"
          />
          <text x="32" y="32" fill="${color}" font-size="13" font-weight="800" font-family="var(--mono)" transform="rotate(90 32 32)" text-anchor="middle" dominant-baseline="central">
            ${score}
          </text>
        </svg>
        <div>
          <div style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;font-weight:700;letter-spacing:0.04em">Health Score</div>
          <div style="font-size:0.8rem;font-weight:600;color:${color}">${score >= 80 ? 'Optimal' : score >= 50 ? 'Fair' : 'Risk'}</div>
        </div>
      </div>
      <div>
        ${statusBadge}
      </div>
    </div>

    <div class="mailbox-meta">
      <div class="mailbox-email">${m.email}</div>
      <div class="mailbox-domain">
        ${m.from_name ? `<strong>${m.from_name}</strong> · ` : ''}${m.domain} · ${m.provider || 'smtp'} · ${m.imap_configured ? 'IMAP connected' : 'IMAP not configured'}
      </div>

      <div class="mailbox-inbox-status" role="status" style="font-size:0.76rem;line-height:1.45;color:var(--text-secondary);margin-top:8px">
        <span>${inboxSyncSummary}</span>
        <a href="#inbox" class="btn-xs" style="margin-left:8px" aria-label="Open received mail for ${escapeHtml(m.email)}">View Inbox →</a>
      </div>

      ${m.warmup_status === 'eligible' || m.warmup_status === 'warming' || m.warmup_status === 'paused' ? renderWarmupReview(m) : ''}

      <div class="mailbox-dns">
        ${dnsItems.map(d => `
        <span class="dns-chip ${d.ok === true ? 'ok' : d.ok === false ? 'fail' : 'unknown'}"${d.title ? ` title="${escapeHtml(d.title)}"` : ''}>
          ${d.label} ${d.ok === true ? '✓' : d.ok === false ? '✗' : '?'}
        </span>`).join('')}
        <button class="btn-xs" style="margin-left:auto" onclick="window.__runDnsCheck(${m.id},'${m.domain}')" title="Lookup real DNS records">
          🔍 DNS Records
        </button>
      </div>
    </div>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;display:flex;flex-direction:column;gap:10px">
      <div class="credit-bar-wrap">
        <div class="credit-bar-label">
          <span>Today's Volume</span>
          <span class="mono">${m.today_sent || 0} accepted + ${m.today_reserved || 0} reserved / ${m.daily_limit || 0}</span>
        </div>
        <div class="credit-bar-track">
          <div class="credit-bar-fill" style="width:${m.daily_limit > 0 ? Math.min(100, Math.round((((m.today_sent || 0) + (m.today_reserved || 0)) / m.daily_limit) * 100)) : 0}%;background:${color}"></div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:4px">
        <div style="display:flex;gap:6px">
          <button class="btn-xs" onclick="window.__testSmtpHandshake(${m.id},'${m.email}')" title="Test SMTP connection">
            🔌 Test SMTP
          </button>
          <button class="btn-xs" onclick="window.__openImapConfig(${m.id},'${m.email}')" title="Configure encrypted inbound IMAP credentials">
            ⚙ IMAP settings
          </button>
          <button class="btn-xs" onclick="window.__testImap(${m.id})" title="Verify IMAP authentication and TLS">
            ↓ Test IMAP
          </button>
          <button class="btn-xs" onclick="window.__openSendTestModal(${m.id},'${m.email}')" title="Send a test message">
            ✉ Send Test
          </button>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-xs" style="color:${m.warmup_status === 'paused' ? 'var(--system-green)' : 'var(--system-orange)'}" onclick="window.__toggleMailboxStatus(${m.id},'${m.warmup_status}')">
            ${m.warmup_status === 'paused' ? '▶ Activate' : '⏸ Pause'}
          </button>
          <button class="btn-xs" style="color:var(--system-red)" onclick="window.__deleteMailbox(${m.id},'${m.email}')">
            ✕
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

export function renderDnsSheetBody(dnsData) {
  const domainDnsblStatus = dnsData.domain_dnsbl_status || dnsData.blacklist_status || 'not_checked';
  const domainDnsblLabels = {
    listed: ['✗ LISTED', 'var(--system-red)'],
    not_listed: ['✓ NOT LISTED', 'var(--system-green)'],
    unavailable: ['⚠ UNAVAILABLE', 'var(--system-orange)'],
    not_checked: ['— NOT CHECKED', 'var(--text-secondary)'],
    unknown: ['? UNKNOWN', 'var(--text-secondary)'],
  };
  const [domainDnsblLabel, domainDnsblColor] = domainDnsblLabels[domainDnsblStatus] || domainDnsblLabels.unknown;
  const dkimDetail = dnsData.dkim_key_status === 'published'
    ? `A valid DNS selector key was observed${dnsData.dkim_selector ? ` at “${escapeHtml(dnsData.dkim_selector)}”` : ''}; this app has not verified a captured outgoing DKIM signature or its alignment.`
    : 'No verified outgoing DKIM signature or alignment evidence is available.';
  return `
  <div style="display:flex;flex-direction:column;gap:14px">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      <div class="kpi-card" style="padding:12px">
        <div class="kpi-label">SPF Record</div>
        <div style="font-weight:700;color:${dnsData.spf_ok ? 'var(--system-green)' : 'var(--system-red)'}">
          ${dnsData.spf_ok ? '✓ PASS' : '✗ MISSING'}
        </div>
      </div>
      <div class="kpi-card" style="padding:12px">
        <div class="kpi-label">DKIM Status</div>
        <div aria-label="DKIM signature and alignment unverified" style="font-weight:700;color:var(--system-orange)">
          ⏳ SIGNATURE / ALIGNMENT UNVERIFIED
        </div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;line-height:1.5">${dkimDetail}</div>
      </div>
      <div class="kpi-card" style="padding:12px">
        <div class="kpi-label">DMARC Policy</div>
        <div style="font-weight:700;color:${dnsData.dmarc_ok ? 'var(--system-green)' : 'var(--system-red)'}">
          ${dnsData.dmarc_ok ? '✓ PASS' : '✗ MISSING'}
        </div>
      </div>
      <div class="kpi-card" style="padding:12px">
        <div class="kpi-label">Domain A-record DNSBL</div>
        <div style="font-weight:700;color:${domainDnsblColor}">
          ${domainDnsblLabel}
        </div>
      </div>
    </div>

    <div role="note" style="padding:12px 14px;border:1px solid rgba(255,190,80,0.25);border-radius:var(--radius-sm);background:rgba(255,190,80,0.06);color:var(--text-secondary);font-size:0.78rem;line-height:1.5">
      <strong style="color:var(--system-orange)">SMTP sender-IP reputation: UNKNOWN.</strong>
      The configured relay's actual outbound IP was not observed. The DNSBL checks below query only the listed domain A-record address${(dnsData.domain_a_records || []).length === 1 ? '' : 'es'} and do not establish whether the mailbox's sending IP is listed.
    </div>

    ${(dnsData.domain_a_records || []).length ? `
    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);padding:10px 14px;border-radius:var(--radius-sm)">
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase">Queried domain IPv4 addresses</div>
      <div class="mono" style="font-size:0.78rem;color:var(--system-cyan);word-break:break-all;margin-top:4px">${dnsData.domain_a_records.map(ip => escapeHtml(ip)).join(', ')}${dnsData.domain_a_records_truncated ? ` (${Number(dnsData.dnsbl_unchecked_domain_ip_count) || 'additional'} additional addresses not checked)` : ''}</div>
    </div>` : ''}

    ${(dnsData.dnsbl_checks || []).length ? `
    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);padding:10px 14px;border-radius:var(--radius-sm)">
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:8px">Observed DNSBL responses</div>
      ${(dnsData.dnsbl_checks || []).map(check => {
        const outcomeLabel = check.outcome === 'listed' ? 'LISTED' : check.outcome === 'not_listed' ? 'NOT LISTED' : check.outcome === 'unavailable' ? 'UNAVAILABLE' : 'NOT CHECKED';
        const outcomeColor = check.outcome === 'listed' ? 'var(--system-red)' : check.outcome === 'not_listed' ? 'var(--system-green)' : 'var(--system-orange)';
        const detail = check.response_codes?.length ? `Response: ${check.response_codes.map(code => escapeHtml(code)).join(', ')}` : check.error ? `Reason: ${escapeHtml(check.error)}` : '';
        return `<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;font-size:0.76rem;margin-bottom:7px">
          <span><span class="mono">${escapeHtml(check.checked_ip || '')}</span> · <span class="mono">${escapeHtml(check.blocklist || '')}</span>${detail ? `<br><span style="font-size:0.68rem;color:var(--text-muted)">${detail}</span>` : ''}</span>
          <strong style="white-space:nowrap;color:${outcomeColor}">${outcomeLabel}</strong>
        </div>`;
      }).join('')}
    </div>` : ''}

    ${dnsData.spf_record ? `
    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);padding:10px 14px;border-radius:var(--radius-sm)">
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase">Resolved SPF TXT</div>
      <div class="mono" style="font-size:0.78rem;color:var(--system-cyan);word-break:break-all;margin-top:4px">${dnsData.spf_record}</div>
    </div>` : ''}

    ${dnsData.dmarc_record ? `
    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);padding:10px 14px;border-radius:var(--radius-sm)">
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase">Resolved DMARC TXT (_dmarc.${dnsData.domain})</div>
      <div class="mono" style="font-size:0.78rem;color:var(--system-cyan);word-break:break-all;margin-top:4px">${dnsData.dmarc_record}</div>
    </div>` : ''}

    ${dnsData.mx_records?.length ? `
    <div style="background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);padding:10px 14px;border-radius:var(--radius-sm)">
      <div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">Active Mail Exchange (MX) Servers</div>
      ${dnsData.mx_records.map(mx => `
      <div style="display:flex;justify-content:space-between;font-size:0.76rem;margin-bottom:3px">
        <span class="mono" style="color:var(--text-primary)">${mx.exchange}</span>
        <span class="mono" style="color:var(--text-muted)">Priority: ${mx.priority}</span>
      </div>`).join('')}
    </div>` : ''}
  </div>`;
}
