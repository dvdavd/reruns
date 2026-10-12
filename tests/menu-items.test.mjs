import test from 'node:test';
import assert from 'node:assert/strict';
import {withoutStrayDividers} from '../web/menu-items.js';

const divider = {type: 'divider'};
const labels = entries => entries.map(entry => entry.action || '|').join(' ');

test('a divider left trailing by a hidden delete goes with it', () => {
  assert.equal(labels(withoutStrayDividers([
    {action: 'save-file'}, divider, {action: 'source'}, {action: 'copy'}, divider,
  ])), 'save-file | source copy');
});

test('leading and doubled dividers are dropped, and a full menu is untouched', () => {
  assert.equal(labels(withoutStrayDividers([
    divider, {action: 'source'}, divider, divider, {action: 'delete'},
  ])), 'source | delete');
  assert.equal(labels(withoutStrayDividers([{action: 'a'}, divider, {action: 'b'}])), 'a | b');
  assert.deepEqual(withoutStrayDividers([divider]), []);
});
