import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRuntime, libraryStats} from '../web/library-stats.js';

function video(id, {size = 100, duration = 60, quality = '1080p', owner, playlist, favourite = false, downloaded = true} = {}) {
  return {
    id, title: `Video ${id}`, favourite,
    parts: [{sizeBytes: size, durationSeconds: duration, quality}],
    facets: {owner: owner ? {id: owner, name: owner} : null, collections: []},
    archive: {downloaded, uploadedAt: 0,
      playlist: playlist ? {id: playlist.id, title: playlist.id, index: playlist.index, count: playlist.count || 0} : null},
  };
}

test('totals what is held, leaving out sidecars with no file', () => {
  const stats = libraryStats([
    video('a', {size: 300, duration: 120, owner: 'A', favourite: true}),
    video('b', {size: 100, duration: 60, owner: 'A', quality: '4K'}),
    video('c', {size: 50, owner: 'B'}),
    video('d', {size: 999, owner: 'C', downloaded: false}),
  ]);
  assert.equal(stats.videos, 3);
  assert.equal(stats.sizeBytes, 450);
  assert.equal(stats.durationSeconds, 240);
  assert.equal(stats.channels, 2);
  assert.equal(stats.favourites, 1);
  assert.deepEqual(stats.qualities, [
    {id: '1080p', name: '1080p', count: 2}, {id: '4K', name: '4K', count: 1}]);
  assert.deepEqual(stats.topChannels.map(channel => [channel.name, channel.count, channel.sizeBytes]),
    [['A', 2, 400], ['B', 1, 50]]);
  assert.deepEqual(stats.largestVideos.map(entry => entry.item.id), ['a', 'b', 'c']);
});

test('ranks playlists by how much of them is held, keeping their full length', () => {
  const stats = libraryStats([
    video('a', {playlist: {id: 'long', index: 1, count: 400}}),
    video('b', {playlist: {id: 'short', index: 1, count: 3}}),
    video('c', {playlist: {id: 'short', index: 2, count: 3}}),
  ]);
  assert.deepEqual(stats.topPlaylists.map(playlist => [playlist.title, playlist.count, playlist.total]),
    [['short', 2, 3], ['long', 1, 400]]);
});

test('reads a running time in the largest units it needs', () => {
  assert.equal(formatRuntime(0), '0m');
  assert.equal(formatRuntime(45 * 60), '45m');
  assert.equal(formatRuntime(3 * 3600 + 5 * 60), '3h 5m');
  assert.equal(formatRuntime(51 * 3600), '2d 3h');
});

test('ranks the entire library by size or runtime before taking the top five', () => {
  const items = Array.from({length: 6}, (_, index) => video(String(index), {
    owner: String(index), size: index + 1, duration: 6 - index,
    playlist: {id: String(index), count: 10},
  }));
  assert.deepEqual(libraryStats(items, 'sizeBytes').topChannels.map(group => group.id), ['5', '4', '3', '2', '1']);
  assert.deepEqual(libraryStats(items, 'durationSeconds').topPlaylists.map(group => group.id), ['0', '1', '2', '3', '4']);
});

test('audio counts as its own quality, linked by an id rather than its name', () => {
  const track = {...video('t', {quality: ''}), audioOnly: true};
  const stats = libraryStats([track, video('v'), video('u', {quality: ''})]);
  assert.deepEqual(stats.qualities.map(entry => [entry.id, entry.count]),
    [['1080p', 1], ['audio', 1], ['Unknown', 1]]);
  assert.equal(stats.qualities[1].name, 'Audio only');
});
