// The heading over the gallery: what the
// list is on the left, and the sort options along the right of the same line.

import {SORT_DEFAULT_DIRECTIONS} from 'media-ui';
import {t} from './i18n.js';

/** The sorts every view offers, in the order they read along the heading.
 *  Which way round each starts is the package's, since sortItems reverses a
 *  sort by comparing against it. */
// Their words are read when a button is drawn, since the language is chosen
// after this module loads.
const option = mode => ({mode, get label() { return t(`sort.${mode}`); }});
export const SORT_OPTIONS = ['latest', 'name', 'duration', 'size'].map(option);
/** A playlist view also offers its own order, which is where it starts. */
export const PLAYLIST_SORT = option('playlist');

/**
 * What the list is: a playlist by its title, a creator's own videos, the
 * videos from one source, or just the videos. `creator` is the creator's name
 * when the view is one, and `source` the source's.
 */
export function galleryHeading({playlist = null, creator = '', source = ''} = {}) {
  if (playlist?.title) return playlist.title;
  if (creator) return t('gallery.creatorVideos', {creator});
  if (source) return t('gallery.sourceVideos', {source});
  return t('nav.videos');
}

/**
 * The sort a view actually uses. No choice yet means the view's own default:
 * playlist order in a playlist, newest first anywhere else. A playlist order
 * chosen in a playlist does not carry to a view that has none.
 */
export function effectiveSort(sort, {playlist = false} = {}) {
  if (!sort || sort === PLAYLIST_SORT.mode) return playlist ? PLAYLIST_SORT.mode : 'latest';
  return sort;
}

/** Each sort button's state. Pressing the active one again reverses it. */
export function sortButtons({sort, directions = {}, playlist = false, playlistReversed = false}) {
  const active = effectiveSort(sort, {playlist});
  return [...(playlist ? [PLAYLIST_SORT] : []), ...SORT_OPTIONS].map(({mode, label}) => {
    const pressed = mode === active;
    const ownOrder = mode === PLAYLIST_SORT.mode;
    // A playlist's direction belongs to the playlist and is saved with it,
    // so it is read from the videos rather than from this view's own choices.
    const direction = ownOrder
      ? (playlistReversed ? 'desc' : 'asc') : directionOf(mode, directions);
    return {
      mode, label, pressed, direction,
      text: pressed ? `${label} ${direction === 'asc' ? '↑' : '↓'}` : label,
      ariaLabel: !pressed ? t('sort.by', {label})
        : ownOrder
          ? t(playlistReversed ? 'sort.playlistReversed' : 'sort.playlistRecorded')
          : t(direction === 'asc' ? 'sort.ascending' : 'sort.descending', {label}),
    };
  });
}

/** The way round a sort currently runs: the viewer's choice, or how the
 *  package's own sort starts. */
export function directionOf(mode, directions = {}) {
  return directions[mode] || SORT_DEFAULT_DIRECTIONS[mode] || 'desc';
}
