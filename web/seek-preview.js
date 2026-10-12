import {formatPlayerTime, tileAt} from 'media-ui';

/** How much smaller than the player's 256x144 tiles the card's thumbs are drawn. */
const THUMB_SCALE = .5;

/**
 * Where the pointer is along the bar, 0 to 1.
 */
export function ratioAt(clientX, rect) {
  return rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
}

/**
 * The CSS that shows one tile of a sprite sheet at `scale`. The sheet is
 * scaled as a whole, so the tile offsets scale with it.
 */
export function thumbStyle(sheet, ratio, scale = THUMB_SCALE) {
  const tileWidth = Number(sheet.tileWidth ?? sheet.tile_width) || 0;
  const tileHeight = Number(sheet.tileHeight ?? sheet.tile_height) || 0;
  const columns = Math.max(1, Number(sheet.columns) || 1);
  const rows = Math.max(1, Math.ceil((Number(sheet.count) || 1) / columns));
  const {offsetX, offsetY} = tileAt(sheet, ratio);
  return {
    width: `${tileWidth * scale}px`,
    height: `${tileHeight * scale}px`,
    backgroundSize: `${columns * tileWidth * scale}px ${rows * tileHeight * scale}px`,
    backgroundPosition: `${offsetX * scale}px ${offsetY * scale}px`,
  };
}

/** Shared seek bubble; playback and sheet loading belong to the caller. */
export function createSeekPreview({seek, container = seek, getDuration, getSheet,
  className = '', gap = null, keepVisible = () => false, onMove = () => {}}) {
  const bubble = document.createElement('output');
  bubble.className = `hover-preview-seek-thumb${className ? ` ${className}` : ''}`;
  bubble.hidden = true;
  bubble.innerHTML = '<span class="hover-preview-seek-image" hidden></span><span class="hover-preview-seek-time">0:00</span>';
  container.append(bubble);
  const image = bubble.querySelector('.hover-preview-seek-image');
  const time = bubble.querySelector('.hover-preview-seek-time');
  let pointer = null;
  function show(event) {
    pointer = {clientX: event.clientX};
    const rect = seek.getBoundingClientRect();
    const ratio = ratioAt(event.clientX, rect);
    if (!rect.width) return ratio;
    time.textContent = formatPlayerTime(ratio * (getDuration() || 0));
    const sheet = getSheet();
    image.hidden = !sheet;
    if (sheet) {
      Object.assign(image.style, thumbStyle(sheet, ratio));
      image.style.backgroundImage = `url("${sheet.spriteUrl ?? sheet.sprite_url}")`;
    }
    bubble.hidden = false;
    const rootRect = container === seek ? rect : container.getBoundingClientRect();
    const half = bubble.offsetWidth / 2;
    const x = Math.max(half, Math.min(rect.width - half, ratio * rect.width));
    bubble.style.left = `${rect.left - rootRect.left + x}px`;
    if (gap !== null) bubble.style.bottom = `${rootRect.bottom - rect.top + gap}px`;
    return ratio;
  }
  const hide = () => { bubble.hidden = true; };
  seek.addEventListener('pointerenter', show);
  seek.addEventListener('pointermove', event => { onMove(show(event)); });
  seek.addEventListener('pointerleave', () => { if (!keepVisible()) hide(); });
  seek.addEventListener('pointercancel', hide);
  return {show, hide, refresh() { if (!bubble.hidden && pointer) show(pointer); }};
}
