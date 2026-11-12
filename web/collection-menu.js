import {createAnchoredMenu} from './popover.js';
import {t} from './i18n.js';

/**
 * The menu a card's single playlist chip opens when its video is in several,
 * in place of one chip per playlist. One menu serves every card. A related
 * card has no chip, so there it opens beside the card menu's row instead, as
 * a submenu like the Add to playlists one.
 */
export function createCollectionMenu({choose}) {
  const menu = createAnchoredMenu({label: t('pl.menu'), className: 'collection-menu', onClose: () => cancelClose()});
  // What a card menu's row names as the menu it opens.
  menu.element.id = 'collection-menu';
  let closeTimer = null;
  function cancelClose() { clearTimeout(closeTimer); closeTimer = null; }

  /** `side` hangs it beside a card menu's row; `focus` moves into it, for a
   *  keyboard rather than a pointer passing over the row. */
  function open(collections, from, {side = false, focus = true} = {}) {
    cancelClose();
    // A pointer moving along the row re-announces it; there is nothing to
    // rebuild, and reopening would flicker.
    if (side && menu.isOpen() && menu.opener() === from) {
      if (focus) menu.element.querySelector('button')?.focus({preventScroll: true});
      return;
    }
    const rows = collections.map(collection => {
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.textContent = collection.name;
      row.append(label);
      row.addEventListener('click', () => { menu.close(); choose(collection); });
      return row;
    });
    if (menu.open(from, rows, {side}) && focus) rows[0]?.focus({preventScroll: true});
  }
  // Left closes a submenu back to the row it came from, as the others do.
  menu.element.addEventListener('keydown', event => {
    const row = menu.opener();
    if (event.key !== 'ArrowLeft' || !row?.closest('.card-menu')) return;
    event.preventDefault();
    menu.close();
    row.focus();
  });
  menu.element.addEventListener('pointerenter', () => cancelClose());
  /** Closes it when it is a card menu's submenu, after `delay` so a pointer
   *  crossing another row on its way into it does not shut it. */
  function closeSubmenu({delay = 0} = {}) {
    cancelClose();
    if (!menu.opener()?.closest('.card-menu')) return;
    if (delay) closeTimer = setTimeout(() => menu.close(), delay);
    else menu.close();
  }
  open.closeSubmenu = closeSubmenu;
  return open;
}
