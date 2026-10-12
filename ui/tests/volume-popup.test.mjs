import assert from 'node:assert/strict';
import test from 'node:test';

import {createVolumePopup, volumeLevel} from '../shared/lib/volume-popup.js';

test('the volume glyph follows the level, and muting overrides it', () => {
  assert.equal(volumeLevel({muted: false, volume: 1}), 'high');
  assert.equal(volumeLevel({muted: false, volume: .5}), 'medium');
  assert.equal(volumeLevel({muted: false, volume: 0}), 'zero');
  assert.equal(volumeLevel({muted: true, volume: 1}), 'muted');
});

/** Just enough of an element for the popup: attributes, classes, events. */
function element() {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  return {
    style: {}, offsetWidth: 44, children: [],
    classList: {add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name)},
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; },
    getAttribute: name => attributes[name] ?? null,
    getBoundingClientRect: () => ({left: 100, top: 500, width: 32}),
    contains(target) { return target === this || this.children.includes(target); },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    emit(type, event) { for (const handler of listeners[type] || []) handler(event); },
    focus() {},
  };
}

test('the pill opens over its button and goes on a press elsewhere or Escape', () => {
  const documentListeners = [];
  globalThis.document = {addEventListener: (type, handler) => documentListeners.push(handler)};
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  const button = element();
  const popup = element();
  const slider = element();
  popup.children.push(slider);
  const toggles = [];
  const control = createVolumePopup({button, popup, slider, onToggle: open => toggles.push(open)});

  control.show();
  assert.equal(control.open, true);
  assert.ok(popup.classList.contains('is-open'));
  assert.equal(popup.style.bottom, '106px');
  assert.equal(button.getAttribute('aria-expanded'), 'true');

  // A press inside the pill leaves it up.
  for (const handler of documentListeners) handler({target: slider});
  assert.equal(control.open, true);
  assert.equal(control.takeDismissed(), false);

  // A press elsewhere puts it away, and says so once.
  for (const handler of documentListeners) handler({target: {}});
  assert.equal(control.open, false);
  assert.equal(popup.classList.contains('is-open'), false);
  assert.equal(control.takeDismissed(), true);
  assert.equal(control.takeDismissed(), false);

  control.show();
  popup.emit('keydown', {key: 'Escape', stopPropagation() {}});
  assert.equal(control.open, false);
  assert.deepEqual(toggles, [true, false, true, false]);
  delete globalThis.document;
});
