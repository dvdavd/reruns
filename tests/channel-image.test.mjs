import assert from 'node:assert/strict';
import test from 'node:test';

import {channelIdOf, createChannelImages, loadChannelImage} from '../web/channel-image.js';

const nowait = async () => {};

test('channelIdOf reads the adapted owner facet', () => {
  assert.equal(channelIdOf({facets: {owner: {id: 'UC1', name: 'Blender'}}}), 'UC1');
  assert.equal(channelIdOf({facets: {owner: null}}), '');
  assert.equal(channelIdOf(undefined), '');
});

test('a ready state resolves to the picture', async () => {
  const url = await loadChannelImage('UC1', {
    fetchState: async () => ({state: 'ready', imageUrl: '/channel-image/abc/image.jpg'}),
    wait: nowait,
  });
  assert.equal(url, '/channel-image/abc/image.jpg');
});

test('polls while the server is still fetching', async () => {
  const states = [{state: 'queued', retryAfterMs: 1}, {state: 'running', retryAfterMs: 1},
                  {state: 'ready', imageUrl: '/channel-image/abc/image.png'}];
  let calls = 0;
  const url = await loadChannelImage('UC1', {
    fetchState: async () => { calls += 1; return states.shift(); },
    wait: nowait,
  });
  assert.equal(calls, 3);
  assert.equal(url, '/channel-image/abc/image.png');
});

test('a failure and a request error both resolve to no picture', async () => {
  assert.equal(await loadChannelImage('UC1', {
    fetchState: async () => ({state: 'failed', error: 'gone'}), wait: nowait,
  }), '');
  assert.equal(await loadChannelImage('UC1', {
    fetchState: async () => { throw new Error('404'); }, wait: nowait,
  }), '');
  assert.equal(await loadChannelImage('', {
    fetchState: async () => assert.fail('should not ask'), wait: nowait,
  }), '');
});

test('each channel is looked up once per page', async () => {
  const asked = [];
  const images = createChannelImages({
    fetchState: async id => { asked.push(id); return {state: 'ready', imageUrl: `/i/${id}`}; },
    wait: nowait,
  });
  assert.deepEqual(await Promise.all([images('UC1'), images('UC1'), images('UC2')]),
                   ['/i/UC1', '/i/UC1', '/i/UC2']);
  assert.equal(await images('UC1'), '/i/UC1');
  assert.deepEqual(asked, ['UC1', 'UC2']);
});
