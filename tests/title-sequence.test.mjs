import assert from 'node:assert/strict';
import test from 'node:test';

import {sameSeries, titleSequence} from '../web/title-sequence.js';

const read = title => {
  const sequence = titleSequence(title);
  return sequence && {kind: sequence.kind, number: sequence.number, total: sequence.total, prefix: sequence.prefix};
};

test('reads the common ways a title numbers a run', () => {
  assert.deepEqual(read('Building a shed - Part 3 of 5'), {kind: 'part', number: 3, total: 5, prefix: 'building a shed'});
  assert.deepEqual(read('Building a shed pt.2'), {kind: 'part', number: 2, total: null, prefix: 'building a shed'});
  assert.deepEqual(read('Road trip (2/3)'), {kind: 'part', number: 2, total: 3, prefix: 'road trip'});
  assert.deepEqual(read('Road trip 2 of 3'), {kind: 'part', number: 2, total: 3, prefix: 'road trip'});
  assert.deepEqual(read('The Show Ep12: Finale'), {kind: 'episode', number: 12, total: null, prefix: 'the show'});
  assert.deepEqual(read('The Show S02E04'), {kind: 'season-episode', number: 2004, total: null, prefix: 'the show'});
  assert.deepEqual(read('The Show Season 1, Episode 10'), {kind: 'season-episode', number: 1010, total: null, prefix: 'the show'});
  assert.deepEqual(read('Saga Chapter IV'), {kind: 'chapter', number: 4, total: null, prefix: 'saga'});
  assert.deepEqual(read('Saga Part Two'), {kind: 'part', number: 2, total: null, prefix: 'saga'});
  assert.deepEqual(read('Devlog #7'), {kind: 'number', number: 7, total: null, prefix: 'devlog'});
  // Accents are set aside first, so the French spelling reads the same.
  assert.deepEqual(read('Épisode 3 — café'), {kind: 'episode', number: 3, total: null, prefix: ''});
});

test('leaves alone titles that only look numbered', () => {
  for (const title of ['Part of the plan', 'Partial eclipse 2024', 'Chi 2 review', 'No 2 people agree',
    'Released 3/5', 'Top 10 tips', 'Part in the middle', 'Part 6 of 5', 'Epic 3']) {
    assert.equal(titleSequence(title), null, title);
  }
});

test('parts of one series match, and other runs do not', () => {
  const part3 = titleSequence('Building a shed - Part 3 of 5');
  assert.ok(sameSeries(part3, titleSequence('Building a shed - Part 4 of 5: the roof')));
  assert.ok(sameSeries(part3, titleSequence('Building a shed pt 1')));
  assert.ok(sameSeries(titleSequence('Part 2: building a shed'), titleSequence('Part 3 - building a shed')));
  assert.ok(!sameSeries(part3, titleSequence('Building a shed - Part 3 of 5')), 'a copy is not another part');
  assert.ok(!sameSeries(part3, titleSequence('Building a shed - Part 4 of 6')));
  assert.ok(!sameSeries(part3, titleSequence('Building a shed - Day 4')));
  assert.ok(!sameSeries(part3, titleSequence('Fixing a bike - Part 4')));
  assert.ok(!sameSeries(part3, null));
});
