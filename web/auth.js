import {post, request} from './api.js';
import {LOCALES, t, translateMarkup, useLocale} from './i18n.js';
import {PALETTES, paletteStyle} from './palette.js';

const form = document.querySelector('#auth-form');
const message = document.querySelector('#auth-message');
// Like the theme, the page follows the language this browser last used, so it
// is in place before the config arrives; only a browser with no choice yet
// takes the admin's, once it is known.
async function speak(tag) {
  const wanted = await useLocale(tag);
  document.documentElement.lang = wanted;
  document.title = t('auth.title');
  translateMarkup(document);
  // The hint holds a command in the middle of the sentence, so it is split around it.
  const [before, after] = t('auth.tokenHint', {command: '\u0001'}).split('\u0001');
  const hint = document.querySelector('#setup-token-hint');
  const command = document.createElement('code');
  command.textContent = 'docker logs';
  hint.replaceChildren(before, command, after ?? '');
}
let remembered = '';
try { remembered = localStorage.getItem('archive-language') || ''; } catch { /* The default still works. */ }
await speak(remembered);
const config = await request('/api/auth/config');
if (!LOCALES.includes(remembered) && LOCALES.includes(config.language)) await speak(config.language);
if (config.setup) {
  document.querySelector('#auth-intro').textContent = t('auth.setupIntro');
  document.querySelector('#setup-token-row').hidden = false;
  document.querySelector('#auth-submit').textContent = t('auth.createAdmin');
  form.elements.password.autocomplete = 'new-password';
  form.elements.password.minLength = 12;
  // Disabled outside setup so the sign-in form does not send it.
  form.elements.repeat.disabled = false;
  form.elements.repeat.required = true;
  document.querySelector('#repeat-row').hidden = false;
  if (!config.configWritable) {
    const warning = document.querySelector('#auth-warning');
    warning.textContent = t('auth.notWritable', {dir: config.configDir});
    warning.hidden = false;
  }
}
// The page follows whichever theme this browser last used; only a browser with
// no choice yet (the head script found none) gets the admin's.
try {
  if (config.theme && !localStorage.getItem('archive-theme')) {
    document.documentElement.dataset.theme = config.theme === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : config.theme;
  }
} catch { /* The dark default still works without browser storage. */ }
// The palette follows the theme's rule: this browser's last choice, else the
// admin's default, else Original. Applied through palette.js rather than
// customisation.js, which would store the early-paint copy of whatever it sets.
let palette = '';
try { palette = localStorage.getItem('archive-palette') || ''; } catch { /* Fall back to the admin's. */ }
if (!PALETTES[palette]) palette = PALETTES[config.palette] ? config.palette : 'original';
const logoStops = document.querySelectorAll('#reruns-rainbow stop');
const style = paletteStyle(palette, logoStops.length);
for (const [property, value] of Object.entries(style.properties)) document.documentElement.style.setProperty(property, value);
logoStops.forEach((stop, index) => { stop.style.stopColor = style.stops[index]; });
const oidcLink = document.querySelector('#oidc-link');
// Offered during first-run setup too: a provider group can make the first admin.
oidcLink.hidden = !config.oidc;
document.querySelector('#auth-or').hidden = !config.oidc;
oidcLink.textContent = t('auth.signInWith', {name: config.oidcName || 'OIDC'});
if (location.search.includes('pending=1')) message.textContent = t('auth.pending');
if (location.search.includes('error=oidc')) message.textContent = t('auth.oidcFailed');
form.elements.username.focus();
form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  if (config.setup && form.elements.password.value !== form.elements.repeat.value) {
    message.textContent = t('auth.mismatch');
    return;
  }
  try {
    await post(config.setup ? '/api/auth/setup' : '/api/auth/login', Object.fromEntries(new FormData(form)));
    location.replace('/');
  } catch (error) {
    message.textContent = error.message || String(error);
  }
});

if (location.search.includes('disabled=1')) message.textContent = t('auth.disabled');
