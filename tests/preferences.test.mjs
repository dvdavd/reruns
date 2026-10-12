import assert from 'node:assert/strict';
import test from 'node:test';

import {createPreferences, isDefaultable, isSynced} from '../web/preferences.js';

function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

// The module's own request() talks to the server, so these tests stand one in.
function server(state) {
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    calls.push([path, options.body && JSON.parse(options.body)]);
    return {ok: true, json: async () => state, text: async () => ''};
  };
  return calls;
}

test('browser-only keys and anyone else\'s resume positions are not synced', () => {
  assert.ok(isSynced('archive-theme'));
  assert.ok(isSynced('reruns.playback:["a",0]'));
  assert.ok(!isSynced('archive-directory'));
  assert.ok(!isSynced('archive-palette-style'));
  assert.ok(isDefaultable('archive-theme'));
  assert.ok(!isDefaultable('reruns.playback:["a",0]'));
});

test('signing in takes the account\'s choices, then the admin default per key', async () => {
  const storage = memory({'archive-theme': 'dark', 'ytdlp-autoplay-v1': '1'});
  server({account: 2, values: {'archive-theme': 'light'}, defaults: {'archive-card-size': 'large', 'archive-theme': 'dark'}});
  const store = createPreferences({storage});
  assert.equal(await store.sync(), true);
  assert.equal(storage.getItem('archive-theme'), 'light');
  assert.equal(storage.getItem('archive-card-size'), 'large');
  // Left by the account that was here before, so it does not carry over.
  assert.equal(storage.getItem('ytdlp-autoplay-v1'), null);
});

test('signing in replaces browser preferences without uploading them', async () => {
  const storage = memory({'archive-theme': 'light', 'archive-card-size': 'small', 'archive-directory': 'x'});
  const calls = server({account: 1, values: {}, defaults: {'archive-card-size': 'large'}});
  await createPreferences({storage}).sync();
  assert.equal(storage.getItem('archive-theme'), null);
  assert.equal(storage.getItem('archive-card-size'), 'large');
  assert.equal(storage.getItem('archive-directory'), 'x');
  assert.deepEqual(calls, [['/api/preferences', undefined]]);
});

test('clearing a choice falls back to the default, and changes are saved in a batch', async () => {
  const storage = memory();
  const calls = server({account: 1, values: {'archive-theme': 'light'}, defaults: {'archive-theme': 'dark'}});
  const store = createPreferences({storage});
  await store.sync();
  store.setItem('archive-playback-speed', '1.5');
  store.removeItem('archive-theme');
  assert.equal(storage.getItem('archive-theme'), 'dark');
  await store.flush();
  const saved = calls.filter(([path]) => path === '/api/preferences').at(-1)[1].changes;
  assert.deepEqual(saved, {'archive-playback-speed': '1.5', 'archive-theme': null});
});

test('without an account the browser keeps what it has and saves nothing', async () => {
  const storage = memory({'archive-theme': 'light'});
  globalThis.fetch = async () => ({ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'Sign in'});
  const store = createPreferences({storage});
  assert.equal(await store.sync(), false);
  store.setItem('archive-theme', 'dark');
  await store.flush();
  assert.equal(storage.getItem('archive-theme'), 'dark');
});

test('a save that fails says so, and keeps the change for the next one', async () => {
  // A new language reloads the page only once the server has it.
  const storage = memory();
  server({account: 1, values: {}, defaults: {}});
  const store = createPreferences({storage});
  await store.sync();
  store.setItem('archive-language', 'en-US');
  globalThis.fetch = async () => ({ok: false, status: 503, statusText: 'Unavailable', text: async () => ''});
  assert.equal(await store.flush(), false);
  const calls = server({account: 1, values: {}, defaults: {}});
  assert.equal(await store.flush(), true);
  assert.deepEqual(calls.at(-1)[1].changes, {'archive-language': 'en-US'});
});
