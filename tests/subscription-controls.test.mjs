import assert from 'node:assert/strict';
import test from 'node:test';

import {backlogFrom, shortInterval, choiceFor, profileChoices, subscriptionOwnsProfile, subscriptionProfileName}
  from '../web/subscription-controls.js';

test('the backlog choice reads as all, none or a count', () => {
  assert.equal(backlogFrom('all'), true);
  assert.equal(backlogFrom('new'), false);
  assert.equal(backlogFrom('10'), 10);
});

test('a frequency reads as a short pill', () => {
  assert.equal(shortInterval(1), 'Hourly');
  assert.equal(shortInterval(6), '6h');
  assert.equal(shortInterval(168), 'Weekly');
});

test('only a subscription on Default follows its channel\'s profile', () => {
  assert.equal(subscriptionOwnsProfile(null), false);
  assert.equal(subscriptionOwnsProfile({profileSelection: '', useChannelProfile: true}), false);
  assert.equal(subscriptionOwnsProfile({profileSelection: 'abc', useChannelProfile: false}), true);
  // Made before channel profiles: its saved settings decide, not the channel.
  assert.equal(subscriptionOwnsProfile({}), true);
});

test('a subscription\'s profile is named as its menu names it', () => {
  const profiles = [{id: 'abc', name: '1080p'}];
  assert.equal(subscriptionProfileName({profileSelection: ''}, profiles, 'abc'), '1080p');
  assert.equal(subscriptionProfileName({profileSelection: ''}, [], ''), 'Default');
  assert.equal(subscriptionProfileName({profileSelection: 'abc'}, profiles), '1080p');
  assert.equal(subscriptionProfileName({profileSelection: 'gone'}, profiles), 'Saved settings');
  assert.equal(subscriptionProfileName({}, profiles), 'Current settings');
});

test('subscription menus list the starred profile once, first, marked as the default', () => {
  const profiles = [{id: 'a', name: 'Best quality'}, {id: 'b', name: '720p'}];
  assert.deepEqual(profileChoices(profiles, 'b').map(choice => [choice.id, choice.name, choice.detail ?? '']),
    [['', '720p', 'Default'], ['a', 'Best quality', '']]);
  assert.deepEqual(profileChoices([], ''), [{id: '', name: 'Default'}]);
  // A selection saved as the starred id is the default now.
  assert.equal(choiceFor('b', 'b'), '');
  assert.equal(choiceFor('a', 'b'), 'a');
  assert.equal(choiceFor('manual', 'b'), 'manual');
});
