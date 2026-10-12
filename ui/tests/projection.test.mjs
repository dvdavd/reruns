// Contract for the view arithmetic behind the immersive player. The WebGL half
// needs a real context and is covered by the browser tests instead; these pin
// the maths that decides where a drag or a pinch lands the view.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FOV, MIN_FOV, clampFov, fisheyeEyeScale, horizontalFov, panBy, pinchBy,
} from '../shared/lib/projection.js';

const view = (overrides = {}) => ({yaw: 0, pitch: 0, fov: 90, ...overrides});

test('the field of view stays within the range the controls allow', () => {
  assert.equal(clampFov(90), 90);
  assert.equal(clampFov(5), MIN_FOV);
  assert.equal(clampFov(500), MAX_FOV);
  assert.equal(clampFov('75'), 75);
  assert.equal(clampFov(undefined), MIN_FOV);
});

test('a wider viewport sees more horizontally than vertically', () => {
  // A square viewport sees exactly the vertical field of view.
  assert.ok(Math.abs(horizontalFov(90, 1) - 90) < 1e-9);
  assert.ok(horizontalFov(90, 16 / 9) > 90);
  assert.ok(horizontalFov(90, 0.5) < 90);
});

test('an unusable aspect ratio falls back to widescreen', () => {
  assert.equal(horizontalFov(90, 0), horizontalFov(90, 16 / 9));
  assert.equal(horizontalFov(90, -1), horizontalFov(90, 16 / 9));
});

test('dragging right looks left, and down looks down', () => {
  // The scene moves with the pointer, so the camera turns against it.
  assert.ok(panBy(view(), 100, 0).yaw < 0);
  assert.ok(panBy(view(), 0, 100).pitch > 0);
});

test('panning is proportional to how far the view is zoomed in', () => {
  const wide = panBy(view({fov: 90}), 100, 0).yaw;
  const zoomed = panBy(view({fov: 45}), 100, 0).yaw;
  assert.ok(Math.abs(zoomed) < Math.abs(wide),
    'a zoomed-in view should move less per pixel');
});

test('pitch stops short of the poles where the projection degenerates', () => {
  assert.equal(panBy(view(), 0, 100000).pitch, 85);
  assert.equal(panBy(view(), 0, -100000).pitch, -85);
});

test('yaw is free to wrap, since a full turn is meaningful', () => {
  assert.ok(Math.abs(panBy(view(), 100000, 0).yaw) > 360);
});

test('pinching apart zooms in, and the range still holds', () => {
  assert.ok(pinchBy(view(), 100).fov < 90);
  assert.ok(pinchBy(view(), -100).fov > 90);
  assert.equal(pinchBy(view(), 100000).fov, MIN_FOV);
  assert.equal(pinchBy(view(), -100000).fov, MAX_FOV);
});

test('the view helpers do not mutate the view they are given', () => {
  const original = view();
  panBy(original, 50, 50);
  pinchBy(original, 50);
  assert.deepEqual(original, {yaw: 0, pitch: 0, fov: 90});
});

// The thumbnailer centre-crops a square out of a top/bottom eye before it
// projects (crop=iw:ih/2, then crop=ih:ih). The player has to agree, or the
// same video is round in its thumbnail and squeezed in the player.
test('a fisheye circle is measured against the eye, not the frame', () => {
  // Side by side: each eye is already square, so nothing is padded.
  assert.deepEqual(fisheyeEyeScale(4096, 2048, 'sbs'), [1, 1]);
  // Top/bottom: each eye is a 2:1 half holding a square circle, centred.
  assert.deepEqual(fisheyeEyeScale(4096, 4096, 'tb'), [0.5, 1]);
  // A top/bottom pair that is already square per eye needs no correction.
  assert.deepEqual(fisheyeEyeScale(2048, 4096, 'tb'), [1, 1]);
  // Monoscopic: the frame is the eye.
  assert.deepEqual(fisheyeEyeScale(2048, 2048, null), [1, 1]);
});

test('an unmeasured video leaves the fisheye mapping alone', () => {
  assert.deepEqual(fisheyeEyeScale(0, 0, 'tb'), [1, 1]);
});
