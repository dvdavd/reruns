import {locale, plural, t} from './i18n.js';
import {playlistItems} from './playlists.js';
import {sameSeries, titleSequence} from './title-sequence.js';

// Builds the metadata the watch page shows under the player. Everything here
// reads the adapted item shape only, so it stays testable without a DOM and
// without the shared package; the caller supplies the two shared formatters it
// cannot import (`formatBytes`, `formatDuration`).


function formatCount(value) {
  const count = Number(value || 0);
  if (!count) return '';
  if (count < 1000) return `${count}`;
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  const [scale, suffix] = units.find(([threshold]) => count >= threshold);
  const scaled = count / scale;
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
}

/** yt-dlp timestamps are epoch seconds; upload_date is a bare YYYYMMDD. */
export function uploadedAtOf(raw) {
  const stamp = Number(raw.timestamp || raw.release_timestamp || 0);
  if (stamp) return stamp;
  const date = String(raw.upload_date || raw.release_date || '');
  if (!/^\d{8}$/.test(date)) return 0;
  return Date.UTC(date.slice(0, 4), Number(date.slice(4, 6)) - 1, date.slice(6, 8)) / 1000;
}

// A bare upload_date only ever meant a UTC day, so format in UTC; otherwise a
// negative offset would show every such video as published a day early.
export function formatDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleDateString(locale(), {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/** The day as cards give it, "31 Oct 2026", where a line of figures has no room for the month in full. */
export function formatShortDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleDateString(locale(), {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * The chips shown straight under the title: who, when, and how much of it was
 * watched by the world. Empty values drop out rather than render as blanks.
 */
export function summaryOf(item, format = {}) {
  const duration = format.duration ? format.duration(item.durationSeconds) : '';
  const views = formatCount(item.archive?.viewCount);
  const likes = formatCount(item.archive?.likeCount);
  return [
    item.facets.owner?.name,
    formatDate(item.archive?.uploadedAt),
    views && plural('count.views', Number(item.archive?.viewCount), {text: views}),
    likes && plural('count.likes', Number(item.archive?.likeCount), {text: likes}),
    duration,
  ].filter(Boolean);
}

/**
 * Where the watch page's channel and playlist links lead: the facet each one
 * filters the gallery by, or null when the video has none.
 */
export function watchLinks(item) {
  const owner = item.facets.owner;
  const playlist = item.archive?.playlist;
  const collection = item.facets.collections?.[0];
  const playlistId = playlist?.id || collection?.id;
  return {
    channel: owner?.id ? {id: owner.id, name: owner.name} : null,
    playlist: playlistId
      ? {id: playlistId, name: playlist?.title || collection?.name || ''} : null,
  };
}

/** "Blender in 70 minutes (1 of 2)", or the bare title when there is no position. */
export function playlistLabel(item) {
  const playlist = item.archive?.playlist;
  const title = playlist?.title || item.facets.collections?.[0]?.name || '';
  if (!title) return '';
  return playlist?.index && playlist?.count
    ? t('watch.position', {title, index: playlist.index, count: playlist.count}) : title;
}

// How a container, an audio codec and a site are named on a page, rather than
// as the sidecar spells them: "WebM · AV1 / Opus", not "webm av01.0.00M... opus".
const CONTAINER_NAMES = {webm: 'WebM', mkv: 'MKV', mp4: 'MP4', m4a: 'M4A', mov: 'MOV'};
const AUDIO_CODECS = [
  [/^mp4a/, 'AAC'], [/^opus$/, 'Opus'], [/^vorbis$/, 'Vorbis'], [/^flac$/, 'FLAC'],
  [/^mp3$/, 'MP3'], [/^(?:ac-3|ec-3)$/, 'Dolby Digital'],
];
const SITE_NAMES = {youtube: 'YouTube', twitch: 'Twitch', vimeo: 'Vimeo', tiktok: 'TikTok',
  soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', dailymotion: 'Dailymotion'};

const audioCodecName = codec => AUDIO_CODECS.find(([pattern]) => pattern.test(codec))?.[1] || codec;
const siteName = extractor => SITE_NAMES[String(extractor).toLowerCase()] || extractor;

/**
 * The definition rows for the file itself. These answer "what exactly is on
 * disk", which is the question an archive is for. What the line under the
 * title already says (channel, date, length) is not said again here, and what
 * belongs together shares a row: the picture's size with its frame rate, the
 * container with the codecs inside it.
 */
export function specsOf(item, format = {}) {
  const part = item.parts?.[0] || {};
  const archive = item.archive || {};
  const music = item.music || {};
  const bytes = format.bytes && item.sizeBytes ? format.bytes(item.sizeBytes) : '';
  // 1080p says nothing the size does not; a named step (4K) does.
  const step = /^\d+p$/.test(item.quality || '') ? '' : item.quality;
  const video = part.encoding?.name || (part.resolution ? item.codec : '');
  const audio = archive.audioCodec ? audioCodecName(archive.audioCodec) : '';
  // A file with no picture reports its audio codec as the item's codec.
  const codecs = [video, video && audio === audioCodecName(item.codec) ? '' : audio]
    .filter(Boolean).join(' / ') || audioCodecName(item.codec || '');
  const rows = [
    [t('watch.spec.creator'), item.facets.people?.[0]?.name],
    [t('watch.spec.artist'), music.artist],
    [t('watch.spec.album'), [music.album, music.year].filter(Boolean).join(' · ')],
    [t('watch.spec.track'), music.track && music.trackNumber
      ? t('watch.trackOf', {track: music.track, number: music.trackNumber}) : music.track],
    [t('watch.playlist'), playlistLabel(item), 'playlist'],
    [t('watch.spec.resolution'), part.resolution
      ? [part.resolution, step, archive.fps && t('watch.fps', {fps: archive.fps})].filter(Boolean).join(' · ') : ''],
    [t('watch.spec.format'), [CONTAINER_NAMES[archive.container] || String(archive.container || '').toUpperCase(),
      codecs].filter(Boolean).join(' · ')],
    [t('watch.spec.size'), bytes],
    [t('watch.spec.subtitles'), archive.subtitleLanguages?.join(', ')],
    [t('watch.spec.chapters'), archive.chapters?.length ? `${archive.chapters.length}` : ''],
    [t('watch.spec.source'), siteName(archive.extractor || '')],
    [t('watch.spec.refreshed'), formatDate(archive.refreshedAt)],
    [t('watch.spec.file'), item.filename],
  ];
  // `link` names what a row's value leads to, for the page to make it a link.
  return rows.filter(([, value]) => Boolean(value))
    .map(([label, value, link]) => (link ? {label, value, link} : {label, value}));
}

/**
 * The chapter list, each row carrying the seek target and the label to show.
 * `activeChapterIndex` then says which row to mark while the video plays.
 */
export function chaptersOf(item, format = {}) {
  return (item.archive?.chapters || []).map(chapter => ({
    title: chapter.title,
    startSeconds: chapter.startSeconds,
    time: format.duration ? format.duration(chapter.startSeconds) : '',
  }));
}

/** The last chapter that has started; -1 before the first one, or with none. */
export function activeChapterIndex(chapters, seconds) {
  let active = -1;
  for (const [index, chapter] of chapters.entries()) {
    if (chapter.startSeconds <= seconds) active = index; else break;
  }
  return active;
}

/** How far the busiest moment lifts the bar. Enough to read as a shape, not
 *  so much that the accent stops being the accent. */
export const HEAT_STRENGTH = 0.6;

// Map time onto the thumb's travel inside a full-width gradient. CSS extends
// the outermost colours to the track edges without moving interior stops.
function trackPosition(percent) {
  return `calc(${percent.toFixed(2)}% + var(--range-thumb) * ${(0.5 - percent / 100).toFixed(6)})`;
}

/**
 * The "most replayed" graph as a CSS gradient across the seek bar, white at
 * an alpha that follows the heat so it reads as brightness over whatever
 * colour the bar already is. Each bucket contributes one stop at its midpoint,
 * so the gradient's own interpolation draws the curve between them.
 */
export function heatGradient(item) {
  const heat = item.archive?.heatmap || [];
  const duration = Number(item.durationSeconds) || 0;
  if (heat.length < 2 || duration <= 0) return '';
  const stops = heat.map(bucket => {
    const middle = (bucket.startSeconds + (bucket.endSeconds || bucket.startSeconds)) / 2;
    const position = Math.min(100, Math.max(0, middle * 100 / duration));
    const alpha = Math.min(1, Math.max(0, bucket.value)) * HEAT_STRENGTH;
    return `rgb(255 255 255 / ${alpha.toFixed(3)}) ${trackPosition(position)}`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** SponsorBlock's own names for its categories, as a viewer would read them. */
export const sponsorCategories = () => Object.fromEntries(['sponsor', 'selfpromo', 'interaction', 'intro',
  'outro', 'preview', 'music_offtopic', 'filler'].map(category => [category, t(`sponsor.cat.${category}`)]));

/**
 * SponsorBlock's own colour for each category, the ones a viewer knows from
 * the extension. They are read into both the seek bar and the popup's
 * swatches, so this is the only place they are written down.
 */
export const SPONSOR_COLOURS = {
  sponsor: '#00d400',
  selfpromo: '#ffff00',
  interaction: '#cc00ff',
  intro: '#00ffff',
  outro: '#0202ed',
  preview: '#008fd6',
  music_offtopic: '#ff9900',
  filler: '#7300ff',
};

/**
 * A `linear-gradient` painting the given stretches along the bar, for the
 * shared player's `--range-segments` slot. Built as one background rather
 * than a row of elements so the segments belong to the track itself, and so
 * the playhead rides over them the way it rides over the fill.
 */
export function sponsorGradient(shown) {
  if (!shown.length) return 'linear-gradient(transparent, transparent)';
  const stops = [];
  let at = 0;
  for (const segment of [...shown].sort((a, b) => a.left - b.left)) {
    const start = Math.max(at, segment.left);
    const end = Math.min(100, segment.left + segment.width);
    if (end <= start) continue;
    if (start > at) stops.push(`transparent ${trackPosition(at)} ${trackPosition(start)}`);
    // The slight transparency is what keeps the accent fill readable under a
    // segment, the same way the segments used to sit over it.
    stops.push(`${SPONSOR_COLOURS[segment.category]}e6 ${trackPosition(start)} ${trackPosition(end)}`);
    at = end;
  }
  if (!stops.length) return 'linear-gradient(transparent, transparent)';
  if (at < 100) stops.push(`transparent ${trackPosition(at)} ${trackPosition(100)}`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/**
 * SponsorBlock segments as stretches of the seek bar, in percent of the run.
 * Unknown categories and segments that fall outside the video are dropped.
 */
export function sponsorSegments(segments, durationSeconds) {
  const duration = Number(durationSeconds) || 0;
  if (duration <= 0 || !Array.isArray(segments)) return [];
  const categories = sponsorCategories();
  return segments.flatMap(segment => {
    const label = categories[segment?.category];
    const start = Math.max(0, Number(segment?.start) || 0);
    const end = Math.min(duration, Number(segment?.end) || 0);
    if (!label || end <= start) return [];
    return [{
      category: segment.category, label, start, end,
      left: start * 100 / duration,
      width: (end - start) * 100 / duration,
    }];
  });
}

/** The page's whole model, so the controller only has to paint it. */
export function watchDetails(item, format = {}) {
  return {
    title: item.title,
    summary: summaryOf(item, format),
    description: (item.archive?.description || '').trim(),
    chapters: chaptersOf(item, format),
    heat: heatGradient(item),
    playlist: item.archive?.playlist || null,
    specs: specsOf(item, format),
    sourceUrl: item.archive?.webpageUrl || '',
  };
}

const channelKey = item => item.facets?.owner?.id || item.facets?.owner?.name || null;

const titleStopWords = new Set(('a an and are as at be been being but by for from had has have '
  + 'he her hers him his i if in into is it its me my nor of on or our ours she so than '
  + 'that the their theirs them then there these they this those to too us was we were '
  + 'what when where which who why will with you your yours').split(' '));

function titleWords(title) {
  const words = String(title || '').normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter(word => !/^\p{N}+$/u.test(word) && !titleStopWords.has(word)));
}

function titleSimilarity(words, title) {
  const other = titleWords(title);
  let shared = 0;
  for (const word of words) if (other.has(word)) shared++;
  return shared ? 2 * shared / (words.size + other.size) : 0;
}

/**
 * Other parts of the series this video is numbered in, then channel
 * alternatives, then title matches from the wider library. The parts after
 * this one come first, nearest first, so the next part leads the row whether
 * or not the one straight after is held; the earlier parts follow in order.
 */
export function relatedItems(item, items, limit = 10) {
  const channel = channelKey(item);
  const words = titleWords(item.title);
  const sequence = titleSequence(item.title);
  const seen = new Set([item.id]);
  const later = [];
  const earlier = [];
  const siblings = [];
  const matches = [];
  for (const candidate of items) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const part = sequence && titleSequence(candidate.title);
    if (part && sameSeries(sequence, part)) {
      (part.number > sequence.number ? later : earlier).push({candidate, score: part.number});
      continue;
    }
    const score = titleSimilarity(words, candidate.title);
    const ranked = {candidate, score};
    if (channel != null && channelKey(candidate) === channel) siblings.push(ranked);
    else if (score > 0) matches.push(ranked);
  }
  const bySimilarity = (left, right) => right.score - left.score;
  const inOrder = (left, right) => left.score - right.score;
  return [...later.sort(inOrder), ...earlier.sort(inOrder),
    ...siblings.sort(bySimilarity), ...matches.sort(bySimilarity)]
    .slice(0, Math.max(0, limit)).map(entry => entry.candidate);
}

/**
 * The row under the details: channel alternatives and similarly named videos. A
 * playlist is not shown here — it has its own control under the player — so
 * this stays what it says it is, alternatives rather than a position in a run.
 *
 * With nothing to list there is no row at all: the caller drops it rather
 * than leaving an empty heading under the details.
 */
export function relatedPanel(item, items) {
  const entries = relatedItems(item, items);
  const channel = channelKey(item);
  const fromLibrary = entries.some(candidate => channel == null || channelKey(candidate) !== channel);
  return {heading: t(fromLibrary ? 'watch.related' : 'watch.moreFromChannel'), entries};
}

/**
 * The playlist control's model: where this video sits in the run, and the two
 * neighbours the arrows step to. A run of one is not a run, so it gets no
 * control at all.
 */
export function playlistNav(item, items) {
  const entries = playlistItems(item, items);
  if (entries.length < 2) return null;
  const index = entries.findIndex(entry => entry.id === item.id);
  const {title, url, count} = item.archive.playlist;
  return {
    title: title || t('watch.playlist'),
    url: url || '',
    note: count && count !== entries.length ? t('watch.archived', {held: entries.length, count}) : '',
    position: `${index + 1}/${entries.length}`,
    entries,
    currentId: item.id,
    previous: entries[index - 1] || null,
    next: entries[index + 1] || null,
  };
}

/** Autoplay's choices: on past a playlist's end, within one, or not at all. */
export const AUTOPLAY_MODES = ['on', 'playlist', 'off'];

/**
 * What the next arrow, the up-next card and autoplay lead to after this
 * video. The playlist's next part always comes first. Only with autoplay
 * fully on does a video outside a playlist, or at the end of one, go on to
 * the lead of the related row, so the other modes show exactly what they
 * did before there was a recommendation. `played` holds what has already
 * been watched this session, so two videos that each rank the other first
 * cannot bounce the viewer between them forever.
 */
export function upNextOf(item, items, {mode = 'off', nav = null, played = new Set()} = {}) {
  if (nav?.next) return {item: nav.next, recommended: false};
  if (mode !== 'on') return null;
  const recommended = relatedItems(item, items, Infinity).find(candidate => !played.has(candidate.id));
  return recommended ? {item: recommended, recommended: true} : null;
}

/**
 * How long before the end of a part its "up next" card comes up on its own:
 * twenty seconds, or the last tenth of a short part, so a one-minute clip is
 * not half taken over by the card announcing what follows it.
 */
export const UP_NEXT_LEAD_SECONDS = 20;
export function announcesNext(currentTime, duration) {
  if (!(duration > 0) || !Number.isFinite(currentTime)) return false;
  return duration - currentTime <= Math.min(UP_NEXT_LEAD_SECONDS, duration / 10);
}

/** How long the autoplay countdown runs over the end of a part, and past it. */
export const COUNTDOWN_LEAD_SECONDS = 7;
export const COUNTDOWN_TAIL_SECONDS = 1;

/**
 * Where the autoplay countdown is at this point of a part, or null before it
 * starts. It runs over the part's last few seconds and ends just after the
 * part does, so the bar says what is coming without holding the next part
 * back. A short part gets a shorter run, inside its up-next stretch.
 */
export function countdownAt(currentTime, duration) {
  if (!(duration > 0) || !Number.isFinite(currentTime)) return null;
  const lead = Math.min(COUNTDOWN_LEAD_SECONDS, duration / 10);
  const elapsed = currentTime - (duration - lead);
  if (elapsed < 0) return null;
  return {elapsed: Math.min(elapsed, lead), total: lead + COUNTDOWN_TAIL_SECONDS};
}
