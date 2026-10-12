import {FACETS} from './facets.js';
import {t} from './i18n.js';
import {playlistsFrom} from './playlists.js';

const TOP = 5;

function totals(items) {
  let sizeBytes = 0;
  let durationSeconds = 0;
  for (const item of items) {
    for (const part of item.parts || []) {
      sizeBytes += Number(part.sizeBytes) || 0;
      durationSeconds += Number(part.durationSeconds) || 0;
    }
  }
  return {sizeBytes, durationSeconds};
}

/**
 * What the library holds, from the items the gallery already loaded rather
 * than a second scan: the page has every item in hand, and counting them here
 * keeps the numbers in step with what the gallery shows after a rescan.
 * Only videos with a file count, so a sidecar whose download never finished
 * does not add a video with no size.
 */
export function libraryStats(allItems, metric = 'count') {
  const items = (allItems || []).filter(item => item.archive?.downloaded !== false);

  const channels = new Map();
  for (const item of items) {
    const owner = item.facets?.owner;
    if (!owner) continue;
    if (!channels.has(owner.id)) channels.set(owner.id, {id: owner.id, name: owner.name, items: []});
    channels.get(owner.id).items.push(item);
  }

  // Qualities as the quality filter knows them, most common first, so each
  // slice links to the videos it counts. The id is the URL's and the name is
  // what is read, which differ for audio and for an unknown quality.
  const qualities = new Map();
  for (const item of items) {
    const [{id, name}] = FACETS.quality(item);
    const entry = qualities.get(id) || {id, name, count: 0};
    entry.count += 1;
    qualities.set(id, entry);
  }

  const withTotals = group => ({...group, count: group.items.length, ...totals(group.items)});
  const playlists = playlistsFrom(items);

  const rank = groups => groups.sort((a, b) =>
    b[metric] - a[metric] || b.count - a.count || b.sizeBytes - a.sizeBytes).slice(0, TOP);

  return {
    videos: items.length,
    ...totals(items),
    channels: channels.size,
    playlists: playlists.length,
    favourites: items.filter(item => item.favourite).length,
    qualities: [...qualities.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    topChannels: rank([...channels.values()].map(withTotals)),
    // By what is held, not the playlist's own length: a 400-video playlist
    // with two of them downloaded is not a large part of this library.
    topPlaylists: rank(playlists.map(playlist => ({...withTotals(playlist), total: playlist.count}))),
    largestVideos: [...items].map(item => ({item, ...totals([item])}))
      .sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, TOP),
  };
}

/** A running time long enough to need days, as "2d 3h" rather than "51:04:10". */
export function formatRuntime(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return t('runtime.days', {days, hours});
  if (hours) return t('runtime.hoursMinutes', {hours, minutes: mins});
  return t('runtime.minutes', {minutes: mins});
}
