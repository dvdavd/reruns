// The widths the server makes copies of a thumbnail at (WIDTHS in
// reruns/thumbnails.py) that suit a card. The browser picks one by how wide the
// card is drawn and the screen's density, instead of every card fetching the
// full-size picture; anything the original is narrower than comes back at its
// own size.
const CARD_THUMBNAIL_WIDTHS = [480, 640, 960, 1280, 1920];

/** The address of a thumbnail served by this archive at `width`, or the
 *  address unchanged when it is someone else's. */
export function sizedThumbnail(url, width) {
  return url && url.startsWith('/thumb/') ? `${url}?w=${width}` : url || '';
}

/** A card's srcset for one of this archive's thumbnails, or '' for a picture
 *  from anywhere else, which the server cannot make smaller. */
export function thumbnailSrcset(url) {
  if (!url || !url.startsWith('/thumb/')) return '';
  return CARD_THUMBNAIL_WIDTHS.map(width => `${sizedThumbnail(url, width)} ${width}w`).join(', ');
}

/** A list row's thumbnail is drawn 112px wide at most (MediaRow's regular
 *  size), so this covers a screen of two device pixels to the CSS pixel. */
export const ROW_THUMBNAIL_WIDTH = 256;

// How wide a card's thumbnail is drawn, for its srcset's `sizes`: each card
// size's --video-card-min (base.css and cards.css), which cards stretch past
// to fill their row by up to a column's share. A quarter or so is the common
// case; a card wider still is drawn from a copy a little smaller than it,
// which does not show at these sizes, where a margin for the widest made every
// card on an ordinary screen fetch the next copy up.
// Not "auto": Chrome measures a lazy image the moment it nears the viewport,
// and a gallery card measured before its grid had settled fetched the 1920
// copy for a card 380 wide.
const CARD_MIN = {
  small: 'clamp(280px, 15vw, 380px)',
  medium: 'clamp(380px, 21vw, 520px)',
  large: 'clamp(480px, 28vw, 700px)',
};

export function cardThumbnailSizes() {
  const least = CARD_MIN[globalThis.document?.body?.dataset.cardSize] || CARD_MIN.medium;
  return `min(100vw, calc(${least} * 1.15))`;
}
