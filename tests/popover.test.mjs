import assert from 'node:assert/strict';
import test from 'node:test';

import {placeSidePopover} from '../web/popover.js';

function panel(width = 350, height = 250) {
  return {style: {}, getBoundingClientRect: () => ({width, height})};
}

function button(left, right, top = 100, bottom = 130) {
  return {getBoundingClientRect: () => ({left, right, top, bottom})};
}

test('a side popover flips left and falls below on narrow screens', () => {
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;
  const leftPanel = panel();
  assert.equal(placeSidePopover(button(650, 850), leftPanel), 'left');
  assert.equal(leftPanel.style.left, '294px');

  const rightPanel = panel();
  assert.equal(placeSidePopover(button(100, 300), rightPanel), 'right');
  assert.equal(rightPanel.style.left, '306px');

  globalThis.innerWidth = 320;
  const narrowPanel = panel(280);
  assert.equal(placeSidePopover(button(100, 300), narrowPanel), 'down');
  assert.equal(narrowPanel.style.top, '136px');
});
