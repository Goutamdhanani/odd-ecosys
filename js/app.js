import { renderDashboard } from './dashboard.js';
import { renderLeads } from './leads.js';
import { renderLists } from './lists.js';
import { renderQualification } from './qualification.js';
import { renderVerification } from './verification.js';
import { renderPersonalization } from './personalization.js';
import { renderMailboxes } from './mailboxes.js';
import { renderCampaigns } from './campaigns.js';
import { renderInbox } from './inbox.js';
import { renderBatches } from './batches.js';
import { renderAnalytics } from './analytics.js';
import { renderSettings } from './settings.js';
import { Auth, Workspace, Stats, Personalize } from './api.js';
import { confirmAction, escapeHtml, icon, openDialog, notify, userFacingError } from './ui.js';

const views = {
  dashboard: { fn: renderDashboard, label: 'Overview', group: 'WORKSPACE', icon: 'grid' },
  leads: { fn: renderLeads, label: 'Lead pipeline', group: 'WORKSPACE', icon: 'people' },
  lists: { fn: renderLists, label: 'Contact lists', group: 'WORKSPACE', icon: 'layers' },
  campaigns: { fn: renderCampaigns, label: 'Campaigns', group: 'WORKSPACE', icon: 'send' },
  inbox: { fn: renderInbox, label: 'Inbox', group: 'WORKSPACE', icon: 'mail' },
  mailboxes: { fn: renderMailboxes, label: 'Mailboxes', group: 'WORKSPACE', icon: 'mail' },
  analytics: { fn: renderAnalytics, label: 'Analytics', group: 'WORKSPACE', icon: 'chart' },
  settings: { fn: renderSettings, label: 'Settings', group: 'WORKSPACE', icon: 'shield' },
  qualification: { fn: renderQualification, label: 'Qualification', group: 'THE WORKBENCH', icon: 'globe' },
  verification: { fn: renderVerification, label: 'Verification', group: 'THE WORKBENCH', icon: 'shield' },
  personalization: { fn: renderPersonalization, label: 'Personalization', group: 'THE WORKBENCH', icon: 'sparkle' },
  batches: { fn: renderBatches, label: 'Batches', group: 'THE WORKBENCH', icon: 'layers' },
};
let currentView = 'dashboard';
let statusBusy = false;
let authenticatedEmail = '';
let authenticatedRole = '';
let authenticatedUserId = 0;

export async function navigate(viewId) {
  if (!views[viewId]) return;
  if (currentView !== viewId) {
    document.getElementById('notification-region')?.replaceChildren();
    window.__closeMailboxModals?.();
  }
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
    view.innerHTML = `<section class="studio-error"><div class="error-orbit">${icon('activity', 28)}</div><span class="eyebrow">A PAUSE IN THE SIGNAL</span><h1>${offline ? 'Your workspace is unreachable.' : 'This view couldn’t load.'}</h1><p>${escapeHtml(userFacingError(error, 'The workspace view could not load. Try again, or contact your administrator if it keeps failing.'))}</p><button class="btn btn-primary" data-retry>${icon('refresh', 16)}Try again</button></section>`;
    view.querySelector('[data-retry]').addEventListener('click', () => navigate(viewId));
  } finally { if (currentView === viewId) main.setAttribute('aria-busy', 'false'); }
}

const brandMark = '<img class="odd-ecosys-emblem" src="/assets/odd-ecosys-emblem.png" alt="">';
let googleIdentityScript;

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!googleIdentityScript) {
    googleIdentityScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        if (window.google?.accounts?.id) resolve();
        else { googleIdentityScript = null; reject(new Error('Google sign-in did not initialize.')); }
      };
      script.onerror = () => {
        googleIdentityScript = null;
        script.remove();
        reject(new Error('Google sign-in could not load.'));
      };
      document.head.append(script);
    });
  }
  return googleIdentityScript;
}

async function prepareGoogleSignin(status, mode, container) {
  const message = container?.parentElement?.querySelector('[data-google-message]');
  if (!container || !status?.googleLoginAvailable) return;
  if (message) message.textContent = 'Preparing secure Google sign-in…';
  try {
    const { clientId, nonce } = await Auth.googleNonce();
    await loadGoogleIdentityScript();
    if (!container.isConnected) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      nonce,
      auto_select: false,
      cancel_on_tap_outside: true,
      callback: async response => {
        const button = container;
        button.setAttribute('aria-busy', 'true');
        try {
          if (!response?.credential) throw new Error('Google did not return a sign-in credential.');
          const result = await Auth.googleLogin({ credential: response.credential });
          if (result.mfaRequired) return showMfaChallenge(result, status, mode);
          window.location.replace('/');
        } catch (error) {
          let safeMessage = String(error.message || 'Google sign-in could not be completed.')
            .replace(/^API [^ ]+ failed: HTTP \d+ — /, '');
          try {
            const parsed = JSON.parse(safeMessage);
            safeMessage = parsed.error || parsed.message || safeMessage;
          } catch { /* keep the readable transport error */ }
          const emailField = document.querySelector('#auth-form [name="email"]');
          const email = emailField?.value || '';
          let freshStatus = status;
          try { freshStatus = await Auth.status(); } catch { /* keep the last known setup state */ }
          showAuthScreen(freshStatus, safeMessage.slice(0, 240), mode);
          const replacementEmail = document.querySelector('#auth-form [name="email"]');
          if (replacementEmail) replacementEmail.value = email;
        }
      },
    });
    window.google.accounts.id.renderButton(container, {
      theme: 'outline', size: 'large', text: mode === 'setup' ? 'continue_with' : 'signin_with',
      shape: 'rectangular', width: Math.max(220, Math.min(380, Math.floor(container.clientWidth || 380))),
    });
    if (message) message.textContent = mode === 'setup'
      ? 'Your first verified Google account becomes the workspace owner.'
      : 'Use your verified Google account to continue.';
  } catch (error) {
    if (container.isConnected && message) {
      const fallback = mode === 'setup' && status.setupAvailable !== true
        ? 'Google sign-in is unavailable. Ask the server operator to restore Google access or configure the private first-account setup token.'
        : 'Google sign-in is unavailable. Use your local password or try again.';
      message.textContent = String(error.message || fallback).slice(0, 240);
    }
  }
}

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
  return `<header class="top-header"><div class="header-left"><button class="icon-btn mobile-menu" aria-controls="workspace-navigation" aria-expanded="false" aria-label="Open navigation">${icon('menu')}</button><div class="header-breadcrumb"><span class="bc-root">Workspace</span><span class="bc-sep">/</span><span class="bc-current" id="header-breadcrumb-current">Overview</span></div></div><nav class="header-tabs" aria-label="Quick navigation">${[['dashboard', 'Overview'], ['campaigns', 'Campaigns'], ['analytics', 'Insights']].map(([id, label]) => `<button data-view="${id}">${label}</button>`).join('')}</nav><div class="header-right"><button class="command-trigger" aria-label="Find a page (Control or Command K)">${icon('search', 16)}<span>Jump to…</span><kbd>⌘ K</kbd></button><div class="header-status-pill" id="header-ollama-pill" role="status" title="Connection to the application’s copy engine"><span class="tiny-dot is-muted"></span><span>Copy engine</span><span id="header-ollama-status">Checking</span></div><button class="icon-btn" id="workspace-refresh" aria-label="Refresh current view">${icon('refresh', 17)}</button><button class="auth-account" id="workspace-account" type="button">${escapeHtml(authenticatedEmail)}</button><button class="auth-logout" id="workspace-logout" type="button">Sign out</button></div></header>`;
}

async function openAccountSecurity() {
  const dialog = openDialog({
    title: 'Account security',
    eyebrow: authenticatedEmail || 'LOCAL ACCOUNT',
    body: '<p class="account-events-loading">Loading recent account activity…</p>',
  });
  try {
    const { events } = await Auth.events(50);
    if (!dialog.isConnected || !dialog.open) return;
    const labels = {
      account_bootstrapped: 'First local account created',
      sign_in: 'Signed in',
      sign_in_denied: 'Sign-in attempt rejected',
      sign_out: 'Signed out',
      password_recovered: 'Password recovered; other sessions revoked',
      password_recovery_no_account: 'Recovery request completed without a matching account',
      password_recovery_denied: 'Recovery request rejected',
      bootstrap_denied: 'First-account setup attempt rejected',
      mfa_enabled: 'Multi-factor sign-in enabled',
      mfa_disabled: 'Multi-factor sign-in disabled',
      mfa_sign_in: 'Signed in with an authenticator code',
      mfa_recovery_code_used: 'Signed in with a recovery code',
      mfa_recovery_codes_regenerated: 'Recovery codes replaced',
      password_mfa_challenge_issued: 'Password accepted; authenticator required',
      google_mfa_challenge_issued: 'Google account verified; authenticator required',
      invitation_mfa_challenge_issued: 'Invitation accepted; authenticator required',
      mfa_challenge_denied: 'Authenticator challenge rejected',
      mfa_stepup_denied: 'Account security check rejected',
    };
    const list = Array.isArray(events) && events.length
      ? `<ol class="account-event-list">${events.map(event => {
        const label = labels[event.event_type] || 'Account activity';
        const time = new Date(Number(event.created_at));
        const validTime = !Number.isNaN(time.getTime());
        const timestamp = validTime ? time.toLocaleString() : 'Time unavailable';
        const isoTime = validTime ? time.toISOString() : '';
        return `<li><span>${escapeHtml(label)}</span><time datetime="${escapeHtml(isoTime)}">${escapeHtml(timestamp)}</time></li>`;
      }).join('')}</ol>`
      : '<p class="account-events-loading">No account activity has been recorded yet.</p>';
    const teamAction = ['owner', 'admin'].includes(authenticatedRole)
      ? '<button class="btn btn-secondary team-open-button" id="workspace-team-open" type="button">Manage workspace access</button>'
      : '';
    dialog.querySelector('.studio-dialog-body').innerHTML = `<p class="account-events-loading">Signed in as <strong>${escapeHtml(authenticatedEmail)}</strong> · ${escapeHtml(authenticatedRole)}. Recent local account events:</p>${teamAction}${list}`;
    dialog.querySelector('#workspace-team-open')?.addEventListener('click', openTeamManagement);
  } catch (error) {
    if (dialog.isConnected && dialog.open) dialog.querySelector('.studio-dialog-body').innerHTML = `<p class="auth-error" role="alert">${escapeHtml(error.message || 'Could not load account activity.')}</p>`;
  }
}

async function openTeamManagement() {
  const manager = ['owner', 'admin'].includes(authenticatedRole);
  if (!manager) return;
  const inviteRoles = authenticatedRole === 'owner'
    ? [['admin', 'Admin'], ['operator', 'Operator'], ['reviewer', 'Reviewer']]
    : [['operator', 'Operator'], ['reviewer', 'Reviewer']];
  const roleOptions = roles => roles.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const dialog = openDialog({
    title: 'Workspace access',
    eyebrow: `${authenticatedRole.toUpperCase()} · LOCAL WORKSPACE`,
    body: `<section class="team-invite-panel" aria-labelledby="team-invite-title">
      <h3 id="team-invite-title">Invite a teammate</h3>
      <p>Invitations expire after seven days. No email is sent; share the one-time token through a trusted channel.</p>
      <label>Email address<input id="team-invite-email" type="email" maxlength="254" autocomplete="off" required></label>
      <label>Workspace role<select id="team-invite-role">${roleOptions(inviteRoles)}</select></label>
      <button class="btn btn-primary" id="team-invite-create" type="button">Create invitation</button>
      <div class="team-invitation-token" id="team-invitation-token" hidden></div>
    </section>
    <section class="team-section"><h3>Members</h3><div id="team-members" class="team-list" aria-live="polite">Loading members…</div></section>
    <section class="team-section"><h3>Invitations</h3><div id="team-invitations" class="team-list" aria-live="polite">Loading invitations…</div></section>`,
  });
  const body = dialog.querySelector('.studio-dialog-body');
  const membersView = body.querySelector('#team-members');
  const invitationsView = body.querySelector('#team-invitations');
  const tokenView = body.querySelector('#team-invitation-token');

  async function reloadLists() {
    try {
      const [{ members }, { invitations }] = await Promise.all([Workspace.members(), Workspace.invitations()]);
      if (!dialog.isConnected || !dialog.open) return;
      membersView.innerHTML = members.length ? members.map(member => {
        const canManage = member.active && member.role !== 'owner' && member.email.toLowerCase() !== authenticatedEmail.toLowerCase()
          && (authenticatedRole === 'owner' || member.role !== 'admin');
        const memberRoleOptions = authenticatedRole === 'owner'
          ? [['admin', 'Admin'], ['operator', 'Operator'], ['reviewer', 'Reviewer']]
          : [['operator', 'Operator'], ['reviewer', 'Reviewer']];
        const controls = canManage ? `<div class="team-member-actions"><label class="sr-only" for="team-role-${member.id}">Role for ${escapeHtml(member.email)}</label><select id="team-role-${member.id}" data-team-role="${member.id}">${roleOptions(memberRoleOptions)}</select><button class="btn btn-ghost" data-team-save-role="${member.id}" type="button">Save role</button><button class="btn btn-ghost" data-team-deactivate="${member.id}" type="button">Deactivate</button></div>` : '';
        return `<article class="team-row"><div class="team-row-copy"><strong>${escapeHtml(member.email)}</strong><span>${escapeHtml(member.role)} · ${member.active ? 'Active' : 'Deactivated'}</span></div>${controls}</article>`;
      }).join('') : '<p class="team-empty">No workspace members yet.</p>';
      for (const select of membersView.querySelectorAll('[data-team-role]')) {
        const member = members.find(row => String(row.id) === select.dataset.teamRole);
        if (member && [...select.options].some(option => option.value === member.role)) select.value = member.role;
      }
      const visibleInvitations = invitations.filter(invitation => authenticatedRole === 'owner'
        || Number(invitation.invitedBy) === Number(authenticatedUserId));
      invitationsView.innerHTML = visibleInvitations.length ? visibleInvitations.map(invitation => {
        const canCancel = invitation.status === 'pending' && (authenticatedRole === 'owner'
          || (invitation.role !== 'admin' && Number(invitation.invitedBy) === Number(authenticatedUserId)));
        return `<article class="team-row"><div class="team-row-copy"><strong>${escapeHtml(invitation.email)}</strong><span>${escapeHtml(invitation.role)} · ${escapeHtml(invitation.status)} · expires ${escapeHtml(new Date(invitation.expiresAt).toLocaleString())}</span></div>${canCancel ? `<button class="btn btn-ghost" data-team-cancel-invite="${invitation.id}" type="button">Revoke</button>` : ''}</article>`;
      }).join('') : '<p class="team-empty">No invitations to show.</p>';
    } catch (error) {
      membersView.innerHTML = `<p class="auth-error" role="alert">${escapeHtml(error.message || 'Could not load workspace members.')}</p>`;
      invitationsView.innerHTML = '<p class="team-empty">Invitation list unavailable.</p>';
    }
  }

  body.querySelector('#team-invite-create').addEventListener('click', async event => {
    const button = event.currentTarget;
    const email = body.querySelector('#team-invite-email').value.trim();
    const role = body.querySelector('#team-invite-role').value;
    if (!email) return notify('Enter an email address for the invitation.', 'error');
    button.disabled = true;
    try {
      const { invitation } = await Workspace.invite({ email, role });
      tokenView.hidden = false;
      tokenView.innerHTML = `<strong>Share this one-time invitation token</strong><p>${escapeHtml(invitation.email)} · ${escapeHtml(invitation.role)} · expires ${escapeHtml(new Date(invitation.expiresAt).toLocaleString())}</p><textarea readonly aria-label="One-time invitation token">${escapeHtml(invitation.token)}</textarea><button class="btn btn-ghost" id="team-copy-token" type="button">Copy token</button>`;
      tokenView.querySelector('#team-copy-token').addEventListener('click', async () => {
        const tokenField = tokenView.querySelector('textarea');
        try {
          await navigator.clipboard.writeText(invitation.token);
          notify('Invitation token copied. Share it with the invited teammate.', 'success');
        } catch {
          tokenField.focus(); tokenField.select();
          notify('Token selected. Copy it and share it with the invited teammate.', 'success');
        }
      });
      body.querySelector('#team-invite-email').value = '';
      await reloadLists();
    } catch (error) {
      notify(error.message || 'Could not create the invitation.', 'error');
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  membersView.addEventListener('click', async event => {
    const roleButton = event.target.closest('[data-team-save-role]');
    const deactivateButton = event.target.closest('[data-team-deactivate]');
    if (roleButton) {
      roleButton.disabled = true;
      try {
        const id = roleButton.dataset.teamSaveRole;
        await Workspace.changeRole(id, membersView.querySelector(`[data-team-role="${id}"]`).value);
        notify('Workspace role updated.', 'success');
        await reloadLists();
      } catch (error) { notify(error.message || 'Could not change this role.', 'error'); }
      finally { if (roleButton.isConnected) roleButton.disabled = false; }
    }
    if (deactivateButton) {
      const id = deactivateButton.dataset.teamDeactivate;
      const member = id && membersView.querySelector(`[data-team-role="${id}"]`)?.closest('.team-row')?.querySelector('.team-row-copy strong')?.textContent;
      if (!await confirmAction({ title: `Deactivate ${member || 'workspace member'}`, message: 'Their active sessions will be revoked. Their account and audit history are retained.', confirmLabel: 'Deactivate member', danger: true })) return;
      deactivateButton.disabled = true;
      try {
        await Workspace.deactivateMember(id);
        notify('Member deactivated and active sessions revoked.', 'success');
        await reloadLists();
      } catch (error) { notify(error.message || 'Could not deactivate this member.', 'error'); }
      finally { if (deactivateButton.isConnected) deactivateButton.disabled = false; }
    }
  });
  invitationsView.addEventListener('click', async event => {
    const button = event.target.closest('[data-team-cancel-invite]');
    if (!button) return;
    button.disabled = true;
    try {
      await Workspace.cancelInvitation(button.dataset.teamCancelInvite);
      notify('Invitation revoked.', 'success');
      await reloadLists();
    } catch (error) { notify(error.message || 'Could not revoke the invitation.', 'error'); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  await reloadLists();
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
function showMfaChallenge(challenge, status, mode = 'login', email = '') {
  const app = document.getElementById('app');
  const expiry = Number(challenge?.expiresAt);
  const expiryText = Number.isFinite(expiry)
    ? `This challenge expires at ${new Date(expiry).toLocaleTimeString()}.` : 'This sign-in challenge expires in five minutes.';
  app.innerHTML = `<main class="auth-page"><section class="auth-card" aria-labelledby="auth-title">
    <div class="auth-brand">${brandMark}<span>odd<span>ecosys</span></span></div>
    <span class="eyebrow">SECOND FACTOR</span>
    <h1 id="auth-title">Verify it’s you</h1>
    <p class="auth-description">Enter the current code from your authenticator app or use one unused recovery code. ${escapeHtml(expiryText)}</p>
    <p class="auth-account-hint">${escapeHtml(challenge?.user?.email || email || '')}</p>
    <form id="mfa-challenge-form" class="auth-form" novalidate>
      <label>Authenticator or recovery code<input name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="32" inputmode="text" required autofocus></label>
      <button class="btn btn-primary auth-submit" type="submit">Verify and continue</button>
    </form>
    <button class="auth-text-button" type="button" data-auth-back>Return to sign in</button>
    <p class="auth-footnote">Each authenticator step or recovery code can be used once.</p>
  </section></main>`;
  const form = app.querySelector('#mfa-challenge-form');
  app.querySelector('[data-auth-back]')?.addEventListener('click', () => {
    showAuthScreen(status);
    const field = document.querySelector('#auth-form [name="email"]');
    if (field) field.value = email || challenge?.user?.email || '';
  });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const field = form.elements.code;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await Auth.completeMfaChallenge(challenge.challengeToken, field.value.trim());
      window.location.replace('/');
    } catch (failure) {
      let message = String(failure.message || failure).replace(/^API [^ ]+ failed: HTTP \d+ — /, '');
      try { message = JSON.parse(message).error || message; } catch { /* retain readable API detail */ }
      showMfaChallenge(challenge, status, mode, email);
      const nextForm = document.querySelector('#mfa-challenge-form');
      nextForm?.insertAdjacentHTML('beforebegin', `<p class="auth-error" role="alert">${escapeHtml(message.slice(0, 240))}</p>`);
      document.querySelector('#mfa-challenge-form [name="code"]')?.focus();
    } finally {
      const activeButton = document.querySelector('#mfa-challenge-form [type="submit"]');
      if (activeButton) activeButton.disabled = false;
    }
  });
}

function showAuthScreen(status, message = '', requestedMode = 'login', isSuccess = false) {
  const app = document.getElementById('app');
  const setup = status?.setupRequired === true;
  const available = status?.setupAvailable === true;
  const mode = setup ? 'setup' : requestedMode;
  const recoveryAvailable = status?.recoveryAvailable === true;
  const googleAvailable = status?.googleLoginAvailable === true && Boolean(status?.googleClientId);
  const invitationMode = mode === 'invite';
  const notice = message ? `<p class="${isSuccess ? 'auth-success' : 'auth-error'}" role="${isSuccess ? 'status' : 'alert'}">${escapeHtml(message)}</p>` : '';
  app.innerHTML = `<main class="auth-page"><section class="auth-card" aria-labelledby="auth-title">
    <div class="auth-brand">${brandMark}<span>odd<span>ecosys</span></span></div>
    <span class="eyebrow">LOCAL WORKSPACE ACCESS</span>
    <h1 id="auth-title">${mode === 'setup' ? 'Create your workspace account' : mode === 'recover' ? 'Recover account access' : invitationMode ? 'Accept a workspace invitation' : 'Sign in to your workspace'}</h1>
    <p class="auth-description">${mode === 'setup' ? (googleAvailable ? (available ? 'Create your workspace owner account with your verified Google account, or use the private setup token below.' : 'Create the workspace owner account with your verified Google account.') : 'Create the first local administrator account. Your password is stored as a one-way hash.') : mode === 'recover' ? 'Use the private recovery token configured by your server operator. A successful reset signs out existing sessions.' : invitationMode ? 'Enter the email and one-time invitation token shared by your workspace administrator. This local workspace does not send invitation email.' : 'Your workspace data is available after you sign in.'}</p>
    ${notice}
    ${setup && !available && !googleAvailable ? `<div class="auth-setup-help" role="note"><strong>First-account setup is locked.</strong><span>Set a private <code>ODD_AUTH_BOOTSTRAP_TOKEN</code> with at least 32 characters on the server, then restart it. This value is never generated or displayed by the app.</span></div>` : ''}
    ${googleAvailable && (mode === 'login' || setup) ? `<section class="google-signin" aria-label="Sign in with Google"><div id="google-signin-button" class="google-signin-button"></div><p class="google-signin-message" data-google-message role="status" aria-live="polite">Loading Google sign-in…</p></section><div class="auth-divider"><span>or use your password</span></div>` : ''}
    ${setup && !available ? '' : `<form id="auth-form" class="auth-form" novalidate>
      <label>Email address<input name="email" type="email" autocomplete="username" maxlength="254" required autofocus></label>
      ${setup && available ? '<label>Private setup token<input name="bootstrapToken" type="password" autocomplete="off" minlength="32" required></label>' : ''}
      ${invitationMode ? '<label>One-time invitation token<input name="invitationToken" type="password" autocomplete="off" minlength="32" maxlength="128" required></label>' : ''}
      ${mode === 'recover' ? '<label>Private recovery token<input name="recoveryToken" type="password" autocomplete="off" minlength="32" required></label>' : ''}
      <label>${mode === 'recover' || invitationMode ? 'New password' : 'Password'}<input name="password" type="password" autocomplete="${mode === 'setup' || mode === 'recover' || invitationMode ? 'new-password' : 'current-password'}" minlength="${mode === 'setup' || mode === 'recover' || invitationMode ? '12' : '1'}" maxlength="128" required></label>
      ${mode === 'setup' || mode === 'recover' || invitationMode ? '<label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>' : ''}
      <button class="btn btn-primary auth-submit" type="submit" ${mode === 'setup' && !available ? 'disabled' : ''}>${mode === 'setup' ? 'Create local account' : mode === 'recover' ? 'Reset password' : invitationMode ? 'Accept invitation' : 'Sign in'}</button>
    </form>`}
    ${mode === 'recover' || invitationMode ? '<button class="auth-text-button" type="button" data-auth-view="login">Return to sign in</button>' : mode === 'login' ? `${recoveryAvailable ? '<button class="auth-text-button" type="button" data-auth-view="recover">Forgot password? Use operator recovery token</button>' : ''}<button class="auth-text-button" type="button" data-auth-view="invite">Accept a workspace invitation</button>` : ''}
    <p class="auth-footnote">One local workspace · protected by a private session</p>
  </section></main>`;
  const form = app.querySelector('#auth-form');
  app.querySelector('[data-auth-view="login"]')?.addEventListener('click', () => showAuthScreen(status));
  app.querySelector('[data-auth-view="recover"]')?.addEventListener('click', () => showAuthScreen(status, '', 'recover'));
  app.querySelector('[data-auth-view="invite"]')?.addEventListener('click', () => showAuthScreen(status, '', 'invite'));
  const googleButton = app.querySelector('#google-signin-button');
  if (googleButton) void prepareGoogleSignin(status, mode, googleButton);
  if (!form || (mode === 'setup' && !available)) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get('email') || '');
    const password = String(data.get('password') || '');
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      if (mode === 'recover') {
        if (password !== String(data.get('confirmPassword') || '')) throw new Error('Passwords do not match.');
        const result = await Auth.recover({
          email,
          password,
          recoveryToken: String(data.get('recoveryToken') || ''),
        });
        return showAuthScreen(status, result.message, 'login', true);
      }
      if (invitationMode) {
        if (password !== String(data.get('confirmPassword') || '')) throw new Error('Passwords do not match.');
        const result = await Auth.acceptInvitation({
          email,
          password,
          invitationToken: String(data.get('invitationToken') || ''),
        });
        if (result.mfaRequired) return showMfaChallenge(result, status, mode, email);
        window.location.replace('/');
        return;
      }
      if (mode === 'setup') {
        if (password !== String(data.get('confirmPassword') || '')) throw new Error('Passwords do not match.');
        await Auth.bootstrap({ email, password, bootstrapToken: String(data.get('bootstrapToken') || '') });
      } else {
        const result = await Auth.login({ email, password });
        if (result.mfaRequired) return showMfaChallenge(result, status, mode, email);
      }
      window.location.replace('/');
    } catch (submitError) {
      let message = String(submitError.message || submitError).replace(/^API [^ ]+ failed: HTTP \d+ — /, '');
      try {
        const response = JSON.parse(message);
        message = response.error || response.message || message;
      } catch { /* keep non-JSON error text */ }
      if (mode === 'setup') {
        try {
          const latestStatus = await Auth.status();
          if (latestStatus.setupRequired !== true) {
            showAuthScreen(latestStatus, 'This workspace already has an account. Sign in with its Google account or password.');
            const latestEmailField = app.querySelector('[name="email"]');
            if (latestEmailField) latestEmailField.value = email;
            return;
          }
        } catch { /* Keep the original setup error when the status request also fails. */ }
      }
      showAuthScreen(status, message.slice(0, 240), mode);
      const emailField = app.querySelector('[name="email"]');
      if (emailField) emailField.value = email;
    } finally {
      const currentButton = app.querySelector('#auth-form [type="submit"]');
      if (currentButton) currentButton.disabled = mode === 'setup' && !available;
    }
  });
}

async function init() {
  const app = document.getElementById('app');
  window.addEventListener('api:error', event => {
    if (event.detail?.code !== 'UNAUTHORIZED' || event.detail?.path?.startsWith('/api/auth/')) return;
    Auth.status().then(status => { if (!status.authenticated) showAuthScreen(status, 'Your sign-in session ended. Sign in again to continue.'); }).catch(() => {});
  });
  let authStatus;
  try { authStatus = await Auth.status(); }
  catch (error) {
    return showAuthScreen({ setupRequired: false, setupAvailable: false }, `${error.message}. Check that the local workspace server is running, then reload.`);
  }
  if (!authStatus.authenticated) return showAuthScreen(authStatus);
  authenticatedEmail = authStatus.user?.email || '';
  authenticatedRole = authStatus.user?.role || '';
  authenticatedUserId = Number(authStatus.user?.id) || 0;
  window.__workspaceRole = authenticatedRole;

  window.__nav = navigate;
  app.innerHTML = buildSidebar() + `<div class="main-area">${buildHeader()}<main id="main-content" tabindex="-1" aria-label="Workspace content"></main></div>`;
  app.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  app.querySelector('.sidebar-logo').addEventListener('click', event => { event.preventDefault(); navigate('dashboard'); });
  app.querySelector('.mobile-menu').addEventListener('click', () => { const open = document.body.classList.toggle('navigation-open'); app.querySelector('.mobile-menu').setAttribute('aria-expanded', String(open)); syncNavigationAccessibility(); if (open) app.querySelector('.sidebar .nav-item.active')?.focus(); });
  app.querySelector('.nav-backdrop').addEventListener('click', closeNavigation);
  app.querySelector('.command-trigger').addEventListener('click', openCommands);
  app.querySelector('#workspace-account').addEventListener('click', openAccountSecurity);
  const logoutButton = app.querySelector('#workspace-logout');
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await Auth.logout();
      window.location.replace('/login');
    } catch (error) {
      logoutButton.disabled = false;
      notify(`Could not end this session: ${error.message || 'server unavailable'}`, 'error');
    }
  });
  app.querySelector('#workspace-refresh').addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; await Promise.all([navigate(currentView), updateStatus()]); button.disabled = false; });
  window.addEventListener('hashchange', () => { const route = location.hash.slice(1); if (views[route] && currentView !== route) navigate(route); });
  window.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); } if (event.key === 'Escape') closeNavigation(); });
  matchMedia('(max-width: 700px)').addEventListener('change', syncNavigationAccessibility);
  syncNavigationAccessibility();
  navigate(views[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
  updateStatus(); setInterval(updateStatus, 30000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
