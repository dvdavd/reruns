// One glyph from the shared sprite.
//
// Where that sprite is served from is the package's business: it resolves the
// file next to its own modules, so the mount point can move in server.py and
// the import map without a single icon here being touched.
import {html, iconHref} from 'media-ui';

/** A glyph for a Preact tree, with any extra classes the caller wants. The
 *  sprite's glyphs are drawn on a 24-unit grid, bar the few drawn for one
 *  size, which pass their own. */
export function icon(name, extra = '', viewBox = '0 0 24 24') {
  return html`<svg class=${`icon ${extra}`.trim()} viewBox=${viewBox} aria-hidden="true">
    <use href=${iconHref(name)}/></svg>`;
}

/** The same glyph as markup, for the places that build their HTML as a string. */
export function iconMarkup(name, extra = '') {
  return `<svg class="${`icon ${extra}`.trim()}" viewBox="0 0 24 24" aria-hidden="true">`
    + `<use href="${iconHref(name)}"/></svg>`;
}
