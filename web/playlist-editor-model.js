import {membershipsOf} from './playlists.js';
import {t} from './i18n.js';

const recentAt = item => Number(item.mtime || item.archive?.uploadedAt || 0);
const newestFirst = (left, right) => recentAt(right) - recentAt(left)
  || left.title.localeCompare(right.title);
const creatorIds = item => (item.facets?.people || []).map(person => String(person.id || person.name));

function related(left, right) {
  const channel = left.facets?.owner?.id;
  if (channel && channel === right.facets?.owner?.id) return true;
  const creators = new Set(creatorIds(left));
  if (creatorIds(right).some(id => creators.has(id))) return true;
  const playlists = new Set(membershipsOf(left).map(playlist => String(playlist.id)));
  return membershipsOf(right).some(playlist => playlists.has(String(playlist.id)));
}

/** Related groups follow the playlist's member order; recent videos fill gaps. */
export function playlistSuggestions(library, selected, {query = '', limit = 6, searchLimit = 12} = {}) {
  const chosen = new Set(selected);
  const available = library.filter(item => !chosen.has(item.id)).sort(newestFirst);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const matches = available.filter(item => {
      const text = [item.title, ...(item.searchPath || []), item.facets?.owner?.name,
        ...(item.facets?.people || []).map(person => person.name),
        ...(item.facets?.collections || []).map(playlist => playlist.name)].join(' ').toLowerCase();
      return words.every(word => text.includes(word));
    });
    return {heading: t('pl.heading.search'), items: matches.slice(0, searchLimit), total: matches.length};
  }
  const byId = new Map(library.map(item => [item.id, item]));
  const seen = new Set();
  const suggestions = [];
  for (const id of selected) {
    const member = byId.get(id);
    if (!member) continue;
    for (const candidate of available) {
      if (!seen.has(candidate.id) && related(member, candidate)) {
        seen.add(candidate.id);
        suggestions.push(candidate);
      }
    }
  }
  const hasRelated = suggestions.length > 0;
  suggestions.push(...available.filter(item => !seen.has(item.id)));
  return {heading: t(hasRelated ? 'pl.heading.related' : 'pl.heading.recent'),
    items: suggestions.slice(0, limit), total: suggestions.length};
}
