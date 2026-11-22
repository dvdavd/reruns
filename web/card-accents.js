// Card accents for the archive. The picker and accent writing are shared;
// this module walks gallery cards and knows where the archive
// keeps its thumbnails and how it keys its items.
import {accentFromImage, whenImageLoaded} from 'media-ui/accent.js';
import {applyCardAccent, CARD_SELECTOR, CARD_THUMBNAIL_SELECTOR} from 'media-ui';

// Sampling is a canvas draw and read of the picture, which Safari does on the
// main thread: a long scroll's cards, whose thumbnails were already cached and
// so sampled the moment they were drawn, spent nearly two seconds of it inside
// the frames that drew them. So it waits for the frame to finish and then
// takes a few cards at a time, leaving room for the next one.
const SLICE_MS = 6;
const waiting = [];
let scheduled = false;

const onScreen = ({card}) => {
  const rect = card.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < innerHeight;
};

function drain() {
  scheduled = false;
  // The cards in view go first; the overscan's are not seen until later.
  // Between frames the layout is settled, so asking where each card is costs
  // no more than the asking.
  const first = waiting.filter(onScreen);
  if (first.length && first.length < waiting.length) {
    const rest = waiting.filter(entry => !first.includes(entry));
    waiting.splice(0, waiting.length, ...first, ...rest);
  }
  const until = performance.now() + SLICE_MS;
  while (waiting.length && performance.now() < until) waiting.shift().run();
  if (waiting.length) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(drain, 0);
}

export function initialiseCardAccents(root, itemForId) {
  const itemFor = element => itemForId(element.dataset.id);
  const partFor = (item, element) => item.parts?.[Number(element.dataset.partIndex || 0)];
  // A playlist card among them paints itself, by the video it is showing.
  root.querySelectorAll(`${CARD_SELECTOR}:not([data-accent-initialised], [data-playlist-card])`).forEach(card => {
    card.dataset.accentInitialised = 'true';
    // An item keeps the accent it was given, and its card is drawn with it,
    // so a card scrolled back to has nothing to work out again.
    const item = itemFor(card);
    if (item && (partFor(item, card)?.accent || item.accent)) return;
    const img = card.querySelector(CARD_THUMBNAIL_SELECTOR);
    whenImageLoaded(img, () => {
      waiting.push({card, run: () => {
        if (!card.isConnected) return;
        // The archive keys an item by its id, and a card names the part of it
        // that it is showing.
        applyCardAccent(card, accentFromImage(img), {itemFor, partFor});
      }});
      schedule();
    });
  });
}
