import {playerLightingMode} from './customisation.js';

// Seek sheets sample the middle of each interval. Interpolating between those
// centres keeps the light moving gently without reading back video pixels.
export function ambientFrames(count, ratio) {
  const position = Math.max(0, Math.min(count - 1, ratio * count - .5));
  const first = Math.floor(position);
  return {first, second: Math.min(count - 1, first + 1), blend: position - first};
}

export function initialisePlayerHeader(stage) {
  const header = document.querySelector('.topbar-shell');
  if (!header) return;
  let frame;
  function update() {
    frame = null;
    if (!document.body.classList.contains('watch-open')) return;
    const bounds = header.getBoundingClientRect();
    // Clear while the picture is below the header; fully glass once its top
    // reaches the header's top. The same position gives the same fade both ways.
    const progress = Math.max(0, Math.min(1,
      (bounds.bottom - stage.getBoundingClientRect().top) / Math.max(1, bounds.height)));
    header.style.setProperty('--watch-header-alpha', String(.75 * progress));
    header.style.setProperty('--watch-header-blur', `${14 * progress}px`);
  }
  function schedule() {
    if (frame == null) frame = requestAnimationFrame(update);
  }
  window.addEventListener('scroll', schedule, {passive: true});
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  new ResizeObserver(schedule).observe(header);
  new MutationObserver(schedule).observe(document.body,
    {attributes: true, attributeFilter: ['class']});
  schedule();
}

// The glow is a small copy of the picture, blurred large. Each cell of it is
// averaged over its patch of the frame rather than sampled at its centre, so
// an edge crossing the picture moves the light smoothly, not a cell at a time.
const GLOW_WIDTH = 64;
const GLOW_HEIGHT = 36;
// How often a playing video is copied in realtime mode, and so how far the
// light runs behind the picture: each copy fades in over the gap since the
// last. The copy is tiny; the blur redrawn for each one is the cost. Samples
// land on frames, so this is a little under the tenth of a second it aims
// for: every third frame at 30fps, every sixth at 60, not every fourth.
const REALTIME_SAMPLE_MS = 90;
// A copy from a large frame can be slow, and on a machine decoding in software
// that time comes straight out of the video's. So the light is sampled less
// often while the video drops frames and copies are not trivial, and returns
// to the usual rate once it stops. Dropped frames are the harm itself: Firefox
// takes ~6 ms to copy every 1080p frame without dropping one, and a limit on
// copy time alone held its light at four times the usual gap for nothing.
// Where a browser cannot count dropped frames the copy time decides, judged on
// the median of the last few: a small video's copies took ~0.5 ms with the odd
// ~6 ms stall among them, and reacting to each held the light back too.
const SLOW_COPY_MS = 4;
const FAST_COPY_MS = 2;
const REALTIME_SAMPLE_MAX_MS = 360;
const COPY_WINDOW = 5;
// The seek-sheet light moves with timeupdate, about four times a second.
const FADE_MIN_MS = 80;
const FADE_MAX_MS = 400;
// The light's first appearance, as a video settles, fades up rather than
// switching on. Leaving is at once: the zoom back to the gallery starts
// straight away, and a glow fading out behind it was never seen anyway.
const APPEAR_MS = 600;

// On a pale page, a blurred dark pixel reads as a shadow. Keep light pixels
// and vivid colours, lifting each to full brightness; near-black and dull
// pixels become transparent. Work on the tiny sample before CSS stretches and
// blurs it. The colour is all that shows: white light on a near-white page is
// invisible, so a tint that kept only part of its colour vanished once
// blurred, and the gap between channels is widened rather than narrowed.
export function lightGlowPixels(pixels) {
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i], green = data[i + 1], blue = data[i + 2];
    const brightest = Math.max(red, green, blue);
    const chroma = brightest - Math.min(red, green, blue);
    const luminance = .2126 * red + .7152 * green + .0722 * blue;
    const light = Math.max(0, Math.min(1, (luminance - 45) / 125));
    const vivid = Math.max(0, Math.min(1, (chroma - 30) / 120))
      * Math.min(1, brightest / 100);
    data[i + 3] *= Math.max(light, vivid);
    const white = 235 + 20 * brightest / 255;
    // Held short of pushing a channel below zero: a clipped channel shifts
    // the hue, so oranges went red and skin went orange.
    const widen = Math.min(1.2, white / Math.max(1, chroma));
    data[i] = white - widen * (brightest - red);
    data[i + 1] = white - widen * (brightest - green);
    data[i + 2] = white - widen * (brightest - blue);
  }
  return pixels;
}

/** The gap to leave before the next realtime copy, given how long the recent
 *  ones took, newest last, and how many frames the video dropped since the
 *  last copy (undefined where the browser cannot say). Frames dropped while
 *  copies are quick are not the copies' doing, so they do not slow it. Judged
 *  on copy time alone it holds between the two thresholds, so it does not
 *  hunt. */
export function nextSampleInterval(interval, copies, dropped) {
  const sorted = [...copies].sort((a, b) => a - b);
  const copyMs = sorted[sorted.length >> 1];
  const slower = () => Math.min(REALTIME_SAMPLE_MAX_MS, interval * 1.5);
  const faster = () => Math.max(REALTIME_SAMPLE_MS, interval * .9);
  if (dropped !== undefined) return dropped > 0 && copyMs > FAST_COPY_MS ? slower() : faster();
  if (copyMs > SLOW_COPY_MS) return slower();
  if (copyMs < FAST_COPY_MS) return faster();
  return interval;
}

/** Frames the video has dropped in all, or undefined where it cannot say. */
function droppedFrames(video) {
  return video.getVideoPlaybackQuality?.().droppedVideoFrames;
}

/** Watches frame gaps and says when the page has been struggling for long
 *  enough to give up on the glow. A window is judged by the share of its frames
 *  that were slow; one bad window may be a seek or a tab coming back, so it
 *  takes several in a row. Gaps over STALL_MS are the page having been away
 *  (hidden, suspended) rather than slow, and are not counted. */
const JANK_WINDOW_MS = 2000;
const JANK_SLOW_MS = 40;
const JANK_SHARE = .3;
const JANK_WINDOWS = 3;
const JANK_STALL_MS = 500;
export function createJankMonitor() {
  let elapsed = 0, frames = 0, slow = 0, bad = 0;
  return {
    reset() { elapsed = frames = slow = bad = 0; },
    /** Feeds one frame gap; true once the glow should be turned off. */
    frame(gap) {
      if (!(gap > 0) || gap > JANK_STALL_MS) return false;
      elapsed += gap;
      frames++;
      if (gap > JANK_SLOW_MS) slow++;
      if (elapsed < JANK_WINDOW_MS) return false;
      bad = slow / frames > JANK_SHARE ? bad + 1 : 0;
      elapsed = frames = slow = 0;
      return bad >= JANK_WINDOWS;
    },
  };
}

// Automatic mode's verdict is about this device, not the account, so it is
// kept here rather than in preferences.js, which would carry it to the
// account's faster devices. Choosing another lighting mode clears it.
const SUSPENDED_KEY = 'archive-glow-suspended';
function glowSuspended() {
  try { return localStorage.getItem(SUSPENDED_KEY) === '1'; } catch { return false; }
}
function suspendGlow(on) {
  try { on ? localStorage.setItem(SUSPENDED_KEY, '1') : localStorage.removeItem(SUSPENDED_KEY); } catch { /* Per page load then. */ }
}

export function finishGlowFades(canvas) {
  for (const animation of canvas.getAnimations()) {
    // Sampling must finish the crossfade before reusing a layer, but leave
    // the immersive blur transition running across successive samples.
    if (animation.effect?.getKeyframes().some(frame => Object.hasOwn(frame, 'opacity'))) {
      animation.finish();
    }
  }
}

export function initialiseAmbientGlow(player, stage) {
  const glow = document.createElement('div');
  glow.className = 'archive-ambient-glow';
  glow.hidden = true;
  glow.setAttribute('aria-hidden', 'true');
  const layers = [0, 1].map(() => {
    const canvas = document.createElement('canvas');
    canvas.width = GLOW_WIDTH;
    canvas.height = GLOW_HEIGHT;
    // Neither shows until a sample is drawn into it: the two add together.
    canvas.style.opacity = '0';
    // The light theme reads each sample back to filter it. At this size that
    // is cheaper on the CPU than a round trip from a GPU-backed canvas, and
    // only Chrome works that out for itself.
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (context) context.imageSmoothingQuality = 'high';
    return {canvas, context};
  });
  if (layers.some(layer => !layer.context)) return;
  glow.append(...layers.map(layer => layer.canvas));
  stage.prepend(glow);
  const page = stage.closest('.archive-watch');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let image;
  let sheet;
  let token;
  let switchedToken;
  let timer;
  let frameRequest = null;
  let lastSample = -Infinity;
  let lastTime = -1;
  let still = '';
  let visible = true;
  let front = 0;
  let sampleInterval = REALTIME_SAMPLE_MS;
  const copies = [];
  let droppedBefore;
  const jank = createJankMonitor();
  let suspended = glowSuspended();
  let watching = false;
  let chosenMode = playerLightingMode();
  let warmUntil = 0;

  function filterLightSample(context) {
    if (document.documentElement.dataset.theme !== 'light') return;
    try {
      const pixels = context.getImageData(0, 0, GLOW_WIDTH, GLOW_HEIGHT);
      context.putImageData(lightGlowPixels(pixels), 0, 0);
      glow.style.mixBlendMode = '';
    } catch {
      // A cross-origin poster may draw but forbid pixel reads. Screen blending
      // keeps its dark areas from shading the page in that case.
      glow.style.mixBlendMode = 'screen';
    }
  }

  /** Automatic mode times the page's frames while the glow is showing. The
   *  glow's first moments (its fade up, the zoom settling) are left out. */
  function watchFrames() {
    if (watching || playerLightingMode() !== 'automatic') return;
    watching = true;
    jank.reset();
    warmUntil = performance.now() + 1500;
    let previous;
    const tick = time => {
      if (glow.hidden || document.hidden || playerLightingMode() !== 'automatic') { watching = false; return; }
      if (time > warmUntil && previous != null && jank.frame(time - previous)) {
        watching = false;
        suspended = true;
        suspendGlow(true);
        update();
        return;
      }
      previous = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function hide() {
    glow.hidden = true;
    glow.getAnimations().forEach(animation => animation.cancel());
    for (const {canvas} of layers) canvas.getAnimations().forEach(animation => animation.cancel());
    lastSample = -Infinity;
    lastTime = -1;
    still = '';
  }

  /** The layer not showing, to draw the next sample into. What is left of
   *  the last fade finishes first, so it is out of sight before it changes. */
  function nextLayer() {
    for (const {canvas} of layers) finishGlowFades(canvas);
    return layers[1 - front];
  }

  /** Fades a freshly drawn layer in as the other fades out, over the time
   *  since the last sample so fades meet end to end; the first sample after
   *  the glow was hidden shows at once, and the glow as a whole fades up. */
  function present(layer, now) {
    const appearing = glow.hidden;
    const fade = appearing ? 0 : Math.min(FADE_MAX_MS, Math.max(FADE_MIN_MS, now - lastSample));
    lastSample = now;
    const outgoing = layers[front].canvas;
    front = layers.indexOf(layer);
    outgoing.style.opacity = '0';
    layer.canvas.style.opacity = '1';
    if (fade) {
      outgoing.animate({opacity: [1, 0]}, {duration: fade});
      layer.canvas.animate({opacity: [0, 1]}, {duration: fade});
    }
    glow.hidden = false;
    watchFrames();
    // On the container, not the layer: the next sample finishes the layers'
    // fades early, and it comes long before this one would end.
    if (appearing) glow.animate({opacity: [0, getComputedStyle(glow).opacity]}, {duration: APPEAR_MS, easing: 'ease-out'});
  }

  // Sample on the video's own frames where the browser offers them, so a
  // copy is always of a new picture; a timer where it does not.
  function followFrames() {
    const {video} = player;
    if (!video.requestVideoFrameCallback) {
      timer = setTimeout(update, Math.max(16, sampleInterval - (performance.now() - lastSample)));
    } else if (frameRequest == null) {
      frameRequest = video.requestVideoFrameCallback(() => {
        frameRequest = null;
        update();
      });
    }
  }

  function update() {
    clearTimeout(timer);
    const mode = playerLightingMode();
    const state = player.root.dataset.playerState;
    const switching = page?.classList.contains('is-switching');
    if (switching) switchedToken = player.loadToken;
    // No light until the zoom from a card has landed and faded: sampling and
    // redrawing the blur mid-flight made the zoom stutter. The mini player's
    // stylesheet hides the glow, so sampling for it would be pure waste.
    if (mode === 'off' || (mode === 'automatic' && suspended) || document.hidden || document.fullscreenElement || !visible || reducedMotion.matches || !player.source
        || switching || page?.classList.contains('is-zooming') || page?.classList.contains('is-mini')
        || !['playing', 'paused'].includes(state)) {
      hide();
      return;
    }
    if (token !== player.loadToken) hide();
    const now = performance.now();
    // The light comes from the picture on screen, and sometimes that is the
    // thumbnail rather than the video. A playlist switch hides the poster
    // and shows black until the new frame is ready. Its video may still report
    // the poster after the switch ends, so do not use that poster for this
    // load. A video the browser cannot decode still gives Safari a frame per
    // seek, which lit the page in colours from a video that would not play;
    // and a page opened on a video holds its thumbnail until there is a frame
    // to show, which with nothing to resume is not until play is pressed,
    // while the seek sheet's first tile - often a title card or black - lit
    // the page around it.
    // The video element keeps its own poster up, loaded frames or not, until
    // it has played or been sought; with nothing to resume that is until play
    // is pressed, and the glow followed the hidden first frame instead - in
    // Firefox a second after the page opened, once that frame had loaded.
    const {video} = player;
    const videoOnPoster = switchedToken !== player.loadToken
      && Boolean(video.getAttribute('poster')) && !video.played.length
      && !video.currentTime && !video.seeking;
    const posterShown = player.root.classList.contains('is-audio-only')
      || player.root.classList.contains('is-unplayable')
      || Boolean(stage.closest('.is-holding-poster')) || videoOnPoster;
    if (posterShown) {
      const {poster} = player;
      if (!poster?.complete || !poster.naturalWidth) { hide(); return; }
      if (token === player.loadToken && still === poster.src) return;
      const layer = nextLayer();
      try {
        layer.context.clearRect(0, 0, GLOW_WIDTH, GLOW_HEIGHT);
        layer.context.drawImage(poster, 0, 0, GLOW_WIDTH, GLOW_HEIGHT);
        filterLightSample(layer.context);
      } catch { hide(); return; }
      token = player.loadToken;
      still = poster.src;
      present(layer, now);
      return;
    }
    // Back to the video, so the thumbnail is drawn afresh if it is shown again.
    still = '';
    if (!player.video.paused && !player.video.ended) followFrames();
    if (player.video.readyState >= 2 && !player.video.seeking) {
      if (now - lastSample < sampleInterval || player.video.currentTime === lastTime) return;
      const layer = nextLayer();
      try {
        layer.context.clearRect(0, 0, GLOW_WIDTH, GLOW_HEIGHT);
        // Only the copy is timed: it is what a large frame makes slow, and
        // the fades finished and the light theme's filter are not.
        const copyStart = performance.now();
        layer.context.drawImage(player.video, 0, 0, GLOW_WIDTH, GLOW_HEIGHT);
        copies.push(performance.now() - copyStart);
        if (copies.length > COPY_WINDOW) copies.shift();
        filterLightSample(layer.context);
        // The count runs from when the video was loaded, so it falls when a
        // new one starts; that is no frames dropped, not frames regained.
        const droppedNow = droppedFrames(player.video);
        const dropped = droppedNow === undefined ? undefined
          : Math.max(0, droppedNow - (droppedBefore ?? droppedNow));
        droppedBefore = droppedNow;
        sampleInterval = nextSampleInterval(sampleInterval, copies, dropped);
        token = player.loadToken;
        lastTime = player.video.currentTime;
        present(layer, now);
        return;
      } catch { /* Keep the seek-sheet fallback if a frame cannot be copied. */ }
    }
    // A seek or brief buffering gap must not flash a distant thumbnail over
    // the live colours. Hold the last frame until decoded video returns.
    if (lastTime >= 0) return;
    if (token !== player.loadToken || sheet !== player.seekPreview) {
      token = player.loadToken;
      sheet = player.seekPreview;
      image = null;
      hide();
      const url = sheet?.spriteUrl ?? sheet?.sprite_url;
      if (url) {
        const pending = new Image();
        image = pending;
        pending.onload = () => { if (image === pending) update(); };
        pending.src = url;
      }
    }
    if (!image?.complete || !image.naturalWidth) return;
    const width = Number(sheet.tileWidth ?? sheet.tile_width);
    const height = Number(sheet.tileHeight ?? sheet.tile_height);
    const columns = Number(sheet.columns);
    const count = Number(sheet.count);
    const duration = player.totalDuration();
    if (!(width > 0 && height > 0 && columns > 0 && count > 0 && duration > 0)) return;
    const {first, second, blend} = ambientFrames(count, player.absoluteTime() / duration);
    // timeupdate arrives in discrete steps, even though neighbouring tiles
    // are interpolated. Each step fades in like a live sample.
    const layer = nextLayer();
    const {context} = layer;
    const draw = index => context.drawImage(image,
      index % columns * width, Math.floor(index / columns) * height, width, height,
      0, 0, GLOW_WIDTH, GLOW_HEIGHT);
    context.globalAlpha = 1;
    context.clearRect(0, 0, GLOW_WIDTH, GLOW_HEIGHT);
    draw(first);
    context.globalAlpha = blend;
    draw(second);
    context.globalAlpha = 1;
    filterLightSample(context);
    present(layer, now);
  }

  for (const event of ['timeupdate', 'play', 'pause', 'loadeddata', 'emptied']) {
    player.video.addEventListener(event, update);
  }
  player.video.addEventListener('seeked', () => {
    lastSample = -Infinity;
    lastTime = -1;
    update();
  });
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    update();
  }, {rootMargin: '100px'}).observe(stage);
  new MutationObserver(update).observe(player.root,
    {attributes: true, attributeFilter: ['data-player-state', 'class']});
  // The watch page holds the thumbnail up with a class of its own.
  if (page) new MutationObserver(update).observe(page, {attributes: true, attributeFilter: ['class']});
  player.poster?.addEventListener('load', update);
  new MutationObserver(update).observe(player.previewImage,
    {attributes: true, attributeFilter: ['style']});
  document.addEventListener('visibilitychange', update);
  // Fullscreen lifts the player out of the stage and leaves the glow behind
  // it, unseen but still sampling frames; the stage never scrolls, so the
  // IntersectionObserver cannot notice.
  document.addEventListener('fullscreenchange', update);
  window.addEventListener('archive-lighting-change', () => {
    // The event also fires as the page loads, so only a changed mode counts
    // as choosing again.
    if (playerLightingMode() !== chosenMode) {
      chosenMode = playerLightingMode();
      suspended = false;
      suspendGlow(false);
    }
    hide();
    sampleInterval = REALTIME_SAMPLE_MS;
    copies.length = 0;
    droppedBefore = undefined;
    token = undefined;
    sheet = undefined;
    image = null;
    update();
  });
  new MutationObserver(() => {
    hide();
    glow.style.mixBlendMode = '';
    update();
  }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  reducedMotion.addEventListener('change', update);
}
