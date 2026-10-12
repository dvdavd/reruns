import assert from 'node:assert/strict';
import test from 'node:test';
import {createDrawerControls, createDrawerAddControls} from '../web/drawer.js';

test('header Add reveals and focuses the form, and hides it after creation', () => {
  let click;
  let focused = 0;
  const attributes = {};
  const button = {
    innerHTML: '<svg></svg>Add account',
    addEventListener(type, listener) { assert.equal(type, 'click'); click = listener; },
    setAttribute(name, value) { attributes[name] = value; },
  };
  const form = {hidden: true, querySelector: () => ({focus() { focused++; }})};
  const controls = createDrawerAddControls(button, form);
  click();
  assert.equal(form.hidden, false);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(button.innerHTML, 'Cancel');
  assert.equal(focused, 1);
  click();
  assert.equal(form.hidden, true);
  assert.equal(attributes['aria-expanded'], 'false');
  assert.equal(button.innerHTML, '<svg></svg>Add account');
  assert.equal(focused, 1);
  click();
  controls.hide();
  assert.equal(form.hidden, true);
  assert.equal(attributes['aria-expanded'], 'false');
});

test('drawer close guard covers Close, Escape, and backdrop clicks', () => {
  const listeners = {};
  const classes = new Set();
  let allowed = false;
  let attempts = 0;
  let closed = 0;
  const drawer = {
    open: true,
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name),
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    getBoundingClientRect: () => ({left: 100}),
    close() { closed++; },
  };
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({transitionDuration: '0s', transitionDelay: '0s'});
  try {
    const controls = createDrawerControls(drawer, {beforeClose() { attempts++; return allowed; }});
    controls.close();
    listeners.cancel({preventDefault() {}});
    listeners.click({target: drawer, clientX: 50});
    assert.equal(attempts, 3);
    assert.equal(closed, 0);
    listeners.click({target: drawer, clientX: 150});
    assert.equal(attempts, 3);
    allowed = true;
    controls.close();
    assert.equal(closed, 1);
  } finally {
    globalThis.getComputedStyle = previous;
  }
});

test('the creation section toggles without hiding its form', () => {
  let click;
  const button = {addEventListener(type, listener) { click = listener; }, setAttribute() {}};
  const section = {hidden: true};
  let focused = false;
  const form = {
    hidden: false,
    closest: () => section,
    querySelector: () => ({focus(options) {
      assert.deepEqual(options, {preventScroll: true});
      focused = true;
    }}),
  };
  const controls = createDrawerAddControls(button, form);
  click();
  assert.equal(section.hidden, false);
  assert.equal(form.hidden, false);
  assert.equal(focused, true);
  controls.hide();
  assert.equal(section.hidden, true);
  assert.equal(form.hidden, false);
});
