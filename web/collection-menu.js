import {createAnchoredMenu} from './popover.js';
import {t} from './i18n.js';

/**
 * The menu a card's single playlist chip opens when its video is in several,
 * in place of one chip per playlist. One menu serves every card.
 */
export function createCollectionMenu({choose}) {
  const menu = createAnchoredMenu({label: t('pl.menu'), className: 'collection-menu'});
  return function open(collections, chip) {
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
    if (menu.open(chip, rows)) rows[0]?.focus({preventScroll: true});
  };
}
