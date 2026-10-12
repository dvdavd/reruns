import test from 'node:test';
import assert from 'node:assert/strict';

import {browseProfileOptions, downloadBody, grantedLocationChoices, locationChoices, profileLabel, profileMenuItems, profilesSummary, resolveSelection,
        suggestedCodec}
  from '../web/download-profiles.js';

const music = {id: 'a1', name: 'Music', library: 'lib1',
  options: {media: 'audio', container: 'flac', subdirectory: 'Music/%(artist)s'}};
const libraries = [{id: 'lib1', path: '/mnt/music'}];

test('a profile reads as what it fetches and where it lands', () => {
  assert.equal(profileLabel(music, libraries),
    'Audio · FLAC · Default filename layout · Music/%(artist)s · /mnt/music');
});

test('audio profiles do not claim a resolution', () => {
  assert.ok(!profileLabel({options: {media: 'audio', quality: '1080'}}).includes('1080'));
  assert.ok(profileLabel({options: {media: 'video', quality: '1080'}}).includes('1080p'));
});

test('the summary counts profiles the way the folders drawer counts folders', () => {
  assert.equal(profilesSummary([]), 'No profiles yet');
  assert.equal(profilesSummary([music]), '1 profile');
  assert.equal(profilesSummary([music, music]), '2 profiles');
});

test('the menu leads with the starred profile, marked as the default, and ends in manual', () => {
  const small = {id: 'b2', name: '720p'};
  const items = profileMenuItems([music, small], 'b2');
  assert.deepEqual(items.map(item => item.value), ['', 'a1', 'manual']);
  assert.deepEqual(items.map(item => item.label), ['720p', 'Music', 'Manual overrides…']);
  assert.equal(items[0].detail, 'Default');
  assert.equal(items[1].detail, '');
  // The starred profile is listed once: picking it by name would only be the
  // default with the channel's own profile switched off.
  assert.equal(items.filter(item => item.label === '720p').length, 1);
  assert.equal(profileMenuItems([], '').at(-1).value, 'manual');
});

test('a profile deleted elsewhere hands the choice back to the default', () => {
  assert.equal(resolveSelection('a1', [music], 'b2'), 'a1');
  assert.equal(resolveSelection('gone', [music], 'a1'), '');
  assert.equal(resolveSelection('manual', []), 'manual');
  // The starred profile chosen by id is the default, however it was stored.
  assert.equal(resolveSelection('a1', [music], 'a1'), '');
});

test('manual sends its options, every other choice sends a name', () => {
  const readOptions = () => ({media: 'video'});
  assert.deepEqual(downloadBody('https://x.test/a', 'manual', readOptions),
    {url: 'https://x.test/a', options: {media: 'video'}});
  assert.deepEqual(downloadBody('https://x.test/a', 'a1', readOptions),
    {url: 'https://x.test/a', profile: 'a1'});
  assert.deepEqual(downloadBody('https://x.test/a', '', readOptions),
    {url: 'https://x.test/a', profile: ''});
});

test('a profile names the subtitle languages it asks for', () => {
  const label = options => profileLabel({options: {media: 'video', ...options}});
  assert.ok(!label({subtitles: 'none'}).includes('Subtitles'));
  assert.ok(label({subtitles: 'manual'}).includes('Subtitles (en.*)'));
  assert.ok(label({subtitles: 'manual', subtitle_languages: 'en.*,fr'})
    .includes('Subtitles (en.*,fr)'));
  // Empty is every language, which is not worth a parenthesis.
  assert.ok(label({subtitles: 'manual', subtitle_languages: ''}).includes('· Subtitles ·'));
});

test('a profile names the audio languages it keeps, and says nothing when it has none', () => {
  assert.ok(profileLabel({options: {media: 'video', audio_languages: 'de'}}).includes('de audio'));
  assert.ok(profileLabel({options: {media: 'video', audio_languages: 'en,de'}}).includes('en, de audio'));
  assert.ok(profileLabel({options: {media: 'audio', audio_languages: 'de'}}).includes('de audio'));
  assert.ok(!profileLabel({options: {media: 'video'}}).includes('audio'));
});

test('a preferred codec is named, and never on audio', () => {
  assert.ok(profileLabel({options: {codec: 'vp9'}}).includes('VP9'));
  assert.ok(!profileLabel({options: {codec: 'any'}}).includes('AV1'));
  assert.ok(!profileLabel({options: {media: 'audio', codec: 'h264'}}).includes('H.264'));
});

test('suggests the first codec the browser will play, and nothing when it plays none', () => {
  const plays = (...codecs) => type => (codecs.some(codec => type.includes(codec)) ? 'probably' : '');
  assert.deepEqual(suggestedCodec(plays('vp09', 'avc1')), {codec: 'vp9', name: 'VP9'});
  assert.deepEqual(suggestedCodec(plays('avc1')), {codec: 'h264', name: 'H.264'});
  assert.equal(suggestedCodec(plays()), null);
});

test("browse offers the profiles with the default marked, and no manual overrides", () => {
  const small = {id: 'b2', name: '720p'};
  assert.deepEqual(browseProfileOptions([music, small], 'b2'), [
    {value: '', label: '720p', detail: 'Default'}, {value: 'a1', label: 'Music', detail: ''}]);
  assert.deepEqual(browseProfileOptions([], ''), [{value: '', label: 'Default'}]);
});

test('a folder is sent only when one was chosen', () => {
  assert.deepEqual(downloadBody('https://x.test/a', '', () => ({}), 'lib1/Music/'),
    {url: 'https://x.test/a', profile: '', location: 'lib1/Music/'});
});

test('the location choices put the default first and offer the current view', () => {
  const rows = [{key: 'lib1/Music/', name: 'Music', depth: 1}];
  assert.deepEqual(locationChoices(rows, '').map(choice => choice.label),
    ['Profile Default', 'Music']);
  assert.deepEqual(locationChoices(rows, 'lib1/Music/').map(choice => choice.label),
    ['Profile Default', 'Current view (Music)', 'Music']);
});

test('restricted locations contain only explicit grants, even for empty folders', () => {
  const grants = [{library: 'shared', folder: 'Sub Folder'},
    {library: 'empty', folder: ''}, {library: 'removed', folder: ''}];
  const choices = grantedLocationChoices(grants, [
    {id: 'private', path: 'private', downloads: true},
    {id: 'shared', path: 'videos'}, {id: 'empty', path: 'empty-library'},
  ]);
  assert.deepEqual(choices.map(choice => choice.label), ['Sub Folder', 'empty-library']);
  assert.deepEqual(choices.map(choice => JSON.parse(choice.value)), grants.slice(0, 2));
  assert.deepEqual(grantedLocationChoices([], libraries), []);
});

test('manual defaults and granted folder labels stay compact without changing destinations', () => {
  assert.deepEqual(locationChoices([], '', 'Default'), [{value: '', label: 'Default'}]);
  const granted = grantedLocationChoices([{library: 'lib1', folder: 'Shared'}], libraries);
  assert.equal(granted[0].label, 'Shared');
  assert.deepEqual(JSON.parse(granted[0].value), {library: 'lib1', folder: 'Shared'});
  assert.equal(grantedLocationChoices([{library: 'lib1', folder: ''}], libraries)[0].label, 'music');
});
