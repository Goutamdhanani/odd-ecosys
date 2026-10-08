// ============================================================
//  Campaigns + A/B Testing View — 100% live API
// ============================================================
import { Campaigns, Sending, fmtNum, relTime } from './api.js';
import { icon } from './ui.js';

let _selectedCampaign = null;

export async function renderCampaigns(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading campaigns…</span></div>`;

  const [campaigns, sendStats] = await Promise.all([
    Campaigns.list(),
    Sending.stats(),
  ]);

  const list = campaigns || [];

  container.innerHTML = `
  <div class="section-header mb-16">
    <div>
      <h1 class="section-title">Messages with a destination.</h1>
      <div class="section-sub">${list.length} campaigns · shape your outreach and learn which messages connect.</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-ghost btn-sm" onclick="window.__abAutoPromote()">${icon('chart', 15)} Review winners</button>
      <button class="btn btn-primary btn-sm" onclick="window.__campaignCreate()">${icon('plus', 15)} New campaign</button>
    </div>
  </div>

  <!-- Send Engine Stats -->
  <div class="kpi-grid-4 mb-16">
    ${[
      { label: 'Total Sent',   val: fmtNum(sendStats?.sent || 0),      color: '#6366f1' },
      { label: 'Scheduled',   val: fmtNum(sendStats?.scheduled || 0), color: '#f59e0b' },
      { label: "Today's Sends",val: fmtNum(sendStats?.today_sent || 0),color: '#10b981' },
      { label: 'Failed',      val: fmtNum(sendStats?.failed || 0),    color: '#f43f5e' },
    ].map(k => `
    <div class="kpi-card" style="--accent-color:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.val}</div>
    </div>`).join('')}
  </div>

  <!-- Create form (hidden) -->
  <div id="campaign-create-form" class="glass-panel mb-16" style="display:none">
    <div class="panel-header"><span class="panel-title">Create Campaign</span></div>
    <div class="panel-body">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label class="form-label">Campaign Name</label>
          <input id="new-camp-name" class="filter-input" placeholder="No-Website Pitch v3" style="width:260px" />
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__campaignSubmit()">Create</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('campaign-create-form').style.display='none'">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Campaign cards -->
  <div id="campaign-list" class="campaign-list">
    ${list.length === 0 ? `
    <div class="glass-panel">
      <div class="panel-body empty-state">
        <div class="empty-orbit">${icon('send', 25)}</div>
        <h3>A conversation waiting to happen.</h3>
        <p class="empty-hint">Create your first campaign, then prepare the people and messages behind it.</p>
      </div>
    </div>` : list.map(c => renderCampaignCard(c)).join('')}
  </div>

  <!-- A/B Detail Panel (hidden) -->
  <div id="ab-detail" class="glass-panel mt-16" style="display:none">
    <div class="panel-header">
      <span id="ab-detail-title" class="panel-title"></span>
      <button onclick="document.getElementById('ab-detail').style.display='none'" style="background:none;border:none;color:var(--text-muted);cursor:pointer">✕</button>
    </div>
    <div id="ab-detail-body" class="panel-body">Loading…</div>
  </div>`;

  // Wire
  window.__campaignCreate = () => {
    document.getElementById('campaign-create-form').style.display = '';
  };
  window.__campaignSubmit = async () => {
    const name = document.getElementById('new-camp-name')?.value?.trim();
    if (!name) return;
    await Campaigns.create({ name });
    document.getElementById('campaign-create-form').style.display = 'none';
    renderCampaigns(container);
  };
  window.__abAutoPromote = async () => {
    const result = await Campaigns.autoPromote();
    const count = result?.promoted?.length || 0;
    alert(count > 0 ? `Promoted ${count} winner(s)!` : 'No winners ready yet — need more data.');
    renderCampaigns(container);
  };
  window.__viewAB = async (id, name) => {
    const panel = document.getElementById('ab-detail');
    const body  = document.getElementById('ab-detail-body');
    const title = document.getElementById('ab-detail-title');
    panel.style.display = '';
    title.textContent = `A/B Analysis — ${name}`;
    body.innerHTML = '<div class="loading-state" style="padding:20px"><div class="spinner"></div></div>';
    panel.scrollIntoView({ behavior: 'smooth' });

    const [variants, timeline] = await Promise.all([
      Campaigns.variants(id),
      Campaigns.timeline(id, 14),
    ]);
    body.innerHTML = renderABPanel(variants, timeline);
  };
  window.__queueSends = async (id) => {
    const limit = prompt('How many leads to queue?', '50');
    if (!limit) return;
    const result = await Sending.queueSends(id, { limit: parseInt(limit) });
    if (result) alert(`Queued: ${result.queued} · Skipped: ${result.skipped}`);
    renderCampaigns(container);
  };
  window.__processSends = async () => {
    await Sending.process();
    alert('Send queue processing started');
  };
}

function renderCampaignCard(c) {
  const sent = c.sent || 0;
  const openRate  = sent > 0 ? ((c.opened  || 0) / sent * 100).toFixed(1) : '—';
  const replyRate = sent > 0 ? ((c.replied || 0) / sent * 100).toFixed(1) : '—';
  const bounceRate= sent > 0 ? ((c.bounced || 0) / sent * 100).toFixed(1) : '—';

  const statusColor = c.status === 'active' ? 'var(--emerald)' : c.status === 'draft' ? 'var(--amber)' : 'var(--text-muted)';
  const hasWinner = c.winner;

  return `
  <div class="glass-panel mb-14 animate-in campaign-card">
    <div class="campaign-card-header">
      <div>
        <div class="campaign-name">${c.name}</div>
        <div class="campaign-meta">Step ${c.sequence_step} · ${fmtNum(c.total || 0)} leads scheduled</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${hasWinner ? `<span class="winner-chip">🏆 Variant ${c.winner} wins</span>` : ''}
        <span class="status-badge" style="color:${statusColor};border-color:${statusColor}44">${c.status || 'draft'}</span>
      </div>
    </div>

    <!-- Metrics row -->
    <div class="campaign-metrics">
      ${[
        { label: 'Sent',     val: fmtNum(sent),           color: 'var(--indigo-light)' },
        { label: 'Open %',   val: openRate + (openRate !== '—' ? '%' : ''), color: 'var(--sky)' },
        { label: 'Reply %',  val: replyRate + (replyRate !== '—' ? '%' : ''), color: 'var(--emerald)' },
        { label: 'Bounce %', val: bounceRate + (bounceRate !== '—' ? '%' : ''), color: 'var(--rose)' },
      ].map(m => `
      <div class="camp-metric">
        <div class="camp-metric-val" style="color:${m.color}">${m.val}</div>
        <div class="camp-metric-label">${m.label}</div>
      </div>`).join('')}
    </div>

    <!-- Variant pills -->
    ${c.variants?.length > 0 ? `
    <div class="campaign-variants">
      ${c.variants.map(v => `
      <div class="variant-pill ${v.declared_winner ? 'winner' : ''}">
        <span class="variant-label">Var ${v.variant}</span>
        <span class="variant-rate">${v.sent > 0 ? (v.reply_rate * 100).toFixed(1) + '% reply' : 'no data'}</span>
        ${v.declared_winner ? '<span class="winner-star">★</span>' : ''}
        ${v.significance ? `<span class="confidence-badge">${(v.significance * 100).toFixed(0)}% conf.</span>` : ''}
      </div>`).join('')}
    </div>` : `<div style="font-size:0.72rem;color:var(--text-muted);padding:8px 0">No A/B data yet — queue sends to generate variant data</div>`}

    <!-- Actions -->
    <div class="campaign-actions">
      <button class="btn btn-ghost btn-sm" onclick="window.__viewAB(${c.id},'${c.name.replace(/'/g,"\\'")}')">📊 A/B Analysis</button>
      <button class="btn btn-ghost btn-sm" onclick="window.__queueSends(${c.id})">→ Queue Sends</button>
      <button class="btn btn-ghost btn-sm" onclick="window.__processSends()">▶ Process Queue</button>
    </div>
  </div>`;
}

function renderABPanel(variantData, timeline) {
  const variants = variantData?.variants || [];
  const comparisons = variantData?.comparisons || [];
  const winner = variantData?.winner;

  if (variants.length === 0) {
    return `<div class="empty-state" style="padding:24px">
      <p>No variant data yet — queue and send emails to start A/B testing</p>
    </div>`;
  }

  return `
  <!-- Variant comparison table -->
  <div class="ab-variants-grid">
    ${variants.map(v => {
      const color = v.variant === 'A' ? 'var(--indigo-light)' : 'var(--violet)';
      return `
      <div class="ab-variant-card ${v.declared_winner ? 'winner' : ''}">
        <div class="ab-variant-header">
          <span class="ab-variant-name" style="color:${color}">Variant ${v.variant}</span>
          ${v.declared_winner ? '<span class="ab-winner-badge">🏆 Winner</span>' : ''}
        </div>
        <div class="ab-stats-grid">
          ${[
            { label: 'Sent',     val: fmtNum(v.sent) },
            { label: 'Opened',   val: fmtNum(v.opened) },
            { label: 'Replied',  val: fmtNum(v.replied) },
            { label: 'Positive', val: fmtNum(v.positive) },
            { label: 'Open %',   val: v.sent > 0 ? (v.open_rate * 100).toFixed(1) + '%' : '—' },
            { label: 'Reply %',  val: v.sent > 0 ? (v.reply_rate * 100).toFixed(1) + '%' : '—' },
          ].map(s => `
          <div class="ab-stat">
            <div class="ab-stat-val">${s.val}</div>
            <div class="ab-stat-label">${s.label}</div>
          </div>`).join('')}
        </div>
        <div class="ab-sample-bar">
          <div class="ab-sample-fill" style="width:${Math.min(100, (v.sample_progress || 0) * 100).toFixed(0)}%;background:${color}"></div>
        </div>
        <div style="font-size:0.65rem;color:var(--text-muted)">${fmtNum(v.sent)} / ${fmtNum(v.sample_target)} sample target</div>
      </div>`;
    }).join('')}
  </div>

  <!-- Statistical test results -->
  ${comparisons.length > 0 ? `
  <div class="ab-test-result" style="margin-top:16px">
    ${comparisons.map(c => `
    <div class="ab-z-result">
      <div>
        <strong>Variant ${c.variantA} vs ${c.variantB}</strong>
        <span style="color:var(--text-muted);font-size:0.72rem;margin-left:8px">on ${c.metric}</span>
      </div>
      <div class="ab-z-stats">
        <span>z = ${c.zScore?.toFixed(2)}</span>
        <span>p = ${c.pValue?.toFixed(4)}</span>
        <span style="color:${c.significant ? 'var(--emerald)' : 'var(--amber)'}">
          ${(c.confidence * 100).toFixed(1)}% confidence
        </span>
        ${c.significant ? `<span style="color:var(--emerald)">✓ Significant</span>` : `<span style="color:var(--amber)">⏳ Need more data</span>`}
        ${c.winner ? `<span style="color:var(--emerald)">Winner: Variant ${c.winner}</span>` : ''}
      </div>
    </div>`).join('')}
  </div>` : ''}`;
}
