import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeekPreview} from '../web/seek-preview.js';

test('a mini seek bubble positions against its parent and refreshes the current sheet', () => {
  const originalDocument = globalThis.document;
  const image = {style: {}, hidden: true};
  const time = {};
  const bubble = {style: {}, offsetWidth: 128,
    querySelector: selector => selector.endsWith('image') ? image : time};
  const events = {};
  const seek = {getBoundingClientRect: () => ({left: 120, top: 180, width: 200}),
    addEventListener(name, callback) { events[name] = callback; }};
  const container = {append(element) { assert.equal(element, bubble); },
    getBoundingClientRect: () => ({left: 100, bottom: 200})};
  let sheet = {sprite_url: '/one.jpg', tile_width: 256, tile_height: 144,
    columns: 4, count: 8};
  let dragging = false;
  let moved;
  globalThis.document = {createElement: () => bubble};
  try {
    const preview = createSeekPreview({seek, container, getDuration: () => 100,
      getSheet: () => sheet, gap: 4, className: 'archive-mini-seek-preview',
      keepVisible: () => dragging, onMove: ratio => { moved = ratio; }});
    events.pointerenter({clientX: 120});
    assert.equal(bubble.style.left, '84px');
    assert.equal(bubble.style.bottom, '24px');
    assert.equal(time.textContent, '0:00');
    assert.equal(image.style.backgroundImage, 'url("/one.jpg")');
    events.pointermove({clientX: 320});
    assert.equal(moved, 1);
    assert.equal(bubble.style.left, '156px');
    assert.equal(time.textContent, '1:40');
    dragging = true;
    events.pointerleave();
    assert.equal(bubble.hidden, false);
    sheet = null;
    preview.refresh();
    assert.equal(image.hidden, true);
    events.pointercancel();
    assert.equal(bubble.hidden, true);
    sheet = {spriteUrl: '/two.jpg', tileWidth: 256, tileHeight: 144, count: 1};
    preview.refresh();
    assert.equal(bubble.hidden, true, 'loading a sheet must not reopen a hidden bubble');
    events.pointerenter({clientX: 220});
    assert.equal(image.hidden, false);
    assert.equal(image.style.backgroundImage, 'url("/two.jpg")');
    dragging = false;
    events.pointerleave();
    assert.equal(bubble.hidden, true);
  } finally {
    globalThis.document = originalDocument;
  }
});
