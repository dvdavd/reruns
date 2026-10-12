import assert from 'node:assert/strict';
import test from 'node:test';
import {nextRepeat, shuffleOrder, stepFrom} from '../web/track-order.js';

const run = ['a', 'b', 'c', 'd'].map(id => ({id}));

test('repeat cycles off, all, one and round', () => {
  assert.deepEqual(['off', 'all', 'one'].map(nextRepeat), ['all', 'one', 'off']);
});

test('a shuffle starts at the playing track and holds every track once', () => {
  const order = shuffleOrder(run, 'c', null, () => 0);
  assert.equal(order[0].id, 'c');
  assert.deepEqual(order.map(entry => entry.id).sort(), ['a', 'b', 'c', 'd']);
});

test('a shuffle is kept while the run is the same, and redone when it is not', () => {
  const order = shuffleOrder(run, 'a');
  assert.equal(shuffleOrder(run, 'b', order), order);
  assert.notEqual(shuffleOrder(run.slice(1), 'b', order), order);
});

test('stepping stops at the ends unless the whole run repeats', () => {
  assert.equal(stepFrom(run, 'd', 1), null);
  assert.equal(stepFrom(run, 'a', -1), null);
  assert.equal(stepFrom(run, 'd', 1, 'one'), null);
  assert.equal(stepFrom(run, 'd', 1, 'all').id, 'a');
  assert.equal(stepFrom(run, 'a', -1, 'all').id, 'd');
  assert.equal(stepFrom(run, 'b', 1).id, 'c');
});
