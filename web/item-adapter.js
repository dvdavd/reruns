// Translates yt-dlp's .info.json fields into the shared item shape. The shared
// components never see yt-dlp field names; everything provider-specific stops
// here, so a change in yt-dlp's metadata only ever touches this file.
/** @import {MediaItem} from './contracts.js' */
import {t} from './i18n.js';
import {uploadedAtOf} from './watch-details.js';

function qualityOf(raw) {
  // A download with no picture has no quality to rank. yt-dlp's note for an
  // audio format is its own shorthand ("medium", or a whole track
  // description), which says nothing to a viewer; facets.js names it Audio.
  if (isAudioOnly(raw)) return '';
  const width = Number(raw.width || 0);
  const height = Number(raw.height || 0);
  if (width >= 7680) return '8K';
  if (width >= 3840) return '4K';
  if (width >= 2560) return '1440p';
  if (width >= 1920) return '1080p';
  if (width >= 1280) return '720p';
  // Under the usual ladder, name it for its lines rather than for yt-dlp's
  // format note, which is its own shorthand and comes through as a jumble
  // like "480p+medium" or a whole track description. The line count is the
  // short side, so a video shot in portrait reads like a landscape one: a
  // 1080x1920 phone video is 1080p, the same as 1920x1080 is.
  if (width && height) return `${Math.min(width, height)}p`;
  // Nothing but a note left, which is a download with no picture at all.
  return raw.format_note || '';
}

/**
 * Whether the file has a picture. The server marks a file with an audio
 * suffix "none" whatever the sidecar said, and yt-dlp says "none" itself for
 * an audio format kept in its own container, such as Opus in a WebM; a
 * sidecar that records no codec at all is taken for a video, as it always was.
 */
function isAudioOnly(raw) {
  return raw.vcodec === 'none';
}

/**
 * The track as a music service describes it. YouTube Music, Bandcamp and
 * SoundCloud fill these in; anything else leaves them out, and a video that
 * happens to be music is not given an album it never had. yt-dlp has moved
 * from one `artist` string to an `artists` list, so either is read.
 */
function musicOf(raw) {
  const track = String(raw.track || '');
  const album = String(raw.album || '');
  if (!track && !album) return null;
  const artists = Array.isArray(raw.artists) && raw.artists.length ? raw.artists : [raw.artist];
  return {
    track, album,
    artist: artists.filter(Boolean).join(', '),
    trackNumber: Number(raw.track_number || 0) || 0,
    year: Number(raw.release_year || 0) || 0,
  };
}

// yt-dlp reports YouTube's codecs in full (av01.0.12M.08, vp09.00.40.08),
// which is what a browser needs to be asked about them. Other extractors can
// say just "h264"; a browser answers no to that as a codec string even when it
// plays the file, so only the forms here are put to it.
const VIDEO_CODECS = [
  [/^av01\./, 'AV1'], [/^vp09\./, 'VP9'], [/^vp0?9$/, 'VP9'], [/^vp0?8$/, 'VP8'],
  [/^(?:avc1|avc3)\./, 'H.264'], [/^(?:hvc1|hev1)\./, 'HEVC'],
];
const VIDEO_CONTAINERS = {webm: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4'};

/**
 * How the picture is encoded, in the terms MediaCapabilities asks for, so the
 * player can warn before a browser silently fails to play it - Safari on a Mac
 * with no AV1 hardware does exactly that. Null when there is no picture, or
 * one described too loosely to ask about: a warning on a file that would have
 * played is worse than no warning.
 */
function encodingOf(raw, container) {
  const codec = raw.vcodec && raw.vcodec !== 'none' ? String(raw.vcodec) : '';
  const name = VIDEO_CODECS.find(([pattern]) => pattern.test(codec))?.[1];
  const type = VIDEO_CONTAINERS[container];
  if (!name || !type) return null;
  const duration = Number(raw.duration || 0);
  const size = Number(raw.filesize || raw.filesize_approx || 0);
  return {
    name,
    contentType: `${type}; codecs="${codec}"`,
    width: Number(raw.width || 0), height: Number(raw.height || 0),
    framerate: Number(raw.fps || 0),
    // The file's whole rate, sound and all; near enough for a decoder to judge.
    bitrate: duration && size ? Math.round(size * 8 / duration) : 0,
  };
}

function basename(path) {
  return String(path || '').split('/').pop();
}

function sameName(left, right) {
  return String(left || '').trim().localeCompare(String(right || '').trim(), undefined, {
    sensitivity: 'accent',
  }) === 0;
}

/**
 * Whether the uploader is the channel, said by the addresses rather than the
 * names. TikTok calls the @handle the uploader and the display name the
 * channel, so matching on the names alone leaves one person wearing two chips
 * — and the card's footer wraps onto a second row to hold them both. A video
 * whose own page sits under the uploader's profile belongs to that account by
 * construction, however differently the two fields spell it. A YouTube watch
 * URL lives at the site root, not under a channel, so the rare video that
 * really does credit someone other than the channel keeps its person.
 */
function ownsThePage(raw) {
  const profile = String(raw.uploader_url || '').replace(/\/+$/, '');
  return Boolean(profile) && String(raw.webpage_url || '').startsWith(`${profile}/`);
}

/**
 * YouTube parses the uploader's description timestamps into this list, so the
 * structured field is what we read rather than the description text. It also
 * synthesises a leading chapter when the first timestamp is not 0:00, naming it
 * `<Untitled Chapter 1>`; that placeholder is yt-dlp passing YouTube's own
 * wording through, and it reads badly in a list, so it becomes a plain number.
 */
function chaptersOf(raw) {
  const chapters = (Array.isArray(raw.chapters) ? raw.chapters : []).map(chapter => ({
    startSeconds: Math.max(0, Number(chapter.start_time) || 0),
    endSeconds: Number(chapter.end_time) || 0,
    title: String(chapter.title || '').trim(),
  })).sort((left, right) => left.startSeconds - right.startSeconds);
  // Number the fallbacks after sorting, so they count up the way they read.
  return chapters.map((chapter, index) => ({
    ...chapter,
    title: !chapter.title || /^<untitled chapter \d+>$/i.test(chapter.title)
      ? t('item.chapter', {number: index + 1}) : chapter.title,
  }));
}

/**
 * YouTube's "most replayed" graph, which yt-dlp records as a fixed number of
 * equal buckets covering the whole video, each already normalised to 0..1.
 * Only YouTube reports it, and only for videos with enough traffic, so it is
 * routinely absent.
 */
function heatmapOf(raw) {
  return (Array.isArray(raw.heatmap) ? raw.heatmap : []).map(bucket => ({
    startSeconds: Math.max(0, Number(bucket.start_time) || 0),
    endSeconds: Math.max(0, Number(bucket.end_time) || 0),
    value: Math.min(1, Math.max(0, Number(bucket.value) || 0)),
  })).sort((left, right) => left.startSeconds - right.startSeconds);
}

/**
 * The subtitle files downloaded beside the video, named for a menu. yt-dlp
 * keeps the site's own language tags, which are mostly BCP 47 but not always
 * — "en-orig" and the like are its own — so an unrecognised tag is shown as
 * it was written rather than dropped.
 */
function subtitleTracksOf(raw) {
  let names = null;
  try {
    names = new Intl.DisplayNames(navigator.languages, {type: 'language'});
  } catch { /* An environment without display names labels by tag. */ }
  return (Array.isArray(raw._subtitle_tracks) ? raw._subtitle_tracks : []).map(track => {
    let label = track.language;
    try {
      label = names?.of(track.language) || track.language;
    } catch { /* Not a language tag this browser can name. */ }
    return {language: track.language, label, url: track.url};
  });
}

/**
 * How many audio tracks the file was merged with. yt-dlp lists what it fetched
 * in `requested_formats`, and the sidecar is all the page has to go on before
 * asking the server about the file itself; more than one is what sends a
 * file through the remux, whatever its container, so the picker can switch.
 */
function audioTrackCountOf(raw) {
  return (Array.isArray(raw.requested_formats) ? raw.requested_formats : [])
    .filter(format => format.vcodec === 'none' && format.acodec && format.acodec !== 'none').length;
}

// Extractors that are not a site of their own, only a way of reading any page.
const GENERIC_EXTRACTORS = new Set(['generic', 'html5mediaembed']);

// yt-dlp's extractor keys for the services web/sources.svg has a logo for.
// A service has several extractors - YoutubeTab, TwitchVod, TwitchClips - so
// each is matched by its stem, and they all filter as the one source.
const KNOWN_SOURCES = [
  [/^youtube/, 'youtube', 'YouTube'], [/^twitch/, 'twitch', 'Twitch'],
  [/^tiktok/, 'tiktok', 'TikTok'], [/^dropbox/, 'dropbox', 'Dropbox'],
  [/^vimeo/, 'vimeo', 'Vimeo'], [/^twitter/, 'x', 'X'],
  [/^instagram/, 'instagram', 'Instagram'], [/^reddit/, 'reddit', 'Reddit'],
  [/^facebook/, 'facebook', 'Facebook'], [/^soundcloud/, 'soundcloud', 'SoundCloud'],
  [/^bili/, 'bilibili', 'Bilibili'], [/^bandcamp/, 'bandcamp', 'Bandcamp'],
  [/^kick(?:vod|clips)?$/, 'kick', 'Kick'], [/^rumble/, 'rumble', 'Rumble'],
  [/^patreon/, 'patreon', 'Patreon'], [/^bluesky/, 'bluesky', 'Bluesky'],
  [/^googledrive/, 'google-drive', 'Google Drive'], [/^mastodon/, 'mastodon', 'Mastodon'],
];
const SOURCE_SPRITE = new URL('./sources.svg', import.meta.url).href;

/**
 * Where a video came from, for the logo at the front of its channel chip.
 * Anything without a logo of its own - an extractor this list does not know,
 * or the generic one that reads any page, named for its host - wears the
 * globe, so every card still says where it is from.
 */
function sourceOf(raw) {
  const extractor = String(raw.extractor_key || raw.extractor || '');
  const key = extractor.toLowerCase();
  const generic = !extractor || GENERIC_EXTRACTORS.has(key);
  let host = '';
  if (generic) {
    host = String(raw.webpage_url_domain || '');
    if (!host) {
      try {
        host = new URL(raw.webpage_url).hostname;
      } catch { /* No address, so nowhere to name. */ }
    }
    host = host.replace(/^www\./, '');
  }
  // With no extractor to go on, a known site's address still names it: a
  // sidecar written by hand, or by an older tool, may record only the page.
  const known = KNOWN_SOURCES.find(([pattern]) => pattern.test(generic ? host.split('.')[0] : key));
  if (known) return {id: known[1], name: known[2], icon: `${SOURCE_SPRITE}#source-${known[1]}`};
  const name = generic ? host : extractor;
  return name ? {id: name.toLowerCase(), name, icon: `${SOURCE_SPRITE}#source-unknown`} : null;
}

/**
 * The title, or a readable one when all the site had was the file's name:
 * Dropbox titles a video "American-Reacts-to-The-Crystal-Maze-4" because that
 * is what the file was called. Only a title that is exactly the name in the
 * address is taken for one, so a real title with hyphens in it is left alone.
 */
function titleOf(raw, filename) {
  const title = String(raw.title || '');
  if (!title) return filename || t('item.untitled');
  let named = '';
  try {
    named = decodeURIComponent(new URL(raw.webpage_url).pathname.split('/').pop() || '');
  } catch { /* No address to compare with. */ }
  if (named.replace(/\.[a-z0-9]{2,4}$/i, '') !== title || !/[-_.]/.test(title)) return title;
  const spaced = title.replace(/[-_.]+/g, ' ').trim();
  return spaced || title;
}

/** @returns {MediaItem} */
export function toMediaItem(raw, originalOrder = 0) {
  // Only someone the sidecar actually names. A made-up "Unknown creator"
  // gathered every anonymous video there was into one person's page; with
  // nobody named, the source's logo is the card's whole chip instead.
  const creator = raw.uploader || raw.creator || raw.channel || '';
  // Twitch (and other single-uploader extractors) never report a separate
  // `channel` field, only `uploader` — the broadcaster is the channel there,
  // so treat it as one rather than showing it as a bare creator with no owner.
  const channel = raw.channel || raw.uploader || '';
  // YouTube commonly reports uploader and channel as the same identity. In
  // that case, rendering both a person chip and an owner chip repeats the
  // channel name on every card. Keep a separate creator only when the source
  // metadata actually distinguishes it from the channel.
  const people = !creator || (channel && (sameName(creator, channel) || ownsThePage(raw)))
    ? []
    : [{id: raw.uploader_id || creator, name: creator, favourite: false}];
  const filename = basename(raw.filepath);
  const title = titleOf(raw, filename);
  const thumbnail = {url: raw._thumb_url || ''};
  const container = raw.ext || filename.split('.').slice(1).pop() || '';
  const music = musicOf(raw);
  const part = {
    id: raw._key,
    sourceRef: raw._media_url,
    filename,
    title: '',
    durationSeconds: Number(raw.duration || 0),
    sizeBytes: Number(raw.filesize || raw.filesize_approx || 0),
    resolution: raw.width && raw.height ? `${raw.width}x${raw.height}` : '',
    quality: qualityOf(raw),
    codec: raw.vcodec && raw.vcodec !== 'none' ? raw.vcodec : (raw.acodec || 'Unknown'),
    encoding: encodingOf(raw, container),
    thumbnail,
    watch: {},
    session: {},
    media: null,
    seekPreviewUrl: raw._seek_preview_url || '',
    subtitleTracks: subtitleTracksOf(raw),
    audioTrackCount: audioTrackCountOf(raw),
  };
  return {
    id: raw._key,
    sourceRef: raw._media_url,
    searchPath: [title, raw.title, creator, channel, raw.playlist, music?.artist, music?.album,
      raw.webpage_url]
      .filter(Boolean).join(' ').toLowerCase(),
    title,
    filename,
    durationSeconds: part.durationSeconds,
    sizeBytes: part.sizeBytes,
    // Sorting by newest wants a date for every video. One the site never
    // dated sorts by when it was downloaded, rather than sinking to the end
    // as if it were the oldest thing in the archive; the watch page still
    // shows no upload date for it, since it has none.
    mtime: uploadedAtOf(raw) || Number(raw.epoch || 0),
    quality: part.quality,
    codec: part.codec,
    // Of the copy this item stands for, so the card says what a click plays.
    // Not `media`, which is the player's projection of a VR video.
    audioOnly: isAudioOnly(raw),
    music,
    favourite: Boolean(raw._favourite),
    thumbnail,
    watch: {},
    session: {},
    media: null,
    parts: [part],
    facets: {
      people,
      // The server indexes channels by this same id so the watch page can
      // ask it for the channel's picture; `_channel_key` is its own answer.
      owner: channel
        ? {id: raw._channel_key || raw.channel_id || raw.uploader_id || channel, name: channel} : null,
      collections: raw.playlist
        ? [{id: raw.playlist_id || raw.playlist, name: raw.playlist}] : [],
      source: sourceOf(raw),
      // The shared ordinal is a release number displayed beside the owner.
      // A playlist position belongs to the collection, not the channel.
      ordinal: null,
    },
    // Everything the watch page shows beyond the card. The gallery ignores
    // these, but they are the reason to keep the sidecar around at all.
    archive: {
      webpageUrl: raw.webpage_url || '',
      // The channel's addresses, so a subscription can find its videos.
      channelUrls: [raw.channel_url, raw.uploader_url].filter(Boolean),
      downloaded: Boolean(raw._media_url),
      extractor: raw.extractor_key || raw.extractor || '',
      // The id the site gave the video, as opposed to the key of the file on
      // disk. Two downloads of the same video share it, which is how
      // groupFormats knows they are one video in two formats.
      sourceId: String(raw.id || ''),
      // Both of these arrive from `detailsUrl`, not the listing: see
      // applyItemDetails. They are empty on an item straight from /api/items.
      description: raw.description || '',
      uploadedAt: uploadedAtOf(raw),
      // Epoch seconds of the last metadata refresh; 0 for a video never refreshed.
      refreshedAt: Number(raw._reruns_refreshed || 0),
      viewCount: Number(raw.view_count || 0),
      likeCount: Number(raw.like_count || 0),
      fps: Math.round(Number(raw.fps || 0)) || 0,
      container,
      audioCodec: raw.acodec && raw.acodec !== 'none' ? raw.acodec : '',
      subtitleLanguages: Object.keys(raw.subtitles || {}).sort(),
      automaticCaptionLanguages: [],
      chapters: chaptersOf(raw),
      heatmap: heatmapOf(raw),
      detailsUrl: raw._details_url || '',
      // The number arrives with the details; the comments themselves are
      // fetched from commentsUrl only when the section is opened.
      commentsUrl: raw._comments_url || '',
      // The chat replay saved beside a stream, read a window at a time.
      chatHeld: Boolean(raw._chat_held),
      chatUrl: raw._chat_url || '',
      commentCount: 0,
      sponsorBlockUrl: raw._sponsorblock_url || '',
      // The position stays here rather than in facets.ordinal: the shared
      // ordinal renders beside the owner, and this belongs to the collection.
      playlist: raw.playlist_id || raw.playlist ? {
        id: raw.playlist_id || raw.playlist,
        title: raw.playlist_title || raw.playlist || '',
        index: Number(raw.playlist_index || 0),
        count: Number(raw.playlist_count || raw.n_entries || 0),
        url: raw.playlist_webpage_url || '',
        uploader: raw.playlist_uploader || raw.playlist_channel || '',
        uploads: channelUploads(raw),
      } : null,
    },
    originalOrder,
  };
}

// A channel's tabs, as yt-dlp names the playlist a channel download makes.
const CHANNEL_TAB = /\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/(videos|shorts|streams|live|featured|podcasts|releases))?\/?$/;

/**
 * Whether the "playlist" a video came in is just its channel: yt-dlp reports
 * a channel or one of its tabs as a playlist named for it, and YouTube's
 * uploads list is the channel's id with UU for UC. Those are what a channel
 * posted rather than something anyone put together.
 */
function channelUploads(raw) {
  const id = String(raw.playlist_id || '');
  const channel = String(raw.channel_id || '');
  if (id && (id === channel || id === raw.uploader_id)) return true;
  if (channel.startsWith('UC') && id === `UU${channel.slice(2)}`) return true;
  return CHANNEL_TAB.test(String(raw.playlist_webpage_url || '').split('?')[0]);
}

/** Keep archive-only fields behind the adapter boundary. */
export function sourceUrlFor(item) {
  return item.archive?.webpageUrl || '';
}

/** Translates a playlist sidecar; the shape mirrors an item's own playlist. */
export function toPlaylist(raw) {
  return {
    id: String(raw.id || ''),
    title: raw.title || '',
    description: raw.description || '',
    url: raw.url || '',
    count: Number(raw.count || 0),
    uploader: raw.uploader || '',
    manual: Boolean(raw.manual),
    members: raw.members || [],
  };
}

/**
 * Folds the playlist sidecars into the items that belong to them. A video's
 * own sidecar only knows what was true when it was downloaded — a playlist
 * that has grown since leaves it reporting a stale count, and a playlist you
 * fetched a single video from may leave it with no count at all. The playlist
 * record is the authority for the playlist itself, so it wins for title, URL
 * and count; the per-video position stays the video's own.
 */
export function applyPlaylists(items, playlists) {
  const byId = new Map(playlists.map(playlist => [playlist.id, playlist]));
  const bySource = new Map();
  for (const playlist of playlists) {
    for (const member of playlist.members || []) {
      if (!bySource.has(member.source)) bySource.set(member.source, []);
      bySource.get(member.source).push({...playlist, index: Number(member.index || 0)});
    }
  }
  for (const item of items) {
    const source = item.archive.extractor && item.archive.sourceId
      ? `${item.archive.extractor.toLowerCase()}:${item.archive.sourceId}` : `file:${item.id}`;
    const memberships = new Map((item.archive.playlists || (item.archive.playlist ? [item.archive.playlist] : []))
      .map(playlist => [String(playlist.id), playlist]));
    for (const playlist of bySource.get(source) || []) memberships.set(playlist.id, playlist);
    item.archive.playlists = [...memberships.values()].map(playlist => {
      const record = byId.get(String(playlist.id));
      return record ? {...playlist, manual: record.manual, title: record.title || playlist.title,
        url: record.url || playlist.url, count: record.count || playlist.count,
        uploader: record.uploader || playlist.uploader, description: record.description || ''} : playlist;
    });
    item.facets.collections = item.archive.playlists.map(playlist => ({id: playlist.id, name: playlist.title}));
    item.archive.playlist = item.archive.playlists.find(playlist => playlist.id === item.archive.playlist?.id)
      || item.archive.playlists[0] || null;
  }
  return items;
}


/**
 * The same video downloaded twice — 1080p and 4K, or a video and the audio
 * pulled out of it — is one video with two files, not two videos. yt-dlp
 * records the site's own id for the video, so two sidecars naming the same id
 * from the same extractor are the same video however differently the files
 * are named. The key of a file on disk is not it: that is exactly what
 * differs between the copies.
 */
function formatGroupOf(item) {
  const {extractor, sourceId} = item.archive;
  return extractor && sourceId ? `${extractor}\u0000${sourceId}` : '';
}

function pixelsOf(item) {
  const [width, height] = String(item.parts[0]?.resolution || '').split('x');
  return (Number(width) || 0) * (Number(height) || 0);
}

/** The best copy first: the largest picture, and the biggest file of two that
 *  are the same size on screen, which is the one that was worth keeping. */
function byQuality(left, right) {
  return pixelsOf(right) - pixelsOf(left) || right.sizeBytes - left.sizeBytes;
}

/**
 * How a copy is named in the switcher: what a viewer would call the
 * difference. A download with no picture is named for that rather than for
 * its quality — yt-dlp's note for an audio format is its own shorthand
 * ("medium", or a whole track description), which says nothing to a viewer
 * choosing between a video and the sound from it.
 */
function formatLabelOf(item) {
  const part = item.parts[0] || {};
  if (!part.resolution) return t('item.audioOnly');
  return item.quality || part.resolution;
}

/** A codec as a viewer would name it: AV1 rather than av01.0.12M.08. */
export function codecNameOf(format) {
  return format.encoding?.name || format.codec || '';
}

function formatOf(item) {
  const part = item.parts[0] || {};
  const label = formatLabelOf(item);
  return {
    id: item.id,
    label,
    // What the player's own button says. The label beside it in the list may
    // pick up a container or a codec to tell two copies apart; the button
    // names the picture and nothing else, since it is saying what is playing
    // rather than distinguishing it from anything.
    shortLabel: label,
    sourceRef: item.sourceRef,
    filename: item.filename,
    sizeBytes: item.sizeBytes,
    quality: item.quality,
    audioOnly: item.audioOnly,
    resolution: part.resolution,
    codec: item.codec,
    encoding: part.encoding,
    audioCodec: item.archive.audioCodec,
    container: item.archive.container,
    fps: item.archive.fps,
    seekPreviewUrl: part.seekPreviewUrl,
    subtitleTracks: part.subtitleTracks || [],
    audioTrackCount: part.audioTrackCount || 0,
  };
}

/**
 * Tells copies apart that a viewer could not otherwise: two 1080p downloads
 * are distinguished by their containers, and failing that by their codecs.
 * Only the copies that actually collide are qualified, and only by what
 * differs between them, so a list of 4K, 1080p and 720p stays three plain
 * names and two 4K WebMs read "4K · AV1" and "4K · VP9", not "4K · WEBM · AV1".
 */
function distinguish(formats) {
  for (const qualify of [format => format.container.toUpperCase(), codecNameOf]) {
    const groups = new Map();
    for (const format of formats) {
      groups.set(format.label, [...(groups.get(format.label) || []), format]);
    }
    const colliding = [...groups.values()].filter(group => group.length > 1);
    if (!colliding.length) break;
    for (const group of colliding) {
      if (new Set(group.map(qualify)).size < 2) continue;
      for (const format of group) {
        const extra = qualify(format);
        if (extra) format.label = `${format.label} · ${extra}`;
      }
    }
  }
  return formats;
}

/**
 * Collapses each video's several downloaded formats into the one item the
 * gallery shows, keeping the rest on `archive.formats` for the watch page to
 * offer. The best copy is the one kept, so the gallery card describes what a
 * click will play; a favourite set on any copy belongs to the video, so it
 * survives whichever copy is dropped.
 *
 * `known` is the ids the page already has for videos. A copy among them keeps
 * standing for its video even when a better one lands beside it: the id is
 * what the watch page, its address and the saved position hold on to, and a
 * VP9 copy fetched because the AV1 one would not play is usually the bigger
 * file, which made it the best and took the video's id from under a page
 * that was showing it. The new copy joins the formats instead.
 *
 * The items keep their original order: a group sits where its first copy was.
 */
export function groupFormats(items, known = new Set()) {
  const groups = new Map();
  const order = [];
  for (const item of items) {
    const key = formatGroupOf(item);
    if (!key) {
      order.push(item);
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(item);
  }
  return order.map(entry => {
    if (typeof entry !== 'string') return entry;
    const copies = groups.get(entry);
    if (copies.length === 1) return copies[0];
    const ranked = [...copies].sort(byQuality);
    const best = ranked.find(copy => known.has(copy.id)) || ranked[0];
    best.archive.playlists = [...new Map(copies.flatMap(copy => copy.archive.playlists
      || (copy.archive.playlist ? [copy.archive.playlist] : []))
      .map(playlist => [String(playlist.id), playlist])).values()];
    best.favourite = copies.some(copy => copy.favourite);
    best.archive.formats = distinguish(ranked.map(formatOf));
    best.archive.formatId = best.id;
    return best;
  });
}

/**
 * Switches an item to another of its downloaded formats, in place. Only the
 * facts about the file change — the video's own identity, its thumbnail and
 * its watched position stay the item's, so the player reloads the picture
 * without the watch page becoming a different video. Returns whether anything
 * moved, so a caller can skip reloading for the format already playing.
 */
export function selectFormat(item, formatId) {
  if (!formatId) return false;
  const chosen = (item.archive?.formats || []).find(format => format.id === formatId);
  if (!chosen || item.archive.formatId === formatId) return false;
  const part = item.parts[0];
  for (const target of [item, part]) {
    target.sourceRef = chosen.sourceRef;
    target.filename = chosen.filename;
    target.sizeBytes = chosen.sizeBytes;
    target.quality = chosen.quality;
    target.codec = chosen.codec;
  }
  part.resolution = chosen.resolution;
  item.audioOnly = chosen.audioOnly;
  part.encoding = chosen.encoding;
  part.seekPreviewUrl = chosen.seekPreviewUrl;
  part.subtitleTracks = chosen.subtitleTracks;
  part.audioTrackCount = chosen.audioTrackCount;
  item.archive.container = chosen.container;
  item.archive.fps = chosen.fps;
  item.archive.audioCodec = chosen.audioCodec;
  item.archive.formatId = formatId;
  return true;
}

/** The format playing now, for a control that names it. Null when the video
 *  was only ever downloaded once. */
export function currentFormat(item) {
  const formats = item?.archive?.formats || [];
  if (formats.length < 2) return null;
  return formats.find(format => format.id === item.archive.formatId) || formats[0];
}

/**
 * Folds a `/api/item-details` payload into an item, in place.
 *
 * The description and the heatmap are most of what a listing would weigh - a
 * heatmap is around a hundred buckets a video - and only the watch page reads
 * either, so the server leaves them out of /api/items and the watch page asks
 * for the one video it is showing. Returns the item, so a caller can redraw
 * from the result.
 */
export function applyItemDetails(item, details) {
  if (!item || !details) return item;
  if (typeof details.description === 'string') {
    item.archive.description = details.description;
  }
  if (Array.isArray(details.heatmap)) {
    item.archive.heatmap = heatmapOf(details);
  }
  if (Number.isFinite(details._comments_held)) {
    item.archive.commentCount = details._comments_held;
  }
  if (Array.isArray(details.automatic_caption_languages)) {
    item.archive.automaticCaptionLanguages = details.automatic_caption_languages;
  }
  return item;
}

/**
 * `/api/comments` entries as threads. yt-dlp gives a flat list in YouTube's
 * ranking order; a reply's parent is the id it hangs under ("root" for the
 * rest). A reply whose parent was cut by the download's cap has nothing to
 * hang from, so it is left out rather than shown as a stray top-level remark.
 * `postedAt` is yt-dlp's guess from "6 years ago", so it is good for ordering
 * and for a day at most. Edited is the one thing only `_time_text` records,
 * which is unofficial, hence the loose match.
 */
export function commentsOf(list) {
  const entries = (Array.isArray(list) ? list : []).map(raw => ({
    id: String(raw.id ?? ''),
    parent: raw.parent && raw.parent !== 'root' ? String(raw.parent) : '',
    author: String(raw.author || '').replace(/^@/, ''),
    avatarUrl: String(raw.author_thumbnail || ''),
    text: String(raw.text || ''),
    likes: Math.max(0, Number(raw.like_count) || 0),
    postedAt: Number(raw.timestamp) || 0,
    edited: /\(edited\)/i.test(String(raw._time_text || '')),
    pinned: raw.is_pinned === true,
    hearted: raw.is_favorited === true,
    byUploader: raw.author_is_uploader === true,
    replies: [],
  }));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const threads = [];
  for (const entry of entries) {
    if (!entry.parent) threads.push(entry);
    else byId.get(entry.parent)?.replies.push(entry);
  }
  return threads;
}

/** Top keeps YouTube's order (pinned first, as it ranks them); newest orders
 *  by the estimated time. Replies read oldest-first either way, as a
 *  conversation does. */
export function sortComments(threads, order) {
  const ordered = order === 'newest'
    ? [...threads].sort((a, b) => b.postedAt - a.postedAt)
    : threads;
  return ordered.map(thread => ({
    ...thread,
    replies: [...thread.replies].sort((a, b) => a.postedAt - b.postedAt),
  }));
}
