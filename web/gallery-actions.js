import {cardLabels} from './card-labels.js';
import {plural, t} from './i18n.js';
import {post} from './api.js';
import {deletionVersions, survivingFormatId} from './delete-dialog.js';
import {selectFormat, sourceUrlFor} from './item-adapter.js';
import {markPlaylistDirection} from './playlists.js';
import {withoutStrayDividers} from './menu-items.js';
import {cardThumbnailSizes} from './thumbnail-sizes.js';
import {formatShortDate} from './watch-details.js';

export function createGalleryActions({
  store, player, report, draw,
  filterByFacet, channelImages, openCollections, playlistEditor,
  deletion, load, replaceItems, getCollections,
  setCollections,
}) {
  let openFormatDownload = null;
  let closeFormatDownload = null;
  // A video can render in more than one surface at once (the favourites
  // shelf and the main gallery, say), so menu ownership needs the surface
  // too, or opening one card's menu would open its twin's as well.
  let openMenu = {surface: null, id: null};
  const closingMenus = new Map();
  const menuKey = ({surface, id}) => `${surface}\u0000${id}`;
  function setCardMenu(next) {
    if (openMenu.id != null && (openMenu.surface !== next.surface || openMenu.id !== next.id)) {
      const key = menuKey(openMenu);
      clearTimeout(closingMenus.get(key));
      closingMenus.set(key, setTimeout(() => {
        closingMenus.delete(key);
        draw();
      }, 170));
    }
    if (next.id != null) {
      const key = menuKey(next);
      clearTimeout(closingMenus.get(key));
      closingMenus.delete(key);
    }
    openMenu = next;
    draw();
  }
  const labels = cardLabels({play: 'card.playArchived'});
  const hooks = {
    owner: owner => ({'data-channel-filter': owner.name}),
    source: source => ({'data-source-filter': source.name}),
    person: person => ({'data-creator-filter': person.name}),
  };
  const menuItems = [
    {action: 'add-playlist', label: t('menu.addToPlaylists'), submenu: true,
      controls: 'playlist-add-menu'},
    {action: 'save-file', label: t('menu.saveFile')},
    {action: 'download-format', label: t('menu.downloadFormat'), submenu: true,
      popupRole: 'dialog', controls: 'download-advanced'},
    {type: 'divider'},
    {action: 'source', label: t('menu.openSource')},
    {action: 'copy', label: t('menu.copySource')},
    {type: 'divider'},
    {action: 'delete', label: t('menu.delete'), danger: true},
  ];

  // A personal playlist is only a record, so its videos go only if the panel
  // had them ticked; a downloaded one is its videos, and those ticked go.
  async function deletePlaylist(playlist) {
    const chosen = await deletion.confirmPlaylist(playlist);
    if (!chosen) return;
    if (playlist.manual) await post('/api/playlists', {action: 'delete', id: playlist.id});
    const doomed = new Set(playlist.items.filter(item => deletionVersions(item)
      .every(version => chosen.includes(version.id))).map(item => item.id));
    if (doomed.has(player.activeId())) player.close();
    for (const id of chosen) await post('/api/item/delete', {id});
    await load();
  }
  async function toggleChannelFavourite(creator) {
    const previous = getCollections().favouriteChannels.has(creator.id);
    const apply = favourite => {
      const favouriteChannels = new Set(getCollections().favouriteChannels);
      if (favourite) favouriteChannels.add(creator.id); else favouriteChannels.delete(creator.id);
      setCollections({favouriteChannels});
      draw();
    };
    apply(!previous);
    try {
      await post('/api/favourite-channel', {id: creator.id, favourite: !previous});
    } catch (error) {
      apply(previous);
      report(t('error.reason', {message: t('gallery.error.favourite'), reason: error.message || error}), {error: true});
    }
  }
  async function togglePlaylistFavourite(playlist) {
    const id = String(playlist.id);
    const previous = getCollections().favouritePlaylists.has(id);
    const apply = favourite => {
      const favouritePlaylists = new Set(getCollections().favouritePlaylists);
      if (favourite) favouritePlaylists.add(id); else favouritePlaylists.delete(id);
      setCollections({favouritePlaylists});
      draw();
    };
    apply(!previous);
    try {
      await post('/api/favourite-playlist', {id, favourite: !previous});
    } catch (error) {
      apply(previous);
      report(t('error.reason', {message: t('gallery.error.favourite'), reason: error.message || error}), {error: true});
    }
  }
  async function toggleFavourite(target) {
    const previous = target.favourite;
    store.updateItemAtRef(target.id, item => { item.favourite = !previous; });
    try {
      await post('/api/favourite', {id: target.id, favourite: !previous});
    } catch (error) {
      store.updateItemAtRef(target.id, item => { item.favourite = previous; });
      report(t('error.reason', {message: t('gallery.error.favourite'), reason: error.message || error}), {error: true});
    }
  }
  /** Everything a video card needs, shared by the gallery and the shelf;
   *  `surface` tells one card's menu apart from the same video's elsewhere. */
  function cardProps(item, surface = 'gallery') {
    const collections = item.facets?.collections || [];
    // A related card is narrow, so the playlists it is in go in its menu
    // rather than taking a button beside the title. One playlist is shown
    // straight away; only a choice of several needs a submenu.
    const several = collections.length > 1;
    const playlistsRow = surface === 'related' && collections.length
      ? [{action: 'show-playlists', label: plural('menu.showPlaylist', collections.length),
        ...(several ? {submenu: true, controls: 'collection-menu'} : {})}, {type: 'divider'}]
      : [];
    return {
      item, labels, hooks,
      loadOwnerPortrait: owner => channelImages(owner === item.facets?.owner ? owner.id : ''),
      durationInCorner: true,
      thumbnailSizes: cardThumbnailSizes(),
      // A track's album says more than the day its upload was dated, which
      // for a label's catalogue is when the label got round to it.
      channelMetadata: [
        item.music?.album || formatShortDate(item.archive?.uploadedAt),
      ],
      menuItems: withoutStrayDividers([...playlistsRow, ...menuItems].filter(entry => entry.action === 'save-file'
        ? Boolean(item.sourceRef)
        : entry.action === 'download-format' ? Boolean(sourceUrlFor(item) && openFormatDownload)
        : entry.action === 'delete' ? document.body.dataset.canDelete !== 'false' : true)),
      // This archive saves a resumable position locally, so its gallery,
      // favourite shelf, and related cards should expose that progress.
      showSavedProgress: true,
      dataset: {'data-favourite': String(item.favourite)},
      menuOpen: openMenu.surface === surface && openMenu.id === item.id,
      menuClosing: closingMenus.has(menuKey({surface, id: item.id})),
      onOpenDetails: player.open,
      detailsUrlFor: player.linkFor,
      onFilterOwner: owner => filterByFacet('channel', owner),
      onFilterSource: source => filterByFacet('source', source),
      onFilterPerson: person => filterByFacet('creator', person),
      onFilterCollection: collection => filterByFacet('playlist', collection),
      onOpenCollections: (_item, collections, chip) => openCollections(collections, chip),
      onToggleFavourite: toggleFavourite,
      onToggleMenu: target => {
        const wasOpen = openMenu.surface === surface && openMenu.id === target.id;
        closeSubmenus();
        setCardMenu(wasOpen ? {surface: null, id: null} : {surface, id: target.id});
      },
      onMenuItemHover: (entry, target, event) => {
        const row = event.currentTarget;
        const keyboard = event.type === 'keydown' || (event.type === 'click' && event.detail === 0);
        const pointer = event.type === 'pointerenter';
        cancelSubmenuOpen();
        // Each submenu row opens its own and lets the other go, after a beat
        // so a pointer cutting across a row on its way into one keeps it.
        if (entry.action !== 'add-playlist') playlistEditor?.closeSubmenu({delay: 150});
        if (entry.action !== 'show-playlists') openCollections?.closeSubmenu?.({delay: 150});
        if (entry.action !== 'download-format') closeFormatDownload?.({delay: 150});
        if (!entry.submenu) return;
        if (pointer) settleThenOpen(row, () => openSubmenu(entry, target, row, false));
        else openSubmenu(entry, target, row, keyboard);
      },
      onMenuAction: async (action, target) => {
        closeSubmenus();
        setCardMenu({surface: null, id: null});
        const sourceUrl = sourceUrlFor(target);
        try {
          if (action === 'delete') await deleteVideo(target);
          if (action === 'show-playlists' && target.facets?.collections?.length) {
            filterByFacet('playlist', target.facets.collections[0]);
          }
          if (action === 'save-file' && target.sourceRef) {
            const link = document.createElement('a');
            link.href = target.sourceRef;
            link.download = target.filename || '';
            document.body.append(link);
            link.click();
            link.remove();
          }
          if (action === 'source' && sourceUrl) window.open(sourceUrl, '_blank', 'noopener');
          if (action === 'copy' && sourceUrl) await navigator.clipboard.writeText(sourceUrl);
        } catch (error) {
          report(t('error.reason', {message: t('gallery.error.action'), reason: error.message || error}), {error: true});
        }
        draw();
      },
    };
  }
  /**
   * Removes the copies the viewer picked out of the panel. A video held at
   * several qualities is one card standing for several files, so deleting can
   * leave the video there with fewer of them: the card only goes when nothing
   * of it is left, and the rescan afterwards is what settles which copy the
   * card then stands for.
   */
  async function deleteVideo(target) {
    const versions = deletionVersions(target);
    const chosen = await deletion.confirm(target);
    if (!chosen?.length) return;
    const watching = player.activeId() === target.id;
    const activeFormatId = target.archive.formatId || target.id;
    const nextFormatId = survivingFormatId(target, chosen);
    const handoff = watching && nextFormatId
      && (chosen.includes(activeFormatId) || chosen.includes(target.id));
    const playback = handoff ? player.playbackSnapshot() : null;
    for (const id of chosen) await post('/api/item/delete', {id});
    const removesCard = chosen.length === versions.length;
    if (watching && removesCard) player.close();
    const remaining = removesCard
      ? store.allItems().filter(item => item.id !== target.id) : store.allItems();
    replaceItems(remaining, {notify: removesCard});
    await load({refreshPlayer: !handoff});
    if (handoff && player.activeId() === target.id) {
      const replacement = store.allItems().find(item => item.id === nextFormatId
        || item.archive?.formats?.some(format => format.id === nextFormatId));
      if (replacement) {
        selectFormat(replacement, nextFormatId);
        await player.replaceDeletedFormat(replacement, playback);
      } else {
        player.close();
      }
    }
  }

  /* A submenu waits for the pointer to settle on its row before opening:
     opened on entry, every row a pointer swept across on its way down the
     menu flashed its submenu up and away again. Settled is a short spell
     without movement, or a slightly longer one on the row however it moves,
     so a pointer drifting along the row towards the submenu still opens it. */
  const SUBMENU_SETTLE = 90;
  const SUBMENU_DWELL = 260;
  let pendingOpen = null;
  function cancelSubmenuOpen() {
    if (!pendingOpen) return;
    pendingOpen.stop();
    pendingOpen = null;
  }
  function settleThenOpen(row, open) {
    let settle = null;
    const fire = () => { cancelSubmenuOpen(); if (row.isConnected) open(); };
    const moved = () => { clearTimeout(settle); settle = setTimeout(fire, SUBMENU_SETTLE); };
    const dwell = setTimeout(fire, SUBMENU_DWELL);
    row.addEventListener('pointermove', moved);
    row.addEventListener('pointerleave', cancelSubmenuOpen);
    moved();
    pendingOpen = {stop() {
      clearTimeout(settle);
      clearTimeout(dwell);
      row.removeEventListener('pointermove', moved);
      row.removeEventListener('pointerleave', cancelSubmenuOpen);
    }};
  }
  /* Opening one submenu lets the others go at once rather than after their
     grace: the new row's aria-expanded takes it out of the rows that dim an
     open one, so the old row relit until its own close came round. */
  function openSubmenu(entry, target, row, focus) {
    if (entry.action !== 'add-playlist') playlistEditor?.closeSubmenu();
    if (entry.action !== 'show-playlists') openCollections?.closeSubmenu?.();
    if (entry.action === 'show-playlists') {
      closeFormatDownload?.();
      openCollections(target.facets?.collections || [], row, {side: true, focus});
      return;
    }
    if (entry.action === 'add-playlist') {
      closeFormatDownload?.();
      playlistEditor?.add(target, row, {side: true, focus});
      return;
    }
    if (entry.action !== 'download-format') return;
    const sourceUrl = sourceUrlFor(target);
    if (sourceUrl) openFormatDownload?.(row, {url: sourceUrl, side: true, focus});
  }

  function closeSubmenus() {
    cancelSubmenuOpen();
    closeFormatDownload?.();
    openCollections?.closeSubmenu?.();
    playlistEditor?.closeSubmenu();
  }
  function closeCardMenu() {
    if (openMenu.id == null) return;
    closeSubmenus();
    setCardMenu({surface: null, id: null});
  }
  function positionOpenCardMenu() {
    const menu = document.querySelector('.video-card.menu-open .card-menu > .menu-popover');
    if (!menu) return;
    const trigger = menu.previousElementSibling;
    const headerBottom = Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0);
    const above = Math.max(0, trigger.getBoundingClientRect().top - headerBottom - 5);
    const below = Math.max(0, innerHeight - trigger.getBoundingClientRect().bottom - 5);
    const opensBelow = menu.scrollHeight > above && below > above;
    menu.style.top = opensBelow ? 'calc(100% + 5px)' : 'auto';
    menu.style.bottom = opensBelow ? 'auto' : 'calc(100% + 5px)';
    menu.style.maxHeight = `${opensBelow ? below : above}px`;
  }
  window.addEventListener('scroll', positionOpenCardMenu, {passive: true});
  window.addEventListener('resize', positionOpenCardMenu);
  // The menu is a plain popover div, not a native one, so dismissing it on
  // an outside click or Escape is this app's job.
  document.addEventListener('click', event => {
    if (openMenu.id != null && !event.target.closest('.menu-popover, .menu-trigger')) closeCardMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openMenu.id != null) closeCardMenu();
  });
  /**
   * Point a playlist the other way and remember it. The dates only ever
   * guessed, so a viewer saying otherwise settles it for good: what is saved
   * is the direction itself, not "flip whatever was guessed", or the guess
   * changing later would quietly change what they asked for.
   */
  async function togglePlaylistDirection(playlistId, reversed) {
    const previous = getCollections().playlistOrder[playlistId];
    const apply = choice => {
      const playlistOrder = {...getCollections().playlistOrder};
      if (choice) playlistOrder[playlistId] = choice; else delete playlistOrder[playlistId];
      setCollections({playlistOrder});
      markPlaylistDirection(store.allItems(), playlistOrder);
      draw();
    };
    apply(reversed ? 'forward' : 'reverse');
    try {
      await post('/api/playlist-order', {id: playlistId, order: getCollections().playlistOrder[playlistId]});
    } catch (error) {
      apply(previous);
      report(t('error.reason', {message: t('gallery.error.order'), reason: error.message || error}), {error: true});
    }
  }
  return {
    toggleChannelFavourite, togglePlaylistFavourite, toggleFavourite, togglePlaylistDirection,
    deleteVideo, deletePlaylist, cardProps, positionOpenCardMenu,
    setFormatDownloader(open, close) { openFormatDownload = open; closeFormatDownload = close; },
    reconcileItems(items) {
      if (openMenu.id && !items.some(item => item.id === openMenu.id)) openMenu = {surface: null, id: null};
    },
  };
}
