// Feed a remuxed stream to the existing video element. Only the playback
// window lives in memory; cancelling a fetch also closes the server's pipe.
import {mp4Fragments} from './mp4-fragments.js';
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

export function bufferedAt(ranges, time) {
  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= time && ranges.end(index) > time + .1) return ranges.end(index);
  }
  return null;
}

export function evictionBoundary(points, time) {
  return points.filter(point => point <= time - 20).at(-1) || 0;
}

function updated(buffer, action) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      buffer.removeEventListener('updateend', done);
      buffer.removeEventListener('error', fail);
    };
    const done = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('SourceBuffer error')); };
    buffer.addEventListener('updateend', done, {once: true});
    buffer.addEventListener('error', fail, {once: true});
    try { action(); } catch (error) { clean(); reject(error); }
  });
}

export class RemuxPlayback {
  constructor(video, source, onError) {
    this.video = video;
    this.source = source;
    this.onError = onError;
    this.listeners = new AbortController();
    this.media = new MediaSource();
    this.url = URL.createObjectURL(this.media);
    this.pending = Promise.resolve();
    this.target = source.resumeSeconds || 0;
    this.streamFrom = null;
    this.appendedTo = 0;
    this.media.addEventListener('sourceopen', () => {
      if (this.buffer || this.closed) return;
      try {
        this.media.duration = source.durationSeconds;
        this.buffer = this.media.addSourceBuffer(source.remux.mime);
        this.restart(this.target);
      } catch (error) { this.onError(error); }
    }, {signal: this.listeners.signal});
    video.addEventListener('seeking', () => {
      const target = video.currentTime;
      if (!this.buffer || bufferedAt(this.buffer.buffered, target) !== null) return;
      // Dragging the seek bar seeks on every input event. A position the
      // running stream is about to reach waits for it rather than abandoning
      // it, or each step would clear the buffer and start another remux.
      if (this.streamFrom !== null && target >= this.streamFrom
          && target <= Math.max(this.streamFrom, this.target, this.appendedTo) + 8) {
        this.target = target;
        this.awaitingTarget = true;
      } else this.restart(target);
    }, {signal: this.listeners.signal});
    video.src = this.url;
    video.load();
  }

  restart(target) {
    this.target = target;
    this.awaitingTarget = true;
    this.streamFrom = null;
    this.fetchController?.abort();
    const controller = new AbortController();
    this.fetchController = controller;
    // Serialise restarts so a superseded fetch cannot append to the new seek.
    // The pause lets a drag settle, so it costs the server one remux rather
    // than one per pointer step, each still holding a slot until it notices.
    this.pending = this.pending.catch(() => {}).then(async () => {
      if (this.closed || controller.signal.aborted) return;
      await delay(150);
      if (this.closed || controller.signal.aborted) return;
      if (this.media.readyState === 'ended') this.buffer.timestampOffset = 0;
      this.buffer.abort();
      this.buffer.timestampOffset = 0;
      if (this.buffer.buffered.length) {
        await updated(this.buffer, () => this.buffer.remove(0, Infinity));
      }
      this.evictionPoints = [];
      await this.pump(target, controller);
    }).catch(error => {
      if (!this.closed && !controller.signal.aborted) this.onError(error);
    });
  }

  async pump(target, controller) {
    const {signal} = controller;
    const start = Math.max(0, target - 2);
    let response;
    // A 503 means every remux slot is busy, usually with streams this page
    // has just abandoned; the server frees them once it sees the disconnect.
    for (let attempt = 0; ; attempt++) {
      // The track is only named when there is a choice, so a single-track
      // file asks exactly as it always did.
      const {url, audio, audioTracks} = this.source.remux;
      const track = audioTracks?.length && audio !== null && audio !== undefined ? `&audio=${audio}` : '';
      response = await fetch(`${url}?start=${start}${track}`, {signal, cache: 'no-store'});
      if (response.status !== 503 || attempt === 5) break;
      await delay(250 * (attempt + 1));
      signal.throwIfAborted();
    }
    if (!response.ok) throw new Error(`Remux HTTP ${response.status}`);
    const reader = response.body.getReader();
    this.streamFrom = start;
    this.appendedTo = start;
    try {
      for await (const fragment of mp4Fragments(reader, signal)) {
        while (!signal.aborted && (bufferedAt(this.buffer.buffered, this.video.currentTime) || 0)
            - this.video.currentTime > 30) await delay();
        if (signal.aborted) return;
        // Removing into a GOP can discard video through its next keyframe,
        // including frames still needed at the current playback position.
        const boundary = evictionBoundary(this.evictionPoints, this.video.currentTime);
        if (boundary > 0 && this.buffer.buffered.length && this.buffer.buffered.start(0) < boundary) {
          await updated(this.buffer, () => this.buffer.remove(0, boundary));
          this.evictionPoints = this.evictionPoints.filter(point => point > boundary);
        }
        await updated(this.buffer, () => this.buffer.appendBuffer(fragment));
        if (signal.aborted) return;
        const ranges = this.buffer.buffered;
        if (ranges.length) {
          this.appendedTo = ranges.end(ranges.length - 1);
          this.evictionPoints.push(this.appendedTo);
        }
        if (this.awaitingTarget && bufferedAt(ranges, this.target) !== null) {
          this.awaitingTarget = false;
          if (this.video.currentTime < this.target - .25) this.video.currentTime = this.target;
        }
      }
      if (!signal.aborted && this.media.readyState === 'open') this.media.endOfStream();
    } finally {
      if (this.fetchController === controller) this.streamFrom = null;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  close() {
    this.closed = true;
    this.fetchController?.abort();
    this.listeners.abort();
    URL.revokeObjectURL(this.url);
  }
}
