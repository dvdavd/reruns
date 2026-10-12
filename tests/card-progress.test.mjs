import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const gallery = await readFile('web/gallery-actions.js', 'utf8');

test('archive cards opt in to displaying saved playback progress', () => {
  // `cardProps` feeds the gallery and every secondary surface that reuses its
  // cards, including favourites and the player's related-video row.
  assert.match(gallery, /function cardProps\([\s\S]*?showSavedProgress: true,/);
});
