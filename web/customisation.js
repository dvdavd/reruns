import {escapeMarkup} from 'media-ui';
import {createDrawerControls} from './drawer.js';
import {preferences} from './preferences.js';
import {DEFAULT_LOCALE, LOCALES, t} from './i18n.js';
import {PALETTES, gradientAt, paletteGradient, paletteStyle} from './palette.js';

const PALETTE_PROPERTIES = ['--button-hue', '--theme-hue', '--color-accent', '--color-accent-strong', '--logo-gradient', '--logo-1', '--logo-2', '--logo-3', '--logo-4'];
// This module runs only once the whole module graph has loaded, well after the
// first paint, so the chosen palette is also kept as a stylesheet that
// index.html's head script puts in place before anything is drawn. Once the
// palette is applied here its inline styles carry it, and that early copy goes,
// so that choosing Cooler later is not overruled by it.
const EARLY_STYLE_KEY = 'archive-palette-style';
function keepEarlyStyle(css) {
  document.getElementById('palette-early')?.remove();
  try {
    if (css) localStorage.setItem(EARLY_STYLE_KEY, css);
    else localStorage.removeItem(EARLY_STYLE_KEY);
  } catch { /* The palette still applies, just after the first paint. */ }
}

function applyPalette(key) {
  const root = document.documentElement.style;
  const logoStops = document.querySelectorAll('#reruns-rainbow stop');
  if (key === 'cooler') {
    for (const property of PALETTE_PROPERTIES) root.removeProperty(property);
    for (const stop of logoStops) stop.style.removeProperty('stop-color');
    keepEarlyStyle('');
    return;
  }
  const style = paletteStyle(key, logoStops.length);
  for (const [property, value] of Object.entries(style.properties)) root.setProperty(property, value);
  logoStops.forEach((stop, index) => { stop.style.stopColor = style.stops[index]; });
  const properties = PALETTE_PROPERTIES.map(property => `${property}:${root.getPropertyValue(property)}`).join(';');
  const stopRules = [...logoStops].map((stop, index) => `#reruns-rainbow stop:nth-of-type(${index + 1}){stop-color:${stop.style.stopColor}}`);
  keepEarlyStyle([`:root{${properties}}`, ...stopRules].join('\n'));
}

// Optional so the node tests, which have no window, can still import this.
const prefersLight = globalThis.matchMedia?.('(prefers-color-scheme: light)');

// Each choice is kept with the account, and a key never chosen follows the
// admin's default. The browser holds a copy (see preferences.js) so the theme
// is known before the first paint.
const SETTINGS = {
  'theme': {key: 'archive-theme', values: ['dark', 'light', 'system'], fallback: 'dark', apply: value => {
    // The page's stylesheets only know dark and light, so System is resolved
    // here and again whenever the system changes its mind.
    document.documentElement.dataset.theme = value === 'system' ? (prefersLight?.matches ? 'light' : 'dark') : value;
  }},
  'player-lighting': {key: 'archive-player-lighting', values: ['on', 'automatic', 'off'], fallback: 'off',
    // Realtime became On. Efficient (once Fast) blended seek-sheet images; it
    // flickered and saved little, so Automatic, which backs off when the page
    // is struggling, replaces it.
    renamed: {realtime: 'on', efficient: 'automatic', fast: 'automatic'}, dataset: 'playerLighting', event: 'archive-lighting-change'},
  'popup-player-size': {key: 'archive-popup-player-size', values: ['small', 'medium', 'large'], fallback: 'medium', dataset: 'popupPlayerSize'},
  'player-rounding': {key: 'archive-player-rounding', values: ['default', 'small', 'off'], fallback: 'default', dataset: 'playerRounding'},
  'palette': {key: 'archive-palette', values: Object.keys(PALETTES), fallback: 'original', dataset: 'palette', apply: applyPalette,
    // Aurora went for being hard to tell from Ocean; Pastel and Gold for Ice and
    // Mint & teal, Gold's pale yellow having been too pale for a white icon.
    renamed: {aurora: 'ocean', pastel: 'ice', gold: 'mint'}},
  // The colours themselves are swapped by web/styles, only while a video is
  // open; this is just the switch it reads from body. On recolours the whole
  // theme, Player only the page's own panels and the player's controls.
  'video-colours': {key: 'archive-video-colours', values: ['off', 'player', 'on'], fallback: 'off', dataset: 'videoColours'},
  // The grids and shelves count their columns on a window resize, so a new
  // card width announces itself as one rather than each listening for it.
  'card-size': {key: 'archive-card-size', values: ['small', 'medium', 'large'], fallback: 'medium', dataset: 'cardSize', event: 'resize'},
  // Worded once, by app.js as the page loads: the markup and everything made
  // from the catalogue (menus, option lists, the rows built once at startup).
  // Translating index.html again here would undo text the page has changed
  // since (Subscribe turned Unsubscribe), so a change of language is applied
  // by loading the page again; see reloadForLanguage.
  'language': {key: 'archive-language', values: LOCALES, fallback: DEFAULT_LOCALE},
};

function read(setting) {
  try {
    let saved = preferences.getItem(setting.key);
    saved = setting.renamed?.[saved] ?? saved;
    if (setting.values.includes(saved)) return saved;
  } catch { /* Keep the current default when storage is unavailable. */ }
  return setting.fallback;
}
const current = Object.fromEntries(Object.entries(SETTINGS).map(([name, setting]) => [name, read(setting)]));
export const playerLightingMode = () => current['player-lighting'];
export const chosenLanguage = () => current.language;
// What the page was worded in when it loaded.
const loadedLanguage = current.language;

/** Applies a new language by loading the page afresh. The choice reaches the
 * server first: the page being loaded asks it for the account's settings and
 * would otherwise be handed the old language back. */
async function reloadForLanguage(sync, report) {
  if (current.language === loadedLanguage) return;
  let saved = true;
  try { saved = (await preferences.flush?.()) !== false; } catch { saved = false; }
  if (saved) return location.reload();
  // The reloaded page would be handed the old language back by the server,
  // so stay as we are and say so, rather than seem to ignore the choice.
  current.language = loadedLanguage;
  try { preferences.setItem(SETTINGS.language.key, loadedLanguage); } catch { /* Only this page. */ }
  sync('language');
  report?.(t('appearance.language.unsaved'), {error: true});
}

export function createCustomisationUI(drawer, {report} = {}) {
  const controls = createDrawerControls(drawer);
  function sync(name) {
    const setting = SETTINGS[name];
    if (setting.dataset) document.body.dataset[setting.dataset] = current[name];
    for (const input of drawer.querySelectorAll(`[name="${name}"]`)) input.checked = input.value === current[name];
    for (const button of drawer.querySelectorAll(`[data-choice-for="${name}"]`)) {
      button.setAttribute('aria-pressed', String(button.dataset.value === current[name]));
    }
    for (const toggle of drawer.querySelectorAll(`[data-customisation-switch="${name}"]`)) {
      toggle.setAttribute('aria-checked', String(current[name] === 'on'));
    }
    // Each option's one-line note shows only while it is the chosen one, so a
    // setting costs a line however many options it has.
    for (const note of drawer.querySelectorAll(`[data-note-for="${name}"]`)) note.hidden = note.dataset.noteValue !== current[name];
    for (const text of drawer.querySelectorAll(`[data-selected-name="${name}"]`)) text.textContent = t(`${name}.${current[name]}`);
    setting.apply?.(current[name]);
    if (setting.event) window.dispatchEvent(new Event(setting.event));
  }
  // The palette tiles are drawn from the list above rather than written out
  // in the markup, so a palette is added in one place.
  drawer.querySelector('[data-palette-choices]').append(...Object.entries(PALETTES).map(([key, palette]) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="radio" name="palette" value="${key}"><span class="preview-palette" aria-hidden="true"><span class="preview-logo"></span><span class="preview-button"></span><span class="preview-button preview-button-last"></span></span><span class="choice-name sr-only">${escapeMarkup(t(`palette.${key}`))}</span>`;
    label.title = t(`palette.${key}`);
    const preview = label.querySelector('.preview-palette');
    preview.style.setProperty('--preview-gradient', paletteGradient(palette));
    preview.style.setProperty('--preview-reference', gradientAt(palette.stops, 5 / 8, palette.spread));
    preview.style.setProperty('--preview-first', gradientAt(palette.stops, 1 / 8, palette.spread));
    preview.style.setProperty('--preview-last', gradientAt(palette.stops, 7 / 8, palette.spread));
    return label;
  }));
  drawer.querySelector('[data-customisation-close]').addEventListener('click', controls.close);
  function choose(name, value) {
    current[name] = value;
    // Kept even when it is the built-in default: with an admin default in place,
    // an absent choice would mean that one instead.
    try { preferences.setItem(SETTINGS[name].key, value); } catch { /* Still apply for this session. */ }
    sync(name);
    if (name === 'language') reloadForLanguage(sync, report);
  }
  for (const [name, setting] of Object.entries(SETTINGS)) {
    for (const input of drawer.querySelectorAll(`[name="${name}"]`)) input.addEventListener('change', () => {
      if (input.checked) choose(name, input.value);
    });
    sync(name);
  }
  // Settings with a few named options are pills (.statistics-ranking), the
  // same control the library and statistics use; the tile pickers stay radios.
  for (const button of drawer.querySelectorAll('[data-choice-for]')) {
    button.addEventListener('click', () => choose(button.dataset.choiceFor, button.dataset.value));
  }
  for (const toggle of drawer.querySelectorAll('[data-customisation-switch]')) {
    toggle.addEventListener('click', () => {
      const name = toggle.dataset.customisationSwitch;
      choose(name, current[name] === 'on' ? 'off' : 'on');
    });
  }
  drawer.querySelector('[data-customisation-reset]').addEventListener('click', () => {
    // Back to what the account would have had without choosing: the admin's
    // default where there is one, else the built-in.
    for (const [name, setting] of Object.entries(SETTINGS)) {
      try { preferences.removeItem(setting.key); } catch { /* Still apply for this session. */ }
      current[name] = read(setting);
      sync(name);
    }
    reloadForLanguage(sync, report);
  });
  prefersLight?.addEventListener('change', () => { if (current.theme === 'system') sync('theme'); });
  window.addEventListener('storage', event => {
    for (const [name, setting] of Object.entries(SETTINGS)) {
      // Another tab's language is left to that tab: reloading here would race
      // its save to the server, and the old language could win.
      if (name === 'language') continue;
      if (event.key === setting.key || event.key === null) { current[name] = read(setting); sync(name); }
    }
  });
  return controls;
}
