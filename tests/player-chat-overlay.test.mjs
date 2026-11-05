import assert from 'node:assert/strict';
import test from 'node:test';
import {chosenSpot, spotAt, videoAlignment} from '../web/player-chat-overlay.js';

const box = {left: 0, top: 0, width: 1600, height: 900};

test('an unknown spot is the foot of the right side', () => {
  assert.deepEqual(chosenSpot(null), {side: 'right', row: 'bottom'});
  assert.deepEqual(chosenSpot('left-top'), {side: 'left', row: 'top'});
  assert.deepEqual(chosenSpot('up-sideways'), {side: 'right', row: 'bottom'});
});

test('a dropped chat lands by where its centre is: the nearer side, and at half height the third it is in', () => {
  // The centres of a half-height chat standing at each of the three places.
  assert.deepEqual(spotAt(200, 230, box, false), {side: 'left', row: 'top'});
  assert.deepEqual(spotAt(1400, 450, box, false), {side: 'right', row: 'middle'});
  assert.deepEqual(spotAt(1400, 670, box, false), {side: 'right', row: 'bottom'});
  // Dragged past the player's edge still counts as its nearest third.
  assert.deepEqual(spotAt(1700, 2000, box, false), {side: 'right', row: 'bottom'});
  // Full height has only the side to choose.
  assert.deepEqual(spotAt(200, 100, box, true), {side: 'left', row: 'bottom'});
});

test('the picture is pushed into its bars away from the chat, and centred when docked', () => {
  const over = {docked: false, tall: false};
  assert.equal(videoAlignment({docked: false, tall: true}, {side: 'right', row: 'bottom'}), '0% 50%');
  assert.equal(videoAlignment({docked: false, tall: true}, {side: 'left', row: 'top'}), '100% 50%');
  assert.equal(videoAlignment(over, {side: 'right', row: 'top'}), '0% 100%');
  assert.equal(videoAlignment(over, {side: 'left', row: 'bottom'}), '100% 0%');
  assert.equal(videoAlignment(over, {side: 'left', row: 'middle'}), '100% 50%');
  assert.equal(videoAlignment({docked: true, tall: true}, {side: 'left', row: 'top'}), '50% 50%');
});
