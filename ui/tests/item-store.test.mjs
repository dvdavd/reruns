import assert from 'node:assert/strict';
import test from 'node:test';

import {createItemStore} from '../shared/lib/store.js';

const item = (id, parts = []) => ({id, parts, facets: {}, watch: {}, session: {}});

test('a shared store accepts normalized items and indexes every source reference', () => {
  const target = item('series', [
    {id: 'one', sourceRef: '/one.mp4'},
    {id: 'two', sourceRef: '/two.mp4'},
  ]);
  const store = createItemStore([target]);
  assert.equal(store.itemForRef('series'), target);
  assert.equal(store.itemForRef('/two.mp4'), target);
  assert.equal(target.originalOrder, 0);
});

test('stores are independent and notify only their own subscribers', () => {
  const first = createItemStore([item('a')]);
  const second = createItemStore([item('b')]);
  let firstNotifications = 0;
  let secondNotifications = 0;
  first.subscribe(() => { firstNotifications += 1; });
  second.subscribe(() => { secondNotifications += 1; });

  first.updateItemAtRef('a', value => { value.favourite = true; });
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 0);
  assert.equal(second.allItems()[0].favourite, undefined);
});
