/**
 * A text field that hands over its whole contents when it is focused, so the
 * next thing typed replaces what is there rather than joining it.
 *
 * Focus alone is not enough: a click focuses the field and then places a
 * caret, undoing the selection. So a click that arrives on an unfocused
 * field has its caret placement dropped, while a click on one already
 * focused is left alone — dragging out a selection by hand still works.
 */
export function selectOnFocus(input) {
  if (!input) return;
  let focusing = false;
  input.addEventListener('pointerdown', () => {
    focusing = input.ownerDocument?.activeElement !== input;
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('mouseup', event => {
    if (!focusing) return;
    focusing = false;
    event.preventDefault();
  });
  // A click that never lands (a drag out of the field) must not leave the
  // next one thinking it is the one that focused.
  input.addEventListener('blur', () => { focusing = false; });
}
