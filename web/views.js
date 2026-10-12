// The library's views, Home is the
// default and so carries no parameter; the others are `?view=<name>`.

export const VIEWS = ['home', 'videos', 'playlists', 'channels'];

/** The view a URL asks for; anything unknown is home. */
export function viewFromParams(params) {
  const view = params.get('view');
  return VIEWS.includes(view) && view !== 'home' ? view : 'home';
}

/** Writes the view onto a URL, leaving home as the bare address. */
export function applyViewParam(url, view) {
  if (view && view !== 'home' && VIEWS.includes(view)) url.searchParams.set('view', view);
  else url.searchParams.delete('view');
  return url;
}

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
