import {preferences} from './preferences.js';
import {t} from './i18n.js';
import {SPEED_GLYPH_MARKUP} from './player-speed-glyph.js';

const PLAYBACK_SPEED_KEY = 'archive-playback-speed';
const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 6, 8];

export function createPlaybackSpeed({
  element, mediaPlayer, speedSlider, speedValue,
  speedPresets, speedSummary,
}) {
  let playbackSpeed = 1;
  try {
    const savedSpeed = Number(preferences.getItem(PLAYBACK_SPEED_KEY));
    if (PLAYBACK_SPEEDS.includes(savedSpeed)) playbackSpeed = savedSpeed;
  } catch { /* A blocked store simply starts at normal speed. */ }
  /**
   * Speed reads as a dial rather than a list: the slider steps between the
   * rates the player supports, and the few rates anyone actually asks for sit
   * under it as buttons, so the common choice is one press rather than a drag.
   */
  const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3, 4];
  const speedLabel = rate => rate === 1 ? t('player.normal') : `${rate}x`;
  speedSlider.max = String(PLAYBACK_SPEEDS.length - 1);
  speedPresets.replaceChildren(...SPEED_PRESETS.map(rate => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.speedPreset = String(rate);
    button.textContent = `${rate}x`;
    button.addEventListener('click', () => chooseSpeed(rate));
    return button;
  }));

  function drawSpeed() {
    const step = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    speedSlider.value = String(step);
    // Chromium cannot paint a range's filled side on its own, so the track's
    // gradient is told where to stop, as the seek bar's is.
    speedSlider.style.setProperty('--speed-fill', `${step / (PLAYBACK_SPEEDS.length - 1) * 100}%`);
    speedSlider.setAttribute('aria-valuetext', speedLabel(playbackSpeed));
    speedValue.textContent = speedLabel(playbackSpeed);
    speedSummary.textContent = speedLabel(playbackSpeed);
    for (const button of speedPresets.children) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.speedPreset) === playbackSpeed));
    }
  }

  function chooseSpeed(rate) {
    if (!PLAYBACK_SPEEDS.includes(rate)) return;
    playbackSpeed = rate;
    drawSpeed();
    mediaPlayer.video.playbackRate = playbackSpeed;
    resyncAudio();
    try { preferences.setItem(PLAYBACK_SPEED_KEY, String(playbackSpeed)); } catch {}
  }

  speedSlider.addEventListener('input', () => chooseSpeed(PLAYBACK_SPEEDS[Number(speedSlider.value)]));
  drawSpeed();

  /**
   * Press and hold on the picture plays at double speed until let go, as
   * YouTube does. A press that moves is a drag (the projected view pans), and
   * a quick one is still the player's click to pause, so the speed-up only
   * starts once the pointer has stayed put for a moment; letting go of a hold
   * then swallows the click it would otherwise end in.
   *
   * While held, moving up speeds up and moving down slows down, smoothly and
   * on a doubling scale so each step feels the same, between 0.5× and 4×.
   * Every hold starts again from 2×.
   */
  const HOLD_DELAY_MS = 350;
  const HOLD_RATE = 2;
  const HOLD_MIN_RATE = 0.5;
  const HOLD_MAX_RATE = 4;
  const HOLD_PX_PER_DOUBLING = 90;
  const HOLD_SLOP = 10;
  const holdBadge = document.createElement('div');
  holdBadge.className = 'archive-hold-speed';
  holdBadge.setAttribute('aria-hidden', 'true');
  // The trailing triangle is dropped at 1× and below, where the hold is not
  // running the video on at all; both point forward either way, since it
  // never rewinds.
  holdBadge.innerHTML = `${SPEED_GLYPH_MARKUP}<span class="archive-hold-rate"></span>`;
  const holdRate = holdBadge.querySelector('.archive-hold-rate');
  const drawHoldRate = rate => {
    holdRate.textContent = `${rate.toFixed(1)}x`;
    holdBadge.classList.toggle('is-slow', rate <= 1);
  };
  element.append(holdBadge);
  let hold = null;
  // Set by letting go of a hold, for the click that release produces.
  let swallowClick = false;

  // Firefox on Linux lets the audio drift behind the picture after a rate
  // change; muting and unmuting again makes it pick the audio back up in sync.
  const resyncsAudioOnRateChange = /Firefox\//.test(navigator.userAgent)
    && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

  function resyncAudio() {
    const video = mediaPlayer.video;
    if (!resyncsAudioOnRateChange || video.muted) return;
    video.muted = true;
    requestAnimationFrame(() => { video.muted = false; });
  }

  // The badge leans a little the way the speed is being dragged, and springs
  // back to its place once the pointer stops or lets go.
  // The lean eases towards its limit rather than stopping hard at it: about
  // half of it after 30px of drag, and most of it only after 100px. Past 0.5×
  // or 4× the drag counts for a quarter, so pushing on at an end still moves
  // the badge, but stiffly, and says there is no more speed to be had there.
  const HOLD_LEAN_MAX_PX = 10;
  const HOLD_LEAN_EASE_PX = 55;
  const HOLD_LEAN_PAST_END = .25;
  const HOLD_SETTLE_MS = 90;
  let leanTimer = null;

  function settleHoldBadge() {
    clearTimeout(leanTimer);
    if (hold) hold.leanTravel = 0;
    holdBadge.classList.remove('is-leaning');
    holdBadge.style.setProperty('--hold-lean', '0px');
  }

  function leanHoldBadge(y, pastEnd) {
    hold.leanTravel = (hold.leanTravel || 0)
      + (y - (hold.leanY ?? y)) * (pastEnd ? HOLD_LEAN_PAST_END : 1);
    hold.leanY = y;
    const lean = HOLD_LEAN_MAX_PX * Math.tanh(hold.leanTravel / HOLD_LEAN_EASE_PX);
    holdBadge.classList.add('is-leaning');
    holdBadge.style.setProperty('--hold-lean', `${lean}px`);
    clearTimeout(leanTimer);
    leanTimer = setTimeout(settleHoldBadge, HOLD_SETTLE_MS);
  }

  function endHold() {
    if (!hold) return;
    clearTimeout(hold.timer);
    settleHoldBadge();
    if (hold.active) {
      mediaPlayer.video.playbackRate = hold.previousRate;
      resyncAudio();
      element.classList.remove('is-hold-speeding');
    }
    hold = null;
  }

  element.addEventListener('pointerdown', event => {
    endHold();
    // A release outside the player makes no click, so never carry one over.
    swallowClick = false;
    // A touch on a hidden bar is waking it, and the bar then covers the
    // finger, so a hold begun there would never see its release.
    if (event.pointerType !== 'mouse' && mediaPlayer.root.classList.contains('is-controls-hidden')) return;
    if (event.button !== 0 || !event.isPrimary || mediaPlayer.video.paused
        || event.target.closest('.media-player-controls, .playlist-popup, .archive-part-nav, button')) return;
    const started = {x: event.clientX, y: event.clientY, pointerId: event.pointerId};
    hold = {...started, lastY: event.clientY, active: false, timer: setTimeout(() => {
      if (!hold || mediaPlayer.video.paused) return;
      hold.active = true;
      // Speed is measured from where the pointer is once the hold starts.
      hold.anchorY = hold.lastY;
      hold.previousRate = mediaPlayer.video.playbackRate;
      mediaPlayer.video.playbackRate = HOLD_RATE;
      drawHoldRate(HOLD_RATE);
      element.classList.add('is-hold-speeding');
    }, HOLD_DELAY_MS)};
  }, {capture: true});
  // On the window, so the speed keeps following a pointer dragged off the player.
  window.addEventListener('pointermove', event => {
    if (!hold || event.pointerId !== hold.pointerId) return;
    hold.lastY = event.clientY;
    if (!hold.active) {
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP) endHold();
      return;
    }
    const doublings = (hold.anchorY - event.clientY) / HOLD_PX_PER_DOUBLING;
    const wanted = HOLD_RATE * 2 ** doublings;
    const exact = Math.min(HOLD_MAX_RATE, Math.max(HOLD_MIN_RATE, wanted));
    // A drag past 0.5× or 4× is not banked, so turning back changes the
    // speed straight away: the scale moves along to keep the pointer at the
    // end it is pressing on.
    const pastEnd = exact !== wanted;
    if (pastEnd) hold.anchorY = event.clientY + Math.log2(exact / HOLD_RATE) * HOLD_PX_PER_DOUBLING;
    // Snapped to the tenth the badge shows, so the figure is the speed rather
    // than a rounded view of it: 1.0x plays at 1, and reads as 1.
    const rate = Math.round(exact * 10) / 10;
    mediaPlayer.video.playbackRate = rate;
    drawHoldRate(rate);
    leanHoldBadge(event.clientY, pastEnd);
    // The move is setting the speed, so a projected view must not pan with it.
    event.stopPropagation();
  }, {capture: true});
  for (const type of ['pointerup', 'pointercancel']) {
    window.addEventListener(type, event => {
      if (!hold || event.pointerId !== hold.pointerId) return;
      swallowClick = hold.active && type === 'pointerup';
      endHold();
    }, {capture: true});
  }
  element.addEventListener('click', event => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
  }, {capture: true});
  // A long press on a touch screen would otherwise open the context menu.
  element.addEventListener('contextmenu', event => {
    if (hold?.active) event.preventDefault();
  });
  mediaPlayer.video.addEventListener('pause', endHold);

  return {applySavedRate() { mediaPlayer.video.playbackRate = playbackSpeed; }};
}
