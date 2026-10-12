// The shared library-item shape. Both the VR library and the archival client
// adapt their server payloads into this form, so the shared components never
// see app-specific field names.
//
// Facets carry the app-flavoured vocabulary in four fixed shapes:
//   people      multi-valued taggable entities (actors | contributors)
//   owner       single-valued owner            (studio | channel)
//   collections many-to-many membership        (groups | playlists)
//   ordinal     position within the owner      (release number | episode)

/** Mirrors config.py's format_bytes: integer bytes, one decimal above. */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return unit === 'B' ? `${Math.trunc(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

/** Mirrors library.py's format_duration; null durations read as "Unknown". */
export function formatDuration(seconds) {
  if (seconds == null) return 'Unknown';
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = value => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Returns the part a card is currently showing, or null when unsplit. */
export function partAt(item, partIndex = 0) {
  const parts = item.parts || [];
  if (parts.length < 2) return parts[0] || null;
  return parts[(partIndex % parts.length + parts.length) % parts.length];
}

// The label logic that previously lived in library.py's display_name plus the
// template's `display_name: subtitle` concatenation. A part's title is the
// former per-video `subtitle`, so the full label needs the part context.
export function displayLabel(item, partIndex = 0) {
  const base = (item.title || '').trim() || item.filename || '';
  const part = partAt(item, partIndex);
  const partTitle = (part?.title || '').trim();
  return partTitle ? `${base}: ${partTitle}` : base;
}

/**
 * Collapses an item and its active part into the flat values a card renders.
 * Parts override the item for everything the part carries its own copy of,
 * which is what changeCardPart used to do by writing back onto the dataset.
 */
export function viewOf(item, partIndex = 0) {
  const parts = item.parts || [];
  const part = partAt(item, partIndex);
  const pick = key => (part && part[key] != null ? part[key] : item[key]);
  const watch = {...(item.watch || {}), ...(part?.watch || {})};
  return {
    id: item.id,
    sourceRef: part?.sourceRef ?? item.sourceRef,
    label: displayLabel(item, partIndex),
    filename: pick('filename'),
    durationSeconds: Number(pick('durationSeconds') || 0),
    sizeBytes: Number(pick('sizeBytes') || 0),
    resolution: pick('resolution') || '',
    quality: pick('quality') || '',
    codec: pick('codec') || 'Unknown',
    remastered: Boolean(pick('remastered')),
    accent: pick('accent') || null,
    favourite: Boolean(item.favourite),
    watch: {
      count: Number(watch.count || 0),
      progress: Number(watch.progress || 0),
      completed: Boolean(watch.completed),
      lastPlayedAt: Number(watch.lastPlayedAt || 0),
      lastCompletedAt: Number(watch.lastCompletedAt || 0),
      resumeSeconds: Number(watch.resumeSeconds || 0),
    },
    // A part carries its own session only when it is genuinely split; an
    // unsplit item keeps its session on the item itself.
    session: sessionOf(part?.session ? part : item),
    thumbnail: part?.thumbnail || item.thumbnail || {},
    // A part may name its own owner (a playlist of several creators), which
    // then speaks for the card while that part is showing.
    facets: part?.facets ? {...item.facets, ...part.facets} : item.facets || {},
    partIndex: parts.length > 1 ? (partIndex % parts.length + parts.length) % parts.length : 0,
    partCount: parts.length,
    partLabel: part?.label || '',
  };
}

/** A playback session only counts as live while its expiry is in the future. */
export function sessionOf(source, now = Date.now()) {
  const session = source?.session || {};
  const active = Boolean(session.active) && Number(session.expiresAt || 0) > now;
  return {
    active,
    progress: Math.max(0, Math.min(100, Number(session.progress || 0))),
    completed: Boolean(session.completed),
    expiresAt: Number(session.expiresAt || 0),
  };
}
