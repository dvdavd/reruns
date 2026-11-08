import {createDeleteDialog} from './delete-dialog.js';
import {createGalleryActions} from './gallery-actions.js';
import {createLibraryLoader} from './gallery-loader.js';
import {createGalleryNavigation} from './gallery-navigation.js';
import {createItemStore, filterItems, formatBytes, html, render, sortItems, VideoCard} from 'media-ui';
import {t} from './i18n.js';
import {setPageTitle} from './page-title.js';
import {preferences} from './preferences.js';
import {applyPlaybackPositions} from './playback-position.js';
import {initialiseCardAccents} from './card-accents.js';
import {createChannelImages} from './channel-image.js';
import {createChannelProfile} from './channel-profile.js';
import {createCollectionMenu} from './collection-menu.js';
import {createCreatorShelf, creatorOf} from './creator-shelf.js';
import {facetFromParams, facetName, matchesFacet} from './facets.js';
import {
  createPlaylistCollapser, inPlaylist, inPlaylistOrder, isReversed,
  playlistsFrom, playlistViewOf,
} from './playlists.js';
import {createPlaylistEditor} from './playlist-editor.js';
import {inDirectory} from './directories.js';
import {createPlaylistCards, createPlaylistGrid} from './playlist-grid.js';
import {createPlaylistShelf, favouritePlaylists as favouritesAmong} from './playlist-shelf.js';
import {createTracklist, showsAsTracks, tracklistOf} from './tracklist.js';
import {createVideoShelf, favouriteVideos} from './video-shelf.js';
import {channelSubscribeUrl} from './subscription-target.js';
import {displayedView, viewFromParams} from './views.js';
import {ColumnGallery} from './column-gallery.js';

/** Whether a playlist belongs to the channel or creator a chip names: any of
 *  its videos carrying that chip is enough. */
const ownedBy = (playlist, facet) => playlist.items.some(item => matchesFacet(item, facet));
import {directionOf, effectiveSort, galleryHeading, sortButtons} from './gallery-heading.js';
import {createPlaylistProfile} from './playlist-profile.js';

const facetFromUrl = () =>
  facetFromParams(new URLSearchParams(window.location.search));

export function createGalleryController({
  root, summary, playlistsSummary, channelsSummary, count, search, searchClear, shelf, videoShelf,
  playlistShelf, pageVideoShelf, pagePlaylistShelf, viewPlaylistShelf,
  playlistsRoot, playlistsHeading,
  channelPlaylists: channelPlaylistsShelf, channelProfile: profileSection, playlistProfile: playlistProfileSection, channels,
  navButtons, heading, sortControl, layoutControl, tracklist: tracklistRoot, deleteDialog, player, report,
  directory,
}) {
  const store = createItemStore([]);
  // The folder the archive is narrowed to, as the key its items' ids start
  // with. Everything the gallery shows is drawn from the items inside it;
  // whatever has to see the whole archive (deleting, rescanning, finding a
  // chip's name) still reads the store.
  let scope = directory.selected();
  const scoped = () => (scope ? store.allItems().filter(item => inDirectory(item, scope))
    : store.allItems());
  // No choice yet is the view's own default; see effectiveSort.
  let sort = null;
  const directions = {};
  let playlistRecords = [];
  const allPlaylists = (pool = scoped()) => playlistsFrom(pool, scope ? [] : playlistRecords);
  const playlistEditor = createPlaylistEditor({
    items: () => store.allItems(), playlists: () => playlistsFrom(store.allItems(), playlistRecords),
    reload: () => load(),
    onCreated: record => {
      directory.select('');
      filterByFacet('playlist', {id: record.id, name: record.title}, {view: 'videos'});
    },
  });
  const openCollections = createCollectionMenu({choose: collection => filterByFacet('playlist', collection)});
  document.querySelector('#create-playlist')?.addEventListener('click', () => playlistEditor.edit());
  const editPlaylist = document.createElement('button');
  editPlaylist.type = 'button';
  editPlaylist.className = 'confirm-dialog-button playlist-profile-edit';
  editPlaylist.textContent = t('menu.editPlaylist');
  editPlaylist.hidden = true;
  (playlistProfileSection.querySelector('.profile-actions') || playlistProfileSection).append(editPlaylist);
  editPlaylist.addEventListener('click', () => {
    const playlist = playlistsFrom(store.allItems(), playlistRecords).find(entry => entry.id === facet?.id);
    if (playlist?.manual) playlistEditor.edit(playlist);
  });
  // Held only while a render that would move the page is under way: the
  // optimistic removal after a delete, and load's swap to fresh items.
  let deletionGalleryAnchor = null;
  const cardSurfaces = [];
  // Wired in from outside once the subscriptions module exists; every
  // Subscribe/Unsubscribe shortcut in the gallery (channel page, playlist
  // page, playlist card menus) goes through this stable proxy, so those
  // pieces can be built before the subscriptions module is.
  let subscriptionsBackend = null;
  // The browse panel is built after the gallery, so the pages reach it through
  // this and it is set once it exists.
  let browseSource = () => {};
  const subscriptions = {
    list: () => subscriptionsBackend?.list() || [],
    subscribe: (...args) => subscriptionsBackend?.subscribe(...args),
    unsubscribe: (...args) => subscriptionsBackend?.unsubscribe(...args),
    update: (...args) => subscriptionsBackend?.update(...args),
    check: (...args) => subscriptionsBackend?.check(...args),
    refresh: () => subscriptionsBackend?.refresh(),
  };
  let query = new URLSearchParams(window.location.search).get('q') || '';
  let facet = facetFromUrl();
  let view = viewFromParams(new URLSearchParams(window.location.search));
  const nameOf = active => facetName(active, store.allItems());
  const navigation = createGalleryNavigation({search, searchClear, player, nameOf,
    getState: () => ({query, facet, view}),
    onChange(next) { query = next.query; facet = next.facet; view = next.view; }, draw});
  const {setQuery, filterBy, filterByFacet, setView, clearFilter, facetLink} = navigation;
  // Read by the topbar to decide whether YouTube is worth searching.
  let viewMatches = 0;
  // The markup presses no view, since it cannot know the address; the right
  // one lights now rather than once the library has loaded.
  markView(displayedView(view, {query, facet}));
  // Channel ids, which live in the server's settings rather than the items.
  let favouriteChannels = new Set();
  // Playlist ids, likewise.
  let favouritePlaylists = new Set();
  // Playlist ids the viewer has pointed the right way round; the rest are read
  // from their upload dates. Also in the settings rather than the items.
  let playlistOrder = {};
  // How each playlist is shown, where the viewer has said: 'tracks' or
  // 'cards'. A viewing choice rather than the playlist's, so it follows the
  // account, not the shared settings its order lives in.
  const LAYOUT_KEY = 'archive-playlist-layouts';
  const layoutChoices = () => {
    try { return JSON.parse(preferences.getItem(LAYOUT_KEY) || '{}') || {}; } catch { return {}; }
  };
  search.value = query;
  /**
   * A playlist is the one view the archive holds an order of its own for, so
   * that is where it starts; the sort control can still ask for another. It is
   * a playlist view when a playlist chip filtered it, or a search whose
   * results all belong to one. A creator whose videos happen to share one
   * playlist is still that creator's view.
   */
  function visibleItems() {
    const matched = filterItems(scoped(), {query})
      .filter(item => matchesFacet(item, facet))
      .map(item => facet?.kind === 'playlist' ? inPlaylist(item, facet.id) : item);
    const playlist = facet?.kind === 'playlist'
      // A saved playlist can currently contain only one archived video. It is
      // still a playlist when reached through its chip, even though the
      // general search heuristic deliberately treats one result as a video.
      ? allPlaylists().find(entry => entry.id === facet.id) || null
      : !facet && query.trim() ? playlistViewOf(matched) : null;
    // An album is heard in the order it was made in, whatever sort the cards
    // were last given, and a sort chosen on the cards is left as it was.
    const asTracks = Boolean(playlist) && displayedView(view, {query, facet}) === 'videos'
      && showsAsTracks(matched, layoutChoices()[String(playlist.id)]);
    const mode = asTracks ? 'playlist' : effectiveSort(sort, {playlist: Boolean(playlist)});
    return {
      asTracks,
      items: mode === 'playlist' ? inPlaylistOrder(matched)
        : sortItems(matched, {mode, direction: directionOf(mode, directions)}),
      playlist,
    };
  }
  /** The creator a view is about: a channel or creator chip, or a search for
   *  exactly a creator's name (what a shelf card with no id falls back to). */
  function creatorOfView() {
    if (facet?.kind === 'channel' || facet?.kind === 'creator') return nameOf(facet);
    if (facet || !query.trim()) return '';
    const name = query.trim();
    return scoped().some(item => item.facets?.owner?.name === name
      || item.facets?.people?.some(person => person.name === name)) ? name : '';
  }
  function channelBrowseSource() {
    if (player.activeId() || query.trim() || !['channel', 'creator'].includes(facet?.kind)
        || displayedView(view, {query, facet}) !== 'videos'
        || search.value.trim() !== nameOf(facet).trim()) return null;
    const url = channelSubscribeUrl(scoped().filter(item => matchesFacet(item, facet)));
    return url ? {kind: 'channel', url, title: nameOf(facet).trim()} : null;
  }
  function refreshPageTitle() {
    if (!player.activeId()) setPageTitle(facet?.kind === 'playlist' || facet?.kind === 'source'
      ? nameOf(facet) : creatorOfView());
  }
  function drawSort(playlist, playlistReversed) {
    render(sortButtons({sort, directions, playlist, playlistReversed}).map(button => html`
      <button type="button" key=${button.mode} aria-pressed=${String(button.pressed)}
              aria-label=${button.ariaLabel}
              onClick=${() => chooseSort(button, playlist)}>${button.text}</button>`),
    sortControl);
  }
  const tracks = createTracklist({
    root: tracklistRoot,
    linkFor: item => player.linkFor(item),
    onPlay: item => player.playInBackground(item),
    onToggle: () => player.toggle(),
    onToggleFavourite: item => toggleFavourite(item),
    playingId: () => player.playingId(),
    media: player.media,
    waveform: player.waveform,
  });
  /** The cards-or-tracklist switch, shown only on a playlist's own page. */
  function drawLayout(playlist, asTracks) {
    layoutControl.hidden = !playlist || displayedView(view, {query, facet}) !== 'videos';
    for (const button of layoutControl.querySelectorAll('[data-layout]')) {
      button.setAttribute('aria-pressed', String((button.dataset.layout === 'tracks') === asTracks));
    }
  }
  layoutControl.addEventListener('click', event => {
    const button = event.target.closest('[data-layout]');
    const playlist = button && visibleItems().playlist;
    if (!playlist) return;
    const choices = layoutChoices();
    // Choosing what the playlist would have been anyway is no choice, so a
    // playlist that later gains a video goes back to deciding for itself.
    delete choices[String(playlist.id)];
    const natural = showsAsTracks(visibleItems().items) ? 'tracks' : 'cards';
    if (button.dataset.layout !== natural) choices[String(playlist.id)] = button.dataset.layout;
    try { preferences.setItem(LAYOUT_KEY, JSON.stringify(choices)); } catch { /* Still apply for this session. */ }
    draw();
  });
  function chooseSort(button, playlist) {
    // Pressing the playlist's own order again turns the playlist round, which
    // is the playlist's business and saved with it rather than this view's.
    if (button.pressed && button.mode === 'playlist') {
      const {items: shown, playlist: view} = visibleItems();
      if (view?.id) {
        togglePlaylistDirection(String(view.id), isReversed(shown));
      }
      return;
    }
    if (button.pressed) {
      directions[button.mode] = directionOf(button.mode, directions) === 'asc' ? 'desc' : 'asc';
    }
    // Choosing the view's default is the same as no choice, so leaving a
    // playlist for the whole archive goes back to newest first.
    sort = button.mode === effectiveSort(null, {playlist}) ? null : button.mode;
    draw();
  }
  // The shelf shares the watch page's per-channel picture cache, so opening a
  // video the shelf already has a portrait for costs no second fetch.
  const channelImages = createChannelImages();
  const actions = createGalleryActions({store, player, report, draw, filterByFacet, channelImages,
    openCollections, playlistEditor,
    deletion: createDeleteDialog(deleteDialog, {format: {bytes: formatBytes}}),
    load: options => load(options), replaceItems,
    getCollections: () => ({favouriteChannels, favouritePlaylists, playlistOrder}),
    setCollections(next) {
      if (next.favouriteChannels) favouriteChannels = next.favouriteChannels;
      if (next.favouritePlaylists) favouritePlaylists = next.favouritePlaylists;
      if (next.playlistOrder) playlistOrder = next.playlistOrder;
    },
  });
  const {toggleChannelFavourite, togglePlaylistFavourite, toggleFavourite, togglePlaylistDirection,
    deleteVideo, deletePlaylist, cardProps, positionOpenCardMenu} = actions;
  const creatorShelf = createCreatorShelf({
    ...shelf,
    // A shelf card is a channel when the archive knows its channel, and the
    // lone uploader otherwise; either way it filters by that id.
    onSelect: creator => filterByFacet(creator.channelId ? 'channel' : 'creator', creator),
    onToggleFavourite: toggleChannelFavourite,
    loadImage: channelImages,
  });
  const channelGrid = createCreatorShelf({
    ...channels,
    mode: 'all',
    onSelect: creator => filterByFacet(creator.channelId ? 'channel' : 'creator', creator),
    onToggleFavourite: toggleChannelFavourite,
    loadImage: channelImages,
  });
  const favouriteVideoShelf = createVideoShelf({
    ...videoShelf, cardProps: item => cardProps(item, 'shelf'),
    afterRender: track => initialiseCardAccents(track, id => store.itemForRef(id)),
  });
  // The playlists view keeps a channel chip in the view, so it shows that
  // channel's playlists; a playlist chip always opens its videos.
  const openPlaylist = playlist =>
    filterByFacet('playlist', {id: playlist.id, name: playlist.title}, {view: 'videos'});
  // Every playlist card, wherever it is, hearts the same way, and opens to
  // its list when its page would show it as one.
  const playlistFavourites = {
    isFavourite: id => favouritePlaylists.has(String(id)),
    onToggleFavourite: playlist => togglePlaylistFavourite(playlist),
    opensAsList: playlist => showsAsTracks(playlist.items, layoutChoices()[String(playlist.id)]),
  };
  const playlistGrid = createPlaylistGrid({
    root: playlistsRoot,
    onPlay: (item, event) => player.open(item, 0, event),
    onOpen: openPlaylist,
    onFilterOwner: owner => filterByFacet('channel', owner, {view: ownerView()}),
    loadOwnerPortrait: channelImages,
    ...playlistFavourites,
    onEdit: playlist => playlistEditor.edit(playlist),
    onDelete: deletePlaylist,
    subscriptions,
    report,
  });
  // Home folds a whole playlist into one card among the videos, which plays,
  // opens and hearts as it does in the playlists view.
  const collapsePlaylists = createPlaylistCollapser();
  // The choice is shelf-settings.js's, a word on body like the rows it hides.
  const foldsPlaylists = () =>
    !(document.body.dataset.homeHidden || '').split(' ').includes('collapsed-playlists');
  let folding = foldsPlaylists();
  new MutationObserver(() => {
    if (folding === foldsPlaylists()) return;
    folding = foldsPlaylists();
    draw();
  }).observe(document.body, {attributeFilter: ['data-home-hidden']});
  const galleryPlaylists = createPlaylistCards({
    onPlay: (item, event) => player.open(item, 0, event),
    onOpen: openPlaylist,
    onFilterOwner: owner => filterByFacet('channel', owner),
    loadOwnerPortrait: channelImages,
    ...playlistFavourites,
    subscriptions,
    report,
    redraw: () => virtualGallery.refreshMounted(),
  });
  const favouritePlaylistShelf = createPlaylistShelf({
    ...playlistShelf,
    onPlay: (item, event) => player.open(item, 0, event),
    onOpen: openPlaylist,
    onFilterOwner: owner => filterByFacet('channel', owner),
    loadOwnerPortrait: channelImages,
    ...playlistFavourites,
    subscriptions,
    report,
  });
  const channelProfile = createChannelProfile({
    section: profileSection,
    loadImage: channelImages,
    onToggleFavourite: toggleChannelFavourite,
    onBrowse: source => browseSource(source),
    subscriptions,
    report,
  });
  const playlistProfile = createPlaylistProfile({
    section: playlistProfileSection,
    subscriptions,
    onOpenOwner: owner => filterByFacet('channel', owner, {view: 'videos'}),
    onToggleFavourite: playlist => togglePlaylistFavourite(playlist),
    onBrowse: source => browseSource(source),
  });
  // A channel's page and a playlist's page each offer rows of their own
  // favourites, and a channel's page a row of all its playlists, above the
  // videos; the unfiltered videos and playlists views offer the archive's.
  // Which of them show is shelf-settings.js's choice.
  const playlistShelfOptions = {
    onPlay: (item, event) => player.open(item, 0, event),
    onOpen: openPlaylist,
    onFilterOwner: owner => filterByFacet('channel', owner),
    loadOwnerPortrait: channelImages,
    ...playlistFavourites,
    subscriptions,
    report,
  };
  const channelPlaylists = createPlaylistShelf({...channelPlaylistsShelf, ...playlistShelfOptions});
  const pagePlaylists = createPlaylistShelf({...pagePlaylistShelf, ...playlistShelfOptions});
  const viewPlaylists = createPlaylistShelf({...viewPlaylistShelf, ...playlistShelfOptions});
  const pageVideos = createVideoShelf({
    ...pageVideoShelf, cardProps: item => cardProps(item, 'page-shelf'),
    afterRender: track => initialiseCardAccents(track, id => store.itemForRef(id)),
  });

  const ownerView = () => (displayedView(view, {query, facet}) === 'playlists' ? 'playlists' : view);
  /**
   * Clearing means the whole archive, every time. Stepping back through
   * history instead would land on whatever was filtered before — the previous
   * search, or the creator looked at before this one — which is not what
   * "clear" says it does. The cleared view replaces the
   * filter's own history entry rather than pushing a new one, so clearing
   * leaves no entry that would filter the gallery again on Back.
   */
  /** The home view: no filter, the default sort, from the top. It is a
   *  place you go to, like following the link, so it is a history entry. */
  function reset() {
    sort = null;
    for (const mode of Object.keys(directions)) delete directions[mode];
    setView('home');
  }
  function Cards({items}) {
    return items.map(item => item.playlist ? galleryPlaylists.card(item.playlist)
      : html`<${VideoCard} key=${item.id} ...${cardProps(item)} />`);
  }
  const virtualGallery = new ColumnGallery({
    root,
    renderChunk(chunk, items, place) {
      if (!chunk.host) {
        chunk.host = document.createElement('div');
        chunk.host.className = 'gallery-chunk';
        place(chunk.host);
      }
      render(html`<${Cards} items=${items} />`, chunk.host);
      initialiseCardAccents(chunk.host, id => store.itemForRef(id));
      galleryPlaylists.paint(chunk.host);
    },
    unmountChunk(chunk) {
      if (!chunk.host) return;
      render(null, chunk.host);
      chunk.host.remove();
      chunk.host = null;
    },
    elementsForChunk: chunk => chunk.host
      ? [...chunk.host.querySelectorAll('.video-card')] : [],
  });
  /** A message about the archive itself, under the heading; none takes no room. */
  function setStatus(message) {
    summary.textContent = message;
    summary.hidden = !message;
  }
  function setViewStatus(element, message) {
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }
  function markView(onScreen) {
    document.body.dataset.view = onScreen;
    for (const button of navButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mainView === onScreen));
    }
  }
  function draw() {
    refreshPageTitle();
    const {items: shown, playlist, asTracks} = visibleItems();
    editPlaylist.hidden = !playlist?.manual;
    player.setShownPlaylist(playlist?.id ?? null);
    const pool = scoped();
    const total = pool.length;
    // A name is only knowable once the items are in, so a filter restored from
    // the URL labels its box here.
    if (facet && !search.value) {
      search.value = nameOf(facet);
      search.dispatchEvent(new Event('searchsync'));
    }
    const onChannelPage = displayedView(view, {query, facet}) === 'videos'
      && (facet?.kind === 'channel' || facet?.kind === 'creator');
    // The profile names the channel, so the list under it is just its videos.
    drawLayout(playlist, asTracks);
    heading.textContent = playlist ? t(asTracks ? 'tracklist.heading' : 'nav.videos') : galleryHeading({
      creator: onChannelPage ? '' : creatorOfView(),
      source: facet?.kind === 'source' ? nameOf(facet) : '',
    });
    // Nothing to sort in a tracklist: it is the album's order, and the
    // heading is left with the cards-or-tracks switch alone.
    sortControl.hidden = asTracks;
    if (!asTracks) drawSort(Boolean(playlist), isReversed(shown));
    root.classList.toggle('is-playlist-view', Boolean(playlist));
    // The count sits in the search box, and only
    // while something is filtering. In a playlist the playlist's own size is
    // the useful denominator: how much of it this archive actually holds.
    const filtered = Boolean(query.trim() || facet);
    const onScreen = displayedView(view, {query, facet});
    markView(onScreen);
    count.hidden = !total || !filtered;
    count.textContent = t('gallery.countOf', {shown: shown.length, total: playlist?.count || total});
    // Only the view on screen is painted; the rest catch up when shown.
    if (!total) {
      const none = scope ? t('gallery.noFolder') : t('gallery.noArchive');
      setStatus(none);
      setViewStatus(playlistsSummary, none);
      setViewStatus(channelsSummary, none);
      // These surfaces normally redraw only in their own view. Clear them
      // when the last library disappears, including favourites on home.
      creatorShelf.update([], {favourites: favouriteChannels});
      favouriteVideoShelf.update([]);
      favouritePlaylistShelf.update([], favouritePlaylists);
      channelGrid.update([]);
      playlistGrid.update([]);
    } else if (onScreen === 'home') {
      setViewStatus(playlistsSummary, '');
      setViewStatus(channelsSummary, '');
      setStatus('');
      creatorShelf.update(pool, {favourites: favouriteChannels, quiet: Boolean(scope)});
      favouriteVideoShelf.update(pool, {quiet: Boolean(scope)});
      favouritePlaylistShelf.update(allPlaylists(pool), favouritePlaylists, {quiet: Boolean(scope)});
    } else if (onScreen === 'channels') {
      setViewStatus(playlistsSummary, '');
      setStatus('');
      const matched = channelGrid.update(pool,
        {filter: query, favourites: favouriteChannels});
      viewMatches = matched;
      count.textContent = t('gallery.countOf', {shown: matched, total: new Set(pool
        .map(item => item.facets?.owner?.id || item.facets?.people?.[0]?.id)
        .filter(Boolean)).size});
      setViewStatus(channelsSummary, matched ? '' : t('gallery.noChannels'));
    } else if (onScreen === 'playlists') {
      setViewStatus(channelsSummary, '');
      setStatus('');
      const all = allPlaylists(pool);
      const needle = query.trim().toLowerCase();
      const matched = all.filter(entry => (facet ? ownedBy(entry, facet)
        : !needle || `${entry.title} ${entry.owner?.name || ''}`.toLowerCase().includes(needle)));
      playlistGrid.update(matched);
      viewMatches = matched.length;
      playlistsHeading.textContent = facet ? t('gallery.playlistsOf', {name: nameOf(facet)}) : t('nav.playlists');
      count.textContent = t('gallery.countOf', {shown: matched.length, total: all.length});
      setViewStatus(playlistsSummary, matched.length ? '' : t('gallery.noPlaylists'));
    } else {
      setStatus('');
      setViewStatus(playlistsSummary, '');
      setViewStatus(channelsSummary, '');
    }
    const channelFacet = onScreen === 'videos' && (facet?.kind === 'channel' || facet?.kind === 'creator');
    const channelPlaylistsFor = channelFacet
      ? allPlaylists(pool).filter(entry => ownedBy(entry, facet)) : [];
    const profileItems = channelFacet ? pool.filter(item => matchesFacet(item, facet)) : [];
    const owner = profileItems.map(creatorOf).find(Boolean);
    channelProfile.update(channelFacet && profileItems.length ? {
      id: owner?.id || facet.id,
      name: nameOf(facet) || owner?.name || '',
      channelId: facet.kind === 'channel' ? facet.id : owner?.channelId || '',
    } : null, {
      items: profileItems,
      playlists: channelPlaylistsFor,
      favourite: favouriteChannels.has(owner?.id || facet?.id),
    });
    const playlistOwner = playlist && !playlist.manual ? shown.map(item => item.facets?.owner).find(Boolean) : null;
    playlistProfile.update(playlist ? {...playlist, items: shown, owner: playlistOwner} : null,
      {favourite: favouritePlaylists.has(String(playlist?.id)), tracks: asTracks ? tracklistOf(shown) : null});
    // The whole views take their rows only while unfiltered, as home's give
    // way to a search. The videos view's favourites row is the exception: it
    // stays through a search, narrowed to the favourites that match, so a
    // favourite is still found at the top rather than somewhere in the grid.
    const searchingVideos = view === 'videos' && onScreen === 'videos' && !facet && !playlist;
    // A tracklist has no favourite videos row, or the menu that switches it.
    const page = channelFacet ? 'channel' : playlist && onScreen === 'videos' ? (asTracks ? '' : 'playlist')
      : (filtered && !searchingVideos) || !['videos', 'playlists'].includes(onScreen) ? '' : onScreen;
    if (page) document.body.dataset.page = page; else delete document.body.dataset.page;
    channelPlaylists.show(channelPlaylistsFor);
    pagePlaylists.show(page === 'channel' ? favouritesAmong(channelPlaylistsFor, favouritePlaylists) : []);
    viewPlaylists.show(page === 'playlists'
      ? favouritesAmong(allPlaylists(pool), favouritePlaylists) : []);
    pageVideos.show(page === 'channel' ? favouriteVideos(profileItems)
      : page === 'playlist' ? favouriteVideos(shown)
        : page === 'videos' ? favouriteVideos(filtered ? shown : pool) : []);
    // Only home folds playlists, and only while its menu says to: the videos
    // view is every video, and the playlists view already has them as
    // playlists.
    // A tracklist stands in for the cards rather than sitting under them.
    root.hidden = asTracks;
    tracks.update(asTracks ? shown : []);
    // The record layout's styles key on this; see library.css.
    tracklistRoot.parentElement.classList.toggle('is-tracklist-view', !tracklistRoot.hidden);
    virtualGallery.setItems(asTracks ? [] : onScreen === 'home' && foldsPlaylists()
      ? collapsePlaylists(shown, allPlaylists(pool)) : shown);
    if (deletionGalleryAnchor) virtualGallery.restoreAnchor(deletionGalleryAnchor);
    virtualGallery.refreshMounted();
    // Cards the gallery does not own itself - the watch page's related row -
    // read their menu's open state from here, so they are redrawn whenever it
    // changes, including when a click elsewhere closes the menu.
    for (const redraw of cardSurfaces) redraw();
    positionOpenCardMenu();
  }
  const libraryLoader = createLibraryLoader({store, player, report, setStatus,
    applyMetadata({playlistRecords: records, directories, settings}) {
      playlistRecords = records;
      scope = directory.setEntries(directories);
      if (settings) {
        favouriteChannels = new Set(settings.favouriteChannels || []);
        favouritePlaylists = new Set(settings.favouritePlaylists || []);
        playlistOrder = settings.playlistOrder || {};
      }
      return playlistOrder;
    },
    replaceItems,
  });
  function replaceItems(items, {firstLoad = false, notify = true} = {}) {
    actions.reconcileItems(items);
    // Fresh chunks have estimated heights until measured; keep a visible card fixed.
    const anchor = firstLoad ? null : virtualGallery.captureAnchorFor(items);
    deletionGalleryAnchor = anchor;
    try {
      if (notify) store.setItems(items, {notify: true});
    } finally {
      deletionGalleryAnchor = null;
    }
  }
  function load(options) { return libraryLoader.load(options); }
  store.subscribe(draw);
  const refreshPlayback = () => {
    store.allItems().forEach(applyPlaybackPositions);
    store.notify();
  };
  window.addEventListener('archive-playback-change', refreshPlayback);
  window.addEventListener('storage', event => {
    if (event.key === null || event.key.startsWith('reruns.playback:')) refreshPlayback();
  });
  return {
    addToPlaylists: (target, button) => playlistEditor.add(target, button),
    facetLink,
    refreshPageTitle,
    setDownloadProfiles: settings => {
      channelProfile.setProfiles(settings);
      playlistProfile.setProfiles(settings);
    },
    setFormatDownloader(open, close) { actions.setFormatDownloader(open, close); },
    load,
    /** Narrows everything to a folder's videos; the empty key is all of them. */
    setDirectory(key) { scope = key; draw(); },
    items: () => store.allItems(),
    statisticsView: () => ({
      items: visibleItems().items,
      label: [scope ? t('gallery.folder', {scope}) : '', facet ? nameOf(facet) : query.trim() ? t('gallery.search', {query: query.trim()}) : '']
        .filter(Boolean).join(' · ') || t('nav.allVideos'),
    }),
    channelBrowseSource,
    /** The view on screen: what a YouTube search from the topbar looks for. */
    currentView: () => displayedView(view, {query, facet}),
    /** How many the playlists or channels grid matched when last drawn. */
    viewMatches: () => viewMatches,
    /** Everything a video card needs, for the surfaces the gallery does not
     *  draw itself; `surface` keeps one card's menu apart from the same
     *  video's card in the gallery behind it. */
    cardProps,
    /** A surface drawn elsewhere that shows gallery cards, redrawn with the
     *  gallery so its menus open and close with everything else. */
    registerCardSurface(redraw) { cardSurfaces.push(redraw); },
    reset,
    setView,
    toggleFavourite,
    togglePlaylistDirection,
    deleteVideo,
    subscribe: listener => store.subscribe(listener),
    /** The key of the library video the site knows by this extractor and id, or ''. */
    keyForSource(extractor, id) {
      const wanted = String(extractor).toLowerCase();
      const found = store.allItems().find(item => item.archive?.sourceId === String(id)
        && String(item.archive.extractor).toLowerCase() === wanted);
      return found?.id || '';
    },
    /** Opens a library video by its key; false when the library no longer has it. */
    playByKey(key, event) {
      const item = store.itemForRef(key);
      if (!item) return false;
      player.open(item, 0, event);
      return true;
    },
    /** Hands the gallery the browse panel's opener, for its Browse shortcuts. */
    setBrowse(open) {
      browseSource = open;
    },
    setSubscriptions(backend) {
      subscriptionsBackend = backend;
      backend.onChange(() => draw());
    },
  };
}
