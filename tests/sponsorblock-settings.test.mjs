import assert from 'node:assert/strict';
import test from 'node:test';

import {loadCategoryActions, loadChannelOverrides, loadSponsorBlockEnabled, saveCategoryActions,
        saveChannelOverrides, saveSponsorBlockEnabled, segmentActionAt,
        sponsorBlockEnabledFor} from '../web/sponsorblock-settings.js';

function memoryStorage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
}

test('category actions survive a round trip and junk loads as none', () => {
  const storage = memoryStorage();
  assert.deepEqual([...loadCategoryActions(storage)], []);
  saveCategoryActions(new Map([
    ['sponsor', {mode: 'skip'}],
    ['intro', {mode: 'fast', speed: 4}],
    ['outro', {mode: 'notify'}],
    ['filler', {mode: 'play'}],
  ]), storage);
  assert.deepEqual([...loadCategoryActions(storage)], [
    ['sponsor', {mode: 'skip'}],
    ['intro', {mode: 'fast', speed: 4}],
    ['outro', {mode: 'notify'}],
  ]);
  storage.setItem('ytdlp-sponsorblock-actions-v1', '{not json');
  assert.deepEqual([...loadCategoryActions(storage)], []);
});

test('a speed the list does not offer falls back to 2x', () => {
  const storage = memoryStorage();
  storage.setItem('ytdlp-sponsorblock-actions-v1',
    JSON.stringify({sponsor: {mode: 'fast', speed: 97}}));
  assert.deepEqual(loadCategoryActions(storage).get('sponsor'), {mode: 'fast', speed: 2});
});

test('categories skipped before there were modes are read as skips', () => {
  const storage = memoryStorage();
  storage.setItem('ytdlp-sponsorblock-skip-v1', JSON.stringify(['sponsor', 'intro']));
  assert.deepEqual([...loadCategoryActions(storage)], [
    ['sponsor', {mode: 'skip'}],
    ['intro', {mode: 'skip'}],
  ]);
  // Once modes are saved the old list is ignored, deletions included.
  saveCategoryActions(new Map([['sponsor', {mode: 'skip'}]]), storage);
  assert.deepEqual([...loadCategoryActions(storage)], [['sponsor', {mode: 'skip'}]]);
});

test('only a segment with an action under the playhead is acted on', () => {
  const segments = [{category: 'intro', start: 0, end: 10}, {category: 'sponsor', start: 30, end: 60}];
  const actions = new Map([['sponsor', {mode: 'fast', speed: 3}]]);
  assert.equal(segmentActionAt(segments, 5, actions), null);
  assert.deepEqual(segmentActionAt(segments, 30, actions),
    {segment: segments[1], mode: 'fast', speed: 3});
  assert.equal(segmentActionAt(segments, 59.9, actions), null);
  assert.equal(segmentActionAt(segments, 60, actions), null);
  assert.equal(segmentActionAt(segments, 30, new Map([['sponsor', {mode: 'play'}]])), null);
});

test('SponsorBlock is on until switched off', () => {
  const storage = memoryStorage();
  assert.equal(loadSponsorBlockEnabled(storage), true);
  saveSponsorBlockEnabled(false, storage);
  assert.equal(loadSponsorBlockEnabled(storage), false);
  saveSponsorBlockEnabled(true, storage);
  assert.equal(loadSponsorBlockEnabled(storage), true);
});

test('channel overrides win over the global default and survive a round trip', () => {
  const storage = memoryStorage();
  const overrides = new Map([['UC123', {enabled: false, name: 'A channel'}]]);
  saveChannelOverrides(overrides, storage);
  const loaded = loadChannelOverrides(storage);
  assert.deepEqual([...loaded], [...overrides]);
  assert.equal(sponsorBlockEnabledFor('UC123', true, loaded), false);
  assert.equal(sponsorBlockEnabledFor('UC999', true, loaded), true);
});
