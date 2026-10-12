import {html, render} from 'media-ui';
import {post, request} from './api.js';
import {createDrawerControls} from './drawer.js';
import {icon} from './icon.js';
import {t} from './i18n.js';
import {relativeTime} from './subscriptions-ui.js';

const TOOLS = [['pyav', 'PyAV'], ['ffmpeg', 'ffmpeg'], ['ytdlp', 'yt-dlp']];

export const TOOL_LINKS = {
  PyAV: 'https://pyav.org',
  ffmpeg: 'https://ffmpeg.org',
  'yt-dlp': 'https://github.com/yt-dlp/yt-dlp',
};

/** What this app is and which media tools the server found. The server probes
    the tools once at startup, so a null here means it could not run that one. */
export function aboutRows(about) {
  return [['Reruns', about.version],
    ...TOOLS.map(([key, label]) => [label, about[key]])];
}

const BUSY = new Set(['checking', 'updating']);
// How often the page asks again while a check runs; a download of the release
// takes a few seconds, and the check itself less.
const POLL_MS = 2000;

/** The line under yt-dlp when the server keeps it up to date itself. Only a
    server started with --manage-yt-dlp sends updates at all. */
export function updateStatus(updates, now = Date.now() / 1000) {
  if (updates.state === 'checking') return {text: t('about.checking'), error: false};
  if (updates.state === 'updating') return {text: t('about.installing', {version: updates.latest}), error: false};
  if (updates.state === 'error') return {text: t('about.updateFailed', {error: updates.error}), error: true};
  if (!updates.checkedAt) return {text: t('about.notChecked'), error: false};
  const current = updates.latest && updates.latest === updates.version;
  const state = current ? t('about.upToDate') : t('about.available', {version: updates.latest});
  return {text: t('about.checked', {state, when: relativeTime(updates.checkedAt, now)}), error: false};
}

export function createAboutUI({drawer, drawerClose, summary, list, report}) {
  const controls = createDrawerControls(drawer);

  let poll = 0;
  // Set while a check the viewer asked for is running, so its outcome is
  // reported once it settles; the daily check in the background says nothing.
  let settling = false;

  function updateRow(updates) {
    const status = updateStatus(updates);
    const busy = BUSY.has(updates.state);
    return html`<dd class="about-update">
      <span class="about-update-status" data-error=${String(status.error)}>${status.text}</span>
      <span class="about-update-actions">
        <select aria-label=${t('about.channel')} value=${updates.channel} disabled=${busy}
          onChange=${event => act('/api/settings/yt-dlp-channel', {channel: event.currentTarget.value},
            'about.error.channel')}>
          <option value="stable">${t('about.stable')}</option>
          <option value="nightly">${t('about.nightly')}</option>
        </select>
        <button type="button" class="library-row-action" disabled=${busy}
          aria-label=${t('about.checkYtdlp')} title=${t('about.checkYtdlp')}
          onClick=${() => act('/api/yt-dlp/check', {}, 'about.error.check')}>
          ${icon('refresh')}</button>
      </span>
    </dd>`;
  }

  function show(about) {
    summary.textContent = t('about.version', {version: about.version});
    render(aboutRows(about).map(([name, version]) => {
      const updates = name === 'yt-dlp' && about.ytdlpUpdates;
      return html`<div class=${`about-row${updates ? ' has-update' : ''}`} key=${name}>
        <dt>${TOOL_LINKS[name]
          ? html`<a class="about-tool-link" href=${TOOL_LINKS[name]} target="_blank" rel="noopener noreferrer">${name}${icon('external-link')}</a>`
          : name}</dt>
        <dd data-missing=${String(!version)}>${version || t('about.notFound')}</dd>
        ${updates ? updateRow(updates) : null}
      </div>`;
    }), list);
    clearTimeout(poll);
    if (about.ytdlpUpdates && BUSY.has(about.ytdlpUpdates.state) && drawer.open) {
      poll = setTimeout(refresh, POLL_MS);
    } else if (settling) {
      settling = false;
      const {state, version, error} = about.ytdlpUpdates || {};
      report(state === 'error' ? t('about.updateError', {error}) : t('about.running', {version}),
        {error: state === 'error'});
    }
  }

  async function act(path, body, failure) {
    try {
      settling = true;
      await post(path, body);
      await refresh();
    } catch (error) {
      settling = false;
      report(t('error.reason', {message: t(failure), reason: error.message || error}), {error: true});
    }
  }

  async function refresh() {
    try {
      show(await request('/api/about'));
    } catch (error) {
      report(t('error.reason', {message: t('about.error.read'), reason: error.message || error}), {error: true});
    }
  }

  async function open() {
    settling = false;
    controls.open();
    await refresh();
  }

  drawerClose.addEventListener('click', controls.close);
  return {open};
}
