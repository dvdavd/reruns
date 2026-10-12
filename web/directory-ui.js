// The folder picker beside the search box. It has nothing to offer until the
// archive holds more than one place to look, and stays out of the way until
// then. A saved choice that has since gone (a library removed, a folder
// emptied and forgotten) falls back to everything rather than showing an
// empty archive with no hint why.

import {directoryRows, offersDirectories, readDirectory, saveDirectory} from './directories.js';
import {anchorPopover} from './popover.js';
import {t} from './i18n.js';

export function createDirectoryUI({button, menu, label, onChange}) {
  let rows = [];
  let selected = readDirectory();
  anchorPopover(button, menu);

  function choose(key, {notify = true} = {}) {
    selected = key;
    saveDirectory(key);
    draw();
    if (notify) onChange(key);
  }

  function draw() {
    const all = document.createElement('button');
    all.type = 'button';
    all.setAttribute('role', 'menuitemradio');
    all.setAttribute('aria-checked', String(!selected));
    all.append(Object.assign(document.createElement('span'), {textContent: t('nav.allVideos')}));
    all.addEventListener('click', () => { menu.hidePopover(); choose(''); });
    const items = rows.map(row => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(row.key === selected));
      item.style.setProperty('--depth', row.depth);
      item.append(Object.assign(document.createElement('span'), {textContent: row.name}),
        Object.assign(document.createElement('small'), {textContent: row.count}));
      item.addEventListener('click', () => { menu.hidePopover(); choose(row.key); });
      return item;
    });
    menu.replaceChildren(all, ...items);
    const current = rows.find(row => row.key === selected);
    label.textContent = current ? current.name : t('nav.allVideos');
    button.dataset.filtered = String(Boolean(current));
  }

  return {
    select: choose,
    selected: () => selected,
    /** The folders the menu offers, as directoryRows lists them. */
    rows: () => rows,
    /** Takes the server's list of folders. Returns the key now in force, which
     *  differs from the last when the saved folder no longer exists. */
    setEntries(entries) {
      rows = directoryRows(entries);
      button.hidden = !offersDirectories(entries);
      if (selected && !rows.some(row => row.key === selected)) {
        selected = '';
        saveDirectory('');
      }
      draw();
      return selected;
    },
  };
}
