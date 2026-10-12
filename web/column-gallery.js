import {VirtualGallery} from 'media-ui';

/** The shared virtual gallery rebuilds whenever its grid's column template
 *  changes: every card is thrown away and made again, and after a hard reload
 *  each thumbnail then downloads afresh, blanking while it does. An auto-fill
 *  grid's template lists its columns' widths, so that was every frame of a
 *  resize. Here a width change only re-windows, which re-measures the chunks.
 *  A change in the column count keeps the cards too, as long as the chunks
 *  still hold whole rows: chunks are sized by a count of cards that 1, 2, 3,
 *  4 and 6 columns all divide, so only other counts rebuild. */
const CHUNK_CARDS = 12;
export class ColumnGallery extends VirtualGallery {
  // A rescan replaces item objects even when the cards on screen did not
  // otherwise change. Keep a surviving card at its viewport position while a
  // destructive update rebuilds the virtual chunks around it.
  captureAnchorFor(items) {
    const ids = new Set(items.map(item => String(item.id)));
    const element = [...this.root.querySelectorAll('[data-id]')]
      .find(candidate => ids.has(candidate.dataset.id)
        && candidate.getBoundingClientRect().bottom > 0);
    return element ? {id: element.dataset.id, offset: element.getBoundingClientRect().top} : null;
  }

  chunkSize(template) {
    const columns = Math.max(1, template.split(' ').filter(Boolean).length);
    return CHUNK_CARDS % columns === 0 ? CHUNK_CARDS : columns * this.rowsPerChunk;
  }
  // The base method, with the grid's changes settled in the same frame that
  // reads them: a frame apart, a resize still under way moves them on first.
  scheduleUpdate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.root.isConnected || !this.root.getClientRects().length) return;
      const template = getComputedStyle(this.root).gridTemplateColumns;
      if (template !== this.columns && this.chunks.length
          && this.chunkSize(template) === this.chunkSize(this.columns)) {
        this.columns = template;
      }
      if (template !== this.columns) {
        const anchor = this.captureAnchor();
        this.setItems(this.items, {force: true});
        this.restoreAnchor(anchor);
      } else {
        this.updateWindow();
      }
      this.onViewportChange?.();
    });
  }
  setItems(items, {force = false} = {}) {
    const style = getComputedStyle(this.root);
    const template = style.gridTemplateColumns;
    if (template !== this.columns && this.chunks.length
        && this.chunkSize(template) === this.chunkSize(this.columns)) {
      this.columns = template;
    }
    const sameGrid = template === this.columns;
    if (!force && sameGrid && this.chunks.length && this.items.length === items.length
        && this.items.every((item, index) => item === items[index])) {
      this.updateWindow();
      return;
    }
    // As the base method, with the chunk size above in place of rows per chunk.
    const previousChunks = this.chunks;
    const previousItems = this.items;
    for (const chunk of previousChunks) this.dropChunk(chunk);
    this.columns = template;
    this.items = items;
    this.chunks = [];
    const columnCount = Math.max(1, template.split(' ').filter(Boolean).length);
    const gap = parseFloat(style.rowGap) || 0;
    const chunkSize = this.chunkSize(template);
    const fragment = document.createDocumentFragment();
    for (let start = 0; start < items.length; start += chunkSize) {
      const end = Math.min(items.length, start + chunkSize);
      const rows = Math.ceil((end - start) / columnCount);
      const previous = sameGrid ? previousChunks.find(chunk =>
        previousItems[chunk.start] === items[start]
        && previousItems[chunk.end - 1] === items[end - 1]) : null;
      const height = previous?.height || rows * this.estimatedCardHeight + (rows - 1) * gap;
      const placeholder = document.createElement('div');
      placeholder.className = 'gallery-spacer';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.style.height = `${height}px`;
      fragment.append(placeholder);
      this.chunks.push({start, end, height, placeholder, mounted: false, host: null});
    }
    this.root.replaceChildren(fragment);
    this.updateWindow();
  }
}

