import assert from 'node:assert/strict';
import test from 'node:test';

import {favouritePlaylists} from '../web/playlist-shelf.js';

test('the home shelf shows only favourite playlists, in the archive\'s order', () => {
  const playlists = [{id: 'PL3'}, {id: 'PL1'}, {id: 'PL2'}];
  assert.deepEqual(favouritePlaylists(playlists, new Set(['PL1', 'PL3'])).map(entry => entry.id),
                   ['PL3', 'PL1']);
  assert.deepEqual(favouritePlaylists(playlists, new Set()), []);
});

test('a playlist card wears the portrait of the creator with the most videos in it', async () => {
  const {commonOwnerOf} = await import('../web/playlists.js');
  const by = id => ({facets: {owner: id ? {id, name: id} : null}});
  assert.equal(commonOwnerOf([by('a'), by('b'), by('b'), by(null)]).id, 'b');
  assert.equal(commonOwnerOf([by('a'), by('b')]).id, 'a');
  assert.equal(commonOwnerOf([by(null)]), null);
});

test('a playlist card states its total runtime', async () => {
  const {runtimeLabel} = await import('../web/playlist-grid.js');
  const of = (...seconds) => seconds.map(durationSeconds => ({durationSeconds}));
  assert.equal(runtimeLabel(of(3600, 3900)), '2h 05m');
  assert.equal(runtimeLabel(of(300, 45)), '5m');
  assert.equal(runtimeLabel(of(null)), '');
});

test('a playlist card shows the creator of the part on show', async () => {
  const {playlistItem} = await import('../web/playlist-grid.js');
  const {viewOf} = await import('../ui/shared/lib/item.js');
  const video = (id, owner) => ({id, facets: {owner: owner && {id: owner, name: owner}}});
  const card = playlistItem({id: 'p', title: 'P', count: 3, creator: {id: 'a', name: 'a'},
    items: [video('1', 'a'), video('2', 'b'), video('3', null)]});
  assert.equal(viewOf(card, 0).facets.owner.id, 'a');
  assert.equal(viewOf(card, 1).facets.owner.id, 'b');
  assert.equal(viewOf(card, 2).facets.owner.id, 'a');
});

test("a playlist read as a list opens from its card's thumbnail, and any other plays", async () => {
  globalThis.document ??= {addEventListener() {}};
  const {createPlaylistCards} = await import('../web/playlist-grid.js');
  const opened = [];
  const played = [];
  const cards = createPlaylistCards({
    onPlay: item => played.push(item.id),
    onOpen: playlist => opened.push(playlist.id),
    opensAsList: playlist => playlist.id === 'album',
    subscriptions: {list: () => []},
    redraw() {},
  });
  const playlist = id => ({id, title: id, count: 1, items: [{id: `${id}-1`, title: 'One'}]});
  cards.card(playlist('album')).props.onOpenDetails(null, 0, null);
  cards.card(playlist('videos')).props.onOpenDetails(null, 0, null);
  assert.deepEqual(opened, ['album']);
  assert.deepEqual(played, ['videos-1']);
});
