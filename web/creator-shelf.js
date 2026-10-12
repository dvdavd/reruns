// The creator shelf above the gallery: a
// grid of portrait cards that filter the gallery when clicked. The archive has
// no favourites among creators to rank by, so the order is the one the shelf
// is actually for — who posted most recently.

import {accentFromImage, whenImageLoaded} from 'media-ui/accent.js';
import {createShelfRows} from 'media-ui';
import {iconMarkup} from './icon.js';
import {plural, t} from './i18n.js';
import {shelfLabels} from './shelf-labels.js';

// Home shows two rows of channels, with cards for each channel.
const SHELF_ROWS = 2;

/** The creator a video belongs to: its channel, or its uploader when the
 *  extractor recorded no channel at all. */
export function creatorOf(item) {
  const owner = item?.facets?.owner;
  if (owner?.name) {
    return {id: String(owner.id || owner.name), name: owner.name,
            channelId: String(owner.id || '')};
  }
  const person = item?.facets?.people?.[0];
  if (person?.name) {
    return {id: String(person.id || person.name), name: person.name, channelId: ''};
  }
  return null;
}

const publishedAt = item => Number(item?.mtime || item?.archive?.uploadedAt || 0);

/**
 * One entry per creator, most recent video first. `latestAt` is the newest
 * video this archive holds for them, which is what the order means: the shelf
 * answers "who have I been archiving lately", not "who has the most videos".
 */
export function creatorsFrom(items) {
  const creators = new Map();
  for (const item of items || []) {
    const creator = creatorOf(item);
    if (!creator) continue;
    // Where the channel lives, for the logo in the card's corner: the same
    // name on YouTube and on Twitch is two channels, and two cards that
    // otherwise look alike.
    const source = item.facets?.source || null;
    const entry = creators.get(creator.id);
    if (!entry) {
      creators.set(creator.id, {...creator, source, count: 1, latestAt: publishedAt(item)});
      continue;
    }
    entry.count += 1;
    entry.latestAt = Math.max(entry.latestAt, publishedAt(item));
    // A channel that only linked itself in some sidecars still gets its id.
    if (!entry.channelId) entry.channelId = creator.channelId;
    if (!entry.source) entry.source = source;
  }
  // Undated videos sort last rather than jumbling the top of the shelf; names
  // break ties so a rescan never reshuffles equal creators.
  return [...creators.values()].sort((left, right) =>
    right.latestAt - left.latestAt || left.name.localeCompare(right.name));
}


/** A to Z by name, ignoring case and accents. */
export function alphabetical(creators) {
  return [...creators].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, {sensitivity: 'base', numeric: true}));
}

/**
 * What the home shelf shows: the favourites, or while there are none, the
 * most recent creators so a fresh archive still has something to offer.
 */
export function shelfCreators(creators, favourites = new Set()) {
  const pinned = creators.filter(creator => favourites.has(creator.id));
  return pinned.length ? pinned : creators;
}

const heart = filled => iconMarkup(filled ? 'heart-filled' : 'heart-outline');

export function setHeart(button, name, favourite, {noun = 'channels'} = {}) {
  button.setAttribute('aria-pressed', String(favourite));
  button.setAttribute('aria-label', t(favourite ? 'fav.remove' : 'fav.add', {name, noun: t(`fav.noun.${noun}`)}));
  button.innerHTML = heart(favourite);
}

/** The source's logo, as a badge on the portrait's lower-left edge. It only
 *  says where the channel is; the card itself is what opens it. */
function sourceBadge(source) {
  const badge = document.createElement('span');
  badge.className = 'creator-card-source';
  badge.title = source.name;
  badge.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', source.icon);
  svg.append(use);
  badge.append(svg);
  return badge;
}

/* The card is an article rather than one button, since the heart is a second
   control inside it; the open button stretches over the whole card. */
function creatorCard(creator, {onSelect, onToggleFavourite, active, favourite}) {
  const card = document.createElement('article');
  card.className = 'creator-shelf-card';
  card.dataset.creatorId = creator.id;
  card.dataset.channelFilter = creator.name;
  card.dataset.favourite = String(favourite);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'creator-card-open';
  button.setAttribute('aria-pressed', String(active));
  // The logo in the corner is hidden from assistive tech, so the label
  // carries the source instead: "Ashens on Twitch" beside "Ashens on YouTube".
  const videos = plural('count.videos', creator.count);
  button.setAttribute('aria-label', creator.source?.name
    ? t('card.showCreatorOn', {name: creator.name, source: creator.source.name, count: videos})
    : t('card.showCreator', {name: creator.name, count: videos}));

  const portrait = document.createElement('span');
  portrait.className = 'creator-card-portrait';
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  image.hidden = true;
  image.addEventListener('error', () => { image.hidden = true; });
  portrait.append(image);

  const name = document.createElement('strong');
  name.className = 'creator-card-name';
  name.textContent = creator.name;
  const count = document.createElement('span');
  count.className = 'creator-card-count';
  count.textContent = `${plural('count.videos', creator.count)}`;

  // The badge sits beside the portrait rather than in it, since the portrait
  // crops whatever crosses its circle.
  const figure = document.createElement('span');
  figure.className = 'creator-card-figure';
  figure.append(portrait);
  if (creator.source?.icon) figure.append(sourceBadge(creator.source));

  button.append(figure, name, count);
  button.addEventListener('click', () => onSelect(creator));

  const favouriteButton = document.createElement('button');
  favouriteButton.type = 'button';
  favouriteButton.className = 'creator-card-favourite';
  favouriteButton.dataset.channelFavourite = creator.id;
  setHeart(favouriteButton, creator.name, favourite);
  favouriteButton.addEventListener('click', () => onToggleFavourite?.(creator));

  card.append(button, favouriteButton);
  return card;
}

/**
 * Paints the shelf and keeps it in step with the gallery. The track is rebuilt
 * only when the creators themselves change, so a redraw never restarts the
 * portrait fetches or drops the pictures already showing.
 */
/**
 * Tints one card from its own portrait. The picture is square, so it is sampled
 * square; a portrait too grey to read leaves the shelf's default accent alone.
 */
function paintAccent(card, image, accentOf = accentFromImage) {
  whenImageLoaded(image, () => {
    const accent = accentOf(image, 32, 32);
    if (accent) card.style.setProperty('--card-accent', accent);
  });
}

/**
 * `mode` is 'shelf' for home (favourites, or the most recent while there are
 * none, capped with a More button) or 'all' for the channels view (every
 * creator A to Z, favourites marked by their glow). `favourites` is a Set of creator ids.
 */
export function createCreatorShelf({section, track, moreButton = null, onSelect,
                                    onToggleFavourite, mode = 'shelf',
                                    emptyHint = null,
                                    loadImage = async () => '',
                                    accentOf = accentFromImage}) {
  let creators = [];
  let favourites = new Set();
  let activeName = '';

  function paint() {
    const ordered = mode === 'all' ? alphabetical(creators) : shelfCreators(creators, favourites);
    // The channels view lists every creator, so it has no rows to cap and no
    // More button; only the shelf on home does.
    const shown = rows ? rows.take(ordered) : ordered;
    rows?.sync(ordered.length);
    if (emptyHint) emptyHint.hidden = mode !== 'shelf' || shown.some(creator => favourites.has(creator.id));
    const signature = JSON.stringify(
      shown.map(creator => [creator.id, creator.name, creator.count, favourites.has(creator.id)]));
    if (track.dataset.signature !== signature) {
      track.dataset.signature = signature;
      // Cards already on the shelf keep their portrait; only new ones fetch.
      const existing = new Map([...track.children].map(card => [card.dataset.creatorId, card]));
      track.replaceChildren(...shown.map(creator => {
        const reused = existing.get(creator.id);
        if (reused && reused.dataset.channelFilter === creator.name) {
          reused.querySelector('.creator-card-count').textContent =
            `${plural('count.videos', creator.count)}`;
          setHeart(reused.querySelector('.creator-card-favourite'), creator.name,
                   favourites.has(creator.id));
          reused.dataset.favourite = String(favourites.has(creator.id));
          return reused;
        }
        const card = creatorCard(creator, {
          onSelect, onToggleFavourite,
          active: creator.name === activeName,
          favourite: favourites.has(creator.id),
        });
        loadImage(creator.channelId).then(url => {
          if (!url || !card.isConnected) return;
          const image = card.querySelector('img');
          image.src = url;
          image.hidden = false;
          paintAccent(card, image, accentOf);
        });
        return card;
      }));
    }
    for (const card of track.children) {
      card.querySelector('.creator-card-open')
        .setAttribute('aria-pressed', String(card.dataset.channelFilter === activeName));
    }
  }

  const rows = mode === 'shelf'
    ? createShelfRows({
      track, moreButton, rows: SHELF_ROWS, labels: shelfLabels(),
      onChange: () => { if (!section.hidden) paint(); },
    }).watch()
    : null;

  return {
    /**
     * `filter` is the current search text. On the shelf, a creator's name
     * marks that card; in the channels view it narrows the grid by name.
     * `quiet` keeps the shelf out of the way while it holds no favourite,
     * rather than filling in with recent channels and asking for one: a
     * narrowed archive is not the place to be prompted.
     */
    update(items, {filter = '', favourites: next = favourites, quiet = false} = {}) {
      favourites = next;
      const all = creatorsFrom(items);
      const needle = filter.trim().toLowerCase();
      creators = mode === 'all' && needle
        ? all.filter(creator => creator.name.toLowerCase().includes(needle)) : all;
      activeName = mode === 'all' ? '' : filter.trim();
      section.hidden = mode === 'shelf'
        && (!all.length || (quiet && !all.some(creator => favourites.has(creator.id))));
      if (!section.hidden) paint();
      return creators.length;
    },
  };
}
