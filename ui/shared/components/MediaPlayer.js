import {formatDuration} from '../lib/item.js';
import {ProjectionRenderer, clampFov, horizontalFov, panBy, pinchBy} from '../lib/projection.js';
import {formatPlayerTime, previewPlacement, tileBackgroundPosition} from '../lib/seek-preview.js';
import {AudioWaveform} from './AudioWaveform.js';
import {iconHref} from './icons.js';
import {createSay, escapeMarkup} from '../lib/labels.js';
import {createVolumePopup, volumeLevel} from '../lib/volume-popup.js';

/** The player's words, English unless an app passes its own `labels`. */
export const DEFAULT_PLAYER_LABELS = {
  player: 'Video player', canvas: 'Interactive unwarped video view', audioOnly: 'Audio only', controls: 'Video controls',
  play: 'Play', pause: 'Pause', restart: 'Restart', seek: 'Seek', mute: 'Mute', unmute: 'Unmute', volume: 'Volume',
  showRaw: 'Show raw video', showUnwarped: 'Show unwarped video', resetView: 'Reset view',
  enterFullscreen: 'Enter fullscreen', exitFullscreen: 'Exit fullscreen',
  cannotPlay: 'This browser cannot play this video.', cannotPlayEncoding: 'This browser cannot play {name} video.',
  couldNotLoad: 'Could not load video.', seeking: 'Seeking…', couldNotSeek: 'Could not seek.',
  noWebgl: 'WebGL unwarping is unavailable; showing the raw video.',
};
const say = createSay(DEFAULT_PLAYER_LABELS);

/* A pan is a click with the pointer moved. Past this many pixels the gesture
   is a camera move, not a tap to pause. */
const DRAG_SLOP = 4;

const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><use href="${iconHref(name)}"></use></svg>`;

/**
 * Keeps a poster image from ever showing the wrong picture. A browser paints
 * the previous image until the new `src` decodes, so a reused player would
 * show the last video's thumbnail over this one - and an image with no `src`,
 * or one that fails, paints as a broken box. Either way the image stays hidden
 * until the picture it was last given has actually arrived.
 *
 * The `src` is watched rather than wrapped because hosts set it directly on
 * the element, not through this module. Binding twice returns the first sync.
 */
export function bindPosterImage(image, {watchSource} = {}) {
  if (image._posterSync) return image._posterSync;
  const sync = () => {
    const source = image.getAttribute('src');
    image.hidden = !source || !(image.complete && image.naturalWidth !== 0);
  };
  image.addEventListener('load', () => { image.hidden = false; });
  image.addEventListener('error', () => { image.hidden = true; });
  const watch = watchSource || (handler => new globalThis.MutationObserver(handler)
    .observe(image, {attributes: true, attributeFilter: ['src']}));
  watch(sync);
  sync();
  image._posterSync = sync;
  return sync;
}

export function createPlayerElement({label, labels} = {}) {
  // Only for the markup below, which is written as a string.
  const s = (key, values) => escapeMarkup(say(labels, key, values));
  const root = document.createElement('div');
  root.className = 'media-player';
  root.dataset.playerState = 'idle';
  root.tabIndex = 0;
  root.setAttribute('aria-label', label ?? say(labels, 'player'));
  root.innerHTML = `<img class="media-player-poster" alt="" decoding="async" hidden>
    <video class="media-player-video" playsinline preload="metadata"></video>
    <canvas class="media-player-canvas" aria-label="${s('canvas')}"></canvas>
    <div class="media-player-audio-visual">
    <div class="media-player-audio-icon" role="img" aria-label="${s('audioOnly')}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
        <path d="M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
        <path d="M9 17v-13h10v13" />
        <path d="M9 8h10" />
      </svg>
    </div>
    <div class="media-player-audio-waveform" aria-hidden="true">${
      Array.from({length: 10}, () => '<span></span>').join('')}</div>
    </div>
    <div class="media-player-message" role="status" hidden></div>
    <div class="media-player-controls" aria-label="${s('controls')}">
      <button type="button" data-media-play aria-label="${s('play')}">${icon('play', 'media-icon-play')}${icon('pause', 'media-icon-pause')}</button>
      <button type="button" data-media-restart aria-label="${s('restart')}">${icon('skip-back')}</button>
      <span data-media-time>0:00 / 0:00</span>
      <input data-media-seek type="range" min="0" max="1000" value="0" aria-label="${s('seek')}">
      <button type="button" data-media-volume-toggle data-volume-state="high" aria-label="${s('mute')}">${
        icon('volume-high', 'media-icon-volume-high')}${icon('volume-medium', 'media-icon-volume-medium')}${
        icon('volume-zero', 'media-icon-volume-zero')}${icon('volume-muted', 'media-icon-volume-muted')}</button>
      <span class="media-player-volume-popup" data-media-volume-popup><input data-media-volume type="range" min="0" max="1" step="0.05" value="1" aria-label="${s('volume')}"><button type="button" data-media-mute aria-pressed="false" aria-label="${s('mute')}">${icon('volume-muted')}</button></span>
      <button type="button" data-media-view aria-label="${s('showRaw')}">${icon('projection-flat', 'media-icon-projected')}${icon('projection-raw', 'media-icon-raw')}</button>
      <button type="button" data-media-reset aria-label="${s('resetView')}">${icon('reset')}</button>
      <button type="button" data-media-fullscreen aria-label="${s('enterFullscreen')}">${icon('maximize', 'media-icon-maximize')}${icon('minimize', 'media-icon-minimize')}</button>
    </div>
    <output class="media-player-seek-preview" data-media-seek-preview hidden>
      <span class="media-player-seek-preview-image" data-media-preview-image hidden></span>
      <span class="media-player-seek-preview-time" data-media-preview-time>0:00</span>
    </output>`;
  return root;
}

export class LocalMediaProvider {
  async resolve(item, partIndex = 0) {
    const part = item.parts?.[partIndex] || item.parts?.[0] || item;
    return {url: part.sourceRef || item.sourceRef, type: 'file',
      durationSeconds: Number(part.durationSeconds || item.durationSeconds || 0),
      resumeSeconds: Number(part.watch?.resumeSeconds || item.watch?.resumeSeconds || 0),
      poster: part.thumbnail?.url || item.thumbnail?.url || '',
      media: part.media || item.media || null,
      seekPreview: part.seekPreview || item.seekPreview || null,
      encoding: part.encoding || item.encoding || null};
  }
  async reportPlayback() {}
  async release() {}
}

export class MediaPlayer {
  constructor(root, {provider = new LocalMediaProvider(), reportInterval = 10000, roomShader, touchActivation = false, labels} = {}) {
    this.root = root;
    this.labels = labels;
    this.provider = provider;
    this.reportInterval = reportInterval;
    this.touchActivation = touchActivation;
    this.video = root.querySelector('.media-player-video');
    this.poster = root.querySelector('.media-player-poster');
    if (this.poster) bindPosterImage(this.poster);
    this.audioWaveform = new AudioWaveform(this.video,
      [...root.querySelectorAll('.media-player-audio-waveform span')],
      () => this.root.classList.contains('is-audio-only'));
    this.playButton = root.querySelector('[data-media-play]');
    this.seek = root.querySelector('[data-media-seek]');
    this.time = root.querySelector('[data-media-time]');
    this.volume = root.querySelector('[data-media-volume]');
    this.volumeButton = root.querySelector('[data-media-volume-toggle]');
    this.volumePopup = root.querySelector('[data-media-volume-popup]');
    this.muteButton = root.querySelector('[data-media-mute]');
    this.volumeControl = createVolumePopup({
      button: this.volumeButton, popup: this.volumePopup, slider: this.volume,
      onToggle: open => {
        this.root.classList.toggle('is-volume-open', open);
        if (!open) this.updateVolume();
      },
    });
    this.fullscreenButton = root.querySelector('[data-media-fullscreen]');
    this.message = root.querySelector('.media-player-message');
    this.canvas = root.querySelector('.media-player-canvas');
    this.viewButton = root.querySelector('[data-media-view]');
    this.resetButton = root.querySelector('[data-media-reset]');
    this.preview = root.querySelector('[data-media-seek-preview]');
    this.previewImage = root.querySelector('[data-media-preview-image]');
    this.previewTime = root.querySelector('[data-media-preview-time]');
    this.roomShader = roomShader;
    this.pointers = new Map();
    this.loadToken = 0;
    this.scrubbing = false;
    this.bind();
  }

  bind() {
    this.playButton.addEventListener('click', () => this.toggle());
    this.root.querySelector('[data-media-restart]').addEventListener('click', () => this.requestSeek(0));
    this.seek.addEventListener('input', () => { this.scrubbing = true; if (!this.streamSeek() && Number.isFinite(this.video.duration)) this.video.currentTime = Number(this.seek.value) * this.video.duration / 1000; this.updateControls(); });
    this.seek.addEventListener('change', () => { const target = Number(this.seek.value) * this.totalDuration() / 1000; this.scrubbing = false; return this.requestSeek(target); });
    this.volume.addEventListener('input', () => { this.video.volume = Number(this.volume.value); this.video.muted = false; });
    this.volumeButton.addEventListener('click', () => {
      // Where the bar has no room for the slider, a collapsed button alone
      // could only mute - there was no way to set a level at all. So there the
      // button stands the slider up above itself instead, and muting moves
      // into that popup with it. Whether the slider has room is the
      // stylesheet's call: it is simply not laid out when it has none.
      if (this.volumeOpen) this.closeVolume();
      else if (!this.volume.getClientRects().length) this.openVolume();
      else this.video.muted = !this.video.muted;
    });
    this.muteButton.addEventListener('click', () => { this.video.muted = !this.video.muted; });
    // Which of those the button does changes with the bar's width, and the
    // bar is only a play button until something is loaded, so its label is
    // settled again whenever the bar is resized.
    if (globalThis.ResizeObserver) {
      new ResizeObserver(() => this.updateVolume())
        .observe(this.root.querySelector('.media-player-controls'));
    }
    this.fullscreenButton.addEventListener('click', () => this.toggleFullscreen());
    this.viewButton.addEventListener('click', () => this.setRaw(!this.raw));
    this.resetButton.addEventListener('click', () => this.resetView());
    this.video.addEventListener('loadedmetadata', () => { this.updateMediaKind(); if (this.resumeSeconds > 0) this.video.currentTime = Math.min(this.resumeSeconds, Math.max(0, this.video.duration - 1)); this.updateControls(); this.draw(); });
    this.video.addEventListener('timeupdate', () => this.updateControls());
    this.video.addEventListener('volumechange', () => this.updateVolume());
    this.video.addEventListener('play', () => { this.root.dataset.playerState = 'playing'; this.playButton.ariaLabel = say(this.labels, 'pause'); clearInterval(this.reportTimer); this.reportTimer = setInterval(() => this.report('progress'), this.reportInterval); this.startDrawing(); this.audioWaveform.start(); this.showControls(); });
    this.video.addEventListener('pause', () => { if (this.root.dataset.playerState !== 'idle') this.root.dataset.playerState = 'paused'; this.playButton.ariaLabel = say(this.labels, 'play'); clearInterval(this.reportTimer); this.audioWaveform.pause(); this.keepControlsVisible(); if (!this.stopping) this.report('pause'); });
    this.video.addEventListener('ended', () => { clearInterval(this.reportTimer); this.audioWaveform.pause(); this.report('ended'); });
    this.video.addEventListener('error', () => { if (this.video.error?.code !== globalThis.MediaError?.MEDIA_ERR_ABORTED) this.showUnplayable(say(this.labels, 'cannotPlay')); });
    this.seek.addEventListener('pointerenter', event => this.showPreview(event));
    this.seek.addEventListener('pointermove', event => this.showPreview(event));
    this.seek.addEventListener('pointerleave', () => { this.preview.hidden = true; });
    this.canvas.addEventListener('pointerdown', event => { this.canvas.setPointerCapture(event.pointerId); this.dragged = false; this.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY}); });
    this.canvas.addEventListener('pointermove', event => this.movePointer(event));
    this.canvas.addEventListener('pointerup', event => this.pointers.delete(event.pointerId));
    this.canvas.addEventListener('pointercancel', event => this.pointers.delete(event.pointerId));
    this.canvas.addEventListener('wheel', event => { event.preventDefault(); this.fov = clampFov(this.fov + event.deltaY * .04); this.draw(); }, {passive: false});
    // A touch that finds the bar hidden is only waking it, as a mouse move
    // would; the same tap must not also pause. Read in the capture phase,
    // before the bubbling listener below reveals the bar.
    this.root.addEventListener('pointerdown', event => {
      this.touchWokeControls = event.pointerType !== 'mouse' && event.isPrimary
        && this.root.classList.contains('is-controls-hidden')
        && this.controlsAreClickThrough();
    }, true);
    // The bar is click-through while hidden, but browsers can hit-test the
    // click again once the finger lifts, by which time the bar is back and
    // the tap would land on whichever button now sits there. Stopped in the
    // capture phase so no button ever sees it.
    this.root.addEventListener('click', event => {
      if (!this.touchWokeControls) return;
      this.touchWokeControls = false;
      event.stopPropagation();
      event.preventDefault();
    }, true);
    this.root.addEventListener('click', event => {
      // A pan of the projected view ends in a click on the canvas. Moving the
      // camera is the gesture the viewer made, so it must not also pause.
      if (this.dragged) { this.dragged = false; return; }
      // A press that lands on the picture to put the volume slider away was
      // only meant to dismiss it, not to pause as well.
      if (this.volumeControl.takeDismissed()) return;
      const onControls = event.target.closest?.('.media-player-controls');
      // Revealing hidden controls after the first click can put the second
      // click over the controls even though the gesture began on the video.
      // Keep treating that pair as one surface gesture.
      if (onControls && !this.surfaceClickGesture) return;
      clearTimeout(this.surfaceClickTimer);
      this.surfaceClickGesture = true;
      this.surfaceClickCount = (this.surfaceClickCount || 0) + 1;
      // Use our own sequence because browsers may carry their native click
      // count across two double-clicks made close together.
      if (this.surfaceClickCount === 1) {
        this.surfaceClickTimer = setTimeout(() => {
          this.surfaceClickCount = 0;
          this.surfaceClickGesture = false;
          this.toggle();
        }, 300);
      }
    });
    this.bindTouchActivation();
    this.root.addEventListener('dblclick', event => {
      if (event.target.closest?.('.media-player-controls') && !this.surfaceClickGesture) return;
      event.preventDefault();
      clearTimeout(this.surfaceClickTimer);
      this.surfaceClickCount = 0;
      this.surfaceClickGesture = false;
      this.toggleFullscreen();
    });
    ['pointermove', 'pointerdown', 'focusin', 'keydown'].forEach(type =>
      this.root.addEventListener(type, () => this.showControls()));
    this.root.addEventListener('keydown', event => { if (event.target.matches('input, button')) return; if (event.key === ' ') { event.preventDefault(); this.toggle(); } if (event.key === 'ArrowLeft') this.requestSeek(this.absoluteTime() - 10); if (event.key === 'ArrowRight') this.requestSeek(this.absoluteTime() + 10); if (event.key.toLowerCase() === 'f') this.toggleFullscreen(); });
    document.addEventListener('fullscreenchange', () => this.updateFullscreen());
    this.updateVolume();
  }

  async load(item, partIndex = 0) {
    const token = ++this.loadToken;
    await this.stop('change');
    this.item = item;
    this.partIndex = partIndex;
    this.scrubbing = false;
    this.root.dataset.playerState = 'loading';
    this.root.classList.remove('is-unplayable', 'is-audio-only');
    this.audioWaveform.reset();
    this.hideMessage();
    try {
      const source = await this.provider.resolve(item, partIndex);
      if (token !== this.loadToken) { await this.provider.release?.(source); return false; }
      this.source = source;
      this.resumeSeconds = Number(source.resumeSeconds || 0);
      this.video.poster = source.poster || '';
      this.setPoster(source.poster);
      this.configureProjection(source.media);
      this.configureSeekPreview(source.seekPreview);
      if (this.provider.resolveSeekPreview) {
        this.provider.resolveSeekPreview(source).then(sheet => {
          if (token === this.loadToken && sheet) this.configureSeekPreview(sheet);
        });
      }
      if (this.provider.attach) await this.provider.attach(this.video, source);
      else { this.video.src = source.url; this.video.load(); }
      this.root.dataset.playerState = 'paused';
      this.checkDecodable(source, token);
      return true;
    } catch (error) { if (token === this.loadToken) this.showMessage(error.message || say(this.labels, 'couldNotLoad')); return false; }
  }

  updateMediaKind() {
    const audioOnly = this.video.readyState >= 1 && !this.video.videoWidth && !this.video.videoHeight;
    this.root.classList.toggle('is-audio-only', audioOnly);
    if (audioOnly && !this.video.paused) this.audioWaveform.start();
  }

  /**
   * A codec the browser cannot decode does not always fail loudly. Safari on a
   * Mac with no AV1 hardware loads such a file, shows a frame for each seek,
   * and then never plays - no error event, nothing to say why. So a source
   * that says how it is encoded is checked before anyone presses play. It is
   * still attached: the check can only say no, and a wrong no should cost a
   * message, not the video.
   */
  async checkDecodable(source, token) {
    const encoding = source.encoding;
    if (!encoding?.contentType) return;
    let playable = this.video.canPlayType?.(encoding.contentType) !== '';
    const capabilities = globalThis.navigator?.mediaCapabilities;
    if (playable && capabilities) {
      const {name, ...video} = encoding;
      try { playable = (await capabilities.decodingInfo({type: 'file', video})).supported; }
      catch { /* A configuration it cannot judge is no evidence either way. */ }
    }
    if (!playable && token === this.loadToken) {
      this.showUnplayable(encoding.name ? say(this.labels, 'cannotPlayEncoding', {name: encoding.name}) : say(this.labels, 'cannotPlay'));
    }
  }

  /** A video that will not play keeps its poster up: the element it would
   *  have played in is black, and a black player says nothing about what the
   *  video was. */
  showUnplayable(message) {
    this.root.classList.add('is-unplayable');
    this.showMessage(message);
  }

  /**
   * The poster is the host's if the host has set one. A host knows things
   * about its own picture that a resolved source does not - which settings it
   * was generated under, that it has just been regenerated, that the copy on
   * screen is already decoded - and a URL resolved from the item can answer
   * with something else entirely. So the player fills an empty poster and
   * maintains the one it filled, and never overwrites anyone else's.
   */
  setPoster(url) {
    if (!this.poster) return;
    const current = this.poster.getAttribute('src');
    if (current && current !== this.posterSrc) return;
    if (url) {
      if (current !== url) this.poster.src = url;
      this.posterSrc = url;
      return;
    }
    if (current) this.poster.removeAttribute('src');
    this.posterSrc = '';
  }

  async play() { if (this.root.classList.contains('is-audio-only')) this.audioWaveform.start(); else this.audioWaveform.resumeOutput(); try { await this.video.play(); } catch (error) { if (error.name !== 'AbortError') this.showMessage(error.message); } }
  toggle() { return this.video.paused ? this.play() : this.video.pause(); }
  async stop(reason = 'close') {
    this.scrubbing = false;
    clearTimeout(this.surfaceClickTimer);
    this.surfaceClickCount = 0;
    this.surfaceClickGesture = false;
    this.keepControlsVisible();
    clearInterval(this.reportTimer);
    this.audioWaveform.reset();
    if (!this.source) return;
    this.stopping = true;
    this.video.pause();
    await this.report(reason);
    await this.provider.release?.(this.source, this.video);
    this.stopping = false;
    this.source = null;
    cancelAnimationFrame(this.frameRequest);
    this.video.removeAttribute('src');
    this.video.load();
    this.root.dataset.playerState = 'idle';
  }
  report(reason) {
    if (!this.item || !this.source) return Promise.resolve();
    return Promise.resolve(this.provider.reportPlayback?.({reason, item: this.item, partIndex: this.partIndex, source: this.source, positionSeconds: this.absoluteTime(), durationSeconds: this.totalDuration()})).catch(() => {});
  }
  totalDuration() { return Number(this.source?.durationSeconds || this.video.duration || 0); }
  absoluteTime() { return Number(this.video.currentTime || 0) + Number(this.source?.startOffset || 0); }
  /**
   * True only when seeking means asking the provider for a fresh stream. A
   * provider that can do that for its HLS sources still serves plain files
   * the browser seeks by itself, so the source decides, not the provider.
   */
  streamSeek() { return Boolean(this.provider.seek) && this.source?.type === 'hls'; }

  async requestSeek(seconds) {
    const target = Math.max(0, Math.min(this.totalDuration() || Infinity, Number(seconds) || 0));
    if (!this.streamSeek()) {
      this.video.currentTime = target;
      return this.report('seek');
    }
    const previous = this.source;
    const wasPlaying = !this.video.paused;
    this.video.pause();
    this.showMessage(say(this.labels, 'seeking'));
    try {
      const next = await this.provider.seek(previous, target, this.item);
      await this.provider.attach(this.video, next);
      this.source = next;
      this.resumeSeconds = Number(next.resumeSeconds || 0);
      await this.provider.release(previous);
      this.hideMessage();
      if (wasPlaying) await this.play();
      await this.report('seek');
    } catch (error) { this.showMessage(error.message || say(this.labels, 'couldNotSeek')); }
  }
  /**
   * Gives the readout an explicit width so a change in digits (a video that
   * crosses ten minutes or an hour) can slide the seek bar to its new length
   * instead of snapping; an auto width cannot be transitioned. Only a change
   * in the text's length is worth measuring, and a hidden readout measures as
   * zero, which must not be kept.
   */
  fitTime() {
    const length = this.time.textContent.length;
    if (length === this.timeLength) return;
    const range = document.createRange();
    range.selectNodeContents(this.time);
    const width = range.getBoundingClientRect().width;
    if (!width) return;
    this.timeLength = length;
    this.time.style.width = `${width}px`;
  }

  /**
   * While the thumb is being dragged it, not the playhead, owns the position.
   * Writing the playhead back mid-drag pulls the thumb out from under the
   * pointer, and the value the drag ends on is then the playhead's rather than
   * the one that was aimed at - which reads as seeking doing nothing at all.
   */
  updateControls() {
    const duration = this.totalDuration();
    const playhead = Math.min(duration || Infinity, this.absoluteTime());
    const position = this.scrubbing && duration
      ? Number(this.seek.value) * duration / 1000 : playhead;
    this.time.textContent = `${formatDuration(position)} / ${formatDuration(duration)}`;
    this.fitTime();
    if (!this.scrubbing) {
      this.seek.value = duration ? String(Math.round(playhead * 1000 / duration)) : '0';
    }
    this.seek.style.setProperty('--range-progress', `${duration ? position * 100 / duration : 0}%`);
  }
  updateVolume() {
    const muted = this.video.muted;
    const value = this.video.volume;
    // Four glyphs, matching the levels the volume slider can express.
    this.volumeButton.dataset.volumeState = volumeLevel(this.video);
    this.volume.value = muted ? '0' : String(value);
    this.volume.style.setProperty('--range-progress', `${(muted ? 0 : value) * 100}%`);
    // The button only mutes where the slider sits in the bar beside it.
    const popup = this.volumeOpen || (this.root.isConnected && !this.volume.getClientRects().length);
    this.volumeButton.ariaLabel = say(this.labels, popup ? 'volume' : muted ? 'unmute' : 'mute');
    this.muteButton.ariaLabel = say(this.labels, muted ? 'unmute' : 'mute');
    this.muteButton.setAttribute('aria-pressed', String(muted));
  }
  get volumeOpen() { return this.volumeControl.open; }
  openVolume() { this.volumeControl.show(); }
  closeVolume() { this.volumeControl.hide(); }
  // An opt-in workaround for previously observed Firefox Android tap failures.
  // It read some taps on a bar button as a long press (contextmenu 500ms in,
  // with the haptic pulse), withheld the click, and held the pointerup back
  // until the next touch began, so a
  // bar that waits for either runs a tap behind and looks dead. The pointerdown
  // always arrives at once. In fullscreen, where the bar sits over the picture
  // and nothing underneath scrolls, a touch therefore presses the button the
  // moment it lands. Elsewhere a touch that goes down and up on one button
  // without moving presses it on release, so a scroll that starts on the bar is
  // not taken for a tap. Either way the browser's own click, if it does come,
  // is swallowed rather than pressing the button twice.
  bindTouchActivation() {
    // Native clicks are the default; hosts can opt in if tap failures recur.
    if (!this.touchActivation) return;
    const bar = this.root.querySelector('.media-player-controls');
    let press = null;
    let pressed = null;
    const release = event => {
      if (pressed && event.pointerId === pressed.id) pressed.releasedAt = event.timeStamp;
    };
    bar.addEventListener('pointerdown', event => {
      press = null;
      // A lost pointerup must not leave the last button swallowing clicks.
      pressed = null;
      if (event.pointerType === 'mouse' || !event.isPrimary || this.touchWokeControls) return;
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (document.fullscreenElement === this.root) {
        pressed = {button, id: event.pointerId, releasedAt: 0};
        button.click();
      } else {
        press = {button, id: event.pointerId, x: event.clientX, y: event.clientY};
      }
    });
    bar.addEventListener('pointerup', event => {
      release(event);
      if (!press || event.pointerId !== press.id) return;
      const {button, x, y} = press;
      press = null;
      if (Math.hypot(event.clientX - x, event.clientY - y) > 10) return;
      pressed = {button, id: event.pointerId, releasedAt: event.timeStamp};
      button.click();
    });
    bar.addEventListener('pointercancel', event => { press = null; release(event); });
    // The callout and text selection a long press raises are no use on a button.
    bar.addEventListener('contextmenu', event => { if (press || pressed) event.preventDefault(); });
    bar.addEventListener('click', event => {
      if (!event.isTrusted || !pressed) return;
      const held = !pressed.releasedAt || event.timeStamp - pressed.releasedAt < 600;
      if (!held || event.target.closest('button') !== pressed.button) { pressed = null; return; }
      pressed = null;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, true);
  }
  // A layout can keep the bar on screen, clear of the picture, whatever the
  // hidden class says (the portrait page does). A touch there is on a live
  // bar, not waking one, so it must act at once rather than be swallowed.
  controlsAreClickThrough() {
    const controls = this.root.querySelector('.media-player-controls');
    return !controls || getComputedStyle(controls).pointerEvents === 'none';
  }
  keepControlsVisible() {
    clearTimeout(this.controlsTimer);
    this.root.classList.remove('is-controls-hidden');
  }
  showControls() {
    this.keepControlsVisible();
    if (this.root.dataset.playerState !== 'playing') return;
    this.controlsTimer = setTimeout(() => {
      if (this.root.dataset.playerState !== 'playing') return;
      // The slider goes with the bar, rather than waiting invisible to be
      // found open again the next time the bar comes back.
      this.closeVolume();
      this.root.classList.add('is-controls-hidden');
    }, 2200);
  }
  toggleFullscreen() { if (document.fullscreenElement === this.root) document.exitFullscreen(); else this.root.requestFullscreen?.(); }
  updateFullscreen() { this.fullscreenButton.ariaLabel = say(this.labels, document.fullscreenElement === this.root ? 'exitFullscreen' : 'enterFullscreen'); }
  currentHorizontalFov() {
    const width = this.canvas.clientWidth || this.root.clientWidth;
    const height = this.canvas.clientHeight || this.root.clientHeight;
    return horizontalFov(this.fov || 90, width > 0 && height > 0 ? width / height : 0);
  }
  captureState() {
    return {video: this.video, canvas: this.canvas, raw: this.raw,
      positionSeconds: this.absoluteTime(), durationSeconds: this.totalDuration(),
      yaw: Number(this.yaw || 0), pitch: Number(this.pitch || 0),
      horizontalFov: this.currentHorizontalFov(), media: this.media || null};
  }
  configureProjection(media) {
    this.media = media;
    this.raw = !media?.projection && !['sbs', 'tb', 'vr180_sbs', 'vr180_tb'].includes(media?.layout);
    this.root.classList.toggle('is-projected', !this.raw);
    this.root.classList.toggle('is-raw', this.raw);
    this.viewButton.hidden = this.raw;
    this.resetButton.hidden = this.raw;
    if (this.raw) return;
    this.renderer ||= new ProjectionRenderer(this.canvas, this.video,
      this.roomShader ? {roomShader: this.roomShader} : {});
    if (!this.renderer.gl && !this.renderer.initialise()) {
      this.setRaw(true);
      this.viewButton.hidden = true;
      this.resetButton.hidden = true;
      this.showMessage(say(this.labels, 'noWebgl'));
    }
    this.resetView();
  }
  projectionSource() {
    const layout = this.media?.layout;
    return {projection: this.media?.projection === 'hequirect' ? 'hequirect' : 'fisheye',
      layout: ['tb', 'vr180_tb'].includes(layout) ? 'tb' : 'sbs',
      inputHfov: Number(this.media?.inputHfov || this.media?.detectedHfov || 180),
      alphaPacked: ['deovr', true].includes(this.media?.alphaPacking)};
  }
  setRaw(raw) { this.raw = raw; this.root.classList.toggle('is-raw', raw); this.viewButton.ariaLabel = say(this.labels, raw ? 'showUnwarped' : 'showRaw'); if (!raw) this.draw(); }
  resetView() { this.yaw = 0; this.pitch = 0; this.fov = clampFov(this.media?.hfov || 90); this.draw(); }
  movePointer(event) {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const current = {x: event.clientX, y: event.clientY, startX: previous.startX, startY: previous.startY};
    this.pointers.set(event.pointerId, current);
    if (Math.hypot(current.x - current.startX, current.y - current.startY) > DRAG_SLOP) this.dragged = true;
    const view = {yaw: this.yaw, pitch: this.pitch, fov: this.fov};
    if (this.pointers.size === 1) Object.assign(this, panBy(view, current.x - previous.x, current.y - previous.y));
    else if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) Object.assign(this, pinchBy(view, Math.hypot(current.x - other.x, current.y - other.y) - Math.hypot(previous.x - other.x, previous.y - other.y)));
    }
    this.draw();
  }
  draw() { if (this.renderer && !this.raw) this.renderer.draw({view: {yaw: this.yaw, pitch: this.pitch, fov: this.fov}, source: this.projectionSource(), accent: new Float32Array([.55, .4, .7])}); }
  startDrawing() { cancelAnimationFrame(this.frameRequest); const frame = () => { this.draw(); if (!this.video.paused) this.frameRequest = requestAnimationFrame(frame); }; frame(); }
  configureSeekPreview(sheet) {
    this.seekPreview = sheet;
    this.previewImage.hidden = !sheet;
    if (!sheet) { this.preview.hidden = true; return; }
    this.previewImage.style.width = `${Number(sheet.tileWidth ?? sheet.tile_width)}px`;
    this.previewImage.style.height = `${Number(sheet.tileHeight ?? sheet.tile_height)}px`;
    this.previewImage.style.backgroundImage = `url("${sheet.spriteUrl ?? sheet.sprite_url}")`;
  }
  showPreview(event) {
    const seekRect = this.seek.getBoundingClientRect();
    if (!seekRect.width) return;
    // Against the thumb's travel rather than the whole bar, which is how the
    // input itself reads a click: a preview measured edge to edge would name
    // a moment a little further on than the one the click would seek to.
    const thumb = parseFloat(getComputedStyle(this.seek).getPropertyValue('--range-thumb')) || 0;
    const travel = seekRect.width - thumb;
    if (travel <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - seekRect.left - thumb / 2) / travel));
    const rootRect = this.root.getBoundingClientRect();
    this.previewTime.textContent = formatPlayerTime(ratio * Number(this.video.duration || this.source?.durationSeconds || 0));
    if (this.seekPreview) this.previewImage.style.backgroundPosition = tileBackgroundPosition(this.seekPreview, ratio);
    this.preview.hidden = false;
    const placement = previewPlacement({rootRect, seekRect, ratio, thumb, previewHeight: this.preview.offsetHeight});
    this.preview.style.left = `${placement.left}px`;
    this.preview.style.top = `${placement.top}px`;
  }
  showMessage(message) { this.message.textContent = message; this.message.hidden = false; }
  hideMessage() { this.message.hidden = true; this.message.textContent = ''; }
}
