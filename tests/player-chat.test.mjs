import assert from 'node:assert/strict';
import test from 'node:test';
import {WINDOW_MS, between, chosenPosition, formatOffset, newestUpTo, placement, windowOf} from '../web/player-chat.js';

const say = t => ({t, author: 'a', kind: 'text', role: '', amount: '', text: String(t)});
// Two windows, and the third not yet arrived.
const windows = new Map([
  [0, [say(0), say(1000), say(WINDOW_MS - 1)]],
  [1, [say(WINDOW_MS), say(WINDOW_MS + 500)]],
]);

test('offsets read as a clock', () => {
  assert.equal(formatOffset(0), '0:00');
  assert.equal(formatOffset(61999), '1:01');
  assert.equal(formatOffset(3723000), '1:02:03');
  assert.equal(formatOffset(-5), '0:00');
});

test('a time belongs to the window it falls in', () => {
  assert.equal(windowOf(0), 0);
  assert.equal(windowOf(WINDOW_MS - 1), 0);
  assert.equal(windowOf(WINDOW_MS), 1);
});

test('what was said since the last look spans a window boundary and excludes the lower bound', () => {
  assert.deepEqual(between(windows, 1000, WINDOW_MS).map(m => m.t), [WINDOW_MS - 1, WINDOW_MS]);
  assert.deepEqual(between(windows, WINDOW_MS + 500, WINDOW_MS + 900), []);
  // Windows that have not arrived say nothing rather than failing.
  assert.deepEqual(between(windows, WINDOW_MS + 500, 3 * WINDOW_MS).map(m => m.t), []);
});

test('a seek shows the newest messages before the new time, oldest first', () => {
  assert.deepEqual(newestUpTo(windows, WINDOW_MS + 100, 3).map(m => m.t), [1000, WINDOW_MS - 1, WINDOW_MS]);
  assert.deepEqual(newestUpTo(windows, 500, 5).map(m => m.t), [0]);
  assert.deepEqual(newestUpTo(windows, 0, 5).map(m => m.t), [0]);
});

test('the chat goes beside the player only where the window has room for it', () => {
  const wide = {beside: true, automatic: true};
  const middling = {beside: true, automatic: false};
  const narrow = {beside: false, automatic: false};
  assert.equal(placement('automatic', wide), 'beside');
  // Automatic asks for more room than choosing Beside does.
  assert.equal(placement('automatic', middling), 'below');
  assert.equal(placement('beside', middling), 'beside');
  assert.equal(placement('beside', narrow), 'below');
  assert.equal(placement('below', wide), 'below');
});

test('an upright phone pins the chat under the picture unless it was put under the details', () => {
  const phone = {beside: false, automatic: false, pinned: true};
  assert.equal(placement('automatic', phone), 'pinned');
  assert.equal(placement('beside', phone), 'pinned');
  assert.equal(placement('below', phone), 'below');
  assert.equal(placement('overlay', phone), 'overlay');
  assert.equal(placement('automatic', {...phone, fullscreen: true}), 'overlay');
});

test('an unknown or missing choice of chat position is Automatic', () => {
  assert.equal(chosenPosition(null), 'automatic');
  assert.equal(chosenPosition('sideways'), 'automatic');
  assert.equal(chosenPosition('below'), 'below');
});

test('fullscreen puts the chat over the picture whatever was chosen, as does choosing it', () => {
  for (const choice of ['automatic', 'beside', 'below', 'overlay']) {
    assert.equal(placement(choice, {beside: true, automatic: true, fullscreen: true}), 'overlay');
  }
  assert.equal(placement('overlay', {beside: false, automatic: false}), 'overlay');
  assert.equal(chosenPosition('overlay'), 'overlay');
});
