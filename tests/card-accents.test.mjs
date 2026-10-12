// The picker belongs to the shared package. These tests cover the wiring: the walk over gallery cards, and that it did not grow a
// second implementation of the algorithm.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {accentFromImageData} from 'media-ui/accent.js';
import {initialiseCardAccents} from '../web/card-accents.js';

const source = await readFile('web/card-accents.js', 'utf8');

function solid(red, green, blue, width = 32, height = 18) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set([red, green, blue, 255], offset);
  }
  return {data, width, height};
}

test('the accent the archive paints with is the shared one', () => {
  const image = solid(30, 80, 230);
  assert.match(accentFromImageData(image.data, image.width, image.height),
    /^oklch\(62% 0\.\d{3} \d+\.\d\)$/);
  assert.equal(accentFromImageData(...Object.values(solid(128, 128, 128))), null);
});

test('this repo wires the shared picker up rather than re-deriving it', () => {
  assert.equal(typeof initialiseCardAccents, 'function');
  assert.match(source, /from 'media-ui\/accent\.js'/);
  // The tuning constants belong to the shared module and its Python twin.
  assert.doesNotMatch(source, /0\.22|0\.17|oklch\(/);
});
