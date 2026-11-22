// Icons drawn from a sprite in this document rather than from its file.
//
// A <use> that points into another file costs Safari a copy of the glyph out
// of that separately loaded document each time one is put in the page. With
// five icons a card it was some 40% of what a long scroll spent making cards
// (Firefox does the same far more cheaply). Pointing into the page itself
// costs Safari little, so once a sprite has been brought in, the addresses
// handed out for it are local; until then they are the file's as before, so
// nothing drawn early is left blank.

// Each sprite brought in, by its address without a fragment, and the prefix
// its ids were given so they cannot meet the page's own.
const local = new Map();
const pending = new Set();
let brought = 0;

const withoutFragment = href => href.split('#')[0];

/** `href` (a sprite's address and a glyph's id) as it is best drawn now. */
export function spriteHref(href) {
  if (!href) return href;
  const hash = href.indexOf('#');
  if (hash < 0) return href;
  const prefix = local.get(href.slice(0, hash));
  return prefix === undefined ? href : `#${prefix}${href.slice(hash + 1)}`;
}

/**
 * Brings the sprite at `url` into `doc`, once. Resolves either way: a sprite
 * that cannot be fetched or read is simply still drawn from its file.
 */
export async function inlineSprite(url, doc = globalThis.document) {
  if (!doc?.body || !url) return;
  const address = withoutFragment(new URL(url, doc.baseURI).href);
  if (local.has(address) || pending.has(address)) return;
  pending.add(address);
  try {
    const response = await fetch(address);
    if (!response.ok) return;
    const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
    const sprite = parsed.documentElement;
    if (sprite.localName !== 'svg' || parsed.querySelector('parsererror')) return;
    const prefix = `sprite${brought++}-`;
    for (const glyph of sprite.querySelectorAll('[id]')) glyph.id = `${prefix}${glyph.id}`;
    // Kept out of sight and of the layout, but not display:none, which some
    // engines have drawn <use> of as nothing.
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('width', '0');
    sprite.setAttribute('height', '0');
    sprite.setAttribute('style', 'position: absolute; overflow: hidden; pointer-events: none');
    doc.body.prepend(doc.importNode(sprite, true));
    local.set(address, prefix);
  } catch {
    // Left to the file.
  } finally {
    pending.delete(address);
  }
}
