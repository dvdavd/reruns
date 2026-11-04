import assert from 'node:assert/strict';
import test from 'node:test';
import {ACTIVE_STATES, createJobFailureTracker, flattenDownloads, formatDuration, formatLine, formatNotes,
  partitionJobs, queueStatus} from '../web/download-model.js';

test('job failures notify once, including fast jobs and failures after resuming', () => {
  const failures = createJobFailureTracker();
  const old = {id: 'old', state: 'failed'};
  const subtitle = {id: 'subtitles', state: 'running', kind: 'subtitles'};
  assert.deepEqual(failures([old, subtitle]), []);
  const failed = {...subtitle, state: 'failed', error: 'HTTP Error 429: Too Many Requests'};
  assert.deepEqual(failures([old, failed]), [failed]);
  assert.deepEqual(failures([old, failed]), []);
  const fast = {id: 'fast', state: 'failed'};
  assert.deepEqual(failures([old, failed, fast]), [fast]);
  assert.deepEqual(failures([old, subtitle, fast]), []);
  assert.deepEqual(failures([old, failed, fast]), [failed]);
  assert.deepEqual(failures([{id: 'cancelled', state: 'cancelled'}]), []);
});

test('partitions every active lifecycle state from history', () => {
  const jobs = ['queued', 'inspecting', 'running', 'postprocessing', 'saving', 'discarding',
    'done', 'failed', 'cancelled'].map((state, id) => ({id, state}));
  const result = partitionJobs(jobs);

  assert.deepEqual(result.active.map(job => job.state), [...ACTIVE_STATES]);
  assert.deepEqual(result.finished.map(job => job.state), ['done', 'failed', 'cancelled']);
});

test('flattens a batch into one row per video, in progress order', () => {
  const jobs = [{
    id: 'j1', url: 'https://www.youtube.com/playlist?list=x', state: 'running',
    items: [
      {id: 'a', title: 'First', state: 'done', files: ['First.mp4'], error: '',
        playlistIndex: 1, playlistCount: 3, transfers: []},
      {id: 'b', title: 'Second', state: 'running', files: [], error: '',
        playlistIndex: 2, playlistCount: 3,
        transfers: [{state: 'done', percent: 100}, {state: 'running', percent: 50, speed: '3MiB/s', eta: '00:20'}]},
      {id: 'c', title: 'Third', state: 'queued', files: [], error: '',
        playlistIndex: 3, playlistCount: 3, transfers: []},
    ],
  }];

  const rows = flattenDownloads(jobs);

  assert.deepEqual(rows.map(row => row.title),
    ['2/3 · Second', '3/3 · Third', '1/3 · First']);
  assert.equal(rows[0].percent, 75);
  assert.equal(rows[0].detail, 'Downloading · 75% · 3MiB/s · 00:20 left');
  assert.equal(rows[2].detail, 'MP4');
});

test('the detail follows the newest media format transfer', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'a', title: 'Clip', state: 'running', files: [], error: '', transfers: [
      {state: 'running', percent: 100, speed: '4MiB/s'},
      {state: 'running', percent: 30, speed: '1MiB/s', eta: '00:12'},
    ]},
  ]}]);

  assert.equal(row.detail, 'Downloading · 65% · 1MiB/s · 00:12 left');
});

test('only the leading pending video of a batch carries its controls', () => {
  const jobs = [{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'a', title: 'A', state: 'running', files: [], error: '', transfers: []},
    {id: 'b', title: 'B', state: 'queued', files: [], error: '', transfers: []},
  ]}];

  assert.deepEqual(flattenDownloads(jobs).map(row => row.actions),
    [{pause: true, resume: false, remaining: 2}, null]);

  jobs[0].state = 'paused';
  jobs[0].items.forEach(item => { item.state = 'paused'; });
  assert.deepEqual(flattenDownloads(jobs).map(row => [row.state, row.actions && row.actions.resume]),
    [['paused', true], ['paused', null]]);
});

test('an uninspected job stands in for itself with its source name', () => {
  const rows = flattenDownloads([
    {id: 'j1', url: 'https://www.youtube.com/watch?v=x', state: 'inspecting', items: [],
      options: {media: 'video', quality: '1080', container: 'mp4', playlist: 'single'}}]);

  assert.deepEqual(rows, [{key: 'j1', jobId: 'j1', state: 'inspecting',
    title: 'youtube.com', source: 'https://www.youtube.com/watch?v=x', percent: null,
    pendingMetadata: true, settings: 'Video · 1080p · MP4 · Single video',
    indeterminate: true, detail: 'Reading playlist', error: false,
    actions: {pause: true, resume: false, remaining: 0},
    channel: '', channelId: '', thumbnail: '', duration: ''}]);
});

test('a new video shows its request while metadata is being fetched', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'https://youtu.be/x', state: 'running',
    items: [], options: {media: 'audio', container: 'mp3'}}]);

  assert.equal(row.detail, 'Fetching video details');
  assert.equal(row.settings, 'Audio · MP3');
  assert.equal(row.indeterminate, true);
  assert.equal(row.percent, null);
});

test('the queue counts remaining videos and tracks the one in flight', () => {
  const rows = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'a', title: 'A', state: 'done', files: [], error: '', transfers: []},
    {id: 'b', title: 'B', state: 'running', files: [], error: '',
      transfers: [{state: 'running', percent: 40}]},
    {id: 'c', title: 'C', state: 'queued', files: [], error: '', transfers: []},
  ]}]);

  assert.deepEqual(queueStatus(rows),
    {remaining: 2, percent: 40, summary: '2 downloads remaining'});
  assert.deepEqual(queueStatus(rows.filter(row => row.state === 'done')),
    {remaining: 0, percent: null, summary: '1 finished'});
  assert.equal(queueStatus([]).summary, 'Nothing queued');
});

test('a live transfer has an indeterminate row rather than a misleading zero percent', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'live', title: 'Live now', state: 'running', files: [], error: '',
      transfers: [{state: 'running', percent: 0, live: true, speed: '2MiB/s'}]},
  ]}]);

  assert.equal(row.percent, null);
  assert.equal(row.indeterminate, true);
  assert.equal(row.detail, 'Downloading live · 2MiB/s');
});

test('a live item is indeterminate before the downloader emits byte progress', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'live', title: 'Live now', state: 'running', live: true, files: [], error: '', transfers: []},
  ]}]);

  assert.equal(row.percent, null);
  assert.equal(row.indeterminate, true);
  assert.equal(row.detail, 'Downloading live');
});

test('a live recording offers save or discard instead of pause and resume', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'live', title: 'Live now', state: 'running', live: true, files: [], error: '', transfers: []},
  ]}]);

  assert.deepEqual(row.actions,
    {pause: false, resume: false, stopSave: true, discard: true, cancelAll: false, remaining: 1});
});

test('a recording in a batch can be stopped alone, or the whole batch cancelled', () => {
  const rows = flattenDownloads([{id: 'j1', url: 'u', state: 'postprocessing', items: [
    {id: 'live', title: 'Live now', state: 'running', live: true, files: [], error: '', transfers: []},
    {id: 'next', title: 'Next', state: 'queued', files: [], error: '', transfers: []},
  ]}]);
  const live = rows.find(row => row.key === 'j1:live');
  const next = rows.find(row => row.key === 'j1:next');

  assert.deepEqual(live.actions,
    {pause: false, resume: false, stopSave: true, discard: true, cancelAll: true, remaining: 2});
  assert.equal(next.actions, null);
});

test('a recording being saved has no controls, and the batch\'s pass to the next video', () => {
  const rows = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'live', title: 'Live now', state: 'saving', live: true, files: [], error: '', transfers: []},
    {id: 'next', title: 'Next', state: 'queued', files: [], error: '', transfers: []},
  ]}]);

  assert.equal(rows.find(row => row.key === 'j1:live').actions, null);
  assert.deepEqual(rows.find(row => row.key === 'j1:next').actions,
    {pause: true, resume: false, remaining: 2});
});

test('post-processing is indeterminate instead of appearing stuck at 100 percent', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'postprocessing', items: [
    {id: 'video', title: 'Video', state: 'postprocessing', files: [], error: '',
      transfers: [{state: 'done', percent: 100}]},
  ]}]);

  assert.equal(row.percent, null);
  assert.equal(row.indeterminate, true);
  assert.equal(row.detail, 'Finishing up');
});

test('an unknown-length transfer is indeterminate when extractor metadata is absent', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'running', items: [
    {id: 'stream', title: 'Stream', state: 'running', files: [], error: '',
      transfers: [{state: 'running', percent: 0, indeterminate: true}]},
  ]}]);

  assert.equal(row.percent, null);
  assert.equal(row.indeterminate, true);
});

test('rows carry the channel, thumbnail and length read before downloading', () => {
  const [row] = flattenDownloads([{id: 'j1', url: 'u', state: 'queued', channel: 'List owner',
    items: [{id: 'a', title: 'A', state: 'queued', files: [], error: '', transfers: [],
      channel: 'Creator', channelId: 'UC1', thumbnail: 'https://i/a.jpg', duration: 3725}]}]);

  assert.equal(row.channel, 'Creator');
  assert.equal(row.channelId, 'UC1');
  assert.equal(row.thumbnail, 'https://i/a.jpg');
  assert.equal(row.duration, '1:02:05');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(null), '');
});

test('tells a pasted link from a search', async () => {
  const {isDownloadUrl} = await import('../web/download-model.js');
  assert.ok(isDownloadUrl('https://www.youtube.com/watch?v=abc'));
  assert.ok(isDownloadUrl('  http://youtu.be/abc  '));
  assert.ok(!isDownloadUrl('youtube.com/watch?v=abc'));
  assert.ok(!isDownloadUrl('https://example.com and more'));
  assert.ok(!isDownloadUrl('https://localhost'));
  assert.ok(!isDownloadUrl('cats'));
});

test('a half-typed link is already not a search', async () => {
  const {isDownloadUrl, startsLikeUrl} = await import('../web/download-model.js');
  for (const value of ['h', 'ht', 'htt', 'http', 'https', 'http:', 'https:', 'https:/', 'https://', 'https://test', ' HTTP://test.com']) assert.ok(startsLikeUrl(value));
  assert.ok(!isDownloadUrl('https://test'));
  assert.ok(!startsLikeUrl('hello'));
  assert.ok(!startsLikeUrl('httpx'));
  assert.ok(!startsLikeUrl(''));
  assert.ok(!startsLikeUrl('cats https://x.com'));
});

test('failed batches offer retry once on the first failed video', () => {
  const rows = flattenDownloads([{id: 'retry', state: 'failed', kind: 'download', items: [
    {id: 'saved', state: 'done', title: 'Saved'},
    {id: 'failed', state: 'failed', title: 'Failed'},
    {id: 'failed2', state: 'failed', title: 'Failed again'},
  ]}]);
  assert.equal(rows.filter(row => row.actions?.retry).length, 1);
  assert.equal(rows.find(row => row.actions?.retry).title, 'Failed');
});

test('a row says which format was fetched, and where it fell short', () => {
  const format = {id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, fps: 30,
    warnings: [{level: 'warning', code: 'smaller', got: 360, available: 1080},
      {level: 'note', code: 'codecLimit', wanted: 'H.264', got: 1080, available: 2160}]};
  const [row] = flattenDownloads([{id: 'j', url: 'u', state: 'running', items: [
    {id: 'i', title: 'Clip', state: 'running', transfers: [], format}]}]);
  assert.equal(row.format, '360p · H.264 · AAC');
  assert.deepEqual(row.formatNotes.map(note => note.level), ['warning', 'note']);
  assert.match(row.formatNotes[0].text, /360p.*1080p/);
  assert.equal(formatLine({height: 1080, fps: 60, vcodec: 'vp09.00.40.08', acodec: 'opus'}), '1080p60 · VP9 · Opus');
  assert.equal(formatLine({vcodec: '', acodec: 'mp4a.40.2'}), 'AAC');
  assert.equal(formatLine(null), '');
  assert.deepEqual(formatNotes(undefined), []);
});
