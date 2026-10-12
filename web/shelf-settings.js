// Which favourite rows a page shows, chosen from a button at the top of it:
// home, a channel's page, a playlist's page, and the videos and playlists
// views each have their own. Kept with the
// account like the appearance settings. The rows are hidden by a word on body rather
// than their own hidden attribute, which each shelf already sets for itself as
// its entries come and go.
//
// The button lives in whichever heading comes first. Left on the gallery's
// heading it sank below every row still shown, moving each time one was
// switched and often off the screen; the first heading is always at the top,
// so the button stays where it was clicked.

import {anchorPopover} from './popover.js';
import {t} from './i18n.js';
import {preferences} from './preferences.js';

// The gallery's heading comes last on every page, and takes the button when
// every row above it is off or empty.
const VIDEOS_HEADING = ['.videos-heading', '.videos-heading-tools'];

/**
 * Each page's rows as [name, label key, shown until switched, options], where
 * `divided` sets a choice that is not a row apart from the rows, the body word that
 * lists the ones hidden, and its headings from the top, each with where the
 * button would go in it. The pages other than home share their favourite
 * rows' markup, so which page is showing is `body[data-page]`.
 */
export const SHELF_PAGES = {
  home: {
    key: 'archive-home-hidden',
    attribute: 'homeHidden',
    active: () => document.body.dataset.view === 'home',
    sections: [
      ['channels', 'shelf.favChannels', true],
      ['videos', 'shelf.favVideos', true],
      ['playlists', 'shelf.favPlaylists', true],
      // Not a row: whether the gallery under them folds whole playlists.
      ['collapsed-playlists', 'shelf.collapsePlaylists', true, {divided: true}],
    ],
    headings: [
      ['#creator-shelf', '.section-heading'],
      ['#video-shelf', '.section-heading'],
      ['#playlist-shelf', '.section-heading'],
      VIDEOS_HEADING,
    ],
  },
  channel: {
    key: 'archive-channel-shelves',
    attribute: 'channelHidden',
    active: () => document.body.dataset.page === 'channel',
    sections: [
      ['favourite-playlists', 'shelf.favPlaylists', false],
      ['playlists', 'shelf.allPlaylists', false],
      ['videos', 'shelf.favVideos', true],
    ],
    headings: [
      ['#page-playlist-shelf', '.section-heading'],
      ['#channel-playlists', '.section-heading'],
      ['#page-video-shelf', '.section-heading'],
      VIDEOS_HEADING,
    ],
  },
  playlist: {
    key: 'archive-playlist-shelves',
    attribute: 'playlistHidden',
    active: () => document.body.dataset.page === 'playlist',
    sections: [
      ['videos', 'shelf.favVideos', false],
    ],
    headings: [
      ['#page-video-shelf', '.section-heading'],
      VIDEOS_HEADING,
    ],
  },
  // The whole of the videos and playlists views, unfiltered.
  videos: {
    key: 'archive-videos-shelves',
    attribute: 'videosHidden',
    active: () => document.body.dataset.page === 'videos',
    sections: [
      ['videos', 'shelf.favVideos', false],
    ],
    headings: [
      ['#page-video-shelf', '.section-heading'],
      VIDEOS_HEADING,
    ],
  },
  playlists: {
    key: 'archive-playlists-shelves',
    attribute: 'playlistsHidden',
    active: () => document.body.dataset.page === 'playlists',
    sections: [
      ['playlists', 'shelf.favPlaylists', false],
    ],
    headings: [
      ['#view-playlist-shelf', '.section-heading'],
      ['#playlists-view', '.section-heading'],
    ],
  },
};

/**
 * The rows a page hides, in the order it shows them. What is saved is each
 * row the viewer has switched, as `{name: shown}`, so a row they never touched
 * follows its default. Home once saved a plain list of the rows it hid, which
 * reads as those rows switched off.
 */
export function readHidden(page, storage = preferences) {
  const {key, sections} = SHELF_PAGES[page];
  let choices = {};
  try {
    const saved = JSON.parse(storage?.getItem(key) || '{}');
    if (Array.isArray(saved)) choices = Object.fromEntries(saved.map(name => [name, false]));
    else if (saved && typeof saved === 'object') choices = saved;
  } catch { /* Use the defaults when storage is unavailable or unreadable. */ }
  return sections.filter(([name, , shown]) => !(typeof choices[name] === 'boolean' ? choices[name] : shown))
    .map(([name]) => name);
}

export function createShelfSettingsUI(page, button, menu) {
  const {key, attribute, active, sections, headings: slots} = SHELF_PAGES[page];
  let hidden = readHidden(page);
  anchorPopover(button, menu);
  const rows = sections.map(([name, label]) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'menuitemcheckbox');
    row.append(Object.assign(document.createElement('span'), {textContent: t(label)}));
    // The menu closes on a choice. Most pages offer one or two rows, and a
    // one-row menu that stayed open after its only choice looked broken;
    // switching a second row is only one more click on the button.
    row.addEventListener('click', () => {
      menu.hidePopover();
      hidden = hidden.includes(name) ? hidden.filter(other => other !== name) : [...hidden, name];
      const choices = Object.fromEntries(sections.map(([other]) => [other, !hidden.includes(other)]));
      try { preferences.setItem(key, JSON.stringify(choices)); } catch { /* Still apply for this session. */ }
      apply();
    });
    return [name, row];
  });
  menu.replaceChildren(...rows.flatMap(([name, row]) => {
    const divided = sections.find(([other]) => other === name)[3]?.divided;
    return divided ? [Object.assign(document.createElement('div'), {className: 'menu-divider'}), row] : [row];
  }));
  const headings = slots.map(([section, slot]) => {
    const element = document.querySelector(section);
    return [element, element.matches(slot) ? element : element.querySelector(slot)];
  });
  function place() {
    if (!active()) return;
    const [, slot] = headings.find(([section]) => section.checkVisibility()) || headings.at(-1);
    if (button.parentElement !== slot) slot.append(button);
  }
  function apply() {
    document.body.dataset[attribute] = hidden.join(' ');
    for (const [name, row] of rows) row.setAttribute('aria-checked', String(!hidden.includes(name)));
    place();
  }
  apply();
  // A shelf shows or hides itself as its entries load and change, and the
  // headings are only laid out while the page is the one showing.
  const watch = new MutationObserver(place);
  for (const [section] of headings) watch.observe(section, {attributeFilter: ['hidden']});
  watch.observe(document.body, {attributeFilter: ['data-view', 'data-page']});
  // Another tab changing it follows here too, as the appearance settings do.
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { hidden = readHidden(page); apply(); }
  });
}
