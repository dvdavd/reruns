import {readStyles} from './styles-source.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {creatorOf, creatorsFrom} from '../web/creator-shelf.js';

const video = (name, mtime, {id = '', person = ''} = {}) => ({
  mtime,
  facets: {
    owner: name ? {id, name} : null,
    people: person ? [{id: '', name: person}] : [],
  },
});

test('a creator is the channel, or the uploader when there is no channel', () => {
  assert.deepEqual(creatorOf(video('Blender', 1, {id: 'UC1'})),
                   {id: 'UC1', name: 'Blender', channelId: 'UC1'});
  assert.deepEqual(creatorOf(video('', 1, {person: 'A Guest'})),
                   {id: 'A Guest', name: 'A Guest', channelId: ''});
  assert.equal(creatorOf(video('', 1)), null);
  assert.equal(creatorOf(undefined), null);
});

test('creators are ordered by their most recent video', () => {
  const items = [
    video('Old Channel', 300, {id: 'UC-old'}),
    video('Busy Channel', 100, {id: 'UC-busy'}),
    video('Busy Channel', 900, {id: 'UC-busy'}),
    video('Busy Channel', 200, {id: 'UC-busy'}),
    video('Quiet Channel', 500, {id: 'UC-quiet'}),
  ];
  assert.deepEqual(creatorsFrom(items).map(creator => [creator.name, creator.count]),
                   [['Busy Channel', 3], ['Quiet Channel', 1], ['Old Channel', 1]]);
  assert.equal(creatorsFrom(items)[0].latestAt, 900);
});

test('videos are grouped by channel id, not by name', () => {
  const creators = creatorsFrom([
    video('Same Name', 10, {id: 'UC1'}),
    video('Same Name', 20, {id: 'UC2'}),
  ]);
  assert.equal(creators.length, 2);
  assert.deepEqual(creators.map(creator => creator.id), ['UC2', 'UC1']);
});

test('a channel id found in only one sidecar still reaches the shelf', () => {
  const [creator] = creatorsFrom([
    {mtime: 10, facets: {owner: {id: 'UC1', name: 'Blender'}}},
    {mtime: 20, facets: {owner: {id: 'UC1', name: 'Blender'}}},
  ]);
  assert.equal(creator.channelId, 'UC1');
});

test('a channel carries where it lives, so namesakes on two sites tell apart', () => {
  const youtube = {id: 'youtube', name: 'YouTube', icon: '/sources.svg#source-youtube'};
  const twitch = {id: 'twitch', name: 'Twitch', icon: '/sources.svg#source-twitch'};
  const creators = creatorsFrom([
    {mtime: 20, facets: {owner: {id: 'UCashens', name: 'Ashens'}, source: youtube}},
    {mtime: 10, facets: {owner: {id: 'ashens', name: 'Ashens'}, source: twitch}},
  ]);
  assert.deepEqual(creators.map(creator => creator.source.id), ['youtube', 'twitch']);
  // A channel whose first video named no source takes it from the next.
  const [late] = creatorsFrom([
    {mtime: 20, facets: {owner: {id: 'UC1', name: 'Blender'}}},
    {mtime: 10, facets: {owner: {id: 'UC1', name: 'Blender'}, source: youtube}},
  ]);
  assert.equal(late.source.id, 'youtube');
});

test('undated videos sort last and equal creators sort by name', () => {
  const creators = creatorsFrom([
    video('Undated', 0, {id: 'UC0'}),
    video('Beta', 100, {id: 'UCb'}),
    video('Alpha', 100, {id: 'UCa'}),
  ]);
  assert.deepEqual(creators.map(creator => creator.name), ['Alpha', 'Beta', 'Undated']);
});

test('an item with no date at all still counts', () => {
  const [creator] = creatorsFrom([{facets: {owner: {id: 'UC1', name: 'Blender'}},
                                   archive: {uploadedAt: 42}}]);
  assert.deepEqual([creator.count, creator.latestAt], [1, 42]);
});

test('an empty archive has no creators', () => {
  assert.deepEqual(creatorsFrom([]), []);
  assert.deepEqual(creatorsFrom(undefined), []);
});

test('a creator card is tinted by its own portrait', async () => {
  const {readFile} = await import('node:fs/promises');
  const source = await readFile('web/creator-shelf.js', 'utf8');
  const styles = await readStyles();
  // The portrait is square, so it is sampled square rather than at 16:9.
  assert.match(source, /accentOf\(image, 32, 32\)/);
  assert.match(source, /setProperty\('--card-accent', accent\)/);
  assert.match(styles, /\.creator-shelf-card \{[^}]*--card-accent/);
});

test('the home shelf shows only favourite channels', async () => {
  const {shelfCreators} = await import('../web/creator-shelf.js');
  const creators = creatorsFrom([
    video('New', 300, {id: 'UC-new'}),
    video('Mid', 200, {id: 'UC-mid'}),
    video('Old', 100, {id: 'UC-old'}),
  ]);
  const favourites = new Set(['UC-old']);
  assert.deepEqual(shelfCreators(creators, favourites).map(c => c.name), ['Old']);
  // With nothing favourited the shelf still offers the most recent.
  assert.deepEqual(shelfCreators(creators, new Set()).map(c => c.name), ['New', 'Mid', 'Old']);
});

test('the channels view lists creators alphabetically', async () => {
  const {alphabetical} = await import('../web/creator-shelf.js');
  const creators = creatorsFrom([
    video('beta', 300, {id: 'b'}),
    video('Älpha', 200, {id: 'a'}),
    video('Gamma 10', 100, {id: 'g10'}),
    video('Gamma 9', 50, {id: 'g9'}),
  ]);
  assert.deepEqual(alphabetical(creators).map(c => c.name), ['Älpha', 'beta', 'Gamma 9', 'Gamma 10']);
});
