import {html, render} from 'media-ui';
import {icon} from './icon.js';
import {post, request} from './api.js';
import {createDrawerAddControls, createDrawerControls} from './drawer.js';
import {anchorPopover} from './popover.js';
import {locale, plural, t} from './i18n.js';
import {createPasswordField} from './password-field.js';

// The library a grant names to mean every library, those added later too
// (ALL_LIBRARIES in auth.py).
const ALL_LIBRARIES = '*';

export function accountsSummary(users) {
  if (!users.length) return t('accounts.none');
  const pending = users.filter(user => !user.enabled && !user.ever_approved).length;
  const count = plural('count.accounts', users.length);
  return pending ? t('accounts.summaryPending', {count, pending}) : count;
}

/* Not in the shared sprite, so drawn inline like the profiles' star. */
const shield = html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"/></svg>`;
const tick = html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>`;

/** Who may sign in, and what each of them may do once they have. A permission
    is a round switch on the account's own row, saved the moment it is flipped,
    so the list reads as a grid of who-can-what. The folders someone sees are a
    small menu off the same row, a password reset opens the password dialog,
    and deleting it ends it. New accounts are added, or invited, from editors
    that fold out of the heading, as folders and profiles are. */
export function createAccountsUI({drawer, drawerClose, addButton, addForm, inviteButton, inviteForm, summary, list,
  passwords, report, selfId}) {
  let users = [];
  let invites = [];
  const anchored = new WeakSet();
  // What the folder picker beside the search box offers, as the server lists it.
  let directories = [];
  async function act(path, body, failure) {
    try {
      await post(path, body);
      await refresh();
      return true;
    } catch (error) {
      report(t('error.reason', {message: t(failure), reason: error.message || error}), {error: true});
      // Put right anything shown ahead of the server's answer.
      refresh();
      return false;
    }
  }

  const change = (user, changes) => act(`/api/auth/users/${user.id}`, changes, 'accounts.error.change');

  // Admins can always download new media, so their permission switch stays
  // lit and unavailable, and the columns still line up.
  function toggle(user, key, label, glyph, {implied = false, save = changes => change(user, changes)} = {}) {
    const on = implied || Boolean(user[key]);
    return html`<button type="button" role="switch" aria-checked=${String(on)} disabled=${implied}
      class=${`library-row-action${on ? ' active' : ''}`} aria-label=${label}
      title=${implied ? t('accounts.adminsAlways', {label}) : label}
      onClick=${() => save({[key]: !user[key]})}>${glyph}</button>`;
  }

  function adminSwitch(user, save) {
    const admin = user.role === 'admin';
    return html`<button type="button" role="switch" aria-checked=${String(admin)}
      class=${`library-row-action${admin ? ' active' : ''}`} aria-label=${t('accounts.admin')}
      title=${admin ? t('accounts.adminTitle') : t('accounts.makeAdmin')}
      onClick=${() => save({role: admin ? 'user' : 'admin'})}>${shield}</button>`;
  }

  const sameFolder = (grant, entry) => grant.library === entry.library && grant.folder === entry.path;
  // A folder is covered when it, or one above it in its library, is granted,
  // or when every library is.
  const covers = (grant, entry) => grant.library === ALL_LIBRARIES || grant.library === entry.library
    && (!grant.folder || entry.path === grant.folder || entry.path.startsWith(`${grant.folder}/`));

  // What the picker beside the search box offers, under "All videos": every
  // library, those added later too, which is where accounts start. Each
  // library follows by name, even when there is only one, so two rows are
  // never both called "All videos" while granting different things. A
  // granted folder that has since left the list stays choosable, rather than
  // quietly vanishing from the account on the next save.
  function folderEntries(user) {
    const entries = [{library: ALL_LIBRARIES, path: '', name: t('accounts.allVideos'), depth: 0,
      count: directories.filter(entry => !entry.path).reduce((total, entry) => total + entry.count, 0)},
    ...directories.map(entry => ({...entry, depth: (entry.path ? entry.path.split('/').length : 0) + 1}))];
    for (const grant of user.grants) {
      if (!entries.some(entry => sameFolder(grant, entry))) {
        entries.push({library: grant.library, path: grant.folder, name: grant.folder, count: 0, depth: 0});
      }
    }
    return entries;
  }

  function folderLabel(user, entries) {
    if (user.role === 'admin') return t('accounts.adminFolders');
    const chosen = entries.filter(entry => user.grants.some(grant => sameFolder(grant, entry)));
    if (!chosen.length) return t('accounts.visibleNone');
    return t('accounts.visible', {names: chosen.length === 1 ? chosen[0].name : plural('count.folders', chosen.length)});
  }

  // Each choice is saved as it is made and the menu stays open, so several
  // folders can be ticked in one go. The row is updated before the server
  // answers, or a second click would build on the grants from before the first.
  function toggleFolder(user, entry, save) {
    const grant = {library: entry.library, folder: entry.path};
    user.grants = user.grants.some(held => sameFolder(held, entry))
      ? user.grants.filter(held => !sameFolder(held, entry)) : [...user.grants, grant];
    save(user.grants);
  }

  const anchor = menu => {
    if (menu && !anchored.has(menu)) {
      anchored.add(menu);
      anchorPopover(menu.previousElementSibling, menu);
    }
  };

  function folderPicker(user, save = grants => { show(); change(user, {grants}); }) {
    const entries = folderEntries(user);
    const id = `account-folders-${user.id}`;
    const label = folderLabel(user, entries);
    return html`<button type="button" class="library-row-action" aria-haspopup="menu" aria-expanded="false"
        aria-controls=${id} popovertarget=${id} aria-label=${t('accounts.visibleFolders')} title=${label}
        disabled=${user.role === 'admin'}>${icon('folders')}</button>
      <div id=${id} class="menu-popover directory-menu" popover="auto" role="menu" aria-label=${t('accounts.visibleFolders')}
        ref=${anchor}>
        ${entries.map(entry => {
          const held = user.grants.some(grant => sameFolder(grant, entry));
          const implied = !held && user.grants.some(grant => covers(grant, entry));
          return html`<button type="button" role="menuitemcheckbox" key=${`${entry.library}/${entry.path}`}
            aria-checked=${String(held || implied)} aria-disabled=${String(implied)}
            style=${`--depth:${entry.depth}`}
            title=${implied ? t('accounts.included') : null}
            onClick=${() => implied || toggleFolder(user, entry, save)}>
            <span>${entry.name}</span><small>${entry.count}</small></button>`;
        })}
      </div>`;
  }

  // In the shared password dialog, asked once with a reveal rather than
  // twice. OIDC accounts have no local password to set, so theirs is there
  // for the columns' sake only.
  function passwordButton(user) {
    return html`<button type="button" class="library-row-action" aria-haspopup="dialog"
        aria-label=${t('accounts.resetPassword')}
        title=${user.username ? t('accounts.resetPassword') : t('accounts.oidc')}
        disabled=${!user.username}
        onClick=${() => passwords.ask({
          with: [],
          title: t('accounts.newPasswordFor', {name: user.name}),
          submit: t('accounts.setPassword'),
          send: async ({password}) => { await post(`/api/auth/users/${user.id}`, {password}); refresh(); },
          done: t('accounts.passwordChanged'),
        })}>${icon('key')}</button>`;
  }

  // Your own account is left to another admin, as the last admin is. An OIDC
  // identity the provider still vouches for is back at its next sign-in, so
  // its warning points at disabling instead.
  function deleteButton(user) {
    const own = user.id === selfId;
    return html`<button type="button" class="library-row-action danger" disabled=${own}
      aria-label=${t('accounts.delete')} title=${own ? t('accounts.deleteOwn') : t('accounts.delete')}
      onClick=${() => {
        if (confirm(t(user.username ? 'accounts.confirmDelete' : 'accounts.confirmDeleteOidc', {name: user.name}))) {
          act(`/api/auth/users/${user.id}/delete`, {}, 'accounts.error.delete');
        }
      }}>${icon('trash')}</button>`;
  }

  function row(user) {
    const implied = user.role === 'admin';
    return html`<li class="account-row" key=${user.id} data-disabled=${String(!user.enabled)}>
      <div class="account-line">
        <div class="library-row-text">
          <span class="account-name">${user.name}</span>
          <small class="account-meta">${[user.username ? `@${user.username}` : 'OIDC',
            user.role === 'admin' ? t('accounts.admin') : null,
            user.enabled ? t('accounts.enabled') : user.ever_approved ? t('accounts.disabled') : t('accounts.awaiting')].filter(Boolean).join(' · ')}</small>
        </div>
        <span class="library-row-actions account-switches">
          <button type="button" role="switch" aria-checked=${String(Boolean(user.enabled))}
            class=${`library-row-action${user.enabled ? ' active' : ''}`} aria-label=${t('accounts.accountEnabled')}
            title=${user.enabled ? t('accounts.enabledTitle') : t('accounts.enable')}
            onClick=${() => change(user, {enabled: !user.enabled})}>${tick}</button>
          ${toggle(user, 'fetch', t('accounts.mayDownload'), icon('download'), {implied})}
          ${adminSwitch(user, changes => change(user, changes))}
          ${folderPicker(user)}
          ${passwordButton(user)}
          ${deleteButton(user)}
        </span>
      </div>
    </li>`;
  }

  // What an account made from an invite starts with, in the words of the
  // switches it was chosen with.
  function accessSummary(access) {
    return [access.role === 'admin' ? t('accounts.admin') : null,
      access.role !== 'admin' && access.fetch ? t('accounts.mayDownload') : null,
      access.role === 'admin' ? null : folderLabel(access, folderEntries(access))].filter(Boolean);
  }

  // An invite not yet used, until it is or it lapses. Its link is not here:
  // the server keeps only the hash, so a lost link is revoked and made again.
  function inviteRow(invite) {
    return html`<li class="account-row" key=${`invite-${invite.id}`}>
      <div class="account-line">
        <div class="library-row-text">
          <span class="account-name">${t('accounts.invite.row')}</span>
          <small class="account-meta">${[t('accounts.invite.expires', {date: new Date(invite.expires * 1000).toLocaleString(locale(), {
            day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'})}), ...accessSummary(invite)].join(' · ')}</small>
        </div>
        <span class="library-row-actions">
          <button type="button" class="library-row-action danger" aria-label=${t('accounts.invite.revoke')}
            title=${t('accounts.invite.revoke')}
            onClick=${() => act(`/api/auth/invites/${invite.id}/delete`, {}, 'accounts.error.revoke')}>${icon('trash')}</button>
        </span>
      </div>
    </li>`;
  }

  function show() {
    summary.textContent = accountsSummary(users);
    render(html`${users.length ? html`<ul class="library-list account-list">${users.map(row)}</ul>`
        : html`<p class="download-empty">${t('accounts.empty')}</p>`}
      ${invites.length ? html`<h3 class="account-invites-heading">${t('accounts.invites')}</h3>
        <ul class="library-list account-list">${invites.map(inviteRow)}</ul>` : null}`, list);
  }

  async function refresh() {
    try {
      [users, directories, invites] = await Promise.all([request('/api/auth/users'), request('/api/directories'),
        request('/api/auth/invites')]);
      show();
    } catch (error) {
      report(t('error.reason', {message: t('accounts.error.load'), reason: error.message || error}), {error: true});
    }
  }

  // The server's refusal is shown in the editor rather than as a toast, so it
  // sits beside the field it is about and the form stays filled in.
  const failer = form => {
    const message = form.querySelector('[data-form-message]');
    form.addEventListener('input', () => { message.textContent = ''; });
    return text => { message.textContent = text; };
  };

  const password = createPasswordField(addForm.querySelector('[data-account-password]'));
  const addFail = failer(addForm);
  const adding = createDrawerAddControls(addButton, addForm);
  function resetAdd() { addForm.reset(); password.hide(); addFail(''); }
  addForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = addForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await post('/api/auth/users', Object.fromEntries(new FormData(addForm)));
      resetAdd();
      adding.hide();
      report(t('accounts.added'));
      refresh();
    } catch (error) {
      addFail(error.message || String(error));
    } finally {
      submit.disabled = false;
    }
  });

  // The link is shown once, since the server keeps only its hash; a lost one
  // is revoked from the list and made again.
  const inviteLink = inviteForm.querySelector('[data-invite-link]');
  const linkInput = inviteLink.querySelector('input');
  const inviteSubmit = inviteForm.querySelector('[data-invite-submit]');
  const inviteFail = failer(inviteForm);
  const inviting = createDrawerAddControls(inviteButton, inviteForm);
  // What the account will start with, chosen with the same switches and
  // folder menu as an account's row and sent along when the link is made.
  const accessHolder = inviteForm.querySelector('[data-invite-access]');
  // Every library, as an account added by hand starts.
  const freshAccess = () => ({id: 'invite', role: 'user', fetch: false, grants: [{library: ALL_LIBRARIES, folder: ''}]});
  let access = freshAccess();
  function showAccess() {
    const update = changes => { Object.assign(access, changes); showAccess(); };
    const made = !inviteLink.hidden;
    render(html`<div class="account-line">
        <div class="library-row-text">
          <span class="account-name">${t('accounts.invite.access')}</span>
          <small class="account-meta">${accessSummary(access).join(' · ')}</small>
        </div>
        <span class="library-row-actions account-switches" inert=${made}>
          ${toggle(access, 'fetch', t('accounts.mayDownload'), icon('download'), {implied: access.role === 'admin', save: update})}
          ${adminSwitch(access, update)}
          ${folderPicker(access, () => showAccess())}
        </span>
      </div>`, accessHolder);
  }
  function resetInvite() {
    linkInput.value = '';
    inviteLink.hidden = true;
    inviteSubmit.textContent = t('accounts.invite.create');
    inviteFail('');
    access = freshAccess();
    showAccess();
  }
  inviteForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!inviteLink.hidden) { inviting.hide(); return; }
    inviteSubmit.disabled = true;
    try {
      const {token} = await post('/api/auth/invites', {role: access.role, fetch: access.fetch, grants: access.grants});
      linkInput.value = new URL(`/auth.html#invite=${token}`, location.origin).href;
      inviteLink.hidden = false;
      showAccess();
      inviteSubmit.textContent = t('common.done');
      linkInput.select();
      refresh();
    } catch (error) {
      inviteFail(t('error.reason', {message: t('accounts.error.invite'), reason: error.message || error}));
    } finally {
      inviteSubmit.disabled = false;
    }
  });
  inviteForm.querySelector('[data-invite-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
    } catch {
      // No clipboard API outside a secure origin, which a server on the
      // local network often is: the older copy command still works there.
      linkInput.select();
      if (!document.execCommand('copy')) return;
    }
    report(t('accounts.invite.copied'));
  });

  // One editor at a time, each starting afresh. The toggle's own listener ran
  // first, so the one whose button this was is already open or shut.
  addButton.addEventListener('click', () => { inviting.hide(); resetInvite(); });
  // The folder menu offers what the server lists, so it is asked afresh.
  inviteButton.addEventListener('click', () => { adding.hide(); resetAdd(); resetInvite(); refresh().then(showAccess); });
  function hideEditors() { adding.hide(); inviting.hide(); resetAdd(); resetInvite(); }

  const {open: openDrawer, close} = createDrawerControls(drawer);
  drawerClose.addEventListener('click', close);
  return {open() { hideEditors(); openDrawer(); refresh(); }, close, refresh};
}
