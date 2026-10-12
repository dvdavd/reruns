import {html, render} from 'media-ui';
import {icon} from './icon.js';
import {post, request} from './api.js';
import {createDrawerControls, createDrawerAddControls} from './drawer.js';
import {anchorPopover} from './popover.js';
import {plural, t} from './i18n.js';

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
    so the list reads as a grid of who-can-what. The folders someone sees and a
    password reset are small menus off the same row. */
export function createAccountsUI({drawer, drawerClose, summary, list, form, report}) {
  let users = [];
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
  function toggle(user, key, label, glyph, {implied = false} = {}) {
    const on = implied || Boolean(user[key]);
    return html`<button type="button" role="switch" aria-checked=${String(on)} disabled=${implied}
      class=${`library-row-action${on ? ' active' : ''}`} aria-label=${label}
      title=${implied ? t('accounts.adminsAlways', {label}) : label}
      onClick=${() => change(user, {[key]: !user[key]})}>${glyph}</button>`;
  }

  const sameFolder = (grant, entry) => grant.library === entry.library && grant.folder === entry.path;
  // A folder is covered when it, or one above it in its library, is granted.
  const covers = (grant, entry) => grant.library === entry.library
    && (!grant.folder || entry.path === grant.folder || entry.path.startsWith(`${grant.folder}/`));

  // What the picker beside the search box offers, with each library's root as
  // "All videos" (the library's name when there are several to tell apart).
  // A granted folder that has since left the list stays choosable, rather
  // than quietly vanishing from the account on the next save.
  function folderEntries(user) {
    const several = new Set(directories.map(entry => entry.library)).size > 1;
    const entries = directories.map(entry => (entry.path || several ? entry : {...entry, name: t('accounts.allVideos')}));
    for (const grant of user.grants) {
      if (!entries.some(entry => sameFolder(grant, entry))) {
        entries.push({library: grant.library, path: grant.folder, name: grant.folder, count: 0});
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
  function toggleFolder(user, entry) {
    const grant = {library: entry.library, folder: entry.path};
    user.grants = user.grants.some(held => sameFolder(held, entry))
      ? user.grants.filter(held => !sameFolder(held, entry)) : [...user.grants, grant];
    show();
    change(user, {grants: user.grants});
  }

  const anchor = menu => {
    if (menu && !anchored.has(menu)) {
      anchored.add(menu);
      anchorPopover(menu.previousElementSibling, menu);
    }
  };

  function folderPicker(user) {
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
            style=${`--depth:${entry.path ? entry.path.split('/').length : 0}`}
            title=${implied ? t('accounts.included') : null}
            onClick=${() => implied || toggleFolder(user, entry)}>
            <span>${entry.name}</span><small>${entry.count}</small></button>`;
        })}
      </div>`;
  }

  // Asked twice, since a typo would lock them out. OIDC accounts have no
  // local password to set, so theirs is there for the columns' sake only.
  function passwordPopup(user) {
    const id = `account-password-${user.id}`;
    return html`<button type="button" class="library-row-action" aria-haspopup="dialog" aria-expanded="false"
        aria-controls=${id} popovertarget=${id} aria-label=${t('accounts.resetPassword')}
        title=${user.username ? t('accounts.resetPassword') : t('accounts.oidc')}
        disabled=${!user.username}>${icon('key')}</button>
      <form id=${id} class="menu-popover account-password-menu" popover="auto"
        aria-label=${t('accounts.newPasswordFor', {name: user.name})} ref=${anchor}
        onToggle=${event => {
          if (event.newState === 'open') event.currentTarget.elements.password.focus();
          else event.currentTarget.reset();
        }}
        onSubmit=${async event => {
          event.preventDefault();
          const form = event.currentTarget;
          if (form.elements.password.value !== form.elements.repeat.value) {
            form.elements.repeat.setCustomValidity(t('accounts.mismatch'));
            form.elements.repeat.reportValidity();
            return;
          }
          if (await change(user, {password: form.elements.password.value})) {
            form.hidePopover();
            report(t('accounts.passwordChanged'));
          }
        }}>
        <input type="password" name="password" minlength="12" required autocomplete="new-password"
          aria-label=${t('accounts.newPassword')} placeholder=${t('accounts.newPasswordHint')}/>
        <input type="password" name="repeat" required autocomplete="new-password"
          aria-label=${t('accounts.repeatLabel')} placeholder=${t('accounts.repeat')}
          onInput=${event => event.currentTarget.setCustomValidity('')}/>
        <button class="profile-save" type="submit">${t('accounts.setPassword')}</button>
      </form>`;
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
          <button type="button" role="switch" aria-checked=${String(user.role === 'admin')}
            class=${`library-row-action${user.role === 'admin' ? ' active' : ''}`} aria-label=${t('accounts.admin')}
            title=${user.role === 'admin' ? t('accounts.adminTitle') : t('accounts.makeAdmin')}
            onClick=${() => change(user, {role: user.role === 'admin' ? 'user' : 'admin'})}>${shield}</button>
          ${folderPicker(user)}
          ${passwordPopup(user)}
        </span>
      </div>
    </li>`;
  }

  function show() {
    summary.textContent = accountsSummary(users);
    render(users.length ? html`<ul class="library-list account-list">${users.map(row)}</ul>`
      : html`<p class="download-empty">${t('accounts.empty')}</p>`, list);
  }

  async function refresh() {
    try {
      [users, directories] = await Promise.all([request('/api/auth/users'), request('/api/directories')]);
      show();
    } catch (error) {
      report(t('error.reason', {message: t('accounts.error.load'), reason: error.message || error}), {error: true});
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (await act('/api/auth/users', data, 'accounts.error.add')) { form.reset(); addControls.hide(); }
  });

  const addControls = createDrawerAddControls(drawer.querySelector('#accounts-new'), form);
  const {open: openDrawer, close} = createDrawerControls(drawer);
  drawerClose.addEventListener('click', close);
  return {open() { addControls.hide(); openDrawer(); refresh(); }, close, refresh};
}
