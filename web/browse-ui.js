import {filterItems, html, MediaRow, render} from 'media-ui';
import {icon} from './icon.js';
import {request} from './api.js';
import {createDrawerControls} from './drawer.js';
import {anchorPopover} from './popover.js';
import {flattenDownloads, formatDuration, startsLikeUrl} from './download-model.js';
import {downloadRow} from './download-row.js';
import {browseProfileOptions} from './download-profiles.js';
import {relativeTime, subscribableKind} from './subscriptions-ui.js';
import {channelSubscriptionIdFor, subscribedIdFor} from './subscription-target.js';
import {defaultMark} from './default-mark.js';
import {plural, t} from './i18n.js';

// The panel that shows what a channel, playlist or search lists, whether or not
// the archive holds it. The server answers in one small shape of its own (see
// browse.py), so nothing here knows yt-dlp's field names.

export const PAGE = 30;
const POLL_LIMIT = 60;

/** The identity the server marks held entries by, and the panel remembers
 *  queued ones by. */
export const entryKey = entry => `${entry.extractor} ${entry.id}`;

/** What a search on each library view looks for on YouTube: the playlists
 *  and channels views find more of those to follow, anywhere else videos. */
const SEARCH_KINDS = {playlists: 'search-playlists', channels: 'search-channels'};
const SEARCH_TITLES = {
  search: 'browse.searchTitle',
  'search-playlists': 'browse.searchPlaylistsTitle',
  'search-channels': 'browse.searchChannelsTitle',
};
export const isSearch = source => Boolean(SEARCH_TITLES[source?.kind]);

/** The query string for one listing. A search names its text, the others an
 *  address. */
export function listingPath(source, count) {
  const params = new URLSearchParams({kind: source.kind, count: String(count)});
  params.set(isSearch(source) ? 'query' : 'url', isSearch(source) ? source.query : source.url);
  return `/api/browse?${params}`;
}

/**
 * The finished listing, polling until the server has it. Throws with the
 * server's own words when it cannot be had, and returns null when `stale()`
 * says a newer request has taken over, so a slow answer never lands on a
 * source the person has since left. `fetchState` and `wait` are injected so
 * the polling is testable.
 */
export async function loadListing(source, count, {
  stale = () => false,
  fetchState = path => request(path),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const state = await fetchState(listingPath(source, count));
    if (stale()) return null;
    if (state?.state === 'ready') return state;
    if (state?.state === 'failed') throw new Error(state.error || t('browse.couldNotList'));
    await wait(Number(state?.retryAfterMs) || 900);
    if (stale()) return null;
  }
  throw new Error(t('browse.tooLong'));
}

/** What the filter box and the "hide downloaded" switch leave showing. */
export function filterEntries(entries, {text = '', missingOnly = false, queued = new Set()} = {}) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (missingOnly && (entry.held || queued.has(entryKey(entry)))) return false;
    const haystack = `${entry.title} ${entry.uploader}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

function shortCount(count, key) {
  if (count === null || count === undefined) return '';
  const short = (value, unit) => `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
  const text = count >= 1e9 ? short(count / 1e9, 'B') : count >= 1e6 ? short(count / 1e6, 'M')
    : count >= 1e3 ? short(count / 1e3, 'K') : String(count);
  return plural(key, count, {text});
}
export const formatViews = count => shortCount(count, 'count.views');
export const formatFollowers = count => shortCount(count, 'count.subscribers');

// YouTube's flat listings only say "1 month ago", which yt-dlp turns into a
// timestamp of about N x 30.5 days. Quoting that back as "31 days ago" claims a
// precision nobody had, and shows every video of a month as one lump, so from a
// fortnight on we give the unit YouTube gave. Its "3 weeks ago" is the same as
// a month to us, so weeks stop at two: months, then years, follow.
export function approximateAge(seconds, now = Date.now() / 1000) {
  const days = (now - seconds) / 86400;
  if (days < 14) return relativeTime(seconds, now);
  if (days < 21) return t('time.twoWeeks');
  const months = Math.max(1, Math.round(days / 30.44));
  if (months < 12) return plural('count.monthsAgo', months);
  const years = Math.floor(months / 12);
  return plural('count.yearsAgo', years);
}

/** The line under a title: who, how many watched, and how long ago. A
 *  channel is its own uploader, so it says how many follow it instead. */
export function entryMeta(entry, now = Date.now() / 1000) {
  if (entry.kind === 'channel') return [formatFollowers(entry.followers)].filter(Boolean);
  return [entry.uploader, formatViews(entry.views),
    entry.uploadedAt ? approximateAge(entry.uploadedAt, now) : ''].filter(Boolean);
}

export function browseSummary(entries, shown, queued = new Set()) {
  if (!entries.length) return '';
  const held = entries.filter(entry => entry.held).length;
  const waiting = entries.filter(entry => !entry.held && queued.has(entryKey(entry))).length;
  const listed = t('browse.listed', {count: entries.length});
  const parts = [shown < entries.length ? t('browse.shownOf', {shown, listed}) : listed];
  if (held) parts.push(t('browse.inLibrary', {count: held}));
  if (waiting) parts.push(t('browse.queuedCount', {count: waiting}));
  return parts.join(' · ');
}

/** Forget jobs that can no longer be queued. A completed job stays, with an
 *  empty id, until a listing shows its video as held: forgetting it sooner
 *  would offer Download again while the library has not been rescanned. It
 *  asks the caller for that rescan once. */
export function reconcileQueued(queued, jobs) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  let completed = false;
  let changed = false;
  for (const [key, id] of queued) {
    if (!id) continue;
    const state = byId.get(id)?.state;
    if (state === 'done') {
      queued.set(key, '');
      completed = true;
      changed = true;
    } else if (!state || ['failed', 'cancelled'].includes(state)) {
      queued.delete(key);
      changed = true;
    }
  }
  return {completed, changed};
}

/** Pick the current video of each download started here. A job may have
 *  several items after inspection; the queue already sorts the active ones
 *  ahead of finished items. */
export function queuedDownloadRows(queued, jobs) {
  const rows = flattenDownloads(jobs);
  return new Map([...queued].map(([key, id]) => [key,
    rows.find(row => row.jobId === id && row.state !== 'done')]).filter(([, row]) => row));
}

/** What the topbar's Browse button opens for what is in the field, or null
 *  when it has nothing to offer: a channel or playlist link is browsed, any
 *  other text is searched for, as whatever the library view on screen lists,
 *  and a single video's link is neither. */
export function browseSourceFor(value, {link, view = ''}) {
  const text = String(value || '').trim();
  if (!text || (!link && startsLikeUrl(text))) return null;
  if (link) {
    const kind = subscribableKind(text);
    return kind ? {kind, url: text, title: ''} : null;
  }
  const kind = SEARCH_KINDS[view] || 'search';
  return {kind, query: text, title: t(SEARCH_TITLES[kind], {query: text})};
}

/** The YouTube action takes the download button's emphasis only when the
 *  archive's own search has no result for the same words. A playlist or
 *  channel search is answered by the grid on screen, which counts its own
 *  matches. */
export function searchNeedsYouTube(source, items, viewMatches = 0) {
  if (source?.kind === 'search') return !filterItems(items, {query: source.query}).length;
  return isSearch(source) && !viewMatches;
}

/** The subscription already following a listed playlist or channel, or null. */
export function entrySubscriptionId(entry, subscriptions) {
  if (entry.kind === 'playlist') return subscribedIdFor(subscriptions, 'playlist', entry.url);
  if (entry.kind === 'channel') return channelSubscriptionIdFor(subscriptions, [], entry.id);
  return null;
}

export function createBrowseUI({drawer, drawerClose, backButton, title, summary, filter, optionsButton,
  optionsMenu, list, moreButton, download, jobAction, playLocal, report}) {
  // Back, and Escape, step down to the drawer beneath, its contents sliding
  // back in step with this one leaving; the dimmed page closes both.
  const controls = createDrawerControls(drawer, {
    beforeClose: () => {
      over?.drawer.classList.remove('is-covered');
      return true;
    },
    dismiss: () => closeAll(),
  });
  let source = null;
  // The search a playlist or channel was opened from, kept whole so Back
  // returns to the same results, scrolled and filtered as they were.
  let parent = null;
  // The drawer this one slid over (the subscriptions list), as {drawer, close},
  // left open beneath it so Back at the top of the stack slides this away to
  // reveal it again.
  let over = null;
  // Set by an admin's page; without it listed playlists and channels are
  // only browsed, never followed.
  let subscriptions = null;
  const subscribing = new Set();
  let hideDownloaded = false;
  let profile = '';
  let profileOptions = browseProfileOptions([], '');
  let count = PAGE;
  let listing = null;
  let status = 'idle';
  let error = '';
  let token = 0;
  // Downloads started from this panel, until the archive holds them: the
  // server only learns a video is held when the library is next scanned.
  const queued = new Map();
  let queuedRows = new Map();

  function visible() {
    return filterEntries(listing?.entries || [], {
      text: filter.value, missingOnly: hideDownloaded, queued: new Set(queued.keys()),
    });
  }

  async function start(entry) {
    const key = entryKey(entry);
    queued.set(key, null);
    draw();
    try {
      const job = await download(entry, profile);
      queued.set(key, job.id);
    } catch (failure) {
      queued.delete(key);
      draw();
      report(t('error.reason', {message: t('browse.error.download'), reason: failure.message || failure}), {error: true});
    }
  }

  async function toggleSubscription(entry) {
    const key = entryKey(entry);
    if (subscribing.has(key)) return;
    subscribing.add(key);
    draw();
    try {
      const id = entrySubscriptionId(entry, subscriptions.list());
      if (id) await subscriptions.unsubscribe(id, entry.title);
      // The panel's own Download with choice, as its download buttons use.
      else await subscriptions.subscribe(entry.url, {channelId: entry.kind === 'channel' ? entry.id : '', profile});
    } finally {
      subscribing.delete(key);
      draw();
    }
  }

  function subscribeAction(entry) {
    if (!subscriptions) return null;
    const subscribed = Boolean(entrySubscriptionId(entry, subscriptions.list()));
    return html`<button type="button" class="browse-subscribe" aria-pressed=${String(subscribed)}
      disabled=${subscribing.has(entryKey(entry))}
      title=${subscribed ? t('subscriptions.unsubscribe')
        : t(entry.kind === 'channel' ? 'subscriptions.subscribeChannelTitle' : 'subscriptions.subscribePlaylistTitle')}
      aria-label=${t(subscribed ? 'browse.unsubscribeItem' : 'browse.subscribeItem', {title: entry.title})}
      onClick=${() => toggleSubscription(entry)}>
      ${subscribed ? t('subscriptions.unsubscribe') : t('subscriptions.subscribe')}</button>`;
  }

  function action(entry) {
    if (entry.kind === 'playlist' || entry.kind === 'channel') return subscribeAction(entry);
    if (entry.held) return html`<span class="browse-chip" data-state="held">${t('browse.heldChip')}</span>`;
    if (queued.has(entryKey(entry))) return html`<span class="browse-chip" data-state="queued">${t('browse.queuedChip')}</span>`;
    if (!download) return null;
    return html`<button type="button" class="download-row-action" title=${t('downloads.download')}
      aria-label=${t('browse.downloadItem', {title: entry.title})} onClick=${() => start(entry)}>${icon('download')}</button>`;
  }

  function openLocal(event, entry) {
    // A modified click keeps its usual meaning, a new tab on the same address.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!playLocal?.(entry.localKey, event)) return;
    event.preventDefault();
    closeAll();
  }

  function openNested(event, entry) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    parent = {source, listing, count, filter: filter.value, scroll: drawer.scrollTop};
    show({kind: entry.kind, url: entry.url, title: entry.title});
  }

  // A held video's title opens the local copy; a playlist or channel lists
  // here what it holds; the site's page is for the rest.
  function titleLink(entry) {
    if (entry.kind === 'playlist' || entry.kind === 'channel') {
      return html`<a class="media-row-title" href=${entry.url} title=${t('browse.openListing')}
        onClick=${event => openNested(event, entry)}>${entry.title}</a>`;
    }
    if (entry.held && entry.localKey) {
      return html`<a class="media-row-title" href=${`/?watch=${encodeURIComponent(entry.localKey)}`}
        title=${t('downloads.playLocal')} onClick=${event => openLocal(event, entry)}>${entry.title}</a>`;
    }
    return html`<a class="media-row-title" href=${entry.url} target="_blank"
      rel="noreferrer noopener" title=${t('subscriptions.openOriginal')}>${entry.title}</a>`;
  }

  function row(entry) {
    const active = queuedRows.get(entryKey(entry));
    if (active) return downloadRow(active, {entry, key: entryKey(entry), onAction: jobAction});
    const meta = entryMeta(entry);
    return html`<${MediaRow} key=${entryKey(entry)} class="download-row browse-row"
      data-held=${String(entry.held)} data-kind=${entry.kind || 'video'}
      round=${entry.kind === 'channel'} thumbnail=${entry.thumbnail || null}
      duration=${entry.duration ? formatDuration(entry.duration) : null}>
      ${titleLink(entry)}
      <div class="browse-foot">
        ${meta.length ? html`<p class="media-row-meta"><span>${meta.join(' · ')}</span></p>` : null}
        ${entry.live ? html`<span class="browse-chip" data-state="live">${t('browse.live')}</span>` : null}
        ${action(entry)}
      </div>
    <//>`;
  }

  function body(shown) {
    if (status === 'loading' && !listing) return html`<p class="download-empty">${t('browse.listing')}</p>`;
    if (status === 'failed' && !listing) {
      return html`<p class="download-empty" data-error="true">${t('browse.failed', {error})}</p>`;
    }
    if (!listing) return null;
    if (!listing.entries.length) return html`<p class="download-empty">${t('browse.nothing')}</p>`;
    if (!shown.length) return html`<p class="download-empty">${t('browse.noMatch')}</p>`;
    return html`<ul class="download-list">${shown.map(row)}</ul>`;
  }

  function draw() {
    const shown = visible();
    // The person's own words for a search, the page's name for a channel.
    title.textContent = source?.title || listing?.title || '';
    backButton.hidden = !parent && !over;
    const backLabel = t(parent ? 'browse.back' : 'browse.backToSubscriptions');
    backButton.title = backLabel;
    backButton.setAttribute('aria-label', backLabel);
    summary.textContent = status === 'loading' ? t('browse.listing')
      : browseSummary(listing?.entries || [], shown.length, new Set(queued.keys()));
    render(body(shown), list);
    // Kept while more is being fetched, so the button does not vanish under a
    // pointer that has just pressed it.
    moreButton.hidden = !listing?.more && status !== 'loading-more';
    moreButton.disabled = status === 'loading-more';
    moreButton.textContent = status === 'loading-more' ? t('browse.listing') : t('browse.more');
    if (status === 'failed' && listing) moreButton.textContent = t('browse.tryAgain');
  }

  async function load({more = false} = {}) {
    const mine = ++token;
    status = more ? 'loading-more' : listing ? 'refreshing' : 'loading';
    draw();
    try {
      const result = await loadListing(source, count, {stale: () => mine !== token});
      if (!result) return;
      listing = result;
      status = 'ready';
      for (const entry of result.entries) {
        if (entry.held && queued.get(entryKey(entry)) === '') queued.delete(entryKey(entry));
      }
    } catch (failure) {
      if (mine !== token) return;
      error = failure.message || String(failure);
      status = 'failed';
    }
    draw();
  }

  filter.addEventListener('input', draw);
  moreButton.addEventListener('click', () => {
    // A failed page is asked for again as it was; a good one is widened.
    if (status !== 'failed') count += PAGE;
    load({more: true});
  });
  // Leaving for good (the close button, the dimmed page, a video played from
  // the list) takes the drawer beneath along too; only Back and Escape step
  // down to it.
  // Its contents stay slid aside while it goes, so they do not sweep back
  // across under this one on their way out.
  function closeAll() {
    const beneath = over;
    over = null;
    controls.close();
    if (!beneath) return;
    beneath.drawer.addEventListener('close',
      () => beneath.drawer.classList.remove('is-covered'), {once: true});
    beneath.close();
  }
  drawerClose.addEventListener('click', closeAll);
  drawer.addEventListener('close', () => {
    over = null;
    drawer.classList.remove('is-stacked');
  });
  backButton.addEventListener('click', () => {
    if (!parent) {
      controls.close();
      return;
    }
    const back = parent;
    parent = null;
    ({source, listing, count} = back);
    filter.value = back.filter;
    error = '';
    status = 'ready';
    draw();
    drawer.scrollTop = back.scroll;
  });

  /* The panel's own profile, chosen here rather than by the topbar's arrow,
     which remembers whatever was last picked for a one-off. It opens on the
     default each session, and falls back to it when the profile goes. */
  function drawOptions() {
    render(html`
      <button type="button" role="menuitemcheckbox" aria-checked=${String(hideDownloaded)}
        onClick=${() => { hideDownloaded = !hideDownloaded; drawOptions(); draw(); optionsMenu.hidePopover(); }}>
        <span>${t('browse.hideDownloaded')}</span>
      </button>
      <div class="menu-divider" role="separator"></div>
      ${profileOptions.map(({value, label, detail}) => html`
        <button type="button" role="menuitemradio" key=${value} aria-checked=${String(value === profile)}
          onClick=${() => { profile = value; drawOptions(); optionsMenu.hidePopover(); }}>
          <span>${label}</span>
          ${detail ? defaultMark() : null}
        </button>`)}`, optionsMenu);
  }
  anchorPopover(optionsButton, optionsMenu);
  drawOptions();

  function setProfiles({downloadProfiles = [], defaultProfile = ''} = {}) {
    profileOptions = browseProfileOptions(downloadProfiles, defaultProfile);
    if (!profileOptions.some(option => option.value === profile)) profile = '';
    drawOptions();
  }

  function show(next) {
    const same = source && source.kind === next.kind
      && (isSearch(next) ? source.query === next.query : source.url === next.url);
    source = next;
    if (!same) {
      count = PAGE;
      listing = null;
      error = '';
      filter.value = '';
      drawer.scrollTop = 0;
    }
    controls.open();
    load();
  }

  return {
    setProfiles,
    /** Lets an admin's panel follow listed playlists and channels, through
     *  the same subscribe and unsubscribe every other shortcut uses. */
    setSubscriptions(api) {
      subscriptions = api;
      api.onChange(() => { if (drawer.open) draw(); });
    },
    /** `source` is {kind: 'channel'|'playlist', url, title}, or a search:
     *  {kind: 'search'|'search-playlists'|'search-channels', query, title}.
     *  `over` is {drawer, close} when this slides over another drawer, which
     *  stays open beneath for Back to return to. */
    open(next, {over: beneath = null} = {}) {
      parent = null;
      over = beneath;
      drawer.classList.toggle('is-stacked', Boolean(over));
      over?.drawer.classList.add('is-covered');
      show(next);
    },
    /** After downloads settle: the same listing again, so what has just
     *  arrived reads as held. The server keeps the listing itself, so this
     *  costs no request to the site. */
    refresh() {
      if (drawer.open && source && listing) load();
    },
    /** Returns true when a browse download has finished and the archive needs
     *  another scan, including when it finished before the first queue poll. */
    updateJobs(jobs) {
      const {completed, changed} = reconcileQueued(queued, jobs);
      queuedRows = queuedDownloadRows(queued, jobs);
      if (changed || queued.size) draw();
      return completed;
    },
    close: controls.close,
  };
}
