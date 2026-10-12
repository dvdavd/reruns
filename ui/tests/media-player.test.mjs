import assert from 'node:assert/strict';
import test from 'node:test';

import {LocalMediaProvider, MediaPlayer, bindPosterImage}
  from '../shared/components/MediaPlayer.js';

/** Enough of an <img> to drive the poster binding: src, load state, events. */
function posterImage({src = null, complete = false} = {}) {
  const listeners = {};
  return {
    hidden: false, complete, naturalWidth: complete ? 640 : 0,
    attributes: {...(src === null ? {} : {src})},
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; this.changed?.(); },
    set src(value) { this.attributes.src = value; this.complete = false;
                     this.naturalWidth = 0; this.changed?.(); },
    get src() { return this.attributes.src ?? ''; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    emit(type) {
      if (type === 'load') { this.complete = true; this.naturalWidth = 640; }
      for (const handler of listeners[type] || []) handler();
    },
  };
}

/** Binds the image, wiring the stub's attribute writes to the sync callback. */
function bindStub(image) {
  bindPosterImage(image, {watchSource: sync => { image.changed = sync; }});
  return image;
}

test('the local provider resolves a normalized item without app-specific fields', async () => {
  const item = {
    id: 'video', sourceRef: '/fallback.mp4', durationSeconds: 20,
    thumbnail: {url: '/fallback.jpg'}, watch: {resumeSeconds: 2},
    parts: [{id: 'part', sourceRef: '/archive/video.mp4', durationSeconds: 15,
      thumbnail: {url: '/archive/video.jpg'}, watch: {resumeSeconds: 4}}],
  };
  assert.deepEqual(await new LocalMediaProvider().resolve(item, 0), {
    url: '/archive/video.mp4', type: 'file', durationSeconds: 15,
    resumeSeconds: 4, poster: '/archive/video.jpg', media: null, seekPreview: null,
    encoding: null,
  });
});

test('the shared player has no application API or global-state dependency', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /\/api\/|appState/);
  assert.doesNotMatch(
    source,
    /from\s+['"][^'"]*(?:library-store|detail-metadata)/,
  );
});

test('the player surface supports click playback and double-click fullscreen gestures', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  assert.match(source, /addEventListener\('click'/);
  assert.match(source, /addEventListener\('dblclick'/);
  assert.match(source, /this\.toggleFullscreen\(\)/);
  assert.match(source, /surfaceClickGesture/);
  assert.match(source, /closest\?\.\('\.media-player-controls'\).*surfaceClickGesture/s);
  assert.match(source, /surfaceClickCount = 0/);
  assert.doesNotMatch(source, /event\.detail/);
});

test('playing controls hide after inactivity and return on interaction', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  assert.match(source, /is-controls-hidden/);
  assert.match(source, /'pointermove', 'pointerdown', 'focusin', 'keydown'/);
  assert.match(source, /2200/);
});

test('a touch that wakes a hidden bar does not also pause', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  // Read in the capture phase, before the bubbling listener reveals the bar.
  assert.match(source, /touchWokeControls = event\.pointerType !== 'mouse'[^;]*is-controls-hidden[^;]*controlsAreClickThrough\(\);\s*\}, true\)/s);
  assert.match(source, /controlsAreClickThrough\(\) \{[^}]*pointerEvents === 'none'/s);
  // The click is stopped in the capture phase, before any bar button sees it.
  assert.match(source, /if \(!this\.touchWokeControls\) return;\s*this\.touchWokeControls = false;\s*event\.stopPropagation\(\);[^}]*\}, true\)/s);
  assert.match(source, /!event\.isPrimary \|\| this\.touchWokeControls\) return;/);
});

test('seek previews share the translucent control-bar treatment', async () => {
  const styles = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/player.css', import.meta.url), 'utf8'));
  // The frame sits bare with a hairline ring; only the time pill is translucent.
  assert.doesNotMatch(styles, /media-player-seek-preview-image-shell/);
  assert.match(styles, /\.media-player-seek-preview-image \{[^}]*box-shadow: 0 0 0 1px/);
  assert.match(styles, /media-player-seek-preview-time[^}]*linear-gradient/);
  assert.match(styles, /media-player-seek-preview-time[^}]*backdrop-filter: blur\(12px\)/);
  assert.match(styles, /media-player-seek-preview-time[^}]*font-variant-numeric: tabular-nums/);
});

test('a poster with no picture stays hidden rather than painting a broken image', () => {
  const image = bindStub(posterImage());
  assert.equal(image.hidden, true);
});

test('a poster already showing its picture is left visible', () => {
  const image = bindStub(posterImage({src: '/a.jpg', complete: true}));
  assert.equal(image.hidden, false);
});

test('a new picture hides the old one until the new one has arrived', () => {
  const image = bindStub(posterImage({src: '/a.jpg', complete: true}));
  image.src = '/b.jpg';
  assert.equal(image.hidden, true, 'the previous video\'s thumbnail must not show');
  image.emit('load');
  assert.equal(image.hidden, false);
});

test('a picture that fails to load leaves nothing behind', () => {
  const image = bindStub(posterImage({src: '/a.jpg', complete: true}));
  image.src = '/gone.jpg';
  image.emit('error');
  assert.equal(image.hidden, true);
});

test('clearing the picture hides the poster', () => {
  const image = bindStub(posterImage({src: '/a.jpg', complete: true}));
  image.removeAttribute('src');
  assert.equal(image.hidden, true);
});

test('the player replaces only the picture it set itself', () => {
  const setPoster = (player, url) => MediaPlayer.prototype.setPoster.call(player, url);
  // The host put a card's thumbnail there, so it stays - whether or not the
  // source has a poster of its own to offer.
  const host = {poster: bindStub(posterImage({src: '/card.jpg', complete: true}))};
  setPoster(host, '');
  assert.equal(host.poster.getAttribute('src'), '/card.jpg');
  setPoster(host, '/resolved.jpg');
  assert.equal(host.poster.getAttribute('src'), '/card.jpg');

  // What the player set, the player may clear.
  const owned = {poster: bindStub(posterImage())};
  setPoster(owned, '/a.jpg');
  assert.equal(owned.poster.getAttribute('src'), '/a.jpg');
  setPoster(owned, '');
  assert.equal(owned.poster.getAttribute('src'), null);
});

test('a source without a poster leaves the host\'s own picture alone', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  // The host sets the poster directly for a card it already has a thumbnail
  // for, so load() must not blank it on a source that carries none.
  assert.doesNotMatch(source, /this\.poster\.src = source\.poster \|\| ''/);
  assert.match(source, /setPoster\(source\.poster\)/);
  assert.match(source, /posterSrc/);
});


/** A player stub with just the pieces updateControls and seeking touch. */
function seekPlayer({duration = 100, playhead = 10, type = 'direct', providerSeek = true} = {}) {
  return {
    scrubbing: false,
    time: {textContent: ''},
    seek: {value: '0', style: {properties: {},
      setProperty(name, value) { this.properties[name] = value; }}},
    video: {currentTime: 0, duration},
    source: {type},
    provider: providerSeek ? {seek: async () => ({})} : {},
    totalDuration: () => duration,
    absoluteTime: () => playhead,
    streamSeek: MediaPlayer.prototype.streamSeek,
    // Measuring a readout needs a layout engine; the width is not under test.
    fitTime() {},
    updateControls: MediaPlayer.prototype.updateControls,
  };
}

test('a plain file is seeked by the browser even when the provider can seek streams', () => {
  // A streaming provider seeks its HLS transcodes, but serves mp4 and webm
  // directly: those the video element seeks itself.
  assert.equal(seekPlayer({type: 'direct'}).streamSeek(), false);
  assert.equal(seekPlayer({type: 'file'}).streamSeek(), false);
  assert.equal(seekPlayer({type: 'hls'}).streamSeek(), true);
  assert.equal(seekPlayer({type: 'hls', providerSeek: false}).streamSeek(), false);
});

test('dragging the seek bar is not pulled back to the playhead', () => {
  const player = seekPlayer({duration: 100, playhead: 10});
  player.scrubbing = true;
  player.seek.value = '800';
  // A timeupdate lands mid-drag: the thumb must stay where it was dragged.
  player.updateControls();
  assert.equal(player.seek.value, '800');
  assert.equal(player.time.textContent, '1:20 / 1:40', 'the time follows the drag');
  assert.equal(player.seek.style.properties['--range-progress'], '80%');
});

test('the playhead owns the seek bar again once the drag ends', () => {
  const player = seekPlayer({duration: 100, playhead: 10});
  player.seek.value = '800';
  player.updateControls();
  assert.equal(player.seek.value, '100');
  assert.equal(player.time.textContent, '0:10 / 1:40');
});

test('a video of unknown length parks the seek bar at zero', () => {
  const player = seekPlayer({duration: 0, playhead: 0});
  player.updateControls();
  assert.equal(player.seek.value, '0');
  assert.equal(player.seek.style.properties['--range-progress'], '0%');
});

test('live scrubbing is decided by the source, not by the provider', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /!this\.provider\.seek &&/);
  assert.match(source, /addEventListener\('input'.*!this\.streamSeek\(\)/);
  // The value is read before the drag is declared over, so a timeupdate
  // between the two cannot rewrite what the drag asked for.
  assert.match(source, /const target = Number\(this\.seek\.value\).*this\.scrubbing = false/s);
});

/** Enough of a player for checkDecodable: a video that answers canPlayType. */
function decodePlayer(answer) {
  return {
    loadToken: 1, message: '',
    video: {canPlayType: () => answer},
    root: {classList: new Set()},
    showMessage(message) { this.message = message; },
    showUnplayable: MediaPlayer.prototype.showUnplayable,
    checkDecodable: MediaPlayer.prototype.checkDecodable,
  };
}

async function withCapabilities(decodingInfo, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable: true,
    value: decodingInfo ? {mediaCapabilities: {decodingInfo}} : {}});
  try { await run(); } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

const av1 = {name: 'AV1', contentType: 'video/webm; codecs="av01.0.12M.08"',
  width: 3840, height: 2160, framerate: 25, bitrate: 12000000};

test('an audio-only file is identified from media dimensions', () => {
  const classes = new Set();
  const player = {
    root: {classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    }},
    video: {readyState: 1, videoWidth: 0, videoHeight: 0, paused: true},
  };
  MediaPlayer.prototype.updateMediaKind.call(player);
  assert.ok(classes.has('is-audio-only'));
  let starts = 0;
  player.audioWaveform = {start() { starts++; }};
  player.video.paused = false;
  MediaPlayer.prototype.updateMediaKind.call(player);
  assert.equal(starts, 1, 'metadata arriving after play starts the live waveform');
  player.video.videoWidth = 180;
  player.video.videoHeight = 320;
  MediaPlayer.prototype.updateMediaKind.call(player);
  assert.ok(!classes.has('is-audio-only'));
});

test('a codec the browser disowns is named before play is pressed', async () => {
  await withCapabilities(null, async () => {
    const player = decodePlayer('');
    await player.checkDecodable({encoding: av1}, 1);
    assert.equal(player.message, 'This browser cannot play AV1 video.');
    assert.ok(player.root.classList.has('is-unplayable'), 'the poster stays up');
  });
});

test('a codec the browser only says it may play is put to its decoder', async () => {
  const asked = [];
  await withCapabilities(async config => { asked.push(config); return {supported: false}; }, async () => {
    const player = decodePlayer('maybe');
    await player.checkDecodable({encoding: av1}, 1);
    assert.equal(player.message, 'This browser cannot play AV1 video.');
  });
  const {name, ...video} = av1;
  assert.deepEqual(asked, [{type: 'file', video}]);
});

test('a playable codec, an unjudged one, or an unknown one leaves the player quiet', async () => {
  await withCapabilities(async () => ({supported: true}), async () => {
    const player = decodePlayer('probably');
    await player.checkDecodable({encoding: av1}, 1);
    assert.equal(player.message, '');
  });
  await withCapabilities(async () => { throw new TypeError('bad configuration'); }, async () => {
    const player = decodePlayer('maybe');
    await player.checkDecodable({encoding: {contentType: 'video/webm; codecs="vp9"'}}, 1);
    assert.equal(player.message, '');
  });
  const player = decodePlayer('');
  await player.checkDecodable({encoding: null}, 1);
  assert.equal(player.message, '');
});

test('a verdict on a video already left behind is not shown over the next', async () => {
  await withCapabilities(null, async () => {
    const player = decodePlayer('');
    player.loadToken = 2;
    await player.checkDecodable({encoding: av1}, 1);
    assert.equal(player.message, '');
  });
});

/**
 * A bar that records its listeners, and buttons that count their presses, so
 * the touch handling can be driven event by event.
 */
function touchBar({fullscreen = false, touchActivation = true} = {}) {
  const listeners = {};
  const root = {};
  const bar = {addEventListener(type, handler) { (listeners[type] ||= []).push(handler); }};
  root.querySelector = () => bar;
  const button = {disabled: false, presses: 0, closest(selector) { return selector === 'button' ? this : null; }};
  button.click = () => { button.presses += 1; };
  const other = {...button, presses: 0, closest(selector) { return selector === 'button' ? this : null; }};
  const previous = globalThis.document;
  globalThis.document = {fullscreenElement: fullscreen ? root : null};
  MediaPlayer.prototype.bindTouchActivation.call({root, touchActivation});
  const fire = (type, event) => {
    const e = {type, pointerType: 'touch', isPrimary: true, pointerId: 1, isTrusted: true,
      timeStamp: 0, clientX: 0, clientY: 0, target: button, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...event};
    for (const handler of listeners[type] || []) handler(e);
    return e;
  };
  return {button, other, fire, restore() { globalThis.document = previous; }};
}

test('native taps leave fullscreen touch and click events to the browser', () => {
  const t = touchBar({fullscreen: true, touchActivation: false});
  try {
    t.fire('pointerdown');
    t.fire('pointerup', {timeStamp: 40});
    assert.equal(t.button.presses, 0);
    assert.equal(t.fire('click', {timeStamp: 50}).stopped, false);
    assert.equal(t.fire('contextmenu').prevented, false);
  } finally { t.restore(); }
});

test('a touch presses a bar button on release when the page is not fullscreen', () => {
  const t = touchBar();
  try {
    t.fire('pointerdown');
    assert.equal(t.button.presses, 0);
    t.fire('pointerup', {timeStamp: 40});
    assert.equal(t.button.presses, 1);
    // The browser's own click, when it does come, is not a second press.
    assert.equal(t.fire('click', {timeStamp: 50}).stopped, true);
  } finally { t.restore(); }
});

test('a touch that drifts away is a scroll, not a press', () => {
  const t = touchBar();
  try {
    t.fire('pointerdown', {clientX: 0});
    t.fire('pointerup', {clientX: 40});
    assert.equal(t.button.presses, 0);
  } finally { t.restore(); }
});

test('in fullscreen a touch presses the moment it lands, and the click after it is swallowed', () => {
  const t = touchBar({fullscreen: true});
  try {
    t.fire('pointerdown');
    assert.equal(t.button.presses, 1);
    // pointerup can be held back for a second, and the click with it.
    assert.equal(t.fire('click', {timeStamp: 1500}).stopped, true);
    assert.equal(t.button.presses, 1);
  } finally { t.restore(); }
});

test('a click that arrives without a press of ours is left alone', () => {
  const t = touchBar({fullscreen: true});
  try {
    assert.equal(t.fire('click').stopped, false);
    t.fire('pointerdown');
    t.fire('pointerup', {timeStamp: 80});
    // Long after the release, or on another button, it is somebody else's click.
    assert.equal(t.fire('click', {timeStamp: 5000}).stopped, false);
    t.fire('pointerdown');
    t.fire('pointerup', {timeStamp: 6000});
    assert.equal(t.fire('click', {timeStamp: 6010, target: t.other}).stopped, false);
  } finally { t.restore(); }
});

test('a mouse is left to the browser, and a long press raises no menu over a button', () => {
  const t = touchBar({fullscreen: true});
  try {
    t.fire('pointerdown', {pointerType: 'mouse'});
    assert.equal(t.button.presses, 0);
    t.fire('pointerup', {pointerType: 'mouse'});
    t.fire('pointerdown');
    assert.equal(t.fire('contextmenu').prevented, true);
  } finally { t.restore(); }
});
