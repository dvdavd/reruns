// Card accents for the archive. The picker and accent writing are shared;
// this module walks gallery cards and knows where the archive
// keeps its thumbnails and how it keys its items.
import {accentFromImage, whenImageLoaded} from 'media-ui/accent.js';
import {applyCardAccent, CARD_SELECTOR, CARD_THUMBNAIL_SELECTOR} from 'media-ui';

export function initialiseCardAccents(root, itemForId) {
  // A playlist card among them paints itself, by the video it is showing.
  root.querySelectorAll(`${CARD_SELECTOR}:not([data-accent-initialised], [data-playlist-card])`).forEach(card => {
    card.dataset.accentInitialised = 'true';
    const img = card.querySelector(CARD_THUMBNAIL_SELECTOR);
    whenImageLoaded(img, () => {
      applyCardAccent(card, accentFromImage(img), {
        // The archive keys an item by its id, and a card names the part of it
        // that it is showing.
        itemFor: element => itemForId(element.dataset.id),
        partFor: (item, element) => item.parts?.[Number(element.dataset.partIndex || 0)],
      });
    });
  });
}
