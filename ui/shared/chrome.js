// Page chrome behaviour shared by media applications.
//
// Everything here works against the class and role contract in `chrome.css`
// and takes its elements as parameters: a menu is a button plus a `[role=menu]`
// of `[role^=menuitem]` children, a toast is one node. What an app does with a
// chosen item is the app's own business, so `onSelect` receives the item and
// this module stays out of routing.

// Tints the topbar once the page has scrolled away from the top.
export function initTopbarScroll(selector = '.topbar') {
  const topbars = document.querySelectorAll(selector);
  if (!topbars.length) return;
  const update = () => {
    for (const topbar of topbars) {
      topbar.classList.toggle('is-scrolled', window.scrollY > 0);
    }
  };
  window.addEventListener('scroll', update, {passive: true});
  window.addEventListener('pageshow', update);
  update();
}

// A transient message in the corner of the page. `persistent` leaves it up
// until the caller hides it, which is what a long-running scan needs.
export function createStatusToast(node) {
  let timer = null;
  const clear = () => clearTimeout(timer);

  const hide = () => {
    if (!node) return;
    node.classList.remove('is-visible');
    timer = setTimeout(() => { node.hidden = true; }, 260);
  };

  const show = (message, {persistent = false, error = false, timeout = 3200} = {}) => {
    if (!node) return;
    clear();
    node.textContent = message;
    node.onclick = null;
    node.classList.remove('is-clickable', 'is-library-loading');
    node.classList.toggle('is-error', error);
    if (!message) { node.hidden = true; return; }
    node.hidden = false;
    requestAnimationFrame(() => node.classList.add('is-visible'));
    // `timeout: 0` is how a caller says "leave it up", same as `persistent`.
    if (!persistent && timeout) timer = setTimeout(hide, timeout);
  };

  // Applied synchronously: animation frames may not run once a navigation
  // has started, and this is raised on the way out of the page.
  const showSticky = (message, className) => {
    if (!node) return;
    clear();
    node.textContent = message;
    node.onclick = null;
    node.classList.remove('is-clickable', 'is-error');
    node.classList.add(className, 'is-visible');
    node.hidden = false;
  };

  const clearSticky = className => {
    if (!node || !node.classList.contains(className)) return;
    node.classList.remove('is-visible', className);
    node.hidden = true;
  };

  return {node, show, hide, clear, showSticky, clearSticky};
}

// A button that opens a menu popover. Closes on a second click, on an outside
// click, on Escape (restoring focus to the button) and once an item is chosen.
export function createMenu({button, menu, onSelect, closeDelay = 0}) {
  if (!button || !menu) return {open() {}, close() {}, isOpen: () => false};

  let closeTimer = null;
  let closing = false;
  const isOpen = () => !menu.hidden && !closing;

  const finishClose = () => {
    menu.hidden = true;
    menu.inert = false;
    delete menu.dataset.closing;
    closeTimer = null;
    closing = false;
  };

  const close = ({restoreFocus = false} = {}) => {
    if (!isOpen()) return;
    button.setAttribute('aria-expanded', 'false');
    if (closeDelay) {
      closing = true;
      menu.inert = true;
      menu.dataset.closing = 'true';
      closeTimer = setTimeout(finishClose, closeDelay);
    } else finishClose();
    if (restoreFocus) button.focus();
  };

  const open = () => {
    if (closeTimer !== null) clearTimeout(closeTimer);
    closeTimer = null;
    closing = false;
    menu.inert = false;
    delete menu.dataset.closing;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('[role^="menuitem"]')?.focus();
  };

  button.addEventListener('click', () => (isOpen() ? close() : open()));

  menu.addEventListener('click', event => {
    const item = event.target.closest('[role^="menuitem"]');
    if (!item || !menu.contains(item)) return;
    close();
    onSelect?.(item, event);
  });

  document.addEventListener('click', event => {
    if (!isOpen() || menu.contains(event.target) || button.contains(event.target)) return;
    close();
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    event.preventDefault();
    close({restoreFocus: true});
  });

  return {open, close, isOpen};
}

// Marks one `[role=menuitemcheckbox]` as the chosen one, which is what the
// check mark in chrome.css keys off. `attribute` names the data-* the items
// carry their value in, so each app keeps its own vocabulary.
export function selectMenuValue(menu, value, attribute) {
  if (!menu) return value;
  for (const item of menu.querySelectorAll(`[role="menuitemcheckbox"][data-${attribute}]`)) {
    item.setAttribute('aria-checked', String(item.dataset[attribute] === value));
  }
  return value;
}

// The value currently checked in such a menu, or the first item's value.
export function selectedMenuValue(menu, attribute) {
  const items = [...(menu?.querySelectorAll(`[role="menuitemcheckbox"][data-${attribute}]`) || [])];
  const checked = items.find(item => item.getAttribute('aria-checked') === 'true');
  return (checked || items[0])?.dataset[attribute];
}
