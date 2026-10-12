import assert from 'node:assert/strict';
import test from 'node:test';
import {applyPlaylists, toMediaItem, toPlaylist} from '../web/item-adapter.js';
import {createPlaylistCollapser, markPlaylistDirection, playlistsFrom} from '../web/playlists.js';

const video = (id, playlist, index, count) => toMediaItem({
  id, extractor_key: 'Youtube', title: id, _key: id, _media_url: '/media/' + id,
  ...(playlist ? {playlist_id: playlist, playlist_title: playlist, playlist_index: index, playlist_count: count} : {}),
});
const ids = list => list.map(item => item.id);

test('a whole playlist folds into one entry where its first video was', () => {
  const items = [video('loose', null), video('track2', 'ALBUM', 2, 3), video('track1', 'ALBUM', 1, 3),
    video('other', null), video('track3', 'ALBUM', 3, 3)];
  const collapse = createPlaylistCollapser();
  const shown = collapse(items, playlistsFrom(markPlaylistDirection(items)));
  assert.deepEqual(ids(shown), ['loose', 'playlist:ALBUM', 'other']);
  assert.deepEqual(ids(shown[1].playlist.items), ['track1', 'track2', 'track3']);
});

test('part of a playlist, a playlist of one, and a personal playlist stay as videos', () => {
  const items = [video('a1', 'PART', 1, 5), video('a2', 'PART', 2, 5), video('solo', 'ONE', 1, 1),
    video('m1', null), video('m2', null)];
  const records = [toPlaylist({id: 'manual:1', title: 'Mine', manual: true, members: [
    {source: 'youtube:m1', index: 1}, {source: 'youtube:m2', index: 2}]})];
  applyPlaylists(items, records);
  const shown = createPlaylistCollapser()(items, playlistsFrom(items, records));
  assert.deepEqual(ids(shown), ['a1', 'a2', 'solo', 'm1', 'm2']);
});

test('a video in two whole playlists shows once', () => {
  const shared = video('shared', 'FIRST', 1, 2);
  const items = [shared, video('f2', 'FIRST', 2, 2), video('s2', 'SECOND', 2, 2)];
  const records = [toPlaylist({id: 'SECOND', title: 'SECOND', count: 2, members: [
    {source: 'youtube:shared', index: 1}, {source: 'youtube:s2', index: 2}]})];
  applyPlaylists(items, records);
  const shown = createPlaylistCollapser()(items, playlistsFrom(items, records));
  assert.equal(ids(shown).filter(id => id.startsWith('playlist:')).length, 1);
  assert.equal(new Set(shown.flatMap(entry => entry.playlist ? ids(entry.playlist.items) : [entry.id])).size, 3);
});

test('an unchanged playlist keeps its entry, so the gallery does not rebuild', () => {
  const items = [video('t1', 'ALBUM', 1, 2), video('t2', 'ALBUM', 2, 2)];
  const collapse = createPlaylistCollapser();
  const first = collapse(items, playlistsFrom(items))[0];
  assert.equal(collapse(items, playlistsFrom(items))[0], first);
  const replaced = [video('t1', 'ALBUM', 1, 2), items[1]];
  assert.notEqual(collapse(replaced, playlistsFrom(replaced))[0], first);
});

test('a channel downloaded whole stays as its videos', () => {
  const upload = (id, index, extra) => toMediaItem({
    id, extractor_key: 'Youtube', title: id, _key: id, _media_url: '/media/' + id, channel_id: 'UCabc',
    playlist_index: index, playlist_count: 2, ...extra,
  });
  const cases = [
    {playlist_id: 'UCabc', playlist_title: 'Someone - Videos'},
    {playlist_id: 'UUabc', playlist_title: 'Uploads from Someone'},
    {playlist_id: 'someone', playlist_webpage_url: 'https://www.youtube.com/@someone/videos'},
  ];
  for (const extra of cases) {
    const items = [upload('v1', 1, extra), upload('v2', 2, extra)];
    assert.equal(items[0].archive.playlist.uploads, true);
    assert.deepEqual(ids(createPlaylistCollapser()(items, playlistsFrom(items))), ['v1', 'v2']);
  }
  const album = video('t1', 'OLAKalbum', 1, 1);
  assert.equal(album.archive.playlist.uploads, false);
});
