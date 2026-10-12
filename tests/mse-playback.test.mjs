import assert from 'node:assert/strict';
import test from 'node:test';
import {bufferedAt, evictionBoundary, RemuxPlayback} from '../web/mse-playback.js';
import {ArchiveMediaProvider} from '../web/media-provider.js';

const ranges = entries => ({length: entries.length,
  start: index => entries[index][0], end: index => entries[index][1]});

test('eviction retains a long GOP until its entire fragment is safely behind playback', () => {
  assert.equal(evictionBoundary([60, 120], 35), 0);
  assert.equal(evictionBoundary([60, 120], 79), 0);
  assert.equal(evictionBoundary([60, 120], 85), 60);
  assert.equal(evictionBoundary([8, 16, 24, 32], 43), 16);
});

test('seeking needs new media when the requested time is in a buffer gap', () => {
  const buffered = ranges([[0, 10], [30, 45]]);
  assert.equal(bufferedAt(buffered, 5), 10);
  assert.equal(bufferedAt(buffered, 20), null);
  assert.equal(bufferedAt(buffered, 35), 45);
  assert.equal(bufferedAt(buffered, 45), null);
});

test('MKV resolution selects remuxing only when MSE supports the actual tracks', async () => {
  const previousFetch = globalThis.fetch;
  const previousMedia = globalThis.MediaSource;
  const requests = [];
  const plan = {mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"', duration: 120};
  globalThis.fetch = async url => { requests.push(url); return {ok: true, json: async () => plan}; };
  globalThis.MediaSource = {isTypeSupported: mime => mime === plan.mime};
  try {
    const provider = new ArchiveMediaProvider();
    const item = {id: 'clip', parts: [{filename: 'Clip.mkv', sourceRef: '/media/clip.info.json', durationSeconds: 119}]};
    provider.resumeFrom(75);
    const source = await provider.resolve(item);
    assert.equal(source.remux.url, '/stream/clip.info.json');
    assert.equal(source.durationSeconds, 120);
    assert.equal(source.resumeSeconds, 75);
    assert.deepEqual(requests, ['/api/playback/clip.info.json']);
    globalThis.MediaSource.isTypeSupported = () => false;
    assert.equal((await provider.resolve(item)).remux, undefined);
    requests.length = 0;
    item.parts[0].filename = 'Clip.mp4';
    assert.equal((await provider.resolve(item)).remux, undefined);
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.MediaSource = previousMedia;
  }
});

test('closing playback releases its URL and cancels listeners and the fetch', () => {
  const previousMedia = globalThis.MediaSource;
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.MediaSource = class extends EventTarget {};
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const video = Object.assign(new EventTarget(), {load() {}});
    const session = new RemuxPlayback(video, {resumeSeconds: 0}, () => {});
    session.fetchController = new AbortController();
    session.close();
    assert.equal(session.fetchController.signal.aborted, true);
    assert.equal(session.listeners.signal.aborted, true);
    assert.deepEqual(revoked, ['blob:test']);
  } finally {
    globalThis.MediaSource = previousMedia;
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
  }
});

test('scrubbing ahead within the running stream waits for it instead of restarting', () => {
  const previousMedia = globalThis.MediaSource;
  const previousCreate = URL.createObjectURL;
  globalThis.MediaSource = class extends EventTarget {};
  URL.createObjectURL = () => 'blob:test';
  try {
    const video = Object.assign(new EventTarget(), {load() {}, currentTime: 0});
    const session = new RemuxPlayback(video, {resumeSeconds: 0}, () => {});
    const restarts = [];
    session.restart = target => restarts.push(target);
    session.buffer = {buffered: ranges([[98, 110]])};
    session.streamFrom = 98;
    session.appendedTo = 110;
    session.target = 100;
    for (const time of [112, 115, 117.5]) {
      video.currentTime = time;
      video.dispatchEvent(new Event('seeking'));
    }
    assert.deepEqual(restarts, []);
    assert.equal(session.target, 117.5);
    assert.equal(session.awaitingTarget, true);
    video.currentTime = 200;
    video.dispatchEvent(new Event('seeking'));
    video.currentTime = 50;
    video.dispatchEvent(new Event('seeking'));
    assert.deepEqual(restarts, [200, 50]);
    session.close();
  } finally {
    globalThis.MediaSource = previousMedia;
    URL.createObjectURL = previousCreate;
  }
});

test('a file with several audio tracks is remuxed whatever its container, and the track asked for is the one requested', async () => {
  const previousFetch = globalThis.fetch;
  const previousMedia = globalThis.MediaSource;
  const previousStorage = globalThis.localStorage;
  const held = new Map();
  globalThis.localStorage = {getItem: key => held.get(key) ?? null, setItem: (key, value) => held.set(key, value),
    removeItem: key => held.delete(key)};
  const tracks = [
    {index: 1, language: 'eng', title: '', codec: 'aac', default: true, playable: true},
    {index: 2, language: 'deu', title: '', codec: 'aac', default: false, playable: true},
    {index: 3, language: 'fra', title: '', codec: 'dts', default: false, playable: false}];
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    const audio = Number(new URL(url, 'http://x').searchParams.get('audio') || 1);
    return {ok: true, json: async () => ({mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"', duration: 60, audio, audioTracks: tracks})};
  };
  globalThis.MediaSource = {isTypeSupported: () => true};
  try {
    const provider = new ArchiveMediaProvider();
    const item = {id: 'clip', parts: [{filename: 'Clip.mp4', sourceRef: '/media/clip.info.json', durationSeconds: 60,
      audioTrackCount: 2}]};
    // Nothing chosen: the file's own default, in a single request.
    let source = await provider.resolve(item);
    assert.equal(source.remux.audio, 1);
    assert.deepEqual(requests, ['/api/playback/clip.info.json']);
    // A pick is for the next load only, and asks for that stream.
    requests.length = 0;
    provider.chooseAudio(tracks[1]);
    source = await provider.resolve(item);
    assert.equal(source.remux.audio, 2);
    assert.deepEqual(requests, ['/api/playback/clip.info.json?audio=2']);
    // The language is remembered, so the next video that has it starts there.
    requests.length = 0;
    source = await provider.resolve(item);
    assert.equal(source.remux.audio, 2);
    assert.deepEqual(requests, ['/api/playback/clip.info.json', '/api/playback/clip.info.json?audio=2']);
    // One track, outside an MKV, stays native.
    requests.length = 0;
    item.parts[0].audioTrackCount = 0;
    assert.equal((await provider.resolve(item)).remux, undefined);
    assert.equal(requests.length, 0);
    // Whatever the plan says, the stream asks for the track it describes.
    const urls = [];
    globalThis.fetch = async url => { urls.push(url); throw new Error('stop'); };
    const session = Object.create(RemuxPlayback.prototype);
    session.source = {remux: {url: '/stream/clip', audio: 2, audioTracks: tracks}};
    await session.pump(10, new AbortController()).catch(() => {});
    assert.deepEqual(urls, ['/stream/clip?start=8&audio=2']);
    urls.length = 0;
    session.source = {remux: {url: '/stream/clip', audio: 1, audioTracks: []}};
    await session.pump(10, new AbortController()).catch(() => {});
    assert.deepEqual(urls, ['/stream/clip?start=8']);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.MediaSource = previousMedia;
    globalThis.localStorage = previousStorage;
  }
});

test('a remembered audio language finds the same language however a file spells it', async () => {
  const {preferredAudio} = await import('../web/media-provider.js');
  const track = (index, language, playable = true) => ({index, language, playable});
  const tracks = [track(1, 'eng'), track(2, 'deu'), track(3, 'und'), track(4, 'fra', false)];
  assert.equal(preferredAudio(tracks, 'de-DE').index, 2);
  assert.equal(preferredAudio(tracks, 'de').index, 2);
  assert.equal(preferredAudio(tracks, 'deu').index, 2);
  assert.equal(preferredAudio(tracks, 'EN').index, 1);
  // Not a track this browser can play, a language the file lacks, and nothing at all.
  assert.equal(preferredAudio(tracks, 'fr'), null);
  assert.equal(preferredAudio(tracks, 'ja'), null);
  assert.equal(preferredAudio(tracks, ''), null);
  // Undetermined is not a language anyone asks for.
  assert.equal(preferredAudio(tracks, 'und'), null);
});
