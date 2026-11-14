import {html, render} from 'media-ui';
import {icon} from './icon.js';
import {post} from './api.js';
import {createJobFeed} from './job-feed.js';
import {DEBUG_DOWNLOADS, debugJobs} from './download-debug.js';
import {t} from './i18n.js';
import {ACTIVE_STATES, createJobFailureTracker, flattenDownloads, isDownloadUrl, queueStatus} from './download-model.js';
import {downloadRow} from './download-row.js';
import {audioCodecChoices, codecChoices, downloadBody, formatChoices, grantedLocationChoices, locationChoices, profileMenuItems, resolveSelection} from './download-profiles.js';
import {createDrawerControls} from './drawer.js';
import {animateResize, claimSubmenuRow, followButton} from './popover.js';
import {audioLanguagePicker, languageName, parseLanguageTags, subtitleLanguagePicker} from './subtitle-languages.js';
import {defaultMark} from './default-mark.js';
import {preferences as account} from './preferences.js';

export const DEFAULT_PREFERENCES = {
  media: 'video', quality: 'best', videoContainer: 'auto', audioContainer: 'auto', codec: 'any', audio_codec: 'auto',
  subtitles: 'none', subtitleLanguages: 'en.*', audioLanguages: '', comments: 'off', chat: 'off',
  playlist: 'all', organization: 'server',
  // Which entry of the arrow's menu is picked: '' for the default, a profile
  // id, or 'manual' for the selects that were always here.
  selection: '',
};
const STORAGE_KEY = 'ytdlp-download-options-v1';

const POLL_FAILURES_BEFORE_REPORT = 3;
// While a job runs, the gallery is read again at most this often for the
// parts it has saved. Each read is the whole library listing, which for a
// large library is most of a megabyte, and a playlist of short videos can
// land a part every few seconds.
const ARRIVAL_RELOAD_MS = 15000;

export function createDownloadsUI({access = {role: 'admin'}, directory, form, urlInput, jobsElement,
  advancedToggle, advancedPanel, profileMenu, manualPanel, subscribeButton,
  queueToggle, queueCount, drawer, drawerClose, drawerSummary, onJobs, onSettled, playLocal, report}) {
  let pollTimer = null;
  const jobFeed = createJobFeed();
  let pollFailures = 0;
  const newFailures = createJobFailureTracker();
  // Videos finished across all jobs at the last poll; null until there is one,
  // so opening the page does not read as a download having just landed.
  let completedBefore = null;
  // A part that landed while the last reload was too recent, so it is still
  // owed one: when the wait is up, or when the job ends.
  let arrivalWaiting = false;
  let lastArrivalReload = 0;
  let preferences = loadPreferences();
  let profiles = [];
  let defaultProfile = '';
  let libraries = [];
  // Per download rather than remembered: a folder picked for one link should
  // not quietly catch the next.
  let folder = '';
  const locationRow = advancedPanel.querySelector('[data-download-location]');
  const locationSelect = locationRow.querySelector('select');
  const restricted = access.role !== 'admin';
  if (restricted) {
    // All download entry points use the same explicit destination override.
    globalThis.rerunsDestination = () => {
      const choices = grantedLocationChoices(access.grants || [], libraries);
      const chosen = choices.find(choice => choice.value === folder) || choices[0];
      return chosen ? JSON.parse(chosen.value) : undefined;
    };
  }
  const mediaSelect = form.elements.media;
  const formatSelect = form.elements.container;
  const languagesPicker = advancedPanel.querySelector('[data-subtitle-languages-picker]');
  const audioLanguagesPicker = advancedPanel.querySelector('[data-audio-languages-picker]');
  const pagesBox = advancedPanel.querySelector('[data-download-pages]');
  const pages = [...pagesBox.querySelectorAll('[data-download-page]')];
  const subtitleSummary = advancedPanel.querySelector('[data-subtitle-summary]');
  const subtitleModesList = advancedPanel.querySelector('[data-subtitle-modes]');
  const subtitleLanguagesBlock = advancedPanel.querySelector('[data-subtitle-languages-block]');
  const audioSummary = advancedPanel.querySelector('[data-audio-summary]');
  const watchFooter = advancedPanel.querySelector('[data-download-watch]');
  const watchNote = advancedPanel.querySelector('[data-download-watch-note]');
  // The button the popup hangs from: the topbar's chevron, the watch page's
  // download button, or a card menu's submenu row.
  let opener = advancedToggle;
  let placement = 'vertical';
  let submenuCloseTimer = null;
  let hideTimer = null;
  function cancelSubmenuClose() {
    if (submenuCloseTimer !== null) clearTimeout(submenuCloseTimer);
    submenuCloseTimer = null;
  }
  function cancelHide() {
    // A close taken back leaves the panel open, so its row says so again.
    if (hideTimer !== null && advancedPanel.matches(':popover-open')) opener.setAttribute('aria-expanded', 'true');
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
    advancedPanel.classList.remove('is-closing');
    advancedPanel.inert = false;
  }
  function closeAdvancedPanel({immediate = false} = {}) {
    if (!advancedPanel.matches(':popover-open')) return;
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelHide();
      advancedPanel.hidePopover();
      return;
    }
    if (hideTimer !== null) return;
    advancedPanel.classList.add('is-closing');
    advancedPanel.inert = true;
    // The row stops saying it is open as the panel starts to fade, not after:
    // a card menu lights every expanded row once the hovered one is expanded
    // too, so moving on to another submenu relit this row until the fade ended.
    opener.setAttribute('aria-expanded', 'false');
    hideTimer = setTimeout(() => {
      advancedPanel.hidePopover();
      cancelHide();
    }, 140);
  }
  // Set while the watch page has the popup. Its choices live here rather than
  // in the remembered preferences: settings suggested for one video that will
  // not play must not become what the topbar offers for every link after it.
  let watch = null;
  const current = () => (watch ? watch.preferences : preferences);
  function update(patch) {
    if (watch) watch.preferences = {...watch.preferences, ...patch};
    else { preferences = {...preferences, ...patch}; savePreferences(); }
  }

  function loadPreferences() {
    try {
      const saved = JSON.parse(account.getItem(STORAGE_KEY) || '{}');
      return {...DEFAULT_PREFERENCES, ...(saved && typeof saved === 'object' ? saved : {})};
    } catch (_) {
      return {...DEFAULT_PREFERENCES};
    }
  }
  function savePreferences() {
    try { account.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch (_) {}
  }
  /** Built when drawn, so a change of language reaches the words. */
  const subtitleModes = () => [['none', t('profiles.subtitles.none')],
    ['manual', t('profiles.subtitles.manual')], ['manual_auto', t('profiles.subtitles.auto')]];
  /** What the audio row says it holds: names rather than tags, and the first
   *  couple only, so a long list cannot push the row wider than the popup. */
  function languageSummary(value) {
    const names = parseLanguageTags(value).map(languageName);
    if (!names.length) return t('downloads.audioDefault');
    if (names.length <= 2) return names.join(', ');
    return t('downloads.moreLanguages', {languages: names.slice(0, 2).join(', '), count: names.length - 2});
  }
  /* The language pickers are pages that slide over the menu rather than
     blocks inside it: twelve boxes and a tags field made the popup taller than
     everything else in it put together. Only the page showing is in the flow,
     so the popup's own resize animation measures the right height; the others
     wait out of sight and, being inert, out of the tab order. */
  let pageName = '';
  function showPage(name, {animate = true, focus = true} = {}) {
    const from = pageName;
    if (name === from) return;
    const change = () => {
      pageName = name;
      pagesBox.dataset.page = name;
      for (const page of pages) {
        const here = page.dataset.downloadPage === name;
        page.toggleAttribute('data-active', here);
        page.inert = !here;
      }
    };
    if (animate) animateResize(advancedPanel, change); else change();
    advancedPanel.scrollTop = 0;
    if (!focus) return;
    // Focus follows the slide, and comes back to the row that opened the page.
    // Without preventScroll the browser scrolls the clipped box to bring a
    // button that is still mid-slide into view, and the pages stay sideways.
    const target = name === 'main'
      ? advancedPanel.querySelector(`[data-download-go="${from}"]`)
      : pagesBox.querySelector(`[data-download-page="${name}"] [data-download-back]`);
    target?.focus({preventScroll: true});
    pagesBox.scrollLeft = 0;
  }
  advancedPanel.querySelectorAll('[data-download-go]').forEach(button => {
    button.addEventListener('click', () => showPage(button.dataset.downloadGo));
  });
  advancedPanel.querySelectorAll('[data-download-back]').forEach(button => {
    button.addEventListener('click', () => showPage('main'));
  });
  showPage('main', {animate: false, focus: false});

  function syncForm() {
    const codecSelect = form.elements.codec;
    if (codecSelect && !codecSelect.options.length) {
      render(codecChoices().map(([value, label]) => html`<option value=${value}>${label}</option>`), codecSelect);
    }
    const audioCodecSelect = form.elements.audio_codec;
    if (audioCodecSelect && !audioCodecSelect.options.length) {
      render(audioCodecChoices().map(([value, label]) => html`<option value=${value}>${label}</option>`), audioCodecSelect);
    }
    const values = current();
    for (const name of ['media', 'quality', 'codec', 'audio_codec', 'comments', 'chat', 'playlist', 'organization']) {
      if (form.elements[name]) form.elements[name].value = values[name];
    }
    render(subtitleLanguagePicker({
      id: 'download-subtitle-languages',
      menu: true,
      value: values.subtitleLanguages,
      onChange: tags => {
        update({subtitleLanguages: tags});
        syncForm();
      },
    }), languagesPicker);
    render(audioLanguagePicker({
      menu: true,
      id: 'download-audio-languages',
      value: values.audioLanguages,
      onChange: tags => {
        update({audioLanguages: tags});
        syncForm();
      },
    }), audioLanguagesPicker);
    const media = values.media === 'audio' ? 'audio' : 'video';
    audioSummary.textContent = languageSummary(values.audioLanguages);
    advancedPanel.querySelector('[data-audio-note]').hidden = media !== 'audio';
    subtitleSummary.textContent = subtitleModes().find(([value]) => value === values.subtitles)?.[1] || '';
    subtitleLanguagesBlock.hidden = values.subtitles === 'none';
    render(subtitleModes().map(([value, label]) => html`
      <button type="button" role="menuitemradio" key=${value}
        aria-checked=${String(value === values.subtitles)}
        onClick=${() => { update({subtitles: value}); syncForm(); }}>
        <span>${label}</span>
      </button>`), subtitleModesList);
    render(formatChoices(media === 'audio').map(([value, label]) => html`
      <option value=${value}>${label}</option>`), formatSelect);
    formatSelect.value = values[media === 'video' ? 'videoContainer' : 'audioContainer'];
    advancedPanel.querySelectorAll('[data-video-option]').forEach(element => {
      const off = media === 'audio';
      element.hidden = off;
      element.querySelector('select, input[form]')?.toggleAttribute('disabled', off);
    });
  }
  function readOptions() {
    const media = mediaSelect.value;
    update({
      media, quality: form.elements.quality.value,
      codec: media === 'video' ? form.elements.codec.value : current().codec,
      audio_codec: form.elements.audio_codec.value,
      subtitles: media === 'video' ? current().subtitles : 'none',
      comments: form.elements.comments.value,
      chat: form.elements.chat.value,
      playlist: form.elements.playlist.value,
      organization: form.elements.organization.value,
      [media === 'video' ? 'videoContainer' : 'audioContainer']: formatSelect.value,
    });
    const values = current();
    return {
      media, quality: values.quality,
      codec: media === 'video' ? values.codec : 'any',
      audio_codec: values.audio_codec,
      container: values[media === 'video' ? 'videoContainer' : 'audioContainer'],
      subtitles: values.subtitles,
      subtitle_languages: values.subtitleLanguages,
      // One stream in an audio file, so only the first language can be kept.
      audio_languages: media === 'audio' ? values.audioLanguages.split(',')[0] : values.audioLanguages,
      comments: values.comments,
      chat: values.chat,
      playlist: values.playlist,
      organization: values.organization,
    };
  }
  syncForm();

  /* The arrow's menu: the default, every profile, then the manual overrides.
     Picking one only changes what submit sends, so switching between profiles
     costs nothing and the manual selects keep their own remembered values. */
  function selection() {
    return resolveSelection(current().selection, profiles, defaultProfile);
  }
  function selectedProfile() {
    const chosen = selection();
    if (chosen === 'manual') return null;
    return profiles.find(item => item.id === (chosen || defaultProfile || profiles[0]?.id));
  }
  /** The profile's library, falling back to the server's download library. */
  function defaultPath() {
    const library = libraries.find(item => item.id === selectedProfile()?.library)
      || libraries.find(item => item.downloads);
    return library?.path || '';
  }
  function drawLocation() {
    const rows = directory?.rows() || [];
    const choices = restricted
      ? grantedLocationChoices(access.grants || [], libraries)
      : locationChoices(rows, directory?.selected() || '', selection() === 'manual' ? t('profiles.default') : t('profiles.profileDefault'));
    locationRow.hidden = restricted ? !choices.length : !rows.length && !defaultPath();
    if (!choices.some(choice => choice.value === folder)) {
      folder = restricted ? choices[0]?.value || '' : '';
    }
    render(choices.map(choice => html`
      <option value=${choice.value} selected=${choice.value === folder}>${
        '\u00a0\u00a0'.repeat(Math.max(0, (choice.depth || 0) - 1))}${choice.label}</option>`),
    locationSelect);
    locationSelect.value = folder;
  }
  locationSelect.addEventListener('change', () => { folder = locationSelect.value; });
  function drawProfileMenu() {
    drawLocation();
    const chosen = selection();
    render(profileMenuItems(profiles, defaultProfile).map(item => html`
      <button type="button" role="menuitemradio" key=${item.value}
        aria-checked=${String(item.value === chosen)}
        onClick=${() => animateResize(advancedPanel, () => {
          update({selection: item.value});
          drawProfileMenu();
        })}>
        <span>${item.label}</span>
        ${item.detail ? defaultMark() : null}
      </button>`), profileMenu);
    manualPanel.hidden = chosen !== 'manual';
  }
  /** The profiles the server knows about, from app.js's settings payload. */
  function setProfiles({downloadProfiles = [], defaultProfile: chosen = '', libraries: held = []} = {}) {
    profiles = downloadProfiles;
    libraries = held;
    defaultProfile = chosen;
    drawProfileMenu();
  }
  drawProfileMenu();

  // The search field doubles as the URL field: a link in it switches the bar
  // to its download actions, and the options popup belongs to that mode.
  const submitButton = form.querySelector('#download-submit');
  const isLink = () => form.dataset.mode === 'link';
  function syncMode() {
    const link = isDownloadUrl(urlInput.value);
    form.dataset.mode = link ? 'link' : 'search';
    form.dataset.filled = String(Boolean(urlInput.value.trim()));
    // Collapsed to zero width rather than display:none so the mode switch
    // animates; tabindex keeps the collapsed buttons out of tab order. Typing
    // already searches, so the go button only ever does something once a
    // link turns it into Download.
    submitButton.tabIndex = link ? 0 : -1;
    advancedToggle.tabIndex = link ? 0 : -1;
    subscribeButton.tabIndex = link ? 0 : -1;
    // The watch page's popup is for its video, not the field's contents.
    if (!link && !watch) closeAdvancedPanel();
  }
  // The gallery ignored the link, so emptying the field needs no new search.
  function reset() {
    urlInput.value = '';
    urlInput.dispatchEvent(new Event('searchsync'));
  }
  urlInput.addEventListener('input', syncMode);
  // The gallery announces the times it sets the field itself.
  urlInput.addEventListener('searchsync', syncMode);
  syncMode();
  // Choosing audio drops the video rows, and choosing whether to fetch
  // subtitles decides whether asking which languages means anything, so the
  // rows follow each choice as it is made. The media select is inside the
  // panel, so this one listener hears it too.
  advancedPanel.addEventListener('change', () => animateResize(advancedPanel, () => {
    readOptions();
    syncForm();
  }));
  // A manual popover lets the closing opacity finish before hiding it in
  // browsers that cannot transition display. Closed, it goes back to the topbar.
  const follow = followButton(advancedPanel, () => opener, 6, () => placement);
  advancedToggle.addEventListener('click', () => {
    if (advancedPanel.matches(':popover-open') && opener === advancedToggle) {
      closeAdvancedPanel();
      return;
    }
    cancelHide();
    watch = null;
    opener = advancedToggle;
    placement = 'vertical';
    advancedPanel.setAttribute('role', 'group');
    watchFooter.hidden = true;
    syncForm();
    drawProfileMenu();
    if (!advancedPanel.matches(':popover-open')) advancedPanel.showPopover();
  });
  document.addEventListener('pointerdown', event => {
    if (!advancedPanel.matches(':popover-open') || advancedPanel.contains(event.target)
        || opener.contains(event.target)) return;
    closeAdvancedPanel();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !advancedPanel.matches(':popover-open')) return;
    event.preventDefault();
    if (pageName !== 'main') { showPage('main'); return; }
    const button = opener;
    closeAdvancedPanel();
    button.focus();
  });
  advancedPanel.addEventListener('toggle', event => {
    const open = event.newState === 'open';
    // Always reopens on the menu, never on a language page left behind.
    showPage('main', {animate: false, focus: false});
    opener.setAttribute('aria-expanded', String(open));
    if (open) { follow.start(); return; }
    cancelSubmenuClose();
    follow.stop();
    if (!watch) return;
    watch = null;
    opener = advancedToggle;
    placement = 'vertical';
    advancedPanel.setAttribute('role', 'group');
    watchFooter.hidden = true;
    syncForm();
    drawProfileMenu();
  });

  /**
   * The same choices as the topbar's arrow, for a video on the watch page or
   * in a card menu: a profile, or the manual overrides. The copy lands beside the one
   * already held rather than on its name. With a `suggestion` - the picture
   * will not play in this browser - the overrides open on a codec that will,
   * and say so.
   */
  function openForVideo(button, {url, suggestion = null, note = '',
    side = false, focus = false, toggle = false} = {}) {
    cancelSubmenuClose();
    cancelHide();
    if (watch?.url === url && opener === button && advancedPanel.matches(':popover-open')) {
      // A press on the button the popup hangs from, rather than a hover
      // re-announcing the row that opened it, turns it off again.
      if (toggle) { closeAdvancedPanel(); return; }
      if (focus) profileMenu.querySelector('button')?.focus();
      return;
    }
    const base = {...preferences};
    watch = {url, submenu: side, preferences: suggestion
      ? {...base, selection: 'manual', media: 'video', codec: suggestion.codec}
      : base};
    opener = button;
    placement = side ? 'side' : 'vertical';
    advancedPanel.setAttribute('role', side ? 'dialog' : 'group');
    watchNote.textContent = note;
    watchNote.hidden = !note;
    watchFooter.hidden = false;
    syncForm();
    drawProfileMenu();
    if (!advancedPanel.matches(':popover-open')) advancedPanel.showPopover();
    if (focus) profileMenu.querySelector('button')?.focus();
  }
  function closeForVideo({delay = 0} = {}) {
    cancelSubmenuClose();
    if (!watch?.submenu || !advancedPanel.matches(':popover-open')) return;
    if (delay) {
      submenuCloseTimer = setTimeout(() => closeForVideo(), delay);
      return;
    }
    closeAdvancedPanel();
  }
  advancedPanel.addEventListener('pointerenter', () => {
    cancelSubmenuClose();
    if (watch?.submenu) claimSubmenuRow(opener);
  });
  advancedPanel.addEventListener('keydown', event => {
    if (!watch?.submenu || event.key !== 'ArrowLeft'
        || !event.target.closest('#download-profile-menu')) return;
    event.preventDefault();
    const button = opener;
    closeForVideo();
    button.focus();
  });
  watchFooter.querySelector('[data-download-watch-submit]').addEventListener('click', async () => {
    if (!watch) return;
    try {
      await post('/api/download', {...downloadBody(watch.url, selection(), readOptions, restricted ? '' : folder),
        alongside: true});
      folder = '';
      closeAdvancedPanel();
      markQueued();
      schedulePoll();
      report(t('downloads.queued'));
    } catch (error) {
      report(t('error.reason', {message: t('downloads.error.start'), reason: error.message || error}), {error: true});
    }
  });
  urlInput.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isLink()) reset();
  });

  const {open: openDrawer, close: closeDrawer} = createDrawerControls(drawer);
  queueToggle.addEventListener('click', openDrawer);
  drawerClose.addEventListener('click', closeDrawer);
  // In the header beside Close, where it stays put however long the list is.
  const clearButton = drawer.querySelector('#download-clear');
  clearButton.addEventListener('click', clearFinished);
  // Clearing the last finished row leaves the drawer open over an empty list;
  // the button stays until it closes, so focus has somewhere to return to.
  let rowCount = 0;
  drawer.addEventListener('close', () => showQueueToggle(rowCount > 0));
  function showQueueToggle(show) {
    if (!show && drawer.open) return;
    queueToggle.dataset.empty = show ? 'false' : 'true';
  }
  function markQueued() {
    // Include jobs that finish before their first poll.
    completedBefore ??= 0;
    queueToggle.dataset.active = 'true';
    showQueueToggle(true);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 200);
  }
  async function jobAction(id, action) {
    if (DEBUG_DOWNLOADS) { report(`Debug downloads: ${action} does nothing`); return; }
    try { await post(`/api/jobs/${id}/${action}`); }
    catch (error) { report(t('error.reason', {message: t(`downloads.error.${action}`), reason: error.message || error}), {error: true}); }
    schedulePoll();
  }
  async function clearFinished() {
    if (DEBUG_DOWNLOADS) { report('Debug downloads: clearing does nothing'); return; }
    try { await post('/api/jobs/clear'); schedulePoll(); }
    catch (error) { report(t('error.reason', {message: t('downloads.error.clear'), reason: error.message || error}), {error: true}); }
  }
  // A finished video's title plays the copy the library now holds, once the
  // rescan after settling has found it.
  function localLink(row) {
    if (row.state !== 'done' || !row.videoId || !playLocal) return null;
    const key = playLocal.keyFor(row.extractor, row.videoId);
    if (!key) return null;
    return {href: `/?watch=${encodeURIComponent(key)}`, onClick: event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!playLocal.play(key, event)) return;
      event.preventDefault();
      closeDrawer();
    }};
  }
  function draw(jobs) {
    const rows = flattenDownloads(jobs);
    const {remaining, percent, summary} = queueStatus(rows);
    rowCount = rows.length;
    clearButton.disabled = !rows.some(row => !ACTIVE_STATES.has(row.state) && row.state !== 'paused');
    showQueueToggle(rows.length > 0);
    queueToggle.dataset.active = remaining ? 'true' : 'false';
    queueToggle.style.setProperty('--download-progress', percent === null ? '0' : `${percent}`);
    /* The button settles into its downloading look the moment something is queued,
       rather than flipping from flat purple to the gradient once yt-dlp reports a
       first percentage. Until then the ring has nothing to measure, so it spins. */
    queueToggle.dataset.progress = remaining ? 'true' : 'false';
    queueToggle.dataset.waiting = remaining && percent === null ? 'true' : 'false';
    queueCount.hidden = !remaining;
    queueCount.textContent = remaining || '';
    drawerSummary.textContent = summary;
    render(rows.length ? html`
      <ul class="download-list">${rows.map(row => downloadRow(row, {onAction: jobAction, local: localLink(row)}))}</ul>
`
      : html`<p class="download-empty">${t('downloads.empty')}</p>`, jobsElement);
  }
  async function poll() {
    let failedJobs = [];
    try {
      const jobs = DEBUG_DOWNLOADS ? debugJobs() : await jobFeed.read();
      pollFailures = 0;
      draw(jobs);
      failedJobs = newFailures(jobs);
      const settledBrowse = onJobs?.(jobs) || false;
      if (DEBUG_DOWNLOADS) { pollTimer = setTimeout(poll, 1000); return; }
      const active = jobs.some(job => ACTIVE_STATES.has(job.state));
      // A comments-only refresh is left out: the comments card reads its own
      // result, and reading the library again for it redrew every card and
      // showed the scanning toast for nothing the gallery lists.
      const completed = jobs.reduce((total, job) =>
        total + (job.commentsOnly ? 0 : job.counts?.completed || 0), 0);
      if (completedBefore !== null && completed > completedBefore) arrivalWaiting = true;
      completedBefore = completed;
      if (active) {
        pollTimer = setTimeout(poll, 1000);
        // A playlist can run for hours; each part is watchable soon after it
        // is saved, so the gallery need not wait for the whole job to settle.
        if (arrivalWaiting && Date.now() - lastArrivalReload >= ARRIVAL_RELOAD_MS) {
          arrivalWaiting = false;
          lastArrivalReload = Date.now();
          await onSettled();
          draw(jobs);
        }
        return;
      }
      // Subscriptions start checks on the server's clock, so keep an ear out.
      pollTimer = setTimeout(poll, 30000);
      if (arrivalWaiting || settledBrowse) {
        arrivalWaiting = false;
        lastArrivalReload = Date.now();
        await onSettled();
        draw(jobs);
      }
    } catch (error) {
      // Behind a reverse proxy an odd poll fails while a video is streaming and
      // the next one works, so stay quiet for a blip and keep polling. Only a
      // run of failures is worth telling anyone about, and only once.
      // A failed reload after the timer was set must not leave two chains polling.
      pollFailures += 1;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 5000);
      if (pollFailures === POLL_FAILURES_BEFORE_REPORT) {
        report(t('error.reason', {message: t('downloads.error.poll'), reason: error.message || error}), {error: true});
      }
    } finally {
      // Archive scans use and clear the same toast; show failures afterward.
      for (const job of failedJobs) {
        if (DEBUG_DOWNLOADS) continue;
        const what = t(`downloads.failed.${job.kind === 'subtitles' || job.kind === 'refresh' ? job.kind : 'download'}`);
        const reason = job.error || job.items?.find(item => item.error)?.error;
        const message = job.title ? t('downloads.failedFor', {what, title: job.title}) : t('downloads.failed', {what});
        report(reason ? t('error.reason', {message, reason}) : message, {error: true, timeout: 10000});
      }
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    // The browse action handles Enter when a search has no local match.
    if (!isLink()) { urlInput.blur(); return; }
    try {
      await post('/api/download', downloadBody(urlInput.value.trim(), selection(), readOptions, restricted ? '' : folder));
      folder = '';
      reset();
      markQueued();
      schedulePoll();
    } catch (error) {
      report(t('error.reason', {message: t('downloads.error.start'), reason: error.message || error}), {error: true});
    }
  });
  async function downloadSubtitles(options) {
    try {
      const job = await post('/api/item/subtitles', options);
      markQueued();
      schedulePoll();
      // The chat card shows its own progress, as the comments card does.
      if (options.chat !== true) report(t('downloads.subtitlesQueued'));
      return job;
    } catch (error) {
      if (options.chat !== true) report(t('error.reason', {message: t('downloads.error.subtitles'), reason: error.message || error}), {error: true});
      throw error;
    }
  }
  async function refreshMetadata(options) {
    try {
      // A refresh brings the comments up to date when downloads are set to
      // keep them: the chosen profile's say, or the manual selects'. One made
      // from the comments card is for the comments alone, whatever they say,
      // and has the card's own progress rather than a toast.
      const commentsOnly = options.commentsOnly === true;
      const keeping = commentsOnly || (selection() === 'manual'
        ? current().comments === 'on'
        : selectedProfile()?.options?.comments === 'on');
      const job = await post('/api/item/refresh', {...options, comments: keeping});
      markQueued();
      schedulePoll();
      if (!commentsOnly) report(t('downloads.refreshQueued'));
      return job;
    } catch (error) {
      report(t('error.reason', {message: t('downloads.error.refresh'), reason: error.message || error}), {error: true});
      throw error;
    }
  }
  return {poll, schedulePoll, jobAction, downloadSubtitles, refreshMetadata, readOptions, selection, setProfiles, isLink, reset,
    openForVideo, closeForVideo};
}
