import assert from 'node:assert/strict';
import test from 'node:test';

import {createJankMonitor, finishGlowFades, lightGlowPixels, nextSampleInterval} from '../web/ambient-glow.js';

test('new glow samples finish opacity fades without snapping the blur transition', () => {
  const finished = [];
  const animation = (property, value) => ({
    effect: {getKeyframes: () => [{[property]: value}]},
    finish: () => finished.push(property),
  });
  finishGlowFades({getAnimations: () => [
    animation('opacity', 1), animation('filter', 'blur(13px)'), animation('opacity', 0),
  ]});
  assert.deepEqual(finished, ['opacity', 'opacity']);
});

function pixel(red, green, blue, alpha = 255) {
  return lightGlowPixels({data: new Uint8ClampedArray([red, green, blue, alpha])}).data;
}

test('light glow fades near-black pixels but allows some dark grey through', () => {
  assert.equal(pixel(0, 0, 0)[3], 0);
  assert.equal(pixel(30, 30, 30)[3], 0);
  assert.ok(pixel(60, 60, 60)[3] > 0);
  assert.ok(pixel(60, 60, 60)[3] < pixel(100, 100, 100)[3]);
  assert.equal(pixel(220, 220, 220)[3], 255);
});

test('light glow keeps vivid colours bright and saturated', () => {
  const blue = pixel(15, 35, 170);
  assert.ok(blue[3] > 0);
  assert.ok(blue[2] > 240);
  assert.ok(blue[2] - blue[0] > 170 - 15);
  assert.ok(pixel(60, 60, 60)[3] < blue[3]);
});

test('light glow preserves source transparency', () => {
  assert.equal(pixel(255, 0, 0, 0)[3], 0);
});

test('realtime sampling slows after slow copies, caps, and recovers', () => {
  let interval = 90;
  interval = nextSampleInterval(interval, 8);
  assert.equal(interval, 135);
  for (let i = 0; i < 10; i++) interval = nextSampleInterval(interval, 8);
  assert.equal(interval, 360);
  assert.equal(nextSampleInterval(150, 3), 150);
  for (let i = 0; i < 40; i++) interval = nextSampleInterval(interval, 1);
  assert.equal(interval, 90);
});

// Feeds `seconds` of frames at a fixed gap and reports whether it ever tripped.
function run(monitor, gap, seconds) {
  let tripped = false;
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += gap) tripped ||= monitor.frame(gap);
  return tripped;
}

test('the jank monitor leaves a smooth page alone', () => {
  assert.equal(run(createJankMonitor(), 16.7, 30), false);
});

test('the jank monitor trips after several slow windows in a row, not one', () => {
  assert.equal(run(createJankMonitor(), 80, 3), false);
  assert.equal(run(createJankMonitor(), 80, 9), true);
});

test('a good window clears the jank count', () => {
  const monitor = createJankMonitor();
  assert.equal(run(monitor, 80, 5), false);
  assert.equal(run(monitor, 16.7, 2.5), false);
  assert.equal(run(monitor, 80, 5), false);
});

test('the jank monitor ignores stalls from the page being away', () => {
  const monitor = createJankMonitor();
  for (let i = 0; i < 40; i++) assert.equal(monitor.frame(5000), false);
});
