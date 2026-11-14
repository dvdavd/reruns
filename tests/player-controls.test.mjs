import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlaybackSpeed} from '../web/player-speed.js';
import {createTrackControls} from '../web/player-tracks.js';

class Element extends EventTarget {
  constructor() {
    super();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.style = {setProperty() {}};
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  querySelector() { return new Element(); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set innerHTML(value) { this.children = [new Element(), new Element(), new Element()]; }
}

function environment(t, initial = {}) {
  const values = new Map(Object.entries(initial));
  t.mock.method(globalThis, 'fetch', async () => ({ok: false, text: async () => ''}));
  const install = (key, value) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, value});
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  };
  install('localStorage', {getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)});
  install('document', {createElement: () => new Element()});
  install('window', new EventTarget());
  install('navigator', {userAgent: 'Test', languages: ['en-GB']});
  return values;
}

function pointer(type, properties = {}) {
  return Object.assign(new Event(type), {pointerId: 1, pointerType: 'mouse', button: 0,
    isPrimary: true, clientX: 0, clientY: 0, ...properties});
}

test('a hold restores the selected speed without changing its saved preference', t => {
  const values = environment(t, {'archive-playback-speed': '1.5'});
  t.mock.timers.enable({apis: ['setTimeout']});
  const element = new Element();
  element.closest = () => null;
  const video = new Element();
  video.paused = false;
  video.playbackRate = 1;
  const controls = createPlaybackSpeed({element, mediaPlayer: {video, root: element},
    speedSummary: new Element(), speedSteps: []});
  controls.applySavedRate();
  assert.equal(video.playbackRate, 1.5);
  element.dispatchEvent(pointer('pointerdown'));
  t.mock.timers.tick(350);
  assert.equal(video.playbackRate, 2);
  window.dispatchEvent(pointer('pointerup'));
  assert.equal(video.playbackRate, 1.5);
  assert.equal(values.get('archive-playback-speed'), '1.5');
  video.playbackRate = 1;
  controls.applySavedRate();
  assert.equal(video.playbackRate, 1.5);
});

test('a touch that wakes hidden controls never arms a speed hold', t => {
  environment(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  const element = new Element();
  element.classList.add('is-controls-hidden');
  const video = new Element();
  video.paused = false;
  video.playbackRate = 1;
  createPlaybackSpeed({element, mediaPlayer: {video, root: element},
    speedSummary: new Element(), speedSteps: []});
  element.dispatchEvent(pointer('pointerdown', {pointerType: 'touch'}));
  t.mock.timers.tick(400);
  assert.equal(video.playbackRate, 1);
});

test('caption language follows regional variants and disabling captions redraws the cue', t => {
  const values = environment(t, {'archive-subtitle-language': 'en-GB'});
  const video = new Element();
  video.textTracks = [{language: 'en-US'}, {language: 'fr'}];
  let redraws = 0;
  video.addEventListener('archive-subtitles-change', () => redraws++);
  const subtitleToggle = new Element();
  const subtitleSwitch = new Element();
  const subtitleSummary = new Element();
  const controls = createTrackControls({mediaPlayer: {video},
    getActiveItem: () => ({parts: [{subtitleTracks: [{language: 'en-US', label: 'English'}]}]}),
    subtitleList: new Element(), subtitleSummary, subtitleToggle, subtitleSwitch,
    subtitleEmpty: new Element(), subtitleDownloadOffers: new Element(), subtitleDownloads: new Element()});
  controls.applySubtitles();
  assert.deepEqual(video.textTracks.map(track => track.mode), ['hidden', 'disabled']);
  subtitleToggle.dispatchEvent(new Event('click'));
  assert.deepEqual(video.textTracks.map(track => track.mode), ['disabled', 'disabled']);
  assert.equal(values.has('archive-subtitle-language'), false);
  assert.equal(redraws, 2);
  // The menu's switch says the same as the bar's button, and turns the
  // language back on that was last chosen.
  assert.equal(subtitleSwitch.attributes.get('aria-checked'), 'false');
  assert.equal(subtitleSummary.textContent, '');
  subtitleSwitch.dispatchEvent(new Event('click'));
  assert.deepEqual(video.textTracks.map(track => track.mode), ['hidden', 'disabled']);
  assert.equal(subtitleSwitch.attributes.get('aria-checked'), 'true');
  assert.equal(subtitleSummary.textContent, 'English');
  assert.equal(values.get('archive-subtitle-language'), 'en-US');
});

test('the speed row steps through every rate, stops at the ends, and its figure goes back to normal', t => {
  const values = environment(t, {'archive-playback-speed': '0.5'});
  const element = new Element();
  const video = new Element();
  const slower = Object.assign(new Element(), {dataset: {speedStep: '-1'}});
  const faster = Object.assign(new Element(), {dataset: {speedStep: '1'}});
  const speedSummary = new Element();
  createPlaybackSpeed({element, mediaPlayer: {video, root: element},
    speedSummary, speedSteps: [slower, faster]});
  assert.equal(slower.disabled, false);
  slower.dispatchEvent(new Event('click'));
  assert.equal(video.playbackRate, 0.25);
  assert.equal(slower.disabled, true);
  slower.dispatchEvent(new Event('click'));
  assert.equal(video.playbackRate, 0.25);
  faster.dispatchEvent(new Event('click'));
  faster.dispatchEvent(new Event('click'));
  assert.equal(video.playbackRate, 0.75);
  assert.equal(speedSummary.textContent, '0.75x');
  speedSummary.dispatchEvent(new Event('click'));
  assert.equal(video.playbackRate, 1);
  assert.equal(values.get('archive-playback-speed'), '1');
});

test('dragging the speed figure turns it like a dial, and the drag\'s click keeps the speed', t => {
  environment(t);
  const element = new Element();
  const video = new Element();
  const speedSummary = new Element();
  createPlaybackSpeed({element, mediaPlayer: {video, root: element}, speedSummary, speedSteps: []});
  speedSummary.dispatchEvent(pointer('pointerdown', {clientX: 100}));
  speedSummary.dispatchEvent(pointer('pointermove', {clientX: 102}));
  assert.equal(video.playbackRate, undefined, 'a press that has hardly moved is still a click');
  speedSummary.dispatchEvent(pointer('pointermove', {clientX: 136}));
  assert.equal(video.playbackRate, 1.5);
  speedSummary.dispatchEvent(pointer('pointermove', {clientX: 1000}));
  assert.equal(video.playbackRate, 8);
  speedSummary.dispatchEvent(pointer('pointermove', {clientX: 82}));
  assert.equal(video.playbackRate, 0.75);
  speedSummary.dispatchEvent(pointer('pointerup', {clientX: 82}));
  speedSummary.dispatchEvent(new Event('click'));
  assert.equal(video.playbackRate, 0.75);
  speedSummary.dispatchEvent(new Event('click'));
  assert.equal(video.playbackRate, 1);
});
