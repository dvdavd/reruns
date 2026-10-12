// Scrub previews: the thumbnail strip a viewer sees while dragging the seek
// bar. The server renders one sprite sheet per video, and the client indexes
// into it by how far along the bar the pointer is.
//
// Standard video-player furniture, and the arithmetic is the same wherever the
// sheet comes from, so it lives here rather than in either app's player.

/** "1:02:03" / "4:05" — hours only when the video is long enough to need them. */
export function formatPlayerTime(seconds) {
  // A live or not-yet-probed stream reports an infinite duration, which must
  // read as zero rather than propagating into the arithmetic.
  if (!Number.isFinite(Number(seconds))) return '0:00';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = value => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * Which tile of the sprite sheet covers `ratio` of the way through, and the
 * background offset that brings it into view.
 *
 * The last tile covers the end of the video, so a ratio of exactly 1 must not
 * index past the end of the sheet.
 */
export function tileAt(sheet, ratio) {
  const count = Math.max(1, Number(sheet.count) || 1);
  const columns = Math.max(1, Number(sheet.columns) || 1);
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const index = Math.min(count - 1, Math.floor(clamped * count));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    index,
    column,
    row,
    // `+ 0` normalises the negative zero the first tile would otherwise get.
    offsetX: -column * Number(sheet.tileWidth ?? sheet.tile_width ?? 0) + 0,
    offsetY: -row * Number(sheet.tileHeight ?? sheet.tile_height ?? 0) + 0,
  };
}

/** The CSS `background-position` for that tile. */
export function tileBackgroundPosition(sheet, ratio) {
  const {offsetX, offsetY} = tileAt(sheet, ratio);
  return `${offsetX}px ${offsetY}px`;
}

/**
 * Where the preview sits above the seek bar, in coordinates relative to the
 * player root, clamped so it tracks the pointer along the bar.
 *
 * `thumb` is the width of the handle: a thumb never reaches nearer than half
 * itself to either end, so the run the ratio describes is that much shorter
 * than the bar, and a preview placed over the full width would drift away
 * from the handle it is previewing towards the ends.
 */
export function previewPlacement({rootRect, seekRect, ratio, previewHeight, gap = 20, thumb = 0}) {
  const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
  const inset = (Number(thumb) || 0) / 2;
  return {
    left: seekRect.left - rootRect.left + inset + clamped * (seekRect.width - 2 * inset),
    top: seekRect.top - rootRect.top - previewHeight - gap,
  };
}
