import {post, request} from './api.js';
import {LOCALES, t, translateMarkup, useLocale} from './i18n.js';
import {PALETTES, paletteStyle} from './palette.js';
import {createPasswordField} from './password-field.js';
import {followThemeColour} from './theme-colour.js';

followThemeColour();

const form = document.querySelector('#auth-form');
const message = document.querySelector('#auth-message');
const passwordField = createPasswordField(form.querySelector('[data-password-field]'));
// Like the theme, the page follows the language this browser last used, so it
// is in place before the config arrives; only a browser with no choice yet
// takes the admin's, once it is known.
async function speak(tag) {
  const wanted = await useLocale(tag);
  document.documentElement.lang = wanted;
  document.title = t('auth.title');
  translateMarkup(document);
  passwordField.sync();
}
let remembered = '';
try { remembered = localStorage.getItem('archive-language') || ''; } catch { /* The default still works. */ }
await speak(remembered);
const config = await request('/api/auth/config');
// With no admin yet there is no one to sign in as, so the first admin is made
// on the setup page. Not when this page was sent a sign-in's outcome to show:
// an OIDC sign-in can be pending before any admin exists.
if (config.setup && !location.search) location.replace('/setup.html');
if (!LOCALES.includes(remembered) && LOCALES.includes(config.language)) await speak(config.language);
// A browser that never chose a theme takes the admin's default.
try {
  if (config.theme && !localStorage.getItem('archive-theme')) {
    document.documentElement.dataset.theme = config.theme === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : config.theme;
  }
} catch { /* The dark default still works without browser storage. */ }
// The palette: this browser's last choice, else the admin's default, else
// Original. Applied through palette.js rather than customisation.js, which
// would store the early-paint copy of whatever it sets.
let palette = '';
try { palette = localStorage.getItem('archive-palette') || ''; } catch { /* Fall back to the admin's. */ }
if (!PALETTES[palette]) palette = PALETTES[config.palette] ? config.palette : 'original';
const logoStops = document.querySelectorAll('#reruns-rainbow stop');
const style = paletteStyle(palette, logoStops.length);
for (const [property, value] of Object.entries(style.properties)) document.documentElement.style.setProperty(property, value);
logoStops.forEach((stop, index) => { stop.style.stopColor = style.stops[index]; });
const oidcLink = document.querySelector('#oidc-link');
oidcLink.hidden = !config.oidc;
document.querySelector('#auth-or').hidden = !config.oidc;
oidcLink.textContent = t('auth.signInWith', {name: config.oidcName || 'OIDC'});
if (location.search.includes('pending=1')) message.textContent = t('auth.pending');
if (location.search.includes('error=oidc')) message.textContent = t('auth.oidcFailed');
// An invite link (accounts-ui.js) carries its token in the fragment, which
// never reaches the server's logs. A good one turns the form into choosing a
// username and password; the address loses it so a reload or a shared
// screenshot does not carry it on.
const invite = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
if (invite) history.replaceState(null, '', location.pathname + location.search);
const inviting = invite && (await post('/api/auth/invite', {token: invite}).catch(() => ({}))).valid;
if (inviting) {
  document.querySelector('#auth-intro').textContent = t('auth.invite.intro');
  document.querySelector('#auth-submit').textContent = t('auth.invite.create');
  form.elements.username.autocomplete = 'username';
  form.elements.password.autocomplete = 'new-password';
  form.elements.password.minLength = 12;
  form.querySelector('.password-strength').hidden = false;
  passwordField.sync();
  oidcLink.hidden = true;
  document.querySelector('#auth-or').hidden = true;
} else if (invite) {
  message.textContent = t('auth.invite.invalid');
}
/** Where a signed-out visit was headed. Only a path on this site, so a
 *  crafted link cannot send a fresh sign-in somewhere else. */
function nextPage() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}
form.elements.username.focus();
form.addEventListener('input', () => { message.textContent = ''; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  try {
    const values = Object.fromEntries(new FormData(form));
    if (inviting) await post('/api/auth/invite/redeem', {...values, token: invite});
    else await post('/api/auth/login', values);
    location.replace(nextPage());
  } catch (error) {
    message.textContent = error.message || String(error);
  }
});

if (location.search.includes('disabled=1')) message.textContent = t('auth.disabled');
