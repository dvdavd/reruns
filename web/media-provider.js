// Local playback plus server-generated scrub thumbnails. The shared player
// asks for the sheet once per load and polls until the server has built it.
import {LocalMediaProvider} from 'media-ui';
import {positionKey, resumablePosition, savedPosition} from './playback-position.js';
import {preferences} from './preferences.js';
import {t} from './i18n.js';
import {RemuxPlayback} from './mse-playback.js';

const SUBTITLE_GAP_GRACE_MS = 120;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Find a visible line carried forward by a replacement rolling cue. */
export function continuingSubtitleLine(lines, text) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  let best;
  let longest = 0;
  for (const line of lines) {
    const words = line.textContent.trim().replace(/\s+/g, ' ');
    if (words === normalized) return line;
    if (words.length > longest && normalized.startsWith(`${words} `)) {
      best = line;
      longest = words.length;
    }
  }
  return best;
}

const normalisedText = text => text.trim().replace(/\s+/g, ' ');

/**
 * Auto-captions put a cue of about ten milliseconds between the two real
 * ones, holding only the row that is about to stay. Drawn, it drops the
 * leaving row a moment before the others start to slide, so the top row
 * blinks out instead of scrolling away. A blip that says nothing already on
 * screen does not is passed over, and the gap grace carries the rows through.
 */
export function isRepeatedSubtitleBlip(cue, rows, lines) {
  if (cue.endTime - cue.startTime >= .05) return false;
  const shown = new Set(lines.map(line => normalisedText(line.textContent)));
  return rows.every(row => shown.has(normalisedText(row.textContent)));
}

/**
 * Move all caption rows together, including words arriving during a slide.
 * Returns how far the surviving rows had to travel, so a row that has just
 * left can be carried the same distance.
 */
export function slideSubtitleRows(lines, previousTops) {
  const anchor = lines.find(line => previousTops.has(line));
  if (!anchor) return 0;
  const offset = previousTops.get(anchor) - anchor.getBoundingClientRect().top;
  if (Math.abs(offset) < .5) return 0;
  const frames = [{transform: `translateY(${offset}px)`}, {transform: 'translateY(0)'}];
  const startTime = globalThis.document?.timeline?.currentTime;
  for (const line of lines) {
    const animation = line.animate?.(frames, {duration: 180, easing: 'ease-out'});
    if (animation && startTime != null) animation.startTime = startTime;
  }
  return offset;
}

/**
 * Keep a row that has just left on screen long enough to scroll away with the
 * others. It is pinned where it was, in the overlay's new coordinates, and
 * the overlay's clip hides it as it slides out of the box.
 */
export function slideOutSubtitleRow(overlay, line, previousRect, offset) {
  const box = overlay.getBoundingClientRect();
  Object.assign(line.style, {
    position: 'absolute',
    left: `${previousRect.left - box.left}px`,
    top: `${previousRect.top - box.top}px`,
    width: `${previousRect.width}px`,
    // The cue rule's max-width: 100% now means the overlay's new, narrower
    // box; left to it the row would wrap back down over the line beneath.
    maxWidth: 'none',
    whiteSpace: 'nowrap',
  });
  overlay.append(line);
  const animation = line.animate?.(
    [{transform: 'translateY(0)'}, {transform: `translateY(${-offset}px)`}],
    {duration: 180, easing: 'ease-out'});
  if (animation) animation.onfinish = () => line.remove();
  else line.remove();
}

/**
 * Decide which of the two visible subtitle docks a dragged cue is over.  The
 * bottom dock is raised above the controls while they show, so its hit area
 * must use the dock's own lift, `dockBottom`, rather than the physical bottom
 * edge of the player.
 */
export function subtitleDockTarget(playerRect, movedRect, dockBottom) {
  const dockZone = Math.min(140, Math.max(72, playerRect.height * .15));
  const horizontalCentre = movedRect.left + movedRect.width / 2 - playerRect.left;
  if (Math.abs(horizontalCentre - playerRect.width / 2) > playerRect.width * .25) return null;

  const topDockTop = playerRect.top + 20;
  const bottomDockTop = playerRect.bottom - dockBottom - movedRect.height;
  const topDistance = Math.abs(movedRect.top - topDockTop);
  const bottomDistance = Math.abs(movedRect.top - bottomDockTop);
  if (Math.min(topDistance, bottomDistance) > dockZone) return null;
  return topDistance <= bottomDistance ? 'top' : 'bottom';
}

/** Ignore cues that a track still reports as active after their end time. */
export function visibleSubtitleCues(textTracks, currentTime) {
  const cues = [];
  for (const track of textTracks || []) {
    if (track.mode === 'disabled') continue;
    for (const cue of track.activeCues || []) {
      if (currentTime >= cue.startTime && currentTime < cue.endTime) cues.push(cue);
    }
  }
  return cues;
}

/** Reveal WebVTT timestamped words as playback reaches them. */
export function subtitleContentAt(cue, currentTime) {
  const content = cue.getCueAsHTML();
  const result = content.ownerDocument.createDocumentFragment();
  let showing = true;
  const copy = (source, destination) => {
    for (const child of source.childNodes) {
      if (child.nodeType === 7 && child.target === 'timestamp') {
        const match = /^(\d+):(\d\d):(\d\d)\.(\d{3})$/.exec(child.data);
        if (match) showing = Number(match[1]) * 3600 + Number(match[2]) * 60
          + Number(match[3]) + Number(match[4]) / 1000 <= currentTime;
      } else if (child.nodeType === 1) {
        const element = child.cloneNode(false);
        copy(child, element);
        if (element.hasChildNodes()) destination.append(element);
      } else if (showing) {
        destination.append(child.cloneNode(true));
      }
    }
  };
  copy(content, result);
  return result;
}

/** Split explicit caption rows while keeping inline WebVTT formatting. */
export function subtitleRows(content) {
  const doc = content.ownerDocument;
  const rows = [doc.createDocumentFragment()];
  const append = (node, ancestors) => {
    let parent = rows.at(-1);
    for (const ancestor of ancestors) {
      const wrapper = ancestor.cloneNode(false);
      parent.append(wrapper);
      parent = wrapper;
    }
    parent.append(node);
  };
  const visit = (node, ancestors = []) => {
    if (node.nodeType === 3) {
      node.data.split(/\r?\n/).forEach((text, index) => {
        if (index) rows.push(doc.createDocumentFragment());
        if (text) {
          const copy = node.cloneNode(false);
          copy.data = text;
          append(copy, ancestors);
        }
      });
    } else {
      const nested = node.nodeType === 1 ? [...ancestors, node] : ancestors;
      for (const child of node.childNodes) visit(child, nested);
    }
  };
  visit(content);
  return rows.filter(row => row.textContent.trim());
}

/** The next inline word timestamp, if one is still ahead in these cues. */
export function nextSubtitleWordTime(cues, currentTime) {
  let next = Infinity;
  for (const cue of cues) {
    for (const match of (cue.text || '').matchAll(/<(\d+):(\d\d):(\d\d)\.(\d{3})>/g)) {
      const at = Number(match[1]) * 3600 + Number(match[2]) * 60
        + Number(match[3]) + Number(match[4]) / 1000;
      if (at > currentTime && at < cue.endTime && at < next) next = at;
    }
  }
  return next;
}

/**
 * Puts subtitles the viewer left somewhere of their own back where they were
 * left. That place is the box's centre, kept as a share of the player, not
 * in pixels: a zoom or a resize changes the player's size in CSS pixels, and
 * a fixed offset carried them outside it, even off the page. The centre, so a
 * longer line or a larger player grows the box evenly about where it was put,
 * as a docked cue grows about its dock, rather than away from one corner.
 * Each placing is also held inside the player, since a long line near an edge
 * can reach past it, but without overwriting the share, so the box returns
 * once there is room again.
 */
function placeFloatingSubtitles(overlay, player) {
  if (!overlay.classList.contains('is-undocked') || overlay.classList.contains('is-dragging')) return;
  const x = Number(overlay.dataset.floatX);
  const y = Number(overlay.dataset.floatY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  // Layout sizes, not the bounding box, so a docking bounce in flight does
  // not count as where the box is.
  const width = player.clientWidth;
  const height = player.clientHeight;
  const boxWidth = overlay.offsetWidth;
  const boxHeight = overlay.offsetHeight;
  overlay.style.left = `${Math.max(0, Math.min(width - boxWidth, x * width - boxWidth / 2))}px`;
  overlay.style.top = `${Math.max(0, Math.min(height - boxHeight, y * height - boxHeight / 2))}px`;
}

const AUDIO_LANGUAGE_KEY = 'archive-audio-language';

/**
 * What a language code means, so "de-DE" from a download, "de" from a site
 * and "deu" from a Matroska file are one answer. The browser knows the names
 * of all three; "und" and anything it cannot name stand for nothing, so they
 * never match each other.
 */
function languageKey(code) {
  const base = String(code || '').toLowerCase().split('-')[0];
  if (!base || base === 'und' || base === 'zxx') return '';
  try {
    const name = new Intl.DisplayNames(['en'], {type: 'language'}).of(base);
    return name && name !== base ? name : base;
  } catch { return base; }
}

/**
 * The track to play for a remembered language, among those the browser can
 * play: the same code first, then the same language however it is spelled.
 */
export function preferredAudio(tracks, language) {
  const key = languageKey(language);
  if (!key || !Array.isArray(tracks)) return null;
  const playable = tracks.filter(track => track.playable);
  const wanted = language.toLowerCase();
  return playable.find(track => track.language.toLowerCase() === wanted)
    || playable.find(track => languageKey(track.language) === key) || null;
}

// A blocked or missing store must not cost the remux, so it reads as no choice.
function rememberedAudioLanguage() {
  try { return preferences.getItem(AUDIO_LANGUAGE_KEY) || ''; } catch { return ''; }
}

/** Whether this browser says it plays an MKV of the part's codecs itself.
 *  Only "probably" counts: "maybe" is said of containers whatever is in them. */
export function playsMatroska(part, probe = globalThis.document?.createElement('video')) {
  const codecs = [part.videoCodec, part.audioCodec].filter(Boolean);
  if (!part.videoCodec || !probe?.canPlayType) return false;
  return probe.canPlayType(`video/x-matroska; codecs="${codecs.join(', ')}"`) === 'probably';
}

export class ArchiveMediaProvider extends LocalMediaProvider {
  /**
   * Where the next load should start, when the caller knows better than the
   * saved position — switching format reloads the same video and should carry
   * on where the other copy was, including inside the first few seconds that
   * are not worth saving. Consumed by the load it was set for. Zero is a
   * place like any other: a track played from an album's list starts at its
   * top, whatever was saved for it.
   */
  resumeFrom(seconds) {
    this.resumeOverride = Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  /**
   * Plays another audio track of the video on show: the next load asks for
   * that stream, and the language is remembered, so the next video that has it
   * plays it from the start. The index is only good for this file, which is
   * why it is consumed by the load it was set for, like resumeFrom.
   */
  chooseAudio(track) {
    this.audioOverride = track.index;
    try {
      if (track.language) preferences.setItem(AUDIO_LANGUAGE_KEY, track.language);
      else preferences.removeItem(AUDIO_LANGUAGE_KEY);
    } catch { /* A blocked store simply forgets the choice at reload. */ }
  }

  async resolve(item, partIndex = 0) {
    const source = await super.resolve(item, partIndex);
    const part = item.parts?.[partIndex] || item.parts?.[0] || item;
    const override = this.resumeOverride;
    this.resumeOverride = null;
    const audioIndex = this.audioOverride ?? null;
    this.audioOverride = null;
    let remux;
    // A file goes through the remux when it holds several audio tracks, which
    // a browser's own player cannot switch between, and an MKV when the
    // browser will not play it itself. Firefox once played MKV with frames
    // dropping, and every MKV was remuxed; it plays them smoothly now, and the
    // remux there costs memory for good on each seek into what is not loaded
    // (a Firefox fault in its MediaSource), gigabytes after some skipping.
    const remuxed = part.audioTrackCount > 1
      || (/\.mkv$/i.test(part.filename || '') && !playsMatroska(part));
    if (globalThis.MediaSource && source.url?.startsWith('/media/') && remuxed) {
      try {
        const key = source.url.slice('/media/'.length);
        const fetchPlan = async index => {
          const response = await fetch(`/api/playback/${key}${index === null ? '' : `?audio=${index}`}`,
            {cache: 'no-store'});
          return response.ok ? response.json() : null;
        };
        let plan = await fetchPlan(audioIndex);
        // Without a track chosen for this load, the language the viewer last
        // picked decides, when this file has it; a plan is cheap enough to
        // ask for twice, and it keeps the preference out of the player.
        if (plan && audioIndex === null) {
          const wanted = preferredAudio(plan.audioTracks, rememberedAudioLanguage());
          if (wanted && wanted.index !== plan.audio) plan = await fetchPlan(wanted.index) || plan;
        }
        if (plan && (plan.duration || source.durationSeconds) > 0 && MediaSource.isTypeSupported(plan.mime)) {
          remux = {...plan, url: `/stream/${key}`};
          source.durationSeconds = plan.duration || source.durationSeconds;
        }
      } catch { /* Native playback remains available when remuxing is unavailable. */ }
    }
    const resumeSeconds = override ?? savedPosition(item, partIndex, source.durationSeconds);
    return {...source, remux, resumeSeconds, seekPreviewUrl: part.seekPreviewUrl || item.seekPreviewUrl || '',
      subtitleTracks: part.subtitleTracks || item.parts?.[0]?.subtitleTracks || []};
  }

  /**
   * Subtitles are sidecar files the server converts to WebVTT, so they are
   * <track> children rather than anything the container carries. They are
   * replaced with the source: a leftover track from the last video would keep
   * showing its captions over this one. All of them start off, and the player
   * turns one on — which language, if any, is the viewer's choice.
   */
  attach(video, source) {
    source.video = video;
    // The controller draws the audio menu from this, the way it redraws
    // captions on archive-subtitles-change; a file with one track says none.
    video.dispatchEvent(new CustomEvent('archive-audio-tracks', {detail: {
      tracks: source.remux?.audioTracks || [], current: source.remux?.audio ?? null}}));
    this.subtitleResizeObserver?.disconnect();
    this.subtitleListeners?.abort();
    clearTimeout(this.subtitleWordTimer);
    this.subtitleListeners = new AbortController();
    const player = video.closest?.('.media-player');
    const controls = player?.querySelector('.media-player-controls');
    let overlay = player?.querySelector('.archive-subtitles');
    if (player && !overlay) {
      overlay = document.createElement('div');
      overlay.className = 'archive-subtitles';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.title = t('subtitles.dragHint');
      player.append(overlay);
    }
    let dockPlaceholder = player?.querySelector('.archive-subtitle-dock-placeholder');
    if (player && !dockPlaceholder) {
      dockPlaceholder = document.createElement('div');
      dockPlaceholder.className = 'archive-subtitle-dock-placeholder';
      dockPlaceholder.hidden = true;
      player.append(dockPlaceholder);
    }
    if (overlay && !overlay.dataset.draggable) {
      overlay.dataset.draggable = 'true';
      let drag = null;
      const dock = (edge = 'bottom') => {
        const from = overlay.getBoundingClientRect();
        overlay.classList.remove('is-undocked');
        overlay.classList.toggle('is-docked-top', edge === 'top');
        delete overlay.dataset.floatX;
        delete overlay.dataset.floatY;
        for (const property of ['left', 'top', 'right', 'bottom']) {
          overlay.style.removeProperty(property);
        }
        dockPlaceholder.hidden = true;
        const to = overlay.getBoundingClientRect();
        if (!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          const offsetX = from.left - to.left;
          const offsetY = from.top - to.top;
          const distance = Math.hypot(offsetX, offsetY);
          const bounceX = distance ? -offsetX / distance * 4 : 0;
          const bounceY = distance ? -offsetY / distance * 4 : 0;
          overlay.getAnimations?.().forEach(animation => animation.cancel());
          overlay.animate?.([
            {translate: `${offsetX}px ${offsetY}px`},
            {translate: '0 0', offset: .78},
            {translate: `${bounceX}px ${bounceY}px`, offset: .9},
            {translate: '0 0'},
          ], {duration: 380, easing: 'cubic-bezier(.22,.8,.25,1)'});
        }
      };
      overlay.addEventListener('pointerdown', event => {
        if (!overlay.hasChildNodes() || event.button !== 0) return;
        event.stopPropagation();
        const playerRect = player.getBoundingClientRect();
        const rect = overlay.getBoundingClientRect();
        const originDock = overlay.classList.contains('is-undocked') ? null
          : overlay.classList.contains('is-docked-top') ? 'top' : 'bottom';
        drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          left: rect.left - playerRect.left, top: rect.top - playerRect.top,
          originDock, leftOrigin: false, dockTarget: null};
        overlay.classList.add('is-undocked', 'is-dragging');
        overlay.style.left = `${drag.left}px`;
        overlay.style.top = `${drag.top}px`;
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        overlay.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      overlay.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.stopPropagation();
        const playerRect = player.getBoundingClientRect();
        const rect = overlay.getBoundingClientRect();
        const left = Math.max(0, Math.min(playerRect.width - rect.width,
          drag.left + event.clientX - drag.x));
        const top = Math.max(0, Math.min(playerRect.height - rect.height,
          drag.top + event.clientY - drag.y));
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        const movedRect = overlay.getBoundingClientRect();
        // The stylesheet decides where the bottom dock rests, from whether the
        // bar is showing; custom properties do not transition, so this is
        // where it is going rather than a frame of it getting there.
        const dockBottom = parseFloat(getComputedStyle(player)
          .getPropertyValue('--subtitle-dock-bottom')) || 20;
        const target = subtitleDockTarget(playerRect, movedRect, dockBottom);
        if (target !== drag.originDock) drag.leftOrigin = true;
        drag.dockTarget = target && (target !== drag.originDock || drag.leftOrigin) ? target : null;
        dockPlaceholder.hidden = !drag.dockTarget;
        if (drag.dockTarget) {
          dockPlaceholder.classList.toggle('is-top', drag.dockTarget === 'top');
          dockPlaceholder.style.width = `${movedRect.width}px`;
          dockPlaceholder.style.height = `${movedRect.height}px`;
        }
      });
      const finishDrag = event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.stopPropagation();
        const {dockTarget} = drag;
        drag = null;
        overlay.classList.remove('is-dragging');
        overlay.releasePointerCapture?.(event.pointerId);
        dockPlaceholder.hidden = true;
        if (dockTarget) dock(dockTarget);
        else {
          overlay.dataset.floatX = String(
            (parseFloat(overlay.style.left) + overlay.offsetWidth / 2) / player.clientWidth);
          overlay.dataset.floatY = String(
            (parseFloat(overlay.style.top) + overlay.offsetHeight / 2) / player.clientHeight);
        }
        // cuechange may have tried to clear the caption while it was being
        // held. Reconcile it now that releasing cannot collapse the drag.
        renderCues();
      };
      overlay.addEventListener('pointerup', finishDrag);
      overlay.addEventListener('pointercancel', finishDrag);
      // The player treats a click on its picture as play/pause. A completed
      // subtitle drag produces one too, so keep both clicks inside the overlay.
      overlay.addEventListener('click', event => event.stopPropagation());
      overlay.addEventListener('dblclick', event => {
        event.stopPropagation();
        dock('bottom');
      });
    }
    // A new track may take a moment to load; do not leave the previous
    // video's final cue on screen during that gap.
    overlay?.replaceChildren();
    const placeOverlay = () => {
      if (!overlay || !player || !controls) return;
      const playerRect = player.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const videoRect = video.getBoundingClientRect();
      player.style.setProperty('--subtitle-video-bottom',
        `${Math.max(20, playerRect.bottom - videoRect.bottom + 20)}px`);
      player.style.setProperty('--subtitle-controls-bottom',
        `${Math.max(20, playerRect.bottom - controlsRect.top + 20)}px`);
      placeFloatingSubtitles(overlay, player);
    };
    let renderedLines = [];
    let emptySince = null;
    const renderCues = (event) => {
      if (!overlay) return;
      clearTimeout(this.subtitleWordTimer);
      const cues = visibleSubtitleCues(video.textTracks, video.currentTime);
      const lines = [];
      const previousTops = new Map();
      const previousRects = new Map();
      const animateMovement = !video.seeking && event?.type !== 'seeked'
        && !overlay.classList.contains('is-dragging')
        && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (animateMovement) {
        for (const line of renderedLines) {
          const rect = line.getBoundingClientRect();
          previousTops.set(line, rect.top);
          previousRects.set(line, rect);
        }
      }
      let changed = false;
      const availableLines = new Set(renderedLines);
      const settled = animateMovement && !video.paused;
      const contents = cues.flatMap(cue => {
        const rows = subtitleRows(subtitleContentAt(cue, video.currentTime));
        return settled && isRepeatedSubtitleBlip(cue, rows, renderedLines) ? [] : rows;
      });
      for (const content of contents) {
        let line = continuingSubtitleLine(availableLines, content.textContent);
        // Follow the visible row across replacement cues and row indexes.
        availableLines.delete(line);
        if (!line) {
          line = document.createElement('span');
          line.className = 'archive-subtitle-cue';
          changed = true;
        }
        // Leave an unchanged cue and its in-flight animation alone between
        // word timestamps. The fragment preserves WebVTT inline formatting.
        if (line.textContent !== content.textContent || !line.hasChildNodes()) {
          line.replaceChildren(content);
          changed = true;
        }
        lines.push(line);
      }
      const nextWord = nextSubtitleWordTime(cues, video.currentTime);
      if (!video.paused && video.playbackRate > 0 && Number.isFinite(nextWord)) {
        this.subtitleWordTimer = setTimeout(renderCues,
          Math.max(10, (nextWord - video.currentTime) * 1000 / video.playbackRate + 10));
      }
      // Keep the grabbed cue under the pointer through a gap between cues;
      // otherwise its box and the dock target both collapse mid-drag. Only
      // while it is held: undocked alone is also a cue left where it was
      // dropped, which would then keep its last line up through every pause.
      if (!lines.length && overlay.classList.contains('is-dragging')) return;
      // Rolling captions can hand over between cues with a gap of a few
      // milliseconds. Emptying the overlay for that long drops its backing for
      // a frame or two, so wait out short gaps before clearing during playback.
      if (lines.length) emptySince = null;
      else if (renderedLines.length && animateMovement && !video.paused
        && event?.type !== 'archive-subtitles-change') {
        emptySince ??= performance.now();
        const waited = performance.now() - emptySince;
        if (waited < SUBTITLE_GAP_GRACE_MS) {
          this.subtitleWordTimer = setTimeout(renderCues, SUBTITLE_GAP_GRACE_MS - waited + 5);
          return;
        }
      }
      if (!lines.length) emptySince = null;
      changed ||= lines.length !== renderedLines.length
        || lines.some((line, index) => line !== renderedLines[index]);
      if (changed || !animateMovement) {
        for (const line of renderedLines) {
          line.getAnimations?.().forEach(animation => animation.cancel());
        }
      }
      if (!changed) return;
      const departing = renderedLines.filter(line => !lines.includes(line));
      overlay.replaceChildren(...lines);
      renderedLines = lines;
      if (player) placeFloatingSubtitles(overlay, player);
      // Use a surviving row's visual position as the offset for every row.
      // New text then joins the same slide without colliding with older text.
      if (animateMovement) {
        const offset = slideSubtitleRows(lines, previousTops);
        if (offset && lines.length) {
          for (const line of departing) {
            slideOutSubtitleRow(overlay, line, previousRects.get(line), offset);
          }
        }
      }
    };
    // TextTrack mode changes do not consistently emit cuechange, especially
    // while disabling an active cue. The controller emits this after applying
    // the subtitle selection so Off clears the custom overlay immediately.
    for (const event of ['archive-subtitles-change', 'timeupdate', 'seeked', 'playing', 'ratechange']) {
      video.addEventListener(event, renderCues, {signal: this.subtitleListeners.signal});
    }
    if (controls && globalThis.ResizeObserver) {
      this.subtitleResizeObserver = new globalThis.ResizeObserver(placeOverlay);
      this.subtitleResizeObserver.observe(player);
      this.subtitleResizeObserver.observe(controls);
      this.subtitleResizeObserver.observe(video);
    }
    placeOverlay();
    video.replaceChildren(...(source.subtitleTracks || []).map(entry => {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = entry.language;
      track.label = entry.label;
      track.src = entry.url;
      track.addEventListener('load', () => {
        track.track.addEventListener('cuechange', renderCues);
        renderCues();
      });
      return track;
    }));
    if (source.remux) {
      source.remuxPlayback = new RemuxPlayback(video, source, () => {
        video.dispatchEvent(new Event('error'));
      });
    } else {
      video.src = source.url;
      video.load();
    }
  }

  async release(source) {
    source.remuxPlayback?.close();
  }

  reportPlayback({item, partIndex = 0, source, positionSeconds, durationSeconds, reason}) {
    // A close during loading must not replace the saved position with zero.
    if (!source.video?.readyState || !Number.isFinite(positionSeconds) || positionSeconds < 0) return;
    try {
      const key = positionKey(item, partIndex);
      if (reason === 'ended' || source.video.ended
          || !resumablePosition(positionSeconds, durationSeconds)) {
        preferences.removeItem(key);
      } else {
        preferences.setItem(key, String(positionSeconds));
      }
      globalThis.window?.dispatchEvent(new Event('archive-playback-change'));
    } catch { /* A full or blocked store must not interrupt playback. */ }
  }

  // Returning null simply leaves the time bubble without a picture, so every
  // failure here is silent by design.
  async resolveSeekPreview(source) {
    if (!source.seekPreviewUrl) return null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      let sheet;
      try {
        const response = await fetch(source.seekPreviewUrl, {cache: 'no-store'});
        if (!response.ok) return null;
        sheet = await response.json();
      } catch {
        return null;
      }
      if (sheet.state === 'ready') return sheet;
      if (sheet.state !== 'queued' && sheet.state !== 'running') return null;
      await wait(Number(sheet.retryAfterMs) || 700);
    }
    return null;
  }
}
