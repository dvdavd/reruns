// Contract tests for the shared library-item shape. Run with
// `node --test tests/shared/` or through tests/test_shared_js.py.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayLabel, formatBytes, formatDuration, partAt, sessionOf, viewOf,
} from '../shared/lib/item.js';

// These expectations mirror config.py's format_bytes and library.py's
// format_duration exactly; the card must render identically after the port.
test('formatBytes matches the server formatter', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(11274289152), '10.5 GB');
});

test('formatDuration matches the server formatter', () => {
  assert.equal(formatDuration(null), 'Unknown');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(59), '0:59');
  assert.equal(formatDuration(61), '1:01');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(7325.6), '2:02:06');
});

const item = (overrides = {}) => ({
  id: '/library/a.mp4',
  sourceRef: '/library/a.mp4',
  title: 'Beach Day',
  filename: 'a.mp4',
  parts: [{id: '/library/a.mp4', sourceRef: '/library/a.mp4', title: '', filename: 'a.mp4'}],
  facets: {},
  ...overrides,
});

test('displayLabel falls back to the filename when untitled', () => {
  assert.equal(displayLabel(item({title: ''})), 'a.mp4');
  assert.equal(displayLabel(item({title: '   '})), 'a.mp4');
  assert.equal(displayLabel(item()), 'Beach Day');
});

test('a part title is appended as the former subtitle was', () => {
  const multipart = item({
    parts: [
      {id: 'p1', sourceRef: 'p1', title: 'Arrival', filename: 'a1.mp4', label: 'A'},
      {id: 'p2', sourceRef: 'p2', title: 'Departure', filename: 'a2.mp4', label: 'B'},
    ],
  });
  assert.equal(displayLabel(multipart, 0), 'Beach Day: Arrival');
  assert.equal(displayLabel(multipart, 1), 'Beach Day: Departure');
});

test('partAt wraps in both directions', () => {
  const multipart = item({
    parts: [{id: 'p1', title: 'One'}, {id: 'p2', title: 'Two'}, {id: 'p3', title: 'Three'}],
  });
  assert.equal(partAt(multipart, 3).id, 'p1');
  assert.equal(partAt(multipart, -1).id, 'p3');
  assert.equal(partAt(multipart, -4).id, 'p3');
});

test('a single-part item reports no part navigation', () => {
  const view = viewOf(item());
  assert.equal(view.partCount, 1);
  assert.equal(view.partIndex, 0);
});

// This is what changeCardPart used to do by writing back onto the dataset.
test('the active part overrides the item it belongs to', () => {
  const multipart = item({
    resolution: '1920x1080',
    codec: 'h264',
    parts: [
      {id: 'p1', sourceRef: 'p1', filename: 'a1.mp4', resolution: '1920x1080', codec: 'h264'},
      {id: 'p2', sourceRef: 'p2', filename: 'a2.mp4', resolution: '3840x2160', codec: 'hevc',
       remastered: true, watch: {count: 4}},
    ],
  });
  const view = viewOf(multipart, 1);
  assert.equal(view.sourceRef, 'p2');
  assert.equal(view.filename, 'a2.mp4');
  assert.equal(view.resolution, '3840x2160');
  assert.equal(view.codec, 'hevc');
  assert.equal(view.remastered, true);
  assert.equal(view.watch.count, 4);
});

test('favourite stays an item-level flag, not a per-part one', () => {
  const multipart = item({
    favourite: true,
    parts: [{id: 'p1', favourite: false}, {id: 'p2', favourite: false}],
  });
  assert.equal(viewOf(multipart, 1).favourite, true);
});

test('an expired session is not active', () => {
  const now = 1_000_000;
  const live = sessionOf({session: {active: true, progress: 40, expiresAt: now + 1000}}, now);
  const stale = sessionOf({session: {active: true, progress: 40, expiresAt: now - 1000}}, now);
  assert.equal(live.active, true);
  assert.equal(stale.active, false);
});

test('session progress is clamped to a percentage', () => {
  assert.equal(sessionOf({session: {progress: 140}}).progress, 100);
  assert.equal(sessionOf({session: {progress: -20}}).progress, 0);
});

test('missing optional fields degrade to safe defaults', () => {
  const view = viewOf({id: 'x', parts: []});
  assert.equal(view.codec, 'Unknown');
  assert.equal(view.watch.count, 0);
  assert.equal(view.session.active, false);
  assert.equal(view.partCount, 0);
});
