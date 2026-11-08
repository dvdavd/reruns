import assert from 'node:assert/strict';
import test from 'node:test';
import {createItemStore} from 'media-ui';
import {createLibraryLoader} from '../web/gallery-loader.js';
import {groupFormats, selectFormat, toMediaItem} from '../web/item-adapter.js';

const copies = [720, 1080].map(height => ({_key: `clip.${height}.info.json`,
  _serves: 'media', id: 'same', extractor_key: 'Youtube',
  title: 'Clip', width: height * 16 / 9, height, ext: 'mp4', vcodec: 'avc1'}));

function harness(t, fetch) {
  const previous = globalThis.document;
  globalThis.document = {body: {dataset: {}}};
  t.after(() => { globalThis.document = previous; });
  t.mock.method(globalThis, 'fetch', fetch);
  const store = createItemStore([]);
  const replacements = [];
  let refreshes = 0;
  const loader = createLibraryLoader({store, player: {refreshActiveItem: () => refreshes++},
    report() {}, setStatus() {}, applyMetadata: () => ({}),
    replaceItems(items) { replacements.push(items); store.setItems(items); }});
  return {store, loader, replacements, refreshes: () => refreshes};
}
const response = value => ({ok: true, json: async () => value});

test('rescan retains the playing format and session when optional endpoints fail', async t => {
  const requests = [];
  const {store, loader, replacements, refreshes} = harness(t, async path => {
    requests.push(path);
    if (path === '/api/items') return response(copies);
    throw new Error('Optional endpoint unavailable');
  });
  const [old] = groupFormats(copies.map(toMediaItem));
  selectFormat(old, copies[0]._key);
  old.session = {playing: true};
  store.setItems([old]);
  await loader.load();
  assert.equal(replacements.length, 1);
  const item = store.allItems()[0];
  assert.equal(item.archive.formatId, copies[0]._key);
  assert.equal(item.session, old.session);
  assert.equal(refreshes(), 1);
  assert.equal(requests.at(-1), '/api/directories');
  assert.equal(document.body.dataset.loading, undefined);
});

test('overlapping requests queue one follow-up scan instead of racing replacements', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let scans = 0;
  const {loader, replacements} = harness(t, async path => {
    if (path === '/api/items') {
      if (++scans === 1) await pending;
      return response(copies);
    }
    return response(path === '/api/settings' ? {} : []);
  });
  const first = loader.load();
  await loader.load();
  await loader.load();
  assert.equal(scans, 1);
  release();
  await first;
  assert.equal(scans, 2);
  assert.equal(replacements.length, 2);
});

test('rescan keeps sampled accents while the thumbnail is the same', async t => {
  const pictured = copies.map(copy => ({...copy, _serves: 'media thumb'}));
  let served = pictured;
  const {store, loader} = harness(t, async path =>
    response(path === '/api/items' ? served : path === '/api/settings' ? {} : []));
  const [old] = groupFormats(pictured.map(toMediaItem));
  old.accent = 'rgb(1, 2, 3)';
  old.parts[0].accent = 'rgb(1, 2, 3)';
  store.setItems([old]);
  await loader.load();
  let item = store.allItems()[0];
  assert.notEqual(item, old);
  assert.equal(item.accent, 'rgb(1, 2, 3)');
  assert.equal(item.parts[0].accent, 'rgb(1, 2, 3)');

  // A colour from a thumbnail that has gone is not kept for the video.
  served = copies;
  await loader.load();
  item = store.allItems()[0];
  assert.equal(item.accent, undefined);
  assert.equal(item.parts[0].accent, undefined);
});
