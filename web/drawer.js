// Shared open/close for the side drawers (downloads, subscriptions,
// libraries, profiles, about, activity, SponsorBlock): they slide in and out, so closing has to hold the dialog
// open through the CSS transition before actually calling .close().
import {t, translateMarkup} from './i18n.js';

/* `dismiss` is what a click on the dimmed page does, for a drawer that leaves
   more than itself behind when it goes. */
export function createDrawerControls(drawer, {beforeClose = () => true, dismiss = null} = {}) {
  let closeTimer;
  function open() {
    clearTimeout(closeTimer);
    drawer.classList.remove('is-closing');
    if (drawer.open) return;
    if (drawer.showModal) drawer.showModal(); else drawer.setAttribute('open', '');
  }
  function close() {
    if (!drawer.open || drawer.classList.contains('is-closing')) return;
    if (!beforeClose()) return;
    drawer.classList.add('is-closing');
    // Reduced motion and a close during the opening frame can both leave
    // us without transitionend. Keep a fallback for those cases.
    const style = getComputedStyle(drawer);
    const milliseconds = value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000);
    const durations = style.transitionDuration.split(',').map(milliseconds);
    const delays = style.transitionDelay.split(',').map(milliseconds);
    const duration = Math.max(...durations.map((value, index) => value + delays[index % delays.length]));
    if (!duration) finishClose();
    else closeTimer = setTimeout(finishClose, duration + 50);
  }
  function finishClose() {
    clearTimeout(closeTimer);
    drawer.classList.remove('is-closing');
    if (drawer.close) drawer.close(); else drawer.removeAttribute('open');
  }
  drawer.addEventListener('transitionend', event => {
    if (event.target === drawer && drawer.classList.contains('is-closing')) {
      finishClose();
    }
  });
  // Escape fires 'cancel' and closes the dialog immediately; hold it back so
  // it slides out like every other close does.
  drawer.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  // A modal dialog's backdrop is part of the dialog, so a click on the dimmed
  // page left of the panel targets the drawer itself. Kept here rather than
  // per drawer, since the ones that wired it separately were the ones missed.
  drawer.addEventListener('click', event => {
    if (event.target === drawer && event.clientX < drawer.getBoundingClientRect().left) (dismiss ?? close)();
  });
  return {open, close};
}

/** Reveal a creation form above the list from its heading button. */
export function createDrawerAddButton(button) {
  const addMarkup = button.innerHTML;
  return expanded => {
    button.setAttribute('aria-expanded', String(expanded));
    // Put back as it was first found, then translated again: the language may
    // have changed since, and the saved copy is in the one it was captured in.
    button.innerHTML = expanded ? t('common.cancel') : addMarkup;
    if (!expanded) translateMarkup(button);
  };
}

export function createDrawerAddControls(button, form) {
  const section = form.closest?.('.drawer-editor') ?? form;
  const updateButton = createDrawerAddButton(button);
  function hide() {
    section.hidden = true;
    updateButton(false);
  }
  button.addEventListener('click', () => {
    section.hidden = !section.hidden;
    updateButton(!section.hidden);
    if (!section.hidden) form.querySelector('input')?.focus({preventScroll: true});
  });
  return {hide};
}
