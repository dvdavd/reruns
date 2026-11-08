import assert from 'node:assert/strict';
import test from 'node:test';
import {applyPlaylists, groupFormats, toMediaItem, toPlaylist} from '../web/item-adapter.js';
import {inPlaylist, markPlaylistDirection, playlistsFrom} from '../web/playlists.js';
import {playlistNav} from '../web/watch-details.js';
import {matchesFacet} from '../web/facets.js';

const video = (id, playlist, index, suffix = '') => toMediaItem({
  id, extractor_key: 'Youtube', title: id, _key: id + suffix, _serves: 'media' + id,
  playlist_id: playlist, playlist_title: playlist, playlist_index: index,
});

test('one downloaded video belongs to multiple playlists with separate orders', () => {
  const items = [video('shared', 'PL1', 1), video('other', 'PL1', 2)];
  const records = [toPlaylist({id: 'manual:1', title: 'Study', manual: true, members: [
    {source: 'youtube:other', index: 1}, {source: 'youtube:shared', index: 2}]}),
    toPlaylist({id: 'manual:empty', title: 'Empty', manual: true})];
  markPlaylistDirection(applyPlaylists(items, records));
  const playlists = playlistsFrom(items, records);
  assert.equal(playlists.length, 3);
  assert.deepEqual(playlists.find(p => p.id === 'PL1').items.map(item => item.id), ['shared', 'other']);
  assert.deepEqual(playlists.find(p => p.id === 'manual:1').items.map(item => item.id), ['other', 'shared']);
  assert.equal(playlists.find(p => p.id === 'manual:empty').items.length, 0);
  assert(matchesFacet(items[0], {kind: 'playlist', id: 'manual:1'}));
  const nav = playlistNav(inPlaylist(items[0], 'manual:1'), items);
  assert.equal(nav.title, 'Study');
  assert.equal(nav.previous.id, 'other');
  assert.equal(nav.next, null);
  assert.equal(items[0].archive.playlist.id, 'PL1');
  const contextual = inPlaylist(items[0], 'manual:1');
  contextual.archive.formatId = 'another-format';
  contextual.archive.detailsLoaded = true;
  assert.equal(items[0].archive.formatId, 'another-format');
  assert.equal(items[0].archive.detailsLoaded, true);
  assert.equal(items[0].archive.playlist.id, 'PL1');
});

test('format grouping retains the playlists recorded by all copies', () => {
  const grouped = groupFormats([video('shared', 'PL1', 1), video('shared', 'PL2', 7, '-copy')]);
  assert.equal(grouped.length, 1);
  applyPlaylists(grouped, []);
  assert.deepEqual(new Set(playlistsFrom(grouped).map(p => p.id)), new Set(['PL1', 'PL2']));
});

test('manual order stays as edited when upload dates descend', () => {
  const items = [video('a'), video('b')];
  items[0].archive.uploadedAt = 200;
  items[1].archive.uploadedAt = 100;
  const records = [toPlaylist({id: 'manual:1', title: 'Ordered', manual: true, members: [
    {source: 'youtube:a', index: 1}, {source: 'youtube:b', index: 2}]})];
  markPlaylistDirection(applyPlaylists(items, records));
  assert.deepEqual(playlistsFrom(items)[0].items.map(item => item.id), ['a', 'b']);
});
