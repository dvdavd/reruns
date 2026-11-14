// Window-scrolling gallery virtualizer. Rendering is injected so this module
// has no dependency on Preact, VideoCard, app state, routes, or API behavior.

const isSpacer = node => node.classList?.contains('gallery-spacer');

/**
 * Brings `root`'s children into line with `wanted`: a number is a spacer of
 * that many pixels, a node is a mounted chunk's own node. Only spacers are
 * added, moved or dropped; chunk nodes already in place are left where they
 * are (moving one would restart its thumbnails and previews), and one not yet
 * in `root` is put where it belongs. Existing spacers are reused, so a redraw
 * touches a handful of elements however long the gallery is.
 */
export function reconcileSpacers(root, wanted, makeSpacer) {
  const spare = [];
  let cursor = root.firstChild;
  for (const want of wanted) {
    if (typeof want === 'number') {
      let spacer;
      if (cursor && isSpacer(cursor)) {
        spacer = cursor;
        cursor = cursor.nextSibling;
      } else {
        spacer = spare.pop() || makeSpacer();
        root.insertBefore(spacer, cursor);
      }
      const height = `${want}px`;
      if (spacer.style.height !== height) spacer.style.height = height;
    } else if (want.parentNode !== root) {
      root.insertBefore(want, cursor);
    } else {
      while (cursor && cursor !== want) {
        const next = cursor.nextSibling;
        if (isSpacer(cursor)) {
          cursor.remove();
          spare.push(cursor);
        }
        cursor = next;
      }
      if (cursor) cursor = cursor.nextSibling;
    }
  }
  while (cursor) {
    const next = cursor.nextSibling;
    if (isSpacer(cursor)) cursor.remove();
    cursor = next;
  }
}

export class VirtualGallery {
  constructor({
    root,
    renderChunk,
    unmountChunk,
    elementsForChunk,
    rowsPerChunk = 4,
    estimatedCardHeight = 290,
    overscanViewports = 1.5,
    onMount,
    onUnmount,
    onRenderCount,
    onViewportChange,
    captureAnchor,
    restoreAnchor,
  }) {
    this.root = root;
    this.renderChunk = renderChunk;
    this.unmountChunk = unmountChunk;
    this.elementsForChunk = elementsForChunk;
    this.rowsPerChunk = rowsPerChunk;
    this.estimatedCardHeight = estimatedCardHeight;
    this.overscanViewports = overscanViewports;
    this.onMount = onMount;
    this.onUnmount = onUnmount;
    this.onRenderCount = onRenderCount;
    this.onViewportChange = onViewportChange;
    this.captureAnchorForResize = captureAnchor;
    this.restoreAnchorAfterResize = restoreAnchor;
    this.items = [];
    this.chunks = [];
    this.columns = '';
    this.gap = 0;
    // Pixels per row of cards, measured from the chunks on screen; until then
    // estimatedCardHeight stands in.
    this.rowHeight = 0;
    // While set, mounts and drops leave the spacers for one sync at the end.
    this.batching = false;
    this.frame = null;
    // updateWindow keeps the view still itself when a chunk above it mounts
    // at other than its estimated height. Browser scroll anchoring would make
    // the same correction again, and the doubled jump outweighed the wheel:
    // scrolling up past a chunk skipped on the way down threw the page down.
    // The correction is ours rather than the browser's because Safari has none.
    root.style.overflowAnchor = 'none';

    this.update = this.scheduleUpdate.bind(this);
    window.addEventListener('scroll', this.update, {passive: true});
    window.addEventListener('resize', this.update);
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(this.update) : null;
    this.resizeObserver?.observe(root);
  }

  scheduleUpdate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (!this.root.isConnected || !this.root.getClientRects().length) return;
      const columns = getComputedStyle(this.root).gridTemplateColumns;
      if (columns !== this.columns) {
        const anchor = this.captureAnchorForResize?.() || this.captureAnchor();
        this.setItems(this.items, {force: true});
        if (this.restoreAnchorAfterResize) this.restoreAnchorAfterResize(anchor);
        else this.restoreAnchor(anchor);
      } else {
        this.updateWindow();
      }
      this.onViewportChange?.();
    });
  }

  setItems(items, {force = false} = {}) {
    const style = getComputedStyle(this.root);
    const nextColumns = style.gridTemplateColumns;
    const sameGrid = nextColumns === this.columns;
    if (!force && sameGrid && this.chunks.length && this.items.length === items.length
        && this.items.every((item, index) => item === items[index])) {
      this.updateWindow();
      return;
    }

    this.rebuild(items, style, nextColumns, sameGrid);
  }

  /** Cards per chunk for a grid with this column template. */
  chunkSize(template) {
    return Math.max(1, template.split(' ').filter(Boolean).length) * this.rowsPerChunk;
  }

  /**
   * Replaces the chunks with ones for `items`. Chunks off screen are drawn as
   * one spacer per unbroken run of them rather than one each: a sort of
   * 50,000 videos made some 3,800 new spacers, and styling them cost more
   * than the cards themselves.
   */
  rebuild(items, style, template, sameGrid) {
    const previousChunks = this.chunks;
    const previousItems = this.items;
    // On the same grid a chunk on screen hands its node to the new chunk in
    // its place, which is drawn into it again rather than afresh. Dropped and
    // remade, every card on screen was new, its thumbnail blank until it had
    // decoded again: deleting a video blinked the whole gallery, once for the
    // list without it and once more for the rescan after.
    const adoptable = sameGrid
      ? previousChunks.filter(chunk => chunk.mounted && chunk.node && chunk.index * this.chunkSize(template) < items.length)
      : [];
    const adopted = new Set(adoptable);
    this.batching = true;
    for (const chunk of previousChunks) if (!adopted.has(chunk)) this.dropChunk(chunk);
    this.batching = false;
    const kept = new Set(adoptable.map(chunk => chunk.node));
    // Whatever else the markup started with goes, as replaceChildren once did.
    for (const child of [...this.root.childNodes]) {
      if (!isSpacer(child) && !kept.has(child)) child.remove();
    }

    this.columns = template;
    this.items = items;
    this.chunks = [];
    const columnCount = Math.max(1, template.split(' ').filter(Boolean).length);
    this.gap = parseFloat(style.rowGap) || 0;
    const chunkSize = this.chunkSize(template);
    const previousChunk = this.previousChunkFinder(previousChunks, previousItems);
    for (let start = 0; start < items.length; start += chunkSize) {
      const end = Math.min(items.length, start + chunkSize);
      const rows = Math.ceil((end - start) / columnCount);
      const previous = sameGrid ? previousChunk(items[start], items[end - 1]) : null;
      this.chunks.push({index: this.chunks.length, start, end,
                        height: previous?.height || this.estimate(end - start, columnCount),
                        measuredFor: previous?.measuredFor ?? null,
                        mounted: false, host: null, node: null});
    }
    for (const old of adoptable) {
      const chunk = this.chunks[old.index];
      Object.assign(chunk, {mounted: true, host: old.host, node: old.node});
      this.onUnmount?.(this.elementsForChunk(old), old);
      this.renderChunk(chunk, items.slice(chunk.start, chunk.end),
                       node => this.placeChunk(chunk, node));
      this.onMount?.(this.elementsForChunk(chunk), chunk);
    }
    this.syncSpacers();
    this.updateWindow();
  }

  /** The height a chunk of `count` cards is taken to have until it is drawn. */
  estimate(count, columns) {
    const rows = Math.ceil(count / columns);
    return rows * (this.rowHeight || this.estimatedCardHeight) + (rows - 1) * this.gap;
  }

  /** One spacer for each run of unmounted chunks, holding their room. */
  syncSpacers() {
    if (this.batching) return;
    const wanted = [];
    let height = 0;
    let count = 0;
    const flush = () => {
      if (count) wanted.push(height + this.gap * (count - 1));
      height = 0;
      count = 0;
    };
    for (const chunk of this.chunks) {
      if (chunk.mounted && chunk.node) {
        flush();
        wanted.push(chunk.node);
      } else if (!chunk.mounted) {
        height += chunk.height;
        count += 1;
      }
    }
    flush();
    reconcileSpacers(this.root, wanted, () => {
      const spacer = document.createElement('div');
      spacer.className = 'gallery-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      return spacer;
    });
  }

  /**
   * Given to renderChunk to put a chunk's node in the grid: before the next
   * mounted chunk's, and syncSpacers then splits the spacer around it.
   */
  placeChunk(chunk, node) {
    chunk.node = node;
    let next = null;
    for (let index = chunk.index + 1; index < this.chunks.length && !next; index += 1) {
      const later = this.chunks[index];
      if (later.mounted && later.node?.parentNode === this.root) next = later.node;
    }
    this.root.insertBefore(node, next);
  }

  /**
   * Finds the old chunk that ran from one item to another, so a chunk that
   * survives a redraw keeps its measured height. Looked up by its first item:
   * searching every old chunk for each new one made a redraw of 50,000 videos
   * spend a fifth of a second just matching chunks.
   */
  previousChunkFinder(previousChunks, previousItems) {
    const byFirst = new Map(previousChunks.map(chunk => [previousItems[chunk.start], chunk]));
    return (first, last) => {
      const chunk = byFirst.get(first);
      return chunk && previousItems[chunk.end - 1] === last ? chunk : null;
    };
  }

  mountChunk(chunk) {
    if (chunk.mounted) return;
    chunk.mounted = true;
    this.renderChunk(chunk, this.items.slice(chunk.start, chunk.end),
                     node => this.placeChunk(chunk, node));
    this.syncSpacers();
    this.onMount?.(this.elementsForChunk(chunk), chunk);
  }

  dropChunk(chunk) {
    if (!chunk.mounted && !chunk.host && !chunk.node) return;
    const elements = this.elementsForChunk(chunk);
    this.onUnmount?.(elements, chunk);
    this.unmountChunk(chunk);
    if (chunk.node?.parentNode === this.root) chunk.node.remove();
    chunk.node = null;
    chunk.mounted = false;
    this.syncSpacers();
  }

  refreshMounted() {
    for (const chunk of this.chunks) {
      if (!chunk.mounted) continue;
      this.renderChunk(chunk, this.items.slice(chunk.start, chunk.end),
                       node => this.placeChunk(chunk, node));
      this.onMount?.(this.elementsForChunk(chunk), chunk);
    }
  }

  updateWindow(position = window.scrollY) {
    // A grid with no layout box — taken out of the document by whatever route
    // is on screen — has nothing to window. Every rect it could read is zero,
    // so measuring would store zero heights for its mounted chunks, and the
    // drift correction below would scroll the page that replaced it. Callers
    // that are not the scroll listener (setItems, ensureGalleryScrollPosition)
    // reach here at any time, including while the grid is display:none.
    if (!this.root.getClientRects().length) return;
    const style = getComputedStyle(this.root);
    const gap = parseFloat(style.rowGap) || 0;
    this.gap = gap;
    const template = style.gridTemplateColumns;
    const columns = Math.max(1, template.split(' ').filter(Boolean).length);
    const origin = this.root.getBoundingClientRect().top + window.scrollY
      + (parseFloat(style.paddingTop) || 0);
    const measure = elements => elements.at(-1).getBoundingClientRect().bottom
      - elements[0].getBoundingClientRect().top;
    const learnRowHeight = () => {
      let rows = 0;
      let height = 0;
      for (const chunk of this.chunks) {
        if (!chunk.mounted || chunk.measuredFor !== template) continue;
        const count = Math.ceil((chunk.end - chunk.start) / columns);
        rows += count;
        height += chunk.height - (count - 1) * gap;
      }
      return rows ? height / rows : this.rowHeight;
    };

    for (const chunk of this.chunks) {
      if (!chunk.mounted) continue;
      const elements = this.elementsForChunk(chunk);
      if (!elements.length) continue;
      chunk.height = measure(elements);
      chunk.measuredFor = template;
    }
    this.rowHeight = learnRowHeight();

    // A chunk measured at another width, or never, is guessed again from the
    // rows it now has. The gallery keeps its chunks when the column count
    // changes, so without this a page that lost a column to its scrollbar
    // kept guessing three rows a chunk where there were four, and came out a
    // quarter short. A guess that changes above the view moves the page by
    // as much, so what is on screen stays put.
    let before = 0;
    let shift = 0;
    let reguessed = false;
    for (const chunk of this.chunks) {
      const old = chunk.height;
      if (!chunk.mounted && chunk.measuredFor !== template) {
        const guess = this.estimate(chunk.end - chunk.start, columns);
        if (Math.abs(guess - old) > 0.5) {
          if (before + old <= position - origin) shift += guess - old;
          chunk.height = guess;
          reguessed = true;
        }
      }
      before += old + gap;
    }
    if (reguessed) this.syncSpacers();
    position += shift;

    const overscan = window.innerHeight * this.overscanViewports;
    const low = position - origin - overscan;
    const high = position - origin + window.innerHeight + overscan;
    let top = 0;
    for (const chunk of this.chunks) {
      chunk.top = top;
      chunk.needed = top <= high && top + chunk.height >= low;
      top += chunk.height + gap;
    }

    const viewportTop = position - origin;
    let drift = shift;
    for (const chunk of this.chunks) {
      if (chunk.needed) {
        const estimated = chunk.height;
        this.mountChunk(chunk);
        const elements = this.elementsForChunk(chunk);
        const measured = elements.length ? measure(elements) : 0;
        if (measured > 0) {
          chunk.height = measured;
          chunk.measuredFor = template;
          if (chunk.top + estimated <= viewportTop) drift += measured - estimated;
        }
      } else if (chunk.mounted) {
        const elements = this.elementsForChunk(chunk);
        if (elements.some(element => element.contains(document.activeElement)
            || element.classList.contains('menu-open'))) continue;
        this.dropChunk(chunk);
      }
    }
    if (drift) window.scrollBy(0, drift);
    // Chunks drawn just now may show rows of another height than the guesses
    // were made with, as on the first draw; guess again next frame.
    const rowHeight = learnRowHeight();
    if (Math.abs(rowHeight - this.rowHeight) > 0.5) {
      this.rowHeight = rowHeight;
      this.scheduleUpdate();
    }
    this.onRenderCount?.(this.chunks.reduce((count, chunk) =>
      count + (chunk.mounted ? chunk.end - chunk.start : 0), 0));
  }

  captureAnchor() {
    const element = [...this.root.querySelectorAll('[data-id]')]
      .find(candidate => candidate.getBoundingClientRect().bottom > 0);
    return element ? {id: element.dataset.id, offset: element.getBoundingClientRect().top} : null;
  }

  restoreAnchor(anchor) {
    if (!anchor) return;
    const index = this.items.findIndex(item => String(item.id) === anchor.id);
    const chunk = this.chunks.find(entry => index >= entry.start && index < entry.end);
    if (chunk) this.mountChunk(chunk);
    const element = [...this.root.querySelectorAll('[data-id]')]
      .find(candidate => candidate.dataset.id === anchor.id);
    if (element) window.scrollBy(0, element.getBoundingClientRect().top - anchor.offset);
  }

  disconnect() {
    window.removeEventListener('scroll', this.update);
    window.removeEventListener('resize', this.update);
    this.resizeObserver?.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.batching = true;
    for (const chunk of this.chunks) this.dropChunk(chunk);
    this.batching = false;
  }
}
