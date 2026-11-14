import {formatPlayerTime, tileBackgroundPosition} from 'media-ui';
import {iconMarkup} from './icon.js';
import {SPEED_GLYPH_MARKUP} from './player-speed-glyph.js';
import {createDrawerControls} from './drawer.js';
import {t} from './i18n.js';
import {
  FAST_SPEED_DEFAULT, FAST_SPEEDS, loadCategoryActions, loadChannelOverrides,
  loadSponsorBlockEnabled, saveCategoryActions, saveChannelOverrides, saveSponsorBlockEnabled,
  segmentActionAt, sponsorModeLabels, sponsorBlockEnabledFor,
} from './sponsorblock-settings.js';
import {
  activeChapterIndex, sponsorCategories, SPONSOR_COLOURS, sponsorGradient,
  sponsorSegments,
} from './watch-details.js';

export function createPlayerTimeline({
  page, element, mediaPlayer, seekInput,
  chapterMarkers, halfThumb, onAspect,
}) {
  let chapters = [];
  let chapterDuration = 0;
  let activeChapter = -1;
  let hoveredChapter = -1;

  const chapterDots = () => chapterMarkers.children;
  // A chapter starting at zero gets no dot, so the dots are not one per
  // chapter: each carries the chapter it belongs to rather than relying on
  // its position in the row.
  const dotFor = index => chapterMarkers.querySelector(`[data-index="${index}"]`);

  function markActiveChapter() {
    const index = activeChapterIndex(chapters, mediaPlayer.absoluteTime());
    if (index === activeChapter) return;
    dotFor(activeChapter)?.classList.remove('is-active');
    dotFor(index)?.classList.add('is-active');
    activeChapter = index;
  }

  // The player owns the element, so follow its clock rather than polling.
  mediaPlayer.video.addEventListener('timeupdate', markActiveChapter);
  // A sidecar duration can disagree with the file; once the real one is known
  // the dots move to where they actually belong.
  mediaPlayer.video.addEventListener('loadedmetadata', () => {
    const {videoWidth, videoHeight} = mediaPlayer.video;
    if (videoWidth > 0 && videoHeight > 0) onAspect(`${videoWidth} / ${videoHeight}`);
    const duration = Number(mediaPlayer.video.duration);
    if (Number.isFinite(duration) && duration > 0 && duration !== chapterDuration) {
      drawChapterMarkers(duration);
      drawSponsorSegments(duration);
    }
  });

  let sponsorData = [];
  let sponsorShown = [];
  let sponsorRequest = 0;
  let sponsorItem = null;
  let sponsorGlobalEnabled = loadSponsorBlockEnabled();
  const sponsorChannelOverrides = loadChannelOverrides();
  let sponsorEnabled = sponsorGlobalEnabled;
  let sponsorVideoOverride = null;
  let sponsorChannelKey = '';
  let sponsorChannelName = '';

  function updatePlayheadColour() {
    const position = Number(seekInput.value) / Number(seekInput.max) * 100;
    // Match the gradient's precedence where segments overlap.
    const segment = sponsorShown.find(entry => position >= entry.left
      && (position < entry.left + entry.width
        || (position === 100 && entry.left + entry.width >= 100)));
    seekInput.style.setProperty('--archive-playhead-colour', segment
      ? `color-mix(in srgb, ${SPONSOR_COLOURS[segment.category]} 90.196%, var(--range-accent))`
      : 'var(--range-accent)');
  }
  seekInput.addEventListener('input', updatePlayheadColour);
  for (const event of ['timeupdate', 'loadedmetadata', 'seeking', 'seeked', 'emptied']) {
    mediaPlayer.video.addEventListener(event, updatePlayheadColour);
  }

  /** The SponsorBlock stretches, painted into the bar's own background so
   *  the playhead's ring passes over them rather than under. */
  function drawSponsorSegments(duration) {
    sponsorShown = sponsorEnabled ? sponsorSegments(sponsorData, duration).sort((a, b) => a.left - b.left) : [];
    seekInput.style.setProperty('--range-segments', sponsorGradient(sponsorShown));
    updatePlayheadColour();
  }

  // A segment the viewer seeks into is one they chose to watch, so it plays
  // through; only playing into a segment from outside it acts on it. Held as
  // the segment's start, since the objects are rebuilt whenever the bar
  // redraws. The exemption is taken on `seeking`, not `seeked`: a seek fires
  // `timeupdate` at the new time before `seeked`, which would skip first.
  let sponsorExemptStart = null;
  // The segment a "skip?" offer is currently about, and the speed we imposed
  // for a fast forward, so ours is the only rate we ever put back.
  let promptSegment = null;
  let sponsorRate = null;

  // The offer for a category set to notify: a pill over the controls naming
  // the segment, with the skip a click away. Dismissing it exempts that
  // segment, so it does not come straight back a tick later.
  const sponsorPrompt = document.createElement('div');
  sponsorPrompt.className = 'archive-sponsor-prompt';
  sponsorPrompt.hidden = true;
  const promptLabel = document.createElement('span');
  promptLabel.className = 'archive-sponsor-prompt-label';
  const promptSkip = document.createElement('button');
  promptSkip.type = 'button';
  promptSkip.className = 'archive-sponsor-prompt-skip';
  promptSkip.textContent = t('sponsor.mode.skip');
  const promptDismiss = document.createElement('button');
  promptDismiss.type = 'button';
  promptDismiss.className = 'archive-sponsor-prompt-dismiss';
  promptDismiss.setAttribute('aria-label', t('sponsor.keepPlaying'));
  promptDismiss.innerHTML = iconMarkup('x');
  sponsorPrompt.append(promptLabel, promptSkip, promptDismiss);
  // The pill sits over the picture, where the shared player's own click
  // toggles play; answering the offer is not a click on the video, so it must
  // not also pause. That listener is on the player's root, so stopping the
  // click here keeps it from ever arriving.
  sponsorPrompt.addEventListener('click', event => event.stopPropagation());
  element.append(sponsorPrompt);

  // What a fast forward looks like from the picture: the same badge a hold
  // wears, at the top of the player, naming the category being run past.
  const sponsorChip = document.createElement('div');
  sponsorChip.className = 'archive-sponsor-speeding';
  sponsorChip.hidden = true;
  sponsorChip.setAttribute('aria-hidden', 'true');
  sponsorChip.innerHTML = `${SPEED_GLYPH_MARKUP}<span class="archive-sponsor-speeding-label"></span>`;
  const sponsorChipLabel = sponsorChip.querySelector('.archive-sponsor-speeding-label');
  element.append(sponsorChip);

  function drawSponsorChip(segment, speed) {
    sponsorChipLabel.textContent =
      t('sponsor.segmentSpeed', {label: sponsorCategories()[segment.category] || t('sponsor.segment'), speed});
    sponsorChip.hidden = false;
  }

  function hideSponsorPrompt() {
    promptSegment = null;
    sponsorPrompt.hidden = true;
  }

  function showSponsorPrompt(segment) {
    if (promptSegment?.start === segment.start
        && promptSegment.category === segment.category) return;
    promptSegment = segment;
    promptLabel.textContent = t('sponsor.ahead', {label: sponsorCategories()[segment.category] || t('sponsor.segment')});
    sponsorPrompt.hidden = false;
  }

  promptSkip.addEventListener('click', () => {
    const video = mediaPlayer.video;
    if (promptSegment) {
      video.currentTime = Math.min(promptSegment.end, video.duration || promptSegment.end);
    }
    hideSponsorPrompt();
  });
  promptDismiss.addEventListener('click', () => {
    sponsorExemptStart = promptSegment?.start ?? null;
    hideSponsorPrompt();
  });

  const sponsorActions = loadCategoryActions();
  const sponsorDrawer = document.querySelector('#sponsorblock-drawer');
  const sponsorDrawerControls = createDrawerControls(sponsorDrawer);
  const sponsorGlobalToggle = sponsorDrawer.querySelector('[data-sponsorblock-global]');
  const sponsorOptions = sponsorDrawer.querySelector('[data-sponsorblock-options]');
  const sponsorOverrideList = sponsorDrawer.querySelector('[data-sponsorblock-overrides]');
  const sponsorOverrideEmpty = sponsorDrawer.querySelector('[data-sponsorblock-overrides-empty]');
  const sponsorOverrideSearch = sponsorDrawer.querySelector('[data-sponsorblock-overrides-search]');
  const sponsorPlayerRow = page.querySelector('[data-sponsorblock-player-row]');
  // The menu's row and its SponsorBlock page each have the switch for this
  // video, and both say the same.
  const sponsorVideoToggles = page.querySelectorAll('[data-sponsorblock-video-toggle]');
  const sponsorChannelSelect = page.querySelector('[data-sponsorblock-channel-select]');
  const sponsorChannelLabel = page.querySelector('[data-sponsorblock-channel-label]');
  const sponsorSource = page.querySelector('[data-sponsorblock-source]');

  const inheritedSponsorEnabled = () => sponsorBlockEnabledFor(
    sponsorChannelKey, sponsorGlobalEnabled, sponsorChannelOverrides,
  );

  function drawChannelOverrides() {
    const query = sponsorOverrideSearch.value.trim().toLocaleLowerCase();
    const saved = [...sponsorChannelOverrides.entries()];
    const rows = saved.filter(([, override]) => override.name.toLocaleLowerCase().includes(query)).sort((a, b) =>
      a[1].name.localeCompare(b[1].name)).map(([key, override]) => {
      const row = document.createElement('div');
      row.className = 'sponsorblock-override-row';
      const text = document.createElement('span');
      text.innerHTML = '<strong></strong><small></small>';
      text.querySelector('small').textContent = t(override.enabled ? 'sponsor.alwaysOn' : 'sponsor.alwaysOff');
      text.querySelector('strong').textContent = override.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = t('sponsor.useDefault');
      remove.addEventListener('click', () => {
        sponsorChannelOverrides.delete(key);
        saveChannelOverrides(sponsorChannelOverrides);
        if (key === sponsorChannelKey) applySponsorPreference();
        drawChannelOverrides();
      });
      row.append(text, remove);
      return row;
    });
    sponsorOverrideList.replaceChildren(...rows);
    // Searching nothing is pointless, so the box only appears once there is something to find.
    sponsorOverrideSearch.hidden = !saved.length;
    sponsorOverrideEmpty.textContent = saved.length ? t('sponsor.noMatch') : t('sponsor.noOverrides');
    sponsorOverrideEmpty.hidden = Boolean(rows.length);
  }

  /** Off hides the segments, stops skipping and stops asking SponsorBlock at
   *  all; the per-category choices are kept for when it is switched back on. */
  function drawSponsorEnabled() {
    sponsorGlobalToggle.setAttribute('aria-checked', String(sponsorGlobalEnabled));
    sponsorOptions.disabled = !sponsorGlobalEnabled;
    for (const toggle of sponsorVideoToggles) toggle.setAttribute('aria-checked', String(sponsorEnabled));
    const channel = sponsorChannelOverrides.get(sponsorChannelKey);
    sponsorChannelSelect.value = channel ? (channel.enabled ? 'on' : 'off') : 'default';
    sponsorChannelLabel.textContent = t('sponsor.channelDefault', {name: sponsorChannelName || t('sponsor.this')});
    sponsorSource.textContent = sponsorVideoOverride !== null ? t('sponsor.overriddenVideo')
      : channel ? t('sponsor.channelOverride', {state: t(channel.enabled ? 'common.onLower' : 'common.offLower')})
        : t('sponsor.globalSetting', {state: t(sponsorGlobalEnabled ? 'common.onLower' : 'common.offLower')});
    if (!sponsorEnabled) hideSponsorPrompt();
  }
  function applySponsorPreference() {
    sponsorEnabled = sponsorVideoOverride ?? inheritedSponsorEnabled();
    drawSponsorEnabled();
    if (sponsorItem) loadSponsorSegments(sponsorItem);
  }
  drawSponsorEnabled();
  sponsorGlobalToggle.addEventListener('click', () => {
    sponsorGlobalEnabled = !sponsorGlobalEnabled;
    saveSponsorBlockEnabled(sponsorGlobalEnabled);
    applySponsorPreference();
  });
  for (const toggle of sponsorVideoToggles) {
    toggle.addEventListener('click', () => {
      sponsorVideoOverride = !sponsorEnabled;
      applySponsorPreference();
    });
  }
  sponsorChannelSelect.addEventListener('change', () => {
    if (sponsorChannelSelect.value === 'default') sponsorChannelOverrides.delete(sponsorChannelKey);
    else sponsorChannelOverrides.set(sponsorChannelKey, {
      enabled: sponsorChannelSelect.value === 'on', name: sponsorChannelName || sponsorChannelKey,
    });
    saveChannelOverrides(sponsorChannelOverrides);
    sponsorVideoOverride = null;
    drawChannelOverrides();
    applySponsorPreference();
  });
  sponsorDrawer.querySelector('[data-sponsorblock-close]').addEventListener('click', sponsorDrawerControls.close);
  sponsorOverrideSearch.addEventListener('input', drawChannelOverrides);
  drawChannelOverrides();

  /** One row per category: the familiar SponsorBlock colour and a compact
   *  segmented control. Icon buttons make the four actions comparable at a
   *  glance; fast-forward reveals its own small stepped speed control. */
  const redrawSponsorRows = [];
  sponsorDrawer.querySelector('[data-sponsorblock-rows]').replaceChildren(
    ...Object.entries(sponsorCategories()).map(([category, label]) => {
      const row = document.createElement('div');
      row.className = 'sponsorblock-option';
      row.style.setProperty('--sponsor-category-colour', SPONSOR_COLOURS[category]);
      const swatch = document.createElement('span');
      swatch.className = 'sponsorblock-swatch';
      swatch.style.background = SPONSOR_COLOURS[category];
      const name = document.createElement('span');
      name.className = 'sponsorblock-option-name';
      name.textContent = label;

      const modes = document.createElement('div');
      modes.className = 'sponsorblock-modes';
      modes.setAttribute('role', 'radiogroup');
      modes.setAttribute('aria-label', t('sponsor.segmentsLabel', {label}));
      const modeIcons = {
        play: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7l-11 7z"/></svg>',
        fast: '<svg viewBox="0 0 24 24"><path d="M3 5l8 7l-8 7zM12 5l8 7l-8 7z"/></svg>',
        notify: '<svg viewBox="0 0 24 24"><path d="M14.235 19c.865 0 1.322 1.024 .745 1.668a3.992 3.992 0 0 1-2.98 1.332a3.992 3.992 0 0 1-2.98-1.332c-.552-.616-.158-1.579.634-1.661l.11-.006h4.471z"/><path d="M12 2c1.358 0 2.506.903 2.875 2.141l.046.171l.008.043a8.013 8.013 0 0 1 4.024 6.069l.028.287l.019.289v2.931l.021.136a3 3 0 0 0 1.143 1.847l.167.117l.162.099c.86.487.56 1.766-.377 1.864l-.116.006h-16c-1.028 0-1.387-1.364-.493-1.87a3 3 0 0 0 1.472-2.063l.021-.143l.001-2.97a8 8 0 0 1 3.821-6.454l.248-.146l.01-.043a3.003 3.003 0 0 1 2.562-2.29l.182-.017l.176-.004z"/></svg>',
        skip: '<svg viewBox="0 0 24 24"><path d="M5 17a7 7 0 0 1 11-8l2 2M18 6v5h-5M19 15v4"/></svg>',
      };
      const modeLabels = sponsorModeLabels();
      const modeButtons = new Map(['play', 'notify', 'skip', 'fast'].map(value => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.mode = value;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-label', modeLabels[value]);
        button.title = modeLabels[value];
        button.innerHTML = modeIcons[value];
        modes.append(button);
        return [value, button];
      }));

      const speedControl = document.createElement('label');
      speedControl.className = 'sponsorblock-speed-control';
      const speed = document.createElement('input');
      speed.type = 'range';
      speed.min = '0';
      speed.max = String(FAST_SPEEDS.length - 1);
      speed.step = '1';
      speed.setAttribute('aria-label', t('sponsor.speedLabel', {label}));
      const speedValue = document.createElement('output');
      speedControl.append(speed, speedValue);

      function drawRow() {
        const action = sponsorActions.get(category) || {mode: 'play'};
        for (const [value, button] of modeButtons) {
          button.setAttribute('aria-checked', String(action.mode === value));
        }
        const chosenSpeed = action.mode === 'fast' ? action.speed : FAST_SPEED_DEFAULT;
        const speedIndex = Math.max(0, FAST_SPEEDS.indexOf(chosenSpeed));
        speed.value = String(speedIndex);
        speed.style.setProperty('--sponsor-speed-fill', `${speedIndex * 100 / (FAST_SPEEDS.length - 1)}%`);
        speedValue.value = speedValue.textContent = `${chosenSpeed}x`;
        speed.disabled = action.mode !== 'fast';
        speedControl.classList.toggle('is-disabled', action.mode !== 'fast');
      }
      drawRow();
      redrawSponsorRows.push(drawRow);
      function change(mode) {
        if (mode === 'play') sponsorActions.delete(category);
        else if (mode === 'fast') {
          sponsorActions.set(category, {mode, speed: FAST_SPEEDS[Number(speed.value)]});
        } else sponsorActions.set(category, {mode});
        saveCategoryActions(sponsorActions);
        drawRow();
        // A category the viewer has just taken off duty should stop asking.
        if (promptSegment && promptSegment.category === category) hideSponsorPrompt();
      }
      for (const [value, button] of modeButtons) button.addEventListener('click', () => change(value));
      speed.addEventListener('input', () => change('fast'));
      row.append(swatch, name, modes, speedControl);
      return row;
    }));

  // Back to how SponsorBlock starts out. Channel overrides are left alone:
  // they are exceptions, each with a "Use default" of its own below.
  sponsorDrawer.querySelector('[data-sponsorblock-reset]').addEventListener('click', () => {
    sponsorActions.clear();
    saveCategoryActions(sponsorActions);
    for (const redraw of redrawSponsorRows) redraw();
    hideSponsorPrompt();
    sponsorGlobalEnabled = true;
    saveSponsorBlockEnabled(true);
    applySponsorPreference();
  });

  mediaPlayer.video.addEventListener('seeking', () => {
    sponsorExemptStart =
      segmentActionAt(sponsorShown, mediaPlayer.video.currentTime, sponsorActions)?.segment.start
      ?? null;
    hideSponsorPrompt();
  });

  /** Puts back whatever the video was playing at before a fast forward, but
   *  only if the rate is still the one we set: a hold-to-speed since then is
   *  the viewer's own and is left to the hold to undo. */
  function endSponsorFastForward() {
    sponsorChip.hidden = true;
    if (!sponsorRate) return;
    const video = mediaPlayer.video;
    if (video.playbackRate === sponsorRate.rate) video.playbackRate = sponsorRate.previous;
    sponsorRate = null;
  }

  // Only while playing, so pausing inside a segment to look at it is left be.
  mediaPlayer.video.addEventListener('timeupdate', () => {
    const video = mediaPlayer.video;
    // Nor mid-seek or while the bar is being dragged, when the time is only
    // passing through on its way to wherever the viewer lets go.
    if (video.paused || video.seeking || mediaPlayer.scrubbing || !sponsorEnabled) {
      return;
    }
    const acted = segmentActionAt(sponsorShown, video.currentTime, sponsorActions);
    if (!acted || acted.segment.start === sponsorExemptStart) {
      if (!acted) hideSponsorPrompt();
      endSponsorFastForward();
      return;
    }
    sponsorExemptStart = null;
    if (acted.mode === 'skip') {
      endSponsorFastForward();
      hideSponsorPrompt();
      video.currentTime = Math.min(acted.segment.end, video.duration || acted.segment.end);
    } else if (acted.mode === 'fast') {
      hideSponsorPrompt();
      drawSponsorChip(acted.segment, acted.speed);
      if (sponsorRate?.rate !== acted.speed) {
        // The rate to come back to is the one playing before the segment, not
        // whatever a previous segment left behind.
        const previous = sponsorRate ? sponsorRate.previous : video.playbackRate;
        video.playbackRate = acted.speed;
        sponsorRate = {rate: acted.speed, previous};
      }
    } else {
      endSponsorFastForward();
      showSponsorPrompt(acted.segment);
    }
  });

  /** Segments come from the server, which asks SponsorBlock; a slow or failed
   *  lookup just leaves the bar plain, and a stale answer is ignored. */
  async function loadSponsorSegments(item) {
    const request = ++sponsorRequest;
    sponsorItem = item;
    sponsorExemptStart = null;
    sponsorData = [];
    drawSponsorSegments(0);
    const url = item.archive?.sponsorBlockUrl;
    sponsorPlayerRow.hidden = !url;
    if (!url || !sponsorEnabled) return;
    try {
      const response = await fetch(url);
      const segments = response.ok ? await response.json() : [];
      if (request !== sponsorRequest) return;
      sponsorData = segments;
      drawSponsorSegments(chapterDuration || Number(mediaPlayer.video.duration)
        || Number(item.durationSeconds) || 0);
    } catch {
      // Leave the bar without segments.
    }
  }

  /** One dot per chapter, placed as a percentage of the run. A chapter that
   *  starts at zero marks nothing a viewer can seek to, so it is left out. */
  function drawChapterMarkers(duration) {
    chapterDuration = duration;
    activeChapter = -1;
    hoveredChapter = -1;
    chapterMarkers.replaceChildren(...(duration > 0 ? chapters : []).map((chapter, index) => {
      const dot = document.createElement('span');
      dot.className = 'archive-chapter-dot';
      dot.style.left = `${Math.min(100, chapter.startSeconds * 100 / duration)}%`;
      dot.dataset.index = index;
      return dot;
    }).filter((_, index) => chapters[index].startSeconds > 0));
    markActiveChapter();
  }

  function drawChapters(details, durationSeconds) {
    chapters = details.chapters;
    drawChapterMarkers(Number(durationSeconds) || 0);
  }

  // Two radii: the wider one only brightens a dot as the pointer approaches,
  // the tighter one is what actually names the chapter.
  const NEAR_RADIUS = 30;
  const SNAP_RADIUS = 9;

  const dotCentre = (dot, rect) => rect.left + rect.width * parseFloat(dot.style.left) / 100;

  /** The dot nearest the pointer, with how far away it is. */
  function chapterAt(clientX) {
    const rect = chapterMarkers.getBoundingClientRect();
    let nearest = -1;
    let distance = NEAR_RADIUS;
    for (const [index, dot] of [...chapterDots()].entries()) {
      const gap = Math.abs(clientX - dotCentre(dot, rect));
      if (gap <= distance) { nearest = index; distance = gap; }
    }
    return {index: nearest, distance};
  }

  function clearChapterHover() {
    for (const dot of chapterDots()) dot.classList.remove('is-near', 'is-hovered');
    hoveredChapter = -1;
  }

  /**
   * Bound after the player's own seek listeners, so this runs last and can
   * rewrite what its preview says. The bubble stays the player's own — same
   * shape, same frame above it — with the chapter's name added to the time it
   * already shows, and the frame snapped to where that chapter starts.
   */
  seekInput.addEventListener('pointermove', event => {
    const {index, distance} = chapterAt(event.clientX);
    clearChapterHover();
    labelSponsorSegment(event.clientX);
    if (index < 0) return;
    const dot = chapterDots()[index];
    dot.classList.add(distance <= SNAP_RADIUS ? 'is-hovered' : 'is-near');
    if (distance > SNAP_RADIUS) return;
    hoveredChapter = index;
    const chapter = chapters[Number(dot.dataset.index)];
    const duration = chapterDuration || Number(mediaPlayer.video.duration) || 0;
    const ratio = duration ? chapter.startSeconds / duration : 0;
    mediaPlayer.previewTime.textContent =
      `${formatPlayerTime(chapter.startSeconds)} · ${chapter.title}`;
    if (mediaPlayer.seekPreview) {
      mediaPlayer.previewImage.style.backgroundPosition =
        tileBackgroundPosition(mediaPlayer.seekPreview, ratio);
    }
  });
  seekInput.addEventListener('pointerleave', clearChapterHover);

  /** Names the SponsorBlock category under the pointer beside the preview time. */
  function labelSponsorSegment(clientX) {
    if (!sponsorShown.length) return;
    const rect = seekInput.getBoundingClientRect();
    const inset = halfThumb();
    const width = rect.width - 2 * inset;
    const percent = width > 0 ? (clientX - rect.left - inset) * 100 / width : -1;
    const segment = sponsorShown.find(entry =>
      percent >= entry.left && percent <= entry.left + entry.width);
    if (segment) mediaPlayer.previewTime.textContent += ` · ${segment.label}`;
  }

  return {
    drawChapters, loadSponsorSegments,
    openSponsorBlock: sponsorDrawerControls.open,
    setItem(item) {
      sponsorVideoOverride = null;
      sponsorChannelKey = String(item.facets?.owner?.id || item.facets?.owner?.name || '');
      sponsorChannelName = String(item.facets?.owner?.name || '');
      sponsorEnabled = inheritedSponsorEnabled();
      drawSponsorEnabled();
    },
  };
}
