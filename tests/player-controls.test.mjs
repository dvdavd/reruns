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
    speedSlider: new Element(), speedValue: new Element(), speedPresets: new Element(), speedSummary: new Element()});
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
    speedSlider: new Element(), speedValue: new Element(), speedPresets: new Element(), speedSummary: new Element()});
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
  const controls = createTrackControls({mediaPlayer: {video},
    getActiveItem: () => ({parts: [{subtitleTracks: [{language: 'en-US', label: 'English'}]}]}),
    subtitleList: new Element(), subtitleSummary: new Element(), subtitleToggle,
    subtitleEmpty: new Element(), subtitleDownloadOffers: new Element(), subtitleDownloads: new Element()});
  controls.applySubtitles();
  assert.deepEqual(video.textTracks.map(track => track.mode), ['hidden', 'disabled']);
  subtitleToggle.dispatchEvent(new Event('click'));
  assert.deepEqual(video.textTracks.map(track => track.mode), ['disabled', 'disabled']);
  assert.equal(values.has('archive-subtitle-language'), false);
  assert.equal(redraws, 2);
});
