import assert from 'node:assert/strict';
import test from 'node:test';

import {applyItemDetails, currentFormat, groupFormats, selectFormat, sourceUrlFor,
        toMediaItem} from '../web/item-adapter.js';

test('adapts yt-dlp metadata and persisted favourite state', () => {
  const item = toMediaItem({
    _key: 'channel/clip.info.json',
    _serves: 'media thumb seek',
    _favourite: true,
    filepath: '/archive/channel/clip.mp4',
    title: 'A clip',
    uploader: 'Creator',
    channel: 'Channel',
    playlist: 'Series',
    webpage_url: 'https://example.test/watch/1',
    width: 1920,
    height: 1080,
    duration: 42,
  });

  assert.equal(item.favourite, true);
  assert.equal(item.quality, '1080p');
  assert.equal(item.facets.people[0].name, 'Creator');
  assert.equal(item.facets.owner.name, 'Channel');
  assert.equal(item.parts[0].seekPreviewUrl, '/api/seek-preview/channel/clip.info.json');
  assert.equal(item.sourceRef, '/media/channel/clip.info.json');
  assert.equal(item.thumbnail.url, '/thumb/channel/clip.info.json');
  assert.equal(item.filename, 'clip.mp4');
  assert.equal(sourceUrlFor(item), 'https://example.test/watch/1');
});

test('source URL helper safely isolates missing archive metadata', () => {
  assert.equal(sourceUrlFor({}), '');
});

test('does not repeat a channel that yt-dlp also reports as the uploader', () => {
  const item = toMediaItem({
    _key: 'channel/clip.info.json',
    _serves: 'media',
    title: 'A clip',
    uploader: 'Example Channel',
    channel: 'example channel',
  });

  assert.deepEqual(item.facets.people, []);
  assert.equal(item.facets.owner.name, 'example channel');
});

test('keeps a distinct creator alongside the channel', () => {
  const item = toMediaItem({
    _key: 'channel/clip.info.json',
    _serves: 'media',
    title: 'A clip',
    uploader: 'Guest Creator',
    channel: 'Example Channel',
  });

  assert.equal(item.facets.people[0].name, 'Guest Creator');
  assert.equal(item.facets.owner.name, 'Example Channel');
});

test('does not chip a handle and a display name as two people', () => {
  const item = toMediaItem({
    _key: 'channel/clip.info.json',
    _serves: 'media',
    title: 'A clip',
    uploader: 'xstinamendez',
    uploader_url: 'https://www.tiktok.com/@xstinamendez',
    channel: 'cristina m\u00e9ndez',
    webpage_url: 'https://www.tiktok.com/@xstinamendez/video/7685956541895232798',
  });

  assert.deepEqual(item.facets.people, []);
  assert.equal(item.facets.owner.name, 'cristina m\u00e9ndez');
});

test('a guest on a channel is still their own person', () => {
  const item = toMediaItem({
    _key: 'channel/clip.info.json',
    _serves: 'media',
    title: 'A clip',
    uploader: 'Guest Creator',
    uploader_url: 'https://www.youtube.com/@guest',
    channel: 'Example Channel',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
  });

  assert.equal(item.facets.people[0].name, 'Guest Creator');
});

test('does not present a playlist position as a channel release number', () => {
  const item = toMediaItem({
    _key: 'channel/clip.info.json',
    _serves: 'media',
    title: 'A clip',
    channel: 'Example Channel',
    playlist: 'Example Playlist',
    playlist_id: 'PL123',
    playlist_index: 7,
  });

  assert.equal(item.facets.ordinal, null);
  assert.deepEqual(item.facets.collections, [
    {id: 'PL123', name: 'Example Playlist'},
  ]);
});

test('leaves the watch page fields empty until their details arrive', () => {
  const item = toMediaItem({
    _key: 'clip.info.json',
    _serves: 'media details',
    title: 'A clip',
  });

  assert.equal(item.archive.description, '');
  assert.deepEqual(item.archive.heatmap, []);
  assert.equal(item.archive.detailsUrl, '/api/item-details/clip.info.json');

  applyItemDetails(item, {
    description: 'The long text',
    heatmap: [{start_time: 0, end_time: 2, value: 0.5}],
    automatic_caption_languages: [
      {language: 'en', label: 'English'},
      {language: 'fr-en', label: 'French from English'},
    ],
  });

  assert.equal(item.archive.description, 'The long text');
  assert.deepEqual(item.archive.heatmap,
    [{startSeconds: 0, endSeconds: 2, value: 0.5}]);
  assert.deepEqual(item.archive.automaticCaptionLanguages, [
    {language: 'en', label: 'English'},
    {language: 'fr-en', label: 'French from English'},
  ]);
});

test('folding in details keeps what is already there when a field is absent', () => {
  const item = toMediaItem({_key: 'clip.info.json', _serves: 'media', title: 'A clip'});
  applyItemDetails(item, {description: 'Only the text'});
  assert.equal(item.archive.description, 'Only the text');
  assert.deepEqual(item.archive.heatmap, []);
  // A video whose sidecar recorded neither, and a failed fetch, are both
  // nothing to fold in rather than something to blank out.
  applyItemDetails(item, {});
  applyItemDetails(item, null);
  assert.equal(item.archive.description, 'Only the text');
});

const copyRaw = (key, extra) => ({
  _key: key,
  _serves: 'media seek',
  id: 'abc123',
  extractor_key: 'Youtube',
  title: 'A clip',
  ext: 'mp4',
  vcodec: 'avc1',
  ...extra,
});

test('shows one card for a video downloaded in several formats', () => {
  const items = groupFormats([
    toMediaItem(copyRaw('clip.1080p.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.4k.info.json', {width: 3840, height: 2160, filesize: 5000, _favourite: true})),
    toMediaItem({_key: 'other.info.json', _serves: 'media', id: 'zzz',
                 extractor_key: 'Youtube', title: 'Another'}),
  ]);

  assert.deepEqual(items.map(item => item.id), ['clip.4k.info.json', 'other.info.json']);
  // The best copy stands for the video, wherever its own copy was in the list.
  assert.equal(items[0].quality, '4K');
  // A favourite belongs to the video, not to whichever file carried it.
  assert.equal(items[0].favourite, true);
  assert.deepEqual(items[0].archive.formats.map(format => format.label), ['4K', '1080p']);
  assert.equal(items[0].archive.formatId, 'clip.4k.info.json');
});

test('leaves a video downloaded once without a format list', () => {
  const [item] = groupFormats([toMediaItem(copyRaw('clip.info.json', {width: 1920, height: 1080}))]);
  assert.equal(item.archive.formats, undefined);
  assert.equal(currentFormat(item), null);
});

test('keeps separate videos apart, including ones with no source id', () => {
  const items = groupFormats([
    toMediaItem(copyRaw('a.info.json', {id: 'one'})),
    toMediaItem(copyRaw('b.info.json', {id: 'two'})),
    toMediaItem({_key: 'c.info.json', _serves: 'media', title: 'No id'}),
    toMediaItem({_key: 'd.info.json', _serves: 'media', title: 'No id either'}),
  ]);
  assert.equal(items.length, 4);
});

test('names an audio-only copy, and tells same-quality copies apart', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.mp4.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.webm.info.json', {width: 1920, height: 1080, filesize: 800, ext: 'webm'})),
    toMediaItem(copyRaw('clip.m4a.info.json', {vcodec: 'none', acodec: 'mp4a', ext: 'm4a',
                                               filesize: 50, format_note: 'medium'})),
  ]);
  assert.deepEqual(item.archive.formats.map(format => format.label),
    ['1080p · MP4', '1080p · WEBM', 'Audio only']);
});

test('switches an item to another of its formats, keeping the video itself', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.1080p.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.4k.info.json', {width: 3840, height: 2160, filesize: 5000})),
  ]);

  assert.equal(selectFormat(item, 'clip.4k.info.json'), false, 'already playing');
  assert.equal(selectFormat(item, 'nothing.info.json'), false, 'no such format');
  assert.equal(selectFormat(item, 'clip.1080p.info.json'), true);

  assert.equal(item.sourceRef, '/media/clip.1080p.info.json');
  assert.equal(item.parts[0].sourceRef, '/media/clip.1080p.info.json');
  assert.equal(item.parts[0].seekPreviewUrl, '/api/seek-preview/clip.1080p.info.json');
  assert.equal(item.quality, '1080p');
  assert.equal(item.sizeBytes, 900);
  assert.equal(currentFormat(item).label, '1080p');
  // The video's own identity is untouched, so the page stays on the video and
  // the position saved against it still belongs to it.
  assert.equal(item.id, 'clip.4k.info.json');
  assert.equal(item.parts[0].id, 'clip.4k.info.json');
});

test('a rescan keeps the format the viewer chose', () => {
  const scan = () => groupFormats([
    toMediaItem(copyRaw('clip.1080p.info.json', {width: 1920, height: 1080, filesize: 900})),
    toMediaItem(copyRaw('clip.4k.info.json', {width: 3840, height: 2160, filesize: 5000})),
  ])[0];
  const watching = scan();
  selectFormat(watching, 'clip.1080p.info.json');
  const rescanned = scan();
  assert.equal(selectFormat(rescanned, watching.archive.formatId), true);
  assert.equal(rescanned.sourceRef, '/media/clip.1080p.info.json');
  // A video with no formats to choose between is left exactly as it was.
  const single = groupFormats([toMediaItem(copyRaw('only.info.json', {width: 1280, height: 720}))])[0];
  assert.equal(selectFormat(single, undefined), false);
});

test('names a small video for its lines, not for yt-dlp format note', () => {
  const quality = (width, height, format_note) =>
    toMediaItem({_key: 'a', _serves: 'media', title: 'T', width, height, format_note}).quality;

  assert.equal(quality(854, 480, '480p+medium'), '480p');
  assert.equal(quality(640, 360, '360p, medium'), '360p');
  // The short side is the line count, so a portrait video reads as its width.
  assert.equal(quality(1080, 1920, 'source'), '1080p');
  // The ladder above 720p is unchanged.
  assert.equal(quality(3840, 2160, ''), '4K');
  assert.equal(quality(1920, 1080, ''), '1080p');
  // With no picture at all the note is all there is.
  assert.equal(quality(0, 0, 'medium'), 'medium');
});

test('the player button names the picture, the list tells copies apart', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.mp4.info.json', {width: 854, height: 480, filesize: 900,
                                               format_note: '480p+medium'})),
    toMediaItem(copyRaw('clip.webm.info.json', {width: 854, height: 480, filesize: 800,
                                                ext: 'webm', format_note: '480p+medium'})),
  ]);
  assert.deepEqual(item.archive.formats.map(entry => entry.label),
    ['480p · MP4', '480p · WEBM']);
  assert.deepEqual(item.archive.formats.map(entry => entry.shortLabel), ['480p', '480p']);
});

test('names the subtitle tracks downloaded beside a video', () => {
  const item = toMediaItem({
    _key: 'clip.info.json',
    _serves: 'media',
    title: 'A clip',
    // en-orig is yt-dlp's own tag for the uploader's language, which is not
    // BCP 47 and so has no display name to fall back on.
    _subtitles: ['en', 'pt-BR', 'en-orig'],
  });
  assert.deepEqual(item.parts[0].subtitleTracks.map(track => track.language),
    ['en', 'pt-BR', 'en-orig']);
  assert.equal(item.parts[0].subtitleTracks[0].url, '/subtitles/en/clip.info.json');
  for (const track of item.parts[0].subtitleTracks) assert.ok(track.label);
  assert.deepEqual(toMediaItem({_key: 'bare.info.json'}).parts[0].subtitleTracks, []);
});

test('a format carries its own subtitles, so switching copies swaps them', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.1080p.info.json', {
      width: 1920, height: 1080, filesize: 900,
      _subtitles: ['de'],
    })),
    toMediaItem(copyRaw('clip.4k.info.json', {
      width: 3840, height: 2160, filesize: 5000,
      _subtitles: ['en'],
    })),
  ]);
  assert.deepEqual(item.parts[0].subtitleTracks.map(track => track.language), ['en']);
  selectFormat(item, 'clip.1080p.info.json');
  assert.deepEqual(item.parts[0].subtitleTracks.map(track => track.url),
    ['/subtitles/de/clip.1080p.info.json']);
});

test('describes the picture\'s encoding so the player can ask the browser about it', () => {
  const item = toMediaItem(copyRaw('clip.info.json', {ext: 'webm', vcodec: 'av01.0.12M.08',
    acodec: 'opus', width: 3840, height: 2160, fps: 25, duration: 100, filesize: 150_000_000}));
  assert.deepEqual(item.parts[0].encoding, {name: 'AV1',
    contentType: 'video/webm; codecs="av01.0.12M.08"',
    width: 3840, height: 2160, framerate: 25, bitrate: 12_000_000});
});

test('leaves the encoding out rather than asking about one it cannot state', () => {
  const encodingOf = extra => toMediaItem(copyRaw('clip.info.json', extra)).parts[0].encoding;
  // A bare "avc1" would be refused as a codec string by a browser that plays it.
  assert.equal(encodingOf({vcodec: 'avc1'}), null);
  assert.equal(encodingOf({vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a'}), null);
  assert.equal(encodingOf({vcodec: 'avc1.640028', ext: 'mkv'}), null);
  assert.equal(encodingOf({vcodec: 'vp9', ext: 'webm'}).name, 'VP9');
});

test('switching format switches the encoding the player checks', () => {
  const [item] = groupFormats([
    toMediaItem(copyRaw('clip.av1.info.json', {width: 3840, height: 2160, filesize: 5000,
      ext: 'webm', vcodec: 'av01.0.12M.08'})),
    toMediaItem(copyRaw('clip.h264.info.json', {width: 1920, height: 1080, filesize: 900,
      vcodec: 'avc1.640028'})),
  ]);
  assert.equal(item.parts[0].encoding.name, 'AV1');
  selectFormat(item, 'clip.h264.info.json');
  assert.equal(item.parts[0].encoding.name, 'H.264');
});

test('a copy the page already knows keeps standing for its video when a better one lands', () => {
  const scan = () => [
    toMediaItem(copyRaw('clip.av1.info.json', {width: 3840, height: 2160, filesize: 5000,
      ext: 'webm', vcodec: 'av01.0.12M.08'})),
    toMediaItem(copyRaw('clip.vp9.info.json', {width: 3840, height: 2160, filesize: 9000,
      ext: 'webm', vcodec: 'vp9'})),
  ];
  // Fresh, the bigger copy stands for the video.
  assert.equal(groupFormats(scan())[0].id, 'clip.vp9.info.json');
  // Known already, the first copy keeps its place and the new one joins it.
  const [item] = groupFormats(scan(), new Set(['clip.av1.info.json']));
  assert.equal(item.id, 'clip.av1.info.json');
  assert.equal(item.archive.formatId, 'clip.av1.info.json');
  assert.deepEqual(item.archive.formats.map(format => format.id),
    ['clip.vp9.info.json', 'clip.av1.info.json']);
  // Same size and container, the two are told apart by codec, named for people.
  assert.deepEqual(item.archive.formats.map(format => format.label), ['4K · VP9', '4K · AV1']);
});

test('a video naming no one has only its source, not an unknown creator', () => {
  const item = toMediaItem({
    _key: 'Dropbox/clip.info.json',
    title: 'American-Reacts-to-The-Crystal-Maze-Original-4',
    extractor_key: 'Dropbox',
    webpage_url: 'https://www.dropbox.com/scl/fi/abc/American-Reacts-to-The-Crystal-Maze-Original-4.mp4?dl=0',
    epoch: 1790417596,
  });

  assert.deepEqual(item.facets.people, []);
  assert.equal(item.facets.owner, null);
  assert.equal(item.facets.source.id, 'dropbox');
  assert.equal(item.facets.source.name, 'Dropbox');
  assert.match(item.facets.source.icon, /\/sources\.svg#source-dropbox$/);
  // All Dropbox had for a title was the file's name.
  assert.equal(item.title, 'American Reacts to The Crystal Maze Original 4');
  // Sorted by when it arrived, but never shown as its upload date.
  assert.equal(item.mtime, 1790417596);
  assert.equal(item.archive.uploadedAt, 0);
});

test('a service with several extractors is one source', () => {
  const sourceOf = extractor_key => toMediaItem({_key: 'a', title: 'A', extractor_key}).facets.source;
  assert.equal(sourceOf('YoutubeTab').id, 'youtube');
  assert.equal(sourceOf('Youtube').name, 'YouTube');
  assert.equal(sourceOf('TwitchVod').id, 'twitch');
  assert.equal(sourceOf('Twitter').name, 'X');
  // Kick has a logo; Kickstarter is not Kick.
  assert.equal(sourceOf('KickVOD').id, 'kick');
  assert.equal(sourceOf('Kickstarter').id, 'kickstarter');
});

test('a source without a logo wears the globe', () => {
  const generic = toMediaItem({
    _key: 'clip.info.json', title: 'Clip', extractor_key: 'Generic',
    webpage_url: 'https://www.example.org/videos/clip.mp4',
  }).facets.source;
  assert.equal(generic.name, 'example.org');
  assert.match(generic.icon, /#source-unknown$/);
  const unlisted = toMediaItem({_key: 'a', title: 'A', extractor_key: 'Nebula'}).facets.source;
  assert.deepEqual([unlisted.id, unlisted.name], ['nebula', 'Nebula']);
  assert.equal(toMediaItem({_key: 'a', title: 'A'}).facets.source, null);
  // No extractor recorded, but the address is a known site's.
  const addressed = toMediaItem({
    _key: 'a', title: 'A', webpage_url: 'https://www.youtube.com/watch?v=abc',
  }).facets.source;
  assert.deepEqual([addressed.id, addressed.name], ['youtube', 'YouTube']);
});

test('a real title with hyphens in it is left alone', () => {
  const item = toMediaItem({
    _key: 'clip.info.json', title: 'Spider-Man-style stunts', uploader: 'Someone',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
  });
  assert.equal(item.title, 'Spider-Man-style stunts');
});

test('a download with no picture is audio, with no quality of its own', () => {
  const track = toMediaItem({
    _key: 'song.info.json', title: 'Song', vcodec: 'none', acodec: 'opus', format_note: 'medium',
    filepath: '/archive/song.webm',
  });
  assert.equal(track.audioOnly, true);
  assert.equal(track.quality, '');
  const video = toMediaItem({_key: 'clip.info.json', title: 'Clip', width: 1280, height: 720});
  assert.equal(video.audioOnly, false);
  // A sidecar that records no codec at all is taken for a video, as before.
  assert.equal(toMediaItem({_key: 'a', title: 'A'}).audioOnly, false);
});

test('a track keeps what a music service says about it, and only then', () => {
  const track = toMediaItem({
    _key: 'song.info.json', title: 'Song', vcodec: 'none', track: 'Song', artists: ['Band', 'Guest'],
    album: 'Record', track_number: 3, release_year: 1999,
  });
  assert.deepEqual(track.music, {track: 'Song', album: 'Record', artist: 'Band, Guest', trackNumber: 3, year: 1999});
  assert.match(track.searchPath, /record/);
  assert.equal(toMediaItem({_key: 'a', title: 'A', track: 'A', artist: 'Solo'}).music.artist, 'Solo');
  assert.equal(toMediaItem({_key: 'clip', title: 'Clip', artist: 'Someone'}).music, null);
});

test('switching to a copy with no picture makes the item audio', () => {
  const [item] = groupFormats([
    toMediaItem({_key: 'v.info.json', id: 'x', extractor_key: 'Youtube', title: 'V', width: 1920, height: 1080,
      vcodec: 'avc1.640028'}),
    toMediaItem({_key: 'a.info.json', id: 'x', extractor_key: 'Youtube', title: 'V', vcodec: 'none'}),
  ]);
  assert.equal(item.audioOnly, false);
  selectFormat(item, 'a.info.json');
  assert.equal(item.audioOnly, true);
});

test('commentsOf nests replies under their parent and drops orphans', async () => {
  const {commentsOf, sortComments} = await import('../web/item-adapter.js');
  const threads = commentsOf([
    {id: 'a', parent: 'root', text: 'first', author: '@Ann', like_count: 3, _time_text: '1 year ago (edited)'},
    {id: 'b', parent: 'root', text: 'second', author: 'Bo', timestamp: 500, is_pinned: true},
    {id: 'a.2', parent: 'a', text: 'later', timestamp: 20},
    {id: 'a.1', parent: 'a', text: 'earlier', timestamp: 10},
    {id: 'z.1', parent: 'z', text: 'orphan'},
  ]);
  assert.deepEqual(threads.map(thread => thread.id), ['a', 'b']);
  assert.equal(threads[0].author, 'Ann');
  assert.equal(threads[0].edited, true);
  assert.equal(threads[1].pinned, true);
  const [top] = sortComments(threads, 'top');
  assert.deepEqual(top.replies.map(reply => reply.id), ['a.1', 'a.2']);
  assert.deepEqual(sortComments(threads, 'newest').map(thread => thread.id), ['b', 'a']);
  assert.deepEqual(commentsOf(null), []);
});

test('a file merged from several audio tracks says how many, so the player knows to offer a choice', () => {
  const merged = {vcodec: 'avc1', acodec: 'mp4a.40.2'};
  const tracks = count => Array.from({length: count}, () => ({vcodec: 'none', acodec: 'mp4a.40.2'}));
  const part = requested => toMediaItem({_key: 'a.info.json', _serves: 'media',
    filepath: '/archive/a.mkv', title: 'A', ...(requested ? {requested_formats: requested} : {})}).parts[0];
  assert.equal(part(null).audioTrackCount, 0);
  assert.equal(part([{vcodec: 'avc1', acodec: 'none'}, ...tracks(1)]).audioTrackCount, 1);
  assert.equal(part([{vcodec: 'avc1', acodec: 'none'}, ...tracks(3)]).audioTrackCount, 3);
  assert.equal(part([merged]).audioTrackCount, 0);
});

test('builds the addresses the listing names in _serves, encoded as the server quotes a key', () => {
  // Expected values are Python's urllib.parse.quote of the key, which is how
  // the server built these addresses when it sent them whole.
  const key = '05fdda55/Ch #1/a ?b% (live)! *é* ~x.info.json';
  const href = '05fdda55/Ch%20%231/a%20%3Fb%25%20%28live%29%21%20%2A%C3%A9%2A%20~x.info.json';
  const item = toMediaItem({_key: key, _serves: 'media thumb seek sponsorblock comments details chat',
    _subtitles: ['pt-BR'], title: 'Awkward'});
  assert.equal(item.sourceRef, `/media/${href}`);
  assert.equal(item.thumbnail.url, `/thumb/${href}`);
  assert.equal(item.parts[0].seekPreviewUrl, `/api/seek-preview/${href}`);
  assert.equal(item.parts[0].subtitleTracks[0].url, `/subtitles/pt-BR/${href}`);
  assert.equal(item.archive.sponsorBlockUrl, `/api/sponsorblock/${href}`);
  assert.equal(item.archive.commentsUrl, `/api/comments/${href}`);
  assert.equal(item.archive.detailsUrl, `/api/item-details/${href}`);
  assert.equal(item.archive.chatUrl, `/api/chat/${href}`);

  // What the server has nothing to give for has no address at all.
  const bare = toMediaItem({_key: key, _serves: '', title: 'Bare'});
  assert.equal(bare.archive.downloaded, false);
  assert.deepEqual([bare.sourceRef, bare.thumbnail.url, bare.parts[0].seekPreviewUrl,
    bare.archive.sponsorBlockUrl, bare.archive.commentsUrl, bare.archive.detailsUrl, bare.archive.chatUrl],
  ['', '', '', '', '', '', '']);
});
