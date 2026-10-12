import assert from 'node:assert/strict';
import test from 'node:test';
import {channelKey, playlistSubscribeUrl, subscriptionTarget} from '../web/subscription-target.js';

const video = (archive, facets) => ({archive, facets});

test('custom playlists have no external browse or subscription address', () => {
  assert.equal(playlistSubscribeUrl({id: 'manual:1', manual: true}), '');
  assert.equal(playlistSubscribeUrl({id: 'manual:1', manual: true, url: 'https://example.com/playlist'}), '');
  assert.equal(playlistSubscribeUrl({id: 'PL1'}), 'https://www.youtube.com/playlist?list=PL1');
  assert.equal(playlistSubscribeUrl({id: 'PL1', url: 'https://example.com/playlist'}), 'https://example.com/playlist');
});

test('a playlist opens by its list id', () => {
  const items = [video({playlist: {id: 'PL1', title: 'England'}}, {owner: null, collections: []})];
  assert.deepEqual(subscriptionTarget({kind: 'playlist', url: 'https://www.youtube.com/playlist?list=PL1'}, items),
    {kind: 'playlist', target: {id: 'PL1', name: 'England'}});
  assert.equal(subscriptionTarget({kind: 'playlist', url: 'https://www.youtube.com/playlist?list=PL2'}, items), null);
});

test('a channel matches the addresses its videos recorded, ignoring the tab', () => {
  const items = [video({channelUrls: ['https://www.youtube.com/channel/UC9', 'https://www.youtube.com/@Someone']},
    {owner: {id: 'UC9', name: 'Someone'}})];
  const expected = {kind: 'channel', target: {id: 'UC9', name: 'Someone'}};
  assert.deepEqual(subscriptionTarget({kind: 'channel', url: 'https://www.youtube.com/@someone/videos'}, items), expected);
  assert.deepEqual(subscriptionTarget({kind: 'channel', url: 'https://youtube.com/channel/UC9/videos'}, items), expected);
  assert.equal(subscriptionTarget({kind: 'channel', url: 'https://www.youtube.com/@other/videos'}, items), null);
  assert.equal(channelKey('https://m.youtube.com/@A/streams'), 'youtube.com/@a');
});

test('a channel page finds a subscription made from any of its addresses', async () => {
  const {channelSubscriptionIdFor} = await import('../web/subscription-target.js');
  const items = [video({channelUrls: ['https://www.youtube.com/channel/UCd6', 'https://www.youtube.com/@SAMTIME']},
    {owner: {id: 'UCd6', name: 'SAMTIME'}})];
  const find = subscriptions => channelSubscriptionIdFor(subscriptions, items);
  // Added by hand from the @handle, while the page offers the /channel/ address.
  assert.equal(find([{id: 'a', kind: 'channel', url: 'https://www.youtube.com/@SAMTIME/videos'}]), 'a');
  assert.equal(find([{id: 'b', kind: 'channel', url: 'https://www.youtube.com/channel/UCd6/videos'}]), 'b');
  // Or known only by the id its first listing reported.
  assert.equal(find([{id: 'c', kind: 'channel', url: 'https://www.youtube.com/c/Old/videos', channelId: 'UCd6'}]), 'c');
  assert.equal(find([{id: 'd', kind: 'channel', url: 'https://www.youtube.com/@other/videos'},
    {id: 'e', kind: 'playlist', url: 'https://www.youtube.com/playlist?list=UCd6'}]), null);
  assert.equal(channelSubscriptionIdFor([{id: 'f', kind: 'channel', url: 'https://x.test/c/1', channelId: 'UC7'}],
    [], 'UC7'), 'f');
});
