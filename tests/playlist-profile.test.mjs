import assert from 'node:assert/strict';
import test from 'node:test';
import {playlistStats} from '../web/playlist-profile.js';

test('playlist profile shows held and total video counts with runtime', () => {
  assert.deepEqual(playlistStats({
    count: 5,
    items: [{durationSeconds: 60}, {durationSeconds: 60}],
  }), ['2 of 5 videos', '2 min']);
});

test('playlist profile uses a singular count for a complete one-video playlist', () => {
  assert.deepEqual(playlistStats({items: [{}]}), ['1 video']);
});

test('an album counts tracks, and leaves its year to the byline', () => {
  assert.deepEqual(playlistStats({items: [{durationSeconds: 120}, {durationSeconds: 60}]},
    {album: 'Record', artist: 'Band', year: 1999}), ['2 tracks', '3 min']);
  assert.deepEqual(playlistStats({items: [{}]}, {album: '', artist: '', year: 0}), ['1 track']);
});
