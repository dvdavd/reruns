import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import * as mediaUi from '../shared/index.js';

test('the package root exposes the gallery and player contracts', () => {
  for (const name of [
    'createItemStore', 'filterItems', 'VideoCard', 'VirtualGallery',
    'MediaPlayer', 'LocalMediaProvider', 'EntityPicker', 'FramePicker', 'render',
    'gridColumns', 'watchColumns', 'createShelfRows',
    'setIconSpriteUrl', 'accentFromImage', 'accentFromImageData',
  ]) assert.equal(typeof mediaUi[name], 'function', name);
});

test('package exports cover every documented public entry point and asset', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'media-ui');
  for (const path of [
    '.', './core', './accent', './gallery', './shelf', './player', './entities', './pickers',
    './assets', './chrome', './styles.css', './player.css', './icons.svg',
    './tokens.css', './chrome.css',
  ]) assert.ok(manifest.exports[path], path);
});

test('shared JavaScript does not assume a consumer mounted it at /static/shared', async () => {
  const files = [
    'shared/components/icons.js',
    'shared/components/MediaPlayer.js',
    'shared/chrome.js',
  ];
  for (const file of files) {
    assert.doesNotMatch(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), /\/static\/shared/);
  }
});

test('the player stylesheet is self-contained enough to look right alone', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/player.css', import.meta.url), 'utf8'));
  // Consumers have no global reset, so the player must bring its own box
  // model: without it the 48px control bar renders 64px tall.
  assert.match(source, /\.media-player \*[^{]*\{[^}]*box-sizing: border-box/);
  // Every icon is drawn as an outline, so solid transport glyphs are the
  // stylesheet's job, not the host application's.
  assert.match(source, /\.media-icon-play[\s\S]*?fill: currentColor/);
  // Each paired icon hides its inactive half; both halves share one grid cell.
  for (const pair of [
    ['media-icon-pause', 'media-icon-play'],
    ['media-icon-minimize', 'media-icon-maximize'],
    ['media-icon-raw', 'media-icon-projected'],
  ]) {
    for (const name of pair) assert.match(source, new RegExp(`\\.${name}\\b`));
  }
  // The volume button swaps between four glyphs by data-volume-state.
  for (const state of ['high', 'medium', 'zero', 'muted']) {
    assert.match(source, new RegExp(`\\[data-volume-state="${state}"\\] \\.media-icon-volume-${state}`));
  }
});

test('the player reports every volume level the stylesheet draws', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../shared/components/MediaPlayer.js', import.meta.url), 'utf8'));
  // Without this the button renders but never changes glyph, which is how the
  // volume states were lost when the legacy engine was removed.
  assert.match(source, /volumeButton\.dataset\.volumeState/);
  for (const state of ['high', 'medium', 'zero', 'muted']) {
    assert.match(source, new RegExp(`media-icon-volume-${state}|'${state}'`));
  }
});
