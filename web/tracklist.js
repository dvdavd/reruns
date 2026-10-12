// A playlist of music, drawn as an album's tracklist rather than a grid of
// cards: a cover is a poor thing to tell twelve songs apart by, and every card
// of an album wears the same one. The gallery decides when a playlist reads
// this way and hands over the items in whatever order its sort chose.
import {formatDuration, html, render} from 'media-ui';
import {icon} from './icon.js';
import {t} from './i18n.js';

/**
 * Whether a playlist is shown as tracks. The viewer's choice for this
 * playlist wins; without one, it is tracks when everything held is either
 * sound alone or a track some service filed under an album. One video among
 * them is enough to keep the cards, since a list would hide its picture.
 */
export function showsAsTracks(items, choice) {
  if (choice === 'tracks' || choice === 'cards') return choice === 'tracks';
  return items.length > 0 && items.every(item => item.audioOnly || item.music?.album);
}

/** The value every item gives, or '' when they differ or any gives none. */
function shared(items, valueOf) {
  const values = new Set(items.map(valueOf));
  return values.size === 1 ? [...values][0] || '' : '';
}

/**
 * Whether a track's picture is a record's cover. A track a service filed
 * under an album wears its cover, square - YouTube's own copy pads it out to
 * 16:9 with bars, which a square crop takes off again. Anything else saved as
 * sound alone wears its video's still, 16:9, which a square would cut the
 * sides off.
 */
export const hasCover = item => Boolean(item.music?.album);

/**
 * Whether an item is listened to rather than watched, which is what puts it
 * in the audio bar instead of the corner window: sound alone, or a track
 * filed under an album whatever its file - YouTube Music saved with a video
 * profile is the cover held still for the length of the song, nothing to
 * watch.
 */
export const isListened = item => Boolean(item?.audioOnly || hasCover(item || {}));

/**
 * Whether leaving the watch page with this playing carries on in the
 * background player, for the viewer's setting: 'auto' keeps anything, 'audio'
 * only what is listened to rather than watched, 'off' nothing. Apart from the
 * controller's closure so that the rule can be tested.
 */
export const keepsPlayingIn = (mode, item) => mode === 'auto' || (mode === 'audio' && isListened(item));

/**
 * What a tracklist knows about itself: whether its tracks are one album, and
 * by one artist, which decides what each row needs to say, and whether its
 * pictures are all covers, which decides the shape of the header's. An
 * album's rows all wear the same cover, so they leave it to the header; a
 * mixed list keeps each track's own.
 */
export function tracklistOf(items) {
  const album = shared(items, item => item.music?.album || '');
  const artist = shared(items, item => item.music?.artist || '');
  return {
    album,
    artist,
    year: album ? shared(items, item => item.music?.year || 0) || 0 : 0,
    covers: items.length > 0 && items.every(hasCover),
  };
}

/**
 * A track's own number, kept whatever the list is sorted by, as a record's
 * sleeve keeps it: the number the album gave it, else its place in the
 * playlist. A track with neither has none, rather than a count that would
 * change meaning with the sort.
 */
export function trackNumberOf(item) {
  return item.music?.trackNumber || item.archive?.playlist?.index || '';
}

/** The line under a title: who it is by, when that is not the whole list's. */
function bylineOf(item, list) {
  if (list.artist) return '';
  return item.music?.artist || item.facets?.owner?.name || '';
}

/**
 * The list itself. `onPlay` plays a track where the list is, from its top,
 * as a record does when the needle is put down on it; the row is still a
 * link to the track's watch page for a new tab. A row whose track the player
 * already holds pauses or carries on instead, through `onToggle`, rather
 * than starting the song again. The playing row's bars follow the player's
 * own waveform, `waveform`, where it has a live signal to give.
 */
export function createTracklist({root, linkFor, onPlay, onToggle, onToggleFavourite, playingId, media, waveform}) {
  let shown = [];
  // The bars being driven, and how to stop: one row at a time.
  let followed = null;
  let unfollow = null;

  /** Marks the track the player holds, open or in the corner, and whether it
   *  is sounding. Painted onto the rows rather than rendered, since the
   *  player moves on without the gallery drawing. */
  function paintPlaying() {
    const id = playingId?.() || null;
    const sounding = Boolean(id && media && !media.paused && !media.ended);
    let bars = null;
    for (const row of root.querySelectorAll('.track')) {
      const current = row.dataset.id === id;
      if (current) bars = row.querySelector('.track-sounding');
      row.classList.toggle('is-playing', current);
      row.classList.toggle('is-sounding', current && sounding);
      const link = row.querySelector('.track-play');
      if (current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
    if (bars !== followed) {
      unfollow?.();
      followed = bars;
      // Heights from 3px to the 12px the bars stand in, and livelier than the
      // player's, since three bars that size barely stir at its level.
      unfollow = bars && waveform ? waveform.follow(bars, {min: 3, max: 12, gain: 2.2}) : null;
    }
  }
  for (const event of ['play', 'pause', 'ended', 'emptied', 'loadstart']) {
    media?.addEventListener(event, paintPlaying);
  }

  function Track({item, list}) {
    const byline = bylineOf(item, list);
    const thumbnail = list.album ? '' : item.thumbnail?.url || '';
    const number = trackNumberOf(item);
    return html`
      <li class="track" key=${item.id} data-id=${item.id}
          data-audio-only=${item.audioOnly ? '' : undefined}>
        <a class="track-play" href=${linkFor?.(item)}
           aria-label=${t('tracklist.play', {title: item.title})}
           onClick=${event => {
             if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
             event.preventDefault();
             if (item.id === playingId?.()) onToggle?.(item);
             else onPlay?.(item, event);
           }}>
          <span class="track-number" aria-hidden="true">
            <span class="track-number-text">${number}</span>
            ${icon('play', 'track-play-glyph')}
            ${icon('pause-14', 'track-pause-glyph', '0 0 14 14')}
            <span class="track-sounding"><span></span><span></span><span></span></span>
          </span>
          ${!list.album && html`
            <span class="track-art" data-cover=${hasCover(item) ? '' : undefined}>
              ${thumbnail && html`<img src=${thumbnail} alt="" loading="lazy" decoding="async"
                onError=${event => { event.currentTarget.hidden = true; }} />`}
            </span>`}
          <span class="track-text">
            <span class="track-title">${item.title}</span>
            ${byline && html`<span class="track-byline">${byline}</span>`}
          </span>
        </a>
        <button class="track-favourite" type="button" aria-pressed=${String(Boolean(item.favourite))}
                aria-label=${t(item.favourite ? 'fav.remove' : 'fav.add',
                  {name: item.title, noun: t('fav.noun.videos')})}
                onClick=${() => onToggleFavourite?.(item)}>
          ${icon(item.favourite ? 'heart-filled' : 'heart-outline')}
        </button>
        <span class="track-duration">${item.durationSeconds ? formatDuration(item.durationSeconds) : ''}</span>
      </li>`;
  }

  return {
    /** Draws `items`, or clears the list when given none. */
    update(items) {
      shown = items || [];
      root.hidden = !shown.length;
      const list = tracklistOf(shown);
      root.classList.toggle('is-album', Boolean(list.album));
      render(shown.map(item => html`<${Track} key=${item.id} item=${item} list=${list} />`), root);
      paintPlaying();
    },
    paintPlaying,
    get items() { return shown; },
  };
}
