// The library's views. Home is the default and so the bare address; the
// others are `/<name>` (see routes.js).

export const VIEWS = ['home', 'videos', 'playlists', 'channels'];

/**
 * What is actually on screen. A chip filter is always a list of videos. A
 * search on home is too, since the shelves answer nothing about it; the
 * playlist and channel grids search themselves by name instead.
 */
export function displayedView(view, {query = '', facet = null} = {}) {
  // The playlists view narrows to one channel's playlists; any other chip,
  // anywhere, is a list of videos.
  if (facet && view === 'playlists' && facet.kind !== 'playlist') return 'playlists';
  if (facet) return 'videos';
  if (view === 'home' && query.trim()) return 'videos';
  return view;
}
