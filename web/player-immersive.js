import {preferences} from './preferences.js';
import {plural, t} from './i18n.js';

const DELAY_KEY = 'archive-immersive-delay';
export function immersiveDelayMs(value) {
  const seconds = value == null || value === '' ? 20 : Number(value);
  return [0, 2, 5, 10, 20, 30].includes(seconds) ? seconds * 1000 : 20_000;
}

/** Bounds after scaling around the stage's bottom centre, then translating. */
export function immersiveOverlapsLogo(rect, logo, scale, drop) {
  const left = rect.left - rect.width * (scale - 1) / 2;
  const top = rect.top - rect.height * (scale - 1) + drop;
  return left < logo.right && left + rect.width * scale > logo.left
    && top < logo.bottom && top + rect.height * scale > logo.top;
}

/**
 * How far the stage grows (`extra` pixels of height, as `scale`) and comes
 * down (`drop`) for a stage at `rect` in a window `width` by `height`.
 * `headBottom` is the foot of the title block as laid out before immersion,
 * or null where there is none; the title comes down by `drop` too, so it
 * stays as far under the picture as it was.
 */
export function immersiveLayout(rect, {width, height, landscape = false, desktop = true, headBottom = null}) {
  // On a short landscape screen, use the faded header's space and centre
  // the picture in the viewport. The text below keeps its layout position.
  const below = landscape ? 0 : 18;
  const widthRoom = rect.height * ((width - 24) / rect.width - 1);
  const heightRoom = Math.min(rect.top + below - 20, landscape ? Infinity : 96);
  let extra = Math.max(0, Math.min(heightRoom, widthRoom));
  let drop = Math.min(below, extra);
  // The picture and the title under it are centred in the window together.
  // A picture that runs out of height first grows on down into the room
  // under the title while it has width to; whatever is left either way is
  // shared out above and below. Centring the picture alone left the title
  // in a band as wide as the one above or none, and growing from the foot
  // alone left a wider band under the title than over the picture.
  if (desktop && headBottom != null) {
    let top = rect.top - extra + drop;
    let bottom = height - (headBottom + drop);
    if (bottom > top) {
      const grow = Math.max(0, Math.min(bottom - top, widthRoom - extra, 96 - extra));
      extra += grow;
      drop += grow;
      bottom -= grow;
    }
    drop += (bottom - top) / 2;
  }
  return {extra, scale: 1 + extra / rect.height, drop};
}

/** Keep immersion local to the watch page; fullscreen and the mini player
 * already have their own layout and control visibility. */
export function initialisePlayerImmersive(page, player, {idleMs} = {}) {
  if (idleMs == null) {
    try { idleMs = immersiveDelayMs(preferences.getItem(DELAY_KEY)); }
    catch { idleMs = 20_000; }
  }
  const stage = page.querySelector('.archive-watch-stage');
  const header = document.querySelector('.topbar');
  const body = document.body;
  const options = page.querySelector('[data-immersive-options]');
  const summary = page.querySelector('[data-immersive-summary]');
  const delayLabel = seconds => seconds === 0 ? t('common.off') : plural('count.seconds', seconds);
  function drawDelay() {
    if (summary) summary.textContent = delayLabel(idleMs / 1000);
    options?.querySelectorAll('[data-immersive-seconds]').forEach(row => {
      row.setAttribute('aria-checked', String(Number(row.dataset.immersiveSeconds) * 1000 === idleMs));
    });
  }
  if (options) {
    options.replaceChildren(...[0, 2, 5, 10, 20, 30].map(seconds => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'settings-option';
      row.setAttribute('role', 'radio');
      row.dataset.immersiveSeconds = String(seconds);
      row.innerHTML = '<svg class="settings-option-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg><span></span><span></span>';
      row.children[1].textContent = delayLabel(seconds);
      row.addEventListener('click', () => {
        idleMs = seconds * 1000;
        try { preferences.setItem(DELAY_KEY, String(seconds)); } catch {}
        drawDelay();
        restore();
      });
      return row;
    }));
  }
  drawDelay();
  let timer;
  // A press-and-hold on the picture (hold-to-speed) sends no further pointer
  // events while it is held still, so the idle timer started by its
  // pointerdown would otherwise run out mid-hold and scale the stage
  // under the viewer's finger.
  const pressed = new Set();
  // The search form's own controls (folders, field, go, subscribe) are
  // separate steps in the wave; treating the form as one node moved them together.
  const chrome = header?.querySelectorAll(
    '.topbar-navigation > *, .topbar-search > :not(.menu-popover), .topbar-actions > *') || [];
  chrome.forEach(node => node.classList.add('immersive-chrome'));

  function eligible() {
    const focused = document.activeElement;
    const editing = focused?.matches('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"])')
      && focused.getClientRects().length > 0 && getComputedStyle(focused).visibility !== 'hidden';
    // Match the edge-to-edge portrait layout; landscape still benefits from
    // reclaiming the header space. Resize restores immersion on rotation.
    const edgeToEdgePortrait = matchMedia('(max-width: 700px) and (orientation: portrait)').matches;
    // The chat beside the player is being read the whole time the picture
    // plays, and a stage grown from its centre would cover it.
    const chatBeside = page.classList.contains('has-chat-beside');
    return !edgeToEdgePortrait && !chatBeside && idleMs > 0 && !pressed.size && window.scrollY <= 0 && body.classList.contains('watch-open') && !page.hidden
      && !page.classList.contains('is-mini') && !player.video.paused
      && !player.video.ended && !player.root.classList.contains('is-audio-only')
      && !document.fullscreenElement && !document.hidden
      && !document.querySelector('dialog[open], [popover]:popover-open, [aria-haspopup][aria-expanded="true"], .topbar [aria-expanded="true"]')
      && !editing;
  }

  function enter() {
    timer = null;
    if (!eligible()) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.top < 0) return;
    // One wave across the whole bar, rightmost control first. Controls that
    // are not displayed (folders with one folder, subscribe) leave no pause.
    const visibleChrome = [...chrome].filter(node => node.getClientRects().length);
    visibleChrome.reverse().forEach((node, index) => node.style.setProperty('--immersive-delay', `${index * 65}ms`));
    // The logo is the final step in the same right-to-left wave.
    header?.style.setProperty('--immersive-logo-delay', `${visibleChrome.length * 65}ms`);
    // Hidden format/subscription actions should not leave pauses in the wave.
    [...page.querySelectorAll('.archive-watch-actions > button, .archive-watch-actions > a')]
      .filter(node => node.getClientRects().length)
      .forEach((node, index) => node.style.setProperty('--immersive-delay', `${index * 65}ms`));
    const landscape = matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    const desktop = !landscape && !matchMedia('(max-width: 700px)').matches;
    const head = page.querySelector('.archive-watch-head');
    const {extra, scale, drop} = immersiveLayout(rect, {
      width: window.innerWidth, height: window.innerHeight, landscape, desktop,
      headBottom: head?.getBoundingClientRect().bottom ?? null,
    });
    stage.style.setProperty('--immersive-scale', String(scale));
    stage.style.setProperty('--immersive-drop', `${drop}px`);
    head?.style.setProperty('--immersive-drop', `${drop}px`);
    const offset = landscape
      ? (window.innerHeight - rect.height - extra) / 2 - (rect.top - extra)
      : 0;
    stage.style.setProperty('--immersive-landscape-offset', `${offset}px`);
    const logo = header?.querySelector('.topbar-brand');
    if (desktop && logo && immersiveOverlapsLogo(rect, logo.getBoundingClientRect(), scale, drop)) {
      body.classList.add('is-immersive-logo-overlapped');
    }
    body.classList.add('is-player-immersive');
  }

  function restore() {
    clearTimeout(timer);
    const wasImmersive = body.classList.contains('is-player-immersive');
    body.classList.remove('is-player-immersive');
    body.classList.remove('is-immersive-logo-overlapped');
    // Return the whole row together. Reversing each button's staggered
    // transition midway otherwise gives them different return timings.
    if (wasImmersive && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      page.querySelector('.archive-watch-actions')?.animate(
        [{opacity: 0, translate: '0 12px'}, {opacity: 1, translate: '0 0'}],
        {duration: 180, easing: 'ease-out'},
      );
    }
    if (eligible()) timer = setTimeout(enter, idleMs);
  }

  for (const event of ['pointermove', 'pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart']) {
    document.addEventListener(event, restore, {passive: true});
  }
  document.addEventListener('pointerdown', event => pressed.add(event.pointerId), {passive: true, capture: true});
  for (const event of ['pointerup', 'pointercancel']) {
    document.addEventListener(event, e => { pressed.delete(e.pointerId); restore(); }, {passive: true, capture: true});
  }
  // Some releases never reach the page (a scrollbar drag, letting go outside
  // the window), and a press left behind would block immersion for good. A
  // mouse that moves with no button down, or a window that loses focus, shows
  // the press is over.
  document.addEventListener('pointermove', e => {
    if (e.buttons === 0) pressed.delete(e.pointerId);
  }, {passive: true, capture: true});
  window.addEventListener('blur', () => { pressed.clear(); restore(); });
  // Blur completes after focusout; checking immediately still sees the
  // editor that was just left and fails to restart the inactivity timer.
  document.addEventListener('focusout', () => queueMicrotask(restore));
  window.addEventListener('scroll', restore, {passive: true});
  window.addEventListener('resize', restore);
  document.addEventListener('fullscreenchange', restore);
  document.addEventListener('visibilitychange', restore);
  document.addEventListener('toggle', restore, true);
  document.addEventListener('close', restore, true);
  // Menus can close after the last pointer/focus event, leaving that event's
  // eligibility check blocked. Rearm when their expanded state changes.
  new MutationObserver(records => {
    // Playback progress redraws gallery shelves every ten seconds. Their
    // unchanged aria-expanded writes are mutations, but not user activity.
    if (records.some(record => record.oldValue !== record.target.getAttribute(record.attributeName))) restore();
  }).observe(body, {
    subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['aria-expanded', 'open'],
  });
  for (const event of ['play', 'pause', 'ended', 'emptied', 'loadedmetadata']) {
    player.video.addEventListener(event, restore);
  }
  // Navigation can leave playback running in the mini player.
  new MutationObserver(restore).observe(page, {attributes: true, attributeFilter: ['class', 'hidden']});
  new MutationObserver(() => {
    if (!body.classList.contains('watch-open') && body.classList.contains('is-player-immersive')) restore();
  }).observe(body, {attributes: true, attributeFilter: ['class']});
  restore();
}
