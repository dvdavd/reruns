/**
 * Looks up the interface's text. A catalogue maps a key to a string, or for a
 * count to an object keyed by plural category (`one`, `other`, ...), and a
 * string may name values as `{name}`. en-GB holds every key and is the
 * fallback, so another catalogue lists only what it words differently: en-US
 * is a few dozen spellings, not a copy.
 *
 * The active locale is module state rather than something passed around,
 * because nearly every module that draws text needs it. It is set once, before
 * the page builds anything, by `useLocale`; node tests that never call it get
 * en-GB.
 */
import base from './locales/en-GB.js';

export const DEFAULT_LOCALE = 'en-GB';
// en-GB is always loaded, being the fallback, and the others on demand, so a
// language nobody picked costs nothing.
const CATALOGUES = {
  'en-GB': async () => ({default: {}}),
  'en-US': () => import('./locales/en-US.js'),
};
export const LOCALES = Object.keys(CATALOGUES);

let active = {locale: DEFAULT_LOCALE, messages: {}, plurals: new Intl.PluralRules(DEFAULT_LOCALE)};

export const locale = () => active.locale;

/** Loads a catalogue and makes it the one `t` and `plural` read. An unknown
 * tag keeps the default rather than throwing, since it comes from a setting. */
export async function useLocale(tag) {
  const wanted = LOCALES.includes(tag) ? tag : DEFAULT_LOCALE;
  const messages = (await CATALOGUES[wanted]()).default;
  active = {locale: wanted, messages, plurals: new Intl.PluralRules(wanted)};
  return wanted;
}

function fill(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (whole, name) => name in values ? String(values[name]) : whole);
}
const lookup = key => active.messages[key] ?? base[key];

/** A key nobody has written shows as itself, which is ugly but findable. */
export function t(key, values = {}) {
  const found = lookup(key);
  return fill(typeof found === 'string' ? found : key, values);
}

/** `count` picks the plural form; it is also available as `{count}`. */
export function plural(key, count, values = {}) {
  const found = lookup(key);
  const form = found && typeof found === 'object'
    ? found[active.plurals.select(count)] ?? found.other : key;
  return fill(form, {...values, count});
}

/**
 * Translates the markup already on the page. `data-i18n` sets an element's
 * text and `data-i18n-attrs="aria-label:key,title:key"` sets attributes. The
 * HTML keeps its en-GB wording, so a page that never loads a catalogue still
 * reads correctly and the default locale shows no flash.
 *
 * With children, only the first non-blank text node is replaced, so a `<small>`
 * after a label, or an icon before one, survives. A key written with `{child}`
 * (or `{child1}`, `{child2}`... for several) puts the element's children there
 * instead, for a sentence with a `<code>` or a link in the middle.
 */
export function translateMarkup(root) {
  // The root counts too, for a button that is retranslated after its markup is put back.
  const within = selector => [...(root.matches?.(selector) ? [root] : []), ...(root.querySelectorAll?.(selector) ?? [])];
  for (const element of within('[data-i18n]')) {
    const text = t(element.dataset.i18n);
    if (!element.children.length) { element.textContent = text; continue; }
    // A sentence with elements in it, such as a <code> or a link: written with
    // {child} for a lone one, or {child1}, {child2}... where there are several,
    // and split around them in order.
    const kids = [...element.children];
    const markers = Object.fromEntries(kids.map((_, index) => [`child${index + 1}`, `\u0001${index}\u0002`]));
    if (kids.length === 1) markers.child = markers.child1;
    const pieces = t(element.dataset.i18n, markers).split(/\u0001(\d+)\u0002/);
    if (pieces.length > 1) {
      element.replaceChildren(...pieces.map((piece, index) => (index % 2 ? kids[Number(piece)] : piece)));
      continue;
    }
    const node = [...element.childNodes].find(child => child.nodeType === 3 && child.textContent.trim());
    if (node) node.textContent = text;
  }
  for (const element of within('[data-i18n-attrs]')) {
    for (const pair of element.dataset.i18nAttrs.split(',')) {
      const [name, key] = pair.split(':');
      element.setAttribute(name.trim(), t(key.trim()));
    }
  }
}

/*
 * The server's refusals arrive as English text, and a message names no code to
 * look up. So each is matched against the wording the catalogue holds for it
 * (the `server.*` keys, written as the server writes them, with {name} where
 * it fills a value in) and said again in the chosen language. Anything it does
 * not recognise, such as yt-dlp's own output, is shown as it came.
 */
let serverMatchers = null;
function matchersForServer() {
  serverMatchers ??= Object.keys(base).filter(key => key.startsWith('server.')).map(key => {
    const names = [];
    const pattern = base[key].split(/(\{\w+\})/).map(part => {
      const placeholder = part.match(/^\{(\w+)\}$/);
      if (placeholder) { names.push(placeholder[1]); return '(.+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return {key, names, regex: new RegExp(`^${pattern}$`)};
  // Messages with no value in them first, so a plain one is never read as a template.
  }).sort((a, b) => a.names.length - b.names.length);
  return serverMatchers;
}

export function serverMessage(text) {
  const message = String(text ?? '');
  // http.server ends the message it prints with a full stop.
  const stopped = message.endsWith('.');
  const bare = stopped ? message.slice(0, -1) : message;
  for (const {key, names, regex} of matchersForServer()) {
    // Without the full stop first, so a value at the end does not swallow it.
    for (const candidate of stopped ? [bare, message] : [message]) {
      const found = regex.exec(candidate);
      if (!found) continue;
      const said = t(key, Object.fromEntries(names.map((name, index) => [name, found[index + 1]])));
      const droppedStop = stopped && candidate === bare;
      return droppedStop && !/[.!?…]$/.test(said) ? `${said}.` : said;
    }
  }
  return message;
}
