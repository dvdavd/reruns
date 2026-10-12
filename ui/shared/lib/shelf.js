// How many cards a home shelf shows, and the More button that lifts the cap.
//
// A shelf is a grid track one or two rows tall: it shows however many cards
// fit across at the current width, and hides the rest behind More. Only the
// grid knows how many fit, so the count is read back from the computed
// template rather than worked out from card widths.
//
// Rendering stays with the caller. Some shelves render their cards fresh on
// every change, others hide DOM already on the page; both want the same
// arithmetic and the same button bookkeeping.

/** The number of columns a grid track lays out at its current width. */
export function gridColumns(track) {
  const template = getComputedStyle(track).gridTemplateColumns;
  // A track that is not laid out reports `none`, which is no columns at all
  // rather than one named `none`.
  return Math.max(1, template.split(' ').filter(value => value && value !== 'none').length);
}

/**
 * Calls `onChange` when the track's column count changes, and returns the
 * function that stops watching. The first measurement is the caller's to
 * make: a shelf draws itself once before there is anything to change.
 */
export function watchColumns(track, onChange) {
  let columns = gridColumns(track);
  const check = () => {
    // Hiding a parent makes the computed template `none`. Keep the last
    // laid-out width so returning from another page does not collapse rows.
    if (track.getClientRects && !track.getClientRects().length) return;
    const next = gridColumns(track);
    if (next !== columns) { columns = next; onChange(); }
  };
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(check);
    observer.observe(track);
    return () => observer.disconnect();
  }
  window.addEventListener('resize', check);
  return () => window.removeEventListener('resize', check);
}

/**
 * Hides the cards past the rows a shelf is allowed, for a shelf whose cards
 * are already on the page. Returns how many stayed visible.
 */
export function fitShelfRows(track, {rows = 1, selector = '.video-card'} = {}) {
  const limit = gridColumns(track) * rows;
  const cards = Array.from(track.querySelectorAll(selector));
  cards.forEach((card, index) => { card.hidden = index >= limit; });
  return Math.min(limit, cards.length);
}

const DEFAULT_LABELS = {more: 'More', less: 'Less'};

/**
 * The cap on a shelf and the state of its More button (an icon button; the
 * labels become its accessible name and tooltip). `onChange` is called
 * when the viewer expands or collapses the shelf, and when the column count
 * changes, so the caller can draw again; `rows` is how many rows the shelf
 * shows while collapsed.
 *
 * A shelf with no More button cannot expand, and one with no `track` laid out
 * yet still reports a limit of at least one row.
 */
export function createShelfRows({track, moreButton = null, rows = 1,
                                 labels: overrides = {}, onChange} = {}) {
  const labels = {...DEFAULT_LABELS, ...overrides};
  let expanded = false;
  let stopWatching = null;
  let columns = gridColumns(track);

  /** The cards a collapsed shelf has room for. */
  const capacity = () => {
    if (!track.getClientRects || track.getClientRects().length) columns = gridColumns(track);
    return columns * rows;
  };

  const rowsApi = {
    get expanded() { return expanded; },

    /** The entries to draw: all of them when expanded, one shelf-full when not. */
    take(entries) {
      return expanded ? [...entries] : [...entries].slice(0, capacity());
    },

    /**
     * Points the More button at a shelf holding `total` entries. It only
     * appears once there is something hidden behind it.
     */
    sync(total) {
      if (!moreButton) return;
      moreButton.hidden = total <= capacity();
      // The page turns the chevron with aria-expanded. A button with a
      // label span shows the words beside it; one without is icon-only and
      // keeps them as its name.
      const label = expanded ? labels.less : labels.more;
      const text = moreButton.querySelector?.('[data-shelf-more-label]');
      if (text) {
        text.textContent = label;
      } else {
        moreButton.setAttribute('aria-label', label);
        moreButton.setAttribute('title', label);
      }
      moreButton.setAttribute('aria-expanded', String(expanded));
    },

    /** Redraws on resize until `stop` is called. */
    watch() {
      stopWatching?.();
      stopWatching = watchColumns(track, () => onChange?.());
      return rowsApi;
    },

    stop() {
      stopWatching?.();
      stopWatching = null;
    },
  };

  moreButton?.addEventListener('click', () => {
    expanded = !expanded;
    onChange?.();
  });

  return rowsApi;
}
