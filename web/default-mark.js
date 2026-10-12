import {html} from 'media-ui';
import {t} from './i18n.js';

/* The star that marks a menu's default profile, the one the profiles panel
   stars. It is not in the shared sprite, so it is drawn here; the path is
   shared between Preact menus and the ones built with the DOM. A label stands
   in for the word "Default" that used to sit at the row's end. */
const PATH = 'M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245';

export function defaultMark() {
  return html`<span class="default-mark" role="img" aria-label=${t('profiles.default')} title=${t('profiles.default')}>
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${PATH} /></svg></span>`;
}

export function defaultMarkElement() {
  const mark = document.createElement('span');
  mark.className = 'default-mark';
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', t('profiles.default'));
  mark.title = t('profiles.default');
  mark.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATH}" /></svg>`;
  return mark;
}
