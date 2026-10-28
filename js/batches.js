// ============================================================
//  ODD-ECOSYS — Batches View (Section 14 Cohort Engine)
//  100% Live API · Bounded Cohort Management
//  Terminal Lead Archival & SQLite VACUUM Defragmentation
// ============================================================
import { Batches, Qualify, Stats, relTime, fmtNum } from './api.js';
import { confirmAction, notify } from './ui.js';

export async function renderBatches(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading cohorts…</span></div>`;

  const [batches, funnel, archStats] = await Promise.all([
    Batches.list(),
    Stats.funnel(),
    Batches.archiveStats(),
  ]);

  const list = batches || [];
  const arch = archStats || {};
  const restorableBatchIds = new Set((arch.restorableBatchIds || []).map(Number));

  container.innerHTML = `
  <div class="dash-header">
    <div>
      <h1 class="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="vertical-align:-4px">
          <rect x="3" y="3" width="18" height="6" rx="2" stroke="var(--system-blue)" stroke-width="1.8"/>
          <rect x="3" y="11" width="18" height="6" rx="2" stroke="var(--system-blue)" stroke-width="1.8"/>
          <rect x="3" y="19" width="10" height="3" rx="1.5" stroke="var(--system-blue)" stroke-width="1.8"/>
        </svg>
        People, brought together.
      </h1>
      <div class="section-sub">${list.length} batches · organize your prospects into a considered outreach journey.</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="window.__batchCreate()">+ New Batch</button>
    </div>
  </div>

  <!-- Archive Stats Widget Strip -->
  <div class="kpi-grid-4 mb-16">
    ${[
      { label: 'Active Cohorts',    val: list.filter(b=>b.status!=='closed').length, sub: 'currently in pipeline', color: 'var(--system-blue)' },
      { label: 'Archived Leads',    val: arch.leadsArchived || 0, sub: 'preserved in your history', color: 'var(--system-purple)' },
      { label: 'Archived Sends',    val: arch.sendsArchived || 0, sub: 'historical transmissions', color: 'var(--system-green)' },
      { label: 'Closed Batches',    val: arch.closedBatches || 0, sub: 'completed or closed by you', color: 'var(--system-orange)' },
    ].map(k => `
    <div class="kpi-card" style="--accent-color:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.val}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('')}
  </div>

  <!-- Create batch form (hidden) -->
  <div id="batch-create-form" class="glass-panel mb-16" style="display:none">
    <div class="panel-header"><span class="panel-title">Create New Processing Cohort</span></div>
    <div class="panel-body">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label class="form-label">Batch Name</label>
          <input id="new-batch-name" class="filter-input" placeholder="Roofers — Dallas TX" style="width:280px" />
        </div>
        <div>
          <label class="form-label">Pipeline Phase</label>
          <select id="new-batch-phase" class="filter-select">
            <option value="discovery">Discovery</option>
            <option value="qualification">Qualification</option>
            <option value="sending">Sending</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__batchSubmit()">Create Cohort</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('batch-create-form').style.display='none'">Cancel</button>
      </div>
    </div>
  </div>

  <!-- Batch list -->
  <div class="batch-list">
    ${list.length === 0 ? `
    <div class="glass-panel">
      <div class="panel-body empty-state">
        <div class="empty-icon">⬡</div>
        <p>No cohorts yet</p>
        <p class="empty-hint">Click <strong>+ New Batch</strong> to start your first bounded processing cohort</p>
      </div>
    </div>` : list.map(b => renderBatchCard(b, restorableBatchIds.has(Number(b.id)))).join('')}
  </div>`;

  // Wire
  window.__batchCreate = () => {
    document.getElementById('batch-create-form').style.display = '';
  };
  window.__batchSubmit = async () => {
    const name  = document.getElementById('new-batch-name')?.value?.trim();
    const phase = document.getElementById('new-batch-phase')?.value;
    if (!name) return;
    await Batches.create({ name, phase });
    document.getElementById('batch-create-form').style.display = 'none';
    renderBatches(container);
  };
  window.__batchStartQualify = async (id) => {
    await Qualify.startBatch(id);
    window.__nav('qualification');
  };
  window.__batchClose = async (id) => {
    if (!await confirmAction({ title: 'Close batch', message: 'Closing stops new leads from being added. Existing records and history are retained.', confirmLabel: 'Close batch', danger: true })) return;
    try { await Batches.close(id); notify('Batch closed; its records were retained.'); await renderBatches(container); }
    catch (error) { notify(error.message || 'Could not close this batch.', 'error'); }
  };
  window.__batchArchive = async (id, name) => {
    if (!await confirmAction({ title: `Archive batch “${name}”`, message: 'A full restorable snapshot keeps contact, verification, source and send history. Active or uncertain campaign work blocks archiving.', confirmLabel: 'Archive batch', danger: true })) return;
    try {
      const res = await Batches.archive(id);
      if (res?.ok) notify(`Archived ${res.archivedLeads} contacts and ${res.archivedSends} sends. You can restore this batch later.`, 'success');
      await renderBatches(container);
    } catch (error) { notify(error.message || 'Could not archive this batch.', 'error'); }
  };
  window.__batchRestore = async (id, name) => {
    if (!await confirmAction({ title: `Restore batch “${name}”`, message: 'Restore its contacts and linked history from the saved archive snapshot?', confirmLabel: 'Restore batch', danger: false })) return;
    try {
      const res = await Batches.restore(id);
      if (res?.ok) notify(`Restored ${res.restoredLeads} contacts and ${res.restoredSends} sends.`, 'success');
      await renderBatches(container);
    } catch (error) { notify(error.message || 'Could not restore this batch.', 'error'); }
  };
}

function renderBatchCard(b, archived = false) {
  const processed = b.actual_leads || b.lead_count || 0;
  const qualified = b.qualified || 0;
  const pct = processed > 0 ? Math.round((qualified / processed) * 100) : 0;

  const statusColor = {
    open: 'var(--system-orange)', processing: 'var(--system-green)', closed: 'var(--text-muted)',
  }[b.status] || 'var(--text-muted)';

  const phaseColor = {
    discovery: 'var(--system-blue)', qualification: 'var(--system-purple)', sending: 'var(--system-green)',
  }[b.phase] || 'var(--system-blue)';

  return `
  <div class="glass-panel mb-14 animate-in batch-card">
    <div class="batch-card-header">
      <div class="batch-card-left">
        <div class="batch-card-name">${b.name || b.label || 'Batch #' + b.id}</div>
        <div class="batch-card-meta">
          <span class="phase-chip" style="color:${phaseColor};border-color:${phaseColor}44">${b.phase}</span>
          <span style="color:var(--text-muted);font-size:0.75rem">opened ${relTime(b.opened_at)}</span>
          ${b.closed_at ? `<span style="color:var(--text-muted);font-size:0.75rem">· closed ${relTime(b.closed_at)}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="status-badge" style="color:${statusColor};border-color:${statusColor}44">${b.status}</span>
      </div>
    </div>

    <div class="batch-card-stats">
      ${[
        { label: 'Total Leads', val: fmtNum(b.lead_count || 0), color: 'var(--system-blue)' },
        { label: 'Processed',   val: fmtNum(processed),          color: 'var(--system-cyan)' },
        { label: 'Qualified',   val: fmtNum(qualified),           color: 'var(--system-green)' },
        { label: 'Sent',        val: fmtNum(b.sent_count || 0),  color: 'var(--system-orange)' },
      ].map(s => `
      <div class="batch-stat-cell">
        <div class="batch-stat-val" style="color:${s.color}">${s.val}</div>
        <div class="batch-stat-label">${s.label}</div>
      </div>`).join('')}
    </div>

    ${processed > 0 ? `
    <div class="batch-card-progress">
      <div class="progress-track" style="height:6px">
        <div class="progress-fill" style="width:${pct}%;background:var(--system-blue)"></div>
      </div>
      <span style="font-size:0.72rem;color:var(--text-muted);font-weight:600">${pct}% qualified</span>
    </div>` : ''}

    <div class="batch-card-actions">
      ${archived ? `
        <span style="font-size:0.75rem;color:var(--text-muted)">Archived snapshot · history retained</span>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto;color:var(--system-purple)" onclick="window.__batchRestore(${b.id},'${(b.name||'').replace(/'/g,"\\'")}')">↩ Restore batch</button>
      ` : `
        ${b.status !== 'closed' ? `
        <button class="btn btn-ghost btn-sm" onclick="window.__batchStartQualify(${b.id})">◎ Run Qualification</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__nav('verification')">✉ Verify Emails</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__nav('personalization')">✍ Personalize</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--system-orange)" onclick="window.__batchClose(${b.id})">Close Cohort</button>
        ` : `<span style="font-size:0.75rem;color:var(--text-muted)">Closed · records are still available</span>`}
        <button class="btn btn-ghost btn-sm" style="color:var(--system-purple)" onclick="window.__batchArchive(${b.id},'${(b.name||'').replace(/'/g,"\\'")}')">📦 Archive batch</button>
      `}
    </div>
  </div>`;
}
