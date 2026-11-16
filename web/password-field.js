// The password field every form shares: the setup wizard, the sign-in page,
// and the dialog that changes, resets and first sets passwords in the app.
// They had grown four ways of asking, so the parts live here and each page
// only supplies its markup:
//
//   <label class="form-field"><span>Password</span>
//     <span class="password-input">
//       <input type="password" ...><button type="button" class="password-reveal"></button>
//     </span>
//     <span class="password-strength" aria-live="polite"><i></i><b></b></span>
//   </label>
//
// The meter is only for a password being chosen; signing in has none.
import {iconMarkup} from './icon.js';
import {plural, t} from './i18n.js';

/** Length is the only rule the server holds a password to, so the meter
 *  counts towards twelve and fills on towards twenty. */
export const PASSWORD_MINIMUM = 12;

export function passwordStrength(length) {
  const level = length === 0 ? '' : length < PASSWORD_MINIMUM ? 'short' : length < 16 ? 'fair' : 'good';
  return {level, fill: Math.min(length / 20, 1) * 100};
}

/** Wire one field. Returns `sync`, to redraw the button and meter after a
 *  language change or a reset, which fires no input event. */
export function createPasswordField(field) {
  const input = field.querySelector('input');
  const reveal = field.querySelector('.password-reveal');
  const meter = field.querySelector('.password-strength');
  function drawReveal() {
    if (!reveal) return;
    const shown = input.type === 'text';
    reveal.innerHTML = iconMarkup(shown ? 'excluded' : 'eye');
    reveal.setAttribute('aria-pressed', String(shown));
    reveal.setAttribute('aria-label', t(shown ? 'password.hide' : 'password.reveal'));
    reveal.title = reveal.getAttribute('aria-label');
  }
  function drawMeter() {
    if (!meter) return;
    const {length} = input.value;
    const {level, fill} = passwordStrength(length);
    meter.dataset.level = level;
    meter.style.setProperty('--fill', `${fill}%`);
    meter.querySelector('b').textContent = level === 'short'
      ? plural('password.short', PASSWORD_MINIMUM - length)
      : level ? t(`password.${level}`) : t('password.rule');
  }
  reveal?.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    drawReveal();
    input.focus();
  });
  input.addEventListener('input', drawMeter);
  function sync() { drawReveal(); drawMeter(); }
  /** Back to hidden and empty-metered, for a form being reused. */
  function hide() {
    input.type = 'password';
    sync();
  }
  sync();
  return {sync, hide};
}
