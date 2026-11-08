import assert from 'node:assert/strict';
import test from 'node:test';

import {deletionPrompt, deletionVersions, playlistDeletion, survivingFormatId} from '../web/delete-dialog.js';
import {groupFormats, selectFormat, toMediaItem} from '../web/item-adapter.js';

const format = {bytes: bytes => `${bytes} B`};

const copyRaw = (key, extra) => ({
  _key: key,
  _serves: 'media',
  id: 'abc123',
  extractor_key: 'Youtube',
  title: 'A clip',
  ext: 'mp4',
  vcodec: 'avc1',
  filepath: `/archive/${key.replace('.info.json', '.mp4')}`,
  ...extra,
});

test('lists every copy of a video that was downloaded more than once', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.1080p.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.4k.info.json', {width: 3840, height: 2160, filesize: 5000,
                                              ext: 'webm'})),
  ]);
  const versions = deletionVersions(item, format);

  assert.deepEqual(versions.map(version => version.id),
    ['clip.4k.info.json', 'clip.1080p.info.json']);
  assert.deepEqual(versions.map(version => version.label), ['4K', '1080p']);
  assert.deepEqual(versions.map(version => version.detail), ['avc1 · WEBM · 5000 B', 'avc1 · MP4 · 900 B']);
  assert.equal(versions[0].filename, 'clip.4k.mp4');
  assert.match(deletionPrompt(item, versions).note, /on disk 2 times/);
  assert.equal(deletionPrompt(item, versions).title, 'Delete “A clip”?');
});

test('lists the one file of a video downloaded once', () => {
  const item = toMediaItem(copyRaw('clip.info.json', {width: 1280, height: 720, filesize: 40}));
  const versions = deletionVersions(item, format);

  assert.deepEqual(versions, [{
    id: 'clip.info.json', label: '720p', detail: 'avc1 · MP4 · 40 B', filename: 'clip.mp4',
  }]);
  assert.match(deletionPrompt(item, versions).note, /cannot be undone/);
});

test('names a codec it knows as a viewer would', () => {
  const item = toMediaItem(copyRaw('clip.info.json', {vcodec: 'av01.0.12M.08', ext: 'webm'}));
  assert.match(deletionVersions(item, format)[0].detail, /^AV1 · WEBM/);
});

test('names a file that reports no quality at all', () => {
  const item = toMediaItem({_key: 'bare.info.json', _serves: 'media', title: 'Bare'});
  assert.equal(deletionVersions(item, format)[0].label, 'The file');
});

test('deleting the playing copy chooses the next available format', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.720p.info.json', {width: 1280, height: 720, filesize: 300})),
    toMediaItem(copyRaw('clip.1080p.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.4k.info.json', {width: 3840, height: 2160, filesize: 5000})),
  ]);
  const best = 'clip.4k.info.json';
  const next = 'clip.1080p.info.json';
  const last = 'clip.720p.info.json';
  assert.equal(survivingFormatId(item, [best]), next);
  selectFormat(item, next);
  assert.equal(survivingFormatId(item, [best]), next,
    'keep the playing copy when the card representative is deleted');
  assert.equal(survivingFormatId(item, [next]), last);
  assert.equal(survivingFormatId(item, [best, next]), last);
  assert.equal(survivingFormatId(item, [best, next, last]), null);
});

test('a downloaded playlist lists every video, its formats and the total size', () => {
  const [multi] = groupFormats([
    toMediaItem(copyRaw('clip.1080p.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.4k.info.json', {width: 3840, height: 2160, filesize: 5000})),
  ]);
  const single = toMediaItem({...copyRaw('other.info.json', {width: 1280, height: 720, filesize: 40}),
    id: 'zzz', title: 'Another'});
  const plan = playlistDeletion({title: 'Mix', manual: false, items: [multi, single]}, format);

  assert.equal(plan.total, '2 videos · 3 files · 5940 B');
  assert.deepEqual(plan.rows.flatMap(row => row.ids), ['clip.4k.info.json', 'clip.1080p.info.json', 'other.info.json']);
  assert.deepEqual(plan.rows.map(row => row.formats), ['4K, 1080p', '']);
  assert.match(plan.note, /1 video is held in more than one format/);
});

test('a personal playlist says its videos are kept', () => {
  const item = toMediaItem(copyRaw('clip.info.json', {filesize: 40}));
  const plan = playlistDeletion({title: 'Mine', manual: true, items: [item]}, format);
  assert.match(plan.note, /keep every file and remove only the playlist/);
});
