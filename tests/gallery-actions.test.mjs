import assert from 'node:assert/strict';
import test from 'node:test';
import {createItemStore} from 'media-ui';
import {createGalleryActions} from '../web/gallery-actions.js';
import {groupFormats, toMediaItem} from '../web/item-adapter.js';

const copies = [720, 1080].map(height => ({_key: `clip.${height}.info.json`,
  _serves: 'media', id: 'same', extractor_key: 'Youtube',
  title: 'Clip', width: height * 16 / 9, height, ext: 'mp4', vcodec: 'avc1'}));

function harness(t, choose) {
  for (const key of ['document', 'window']) {
    const previous = globalThis[key];
    globalThis[key] = new EventTarget();
    t.after(() => { globalThis[key] = previous; });
  }
  document.body = {dataset: {}};
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    posts.push([path, JSON.parse(options.body)]);
    return {ok: true, json: async () => ({})};
  });
  const [item] = groupFormats(copies.map(toMediaItem));
  const store = createItemStore([item]);
  const playback = {position: 42, playing: true};
  const handoffs = [];
  const reloads = [];
  let closed = false;
  const actions = createGalleryActions({store, draw() {}, report() {},
    player: {activeId: () => item.id, playbackSnapshot: () => playback,
      close: () => { closed = true; }, replaceDeletedFormat: (...args) => handoffs.push(args)},
    deletion: {confirm: async () => choose(item)},
    replaceItems(items, {notify}) { if (notify) store.setItems(items); },
    load(options) {
      reloads.push(options);
      store.setItems(copies.filter(raw => !choose(item).includes(raw._key)).map(toMediaItem));
    },
  });
  return {item, actions, handoffs, reloads, posts, closed: () => closed, playback};
}

test('deleting the playing format carries its position to the surviving copy', async t => {
  const h = harness(t, item => [item.archive.formatId]);
  const removed = h.item.archive.formatId;
  await h.actions.deleteVideo(h.item);
  assert.deepEqual(h.posts, [['/api/item/delete', {id: removed}]]);
  assert.deepEqual(h.reloads, [{refreshPlayer: false}]);
  assert.equal(h.handoffs.length, 1);
  assert.notEqual(h.handoffs[0][0].archive.formatId, removed);
  assert.equal(h.handoffs[0][1], h.playback);
  assert.equal(h.closed(), false);
});

test('deleting every copy closes the player without a playback handoff', async t => {
  const h = harness(t, item => item.archive.formats.map(format => format.id));
  await h.actions.deleteVideo(h.item);
  assert.equal(h.posts.length, 2);
  assert.equal(h.closed(), true);
  assert.equal(h.handoffs.length, 0);
  assert.deepEqual(h.reloads, [{refreshPlayer: true}]);
});

test('a card menu belongs to its surface and is cleared if its item disappears', t => {
  const h = harness(t, () => []);
  h.actions.cardProps(h.item, 'gallery').onToggleMenu(h.item);
  assert.equal(h.actions.cardProps(h.item, 'gallery').menuOpen, true);
  assert.equal(h.actions.cardProps(h.item, 'related').menuOpen, false);
  h.actions.reconcileItems([]);
  assert.equal(h.actions.cardProps(h.item, 'gallery').menuOpen, false);
});

test('a related card lists its playlists in its menu, where the gallery card has a chip', t => {
  const h = harness(t, () => []);
  const actions = props => props.menuItems.map(entry => entry.action);
  assert.ok(!actions(h.actions.cardProps(h.item, 'related')).includes('show-playlists'));
  h.item.facets.collections = [{id: 'a', name: 'One'}];
  const [single, divider] = h.actions.cardProps(h.item, 'related').menuItems;
  assert.deepEqual([single.action, single.label, single.submenu, divider.type],
    ['show-playlists', 'Show playlist', undefined, 'divider']);
  h.item.facets.collections.push({id: 'b', name: 'Two'});
  const [several] = h.actions.cardProps(h.item, 'related').menuItems;
  assert.deepEqual([several.label, several.submenu], ['Show playlists', true]);
  assert.ok(!actions(h.actions.cardProps(h.item, 'gallery')).includes('show-playlists'));
});

test('a refused favourite change restores the store value', async t => {
  const h = harness(t, () => []);
  const before = h.item.favourite;
  t.mock.method(globalThis, 'fetch', async () => ({ok: false, text: async () => 'Refused'}));
  await h.actions.toggleFavourite(h.item);
  assert.equal(h.item.favourite, before);
});
