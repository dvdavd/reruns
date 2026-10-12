import {html, render} from 'media-ui';
import {post, request} from './api.js';
import {createDrawerControls} from './drawer.js';
import {locale, plural, t} from './i18n.js';

// Often enough that a download reads as it happens; only while the drawer is
// open, since nothing else on the page shows the log.
const POLL_MS = 2000;
// The server keeps as many; holding more here would only outlive its copy.
const LIMIT = 1000;

// Words for these come from the catalogue; the names of other programs are left as they are.
const SOURCES = new Set(['download', 'subtitles', 'subscription', 'portrait', 'preview', 'probe', 'server']);
const PROGRAMS = {sponsorblock: 'SponsorBlock', 'yt-dlp': 'yt-dlp'};
// The filter names the kinds of work a person asks after; the rest share one choice.
const FILTERED = new Set(['download', 'subtitles', 'subscription', 'portrait']);
const LEVELS = {problems: new Set(['warning', 'error', 'critical']), errors: new Set(['error', 'critical'])};

export const sourceLabel = source => SOURCES.has(source) ? t(`activity.source.${source}`) : PROGRAMS[source] || source;

/** What the page holds after one poll. A different boot means the server
    restarted and numbered from one again, so what it sent replaces the lot. */
export function mergeActivity(held, payload, limit = LIMIT) {
  const entries = held.boot === payload.boot ? [...held.entries, ...payload.entries] : payload.entries;
  return {boot: payload.boot, latest: payload.latest, entries: entries.slice(-limit)};
}

export function filterActivity(entries, {source = 'all', level = 'all'} = {}) {
  return entries.filter(entry => (source === 'all'
    || (source === 'other' ? !FILTERED.has(entry.source) : entry.source === source))
    && (level === 'all' || LEVELS[level].has(entry.level)));
}


export function activitySummary(entries) {
  if (!entries.length) return t('activity.none');
  const errors = entries.filter(entry => LEVELS.errors.has(entry.level)).length;
  const warnings = entries.filter(entry => entry.level === 'warning').length;
  return [plural('count.entries', entries.length),
    errors && plural('count.errors', errors), warnings && plural('count.warnings', warnings)]
    .filter(Boolean).join(' · ');
}

// The words a log is written in, as they were before there was a choice.
const ENGLISH = {download: 'Download', subtitles: 'Subtitles', subscription: 'Subscription',
  portrait: 'Portrait', preview: 'Scrub preview', probe: 'Media probe', server: 'Server'};
const englishSource = source => ENGLISH[source] || PROGRAMS[source] || source;

const pad = number => String(number).padStart(2, '0');
function stamp(seconds) {
  const at = new Date(seconds * 1000);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** The entries as plain text, oldest first as a log file reads, for pasting
    into a bug report. The source is named in English whatever the language, so
    a report reads the same to whoever receives it. */
export function activityText(entries) {
  return entries.map(entry => [
    `${stamp(entry.at)}  ${entry.level.toUpperCase().padEnd(7)}  ${englishSource(entry.source)}: ${entry.message}`,
    ...(entry.detail ? entry.detail.split('\n').map(line => `    ${line}`) : []),
  ].join('\n')).join('\n');
}

/** The time of day alone: every row's column is the same width, and the day
    is named once by a heading where it changes instead. */
export const entryTime = seconds => {
  const at = new Date(seconds * 1000);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};

/** What heads a day's run of entries. */
export function dayLabel(seconds, now = new Date()) {
  const at = new Date(seconds * 1000);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === now.toDateString()) return t('activity.today');
  if (at.toDateString() === yesterday.toDateString()) return t('activity.yesterday');
  return at.toLocaleDateString(locale(), {weekday: 'short', day: 'numeric', month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : {year: 'numeric'})});
}

/** What the server has been doing: downloads, subtitle and portrait fetches,
    subscription checks, and whatever else logged a line. */
export function createActivityUI({drawer, drawerClose, summary, list, sourceSelect, levelSelect,
  copyButton, report}) {
  let held = {boot: '', latest: 0, entries: []};
  let timer = null;
  let failing = false;

  function row(entry) {
    return html`<li class="activity-row" key=${entry.id} data-level=${entry.level}>
      <time class="activity-time" datetime=${new Date(entry.at * 1000).toISOString()}
        title=${stamp(entry.at)}>${entryTime(entry.at)}</time>
      <div class="activity-body">
        <span class="activity-source">${sourceLabel(entry.source)}</span>
        <p class="activity-message">${entry.message}</p>
        ${entry.detail ? html`<details class="activity-detail">
          <summary>${t('activity.details')}</summary><pre>${entry.detail}</pre>
        </details>` : null}
      </div>
    </li>`;
  }

  // Newest first, so a heading goes above the first entry of each day met.
  function rows(entries) {
    let day = null;
    return entries.flatMap(entry => {
      const key = new Date(entry.at * 1000).toDateString();
      const found = row(entry);
      if (key === day) return [found];
      day = key;
      return [html`<li class="activity-day" key=${`day-${key}`}>${dayLabel(entry.at)}</li>`, found];
    });
  }

  function shown() {
    return filterActivity(held.entries, {source: sourceSelect.value, level: levelSelect.value});
  }

  function draw() {
    const entries = shown();
    summary.textContent = activitySummary(held.entries);
    copyButton.disabled = !entries.length;
    clearButton.disabled = !held.entries.length;
    // Newest first: what just happened is what the drawer is opened to see.
    render(entries.length
      ? html`<ol class="activity-list">${rows(entries.slice().reverse())}</ol>`
      : html`<p class="download-empty">${held.entries.length
        ? t('activity.noMatch')
        : t('activity.empty')}</p>`,
    list);
  }

  async function poll() {
    timer = null;
    try {
      const after = held.boot ? held.latest : 0;
      const payload = await request(`/api/activity?after=${after}`);
      // Only a new boot or new lines are worth a render.
      if (payload.boot !== held.boot || payload.entries.length) {
        held = mergeActivity(held, payload);
        draw();
      }
      failing = false;
    } catch (error) {
      // Once per outage rather than every two seconds of it.
      if (!failing) report(t('error.reason', {message: t('activity.error.load'), reason: error.message || error}), {error: true});
      failing = true;
    }
    if (drawer.open && !drawer.classList.contains('is-closing')) timer = setTimeout(poll, POLL_MS);
  }

  const clearButton = drawer.querySelector('#activity-clear');
  clearButton.addEventListener('click', async () => {
    try {
      await post('/api/activity/clear');
      // The server keeps its numbering, so the next poll carries on from here.
      held = {...held, entries: []};
      draw();
    } catch (error) {
      report(t('error.reason', {message: t('activity.error.clear'), reason: error.message || error}), {error: true});
    }
  });
  sourceSelect.addEventListener('change', draw);
  levelSelect.addEventListener('change', draw);
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(activityText(shown()));
      report(t('activity.copied'));
    } catch (error) {
      report(t('error.reason', {message: t('activity.error.copy'), reason: error.message || error}), {error: true});
    }
  });

  const controls = createDrawerControls(drawer);
  drawer.addEventListener('close', () => {
    clearTimeout(timer);
    timer = null;
  });
  function open() {
    controls.open();
    draw();
    if (!timer) poll();
  }
  drawerClose.addEventListener('click', controls.close);
  return {open};
}
