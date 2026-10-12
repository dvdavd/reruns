// The playlists view: one card per playlist, in the shared multi-part card
// style, where each of the playlist's videos is a part the arrows step through.

import {accentFromImage, whenImageLoaded} from 'media-ui/accent.js';
import {applyCardAccent, CARD_SELECTOR, CARD_THUMBNAIL_SELECTOR, html, render,
        VideoCard} from 'media-ui';
import {subscribedIdFor} from './subscription-target.js';
import {cardLabels} from './card-labels.js';
import {plural, t} from './i18n.js';

/**
 * One card item standing for a group of videos, each video a part. It knows
 * nothing about playlists or this app, so a group of any kind can use it.
 */
export function collectionItem(items, {id, label, owner = null, collection = null, chip = '',
                                       favourite = false}) {
  const parts = items.map((item, index) => ({
    id: item.id,
    sourceRef: item.sourceRef,
    // The part's title follows the collection's name in the card label.
    title: item.title,
    label: String(item.archive?.playlist?.index || index + 1),
    filename: item.filename,
    durationSeconds: item.durationSeconds,
    sizeBytes: item.sizeBytes,
    quality: chip,
    thumbnail: item.thumbnail,
    accent: item.accent,
    facets: item.facets?.owner ? {owner: item.facets.owner} : undefined,
  }));
  return {
    id,
    sourceRef: parts[0]?.sourceRef || '',
    title: label,
    filename: '',
    quality: chip,
    favourite,
    thumbnail: parts[0]?.thumbnail || {},
    watch: {},
    session: {},
    parts,
    facets: {people: [], owner, collections: collection ? [collection] : [], ordinal: null},
    mtime: Math.max(0, ...items.map(item => Number(item.mtime || 0))),
  };
}

const heldLabel = playlist => (playlist.count > playlist.items.length
  ? `${playlist.items.length} of ${playlist.count}`
  : plural('count.videos', playlist.items.length));

/** A playlist's total running time as "2h 05m", or "" when no video has a length. */
export function runtimeLabel(items) {
  const total = Math.round(items.reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0));
  if (!total) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  if (!hours) return minutes ? `${minutes}m` : `${total}s`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** The card item for a playlist from `playlistsFrom`. */
export function playlistItem(playlist, {favourite = false} = {}) {
  return collectionItem(playlist.items, {
    id: `playlist:${playlist.id}`,
    label: playlist.title,
    // The most common creator stands in for any video that names none.
    owner: playlist.creator ?? playlist.owner,
    collection: {id: playlist.id, name: playlist.title},
    chip: heldLabel(playlist),
    favourite,
  });
}

/**
 * Puts each card's accent on, from whichever of the playlist's videos it is
 * showing. A playlist card is rebuilt from the archive's videos on every draw,
 * so the colour cannot live on the card item - it goes onto the video the part
 * was made from, which is where `collectionItem` reads it back out of. The
 * paint is keyed by the part on show rather than by the card, since one card
 * shows every video in the playlist in turn. Only playlist cards are touched,
 * since home's gallery has video cards beside them.
 */
function paintAccents(root, videosFor) {
  root.querySelectorAll(`${CARD_SELECTOR}[data-playlist-card]`).forEach(card => {
    const showing = card.dataset.partIndex || '0';
    if (card.dataset.accentPart === showing) return;
    card.dataset.accentPart = showing;
    const image = card.querySelector(CARD_THUMBNAIL_SELECTOR);
    whenImageLoaded(image, () => {
      // The arrows may have stepped the card on while the thumbnail loaded.
      if (card.dataset.accentPart !== showing) return;
      const videos = videosFor(card.dataset.playlistCard) || [];
      const at = videos.length
        ? (Number(showing) % videos.length + videos.length) % videos.length : 0;
      applyCardAccent(card, accentFromImage(image), {itemFor: () => videos[at]});
    });
  });
}

/**
 * Playlist cards for any surface: the playlists view, the favourites shelf,
 * and home's gallery, where a whole playlist stands in for its videos. Each
 * card remembers which video it is showing across redraws. The thumbnail
 * plays that video through `onPlay`; the playlist chip opens the playlist's
 * own gallery through `onOpen`, as it does on any card. The heart reads
 * `isFavourite(id)` on every draw, since favourites live in the settings
 * rather than on the videos a card is rebuilt from. `redraw` is the surface's
 * own, called when a card's part or menu changes. A playlist that `opensAsList`
 * says is read as a list - an album, shown as its tracks - opens from the
 * thumbnail too, since a record is put on from its tracklist rather than by
 * dropping into one song's watch page; the chip still opens it as on any card.
 */
export function createPlaylistCards({onPlay, onOpen, opensAsList = () => false, onFilterOwner, loadOwnerPortrait,
                                     isFavourite = () => false,
                                     onToggleFavourite, onEdit, onDelete, subscriptions, report, redraw}) {
  const partIndexes = new Map();
  // Once, as the gallery's are: the language is fixed for the page's life,
  // and one object spares every card new labels on every draw.
  const labels = cardLabels({noun: 'playlists'});
  const shown = new Map();
  let openMenuId = null;

  function closeMenu() {
    openMenuId = null;
  }
  // The menu is a plain popover div, not a native one, so dismissing it on
  // an outside click or Escape is this app's job.
  document.addEventListener('click', event => {
    if (openMenuId != null && !event.target.closest('.menu-popover, .menu-trigger')) {
      closeMenu();
      redraw();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openMenuId != null) {
      closeMenu();
      redraw();
    }
  });

  function card(playlist) {
    shown.set(String(playlist.id), playlist);
    const item = playlistItem(playlist, {favourite: isFavourite(playlist.id)});
    const count = playlist.items.length;
    const partIndex = partIndexes.get(item.id) || 0;
    const showing = playlist.items[(partIndex % count + count) % count];
    const subscriptionId = playlist.url
      ? subscribedIdFor(subscriptions.list(), 'playlist', playlist.url) : null;
    const menuItems = playlist.url
      ? [{action: 'source', label: t('menu.openPlaylist')}, {action: 'copy', label: t('menu.copyPlaylist')},
        {action: 'subscribe', label: subscriptionId ? t('subscriptions.unsubscribe') : t('subscriptions.subscribe')}]
      : [];
    if (playlist.manual && onEdit) menuItems.push({action: 'edit', label: t('menu.editPlaylist')});
    if (onDelete) {
      menuItems.push({action: 'delete', danger: true,
        label: playlist.manual ? t('menu.deletePlaylist') : t('menu.deletePlaylistVideos')});
    }
    return html`
      <${VideoCard}
        key=${item.id} item=${item} partIndex=${partIndex}
        labels=${labels}
        loadOwnerPortrait=${loadOwnerPortrait && (owner => loadOwnerPortrait(owner.id))}
        durationInCorner=${true}
        channelMetadata=${[runtimeLabel(playlist.items)]}
        dataset=${{'data-playlist-card': playlist.id, 'data-part-id': showing?.id || '',
                   'data-favourite': String(item.favourite)}}
        menuItems=${menuItems} menuOpen=${openMenuId === item.id}
        onOpenDetails=${(_item, at, event) => {
          if (!count || opensAsList(playlist)) return onOpen(playlist);
          // The event goes on to the player, which zooms the card's
          // thumbnail out into the stage; without it the player just appears.
          onPlay(playlist.items[(at % count + count) % count], event);
        }}
        onFilterCollection=${() => onOpen(playlist)}
        onChangePart=${(target, direction) => {
          partIndexes.set(target.id, (partIndexes.get(target.id) || 0) + direction);
          redraw();
        }}
        onFilterOwner=${onFilterOwner}
        onToggleFavourite=${onToggleFavourite && (() => onToggleFavourite(playlist))}
        onToggleMenu=${target => {
          openMenuId = openMenuId === target.id ? null : target.id;
          redraw();
        }}
        onMenuAction=${async action => {
          closeMenu();
          try {
            if (action === 'source') window.open(playlist.url, '_blank', 'noopener');
            if (action === 'copy') await navigator.clipboard.writeText(playlist.url);
            if (action === 'edit') onEdit?.(playlist);
            if (action === 'delete') await onDelete?.(playlist);
            if (action === 'subscribe') {
              if (subscriptionId) await subscriptions.unsubscribe(subscriptionId, playlist.title);
              else await subscriptions.subscribe(playlist.url);
            }
          } catch (error) {
            report(t('error.reason', {message: t('gallery.error.action'), reason: error.message || error}), {error: true});
          }
          redraw();
        }}
      />`;
  }

  return {
    card,
    /** Accents for the playlist cards under `root`, once they are drawn. */
    paint(root) {
      paintAccents(root, id => shown.get(id)?.items);
    },
  };
}

/** Paints the playlists view's grid, one card per playlist. */
export function createPlaylistGrid({root, ...cardOptions}) {
  let playlists = [];
  const cards = createPlaylistCards({...cardOptions, redraw: draw});

  function draw() {
    render(playlists.map(cards.card), root);
    cards.paint(root);
  }

  return {
    update(next) {
      playlists = next;
      draw();
    },
  };
}
