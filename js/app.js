import { renderDashboard } from './dashboard.js';
import { renderLeads } from './leads.js';
import { renderQualification } from './qualification.js';
import { renderVerification } from './verification.js';
import { renderPersonalization } from './personalization.js';
import { renderMailboxes } from './mailboxes.js';
import { renderCampaigns } from './campaigns.js';
import { renderBatches } from './batches.js';
import { renderAnalytics } from './analytics.js';
import { Stats, Personalize } from './api.js';
import { escapeHtml, icon, openDialog } from './ui.js';

const views = {
  dashboard: { fn: renderDashboard, label: 'Overview', group: 'WORKSPACE', icon: 'grid' },
  leads: { fn: renderLeads, label: 'Lead pipeline', group: 'WORKSPACE', icon: 'people' },
  campaigns: { fn: renderCampaigns, label: 'Campaigns', group: 'WORKSPACE', icon: 'send' },
  mailboxes: { fn: renderMailboxes, label: 'Mailboxes', group: 'WORKSPACE', icon: 'mail' },
  analytics: { fn: renderAnalytics, label: 'Analytics', group: 'WORKSPACE', icon: 'chart' },
  qualification: { fn: renderQualification, label: 'Qualification', group: 'THE WORKBENCH', icon: 'globe' },
  verification: { fn: renderVerification, label: 'Verification', group: 'THE WORKBENCH', icon: 'shield' },
  personalization: { fn: renderPersonalization, label: 'Personalization', group: 'THE WORKBENCH', icon: 'sparkle' },
  batches: { fn: renderBatches, label: 'Batches', group: 'THE WORKBENCH', icon: 'layers' },
};
let currentView = 'dashboard';
let statusBusy = false;

export async function navigate(viewId) {
  if (!views[viewId]) return;
  currentView = viewId;
  history.replaceState(null, '', `#${viewId}`);
  document.title = `${views[viewId].label} — oddecosys`;
  document.querySelectorAll('[data-view]').forEach(element => {
    const active = element.dataset.view === viewId;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
  document.getElementById('header-breadcrumb-current').textContent = views[viewId].label;
  closeNavigation();
  const main = document.getElementById('main-content');
  const view = document.createElement('div');
  view.className = `page-view view-${viewId}`;
  main.replaceChildren(view);
  main.scrollTop = 0;
  main.setAttribute('aria-busy', 'true');
  try { await views[viewId].fn(view); }
  catch (error) {
    if (currentView !== viewId) return;
    const offline = error.code === 'NETWORK_ERROR' || error.status === 0;
    view.innerHTML = `<section class="studio-error"><div class="error-orbit">${icon('activity', 28)}</div><span class="eyebrow">A PAUSE IN THE SIGNAL</span><h1>${offline ? 'Your workspace is unreachable.' : 'This view couldn’t load.'}</h1><p>${escapeHtml(String(error.message || error).slice(0, 240))}</p><button class="btn btn-primary" data-retry>${icon('refresh', 16)}Try again</button></section>`;
    view.querySelector('[data-retry]').addEventListener('click', () => navigate(viewId));
  } finally { if (currentView === viewId) main.setAttribute('aria-busy', 'false'); }
}

const brandMark = '<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M28.8 11.3A13 13 0 1 0 26 29.4" fill="none" stroke="currentColor" stroke-width="6.2" stroke-linecap="round"/><path d="M28.1 12.9a9 9 0 1 0-3.3 16" fill="none" stroke="currentColor" stroke-opacity=".52" stroke-width="4.2" stroke-linecap="round"/><circle cx="25.4" cy="22.5" r="5.2" fill="currentColor"/></svg>';

function buildSidebar() {
  return `<aside class="sidebar" id="workspace-navigation" aria-label="Workspace navigation">
    <a class="sidebar-logo" href="#dashboard" aria-label="oddecosys overview"><span class="studio-brand-mark">${brandMark}</span><span class="logo-text">odd<span>ecosys</span></span></a>
    <div class="workspace-switch"><span class="workspace-symbol">${icon('layers', 15)}</span><div><strong>Your workspace</strong><span>Local environment</span></div><span class="workspace-initial">O</span></div>
    <nav class="sidebar-nav">${['WORKSPACE', 'THE WORKBENCH'].map(group => `<div class="nav-section-label">${group}</div>${Object.entries(views).filter(([, view]) => view.group === group).map(([id, view]) => `<button class="nav-item" type="button" data-view="${id}" title="${view.label}">${icon(view.icon, 18)}<span class="nav-label">${view.label}</span>${id === 'dashboard' ? '<span class="nav-active-mark"></span>' : ''}</button>`).join('')}`).join('')}</nav>
    <div class="sidebar-note"><div class="note-orbit" aria-hidden="true"></div><span>Less noise.<br>More connection.</span><small>YOUR OUTREACH, IN ORBIT.</small></div>
    <div class="sidebar-footer"><div class="sidebar-status" id="sidebar-status" role="status"><span class="tiny-dot is-muted"></span><span>Connecting to workspace</span></div><span class="sidebar-version">ODD ECOSYSTEM / 01</span></div>
  </aside><button class="nav-backdrop" aria-label="Close navigation" tabindex="-1"></button>`;
}
function buildHeader() {
  return `<header class="top-header"><div class="header-left"><button class="icon-btn mobile-menu" aria-controls="workspace-navigation" aria-expanded="false" aria-label="Open navigation">${icon('menu')}</button><div class="header-breadcrumb"><span class="bc-root">Workspace</span><span class="bc-sep">/</span><span class="bc-current" id="header-breadcrumb-current">Overview</span></div></div><nav class="header-tabs" aria-label="Quick navigation">${[['dashboard', 'Overview'], ['campaigns', 'Campaigns'], ['analytics', 'Insights']].map(([id, label]) => `<button data-view="${id}">${label}</button>`).join('')}</nav><div class="header-right"><button class="command-trigger" aria-label="Find a page (Control or Command K)">${icon('search', 16)}<span>Jump to…</span><kbd>⌘ K</kbd></button><div class="header-status-pill" id="header-ollama-pill" role="status" title="Connection to the application’s copy engine"><span class="tiny-dot is-muted"></span><span>Copy engine</span><span id="header-ollama-status">Checking</span></div><button class="icon-btn" id="workspace-refresh" aria-label="Refresh current view">${icon('refresh', 17)}</button></div></header>`;
}
function closeNavigation() {
  const wasOpen = document.body.classList.contains('navigation-open');
  document.body.classList.remove('navigation-open');
  document.querySelector('.mobile-menu')?.setAttribute('aria-expanded', 'false');
  syncNavigationAccessibility();
  if (wasOpen) document.querySelector('.mobile-menu')?.focus();
}
function syncNavigationAccessibility() {
  const sidebar = document.getElementById('workspace-navigation');
  const mobile = matchMedia('(max-width: 700px)').matches;
  const open = document.body.classList.contains('navigation-open');
  if (sidebar) sidebar.inert = mobile && !open;
  const main = document.querySelector('.main-area');
  if (main) main.inert = mobile && open;
}
function openCommands() {
  const dialog = openDialog({ title: 'Find your next step', eyebrow: 'MOVE THROUGH YOUR WORKSPACE', body: `<label class="command-input">${icon('search', 19)}<input type="search" placeholder="Search pages…" aria-label="Search workspace pages" autofocus></label><div class="command-results">${Object.entries(views).map(([id, view]) => `<button type="button" class="command-result" data-command="${id}">${icon(view.icon, 19)}<span>${view.label}<small>${view.group.toLowerCase()}</small></span>${icon('arrow', 16)}</button>`).join('')}</div><p class="command-no-results" hidden>No matching pages.</p>` });
  dialog.classList.add('command-dialog');
  const input = dialog.querySelector('input');
  input.addEventListener('input', () => {
    let found = 0;
    dialog.querySelectorAll('[data-command]').forEach(button => { button.hidden = !views[button.dataset.command].label.toLowerCase().includes(input.value.toLowerCase().trim()); if (!button.hidden) found++; });
    dialog.querySelector('.command-no-results').hidden = found !== 0;
  });
  dialog.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { dialog.close(); navigate(button.dataset.command); }));
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); dialog.querySelector('[data-command]:not([hidden])')?.click(); } });
}
async function updateStatus() {
  if (statusBusy || document.hidden) return;
  statusBusy = true;
  const [engine, stats] = await Promise.allSettled([Personalize.ollamaTest(), Stats.funnel()]);
  const engineText = document.getElementById('header-ollama-status');
  const dot = document.querySelector('#header-ollama-pill .tiny-dot');
  const connected = engine.status === 'fulfilled' && engine.value.connected === true;
  engineText.textContent = connected ? 'Connected' : engine.status === 'rejected' ? 'Unavailable' : 'Offline';
  dot.className = `tiny-dot ${connected ? '' : 'is-warning'}`;
  document.getElementById('header-ollama-pill').classList.toggle('is-disconnected', !connected);
  const sidebarStatus = document.getElementById('sidebar-status');
  sidebarStatus.innerHTML = stats.status === 'fulfilled' ? `<span class="tiny-dot"></span><span>${Number(stats.value.queued) || 0} queued · workspace online</span>` : '<span class="tiny-dot is-warning"></span><span>Workspace unavailable</span>';
  statusBusy = false;
}
function init() {
  window.__nav = navigate;
  const app = document.getElementById('app');
  app.innerHTML = buildSidebar() + `<div class="main-area">${buildHeader()}<main id="main-content" tabindex="-1" aria-label="Workspace content"></main></div>`;
  app.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  app.querySelector('.sidebar-logo').addEventListener('click', event => { event.preventDefault(); navigate('dashboard'); });
  app.querySelector('.mobile-menu').addEventListener('click', () => { const open = document.body.classList.toggle('navigation-open'); app.querySelector('.mobile-menu').setAttribute('aria-expanded', String(open)); syncNavigationAccessibility(); if (open) app.querySelector('.sidebar .nav-item.active')?.focus(); });
  app.querySelector('.nav-backdrop').addEventListener('click', closeNavigation);
  app.querySelector('.command-trigger').addEventListener('click', openCommands);
  app.querySelector('#workspace-refresh').addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; await Promise.all([navigate(currentView), updateStatus()]); button.disabled = false; });
  window.addEventListener('hashchange', () => { const route = location.hash.slice(1); if (views[route] && currentView !== route) navigate(route); });
  window.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); } if (event.key === 'Escape') closeNavigation(); });
  matchMedia('(max-width: 700px)').addEventListener('change', syncNavigationAccessibility);
  syncNavigationAccessibility();
  navigate(views[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
  updateStatus(); setInterval(updateStatus, 30000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
