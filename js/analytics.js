// ============================================================
//  ODD-ECOSYS — Analytics & Performance View
//  100% Live API Data · Real Email Funnel · AI Cost & Sentiment
// ============================================================

import { Stats, fmtNum, fmtPct, relTime } from './api.js';
import { escapeHtml, icon, notify } from './ui.js';

export async function renderAnalytics(container) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading real-time analytics…</span></div>`;

  const [analyticsData, funnel] = await Promise.all([
    Stats.analytics(),
    Stats.funnel(),
  ]);

  const timeline = analyticsData.timeline || [];
  const sentiment = analyticsData.sentiment || { interested: 0, not_interested: 0, out_of_office: 0, wrong_person: 0, unsubscribe_request: 0, total: 0 };
  const niches = analyticsData.niches || [];
  const aiCost = analyticsData.aiCost || { ollama_calls: 0, bedrock_calls: 0, cost_usd: null, total_tokens: null, cost_per_lead: null, tasks: [] };

  const totalSent = (funnel.sent || 0) + (funnel.replied || 0) + (funnel.won || 0) + (funnel.lost || 0);

  container.innerHTML = `
  <div class="dash-header mb-16">
    <div>
      <h1 class="section-title">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="vertical-align:-4px">
          <path d="M3 3v18h18" stroke="var(--system-blue)" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M7 14l4-4 4 4 5-7" stroke="var(--system-blue)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        A clearer picture.
      </h1>
      <div class="section-sub">Follow your recorded outreach activity. Unknown costs stay unknown.</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn btn-ghost btn-sm" onclick="window.__exportAnalyticsCSV()">${icon('diagonal', 15)} Export CSV</button>
    </div>
  </div>

  <!-- KPI Strip -->
  <div class="kpi-grid-4 mb-16">
    ${[
      { label: 'Total Leads Tracked', val: fmtNum(Object.values(funnel).reduce((a,b)=>a+b,0)), sub: 'in active database', color: 'var(--system-blue)' },
      { label: 'Emails Sent', val: fmtNum(totalSent), sub: 'across active mailboxes', color: 'var(--system-purple)' },
      { label: 'Total Replies', val: fmtNum((funnel.replied || 0) + (funnel.won || 0)), sub: 'inbound responses', color: 'var(--system-green)' },
      { label: 'AI provider requests', val: fmtNum(aiCost.request_count || 0), sub: 'since request tracking began', color: 'var(--system-blue)' },
    ].map(k => `
    <div class="kpi-card" style="--accent-color:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.val}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('')}
  </div>

  <!-- Top row: 7-day stacked + sentiment donut -->
  <div class="grid cols-2 mb-16">
    <div class="glass-panel animate-in">
      <div class="panel-header">
        <span class="panel-title"><span class="dot" style="background:var(--system-blue)"></span>7-Day Activity Funnel</span>
        <span class="panel-hint">Accepted sends, replies & unique tracked links requested. Automated email checks may be included.</span>
      </div>
      <div class="panel-body" id="stacked-chart">
        ${renderStackedChartHtml(timeline)}
      </div>
    </div>

    <div class="glass-panel animate-in">
      <div class="panel-header">
        <span class="panel-title"><span class="dot" style="background:var(--system-green)"></span>AI Reply Sentiment</span>
        <span class="panel-hint">Ollama local NLP classification</span>
      </div>
      <div class="panel-body" id="sentiment-area">
        ${renderSentimentHtml(sentiment)}
      </div>
    </div>
  </div>

  <!-- AI Cost breakdown -->
  <div class="glass-panel mb-16 animate-in">
    <div class="panel-header">
      <span class="panel-title"><span class="dot" style="background:var(--system-purple)"></span>AI Requests & Usage</span>
      <span class="panel-hint">Provider-reported tokens · dated rates only</span>
    </div>
    <div class="panel-body" id="ai-cost-area">
      ${renderAICostHtml(aiCost)}
    </div>
  </div>

  <!-- Niche performance table -->
  <div class="glass-panel animate-in">
    <div class="panel-header">
      <span class="panel-title"><span class="dot" style="background:var(--system-orange)"></span>Live Niche & Geo Performance</span>
      <span class="panel-hint">Grouped by audience and location</span>
    </div>
    <div class="panel-body" style="padding:0;overflow-x:auto">
      <table class="data-table">
        <thead>
          <tr>
            <th>Niche Category</th>
            <th>Location</th>
            <th class="td-right">Total Leads</th>
            <th class="td-right">Sent</th>
            <th class="td-right">Replies</th>
            <th class="td-right">Reply Rate</th>
            <th class="td-right">Won Leads</th>
            <th class="td-right">Avg Site Score</th>
          </tr>
        </thead>
        <tbody>
          ${niches.length === 0 ? `
          <tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">No niche data available yet.</td></tr>
          ` : niches.map(n => `
          <tr>
            <td class="td-name"><strong>${n.niche}</strong></td>
            <td style="color:var(--text-secondary)">📍 ${n.geo}</td>
            <td class="td-right td-mono">${fmtNum(n.leads)}</td>
            <td class="td-right td-mono">${fmtNum(n.sent)}</td>
            <td class="td-right td-mono" style="color:var(--system-cyan)">${fmtNum(n.replies)}</td>
            <td class="td-right td-mono ${n.reply_rate > 5 ? 'text-emerald' : ''}">${n.reply_rate > 0 ? n.reply_rate + '%' : '—'}</td>
            <td class="td-right td-mono" style="color:var(--system-green);font-weight:700">${fmtNum(n.positive)}</td>
            <td class="td-right td-mono">
              ${n.avg_site_score != null ? `<span style="font-weight:600;color:${n.avg_site_score < 50 ? 'var(--system-orange)' : 'var(--system-green)'}">${n.avg_site_score}/100</span>` : '—'}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  // Global helper for CSV export
  window.__exportAnalyticsCSV = () => {
    if (!niches || niches.length === 0) return notify('There’s no audience data to export yet.');
    const headers = ['Niche', 'Geography', 'Leads', 'Sent', 'Replies', 'ReplyRate', 'Positive', 'AvgSiteScore'];
    const rows = niches.map(n => [
      `"${n.niche}"`, `"${n.geo}"`, n.leads, n.sent, n.replies, `${n.reply_rate}%`, n.positive, n.avg_site_score || 0
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `oddecosys-analytics-${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
}

// ── Stacked Chart Generator ──────────────────────────────────
export function renderStackedChartHtml(data) {
  if (!data || data.length === 0 || !data.some(row => ['sent', 'tracked_link_requests', 'replied'].some(key => Number(row[key]) > 0))) {
    return `<div class="chart-empty"><div class="empty-orbit">${icon('chart', 25)}</div><h3>Space for your next signal.</h3><p>Recorded sends and responses will appear here.</p></div>`;
  }

  const W = 480, H = 150, PAD = 24;
  const labels = data.map(d => (d.date || '').slice(5));
  const series = [
    { key: 'sent',    color: '#bacdad', label: 'Sent'    },
    { key: 'tracked_link_requests', color: '#939f8b', label: 'Unique tracked links requested' },
    { key: 'replied', color: '#d8bf91', label: 'Replied' },
  ];

  const maxVal = Math.max(1, ...data.map(d => Math.max(d.sent || 0, d.tracked_link_requests || 0, d.replied || 0)));
  const xStep = (W - PAD * 2) / Math.max(1, data.length - 1);
  const toX = (i) => PAD + i * xStep;
  const toY = (v) => H - PAD - (((v || 0) / maxVal) * (H - PAD * 2));

  const makeLine = (key, color) => {
    const pts = data.map((p, i) => `${toX(i).toFixed(1)},${toY(p[key]).toFixed(1)}`).join(' ');
    const first = `${toX(0).toFixed(1)},${H - PAD}`;
    const last  = `${toX(data.length - 1).toFixed(1)},${H - PAD}`;
    const d = data.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p[key]).toFixed(1)}`).join(' ');

    return `
      <polygon points="${first} ${pts} ${last}" fill="${color}" opacity="0.12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${data.map((p, i) => `<circle cx="${toX(i).toFixed(1)}" cy="${toY(p[key]).toFixed(1)}" r="3" fill="${color}" stroke="#0f1422" stroke-width="2"/>`).join('')}
    `;
  };

  return `
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
    ${series.map(s => `
    <div style="display:flex;align-items:center;gap:6px;font-size:0.75rem">
      <span style="width:12px;height:3px;background:${s.color};border-radius:2px;display:inline-block"></span>
      <span style="color:var(--text-secondary)">${s.label}</span>
    </div>`).join('')}
  </div>
  <div class="chart-wrap" style="width:100%;overflow-x:auto">
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" style="width:100%;height:auto;min-width:320px">
      ${[0.33, 0.66, 1].map(f => {
        const y = toY(maxVal * f);
        return `
          <line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${PAD - 4}" y="${y + 3}" fill="rgba(255,255,255,0.3)" font-size="8" font-family="monospace" text-anchor="end">${Math.round(maxVal * f)}</text>
        `;
      }).join('')}
      ${labels.map((l, i) => `<text x="${toX(i)}" y="${H - 4}" fill="rgba(255,255,255,0.35)" font-size="8" font-family="monospace" text-anchor="middle">${l}</text>`).join('')}
      ${series.map(s => makeLine(s.key, s.color)).join('')}
    </svg>
  </div>`;
}

// ── Sentiment Breakdown ──────────────────────────────────────
function renderSentimentHtml(sentiment) {
  const sentimentItems = [
    { label: 'Interested / Meeting', key: 'interested', color: '#30D158' },
    { label: 'Declined / Not Interested', key: 'not_interested', color: '#FF453A' },
    { label: 'Out of Office', key: 'out_of_office', color: '#FF9F0A' },
    { label: 'Wrong Person', key: 'wrong_person', color: '#BF5AF2' },
    { label: 'Unsubscribe Request', key: 'unsubscribe_request', color: '#8E8E93' },
  ];

  const total = Object.values(sentiment).reduce((s, v) => typeof v === 'number' ? s + v : s, 0) || 0;

  if (total === 0) {
    return `<div style="padding:40px;text-align:center;color:var(--text-muted)">No inbound replies received yet.</div>`;
  }

  return `
  <div style="display:flex;flex-direction:column;gap:12px">
    ${sentimentItems.map(item => {
      const val = sentiment[item.key] || 0;
      const pct = total > 0 ? Math.round((val / total) * 100) : 0;
      return `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-size:0.8rem">
          <span style="color:var(--text-primary);display:flex;align-items:center;gap:6px">
            <span style="width:8px;height:8px;border-radius:50%;background:${item.color}"></span>
            ${item.label}
          </span>
          <span style="font-family:var(--mono);font-weight:700;color:${item.color}">${val} (${pct}%)</span>
        </div>
        <div class="progress-track" style="height:6px">
          <div class="progress-fill" style="width:${pct}%;background:${item.color}"></div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ── AI Cost Breakdown ─────────────────────────────────────────
export function renderAICostHtml(aiCost) {
  const tasks = aiCost.tasks || [];
  const maxCalls = Math.max(1, ...tasks.map(t => t.calls || 0));
  const tokenText = value => value == null ? 'unknown' : fmtNum(value);
  const inputText = value => value == null ? 'unknown' : fmtNum(value);
  const usageNote = escapeHtml(aiCost.usage_note || 'Provider usage is recorded per request where returned.');
  const rateNote = escapeHtml(aiCost.rate_card_note || 'Cost remains unknown without a matching dated rate card.');

  return `
  <div class="grid cols-4 mb-16" style="gap:12px">
    ${[
      { label: 'Ollama requests', val: fmtNum(aiCost.ollama_calls || 0), color: 'var(--system-green)', sub: 'Recorded provider attempts' },
      { label: 'Bedrock requests', val: fmtNum(aiCost.bedrock_calls || 0), color: 'var(--system-purple)', sub: 'Recorded provider attempts' },
      { label: 'Measured AI tokens', val: tokenText(aiCost.total_tokens), color: 'var(--system-blue)', sub: aiCost.total_tokens == null ? 'Incomplete or unavailable provider usage' : 'Input plus output tokens reported by providers' },
      { label: 'Recorded AI cost', val: aiCost.cost_usd == null ? 'unknown' : '$' + aiCost.cost_usd.toFixed(6), color: 'var(--system-orange)', sub: aiCost.cost_usd == null ? 'No complete dated rate card' : 'Calculated from request usage and saved rate cards' },
    ].map(k => `
    <div style="background:rgba(255,255,255,0.03);border:1px solid var(--glass-border);border-radius:var(--radius-sm);padding:14px">
      <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">${k.label}</div>
      <div style="font-size:1.35rem;font-weight:800;color:${k.color};font-family:var(--mono)">${k.val}</div>
      <div style="font-size:0.72rem;color:var(--text-secondary);margin-top:4px">${k.sub}</div>
    </div>`).join('')}
  </div>

  <div class="panel-hint" style="margin:0 0 14px">${usageNote} ${rateNote}</div>

  <div style="display:flex;flex-direction:column;gap:12px">
    ${tasks.map(t => `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="site-status-chip" style="${t.tier==='ollama'?'color:var(--system-green);border-color:rgba(48,209,88,0.3)':'color:var(--system-purple);border-color:rgba(191,90,242,0.3)'}">
            ${t.tier.toUpperCase()}
          </span>
          <span style="font-size:0.82rem;color:var(--text-secondary)">${escapeHtml(t.name)} <span style="color:var(--text-muted)">· ${escapeHtml(t.model || '')}</span></span>
        </div>
        <div style="display:flex;gap:12px;align-items:center">
          <span style="font-size:0.75rem;color:var(--text-muted);font-family:var(--mono)">${fmtNum(t.calls || 0)} requests · ${fmtNum(t.failed || 0)} failed</span>
          <span style="font-size:0.78rem;font-weight:700;color:${t.tier==='bedrock'?'var(--system-purple)':'var(--system-green)'};width:70px;text-align:right;font-family:var(--mono)">
            ${t.cost_usd == null ? 'unknown' : '$' + t.cost_usd.toFixed(6)}
          </span>
        </div>
      </div>
      <div style="font-size:0.72rem;color:var(--text-muted);margin:0 0 5px">Input ${inputText(t.input_tokens)} · output ${inputText(t.output_tokens)} tokens · ${t.succeeded ? fmtNum(t.succeeded) + ' responses' : 'no successful responses'}</div>
      <div class="progress-track" style="height:6px">
        <div class="progress-fill" style="width:${Math.round(((t.calls || 0) / maxCalls) * 100)}%;background:${t.tier==='ollama'?'var(--system-green)':'var(--system-purple)'}"></div>
      </div>
    </div>`).join('')}
  </div>`;
}
