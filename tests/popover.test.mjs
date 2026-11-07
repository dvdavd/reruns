import assert from 'node:assert/strict';
import test from 'node:test';

import {placePopover, placeSidePopover} from '../web/popover.js';

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

test('a popover opens towards the middle of the screen, or as it is told', () => {
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;
  const leftHalf = panel(300);
  placePopover(button(20, 60), leftHalf, 6, null, 'down', 'auto');
  assert.equal(leftHalf.style.left, '20px');

  const rightHalf = panel(300);
  placePopover(button(900, 940), rightHalf, 6, null, 'down', 'auto');
  assert.equal(rightHalf.style.left, '640px');

  // A card's menu opens over its card wherever the card is.
  const cardMenu = panel(300);
  placePopover(button(200, 240), cardMenu, 6, null, 'up', 'end');
  assert.equal(cardMenu.style.left, '6px');

  // Still kept on the screen when the room runs out on the side it chose.
  const clamped = panel(300);
  placePopover(button(450, 490), clamped, 6, null, 'down', 'start');
  assert.equal(clamped.style.left, '450px');
  placePopover(button(800, 840), clamped, 6, null, 'down', 'start');
  assert.equal(clamped.style.left, '694px');
});
