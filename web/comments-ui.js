import {jobFinished, request} from './api.js';
import {commentsOf, sortComments} from './item-adapter.js';
import {formatDate} from './watch-details.js';
import {plural, t} from './i18n.js';
import {preferences} from './preferences.js';

const MODE_KEY = 'archive-comments-mode';
const MODES = new Set(['none', 'top', 'newest']);

function rememberedMode() {
  try {
    const saved = preferences.getItem(MODE_KEY);
    return MODES.has(saved) ? saved : 'none';
  } catch { return 'none'; }
}

const THUMB_UP = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/></svg>';
const REPLIES_CHEVRON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';

// "3:42" or "1:02:03" in a comment's text. Digits either side rule out the
// middle of a longer number or a ratio like 16:9:1.
const TIMESTAMP = /(?<![\d:])(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)(?![\d:])/g;

/** The text as nodes, with each timestamp a button that seeks. Built from
 *  text nodes alone: a comment is a stranger's words, never markup. */
function textNodes(text, duration, seek) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(TIMESTAMP)) {
    const seconds = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    // A time past the end of the video is a score or a recipe, not a place in it.
    if (!(duration > 0 && seconds <= duration)) continue;
    nodes.push(text.slice(last, match.index));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'archive-comment-time';
    button.textContent = match[0];
    button.addEventListener('click', () => seek(seconds));
    nodes.push(button);
    last = match.index + match[0].length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

function formatLikes(count) {
  return count >= 1000
    ? new Intl.NumberFormat(undefined, {notation: 'compact'}).format(count)
    : String(count);
}

function drawComment(comment, context, {reply = false} = {}) {
  const node = document.createElement('article');
  node.className = reply ? 'archive-comment is-reply' : 'archive-comment';

  // The circle is the wrapper's, so a picture the server could not fetch
  // leaves a plain disc rather than the browser's broken-image mark.
  const avatar = document.createElement('span');
  avatar.className = 'archive-comment-avatar';
  if (comment.avatarUrl) {
    const picture = document.createElement('img');
    picture.alt = '';
    picture.loading = 'lazy';
    picture.addEventListener('error', () => picture.remove());
    picture.src = comment.avatarUrl;
    avatar.append(picture);
  }

  const body = document.createElement('div');
  body.className = 'archive-comment-body';

  const head = document.createElement('div');
  head.className = 'archive-comment-head';
  const author = document.createElement('strong');
  author.textContent = comment.author;
  author.classList.toggle('is-uploader', comment.byUploader);
  head.append(author);
  const date = comment.postedAt ? formatDate(comment.postedAt) : '';
  for (const [shown, label] of [
    [comment.pinned, t('watch.comments.pinned')],
    [date, date],
    [comment.edited, t('watch.comments.edited')],
  ]) {
    if (!shown) continue;
    const part = document.createElement('span');
    part.textContent = label;
    head.append(part);
  }

  const text = document.createElement('p');
  text.className = 'archive-comment-text is-clamped';
  text.append(...textNodes(comment.text, context.duration, context.seek));
  // Hidden until measure() finds the clamp is cutting something off.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'archive-comment-more';
  more.hidden = true;
  more.textContent = t('watch.showMore');
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    const expanded = !text.classList.toggle('is-clamped');
    more.setAttribute('aria-expanded', String(expanded));
    more.textContent = t(expanded ? 'watch.showLess' : 'watch.showMore');
  });

  body.append(head, text, more);
  if (comment.likes || comment.hearted) {
    const line = document.createElement('div');
    line.className = 'archive-comment-foot';
    if (comment.likes) {
      // The thumb stands for the word, so the full "N likes" stays as the
      // name a screen reader and the tooltip give it.
      const likes = document.createElement('span');
      likes.className = 'archive-comment-likes';
      likes.title = plural('count.likes', comment.likes, {text: formatLikes(comment.likes)});
      likes.setAttribute('aria-label', likes.title);
      likes.insertAdjacentHTML('beforeend', THUMB_UP);
      const count = document.createElement('span');
      count.setAttribute('aria-hidden', 'true');
      count.textContent = formatLikes(comment.likes);
      likes.append(count);
      line.append(likes);
    }
    if (comment.hearted) {
      if (comment.likes) line.append(' · ');
      line.append(t('watch.comments.hearted'));
    }
    body.append(line);
  }

  if (comment.replies.length) {
    const replies = document.createElement('details');
    replies.className = 'archive-comment-replies';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = plural('watch.comments.replies', comment.replies.length);
    // Static markup, nothing from the comment: the same chevron as the
    // shelves' More, turned by [open] rather than swapped.
    summary.append(label);
    summary.insertAdjacentHTML('beforeend', REPLIES_CHEVRON);
    replies.append(summary, ...comment.replies.map(item => drawComment(item, context, {reply: true})));
    // A closed reply has no layout to measure, so it is judged as it opens.
    replies.addEventListener('toggle', () => { if (replies.open) measure(replies); });
    body.append(replies);
  }
  node.append(avatar, body);
  return node;
}

const CLAMP_LINES = 4;

/** Clamps each comment that runs past four lines, with Show more under it,
 *  unless the clamp would hide just one line: a toggle to reveal a single line
 *  takes the room it saves. Only a laid-out paragraph can say how many lines
 *  it has, so this runs once the comments are in the page and again when their
 *  width changes. One the viewer has opened is left open, with its toggle. */
function measure(root) {
  const texts = [...root.querySelectorAll('.archive-comment-text')]
    .filter(text => text.nextElementSibling.getAttribute('aria-expanded') !== 'true');
  // Clamped while measured: its scrollHeight is still the whole text's. All
  // are clamped, then all read, then all settled: a write between reads laid
  // the page out again for each comment, and a resize measures every frame,
  // which with a few hundred comments was most of the work of dragging the
  // window.
  for (const text of texts) text.classList.add('is-clamped');
  const worth = texts.map(text => {
    if (!text.clientHeight) return null;
    const line = text.clientHeight / CLAMP_LINES;
    return text.scrollHeight > text.clientHeight + line + 1;
  });
  texts.forEach((text, index) => {
    if (worth[index] === null) return;
    text.classList.toggle('is-clamped', worth[index]);
    text.nextElementSibling.hidden = !worth[index];
  });
}

/**
 * The comments card. One group chooses what to show: None (Hide, once there are
 * some), Top or Newest. Choosing Top or Newest for a video that holds none
 * fetches them first, once; the detached icon fetches them again. The choice is
 * remembered and reapplied to the next video that holds comments; one that
 * holds none opens on None, so moving through a playlist never fetches unasked. The card
 * exists only for a YouTube video, and for an account that may fetch or one
 * that has comments to read.
 *
 * `canFetch()` says whether this account may fetch, and `fetchComments(item)`
 * queues the comments-only refresh and returns its job; `seek(seconds)` and `duration()` come
 * from the player, so a time in a comment moves the video as a chapter does.
 */
export function createCommentsSection(page, {seek, duration, canFetch, fetchComments}) {
  const node = page.querySelector('[data-watch-comments]');
  const modes = node.querySelector('[data-watch-comments-modes]');
  const refresh = node.querySelector('[data-watch-comments-refresh]');
  const list = node.querySelector('[data-watch-comments-list]');
  let item = null;
  let threads = null;
  let mode = 'none';
  let fetching = false;
  let problem = '';
  // Whether this video has had its opening mode chosen. The count of comments
  // held comes with the video's details, a moment after it opens, so the
  // remembered choice waits for it rather than settling on None.
  let opened = false;
  // Videos whose fetch has been tried this visit, so a result of none is
  // reported rather than asked for again each time Top is pressed.
  const attempted = new Set();
  // A quick step through a playlist can land one video's comments after the
  // next has opened.
  let token = 0;

  // A narrower card wraps more lines, so a comment that fitted may not now.
  // Measured once the width settles: re-clamping every comment restyles them
  // all, and done on each frame of a window being dragged it cost ten times
  // the rest of the page together.
  let width = 0;
  let settle = 0;
  new ResizeObserver(([entry]) => {
    const next = Math.round(entry.contentRect.width);
    if (next === width) return;
    // Coming into view (drawn while hidden, where nothing could be measured)
    // is not a drag, and its read-more buttons should not wait.
    const appearing = !width;
    width = next;
    clearTimeout(settle);
    if (appearing) measure(list);
    else settle = setTimeout(() => measure(list), 150);
  }).observe(list);

  const holds = () => (threads ? threads.length > 0 : item?.archive.commentCount > 0);

  function status(text, {busy = false} = {}) {
    const line = document.createElement('p');
    line.className = 'archive-comments-status';
    if (busy) {
      const spinner = document.createElement('span');
      spinner.className = 'archive-comments-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      line.append(spinner);
    }
    line.append(text);
    return line;
  }

  function draw() {
    if (!item) return;
    for (const button of modes.querySelectorAll('[data-comments-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.commentsMode === mode));
    }
    modes.querySelector('[data-comments-mode="none"]').textContent =
      t(holds() ? 'watch.comments.modeHide' : 'watch.comments.modeNone');
    refresh.hidden = !canFetch();
    refresh.disabled = fetching;
    refresh.classList.toggle('is-spinning', fetching);
    list.hidden = mode === 'none';
    if (mode === 'none') return;
    if (fetching) list.replaceChildren(status(t('watch.comments.fetching'), {busy: true}));
    else if (problem) list.replaceChildren(status(problem));
    else if (!threads) list.replaceChildren(status(t('watch.comments.loading'), {busy: true}));
    else if (!threads.length) list.replaceChildren(status(t('watch.comments.none')));
    else {
      const context = {seek, duration: duration()};
      list.replaceChildren(...sortComments(threads, mode).map(comment => drawComment(comment, context)));
      measure(list);
    }
  }

  async function read(mine) {
    const payload = await request(item.archive.commentsUrl);
    if (mine !== token) return false;
    threads = commentsOf(payload.comments);
    item.archive.commentCount = threads.length;
    return true;
  }

  async function fetchFresh() {
    const mine = token;
    const current = item;
    attempted.add(current.id);
    fetching = true;
    problem = '';
    draw();
    try {
      const job = await fetchComments(current);
      if (job) await jobFinished(job, {failure: t('watch.comments.fetchFailed')});
      if (mine !== token) return;
      fetching = false;
      await read(mine);
    } catch (error) {
      if (mine !== token) return;
      fetching = false;
      problem = error?.message || t('watch.comments.fetchFailed');
    }
    if (mine === token) draw();
  }

  /** `asked` is a press of Top or Newest. Without one (the remembered choice
   *  opening a video), a count that turns out stale falls back to None rather
   *  than fetching. */
  async function ensure({asked = true} = {}) {
    const mine = token;
    if (!threads) {
      try {
        if (!await read(mine)) return;
      } catch {
        if (mine === token) { problem = t('watch.comments.failed'); draw(); }
        return;
      }
      if (!asked && !threads.length) mode = 'none';
      draw();
    }
    if (!asked) return;
    if (!threads.length && canFetch() && !attempted.has(item.id) && !fetching) await fetchFresh();
  }

  for (const button of modes.querySelectorAll('[data-comments-mode]')) {
    button.addEventListener('click', () => {
      // Hide is None while there is something to hide; either way it closes.
      mode = button.dataset.commentsMode;
      opened = true;
      try { preferences.setItem(MODE_KEY, mode); } catch {}
      problem = '';
      draw();
      if (mode !== 'none') ensure();
    });
  }
  refresh.addEventListener('click', () => {
    if (fetching || !canFetch()) return;
    if (mode === 'none') mode = 'top';
    opened = true;
    fetchFresh();
  });

  function open() {
    if (opened || !holds()) return;
    opened = true;
    mode = rememberedMode();
    if (mode !== 'none') ensure({asked: false});
  }

  return {
    /** Called each time the watch page draws a video. Opens on the remembered
     *  choice if the video holds comments, else on None. */
    show(next) {
      const same = item?.id === next?.id;
      item = next;
      const offered = Boolean(next?.archive?.commentsUrl);
      node.hidden = !offered || !(next.archive.commentCount > 0 || canFetch());
      if (same) {
        if (!node.hidden) open();
        draw();
        return;
      }
      token++;
      threads = null;
      fetching = false;
      problem = '';
      mode = 'none';
      opened = false;
      list.replaceChildren();
      if (node.hidden) return;
      open();
      draw();
    },
  };
}
