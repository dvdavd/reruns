/* Where a native popover sits: under the button that opened it, flipped above
   when the viewport runs out below, and never past either edge. The popovers
   here are position:fixed, so this is plain viewport arithmetic rather than
   anchor positioning, which Firefox still does not have.

   A panel above its button is held by its bottom edge, a panel below by its
   top: the edge against the button is the one that stays put. Held by its top,
   a panel above floated off its button whenever it changed height - picking a
   profile hides the manual overrides and took a good third off it. `side`
   keeps the side chosen when it opened, so a panel that grows while open
   scrolls inside itself rather than jumping to the button's other side.
   Returns the side, for the next placement to keep. */
export function placePopover(button, panel, gap = 6, side = null, prefer = 'down') {
  const anchor = button.getBoundingClientRect();
  // Measured with any cap from a previous placement lifted, or a panel would
  // come back a little shorter every time it opened.
  panel.style.maxHeight = '';
  const {width, height} = panel.getBoundingClientRect();
  const below = innerHeight - anchor.bottom - gap * 2;
  const above = anchor.top - gap * 2;
  // A card's own menu opens upward, so menus that stand in for it prefer to;
  // either preference gives way when the other side is the only one with room.
  const up = side ? side === 'up'
    : prefer === 'up' ? !(height > above && below > above)
      : height > below && above > below;
  // A panel taller than the room it has is capped and scrolls inside itself;
  // without this it simply ran off the bottom of a phone, and the gallery
  // behind it took the scroll that was meant for the options.
  const room = Math.max(up ? above : below, 0);
  panel.style.maxHeight = `${room}px`;
  panel.style.left = `${Math.max(gap, Math.min(anchor.right - width, innerWidth - width - gap))}px`;
  panel.style.top = up ? 'auto' : `${anchor.bottom + gap}px`;
  panel.style.bottom = up ? `${innerHeight - anchor.top + gap}px` : 'auto';
  return up ? 'up' : 'down';
}

/** Place a submenu beside its row, flipping left when the right edge is tight.
 *  On narrow screens it falls back to the usual above/below placement. */
export function placeSidePopover(button, panel, gap = 6, side = null) {
  const anchor = button.getBoundingClientRect();
  panel.style.maxHeight = '';
  const {width, height} = panel.getBoundingClientRect();
  const right = innerWidth - anchor.right - gap * 2;
  const left = anchor.left - gap * 2;
  if (Math.max(right, left) < width) return placePopover(button, panel, gap);
  const direction = side === 'left' && left >= width ? 'left'
    : side === 'right' && right >= width ? 'right'
      : right >= width ? 'right' : 'left';
  panel.style.maxHeight = `${Math.max(0, innerHeight - gap * 2)}px`;
  panel.style.left = `${direction === 'right' ? anchor.right + gap : anchor.left - width - gap}px`;
  panel.style.top = `${Math.max(gap, Math.min(anchor.top, innerHeight - Math.min(height, innerHeight - gap * 2) - gap))}px`;
  panel.style.bottom = 'auto';
  return direction;
}

/**
 * Calls `moved` in each frame where `measure` reads differently, from `start`
 * until `stop`. The top layer is outside the page's scrolling and knows
 * nothing of the button a popover hangs from, and no one event says that
 * button has moved: a scroll, a resize or a zoom (a resize in CSS pixels)
 * each can, and so can the watch page's frame easing to its new size for
 * 300ms after a resize, which left a panel placed on the resize where the
 * button had been. Animations are sampled before animation frames run, so a
 * reading here is where the button is in the frame about to be painted.
 */
export function followPosition(measure, moved) {
  let frame = null;
  let last = '';
  const check = () => {
    const now = measure();
    if (now !== last) { last = now; moved(); }
    frame = requestAnimationFrame(check);
  };
  return {
    start() { last = ''; check(); },
    stop() { cancelAnimationFrame(frame); frame = null; },
  };
}

/** A rectangle, and the viewport it sits in, as one comparable reading. */
export const rectKey = (...elements) => [innerWidth, innerHeight, ...elements.flatMap(element => {
  const {left, top, right, bottom} = element.getBoundingClientRect();
  return [left, top, right, bottom];
})].join();

/**
 * Keeps an open popover against its button, below or beside it, however it moves and
 * however the panel's own contents change its size. `button` is a function,
 * for a panel that more than one button can open.
 */
export function followButton(panel, button, gap = 6, placement = () => 'vertical', prefer = 'down') {
  let side = null;
  const place = () => {
    const target = button();
    if (target) side = placement() === 'side'
      ? placeSidePopover(target, panel, gap, side)
      : placePopover(target, panel, gap, side, prefer);
  };
  const position = followPosition(() => (button() ? rectKey(button()) : ''), place);
  const resized = new ResizeObserver(place);
  return {
    start() {
      side = null;
      position.start();
      resized.observe(panel);
    },
    stop() {
      position.stop();
      resized.disconnect();
    },
  };
}

/* The toggle handler a popover anchored to a button wants: it keeps the
   button's aria-expanded honest and keeps the panel against it while open. */
export function anchorPopover(button, panel) {
  const follow = followButton(panel, () => button);
  panel.addEventListener('toggle', event => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (open) follow.start();
    else follow.stop();
  });
}

/**
 * Makes `change` and eases an open panel from its old height to its new one,
 * rather than the rows it added or took away snapping it to size. The panel
 * is held by the edge against its button (see placePopover), so it grows and
 * shrinks away from the button. Clipped while it moves: the rows are at their
 * new size from the start, and would otherwise scroll into view past it.
 */
export function animateResize(panel, change) {
  const open = panel.matches(':popover-open');
  const from = open ? panel.getBoundingClientRect().height : 0;
  change();
  if (!open || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = panel.getBoundingClientRect().height;
  if (Math.abs(to - from) < 1) return;
  panel.animate({height: [`${from}px`, `${to}px`], overflow: ['hidden', 'hidden']},
    {duration: 180, easing: 'cubic-bezier(.22,.8,.25,1)'});
}

/**
 * One menu hung from whichever button opens it, for the menus that stand in
 * for a card's own: built once, filled and placed on each `open`. It sits
 * above its button when there is room, as a card's menu does.
 *
 * Pressing the button an open menu hangs from light-dismisses it before the
 * click arrives, which would only open it again. The press is noted while the
 * menu is still open, so the click that follows leaves it closed: `open`
 * returns false for it, and true when the menu opened.
 *
 * `reflect` keeps the opener's aria-expanded honest; leave it off for a
 * button something else renders, which would fight over the attribute.
 */
export function createAnchoredMenu({label, className = '', prefer = 'up', onClose = () => {}}) {
  const menu = document.createElement('div');
  menu.className = `menu-popover ${className}`.trim();
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  document.body.append(menu);
  let opener = null;
  let reflected = false;
  // A card can be redrawn away while its menu is open; the last place the
  // button was is better than the corner of the page.
  let lastRect = null;
  const anchor = {getBoundingClientRect: () => {
    if (opener?.isConnected) lastRect = opener.getBoundingClientRect();
    return lastRect;
  }};
  const follow = followButton(menu, () => (opener ? anchor : null), 6, () => 'vertical', prefer);
  let pressed = null;
  document.addEventListener('pointerdown', event => {
    pressed = opener && menu.matches(':popover-open') && opener.contains(event.target) ? opener : null;
  }, true);
  menu.addEventListener('toggle', event => {
    const open = event.newState === 'open';
    if (reflected) opener?.setAttribute('aria-expanded', String(open));
    if (open) { follow.start(); return; }
    follow.stop();
    opener = null;
    onClose();
  });
  return {
    element: menu,
    isOpen: () => menu.matches(':popover-open'),
    close: () => { if (menu.matches(':popover-open')) menu.hidePopover(); },
    open(from, children, {reflect = true} = {}) {
      if (pressed === from) { pressed = null; return false; }
      pressed = null;
      opener = from;
      reflected = reflect;
      lastRect = from.getBoundingClientRect();
      menu.replaceChildren(...children);
      if (!menu.matches(':popover-open')) menu.showPopover();
      if (reflect) from.setAttribute('aria-expanded', 'true');
      return true;
    },
  };
}
