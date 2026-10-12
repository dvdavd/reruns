import assert from 'node:assert/strict';
import test from 'node:test';

import {applyViewParam, displayedView, viewFromParams} from '../web/views.js';
import {playlistsFrom} from '../web/playlists.js';
import {collectionItem} from '../web/playlist-grid.js';

test('the view comes from the URL, and home is the bare address', () => {
  assert.equal(viewFromParams(new URLSearchParams('')), 'home');
  assert.equal(viewFromParams(new URLSearchParams('view=playlists')), 'playlists');
  assert.equal(viewFromParams(new URLSearchParams('view=nonsense')), 'home');
  const url = new URL('http://x/?view=channels&q=a');
  assert.equal(applyViewParam(url, 'home').search, '?q=a');
  assert.equal(applyViewParam(url, 'videos').searchParams.get('view'), 'videos');
});

test('a chip filter always shows videos; a search only leaves home', () => {
  const facet = {kind: 'channel', id: 'UC1'};
  assert.equal(displayedView('channels', {facet}), 'videos');
  assert.equal(displayedView('home', {query: 'cats'}), 'videos');
  assert.equal(displayedView('playlists', {query: 'cats'}), 'playlists');
  assert.equal(displayedView('home'), 'home');
});

const entry = (id, playlist, index, mtime) => ({
  id, title: `Video ${id}`, mtime, thumbnail: {url: `/thumb/${id}`},
  facets: {owner: {id: 'UC1', name: 'Blender'}},
  archive: {playlist: {id: playlist, title: `List ${playlist}`, index, count: 5}},
});

test('playlists group their videos in order, newest playlist first', () => {
  const playlists = playlistsFrom([
    entry('a2', 'A', 2, 10), entry('a1', 'A', 1, 20),
    entry('b1', 'B', 1, 50), {id: 'loose', archive: {playlist: null}},
  ]);
  assert.deepEqual(playlists.map(p => p.id), ['B', 'A']);
  assert.deepEqual(playlists[1].items.map(item => item.id), ['a1', 'a2']);
  assert.equal(playlists[1].count, 5);
  assert.equal(playlists[1].owner.name, 'Blender');
});

test('a collection is one card item whose parts are its videos', () => {
  const item = collectionItem([entry('a1', 'A', 1, 1), entry('a2', 'A', 2, 1)],
    {id: 'playlist:A', label: 'List A', chip: '2 of 5', collection: {id: 'A', name: 'List A'}});
  assert.equal(item.parts.length, 2);
  assert.deepEqual(item.parts.map(part => part.thumbnail.url), ['/thumb/a1', '/thumb/a2']);
  assert.equal(item.parts[1].label, '2');
  assert.equal(item.quality, '2 of 5');
  assert.deepEqual(item.facets.collections, [{id: 'A', name: 'List A'}]);
});

test('the playlists view narrows by channel; a playlist chip still shows videos', () => {
  assert.equal(displayedView('playlists', {facet: {kind: 'channel', id: 'UC1'}}), 'playlists');
  assert.equal(displayedView('playlists', {facet: {kind: 'playlist', id: 'PL1'}}), 'videos');
  assert.equal(displayedView('home', {facet: {kind: 'channel', id: 'UC1'}}), 'videos');
});

test('a channel profile sums what the archive holds for it', async () => {
  const {channelStats, formatRuntime} = await import('../web/channel-profile.js');
  assert.equal(formatRuntime(59 * 60), '59 min');
  assert.equal(formatRuntime(2 * 3600), '2 h');
  assert.equal(formatRuntime(3 * 3600 + 25 * 60), '3 h 25 min');
  const stats = channelStats([
    {durationSeconds: 3600, sizeBytes: 1024 ** 3, favourite: true, archive: {uploadedAt: 0}},
    {durationSeconds: 1800, sizeBytes: 0, favourite: false, archive: {uploadedAt: 0}},
  ], [{id: 'PL1'}]);
  assert.deepEqual(stats, ['2 videos', '1 playlist', '1 h 30 min', '1.0 GB', '1 favourite']);
});
