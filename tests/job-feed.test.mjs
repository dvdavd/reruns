import assert from 'node:assert/strict';
import test from 'node:test';
import {createJobFeed, mergeJobChanges} from '../web/job-feed.js';

const full = {since: 'e.1', full: true, order: ['a', 'b'], jobs: [
  {id: 'a', state: 'running', itemIds: ['1', '2'], items: [{id: '1', percent: 0}, {id: '2', percent: 0}]},
  {id: 'b', state: 'done', itemIds: [], items: []},
]};

test('a moving video replaces only its own row', () => {
  const known = mergeJobChanges([], full);
  const next = mergeJobChanges(known, {since: 'e.2', full: false, order: ['a', 'b'], jobs: [
    {id: 'a', items: [{id: '2', percent: 40}]}, {id: 'b', unchanged: true}]});
  assert.deepEqual(next[0].items, [{id: '1', percent: 0}, {id: '2', percent: 40}]);
  assert.equal(next[0].state, 'running');
  assert.equal(next[1], known[1]);
});

test('a changed job takes its new fields and order, and cleared jobs go', () => {
  const known = mergeJobChanges([], full);
  const next = mergeJobChanges(known, {since: 'e.3', full: false, order: ['a'], jobs: [
    {id: 'a', state: 'done', itemIds: ['2', '3'], items: [{id: '3', percent: 100}]}]});
  assert.deepEqual(next, [{id: 'a', state: 'done', items: [{id: '2', percent: 0}, {id: '3', percent: 100}]}]);
});

test('the feed sends back the token it was given, and shares a poll already on its way', async () => {
  const asked = [];
  const answers = [full, {since: 'e.1', full: false, order: ['a', 'b'],
    jobs: [{id: 'a', unchanged: true}, {id: 'b', unchanged: true}]}];
  const feed = createJobFeed(async path => { asked.push(path); return answers.shift(); });
  const [one, two] = await Promise.all([feed.read(), feed.read()]);
  assert.equal(one, two);
  const jobs = await feed.read();
  assert.deepEqual(asked, ['/api/jobs?since=', '/api/jobs?since=e.1']);
  assert.equal(jobs.length, 2);
});
