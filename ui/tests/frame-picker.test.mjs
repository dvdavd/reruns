// Render contract for the shared frame picker. It replaced a hand-written
// diffing renderer in thumbnail-picker.js, so these pin the slot padding, the
// selected/arriving states and the injected seams the VR app relies on.
import assert from 'node:assert/strict';
import test from 'node:test';

import render from '../vendor/preact/render-to-string.module.js';
import {html} from '../shared/lib/html.js';
import {
  FramePicker, defaultCaption, frameRevision,
} from '../shared/components/FramePicker.js';

const draw = props => render(html`<${FramePicker} ...${props} />`);

const frame = (percent, overrides = {}) => ({
  percent, state: 'ready', url: `/thumb?p=${percent}`, face_count: 0, ...overrides,
});

test('the grid is padded to a fixed slot count so it does not reflow', () => {
  const out = draw({frames: [frame(0), frame(50)], slotCount: 12});
  assert.equal((out.match(/<button/g) || []).length, 12);
  assert.equal((out.match(/is-placeholder/g) || []).length, 10);
});

test('placeholders say whether more frames are still coming', () => {
  assert.match(draw({frames: [], slotCount: 2, generating: true}), /Generating…/);
  assert.match(draw({frames: [], slotCount: 2, generating: true}), /thumbnail-picker-spinner/);
  const idle = draw({frames: [], slotCount: 2, generating: false});
  assert.match(idle, /Unavailable/);
  assert.doesNotMatch(idle, /thumbnail-picker-spinner/);
});

test('placeholders are not clickable', () => {
  assert.match(draw({frames: [], slotCount: 1}), /disabled/);
});

test('a frame that is not ready cannot be chosen yet', () => {
  const out = draw({frames: [frame(10, {state: 'pending'})], slotCount: 1});
  assert.match(out, /disabled/);
  assert.match(out, /Analysing frames…/);
});

test('the selected frame is marked, matching on percent', () => {
  const out = draw({frames: [frame(0), frame(50)], slotCount: 2, selectedPercent: 50});
  assert.equal((out.match(/is-selected/g) || []).length, 1);
  // A string from a dataset must still match a numeric percent.
  assert.match(draw({frames: [frame(50)], slotCount: 1, selectedPercent: '50'}), /is-selected/);
});

test('only a frame replacing a placeholder animates in', () => {
  const arriving = draw({frames: [frame(0)], slotCount: 1, arrivingAt: () => true});
  assert.match(arriving, /is-arriving/);
  assert.doesNotMatch(draw({frames: [frame(0)], slotCount: 1}), /is-arriving/);
});

test('alpha packing marks every candidate', () => {
  assert.match(draw({frames: [frame(0)], slotCount: 1, alpha: true}), /is-alpha/);
  assert.doesNotMatch(draw({frames: [frame(0)], slotCount: 1}), /is-alpha/);
});

test('a recentred frame busts its cache on the angles it was framed at', () => {
  // Both apps have VR material, so this is shared rather than injected: the
  // recentred frame is served from the same URL as the original.
  const out = draw({frames: [frame(25, {yaw: 10, pitch: -5, centered: true})], slotCount: 1});
  assert.match(out, /revision=centered-10--5/);
  const original = draw({frames: [frame(25, {yaw: 10, pitch: -5})], slotCount: 1});
  assert.match(original, /revision=original/);
  assert.equal(frameRevision({centered: true, yaw: 1, pitch: 2}), 'centered-1-2');
  assert.equal(frameRevision({yaw: 1, pitch: 2}), 'original');
});

test('a frame carries its position and any framing angles', () => {
  const out = draw({frames: [frame(25, {yaw: 10, pitch: -5})], slotCount: 1});
  assert.match(out, /data-percent="25"/);
  assert.match(out, /data-yaw="10"/);
  assert.match(out, /data-pitch="-5"/);
  // A flat frame has no angles to stamp.
  assert.doesNotMatch(draw({frames: [frame(25)], slotCount: 1}), /data-yaw/);
});

test('the routing seams are still overridable', () => {
  const out = draw({
    frames: [frame(25)], slotCount: 1,
    imageUrlFor: candidate => `/other${candidate.url}`,
    datasetFor: () => ({'data-episode': '3'}),
  });
  assert.match(out, /src="\/other\/thumb\?p=25"/);
  assert.match(out, /data-episode="3"/);
  assert.doesNotMatch(out, /data-percent/);
});

test('the alt text describes where in the video the frame is', () => {
  assert.match(draw({frames: [frame(33.4)], slotCount: 1}), /alt="33% through the video"/);
});

test('the caption is overridable, and defaults to the percent', () => {
  assert.match(draw({frames: [frame(40)], slotCount: 1}), />40%</);
  assert.match(
    draw({frames: [frame(40)], slotCount: 1, captionFor: () => '40% · 2 faces framed'}),
    /40% · 2 faces framed/,
  );
});

test('defaultCaption reports failure ahead of readiness', () => {
  assert.equal(defaultCaption({percent: 10, error: 'boom', state: 'ready'}), 'Failed');
  assert.equal(defaultCaption({percent: 10, state: 'pending'}), 'Analysing frames…');
  assert.equal(defaultCaption({percent: 10.6, state: 'ready'}), '11%');
});

test('a frame with no url renders no src rather than an empty one', () => {
  const out = draw({frames: [frame(0, {url: null})], slotCount: 1});
  assert.doesNotMatch(out, /src=""/);
});
