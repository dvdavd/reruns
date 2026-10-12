import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

// A DOM small enough to state the contract chrome.js relies on: elements that
// listen, a document that dispatches, and menu items found by role.
function makeDom() {
  const listeners = {click: [], keydown: []};
  const make = (overrides = {}) => ({
    hidden: false,
    attributes: {},
    focused: false,
    dataset: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() { this.focused = true; },
    contains(node) { return node === this || this.children.includes(node); },
    querySelector() { return this.children[0] ?? null; },
    querySelectorAll() { return this.children; },
    addEventListener(type, handler) { (this.own ??= {})[type] = handler; },
    ...overrides,
  });
  globalThis.document = {
    addEventListener(type, handler) { listeners[type].push(handler); },
  };
  const dispatch = (type, event) => listeners[type].forEach(handler => handler(event));
  return {make, dispatch};
}

const {make, dispatch} = makeDom();
const {createMenu, selectMenuValue, selectedMenuValue} = await import('../shared/chrome.js');

function menuFixture() {
  const item = make({dataset: {sort: 'title'}, attributes: {role: 'menuitemcheckbox'}});
  item.closest = selector => (selector === '[role^="menuitem"]' ? item : null);
  const menu = make({hidden: true, children: [item]});
  const button = make();
  return {button, menu, item};
}

test('the menu button opens, closes and moves focus into the menu', () => {
  const {button, menu} = menuFixture();
  const controller = createMenu({button, menu});
  button.own.click();
  assert.equal(menu.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.children[0].focused, true);
  button.own.click();
  assert.equal(controller.isOpen(), false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('a closing fade keeps menu contents rendered until it ends', async () => {
  const {button, menu} = menuFixture();
  createMenu({button, menu, closeDelay: 10});
  button.own.click();
  button.own.click();
  assert.equal(menu.hidden, false);
  assert.equal(menu.inert, true);
  assert.equal(menu.dataset.closing, 'true');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(menu.hidden, true);
  assert.equal(menu.inert, false);
});

test('choosing an item closes the menu and reports it to the app', () => {
  const {button, menu, item} = menuFixture();
  const chosen = [];
  createMenu({button, menu, onSelect: selected => chosen.push(selected)});
  button.own.click();
  menu.own.click({target: item});
  assert.deepEqual(chosen, [item]);
  assert.equal(menu.hidden, true);
});

test('an outside click and Escape both close an open menu', () => {
  const {button, menu} = menuFixture();
  createMenu({button, menu});

  button.own.click();
  dispatch('click', {target: make()});
  assert.equal(menu.hidden, true);

  button.own.click();
  dispatch('click', {target: menu});
  assert.equal(menu.hidden, false, 'a click inside the menu must not close it');

  let prevented = false;
  dispatch('keydown', {key: 'Escape', preventDefault() { prevented = true; }});
  assert.equal(menu.hidden, true);
  assert.equal(prevented, true);
  assert.equal(button.focused, true, 'Escape returns focus to the button');
});

test('a menu acts single-select through aria-checked', () => {
  const items = ['latest', 'title', 'size'].map(value =>
    make({dataset: {sort: value}, attributes: {role: 'menuitemcheckbox'}}));
  const menu = make({children: items, querySelectorAll: () => items});
  assert.equal(selectMenuValue(menu, 'title', 'sort'), 'title');
  assert.deepEqual(items.map(item => item.getAttribute('aria-checked')),
    ['false', 'true', 'false']);
  assert.equal(selectedMenuValue(menu, 'sort'), 'title');
});

test('an unmarked menu falls back to its first option', () => {
  const items = [make({dataset: {sort: 'latest'}}), make({dataset: {sort: 'title'}})];
  const menu = make({children: items, querySelectorAll: () => items});
  assert.equal(selectedMenuValue(menu, 'sort'), 'latest');
});

test('the chrome stylesheet carries the contract its markup depends on', async () => {
  const source = await readFile(new URL('../shared/chrome.css', import.meta.url), 'utf8');
  // Consumers link this sheet on its own, so it must bring its own tokens.
  assert.match(source, /@import url\("\.\/tokens\.css"\)/);
  for (const selector of [
    '\\.topbar', '\\.topbar-search', '\\.topbar-actions', '\\.icon-button',
    '\\.settings-menu', '\\.search-clear-button', '\\.status-toast',
  ]) assert.match(source, new RegExp(`${selector}\\b`), selector);
  // The check mark is what makes a menu read as single-select.
  assert.match(source, /\[role="menuitemcheckbox"\]\[aria-checked="true"\]::after/);
});
