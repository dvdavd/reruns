import {createVolumePopup, formatPlayerTime, iconHref, volumeLevel} from 'media-ui';
import {createSeekPreview} from './seek-preview.js';
import {ASPECT_MORPH_MS} from './player-transitions.js';
import {preferences} from './preferences.js';
import {inPlaylist} from './playlists.js';
import {hasCover, isListened, keepsPlayingIn} from './tracklist.js';
import {watchLinks} from './watch-details.js';
import {t} from './i18n.js';

export function createBackgroundPlayer({
  page, mediaPlayer, audioBar, getMiniItem,
  getPlaylistId, playlistController, inAudioBar, advanceMini,
  restoreMini, closeMini, close, urlFor,
  linkTo, leaveBar, fitSettingsPage, settingsPages,
  backgroundOptions, backgroundSummary, backgroundSwitch, backgroundNote, backgroundButton,
}) {
  const {audioStep} = playlistController;
  // Which of the two the background player was switched to - 'audio' for
  // the bar, 'video' for the corner window - or null to go by the item (see
  // isListened). It holds while the background player carries on through a
  // playlist, and goes with it. Sound alone has nothing to show, so it is
  // always the bar.
  let barChoice = null;
  const inBar = item => Boolean(item?.audioOnly
    || (barChoice ? barChoice === 'audio' : isListened(item)));
  const BACKGROUND_KEY = 'ytdlp-background-play-v1';
  // What leaving the watch page does with something still playing: 'auto'
  // carries on any of it in the background player, 'audio' only what is
  // listened to (see isListened), 'off' none - the bar's own button is always
  // there to ask outright. Never chosen is 'audio', which is how music behaved
  // before there was a setting for it. The key predates the modes and stored
  // '1' and '0', read as auto and off; a stored 'manual' was off with the
  // button shown, which is now simply off. The stored names are older than the
  // labels: 'auto' is shown as On and 'audio' as Automatic, so that nobody's
  // saved choice changes meaning.
  const BACKGROUND_MODES = [
    ['auto', t('common.on'), t('player.backgroundOnNote')],
    ['audio', t('player.automatic'), t('player.backgroundAutomaticNote')],
    ['off', t('common.off'), t('player.backgroundOffNote')],
  ];
  let backgroundPlay = 'audio';
  try {
    const saved = preferences.getItem(BACKGROUND_KEY);
    if (saved === '1') backgroundPlay = 'auto';
    else if (saved === '0' || saved === 'manual') backgroundPlay = 'off';
    else if (BACKGROUND_MODES.some(([mode]) => mode === saved)) backgroundPlay = saved;
  } catch (_) {}
  // What the menu's switch turns background play back on to: whichever of
  // On and Automatic was chosen last, Automatic if neither ever was.
  const BACKGROUND_ON_KEY = 'ytdlp-background-play-on-v1';
  let backgroundOnMode = backgroundPlay === 'off' ? 'audio' : backgroundPlay;
  try {
    const saved = preferences.getItem(BACKGROUND_ON_KEY);
    if (backgroundPlay === 'off' && (saved === 'auto' || saved === 'audio')) backgroundOnMode = saved;
  } catch (_) {}
  const chooseBackgroundPlay = mode => {
    backgroundPlay = mode;
    try { preferences.setItem(BACKGROUND_KEY, mode); } catch (_) {}
    if (mode !== 'off') {
      backgroundOnMode = mode;
      try { preferences.setItem(BACKGROUND_ON_KEY, mode); } catch (_) {}
    }
    drawBackgroundPlay();
  };
  const drawBackgroundPlay = () => {
    const [, , note] = BACKGROUND_MODES.find(([mode]) => mode === backgroundPlay);
    // The switch says on or off; only Automatic needs saying as well, and
    // shortened, since it shares the row with the switch and the chevron.
    backgroundSummary.textContent = backgroundPlay === 'audio' ? t('player.automaticShort') : '';
    backgroundSwitch.setAttribute('aria-checked', String(backgroundPlay !== 'off'));
    backgroundNote.textContent = note;
    // A note of another length wraps to another height, though only while the
    // page is the one showing: drawn at start-up the menu has no size yet.
    if (settingsPages.dataset.page === 'background') fitSettingsPage('background');
    backgroundOptions.querySelectorAll('[data-background-mode]').forEach(row => {
      row.setAttribute('aria-checked', String(row.dataset.backgroundMode === backgroundPlay));
    });
  };
  backgroundOptions.replaceChildren(...BACKGROUND_MODES.map(([mode, label]) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-option';
    row.setAttribute('role', 'radio');
    row.dataset.backgroundMode = mode;
    row.innerHTML = '<svg class="settings-option-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg><span></span><span></span>';
    row.children[1].textContent = label;
    row.addEventListener('click', () => chooseBackgroundPlay(mode));
    return row;
  }));
  drawBackgroundPlay();
  backgroundSwitch.addEventListener('click', () => {
    chooseBackgroundPlay(backgroundPlay === 'off' ? backgroundOnMode : 'off');
  });
  backgroundButton.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    close({mini: true});
  });
  for (const type of ['dblclick']) backgroundButton.addEventListener(type, event => event.stopPropagation());

  const miniControls = page.querySelector('[data-mini-controls]');
  // The corner window and the audio bar each have a play and a mute button,
  // and both pairs say the same thing, whichever is on screen.
  function drawMiniControls() {
    const video = mediaPlayer.video;
    for (const play of page.querySelectorAll('[data-mini-play]')) {
      play.setAttribute('aria-label', t(video.paused ? 'ui.play' : 'ui.pause'));
      play.dataset.state = video.paused ? 'paused' : 'playing';
    }
    for (const button of page.querySelectorAll('[data-mini-mode]')) button.hidden = Boolean(getMiniItem()?.audioOnly);
    for (const mute of page.querySelectorAll('[data-mini-mute]')) {
      mute.setAttribute('aria-label', t(video.muted ? 'ui.unmute' : 'ui.mute'));
      mute.dataset.state = video.muted ? 'muted' : 'sound';
    }
  }

  /**
   * What the audio bar says about the track it holds: its cover, its title,
   * and who it is by on which record. Next is offered only when the playlist
   * has one; previous always is, since it first goes back to the top. The
   * system's own media controls are told the same, so a keyboard's or a
   * phone's lock screen's buttons step through the album too.
   */
  function drawAudioBar(item) {
    if (!inBar(item)) return;
    audioBar.toggleAttribute('data-cover', hasCover(item));
    const cover = audioBar.querySelector('[data-audio-cover]');
    const thumbnail = item.thumbnail?.url || '';
    cover.hidden = !thumbnail;
    if (thumbnail) cover.src = thumbnail;
    else cover.removeAttribute('src');
    const artist = item.music?.artist || item.facets?.owner?.name || '';
    const album = item.music?.album || '';
    const title = audioBar.querySelector('[data-audio-title]');
    title.textContent = item.title;
    title.href = urlFor(item.id);
    // The artist leads to their channel and the record to the playlist it is
    // playing from, so the bar is a way back to the list it was started in.
    // A track from a playlist with no album named shows the playlist instead.
    const links = watchLinks(inPlaylist(item, getPlaylistId()) || item);
    const byline = audioBar.querySelector('[data-audio-byline]');
    const part = (text, kind, target) => {
      if (!text) return null;
      const anchor = document.createElement('a');
      anchor.textContent = text;
      return linkTo(anchor, kind, target) ? anchor : text;
    };
    const parts = [
      part(artist, 'channel', links.channel),
      part(album || links.playlist?.name, 'playlist', links.playlist),
    ].filter(Boolean);
    byline.replaceChildren(...parts.flatMap((node, index) => (index ? [' · ', node] : [node])));
    drawAudioPlaylist(item);
    drawAudioOrder();
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title, artist, album,
        artwork: thumbnail ? [{src: new URL(thumbnail, window.location.href).href}] : [],
      });
    } catch { /* An older engine without MediaMetadata keeps its own label. */ }
  }
  // The gallery's playlist when it is showing one, so the bar's way back to
  // the playlist is not offered on the playlist itself.
  let shownPlaylistId = null;
  function drawAudioPlaylist(item) {
    const target = watchLinks(inPlaylist(item, getPlaylistId()) || item).playlist;
    const here = target && shownPlaylistId != null && String(target.id) === String(shownPlaylistId);
    const button = audioBar.querySelector('[data-audio-playlist]');
    button.hidden = here || !linkTo(button, 'playlist', target);
  }
  if ('mediaSession' in navigator) {
    const handle = (action, run) => {
      try { navigator.mediaSession.setActionHandler(action, run); } catch { /* Unsupported action. */ }
    };
    handle('previoustrack', () => inAudioBar() && previousTrack());
    handle('nexttrack', () => { const target = inAudioBar() && audioStep(1); if (target) advanceMini(target); });
  }
  /** Back to the top of the track, as a player's previous does, unless it has
   *  barely begun, when it goes to the track before. */
  function previousTrack() {
    const target = audioStep(-1);
    if (mediaPlayer.video.currentTime > 3 || !target) mediaPlayer.requestSeek(0);
    else advanceMini(target);
  }

  const shuffleButton = audioBar.querySelector('[data-audio-shuffle]');
  const repeatButton = audioBar.querySelector('[data-audio-repeat]');
  function drawAudioOrder() {
    const {shuffle, repeat} = playlistController.order();
    shuffleButton.setAttribute('aria-pressed', String(shuffle));
    const label = t(`player.repeat${{off: 'Off', all: 'All', one: 'One'}[repeat]}`);
    repeatButton.dataset.repeat = repeat;
    repeatButton.setAttribute('aria-pressed', String(repeat !== 'off'));
    repeatButton.setAttribute('aria-label', label);
    repeatButton.title = label;
    repeatButton.querySelector('[data-audio-repeat-icon]').setAttribute('href',
      iconHref(repeat === 'one' ? 'repeat-once' : 'repeat'));
    audioBar.querySelector('[data-audio-next]').disabled = !audioStep(1);
  }
  function toggleShuffle() {
    playlistController.toggleShuffle();
    drawAudioOrder();
  }
  function cycleRepeat() {
    playlistController.cycleRepeat();
    drawAudioOrder();
  }

  for (const type of ['play', 'pause', 'volumechange']) {
    mediaPlayer.video.addEventListener(type, drawMiniControls);
  }
  // The corner window's own seek bar, since the player's is hidden there. It
  // reads the player's absolute time and total, so a video held in parts or
  // streamed from an offset still shows where it is overall. While it is
  // dragged the playhead stops driving it, or it would jump back under the
  // finger on every timeupdate.
  const miniSeek = page.querySelector('[data-mini-seek]');
  const audioSeek = audioBar.querySelector('[data-audio-seek]');
  const audioElapsed = audioBar.querySelector('[data-audio-elapsed]');
  const audioTotal = audioBar.querySelector('[data-audio-total]');
  const miniPreview = createSeekPreview({
    seek: miniSeek, container: miniSeek.parentElement,
    getDuration: () => mediaPlayer.totalDuration(), getSheet: () => mediaPlayer.seekPreview,
    className: 'archive-mini-seek-preview', gap: 4,
  });
  mediaPlayer.video.addEventListener('emptied', miniPreview.hide);
  let miniScrubbing = false;
  function drawMiniSeek() {
    if (miniScrubbing) return;
    const total = mediaPlayer.totalDuration();
    const now = mediaPlayer.absoluteTime();
    const fraction = total ? Math.min(1, now / total) : 0;
    for (const seek of [miniSeek, audioSeek]) {
      seek.value = String(Math.round(fraction * 1000));
      seek.style.setProperty('--range-progress', `${fraction * 100}%`);
    }
    audioElapsed.textContent = formatPlayerTime(now || 0);
    audioTotal.textContent = formatPlayerTime(total || 0);
  }
  for (const type of ['timeupdate', 'loadedmetadata', 'seeked', 'emptied']) {
    mediaPlayer.video.addEventListener(type, drawMiniSeek);
  }
  for (const seek of [miniSeek, audioSeek]) {
    seek.addEventListener('input', () => {
      miniScrubbing = true;
      seek.style.setProperty('--range-progress', `${Number(seek.value) / 10}%`);
      if (seek === audioSeek) audioElapsed.textContent = formatPlayerTime(Number(seek.value) * mediaPlayer.totalDuration() / 1000);
    });
    seek.addEventListener('change', () => {
      miniScrubbing = false;
      mediaPlayer.requestSeek(Number(seek.value) * mediaPlayer.totalDuration() / 1000);
    });
  }
  // The title is a link to the watch page, so it can open in a new tab; a
  // plain click brings this one back up with the track still playing.
  audioBar.querySelector('[data-audio-title]').addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    restoreMini();
  });
  /**
   * Swaps the corner window for the bar or back, still playing: the bar for a
   * video wanted only for its sound, the window for a track whose video is
   * worth seeing. The element is the same one either way, only shown or not.
   */
  function switchBackgroundPlayer() {
    if (!getMiniItem() || getMiniItem().audioOnly) return;
    // Between the two the picture does not fly: the window's frame and
    // controls are there before it could land, and read as a shadow with
    // icons waiting for it. A quick fade is cleaner, the bar's stand-in
    // going out as the other player comes in.
    if (inBar(getMiniItem())) leaveBar({lift: false, flying: false});
    barChoice = inBar(getMiniItem()) ? 'video' : 'audio';
    audioVolume.hide();
    page.classList.toggle('is-audio-bar', barChoice === 'audio');
    drawMiniControls();
    drawAudioBar(getMiniItem());
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      page.animate([{opacity: 0}, {opacity: 1}], {duration: ASPECT_MORPH_MS / 2, easing: 'ease-out'});
    }
  }
  // The bar's volume is the player's: the same button, and the same pill
  // stood up over it with the mute at its foot, driving the one element.
  const audioVolumeButton = audioBar.querySelector('[data-audio-volume]');
  const audioVolumeSlider = audioBar.querySelector('[data-audio-volume-slider]');
  const audioMute = audioBar.querySelector('[data-audio-mute]');
  const audioVolume = createVolumePopup({
    button: audioVolumeButton, slider: audioVolumeSlider,
    popup: audioBar.querySelector('[data-audio-volume-popup]'),
  });
  function drawAudioVolume() {
    const video = mediaPlayer.video;
    const level = video.muted ? 0 : video.volume;
    audioVolumeButton.dataset.volumeState = volumeLevel(video);
    audioVolumeSlider.value = String(level);
    audioVolumeSlider.style.setProperty('--range-progress', `${level * 100}%`);
    audioMute.setAttribute('aria-pressed', String(video.muted));
    audioMute.setAttribute('aria-label', t(video.muted ? 'ui.unmute' : 'ui.mute'));
  }
  audioVolumeSlider.addEventListener('input', () => {
    mediaPlayer.video.volume = Number(audioVolumeSlider.value);
    mediaPlayer.video.muted = false;
  });
  mediaPlayer.video.addEventListener('volumechange', drawAudioVolume);
  drawAudioVolume();
  for (const controls of [miniControls, audioBar]) {
    controls.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if ('miniPlay' in button.dataset) mediaPlayer.toggle();
      else if ('miniMute' in button.dataset) mediaPlayer.video.muted = !mediaPlayer.video.muted;
      else if ('miniRestore' in button.dataset) restoreMini();
      else if ('miniClose' in button.dataset) closeMini();
      else if ('miniMode' in button.dataset) switchBackgroundPlayer();
      else if ('audioPrevious' in button.dataset) previousTrack();
      else if ('audioVolume' in button.dataset) audioVolume.toggle();
      else if ('audioMute' in button.dataset) mediaPlayer.video.muted = !mediaPlayer.video.muted;
      else if ('audioShuffle' in button.dataset) toggleShuffle();
      else if ('audioRepeat' in button.dataset) cycleRepeat();
      else if ('audioNext' in button.dataset) { const target = audioStep(1); if (target) advanceMini(target); }
    });
  }

  return {
    inBar, drawMiniControls, drawAudioBar,
    hideVolume: () => audioVolume.hide(),
    resetChoice() { barChoice = null; },
    keepsPlaying: item => keepsPlayingIn(backgroundPlay, item),
    setShownPlaylist(id) {
      shownPlaylistId = id ?? null;
      const item = getMiniItem();
      if (item && inBar(item)) drawAudioPlaylist(item);
    },
  };
}
