// The shared library card. Consumers supply an item in the shape defined by
// lib/item.js plus the app-specific seams: how a play URL is built, what the
// facet chips are called, and what the overflow menu offers.
import {html} from '../lib/html.js';
import {formatDuration, viewOf} from '../lib/item.js';
import {
  ChevronLeft, ChevronRight, EyeIcon, HeartFilled, HeartOutline, InfoIcon, MenuDots, MenuIcon,
  StackIcon,
} from './icons.js';
import {createSay} from '../lib/labels.js';

/**
 * The attributes each interactive part of the card carries so an app's
 * delegated listeners can find it. They are hooks rather than fixed names
 * because each app listens for its own: this app filters on data-actor-filter,
 * an archival client on data-contributor-filter. Supply only what differs.
 */
export const DEFAULT_CARD_HOOKS = {
  owner: owner => ({'data-owner-filter': owner.name}),
  source: source => ({'data-source-filter': source.name}),
  person: person => ({'data-person-filter': person.name}),
  personFavourite: person => ({'data-person-favourite': '', 'data-person-id': person.id ?? ''}),
  addPerson: () => ({'data-add-person': ''}),
  favourite: () => ({'data-item-favourite': ''}),
  openDetails: () => ({'data-open-details': ''}),
  partDirection: direction => ({'data-part-direction': String(direction)}),
};

/**
 * The words the card says, English unless a consumer passes its own `labels`.
 * A label is text with `{name}` where a value goes, or a function of those
 * values for wording that varies, such as a plural. The card never imports an
 * app's translations: whoever uses it hands over what it should say.
 */
export const DEFAULT_LABELS = {
  play: 'Play', favourites: 'favourite videos', addPerson: '+ Add name',
  playbackProgress: 'Playback progress', details: 'Details', viewDetails: 'View details for {label}',
  addTo: 'Add to {noun}', removeFrom: 'Remove from {noun}',
  videoParts: 'Video parts', previousPart: 'Previous part', nextPart: 'Next part',
  part: 'Part {part} · {index}/{count}', remastered: 'Remastered', audioOnly: 'Audio only',
  showVideosBy: 'Show videos by {name}', actionsFor: 'Actions for {label}',
  inPlaylists: 'In {count} playlists', showPlaylists: 'Show the {count} playlists this video is in',
  playlistsChip: '{count} playlists', showVideosIn: 'Show videos in {name}',
  filterBy: 'Filter by {name}', toggleFavourite: 'Toggle favourite for {name}',
};
export const say = createSay(DEFAULT_LABELS);

export const DEFAULT_MENU_ITEMS = [
  {action: 'edit-groups', label: 'Edit groups'},
  {action: 'choose-thumbnail', label: 'Choose thumbnail'},
  {action: 'copy', label: 'Copy path'},
  {action: 'delete', label: 'Delete', danger: true},
];

// A video with no picture, or a picture that will not load, shows a quiet
// frame with a glyph rather than the browser's broken-image icon and border.
// The glyph is drawn by the stylesheet, not an <svg>: a card's SVG count is
// held to a budget, and this would be one more on every card to help a few.
// The mark is an attribute on the image rather than a prop, since only the
// browser knows the image failed; a card reused for another video clears it
// as soon as that video's picture loads.
function markThumbnailMissing(event) {
  event.currentTarget.setAttribute('data-missing', '');
}
function clearThumbnailMissing(event) {
  event.currentTarget.removeAttribute('data-missing');
}

/**
 * Where the item came from, as the logo at the front of the identity chip: a
 * site, a service, a device. Optional, and only as detailed as the consumer
 * cares to be - a source with no icon is named in words instead. With no
 * owner the logo is the whole chip; with one, the name sits right beside it,
 * undivided, so the pair reads as one label.
 */
const SourceChip = ({source, onFilterSource, hooks, labels}) => html`
  <button class="source-chip" type="button" ...${hooks.source(source)}
          title=${source.name} aria-label=${say(labels, 'filterBy', {name: source.name})}
          onClick=${onFilterSource && (() => onFilterSource(source))}>
    ${source.icon
      ? html`<svg class="source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true"><use href=${source.icon} /></svg>`
      : source.name}
  </button>`;

const FacetChips = ({owner, ordinal, source, onFilterOwner, onFilterSource, hooks, labels}) => {
  const hasSource = Boolean(source?.name);
  if (!owner?.name && ordinal == null && !hasSource) return null;
  return html`
    <span class="metadata-chip identity-chip">
      ${hasSource && html`<${SourceChip} source=${source} onFilterSource=${onFilterSource} hooks=${hooks} labels=${labels} />`}
      ${owner?.name && html`
        <button class="studio-chip" type="button" ...${hooks.owner(owner)}
                onClick=${onFilterOwner && (() => onFilterOwner(owner))}>
          ${owner.name}
        </button>`}
      ${owner?.name && ordinal != null && html`<span class="chip-divider" aria-hidden="true"></span>`}
      ${ordinal != null && html`<span class="release-chip">${ordinal}</span>`}
    </span>`;
};

const PeopleChips = ({
  people, onFilterPerson, onToggleFavourite, onAddPerson, addLabel, hooks, labels,
}) => {
  if (!people?.length) {
    if (!onAddPerson) return null;
    return html`
      <button class="actor-chip add-actor-chip" type="button" ...${hooks.addPerson()}
              onClick=${onAddPerson}>
        ${addLabel}
      </button>`;
  }
  return people.map(person => html`
    <span class="actor-chip" key=${person.id ?? person.name}>
      <button class="actor-name-button" type="button" ...${hooks.person(person)}
              onClick=${onFilterPerson && (() => onFilterPerson(person))}>
        ${person.name}
      </button>
      <button class="actor-favourite-button" type="button" ...${hooks.personFavourite(person)}
              aria-label=${say(labels, 'toggleFavourite', {name: person.name})}
              aria-pressed=${String(Boolean(person.favourite))}
              onClick=${onToggleFavourite && (() => onToggleFavourite(person))}>
        ${person.favourite ? html`<${HeartFilled} />` : html`<${HeartOutline} />`}
      </button>
    </span>`);
};

export function VideoCard({
  item,
  partIndex = 0,
  libraryCard = true,
  showSavedProgress = false,
  hidden = false,
  accent,
  thumbnailUrlFor,
  thumbnailSizes = 'min(100vw, 720px)',
  loadOwnerPortrait,
  channelMetadata = [],
  durationInCorner = false,
  thumbnailLoading = 'lazy',
  playUrlFor,
  detailsUrlFor,
  labels = {},
  menuItems = DEFAULT_MENU_ITEMS,
  hooks: hookOverrides = {},
  menuOpen = false,
  menuClosing = false,
  dataset = {},
  onOpenDetails,
  onChangePart,
  onToggleFavourite,
  onToggleMenu,
  onMenuAction,
  onMenuItemHover,
  onFilterOwner,
  onFilterSource,
  onFilterPerson,
  onFilterCollection,
  onOpenCollections,
  onTogglePersonFavourite,
  onAddPerson,
}) {
  const hooks = {...DEFAULT_CARD_HOOKS, ...hookOverrides};
  const view = viewOf(item, partIndex);
  // A saved position is useful in resume-oriented libraries, but it does not
  // mean the item is currently playing. Leave that policy to each consumer.
  const progress = view.session.active ? view.session.progress
    : showSavedProgress ? Math.max(0, Math.min(100, view.watch.progress || 0)) : 0;
  const {people = [], owner, collections = [], ordinal, source} = view.facets;
  const portraitOwner = loadOwnerPortrait ? (owner?.name ? owner : people[0]) : null;
  const hasPeopleRow = !loadOwnerPortrait && Boolean(people.length || onAddPerson);
  const playHref = playUrlFor?.(item, view.partIndex);
  const detailsHref = detailsUrlFor?.(item, view.partIndex);
  const multipart = view.partCount > 1;
  const thumbnailUrl = thumbnailUrlFor?.(item, view.partIndex) ?? view.thumbnail.url;
  // A consumer that names its own picture has said which one; otherwise the
  // item's srcset, when it has one, lets the browser fetch a copy the size of
  // the card rather than the full picture. `thumbnailSizes` is how wide the
  // card is drawn.
  const thumbnailSrcset = (!thumbnailUrlFor && view.thumbnail.srcset) || undefined;

  // In the HereSphere browser the thumbnail itself is the play link and the
  // details button moves alongside it; elsewhere the thumbnail opens details.
  const thumbnailInner = html`
    <span class=${`thumbnail-frame${view.thumbnail.alphaPacking ? ' thumbnail-frame--alpha' : ''}`}>
      <img class="thumbnail-image" src=${thumbnailUrl}
           srcset=${thumbnailSrcset} sizes=${thumbnailSrcset ? thumbnailSizes : undefined}
           data-missing=${thumbnailUrl ? undefined : ''}
           onError=${markThumbnailMissing} onLoad=${clearThumbnailMissing}
           loading=${thumbnailLoading} decoding="async" width="640" height="360" alt="" />
      <span class="thumbnail-chip-row">
        <span class="quality-chip watch-count-chip" hidden=${!view.watch.count}
              aria-label=${`${view.watch.count} watches`} title=${`${view.watch.count} watches`}>
          <${EyeIcon} /><span>${view.watch.count}</span>
        </span>
        ${multipart && html`
          <span class="part-indicator">
            ${say(labels, 'part', {part: view.partLabel, index: view.partIndex + 1, count: view.partCount})}
          </span>`}
        ${item.audioOnly && html`
          <span class="quality-chip audio-only-chip" role="img" aria-label=${say(labels, 'audioOnly')}
                title=${say(labels, 'audioOnly')}></span>`}
        <span class=${durationInCorner ? 'quality-chip video-duration-chip' : 'quality-chip video-quality-chip'} hidden=${durationInCorner && !view.durationSeconds}>${durationInCorner ? formatDuration(view.durationSeconds) : view.quality}</span>
        <span class="quality-chip remastered-chip" hidden=${!view.remastered}>${say(labels, 'remastered')}</span>
      </span>
      <span class="status-chip thumb-status" hidden></span>
      <span class="thumbnail-watch-progress" role="progressbar" aria-label=${say(labels, 'playbackProgress')}
            aria-valuemin="0" aria-valuemax="100"
            aria-valuenow=${String(Math.round(progress))}
            hidden=${progress <= 0}>
        <span style=${`width: ${progress}%`}></span>
      </span>
    </span>`;

  return html`
    <article class=${menuOpen ? 'video-card menu-open' : menuClosing ? 'video-card menu-closing' : 'video-card'} ...${libraryCard ? {'data-library-card': true} : {'data-shelf-card': 'true'}}
             ...${dataset}
             data-path=${view.sourceRef} data-id=${view.id} data-part-index=${String(view.partIndex)}
             data-audio-only=${item.audioOnly ? '' : undefined}
             hidden=${hidden} style=${view.accent || accent
               ? `--card-accent: ${view.accent || accent}` : undefined}>
      <div class="thumbnail-area">
        ${playHref
          ? html`<a class="thumbnail-button" href=${playHref}
                    aria-label=${`${say(labels, 'play')} ${view.label}`}>${thumbnailInner}</a>`
          : html`<button class="thumbnail-button" type="button"
                         aria-label=${say(labels, 'viewDetails', {label: view.label})}
                         onClick=${onOpenDetails && (event => onOpenDetails(item, view.partIndex, event))}>${thumbnailInner}</button>`}

        ${playHref && html`
          <button class="external-play-details" type="button" title=${say(labels, 'details')}
                  ...${hooks.openDetails()}
                  aria-label=${say(labels, 'viewDetails', {label: view.label})}
                  onClick=${onOpenDetails && (event => onOpenDetails(item, view.partIndex, event))}>
            <${InfoIcon} />
          </button>`}

        <button class="video-favourite-button" type="button" ...${hooks.favourite()}
                aria-label=${say(labels, view.favourite ? 'removeFrom' : 'addTo', {noun: say(labels, 'favourites')})}
                aria-pressed=${String(view.favourite)}
                onClick=${onToggleFavourite && (() => onToggleFavourite(item))}>
          ${view.favourite ? html`<${HeartFilled} />` : html`<${HeartOutline} />`}
        </button>

        ${multipart && html`
          <div class="part-navigation" aria-label=${say(labels, 'videoParts')}>
            <button type="button" aria-label=${say(labels, 'previousPart')} ...${hooks.partDirection(-1)}
                    onClick=${onChangePart && (() => onChangePart(item, -1))}>
              <${ChevronLeft} />
            </button>
            <button type="button" aria-label=${say(labels, 'nextPart')} ...${hooks.partDirection(1)}
                    onClick=${onChangePart && (() => onChangePart(item, 1))}>
              <${ChevronRight} />
            </button>
          </div>`}
      </div>

      <div class=${hasPeopleRow ? 'card-footer' : 'card-footer card-footer--single-row'}>
        <div class="card-meta">
          <div class=${loadOwnerPortrait ? 'card-title-row card-title-row--portrait' : 'card-title-row'}>
            ${portraitOwner && html`
              <span class="card-owner-figure">
              <button class="card-owner-portrait" type="button"
                      ...${owner?.name ? hooks.owner(portraitOwner) : hooks.person(portraitOwner)}
                      aria-label=${say(labels, 'showVideosBy', {name: portraitOwner.name})}
                      onClick=${() => (owner?.name ? onFilterOwner : onFilterPerson)?.(portraitOwner)}>
                <span aria-hidden="true">${portraitOwner.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</span>
                <img alt="" hidden decoding="async"
                     ref=${image => {
                       // Hidden lazy images never enter the loading viewport. Nearby
                       // cards are already selected by the gallery virtualiser.
                       if (!image) return;
                       loadOwnerPortrait(portraitOwner).then(url => {
                         if (!image.isConnected) return;
                         if (!url) {
                           // A card stepped on to a creator with no portrait
                           // must not keep the last creator's face.
                           image.hidden = true;
                           image.removeAttribute('src');
                         } else if (image.getAttribute('src') !== url) image.src = url;
                       });
                     }}
                     onLoad=${event => { event.currentTarget.hidden = false; }}
                     onError=${event => { event.currentTarget.hidden = true; }} />
              </button>
              </span>`}
            <div class=${loadOwnerPortrait ? 'card-title-copy' : 'card-title-copy card-title-copy--inline'}>
            <div class="card-context-chips">
              <${FacetChips} labels=${labels} hooks=${portraitOwner && !owner?.name ? {...hooks, owner: hooks.person} : hooks} owner=${portraitOwner || owner} ordinal=${ordinal} source=${source}
                             onFilterOwner=${portraitOwner && !owner?.name ? onFilterPerson : onFilterOwner} onFilterSource=${onFilterSource} />
              ${channelMetadata.filter(Boolean).map(value => html`<span class="card-channel-detail" key=${value}>${value}</span>`)}
              ${durationInCorner && view.quality && html`<span class="card-channel-detail">${view.quality}</span>`}
            </div>
            ${playHref
              ? html`<a class="card-name" href=${playHref}>${view.label}</a>`
              : detailsHref
                ? html`<a class="card-name" href=${detailsHref}
                          onClick=${event => {
                            if (!onOpenDetails || event.button !== 0 || event.metaKey || event.ctrlKey
                                || event.shiftKey || event.altKey || event.defaultPrevented) return;
                            event.preventDefault();
                            onOpenDetails?.(item, view.partIndex, event);
                          }}>${view.label}</a>`
                : onOpenDetails
                  ? html`<button class="card-name" type="button"
                                 onClick=${event => onOpenDetails(item, view.partIndex, event)}>${view.label}</button>`
                  : html`<div class="card-name">${view.label}</div>`}
            </div>
          </div>
          ${hasPeopleRow && html`
            <div class="card-actors">
              <${PeopleChips} hooks=${hooks} labels=${labels} people=${people} onFilterPerson=${onFilterPerson}
                              onToggleFavourite=${onTogglePersonFavourite}
                              onAddPerson=${onAddPerson && (() => onAddPerson(item))}
                              addLabel=${say(labels, 'addPerson')} />
            </div>`}
        </div>
        <div class="card-side">
          <div class="card-menu">
            <button class="menu-trigger" type="button" aria-haspopup="menu"
                    aria-label=${say(labels, 'actionsFor', {label: view.label})}
                    aria-expanded=${String(menuOpen)}
                    onClick=${onToggleMenu && (() => onToggleMenu(item))}>
              <${MenuDots} />
            </button>
            <div class=${menuClosing && !menuOpen ? 'menu-popover is-closing' : 'menu-popover'}
                 role="menu" hidden=${!(menuOpen || menuClosing)} inert=${menuClosing && !menuOpen}>
              ${(menuOpen || menuClosing) && menuItems.map((entry, index) => entry.type === 'divider'
                ? html`<div class="menu-divider" role="separator" key=${entry.key ?? `divider-${index}`}></div>`
                : html`
                <button type="button" role="menuitem" key=${entry.action}
                        data-action=${entry.action}
                        class=${entry.danger ? 'danger' : undefined}
                        aria-haspopup=${entry.submenu ? (entry.popupRole || 'menu') : undefined}
                        aria-expanded=${entry.submenu ? 'false' : undefined}
                        aria-controls=${entry.submenu ? entry.controls : undefined}
                        onPointerEnter=${onMenuItemHover && (event => onMenuItemHover(entry, item, event))}
                        onKeyDown=${entry.submenu && onMenuItemHover && (event => {
                          if (event.key !== 'ArrowRight') return;
                          event.preventDefault();
                          onMenuItemHover(entry, item, event);
                        })}
                        onClick=${entry.submenu
                          ? onMenuItemHover && (event => onMenuItemHover(entry, item, event))
                          : onMenuAction && (event => onMenuAction(entry.action, item, view.partIndex, event))}>
                  <${MenuIcon} name=${entry.action} /><span>${entry.label}</span>
                  ${entry.submenu && html`<${ChevronRight} />`}
                </button>`)}
            </div>
          </div>
          <span class="group-chips" hidden=${!collections.length}>
            ${onOpenCollections && collections.length > 1
              ? html`
              <button type="button" class="group-chip" data-group-menu
                      title=${say(labels, 'inPlaylists', {count: collections.length})} aria-haspopup="menu" aria-expanded="false"
                      aria-label=${say(labels, 'showPlaylists', {count: collections.length})}
                      onClick=${event => onOpenCollections(item, collections, event.currentTarget)}>
                <${StackIcon} /><span class="group-chip-name">${say(labels, 'playlistsChip', {count: collections.length})}</span>
              </button>`
              : collections.map(collection => html`
              <button type="button" class="group-chip" key=${collection.id ?? collection.name}
                      data-group-filter=${collection.name}
                      title=${collection.name} aria-label=${say(labels, 'showVideosIn', {name: collection.name})}
                      onClick=${onFilterCollection && (() => onFilterCollection(collection))}>
                <${StackIcon} /><span class="group-chip-name">${collection.name}</span>
              </button>`)}
          </span>
        </div>
      </div>
    </article>`;
}

export {formatDuration};
