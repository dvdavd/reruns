// App-neutral reactive storage for normalized library items. Each consumer
// creates its own instance, so multiple galleries can coexist independently.
export function createItemStore(initialItems = []) {
  let items = [];
  let byRef = new Map();
  const listeners = new Set();
  let muted = 0;

  const itemRefs = item => item.parts?.length
    ? item.parts.map(part => part.sourceRef) : [item.id];

  function rebuildIndex() {
    byRef = new Map();
    items.forEach((item, index) => {
      item.originalOrder = index;
      for (const ref of itemRefs(item)) byRef.set(ref, item);
      byRef.set(item.id, item);
    });
  }

  function notify() {
    if (!muted) for (const listener of listeners) listener(items);
  }

  function setItems(nextItems, {notify: shouldNotify = false} = {}) {
    items = [...nextItems];
    rebuildIndex();
    if (shouldNotify) notify();
    return items;
  }

  function removeItem(item) {
    const index = items.indexOf(item);
    if (index < 0) return false;
    items.splice(index, 1);
    rebuildIndex();
    notify();
    return true;
  }

  function updateItems(predicate, mutate) {
    let changed = false;
    for (const item of items) {
      if (!predicate(item)) continue;
      mutate(item);
      changed = true;
    }
    if (changed) notify();
    return changed;
  }

  function updateItemAtRef(ref, mutate) {
    const item = byRef.get(ref);
    if (!item) return false;
    mutate(item);
    notify();
    return true;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function batch(body) {
    muted += 1;
    try { return body(); }
    finally { muted -= 1; if (!muted) notify(); }
  }

  function reset() {
    items = [];
    byRef = new Map();
    listeners.clear();
    muted = 0;
  }

  setItems(initialItems);
  return {
    allItems: () => items,
    itemForRef: ref => byRef.get(ref) || null,
    itemRefs, setItems, removeItem, updateItems, updateItemAtRef,
    subscribe, notify, batch, reset,
  };
}
