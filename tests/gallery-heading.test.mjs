import assert from 'node:assert/strict';
import test from 'node:test';

import {SORT_DEFAULT_DIRECTIONS, sortItems} from 'media-ui';

import {
  directionOf, effectiveSort, galleryHeading, SORT_OPTIONS, sortButtons,
} from '../web/gallery-heading.js';

test('the heading names a playlist, a creator, or just the videos', () => {
  assert.equal(galleryHeading(), 'Videos');
  assert.equal(galleryHeading({creator: 'Tom Scott'}), "Tom Scott's Videos");
  assert.equal(galleryHeading({source: 'Dropbox'}), 'Videos from Dropbox');
  assert.equal(galleryHeading({playlist: {title: 'England'}, creator: 'Tom Scott'}), 'England');
});

test('a playlist starts in its own order, and nothing else offers that order', () => {
  assert.equal(effectiveSort(null, {playlist: true}), 'playlist');
  assert.equal(effectiveSort('playlist', {playlist: false}), 'latest');
  assert.equal(effectiveSort('size', {playlist: true}), 'size');
  assert.deepEqual(sortButtons({sort: null}).map(button => button.mode),
    ['latest', 'name', 'duration', 'size']);
  assert.deepEqual(sortButtons({sort: null, playlist: true}).map(button => button.mode),
    ['playlist', 'latest', 'name', 'duration', 'size']);
});

test('only the active sort shows its direction', () => {
  const buttons = sortButtons({sort: 'name', directions: {name: 'desc'}});
  assert.deepEqual(buttons.map(button => button.text), ['Newest', 'Title ↓', 'Duration', 'Size']);
  assert.equal(sortButtons({sort: null})[0].text, 'Newest ↓');
  // A playlist's own order carries an arrow too, but it is the playlist's own
  // and saved with it, so it is passed in rather than read from `directions`.
  assert.equal(sortButtons({sort: null, playlist: true})[0].text, 'Playlist ↑');
  assert.equal(sortButtons({sort: null, playlist: true, playlistReversed: true})[0].text,
    'Playlist ↓');
  assert.equal(sortButtons({sort: 'name', playlist: true, playlistReversed: true})[0].text,
    'Playlist');
  assert.match(sortButtons({sort: null, playlist: true, playlistReversed: true})[0].ariaLabel,
    /reversed; activate to reverse/);
  assert.match(sortButtons({sort: null, playlist: true})[0].ariaLabel,
    /as recorded; activate to reverse/);
});

test('every sort the heading offers is one the package can sort by', () => {
  // A sort with no entry here still draws a button, but sortItems has no
  // comparator for it and quietly falls back to newest first.
  for (const {mode} of SORT_OPTIONS) {
    assert.ok(mode in SORT_DEFAULT_DIRECTIONS, mode);
  }
});

test('the arrow a button shows is the order the package actually sorts in', () => {
  // sortItems reverses by comparing the direction it is given against its own
  // default, so a heading that disagreed would point the arrow the wrong way.
  const items = [
    {id: 'a', title: 'Alpha', mtime: 300, sizeBytes: 300, durationSeconds: 300},
    {id: 'b', title: 'Bravo', mtime: 100, sizeBytes: 100, durationSeconds: 100},
    {id: 'c', title: 'Charlie', mtime: 200, sizeBytes: 200, durationSeconds: 200},
  ];
  const keys = {
    latest: item => item.mtime,
    name: item => item.title,
    duration: item => item.durationSeconds,
    size: item => item.sizeBytes,
  };
  for (const {mode} of SORT_OPTIONS) {
    const direction = directionOf(mode);
    const sorted = sortItems(items, {mode, direction}).map(keys[mode]);
    const rising = sorted[0] < sorted[sorted.length - 1];
    assert.equal(rising, direction === 'asc',
                 `${mode} sorted the other way from its ${direction} arrow`);
  }
});
