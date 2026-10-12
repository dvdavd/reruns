import assert from 'node:assert/strict';
import test from 'node:test';
import {hasCover, isListened, keepsPlayingIn, showsAsTracks, trackNumberOf, tracklistOf} from '../web/tracklist.js';

const track = (extra = {}) => ({audioOnly: true, music: null, archive: {playlist: null}, ...extra});
const video = (extra = {}) => ({audioOnly: false, music: null, archive: {playlist: null}, ...extra});

test('a playlist of sound alone, or of an album, is a tracklist', () => {
  assert.equal(showsAsTracks([track(), track()]), true);
  assert.equal(showsAsTracks([video({music: {album: 'Record'}}), track()]), true);
});

test('one video among the tracks keeps the cards, and nothing is no list', () => {
  assert.equal(showsAsTracks([track(), video()]), false);
  assert.equal(showsAsTracks([]), false);
});

test("the viewer's choice for a playlist wins either way", () => {
  assert.equal(showsAsTracks([video()], 'tracks'), true);
  assert.equal(showsAsTracks([track()], 'cards'), false);
  assert.equal(showsAsTracks([track()], 'something else'), true);
});

test("a track keeps its album's number, else its place in the playlist", () => {
  assert.equal(trackNumberOf(track({music: {trackNumber: 4}, archive: {playlist: {index: 9}}})), 4);
  assert.equal(trackNumberOf(track({archive: {playlist: {index: 9}}})), 9);
  assert.equal(trackNumberOf(track()), '');
});

test('a tracklist is one album only when every track says the same one', () => {
  const song = (album, artist, year) => track({music: {album, artist, year}});
  assert.deepEqual(tracklistOf([song('Record', 'Band', 1999), song('Record', 'Band', 1999)]),
    {album: 'Record', artist: 'Band', year: 1999, covers: true});
  assert.deepEqual(tracklistOf([song('Record', 'Band', 1999), song('Record', 'Guest', 2001)]),
    {album: 'Record', artist: '', year: 0, covers: true});
  assert.deepEqual(tracklistOf([song('Record', 'Band', 1999), track()]),
    {album: '', artist: '', year: 0, covers: false});
});

test("a track filed under an album wears a square cover, and anything else its video's still", () => {
  assert.equal(hasCover(track({music: {album: 'Record'}})), true);
  assert.equal(hasCover(track()), false);
  assert.equal(hasCover(track({music: {artist: 'Band'}})), false);
});

test('sound alone, or a track filed under an album whatever its file, is listened to', () => {
  assert.equal(isListened(track()), true);
  assert.equal(isListened(video({music: {album: 'Record'}})), true);
  assert.equal(isListened(video()), false);
  assert.equal(isListened(video({music: {track: 'Song'}})), false);
});

test('background play keeps anything On, only what is listened to Automatic, and nothing Off', () => {
  const cover = video({music: {album: 'Record'}, thumbnail: {url: '/cover.jpg', square: true}});
  for (const [mode, kept] of [
    ['auto', {track: true, video: true, cover: true}],
    ['audio', {track: true, video: false, cover: isListened(cover)}],
    ['off', {track: false, video: false, cover: false}],
  ]) {
    assert.equal(keepsPlayingIn(mode, track()), kept.track, `${mode} track`);
    assert.equal(keepsPlayingIn(mode, video()), kept.video, `${mode} video`);
    assert.equal(keepsPlayingIn(mode, cover), kept.cover, `${mode} cover`);
  }
  assert.equal(keepsPlayingIn('something else', track()), false);
});
