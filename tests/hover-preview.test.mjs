import test from 'node:test';
import assert from 'node:assert/strict';
import {previewUrl, ratioAt, thumbStyle} from '../web/hover-preview.js';

test('a card previews the part it shows, falling back to the first', () => {
  const item = {sourceRef: '/media/a', parts: [{sourceRef: '/media/a1'}, {sourceRef: '/media/a2'}]};
  assert.equal(previewUrl(item, 1), '/media/a2');
  assert.equal(previewUrl(item, 5), '/media/a1');
});

test('an item with no file has nothing to preview', () => {
  assert.equal(previewUrl(undefined), '');
  assert.equal(previewUrl({parts: []}), '');
});

test('the pointer maps to a position along the bar, clamped to its ends', () => {
  const rect = {left: 100, width: 200};
  assert.equal(ratioAt(200, rect), .5);
  assert.equal(ratioAt(50, rect), 0);
  assert.equal(ratioAt(900, rect), 1);
  assert.equal(ratioAt(10, {left: 0, width: 0}), 0);
});

test('a thumb shows one tile of the sheet, scaled with the whole sheet', () => {
  const sheet = {tileWidth: 256, tileHeight: 144, columns: 4, count: 8};
  const style = thumbStyle(sheet, .5, .5);
  assert.equal(style.width, '128px');
  assert.equal(style.backgroundSize, '512px 144px');
  assert.equal(style.backgroundPosition, '0px -72px');
});

import {createHoverPreview} from '../web/hover-preview.js';

test('a thumbnail loads its seek sheet and updates a stationary hover', async () => {
  const globals = {document: globalThis.document, window: globalThis.window,
    MutationObserver: globalThis.MutationObserver, fetch: globalThis.fetch};
  const listeners = {};
  const elements = [];
  const node = () => ({
    dataset: {}, style: {}, hidden: true, offsetWidth: 128, events: {},
    classList: {add() {}, remove() {}},
    addEventListener(name, callback) { this.events[name] = callback; },
    setAttribute() {}, removeAttribute() {}, remove() {}, append() {},
    pause() {}, load() {}, play: () => Promise.resolve(),
    getBoundingClientRect: () => ({left: 0, width: 200}),
    children: [{addEventListener() {}, setAttribute() {}}, {addEventListener() {}, setAttribute() {}}],
    querySelector(selector) { return this.nodes[selector] ||= node(); }, nodes: {},
  });
  const card = {dataset: {id: 'seek-sheet-test', partIndex: '0'}, isConnected: true};
  const frame = {querySelector: () => ({after() {}})};
  const area = {closest: () => card, matches: () => true, contains: () => false,
    append() {}, querySelector: selector => selector === '.thumbnail-frame' ? frame : null};
  const target = {closest: selector => selector === '.thumbnail-area' ? area : card};
  let resolveSheet;
  let requests = 0;
  globalThis.fetch = async url => {
    assert.equal(url, '/seek-sheet-test');
    requests += 1;
    return {ok: true, json: () => new Promise(resolve => { resolveSheet = resolve; })};
  };
  globalThis.document = {addEventListener() {}, createElement() {
    const element = node(); elements.push(element); return element;
  }};
  globalThis.window = {addEventListener() {}};
  globalThis.MutationObserver = class { observe() {} };
  let preview;
  try {
    preview = createHoverPreview({
      root: {addEventListener(name, callback) { listeners[name] = callback; }},
      itemFor: () => ({sourceRef: '/media/seek-sheet-test', seekPreviewUrl: '/seek-sheet-test'}),
      delay: 0,
    });
    listeners.pointerover({target, relatedTarget: null});
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(requests, 1);
    const video = elements[0];
    video.duration = 100;
    const bar = elements.find(element => element.className === 'hover-preview-seek');
    const thumb = elements.find(element => element.className === 'hover-preview-seek-thumb');
    const image = thumb.querySelector('.hover-preview-seek-image');
    bar.events.pointerenter({clientX: 100});
    assert.equal(thumb.hidden, false);
    assert.equal(image.hidden, true);
    assert.equal(thumb.querySelector('.hover-preview-seek-time').textContent, '0:50');
    resolveSheet({state: 'ready', spriteUrl: '/sprite.jpg', tileWidth: 256,
      tileHeight: 144, columns: 4, count: 8});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(image.hidden, false);
    assert.equal(image.style.backgroundImage, 'url("/sprite.jpg")');
    assert.equal(image.style.backgroundPosition, '0px -72px');
    bar.events.pointerleave();
    assert.equal(thumb.hidden, true);
  } finally {
    preview?.end();
    Object.assign(globalThis, globals);
  }
});

test('changing a hovered playlist part replaces the playing preview', async () => {
  const globals = {document: globalThis.document, window: globalThis.window,
    MutationObserver: globalThis.MutationObserver};
  const listeners = {};
  const videos = [];
  let observeChanges;
  const node = () => ({
    dataset: {}, style: {}, classList: {add() {}, remove() {}},
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {},
    append() {}, pause() {}, load() {}, play: () => Promise.resolve(),
    querySelector: () => node(), children: [nodeButton(), nodeButton()],
  });
  function nodeButton() { return {addEventListener() {}, setAttribute() {}}; }
  const image = {after(video) { videos.push(video); }};
  const frame = {querySelector: () => image};
  const area = {
    closest: () => card, matches: () => true, contains: target => Boolean(target), append() {},
    querySelector: selector => selector === '.thumbnail-frame' ? frame : null,
  };
  const card = {dataset: {id: 'playlist:p', partId: 'a', partIndex: '0'},
    isConnected: true, matches: () => true};
  const target = {closest: selector => selector === '.thumbnail-area' ? area : card};
  globalThis.document = {addEventListener() {}, createElement: () => node()};
  globalThis.window = {addEventListener() {}};
  globalThis.MutationObserver = class {
    constructor(callback) { observeChanges = callback; }
    observe() {}
  };
  try {
    const preview = createHoverPreview({
      root: {addEventListener(name, callback) { listeners[name] = callback; }},
      itemFor: () => ({sourceRef: `/media/${card.dataset.partId}`}), delay: 0,
    });
    listeners.pointerover({target, relatedTarget: null});
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(videos.length, 1);
    assert.equal(videos[0].src, '/media/a');
    let released = false;
    videos[0].removeAttribute = name => { if (name === 'src') released = true; };
    card.dataset.partId = 'b';
    card.dataset.partIndex = '1';
    observeChanges();
    assert.equal(released, true);
    assert.equal(videos.length, 2);
    assert.equal(videos[1].src, '/media/b');
    observeChanges();
    assert.equal(videos.length, 2);
    card.dataset.partId = 'a';
    card.dataset.partIndex = '0';
    observeChanges();
    assert.equal(videos[2].src, '/media/a');
    preview.end();
  } finally {
    Object.assign(globalThis, globals);
  }
});

import {previewSources} from '../web/hover-preview.js';

test('a preview tries the smallest copy held first, and the card\'s own last', () => {
  const item = {sourceRef: '/media/4k', parts: [{sourceRef: '/media/4k'}], archive: {formats: [
    {sourceRef: '/media/4k', sizeBytes: 900},
    {sourceRef: '/media/audio', sizeBytes: 10, audioOnly: true},
    {sourceRef: '/media/unknown'},
    {sourceRef: '/media/720', sizeBytes: 100},
  ]}};
  assert.deepEqual(previewSources(item), ['/media/720', '/media/4k', '/media/unknown']);
  assert.deepEqual(previewSources({sourceRef: '/media/only'}), ['/media/only']);
  assert.deepEqual(previewSources({parts: []}), []);
});

/** A card with a preview made for it, run until the pointer has rested. */
async function hoverOnce({autoplay, item}) {
  const listeners = {};
  const elements = [];
  const node = () => ({
    dataset: {}, style: {}, events: {}, classList: {names: new Set(),
      add(name) { this.names.add(name); }, remove(name) { this.names.delete(name); }},
    attributes: {},
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute() {}, remove() {}, append() {}, after() {},
    pause() {}, load() {}, plays: 0, play() { this.plays += 1; return Promise.resolve(); },
    getBoundingClientRect: () => ({left: 0, width: 200}),
    querySelector(selector) { return this.nodes[selector] ||= node(); }, nodes: {},
  });
  const buttons = [node(), node()];
  const card = {dataset: {id: 'paused-test', partIndex: '0'}, isConnected: true};
  const frame = {querySelector: () => ({after() {}})};
  const appended = [];
  const area = {closest: () => card, matches: () => true, contains: () => false,
    append: element => appended.push(element), querySelector: selector =>
      selector === '.thumbnail-frame' ? frame : null};
  globalThis.document = {addEventListener() {}, createElement() {
    const element = node();
    if (elements.length === 1) element.children = buttons;
    elements.push(element);
    return element;
  }};
  globalThis.window = {addEventListener() {}};
  globalThis.MutationObserver = class { observe() {} };
  const preview = createHoverPreview({
    root: {addEventListener(name, callback) { listeners[name] = callback; }},
    itemFor: () => item, delay: 0, autoplay: () => autoplay,
  });
  listeners.pointerover({target: {closest: selector => selector === '.thumbnail-area' ? area : card},
    relatedTarget: null});
  await new Promise(resolve => setTimeout(resolve, 5));
  return {preview, video: elements[0], controls: elements[1], play: buttons[0], appended};
}

test('with autoplay off, a preview fetches nothing until its play button is pressed', async () => {
  const globals = {document: globalThis.document, window: globalThis.window,
    MutationObserver: globalThis.MutationObserver, fetch: globalThis.fetch};
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return {ok: false}; };
  let preview;
  try {
    const hovered = await hoverOnce({autoplay: false,
      item: {sourceRef: '/media/a', seekPreviewUrl: '/sheet'}});
    preview = hovered.preview;
    const {video, controls, play, appended} = hovered;
    assert.equal(video.src, undefined);
    assert.equal(video.preload, 'none');
    assert.equal(video.plays, 0);
    assert.equal(fetched, 0);
    assert.ok(controls.classList.names.has('is-paused'));
    // Only the buttons are up; the seek bar waits for the video.
    assert.deepEqual(appended, [controls]);
    for (const click of play.events.click) click({preventDefault() {}, stopPropagation() {}});
    assert.equal(video.src, '/media/a');
    assert.equal(video.plays, 1);
    assert.equal(fetched, 1);
    assert.equal(appended.length, 2);
  } finally {
    preview?.end();
    Object.assign(globalThis, globals);
  }
});

test('a copy the browser cannot play gives way to the next', async () => {
  const globals = {document: globalThis.document, window: globalThis.window,
    MutationObserver: globalThis.MutationObserver};
  let preview;
  try {
    const hovered = await hoverOnce({autoplay: true, item: {sourceRef: '/media/big',
      parts: [{sourceRef: '/media/big'}],
      archive: {formats: [{sourceRef: '/media/big', sizeBytes: 9}, {sourceRef: '/media/small', sizeBytes: 1}]}}});
    preview = hovered.preview;
    const {video} = hovered;
    assert.equal(video.src, '/media/small');
    for (const fail of video.events.error) fail();
    assert.equal(video.src, '/media/big');
    assert.equal(video.plays, 2);
  } finally {
    preview?.end();
    Object.assign(globalThis, globals);
  }
});
