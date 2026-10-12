import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCardAccent, cardOfThumbnail, CARD_SELECTOR,
} from '../shared/lib/card-accent.js';

// A card small enough to state the contract: something with a style it can be
// asked to set a custom property on.
function makeCard(dataset = {}) {
  const properties = {};
  return {
    dataset,
    properties,
    style: {setProperty(name, value) { properties[name] = value; }},
  };
}

const ACCENT = 'oklch(62% 0.18 250)';

test('the accent lands on the element, so the card changes now', () => {
  const card = makeCard();
  applyCardAccent(card, ACCENT);
  assert.equal(card.properties['--card-accent'], ACCENT);
});

test('the accent lands on the item too, so the next render keeps it', () => {
  // Without this the colour lasts until the card re-renders from its item and
  // the style attribute Preact owns is written fresh.
  const item = {id: 'a', parts: []};
  const card = makeCard({id: 'a'});
  const written = applyCardAccent(card, ACCENT, {itemFor: () => item});
  assert.equal(item.accent, ACCENT);
  assert.equal(written, item);
});

test('a card showing one part of several accents that part', () => {
  // A part's own accent wins over the item's when the card re-renders, so an
  // item-only write would be overwritten by a stale part.
  const item = {id: 'a', parts: [{accent: 'old'}, {accent: 'old'}]};
  const card = makeCard({id: 'a', partIndex: '1'});
  applyCardAccent(card, ACCENT, {
    itemFor: () => item,
    partFor: (found, element) => found.parts[Number(element.dataset.partIndex || 0)],
  });
  assert.equal(item.accent, ACCENT);
  assert.deepEqual(item.parts.map(part => part.accent), ['old', ACCENT]);
});

test('an item the app cannot place still tints its card', () => {
  const card = makeCard({id: 'gone'});
  assert.equal(applyCardAccent(card, ACCENT, {itemFor: () => null}), null);
  assert.equal(card.properties['--card-accent'], ACCENT);
});

test('a part the app cannot place leaves the other parts alone', () => {
  const item = {id: 'a', parts: [{accent: 'old'}]};
  const card = makeCard({id: 'a', partIndex: '4'});
  applyCardAccent(card, ACCENT, {itemFor: () => item, partFor: () => undefined});
  assert.equal(item.accent, ACCENT);
  assert.deepEqual(item.parts.map(part => part.accent), ['old']);
});

test('no card and no accent are both nothing to do', () => {
  assert.equal(applyCardAccent(null, ACCENT), null);
  const card = makeCard();
  assert.equal(applyCardAccent(card, ''), null);
  assert.deepEqual(card.properties, {});
});

test('a thumbnail finds the card it is in', () => {
  const card = makeCard();
  const image = {closest: selector => (selector === CARD_SELECTOR ? card : null)};
  assert.equal(cardOfThumbnail(image), card);
  assert.equal(cardOfThumbnail(null), null);
  assert.equal(cardOfThumbnail({}), null);
});
