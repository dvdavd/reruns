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
   Returns the side, for the next placement to keep.

   Across, a panel lines up with the edge of its button nearer the edge of the
   screen, so it opens towards the middle: always lining up right edges sent
   the folder and profile pickers on the left of the page out leftwards, away
   from what they belong to. `align` is 'start' or 'end' to choose, or 'auto'
   to decide by which half of the screen the button is in. */
export const popoverAlign = (button, align = 'auto') => {
  if (align !== 'auto') return align;
  const {left, right} = button.getBoundingClientRect();
  return (left + right) / 2 < innerWidth / 2 ? 'start' : 'end';
};

export function placePopover(button, panel, gap = 6, side = null, prefer = 'down', align = 'end') {
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
  const left = popoverAlign(button, align) === 'start' ? anchor.left : anchor.right - width;
  panel.style.left = `${Math.max(gap, Math.min(left, innerWidth - width - gap))}px`;
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
export function followButton(panel, button, gap = 6, placement = () => 'vertical', prefer = 'down', align = 'auto') {
  let side = null;
  // Settled when it opens, like `side`, so a button that crosses the middle
  // while the panel is up (a resize, a drawer sliding) does not swing it over.
  let across = null;
  const place = () => {
    const target = button();
    if (!target) return;
    if (placement() === 'side') { side = placeSidePopover(target, panel, gap, side); return; }
    across ??= popoverAlign(target, align);
    side = placePopover(target, panel, gap, side, prefer, across);
  };
  const position = followPosition(() => (button() ? rectKey(button()) : ''), place);
  const resized = new ResizeObserver(place);
  return {
    start() {
      side = null;
      across = null;
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
 * Gives the highlight back to the row a submenu hangs from, for a pointer
 * that has just come into the submenu. VideoCard lights an open submenu's row
 * only while no other row carries `data-pointer-row`, the mark of the last row
 * the pointer entered; a pointer cutting across another row on its way in left
 * that row marked, and the submenu's own row dark the whole time it was in use.
 */
export function claimSubmenuRow(row) {
  if (!row?.closest('.card-menu')) return;
  for (const other of row.parentElement.querySelectorAll(':scope > [data-pointer-row]')) {
    other.removeAttribute('data-pointer-row');
  }
  row.setAttribute('data-pointer-row', '');
}

/**
 * One menu hung from whichever button opens it, for the menus that stand in
 * for a card's own: built once, filled and placed on each `open`. It sits
 * above its button when there is room, as a card's menu does, and lines up
 * with the button's right edge so it opens over the card the button is on.
 *
 * Pressing the button an open menu hangs from light-dismisses it before the
 * click arrives, which would only open it again. The press is noted while the
 * menu is still open, so the click that follows leaves it closed: `open`
 * returns false for it, and true when the menu opened.
 *
 * `reflect` keeps the opener's aria-expanded honest; leave it off for a
 * button something else renders, which would fight over the attribute.
 *
 * `side` hangs it beside its button as a submenu of the menu that row is in.
 * A submenu opens on hover, so the press that follows is not a second thought
 * and must not close it again: it is opened whatever was pressed.
 */
export function createAnchoredMenu({label, className = '', prefer = 'up', align = 'end', onClose = () => {}}) {
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
  let side = false;
  const anchor = {getBoundingClientRect: () => {
    if (opener?.isConnected) lastRect = opener.getBoundingClientRect();
    return lastRect;
  }};
  const follow = followButton(menu, () => (opener ? anchor : null), 6,
    () => (side ? 'side' : 'vertical'), prefer, align);
  let pressed = null;
  document.addEventListener('pointerdown', event => {
    pressed = opener && menu.matches(':popover-open') && opener.contains(event.target) ? opener : null;
  }, true);
  menu.addEventListener('pointerenter', () => { if (side) claimSubmenuRow(opener); });
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
    opener: () => opener,
    open(from, children, {reflect = true, side: beside = false} = {}) {
      if (pressed === from && !beside) { pressed = null; return false; }
      pressed = null;
      // Placed afresh rather than kept on the side it last took, since it may
      // have been a submenu then and hang from the card's own button now.
      if (menu.matches(':popover-open') && side !== beside) menu.hidePopover();
      side = beside;
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
