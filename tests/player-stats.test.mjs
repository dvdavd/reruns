import assert from 'node:assert/strict';
import test from 'node:test';
import {bufferAhead, statsRows} from '../web/player-stats.js';

const ranges = (...pairs) => ({length: pairs.length, start: i => pairs[i][0], end: i => pairs[i][1]});

test('buffer health is what runs past the playhead in its own range', () => {
  assert.equal(bufferAhead(ranges([0, 10], [20, 40]), 25), 15);
  assert.equal(bufferAhead(ranges([0, 10]), 15), 0);
  assert.equal(bufferAhead(null, 3), 0);
});

test('the panel names the copy, how it is delivered and what the element is doing', () => {
  const item = {id: 'abc', parts: [{filename: 'a.mkv', sizeBytes: 0, codec: 'vp09.00.40.08',
    encoding: {name: 'VP9', width: 1920, height: 1080, framerate: 30, bitrate: 2_500_000}}],
  archive: {extractor: 'Youtube', sourceId: 'jNQ', formatId: 'abc-2', container: 'mkv', audioCodec: 'opus'}};
  const rows = new Map(statsRows({item,
    source: {durationSeconds: 100, remux: {mime: 'video/mp4; codecs="vp09"'},
      remuxPlayback: {streamFrom: 8, appendedTo: 42, awaitingTarget: false}},
    video: {currentTime: 10, playbackRate: 1.5, videoWidth: 1920, videoHeight: 1080,
      buffered: ranges([8, 42]), readyState: 4, networkState: 2, paused: false, volume: .5,
      quality: {droppedVideoFrames: 3, totalVideoFrames: 300}},
    viewport: {width: 960, height: 540, pixelRatio: 2}}));
  assert.equal(rows.get('Source'), 'Youtube:jNQ');
  assert.equal(rows.get('Library file'), 'abc-2');
  assert.equal(rows.get('Delivery'), 'Remuxed to MP4 (video/mp4; codecs="vp09")');
  assert.equal(rows.get('Encoded'), '1920×1080 · 30 fps · 2.50 Mbps');
  assert.equal(rows.get('Frames'), '3 dropped of 300');
  assert.equal(rows.get('Buffer health'), '32.00s');
  assert.equal(rows.get('State'), 'HAVE_ENOUGH_DATA · LOADING · playing');
  assert.equal(rows.get('Remux stream'), 'from 8.00s · appended to 42.00s');
  assert.equal(rows.get('Viewport'), '960×540 @ 2x');
  assert.equal(rows.has('File size'), false);
});
