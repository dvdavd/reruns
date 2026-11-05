import {iconHref} from 'media-ui';
import {request} from './api.js';
import {createChatOverlay} from './player-chat-overlay.js';
import {t} from './i18n.js';
import {preferences} from './preferences.js';

/* The chat replay under a stream, scrolling in step with the video.

   The server hands the replay out a window at a time (see /api/chat), so only
   the minutes being watched are ever held here. Everything said up to the
   playhead is on show; a seek rebuilds the list from the newest messages
   before the new time, and ordinary playback only appends what has been said
   since the last look. */

export const WINDOW_MS = 120000;
// What a seek puts on screen to begin with, and the most the list ever holds:
// a busy stream says thousands of things, and the node count is what scrolls badly.
const BACKFILL = 40;
const MAX_SHOWN = 300;
// A step forward larger than playback makes in a tick is a seek.
const JUMP_MS = 10000;
// How close to the bottom still counts as following along.
const FOLLOW_PX = 40;

export const POSITION_KEY = 'archive-chat-position';
export const CHAT_POSITIONS = ['automatic', 'beside', 'below', 'overlay'];
// Beside the player wants a window that can give a column up without the
// picture becoming a postage stamp; Automatic asks for more room than an
// explicit choice does, since nobody asked it to squeeze.
const ROOM_BESIDE = '(min-width: 760px), (orientation: landscape) and (max-height: 500px) and (min-width: 640px)';
const ROOM_AUTOMATIC = '(min-width: 980px), (orientation: landscape) and (max-height: 500px) and (min-width: 640px)';
// A phone held upright has no column to give, but has height: the picture
// stays at the top and the chat takes the rest of the screen under it, the
// way a beside chat is read alongside the picture rather than scrolled to.
// The same width at which the player runs edge to edge.
const ROOM_PINNED = '(max-width: 700px) and (orientation: portrait)';

/** The chosen position, read back from the preference: anything unknown is Automatic. */
export const chosenPosition = value => CHAT_POSITIONS.includes(value) ? value : 'automatic';

/** Where the chat actually goes for a choice and the room the window has.
 *  Fullscreen leaves only the player on screen, so whatever was chosen, the
 *  chat goes over the picture there (and stays shut if it was shut below).
 *  On an upright phone, Beside and Automatic pin it under the picture. */
export function placement(choice, {beside, automatic, pinned = false, fullscreen = false}) {
  if (fullscreen || choice === 'overlay') return 'overlay';
  if (choice === 'below') return 'below';
  if (pinned) return 'pinned';
  if (choice === 'beside') return beside ? 'beside' : 'below';
  return automatic ? 'beside' : 'below';
}

export const windowOf = ms => Math.floor(ms / WINDOW_MS);

/** "3:42" or "1:02:03": where in the video it was said. */
export function formatOffset(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** What was said after `from` and up to `to`, oldest first, from the windows
 *  that have arrived (a Map of window number to its messages). */
export function between(windows, from, to) {
  const found = [];
  for (let index = windowOf(Math.max(0, from)); index <= windowOf(to); index++) {
    for (const message of windows.get(index) || []) {
      if (message.t > from && message.t <= to) found.push(message);
    }
  }
  return found;
}

/** The newest `count` messages said by `to`, oldest first. */
export function newestUpTo(windows, to, count) {
  const found = [];
  for (let index = windowOf(to); index >= 0 && found.length < count; index--) {
    const said = windows.get(index) || [];
    for (let at = said.length - 1; at >= 0 && found.length < count; at--) {
      if (said[at].t <= to) found.push(said[at]);
    }
  }
  return found.reverse();
}

/** A hue for a name, so the disc of someone without a picture is told
 *  apart from the next one and stays the same colour each time they speak. */
export function nameHue(name) {
  let hash = 0;
  for (const character of String(name || '')) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 360;
}

// Each of these is a stranger's words, so the row is built from text nodes alone.
function drawMessage(message) {
  const row = document.createElement('div');
  row.className = `archive-chat-message is-${message.kind}`;
  // The disc is the wrapper's, with the name's first letter on it, so an
  // author with no picture, or one the server could not fetch, still has a
  // face of a kind rather than a gap or the browser's broken-image mark.
  const face = document.createElement('span');
  face.className = 'archive-chat-face';
  face.setAttribute('aria-hidden', 'true');
  face.style.setProperty('--chat-face-hue', String(nameHue(message.author)));
  face.textContent = [...String(message.author || '').replace(/^@/, '')][0]?.toUpperCase() || '';
  if (message.avatar) {
    const picture = document.createElement('img');
    picture.alt = '';
    picture.decoding = 'async';
    picture.addEventListener('error', () => picture.remove());
    picture.src = message.avatar;
    face.append(picture);
  }
  const body = document.createElement('span');
  body.className = 'archive-chat-body';
  const who = document.createElement('strong');
  who.className = 'archive-chat-author';
  who.textContent = message.author;
  if (message.role) {
    who.classList.add(`is-${message.role}`);
    who.title = t(`watch.chat.role.${message.role}`);
  }
  body.append(who);
  if (message.amount) {
    const amount = document.createElement('span');
    amount.className = 'archive-chat-amount';
    amount.textContent = message.amount;
    body.append(' ', amount);
  }
  if (message.text) {
    const words = document.createElement('span');
    words.className = 'archive-chat-text';
    words.textContent = message.text;
    body.append(' ', words);
  }
  row.append(face, body);
  // No time on the line; the line itself is the way to that moment.
  row.dataset.chatAt = String(message.t);
  row.title = t('watch.chat.seek', {time: formatOffset(message.t)});
  return row;
}

export function createChatSection(page, {video}) {
  const node = page.querySelector('[data-watch-chat]');
  const toggle = node.querySelector('[data-chat-toggle]');
  const move = node.querySelector('[data-chat-move]');
  const list = node.querySelector('[data-chat-list]');
  const status = node.querySelector('[data-chat-status]');
  // Below, the chat sits first in the discussion, above the comments. Beside,
  // it is the watch column's second grid cell, straight after the stage
  // (pinned on a phone, it is in the same place, under the stage), so
  // the mini player's rule that hides all but the stage hides it too.
  // Over the picture, it goes inside the player itself: that is the element
  // made fullscreen, and nothing outside it is drawn then.
  const home = node.parentElement;
  const stage = page.querySelector('.archive-watch-stage');
  const player = video.closest('.media-player');
  const overlay = player ? createChatOverlay(node, player) : null;
  const roomBeside = matchMedia(ROOM_BESIDE);
  const roomAutomatic = matchMedia(ROOM_AUTOMATIC);
  const roomPinned = matchMedia(ROOM_PINNED);
  const header = document.querySelector('.topbar-shell');
  const settingsRow = page.querySelector('[data-chat-settings-row]');
  const summary = page.querySelector('[data-chat-position-summary]');
  const options = page.querySelector('[data-chat-position-options]');
  let choice = 'automatic';
  try { choice = chosenPosition(preferences.getItem(POSITION_KEY)); } catch {}
  let where = 'below';
  let item = null;
  let open = false;
  // In fullscreen the chat is shown and hidden from the control bar, beside
  // the gear, like the captions, where it is to hand whether the chat is
  // showing or not; the panel itself only closes. Put in the bar when first
  // drawn, the bar's own tail being built after this.
  const barToggle = document.createElement('button');
  barToggle.type = 'button';
  barToggle.className = 'archive-chat-bar-toggle';
  barToggle.hidden = true;
  barToggle.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true">
      <path class="chat-frame" d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/>
      <path class="chat-line" d="M8 9h8"/>
      <path class="chat-line" d="M8 13h6"/>
    </svg>`;
  function drawBar() {
    if (!barToggle.isConnected) player?.querySelector('.archive-bar-tail [data-settings-open]')?.before(barToggle);
    barToggle.hidden = where !== 'overlay' || node.hidden;
    barToggle.setAttribute('aria-pressed', String(open));
    barToggle.title = barToggle.ariaLabel = t(open ? 'watch.chat.hideReplay' : 'watch.chat.showReplay');
  }
  let windows = new Map();
  let requested = new Set();
  // Where the list is up to, in ms; null until it has been built for this time.
  let shownUntil = null;
  let failed = false;
  // A quick step through a playlist can land one stream's chat after the next
  // has opened.
  let token = 0;

  const nowMs = () => Math.floor((Number(video.currentTime) || 0) * 1000);

  function say(text, {busy = false} = {}) {
    status.replaceChildren();
    if (busy) {
      const spinner = document.createElement('span');
      spinner.className = 'archive-comments-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      status.append(spinner);
    }
    status.append(text);
    status.hidden = false;
  }

  function load(index) {
    if (index < 0 || requested.has(index)) return;
    // Nothing is said after the video ends, and the last window is often
    // asked for a moment before the duration is known.
    const duration = Number(video.duration);
    if (Number.isFinite(duration) && index * WINDOW_MS > duration * 1000) return;
    requested.add(index);
    const mine = token;
    request(`${item.archive.chatUrl}?from=${index * WINDOW_MS}&to=${(index + 1) * WINDOW_MS}`)
      .then(payload => {
        if (mine !== token) return;
        const said = Array.isArray(payload.messages) ? payload.messages : [];
        // The server names the author by channel; their picture is its to give.
        if (typeof payload.avatars === 'string') {
          for (const message of said) {
            if (message.a) message.avatar = `${payload.avatars}?a=${encodeURIComponent(message.a)}`;
          }
        }
        windows.set(index, said);
        sync();
      })
      .catch(() => {
        if (mine !== token) return;
        requested.delete(index);
        failed = true;
        say(t('watch.chat.failed'));
      });
  }

  const loaded = (from, to) => {
    for (let index = windowOf(from); index <= windowOf(to); index++) {
      if (!windows.has(index)) return false;
    }
    return true;
  };

  const following = () => list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_PX;
  // Whether the reader was at the newest message when last they scrolled. A
  // list that changes size keeps that: beside the player the card is the
  // stage's height, which animates as the picture changes shape, and a list
  // scrolled to the end before the card shrank was left short of it.
  let stuck = true;
  list.addEventListener('scroll', () => { stuck = following(); }, {passive: true});
  new ResizeObserver(() => {
    if (stuck && open) list.scrollTop = list.scrollHeight;
  }).observe(list);

  function trim() {
    while (list.childElementCount > MAX_SHOWN) list.firstElementChild.remove();
  }

  /** Brings the list up to the playhead. Called on every tick, so it does
   *  nothing until the windows it needs have arrived. */
  function sync() {
    if (!open || !item || failed) return;
    const now = nowMs();
    const seeked = shownUntil === null || now < shownUntil || now - shownUntil > JUMP_MS;
    // The window being watched, the one before it for the backfill of a seek,
    // and the one ahead so playback never waits on the network.
    load(windowOf(now));
    load(windowOf(now) + 1);
    if (seeked) {
      load(windowOf(now) - 1);
      if (!loaded(Math.max(0, now - WINDOW_MS), now)) { say(t('watch.chat.loading'), {busy: true}); return; }
      const recent = newestUpTo(windows, now, BACKFILL);
      list.replaceChildren(...recent.map(drawMessage));
      list.scrollTop = list.scrollHeight;
      shownUntil = now;
      if (recent.length) status.hidden = true; else say(t('watch.chat.quiet'));
      return;
    }
    if (!loaded(shownUntil, now)) return;
    const said = between(windows, shownUntil, now);
    shownUntil = now;
    if (!said.length) return;
    const follow = following();
    status.hidden = true;
    list.append(...said.map(drawMessage));
    trim();
    if (follow) list.scrollTop = list.scrollHeight;
  }

  function drawChoice() {
    if (summary) summary.textContent = t(`watch.chat.position.${choice}`);
    options?.querySelectorAll('[data-chat-position]').forEach(row => {
      row.setAttribute('aria-checked', String(row.dataset.chatPosition === choice));
    });
  }
  if (options) {
    options.replaceChildren(...CHAT_POSITIONS.map(value => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'settings-option';
      row.setAttribute('role', 'radio');
      row.dataset.chatPosition = value;
      row.innerHTML = '<svg class="settings-option-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg><span></span><span></span>';
      row.children[1].textContent = t(`watch.chat.position.${value}`);
      row.addEventListener('click', () => choose(value));
      return row;
    }));
  }

  function choose(value) {
    choice = chosenPosition(value);
    try { preferences.setItem(POSITION_KEY, choice); } catch {}
    place();
  }

  function draw() {
    drawChoice();
    toggle.setAttribute('aria-pressed', String(open));
    // Over the picture the bar's button shows the chat, so the panel's own
    // is only a close, a disc among the layout toggles.
    if (where === 'overlay') {
      toggle.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use/></svg>';
      toggle.querySelector('use').setAttribute('href', iconHref('x'));
      toggle.title = toggle.ariaLabel = t('watch.chat.hideReplay');
    } else {
      toggle.textContent = t(open ? 'watch.chat.hide' : 'watch.chat.show');
      toggle.removeAttribute('title');
      toggle.removeAttribute('aria-label');
    }
    // Beside, the column is there to be read; a Hide would leave an empty
    // card the height of the picture. Moving it under the details is the way
    // to put it away.
    toggle.hidden = where === 'beside' || where === 'pinned';
    list.hidden = !open;
    if (!open) status.hidden = true;
    overlay?.set(where === 'overlay', open);
    drawBar();
    const alongside = where === 'beside' || where === 'pinned';
    const there = alongside ? 'below' : 'beside';
    move.hidden = where === 'overlay' || !(roomBeside.matches || roomPinned.matches);
    move.dataset.chatMove = there;
    const label = alongside ? 'watch.chat.moveBelow' : roomPinned.matches ? 'watch.chat.movePinned' : 'watch.chat.moveBeside';
    move.title = move.ariaLabel = t(label);
    const icon = alongside ? 'layout-bottombar' : roomPinned.matches ? 'layout-navbar' : 'layout-sidebar-right';
    move.querySelector('use').setAttribute('href', iconHref(icon));
  }

  // Pinned, the stage sticks under the topbar and the chat is the height
  // the two leave. Both are measured rather than worked out in the
  // stylesheet: the topbar wraps to a second row on a narrow phone, and the
  // stage's height is the picture's shape plus the control strip, which the
  // stage animates between when the shape is corrected.
  function measure() {
    if (where !== 'pinned') return;
    page.style.setProperty('--chat-pin-top', `${header?.getBoundingClientRect().height || 0}px`);
    page.style.setProperty('--chat-pin-stage', `${stage.getBoundingClientRect().height}px`);
  }
  const sizes = new ResizeObserver(measure);
  function drawPinned() {
    const pinned = where === 'pinned' && !node.hidden;
    page.classList.toggle('has-chat-pinned', pinned);
    sizes.disconnect();
    if (pinned) {
      sizes.observe(stage);
      if (header) sizes.observe(header);
      measure();
    } else {
      page.style.removeProperty('--chat-pin-top');
      page.style.removeProperty('--chat-pin-stage');
    }
  }

  function reopen() {
    // Opened again, the list is rebuilt for wherever the video has got to.
    shownUntil = null;
    failed = false;
    draw();
    sync();
  }

  /** Puts the chat where the choice and the window's room say. Moving the
   *  node, rather than drawing a second list, keeps the windows already held. */
  function place() {
    const fullscreen = Boolean(player) && document.fullscreenElement === player;
    const next = placement(choice, {beside: roomBeside.matches, automatic: roomAutomatic.matches, pinned: roomPinned.matches, fullscreen});
    const moved = next !== where;
    where = player ? next : next === 'overlay' ? 'below' : next;
    if ((where === 'beside' || where === 'pinned') && node.previousElementSibling !== stage) stage.after(node);
    if (where === 'below' && node.parentElement !== home) home.prepend(node);
    // Under the control bar and the seek preview, which are drawn after it.
    if (where === 'overlay' && node.parentElement !== player) {
      player.insertBefore(node, player.querySelector('.media-player-controls'));
    }
    node.classList.toggle('is-beside', where === 'beside');
    node.classList.toggle('is-overlay', where === 'overlay');
    node.classList.toggle('is-pinned', where === 'pinned');
    page.classList.toggle('has-chat-beside', where === 'beside' && !node.hidden);
    drawPinned();
    if (moved && (where === 'beside' || where === 'pinned' || where === 'overlay' && choice === 'overlay')) open = true;
    // A moved node keeps its children but not its scroll, and a list that
    // was following along should still be at the newest message.
    if (moved && open) reopen(); else draw();
  }

  toggle.addEventListener('click', () => {
    open = !open;
    reopen();
  });
  barToggle.addEventListener('click', () => {
    open = !open;
    reopen();
  });
  move.addEventListener('click', () => {
    choose(move.dataset.chatMove);
    // Pinned, the chat is at the top of the page, which the reader who
    // asked for it from under the details has scrolled well away from.
    if (where === 'pinned') window.scrollTo({top: 0, behavior: 'smooth'});
  });
  // A line plays the video from when it was said. Not while some of it is
  // selected, so words can still be picked out to copy.
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-chat-at]');
    if (!row || String(getSelection()).length) return;
    video.currentTime = Number(row.dataset.chatAt) / 1000;
  });
  // Over the picture, a press held on a line is not the player's to take
  // for double speed.
  list.addEventListener('pointerdown', event => {
    if (where === 'overlay' && event.target.closest('[data-chat-at]')) event.stopPropagation();
  });
  // Inside the player, a click on the chat's buttons would also reach the
  // player's own handlers and pause, or a double click go fullscreen.
  for (const type of ['click', 'dblclick']) {
    node.addEventListener(type, event => { if (where === 'overlay') event.stopPropagation(); });
  }
  document.addEventListener('fullscreenchange', place);
  roomBeside.addEventListener('change', place);
  roomAutomatic.addEventListener('change', place);
  roomPinned.addEventListener('change', place);
  for (const type of ['timeupdate', 'seeked']) {
    video.addEventListener(type, () => {
      // A seek is a fresh start for a fetch that had failed.
      if (type === 'seeked') failed = false;
      sync();
    });
  }

  place();

  return {
    /** Called each time the watch page draws a video. Starts closed below
     *  the details and open beside the player, pinned under it or over it, unless it was put
     *  over the picture by fullscreen and the choice was to keep it below. */
    show(next) {
      const same = item?.id === next?.id;
      item = next;
      node.hidden = !next?.archive?.chatUrl;
      if (settingsRow) settingsRow.hidden = node.hidden;
      page.classList.toggle('has-chat-beside', where === 'beside' && !node.hidden);
      drawPinned();
      drawBar();
      if (same) return;
      token++;
      open = where === 'beside' || where === 'pinned' || where === 'overlay' && choice !== 'below';
      windows = new Map();
      requested = new Set();
      shownUntil = null;
      failed = false;
      list.replaceChildren();
      reopen();
    },
  };
}
