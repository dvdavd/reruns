const BAR_MIN = 3;
const BAR_RANGE = 21;

/** A small live waveform from the media element's PCM samples. The source
 * stays connected to the output for the element's lifetime: disconnecting a
 * MediaElementAudioSourceNode does not hand audio back to the video element.
 *
 * Other bars elsewhere on the page (a tracklist's playing row) can follow
 * the same analyser with `follow`, since an element can be routed through
 * Web Audio only once. A followed container is marked `data-live` while its
 * bars are being driven, so its own idle animation can stand down; without a
 * live signal (cross-origin, reduced motion) it never is. */
export class AudioWaveform {
  constructor(video, bars, isActive, {
    Context = globalThis.AudioContext || globalThis.webkitAudioContext,
    requestFrame = callback => requestAnimationFrame(callback),
    cancelFrame = id => cancelAnimationFrame(id),
    origin = globalThis.location?.origin,
  } = {}) {
    this.video = video;
    this.bars = bars;
    this.isActive = isActive;
    this.Context = Context;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.origin = origin;
    this.levels = bars.map(() => BAR_MIN);
    this.followers = new Map();
    this.frame = null;
  }

  /** Drives the children of `container` as bars too, between `min` and `max`
   *  pixels tall, for as long as something plays; returns the way to stop.
   *  `gain` lifts a few small bars, which read as still at the player's own
   *  sensitivity. */
  follow(container, {min = BAR_MIN, max = BAR_MIN + BAR_RANGE, gain = 1} = {}) {
    const bars = [...container.children];
    this.followers.set(container, {bars, levels: bars.map(() => min), min, range: max - min, gain});
    if (!this.video.paused) this.start();
    return () => {
      this.followers.delete(container);
      this.release(container);
    };
  }

  /** Hands a followed container back to its own styling. */
  release(container) {
    delete container.dataset.live;
    for (const bar of container.children) bar.style.height = '';
  }

  /** The player's own bars run only while it shows them; followers want the
   *  signal whatever the player is showing. */
  wanted() {
    return this.isActive() || this.followers.size > 0;
  }

  sameOrigin() {
    if (!this.origin) return true;
    const src = this.video.currentSrc || this.video.src;
    if (!src) return false;
    try { return new URL(src, globalThis.location?.href || `${this.origin}/`).origin === this.origin; }
    catch { return false; }
  }

  start() {
    // Connecting a cross-origin media element to Web Audio can silence it.
    if (!this.Context || !this.wanted() || !this.sameOrigin()
        || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return Promise.resolve();
    }
    if (!this.starting) {
      this.starting = this.prepare().catch(() => {}).finally(() => { this.starting = null; });
    }
    return this.starting.then(() => this.paint());
  }

  async prepare() {
    this.context ||= new this.Context();
    if (this.context.state !== 'running') await this.context.resume();
    if (this.context.state !== 'running' || !this.wanted()) return;
    if (!this.source) {
      this.source = this.context.createMediaElementSource(this.video);
      this.source.connect(this.context.destination);
    }
    if (!this.analyser) {
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.source.connect(this.analyser);
      this.samples = new Uint8Array(this.analyser.fftSize);
    }
  }

  /** Future videos use the same media element and therefore the same output
   * route, even when they have a picture and no waveform. */
  resumeOutput() {
    if (this.context?.state !== 'running') this.context?.resume().catch(() => {});
  }

  paint() {
    if (this.frame !== null || !this.analyser || this.video.paused || !this.wanted()
        || this.context.state !== 'running') return;
    this.analyser.getByteTimeDomainData(this.samples);
    const muted = this.video.muted || this.video.volume === 0;
    if (this.isActive()) {
      this.draw({bars: this.bars, levels: this.levels, min: BAR_MIN, range: BAR_RANGE}, muted);
    }
    for (const [container, group] of this.followers) {
      container.dataset.live = '';
      this.draw(group, muted);
    }
    this.frame = this.requestFrame(() => { this.frame = null; this.paint(); });
  }

  /** One set of bars, each the mean loudness of its share of the samples,
   *  eased towards so they move rather than flicker. */
  draw({bars, levels, min, range, gain = 1}, muted) {
    for (let index = 0; index < bars.length; index++) {
      const start = Math.floor(index * this.samples.length / bars.length);
      const end = Math.floor((index + 1) * this.samples.length / bars.length);
      let amplitude = 0;
      for (let sample = start; sample < end; sample++) {
        amplitude += Math.abs(this.samples[sample] - 128);
      }
      const target = muted ? min : min + range * Math.min(1, gain * amplitude / Math.max(1, end - start) / 75);
      const level = levels[index] + (target - levels[index]) * .4;
      levels[index] = level;
      bars[index].style.height = `${level.toFixed(1)}px`;
    }
  }

  pause() {
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
  }

  reset() {
    this.pause();
    this.levels.fill(BAR_MIN);
    for (const bar of this.bars) bar.style.height = `${BAR_MIN}px`;
    for (const [container, group] of this.followers) {
      group.levels.fill(group.min);
      this.release(container);
    }
  }
}
