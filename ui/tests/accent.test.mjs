// The accent picker, for an app whose pictures arrive without an accent.
import assert from 'node:assert/strict';
import test from 'node:test';

import * as accent from '../shared/accent.js';

/** A solid block of one colour, as RGBA pixels. */
const block = (red, green, blue, width = 32, height = 18) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set([red, green, blue, 255], offset);
  }
  return [data, width, height];
};

test('a vivid blue image publishes its hue at the base lightness', () => {
  const published = accent.accentFromImageData(...block(30, 90, 200));
  assert.match(published, /^oklch\(62% \d\.\d{3} \d+\.\d\)$/);
  // Blue in, blue out: the hue survives, only the lightness is normalised.
  const hue = Number(published.match(/ ([\d.]+)\)$/)[1]);
  assert.ok(hue > 230 && hue < 290, published);
});

test('a grey image names no colour rather than inventing one', () => {
  assert.equal(accent.accentFromImageData(...block(128, 128, 128)), null);
  assert.equal(accent.accentFromImageData(...block(0, 0, 0)), null);
});

test('the centre decides, and the edges are the fallback', () => {
  // Red down the centre third, green either side. The centre pass wins even
  // though green covers more of the frame.
  const [data, width, height] = block(20, 170, 40);
  const centreWidth = Math.round(width * accent.CENTRE_FRACTION);
  const left = Math.floor((width - centreWidth) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = left; x < left + centreWidth; x++) {
      data.set([200, 30, 30, 255], (y * width + x) * 4);
    }
  }
  const hue = Number(accent.accentFromImageData(data, width, height)
    .match(/ ([\d.]+)\)$/)[1]);
  assert.ok(hue < 60 || hue > 330, `expected a red hue, got ${hue}`);
});

test('an unreadable image leaves the caller its default accent', () => {
  // A canvas tainted by a cross-origin picture throws on getImageData; so does
  // a document-less runtime, which is what stands in for it here.
  assert.equal(accent.accentFromImage({}), null);
});

test('yellow stays bright while saturated purple is capped for card surfaces', () => {
  const yellow = accent.accentFromImageData(...block(255, 230, 0));
  const purple = accent.accentFromImageData(...block(170, 0, 255));
  const values = colour => colour.match(/^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/).slice(1).map(Number);
  const [yellowLightness, , yellowHue] = values(yellow);
  const [purpleLightness, purpleChroma] = values(purple);
  assert.ok(yellowLightness >= 78, yellow);
  assert.ok(yellowHue > 90 && yellowHue < 115, yellow);
  assert.equal(purpleLightness, 62);
  assert.equal(purpleChroma, accent.MAX_CHROMA, purple);
});

test('a smaller blue patch beats yellow, in the centre or at the edge', () => {
  for (const left of [0, 14]) {
    const [data, width, height] = block(255, 230, 0);
    for (let y = 0; y < height; y++) {
      for (let x = left; x < left + 4; x++) {
        data.set([30, 90, 200, 255], (y * width + x) * 4);
      }
    }
    const published = accent.accentFromImageData(data, width, height);
    const hue = Number(published.match(/ ([\d.]+)\)$/)[1]);
    assert.ok(hue > 230 && hue < 290, published);
  }
});

test('a stray blue pixel does not displace an otherwise yellow image', () => {
  const [data, width, height] = block(255, 230, 0);
  data.set([30, 90, 200, 255], 0);
  assert.equal(accent.accentFromImageData(data, width, height),
    accent.accentFromImageData(...block(255, 230, 0)));
});
