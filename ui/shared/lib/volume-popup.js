/**
 * The volume slider stood up in a pill over its button, with the mute button
 * at its foot: the player's, where the bar has no room for an inline slider,
 * and any other bar's that wants the same thing. `popup` is the pill and holds
 * `slider`; it carries `is-open` while it is up, which is what player.css
 * draws it by. `onToggle(open)` lets the owner mark its own button or bar.
 */

/** Which of the four volume glyphs a media element's level calls for. */
export function volumeLevel(media) {
  if (media.muted) return 'muted';
  if (media.volume === 0) return 'zero';
  return media.volume < .67 ? 'medium' : 'high';
}

export function createVolumePopup({button, popup, slider, onToggle = () => {}}) {
  let open = false;
  let dismissed = false;

  function show() {
    // A popover while it is up, and only then: in the top layer its glass has
    // what is behind it to blur, where inside a bar - itself a backdrop root -
    // it had nothing. Held 6px over the button like the host's own popovers,
    // and kept on screen however near the edge the button is.
    popup.popover = 'manual';
    open = true;
    popup.classList.add('is-open');
    popup.showPopover?.();
    const anchor = button.getBoundingClientRect();
    const width = popup.offsetWidth;
    popup.style.left = `${Math.max(6, Math.min(anchor.left + anchor.width / 2 - width / 2, innerWidth - width - 6))}px`;
    popup.style.bottom = `${innerHeight - anchor.top + 6}px`;
    button.setAttribute('aria-expanded', 'true');
    slider.focus({preventScroll: true});
    onToggle(true);
  }
  function hide() {
    if (!open) return;
    open = false;
    popup.hidePopover?.();
    // Out of the top layer it is no box at all, and must not keep a popover's.
    popup.removeAttribute('popover');
    popup.style.left = popup.style.bottom = '';
    popup.classList.remove('is-open');
    button.removeAttribute('aria-expanded');
    onToggle(false);
  }

  // A press anywhere else puts it away, and is remembered so the owner can
  // keep that press from doing anything more (a pause, on the player).
  document.addEventListener('pointerdown', event => {
    dismissed = open && !popup.contains(event.target) && !button.contains(event.target);
    if (dismissed) hide();
  }, true);
  popup.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); hide(); button.focus(); }
  });

  return {
    get open() { return open; },
    show,
    hide,
    toggle() { if (open) hide(); else show(); },
    /** Whether the last press only closed the popup; asking clears it. */
    takeDismissed() { const was = dismissed; dismissed = false; return was; },
  };
}
