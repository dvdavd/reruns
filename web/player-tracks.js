import {formatBytes, html, render} from 'media-ui';
import {codecNameOf, currentFormat, selectFormat} from './item-adapter.js';
import {preferences} from './preferences.js';
import {t} from './i18n.js';

/** Where the chosen subtitle language is kept between videos and sessions. */
const SUBTITLE_KEY = 'archive-subtitle-language';
export function createTrackControls({
  mediaPlayer, provider, getActiveItem, onFormatChange,
  report, settingsPopup, subtitleList, subtitleSummary,
  subtitleEmpty, subtitleDownloads, subtitleDownloadOffers, subtitleToggle, subtitleSwitch,
  audioRow, audioList, audioSummary, formatPopup,
  formatEntries, formatOpen, formatLabelNode,
}) {
  // The subtitle language the viewer last asked for, across videos and
  // sessions; empty is captions off. See drawSubtitles.
  let subtitleLanguage = '';
  try {
    subtitleLanguage = preferences.getItem(SUBTITLE_KEY) || '';
  } catch { /* A blocked store simply starts with captions off. */ }
  let lastSubtitleLanguage = subtitleLanguage;
  let downloadSubtitles = null;

  /** The tracks the video being watched was downloaded with. */
  function subtitleTracks() {
    const item = getActiveItem();
    return item?.parts?.[0]?.subtitleTracks || [];
  }

  /**
   * The chosen track for a video, which need not be the one the viewer picked
   * last: they chose a language, and this video may only have a regional
   * variant of it, or none at all. Null is captions off.
   */
  function chosenTrack(tracks, language = subtitleLanguage) {
    if (!language) return null;
    const base = language.split('-')[0];
    return tracks.find(track => track.language === language)
      || tracks.find(track => track.language.split('-')[0] === base)
      || null;
  }

  /**
   * Turns the chosen language on and everything else off. The track elements
   * are the provider's, made as the source was attached, so this runs after
   * each load as well as when the choice changes.
   */
  function applySubtitles() {
    const chosen = chosenTrack(subtitleTracks());
    for (const track of mediaPlayer.video.textTracks) {
      // Hidden tracks still update activeCues, letting the player draw them
      // above its controls without the browser drawing a second native copy.
      track.mode = chosen && track.language === chosen.language ? 'hidden' : 'disabled';
    }
    // Changing a TextTrack's mode does not reliably produce cuechange (in
    // particular when disabling its current cue), so tell the custom renderer
    // to redraw immediately instead of leaving that cue on screen.
    mediaPlayer.video.dispatchEvent(new Event('archive-subtitles-change'));
    for (const row of subtitleList.children) {
      row.setAttribute('aria-checked', String(row.dataset.language === (chosen?.language || '')));
    }
    // The switch says on or off, so the summary only names the language.
    subtitleSummary.textContent = chosen?.label || '';
    subtitleToggle.hidden = subtitleTracks().length === 0;
    subtitleToggle.setAttribute('aria-pressed', String(Boolean(chosen)));
    // With nothing downloaded there is nothing to turn on; the chevron still
    // leads to the languages that can be fetched.
    subtitleSwitch.disabled = subtitleTracks().length === 0;
    subtitleSwitch.setAttribute('aria-checked', String(Boolean(chosen)));
  }

  function languageName(language) {
    try {
      return new Intl.DisplayNames(navigator.languages, {type: 'language'}).of(language) || language;
    } catch { return language; }
  }

  /** Populate both captions already on disk and those the source offers. */
  function drawSubtitles(item) {
    const tracks = item?.parts?.[0]?.subtitleTracks || [];
    // With nothing downloaded the chooser would be a list of one saying Off,
    // which reads as a fault rather than an answer; a line of prose says the
    // same thing and leaves the download below it as the obvious next step.
    subtitleList.hidden = tracks.length === 0;
    subtitleEmpty.hidden = tracks.length > 0;
    subtitleList.replaceChildren(...[{language: '', label: t('common.off')}, ...tracks].map(entry => {
      const row = optionRow(entry.label, '');
      row.setAttribute('role', 'radio');
      row.dataset.language = entry.language;
      row.addEventListener('click', () => chooseSubtitles(entry.language));
      return row;
    }));
    const held = new Set(tracks.map(track => track.language));
    const offers = [
      ...(item?.archive?.subtitleLanguages || []).map(entry => ({entry, automatic: false})),
      ...(item?.archive?.automaticCaptionLanguages || []).map(entry => ({entry, automatic: true})),
    ];
    // A source with nothing to fetch has no use for the heading either.
    subtitleDownloadOffers.hidden = offers.length === 0;
    subtitleDownloads.replaceChildren(...offers.map(({entry, automatic}) => {
      const language = typeof entry === 'string' ? entry : entry.language;
      const name = typeof entry === 'string' ? languageName(language)
        : entry.label || languageName(language);
      // Saying which are already here stops a second fetch of the same file
      // being the easiest thing on the page to click.
      const alreadyHeld = held.has(language);
      const row = optionRow(name, alreadyHeld ? t('player.downloaded') : automatic ? t('player.automatic') : '', DOWNLOAD_PATH);
      row.disabled = alreadyHeld;
      row.addEventListener('click', () => fetchSubtitles(row, language, automatic));
      return row;
    }));
    applySubtitles();
  }

  const TICK_PATH = '<path d="M5 12l5 5l10 -10"/>';
  const DOWNLOAD_PATH = '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>';

  /** A row of the subtitles page: an icon column, the name, and a note. */
  function optionRow(name, note, iconPath = TICK_PATH) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-option';
    row.innerHTML = `<svg class="settings-option-icon" viewBox="0 0 24 24" aria-hidden="true">${iconPath}</svg><span></span><span></span>`;
    row.children[1].textContent = name;
    row.children[2].textContent = note;
    return row;
  }

  /**
   * The audio tracks of the file just loaded, which the provider announces
   * on each load: a file with one track has no choice to offer, so the row
   * stays out of the menu. Switching reloads the stream with the other
   * track and carries on from the same place, as choosing a format does.
   */
  function audioName(track) {
    const language = track.language && track.language !== 'und' ? languageName(track.language) : '';
    return track.title || language || t('player.audioTrackNumber', {number: track.index});
  }

  function drawAudio({tracks, current}) {
    audioRow.hidden = tracks.length < 2;
    if (audioRow.hidden) {
      audioList.replaceChildren();
      audioSummary.textContent = '';
      return;
    }
    const chosen = tracks.find(track => track.index === current);
    audioSummary.textContent = chosen ? audioName(chosen) : '';
    audioList.replaceChildren(...tracks.map(track => {
      const row = optionRow(audioName(track), track.playable ? (track.title && track.language
        ? languageName(track.language) : '') : t('player.audioUnplayable'));
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(track.index === current));
      row.disabled = !track.playable;
      row.addEventListener('click', () => chooseAudio(track, current));
      return row;
    }));
  }
  mediaPlayer.video.addEventListener('archive-audio-tracks', event => drawAudio(event.detail));

  async function chooseAudio(track, current) {
    settingsPopup.hidePopover?.();
    const item = getActiveItem();
    if (!item || track.index === current) return;
    const position = mediaPlayer.absoluteTime();
    const playing = !mediaPlayer.video.paused;
    provider.chooseAudio(track);
    provider.resumeFrom(position);
    try {
      const loaded = await mediaPlayer.load(item, 0);
      if (loaded && playing) mediaPlayer.play();
    } catch (error) {
      report(t('error.reason', {message: t('watch.error.playAudio'), reason: error.message || error}), {error: true});
    }
  }

  /** Remembered as the language the viewer asked for, not the track that
   *  matched it: the next video may spell the same language differently. */
  function chooseSubtitles(language) {
    subtitleLanguage = language;
    if (language) lastSubtitleLanguage = language;
    try {
      if (language) preferences.setItem(SUBTITLE_KEY, language);
      else preferences.removeItem(SUBTITLE_KEY);
    } catch { /* A blocked store simply forgets the choice at reload. */ }
    const item = getActiveItem();
    drawSubtitles(item);
  }
  /** Off, or back on in the language last chosen, as the bar's CC button
   *  and the menu's switch both do. */
  function toggleSubtitles() {
    const tracks = subtitleTracks();
    const on = Boolean(chosenTrack(tracks));
    chooseSubtitles(on ? '' : chosenTrack(tracks, lastSubtitleLanguage)?.language || tracks[0]?.language || '');
  }
  subtitleToggle.addEventListener('click', event => {
    event.stopPropagation();
    toggleSubtitles();
  });
  subtitleSwitch.addEventListener('click', toggleSubtitles);
  for (const type of ['dblclick']) subtitleToggle.addEventListener(type, event => event.stopPropagation());
  async function fetchSubtitles(row, language, automatic) {
    const item = getActiveItem();
    const key = item?.archive?.formatId || item?.id;
    if (!key || !downloadSubtitles) return;
    row.disabled = true;
    try {
      await downloadSubtitles({id: key, languages: language, automatic});
      settingsPopup.hidePopover?.();
    } catch {
      // The downloads UI has already reported the server's useful message.
      row.disabled = false;
    }
  }

  /** The switcher, or nothing at all for a video downloaded only once. */
  function drawFormats(item) {
    const current = currentFormat(item);
    formatOpen.hidden = !current;
    if (!current) {
      formatPopup.hidePopover?.();
      render(null, formatEntries);
      return;
    }
    formatLabelNode.textContent = current.shortLabel || current.label;
    formatOpen.title = t('watch.format', {label: current.label});
    formatOpen.setAttribute('aria-label', t('watch.format', {label: current.label}));
    render(item.archive.formats.map(entry => html`
      <button class="format-entry" type="button" key=${entry.id}
              aria-pressed=${String(entry.id === current.id)}
              onClick=${() => chooseFormat(entry.id)}>
        <span class="format-entry-name">${entry.shortLabel || entry.label}</span>
        <span class="format-entry-detail">${[codecNameOf(entry),
          entry.container && entry.container.toUpperCase(),
          entry.sizeBytes ? formatBytes(entry.sizeBytes) : ''].filter(Boolean).join(' · ')}</span>
      </button>`), formatEntries);
  }

  /**
   * Plays another copy of the same video. It is the same video, so the page
   * around it does not change: only the facts about the file are redrawn, and
   * the new copy picks up exactly where the last one had got to, playing on if
   * it was playing.
   */
  async function chooseFormat(formatId) {
    const item = getActiveItem();
    formatPopup.hidePopover?.();
    if (!item || !selectFormat(item, formatId)) return;
    const position = mediaPlayer.absoluteTime();
    const playing = !mediaPlayer.video.paused;
    drawFormats(item);
    drawSubtitles(item);
    onFormatChange(item);
    provider.resumeFrom(position);
    try {
      const loaded = await mediaPlayer.load(item, 0);
      if (loaded && playing) mediaPlayer.play();
    } catch (error) {
      report(t('error.reason', {message: t('watch.error.playFormat'), reason: error.message || error}), {error: true});
    }
  }
  return {drawFormats, drawSubtitles, applySubtitles, setSubtitleDownloader(download) { downloadSubtitles = download; }};
}
