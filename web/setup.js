// First-run setup: a glass panel, the welcome on the
// left and the steps sliding in on the right. It asks first how people will
// sign in, because OIDC and no sign-in are both set in the server's
// environment, so for those the page can only say what to set.
//
// It also finishes a setup that stopped short: an admin with no library
// folder is sent here by app.js and starts at the library step. That covers
// a server without sign-in too, which has no admin to make.
//
// `?preview` walks the steps without sending anything; `?palette=` picks the
// logo's colours and `?theme=` light or dark.
import {post, request} from './api.js';
import {iconMarkup} from './icon.js';
import {followButton} from './popover.js';
import {createPasswordField} from './password-field.js';
import {LOCALES, t, translateMarkup, useLocale} from './i18n.js';
import {PALETTES, paletteStyle} from './palette.js';
import {followThemeColour} from './theme-colour.js';

followThemeColour();

// Which pages follow the first depends on the answer to it. Only local
// accounts are made here; the other two are set in the server's environment,
// so each has one page saying how.
const ROUTES = {local: ['auth', 'account', 'library', 'done'], oidc: ['auth', 'oidc'], none: ['auth', 'none'],
  library: ['library', 'done']};
// The step on the left each page belongs to: an instructions page stands in
// the account's place, relabelled.
const markerOf = name => (name === 'oidc' || name === 'none' ? 'account' : name);
const params = new URLSearchParams(location.search);
const preview = params.has('preview');
const wizard = document.querySelector('.wizard');
const page = name => wizard.querySelector(`[data-page="${name}"]`);
const storage = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
};

let config = preview
  ? {setup: true, oidc: false, configWritable: true, version: 'preview'}
  : await request('/api/auth/config');
let settings = preview
  ? {libraries: [{id: 'preview', path: '/srv/videos', exists: true, downloads: true}]}
  : null;
let current = '';

// ---- The logo's colours -----------------------------------------------------

// A browser that never chose a theme takes the admin's default.
try {
  if (config.theme && !localStorage.getItem('archive-theme')) {
    document.documentElement.dataset.theme = config.theme === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : config.theme;
  }
} catch { /* The dark default still works without browser storage. */ }
if (['light', 'dark'].includes(params.get('theme'))) document.documentElement.dataset.theme = params.get('theme');

const palette = [params.get('palette'), storage.get('archive-palette'), config.palette].find(key => PALETTES[key]) || 'original';
function paint() {
  document.getElementById('palette-early')?.remove();
  const stops = document.querySelectorAll('#reruns-rainbow stop');
  const style = paletteStyle(palette, stops.length);
  for (const [property, value] of Object.entries(style.properties)) document.documentElement.style.setProperty(property, value);
  stops.forEach((stop, index) => { stop.style.stopColor = style.stops[index]; });
}

// ---- Words ----------------------------------------------------------------

async function speak(tag) {
  document.documentElement.lang = await useLocale(tag);
  document.title = t('setup.title');
  translateMarkup(document);
  const version = wizard.querySelector('[data-version]');
  version.textContent = config.version ? t('setup.version', {version: config.version}) : '';
  version.hidden = !config.version;
  for (const button of wizard.querySelectorAll('[data-copy]')) {
    button.innerHTML = iconMarkup('copy');
    button.setAttribute('aria-label', t('setup.copy'));
    button.title = t('setup.copy');
  }
  for (const button of wizard.querySelectorAll('[data-info]')) button.innerHTML = iconMarkup('info');
  describeOidc();
  passwordField.sync();
  if (settings) drawLibraries();
}

// ---- Pages ----------------------------------------------------------------

let resuming = false;
// The answer to the first page. Until one is pressed the steps on the left
// are local accounts', the recommended way, or OIDC's once it is set up.
let chosen = 'local';
const route = () => ROUTES[resuming ? 'library' : chosen];

/** Moves to a page. Those already passed are stacked behind to the left, those
 *  still to come wait off to the right, so going on slides the new page in
 *  from the right over the old one, and going back reverses it. A page off
 *  the chosen route waits on the right with the pages to come. */
function show(name) {
  const order = route();
  const index = order.indexOf(name);
  for (const section of wizard.querySelectorAll('[data-page]')) {
    const at = order.indexOf(section.dataset.page);
    section.dataset.state = section.dataset.page === name ? 'current'
      : at !== -1 && at < index ? 'before' : 'after';
    // Off-stage pages still take their place in the grid; inert keeps the
    // keyboard and screen readers out of them.
    section.inert = section.dataset.page !== name;
  }
  // The steps listed on the left are the route's: four for local accounts,
  // two (the question and its instructions) for the others.
  const markers = order.map(markerOf);
  wizard.querySelectorAll('[data-marker]').forEach(marker => {
    const at = markers.indexOf(marker.dataset.marker);
    marker.hidden = at === -1;
    marker.classList.toggle('is-done', at !== -1 && (at < index || name === 'done'));
    if (at === index) marker.setAttribute('aria-current', 'step');
    else marker.removeAttribute('aria-current');
  });
  wizard.querySelector('[data-marker="account"]').textContent = t(order[1] === 'account' ? 'setup.step.account' : 'setup.step.setUp');
  wizard.querySelector('.wizard-progress').hidden = name === 'closed';
  // An archive that is already set up has nothing left to get set up.
  wizard.querySelector('.wizard-welcome').textContent = t(name === 'closed' ? 'setup.welcome.closed' : 'setup.welcome');
  current = name;
  const section = page(name);
  section.querySelector('[data-message]')?.replaceChildren();
  const heading = section.querySelector('h2');
  heading.tabIndex = -1;
  // After the slide has begun, so focusing does not scroll the pane sideways.
  requestAnimationFrame(() => {
    const field = section.querySelector('input[type="text"]:not([hidden]), input[type="password"]');
    (field && name === 'account' ? field : heading).focus({preventScroll: true});
  });
}

function say(name, text) {
  page(name).querySelector('[data-message]').textContent = text;
}

async function busy(form, work) {
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try { await work(); } catch (error) {
    say(form.dataset.page, error.message || String(error));
  } finally { button.disabled = false; }
}

for (const back of wizard.querySelectorAll('[data-back]')) {
  back.addEventListener('click', () => show(route()[route().indexOf(current) - 1]));
}

// ---- Sign-in type ---------------------------------------------------------

const auth = page('auth');
const oidc = page('oidc');
{
  // Opened rightwards from the icon whatever half of the screen it is in: the
  // usual choice by halves sent it back over the wizard's side pane.
  const button = oidc.querySelector('[data-info]');
  const help = document.getElementById('oidc-optional-help');
  const follow = followButton(help, () => button, 6, () => 'vertical', 'down', 'start');
  help.addEventListener('toggle', event => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (open) follow.start();
    else follow.stop();
  });
}

function describeOidc() {
  oidc.querySelector('[data-callback]').textContent = `${location.origin}/auth/oidc/callback`;
  oidc.querySelector('[data-oidc-env]').textContent = [
    'RERUNS_OIDC_ISSUER=https://identity.example.com',
    'RERUNS_OIDC_CLIENT_ID=',
    'RERUNS_OIDC_CLIENT_SECRET=',
    `RERUNS_PUBLIC_URL=${location.origin}`,
  ].join('\n');
  oidc.querySelector('[data-oidc-optional]').textContent = [
    'RERUNS_OIDC_ADMIN_GROUP=reruns_admin',
    'RERUNS_OIDC_LIBRARIES_CLAIM=reruns_libraries',
  ].join('\n');
  // Already configured: the server knows the provider, so the page can offer
  // it rather than explain it.
  const ready = Boolean(config.oidc);
  oidc.querySelector('[data-oidc-ready]').hidden = !ready;
  oidc.querySelector('[data-oidc-steps]').hidden = ready;
  oidc.querySelector('[data-check]').hidden = ready;
  const name = config.oidcName || 'OIDC';
  oidc.querySelector('[data-oidc-ready-text]').textContent = t('setup.auth.oidc.ready', {name});
  oidc.querySelector('[data-oidc-link]').textContent = t('auth.signInWith', {name});
}
if (config.oidc) chosen = 'oidc';
for (const option of auth.querySelectorAll('.wizard-option')) {
  option.insertAdjacentHTML('beforeend', iconMarkup('chevron-right', 'wizard-option-go'));
}

for (const button of wizard.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.previousElementSibling.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.classList.add('is-copied');
      setTimeout(() => button.classList.remove('is-copied'), 1200);
    } catch {
      // No clipboard outside a secure origin: select it for a manual copy.
      getSelection().selectAllChildren(button.previousElementSibling);
    }
  });
}

auth.addEventListener('submit', event => {
  event.preventDefault();
  chosen = event.submitter?.value || chosen;
  show(route()[1]);
});

// The instructions pages finish with a restart, so their button asks the
// server whether that has happened yet.
for (const form of [oidc, page('none')]) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy(form, async () => {
      if (preview) { say(form.dataset.page, t('setup.auth.notYet')); return; }
      const me = await request('/api/auth/me').catch(() => null);
      if (me && me.authEnabled === false) { location.replace('/'); return; }
      config = await request('/api/auth/config');
      describeOidc();
      if (!(form === oidc && config.oidc)) say(form.dataset.page, t('setup.auth.notYet'));
    });
  });
}

// ---- Account --------------------------------------------------------------

const account = page('account');
// No repeat field: the reveal button is how a typo is caught, as in every
// other password form, and a repeat after it put the button in the way of
// tabbing from one field to the next.
const passwordField = createPasswordField(account.querySelector('[data-password-field]'));

// A token in the fragment fills itself in and stays in the browser.
const handed = new URLSearchParams(location.hash.slice(1)).get('token');
if (handed) {
  account.elements.token.value = handed;
  account.querySelector('[data-token-row]').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
}
if (!config.configWritable) {
  const warning = account.querySelector('[data-not-writable]');
  warning.textContent = t('auth.notWritable', {dir: config.configDir});
  warning.hidden = false;
}

account.addEventListener('submit', event => {
  event.preventDefault();
  const {username, password, token} = account.elements;
  const refuse = (key, field) => { say('account', t(key)); field.focus(); };
  if (!token.value.trim()) { account.querySelector('[data-token-row]').hidden = false; return refuse('setup.account.needToken', token); }
  if (!username.value.trim()) return refuse('setup.account.needName', username);
  if (password.value.length < 12) return refuse('server.giveAUsernameAndA', password);
  busy(account, async () => {
    if (!preview) {
      await post('/api/auth/setup', {username: username.value, password: password.value, token: token.value.trim()});
      settings = await request('/api/settings');
    }
    // The account exists now; there is no going back to make it again.
    for (const back of wizard.querySelectorAll('[data-back]')) back.hidden = true;
    drawLibraries();
    show('library');
  });
});

// ---- Library --------------------------------------------------------------

const library = page('library');
function drawLibraries() {
  const list = library.querySelector('[data-libraries]');
  const many = settings.libraries.length > 1;
  library.querySelector('[data-downloads-hint]').hidden = !many;
  list.replaceChildren(...settings.libraries.map(entry => {
    const row = document.createElement('li');
    row.className = 'wizard-library';
    row.classList.toggle('is-missing', !entry.exists);
    // The Folders drawer's row: a single folder, with an arrow into it on the
    // one new downloads go to, then its round actions.
    row.innerHTML = `${iconMarkup(entry.downloads ? 'folder-down' : 'folder', 'library-row-icon')}`
      + '<span class="wizard-library-path"></span><span class="library-row-actions"></span>';
    row.querySelector('.wizard-library-path').textContent = entry.path;
    const actions = row.querySelector('.library-row-actions');
    const action = (label, glyph, onClick, extra = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `library-row-action${extra}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML = iconMarkup(glyph);
      button.addEventListener('click', onClick);
      actions.append(button);
      return button;
    };
    // With one folder there is nowhere else for downloads to go, so there is
    // nothing to choose.
    if (many) {
      const target = action(t('folders.saveHere'), 'download', () => entry.downloads || setDownloads(entry.id),
        entry.downloads ? ' active' : '');
      target.setAttribute('role', 'switch');
      target.setAttribute('aria-checked', String(entry.downloads));
      if (entry.downloads) target.title = t('folders.saveHere.active');
    }
    const copy = action(t('folders.copy'), 'copy', async () => {
      try {
        await navigator.clipboard.writeText(entry.path);
        copy.classList.add('is-copied');
        setTimeout(() => copy.classList.remove('is-copied'), 1200);
      } catch {
        // No clipboard outside a secure origin: select it for a manual copy.
        getSelection().selectAllChildren(row.querySelector('.wizard-library-path'));
      }
    });
    action(t('folders.remove'), 'trash', () => removeLibrary(entry), ' danger');
    return row;
  }));
  if (!settings.libraries.length) {
    const empty = document.createElement('li');
    empty.className = 'wizard-library is-empty';
    empty.textContent = t('setup.library.none');
    list.append(empty);
  }
}
async function setDownloads(id) {
  try {
    if (preview) settings.libraries.forEach(entry => { entry.downloads = entry.id === id; });
    else settings = await post(`/api/settings/libraries/${encodeURIComponent(id)}/downloads`);
  } catch (error) { say('library', error.message || String(error)); }
  drawLibraries();
}
async function removeLibrary(entry) {
  if (!confirm(t('folders.confirmRemove', {path: entry.path}))) return;
  say('library', '');
  try {
    if (preview) {
      settings.libraries = settings.libraries.filter(other => other !== entry);
      if (entry.downloads && settings.libraries[0]) settings.libraries[0].downloads = true;
    } else settings = await post(`/api/settings/libraries/${encodeURIComponent(entry.id)}/delete`);
  } catch (error) { say('library', error.message || String(error)); }
  drawLibraries();
}
async function addLibrary() {
  const field = library.elements.path;
  const path = field.value.trim();
  if (!path) { field.focus(); return; }
  say('library', '');
  try {
    if (preview) settings.libraries.push({id: `preview-${settings.libraries.length}`, path, exists: true, downloads: false});
    else settings = await post('/api/settings/libraries', {path});
    field.value = '';
    drawLibraries();
  } catch (error) { say('library', error.message || String(error)); }
  field.focus();
}
library.querySelector('[data-add-library]').addEventListener('click', addLibrary);
library.elements.path.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); addLibrary(); }
});
library.addEventListener('submit', event => {
  event.preventDefault();
  if (!settings.libraries.length) { say('library', t('setup.library.needOne')); library.elements.path.focus(); return; }
  show('done');
});

page('done').querySelector('[data-open]').addEventListener('click', event => {
  if (!preview) return;
  // A preview starts again rather than leaving for a library it never made.
  event.preventDefault();
  for (const back of wizard.querySelectorAll('[data-back]')) back.hidden = false;
  show('auth');
});

// ---- Start ----------------------------------------------------------------

/** Where to begin: the first question while there is no admin, the library
 *  step for an admin (or a server without sign-in) still without a folder,
 *  and otherwise a note that it is all done. */
async function opening() {
  if (config.setup) return 'auth';
  if (preview) return 'closed';
  const me = await request('/api/auth/me').catch(() => null);
  if (!me || !(me.authEnabled === false || me.role === 'admin')) return 'closed';
  settings = await request('/api/settings').catch(() => null);
  if (!settings || settings.libraries.length) return 'closed';
  resuming = true;
  drawLibraries();
  return 'library';
}

paint();
await speak([storage.get('archive-language'), config.language].find(tag => LOCALES.includes(tag)) || LOCALES[0]);
show(await opening());
// The first page arrives too, rather than being there already. The pages'
// places are drawn first, with transitions off, and only then switched on,
// so the others start where they wait instead of travelling there.
document.body.getBoundingClientRect();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('is-ready')));
