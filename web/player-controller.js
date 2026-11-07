import {createWatchPage} from './player-watch.js';
import {createBackgroundPlayer} from './player-background.js';
import {createPlayerTransitions} from './player-transitions.js';
import {createPlayerPlaylist} from './player-playlist.js';
import {createPlayerTimeline} from './player-timeline.js';
import {createPlaybackSpeed} from './player-speed.js';
import {createTrackControls} from './player-tracks.js';
import {createPlayerElement, MediaPlayer, render} from 'media-ui';
import {request} from './api.js';
import {setPageTitle} from './page-title.js';
import {applyItemDetails} from './item-adapter.js';
import {followPosition, rectKey} from './popover.js';
import {ArchiveMediaProvider} from './media-provider.js';
import {initialiseAmbientGlow, initialisePlayerHeader} from './ambient-glow.js';
import {createGlowSetting} from './player-glow.js';
import {initialisePlayerImmersive} from './player-immersive.js';
import {createPlayerStats} from './player-stats.js';
import {preferences} from './preferences.js';
import {inPlaylist} from './playlists.js';
import {isListened} from './tracklist.js';
import {t} from './i18n.js';
import {playerLabels} from './player-labels.js';

/**
 * Wraps the shared player's seek input so chapter dots can sit over its track.
 * The shared player lives in the vendored package, so the archive adds its own
 * layer here rather than reaching into it: the markers take no pointer events,
 * which leaves scrubbing exactly as the player defines it.
 */
function buildChapterLayer(element) {
  const seek = element.querySelector('[data-media-seek]');
  const track = document.createElement('span');
  track.className = 'archive-seek-track';
  seek.replaceWith(track);
  const markers = document.createElement('span');
  markers.className = 'archive-chapter-markers';
  // Heat and SponsorBlock are track backgrounds, below the native thumb.
  track.append(seek, markers);
  return {seek, markers};
}

export function createPlayerController(page, report, {openAppearance} = {}) {
  const home = document.querySelector('#archive-home');
  const relatedRoot = page.querySelector('.archive-related-list');
  const element = createPlayerElement({label: t('player.archived'), labels: playerLabels()});
  page.querySelector('[data-player-host]').append(element);
  const provider = new ArchiveMediaProvider();
  // Keep the old Firefox Android workaround available if missed taps recur.
  const touchActivation = new URLSearchParams(window.location.search).has('playertouchdown');
  const mediaPlayer = new MediaPlayer(element, {provider, touchActivation, labels: playerLabels()});
  initialiseAmbientGlow(mediaPlayer, page.querySelector('.archive-watch-stage'));
  initialisePlayerHeader(page.querySelector('.archive-watch-stage'));
  initialisePlayerImmersive(page, mediaPlayer);
  window.addEventListener('pagehide', () => mediaPlayer.report('leave'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') mediaPlayer.report('leave');
  });
  mediaPlayer.video.addEventListener('seeked', () => mediaPlayer.report('seek'));
  const {seek: seekInput, markers: chapterMarkers} = buildChapterLayer(element);

  // Leaving the picture should hide idle controls without waiting for the
  // inactivity timer. Keep them available while paused or dragging a control.
  element.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch' || event.buttons || mediaPlayer.video.paused
        || mediaPlayer.scrubbing || element.querySelector(':popover-open')) return;
    element.classList.add('is-controls-hidden');
  });

  /** Half the bar's thumb, which is how far its travel is inset from either
   *  end. The size is the shared player's to name, so it is read from the
   *  token rather than repeated here. */
  const halfThumb = () =>
    (parseFloat(getComputedStyle(seekInput).getPropertyValue('--range-thumb')) || 0) / 2;
  let activeId = null;
  let activePlaylistId = null;
  // The video left playing in the corner when the watch page was dismissed
  // with background play on. It is deliberately not activeId: the gallery
  // reads activeId as "the watch page is on screen" (titles, scroll, closing
  // for a new filter), and the playlist and autoplay code keyed on it should
  // leave a video that is only a corner window alone.
  let miniItem = null;
  let getItems = () => [];
  let togglePlaylistDirection = null;
  let refreshGalleryTitle = () => setPageTitle();
  let galleryScrollY = 0;
  // This controller is the source of truth for scroll across the gallery/watch
  // switch: it stores the gallery offset in history state and reapplies it on
  // close. The browser's own restoration races that — it lands after popstate,
  // and after a Forward it would scroll the watch page down, putting the stage
  // rect that both zoom animations measure off-screen.
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

  const audioBar = page.querySelector('[data-audio-bar]');
  const transitions = createPlayerTransitions({page, home, getAudioBar: () => audioBar});
  const {stageNode, pictureRect, transitionSource, transitionThumbnail, transitionBackThumbnail,
    aspectOf, applyAspect, setAspect, flyStage, enterBar, leaveBar, flyFromBar} = transitions;

  const urlFor = id => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('watch', id); else url.searchParams.delete('watch');
    return `${url.pathname}${url.search}${url.hash}`;
  };

  const timeline = createPlayerTimeline({page, element, mediaPlayer, seekInput, chapterMarkers, halfThumb, onAspect: setAspect});

  const watchPage = createWatchPage({page, element, mediaPlayer,
    getActiveItem: () => getItems().find(entry => entry.id === activeId), getItems: () => getItems(),
    open, timeline, seekInput, drawFormats: item => trackControls.drawFormats(item),
    drawSubtitles: item => trackControls.drawSubtitles(item)});
  const {drawDetails, drawFileFacts, drawRelated, drawFavourite, clearAccent, sampleAccent, linkTo} = watchPage;

  const playlistPopup = page.querySelector('#watch-playlist-popup');
  const playlistTitle = page.querySelector('[data-playlist-title]');
  const playlistNote = page.querySelector('[data-playlist-note]');
  const playlistEntries = page.querySelector('[data-playlist-entries]');
  const playlistReverse = page.querySelector('[data-playlist-reverse]');

  /**
   * The playlist's own controls ride in the player's control bar, just before
   * fullscreen: the list with where this video sits in it, and autoplay. They
   * act on what plays, so they belong with the other playback controls and
   * stay to hand in fullscreen. The bar is the shared player's, so they are
   * added from here, as the chapter layer is.
   */
  const controlBar = element.querySelector('.media-player-controls');
  const playlistOpen = document.createElement('button');
  playlistOpen.type = 'button';
  playlistOpen.className = 'archive-playlist-open';
  playlistOpen.dataset.playlistOpen = '';
  playlistOpen.setAttribute('popovertarget', 'watch-playlist-popup');
  playlistOpen.setAttribute('aria-haspopup', 'dialog');
  playlistOpen.setAttribute('aria-expanded', 'false');
  playlistOpen.setAttribute('aria-controls', 'watch-playlist-popup');
  playlistOpen.hidden = true;
  playlistOpen.innerHTML = `<svg class="icon playlist-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5h12M5 10.5h12M5 14.5h7"/><path class="playlist-icon-play" d="M15 13.5l6 3.5l-6 3.5z"/>
    </svg><span class="archive-playlist-position" data-playlist-position aria-hidden="true"></span>`;
  const playlistPosition = playlistOpen.querySelector('[data-playlist-position]');
  controlBar.querySelector('[data-media-fullscreen]').before(playlistOpen);
  // The list opens from the player, so it lives in the player: that way it is
  // still there in fullscreen, and it is kept out of the surface's click to
  // pause like the arrows are.
  element.append(playlistPopup);
  for (const type of ['click', 'dblclick']) {
    playlistPopup.addEventListener(type, event => event.stopPropagation());
  }

  const settingsPopup = page.querySelector('#watch-settings-popup');
  const settingsPages = page.querySelector('[data-settings-pages]');
  const subtitleList = page.querySelector('[data-subtitle-list]');
  const speedSlider = page.querySelector('[data-playback-speed]');
  const speedValue = page.querySelector('[data-speed-value]');
  const speedPresets = page.querySelector('[data-speed-presets]');
  const speedSummary = page.querySelector('[data-speed-summary]');
  const subtitleSummary = page.querySelector('[data-subtitle-summary]');
  const audioRow = page.querySelector('[data-audio-row]');
  const audioList = page.querySelector('[data-audio-list]');
  const audioSummary = page.querySelector('[data-audio-summary]');
  const subtitleEmpty = page.querySelector('[data-subtitle-empty]');
  const autoplayToggle = page.querySelector('[data-autoplay-toggle]');
  const backgroundOptions = page.querySelector('[data-background-options]');
  const backgroundSummary = page.querySelector('[data-background-summary]');
  const backgroundNote = page.querySelector('[data-background-note]');
  const subtitleDownloads = page.querySelector('[data-subtitle-downloads]');
  const subtitleDownloadOffers = page.querySelector('[data-subtitle-download]');

  let repositionSettings = null;
  // Each page's width is the stylesheet's to choose, keyed off this attribute,
  // so the menu's proportions are not split between two files.
  const fitSettingsPage = name => {
    const activePage = settingsPopup.querySelector(`[data-settings-page="${name}"]`);
    if (!activePage) return;
    // The sliding pages overlap in one grid row; measure only the active
    // page so a taller subtitle page cannot leave blank space on the menu.
    const pages = [...settingsPages.querySelectorAll('.settings-page')];
    const previousContainerDisplay = settingsPages.style.display;
    const previousDisplays = pages.map(page => page.style.display);
    settingsPages.style.display = 'block';
    pages.forEach(page => { page.style.display = page === activePage ? 'block' : 'none'; });
    settingsPages.style.height = `${activePage.scrollHeight}px`;
    settingsPages.style.display = previousContainerDisplay;
    pages.forEach((page, index) => { page.style.display = previousDisplays[index]; });
  };
  const showSettingsPage = name => {
    settingsPopup.dataset.page = settingsPages.dataset.page = name === 'main' ? '' : name;
    const activePage = settingsPopup.querySelector(`[data-settings-page="${name}"]`);
    if (activePage) {
      fitSettingsPage(name);
      // The pages that slid away are still in the box, just translated out of
      // sight, so without this a tab off the last row walks into controls the
      // viewer cannot see.
      for (const page of settingsPages.querySelectorAll('.settings-page')) page.inert = page !== activePage;
    }
    repositionSettings?.();
  };
  settingsPopup.querySelectorAll('[data-settings-go]').forEach(button => {
    button.addEventListener('click', () => showSettingsPage(button.dataset.settingsGo));
  });
  settingsPopup.querySelectorAll('[data-settings-back]').forEach(button => {
    button.addEventListener('click', () => showSettingsPage('main'));
  });

  /**
   * Subtitles appear in the settings menu when the video has downloaded
   * tracks. The choice is the viewer's rather than the video's, so it is
   * remembered across videos and applied to whichever of them has that
   * language — the way a television keeps captions on until they are off.
   */
  const settingsOpen = document.createElement('button');
  settingsOpen.type = 'button';
  settingsOpen.className = 'archive-settings-open';
  settingsOpen.dataset.settingsOpen = '';
  settingsOpen.setAttribute('popovertarget', 'watch-settings-popup');
  settingsOpen.setAttribute('aria-haspopup', 'dialog');
  settingsOpen.setAttribute('aria-expanded', 'false');
  settingsOpen.setAttribute('aria-controls', 'watch-settings-popup');
  settingsOpen.setAttribute('aria-label', t('player.settingsLabel'));
  settingsOpen.title = t('player.settings');
  settingsOpen.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
      <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"/>
      <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>
    </svg>`;

  const formatPopup = page.querySelector('#watch-format-popup');
  const formatEntries = page.querySelector('[data-format-entries]');

  /**
   * The format switcher: a pill in the control bar naming the copy that is
   * playing, opening the list of the others. The gallery shows one card per
   * video, so this is the only place the copies that card stands for can be
   * reached, and it rides in the bar for the same reason the playlist does —
   * it acts on what is playing, and stays to hand in fullscreen.
   */
  const formatOpen = document.createElement('button');
  formatOpen.type = 'button';
  formatOpen.className = 'archive-format-open';
  formatOpen.dataset.formatOpen = '';
  formatOpen.setAttribute('popovertarget', 'watch-format-popup');
  formatOpen.setAttribute('aria-haspopup', 'dialog');
  formatOpen.setAttribute('aria-expanded', 'false');
  formatOpen.setAttribute('aria-controls', 'watch-format-popup');
  formatOpen.hidden = true;
  formatOpen.innerHTML = '<span class="archive-format-label" data-format-label></span>';
  const formatLabelNode = formatOpen.querySelector('[data-format-label]');
  /**
   * A captions toggle beside the gear, for the common case of wanting them on
   * or off without opening the menu. Language choice stays in the menu; this
   * only flips between Off and the language last used (or the first track).
   */
  const subtitleToggle = document.createElement('button');
  subtitleToggle.type = 'button';
  subtitleToggle.className = 'archive-subtitle-toggle';
  subtitleToggle.hidden = true;
  subtitleToggle.setAttribute('aria-label', t('player.subtitles'));
  subtitleToggle.title = t('player.subtitles');
  subtitleToggle.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
      <path class="subtitle-frame" d="M18 5a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3l12 0"/>
      <path class="subtitle-line" d="M7 15h5"/>
      <path class="subtitle-line" d="M15 15h2"/>
      <path class="subtitle-line" d="M17 12h-3"/>
      <path class="subtitle-line" d="M11 12h-1"/>
    </svg>`;
  // The right-hand end is a group of its own, so that whichever of the format
  // pill and captions button are absent, the rest stay tight together and the
  // group keeps one spacer from the playlist button, rather than each button
  // carrying margins that assume its neighbours.
  const fullscreenButton = controlBar.querySelector('[data-media-fullscreen]');
  const barTail = document.createElement('div');
  barTail.className = 'archive-bar-tail';
  fullscreenButton.before(barTail);
  // The way to the background player whatever the setting: it sits left of
  // fullscreen.
  const backgroundButton = document.createElement('button');
  backgroundButton.type = 'button';
  backgroundButton.className = 'archive-background-button';
  backgroundButton.setAttribute('aria-label', t('player.keepBackground'));
  backgroundButton.title = t('player.keepBackground');
  backgroundButton.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true"><path d="M11 19h-6a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v4"/><path d="M14 15a1 1 0 0 1 1 -1h5a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1l0 -3"/></svg>`;
  barTail.append(formatOpen, subtitleToggle, settingsOpen, backgroundButton, fullscreenButton);
  element.append(formatPopup, settingsPopup);
  for (const type of ['click', 'dblclick']) {
    formatPopup.addEventListener(type, event => event.stopPropagation());
    settingsPopup.addEventListener(type, event => event.stopPropagation());
  }

  const trackControls = createTrackControls({
    mediaPlayer, provider, getActiveItem: () => getItems().find(entry => entry.id === activeId),
    onFormatChange: drawFileFacts, report, settingsPopup,
    subtitleList, subtitleSummary, subtitleEmpty, subtitleDownloads, subtitleDownloadOffers, subtitleToggle,
    audioRow, audioList, audioSummary, formatPopup, formatEntries, formatOpen, formatLabelNode,
  });
  const {drawFormats, drawSubtitles, applySubtitles} = trackControls;

  // The track elements exist from the moment the source is attached, but a
  // mode set before the file has been read does not always survive the load.
  mediaPlayer.video.addEventListener('loadedmetadata', () => {
    playbackSpeed.applySavedRate();
    applySubtitles();
  });

  // A click on the picture while the list is open is the viewer putting the
  // list away, which the popover does by itself, so it must not also pause
  // or play. Whether the list was open is read as the press starts, since it
  // has already closed by the time the click lands. The bar's own buttons
  // still work as normal.
  let dismissingPopup = false;
  element.addEventListener('pointerdown', event => {
    dismissingPopup = Boolean(element.querySelector('[popover]:popover-open'))
      && !event.target.closest('.playlist-popup, .media-player-controls');
  }, {capture: true});
  element.addEventListener('click', event => {
    if (!dismissingPopup) return;
    dismissingPopup = false;
    event.stopPropagation();
  }, {capture: true});

  const playbackSpeed = createPlaybackSpeed({element, mediaPlayer, speedSlider, speedValue, speedPresets, speedSummary});

  const inAudioBar = () => page.classList.contains('is-audio-bar') && Boolean(miniItem);
  const playlistController = createPlayerPlaylist({
    element, mediaPlayer, getItems: () => getItems(), getActiveId: () => activeId,
    getPlaylistId: () => activePlaylistId, getMiniItem: () => miniItem,
    inAudioBar, advanceMini, open,
    togglePlaylistDirection: (...args) => togglePlaylistDirection?.(...args),
    autoplayToggle, playlistPopup, playlistTitle, playlistNote, playlistEntries,
    playlistReverse, playlistOpen, playlistPosition,
  });
  const {drawPlaylist, stopCountdown, audioStep} = playlistController;

  /** Autoplay's step for the corner player: the next video, still in the corner. */
  async function advanceMini(entry) {
    if (entry.id === miniItem?.id) return;
    await loadIntoCorner(entry);
  }

  /**
   * Loads `entry` into the corner window, or the audio bar when it is
   * listened to rather than watched (see isListened), and plays it. A track
   * starts from its top: it is heard whole,
   * and the next song of an album picking up where it was once left off would
   * be a jolt halfway into it.
   */
  async function loadIntoCorner(entry) {
    miniItem = entry;
    page.classList.toggle('is-audio-bar', inBar(entry));
    timeline.setItem(entry);
    loadDetails(entry);
    drawPlaylist(entry);
    drawRelated(entry);
    applyAspect(aspectOf(entry));
    drawAudioBar(entry);
    if (isListened(entry)) provider.resumeFrom(0);
    try {
      const loaded = await mediaPlayer.load(entry, 0);
      if (loaded && miniItem === entry) mediaPlayer.play();
    } catch (error) {
      report(t('error.reason', {message: t('watch.error.playEntry', {title: entry.title}), reason: error.message || error}), {error: true});
    }
  }

  // Shown or not is the viewer's to keep, like autoplay: someone chasing a
  // stutter wants it still up on the next video.
  const STATS_KEY = 'reruns-player-stats-v1';
  const statsToggle = page.querySelector('[data-stats-toggle]');
  let statsShown = false;
  try { statsShown = preferences.getItem(STATS_KEY) === '1'; } catch (_) {}
  const playerStats = createPlayerStats(element, mediaPlayer, {onClose: () => setStatsShown(false)});
  function setStatsShown(shown) {
    statsShown = shown;
    try { preferences.setItem(STATS_KEY, shown ? '1' : '0'); } catch (_) {}
    drawStats();
  }
  // The timer only runs while the watch page is open; a hidden page or a
  // corner window does not need it redrawing.
  const drawStats = () => {
    statsToggle.setAttribute('aria-checked', String(statsShown));
    playerStats.show(statsShown && Boolean(activeId));
  };
  statsToggle.addEventListener('click', () => setStatsShown(!statsShown));
  drawStats();
  createGlowSetting(settingsPopup.querySelector('[data-glow-setting]'), {
    leave: () => settingsPopup.hidePopover?.(),
    openAppearance,
  });

  // The popover lives in the top layer, so it is placed here rather than by
  // the flow it is written in. It sits inside the player like a panel of the
  // control bar: the bar's own 10px inset from the player's edges, the same
  // gap above the bar, lined up under its button as far as the player's
  // edges allow, and never taller than the room above the bar.
  const POPUP_INSET = 10;
  const placePopup = (popup, opener, widest) => () => {
    const player = element.getBoundingClientRect();
    const bar = controlBar.getBoundingClientRect();
    const anchor = opener.getBoundingClientRect();
    const room = player.width - 2 * POPUP_INSET;
    // A popup that resizes as it is used declares each width in CSS and is
    // given no width here, only the player's edges as a limit.
    if (widest) popup.style.width = `${Math.min(widest, room)}px`;
    popup.style.maxWidth = `${room}px`;
    // With the bar under the picture (a phone, see the stylesheet) there is
    // no reason to stop at the picture's top edge: the panel may rise over
    // the page above it, as far as the viewport allows.
    const barBelow = window.matchMedia('(max-width: 700px)').matches
      && document.fullscreenElement !== element;
    const ceiling = barBelow ? 0 : player.top;
    popup.style.maxHeight = `${Math.max(0, bar.top - ceiling - 2 * POPUP_INSET)}px`;
    const {width} = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(player.left + POPUP_INSET, Math.min(
      player.right - width - POPUP_INSET,
      anchor.left + anchor.width / 2 - width / 2,
    ))}px`;
    // Held by the bottom edge, the one against the bar: held by its top, a
    // popup that changed height while open drifted off the bar.
    popup.style.top = 'auto';
    popup.style.bottom = `${window.innerHeight - bar.top + POPUP_INSET}px`;
  };
  /**
   * Keeps a bar popover against the button it opened from, and follows it
   * while the page moves: the top layer sits outside the page's scrolling, so
   * a popover left to itself stays where it opened.
   */
  const followOpener = (popup, opener, place, whenOpen) => {
    // `toggle` is queued after the popover has been shown, so the first frame
    // of a popup that has never been placed paints at its unplaced default
    // (`inset: auto`, no left or top) before place() moves it. Holding it
    // invisible until then hides that frame; later opens reuse the old spot.
    popup.addEventListener('beforetoggle', event => {
      if (event.newState === 'open') popup.style.visibility = 'hidden';
    });
    // The player, its bar and the button are what place() reads, so any of
    // them moving - a scroll, a resize, the frame easing to a new size after
    // one - moves the popup with them in the same frame.
    const position = followPosition(() => rectKey(element, controlBar, opener), place);
    const resized = new ResizeObserver(place);
    popup.addEventListener('toggle', event => {
      const isOpen = event.newState === 'open';
      opener.setAttribute('aria-expanded', String(isOpen));
      if (!isOpen) { position.stop(); resized.disconnect(); return; }
      position.start();
      resized.observe(popup);
      whenOpen?.();
      popup.style.visibility = '';
    });
  };
  // The name and direction toggle stay put while only the list scrolls. Once
  // some of the list has gone up behind them, a divider marks the seam; at the top, or in a playlist that fits, there is neither.
  const drawPlaylistScroll = () => {
    playlistEntries.toggleAttribute('data-scrolled', playlistEntries.scrollTop > 0);
  };
  playlistEntries.addEventListener('scroll', drawPlaylistScroll, {passive: true});
    followOpener(playlistPopup, playlistOpen, placePopup(playlistPopup, playlistOpen, 360),
    () => {
      playlistEntries.querySelector('.is-current')?.scrollIntoView({block: 'nearest'});
      drawPlaylistScroll();
    });
  followOpener(formatPopup, formatOpen, placePopup(formatPopup, formatOpen, 260));
  const placeSettingsBase = placePopup(settingsPopup, settingsOpen, null);
  const placeSettings = () => {
    placeSettingsBase();
    const player = element.getBoundingClientRect();
    const bar = controlBar.getBoundingClientRect();
    settingsPopup.style.left = 'auto';
    settingsPopup.style.right = `${Math.max(POPUP_INSET, window.innerWidth - player.right + POPUP_INSET)}px`;
    settingsPopup.style.top = 'auto';
    settingsPopup.style.bottom = `${Math.max(POPUP_INSET, window.innerHeight - bar.top + POPUP_INSET)}px`;
  };
  repositionSettings = placeSettings;
  followOpener(settingsPopup, settingsOpen, placeSettings, () => showSettingsPage('main'));

  /**
   * Calls `ready` once the video shows the frame it opens on. A video that
   * resumes decodes its first frame and then seeks to the saved position, so
   * the first frame is not it: showing the picture at the first frame put the
   * start of the video up for a moment before it jumped to where the viewer
   * had got to. Failing ends the wait too. Playing does not: `play` fires
   * as soon as it is asked for, long before there is a frame to show.
   */
  function whenFrameReady(id, ready) {
    const video = mediaPlayer.video;
    const events = ['loadeddata', 'seeked', 'error'];
    let loaded = false;
    const check = event => {
      if (event.type === 'loadeddata') loaded = true;
      const waiting = event.type !== 'error' && (!loaded || video.seeking);
      if (waiting) return;
      for (const name of events) video.removeEventListener(name, check);
      if (activeId === id) ready();
    };
    for (const name of events) video.addEventListener(name, check);
  }

  function fadeInWhenReady(id) {
    page.classList.add('is-switching');
    whenFrameReady(id, () => page.classList.remove('is-switching'));
  }

  /**
   * A page opened straight onto a video does not play by itself, so what it
   * shows is a still: the thumbnail, then the video's own frame at the saved
   * position. The thumbnail is held over the video until that frame is ready
   * and then fades out to it, rather than the player flicking from thumbnail
   * to first frame to resume point.
   */
  function holdPosterUntilReady(id) {
    page.classList.add('is-holding-poster');
    whenFrameReady(id, () => {
      const poster = mediaPlayer.poster;
      const release = () => {
        page.classList.remove('is-holding-poster');
        fade?.cancel();
      };
      const fade = !poster || matchMedia('(prefers-reduced-motion: reduce)').matches ? null
        : poster.animate([{opacity: 1}, {opacity: 0}],
          {duration: 400, easing: 'ease', fill: 'forwards'});
      if (fade) fade.finished.then(release, release);
      else release();
    });
  }

  async function open(item, _partIndex = 0, eventOrOptions = {}) {
    if (!item) return;
    const routePlaylist = new URLSearchParams(window.location.search).get('playlist');
    item = inPlaylist(item, routePlaylist) || item;
    activePlaylistId = item.archive?.playlist?.id || null;
    const options = eventOrOptions?.currentTarget ? {} : eventOrOptions;
    // The same video is already playing in the corner: bring it back rather
    // than reloading it, which would restart it from the saved position.
    if (miniItem?.id === item.id) return restoreMini(options);
    const wasMini = Boolean(miniItem);
    miniItem = null;
    page.classList.remove('is-mini', 'is-audio-bar');
    background.hideVolume();
    background.resetChoice();
    // Already watching: a step through the playlist, a related card or Back
    // between two videos. There is no gallery card to zoom from, and flashing
    // the next thumbnail over the player reads as a glitch, so the player
    // goes dark and the new video fades in once it has a frame to show.
    const switching = !page.hidden && !wasMini;
    // A page load that lands straight on a video (a refresh, or a pasted
    // link) was never on the gallery, so there is nothing to zoom from: the
    // player is simply there.
    const {history = true, animate = true} = options;
    const source = switching || !animate ? {src: ''}
      : transitionSource(eventOrOptions?.currentTarget ? eventOrOptions : null, item);
    if (home.hidden === false) {
      galleryScrollY = window.scrollY;
      // Put the viewport on the gallery history entry, rather than only
      // keeping it in memory. That makes browser Back the source of truth and
      // also survives subsequent watch entries (for example, related videos).
      window.history.replaceState(
        {...window.history.state, archiveScrollY: galleryScrollY}, '', window.location.href,
      );
    }
    activeId = item.id;
    drawStats();
    timeline.setItem(item);
    // The glow's slowness check waits for this: a busy opening is not the
    // glow's doing. A load overtaken by the next video leaves the class to it.
    page.classList.add('is-settling');
    loadDetails(item).finally(() => { if (activeId === item.id) page.classList.remove('is-settling'); });
    drawDetails(item);
    drawPlaylist(item);
    drawRelated(item);
    // Before the zoom measures the stage, so a 4:3 video is flown to a 4:3
    // frame: the thumbnail changes shape on its way in rather than landing
    // 16:9 and then settling, which would read as two moves.
    applyAspect(aspectOf(item));
    transitions.begin(source);
    page.classList.toggle('is-thumbnail-transitioning', Boolean(source.src));
    // Unlike the class above, this lasts until the thumbnail has faded away:
    // the ambient glow waits for it, as its sampling and blur cost frames the
    // zoom needs.
    page.classList.toggle('is-zooming', Boolean(source.src));
    home.hidden = true;
    page.hidden = false;
    document.body.classList.add('watch-open');
    window.scrollTo(0, 0);
    if (history) {
      window.history.pushState(
        {...window.history.state, watch: item.id, archiveScrollY: galleryScrollY},
        '', urlFor(item.id),
      );
    }
    // Listening from before the load starts, so no event is missed. A load
    // that fails or is overtaken fires none, so it releases the zoom itself.
    let releaseZoom = () => {};
    const frameReady = new Promise(resolve => {
      releaseZoom = resolve;
      if (source.src) whenFrameReady(item.id, resolve);
    });
    transitionThumbnail(source, frameReady);
    page.classList.remove('is-holding-poster');
    if (switching) fadeInWhenReady(item.id);
    else if (!history) holdPosterUntilReady(item.id);
    try {
      const loaded = await mediaPlayer.load(item, 0);
      if (!loaded) releaseZoom();
      sampleAccent(item);
      // A restored URL or browser-history navigation has no active user
      // gesture, so attempting autoplay there is rejected by browsers. Card
      // clicks still play immediately; restored pages wait for click/Space.
      if (loaded && history) mediaPlayer.play();
    } catch (error) {
      releaseZoom();
      report(t('error.reason', {message: t('watch.error.playEntry', {title: item.title}), reason: error.message || error}), {error: true});
    }
  }

  // The description and heatmap are not in the listing - they are most of its
  // weight and only this page reads them - so they are fetched for the video
  // being opened and folded in when they arrive. The page is already drawn by
  // then, so this redraws rather than delaying it, and a failure leaves the
  // watch page as it is: a missing description is not worth a toast. Fetched
  // once per item; the object is the gallery's, so stepping back to a video
  // already opened finds them in place.
  async function loadDetails(item) {
    if (!item?.archive?.detailsUrl || item.archive.detailsLoaded) return;
    try {
      const details = await request(item.archive.detailsUrl);
      item.archive.detailsLoaded = true;
      applyItemDetails(item, details);
      // Only if it is still the video on screen: a quick step through a
      // playlist can land this after the next one has opened.
      if (activeId === item.id) drawDetails(item);
    } catch { /* The watch page keeps what the listing gave it. */ }
  }

  function close({history = true, scrollY = galleryScrollY, mini = false} = {}) {
    if (!activeId) return;
    const item = getItems().find(entry => entry.id === activeId);
    const initial = pictureRect();
    const initialRadius = getComputedStyle(stageNode()).borderRadius;
    // Only something playing is worth keeping; a paused video has nothing to
    // carry on with, and a corner window holding one would just be in the way.
    // The button asks outright, so it keeps what the setting would not.
    // Leaving a track's page is going back to the album it was put on from,
    // and music is listened to while doing something else, so 'audio' keeps
    // those and leaves pictures alone.
    const playing = !mediaPlayer.video.paused && !mediaPlayer.video.ended;
    const keep = item && (mini
      ? !mediaPlayer.video.ended
      : playing && background.keepsPlaying(item));
    activeId = null;
    drawStats();
    transitions.cancel();
    if (!keep) mediaPlayer.stop('close');
    playlistPopup.hidePopover?.();
    formatPopup.hidePopover?.();
    settingsPopup.hidePopover?.();
    stopCountdown();
    page.classList.remove('is-thumbnail-transitioning', 'is-zooming', 'is-switching', 'is-holding-poster', 'is-settling');
    if (keep) {
      miniItem = item;
      page.classList.add('is-mini');
      page.classList.toggle('is-audio-bar', inBar(item));
      drawMiniControls();
      drawAudioBar(item);
    } else {
      render(null, relatedRoot);
      page.hidden = true;
    }
    home.hidden = false;
    document.body.classList.remove('watch-open');
    // The gallery is back at once, so the header takes its glass at once too,
    // rather than fading it in over its own transition.
    document.body.classList.add('is-leaving-watch');
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('is-leaving-watch')));
    refreshGalleryTitle();
    // A new entry rather than rewriting the watch one, so Back from the
    // gallery returns to the video just left (or its corner window) instead
    // of skipping past it to the gallery entry beneath, which only moved the
    // scroll position.
    if (history) window.history.pushState({archiveScrollY: scrollY}, '', urlFor(null));
    window.scrollTo(0, scrollY);
    // The bar has no picture to carry down to it, so it rises instead.
    if (keep && inBar(item)) enterBar(item, initial, initialRadius);
    else if (keep) flyStage(initial);
    else transitionBackThumbnail(item, initial);
  }

  /** Ends the corner player for good. */
  function closeMini() {
    if (!miniItem) return;
    const item = miniItem;
    const initial = pictureRect();
    const radius = getComputedStyle(stageNode()).borderRadius;
    miniItem = null;
    mediaPlayer.stop('close');
    page.classList.remove('is-mini', 'is-audio-bar');
    background.hideVolume();
    background.resetChoice();
    page.hidden = true;
    render(null, relatedRoot);
    transitionBackThumbnail(item, initial, radius);
  }

  /** Puts the corner player back as the full watch page, still playing. */
  function restoreMini({history = true} = {}) {
    const item = miniItem;
    if (!item) return;
    miniItem = null;
    const from = stageNode().getBoundingClientRect();
    // The bar's cover is where the picture flies from; the stage is not on
    // screen to measure while the page is a bar.
    const coverRect = inBar(item)
      ? audioBar.querySelector('.archive-audio-cover').getBoundingClientRect() : null;
    if (coverRect) leaveBar();
    page.classList.remove('is-mini', 'is-audio-bar');
    background.hideVolume();
    background.resetChoice();
    if (home.hidden === false) {
      galleryScrollY = window.scrollY;
      window.history.replaceState(
        {...window.history.state, archiveScrollY: galleryScrollY}, '', window.location.href,
      );
    }
    activeId = item.id;
    drawStats();
    home.hidden = true;
    document.body.classList.add('watch-open');
    window.scrollTo(0, 0);
    if (history) {
      window.history.pushState(
        {...window.history.state, watch: item.id, archiveScrollY: galleryScrollY},
        '', urlFor(item.id),
      );
    }
    // Redrawn for the page title, which the gallery took back when it shrank.
    drawDetails(item);
    if (!coverRect) return flyStage(from);
    flyFromBar(item, coverRect);
  }

  const background = createBackgroundPlayer({
    page, mediaPlayer, audioBar, getMiniItem: () => miniItem, getPlaylistId: () => activePlaylistId,
    playlistController, inAudioBar, advanceMini, restoreMini, closeMini, close, urlFor, linkTo, leaveBar,
    fitSettingsPage, settingsPages, backgroundOptions, backgroundSummary, backgroundNote, backgroundButton,
  });
  const {inBar, drawMiniControls, drawAudioBar} = background;

  /**
   * Plays `item` behind the page rather than opening it: a track chosen from
   * an album's list, which stays on screen with the bar along its foot. From
   * the top, whatever was saved for it. A video already in the corner gives
   * way to it.
   */
  async function playInBackground(item) {
    if (!item) return;
    const routePlaylist = new URLSearchParams(window.location.search).get('playlist');
    item = inPlaylist(item, routePlaylist) || item;
    activePlaylistId = item.archive?.playlist?.id || null;
    if (activeId) close({history: false});
    page.hidden = false;
    page.classList.add('is-mini');
    // A track picked by hand starts a new shuffle rather than joining the old.
    playlistController.resetShuffle();
    await loadIntoCorner(item);
    drawMiniControls();
  }
  window.addEventListener('popstate', event => {
    const id = new URLSearchParams(window.location.search).get('watch');
    const item = getItems().find(entry => entry.id === id);
    if (item) open(item, 0, {history: false});
    else close({history: false, scrollY: Number.isFinite(event.state?.archiveScrollY)
      ? event.state.archiveScrollY : galleryScrollY});
  });

  return {
    activeId: () => activeId,
    /** What the player holds, on the watch page or in the corner: for a list
     *  to mark the track that is playing, not for deciding what is open. */
    playingId: () => activeId || miniItem?.id || null,
    /** The element itself, so a list can follow play and pause. */
    media: mediaPlayer.video,
    /** Its live waveform, for a list's playing row to move with. */
    waveform: mediaPlayer.audioWaveform,
    playbackSnapshot: () => ({
      position: mediaPlayer.absoluteTime(),
      playing: !mediaPlayer.video.paused,
    }),
    /** Keep watching when a deleted file has another copy in the archive. */
    async replaceDeletedFormat(item, {position, playing}) {
      activeId = item.id;
      window.history.replaceState(
        {...window.history.state, watch: item.id}, '', urlFor(item.id),
      );
      loadDetails(item);
      drawDetails(item);
      drawPlaylist(item);
      drawRelated(item);
      applyAspect(aspectOf(item));
      provider.resumeFrom(position);
      try {
        const loaded = await mediaPlayer.load(item, 0);
        if (loaded && playing) mediaPlayer.play();
      } catch (error) {
        report(t('error.reason', {message: t('watch.error.playFormat'), reason: error.message || error}), {error: true});
      }
    },
    linkFor: item => urlFor(item.id),
    open,
    playInBackground,
    /** Pauses or carries on with whatever the player holds. */
    toggle: () => mediaPlayer.toggle(),
    close,
    /** The settings menu opens the SponsorBlock drawer, which lives here
     *  because the player owns its state. */
    openSponsorBlock: timeline.openSponsorBlock,
    setItemsProvider(provider) { getItems = provider; },
    setPlaylistEditor(...args) { watchPage.setPlaylistEditor(...args); },
    /** Wires the related row's cards to the gallery's, menu and all. */
    setCardProps(...args) { watchPage.setCardProps(...args); },
    /** Redraws the related row: the gallery calls this when a card's menu
     *  opens or closes, since it owns that state for every surface. */
    redrawRelated: () => { if (activeId) drawRelated(); },
    /** The playlist the gallery is showing, or null, as it draws. */
    setShownPlaylist(id) {
      background.setShownPlaylist(id);
    },
    /** Wires the heart to the gallery's favourite toggle. */
    setFavouriteToggle(...args) { watchPage.setFavouriteToggle(...args); },
    /** Wires the playlist popup's order arrow to the gallery, which owns
     *  the saved direction. */
    setPlaylistDirectionToggle(toggle) { togglePlaylistDirection = toggle; },
    /** Queues sidecars against the exact format currently playing. */
    setSubtitleDownloader(download) {
      trackControls.setSubtitleDownloader(download);
      watchPage.setSubtitleDownloader(download);
    },
    /** Opens the download choices for the video on screen, to fetch it again
     *  in another format beside the copy already held. */
    setFormatDownloader(...args) { watchPage.setFormatDownloader(...args); },
    /** Wires the delete button to the gallery, which owns removing videos. */
    setDeleter(...args) { watchPage.setDeleter(...args); },
    setMetadataRefresher(...args) { watchPage.setMetadataRefresher(...args); },
    /** Redraws the open video from the freshly loaded library, so a refresh
     *  or a subtitle fetch shows on the page that asked for it. The details
     *  are fetched again because the new item has not had them yet. */
    redrawActive() {
      const item = getItems().find(entry => entry.id === activeId);
      if (!item) return;
      drawSubtitles(item);
      if (item.archive?.detailsUrl) loadDetails(item); else drawDetails(item);
    },
    /** Restores the gallery or channel name when the watch page closes. */
    setGalleryTitle(refresh) { refreshGalleryTitle = refresh; },
    /** Wires the channel and playlist links to the gallery's filters. */
    setFacetLinks(...args) { watchPage.setFacetLinks(...args); },
    /** Wires the watch page's Subscribe button to the subscriptions module,
     *  and keeps it in step with a subscribe/unsubscribe done elsewhere. */
    setSubscriptions(backend) { watchPage.setSubscriptions(backend); },
    refreshActiveItem() {
      const item = getItems().find(entry => entry.id === activeId);
      if (!item) return;
      drawPlaylist(item, {redraw: true});
      // A copy downloaded from this page lands in the format list here.
      drawFormats(item);
      drawSubtitles(item);
      const wanted = (item.parts?.[0]?.subtitleTracks || []).map(track => track.language).sort();
      const present = [...mediaPlayer.video.textTracks].map(track => track.language).sort();
      if (wanted.join('\u0000') === present.join('\u0000')) {
        applySubtitles();
        return;
      }
      // Reuse the current position while asking the provider to attach the
      // newly discovered sidecar tracks. This is only done when the language
      // set changed, so ordinary archive scans do not interrupt playback.
      const position = mediaPlayer.absoluteTime();
      const playing = !mediaPlayer.video.paused;
      provider.resumeFrom(position);
      mediaPlayer.load(item, 0).then(loaded => {
        if (loaded && playing) mediaPlayer.play();
      }).catch(() => {});
    },
    refreshFavourite: drawFavourite,
    async restoreRoute() {
      const id = new URLSearchParams(window.location.search).get('watch');
      // An address saved while a copy stood for its video still finds the
      // video once a better copy has taken over (see groupFormats).
      const item = getItems().find(entry => entry.id === id)
        || getItems().find(entry => entry.archive?.formats?.some(format => format.id === id));
      if (item && item.id !== id) window.history.replaceState({}, '', urlFor(item.id));
      if (item) await open(item, 0, {history: false, animate: false});
      else if (id) window.history.replaceState({}, '', urlFor(null));
    },
  };
}
