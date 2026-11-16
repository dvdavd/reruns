// The address bar, read and written in one place. Every page is a path —
// `/videos`, `/channel/<id>`, `/watch/<site id>` — so a link says what it is
// and a video's survives its file being renamed or moved. Addresses from
// before, all of them `/?view=…&channel=…&watch=<file key>`, still resolve;
// `legacy` says so, and the page rewrites them once it can.
import {FACETS} from './facets.js';
import {VIEWS} from './views.js';

/** The path each chip kind lives under. Favourites have no id worth showing. */
const FACET_PATHS = {quality: 'quality', playlist: 'playlist', channel: 'channel',
  creator: 'creator', source: 'source'};
const KIND_OF_PATH = Object.fromEntries(Object.entries(FACET_PATHS).map(([kind, path]) => [path, kind]));
const FAVOURITES = 'favourites';

/** Parameters the route owns. Anything else (`?debugdownload`) is carried
 *  from one address to the next. */
const ROUTE_PARAMS = new Set(['q', 'view', 'watch', 'list', 'file', ...Object.keys(FACETS)]);

/**
 * @typedef {{siteId?: string, key?: string, file?: string}} WatchTarget
 * @typedef {{view: string, facet: {kind: string, id: string, name: string}|null,
 *   query: string, watch: WatchTarget|null, list: string, legacy?: boolean}} Route
 */

const HOME = Object.freeze({view: 'home', facet: null, query: '', watch: null, list: ''});

const decode = segment => {
  try { return decodeURIComponent(segment); } catch { return segment; }
};
const encode = value => encodeURIComponent(String(value));

/** What an address asks for. Takes anything with `pathname` and `search`. */
export function routeFromLocation({pathname = '/', search = ''} = {}) {
  const params = new URLSearchParams(search);
  const query = params.get('q') || '';
  const segments = pathname.split('/').filter(Boolean).map(decode);
  const [head, id, tail] = segments;
  if (!head) return legacyRoute(params);
  if (head === 'watch' && id) {
    const watch = id.startsWith('~') ? {key: id.slice(1)}
      : {siteId: id, ...(params.get('file') ? {file: params.get('file')} : {})};
    return {...HOME, watch, list: params.get('list') || ''};
  }
  if (head === 'search') return {...HOME, query};
  if (VIEWS.includes(head) && head !== 'home' && segments.length === 1) return {...HOME, view: head, query};
  if (head === FAVOURITES && segments.length === 1) {
    return {...HOME, view: 'videos', facet: {kind: 'favourite', id: 'true', name: ''}, query};
  }
  const kind = KIND_OF_PATH[head];
  if (kind && id) {
    // Only the playlists view narrows by a chip and stays itself (see
    // displayedView); every other chip is a list of videos.
    const view = tail === 'playlists' && kind !== 'playlist' ? 'playlists' : 'videos';
    return {...HOME, view, facet: {kind, id, name: ''}, query};
  }
  return {...HOME};
}

/** The address as it was before paths: everything on `/`. */
function legacyRoute(params) {
  const view = params.get('view');
  const kind = Object.keys(FACETS).find(name => params.get(name));
  const route = {
    view: VIEWS.includes(view) ? view : 'home',
    facet: kind ? {kind, id: params.get(kind), name: ''} : null,
    query: params.get('q') || '',
    watch: params.get('watch') ? {key: params.get('watch')} : null,
    // A video opened from a playlist's gallery played on through it.
    list: params.get('watch') ? params.get('playlist') || '' : '',
  };
  return {...route, legacy: Boolean(view || kind || route.watch)};
}

/** The parameters to carry: whatever the route does not own. */
function carried(search) {
  const params = new URLSearchParams(search || '');
  for (const name of [...params.keys()]) if (ROUTE_PARAMS.has(name)) params.delete(name);
  return params;
}

const withSearch = (path, params) => {
  const text = params.toString();
  return text ? `${path}?${text}` : path;
};

/**
 * The address for a route, as a path and query. `carry` is the current
 * address's query, whose debug switches stay on.
 */
export function urlForRoute(route, carry = '') {
  const params = carried(carry);
  const {view = 'home', facet = null, query = '', watch = null, list = ''} = route || {};
  if (watch) {
    if (watch.key && !watch.siteId) return withSearch(`/watch/~${encode(watch.key)}`, withList(params, list));
    if (watch.file) params.set('file', watch.file);
    return withSearch(`/watch/${encode(watch.siteId)}`, withList(params, list));
  }
  if (query) params.set('q', query);
  if (facet) {
    if (facet.kind === 'favourite') return withSearch(`/${FAVOURITES}`, params);
    const base = `/${FACET_PATHS[facet.kind] || facet.kind}/${encode(facet.id)}`;
    const narrowed = view === 'playlists' && facet.kind !== 'playlist';
    return withSearch(narrowed ? `${base}/playlists` : base, params);
  }
  if (view && view !== 'home' && VIEWS.includes(view)) return withSearch(`/${view}`, params);
  return withSearch(query ? '/search' : '/', params);
}

function withList(params, list) {
  if (list) params.set('list', list);
  return params;
}

/** The video's site id, which several downloads of it share. */
const siteIdOf = item => item?.archive?.sourceId || '';

/**
 * How an address names a video. By its site id, so the link outlives the
 * file; with the file's key as well when another video in the library has
 * the same id (two sites can, and two libraries can each hold a copy); and by
 * the key alone when the site gave it no id.
 */
export function watchTargetFor(item, items = []) {
  const siteId = siteIdOf(item);
  if (!siteId) return {key: item.id};
  const shared = items.some(other => other.id !== item.id && siteIdOf(other) === siteId);
  return shared ? {siteId, file: item.id} : {siteId};
}

/** The video a watch address names, or undefined while it is not loaded. */
export function findWatched(watch, items = []) {
  if (!watch) return undefined;
  const key = watch.key || watch.file;
  if (key) {
    // An address saved while a copy stood for its video still finds the
    // video once a better copy has taken over (see groupFormats).
    const found = items.find(item => item.id === key)
      || items.find(item => item.archive?.formats?.some(format => format.id === key));
    if (found || !watch.siteId) return found;
  }
  return items.find(item => siteIdOf(item) === watch.siteId);
}

/**
 * The gallery behind a page. A gallery address is its own. A watch entry
 * remembers the one it was opened from in its history state; one landed on
 * directly has none, so it sits on its playlist, or on home.
 */
export function galleryRoute(location, state) {
  const route = routeFromLocation(location);
  if (!route.watch) return route;
  if (typeof state?.gallery === 'string') {
    const [pathname, search = ''] = state.gallery.split('?');
    const behind = routeFromLocation({pathname, search: search ? `?${search}` : ''});
    if (!behind.watch) return behind;
  }
  if (route.legacy) {
    const params = new URLSearchParams(location.search);
    params.delete('watch');
    return legacyRoute(params);
  }
  return route.list ? {...HOME, view: 'videos', facet: {kind: 'playlist', id: route.list, name: ''}} : {...HOME};
}
