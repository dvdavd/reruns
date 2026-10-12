import {applyFacetParams, facetFromParams} from './facets.js';
import {applyViewParam, viewFromParams} from './views.js';
import {startsLikeUrl} from './download-model.js';

const facetFromUrl = () => facetFromParams(new URLSearchParams(window.location.search));

export function createGalleryNavigation({
  search, searchClear, player, nameOf,
  getState, onChange, draw,
}) {
  function queryUrl(value, active, nextView) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('q', value); else url.searchParams.delete('q');
    applyFacetParams(url, active);
    applyViewParam(url, nextView);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  /**
   * The two filters are one filter: picking a chip replaces whatever search
   * text was there, and typing replaces the chip. The search box shows the
   * chip's name so the filter is never invisible, but that text is a label —
   * editing it is a new search, not a search for the name.
   */
  function setQuery(value, {history = 'none', active = null, view: nextView = getState().view,
    syncInput = true} = {}) {
    onChange({query: value, facet: active, view: nextView});
    if (syncInput) search.value = active ? nameOf(active) : value;
    // Setting the field raises no input event, so say it changed.
    if (syncInput) search.dispatchEvent(new Event('searchsync'));
    if (history === 'push') {
      rememberScroll();
      const {archiveScrollY, ...state} = window.history.state || {};
      window.history.pushState(state, '', queryUrl(value, active, nextView));
    } else if (history === 'replace') {
      window.history.replaceState({...window.history.state}, '', queryUrl(value, active, nextView));
    }
    draw();
    // A new filter is a new list, so it starts at its top rather than wherever
    // the last one was scrolled to; a chip deep in the gallery would otherwise
    // leave its heading, and its first videos, off the screen.
    if (history === 'push') window.scrollTo(0, 0);
  }
  function filterBy(name) {
    const {query, facet} = getState();
    if (name !== query || facet) setQuery(name, {history: 'push'});
  }
  /**
   * Filters to exactly the chip's own videos. A chip with no id of its own is
   * all the archive knows about it, so that one falls back to a name search.
   */
  /** `nextView` keeps a chip inside a view that can narrow by it, as the
   *  playlists view does by channel. */
  function filterByFacet(kind, target, {view: nextView = getState().view} = {}) {
    const {facet, view} = getState();
    const id = String(target?.id ?? '');
    if (!id) return filterBy(target.name);
    // From the watch page, the gallery behind it may already be this one; the
    // link still has to leave the video to show it.
    const watching = Boolean(player.activeId());
    if (!watching && facet?.kind === kind && facet.id === id && nextView === view) return;
    if (watching) player.close({scrollY: 0});
    setQuery('', {history: 'push', active: {kind, id, name: target.name || ''}, view: nextView});
  }
  /** A view from the topbar: the whole of it, from the top, as a history
   *  entry. Choosing the view already showing still clears its filter. */
  function setView(next) {
    const {query, facet, view} = getState();
    if (player.activeId()) player.close({scrollY: 0});
    if (next !== view || query || facet || window.location.search) {
      setQuery('', {history: 'push', view: next});
    } else {
      draw();
    }
    window.scrollTo(0, 0);
  }
  function clearFilter({focus = false} = {}) {
    setQuery('', {history: 'replace'});
    if (focus) requestAnimationFrame(() => search.focus());
  }
  search.addEventListener('input', () => {
    const {query, facet} = getState();
    // A link, even half typed, is for downloading, not a filter: the gallery goes back to
    // unfiltered while the field keeps the link, and a video stays open.
    if (startsLikeUrl(search.value)) {
      if (query || facet) setQuery('', {history: 'replace', syncInput: false});
      return;
    }
    // The search is in the topbar on the watch page too, and its results are
    // the gallery's, so searching from a video goes back to show them.
    if (player.activeId()) player.close({scrollY: 0});
    const value = search.value;
    const history = !query && value ? 'push' : 'replace';
    setQuery(value, {history});
  });
  search.addEventListener('keydown', event => {
    const {query, facet} = getState();
    if (event.key === 'Escape' && (query || facet)) clearFilter();
  });
  searchClear.addEventListener('click', () => clearFilter({focus: true}));
  /**
   * Scroll restoration is manual (see player-controller.js), and the player
   * only puts back the gallery a video was opened from. A channel or a
   * playlist is a history entry of the gallery's own, so each entry keeps its
   * offset in its state: written as the page settles after a scroll, so a
   * Forward finds it as well as a Back, and again as a filter is pushed, in
   * case the click came before the scroll had settled.
   */
  let scrollTimer = 0;
  function rememberScroll() {
    clearTimeout(scrollTimer);
    if (player.activeId()) return;
    if (window.history.state?.archiveScrollY === window.scrollY) return;
    window.history.replaceState({...window.history.state, archiveScrollY: window.scrollY}, '');
  }
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(rememberScroll, 150);
  }, {passive: true});
  window.addEventListener('popstate', event => {
    clearTimeout(scrollTimer);
    const params = new URLSearchParams(window.location.search);
    setQuery(params.get('q') || '', {active: facetFromUrl(), view: viewFromParams(params)});
    // A video's entry is the player's to place; it scrolls the watch page to the top.
    if (params.has('watch')) return;
    const scrollY = event.state?.archiveScrollY;
    window.scrollTo(0, Number.isFinite(scrollY) ? scrollY : 0);
  });
  /**
   * A link into a filtered gallery, for pages outside it: the URL it would
   * push, so the link can be opened in a new tab too, and what following it
   * here does. A channel opens its videos; a playlist opens its gallery.
   */
  function facetLink(kind, target) {
    const url = new URL(queryUrl('', {kind, id: target.id, name: target.name || ''}, 'videos'),
      window.location.origin);
    url.searchParams.delete('watch');
    return {
      href: `${url.pathname}${url.search}${url.hash}`,
      open: () => filterByFacet(kind, target, {view: 'videos'}),
    };
  }
  return {setQuery, filterBy, filterByFacet, setView, clearFilter, facetLink};
}
