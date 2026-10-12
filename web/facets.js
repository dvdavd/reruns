// The chip filters. Clicking a chip filters by that thing's own id, never by
// its name as search text: a playlist named "show", or a channel called
// "Shorts", would otherwise drag in every video whose title contains the word.
import {t} from './i18n.js';


/** Each filter as the facets of an item it would match. The key is both the
 *  URL parameter and the chip kind. */
export const FACETS = {
  // An unknown quality's id stays as it was, since it is also the URL's. A
  // download with no picture has no quality to rank, so it is its own kind,
  // which is how the library is filtered to what can only be listened to.
  quality: item => [item.audioOnly ? {id: 'audio', name: t('item.audioOnly')}
    : {id: item.parts?.[0]?.quality || 'Unknown', name: item.parts?.[0]?.quality || t('stats.qualityUnknown')}],
  favourite: item => item.favourite ? [{id: 'true', name: t('stats.favourites')}] : [],
  playlist: item => item.facets?.collections || [],
  channel: item => (item.facets?.owner ? [item.facets.owner] : []),
  creator: item => item.facets?.people || [],
  source: item => (item.facets?.source ? [item.facets.source] : []),
};

/** The facets of `kind` an item carries, as `{id, name}` entries. */
const entriesOf = (item, kind) => (FACETS[kind] || (() => []))(item);

/** Whether an item carries the chip that is filtering, matched on id. */
export function matchesFacet(item, facet) {
  if (!facet) return true;
  return entriesOf(item, facet.kind).some(entry => String(entry.id) === facet.id);
}

/**
 * The chip's display name. An id is not a name, so it comes from an item the
 * filter matches; before the archive has loaded there is none, and the caller
 * asks again once there is.
 */
export function facetName(facet, items) {
  if (!facet) return '';
  if (facet.name) return facet.name;
  for (const item of items) {
    const entry = entriesOf(item, facet.kind).find(one => String(one.id) === facet.id);
    if (entry) return entry.name;
  }
  return '';
}

/** The chip filter a URL asks for, or null for the whole archive. */
export function facetFromParams(params) {
  for (const kind of Object.keys(FACETS)) {
    const id = params.get(kind);
    if (id) return {kind, id, name: ''};
  }
  return null;
}

/** Writes the filter onto a URL, clearing whichever chip is not in play. */
export function applyFacetParams(url, facet) {
  for (const kind of Object.keys(FACETS)) {
    if (facet?.kind === kind) url.searchParams.set(kind, facet.id);
    else url.searchParams.delete(kind);
  }
  return url;
}
