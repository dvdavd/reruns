// Everything that knows what a playlist is, for both the watch sidebar and the
// gallery. A playlist is the one grouping the archive holds an explicit order
// for, so it is the one grouping that is worth ordering by rather than sorting.

export const playlistKey = item => item.archive?.playlist?.id || null;

export const membershipsOf = item => item.archive?.playlists
  || (item.archive?.playlist ? [item.archive.playlist] : []);

/** A view of a video in one playlist, preserving its media identity. */
export function inPlaylist(item, id) {
  let playlist = membershipsOf(item).find(entry => String(entry.id) === String(id));
  if (!playlist) return null;
  // Only the playlist context changes. Format selection and fetched details
  // must still update the library video's archive fields.
  const archive = new Proxy(item.archive, {
    get: (target, key) => key === 'playlist' ? playlist : Reflect.get(target, key),
    set(target, key, value) {
      if (key === 'playlist') playlist = value;
      else Reflect.set(target, key, value);
      return true;
    },
  });
  return {...item, archive};
}

const indexOf = item => item.archive?.playlist?.index || 0;

/**
 * Whether a playlist's recorded order runs backwards. YouTube hands plenty of
 * them back newest-first, which walks a series from its ending, and the site
 * itself plays them that way, so it is worth spotting rather than blaming on
 * the archive.
 *
 * Upload dates decide it, not the titles: numbering is the stronger statement
 * of intent but too often incomplete — a first part is regularly unnumbered,
 * being no series yet when it went up. Every step has to go backwards in time
 * for this to say yes, so a playlist gathered rather than published in order
 * keeps whatever order its maker chose.
 */
export function runsBackwards(members) {
  const dated = (members || [])
    .filter(item => indexOf(item) && item.archive?.uploadedAt)
    .sort((left, right) => indexOf(left) - indexOf(right));
  return dated.length > 1 && dated.every((item, at) =>
    at === 0 || item.archive.uploadedAt < dated[at - 1].archive.uploadedAt);
}

/**
 * Settle each playlist's direction onto its videos, so everything that walks
 * a playlist afterwards — the gallery, the watch sidebar, autoplay — steps the
 * same way. A saved choice is the viewer's own and final; without one the
 * dates decide.
 */
export function markPlaylistDirection(items, saved = {}) {
  const groups = new Map();
  for (const item of items || []) {
    for (const playlist of membershipsOf(item)) {
      const key = String(playlist.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inPlaylist(item, key));
    }
  }
  for (const [key, members] of groups) {
    const choice = saved[key];
    const reversed = choice === 'reverse' || choice === 'forward'
      ? choice === 'reverse' : !members[0]?.archive.playlist.manual && runsBackwards(members);
    for (const item of members) item.archive.playlist.reversed = reversed;
  }
  return items;
}

/** Whether these videos' playlist is being walked against its recorded order. */
export const isReversed = items =>
  (items || []).some(item => item.archive?.playlist?.reversed);

/**
 * Playlist order, which is `playlist_index`, not the gallery's sort, flipped
 * for a playlist that records itself backwards. A video with no recorded
 * position has none either way, so it trails the ones that have one rather
 * than leading a reversed run.
 */
export function inPlaylistOrder(items) {
  const placed = (items || []).filter(indexOf);
  const unplaced = (items || []).filter(item => !indexOf(item));
  const direction = isReversed(placed) ? -1 : 1;
  placed.sort((left, right) => direction * (indexOf(left) - indexOf(right)));
  return [...placed, ...unplaced];
}

/** The playlist's own videos, in playlist order, including the one given. */
export function playlistItems(item, items) {
  const playlist = playlistKey(item);
  if (playlist == null) return [];
  return inPlaylistOrder(items.map(candidate => inPlaylist(candidate, playlist)).filter(Boolean));
}

/**
 * The playlist a filtered gallery view is showing, or null when the view is
 * anything else. Filtering is by text, so this reads the result rather than
 * the query: a view is a playlist view when everything left in it belongs to
 * the same playlist. One video is a video, not a playlist, so it does not
 * count — there is no order to see in a list of one.
 */
export function playlistViewOf(items) {
  if (items.length < 2) return null;
  const first = playlistKey(items[0]);
  if (first == null) return null;
  return items.every(item => playlistKey(item) === first)
    ? items[0].archive.playlist : null;
}

const newestOf = items => Math.max(0, ...items.map(item =>
  Number(item?.mtime || item?.archive?.uploadedAt || 0)));

/**
 * The creator most of a playlist's videos come from, for the portrait on its
 * card. A mixed playlist has no single owner, so the majority speaks for it;
 * a tie goes to whoever comes first in playlist order.
 */
export function commonOwnerOf(items) {
  const tally = new Map();
  for (const item of items || []) {
    const owner = item.facets?.owner;
    if (!owner?.name) continue;
    const key = owner.id || owner.name;
    const entry = tally.get(key) || {owner, count: 0};
    entry.count += 1;
    tally.set(key, entry);
  }
  let best = null;
  for (const entry of tally.values()) if (!best || entry.count > best.count) best = entry;
  return best?.owner || null;
}

/**
 * Every playlist the archive holds videos from, each with its videos in
 * playlist order. The playlist the newest video came from comes first, the
 * same "what have I been archiving lately" order the creator shelf uses.
 */
export function playlistsFrom(items, records = []) {
  const groups = new Map();
  for (const item of items || []) {
    for (const playlist of membershipsOf(item)) {
      const key = String(playlist.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inPlaylist(item, key));
    }
  }
  for (const record of records) if (record.manual && !groups.has(record.id)) groups.set(record.id, []);
  return [...groups.entries()].map(([id, members]) => {
    const ordered = inPlaylistOrder(members);
    const playlist = ordered.find(item => item.archive.playlist.title)?.archive.playlist
      || ordered[0]?.archive.playlist || records.find(record => record.id === id);
    const creator = commonOwnerOf(ordered);
    return {
      id: String(id),
      title: playlist.title || String(id),
      url: playlist.url || '',
      count: Math.max(Number(playlist.count || 0), ordered.length),
      uploader: playlist.uploader || '',
      manual: Boolean(playlist.manual),
      // A channel's own uploads, which yt-dlp also calls a playlist.
      uploads: Boolean(playlist.uploads),
      // A personal playlist has no owner of its own to claim on its page, but
      // its card still wears the portrait of whoever it holds the most of.
      owner: playlist.manual ? null : creator,
      creator,
      latestAt: newestOf(ordered),
      items: ordered,
    };
  }).sort((left, right) =>
    right.latestAt - left.latestAt || left.title.localeCompare(right.title));
}

const sameMembers = (left, right) =>
  left.length === right.length && left.every((item, at) => item === right[at]);

/**
 * Home's list with each whole playlist folded into one entry, so an album
 * downloaded as one is one card rather than a run of its tracks. The entry
 * takes the place of whichever of its videos the list would have shown first.
 *
 * Only a playlist the archive holds all of folds: part of one is a few videos
 * from somewhere, not the thing itself. A personal playlist never does, since
 * gathering videos into one should not take them off home, and nor does a
 * channel downloaded whole, which is a channel rather than an album. A video folds
 * into one playlist at most, and a playlist that would share one with a
 * playlist already folded stays as its videos, so nothing shows twice.
 *
 * The gallery rebuilds whenever an entry is a new object, so an entry is kept
 * for as long as the same videos make it up.
 */
export function createPlaylistCollapser() {
  let kept = new Map();
  return function collapse(items, playlists) {
    const claimed = new Map();
    for (const playlist of playlists || []) {
      if (playlist.manual || playlist.uploads || playlist.items.length < 2 || playlist.items.length < playlist.count) continue;
      const ids = playlist.items.map(item => item.id);
      if (ids.some(id => claimed.has(id))) continue;
      for (const id of ids) claimed.set(id, playlist);
    }
    const members = new Map();
    for (const item of items) {
      const playlist = claimed.get(item.id);
      if (!playlist) continue;
      if (!members.has(playlist)) members.set(playlist, []);
      members.get(playlist).push(item);
    }
    const next = new Map();
    for (const [playlist, held] of members) {
      // Every video has to be in this list too, or what is folded is a
      // filtered remnant rather than the whole playlist.
      if (held.length !== playlist.items.length) continue;
      const previous = kept.get(playlist.id);
      const signature = [playlist.title, playlist.count, playlist.url, isReversed(playlist.items)];
      next.set(playlist.id, previous && sameMembers(previous.members, held)
        && sameMembers(previous.signature, signature)
        ? previous
        : {entry: {id: `playlist:${playlist.id}`, playlist}, members: held, signature});
    }
    kept = next;
    const placed = new Set();
    return items.flatMap(item => {
      const playlist = claimed.get(item.id);
      const fold = playlist && kept.get(playlist.id);
      if (!fold) return [item];
      if (placed.has(playlist.id)) return [];
      placed.add(playlist.id);
      return [fold.entry];
    });
  };
}
