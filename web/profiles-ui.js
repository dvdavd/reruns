import {escapeMarkup, html, render} from 'media-ui';
import {icon} from './icon.js';
import {post, request} from './api.js';
import {createDrawerControls, createDrawerAddButton} from './drawer.js';
import {BLANK_PROFILE, PROFILE_OPTIONS, audioCodecChoices, chatChoices, codecChoices, commentChoices, formatChoices, organisationChoices, profileLabel, profilesSummary} from './download-profiles.js';
import {t} from './i18n.js';
import {audioLanguagePicker, subtitleLanguagePicker} from './subtitle-languages.js';

// Functions, not lists: the words follow the language chosen after this module
// has loaded. Only the values are compared, so a label may change freely.
const qualities = () => [['best', t('profiles.quality.best')], ['2160', '2160p'], ['1440', '1440p'],
  ['1080', '1080p'], ['720', '720p'], ['480', '480p']];
const subtitleChoices = () => [['none', t('profiles.subtitles.none')], ['manual', t('profiles.subtitles.manual')],
  ['manual_auto', t('profiles.subtitles.auto')]];
const playlistChoices = () => [['all', t('profiles.playlist.all')], ['single', t('profiles.playlist.single')]];

/* Not in the shared sprite, so drawn inline. It fills in as the row's chosen
   one, through the same is-solid the pause and play buttons use; a fill
   attribute would not do, since the shared .icon rule sets fill: none. */
function star(extra = '') {
  return html`<svg class=${`icon ${extra}`.trim()} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873l-6.158 -3.245" />
  </svg>`;
}

/** Named download settings: what to fetch, in what shape, and where to put it.
    The server validates every one of these, so the form only has to carry the
    values across and show what came back when it says no. */
export function createProfilesUI({drawer, drawerClose, resetButton, summary, list, onChange, report}) {
  // The profile being edited, or null when the list is just a list. A new
  // profile is this too, with an empty id, so one form serves both.
  const addButton = drawer.querySelector('#profiles-new');
  const updateAddButton = createDrawerAddButton(addButton);
  const editorSection = drawer.querySelector('#profiles-editor');
  let editing = null;
  let initialProfile = '';
  let discardArmed = false;
  const closeMarkup = drawerClose.innerHTML;
  const discardNote = document.createElement('p');
  discardNote.className = 'playlist-editor-note';
  discardNote.setAttribute('role', 'status');
  discardNote.hidden = true;
  drawer.querySelector('.drawer-heading-block').append(discardNote);
  const snapshot = () => JSON.stringify([editing.name, editing.library, editing.options]);

  function disarmDiscard() {
    discardArmed = false;
    discardNote.hidden = true;
    drawerClose.innerHTML = closeMarkup;
    drawerClose.classList.remove('playlist-confirm', 'danger');
    drawerClose.setAttribute('aria-label', t('profiles.close'));
    drawerClose.removeAttribute('title');
    updateAddButton(Boolean(editing));
    const cancel = editorSection.querySelector('.profile-cancel');
    if (cancel) cancel.textContent = t('common.cancel');
  }

  function mayDiscard() {
    if (!editing || snapshot() === initialProfile || discardArmed) {
      disarmDiscard();
      return true;
    }
    discardArmed = true;
    discardNote.textContent = t('profiles.unsaved');
    discardNote.hidden = false;
    addButton.textContent = t('common.discard');
    const cancel = editorSection.querySelector('.profile-cancel');
    if (cancel) cancel.textContent = t('common.discard');
    drawerClose.classList.add('playlist-confirm', 'danger');
    drawerClose.innerHTML = `${closeMarkup}<span class="playlist-confirm-label">${escapeMarkup(t('common.discard'))}</span>`;
    drawerClose.setAttribute('aria-label', t('profiles.discardChanges'));
    drawerClose.title = t('profiles.discardChanges');
    return false;
  }

  function startEditing(profile) {
    editing = clone(profile);
    initialProfile = snapshot();
    disarmDiscard();
    draw();
    drawer.scrollTop = 0;
    editorSection.querySelector('[name="name"]')?.focus({preventScroll: true});
  }

  function cancelEditing() {
    if (!mayDiscard()) return;
    editing = null;
    draw();
  }

  editorSection.addEventListener('input', disarmDiscard);
  editorSection.addEventListener('change', disarmDiscard);
  drawer.addEventListener('click', event => {
    if (event.target === drawer && event.clientX < drawer.getBoundingClientRect().left) return;
    const button = event.target.closest?.('button');
    if (button !== addButton && button !== drawerClose
      && !button?.classList.contains('profile-cancel')) disarmDiscard();
  }, {capture: true});
  // The editor stays mounted while it folds shut: unmounting it on close would
  // drop it from the page at once and the closing transition would never run.
  // So the last form drawn is kept and shown, inert, until it has gone.
  let lastEditor = null;
  let settings = {downloadProfiles: [], defaultProfile: '', libraries: []};

  async function act(path, body, failure) {
    try {
      const payload = await post(path, body);
      show(payload);
      onChange(payload);
      return true;
    } catch (error) {
      report(t('error.reason', {message: t(failure), reason: error.message || error}), {error: true});
      return false;
    }
  }

  function field(label, name, values, hint = '') {
    const options = {...PROFILE_OPTIONS, ...editing.options};
    return html`<label class="profile-field">
      <span>${label}</span>
      <select name=${name} value=${options[name]}
        onChange=${event => { editing.options[name] = event.target.value; draw(); }}>
        ${values.map(([value, text]) => html`<option value=${value}>${text}</option>`)}
      </select>
      ${hint ? html`<small>${hint}</small>` : null}
    </label>`;
  }

  /* One form for both new and existing profiles. The format list and the
     subtitles row follow the media choice, the same way the topbar's options
     popup does, so audio never offers a resolution it cannot honour. */
  function editor() {
    const options = {...PROFILE_OPTIONS, ...editing.options};
    const audio = options.media === 'audio';
    return html`<form class="profile-editor" onSubmit=${save}>
      <label class="profile-field">
        <span>${t('profiles.name')}</span>
        <input type="text" name="name" value=${editing.name} required maxlength="60"
          placeholder="Music" autocomplete="off"
          onInput=${event => { editing.name = event.target.value; }}/>
      </label>
      <label class="profile-field">
        <span>${t('profiles.saveTo')}</span>
        <select name="library" value=${editing.library}
          onChange=${event => { editing.library = event.target.value; draw(); }}>
          <option value="">${t('profiles.preferredFolder')}</option>
          ${settings.libraries.map(library =>
            html`<option value=${library.id}>${library.path}</option>`)}
        </select>
      </label>
      <label class="profile-field profile-field-wide">
        <span>${t('profiles.subfolder')}</span>
        <input type="text" name="subdirectory" value=${options.subdirectory}
          placeholder="Music/%(artist,uploader)s" autocomplete="off" spellcheck="false"
          onInput=${event => { editing.options.subdirectory = event.target.value; }}/>
        <small>${t('profiles.subfolderHint')}</small>
      </label>
      ${field(t('profiles.media'), 'media', [['video', t('profiles.media.video')], ['audio', t('profiles.media.audioOnly')]])}
      ${audio ? null : field(t('profiles.maxQuality'), 'quality', qualities())}
      ${field(t('profiles.format'), 'container', formatChoices(audio))}
      ${audio ? null : field(t('profiles.codec'), 'codec', codecChoices(),
        t('profiles.codecHint'))}
      ${field(t('profiles.audioCodec'), 'audio_codec', audioCodecChoices(), t('profiles.audioCodecHint'))}
      ${audio ? null : field(t('profiles.subtitles'), 'subtitles', subtitleChoices())}
      ${audio || options.subtitles === 'none' ? null : html`
        <div class="profile-field profile-field-wide">
          <span>${t('profiles.languages')}</span>
          ${subtitleLanguagePicker({
            value: options.subtitle_languages,
            onChange: tags => { editing.options.subtitle_languages = tags; draw(); },
          })}
        </div>`}
      <div class="profile-field profile-field-wide">
        <span>${t('profiles.audioLanguages')}</span>
        ${audioLanguagePicker({
          value: options.audio_languages,
          onChange: tags => { editing.options.audio_languages = tags; draw(); },
        })}
      </div>
      ${field(t('profiles.comments'), 'comments', commentChoices(), t('profiles.commentsHint'))}
      ${field(t('profiles.chat'), 'chat', chatChoices(), t('profiles.chatHint'))}
      ${field(t('profiles.playlist'), 'playlist', playlistChoices())}
      ${field(t('profiles.organise'), 'organization', organisationChoices())}
      <label class="profile-field profile-field-wide">
        <span>${t('profiles.arguments')}</span>
        <textarea name="arguments" rows="2" spellcheck="false" value=${options.arguments}
          placeholder="--embed-thumbnail --parse-metadata …"
          onInput=${event => { editing.options.arguments = event.target.value; }}></textarea>
        <small>${t('profiles.argumentsHint')}</small>
      </label>
      <div class="profile-editor-actions">
        <button type="button" class="profile-cancel"
          onClick=${cancelEditing}>${discardArmed ? t('common.discard') : t('common.cancel')}</button>
        <button type="submit" class="profile-save">
          ${editing.id ? t('profiles.save') : t('profiles.create')}</button>
      </div>
    </form>`;
  }

  async function save(event) {
    event.preventDefault();
    const body = {name: editing.name, library: editing.library,
      options: {...PROFILE_OPTIONS, ...editing.options}};
    // Audio cannot carry the video-only answers, and the server says so rather
    // than guessing; clear them here so a switch to audio saves first time.
    if (body.options.media === 'audio') {
      body.options.subtitles = 'none';
      body.options.codec = 'any';
      // An audio file is one stream, so only the first language can be kept.
      body.options.audio_languages = body.options.audio_languages.split(',')[0];
      if (!formatChoices(true).some(([value]) => value === body.options.container)) {
        body.options.container = 'auto';
      }
    } else if (!formatChoices(false).some(([value]) => value === body.options.container)) {
      body.options.container = 'auto';
    }
    const path = editing.id ? `/api/settings/profiles/${editing.id}` : '/api/settings/profiles';
    if (await act(path, body, 'profiles.error.save')) {
      disarmDiscard();
      editing = null;
      draw();
    }
  }

  /* One line per profile like the library folders: its name and what it does,
     then small round actions. */
  /* Starring is a choice among the rows rather than a switch on each, so the
     starred row is the one new downloads use and there is always exactly one:
     the way to unstar a profile is to star another. */
  function row(profile) {
    const isDefault = profile.id === settings.defaultProfile;
    return html`<li class="library-row profile-row" key=${profile.id}>
      <div class="library-row-text">
        <strong class="profile-name">${profile.name}</strong>
        <small class="profile-detail">${profileLabel(profile, settings.libraries)}</small>
      </div>
      <span class="library-row-actions">
        <button type="button" role="radio" aria-checked=${String(isDefault)}
          class=${`library-row-action${isDefault ? ' active' : ''}`}
          aria-label=${t('profiles.use', {name: profile.name})}
          title=${isDefault ? t('profiles.usedNow') : t('profiles.use', {name: profile.name})}
          onClick=${() => isDefault || act(`/api/settings/profiles/${profile.id}/default`,
            {}, 'profiles.error.default')}>${
            star(isDefault ? 'is-solid' : '')}</button>
        <button type="button" class="library-row-action" aria-label=${t('profiles.edit')}
          title=${t('profiles.edit')}
          onClick=${() => {
            if (mayDiscard()) startEditing(profile);
          }}>${icon('pencil')}</button>
        <button type="button" class="library-row-action danger" aria-label=${t('profiles.delete')}
          title=${t('profiles.delete')}
          onClick=${() => {
            if (confirm(t('profiles.confirmDelete', {name: profile.name}))) {
              act(`/api/settings/profiles/${profile.id}/delete`, {}, 'profiles.error.delete');
            }
          }}>${icon('trash')}</button>
      </span>
    </li>`;
  }

  function clone(profile) {
    return {...profile, options: {...PROFILE_OPTIONS, ...profile.options}};
  }

  function draw() {
    summary.textContent = profilesSummary(settings.downloadProfiles);
    updateAddButton(Boolean(editing));
    if (discardArmed) addButton.textContent = t('common.discard');
    if (editing) lastEditor = editor();
    editorSection.hidden = !editing;
    if (lastEditor) render(lastEditor, editorSection.firstElementChild);
    // The star is an icon in the middle of the sentence, so the sentence is
    // translated whole with a marker where it goes, then split around it.
    const [hintBefore, hintAfter] = t('profiles.hint', {star: '\u0001'}).split('\u0001');
    render(html`<div class="profile-panel" role="radiogroup"
      aria-label=${t('profiles.groupLabel')}>
      <p class="profile-hint">${hintBefore}${star('profile-inline-icon')}${hintAfter}</p>
      <ul class="library-list library-blocks">
        ${settings.downloadProfiles.map(row)}
      </ul>
    </div>`, list);
  }

  function show(payload) {
    settings = {downloadProfiles: [], defaultProfile: '', libraries: [], ...payload};
    draw();
  }

  async function refresh() {
    try {
      const payload = await request('/api/settings');
      show(payload);
      return payload;
    } catch (error) {
      report(t('error.reason', {message: t('folders.error.load'), reason: error.message || error}), {error: true});
      return null;
    }
  }

  const {open: openDrawer, close} = createDrawerControls(drawer, {beforeClose: mayDiscard});
  function open() {
    editing = null;
    disarmDiscard();
    openDrawer();
    refresh();
  }
  // The heading action cancels whichever profile is currently being edited.
  addButton.addEventListener('click', () => {
    if (editing) { cancelEditing(); return; }
    startEditing(BLANK_PROFILE);
  });
  drawerClose.addEventListener('click', close);
  // Profiles of your own stay; the stock ones come back as they were made, so
  // a confirmation is owed to any edits made to those.
  resetButton.addEventListener('click', () => {
    if (!confirm(t('profiles.confirmRestore'))) return;
    disarmDiscard();
    editing = null;
    act('/api/settings/profiles/reset', {}, 'profiles.error.restore');
  });
  return {open, refresh};
}
