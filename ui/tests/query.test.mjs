import assert from 'node:assert/strict';
import test from 'node:test';
import {filterItems, sortItems} from '../shared/lib/query.js';

const video = {
  id: 'space', title: 'Exploring Mars',
  facets: {
    owner: {name: 'Science Channel'},
    people: [{id: 'host', name: 'Alice Smith'}],
    collections: [{id: 'space', name: 'Space Adventures'}],
  },
};

test('search combines title and channel words in either order', () => {
  for (const query of ['Mars Science Channel', 'channel mars', '  SCIENCE\tMars  ']) {
    assert.deepEqual(filterItems([video], {query}), [video]);
  }
  assert.deepEqual(filterItems([video], {query: 'Mars missing'}), []);
});

test('search combines creator and playlist words with titles', () => {
  assert.deepEqual(filterItems([video], {query: 'alice mars adventures'}), [video]);
  assert.deepEqual(filterItems([video], {query: 'mars alice missing'}), []);
  assert.deepEqual(filterItems([video], {query: '   '}), [video]);
});

test('exact facet and favourite filters still apply', () => {
  assert.deepEqual(filterItems([video], {exactPerson: {id: 'host'}}), [video]);
  assert.deepEqual(filterItems([video], {exactCollection: {id: 'other'}}), []);
  assert.deepEqual(filterItems([video], {query: 'mars science', favouriteItems: true}), []);
});

test('sorting by name ignores case and accents, and counts numbers by value', () => {
  const titles = ['Part 10', 'part 2', 'Éclair', 'apple', 'Part 1'];
  const sorted = sortItems(titles.map((title, index) => ({id: String(index), title})), {mode: 'name'});
  assert.deepEqual(sorted.map(item => item.title), ['apple', 'Éclair', 'Part 1', 'part 2', 'Part 10']);
  const reversed = sortItems(sorted, {mode: 'name', direction: 'desc'});
  assert.deepEqual(reversed.map(item => item.title), ['Part 10', 'part 2', 'Part 1', 'Éclair', 'apple']);
});
