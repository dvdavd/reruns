// Render contract for the shared entity picker. It replaced two near-identical
// builders in search-catalog.js — the actor checkbox list and the studio radio
// list — so these pin the ordering, grouping and data-* attributes that the
// save handlers and CSS depend on.
import assert from 'node:assert/strict';
import test from 'node:test';

import render from '../vendor/preact/render-to-string.module.js';
import {html} from '../shared/lib/html.js';
import {EntityPicker} from '../shared/components/EntityPicker.js';

const draw = props => render(html`<${EntityPicker} ...${props} />`);

const people = [
  {id: 1, name: 'Ada'},
  {id: 2, name: 'Bo'},
  {id: 3, name: 'Cy'},
];

/** The order labels appear in, which is what the viewer actually sees. */
const order = out => [...out.matchAll(/<label[^>]*>(?:.*?)<\/input>?|<\/label>/g)] && [
  ...out.matchAll(/<label[^>]*>.*?<input[^>]*\/>([^<]*)</g)].map(m => m[1].trim());

test('multi-select renders a checkbox per entity carrying its id', () => {
  const out = draw({entities: people, multiple: true, idAttribute: 'data-actor-id'});
  assert.equal((out.match(/type="checkbox"/g) || []).length, 3);
  assert.match(out, /data-actor-id="1"/);
  assert.match(out, /value="2"/);
});

test('a ticked entity is checked', () => {
  const out = draw({
    entities: people, multiple: true, selected: new Set(['2']),
    idAttribute: 'data-actor-id',
  });
  // Only Bo is checked, so exactly one checkbox carries the attribute.
  assert.equal((out.match(/checked/g) || []).length, 1);
});

test('selected and recent entries are grouped above the rest', () => {
  const out = draw({
    entities: people, multiple: true, selected: new Set(['3']), recent: ['Ada'],
    idAttribute: 'data-actor-id',
  });
  assert.match(out, /class="entity-options-heading">Selected &amp; recent</);
  assert.match(out, /entity-options-heading-all">All names</);
  assert.deepEqual(order(out), ['Cy', 'Ada', 'Bo']);
});

test('with nothing selected the priority heading names only recents', () => {
  const out = draw({entities: people, multiple: true, recent: ['Bo']});
  assert.match(out, /class="entity-options-heading">Recently used</);
  assert.deepEqual(order(out), ['Bo', 'Ada', 'Cy']);
});

test('a query drops the recents, but a selected entry still groups', () => {
  // Recents are noise once the viewer is searching; a ticked name is not, and
  // must stay visible rather than being buried in the filtered list.
  const plain = draw({entities: people, multiple: true, recent: ['Bo'], query: 'a'});
  assert.doesNotMatch(plain, /entity-options-heading/);
  assert.deepEqual(order(plain), ['Ada', 'Bo', 'Cy']);

  const withSelection = draw({
    entities: people, multiple: true, recent: ['Bo'], selected: new Set(['3']), query: 'a',
  });
  assert.match(withSelection, /class="entity-options-heading">Selected &amp; recent</);
  assert.deepEqual(order(withSelection), ['Cy', 'Ada', 'Bo']);
});

test('pending names sort first, are ticked, and are marked new', () => {
  const out = draw({
    entities: people, multiple: true, pending: new Set(['Zed']),
    newAttribute: 'data-new-actor',
  });
  assert.match(out, /class="is-custom"/);
  assert.match(out, /data-new-actor="Zed"/);
  assert.equal(order(out)[0], 'Zed (new)');
});

test('a query filters the pending names too', () => {
  const out = draw({entities: [], multiple: true, pending: new Set(['Zed']), query: 'q'});
  assert.doesNotMatch(out, /Zed/);
});

test('the list is capped, and says how much it is hiding', () => {
  const many = Array.from({length: 90}, (_, index) => ({id: index, name: `N${index}`}));
  const out = draw({entities: many, multiple: true, limit: 80});
  assert.equal((out.match(/type="checkbox"/g) || []).length, 80);
  assert.match(out, /Showing 80 of 90 matches — type to narrow the list/);
});

test('an empty multi-select explains itself either way', () => {
  assert.match(draw({entities: [], multiple: true}), /No existing names/);
  assert.match(draw({entities: [], multiple: true, query: 'zz'}), /Press Enter to add this name/);
});

test('single-select renders radios sharing one name, plus an explicit none', () => {
  const out = draw({
    entities: people, radioName: 'studio-choice', labels: {none: 'No studio'},
  });
  assert.equal((out.match(/type="radio"/g) || []).length, 4);
  assert.equal((out.match(/name="studio-choice"/g) || []).length, 4);
  assert.match(out, /No studio/);
});

test('single-select checks none when nothing is chosen', () => {
  const out = draw({entities: people, labels: {none: 'No studio'}});
  // Preact renders an empty value as a bare attribute.
  assert.match(out, /name="entity-choice" value checked/);
});

test('single-select checks the chosen entity', () => {
  const out = draw({entities: people, chosenId: '2'});
  assert.match(out, /value="2" checked/);
  assert.doesNotMatch(out, /value checked/);
});

test('a pending name outranks the chosen entity and sorts first', () => {
  const out = draw({
    entities: people, chosenId: '2', pendingName: 'New Co',
    newAttribute: 'data-new-studio',
  });
  assert.match(out, /data-new-studio="New Co"/);
  assert.equal(order(out)[0], 'New Co (new)');
  assert.doesNotMatch(out, /value checked/);
});

test('single-select offers to create only when a query found nothing', () => {
  const out = draw({entities: [], query: 'zz', labels: {createHint: 'Press Enter to create this studio'}});
  assert.match(out, /Press Enter to create this studio/);
  assert.doesNotMatch(draw({entities: people, query: 'a'}), /Press Enter/);
  assert.doesNotMatch(draw({entities: [], query: ''}), /Press Enter/);
});

test('a name with markup is escaped', () => {
  const out = draw({entities: [{id: 1, name: '<img onerror=x>'}], multiple: true});
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});
