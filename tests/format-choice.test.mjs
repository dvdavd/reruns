import assert from 'node:assert/strict';
import test from 'node:test';

import {createFormatChooser, PREFERRED_CODEC_KEY} from '../web/format-choice.js';
import {groupFormats, selectFormat, toMediaItem} from '../web/item-adapter.js';

const copy = (key, extra) => toMediaItem({_key: key, _serves: 'media', id: 'abc123',
  extractor_key: 'Youtube', title: 'A clip', ...extra});

// 4K AV1 is ranked first; a VP9 and an H.264 copy are held as well.
const video = () => groupFormats([
  copy('clip.av1.info.json', {width: 3840, height: 2160, filesize: 5000, ext: 'mp4', vcodec: 'av01.0.12M.08'}),
  copy('clip.vp9.info.json', {width: 1920, height: 1080, filesize: 900, ext: 'webm', vcodec: 'vp09.00.40.08'}),
  copy('clip.h264.info.json', {width: 1280, height: 720, filesize: 700, ext: 'mkv', vcodec: 'avc1.64001F'}),
  copy('clip.m4a.info.json', {vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', filesize: 50}),
])[0];

function memoryStore(values = {}) {
  const map = new Map(Object.entries(values));
  return {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map};
}

/** A browser that decodes everything but the codecs it is told to refuse. */
const refusing = (...codecs) => ({
  canPlayType: () => 'probably',
  decodingInfo: async ({video: {contentType}}) => ({supported: !codecs.some(codec => contentType.includes(codec))}),
});

test('plays the best copy when this browser decodes it', async () => {
  const chooser = createFormatChooser({probe: refusing(), store: memoryStore()});
  assert.equal(await chooser.choose(video()), 'clip.av1.info.json');
});

test('passes over a copy the browser cannot decode for the next best that it can', async () => {
  const chooser = createFormatChooser({probe: refusing('av01'), store: memoryStore()});
  const item = video();
  assert.equal(await chooser.choose(item), 'clip.vp9.info.json');
  assert.ok(chooser.refused(item.archive.formats[0]), 'the chooser can dim the AV1 copy');
  assert.ok(!chooser.refused(item.archive.formats[1]));
});

test('asks about an MKV by its codec', async () => {
  const chooser = createFormatChooser({probe: refusing('av01', 'vp09'), store: memoryStore()});
  assert.equal(await chooser.choose(video()), 'clip.h264.info.json');
});

test('keeps the current copy when nothing with a picture will play, rather than the sound alone', async () => {
  const chooser = createFormatChooser({probe: refusing('av01', 'vp09', 'avc1'), store: memoryStore()});
  assert.equal(await chooser.choose(video()), 'clip.av1.info.json');
});

test('a browser that cannot judge is taken at its word that it might', async () => {
  const chooser = createFormatChooser({probe: {canPlayType: () => 'maybe', decodingInfo: async () => { throw new Error('no'); }},
    store: memoryStore()});
  assert.equal(await chooser.choose(video()), 'clip.av1.info.json');
});

test('a copy picked by hand stands, and its codec is preferred on this device after', async () => {
  const store = memoryStore();
  const chooser = createFormatChooser({probe: refusing(), store});
  const item = video();
  selectFormat(item, 'clip.h264.info.json');
  chooser.remember(item, item.archive.formats.find(format => format.id === 'clip.h264.info.json'));
  assert.equal(store.map.get(PREFERRED_CODEC_KEY), 'H.264');
  assert.equal(await chooser.choose(item), 'clip.h264.info.json');
  // Another video, or the next session, starts from the preferred codec.
  const fresh = createFormatChooser({probe: refusing(), store});
  assert.equal(await fresh.choose(video()), 'clip.h264.info.json');
  // Unless this device cannot decode it.
  const refused = createFormatChooser({probe: refusing('avc1'), store});
  assert.equal(await refused.choose(video()), 'clip.av1.info.json');
});

test('asks the browser once per encoding', async () => {
  let asked = 0;
  const chooser = createFormatChooser({store: memoryStore(), probe: {canPlayType: () => 'probably',
    decodingInfo: async () => { asked += 1; return {supported: true}; }}});
  await chooser.choose(video());
  await chooser.choose(video());
  assert.equal(asked, 3);
});

test('suggests a codec to fetch that is neither refused nor already held and refused', async () => {
  const chooser = createFormatChooser({probe: refusing('av01', 'vp09'), store: memoryStore()});
  const item = video();
  item.archive.formats = item.archive.formats.filter(format => format.id !== 'clip.h264.info.json');
  assert.deepEqual(await chooser.suggest(item), {codec: 'h264', name: 'H.264'});
  const none = createFormatChooser({probe: refusing('av01', 'vp09', 'avc1'), store: memoryStore()});
  assert.equal(await none.suggest(video()), null);
});
