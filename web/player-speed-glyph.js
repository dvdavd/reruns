/**
 * The two solid triangles of a track-next button, which is what running the
 * video on at speed feels like. Not in the shared sprite, so drawn inline;
 * both the hold badge and the SponsorBlock chip wear it, and the hold badge
 * drops the trailing one at 1x and below by hiding it.
 */
export const SPEED_GLYPH_MARKUP =
  '<svg class="icon archive-hold-icon" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path class="archive-hold-lead" d="M2 5v14c0 .86 1.012 1.318 1.659 .753l8 -7a1 1 0 0 0 0 -1.506l-8 -7c-.647 -.565 -1.659 -.106 -1.659 .753z" />'
  + '<path class="archive-hold-trail" d="M13 5v14c0 .86 1.012 1.318 1.659 .753l8 -7a1 1 0 0 0 0 -1.506l-8 -7c-.647 -.565 -1.659 -.106 -1.659 .753z" />'
  + '</svg>';

