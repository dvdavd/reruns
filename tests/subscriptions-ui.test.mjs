import test from 'node:test';
import assert from 'node:assert/strict';

import {subscriptionStatus} from '../web/subscriptions-ui.js';

test('a check that has moved on to fetching says it is downloading', () => {
  const item = {state: 'ready', checking: true, downloading: false, enabled: true, nextCheckAt: 7200};
  assert.equal(subscriptionStatus(item, 1000).text, 'Checking now…');
  assert.equal(subscriptionStatus({...item, downloading: true}, 1000).text, 'Downloading new videos…');
});

test('a failed check shows its result instead of only the next check time', () => {
  const item = {state: 'ready', checking: false, enabled: true,
    nextCheckAt: 7200, lastCheckFailed: true, lastResult: 'HTTP Error 429'};
  assert.deepEqual(subscriptionStatus(item, 1000), {
    text: 'Check failed: HTTP Error 429', clock: false, error: true,
  });
  assert.deepEqual(subscriptionStatus({...item, lastCheckFailed: false}, 1000), {
    text: '2 h', clock: true, error: false,
  });
});
