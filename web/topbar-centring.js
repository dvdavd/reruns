// On a wide window the search field sits at the middle of the page at a fixed
// width, rather than stretching across everything between the page buttons
// and settings. Whether there is room for that depends on what is beside it:
// the folder picker comes and goes, its label is the chosen folder's name, and
// the words are the language's. So the bar is measured rather than given a
// breakpoint, and goes back to a full-width field once the space either side
// of the centred one would be too thin to read as deliberate.

// Less than this between the folder picker and the field looks squeezed in.
export const MIN_CENTRED_SPACE = 48;

// What a pasted link brings up beside the field at full width: the go button
// and its options (52 + 30), Subscribe (90) and Browse (104), with the gaps
// between them, as topbar.css sizes them. Reserved whether or not they are
// showing, so typing or pasting never flips the layout.
export const SEARCH_BUTTONS_RESERVE = 52 + 30 + 6 + 90 + 6 + 104;

// Where the centred field's form starts, as an offset past the page buttons,
// or null when it would not fit. Every width is the bar's own geometry, which
// centring leaves as it was, so the answer cannot flip back and forth.
//   barWidth      the bar's width, whose middle is the page's
//   paddingRight  the bar's gutter at the right
//   navEnd        right edge of the page buttons, from the bar's left
//   gap           the bar's gap between its items
//   folder        the folder picker's width, 0 while hidden
//   end           everything right of the search (New Playlist, actions)
//   field         the centred field's width
export function centredSearchOffset({barWidth, paddingRight, navEnd, gap, folder, end, field}) {
  const fieldStart = (barWidth - field) / 2;
  const startEnd = navEnd + (folder ? gap + folder : 0);
  const rightRoom = barWidth - paddingRight - (fieldStart + field);
  if (fieldStart - startEnd < MIN_CENTRED_SPACE) return null;
  if (rightRoom < SEARCH_BUTTONS_RESERVE + gap + end + gap) return null;
  return fieldStart - (navEnd + gap);
}

// Measured inside the observer's callback rather than on the next frame, so
// the first paint already has the right layout. Centring moves nothing that
// is observed, so the writes cannot set it off again.
export function watchTopbarCentring({bar, nav, folder, after}) {
  function update() {
    const style = getComputedStyle(bar);
    const field = parseFloat(style.getPropertyValue('--search-centred-width'));
    const gap = parseFloat(style.columnGap) || 0;
    const left = bar.getBoundingClientRect().left;
    // New Playlist folds to nothing outside the playlists page rather than
    // leaving the flow, so it counts only while it has a width.
    const widths = after.map(element => element.getBoundingClientRect().width)
      .filter(width => width > 0);
    const offset = centredSearchOffset({
      barWidth: bar.clientWidth,
      paddingRight: parseFloat(style.paddingRight),
      navEnd: nav.getBoundingClientRect().right - left,
      gap,
      folder: folder.hidden ? 0 : folder.getBoundingClientRect().width,
      end: widths.reduce((sum, width) => sum + width, 0)
        + Math.max(0, widths.length - 1) * gap,
      field,
    });
    bar.toggleAttribute('data-search-centred', offset != null);
    if (offset != null) bar.style.setProperty('--search-offset', `${offset}px`);
  }
  const sizes = new ResizeObserver(update);
  for (const element of [bar, nav, folder, ...after]) sizes.observe(element);
}
