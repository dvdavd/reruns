import assert from 'node:assert/strict';
import test from 'node:test';
import {playlistSuggestions} from '../web/playlist-editor-model.js';

const video = (id, channel = '', mtime = 0, playlists = []) => ({
  id, title: id, mtime, facets: {owner: channel ? {id: channel, name: channel} : null, people: []},
  archive: {playlists: playlists.map(id => ({id}))},
});

test('an empty playlist suggests a small recent selection without changing library order', () => {
  const library = Array.from({length: 10}, (_, index) => video(`Video ${index}`, '', index));
  const result = playlistSuggestions(library, []);
  assert.equal(result.heading, 'Recent videos');
  assert.deepEqual(result.items.map(item => item.id), ['Video 9', 'Video 8', 'Video 7', 'Video 6', 'Video 5', 'Video 4']);
  assert.equal(result.total, 10);
  assert.equal(library[0].id, 'Video 0');
});

test('related groups follow playlist add order before filling with recent videos', () => {
  const library = [video('first', 'A'), video('second', 'B'), video('recent', 'C', 100),
    video('A older', 'A', 10), video('B newer', 'B', 90), video('A newer', 'A', 20)];
  const result = playlistSuggestions(library, ['first', 'second']);
  assert.equal(result.heading, 'Related videos');
  assert.deepEqual(result.items.map(item => item.id), ['A newer', 'A older', 'B newer', 'recent']);
  assert.deepEqual(playlistSuggestions(library, ['second', 'first']).items.map(item => item.id),
    ['B newer', 'A newer', 'A older', 'recent']);
});

test('shared playlist membership supplies suggestions without duplicates', () => {
  const library = [video('first', '', 0, ['PL1']), video('second', '', 0, ['PL1']),
    video('related', '', 10, ['PL1']), video('unrelated', '', 100)];
  assert.deepEqual(playlistSuggestions(library, ['first', 'second']).items.map(item => item.id),
    ['related', 'unrelated']);
});

test('search covers the whole library and channel metadata, excluding chosen videos', () => {
  const library = [video('chosen', 'Lessons'), ...Array.from({length: 20}, (_, index) =>
    video(`Drawing ${index}`, 'Lessons', index)), video('Drawing elsewhere', 'Other', 100)];
  const result = playlistSuggestions(library, ['chosen'], {query: 'drawing lessons'});
  assert.equal(result.heading, 'Search results');
  assert.equal(result.total, 20);
  assert.equal(result.items.length, 12);
  assert.equal(result.items[0].id, 'Drawing 19');
  assert.equal(playlistSuggestions(library, [], {query: 'nothing here'}).items.length, 0);
});

test('missing or removed members fall back to recent suggestions', () => {
  const library = [video('a', '', 1), video('b', '', 2)];
  assert.equal(playlistSuggestions(library, ['gone']).heading, 'Recent videos');
  assert.deepEqual(playlistSuggestions(library, ['a', 'b']).items, []);
});
