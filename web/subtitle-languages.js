import {html} from 'media-ui';
import {t} from './i18n.js';

/* What a profile asks for is a wish, not a list: the videos it will fetch do
   not exist yet, so nothing can say which languages they carry. These are the
   ones worth offering first, with the browser's own languages ahead of them so
   the common answer is the first thing under the pointer. */
const COMMON = ['en', 'es', 'pt', 'fr', 'de', 'it', 'ru', 'ja', 'ko', 'zh', 'hi', 'ar'];

/** yt-dlp matches a tag against a site's spelling of it, so plain "en" misses
 *  en-GB and en-orig; the wildcard is what makes a language mean the language.
 *  Everything here works in the base tag and only adds the suffix on the way
 *  out, so "en" and "en.*" are one answer rather than two. */
export function baseTag(tag) {
  return tag.trim().replace(/\.\*$/, '');
}

export function languageName(tag) {
  const base = baseTag(tag);
  try {
    const names = new Intl.DisplayNames(navigator.languages, {type: 'language'});
    return names.of(base) || base;
  } catch { return base; }
}

/** The stored value is yt-dlp's own comma-separated list, which stays the
 *  thing saved and sent: the picker is a way of writing it, not a new format. */
export function parseLanguageTags(value) {
  return [...new Set((value || '').split(',').map(baseTag).filter(Boolean))];
}

export function formatLanguageTags(tags, suffix = '.*') {
  return tags.map(tag => `${baseTag(tag)}${suffix}`).join(',');
}

/** The offered set, with anything already asked for kept in front so a tag
 *  typed by hand becomes a box that can be unticked again. */
export function suggestedLanguages(value) {
  const chosen = parseLanguageTags(value);
  let browser = [];
  try {
    browser = (navigator.languages || []).map(tag => baseTag(tag).split('-')[0]);
  } catch { /* Not every host has a navigator; the common list alone will do. */ }
  return [...new Set([...chosen, ...browser, ...COMMON])];
}

export function toggleLanguage(value, tag, suffix = '.*') {
  const chosen = parseLanguageTags(value);
  const base = baseTag(tag);
  return formatLanguageTags(chosen.includes(base)
    ? chosen.filter(entry => entry !== base)
    : [...chosen, base], suffix);
}

/** The picker for subtitles, and for audio: the same boxes, written in
 *  different tags. yt-dlp matches subtitle languages as patterns, so those
 *  take the ".*" that makes "en" mean en-GB and en-orig too; an audio format
 *  filter matches a prefix already, so its tags stay plain. */
function languagePicker({value, onChange, id, suffix, words, menu = false}) {
  const chosen = new Set(parseLanguageTags(value));
  return html`
    <div class="subtitle-languages">
      ${menu ? html`
        <div class="download-language-list" role="menu" aria-label=${words.tags()}>
          <button type="button" role="menuitemcheckbox" aria-checked=${String(!chosen.size)}
            onClick=${() => onChange('')}>
            <span>${words.none()}</span>
          </button>
          <div class="download-language-divider" role="separator"></div>
          ${suggestedLanguages(value).map(tag => html`
            <button type="button" role="menuitemcheckbox" key=${tag}
              aria-checked=${String(chosen.has(tag))}
              onClick=${() => onChange(toggleLanguage(value, tag, suffix))}>
              <span>${languageName(tag)}</span>
            </button>`)}
        </div>` : html`
        <div class="subtitle-language-options">
          ${suggestedLanguages(value).map(tag => html`
            <label class="subtitle-language" key=${tag}>
              <input type="checkbox" checked=${chosen.has(tag)}
                onChange=${() => onChange(toggleLanguage(value, tag, suffix))}/>
              <span>${languageName(tag)}</span>
            </label>`)}
        </div>`}
      <input class="subtitle-language-tags" type="text" id=${id} value=${value}
        placeholder=${words.placeholder()} autocomplete="off" spellcheck="false"
        maxlength="200" aria-label=${words.tags()}
        onInput=${event => onChange(event.target.value)}/>
      <small>${chosen.size ? words.chosenHint() : words.emptyHint()}</small>
    </div>`;
}

/** One picker for both places that ask: the profile editor and the download
 *  arrow's manual overrides. Ticking writes the tags, and the tags stay
 *  visible and editable underneath for a language the list does not name.
 *  `menu` draws the list as the popup's own ticked rows rather than boxes. */
export function subtitleLanguagePicker({value, onChange, id, menu}) {
  return languagePicker({value, onChange, id, menu, suffix: '.*', words: {
    none: () => t('subtitles.all'), placeholder: () => t('subtitles.placeholder'), tags: () => t('subtitles.tags'),
    chosenHint: () => t('subtitles.chosenHint'), emptyHint: () => t('subtitles.emptyHint')}});
}

/** The audio languages to keep, in the order ticked, which is the order the
 *  player lists them. Nothing ticked is yt-dlp's one track, not every track. */
export function audioLanguagePicker({value, onChange, id, menu}) {
  return languagePicker({value, onChange, id, menu, suffix: '', words: {
    none: () => t('audio.default'), placeholder: () => t('audio.placeholder'), tags: () => t('audio.tags'),
    chosenHint: () => t('audio.chosenHint'), emptyHint: () => t('audio.emptyHint')}});
}
