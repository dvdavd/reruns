import {readStyles} from './styles-source.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {applyPlaylists, toMediaItem, toPlaylist} from '../web/item-adapter.js';
import {inPlaylistOrder, isReversed, markPlaylistDirection, playlistItems, playlistViewOf,
        runsBackwards} from '../web/playlists.js';
import {activeChapterIndex, announcesNext, countdownAt, chaptersOf, heatGradient, HEAT_STRENGTH, playlistLabel,
        playlistNav, relatedItems, relatedPanel, specsOf, sponsorSegments, summaryOf, uploadedAtOf,
        watchDetails, watchLinks} from '../web/watch-details.js';

const format = {
  bytes: bytes => `${bytes} B`,
  duration: seconds => `${seconds}s`,
};

const raw = {
  _key: 'channel/clip.info.json',
  _media_url: '/media/channel/clip.info.json',
  filepath: '/archive/channel/clip.mkv',
  title: 'A clip',
  description: 'Line one\nLine two',
  channel: 'Example Channel',
  uploader: 'Guest Creator',
  playlist: 'Series',
  webpage_url: 'https://example.test/watch/1',
  extractor_key: 'Youtube',
  upload_date: '20240301',
  view_count: 1234567,
  like_count: 940,
  width: 1920,
  height: 1080,
  fps: 59.94,
  duration: 42,
  filesize: 1024,
  ext: 'mkv',
  vcodec: 'avc1',
  acodec: 'mp4a.40.2',
  subtitles: {es: [{}], en: [{}]},
  chapters: [
    {start_time: 74, end_time: 310, title: 'Teardown'},
    {start_time: 0, end_time: 74, title: '<Untitled Chapter 1>'},
  ],
};

test('the adapter carries the sidecar detail the watch page needs', () => {
  const {archive} = toMediaItem(raw);
  assert.equal(archive.description, 'Line one\nLine two');
  assert.equal(archive.uploadedAt, Date.UTC(2024, 2, 1) / 1000);
  assert.equal(archive.viewCount, 1234567);
  assert.equal(archive.fps, 60);
  assert.equal(archive.container, 'mkv');
  assert.equal(archive.audioCodec, 'mp4a.40.2');
  assert.deepEqual(archive.subtitleLanguages, ['en', 'es']);
});

test('an epoch timestamp wins over the bare upload date, and neither is required', () => {
  assert.equal(uploadedAtOf({timestamp: 1700000000, upload_date: '20240301'}), 1700000000);
  assert.equal(uploadedAtOf({upload_date: 'unknown'}), 0);
  assert.equal(uploadedAtOf({}), 0);
});

test('the summary abbreviates counts and drops what the sidecar lacks', () => {
  const summary = summaryOf(toMediaItem(raw), format);
  // The date is rendered in the viewer's locale, so assert its parts, not a form.
  assert.deepEqual(
    [summary[0], ...summary.slice(2)],
    ['Example Channel', '1.2M views', '940 likes', '42s']);
  assert.match(summary[1], /2024/);
  assert.match(summary[1], /1\b/);
  assert.deepEqual(summaryOf(toMediaItem({_key: 'a', title: 'B'}), format), ['0s']);
});

test('the spec rows describe the file, naming its codecs and sharing rows for what belongs together', () => {
  const specs = specsOf(toMediaItem(raw), format);
  const values = Object.fromEntries(specs.map(row => [row.label, row.value]));
  assert.equal(values.Resolution, '1920x1080 · 60 fps');
  assert.equal(values.Format, 'MKV · avc1 / AAC');
  assert.equal(values.Codec, undefined);
  assert.equal(values.Quality, undefined);
  assert.equal(values.Size, '1024 B');
  assert.equal(values.Subtitles, 'en, es');
  assert.equal(values.Source, 'YouTube');
  assert.equal(values.Playlist, 'Series');
  assert.equal(values.File, 'clip.mkv');

  const audioOnly = toMediaItem({...raw, vcodec: 'none', width: 0, height: 0});
  const audioValues = Object.fromEntries(
    specsOf(audioOnly, format).map(row => [row.label, row.value]));
  assert.equal(audioValues.Format, 'MKV · AAC');
  assert.equal(audioValues.Resolution, undefined);
});

test('missing metadata renders as fewer rows, never as blank ones', () => {
  const details = watchDetails(toMediaItem({_key: 'a', title: 'Bare'}), format);
  assert.equal(details.description, '');
  assert.equal(details.sourceUrl, '');
  assert.ok(details.specs.every(row => row.value));
});

test('the watch markup and controller render every detail the model carries', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const controller = await playerSources();
  for (const hook of ['title', 'summary', 'description', 'description-text',
    'description-toggle', 'specs', 'source', 'file']) {
    assert.match(html, new RegExp(`data-watch-${hook}[\\s=>]`), hook);
  }
  assert.match(controller, /watchDetails\(item, format\)/);
  // Each spec row is a wrapper div.
  assert.match(controller, /row\.append\(term, definition\)/);
  // The browser's own Back leaves the watch page; there is no in-page button.
  assert.doesNotMatch(html, /data-watch-back/);
  // The source page opens off-site, so it must not hand the archive a referrer.
  assert.match(html, /data-watch-source[\s\S]*?rel="noreferrer noopener"/);
});

test('chapters come from the structured field, ordered, with placeholders named', () => {
  const chapters = chaptersOf(toMediaItem(raw), format);
  assert.deepEqual(chapters, [
    {title: 'Chapter 1', startSeconds: 0, time: '0s'},
    {title: 'Teardown', startSeconds: 74, time: '74s'},
  ]);
  // The description also holds these timestamps; we must not parse them twice.
  assert.deepEqual(chaptersOf(toMediaItem({...raw, chapters: []}), format), []);
});

test('the active chapter is the last one that has started', () => {
  const chapters = chaptersOf(toMediaItem(raw), format);
  assert.equal(activeChapterIndex(chapters, 0), 0);
  assert.equal(activeChapterIndex(chapters, 73.9), 0);
  assert.equal(activeChapterIndex(chapters, 74), 1);
  assert.equal(activeChapterIndex(chapters, 9999), 1);
  assert.equal(activeChapterIndex([], 12), -1);
});

test('chapters mark the seek bar rather than a list under the player', async () => {
  const controller = await playerSources();
  const html = await readFile('web/index.html', 'utf8');
  // The list is gone; the dots live over the shared player's own seek input.
  assert.doesNotMatch(html, /data-watch-chapter/);
  assert.match(controller, /archive-chapter-dot/);
  assert.match(controller, /element\.querySelector\('\[data-media-seek\]'\)/);
  // The markers must never intercept a scrub, so they carry no pointer events,
  // and they only show while the pointer is actually on the bar.
  const styles = await readStyles();
  assert.match(styles, /\.archive-chapter-markers \{[^}]*pointer-events: none/);
  assert.match(styles, /\.archive-chapter-markers \{[^}]*opacity: 0/);
  assert.match(styles, /\.archive-seek-track:hover \.archive-chapter-markers/);
  // The shared player resets the accent on its own root, so the watch page has
  // to hand the video's back or the timeline stays the app-wide colour.
  assert.match(styles, /\.archive-watch-stage \.media-player \{\s*--card-accent: var\(--watch-accent\)/);
  assert.match(controller, /page\.style\.setProperty\('--card-accent'/);
  // The name goes into the player's own preview, so the bubble and the frame
  // above it stay exactly as the shared player draws them.
  assert.match(controller, /mediaPlayer\.previewTime\.textContent =/);
  assert.match(controller, /tileBackgroundPosition\(mediaPlayer\.seekPreview, ratio\)/);
  assert.doesNotMatch(controller, /archive-chapter-tip/);
});

test('a chapter dot sits at its share of the run, and zero marks nothing', () => {
  const chapters = chaptersOf(toMediaItem(raw), format);
  const placed = chapters.filter(chapter => chapter.startSeconds > 0)
    .map(chapter => `${chapter.startSeconds * 100 / 310}%`);
  assert.deepEqual(placed, [`${74 * 100 / 310}%`]);
  assert.deepEqual(chaptersOf(toMediaItem({...raw, chapters: []}), format)
    .filter(chapter => chapter.startSeconds > 0), []);
});

const heatRaw = {
  ...raw,
  duration: 100,
  heatmap: [
    {start_time: 50, end_time: 100, value: 1},
    {start_time: 0, end_time: 50, value: 0.25},
  ],
};

test('the heatmap is normalised, ordered, and absent when the sidecar has none', () => {
  assert.deepEqual(toMediaItem(heatRaw).archive.heatmap, [
    {startSeconds: 0, endSeconds: 50, value: 0.25},
    {startSeconds: 50, endSeconds: 100, value: 1},
  ]);
  assert.deepEqual(toMediaItem(raw).archive.heatmap, []);
  // A value outside 0..1 would blow past the strength cap, so it is clamped.
  assert.equal(toMediaItem({...heatRaw, heatmap: [{start_time: 0, end_time: 1, value: 4}]})
    .archive.heatmap[0].value, 1);
});

test('the heat paints one stop per bucket, at its midpoint', () => {
  const gradient = heatGradient(toMediaItem(heatRaw));
  assert.match(gradient, /^linear-gradient\(to right, /);
  // Midpoints of the two buckets across a 100s video, and the busiest bucket
  // reaching exactly the strength cap.
  assert.ok(gradient.includes(`${(0.25 * HEAT_STRENGTH).toFixed(3)}) calc(25.00% + var(--range-thumb) * 0.250000)`), gradient);
  assert.ok(gradient.includes(`${HEAT_STRENGTH.toFixed(3)}) calc(75.00% + var(--range-thumb) * -0.250000)`), gradient);
});

test('no heatmap, or no duration to place it against, paints nothing', () => {
  assert.equal(heatGradient(toMediaItem(raw)), '');
  assert.equal(heatGradient(toMediaItem({...heatRaw, duration: 0})), '');
  // One bucket is a flat bar, not a graph.
  assert.equal(heatGradient(toMediaItem({...heatRaw, heatmap: [heatRaw.heatmap[0]]})), '');
});

test('heat is painted into the track below the native playhead', async () => {
  const controller = await playerSources();
  const styles = await readStyles();
  assert.ok(controller.includes("seekInput.style.setProperty('--archive-heat', details.heat || 'linear-gradient(transparent, transparent)')"));
  assert.match(styles, /--archive-track-background:\s*var\(--archive-heat/);
  for (const pseudo of ['webkit-slider-runnable-track', 'moz-range-track']) {
    assert.ok(styles.includes(`::-${pseudo} {\n  background: var(--archive-track-background);`));
  }
});

const playlistRaw = (id, index) => ({
  _key: `p${index}`,
  title: `Part ${index}`,
  channel: 'ExplainingComputers',
  playlist: 'Blender in 70 minutes',
  playlist_id: id,
  playlist_title: 'Blender in 70 minutes',
  playlist_index: index,
  playlist_count: 3,
  playlist_webpage_url: 'https://example.test/playlist',
});

test('playlist neighbours are ordered by position, not by the gallery order', () => {
  const items = [toMediaItem(playlistRaw('PL1', 3)), toMediaItem(playlistRaw('PL1', 1)),
                 toMediaItem(playlistRaw('PL2', 1))];
  assert.deepEqual(playlistItems(items[1], items).map(entry => entry.archive.playlist.index),
                   [1, 3]);
  assert.deepEqual(playlistItems(toMediaItem({_key: 'a', title: 'B'}), items), []);
});

test('the playlist control carries the position and both neighbours', () => {
  const items = [toMediaItem(playlistRaw('PL1', 1)), toMediaItem(playlistRaw('PL1', 2))];
  const nav = playlistNav(items[0], items);
  assert.equal(nav.title, 'Blender in 70 minutes');
  assert.equal(nav.position, '1/2');
  assert.equal(nav.note, '2 of 3 archived');
  assert.equal(nav.previous, null);
  assert.equal(nav.next.id, items[1].id);
  assert.equal(playlistNav(items[1], items).previous.id, items[0].id);
});

test('a run of one is not a run, so there is no playlist control', () => {
  const alone = toMediaItem(playlistRaw('PL1', 1));
  assert.equal(playlistNav(alone, [alone]), null);
  assert.equal(playlistNav(toMediaItem({_key: 'a', title: 'B'}), []), null);
});

test('the row under the details is the channel, never the playlist', () => {
  const item = toMediaItem(playlistRaw('PL1', 1));
  const sibling = toMediaItem(playlistRaw('PL1', 2));
  const panel = relatedPanel(item, [item, sibling]);
  assert.equal(panel.heading, 'More from this channel');
  // The channel list is about alternatives, so it never lists the video playing.
  assert.deepEqual(panel.entries.map(entry => entry.id), [sibling.id]);
});

const relatedVideo = (id, title, owner = 'channel') => ({
  id, title, facets: {owner: owner ? {id: owner, name: owner} : null},
});
const relatedIds = (item, items, limit) => relatedItems(item, items, limit).map(entry => entry.id);

test('channel videos come first, ranked by title overlap with stable ties', () => {
  const item = relatedVideo('current', 'Blender lighting tutorial');
  const unrelated = relatedVideo('unrelated', 'Garden tour');
  const weak = relatedVideo('weak', 'Blender basics');
  const strong = relatedVideo('strong', 'Blender lighting');
  const tied = relatedVideo('tied', 'Lighting tutorial');
  const outside = relatedVideo('outside', item.title, 'other');
  const items = [unrelated, weak, outside, strong, tied, item];
  assert.deepEqual(relatedIds(item, items), ['strong', 'tied', 'weak', 'unrelated', 'outside']);
  assert.deepEqual(relatedIds(item, items, 2), ['strong', 'tied']);
  assert.deepEqual(items.map(entry => entry.id), ['unrelated', 'weak', 'outside', 'strong', 'tied', 'current']);
});

test('library matches fill spare places in similarity order without unrelated filler', () => {
  const item = relatedVideo('current', 'Blender lighting');
  const sibling = relatedVideo('sibling', 'Garden tour');
  const weak = relatedVideo('weak', 'Blender basics', 'other');
  const strong = relatedVideo('strong', item.title, 'third');
  const unrelated = relatedVideo('unrelated', 'Cooking tips', 'other');
  const items = [weak, unrelated, strong, sibling];
  assert.deepEqual(relatedIds(item, items), ['sibling', 'strong', 'weak']);
  assert.deepEqual(relatedIds(item, items, 2), ['sibling', 'strong']);
  assert.equal(relatedPanel(item, items).heading, 'Related videos');
  const siblings = Array.from({length: 10}, (_, i) => relatedVideo(`s${i}`, 'Garden tour'));
  assert.deepEqual(relatedIds(item, [strong, ...siblings]), siblings.map(entry => entry.id));
  assert.equal(relatedPanel(item, [strong, ...siblings]).heading, 'More from this channel');
});

test('single-video channels and unknown channels use library title matches', () => {
  for (const owner of ['channel', null]) {
    const item = relatedVideo('current', 'Solar panels', owner);
    const match = relatedVideo('match', 'Solar installation', null);
    const unrelated = relatedVideo('unrelated', 'Garden tour', null);
    assert.deepEqual(relatedIds(item, [item, unrelated, match]), ['match']);
    assert.equal(relatedPanel(item, [match]).heading, 'Related videos');
  }
  const item = relatedVideo('current', 'Solar panels');
  const sibling = relatedVideo('sibling', 'Garden tour');
  item.facets.owner = {name: 'Named channel'};
  sibling.facets.owner = {name: 'Named channel'};
  assert.deepEqual(relatedIds(item, [sibling]), ['sibling']);
});

test('title matching normalizes accents and punctuation and compares unique whole words', () => {
  const item = relatedVideo('current', 'The CAFÉ: solar-solar 123');
  const match = relatedVideo('match', 'Cafe / Solar', 'other');
  const repeated = relatedVideo('repeated', 'cafe cafe solar solar', 'other');
  const weak = relatedVideo('weak', 'Solar installation', 'other');
  const stopWords = relatedVideo('stop', 'The 123 and the', 'other');
  const substring = relatedVideo('substring', 'Solaris cafeteria', 'other');
  assert.deepEqual(relatedIds(item, [weak, match, repeated, stopWords, substring]),
    ['match', 'repeated', 'weak']);
  const unicode = relatedVideo('unicode', '日本語 入門');
  assert.deepEqual(relatedIds(unicode, [relatedVideo('match', '日本語 教室', 'other')]), ['match']);
});

test('related videos exclude the current ID and duplicates and respect empty results and limits', () => {
  const item = relatedVideo('current', 'Solar panels');
  const match = relatedVideo('match', 'Solar installation', 'other');
  assert.deepEqual(relatedIds(item, [{...item}, match, {...match}]), ['match']);
  assert.deepEqual(relatedIds(item, [match], 0), []);
  assert.deepEqual(relatedIds(item, [match], -1), []);
  assert.deepEqual(relatedPanel(item, []).entries, []);
  assert.deepEqual(relatedIds(relatedVideo('empty', ''), [match]), []);
  assert.deepEqual(relatedIds(relatedVideo('generic', 'The and 123'), [match]), []);
  assert.deepEqual(relatedIds(item, [relatedVideo('missing', undefined, 'other')]), []);
});

test('the up-next card comes up in the last twenty seconds, or last tenth of a short part', () => {
  assert.equal(announcesNext(570, 600), false);
  assert.equal(announcesNext(580, 600), true);
  assert.equal(announcesNext(50, 60), false);
  assert.equal(announcesNext(54, 60), true);
  assert.equal(announcesNext(10, 0), false);
  assert.equal(announcesNext(NaN, 60), false);
});

test('the playlist markup and controller carry the control and its popup', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const controller = await playerSources();
  for (const hook of ['title', 'note', 'entries']) {
    assert.match(html, new RegExp(`data-playlist-${hook}[\\s=>]`), hook);
  }
  assert.match(controller, /dataset\.playlistOpen/);
  assert.match(html, /data-autoplay-toggle/);
  assert.match(html, /data-subtitle-download/);
  assert.match(controller, /data-part-step/);
  assert.match(html, /id="watch-playlist-popup" class="playlist-popup" popover/);
  assert.match(controller, /playlistNav\(item, getItems\(\)\)/);
});

test('playback settings share a gear menu and speed persists across videos', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const controller = await playerSources();
  const styles = await readStyles();
  assert.match(html, /id="watch-settings-popup"[\s\S]*data-playback-speed/);
  assert.match(html, /data-settings-go="speed"/);
  assert.match(html, /data-settings-page="subtitles"/);
  assert.match(html, /data-subtitle-list/);
  assert.match(html, /data-subtitle-downloads/);
  assert.match(html, /data-autoplay-toggle/);
  assert.match(controller, /dataset\.settingsOpen/);
  assert.match(controller, /PLAYBACK_SPEED_KEY/);
  assert.match(controller, /video\.playbackRate = playbackSpeed/);
  assert.match(controller, /setSubtitleDownloader/);
  assert.match(controller, /barTail\.append\(formatOpen, subtitleToggle, settingsOpen, backgroundButton, fullscreenButton\)/);
  assert.match(styles, /\[data-media-restart\] \{ margin-left: -6px/);
  assert.match(styles, /\.archive-seek-track \{ margin-left: -5px/);
  assert.match(styles, /\[data-media-volume\] \{ margin-left: -5px/);
});

test('the settings pages carry their own controls and keep the ones behind them out of reach', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const controller = await playerSources();
  const styles = await readStyles();
  // Speed is a dial with the usual rates beside it, not a list to open.
  assert.match(html, /<input[^>]+class="settings-speed-slider"[^>]+data-playback-speed/);
  assert.match(html, /data-speed-presets/);
  assert.match(controller, /SPEED_PRESETS = \[0\.5, 1, 1\.5, 2, 3, 4\]/);
  assert.match(controller, /PLAYBACK_SPEEDS = \[[^\]]*, 8\]/);
  assert.match(controller, /chooseSpeed\(PLAYBACK_SPEEDS\[Number\(speedSlider\.value\)\]\)/);
  // A page that has slid out of sight is still in the box, so it is inert.
  assert.match(controller, /page\.inert = page !== activePage/);
  // Nothing downloaded says so rather than offering a chooser of one.
  assert.match(html, /data-subtitle-empty/);
  assert.match(controller, /subtitleEmpty\.hidden = tracks\.length > 0/);
  assert.match(styles, /\.settings-field\[hidden\]/);
  // The panel is taller than a short player, so it scrolls rather than clips.
  assert.match(styles, /\.settings-popup \{[^}]*overflow-y: auto/);
  // Each page's width is the stylesheet's, so the numbers live in one file.
  assert.match(styles, /\.settings-popup\[data-page="subtitles"\] \{ width:/);
  assert.doesNotMatch(controller, /settingsWidths/);
});

test('a phone gets the whole screen for the picture, and cues sized to it', async () => {
  const styles = await readStyles();
  // The stage pulls back out through the gutter the column keeps, so the
  // player meets the screen's edges square rather than inside a rounded frame.
  assert.match(styles, /\.archive-watch-stage \{[^}]*margin-inline: calc\(var\(--page-gutter\) \* -1\)[^}]*border-radius: 0/);
  // A cue is a share of the player, not a fixed size on the page.
  assert.match(styles, /\.archive-watch-stage \.media-player \{[^}]*container-type: inline-size/);
  assert.match(styles, /\.archive-subtitles \{[^}]*font-size: clamp\(\.8rem, 3\.05cqw, 2rem\)/);
});

test('a card grid never asks for more width than it has', async () => {
  const styles = await readStyles();
  // auto-fill holds a track at its minimum even in a narrower container, so
  // every card grid caps that minimum at the width it actually has.
  assert.doesNotMatch(styles, /minmax\((?!min\()[^,)]*var\(--video-card-min\)/);
  for (const grid of ['archive-gallery', 'video-shelf-track']) {
    assert.match(styles, new RegExp(`\\.${grid} \\{[^}]*minmax\\(min\\(var\\(--video-card-min\\), 100%\\), 1fr\\)`));
  }
  // The related row sits in the capped watch column, so its track is fixed
  // per card size rather than following --video-card-min, and is capped too.
  assert.match(styles,
    /\.archive-related-list \{[^}]*--related-card: 380px;[^}]*minmax\(min\(var\(--related-card\), 100%\), 1fr\)/);
  // Its one-row container queries are written out per size, since a query
  // cannot read the custom property: each break is where another track fits,
  // n * width + (n - 1) * 14px of gaps, so they must follow the width.
  const widths = {small: 280, medium: 380, large: 480};
  for (const [size, width] of Object.entries(widths)) {
    if (size !== 'medium') {
      assert.match(styles, new RegExp(
        `body\\[data-card-size="${size}"\\] \\.archive-related-list \\{ --related-card: ${width}px; \\}`));
    }
    const breaks = [...styles.matchAll(new RegExp(
      `@container archive-related ([^{]*)\\{\\s*`
      + `body\\[data-card-size="${size}"\\][^{]*nth-child\\(n \\+ (\\d+)\\)`, 'g'))]
      .map(([, query, shown]) => [query.match(/min-width: (\d+)px/)?.[1], shown])
      .filter(([min]) => min);
    assert.ok(breaks.length >= 3, `${size} has its breaks`);
    for (const [min, shown] of breaks) {
      const tracks = Number(shown) - 1;
      assert.equal(Number(min), tracks * width + (tracks - 1) * 14, `${size}, ${tracks} cards`);
    }
  }
});

test('the download list is the viewer\'s to pick from, and says what is already here', async () => {
  const controller = await playerSources();
  assert.match(controller, /held\.has\(language\)/);
  assert.match(controller, /alreadyHeld \? t\('player.downloaded'\)/);
  assert.match(controller, /row\.disabled = alreadyHeld/);
  assert.match(controller, /fetchSubtitles\(row, language, automatic\)/);
});

test('turning subtitles off redraws the active custom cue immediately', async () => {
  const controller = await playerSources();
  const provider = await readFile('web/media-provider.js', 'utf8');
  assert.match(controller, /dispatchEvent\(new Event\('archive-subtitles-change'\)\)/);
  assert.match(provider, /\['archive-subtitles-change', 'timeupdate', 'seeked', 'playing', 'ratechange'\]/);
  assert.match(provider, /video\.addEventListener\(event, renderCues/);
});

test('the adapter keeps the playlist position out of the shared owner ordinal', () => {
  const item = toMediaItem(playlistRaw('PL1', 2));
  assert.equal(item.facets.ordinal, null);
  assert.deepEqual(item.archive.playlist, {
    id: 'PL1',
    title: 'Blender in 70 minutes',
    index: 2,
    count: 3,
    url: 'https://example.test/playlist',
    uploader: '',
    uploads: false,
  });
  assert.equal(toMediaItem({_key: 'a', title: 'B'}).archive.playlist, null);
});

test('the playlist spec row carries the position when yt-dlp recorded one', () => {
  assert.equal(playlistLabel(toMediaItem(playlistRaw('PL1', 2))),
    'Blender in 70 minutes (2 of 3)');
  const noIndex = toMediaItem({...playlistRaw('PL1', 2), playlist_index: 0, playlist_count: 0});
  assert.equal(playlistLabel(noIndex), 'Blender in 70 minutes');
  assert.equal(playlistLabel(toMediaItem({_key: 'a', title: 'B'})), '');
});

test('the playlist sidecar wins for the playlist, the video for its position', () => {
  const items = [toMediaItem(playlistRaw('PL1', 1)), toMediaItem(playlistRaw('PL1', 2))];
  applyPlaylists(items, [toPlaylist({
    id: 'PL1', title: 'Blender in 70 minutes (complete)', count: 12,
    url: 'https://example.test/canonical', uploader: 'ExplainingComputers',
    description: 'Two parts',
  })]);

  assert.equal(items[0].archive.playlist.title, 'Blender in 70 minutes (complete)');
  assert.equal(items[0].archive.playlist.url, 'https://example.test/canonical');
  // The stale per-video count gives way; the position does not.
  assert.equal(items[0].archive.playlist.count, 12);
  assert.equal(items[0].archive.playlist.index, 1);
  assert.equal(items[1].archive.playlist.index, 2);
  assert.equal(items[0].facets.collections[0].name, 'Blender in 70 minutes (complete)');
  assert.equal(playlistLabel(items[0]), 'Blender in 70 minutes (complete) (1 of 12)');
  // Now that the true size is known, the playlist control says how much is held.
  assert.equal(playlistNav(items[0], items).note, '2 of 12 archived');
});

test('items keep their own playlist data when no sidecar matches', () => {
  const items = [toMediaItem(playlistRaw('PL1', 1)), toMediaItem({_key: 'x', title: 'Loose'})];
  applyPlaylists(items, [toPlaylist({id: 'PL9', title: 'Other', count: 4})]);
  assert.equal(items[0].archive.playlist.title, 'Blender in 70 minutes');
  assert.equal(items[0].archive.playlist.count, 3);
  assert.equal(items[1].archive.playlist, null);
});

test('the gallery asks for playlists alongside items, and survives losing them', async () => {
  const gallery = await gallerySources();
  assert.match(gallery, /request\('\/api\/playlists'\)\.catch\(\(\) => \[\]\)/);
  assert.match(gallery, /applyPlaylists\(/);
});

test('a gallery view is a playlist view only when everything in it is one playlist', () => {
  const inPlaylist = [toMediaItem(playlistRaw('PL1', 2)), toMediaItem(playlistRaw('PL1', 1))];
  const loose = toMediaItem({_key: 'x', title: 'Loose'});

  assert.equal(playlistViewOf(inPlaylist).id, 'PL1');
  assert.equal(playlistViewOf([...inPlaylist, loose]), null);
  assert.equal(playlistViewOf([...inPlaylist, toMediaItem(playlistRaw('PL2', 1))]), null);
  // One video has no order to show, and neither has a view of none.
  assert.equal(playlistViewOf([inPlaylist[0]]), null);
  assert.equal(playlistViewOf([]), null);
  assert.equal(playlistViewOf([loose, loose]), null);
});

test('playlist order is the position, and leaves the caller\'s array alone', () => {
  const items = [toMediaItem(playlistRaw('PL1', 3)), toMediaItem(playlistRaw('PL1', 1)),
    toMediaItem(playlistRaw('PL1', 2))];
  assert.deepEqual(inPlaylistOrder(items).map(entry => entry.archive.playlist.index), [1, 2, 3]);
  assert.deepEqual(items.map(entry => entry.archive.playlist.index), [3, 1, 2]);
});

// The Revox series as YouTube hands it back: position 1 is the newest video,
// and its first part is the one nobody numbered, being no series yet.
const backwardsRaw = (index, uploadDate) => ({
  ...playlistRaw('PL1', index), _key: `r${index}`, upload_date: uploadDate,
});
const backwardsSeries = () => [
  toMediaItem(backwardsRaw(1, '20251015')),
  toMediaItem(backwardsRaw(2, '20250919')),
  toMediaItem(backwardsRaw(3, '20250813')),
];

test('a playlist whose positions run backwards through time is spotted', () => {
  assert.equal(runsBackwards(backwardsSeries()), true);
  const forwards = [toMediaItem(backwardsRaw(1, '20250813')),
    toMediaItem(backwardsRaw(2, '20250919'))];
  assert.equal(runsBackwards(forwards), false);
  // Gathered rather than published in order: no direction to read, so no flip.
  assert.equal(runsBackwards([toMediaItem(backwardsRaw(1, '20250919')),
    toMediaItem(backwardsRaw(2, '20251015')),
    toMediaItem(backwardsRaw(3, '20250813'))]), false);
  // One video is no sequence, and neither is one with a date.
  assert.equal(runsBackwards([toMediaItem(backwardsRaw(1, '20251015'))]), false);
  assert.equal(runsBackwards([]), false);
});

test('a backwards playlist plays from its first part, unnumbered or not', () => {
  const items = markPlaylistDirection(backwardsSeries());
  assert.equal(isReversed(items), true);
  assert.deepEqual(inPlaylistOrder(items).map(entry => entry.archive.playlist.index), [3, 2, 1]);
  // Autoplay steps the same way, the whole point of settling it on the items.
  const ordered = inPlaylistOrder(items);
  assert.equal(playlistNav(ordered[0], items).next.id, ordered[1].id);
  assert.equal(playlistNav(ordered[0], items).previous, null);
});

test('a saved order is the viewer\'s, and outranks what the dates suggest', () => {
  assert.equal(isReversed(markPlaylistDirection(backwardsSeries(), {PL1: 'forward'})), false);
  const forwards = [toMediaItem(backwardsRaw(1, '20250813')),
    toMediaItem(backwardsRaw(2, '20250919'))];
  assert.equal(isReversed(markPlaylistDirection(forwards, {PL1: 'reverse'})), true);
  // Cleared, it is the dates' call again.
  assert.equal(isReversed(markPlaylistDirection(backwardsSeries(), {})), true);
});

test('a video with no position trails the run rather than leading a reversed one', () => {
  const items = markPlaylistDirection([...backwardsSeries(),
    toMediaItem({...backwardsRaw(0, '20250101'), playlist_index: 0})]);
  assert.deepEqual(inPlaylistOrder(items).map(entry => entry.archive.playlist.index),
    [3, 2, 1, 0]);
});

test('turning a playlist round is the sort control\'s arrow, and the popup\'s', async () => {
  const gallery = await gallerySources();
  // Pressing the playlist's own sort again reverses it, as the other sorts do,
  // rather than flipping a direction this view would forget.
  assert.match(gallery, /if \(button\.pressed && button\.mode === 'playlist'\)/);
  assert.match(gallery, /togglePlaylistDirection\(String\(view\.id\), isReversed\(shown\)\)/);
  assert.match(gallery, /drawSort\(Boolean\(playlist\), isReversed\(shown\)\)/);
  const player = await readFile('web/player-controller.js', 'utf8');
  assert.match(player, /\[data-playlist-reverse\]/);
  assert.match(player, /setPlaylistDirectionToggle/);
  const markup = await readFile('web/index.html', 'utf8');
  assert.match(markup, /data-playlist-reverse/);
});

test('the gallery orders a single-playlist view by position, unless a sort is chosen', async () => {
  const gallery = await gallerySources();
  // Which order a view starts in is effectiveSort's, tested in gallery-heading.
  assert.match(gallery, /asTracks \? 'playlist' : effectiveSort\(sort, \{playlist: Boolean\(playlist\)\}\)/);
  assert.match(gallery, /mode === 'playlist' \? inPlaylistOrder\(matched\)/);
});

test('SponsorBlock segments become labelled stretches of the bar', () => {
  assert.deepEqual(sponsorSegments([
    {category: 'sponsor', start: 10, end: 30},
    {category: 'unknown', start: 40, end: 50},
    {category: 'outro', start: 90, end: 120},
    {category: 'intro', start: 5, end: 5},
  ], 100), [
    {category: 'sponsor', label: 'Sponsor', start: 10, end: 30, left: 10, width: 20},
    {category: 'outro', label: 'Endcards', start: 90, end: 100, left: 90, width: 10},
  ]);
  assert.deepEqual(sponsorSegments([{category: 'sponsor', start: 1, end: 2}], 0), []);
  assert.deepEqual(sponsorSegments(null, 100), []);
});

test('the autoplay countdown runs over the last seconds of a part and just past its end', () => {
  assert.equal(countdownAt(590, 600), null);
  assert.deepEqual(countdownAt(595, 600), {elapsed: 2, total: 8});
  // At the end the part's share is used up, leaving the tail to run.
  assert.deepEqual(countdownAt(600, 600), {elapsed: 7, total: 8});
  // A one-minute clip counts down over its last tenth.
  assert.deepEqual(countdownAt(57, 60), {elapsed: 3, total: 7});
  assert.equal(countdownAt(NaN, 60), null);
});

test('the playlist row says where it links, as the title line does for the channel', () => {
  const item = toMediaItem({_key: 'a', title: 'T', channel: 'Chan', channel_id: 'UC1',
    playlist: 'Series', playlist_id: 'PL1', playlist_title: 'Series'});
  assert.deepEqual(watchLinks(item), {
    channel: {id: 'UC1', name: 'Chan'},
    playlist: {id: 'PL1', name: 'Series'},
  });
  const links = Object.fromEntries(specsOf(item, format).map(row => [row.label, row.link]));
  // The channel links from the line under the title, not from a row.
  assert.equal('Channel' in links, false);
  assert.equal(links.Playlist, 'playlist');
  assert.equal(links.File, undefined);
  assert.deepEqual(watchLinks(toMediaItem({_key: 'b', title: 'Bare'})), {channel: null, playlist: null});
});

test('autoplay preserves hidden arrows before the player reveals controls at end', async () => {
  const source = await readFile('web/player-playlist.js', 'utf8');
  const start = source.indexOf('  // Capture the hidden state before');
  const end = source.indexOf('  const drawAutoplay', start);
  const register = new Function('mediaPlayer', 'element', 'autoplay', 'nav', 'upNextDismissed',
    source.slice(start, end));
  function setup({ended = true, autoplay = true, next = true, dismissed = false, hidden = true} = {}) {
    const classes = new Set(hidden ? ['is-controls-hidden'] : []);
    const interactions = new Map();
    let pause;
    const element = {
      classList: {contains: name => classes.has(name), add: name => classes.add(name),
        remove: name => classes.delete(name)},
      addEventListener: (type, handler) => interactions.set(type, handler),
    };
    const video = {ended, addEventListener(type, handler, options) {
      assert.equal(type, 'pause');
      assert.equal(options.capture, true);
      pause = handler;
    }};
    register({video}, element, autoplay, next ? {next: {id: 'next'}} : null, dismissed);
    pause(); // Capture phase precedes the shared player's normal pause listener.
    classes.delete('is-controls-hidden'); // keepControlsVisible()
    return {classes, interactions};
  }
  const state = setup();
  assert.ok(state.classes.has('is-autoplay-ending'));
  for (const type of ['pointermove', 'pointerdown', 'focusin', 'keydown']) {
    const state = setup();
    state.interactions.get(type)();
    assert.ok(!state.classes.has('is-autoplay-ending'));
  }
  for (const options of [{ended: false}, {autoplay: false}, {next: false}, {dismissed: true}, {hidden: false}]) {
    assert.ok(!setup(options).classes.has('is-autoplay-ending'));
  }
  const styles = await readStyles();
  assert.ok(styles.includes('.media-player:is([data-player-state="playing"].is-controls-hidden, .is-autoplay-ending) .archive-part-step'));
  assert.ok(styles.includes('.media-player:is([data-player-state="playing"].is-controls-hidden, .is-autoplay-ending) .archive-part-side.is-announcing .archive-part-card'));
});

test('the final pause and ended sequence updates the autoplay countdown only once', async () => {
  const source = await readFile('web/player-playlist.js', 'utf8');
  const start = source.indexOf("  mediaPlayer.video.addEventListener('ended', () => {");
  const end = source.indexOf("  autoplayToggle.addEventListener('click'", start);
  const register = new Function('mediaPlayer', 'nav', 'upNextDismissed', 'announceNext',
    'syncCountdown', 'stopCountdown', 'nextSide', 'inAudioBar', 'advanceMini', 'repeat', 'audioStep',
    source.slice(start, end));
  const handlers = new Map();
  const video = {ended: true, addEventListener: (type, handler) => handlers.set(type, handler)};
  let updates = 0;
  let stops = 0;
  register({video}, {next: {id: 'next'}}, false, () => {}, () => updates++, () => stops++,
    {classList: {contains: () => true}}, () => false, () => {}, 'off', () => null);
  handlers.get('pause')();
  assert.equal(updates, 0);
  handlers.get('ended')();
  assert.equal(updates, 1);
  assert.equal(stops, 0);
  // An ordinary pause still synchronises and holds the animation.
  video.ended = false;
  handlers.get('pause')();
  assert.equal(updates, 2);
});

test('an album in the audio bar plays straight on, with no up-next countdown', async () => {
  const source = await readFile('web/player-playlist.js', 'utf8');
  const start = source.indexOf("  mediaPlayer.video.addEventListener('ended', () => {");
  const end = source.indexOf("  autoplayToggle.addEventListener('click'", start);
  const register = new Function('mediaPlayer', 'nav', 'upNextDismissed', 'announceNext',
    'syncCountdown', 'stopCountdown', 'nextSide', 'inAudioBar', 'advanceMini', 'repeat', 'audioStep',
    source.slice(start, end));
  const handlers = new Map();
  const video = {ended: true, addEventListener: (type, handler) => handlers.set(type, handler)};
  let updates = 0;
  const advanced = [];
  register({video}, {next: {id: 'next'}}, false, () => {}, () => updates++, () => {},
    {classList: {contains: () => false}}, () => true, entry => advanced.push(entry.id),
    'off', () => ({id: 'next'}));
  handlers.get('ended')();
  assert.deepEqual(advanced, ['next']);
  assert.equal(updates, 0);
});

test('autoplay tail continues from the rendered bar position without a time-based snap', async () => {
  const source = await readFile('web/player-playlist.js', 'utf8');
  const start = source.indexOf('  function syncCountdown() {');
  const end = source.indexOf('  function stopCountdown() {', start);
  const properties = new Map();
  let timerDelay;
  let restarts = 0;
  const run = new Function('countdownAt', 'getComputedStyle', 'DOMMatrixReadOnly', 'setTimeout', `
    const mediaPlayer = {video: {ended: true, paused: true, currentTime: 600, duration: 600}};
    const autoplay = true, nav = {next: {id: 'next'}}, upNextDismissed = false;
    const element = {}, nextKicker = {};
    // The controller words the kicker through the catalogue; this slice only needs it callable.
    const t = key => key;
    let countdownTimer = null;
    const stopCountdown = () => {}, playFromControl = () => {};
    const nextSide = arguments[4];
    ${source.slice(start, end)}
    syncCountdown();
    syncCountdown();
  `);
  run(countdownAt, () => ({transform: 'matrix(0.91, 0, 0, 1, 0, 0)'}),
    class { constructor() { this.a = 0.91; } },
    (_, delay) => { timerDelay = delay; return 123; }, {
      querySelector: () => ({}),
      style: {setProperty: (key, value) => properties.set(key, value)},
      classList: {remove: () => restarts++, add: () => {}},
      offsetWidth: 340,
    });
  assert.equal(properties.get('--countdown-from'), '0.91');
  assert.equal(properties.get('--countdown-delay'), '0s');
  assert.equal(properties.get('--countdown'), '1s');
  assert.equal(timerDelay, 1000);
  assert.equal(restarts, 1);
});

test('specs show when the metadata was last refreshed, and nothing before it was', () => {
  const raw = {id: 'a', title: 'T', webpage_url: 'https://example.test/a', extractor: 'youtube'};
  const plain = specsOf(toMediaItem(raw), {}).map(row => row.label);
  assert.equal(plain.includes('Refreshed'), false);
  const refreshed = specsOf(toMediaItem({...raw, _reruns_refreshed: Date.UTC(2026, 9, 7) / 1000}), {});
  assert.deepEqual(refreshed.find(row => row.label === 'Refreshed')?.value, '7 October 2026');
});

test('the file details sit in a card of their own beside the description, which is plain', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const lower = html.match(/<div class="archive-watch-lower">[\s\S]*?<section class="archive-watch-comments"/)?.[0] || '';
  const facts = lower.match(/<section class="archive-watch-facts"[\s\S]*?<\/section>/)?.[0] || '';
  const story = lower.match(/<section class="archive-watch-story"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(facts, /data-watch-specs/);
  assert.match(story, /data-watch-description[\s>]/);
  // The two used to take turns in one card behind a pair of tabs.
  assert.doesNotMatch(html, /data-watch-about/);
});

// These integration checks span the feature modules composed by each controller.
async function playerSources() {
  const modules = ['controller', 'speed', 'tracks', 'timeline', 'playlist', 'watch'];
  return (await Promise.all(modules.map(name => readFile(`web/player-${name}.js`, 'utf8')))).join('\n');
}
async function gallerySources() {
  const modules = ['controller', 'loader', 'actions'];
  return (await Promise.all(modules.map(name => readFile(`web/gallery-${name}.js`, 'utf8')))).join('\n');
}
