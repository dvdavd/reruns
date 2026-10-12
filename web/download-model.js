import {plural, t} from './i18n.js';
export const ACTIVE_STATES = new Set(['queued', 'inspecting', 'running', 'postprocessing', 'saving', 'discarding']);

// Seed from history on the first poll, then report each new failure once.
// Remember states rather than IDs so a resumed job can fail again.
export function createJobFailureTracker() {
  let previous = null;
  return jobs => {
    const failures = previous === null ? [] : jobs.filter(job =>
      job.state === 'failed' && previous.get(job.id) !== 'failed');
    previous = new Map(jobs.map(job => [job.id, job.state]));
    return failures;
  };
}

const STATE_LABELS = new Set(['queued', 'inspecting', 'running', 'postprocessing', 'saving', 'discarding',
  'done', 'failed', 'cancelled', 'paused']);
const STATE_ORDER = ['running', 'saving', 'discarding', 'postprocessing', 'inspecting', 'queued', 'paused',
  'failed', 'cancelled', 'done'];

export function stateLabel(state) {
  return STATE_LABELS.has(state) ? t(`downloads.state.${state}`) : state;
}

export function partitionJobs(jobs) {
  return {
    active: jobs.filter(job => ACTIVE_STATES.has(job.state)),
    finished: jobs.filter(job => !ACTIVE_STATES.has(job.state)),
  };
}

/* What a batch's controls offer. yt-dlp runs a batch as one process, so pause
   and cancel act on the whole batch and sit on its current video only. */
function batchActions(job, live = false) {
  const remaining = (job.items || []).filter(item =>
    ACTIVE_STATES.has(item.state) || item.state === 'paused').length;
  if (ACTIVE_STATES.has(job.state)) {
    if (live) return job.state === 'running'
      ? {pause: false, resume: false, stopSave: true, discard: true, remaining} : null;
    return {pause: true, resume: false, remaining};
  }
  if (job.state === 'failed' && job.kind !== 'refresh') return {retry: true, remaining};
  if (job.state === 'paused') return {pause: false, resume: true, remaining};
  return null;
}

/* One download is one video, so that is one row. A job that has not been
   inspected yet has no videos, and stands in for itself until it does. */
export function flattenDownloads(jobs) {
  const rows = [];
  for (const job of jobs) {
    if (!job.items || !job.items.length) {
      rows.push(jobRow(job));
      continue;
    }
    let actions = batchActions(job);
    for (const item of job.items) {
      const pending = ACTIVE_STATES.has(item.state) || item.state === 'paused'
        || (job.state === 'failed' && item.state === 'failed');
      const itemActions = item.live ? batchActions(job, true) : actions;
      rows.push({...itemRow(item, job), actions: itemActions && pending ? itemActions : null});
      if (pending) actions = null;
    }
  }
  return rows.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
}

function jobRow(job) {
  return {
    key: job.id, jobId: job.id, state: job.state, title: job.title || sourceName(job.url),
    source: job.url, pendingMetadata: true, settings: pendingSettings(job.options),
    percent: null, indeterminate: ACTIVE_STATES.has(job.state),
    detail: job.error || (job.state === 'running' ? t('downloads.fetching')
      : job.state === 'queued' ? t('downloads.waiting') : stateLabel(job.state)),
    error: Boolean(job.error), actions: batchActions(job),
    channel: job.channel || '', channelId: '', thumbnail: job.thumbnail || '',
    duration: '',
  };
}

function pendingSettings(options) {
  if (!options) return '';
  const audio = options.media === 'audio';
  const media = t(audio ? 'profiles.media.audio' : 'profiles.media.video');
  const quality = !audio && options.quality
    ? options.quality === 'best' ? t('profiles.bestQuality') : `${options.quality}p` : '';
  const container = options.container && options.container !== 'auto'
    ? options.container.toUpperCase() : '';
  return [media, quality, container, options.playlist === 'single' ? t('profiles.singleVideo') : '']
    .filter(Boolean).join(' · ');
}

function itemRow(item, job) {
  const transfer = activeTransfer(item);
  const indeterminate = item.state === 'postprocessing' || Boolean(item.state === 'running'
    && (item.live || (transfer && (transfer.live || transfer.indeterminate))));
  const percent = itemPercent(item, indeterminate);
  return {
    key: `${job.id}:${item.id}`, jobId: job.id, state: item.state,
    title: playlistPosition(item) + item.title, source: job.url,
    percent, indeterminate, detail: itemDetail(item, percent, indeterminate), error: Boolean(item.error),
    channel: item.channel || job.channel || '', channelId: item.channelId || '',
    thumbnail: item.thumbnail || '', duration: formatDuration(item.duration),
    extractor: item.extractor || '', videoId: item.videoId || '',
  };
}

// The filename repeats the title, so a finished row says only what kind of file
// it is: the media's extensions, leaving out subtitles and pictures saved beside.
const SIDE_FILES = new Set(['vtt', 'srt', 'ass', 'ttml', 'srv3', 'json', 'jpg', 'jpeg', 'png', 'webp', 'description']);
function doneFormats(files = []) {
  const kinds = files.map(name => name.split('.').pop().toLowerCase())
    .filter(kind => kind && !SIDE_FILES.has(kind));
  return [...new Set(kinds)].map(kind => kind.toUpperCase()).join(' · ');
}

function itemDetail(item, percent, indeterminate) {
  if (item.error) return item.error;
  if (item.state === 'done') return doneFormats(item.files) || stateLabel(item.state);
  if (!ACTIVE_STATES.has(item.state)) return stateLabel(item.state);
  const transfer = activeTransfer(item);
  return [indeterminate && item.state === 'running' ? t('downloads.live') : stateLabel(item.state),
    percent === null ? '' : `${Math.round(percent)}%`,
    transfer && transfer.speed, transfer && transfer.eta && t('downloads.left', {eta: transfer.eta})]
    .filter(Boolean).join(' · ');
}

/* yt-dlp fetches video and audio as separate transfers, so the item's own
   progress is how far through all of them it is. */
function itemPercent(item, indeterminate = false) {
  if (item.state === 'done') return 100;
  if (indeterminate) return null;
  const transfers = item.transfers || [];
  if (!transfers.length) return ACTIVE_STATES.has(item.state) ? 0 : null;
  const total = transfers.reduce((sum, transfer) => sum + (transfer.percent || 0), 0);
  return total / transfers.length;
}

function activeTransfer(item) {
  const transfers = item.transfers || [];
  return [...transfers].reverse().find(transfer => transfer.state === 'running')
    || transfers.at(-1) || null;
}

function playlistPosition(item) {
  return item.playlistIndex && item.playlistCount
    ? `${item.playlistIndex}/${item.playlistCount} · ` : '';
}

export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !(seconds > 0)) return '';
  const total = Math.round(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const pad = value => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function sourceName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return url; }
}

/* What the topbar button says: how many downloads are left, and how far the
   one in flight has got. */
export function queueStatus(rows) {
  const remaining = rows.filter(row => ACTIVE_STATES.has(row.state));
  const current = remaining.find(row => row.state === 'running' || row.state === 'postprocessing');
  const paused = rows.filter(row => row.state === 'paused').length;
  const finished = rows.length - remaining.length - paused;
  const parts = [
    remaining.length && plural('count.downloadsRemaining', remaining.length),
    paused && t('downloads.paused', {count: paused}),
  ].filter(Boolean);
  return {
    remaining: remaining.length,
    percent: current && current.percent !== null ? current.percent : null,
    summary: parts.length ? parts.join(' · ') : finished ? t('downloads.finished', {count: finished}) : t('downloads.nothing'),
  };
}

/* Whether the topbar field is on its way to a link: from its first letter,
   while it could still become http:// or https://, and ever after that. A
   search that merely begins with h, like "hello", parts ways at once. */
export function startsLikeUrl(value) {
  const text = String(value || '').trimStart().toLowerCase();
  if (!text) return false;
  return 'https://'.startsWith(text) || 'http://'.startsWith(text) || /^https?:\/\//.test(text);
}

/* Whether the topbar field holds a link to download rather than a search: one
   http(s) address with a host and nothing else around it. */
export function isDownloadUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return false;
  try { return new URL(text).hostname.includes('.'); } catch (_) { return false; }
}
