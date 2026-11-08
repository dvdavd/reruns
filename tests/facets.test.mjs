import assert from 'node:assert/strict';
import test from 'node:test';

import {applyFacetParams, facetFromParams, facetName, matchesFacet} from '../web/facets.js';
import {toMediaItem} from '../web/item-adapter.js';

// yt-dlp names a playlist "show" when a legacy /show/VL… URL gives it nothing
// better, so these fixtures are the archive's real worst case: a playlist, a
// channel and an uploader whose names are words that appear in other titles.
const inPlaylist = toMediaItem({
  _key: 'a', _serves: 'media', title: 'These people walk towards mining disasters.',
  channel: 'Tom Scott', channel_id: 'UCBa659', uploader: 'Tom Scott',
  playlist: 'show', playlist_id: 'show', playlist_index: 4,
});
const elsewhere = toMediaItem({
  _key: 'b', _serves: 'media', title: 'The Harry Hill Show - Matt Baker',
  channel: 'HARRY HILL', channel_id: 'UCharry',
});
const guest = toMediaItem({
  _key: 'c', _serves: 'media', title: 'A guest spot',
  channel: 'Tom Scott', channel_id: 'UCBa659', uploader: 'Matt Gray',
  uploader_id: 'UCmatt',
});
const items = [inPlaylist, elsewhere, guest];
const idsMatching = facet => items.filter(item => matchesFacet(item, facet)).map(item => item.id);

test('a playlist filter matches its id, not every title containing its name', () => {
  assert.deepEqual(idsMatching({kind: 'playlist', id: 'show'}), ['a']);
});

test('a channel filter matches its id, so a guest video comes with it', () => {
  assert.deepEqual(idsMatching({kind: 'channel', id: 'UCBa659'}), ['a', 'c']);
});

test('a creator filter matches the uploader, not the channel they posted to', () => {
  assert.deepEqual(idsMatching({kind: 'creator', id: 'UCmatt'}), ['c']);
  // An uploader who is the channel gets no separate chip, so nothing matches.
  assert.deepEqual(idsMatching({kind: 'creator', id: 'Tom Scott'}), []);
});

test('no filter is the whole archive, and an unknown id is none of it', () => {
  assert.deepEqual(idsMatching(null), ['a', 'b', 'c']);
  assert.deepEqual(idsMatching({kind: 'playlist', id: 'PLmissing'}), []);
});

test('a filter names itself from the items it matches', () => {
  assert.equal(facetName({kind: 'playlist', id: 'show', name: ''}, items), 'show');
  assert.equal(facetName({kind: 'channel', id: 'UCBa659', name: ''}, items), 'Tom Scott');
  // A name already in hand wins, so a click labels the box before the scan.
  assert.equal(facetName({kind: 'channel', id: 'UCBa659', name: 'Given'}, items), 'Given');
  assert.equal(facetName({kind: 'playlist', id: 'PLmissing', name: ''}, items), '');
  assert.equal(facetName(null, items), '');
});

test('a filter round-trips through the URL, one chip at a time', () => {
  const url = new URL('https://archive.test/?q=bell');
  applyFacetParams(url, {kind: 'playlist', id: 'show'});
  assert.equal(url.search, '?q=bell&playlist=show');
  assert.deepEqual(facetFromParams(url.searchParams),
    {kind: 'playlist', id: 'show', name: ''});

  applyFacetParams(url, {kind: 'channel', id: 'UCBa659'});
  assert.equal(url.search, '?q=bell&channel=UCBa659');

  applyFacetParams(url, null);
  assert.equal(url.search, '?q=bell');
  assert.equal(facetFromParams(url.searchParams), null);
});

test('statistics filters match quality and favourites and survive URL navigation', () => {
  const item = {parts: [{quality: '1080p'}], favourite: true};
  assert.equal(matchesFacet(item, {kind: 'quality', id: '1080p'}), true);
  assert.equal(matchesFacet(item, {kind: 'quality', id: '4K'}), false);
  assert.equal(matchesFacet({}, {kind: 'quality', id: 'Unknown'}), true);
  // Audio is its own quality, whatever note yt-dlp left on the format.
  const track = {audioOnly: true, parts: [{quality: ''}]};
  assert.equal(matchesFacet(track, {kind: 'quality', id: 'audio'}), true);
  assert.equal(matchesFacet(track, {kind: 'quality', id: 'Unknown'}), false);
  assert.equal(matchesFacet(item, {kind: 'favourite', id: 'true'}), true);
  assert.equal(matchesFacet({}, {kind: 'favourite', id: 'true'}), false);
  const url = new URL('https://archive.test/?channel=old');
  applyFacetParams(url, {kind: 'quality', id: '1080p'});
  assert.deepEqual(facetFromParams(url.searchParams), {kind: 'quality', id: '1080p', name: ''});
  assert.equal(url.searchParams.has('channel'), false);
});
