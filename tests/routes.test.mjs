import assert from 'node:assert/strict';
import test from 'node:test';

import {findWatched, galleryRoute, routeFromLocation, urlForRoute, watchTargetFor} from '../web/routes.js';

const at = url => {
  const {pathname, search} = new URL(url, 'https://archive.test');
  return routeFromLocation({pathname, search});
};
const roundTrip = route => at(urlForRoute(route));

test('views, search and chips are paths of their own', () => {
  const cases = [
    [{view: 'home'}, '/'],
    [{view: 'videos'}, '/videos'],
    [{view: 'playlists', query: 'mix'}, '/playlists?q=mix'],
    [{view: 'home', query: 'zoo'}, '/search?q=zoo'],
    [{view: 'videos', facet: {kind: 'channel', id: 'UC4Qob'}}, '/channel/UC4Qob'],
    [{view: 'videos', facet: {kind: 'playlist', id: 'PLxyz'}}, '/playlist/PLxyz'],
    [{view: 'videos', facet: {kind: 'quality', id: '1080p'}}, '/quality/1080p'],
    [{view: 'videos', facet: {kind: 'favourite', id: 'true'}}, '/favourites'],
    [{view: 'playlists', facet: {kind: 'channel', id: 'UC4Qob'}}, '/channel/UC4Qob/playlists'],
    // A playlist chip is always its videos, whichever view it was picked in.
    [{view: 'playlists', facet: {kind: 'playlist', id: 'PLxyz'}}, '/playlist/PLxyz'],
  ];
  for (const [route, url] of cases) {
    assert.equal(urlForRoute(route), url);
    const back = roundTrip(route);
    assert.equal(back.query, route.query || '');
    assert.deepEqual(back.facet, route.facet ? {...route.facet, name: ''} : null);
  }
  assert.equal(at('/channel/UC4Qob/playlists').view, 'playlists');
  assert.equal(at('/channel/UC4Qob').view, 'videos');
  assert.equal(at('/nonsense').view, 'home');
});

test('ids with awkward characters survive the path', () => {
  const facet = {kind: 'creator', id: 'AC/DC & friends?', name: ''};
  assert.equal(urlForRoute({facet}), '/creator/AC%2FDC%20%26%20friends%3F');
  assert.deepEqual(roundTrip({facet}).facet, facet);
});

test('a video is named by its site id, its file only when that is not enough', () => {
  const zoo = {id: 'lib/jawed/Me at the zoo.info.json', archive: {sourceId: 'jNQXAC9IVRw'}};
  const copy = {id: 'other/Me at the zoo.info.json', archive: {sourceId: 'jNQXAC9IVRw'}};
  const loose = {id: 'lib/clip.info.json', archive: {sourceId: ''}};
  assert.deepEqual(watchTargetFor(zoo, [zoo, loose]), {siteId: 'jNQXAC9IVRw'});
  assert.equal(urlForRoute({watch: watchTargetFor(zoo, [zoo])}), '/watch/jNQXAC9IVRw');
  assert.equal(urlForRoute({watch: watchTargetFor(zoo, [zoo]), list: 'PLxyz'}),
    '/watch/jNQXAC9IVRw?list=PLxyz');

  const shared = watchTargetFor(copy, [zoo, copy]);
  assert.deepEqual(shared, {siteId: 'jNQXAC9IVRw', file: copy.id});
  assert.equal(findWatched(at(urlForRoute({watch: shared})).watch, [zoo, copy]), copy);

  const keyed = urlForRoute({watch: watchTargetFor(loose, [loose])});
  assert.equal(keyed, '/watch/~lib%2Fclip.info.json');
  assert.equal(findWatched(at(keyed).watch, [zoo, loose]), loose);
  assert.equal(findWatched(at('/watch/jNQXAC9IVRw').watch, [loose, zoo]), zoo);
  assert.equal(findWatched(at('/watch/missing').watch, [zoo]), undefined);
});

test('a key a better copy has replaced still finds its video', () => {
  const best = {id: 'b', archive: {sourceId: 's', formats: [{id: 'b'}, {id: 'a'}]}};
  assert.equal(findWatched({key: 'a'}, [best]), best);
});

test('old query addresses still resolve, and say they are old', () => {
  const watch = at('/?view=videos&playlist=PLxyz&watch=lib%2Fzoo.info.json');
  assert.equal(watch.legacy, true);
  assert.deepEqual(watch.watch, {key: 'lib/zoo.info.json'});
  assert.equal(watch.list, 'PLxyz');
  const gallery = at('/?view=playlists&channel=UC1&q=');
  assert.equal(gallery.view, 'playlists');
  assert.deepEqual(gallery.facet, {kind: 'channel', id: 'UC1', name: ''});
  assert.equal(urlForRoute(gallery), '/channel/UC1/playlists');
  assert.equal(at('/?debugdownload').legacy, false);
});

test('debug switches carry from one address to the next', () => {
  assert.equal(urlForRoute({view: 'videos'}, '?debugdownload&view=home&q=x'), '/videos?debugdownload=');
});

test('the gallery behind a video is the one it was opened from', () => {
  const location = {pathname: '/watch/abc', search: '?list=PLxyz'};
  assert.deepEqual(galleryRoute(location, {gallery: '/channel/UC1/playlists'}).facet,
    {kind: 'channel', id: 'UC1', name: ''});
  // Landed on directly, it sits on its playlist, or on home.
  assert.deepEqual(galleryRoute(location, null).facet, {kind: 'playlist', id: 'PLxyz', name: ''});
  assert.equal(galleryRoute({pathname: '/watch/abc', search: ''}, null).view, 'home');
  // An old address kept its gallery alongside the video.
  const legacy = galleryRoute({pathname: '/', search: '?view=videos&channel=UC1&watch=k'}, null);
  assert.deepEqual(legacy.facet, {kind: 'channel', id: 'UC1', name: ''});
  assert.equal(legacy.watch, null);
});
