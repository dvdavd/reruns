// Render contract for the shared catalogue row. The assertions target the
// class names, data-* attributes and ARIA that the CSS and the delegated
// listeners in search-catalog.js depend on, so a regression here means the
// ported row stopped matching what renderEntityRows used to build.
import assert from 'node:assert/strict';
import test from 'node:test';

import render from '../vendor/preact/render-to-string.module.js';
import {html} from '../shared/lib/html.js';
import {EntityRow} from '../shared/components/EntityRow.js';
import {countLabel, deletionPrompt, toEntity} from '../shared/lib/entity.js';

// Example consumer vocabulary.
const VIDEO_LABELS = {itemSingular: 'video', itemPlural: 'videos'};

const draw = props => render(html`<${EntityRow} ...${props} />`);

const actor = (overrides = {}) => toEntity(
  {id: 7, name: 'Ada Lovelace', video_count: 3, ...overrides},
  {portrait: true},
);

const studio = (overrides = {}) => toEntity(
  {id: 4, name: 'Studio X', video_count: 0, ...overrides},
);

test('toEntity accepts the catalogue payload', () => {
  const entity = actor({favourite: 1});
  assert.equal(entity.id, 7);
  assert.equal(entity.itemCount, 3);
  assert.equal(entity.favourite, true);
  assert.equal(entity.portrait, true);
});

test('the row carries the id the delegated listeners read', () => {
  assert.match(draw({entity: actor()}), /class="entity-row" data-entity-id="7"/);
});

test('the identity button carries the app-supplied filter attribute', () => {
  const out = draw({entity: actor(), filterAttribute: 'data-actor-filter'});
  assert.match(out, /data-actor-filter="Ada Lovelace"/);
  const owner = draw({entity: studio(), filterAttribute: 'data-studio-filter'});
  assert.match(owner, /data-studio-filter="Studio X"/);
});

test('the count chip pluralises on the app noun', () => {
  assert.match(draw({entity: actor(), labels: VIDEO_LABELS}), /entity-count-chip">3 videos</);
  assert.match(draw({entity: actor({video_count: 1}), labels: VIDEO_LABELS}), /entity-count-chip">1 video</);
  assert.equal(countLabel(0, VIDEO_LABELS), '0 videos');
});

test('only an entity with a portrait renders one', () => {
  assert.match(draw({entity: actor()}), /class="entity-portrait"/);
  assert.doesNotMatch(draw({entity: studio()}), /entity-portrait/);
});

test('the portrait carries whatever attributes the app lazy-loads by', () => {
  // A consumer's observer reads data-actor-portrait; another app reads its own,
  // so the row must not presume either.
  const out = draw({
    entity: actor(),
    portraitAttributes: entity => ({'data-actor-portrait': '', 'data-actor-id': entity.id}),
  });
  assert.match(out, /data-actor-portrait/);
  assert.match(out, /data-actor-id="7"/);

  const other = draw({
    entity: actor(),
    portraitAttributes: entity => ({'data-avatar': String(entity.id)}),
  });
  assert.match(other, /data-avatar="7"/);
  assert.doesNotMatch(other, /data-actor/);
});

test('only an entity with a portrait offers to regenerate one', () => {
  assert.match(draw({entity: actor()}), /data-entity-action="regenerate-portrait"/);
  assert.doesNotMatch(draw({entity: studio()}), /regenerate-portrait/);
});

test('rename and delete are always offered, delete marked dangerous', () => {
  const out = draw({entity: studio()});
  assert.match(out, /data-entity-action="rename"/);
  assert.match(out, /data-entity-action="delete"[^>]*class="entity-icon-button danger"|class="entity-icon-button danger"[^>]*data-entity-action="delete"/);
});

test('the rename form starts hidden and is seeded with the current name', () => {
  const out = draw({entity: actor()});
  assert.match(out, /data-entity-rename[^>]*hidden/);
  assert.match(out, /value="Ada Lovelace"/);
});

test('the delete panel starts hidden and explains the consequence', () => {
  const out = draw({entity: actor(), labels: VIDEO_LABELS});
  assert.match(out, /data-entity-delete[^>]*hidden/);
  assert.match(out, /Reassign 3 videos before deleting\?/);
});

test('an entity with no items needs no reassignment', () => {
  const out = draw({entity: studio(), labels: VIDEO_LABELS});
  assert.match(out, /This entry has no associated items\./);
  // The replacement select is pointless with nothing to reassign.
  assert.match(out, /data-entity-replacement[^>]*hidden/);
  assert.equal(deletionPrompt(studio(), VIDEO_LABELS), 'This entry has no associated items.');
});

test('labels are overridable so another app can use its own words', () => {
  const out = draw({
    entity: toEntity({id: 1, name: 'Some Channel', video_count: 2}),
    labels: {itemSingular: 'upload', itemPlural: 'uploads', rename: 'Edit name',
             view: name => `Open ${name}`},
  });
  assert.match(out, /2 uploads/);
  assert.match(out, /aria-label="Edit name Some Channel"/);
  assert.match(out, /aria-label="Open Some Channel"/);
});

test('a name with markup is escaped rather than interpolated', () => {
  const out = draw({entity: toEntity({id: 2, name: '<script>x</script>', video_count: 0})});
  // Escaping the opening bracket is what makes it inert; a bare `>` is safe.
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script>x&lt;\/script>/);
});
