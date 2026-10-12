import assert from 'node:assert/strict';
import test from 'node:test';
import {approximateAge, browseSourceFor, browseSummary, entryKey, entryMeta, entrySubscriptionId, filterEntries,
  formatViews, listingPath, loadListing, queuedDownloadRows, reconcileQueued, searchNeedsYouTube}
  from '../web/browse-ui.js';

const entries = [
  {id: 'a', extractor: 'youtube', title: 'Cats on a Roof', uploader: 'Felix', held: false},
  {id: 'b', extractor: 'youtube', title: 'Dogs in a Park', uploader: 'Rex', held: true},
  {id: 'c', extractor: 'youtube', title: 'More cats', uploader: 'Rex', held: false},
];

test('a search names its text and the rest an address', () => {
  assert.equal(listingPath({kind: 'search', query: 'cat videos'}, 30),
    '/api/browse?kind=search&count=30&query=cat+videos');
  assert.equal(listingPath({kind: 'channel', url: 'https://y/@a?b=c'}, 60),
    '/api/browse?kind=channel&count=60&url=https%3A%2F%2Fy%2F%40a%3Fb%3Dc');
});

test('a playlist or channel search names its text too', () => {
  assert.equal(listingPath({kind: 'search-channels', query: 'lofi'}, 30),
    '/api/browse?kind=search-channels&count=30&query=lofi');
});

test('the filter matches every word against title and channel', () => {
  assert.deepEqual(filterEntries(entries, {text: 'cats'}).map(entry => entry.id), ['a', 'c']);
  assert.deepEqual(filterEntries(entries, {text: 'rex cats'}).map(entry => entry.id), ['c']);
  assert.equal(filterEntries(entries, {text: ''}).length, 3);
});

test('hiding what is held also hides what this panel has just queued', () => {
  assert.deepEqual(filterEntries(entries, {missingOnly: true}).map(entry => entry.id), ['a', 'c']);
  assert.deepEqual(filterEntries(entries, {missingOnly: true, queued: new Set([entryKey(entries[0])])})
    .map(entry => entry.id), ['c']);
});

test('views read short', () => {
  assert.equal(formatViews(1), '1 view');
  assert.equal(formatViews(999), '999 views');
  assert.equal(formatViews(1200), '1.2K views');
  assert.equal(formatViews(45000), '45K views');
  assert.equal(formatViews(2_300_000), '2.3M views');
  assert.equal(formatViews(null), '');
});

test('the meta line leaves out what the extractor did not say', () => {
  const now = 1_000_000;
  assert.deepEqual(entryMeta({uploader: 'Felix', views: 5, uploadedAt: now - 3 * 86400}, now),
    ['Felix', '5 views', '3 days ago']);
  assert.deepEqual(entryMeta({uploader: '', views: null, uploadedAt: 0}, now), []);
});

test('the summary counts what is held, and what was just queued apart', () => {
  assert.equal(browseSummary([], 0), '');
  assert.equal(browseSummary(entries, 3), '3 listed · 1 in your library');
  assert.equal(browseSummary(entries, 2, new Set([entryKey(entries[0])])),
    '2 of 3 listed · 1 in your library · 1 queued');
});

test('failed and cancelled browse jobs can be retried, while a completed job asks for a scan', () => {
  const queued = new Map([['youtube a', 'a'], ['youtube b', 'b'], ['youtube c', 'c'],
    ['youtube d', 'd'], ['youtube pending', null]]);
  const result = reconcileQueued(queued, [
    {id: 'a', state: 'failed'}, {id: 'b', state: 'cancelled'},
    {id: 'c', state: 'done'}, {id: 'd', state: 'running'},
  ]);
  assert.deepEqual(result, {completed: true, changed: true});
  assert.deepEqual([...queued.keys()], ['youtube c', 'youtube d', 'youtube pending']);
  assert.equal(queued.get('youtube c'), '');
  assert.equal(reconcileQueued(queued, [{id: 'd', state: 'running'}]).completed, false);
});

test('a queued browse entry follows the active video of its download job', () => {
  const queued = new Map([['youtube a', 'job-a'], ['youtube pending', null]]);
  const rows = queuedDownloadRows(queued, [{id: 'job-a', url: 'https://youtu.be/a', state: 'running',
    items: [
      {id: 'old', title: 'Already finished', state: 'done', files: [], transfers: []},
      {id: 'a', title: 'Cats on a Roof', state: 'running', files: [], transfers: [
        {state: 'running', percent: 42, speed: '2MiB/s'}]},
    ]}]);
  assert.equal(rows.get('youtube a').title, 'Cats on a Roof');
  assert.equal(rows.get('youtube a').percent, 42);
  assert.equal(rows.has('youtube pending'), false);
});

test('polls until ready', async () => {
  const answers = [{state: 'queued', retryAfterMs: 5}, {state: 'ready', entries: []}];
  const waits = [];
  const result = await loadListing({kind: 'search', query: 'x'}, 30, {
    fetchState: async () => answers.shift(), wait: async ms => waits.push(ms),
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(waits, [5]);
});

test('a failure throws in the server\'s own words', async () => {
  await assert.rejects(loadListing({kind: 'search', query: 'x'}, 30, {
    fetchState: async () => ({state: 'failed', error: 'Private playlist'}),
  }), /Private playlist/);
});

test('an answer for a source since left is dropped', async () => {
  let stale = false;
  const result = await loadListing({kind: 'search', query: 'x'}, 30, {
    fetchState: async () => { stale = true; return {state: 'ready', entries: []}; },
    stale: () => stale,
  });
  assert.equal(result, null);
});

test('gives up rather than polling for ever', async () => {
  await assert.rejects(loadListing({kind: 'search', query: 'x'}, 30, {
    fetchState: async () => ({state: 'queued'}), wait: async () => {},
  }), /too long/);
});

test('the topbar browses a channel or playlist link and searches anything else', () => {
  assert.deepEqual(browseSourceFor('https://www.youtube.com/@name', {link: true}),
    {kind: 'channel', url: 'https://www.youtube.com/@name', title: ''});
  assert.equal(browseSourceFor('https://www.youtube.com/watch?v=abc&list=PL1', {link: true}).kind, 'playlist');
  assert.deepEqual(browseSourceFor(' cats ', {link: false}),
    {kind: 'search', query: 'cats', title: 'Search YouTube: cats'});
});

test('a search from the playlists or channels view looks for those on YouTube', () => {
  assert.deepEqual(browseSourceFor('lofi', {link: false, view: 'playlists'}),
    {kind: 'search-playlists', query: 'lofi', title: 'YouTube playlists: lofi'});
  assert.equal(browseSourceFor('lofi', {link: false, view: 'channels'}).kind, 'search-channels');
  assert.equal(browseSourceFor('lofi', {link: false, view: 'videos'}).kind, 'search');
  assert.equal(browseSourceFor('lofi', {link: false, view: 'home'}).kind, 'search');
  // A link is browsed whatever the view.
  assert.equal(browseSourceFor('https://www.youtube.com/@name', {link: true, view: 'playlists'}).kind, 'channel');
});

test('a playlist or channel search is emphasised when the grid on screen matched nothing', () => {
  const source = browseSourceFor('lofi', {link: false, view: 'playlists'});
  assert.equal(searchNeedsYouTube(source, [], 2), false);
  assert.equal(searchNeedsYouTube(source, [], 0), true);
});

test('a listed channel says who follows it rather than who posted it', () => {
  assert.deepEqual(entryMeta({kind: 'channel', uploader: 'Lofi Girl', followers: 15_800_000}), ['16M subscribers']);
  assert.deepEqual(entryMeta({kind: 'channel', followers: null}), []);
  assert.deepEqual(entryMeta({kind: 'playlist', uploader: 'Lofi Girl', views: null, uploadedAt: 0}), ['Lofi Girl']);
});

test('a listed playlist or channel knows the subscription already following it', () => {
  const subscriptions = [
    {id: 's1', kind: 'playlist', url: 'https://www.youtube.com/playlist?list=PL1'},
    {id: 's2', kind: 'channel', url: 'https://www.youtube.com/@lofigirl', channelId: 'UC1'},
    {id: 's3', kind: 'channel', url: 'https://www.youtube.com/channel/UC2'},
  ];
  const listed = (kind, id, url) => entrySubscriptionId({kind, id, url}, subscriptions);
  assert.equal(listed('playlist', 'PL1', 'https://www.youtube.com/playlist?list=PL1'), 's1');
  assert.equal(listed('playlist', 'PL9', 'https://www.youtube.com/playlist?list=PL9'), null);
  assert.equal(listed('channel', 'UC1', 'https://www.youtube.com/channel/UC1'), 's2');
  assert.equal(listed('channel', 'UC2', 'https://www.youtube.com/channel/UC2'), 's3');
  assert.equal(listed('video', 'abc', 'https://www.youtube.com/watch?v=abc'), null);
});

test('a single video link and an empty field offer nothing', () => {
  assert.equal(browseSourceFor('https://www.youtube.com/watch?v=abc', {link: true}), null);
  assert.equal(browseSourceFor('   ', {link: false}), null);
});

test('a URL being typed does not offer a YouTube search', () => {
  for (const text of ['h', 'ht', 'htt', 'http', 'http:', 'https', 'https:', 'https:/', 'https://']) {
    assert.equal(browseSourceFor(text, {link: false}), null, text);
  }
  assert.equal(browseSourceFor('hello', {link: false}).kind, 'search');
});

test('YouTube search is emphasised only when the archive has no match', () => {
  const items = [{title: 'Cats on a Roof', facets: {owner: {name: 'Felix'}}}];
  assert.equal(searchNeedsYouTube(browseSourceFor('cats', {link: false}), items), false);
  assert.equal(searchNeedsYouTube(browseSourceFor('Felix', {link: false}), items), false);
  assert.equal(searchNeedsYouTube(browseSourceFor('dogs', {link: false}), items), true);
  assert.equal(searchNeedsYouTube(browseSourceFor('h', {link: false}), items), false);
});

test('approximateAge keeps the coarse months YouTube gave rather than inventing days', () => {
  const now = 1_800_000_000;
  const ago = days => approximateAge(now - days * 86400, now);
  assert.equal(ago(4), '4 days ago');
  assert.equal(ago(13), '13 days ago');
  assert.deepEqual([14, 20, 21, 28].map(ago),
    ['2 weeks ago', '2 weeks ago', '1 month ago', '1 month ago']);
  assert.deepEqual([31, 62, 92, 123, 153, 184, 213].map(ago),
    ['1 month ago', '2 months ago', '3 months ago', '4 months ago', '5 months ago',
      '6 months ago', '7 months ago']);
  assert.equal(ago(366), '1 year ago');
  assert.equal(ago(800), '2 years ago');
});
