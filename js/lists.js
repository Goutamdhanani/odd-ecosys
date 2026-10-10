import { Leads, Lists, fmtNum, relTime } from './api.js';
import { escapeHtml, icon, notify, openDialog } from './ui.js';

const MEMBER_PAGE_SIZE = 50;

export async function renderLists(container) {
  let lists = [];
  let activeId = null;
  let listSearch = '';
  let memberSearch = '';
  let memberOffset = 0;
  let memberHasMore = false;
  let members = [];
  let requestVersion = 0;
  let listRequestVersion = 0;

  container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading contact lists…</span></div>`;

  async function loadLists() {
    const version = ++listRequestVersion;
    const result = await Lists.list({ search: listSearch, limit: 100 });
    if (version !== listRequestVersion) return;
    lists = result.items || [];
    if (activeId && !lists.some(item => item.id === activeId)) activeId = null;
    if (!activeId && lists.length) activeId = lists[0].id;
  }

  async function loadMembers({ append = false } = {}) {
    if (!activeId) { members = []; memberHasMore = false; return; }
    const requestedId = activeId;
    const version = ++requestVersion;
    const offset = append ? memberOffset : 0;
    const result = await Lists.members(requestedId, { search: memberSearch, limit: MEMBER_PAGE_SIZE, offset });
    if (version !== requestVersion || requestedId !== activeId) return;
    members = append ? [...members, ...(result.items || [])] : (result.items || []);
    memberOffset = result.pagination?.offset + result.pagination?.limit || members.length;
    memberHasMore = result.pagination?.hasMore === true;
  }

  function draw() {
    const selected = lists.find(item => item.id === activeId) || null;
    container.innerHTML = `
      <div class="section-header mb-16">
        <div><h1 class="section-title">Contact lists</h1><div class="section-sub">Keep people organized into reusable audiences. Removing someone from a list never deletes the contact or changes suppression.</div></div>
        <button class="btn btn-primary btn-sm" data-create-list>${icon('plus', 15)} New list</button>
      </div>
      <div class="contact-lists-layout">
        <aside class="glass-panel contact-lists-sidebar" aria-label="Saved contact lists">
          <div class="contact-lists-sidebar-head"><span class="panel-title">Your lists</span><span class="badge">${fmtNum(lists.length)}</span></div>
          <label class="contact-list-search"><span class="sr-only">Search lists</span><input class="filter-input" type="search" data-list-search placeholder="Find a list…" value="${escapeHtml(listSearch)}"></label>
          <div class="contact-list-items">
            ${lists.length ? lists.map(item => `
              <button class="contact-list-item ${item.id === activeId ? 'is-selected' : ''}" type="button" data-select-list="${item.id}" aria-current="${item.id === activeId ? 'true' : 'false'}">
                <span class="contact-list-item-icon">${icon('people', 17)}</span>
                <span class="contact-list-item-copy"><strong>${escapeHtml(item.name)}</strong><small>${fmtNum(item.contact_count)} contacts · ${item.status === 'archived' ? 'Archived' : 'Active'}</small></span>
                <span class="contact-list-item-arrow">›</span>
              </button>`).join('') : `<div class="contact-list-empty"><span>${icon('layers', 21)}</span><strong>${listSearch ? 'No matching lists' : 'Your first list starts here'}</strong><p>${listSearch ? 'Try another name.' : 'Create a list to gather contacts for future campaign audiences.'}</p></div>`}
          </div>
        </aside>
        <section class="glass-panel contact-list-detail" aria-live="polite">
          ${selected ? renderListDetail(selected, members, memberHasMore) : `
            <div class="contact-list-empty contact-list-empty-main"><span>${icon('people', 26)}</span><h2>No list selected</h2><p>Create a contact list, or clear your search to choose an existing one.</p></div>`}
        </section>
      </div>`;

    container.querySelector('[data-create-list]')?.addEventListener('click', openCreateDialog);
    container.querySelector('[data-list-search]')?.addEventListener('input', onListSearch);
    container.querySelectorAll('[data-select-list]').forEach(button => button.addEventListener('click', async () => {
      activeId = Number(button.dataset.selectList);
      memberSearch = '';
      memberOffset = 0;
      try { await loadMembers(); draw(); } catch (error) { notify(error.message, 'error'); }
    }));
    container.querySelector('[data-edit-list]')?.addEventListener('click', openEditDialog);
    container.querySelector('[data-export-list]')?.addEventListener('click', exportList);
    container.querySelector('[data-toggle-archive]')?.addEventListener('click', toggleArchive);
    container.querySelector('[data-add-contacts]')?.addEventListener('click', openContactPicker);
    container.querySelector('[data-member-search]')?.addEventListener('input', onMemberSearch);
    container.querySelectorAll('[data-remove-member]').forEach(button => button.addEventListener('click', removeMember));
    container.querySelector('[data-load-more]')?.addEventListener('click', loadMoreMembers);
  }

  function renderListDetail(list, rows, hasMore) {
    return `
      <header class="contact-list-detail-head">
        <div class="contact-list-title-block">
          <span class="eyebrow">${list.status === 'archived' ? 'ARCHIVED LIST' : 'CONTACT AUDIENCE'}</span>
          <h2>${escapeHtml(list.name)}</h2>
          <p>${escapeHtml(list.description || 'A reusable group of contacts.')}</p>
          <div class="contact-list-meta"><span>${fmtNum(list.contact_count)} contacts</span><span>Created ${relTime(list.created_at)}</span></div>
        </div>
        <div class="contact-list-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-edit-list>${icon('diagonal', 14)} Edit</button>
          <button class="btn btn-ghost btn-sm" type="button" data-export-list>${icon('download', 14)} Export CSV</button>
          <button class="btn btn-ghost btn-sm" type="button" data-toggle-archive>${list.status === 'archived' ? 'Restore list' : 'Archive list'}</button>
          ${list.status === 'active' ? `<button class="btn btn-primary btn-sm" type="button" data-add-contacts>${icon('plus', 14)} Add contacts</button>` : ''}
        </div>
      </header>
      <div class="contact-list-members-head"><div><h3>People in this list</h3><span>${memberSearch ? 'Filtered results' : 'Membership is saved to your workspace database.'}</span></div><label><span class="sr-only">Search contacts in this list</span><input class="filter-input" type="search" data-member-search placeholder="Search people…" value="${escapeHtml(memberSearch)}"></label></div>
      ${rows.length ? `
        <div class="table-wrap contact-list-members-table"><table><thead><tr><th>Contact</th><th>Email</th><th>Location</th><th>Pipeline stage</th><th>Added</th><th></th></tr></thead><tbody>
          ${rows.map(person => `<tr><td><span class="td-name">${escapeHtml(person.business_name)}</span></td><td>${escapeHtml(person.email || '—')}</td><td>${escapeHtml([person.city, person.country].filter(Boolean).join(', ') || '—')}</td><td><span class="status-badge">${escapeHtml(person.status || 'discovered')}</span></td><td class="text-muted">${escapeHtml(relTime(person.added_at))}</td><td><button type="button" class="btn btn-ghost btn-sm contact-list-remove" data-remove-member="${person.id}" aria-label="Remove ${escapeHtml(person.business_name)} from this list">Remove</button></td></tr>`).join('')}
        </tbody></table></div>
        ${hasMore ? `<div class="contact-list-load-more"><button type="button" class="btn btn-ghost btn-sm" data-load-more>Load more contacts</button></div>` : ''}` : `
        <div class="contact-list-empty contact-list-empty-main"><span>${icon('people', 25)}</span><h3>${memberSearch ? 'No matching contacts' : 'This list is empty'}</h3><p>${memberSearch ? 'Change the search to find another member.' : list.status === 'archived' ? 'Restore this list before adding contacts.' : 'Add existing contacts here. They remain in your contact records when removed from this list.'}</p></div>`}`;
  }

  function openCreateDialog() {
    openDialog({
      title: 'Create a contact list', eyebrow: 'ORGANIZE YOUR CONTACTS', submitLabel: 'Create list',
      body: `<label class="form-label" for="list-name">List name</label><input class="form-input" id="list-name" name="name" maxlength="120" required placeholder="Q4 product launch"><label class="form-label" for="list-description">Description <span class="text-muted">Optional</span></label><textarea class="form-input" id="list-description" name="description" maxlength="1000" rows="3" placeholder="Who belongs in this audience?"></textarea>`,
      onSubmit: async form => {
        const item = await Lists.create({ name: form.get('name'), description: form.get('description') || '' });
        listSearch = ''; activeId = item.id; memberSearch = ''; memberOffset = 0;
        await refresh(); notify('Contact list created.');
      },
    });
  }

  function openEditDialog() {
    const item = lists.find(value => value.id === activeId);
    if (!item) return;
    openDialog({
      title: 'Edit contact list', eyebrow: 'LIST SETTINGS', submitLabel: 'Save changes',
      body: `<label class="form-label" for="list-name">List name</label><input class="form-input" id="list-name" name="name" maxlength="120" required value="${escapeHtml(item.name)}"><label class="form-label" for="list-description">Description</label><textarea class="form-input" id="list-description" name="description" maxlength="1000" rows="3">${escapeHtml(item.description || '')}</textarea>`,
      onSubmit: async form => { await Lists.update(item.id, { name: form.get('name'), description: form.get('description') || '' }); await refresh(); notify('List changes saved.'); },
    });
  }

  async function toggleArchive() {
    const item = lists.find(value => value.id === activeId);
    if (!item) return;
    const status = item.status === 'archived' ? 'active' : 'archived';
    try {
      await Lists.update(item.id, { status });
      await refresh();
      notify(status === 'archived' ? 'List archived. Its contacts and membership were kept.' : 'List restored.');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function exportList() {
    if (!activeId) return;
    const item = lists.find(value => value.id === activeId);
    try {
      const { blob, filename } = await Lists.exportCsv(activeId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`${fmtNum(item?.contact_count || 0)} list contact(s) exported. Verification status is included; no email is sent.`);
    } catch (error) { notify(error.message, 'error'); }
  }

  async function openContactPicker() {
    if (!activeId) return;
    const selectedIds = new Set();
    let searchTimer;
    let searchVersion = 0;
    const dialog = openDialog({
      title: 'Add contacts', eyebrow: 'ADD TO LIST', submitLabel: 'Add selected contacts',
      body: `<p class="contact-picker-intro">Choose existing contacts. This only adds list membership; it does not start a campaign or send email.</p><label class="form-label" for="contact-picker-search">Find contacts</label><input class="form-input" id="contact-picker-search" type="search" autocomplete="off" placeholder="Name, email, or city"><div id="contact-picker-results" class="contact-picker-results" aria-live="polite"><div class="loading-state">Loading contacts…</div></div>`,
      onSubmit: async () => {
        if (!selectedIds.size) throw new Error('Select at least one contact.');
        const result = await Lists.addMembers(activeId, [...selectedIds]);
        await refresh();
        notify(`${result.added} added · ${result.alreadyMember} already on the list.`);
      },
    });
    const input = dialog.querySelector('#contact-picker-search');
    const results = dialog.querySelector('#contact-picker-results');
    const renderResults = async query => {
      const version = ++searchVersion;
      results.innerHTML = `<div class="loading-state contact-picker-loading"><div class="spinner"></div><span>Searching contacts…</span></div>`;
      try {
        const response = await Leads.list({ search: query, limit: 50, offset: 0 });
        if (version !== searchVersion || !dialog.isConnected) return;
        const contacts = response.leads || [];
        results.innerHTML = contacts.length ? contacts.map(person => `
          <label class="contact-picker-row"><input type="checkbox" name="contact-choice" value="${person.id}" ${selectedIds.has(person.id) ? 'checked' : ''}><span><strong>${escapeHtml(person.business_name)}</strong><small>${escapeHtml(person.email || 'No email')} · ${escapeHtml(person.city || 'Location unknown')}</small></span><span class="contact-picker-stage">${escapeHtml(person.status || 'discovered')}</span></label>`).join('') : `<div class="contact-list-empty"><strong>No contacts found</strong><p>Try another name, email, or city.</p></div>`;
        results.querySelectorAll('input[type="checkbox"]').forEach(box => box.addEventListener('change', () => { if (box.checked) selectedIds.add(Number(box.value)); else selectedIds.delete(Number(box.value)); }));
      } catch (error) {
        if (version === searchVersion) results.innerHTML = `<div class="contact-list-empty"><strong>Contacts could not load</strong><p>${escapeHtml(error.message)}</p></div>`;
      }
    };
    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderResults(input.value.trim()), 220); });
    renderResults('');
  }

  async function removeMember(event) {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      await Lists.removeMember(activeId, button.dataset.removeMember);
      await refresh();
      notify('Contact removed from this list.');
    } catch (error) { button.disabled = false; notify(error.message, 'error'); }
  }

  async function loadMoreMembers() {
    try { await loadMembers({ append: true }); draw(); } catch (error) { notify(error.message, 'error'); }
  }

  let listSearchTimer;
  function onListSearch(event) {
    clearTimeout(listSearchTimer);
    listSearchTimer = setTimeout(async () => {
      listSearch = event.currentTarget.value.trim();
      try { await loadLists(); await loadMembers(); draw(); } catch (error) { notify(error.message, 'error'); }
    }, 180);
  }

  let memberSearchTimer;
  function onMemberSearch(event) {
    clearTimeout(memberSearchTimer);
    memberSearchTimer = setTimeout(async () => {
      memberSearch = event.currentTarget.value.trim(); memberOffset = 0;
      try { await loadMembers(); draw(); } catch (error) { notify(error.message, 'error'); }
    }, 180);
  }

  async function refresh() {
    await loadLists();
    await loadMembers();
    draw();
  }

  await refresh();
}
