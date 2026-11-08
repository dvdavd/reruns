import {displayLabel} from './item.js';

export const SORT_DEFAULT_DIRECTIONS = {
  latest: 'desc', played: 'desc', completed: 'desc', name: 'asc', watches: 'desc',
  size: 'desc', duration: 'desc',
};

export function randomOrder(id, seed) {
  let hash = 2166136261;
  const input = `${seed}\0${id}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const number = value => Number(value || 0);
// One collator for every comparison: localeCompare with options sets up the
// language's rules each time it is called, which made sorting 50,000 titles
// take seconds rather than milliseconds.
const byName = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const COMPARATORS = {
  latest: (left, right) => number(right.mtime) - number(left.mtime),
  played: (left, right) => number(right.watch?.lastPlayedAt) - number(left.watch?.lastPlayedAt),
  completed: (left, right) => number(right.watch?.lastCompletedAt) - number(left.watch?.lastCompletedAt),
  name: (left, right) => byName.compare(displayLabel(left), displayLabel(right)),
  watches: (left, right) => number(right.watch?.count) - number(left.watch?.count),
  size: (left, right) => number(right.sizeBytes) - number(left.sizeBytes),
  duration: (left, right) => number(right.durationSeconds) - number(left.durationSeconds),
};

export function sortItems(items, {mode = 'latest', direction, seed} = {}) {
  if (mode === 'random') {
    return [...items].sort((left, right) => randomOrder(left.id, seed) - randomOrder(right.id, seed));
  }
  const compare = COMPARATORS[mode] || COMPARATORS.latest;
  const multiplier = direction && direction !== SORT_DEFAULT_DIRECTIONS[mode] ? -1 : 1;
  return [...items].sort((left, right) =>
    multiplier * compare(left, right) || number(left.originalOrder) - number(right.originalOrder));
}

export function filterItems(items, {
  query = '', exactPerson = null, exactCollection = null,
  favouriteItems = false, favouritePeople = false,
  exactActor = null, exactGroup = null, favouriteVideos = false, favouriteActors = false,
} = {}) {
  const person = exactPerson || exactActor;
  const collection = exactCollection || exactGroup;
  const needle = query.trim().toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const collections = item.facets?.collections || [];
    const people = item.facets?.people || [];
    const matchesQuery = collection
      ? collections.some(entry => String(entry.id) === String(collection.id))
      : collections.some(entry => entry.name.toLowerCase().includes(needle)) || (person
        ? people.some(entry => String(entry.id) === String(person.id))
        : terms.every(term => [
          item.searchPath, item.title,
          ...(item.parts || []).map(part => part.title),
          item.facets?.ordinal,
          ...collections.map(entry => entry.name),
          ...people.map(entry => entry.name),
          item.facets?.owner?.name,
        ].some(value => (value || '').toLowerCase().includes(term))));
    return matchesQuery
      && (!(favouriteItems || favouriteVideos) || item.favourite)
      && (!(favouritePeople || favouriteActors) || people.some(entry => entry.favourite));
  });
}
