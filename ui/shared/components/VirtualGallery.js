// Window-scrolling gallery virtualizer. Rendering is injected so this module
// has no dependency on Preact, VideoCard, app state, routes, or API behavior.
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

    const previousChunks = this.chunks;
    const previousItems = this.items;
    for (const chunk of previousChunks) this.dropChunk(chunk);

    this.columns = nextColumns;
    this.items = items;
    this.chunks = [];
    const columnCount = Math.max(1, nextColumns.split(' ').filter(Boolean).length);
    const gap = parseFloat(style.rowGap) || 0;
    const chunkSize = columnCount * this.rowsPerChunk;
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

  mountChunk(chunk) {
    if (chunk.mounted) return;
    this.renderChunk(chunk, this.items.slice(chunk.start, chunk.end));
    chunk.placeholder.hidden = true;
    chunk.mounted = true;
    this.onMount?.(this.elementsForChunk(chunk), chunk);
  }

  dropChunk(chunk) {
    if (!chunk.mounted && !chunk.host) return;
    const elements = this.elementsForChunk(chunk);
    this.onUnmount?.(elements, chunk);
    this.unmountChunk(chunk);
    chunk.mounted = false;
  }

  refreshMounted() {
    for (const chunk of this.chunks) {
      if (!chunk.mounted) continue;
      this.renderChunk(chunk, this.items.slice(chunk.start, chunk.end));
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
    const origin = this.root.getBoundingClientRect().top + window.scrollY
      + (parseFloat(style.paddingTop) || 0);
    const overscan = window.innerHeight * this.overscanViewports;
    const low = position - origin - overscan;
    const high = position - origin + window.innerHeight + overscan;
    let top = 0;

    for (const chunk of this.chunks) {
      if (chunk.mounted) {
        const elements = this.elementsForChunk(chunk);
        if (elements.length) chunk.height = elements.at(-1).getBoundingClientRect().bottom
          - elements[0].getBoundingClientRect().top;
      }
      chunk.top = top;
      chunk.needed = top <= high && top + chunk.height >= low;
      top += chunk.height + gap;
    }

    const viewportTop = position - origin;
    let drift = 0;
    for (const chunk of this.chunks) {
      if (chunk.needed) {
        const estimated = chunk.height;
        this.mountChunk(chunk);
        const elements = this.elementsForChunk(chunk);
        const measured = elements.length
          ? elements.at(-1).getBoundingClientRect().bottom - elements[0].getBoundingClientRect().top
          : 0;
        if (measured > 0) {
          chunk.height = measured;
          if (chunk.top + estimated <= viewportTop) drift += measured - estimated;
        }
      } else if (chunk.mounted) {
        const elements = this.elementsForChunk(chunk);
        if (elements.some(element => element.contains(document.activeElement)
            || element.classList.contains('menu-open'))) continue;
        chunk.placeholder.style.height = `${chunk.height}px`;
        chunk.placeholder.hidden = false;
        this.dropChunk(chunk);
      }
    }
    if (drift) window.scrollBy(0, drift);
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
    for (const chunk of this.chunks) this.dropChunk(chunk);
  }
}
