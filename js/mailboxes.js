// ============================================================
//  ODD-ECOSYS — Mailboxes View (Phase 6 Full Engine)
//  100% Live API · Real DNS Resolution · Real SMTP Handshakes
//  Live Test Email Transmission · Mailbox Fleet Lifecycle
// ============================================================

import { Sending, fmtNum, relTime } from './api.js';
import { icon } from './ui.js';

let _mailboxes = [];
let _activeMailboxForTest = null;
let _activeDnsModalData = null;

export async function renderMailboxes(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading mailbox fleet…</span></div>`;

  const data = await Sending.mailboxes();
  _mailboxes = Array.isArray(data) ? data : [];

  const eligible = _mailboxes.filter(m => m.warmup_status === 'eligible');
  const warming  = _mailboxes.filter(m => m.warmup_status === 'warming');
  const paused   = _mailboxes.filter(m => m.warmup_status === 'paused');
  const retired  = _mailboxes.filter(m => m.warmup_status === 'retired');

  const totalTodaySent = _mailboxes.reduce((s, m) => s + (m.today_sent || 0), 0);
  const totalCapacity = eligible.reduce((s, m) => s + (m.daily_limit || 0), 0);
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
      { label: "Today's Sends",     val: totalTodaySent,  sub: `${totalCapacity > 0 ? Math.round((totalTodaySent/totalCapacity)*100) : 0}% capacity used`, color: 'var(--system-blue)', icon: '→' },
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

  <!-- Send Credit & Warmup Allocation Panel -->
  <div class="glass-panel mb-16 animate-in">
    <div class="panel-header">
      <span class="panel-title">
        <span class="dot indigo"></span>
        Sending capacity & volume ramp
      </span>
      <span class="panel-hint">Configured sender limits · calendar ramp</span>
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
          const usedPct = m.daily_limit > 0 ? Math.min(100, Math.round(((m.today_sent || 0) / m.daily_limit) * 100)) : 0;
          const barColor = m.health_score >= 80 ? 'var(--system-green)' : m.health_score >= 50 ? 'var(--system-orange)' : 'var(--system-red)';
          return `
          <div>
            <div class="progress-label">
              <span class="mono" style="font-size:0.8rem;font-weight:600;color:var(--text-primary)">
                ${m.email}
                ${m.from_name ? `<span style="color:var(--text-muted);font-weight:400;margin-left:6px">("${m.from_name}")</span>` : ''}
              </span>
              <span style="font-size:0.75rem;color:var(--text-secondary)">
                ${m.today_sent || 0} / ${m.daily_limit} sent (${usedPct}%) · Score: <strong style="color:${barColor}">${m.health_score}</strong>
              </span>
            </div>
            <div class="progress-track" style="height:7px">
              <div class="progress-fill" style="width:${usedPct}%;background:${barColor}"></div>
            </div>
          </div>`;
        }).join('')}
        ${warming.map(m => {
          const warmupDay = m.warmup_started_at
            ? Math.max(1, Math.floor((Date.now() - new Date(m.warmup_started_at).getTime()) / 86400000))
            : 1;
          const rampPct = Math.min(100, Math.round((warmupDay / 35) * 100));
          return `
          <div>
            <div class="progress-label">
              <span class="mono" style="font-size:0.8rem;color:var(--text-secondary)">
                ${m.email} <span class="badge-status" style="color:var(--system-orange);border-color:rgba(255,159,10,0.3);margin-left:6px">Warming</span>
              </span>
              <span style="font-size:0.75rem;color:var(--system-orange)">
                Day ${warmupDay} of 35 (${rampPct}%) · Limit: ${m.daily_limit || 0}/day
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
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div>
            <label class="form-label">Email Address *</label>
            <input id="new-mb-email" type="email" class="filter-input" placeholder="outreach@yourdomain.com" style="width:100%" oninput="window.__onEmailChange(this.value)" />
          </div>
          <div>
            <label class="form-label">From Display Name</label>
            <input id="new-mb-fromname" type="text" class="filter-input" placeholder="Alex Rivers" style="width:100%" />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div>
            <label class="form-label">Email Provider Preset</label>
            <select id="new-mb-provider" class="filter-select" style="width:100%" onchange="window.__onProviderPresetChange(this.value)">
              <option value="gmail">Google Workspace / Gmail</option>
              <option value="outlook">Microsoft 365 / Outlook</option>
              <option value="smtp" selected>Custom SMTP Relay</option>
              <option value="postal">Postal Server</option>
            </select>
          </div>
          <div>
            <label class="form-label">Daily Send Limit</label>
            <input id="new-mb-limit" type="number" class="filter-input" value="40" style="width:100%" />
          </div>
        </div>

        <div style="background:rgba(0,0,0,0.25);border:1px solid var(--glass-border);border-radius:var(--radius-md);padding:14px;margin-bottom:16px">
          <div style="font-size:0.75rem;font-weight:700;color:var(--text-primary);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.05em">
            SMTP Transmission Credentials (Optional for Live Sending)
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:10px">
            <div>
              <label class="form-label">SMTP Host</label>
              <input id="new-mb-host" type="text" class="filter-input" placeholder="smtp.yourdomain.com" style="width:100%" />
            </div>
            <div>
              <label class="form-label">Port</label>
              <input id="new-mb-port" type="number" class="filter-input" value="587" style="width:100%" />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label class="form-label">SMTP Username</label>
              <input id="new-mb-user" type="text" class="filter-input" placeholder="username or email" style="width:100%" />
            </div>
            <div>
              <label class="form-label">SMTP Password / App Key</label>
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

  <!-- Send Test Email Modal -->
  <div id="modal-test-email" class="pers-modal" style="display:none">
    <div class="pers-modal-content">
      <div class="pers-modal-header">
        <span class="pers-modal-title" id="test-email-modal-title">Send Live Test Email</span>
        <button onclick="document.getElementById('modal-test-email').style.display='none'" class="drawer-close">✕</button>
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
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('modal-test-email').style.display='none'">Cancel</button>
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
        <button onclick="document.getElementById('modal-dns-sheet').style.display='none'" class="drawer-close">✕</button>
      </div>
      <div class="pers-modal-body" id="dns-modal-body">
        Loading DNS records…
      </div>
    </div>
  </div>`;

  // Global window bindings
  window.__recomputeFleetHealth = async () => {
    await Sending.recomputeHealth();
    renderMailboxes(container);
  };

  window.__checkFleetWarmup = async () => {
    const res = await Sending.warmupCheck();
    if (res?.transitioned?.length > 0) {
      alert(`🎉 ${res.transitioned.length} mailbox(es) reached target warmup and are now eligible!`);
    } else {
      alert('Warmup check complete. All mailboxes running on schedule.');
    }
    renderMailboxes(container);
  };

  window.__openAddMailboxModal = () => {
    document.getElementById('modal-add-mailbox').style.display = 'flex';
  };

  window.__closeAddMailboxModal = () => {
    document.getElementById('modal-add-mailbox').style.display = 'none';
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
      alert('Please enter a valid email address.');
      return;
    }

    const btn = document.getElementById('btn-save-mailbox');
    if (btn) btn.textContent = 'Saving & Verifying DNS…';

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

    if (btn) btn.textContent = 'Connect & Verify';
    window.__closeAddMailboxModal();
    renderMailboxes(container);
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
    if (!confirm(`Delete mailbox ${email}?`)) return;
    await Sending.deleteMailbox(id);
    renderMailboxes(container);
  };

  window.__runDnsCheck = async (id, domain) => {
    const modal = document.getElementById('modal-dns-sheet');
    const body  = document.getElementById('dns-modal-body');
    const title = document.getElementById('dns-modal-title');
    modal.style.display = 'flex';
    title.textContent = `Live DNS Security — ${domain}`;
    body.innerHTML = '<div class="loading-state"><div class="spinner"></div><span>Querying DNS TXT, MX & DNSBL…</span></div>';

    const result = await Sending.verifyDns(id);
    body.innerHTML = renderDnsSheetBody(result);
    // Refresh card stats
    const updated = await Sending.mailboxes();
    _mailboxes = Array.isArray(updated) ? updated : [];
  };

  window.__testSmtpHandshake = async (id, email) => {
    const res = await Sending.testSmtp(id);
    if (res.ok) {
      alert(`✅ ${res.message}`);
    } else {
      alert(`❌ SMTP Test Failed:\n${res.error || res.message}`);
    }
  };

  window.__openSendTestModal = (id, email) => {
    _activeMailboxForTest = id;
    const modal = document.getElementById('modal-test-email');
    const title = document.getElementById('test-email-modal-title');
    const resultBox = document.getElementById('test-email-result');
    if (resultBox) resultBox.style.display = 'none';
    title.textContent = `Send Test Email from ${email}`;
    modal.style.display = 'flex';
  };

  window.__executeSendTest = async () => {
    if (!_activeMailboxForTest) return;
    const recipient = document.getElementById('test-recipient-email')?.value?.trim();
    const subject   = document.getElementById('test-email-subject')?.value?.trim();
    const body      = document.getElementById('test-email-body')?.value?.trim();
    const resultBox = document.getElementById('test-email-result');
    const btn       = document.getElementById('btn-send-test-action');

    if (!recipient) {
      alert('Please enter a recipient email address.');
      return;
    }

    if (btn) btn.textContent = 'Transmitting…';
    const res = await Sending.sendTest(_activeMailboxForTest, {
      toEmail: recipient,
      subject,
      body,
    });

    if (btn) btn.textContent = '🚀 Transmit Email';

    if (resultBox) {
      resultBox.style.display = 'block';
      if (res.ok) {
        resultBox.style.background = 'rgba(48,209,88,0.15)';
        resultBox.style.border = '1px solid rgba(48,209,88,0.3)';
        resultBox.style.color = 'var(--system-green)';
        resultBox.innerHTML = `✓ Transmitted successfully!<br><span class="mono" style="font-size:0.72rem;color:var(--text-secondary)">Message-ID: ${res.messageId} (${res.mode})</span>`;
      } else {
        resultBox.style.background = 'rgba(255,69,58,0.15)';
        resultBox.style.border = '1px solid rgba(255,69,58,0.3)';
        resultBox.style.color = 'var(--system-red)';
        resultBox.textContent = `Failed: ${res.error || 'Unknown transmission error'}`;
      }
    }
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

function renderMailboxCard(m) {
  const score = Math.round(m.health_score || 100);
  const color = score >= 80 ? 'var(--system-green)' : score >= 50 ? 'var(--system-orange)' : 'var(--system-red)';
  const r = 26;
  const circ = 2 * Math.PI * r;

  const dnsItems = [
    { label: 'SPF', ok: !!m.spf_ok },
    { label: 'DKIM', ok: !!m.dkim_ok },
    { label: 'DMARC', ok: !!m.dmarc_ok },
  ];
  if (m.blacklisted) {
    dnsItems.push({ label: 'BLACKLISTED', ok: false });
  }

  const isConfigured = !!(m.smtp_host || m.smtp_user);
  const statusBadge = m.warmup_status === 'eligible'
    ? '<span class="badge-status badge-deliverable">Eligible</span>'
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
        ${m.from_name ? `<strong>${m.from_name}</strong> · ` : ''}${m.domain} · ${m.provider || 'smtp'}
      </div>

      <div class="mailbox-dns">
        ${dnsItems.map(d => `
        <span class="dns-chip ${d.ok ? 'ok' : 'fail'}">
          ${d.label} ${d.ok ? '✓' : '✗'}
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
          <span class="mono">${m.today_sent || 0} / ${m.daily_limit || 0} sent</span>
        </div>
        <div class="credit-bar-track">
          <div class="credit-bar-fill" style="width:${m.daily_limit > 0 ? Math.min(100, Math.round(((m.today_sent || 0) / m.daily_limit) * 100)) : 0}%;background:${color}"></div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:4px">
        <div style="display:flex;gap:6px">
          <button class="btn-xs" onclick="window.__testSmtpHandshake(${m.id},'${m.email}')" title="Test SMTP connection">
            🔌 Test SMTP
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

function renderDnsSheetBody(dnsData) {
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
        <div style="font-weight:700;color:${dnsData.dkim_ok ? 'var(--system-green)' : 'var(--system-orange)'}">
          ${dnsData.dkim_ok ? '✓ ALIGNED' : '⏳ UNCONFIRMED'}
        </div>
      </div>
      <div class="kpi-card" style="padding:12px">
        <div class="kpi-label">DMARC Policy</div>
        <div style="font-weight:700;color:${dnsData.dmarc_ok ? 'var(--system-green)' : 'var(--system-red)'}">
          ${dnsData.dmarc_ok ? '✓ PASS' : '✗ MISSING'}
        </div>
      </div>
      <div class="kpi-card" style="padding:12px">
        <div class="kpi-label">DNSBL Blacklist</div>
        <div style="font-weight:700;color:${dnsData.blacklisted ? 'var(--system-red)' : 'var(--system-green)'}">
          ${dnsData.blacklisted ? '✗ LISTED' : '✓ CLEAN'}
        </div>
      </div>
    </div>

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
