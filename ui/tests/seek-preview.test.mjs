// Contract for the scrub-preview arithmetic lifted out of detail-metadata.js.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatPlayerTime, previewPlacement, tileAt, tileBackgroundPosition,
} from '../shared/lib/seek-preview.js';

const sheet = {count: 100, columns: 10, tile_width: 160, tile_height: 90};

test('times read as m:ss until an hour, then h:mm:ss', () => {
  assert.equal(formatPlayerTime(0), '0:00');
  assert.equal(formatPlayerTime(5), '0:05');
  assert.equal(formatPlayerTime(245), '4:05');
  assert.equal(formatPlayerTime(3599), '59:59');
  assert.equal(formatPlayerTime(3600), '1:00:00');
  assert.equal(formatPlayerTime(3723), '1:02:03');
});

test('an unknown or live duration reads as zero', () => {
  // A live HLS stream reports Infinity, which must not reach the arithmetic.
  for (const value of [Infinity, -Infinity, NaN, null, undefined, -5]) {
    assert.equal(formatPlayerTime(value), '0:00', String(value));
  }
});

test('a tile is picked by how far along the bar the pointer is', () => {
  assert.deepEqual(tileAt(sheet, 0), {index: 0, column: 0, row: 0, offsetX: 0, offsetY: 0});
  assert.equal(tileAt(sheet, 0.55).index, 55);
  assert.deepEqual(
    {column: tileAt(sheet, 0.55).column, row: tileAt(sheet, 0.55).row}, {column: 5, row: 5});
});

test('the end of the bar lands on the last tile, not past it', () => {
  assert.equal(tileAt(sheet, 1).index, 99);
  assert.equal(tileAt(sheet, 2).index, 99);
});

test('a ratio below zero lands on the first tile', () => {
  assert.equal(tileAt(sheet, -1).index, 0);
});

test('offsets shift the sheet so the tile shows, and read as CSS', () => {
  assert.equal(tileBackgroundPosition(sheet, 0.55), '-800px -450px');
  assert.equal(tileBackgroundPosition(sheet, 0), '0px 0px');
});

test('either naming of the tile size is accepted', () => {
  // The server sends snake_case; a caller may have camelised it already.
  assert.equal(
    tileBackgroundPosition({count: 4, columns: 2, tileWidth: 10, tileHeight: 20}, 0.75),
    tileBackgroundPosition({count: 4, columns: 2, tile_width: 10, tile_height: 20}, 0.75),
  );
});

test('a degenerate sheet does not divide by zero', () => {
  assert.deepEqual(tileAt({count: 0, columns: 0}, 0.5),
    {index: 0, column: 0, row: 0, offsetX: 0, offsetY: 0});
});

test('the preview tracks the pointer and sits above the bar', () => {
  const placement = previewPlacement({
    rootRect: {left: 10, top: 20},
    seekRect: {left: 30, top: 200, width: 400},
    ratio: 0.5,
    previewHeight: 60,
  });
  assert.equal(placement.left, 30 - 10 + 0.5 * 400);
  assert.equal(placement.top, 200 - 20 - 60 - 20);
});

test('the preview follows the thumb, not the whole bar', () => {
  const at = ratio => previewPlacement({
    rootRect: {left: 0, top: 0}, seekRect: {left: 0, top: 100, width: 400},
    ratio, previewHeight: 10, thumb: 14,
  }).left;
  assert.equal(at(0), 7);
  assert.equal(at(0.5), 200);
  assert.equal(at(1), 393);
});

test('the preview stays on the bar at either end', () => {
  const at = ratio => previewPlacement({
    rootRect: {left: 0, top: 0}, seekRect: {left: 0, top: 100, width: 200},
    ratio, previewHeight: 10,
  }).left;
  assert.equal(at(-1), 0);
  assert.equal(at(2), 200);
});
