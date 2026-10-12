import assert from 'node:assert/strict';
import test from 'node:test';
import {BATCH, fetchPlan, fetchable} from '../web/orphans-ui.js';

const entry = (key, videoId = 'abcdefghijk') => ({key, videoId});

test('only files whose name holds an id, and that have not failed, are fetchable', () => {
  const found = [entry('a'), entry('b', ''), entry('c')];
  assert.deepEqual(fetchable(found).map(e => e.key), ['a', 'c']);
  assert.deepEqual(fetchable(found, new Set(['a'])).map(e => e.key), ['c']);
});

test('fetch-all asks only above the batch size, and offers the first batch', () => {
  const few = Array.from({length: BATCH}, (_, i) => entry(String(i)));
  assert.equal(fetchPlan(few).ask, false);
  const many = [...few, entry('extra')];
  const plan = fetchPlan(many);
  assert.equal(plan.ask, true);
  assert.equal(plan.first.length, BATCH);
  assert.equal(plan.all.length, BATCH + 1);
});
