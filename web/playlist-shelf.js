// The favourite playlists shelf on home: the playlists view's cards, for the
// playlists marked as favourites, capped at a row like the shelves above it.

import {createShelfRows} from 'media-ui';
import {createPlaylistGrid} from './playlist-grid.js';
import {shelfLabels} from './shelf-labels.js';

/** Favourite playlists, in `playlistsFrom`'s order: the one archived into
 *  most recently first. `favourites` is a Set of playlist ids. */
export function favouritePlaylists(playlists, favourites) {
  return (playlists || []).filter(playlist => favourites.has(String(playlist.id)));
}

/**
 * The grid options are `createPlaylistGrid`'s, so a card here plays, opens
 * and hearts exactly as it does in the playlists view.
 */
export function createPlaylistShelf({section, track, moreButton, emptyHint = null, ...gridOptions}) {
  let entries = [];
  const grid = createPlaylistGrid({root: track, ...gridOptions});

  function draw() {
    grid.update(rows.take(entries));
    rows.sync(entries.length);
    if (emptyHint) emptyHint.hidden = entries.length > 0;
  }

  const rows = createShelfRows({
    track, moreButton, labels: shelfLabels(),
    onChange: () => { if (!section.hidden) draw(); },
  }).watch();

  return {
    /** `playlists` is every playlist in the archive; with none at all there
     *  is nothing to favourite, so the shelf keeps out of the way. `quiet`
     *  does the same while none is a favourite, instead of asking for one. */
    update(playlists, favourites, {quiet = false} = {}) {
      entries = favouritePlaylists(playlists, favourites);
      section.hidden = !playlists.length || (quiet && !entries.length);
      if (!section.hidden) draw();
    },
    /** Exactly these playlists, for a channel's or a playlist's page, which
     *  keeps no empty row: with none the shelf is hidden. */
    show(playlists) {
      entries = playlists;
      section.hidden = !playlists.length;
      if (!section.hidden) draw();
    },
  };
}
