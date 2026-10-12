import {request} from './api.js';
import {t} from './i18n.js';

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

// Each of these is a stranger's words, so the row is built from text nodes alone.
function drawMessage(message) {
  const row = document.createElement('div');
  row.className = `archive-chat-message is-${message.kind}`;
  const when = document.createElement('span');
  when.className = 'archive-chat-time';
  when.textContent = formatOffset(message.t);
  const who = document.createElement('strong');
  who.className = 'archive-chat-author';
  who.textContent = message.author;
  if (message.role) {
    who.classList.add(`is-${message.role}`);
    who.title = t(`watch.chat.role.${message.role}`);
  }
  row.append(when, ' ', who);
  if (message.amount) {
    const amount = document.createElement('span');
    amount.className = 'archive-chat-amount';
    amount.textContent = message.amount;
    row.append(' ', amount);
  }
  if (message.text) {
    const words = document.createElement('span');
    words.className = 'archive-chat-text';
    words.textContent = message.text;
    row.append(' ', words);
  }
  return row;
}

export function createChatSection(page, {video}) {
  const node = page.querySelector('[data-watch-chat]');
  const toggle = node.querySelector('[data-chat-toggle]');
  const list = node.querySelector('[data-chat-list]');
  const status = node.querySelector('[data-chat-status]');
  let item = null;
  let open = false;
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
        windows.set(index, Array.isArray(payload.messages) ? payload.messages : []);
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

  function draw() {
    toggle.setAttribute('aria-pressed', String(open));
    toggle.textContent = t(open ? 'watch.chat.hide' : 'watch.chat.show');
    list.hidden = !open;
    if (!open) status.hidden = true;
  }

  toggle.addEventListener('click', () => {
    open = !open;
    // Opened again, the list is rebuilt for wherever the video has got to.
    shownUntil = null;
    failed = false;
    draw();
    sync();
  });
  for (const type of ['timeupdate', 'seeked']) {
    video.addEventListener(type, () => {
      // A seek is a fresh start for a fetch that had failed.
      if (type === 'seeked') failed = false;
      sync();
    });
  }

  return {
    /** Called each time the watch page draws a video. Starts closed. */
    show(next) {
      const same = item?.id === next?.id;
      item = next;
      node.hidden = !next?.archive?.chatUrl;
      if (same) return;
      token++;
      open = false;
      windows = new Map();
      requested = new Set();
      shownUntil = null;
      failed = false;
      list.replaceChildren();
      draw();
    },
  };
}
