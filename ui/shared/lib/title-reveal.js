/**
 * Hovering a card whose title or channel line is cut off fades its portrait
 * and slides the words into its place, so more of them shows. A card whose
 * words already fit is left as it is. The styles are in styles.css, keyed on
 * the `data-title-reveal` this sets; the marker is the page's own attribute,
 * which Preact's render leaves alone.
 *
 * The move is played from where the words were (FLIP), not a transition on
 * the portrait's width: narrowing the portrait re-laid the title out every
 * frame, and the ellipsis re-cutting it made the slide jump. Here the layout
 * changes once and only a relative offset animates. It is `left` rather than
 * a transform because a transformed title is painted on its own layer,
 * snapped to a different pixel row, and sat half a pixel low until the slide
 * ended.
 *
 * `dwell` waits for the pointer to rest on a card first. In a grid the
 * pointer crosses a card every tenth of a second on its way somewhere else,
 * and any animation in a card repaints all of it each frame (see the note on
 * hover in the app's cards.css), so a slide per card crossed is the cost
 * that note measured. A short row of cards can reveal at once.
 */
const SLIDE_MS = 200;

/** Whether any of the card's words are cut off where they sit now. */
export function titleIsClipped(card) {
  return [...card.querySelectorAll('.card-name, .card-context-chips, .card-context-chips .identity-chip')]
    .some(node => node.scrollWidth > node.clientWidth + 1);
}

export function revealClippedTitles(root, {
  dwell = 0,
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = timer => clearTimeout(timer),
} = {}) {
  function slide(card, reveal) {
    const copy = card.querySelector('.card-title-row--portrait .card-title-copy');
    if (!copy) return;
    // Measured before the running slide is dropped, so turning round
    // half-way starts from where the words are on screen.
    const from = copy.getBoundingClientRect().left;
    copy.getAnimations?.().forEach(animation => animation.cancel());
    if (reveal) card.dataset.titleReveal = '';
    else delete card.dataset.titleReveal;
    const shift = from - copy.getBoundingClientRect().left;
    if (!shift || reducedMotion() || !copy.animate) return;
    card.dataset.titleSliding = '';
    const animation = copy.animate(
      [{left: `${shift}px`}, {left: '0px'}],
      {duration: SLIDE_MS, easing: 'cubic-bezier(.2, 0, 0, 1)'});
    animation.finished.then(() => { delete card.dataset.titleSliding; }, () => {});
  }

  // At rest whenever it is measured: leaving puts the layout back at once,
  // and only the offset is still running.
  function reveal(card) {
    if (card.isConnected !== false && !('titleReveal' in card.dataset) && titleIsClipped(card)) slide(card, true);
  }

  // Over and out bubble, so one pair of listeners serves every card the
  // root is redrawn with; moving between a card's own parts is not a
  // crossing.
  function crossing(event) {
    if (event.pointerType === 'touch') return null;
    const card = event.target.closest?.('.video-card');
    return card && root.contains(card) && !card.contains(event.relatedTarget) ? card : null;
  }
  const waiting = new Map();
  root.addEventListener('pointerover', event => {
    const card = crossing(event);
    if (!card) return;
    if (!dwell) return reveal(card);
    unschedule(waiting.get(card));
    waiting.set(card, schedule(() => { waiting.delete(card); reveal(card); }, dwell));
  });
  root.addEventListener('pointerout', event => {
    const card = crossing(event);
    if (!card) return;
    unschedule(waiting.get(card));
    waiting.delete(card);
    if ('titleReveal' in card.dataset) slide(card, false);
  });
}
