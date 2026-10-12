// The favourite videos shelf on home: the
// same cards as the gallery, for the videos marked as favourites.

import {createShelfRows, html, render, VideoCard} from 'media-ui';
import {t} from './i18n.js';
import {shelfLabels} from './shelf-labels.js';

/** Favourites, newest first; the shelf shows one row of them. */
export function favouriteVideos(items) {
  return (items || []).filter(item => item.favourite)
    .sort((left, right) => Number(right.mtime || 0) - Number(left.mtime || 0));
}

/**
 * `cardProps(item)` is whatever the gallery gives its own cards, so a card
 * behaves the same in either place; `afterRender(track)` finishes the cards the
 * same way too.
 */
export function createVideoShelf({section, track, moreButton, cardProps, afterRender}) {
  let entries = [];

  function draw() {
    const shown = rows.take(entries);
    rows.sync(entries.length);
    render(shown.length
      ? shown.map(item => html`<${VideoCard} key=${item.id} ...${cardProps(item)} />`)
      : html`<p class="shelf-empty">${t('shelf.hint.video')}</p>`, track);
    afterRender?.(track);
  }

  const rows = createShelfRows({
    track, moreButton, labels: shelfLabels(),
    onChange: () => { if (!section.hidden) draw(); },
  }).watch();

  return {
    /** `quiet` keeps the shelf out of the way while no video is a favourite,
     *  instead of asking for one. */
    update(items, {quiet = false} = {}) {
      entries = favouriteVideos(items);
      section.hidden = !items.length || (quiet && !entries.length);
      if (!section.hidden) draw();
    },
    /** Exactly these videos, for a channel's or a playlist's page, which
     *  keeps no empty row: with none the shelf is hidden. */
    show(videos) {
      entries = videos;
      section.hidden = !videos.length;
      if (!section.hidden) draw();
    },
  };
}
