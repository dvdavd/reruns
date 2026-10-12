import {html, render} from 'media-ui';
import {post, request} from './api.js';
import {createDrawerControls} from './drawer.js';
import {plural, t} from './i18n.js';
import {icon} from './icon.js';

// Past this many a fetch-all asks first, and "fetch the first batch" takes this
// many. Each is a request to YouTube, so a library of thousands should not be
// started by one stray click.
export const BATCH = 25;
// A pause between fetches, so a long run is not a burst.
const PAUSE_MS = 1500;
const POLL_MS = 1000;
const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** The videos a fetch-all would try: those whose name holds an id, minus any
    that already failed in this visit (asking again would only fail again). */
export function fetchable(orphans, failed = new Set()) {
  return orphans.filter(entry => entry.videoId && !failed.has(entry.key));
}

/** What fetch-all should do for this many: nothing to ask below the batch,
    otherwise the choice between all of them and the first batch. */
export function fetchPlan(candidates, batch = BATCH) {
  return {ask: candidates.length > batch, first: candidates.slice(0, batch), all: candidates};
}

export function orphansSummary(orphans) {
  return orphans.length ? plural('count.orphans', orphans.length) : t('orphans.none');
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** The settings panel listing videos that have no sidecar, with a button to
    fetch each one's metadata from the id in its name. */
export function createOrphansUI({drawer, drawerClose, summary, list, fetchAll, confirm,
  menuItem, onFetched, report}) {
  let orphans = [];
  // key -> {state: 'fetching' | 'failed', error}
  let rows = new Map();
  let running = false;
  let stopping = false;
  const {open: openDrawer, close} = createDrawerControls(drawer);

  function draw() {
    const failed = new Set([...rows].filter(([, row]) => row.state === 'failed').map(([key]) => key));
    summary.textContent = orphansSummary(orphans);
    menuItem.hidden = !orphans.length;
    fetchAll.hidden = !fetchable(orphans, failed).length;
    fetchAll.textContent = running ? t('orphans.stop') : t('orphans.fetchAll');
    render(html`<ul class="library-list">${orphans.map(entry => {
      const row = rows.get(entry.key);
      return html`<li class="library-row" key=${entry.key} data-missing=${String(row?.state === 'failed')}>
        <div class="library-row-text">
          <code class="library-path" title=${entry.key}>${entry.name}</code>
          <small class=${row?.state === 'failed' ? 'library-warning' : ''}>
            ${row?.state === 'fetching' ? t('orphans.fetching')
              : row?.state === 'failed' ? t('orphans.failed', {reason: row.error})
              : entry.videoId ? t('orphans.id', {id: entry.videoId}) : t('orphans.noId')}
            ${entry.folder ? ` · ${entry.folder}` : ''}
          </small>
        </div>
        <span class="library-row-actions">
          <button type="button" class="library-row-action" disabled=${!entry.videoId || row?.state === 'fetching'}
            aria-label=${row?.state === 'failed' ? t('orphans.retry') : t('orphans.fetch')}
            title=${row?.state === 'failed' ? t('orphans.retry') : t('orphans.fetch')}
            onClick=${() => fetchOne(entry.key)}>${icon('download')}</button>
        </span>
      </li>`;
    })}</ul>`, list);
  }

  async function refresh() {
    try {
      ({orphans} = await request('/api/orphans'));
      // A row whose file has gone has nothing left to say.
      rows = new Map([...rows].filter(([key]) => orphans.some(entry => entry.key === key)));
      draw();
    } catch (error) {
      report(t('error.reason', {message: t('orphans.error.load'), reason: error.message || error}), {error: true});
    }
  }

  /** Resolves to whether the sidecar was written. The job runs on the server;
      this only waits for it to end. */
  async function fetchOne(key) {
    rows.set(key, {state: 'fetching'});
    draw();
    try {
      let job = await post('/api/orphans/fetch', {key});
      while (!FINISHED.has(job.state)) {
        await wait(POLL_MS);
        job = (await request('/api/jobs')).find(entry => entry.id === job.id) || {...job, state: 'cancelled'};
      }
      if (job.state !== 'done') throw new Error(job.error || job.state);
      rows.delete(key);
      await refresh();
      onFetched();
      return true;
    } catch (error) {
      rows.set(key, {state: 'failed', error: error.message || String(error)});
      draw();
      return false;
    }
  }

  async function run(keys) {
    running = true;
    stopping = false;
    draw();
    let fetched = 0;
    for (const key of keys) {
      if (stopping) break;
      if (await fetchOne(key)) fetched += 1;
      if (!stopping && key !== keys.at(-1)) await wait(PAUSE_MS);
    }
    running = false;
    draw();
    report(t('orphans.done', {fetched, total: keys.length}));
  }

  /** Which of the candidates to fetch: all when few, otherwise whatever the
      person picks in the dialog; null when they cancel. */
  function choose(plan) {
    if (!plan.ask) return Promise.resolve(plan.all);
    confirm.querySelector('h2').textContent = t('orphans.confirmTitle', {count: plan.all.length});
    const first = confirm.querySelector('#orphans-confirm-first');
    first.textContent = t('orphans.confirmFirst', {count: plan.first.length});
    return new Promise(resolve => {
      confirm.addEventListener('close', () => resolve(
        {all: plan.all, first: plan.first}[confirm.returnValue] || null), {once: true});
      confirm.returnValue = 'cancel';
      confirm.showModal();
    });
  }

  fetchAll.addEventListener('click', async () => {
    if (running) {
      stopping = true;
      return;
    }
    const failed = new Set([...rows].filter(([, row]) => row.state === 'failed').map(([key]) => key));
    const chosen = await choose(fetchPlan(fetchable(orphans, failed)));
    if (chosen?.length) run(chosen.map(entry => entry.key));
  });
  drawerClose.addEventListener('click', close);

  function open() {
    openDrawer();
    refresh();
  }
  return {open, refresh};
}
