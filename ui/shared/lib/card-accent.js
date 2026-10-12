// Putting a thumbnail's accent onto the card it was picked from.
//
// A card draws its accent from the item it was rendered with, so writing the
// colour onto the element alone lasts exactly until the next render wipes the
// style attribute. It has to go onto the item, and onto the part the card is
// showing, as well as the element: the element so the card changes now, the
// item so it survives the next render.
//
// Writing all three, rather than storing the accent and asking for a render,
// is deliberate. Accents arrive one thumbnail at a time, and a render per
// thumbnail blinks every mounted card in the gallery as they resolve.
//
// Which item a card belongs to is the app's knowledge — one keys items by
// path, another by id — so the lookups are supplied.

/** The class VideoCard gives a card, and the thumbnail inside it. */
export const CARD_SELECTOR = '.video-card';
export const CARD_THUMBNAIL_SELECTOR = '.thumbnail-image';

/** The card a thumbnail belongs to, or null when it is not in one. */
export function cardOfThumbnail(image) {
  return image?.closest?.(CARD_SELECTOR) ?? null;
}

/**
 * Writes `accent` everywhere the card reads it from, and returns the item it
 * reached so the caller can follow it anywhere else the colour is showing.
 *
 * `itemFor(card)` is the item the card was rendered from, and `partFor(item,
 * card)` the part it is showing — the second only matters for a card that can
 * show one part of several, since the part's own accent wins on a re-render.
 */
export function applyCardAccent(card, accent, {itemFor, partFor} = {}) {
  if (!card || !accent) return null;
  const item = itemFor?.(card) ?? null;
  if (item) {
    item.accent = accent;
    const part = partFor?.(item, card);
    if (part) part.accent = accent;
  }
  card.style?.setProperty('--card-accent', accent);
  return item;
}
