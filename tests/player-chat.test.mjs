import assert from 'node:assert/strict';
import test from 'node:test';
import {WINDOW_MS, between, formatOffset, newestUpTo, windowOf} from '../web/player-chat.js';

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
