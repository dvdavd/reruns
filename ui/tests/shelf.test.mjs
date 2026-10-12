import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShelfRows, fitShelfRows, gridColumns, watchColumns,
} from '../shared/lib/shelf.js';

// A DOM small enough to state the contract: a track whose computed grid
// template is whatever the test says, and cards that can be hidden.
function makeTrack(template, cardCount = 0) {
  const cards = Array.from({length: cardCount}, () => ({hidden: false}));
  const track = {
    template,
    cards,
    querySelectorAll: () => cards,
  };
  globalThis.getComputedStyle = element => ({gridTemplateColumns: element.template});
  return track;
}

function makeButton() {
  return {
    hidden: false,
    textContent: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, handler) { this.handlers = {...this.handlers, [type]: handler}; },
    click() { this.handlers?.click?.(); },
  };
}

test('the column count comes from the laid-out grid template', () => {
  assert.equal(gridColumns(makeTrack('240px 240px 240px')), 3);
  assert.equal(gridColumns(makeTrack('240px')), 1);
});

test('a track that is not laid out still counts as one column', () => {
  // `none` is no columns at all, not one column named none: counting it as a
  // column would be harmless here, but reading it as zero would cap a shelf
  // at nothing once it is shown again.
  assert.equal(gridColumns(makeTrack('none')), 1);
  assert.equal(gridColumns(makeTrack('')), 1);
});

test('watching reports only real changes in the column count', () => {
  const track = makeTrack('240px 240px');
  let observed = null;
  let disconnected = false;
  globalThis.window = {ResizeObserver: true};
  globalThis.ResizeObserver = class {
    constructor(callback) { observed = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };

  let changes = 0;
  const stop = watchColumns(track, () => { changes += 1; });

  observed();  // Same width: the shelf does not need redrawing.
  assert.equal(changes, 0);
  track.template = '240px 240px 240px';
  observed();
  assert.equal(changes, 1);
  observed();  // Still three columns.
  assert.equal(changes, 1);

  stop();
  assert.ok(disconnected);
});

test('hiding a shelf does not report a one-column resize', () => {
  const track = makeTrack('240px 240px 240px');
  track.visible = true;
  track.getClientRects = () => track.visible ? [{}] : [];
  let observed;
  globalThis.window = {ResizeObserver: true};
  globalThis.ResizeObserver = class {
    constructor(callback) { observed = callback; }
    observe() {}
    disconnect() {}
  };
  let draws = 0;
  const rows = createShelfRows({track, rows: 2, onChange: () => { draws += 1; }}).watch();
  const entries = Array.from({length: 9}, (_, index) => index);
  assert.equal(rows.take(entries).length, 6);

  track.visible = false;
  track.template = 'none';
  observed();
  assert.equal(draws, 0);
  assert.equal(rows.take(entries).length, 6);

  track.visible = true;
  track.template = '240px 240px 240px';
  observed();
  assert.equal(draws, 0);
  assert.equal(rows.take(entries).length, 6);

  track.template = '200px 200px';
  observed();
  assert.equal(draws, 1);
  assert.equal(rows.take(entries).length, 4);
  rows.stop();
});

test('watching falls back to the resize event without a ResizeObserver', () => {
  const track = makeTrack('240px');
  const listeners = [];
  globalThis.window = {
    addEventListener: (type, handler) => listeners.push([type, handler]),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex(entry => entry[0] === type && entry[1] === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  delete globalThis.ResizeObserver;

  const stop = watchColumns(track, () => {});
  assert.deepEqual(listeners.map(([type]) => type), ['resize']);
  stop();
  assert.equal(listeners.length, 0);
});

test('fitting rows hides the cards past the rows the shelf is allowed', () => {
  const track = makeTrack('240px 240px 240px', 8);
  assert.equal(fitShelfRows(track, {rows: 2}), 6);
  assert.deepEqual(track.cards.map(card => card.hidden),
                   [false, false, false, false, false, false, true, true]);
});

test('fitting rows shows every card when the shelf has room to spare', () => {
  const track = makeTrack('240px 240px 240px', 2);
  assert.equal(fitShelfRows(track, {rows: 1}), 2);
  assert.deepEqual(track.cards.map(card => card.hidden), [false, false]);
});

test('a collapsed shelf takes one row, and More lifts the cap', () => {
  const track = makeTrack('240px 240px');
  const moreButton = makeButton();
  globalThis.window = {};
  let draws = 0;
  const rows = createShelfRows({track, moreButton, onChange: () => { draws += 1; }});
  const entries = [1, 2, 3, 4, 5];

  assert.deepEqual(rows.take(entries), [1, 2]);
  rows.sync(entries.length);
  assert.equal(moreButton.hidden, false);
  assert.equal(moreButton.attributes['aria-label'], 'More');
  assert.equal(moreButton.attributes['aria-expanded'], 'false');

  moreButton.click();
  assert.equal(draws, 1);
  assert.ok(rows.expanded);
  assert.deepEqual(rows.take(entries), entries);
  rows.sync(entries.length);
  assert.equal(moreButton.attributes['aria-label'], 'Less');
  assert.equal(moreButton.attributes['aria-expanded'], 'true');
});

test('More stays hidden while the shelf holds nothing back', () => {
  const track = makeTrack('240px 240px 240px');
  const moreButton = makeButton();
  globalThis.window = {};
  const rows = createShelfRows({track, moreButton});
  rows.sync(3);
  assert.equal(moreButton.hidden, true);
});

test('a shelf two rows tall caps at both of them', () => {
  const track = makeTrack('240px 240px 240px');
  globalThis.window = {};
  const rows = createShelfRows({track, rows: 2});
  assert.equal(rows.take(Array.from({length: 10}, (_, index) => index)).length, 6);
});

test('a shelf with no More button cannot be expanded', () => {
  const track = makeTrack('240px');
  globalThis.window = {};
  const rows = createShelfRows({track});
  rows.sync(5);  // Nothing to point at, and nothing to throw.
  assert.equal(rows.expanded, false);
  assert.deepEqual(rows.take([1, 2, 3]), [1]);
});

test('a shelf redraws when its column count changes, until it stops', () => {
  const track = makeTrack('240px 240px');
  let observed = null;
  globalThis.window = {ResizeObserver: true};
  globalThis.ResizeObserver = class {
    constructor(callback) { observed = callback; }
    observe() {}
    disconnect() { observed = null; }
  };
  let draws = 0;
  const rows = createShelfRows({track, onChange: () => { draws += 1; }}).watch();

  track.template = '240px';
  observed();
  assert.equal(draws, 1);

  rows.stop();
  assert.equal(observed, null);
});

test("the shelf labels its button in the caller's own words", () => {
  const track = makeTrack('240px');
  const moreButton = makeButton();
  globalThis.window = {};
  const rows = createShelfRows({track, moreButton, labels: {more: 'Show all', less: 'Show fewer'}});
  rows.sync(4);
  assert.equal(moreButton.attributes['aria-label'], 'Show all');
  moreButton.click();
  rows.sync(4);
  assert.equal(moreButton.attributes['aria-label'], 'Show fewer');
});
