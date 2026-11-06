import {post} from './api.js';
import {membershipsOf} from './playlists.js';
import {playlistSuggestions} from './playlist-editor-model.js';
import {createDrawerControls} from './drawer.js';
import {escapeMarkup, html, MediaRow, render} from 'media-ui';
import {icon, iconMarkup} from './icon.js';
import {createAnchoredMenu} from './popover.js';
import {plural, t} from './i18n.js';

const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const videoCount = count => plural('count.videos', count);

/** One draft playlist per panel, saved before returning to the gallery. */
export function createPlaylistEditor({items, playlists, reload, onCreated}) {
  const drawer = node('dialog', '', 'download-drawer playlist-editor');
  drawer.id = 'playlist-editor';
  drawer.setAttribute('aria-labelledby', 'playlist-editor-title');
  document.body.append(drawer);
  let busy = false;
  // Set by edit() to hold a close back while there are unsaved changes; it
  // returns true when it has taken the attempt over.
  let guard = null;
  // Stand down a half-made delete and a half-made discard; set by edit().
  let disarmDelete = () => {};
  let disarmDiscard = () => {};
  // Pressing anywhere but the armed button cancels the question it asked.
  drawer.addEventListener('click', event => {
    const pressed = event.target.closest?.('button');
    if (!pressed?.classList.contains('playlist-delete')) disarmDelete();
    if (!pressed?.classList.contains('playlist-close')) disarmDiscard();
  });
  drawer.addEventListener('cancel', event => {
    if (busy || guard?.()) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, {capture: true});
  drawer.addEventListener('click', event => {
    // Only the dimmed page beside the panel closes it (drawer.js); a click on
    // an empty spot inside the panel also targets the dialog, and is not a leave.
    if (event.target !== drawer || event.clientX >= drawer.getBoundingClientRect().left) return;
    if (busy || guard?.()) event.stopImmediatePropagation();
  }, {capture: true});
  const controls = createDrawerControls(drawer);

  function button(label, action, className = 'confirm-dialog-button', glyph = '') {
    const element = node('button', glyph ? '' : label, className);
    element.type = 'button';
    if (glyph) {
      element.innerHTML = iconMarkup(glyph);
      element.setAttribute('aria-label', label);
      element.title = label;
    }
    element.addEventListener('click', action);
    return element;
  }
  // The header's primary action, in the slot "Add folder" and "New profile"
  // take in the other drawers.
  function headerAction(label, action) {
    const element = node('button', '', 'profile-add drawer-add');
    element.type = 'button';
    element.innerHTML = `${iconMarkup('device-floppy')}${escapeMarkup(label)}`;
    element.addEventListener('click', action);
    return element;
  }
  function shell(title) {
    guard = null;
    disarmDelete = () => {};
    disarmDiscard = () => {};
    drawer.replaceChildren();
    const header = node('div', '', 'download-drawer-head');
    const headingBlock = node('div', '', 'drawer-heading-block');
    const identity = node('div', '', 'playlist-editor-identity');
    const heading = node('h2', title);
    heading.id = 'playlist-editor-title';
    const summary = node('p');
    identity.append(heading, summary);
    const actions = node('div', '', 'download-drawer-actions');
    const close = button(t('pl.close'), () => {
      if (!busy && !guard?.()) controls.close();
    }, 'icon-button close-icon-button playlist-confirm playlist-close', 'x');
    // Slides out of the button when it asks to be pressed again.
    close.append(node('span', t('common.discard'), 'playlist-confirm-label'));
    actions.append(close);
    header.append(identity, actions);
    headingBlock.append(header);
    const content = node('div', '', 'download-jobs playlist-editor-content');
    const error = node('p', '', 'playlist-editor-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const footer = node('div', '', 'playlist-editor-footer');
    // Messages sit in the sticky header, beside the Save and Close buttons that
    // cause them, so they are in view wherever the list is scrolled to.
    headingBlock.append(error);
    drawer.append(headingBlock, content, footer);
    return {heading, summary, content, error, actions, footer, headingBlock, close};
  }
  async function save(work, error) {
    if (busy) return;
    busy = true;
    error.hidden = true;
    const disabled = [...drawer.querySelectorAll('button, input')].map(element => [element, element.disabled]);
    disabled.forEach(([element]) => { element.disabled = true; });
    drawer.setAttribute('aria-busy', 'true');
    try {
      const created = await work();
      await reload();
      controls.close();
      if (created) onCreated?.(created);
    } catch (failure) {
      error.textContent = failure.message || String(failure);
      error.hidden = false;
    } finally {
      busy = false;
      drawer.removeAttribute('aria-busy');
      disabled.forEach(([element, wasDisabled]) => { element.disabled = wasDisabled; });
    }
  }

  // The same row for a suggestion and a member; only its lead and its
  // trailing buttons differ.
  function videoRow(item, {as, lead, actions, ...rest}) {
    const creator = item.facets?.owner?.name || item.facets?.people?.[0]?.name;
    return html`<${MediaRow} as=${as} size="compact" lines=${1} lead=${lead} actions=${actions}
      thumbnail=${item.thumbnail?.url || item.thumbnail?.src || null} fallback=${icon('video')} ...${rest}>
      <span class="media-row-title">${item.title}</span>
      ${creator ? html`<span class="media-row-meta"><span>${creator}</span></span>` : null}
    <//>`;
  }
  const rowButton = (label, glyph, action, {disabled = false, name} = {}) => html`
    <button type="button" class="library-row-action" aria-label=${label} title=${label}
            data-action=${name} disabled=${disabled} onClick=${action}>${icon(glyph)}</button>`;

  function edit(playlist = null) {
    const {heading, summary, content, error, actions, headingBlock, close} = shell(t('pl.editor'));
    // The name is the panel's title, edited in place. The pencil is for people
    // who do not guess the title is a field, and a new playlist starts with
    // the field already selected, since naming it is the first thing to do.
    const name = node('input', '', 'playlist-editor-title-input');
    name.type = 'text';
    name.maxLength = 200;
    name.value = playlist?.title || '';
    name.placeholder = t('pl.untitled');
    name.setAttribute('aria-label', t('pl.nameLabel'));
    const rename = button(t('pl.rename'), () => { name.focus(); name.select(); },
      'icon-button close-icon-button', 'rename');
    heading.replaceChildren(name);
    name.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submitPlaylist(); }
    });
    const library = items();
    const byId = new Map(library.map(item => [item.id, item]));
    let selected = [...(playlist?.items || [])]
      .sort((left, right) => left.archive.playlist.index - right.archive.playlist.index).map(item => item.id);
    const searchLabel = node('label', '', 'playlist-editor-search');
    searchLabel.innerHTML = iconMarkup('search');
    const search = node('input');
    search.type = 'search';
    search.placeholder = t('pl.search');
    search.setAttribute('aria-label', t('pl.searchLabel'));
    searchLabel.append(search);
    const suggestionSection = node('section', '', 'playlist-editor-suggestions');
    const suggestionHeading = node('h3');
    const available = node('div', '', 'playlist-editor-available');
    const hint = node('p', '', 'playlist-editor-hint');
    suggestionSection.append(suggestionHeading, available, hint);
    const memberSection = node('section', '', 'playlist-editor-selection');
    const memberHeading = node('h3', t('pl.members'));
    const members = node('ol', '', 'playlist-editor-members');
    memberSection.append(memberHeading, members);
    content.append(searchLabel, suggestionSection, memberSection);

    function updateHeading() {
      summary.textContent = t('pl.personal', {videos: videoCount(selected.length)});
    }
    // Redrawing replaces the button that was pressed, which would drop
    // keyboard focus to the page; hand it to the same action on the row that
    // moved, or on whichever row now sits where a removed one was.
    function drawMembers(focus = null) {
      updateHeading();
      touched();
      render(selected.length ? selected.map((id, index) => {
        // A video that has left the library stays listed so it can be taken
        // out; skipping it would hide an entry that is still saved.
        const item = byId.get(id) || {id, title: t('pl.missing'), missing: true};
        return videoRow(item, {
          as: 'li', key: id, 'data-id': id, lead: index + 1,
          actions: html`
            ${rowButton(t('pl.moveUp', {title: item.title}), 'chevron-up', () => {
              [selected[index - 1], selected[index]] = [selected[index], selected[index - 1]];
              drawMembers({id, action: 'up'}); drawAvailable();
            }, {name: 'up', disabled: index === 0})}
            ${rowButton(t('pl.moveDown', {title: item.title}), 'chevron-down', () => {
              [selected[index + 1], selected[index]] = [selected[index], selected[index + 1]];
              drawMembers({id, action: 'down'}); drawAvailable();
            }, {name: 'down', disabled: index === selected.length - 1})}
            ${rowButton(t('pl.remove', {title: item.title}), 'x', () => {
              selected = selected.filter(key => key !== id);
              drawMembers({id: null, index, action: 'remove'}); drawAvailable();
            }, {name: 'remove'})}`,
        });
      }) : html`<li class="playlist-editor-empty">${t('pl.emptyMembers')}</li>`,
      members);
      if (focus) {
        const row = [...members.children].find(child => child.dataset.id === focus.id)
          ?? members.children[Math.min(focus.index, members.children.length - 1)];
        const target = row?.querySelector(`[data-action="${focus.action}"]:not(:disabled)`)
          ?? row?.querySelector('button:not(:disabled)');
        (target ?? search).focus({preventScroll: true});
      }
    }
    function drawAvailable() {
      const suggestions = playlistSuggestions(library, selected, {query: search.value});
      suggestionHeading.textContent = suggestions.heading;
      render(suggestions.items.length ? suggestions.items.map(item => videoRow(item, {
        as: 'div', key: item.id,
        actions: rowButton(t('pl.add', {title: item.title}), 'plus', () => {
          selected.push(item.id);
          drawMembers(); drawAvailable();
          search.focus({preventScroll: true});
        }),
      })) : html`<p class="playlist-editor-empty">${search.value.trim()
        ? t('pl.noMatches') : t('pl.allIn')}</p>`,
      available);
      hint.hidden = suggestions.total <= suggestions.items.length;
      hint.textContent = search.value.trim()
        ? t('pl.matchesOf', {shown: suggestions.items.length, total: suggestions.total})
        : t('pl.searchHint');
    }
    const initial = JSON.stringify([name.value, selected]);
    const dirty = () => JSON.stringify([name.value, selected]) !== initial;
    const note = node('p', '', 'playlist-editor-note');
    note.hidden = true;
    headingBlock.append(note);
    let discardArmed = false;
    // The first attempt to leave with unsaved work turns Close into a Discard
    // button and says why; a second one, like the delete button's, is meant.
    guard = () => {
      if (!dirty() || discardArmed || busy) return false;
      discardArmed = true;
      close.classList.add('danger');
      close.title = close.ariaLabel = t('pl.discard');
      note.textContent = t('pl.unsaved');
      note.dataset.kind = 'discard';
      note.hidden = false;
      return true;
    };
    disarmDiscard = () => {
      if (!discardArmed) return;
      discardArmed = false;
      close.classList.remove('danger');
      close.title = close.ariaLabel = t('pl.close');
      if (note.dataset.kind === 'discard') note.hidden = true;
    };
    const touched = () => { disarmDiscard(); note.hidden = true; disarmDelete(); };
    name.addEventListener('input', () => { updateHeading(); touched(); });
    search.addEventListener('input', drawAvailable);
    drawMembers(); drawAvailable();
    const submitPlaylist = () => {
      if (busy) return;
      // Checked before save(), which disables the fields while it works and
      // so would leave nothing there to take focus.
      if (!name.value.trim()) {
        error.textContent = t('pl.needName');
        error.hidden = false;
        name.focus();
        return;
      }
      save(async () => {
        const record = await post('/api/playlists', {action: playlist ? 'update' : 'create',
          ...(playlist ? {id: playlist.id} : {}), title: name.value, videos: selected});
        return playlist ? null : record;
      }, error);
    };
    actions.prepend(headerAction(playlist ? t('pl.save') : t('pl.create'), submitPlaylist));
    actions.prepend(rename);
    if (playlist) {
      // Two presses, the first only asking; the reassurance is not a failure,
      // so it uses the header's note rather than the red error slot.
      const deletion = button(t('pl.delete'), () => {
        if (deletion.dataset.confirm !== 'true') {
          deletion.dataset.confirm = 'true';
          deletion.classList.add('danger');
          deletion.title = deletion.ariaLabel = t('pl.confirmDelete');
          note.textContent = t('pl.deleteNote');
          note.dataset.kind = 'delete';
          note.hidden = false;
          return;
        }
        save(async () => { await post('/api/playlists', {action: 'delete', id: playlist.id}); }, error);
      }, 'icon-button close-icon-button', 'trash');
      // Slides out of the button when it is armed, so it grows to say Confirm.
      deletion.append(node('span', t('pl.confirm'), 'playlist-confirm-label'));
      disarmDelete = () => {
        if (deletion.dataset.confirm !== 'true') return;
        delete deletion.dataset.confirm;
        deletion.classList.remove('danger');
        deletion.title = deletion.ariaLabel = t('pl.delete');
        if (note.dataset.kind === 'delete') note.hidden = true;
      };
      // Between Save and Close, which is last.
      actions.insertBefore(deletion, actions.lastElementChild);
      // Once armed the button stays red, rather than only under the pointer.
      deletion.classList.add('playlist-delete', 'playlist-confirm');
    }
    controls.open();
    drawer.scrollTop = 0;
    if (playlist) search.focus({preventScroll: true});
    else { name.focus({preventScroll: true}); name.select(); }
  }

  // Adding one video to a playlist is a menu's job, not a panel's: each row
  // is saved the moment it is ticked, so there is nothing to Save or discard.
  let changed = false;
  const menu = createAnchoredMenu({label: t('pl.addMenu'), className: 'playlist-add-menu', onClose() {
    cancelClose();
    // Rescanned once, on the way out, so a row ticked a moment ago is not
    // redrawn from under the pointer.
    if (changed) { changed = false; reload(); }
  }});
  // What a card menu's row names as the menu it opens.
  menu.element.id = 'playlist-add-menu';

  /**
   * `from` is the button the menu hangs from. With `side` it is a card menu's
   * row and the menu opens beside it as a submenu; `focus` moves into it, for
   * a keyboard rather than a pointer passing over the row.
   */
  function add(target, from, {side = false, focus = true} = {}) {
    // A pointer moving along the row re-announces it; rebuilding then would
    // drop a name half typed into the new playlist field.
    if (side && menu.isOpen() && menu.opener() === from) {
      if (focus) menu.element.querySelector('button, input')?.focus({preventScroll: true});
      return;
    }
    const members = new Set(membershipsOf(target).map(member => String(member.id)));
    const problem = node('p', '', 'playlist-editor-error');
    problem.setAttribute('role', 'alert');
    problem.hidden = true;
    const rows = playlists().filter(playlist => playlist.manual).map(playlist => {
      const row = node('button', '', '');
      row.type = 'button';
      row.setAttribute('role', 'menuitemcheckbox');
      const mark = () => row.setAttribute('aria-checked', String(members.has(String(playlist.id))));
      mark();
      row.append(node('span', playlist.title));
      row.addEventListener('click', async () => {
        const key = String(playlist.id);
        const wanted = !members.has(key);
        wanted ? members.add(key) : members.delete(key);
        mark();
        problem.hidden = true;
        try {
          await post('/api/playlists', {action: wanted ? 'add' : 'remove', id: playlist.id, videos: [target.id]});
          changed = true;
        } catch (failure) {
          wanted ? members.delete(key) : members.add(key);
          mark();
          problem.textContent = failure.message || String(failure);
          problem.hidden = false;
        }
      });
      return row;
    });
    const name = node('input', '', 'playlist-add-name');
    name.type = 'text';
    name.maxLength = 200;
    name.placeholder = t('pl.newPlaylist');
    name.setAttribute('aria-label', t('pl.newName'));
    // Keys typed here are not menu navigation, except Left with nowhere left
    // to go, which still backs out of a submenu.
    name.addEventListener('keydown', async event => {
      if (event.key === 'ArrowLeft' && name.selectionStart === 0 && name.selectionEnd === 0) return;
      event.stopPropagation();
      if (event.key !== 'Enter' || !name.value.trim() || name.disabled) return;
      event.preventDefault();
      name.disabled = true;
      try {
        await post('/api/playlists', {action: 'create', title: name.value, videos: [target.id]});
        changed = true;
        menu.close();
      } catch (failure) {
        problem.textContent = failure.message || String(failure);
        problem.hidden = false;
        name.disabled = false;
        name.focus();
      }
    });
    const divider = node('div', '', 'menu-divider');
    divider.setAttribute('role', 'separator');
    // The card's own button keeps its aria-expanded to itself.
    if (menu.open(from, [...rows, ...(rows.length ? [divider] : []), name, problem], {reflect: false, side})
        && focus) {
      (rows[0] || name).focus({preventScroll: true});
    }
  }
  // Left closes a submenu back to the row it came from, as in the format one.
  menu.element.addEventListener('keydown', event => {
    const row = menu.opener();
    if (event.key !== 'ArrowLeft' || !row?.closest('.card-menu')) return;
    event.preventDefault();
    menu.close();
    row.focus();
  });
  menu.element.addEventListener('pointerenter', () => cancelClose());
  let closeTimer = null;
  function cancelClose() { clearTimeout(closeTimer); closeTimer = null; }
  /** Closes it when it is a card menu's submenu, after `delay` so a pointer
   *  crossing another row on its way into it does not shut it. */
  function closeSubmenu({delay = 0} = {}) {
    cancelClose();
    if (!menu.opener()?.closest('.card-menu')) return;
    if (delay) closeTimer = setTimeout(() => menu.close(), delay);
    else menu.close();
  }
  return {edit, add: (...args) => { cancelClose(); add(...args); }, closeSubmenu};
}
