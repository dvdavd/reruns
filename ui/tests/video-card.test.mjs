// Render contract for the shared card. Assertions target the class names and
// ARIA the existing CSS and gallery code depend on, so a regression here means
// the ported card stopped matching _video_card.html.
import assert from 'node:assert/strict';
import test from 'node:test';

import render from '../vendor/preact/render-to-string.module.js';
import {html} from '../shared/lib/html.js';
import {VideoCard} from '../shared/components/VideoCard.js';

const baseItem = (overrides = {}) => ({
  id: '/library/beach.mp4',
  sourceRef: '/library/beach.mp4',
  title: 'Beach Day',
  filename: 'beach.mp4',
  quality: '4K',
  codec: 'hevc',
  favourite: false,
  thumbnail: {url: '/api/thumbnail-image?path=beach.mp4'},
  watch: {count: 0},
  session: {},
  parts: [{id: '/library/beach.mp4', sourceRef: '/library/beach.mp4', filename: 'beach.mp4',
           title: '', quality: '4K'}],
  facets: {},
  ...overrides,
});

const draw = props => render(html`<${VideoCard} ...${props} />`);

test('renders the article shell the gallery queries for', () => {
  const out = draw({item: baseItem()});
  assert.match(out, /<article class="video-card"/);
  assert.match(out, /data-library-card/);
  assert.match(out, /data-path="\/library\/beach\.mp4"/);
});

test('a shelf card is marked as such instead of a library card', () => {
  const out = draw({item: baseItem(), libraryCard: false});
  assert.match(out, /data-shelf-card="true"/);
  assert.doesNotMatch(out, /data-library-card/);
});

test('the title reads as the template composed it', () => {
  const out = draw({item: baseItem()});
  assert.match(out, /<div class="card-name">Beach Day<\/div>/);
});

test('a details URL makes the title a link to the watch page', () => {
  const out = draw({
    item: baseItem(), detailsUrlFor: () => '/?watch=beach', onOpenDetails() {},
  });
  assert.match(out, /<a class="card-name" href="\/\?watch=beach">Beach Day<\/a>/);
});

test('a card with an open action but no URL uses a title button', () => {
  const out = draw({item: baseItem(), onOpenDetails() {}});
  assert.match(out, /<button class="card-name" type="button">Beach Day<\/button>/);
});

test('a part title is appended to the card name', () => {
  const item = baseItem({
    parts: [
      {id: 'p1', sourceRef: 'p1', filename: 'a1.mp4', title: 'Arrival', label: 'A', quality: '4K'},
      {id: 'p2', sourceRef: 'p2', filename: 'a2.mp4', title: 'Departure', label: 'B', quality: '8K'},
    ],
  });
  assert.match(draw({item, partIndex: 1}), /<div class="card-name">Beach Day: Departure<\/div>/);
});

test('the watch chip hides at zero and shows the count otherwise', () => {
  assert.match(draw({item: baseItem()}), /watch-count-chip[^>]*hidden/);
  const watched = draw({item: baseItem({watch: {count: 3}})});
  assert.doesNotMatch(watched, /watch-count-chip[^>]*hidden/);
  assert.match(watched, /aria-label="3 watches"/);
});

test('part navigation and the indicator appear only when multipart', () => {
  assert.doesNotMatch(draw({item: baseItem()}), /part-navigation/);
  const item = baseItem({
    parts: [
      {id: 'p1', sourceRef: 'p1', filename: 'a1.mp4', label: 'A', quality: '4K'},
      {id: 'p2', sourceRef: 'p2', filename: 'a2.mp4', label: 'B', quality: '4K'},
    ],
  });
  const out = draw({item, partIndex: 1});
  assert.match(out, /part-navigation/);
  assert.match(out, /Part B · 2\/2/);
});

test('the favourite button reflects and labels its state', () => {
  assert.match(draw({item: baseItem()}), /aria-label="Add to favourite videos" aria-pressed="false"/);
  assert.match(
    draw({item: baseItem({favourite: true})}),
    /aria-label="Remove from favourite videos" aria-pressed="true"/,
  );
});

test('a card of something other than a video names its own favourites', () => {
  assert.match(draw({item: baseItem(), labels: {favourites: 'favourite playlists'}}),
               /aria-label="Add to favourite playlists"/);
});

test('owner and ordinal render as the studio and release chips did', () => {
  const out = draw({item: baseItem({facets: {owner: {id: 7, name: 'Studio X'}, ordinal: '042'}})});
  assert.match(out, /<button class="studio-chip"[^>]*>Studio X<\/button>/);
  assert.match(out, /<span class="release-chip">042<\/span>/);
  assert.match(out, /chip-divider/);
});

test('the divider is omitted when only one identity chip is present', () => {
  assert.doesNotMatch(draw({item: baseItem({facets: {owner: {name: 'Studio X'}}})}), /chip-divider/);
  assert.doesNotMatch(draw({item: baseItem({facets: {ordinal: '042'}})}), /chip-divider/);
});

test('people render as chips, with favourite state per person', () => {
  const out = draw({item: baseItem({facets: {people: [
    {id: 1, name: 'Ada', favourite: true},
    {id: 2, name: 'Bo', favourite: false},
  ]}})});
  assert.match(out, /Ada/);
  assert.match(out, /aria-label="Toggle favourite for Ada" aria-pressed="true"/);
  assert.match(out, /aria-label="Toggle favourite for Bo" aria-pressed="false"/);
});

test('an empty people list only offers the add affordance when it has an action', () => {
  const empty = draw({item: baseItem()});
  assert.doesNotMatch(empty, /add-actor-chip/);
  assert.doesNotMatch(empty, /card-actors/);
  assert.match(empty, /card-footer card-footer--single-row/);
  assert.match(
    draw({item: baseItem(), onAddPerson() {}}),
    /add-actor-chip[^>]*>\+ Add name/,
  );
});

test('facet labels are app-supplied', () => {
  const out = draw({
    item: baseItem(), labels: {addPerson: '+ Add channel'}, onAddPerson() {},
  });
  assert.match(out, /\+ Add channel/);
});

test('collections render as group chips and hide when empty', () => {
  assert.match(draw({item: baseItem()}), /group-chips[^>]*hidden/);
  const out = draw({item: baseItem({facets: {collections: [{id: 3, name: 'Summer'}]}})});
  assert.match(out, /group-chip-name">Summer</);
});

test('several collections share one chip when the app can open a menu for them', () => {
  const item = baseItem({facets: {collections: [{id: 3, name: 'Summer'}, {id: 4, name: 'Beach'}]}});
  const out = draw({item, onOpenCollections() {}});
  assert.match(out, /data-group-menu/);
  assert.doesNotMatch(out, /data-group-filter/);
  assert.match(draw({item}), /data-group-filter="Beach"/);
});

test('an injected play URL turns the thumbnail into a link', () => {
  const out = draw({
    item: baseItem(),
    playUrlFor: () => '/heresphere/media/9/0/beach.mp4',
    labels: {play: 'Play'},
  });
  assert.match(out, /<a class="thumbnail-button" href="\/heresphere\/media\/9\/0\/beach\.mp4"/);
  assert.match(out, /<a class="card-name" href="\/heresphere\/media\/9\/0\/beach\.mp4">Beach Day<\/a>/);
  assert.match(out, /external-play-details/);
});

test('without a play URL the thumbnail opens details', () => {
  const out = draw({item: baseItem()});
  assert.match(out, /<button class="thumbnail-button" type="button"/);
  assert.match(out, /aria-label="View details for Beach Day"/);
  assert.doesNotMatch(out, /external-play-details/);
});

test('the progress bar is hidden unless a session is live', () => {
  assert.match(draw({item: baseItem()}), /thumbnail-watch-progress[^>]*hidden/);
  const live = draw({item: baseItem({
    session: {active: true, progress: 45, expiresAt: Date.now() + 60_000},
  })});
  assert.doesNotMatch(live, /thumbnail-watch-progress[^>]*hidden/);
  assert.match(live, /aria-valuenow="45"/);
  assert.match(live, /width: 45%/);
});

test('menu items are app-supplied and reflect open state', () => {
  assert.match(draw({item: baseItem()}), /aria-expanded="false"/);
  const out = draw({
    item: baseItem(),
    menuOpen: true,
    menuItems: [{action: 'copy', label: 'Copy link'}, {action: 'delete', label: 'Remove', danger: true}],
  });
  assert.match(out, /aria-expanded="true"/);
  assert.match(out, /Copy link/);
  assert.match(out, /class="danger"/);
});

test('an accent is applied as the card custom property', () => {
  assert.match(draw({item: baseItem(), accent: 'oklch(62% 0.02 300)'}),
    /--card-accent: oklch\(62% 0\.02 300\)/);
});

test('an active part accent overrides the item accent', () => {
  const item = baseItem({
    accent: 'red',
    parts: [
      {id: 'p1', sourceRef: 'p1', filename: 'a1.mp4', accent: 'blue'},
      {id: 'p2', sourceRef: 'p2', filename: 'a2.mp4', accent: 'green'},
    ],
  });
  assert.match(draw({item, partIndex: 1}), /--card-accent: green/);
});

// The gallery renders these by the thousand, so a card's closed weight is a
// contract: menu markup and the unused heart variant must stay out of the DOM
// until they are needed. Regressions here show up as whole-UI lag.
test('a closed card omits the overflow menu contents', () => {
  const out = draw({item: baseItem()});
  assert.doesNotMatch(out, /role="menuitem"/);
  assert.match(out, /class="menu-popover"[^>]*hidden/);
});

test('a closing card keeps its menu contents through the fade', () => {
  const out = draw({item: baseItem(), menuClosing: true});
  assert.match(out, /class="video-card menu-closing"/);
  assert.match(out, /class="menu-popover is-closing"/);
  assert.doesNotMatch(out, /class="menu-popover is-closing"[^>]*hidden/);
  assert.equal((out.match(/role="menuitem"/g) || []).length, 4);
});

test('an open card renders its menu items', () => {
  const out = draw({item: baseItem(), menuOpen: true});
  assert.equal((out.match(/role="menuitem"/g) || []).length, 4);
});

test('a divider separates menu actions without becoming an action', () => {
  const out = draw({item: baseItem(), menuOpen: true, menuItems: [
    {action: 'source', label: 'Open source page'},
    {type: 'divider'},
    {action: 'copy', label: 'Copy source URL'},
  ]});
  assert.match(out, /data-action="source"[\s\S]*role="separator"[\s\S]*data-action="copy"/);
  assert.equal((out.match(/role="menuitem"/g) || []).length, 2);
});

test('a submenu action exposes its popout and arrow', () => {
  const out = draw({item: baseItem(), menuOpen: true, menuItems: [
    {action: 'download-format', label: 'Download another format', submenu: true,
      popupRole: 'dialog', controls: 'download-advanced'},
  ]});
  assert.match(out, /aria-haspopup="dialog" aria-expanded="false" aria-controls="download-advanced"/);
  assert.match(out, /chevron-right/);
});

test('menu icons inherit the card foreground instead of defaulting to black', () => {
  const out = draw({item: baseItem(), menuOpen: true});
  assert.match(out, /<svg class="icon"[^>]*fill="none"[^>]*stroke="currentColor"/);
});

test('only the heart matching favourite state is rendered', () => {
  const off = draw({item: baseItem({favourite: false})});
  assert.match(off, /heart-outline/);
  assert.doesNotMatch(off, /heart-filled/);
  const on = draw({item: baseItem({favourite: true})});
  assert.match(on, /heart-filled/);
  assert.doesNotMatch(on, /heart-outline/);
});

test('a closed card stays within its SVG budget', () => {
  const out = draw({item: baseItem({facets: {
    people: [{id: 1, name: 'Ada', favourite: true}, {id: 2, name: 'Bo'}],
    owner: {id: 7, name: 'Studio X'},
    collections: [{id: 3, name: 'Summer'}],
    source: {id: 'web', name: 'The web', icon: '/sources.svg#web'},
  }})});
  // 1 eye + 1 video heart + 2 actor hearts + 1 group stack + 1 menu trigger
  // + 1 source logo.
  assert.ok((out.match(/<svg/g) || []).length <= 7,
    `closed card rendered ${(out.match(/<svg/g) || []).length} SVGs`);
});


// Every interactive part of the card is found by a delegated listener, so the
// attributes it carries are a contract with the app that renders it. They are
// hooks rather than fixed names: this app filters on data-actor-filter, an
// archival client on its own.
test('the card carries the hooks the app supplies, not its own names', () => {
  const out = draw({
    item: baseItem({favourite: true, facets: {
      owner: {id: 7, name: 'Studio X'},
      people: [{id: 1, name: 'Ada', favourite: true}],
    }}),
    hooks: {
      owner: owner => ({'data-studio-filter': owner.name}),
      person: person => ({'data-actor-filter': person.name}),
      personFavourite: person => ({'data-actor-favourite': '', 'data-actor-id': person.id}),
      favourite: () => ({'data-video-favourite': ''}),
    },
  });
  assert.match(out, /data-studio-filter="Studio X"/);
  assert.match(out, /data-actor-filter="Ada"/);
  assert.match(out, /data-actor-favourite/);
  assert.match(out, /data-actor-id="1"/);
  assert.match(out, /data-video-favourite/);
  // None of the consumer's names should be baked into the component itself.
  assert.doesNotMatch(out, /data-person-filter|data-owner-filter|data-item-favourite/);
});

test('the defaults are app-neutral', () => {
  const out = draw({item: baseItem({facets: {
    owner: {id: 7, name: 'Studio X'},
    people: [{id: 1, name: 'Ada'}],
  }})});
  assert.match(out, /data-owner-filter="Studio X"/);
  assert.match(out, /data-person-filter="Ada"/);
  assert.match(out, /data-item-favourite/);
  assert.doesNotMatch(out, /data-actor|data-studio|data-video-favourite/);
});

test('an item with no people offers to add one, through a hook', () => {
  const out = draw({
    item: baseItem({facets: {people: []}}),
    labels: {addPerson: '+ Add name'},
    hooks: {addPerson: () => ({'data-add-actor': ''})},
    onAddPerson() {},
  });
  assert.match(out, /data-add-actor/);
  assert.match(out, /\+ Add name/);
});

test('a multi-part card steps through its parts by hook', () => {
  const out = draw({
    item: baseItem({parts: [
      {sourceRef: '/a.mp4', filename: 'a.mp4', title: 'One'},
      {sourceRef: '/b.mp4', filename: 'b.mp4', title: 'Two'},
    ]}),
    hooks: {partDirection: direction => ({'data-part-direction': String(direction)})},
  });
  assert.match(out, /data-part-direction="-1"/);
  assert.match(out, /data-part-direction="1"/);
});

test('saved progress is opt-in and live progress takes precedence', () => {
  const saved = draw({item: baseItem({watch: {progress: 35}})});
  assert.match(saved, /thumbnail-watch-progress[^>]*hidden/);
  const resumable = draw({item: baseItem({watch: {progress: 35}}), showSavedProgress: true});
  assert.match(resumable, /aria-valuenow="35"/);
  assert.match(resumable, /width: 35%/);
  assert.doesNotMatch(resumable, /aria-valuenow="35" hidden/);
  const live = draw({item: baseItem({watch: {progress: 35},
    session: {active: true, progress: 60, expiresAt: Date.now() + 60000}})});
  assert.match(live, /aria-valuenow="60"/);
});

test('a card with no picture marks its image missing so the placeholder shows', () => {
  const none = draw({item: baseItem({thumbnail: {url: ''}})});
  assert.match(none, /<img class="thumbnail-image"[^>]*data-missing[\s=>]/);
  // One with a picture is only marked if it fails to load, in the browser.
  assert.doesNotMatch(draw({item: baseItem()}), /data-missing/);
});

test('a source leads the identity chip as a logo that filters by it', () => {
  const source = {id: 'dropbox', name: 'Dropbox', icon: '/sources.svg#dropbox'};
  const both = draw({item: baseItem({facets: {owner: {id: 7, name: 'Studio X'}, source}})});
  assert.match(both, /identity-chip"><button class="source-chip"[^>]*data-source-filter="Dropbox"[^>]*title="Dropbox"/);
  assert.match(both, /<use href="\/sources\.svg#dropbox"/);
  assert.match(both, /source-chip.*studio-chip/s);
  assert.doesNotMatch(both, /chip-divider/);

  // Nobody named: the logo is the whole chip.
  const alone = draw({item: baseItem({facets: {source}})});
  assert.match(alone, /identity-chip"><button class="source-chip"[^]*?<\/button><\/span>/);
  assert.doesNotMatch(alone, /chip-divider|studio-chip/);

  // A source with no logo is named in words.
  const words = draw({item: baseItem({facets: {source: {id: 'nas', name: 'NAS'}}})});
  assert.match(words, /class="source-chip"[^>]*>NAS<\/button>/);
});

test('every word the card says can be supplied, as text or as a function of its values', () => {
  const item = baseItem({
    parts: [
      {id: 'a', sourceRef: 'a', filename: 'a', title: '', quality: '4K'},
      {id: 'b', sourceRef: 'b', filename: 'b', title: '', quality: '4K'},
    ],
    facets: {collections: [{id: 1, name: 'One'}, {id: 2, name: 'Two'}]},
  });
  const handlers = {onChangePart() {}, onOpenCollections() {}};
  const plain = draw({item, ...handlers});
  // With no labels the English defaults read as they always did.
  assert.match(plain, /aria-label="Previous part"/);
  assert.match(plain, /aria-label="Actions for Beach Day"/);
  assert.match(plain, /2 playlists/);
  const said = draw({
    item, ...handlers,
    labels: {
      previousPart: 'Vorige', actionsFor: 'Acties voor {label}',
      playlistsChip: values => `${values.count} lijsten`,
    },
  });
  assert.match(said, /aria-label="Vorige"/);
  assert.match(said, /aria-label="Acties voor Beach Day"/);
  assert.match(said, /2 lijsten/);
  // A label left out falls back to its default rather than to nothing.
  assert.match(said, /aria-label="Next part"/);
});
