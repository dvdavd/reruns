import {iconHref} from 'media-ui';
import {t} from './i18n.js';
import {preferences} from './preferences.js';

/* The chat over the picture: how big it is, where it sits, and how the
   picture makes room for it.

   Three toggles in the chat's head. Docked gives the chat a column of the
   player to itself, on the right since it covers nothing there it would need
   moving from, and the picture is fitted whole into what is left; Zoom, only
   offered docked, has the picture fill that room instead, so its middle shows
   and its edges go. Undocked, the chat lies over the picture at half height,
   or the full height with Full height on, and can be dragged by its head to
   either side (and, at half height, to the top, middle or foot of it). */

export const DOCK_KEY = 'archive-chat-overlay-docked';
export const TALL_KEY = 'archive-chat-overlay-tall';
export const ZOOM_KEY = 'archive-chat-overlay-zoom';
export const SPOT_KEY = 'archive-chat-overlay-spot';
const SIDES = ['left', 'right'];
const ROWS = ['top', 'middle', 'bottom'];

/** "right-bottom" and the like, read back from the preference. */
export function chosenSpot(value) {
  const [side, row] = String(value || '').split('-');
  return {side: SIDES.includes(side) ? side : 'right', row: ROWS.includes(row) ? row : 'bottom'};
}

/** Where a dragged chat lands, judged by where the chat itself is when let go
 *  (its centre), not the pointer: the head is at its top, so going by the
 *  pointer took a drop well below where the chat was seen to be. The nearer
 *  side, and at half height the third of the player its centre is in. */
export function spotAt(centreX, centreY, box, tall) {
  const side = centreX < box.left + box.width / 2 ? 'left' : 'right';
  if (tall) return {side, row: 'bottom'};
  const third = Math.min(2, Math.max(0, Math.floor((centreY - box.top) / (box.height / 3))));
  return {side, row: ROWS[third]};
}

/** The picture's `object-position` while the chat lies over it. A picture
 *  narrower or wider than the player has bars to spare, and pushing it into
 *  the bars away from the chat leaves less of it under the chat. Only the axis
 *  with bars moves anything, so both can be given at once. Docked, the
 *  picture has its own room and is centred in it. */
export function videoAlignment({docked, tall}, {side, row}) {
  if (docked) return '50% 50%';
  const x = side === 'right' ? '0%' : '100%';
  const y = tall ? '50%' : {top: '100%', middle: '50%', bottom: '0%'}[row];
  return `${x} ${y}`;
}

export function createChatOverlay(node, player) {
  const head = node.querySelector('.archive-watch-comments-head');
  const controls = node.querySelector('[data-chat-overlay-controls]');
  const read = key => { try { return preferences.getItem(key) === '1'; } catch { return false; } };
  const state = {docked: read(DOCK_KEY), tall: read(TALL_KEY), zoom: read(ZOOM_KEY)};
  let spot = chosenSpot(null);
  try { spot = chosenSpot(preferences.getItem(SPOT_KEY)); } catch {}
  let active = false;
  let open = false;

  const TOGGLES = [
    {name: 'tall', key: TALL_KEY, icon: () => 'arrows-vertical', label: () => 'watch.chat.tall', shown: () => !state.docked},
    {name: 'zoom', key: ZOOM_KEY, icon: () => 'zoom-scan', label: () => 'watch.chat.zoom', shown: () => state.docked},
    // Dock, last before the close, names what it will do, docking or
    // floating, in its picture and its words, so it is never lit; the other
    // two are switches.
    {name: 'docked', key: DOCK_KEY, shown: () => true, action: true,
      icon: () => state.docked ? 'chat-float' : 'chat-dock',
      label: () => state.docked ? 'watch.chat.undock' : 'watch.chat.dock'},
  ];
  const buttons = TOGGLES.map(toggle => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'archive-chat-overlay-toggle';
    button.dataset.chatOverlay = toggle.name;
    button.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use/></svg>';
    button.addEventListener('click', () => {
      state[toggle.name] = !state[toggle.name];
      try { preferences.setItem(toggle.key, state[toggle.name] ? '1' : '0'); } catch {}
      apply();
    });
    return {toggle, button};
  });
  controls.replaceChildren(...buttons.map(({button}) => button));

  // Where the picture itself is drawn inside the video element, which
  // object-fit and object-position decide and the element's box does not say.
  const video = player.querySelector('.media-player-video');
  function picture() {
    if (!video?.videoWidth || !video.getClientRects().length) return null;
    const box = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    const fit = style.objectFit;
    const k = (fit === 'cover' ? Math.max : Math.min)(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * k;
    const height = video.videoHeight * k;
    const [x, y] = style.objectPosition.split(' ').map(parseFloat);
    return {fit, box, width, height,
      left: box.left + (box.width - width) * x / 100, top: box.top + (box.height - height) * y / 100};
  }

  function apply() {
    const before = picture();
    lay();
    const after = picture();
    // The picture slides and scales from where it was to where it now is.
    // Transitioning the element's width and its object-position instead
    // moved it by two curves at once, and a picture that started and ended
    // against the same edge swung out from it and back on the way.
    if (!before || !after || before.fit !== after.fit) return;
    const k = before.width / after.width;
    const dx = before.left - (after.box.left + k * (after.left - after.box.left));
    const dy = before.top - (after.box.top + k * (after.top - after.box.top));
    if (Math.abs(k - 1) < .001 && Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    video.animate([
      {transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${k})`},
      {transformOrigin: '0 0', transform: 'none'},
    ], {duration: 300, easing: 'cubic-bezier(.22,.8,.25,1)'});
  }

  function lay() {
    const shown = active && !node.hidden;
    controls.hidden = !shown;
    for (const {toggle, button} of buttons) {
      button.hidden = !toggle.shown();
      button.querySelector('use').setAttribute('href', iconHref(toggle.icon()));
      button.title = button.ariaLabel = t(toggle.label());
      if (!toggle.action) button.setAttribute('aria-pressed', String(state[toggle.name]));
    }
    const side = state.docked ? 'right' : spot.side;
    const half = !state.docked && !state.tall;
    node.classList.toggle('is-docked', shown && state.docked);
    node.classList.toggle('is-tall', shown && !state.docked && state.tall);
    for (const value of SIDES) node.classList.toggle(`on-${value}`, shown && side === value);
    for (const value of ROWS) node.classList.toggle(`at-${value}`, shown && half && spot.row === value);
    // The picture only makes way for a chat that is showing: shut, the head
    // alone comes and goes with the controls and covers next to nothing.
    const reading = shown && open;
    player.classList.toggle('has-chat-overlay', reading);
    player.classList.toggle('has-chat-docked', reading && state.docked);
    player.classList.toggle('has-chat-zoom', reading && state.docked && state.zoom);
    if (reading) player.style.setProperty('--chat-video-align', videoAlignment(state, {side, row: spot.row}));
    else player.style.removeProperty('--chat-video-align');
  }

  // Dragging the head carries the whole chat; letting go snaps it to the
  // nearest place it can stand, sliding there from where it was dropped.
  let drag = null;
  head.addEventListener('pointerdown', event => {
    // Not passed on: the player would take a held press for double speed.
    if (active) event.stopPropagation();
    if (!active || state.docked || event.button !== 0 || event.target.closest('button')) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
    head.setPointerCapture(event.pointerId);
  });
  head.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    node.classList.add('is-dragging');
    node.style.translate = `${dx}px ${dy}px`;
  });
  function drop(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const {moved} = drag;
    drag = null;
    if (!moved) return;
    const before = node.getBoundingClientRect();
    node.classList.remove('is-dragging');
    node.style.translate = '';
    if (event.type === 'pointerup') {
      spot = spotAt(before.left + before.width / 2, before.top + before.height / 2,
        player.getBoundingClientRect(), state.tall);
      try { preferences.setItem(SPOT_KEY, `${spot.side}-${spot.row}`); } catch {}
      apply();
    }
    const after = node.getBoundingClientRect();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    node.animate([
      {translate: `${before.left - after.left}px ${before.top - after.top}px`},
      {translate: '0 0'},
    ], {duration: 220, easing: 'cubic-bezier(.22,.8,.25,1)'});
  }
  head.addEventListener('pointerup', drop);
  head.addEventListener('pointercancel', drop);

  return {
    /** Whether the chat is over the picture, and whether its list is open. */
    set(nextActive, nextOpen) {
      active = nextActive;
      open = nextOpen;
      apply();
    },
  };
}
