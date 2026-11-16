// The search field centres only while there is room either side of it, and
// the room is measured from what is actually in the bar.
import assert from 'node:assert/strict';
import test from 'node:test';

import {MIN_CENTRED_SPACE, SEARCH_BUTTONS_RESERVE, centredSearchOffset} from '../web/topbar-centring.js';

// Roughly the bar as drawn: logo and page buttons end at 232, the folder
// picker reads "All videos", and settings is alone at the right.
const bar = {paddingRight: 14, navEnd: 232, gap: 14, folder: 136, end: 36, field: 560};

test('a wide bar centres the field, and the form starts that far past the page buttons', () => {
  const offset = centredSearchOffset({...bar, barWidth: 1920});
  assert.equal(offset, (1920 - 560) / 2 - (232 + 14));
});

test('the field snaps back to full width once the folder picker would crowd it', () => {
  // The folder picker ends at 232 + 14 + 136 = 382, so the field's left edge
  // needs to be MIN_CENTRED_SPACE past that.
  const edge = 2 * (382 + MIN_CENTRED_SPACE) + 560;
  assert.notEqual(centredSearchOffset({...bar, barWidth: edge}), null);
  assert.equal(centredSearchOffset({...bar, barWidth: edge - 2}), null);
});

test('a longer folder name moves the snap to a wider bar', () => {
  assert.notEqual(centredSearchOffset({...bar, barWidth: 1440}), null);
  assert.equal(centredSearchOffset({...bar, folder: 200, barWidth: 1440}), null);
});

test('without the folder picker the right side decides, holding room for a link\'s buttons', () => {
  const noFolder = {...bar, folder: 0};
  const right = SEARCH_BUTTONS_RESERVE + 14 + 36 + 14 + 14;
  const edge = 2 * right + 560;
  assert.notEqual(centredSearchOffset({...noFolder, barWidth: edge}), null);
  assert.equal(centredSearchOffset({...noFolder, barWidth: edge - 2}), null);
});
