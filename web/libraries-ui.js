import {html, render} from 'media-ui';
import {icon} from './icon.js';
import {post, request} from './api.js';
import {createDrawerControls, createDrawerAddControls} from './drawer.js';
import {plural, t} from './i18n.js';

export function librariesSummary(libraries) {
  if (!libraries.length) return t('folders.none');
  return plural('count.folders', libraries.length);
}

/** The folders the archive scans, and which of them new downloads land in. */
export function createLibrariesUI({drawer, drawerClose, summary, list, form, pathInput,
  onChange, report}) {
  async function act(path, body, failure) {
    try {
      show(await post(path, body));
      onChange();
      return true;
    } catch (error) {
      report(t('error.reason', {message: t(failure), reason: error.message || error}), {error: true});
      return false;
    }
  }

  /** Adds a folder for a caller with its own form; resolves to the failure's
      text, or an empty string once it is added. */
  async function add(path) {
    try {
      show(await post('/api/settings/libraries', {path}));
      onChange();
      return '';
    } catch (error) {
      return error.message || String(error);
    }
  }

  /* One line per folder in the folder list: the path in monospace,
     then small round actions on the right. */
  function row(library) {
    return html`<li class="library-row" key=${library.id} data-missing=${String(!library.exists)}>
      <div class="library-row-text">
        <code class="library-path" title=${library.path}>${library.path}</code>
        ${library.exists ? null
          : html`<small class="library-warning">${t('folders.missing')}</small>`}
      </div>
      <span class="library-row-actions">
        <button type="button" role="switch" aria-checked=${String(library.downloads)}
          class=${`library-row-action${library.downloads ? ' active' : ''}`}
          aria-label=${t('folders.saveHere')}
          title=${library.downloads ? t('folders.saveHere.active') : t('folders.saveHere')}
          onClick=${() => library.downloads || act(`/api/settings/libraries/${library.id}/downloads`, {},
            'folders.error.change')}>${icon('download')}</button>
        <button type="button" class="library-row-action" aria-label=${t('folders.copy')} title=${t('folders.copy')}
          onClick=${async () => {
            try {
              await navigator.clipboard.writeText(library.path);
              report(t('folders.copied'));
            } catch (error) {
              report(t('error.reason', {message: t('folders.error.copy'), reason: error.message || error}), {error: true});
            }
          }}>${icon('copy')}</button>
        <button type="button" class="library-row-action danger" aria-label=${t('folders.remove')} title=${t('folders.remove')}
          onClick=${() => {
            if (confirm(t('folders.confirmRemove', {path: library.path}))) {
              act(`/api/settings/libraries/${library.id}/delete`, {}, 'folders.error.remove');
            }
          }}>${icon('trash')}</button>
      </span>
    </li>`;
  }

  function show({libraries}) {
    summary.textContent = librariesSummary(libraries);
    render(libraries.length ? html`<ul class="library-list library-blocks">${libraries.map(row)}</ul>`
      : html`<p class="download-empty">${t('folders.empty')}</p>`,
    list);
  }

  async function refresh() {
    try {
      const settings = await request('/api/settings');
      show(settings);
      return settings;
    } catch (error) {
      report(t('error.reason', {message: t('folders.error.load'), reason: error.message || error}), {error: true});
      return null;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (await act('/api/settings/libraries', {path: pathInput.value.trim()},
      'folders.error.add')) { pathInput.value = ''; addControls.hide(); }
  });

  const addControls = createDrawerAddControls(drawer.querySelector('#libraries-new'), form);
  const {open: openDrawer, close} = createDrawerControls(drawer);
  function open() {
    openDrawer();
    refresh();
    addControls.hide();
  }
  drawerClose.addEventListener('click', close);
  return {open, refresh, add};
}
