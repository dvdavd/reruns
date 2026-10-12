import test from 'node:test';
import assert from 'node:assert/strict';
import {readHidden} from '../web/shelf-settings.js';

const storage = value => ({getItem: () => value});

test('reads the switched rows, in the order the page shows them', () => {
  assert.deepEqual(readHidden('home', storage('{"playlists":false,"channels":false,"videos":true}')),
    ['channels', 'playlists']);
});

test('reads home\'s old list of hidden rows as those rows switched off', () => {
  assert.deepEqual(readHidden('home', storage('["playlists","channels"]')), ['channels', 'playlists']);
});

test('drops names no longer offered, and uses the defaults when nothing sensible is saved', () => {
  assert.deepEqual(readHidden('home', storage('["videos","creators"]')), ['videos']);
  assert.deepEqual(readHidden('home', storage(null)), []);
  assert.deepEqual(readHidden('home', storage('{nope')), []);
  assert.deepEqual(readHidden('home', storage('"videos"')), []);
  assert.deepEqual(readHidden('home', storage('{"videos":"no"}')), []);
});

test('a channel\'s page shows only its favourite videos until told otherwise', () => {
  assert.deepEqual(readHidden('channel', storage(null)), ['favourite-playlists', 'playlists']);
  assert.deepEqual(readHidden('channel', storage('{"playlists":true,"videos":false}')),
    ['favourite-playlists', 'videos']);
});

test('a playlist\'s page offers only its favourite videos, off until told otherwise', () => {
  assert.deepEqual(readHidden('playlist', storage(null)), ['videos']);
  assert.deepEqual(readHidden('playlist', storage('{"videos":true}')), []);
});

test('the videos and playlists views offer their favourites, off until told otherwise', () => {
  assert.deepEqual(readHidden('videos', storage(null)), ['videos']);
  assert.deepEqual(readHidden('playlists', storage('{"playlists":true}')), []);
});

test('home folds whole playlists until told otherwise', () => {
  assert.equal(readHidden('home', storage(null)).includes('collapsed-playlists'), false);
  assert.deepEqual(readHidden('home', storage('{"collapsed-playlists":false}')), ['collapsed-playlists']);
});
