import {escapeMarkup, html, MediaRow, render} from 'media-ui';
import {iconMarkup} from './icon.js';
import {preferences} from './preferences.js';
import {nextRepeat, REPEAT_MODES, shuffleOrder, stepFrom} from './track-order.js';
import {inPlaylist, isReversed} from './playlists.js';
import {announcesNext, countdownAt, playlistNav} from './watch-details.js';
import {t} from './i18n.js';

export function createPlayerPlaylist({
  element, mediaPlayer, getItems, getActiveId,
  getPlaylistId, getMiniItem, inAudioBar, advanceMini,
  open, togglePlaylistDirection, autoplayToggle, playlistPopup,
  playlistTitle, playlistNote, playlistEntries, playlistReverse,
  playlistOpen, playlistPosition,
}) {
  // Shuffle and repeat belong to the audio bar, where a run plays through on
  // its own; a watched video's next is the up-next card's to offer.
  const SHUFFLE_KEY = 'ytdlp-audio-shuffle-v1';
  const REPEAT_KEY = 'ytdlp-audio-repeat-v1';
  let shuffle = false;
  let repeat = 'off';
  try {
    shuffle = preferences.getItem(SHUFFLE_KEY) === '1';
    const saved = preferences.getItem(REPEAT_KEY);
    if (REPEAT_MODES.includes(saved)) repeat = saved;
  } catch (_) {}
  let shuffled = null;
  /** The track a step from the playing one lands on, in the bar's order. */
  function audioStep(direction) {
    const miniItem = getMiniItem();
    if (!nav || !miniItem) return null;
    if (shuffle) shuffled = shuffleOrder(nav.entries, miniItem.id, shuffled);
    return stepFrom(shuffle ? shuffled : nav.entries, miniItem.id, direction, repeat);
  }
  // Which part of the run a video is: the number the playlist itself gives,
  // and failing that where it falls among the parts that were archived.
  const partNumber = (entry, entries) =>
    entry.archive?.playlist?.index || entries.indexOf(entry) + 1;

  /**
   * The part arrows sit over the picture, one at each edge.
   * Pointing at one slides out a card naming where it leads; the card ahead
   * also comes up by itself near the end of a part. They live inside the
   * player so they stay with it in fullscreen, and they hide with its
   * controls while the video plays.
   */
  const partNav = document.createElement('div');
  partNav.className = 'archive-part-nav';
  partNav.innerHTML = [-1, 1].map(direction => `
    <div class="archive-part-side" data-part-side="${direction}" hidden>
      <button class="archive-part-step" type="button" data-part-step="${direction}"
              aria-label="${escapeMarkup(t(direction < 0 ? 'player.previousInPlaylist' : 'player.nextInPlaylist'))}">
        ${iconMarkup(direction < 0 ? 'chevron-left' : 'chevron-right')}
      </button>
      <div class="archive-part-card">
        <button class="archive-part-card-body" type="button" tabindex="-1" aria-hidden="true">
          <span class="archive-part-thumb">
            <img alt="" data-part-thumb>
            <span class="archive-part-number" data-part-number></span>
          </span>
          <span class="archive-part-text">
            <span class="archive-part-kicker" data-part-kicker></span>
            <span class="archive-part-title" data-part-title></span>
          </span>
        </button>
        ${direction > 0 ? `<button class="archive-part-dismiss" type="button" data-part-dismiss
                aria-label="${escapeMarkup(t('player.hideUpNext'))}">
          ${iconMarkup('x')}
        </button>
        <span class="archive-part-countdown" aria-hidden="true"></span>` : ''}
      </div>
    </div>`).join('');
  element.append(partNav);
  const partSides = [...partNav.querySelectorAll('[data-part-side]')];
  const nextSide = partNav.querySelector('[data-part-side="1"]');
  const nextKicker = nextSide.querySelector('[data-part-kicker]');
  // Clicks here are navigation, not the player's click-to-pause or
  // double-click-to-fullscreen on the surface underneath.
  for (const type of ['click', 'dblclick']) {
    partNav.addEventListener(type, event => event.stopPropagation());
  }

  const AUTOPLAY_KEY = 'ytdlp-autoplay-v1';
  let autoplay = false;
  try { autoplay = preferences.getItem(AUTOPLAY_KEY) === '1'; } catch (_) {}
  let nav = null;
  // Closing the up-next card holds for the rest of the part, however much
  // the viewer then seeks around in it.
  let upNextDismissed = false;
  let countdownTimer = null;

  // Capture the hidden state before the shared player's pause handler reveals
  // its controls. Autoplay's final second should not move the up-next card.
  mediaPlayer.video.addEventListener('pause', () => {
    if (mediaPlayer.video.ended && autoplay && nav?.next && !upNextDismissed
        && element.classList.contains('is-controls-hidden')) {
      element.classList.add('is-autoplay-ending');
    }
  }, {capture: true});
  for (const type of ['pointermove', 'pointerdown', 'focusin', 'keydown']) {
    element.addEventListener(type, () => element.classList.remove('is-autoplay-ending'));
  }

  const drawAutoplay = () => autoplayToggle.setAttribute('aria-checked', String(autoplay));
  drawAutoplay();

  function announceNext(shown) {
    nextSide.classList.toggle('is-announcing', shown);
    if (!shown) stopCountdown();
  }

  /**
   * Puts the countdown bar where the part's own time says it is. The bar is a
   * CSS animation started part-way through by a negative delay, and it pauses
   * with the video, so it only needs setting again when playback jumps: a
   * play, a pause, a seek, or a change of speed. The run is in the part's own
   * time, so a fast-forwarded outro fills it faster, rather than leaving the
   * bar behind to lurch over the final second. At the end, continue from the
   * rendered position over that second so it cannot snap backwards.
   */
  function syncCountdown() {
    const {video} = mediaPlayer;
    const at = autoplay && nav?.next && !upNextDismissed
      ? countdownAt(video.currentTime, video.duration) : null;
    if (!at) return stopCountdown();
    if (video.ended && countdownTimer !== null) return;
    if (!video.ended) element.classList.remove('is-autoplay-ending');
    clearTimeout(countdownTimer);
    countdownTimer = null;
    const {elapsed} = at;
    const tail = at.total - elapsed;
    let from = 0;
    if (video.ended) {
      const bar = nextSide.querySelector('.archive-part-countdown');
      const transform = getComputedStyle(bar).transform;
      from = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).a;
    }
    nextSide.style.setProperty('--countdown-from', String(from));
    const rate = video.playbackRate > 0 ? video.playbackRate : 1;
    nextSide.style.setProperty('--countdown', `${video.ended ? tail : at.total / rate}s`);
    nextSide.style.setProperty('--countdown-delay', `${video.ended ? 0 : -elapsed / rate}s`);
    nextSide.style.setProperty('--countdown-state',
      video.paused && !video.ended ? 'paused' : 'running');
    // Restarting the animation is what makes a new delay take effect.
    nextSide.classList.remove('is-counting');
    void nextSide.offsetWidth;
    nextSide.classList.add('is-counting');
    nextKicker.textContent = t('watch.playingNext');
    if (video.ended) {
      const target = nav.next.id;
      countdownTimer = setTimeout(() => {
        countdownTimer = null;
        playFromControl(target);
      }, tail * 1000);
    }
  }

  function stopCountdown() {
    clearTimeout(countdownTimer);
    countdownTimer = null;
    element.classList.remove('is-autoplay-ending');
    nextSide.classList.remove('is-counting');
    nextKicker.textContent = t('watch.upNext');
  }

  /**
   * The playlist's two faces on the watch page: the arrows over the player,
   * and the button under it that names the run and where this video sits in
   * it. A run of one is not a run, so anything else leaves both off.
   */
  function drawPlaylist(item, {redraw = false} = {}) {
    item = inPlaylist(item, getPlaylistId()) || item;
    const before = nav?.next?.id;
    nav = playlistNav(item, getItems());
    // A rescan redraws the part already playing, and must not bring back a
    // dismissed card or stop a countdown, unless what comes next has changed.
    if (!redraw || nav?.next?.id !== before) {
      upNextDismissed = false;
      announceNext(false);
    }
    for (const side of partSides) {
      const direction = Number(side.dataset.partSide);
      const target = direction < 0 ? nav?.previous : nav?.next;
      side.hidden = !target;
      if (!target) continue;
      side.querySelector('[data-part-step]').dataset.targetId = target.id;
      side.querySelector('[data-part-title]').textContent = target.title;
      side.querySelector('[data-part-kicker]').textContent = direction < 0 ? t('player.previous') : t('watch.upNext');
      side.querySelector('[data-part-number]').textContent = `${partNumber(target, nav.entries)}`;
      const thumb = side.querySelector('[data-part-thumb]');
      thumb.src = target.thumbnail?.url || '';
      thumb.hidden = !target.thumbnail?.url;
    }
    playlistOpen.hidden = !nav;
    if (!nav) return playlistPopup.hidePopover?.();
    const [index, total] = nav.position.split('/');
    playlistPosition.textContent = `${index}/${total}`;
    playlistOpen.setAttribute('aria-label', t('watch.playlistLabel', {title: nav.title, index, total}));
    playlistOpen.title = nav.title;
    playlistTitle.textContent = nav.title;
    playlistNote.textContent = [t('watch.indexOf', {index, total}), nav.note].filter(Boolean).join(' · ');
    if (playlistReverse) {
      const reversed = isReversed(nav.entries);
      playlistReverse.setAttribute('aria-pressed', String(reversed));
      playlistReverse.setAttribute('aria-label',
        t(reversed ? 'watch.orderReversed' : 'watch.orderRecorded'));
      playlistReverse.title = reversed
        ? t('watch.reversedTitle')
        : t('watch.recordedTitle');
    }
    // Each entry is a button, so choosing one is a click on the row itself.
    // It has no rule beneath it: the current entry is marked by its tint.
    render(nav.entries.map(entry => html`
      <${MediaRow} as="button" type="button" key=${entry.id} size="compact" lines=${2} divided=${false}
        class=${`playlist-entry${entry.id === nav.currentId ? ' is-current' : ''}`}
        data-target-id=${entry.id} lead=${partNumber(entry, nav.entries)}
        thumbnail=${entry.thumbnail?.url || null}>
        <span class="media-row-title">${entry.title}</span>
      <//>`), playlistEntries);
  }

  // Turning the run round here keeps the popup open: the entries and the
  // arrows redraw in place, so the list is seen to flip under the pointer.
  if (playlistReverse) {
    playlistReverse.addEventListener('click', async () => {
      const item = getItems().find(entry => entry.id === getActiveId());
      const playlistId = getPlaylistId() || item?.archive?.playlist?.id;
      if (!playlistId || !togglePlaylistDirection) return;
      await togglePlaylistDirection(String(playlistId), isReversed(nav?.entries || []));
      const current = getItems().find(entry => entry.id === getActiveId());
      if (current) drawPlaylist(current, {redraw: true});
    });
  }

  const playFromControl = target => {
    const entry = nav?.entries.find(candidate => candidate.id === target)
      || getItems().find(candidate => candidate.id === target);
    if (!entry) return;
    // A video in the corner moves on in the corner; opening it would drag the
    // viewer back to the watch page they chose to leave.
    if (getMiniItem()) advanceMini(entry);
    else if (entry.id !== getActiveId()) open(entry);
  };

  for (const side of partSides) {
    const step = side.querySelector('[data-part-step]');
    step.addEventListener('click', () => playFromControl(step.dataset.targetId));
    side.querySelector('.archive-part-card-body')
      .addEventListener('click', () => playFromControl(step.dataset.targetId));
  }
  partNav.querySelector('[data-part-dismiss]').addEventListener('click', () => {
    upNextDismissed = true;
    announceNext(false);
  });

  // The card ahead comes up for the last stretch of a part and stays through
  // its end; seeking back out of that stretch puts it away again.
  mediaPlayer.video.addEventListener('timeupdate', () => {
    if (!nav?.next || upNextDismissed || inAudioBar()) return;
    const {currentTime, duration} = mediaPlayer.video;
    const near = announcesNext(currentTime, duration);
    if (near !== nextSide.classList.contains('is-announcing')) announceNext(near);
    // The countdown starts partway into the up-next stretch, as time passes.
    const counting = nextSide.classList.contains('is-counting');
    if (near && !counting && autoplay && countdownAt(currentTime, duration)) syncCountdown();
  });
  mediaPlayer.video.addEventListener('ended', () => {
    // An album plays through, a track straight into the next, as a record
    // does: the up-next card and its countdown are for videos.
    if (inAudioBar()) {
      if (repeat === 'one') {
        mediaPlayer.requestSeek(0);
        return mediaPlayer.play();
      }
      const target = audioStep(1);
      return target && advanceMini(target);
    }
    if (!nav?.next || upNextDismissed) return;
    announceNext(true);
    syncCountdown();
  });
  // Pausing holds the bar; playing on, seeking or a change of speed puts it
  // back in step, or away again when the seek left the countdown's stretch.
  for (const type of ['play', 'pause', 'seeked', 'ratechange']) {
    mediaPlayer.video.addEventListener(type, () => {
      // `ended` owns the final countdown update. Its preceding pause must
      // not restart the animation or schedule the autoplay tail a second time.
      if (mediaPlayer.video.ended) return;
      if (nextSide.classList.contains('is-announcing')) syncCountdown();
      else stopCountdown();
    });
  }

  autoplayToggle.addEventListener('click', () => {
    autoplay = !autoplay;
    try { preferences.setItem(AUTOPLAY_KEY, autoplay ? '1' : '0'); } catch (_) {}
    drawAutoplay();
    if (!autoplay) stopCountdown();
    else if (nextSide.classList.contains('is-announcing')) syncCountdown();
  });

  // Shift+N and Shift+P step through the run, as they do on YouTube.
  document.addEventListener('keydown', event => {
    if (!getActiveId() || !nav || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const key = event.key.toLowerCase();
    const target = key === 'n' ? nav.next : key === 'p' ? nav.previous : null;
    if (!target) return;
    event.preventDefault();
    playFromControl(target.id);
  });

  playlistEntries.addEventListener('click', event => {
    const button = event.target.closest('.playlist-entry');
    if (!button) return;
    playlistPopup.hidePopover();
    playFromControl(button.dataset.targetId);
  });
  return {
    drawPlaylist, stopCountdown, audioStep,
    order: () => ({shuffle, repeat}),
    resetShuffle() { shuffled = null; },
    toggleShuffle() {
      shuffle = !shuffle;
      shuffled = null;
      try { preferences.setItem(SHUFFLE_KEY, shuffle ? '1' : '0'); } catch (_) {}
    },
    cycleRepeat() {
      repeat = nextRepeat(repeat);
      try { preferences.setItem(REPEAT_KEY, repeat); } catch (_) {}
    },
  };
}
