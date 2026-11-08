// A card's thumbnail plays its video once the pointer has rested on it for a
// moment, and goes back to the picture when the pointer leaves.
//
// The cards belong to Preact, and the gallery recycles them as it scrolls, so
// nothing here is kept on a card: the preview is a <video> and a pair of
// buttons added beside what Preact drew, and it is thrown away the moment the
// card could be showing something else (a scroll, a changed id, a detached
// node). The video itself ignores the pointer, so a click on the thumbnail
// still opens the video exactly as it did before.

import {iconMarkup} from './icon.js';
import {escapeMarkup} from 'media-ui';
import {t} from './i18n.js';
import {createSeekPreview} from './seek-preview.js';
export {ratioAt, thumbStyle} from './seek-preview.js';

export const PREVIEW_DELAY_MS = 500;

/** The playable address of the video a card shows, or '' when it has none. */
export function previewUrl(item, partIndex = 0) {
  const part = item?.parts?.[partIndex] || item?.parts?.[0] || item;
  return part?.sourceRef || item?.sourceRef || '';
}

/**
 * The addresses to try for a card's preview, smallest file first, ending at
 * the card's own. A card is a few hundred pixels wide, so the lowest-quality
 * copy held looks the same there and costs a fraction of the best one to
 * stream; one the browser cannot play falls through to the next.
 */
export function previewSources(item, partIndex = 0) {
  const own = previewUrl(item, partIndex);
  if (!own) return [];
  // Only a single video has copies in other formats (groupFormats).
  const formats = (item?.parts?.length ?? 1) > 1 ? [] : item?.archive?.formats || [];
  const size = format => Number(format.sizeBytes) || Number.MAX_SAFE_INTEGER;
  const smallest = formats.filter(format => format.sourceRef && !format.audioOnly)
    .sort((a, b) => size(a) - size(b))
    .map(format => format.sourceRef);
  return [...new Set([...smallest, own])];
}

// Sheets are fetched once per video: a card previewed again must not ask the
// server twice. A failure is remembered as null, so a video with no sheet
// simply seeks without pictures.
const sheets = new Map();

// Where each preview got to, kept until the page is reloaded so hovering a
// card again carries on rather than starting over. Keyed by address, as the
// gallery recycles cards.
const resumeAt = new Map();

async function loadSheet(url, stillWanted) {
  if (sheets.has(url)) return sheets.get(url);
  for (let attempt = 0; attempt < 20 && stillWanted(); attempt += 1) {
    let sheet;
    try {
      const response = await fetch(url, {cache: 'no-store'});
      if (!response.ok) break;
      sheet = await response.json();
    } catch { break; }
    if (sheet.state === 'ready') {
      sheets.set(url, sheet);
      return sheet;
    }
    if (sheet.state !== 'queued' && sheet.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, Number(sheet.retryAfterMs) || 700));
  }
  if (stillWanted()) sheets.set(url, null);
  return null;
}

/**
 * `autoplay` says whether a preview starts by itself. When it does not, the
 * pointer resting on a card brings up the preview's buttons and nothing more:
 * no part of the video is fetched until its play button or bar is pressed.
 */
export function createHoverPreview({root, itemFor, delay = PREVIEW_DELAY_MS, autoplay = () => true}) {
  let timer = 0;
  let current = null;

  function end() {
    clearTimeout(timer);
    timer = 0;
    if (!current) return;
    const {video, controls, restoreProgress, loaded} = current;
    current = null;
    // Not kept at the very start or end, where carrying on would mean nothing.
    // A preview never started has no say over where the last one got to.
    const at = video.currentTime;
    if (!loaded()) { /* Leave it. */ }
    else if (video.duration && at > 1 && at < video.duration - 1) resumeAt.set(video.dataset.url, at);
    else resumeAt.delete(video.dataset.url);
    restoreProgress();
    video.pause();
    // Releasing the source stops the download as well as the sound.
    video.removeAttribute('src');
    video.load();
    video.remove();
    controls.remove();
  }

  const cardOf = target => target?.closest?.('.video-card');
  const areaOf = target => target?.closest?.('.thumbnail-area');

  function start(area, card) {
    const id = card.dataset.id;
    const item = itemFor(card);
    const sources = previewSources(item, Number(card.dataset.partIndex) || 0);
    const url = sources.at(-1);
    const frame = area.querySelector('.thumbnail-frame');
    // The card may have been recycled or removed while the timer ran.
    if (!url || !frame || !card.isConnected || card.dataset.id !== id || !area.matches(':hover')) return;
    const video = document.createElement('video');
    video.className = 'hover-preview-video';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    // Kept under the card's own address whichever copy plays, so where it
    // got to carries over if the smaller copy goes.
    video.dataset.url = url;
    const continueFrom = resumeAt.get(url);
    if (continueFrom) video.addEventListener('loadedmetadata', () => { video.currentTime = continueFrom; });
    const endThisPreview = () => { if (current?.video === video) end(); };
    // A copy the browser cannot decode gives way to the next, and once none
    // is left the picture simply stays showing.
    let tried = -1;
    let starting = false;
    const loaded = () => tried >= 0;
    const tryNext = () => {
      tried += 1;
      if (tried >= sources.length) return endThisPreview();
      video.src = sources[tried];
      if (starting) video.play().catch(() => {});
    };
    video.addEventListener('error', () => { if (current?.video === video) tryNext(); });
    // Revealed on the first frame, so the thumbnail is never swapped for black.
    video.addEventListener('playing', () => video.classList.add('is-ready'), {once: true});
    frame.querySelector('.thumbnail-image')?.after(video);

    const controls = document.createElement('div');
    controls.className = 'hover-preview-controls';
    controls.innerHTML = `
      <button type="button" data-preview-play aria-label="${escapeMarkup(t('preview.pause'))}">${
        iconMarkup('pause', 'hover-preview-pause')}${iconMarkup('play', 'hover-preview-play')}</button>
      <button type="button" data-preview-mute aria-label="${escapeMarkup(t('preview.unmute'))}" aria-pressed="true">${
        iconMarkup('volume-muted', 'hover-preview-muted')}${iconMarkup('volume-high', 'hover-preview-sound')}</button>`;
    const [playButton, muteButton] = controls.children;
    // Waiting for a press, the button offers to play.
    if (!autoplay()) {
      controls.classList.add('is-paused');
      playButton.setAttribute('aria-label', t('preview.play'));
    }
    playButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (!loaded()) begin();
      else if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    muteButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      video.muted = !video.muted;
    });
    // The buttons follow the video rather than guessing at its state.
    video.addEventListener('play', () => {
      playButton.setAttribute('aria-label', t('preview.pause'));
      controls.classList.remove('is-paused');
    });
    video.addEventListener('pause', () => {
      playButton.setAttribute('aria-label', t('preview.play'));
      controls.classList.add('is-paused');
    });
    video.addEventListener('volumechange', () => {
      muteButton.setAttribute('aria-pressed', String(video.muted));
      muteButton.setAttribute('aria-label', t(video.muted ? 'preview.unmute' : 'preview.mute'));
    });
    area.append(controls);

    // The position bar. Its hit zone is taller than the line it draws, so the
    // pointer only has to come near for the line to swell, and the zone takes
    // the pointer so a click or drag seeks instead of opening the video.
    const seekBar = document.createElement('div');
    seekBar.className = 'hover-preview-seek';
    seekBar.setAttribute('role', 'slider');
    seekBar.setAttribute('aria-label', t('preview.seek'));
    seekBar.innerHTML = '<span class="hover-preview-seek-track"><span class="hover-preview-seek-fill"></span></span>';
    const seekFill = seekBar.querySelector('.hover-preview-seek-fill');
    const part = item?.parts?.[Number(card.dataset.partIndex) || 0];
    let sheet = part?.seekPreview || item?.seekPreview || null;
    const sheetUrl = part?.seekPreviewUrl || item?.seekPreviewUrl || '';
    const seekTo = ratio => {
      if (video.duration) video.currentTime = ratio * video.duration;
    };
    let dragging = false;
    let resume = false;
    const seekPreview = createSeekPreview({
      seek: seekBar, getDuration: () => video.duration, getSheet: () => sheet,
      keepVisible: () => dragging, onMove: ratio => { if (dragging) seekTo(ratio); },
    });
    seekBar.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      resume = !video.paused;
      // Held still while dragged, so the frames shown are the ones scrubbed to.
      video.pause();
      seekBar.setPointerCapture(event.pointerId);
      seekBar.classList.add('is-dragging');
      seekTo(seekPreview.show(event));
    });
    const release = event => {
      if (!dragging) return;
      dragging = false;
      seekBar.classList.remove('is-dragging');
      if (resume) video.play().catch(() => {});
      // A drag can end outside the card, where no pointerout will say so.
      if (!card.matches(':hover')) end();
      else if (!seekBar.matches(':hover')) seekPreview.hide();
    };
    seekBar.addEventListener('pointerup', release);
    seekBar.addEventListener('pointercancel', release);
    // The click that ends a seek would otherwise follow the card's link.
    seekBar.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });

    // The card's progress bar follows the preview while it plays, then goes
    // back to the saved position. Preact owns both the bar and its fill, so
    // what it drew is remembered and put back rather than recomputed.
    const bar = area.querySelector('.thumbnail-watch-progress');
    const saved = bar && {hidden: bar.hidden};
    video.addEventListener('timeupdate', () => {
      if (!video.duration) return;
      const percent = video.currentTime / video.duration * 100;
      seekFill.style.width = `${percent}%`;
      seekBar.setAttribute('aria-valuenow', String(Math.round(percent)));
    });
    const restoreProgress = () => {
      if (bar) bar.hidden = saved.hidden;
      seekBar.remove();
    };
    current = {video, controls, area, card, restoreProgress, loaded,
      id, partId: card.dataset.partId, partIndex: card.dataset.partIndex};
    // Fetches the video and puts up its bar, at once or on the first press.
    function begin() {
      if (loaded()) return;
      starting = true;
      video.preload = 'auto';
      // The preview's own bar takes the card's place while it is up.
      area.append(seekBar);
      if (bar) bar.hidden = true;
      // Loading checks that this preview is still active, so it is registered
      // before this runs.
      if (!sheet && sheetUrl) {
        loadSheet(sheetUrl, () => current?.video === video).then(loadedSheet => {
          if (!loadedSheet || current?.video !== video) return;
          sheet = loadedSheet;
          seekPreview.refresh();
        });
      }
      tryNext();
    }
    if (autoplay()) begin();
    else video.preload = 'none';
  }

  root.addEventListener('pointerover', event => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    const area = areaOf(event.target);
    if (!area || area === current?.area || area.contains(event.relatedTarget)) return;
    // Back from the text onto the picture of the card already playing.
    if (current && cardOf(area) === current.card) return;
    const card = cardOf(area);
    if (!card) return;
    end();
    timer = setTimeout(() => start(area, card), delay);
  });
  // The preview survives the pointer drifting down onto the card's text, so
  // it only ends on leaving the card; it still only starts over the picture.
  root.addEventListener('pointerout', event => {
    const card = cardOf(event.target);
    if (!card || card.contains(event.relatedTarget)) return;
    end();
  });
  // Recycled cards move under a still pointer, which raises no pointerout.
  window.addEventListener('scroll', end, {passive: true});
  document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });

  // Part arrows update the existing card without moving the pointer. Replace
  // the preview after the render so its source follows the selected part.
  new MutationObserver(() => {
    if (!current) return;
    const {card, area, video, id, partId, partIndex} = current;
    if (!card.isConnected || !area.contains(video)) {
      end();
      return;
    }
    if (card.dataset.id === id && card.dataset.partId === partId &&
        card.dataset.partIndex === partIndex) return;
    end();
    if (card.matches(':hover')) start(area, card);
  }).observe(root, {subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-id', 'data-part-id', 'data-part-index']});

  return {end};
}
