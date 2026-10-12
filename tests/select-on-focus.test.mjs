import assert from 'node:assert/strict';
import test from 'node:test';

import {selectOnFocus} from '../web/select-on-focus.js';

/** Just enough of an input to drive the listeners the module binds. */
function fakeInput() {
  const listeners = new Map();
  const input = {
    selected: 0,
    ownerDocument: {activeElement: null},
    addEventListener: (type, handler) => listeners.set(type, handler),
    select() { this.selected += 1; },
    fire(type, event = {}) { listeners.get(type)?.(event); },
  };
  return input;
}

function clickEvent() {
  return {defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }};
}

test('clicking an unfocused field keeps the selection focus made', () => {
  const input = fakeInput();
  selectOnFocus(input);
  input.fire('pointerdown');
  input.ownerDocument.activeElement = input;
  input.fire('focus');
  const click = clickEvent();
  input.fire('mouseup', click);
  assert.equal(input.selected, 1);
  assert.equal(click.defaultPrevented, true);
});

test('a drag inside a field already focused selects by hand', () => {
  const input = fakeInput();
  selectOnFocus(input);
  input.ownerDocument.activeElement = input;
  input.fire('pointerdown');
  const click = clickEvent();
  input.fire('mouseup', click);
  assert.equal(input.selected, 0);
  assert.equal(click.defaultPrevented, false);
});

test('a click that wandered off does not arm the next one', () => {
  const input = fakeInput();
  selectOnFocus(input);
  input.fire('pointerdown');
  input.fire('focus');
  input.fire('blur');
  input.ownerDocument.activeElement = input;
  const click = clickEvent();
  input.fire('mouseup', click);
  assert.equal(click.defaultPrevented, false);
});

test('nothing is bound when the field is not there', () => {
  assert.doesNotThrow(() => selectOnFocus(null));
});
