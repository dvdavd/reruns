import assert from 'node:assert/strict';
import test from 'node:test';
import {filterItems} from '../shared/lib/query.js';

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
