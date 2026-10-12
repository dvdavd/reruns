// The panel that asks before a video is deleted. Deleting is the one thing the
// archive does that cannot be undone, and a video is not always one file — the
// same video downloaded at several qualities is one card in the gallery — so
// the question is what exactly to remove rather than yes or no. The browser's
// own confirm cannot ask that.
//
// The model half is pure, so it reads without a DOM; the dialog half wires up
// the markup index.html carries.

import {codecNameOf} from './item-adapter.js';
import {plural, t} from './i18n.js';

/** The one file a video that was only downloaded once is made of. */
function soleVersion(item) {
  return {
    id: item.id,
    label: item.quality || item.parts?.[0]?.resolution || t('delete.theFile'),
    container: item.archive?.container || '',
    codec: item.codec,
    encoding: item.parts?.[0]?.encoding,
    sizeBytes: item.sizeBytes,
    filename: item.filename,
  };
}

/**
 * A row per file that deleting could remove, best copy first — the order the
 * player's format switcher lists them in, so the two read the same way.
 */
const sourcesOf = item => {
  const formats = item.archive?.formats || [];
  return formats.length > 1 ? formats : [soleVersion(item)];
};

export function deletionVersions(item, format = {}) {
  return sourcesOf(item).map(source => ({
    id: source.id,
    // The picture alone: the codec and container follow in the detail, which
    // is what tells two copies of the same quality apart.
    label: source.shortLabel || source.label || t('delete.theFile'),
    detail: [codecNameOf(source), source.container && source.container.toUpperCase(),
      source.sizeBytes && format.bytes ? format.bytes(source.sizeBytes) : '',
    ].filter(Boolean).join(' · '),
    filename: source.filename || '',
  }));
}

/** Keep the playing copy if it survives; otherwise take the next listed copy. */
export function survivingFormatId(item, chosen) {
  const current = item.archive?.formatId || item.id;
  if (!chosen.includes(current)) return current;
  const versions = deletionVersions(item);
  const index = versions.findIndex(version => version.id === current);
  for (let step = 1; step <= versions.length; step += 1) {
    const next = versions[(index + step) % versions.length];
    if (!chosen.includes(next.id)) return next.id;
  }
  return null;
}

/**
 * What the panel says above the list. A video held in several copies is worth
 * saying so plainly: the danger is someone ticking everything to be rid of a
 * 4K file and losing the video itself.
 */
export function deletionPrompt(item, versions) {
  return {
    title: t('delete.title', {title: item.title}),
    note: versions.length > 1 ? t('delete.noteMany', {count: versions.length}) : t('delete.noteOne'),
  };
}

/** "3 videos · 3 files · 805 KB" for whichever rows are ticked. */
export function playlistTotal(rows, format = {}) {
  const files = rows.reduce((sum, row) => sum + row.ids.length, 0);
  const sizeBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  return [plural('count.videos', rows.length), plural('count.files', files),
    sizeBytes && format.bytes ? format.bytes(sizeBytes) : ''].filter(Boolean).join(' · ');
}

/**
 * What deleting a playlist would touch: a row per video, with every copy of it
 * that is on disk. A personal playlist is only a list, so its videos are
 * deleted only if the viewer ticks them; a downloaded one is the videos
 * themselves, in every format they were fetched in.
 */
export function playlistDeletion(playlist, format = {}) {
  const rows = playlist.items.map(item => {
    const sources = sourcesOf(item);
    const sizeBytes = sources.reduce((sum, source) => sum + (Number(source.sizeBytes) || 0), 0);
    return {
      title: item.title,
      ids: sources.map(source => source.id),
      sizeBytes,
      detail: sizeBytes && format.bytes ? format.bytes(sizeBytes) : '',
      // Only said where there is more than one, so a plain playlist is not a
      // column of identical qualities.
      formats: sources.length > 1
        ? sources.map(source => source.shortLabel || source.label || t('delete.theFile')).join(', ') : '',
    };
  });
  const multiple = rows.filter(row => row.formats).length;
  let note = t(playlist.manual ? 'delete.playlistChoose' : 'delete.playlistRemoves');
  if (multiple) note += ' ' + plural('delete.playlistFormats', multiple);
  return {title: t(playlist.manual ? 'delete.playlistTitle' : 'delete.playlistVideosTitle', {title: playlist.title}), note,
    total: playlistTotal(rows, format), rows, multiple};
}

/**
 * Wires the panel up. `confirm` opens it on a video and settles with the ids
 * to delete, or null if the viewer backed out — so the caller reads as the
 * browser's own confirm did, and every way out of the dialog settles it.
 */
export function createDeleteDialog(dialog, {format = {}} = {}) {
  const titleNode = dialog.querySelector('[data-delete-title]');
  const noteNode = dialog.querySelector('[data-delete-note]');
  const listNode = dialog.querySelector('[data-delete-versions]');
  const cancelButton = dialog.querySelector('[data-delete-cancel]');
  const selectedButton = dialog.querySelector('[data-delete-selected]');
  const allButton = dialog.querySelector('[data-delete-all]');
  const totalNode = dialog.querySelector('[data-delete-total]');
  let settle = null;
  // Set while the panel is asking about a playlist: its rows, which carry one
  // tick box each, and whether it is a personal one (which can be deleted
  // without any of its videos).
  let playlistPlan = null;

  const boxes = () => [...listNode.querySelectorAll('input[type="checkbox"]')];
  const ticked = () => boxes().filter(box => box.checked).map(box => box.value);

  function finish(ids) {
    const resolve = settle;
    settle = null;
    if (dialog.open) dialog.close();
    resolve?.(ids);
  }
  // Escape and the close button both end in `close`, so settling there means
  // no route out can leave the caller waiting on a promise that never lands.
  dialog.addEventListener('close', () => finish(null));
  cancelButton.addEventListener('click', () => finish(null));
  // A modal dialog fills the viewport, so a click outside the panel lands on
  // the dialog itself. That is the backdrop, and backing out is what it means.
  dialog.addEventListener('click', event => {
    if (event.target === dialog) finish(null);
  });
  const tickedRows = () => ticked().map(index => playlistPlan.rows[Number(index)]);
  selectedButton.addEventListener('click', () => {
    // A personal playlist's "keep the files": nothing to delete from disk.
    if (playlistPlan) { finish([]); return; }
    const chosen = ticked();
    if (chosen.length) finish(chosen);
  });
  allButton.addEventListener('click', () => {
    if (!playlistPlan) { finish(boxes().map(box => box.value)); return; }
    const rows = tickedRows();
    if (rows.length) finish(rows.flatMap(row => row.ids));
  });
  // Nothing ticked is nothing to do, so the button says so rather than the
  // dialog closing on a delete that removes no files.
  listNode.addEventListener('change', () => {
    if (playlistPlan) drawPlaylistTotals();
    else selectedButton.disabled = ticked().length === 0;
  });

  function drawVersions(versions) {
    const single = versions.length < 2;
    listNode.replaceChildren(...versions.map(version => {
      const row = document.createElement(single ? 'div' : 'label');
      row.className = 'delete-version';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = version.id;
      box.checked = true;
      // One copy is not a choice: keep its checked value for Delete, but make
      // the hidden input and its row noninteractive.
      box.hidden = single;
      box.disabled = single;
      const name = document.createElement('span');
      name.className = 'delete-version-name';
      name.textContent = version.label;
      const detail = document.createElement('span');
      detail.className = 'delete-version-detail';
      detail.textContent = version.detail;
      const file = document.createElement('span');
      file.className = 'delete-version-file';
      file.textContent = version.filename;
      row.append(box, name, detail, file);
      row.classList.toggle('is-sole', single);
      return row;
    }));
  }

  return {
    confirm(item) {
      // Asking again while an answer is outstanding — a second menu, somehow —
      // backs the first question out rather than stranding it.
      if (settle) finish(null);
      const versions = deletionVersions(item, format);
      const prompt = deletionPrompt(item, versions);
      titleNode.textContent = prompt.title;
      noteNode.textContent = prompt.note;
      drawVersions(versions);
      const single = versions.length < 2;
      selectedButton.textContent = single ? t('delete.one') : t('delete.selected');
      playlistPlan = null;
      dialog.classList.remove('is-playlist');
      selectedButton.hidden = false;
      selectedButton.disabled = false;
      totalNode.hidden = true;
      allButton.textContent = t('delete.all');
      allButton.hidden = single;
      dialog.showModal();
      cancelButton.focus();
      return new Promise(resolve => { settle = resolve; });
    },
    /**
     * The same question for a whole playlist: every video listed with its
     * size and a tick, and the total of those ticked. Settles with the ids to
     * delete from disk (none, for a personal playlist deleted with its files
     * kept), or null if the viewer backed out.
     */
    confirmPlaylist(playlist) {
      if (settle) finish(null);
      const plan = playlistDeletion(playlist, format);
      playlistPlan = {...plan, manual: Boolean(playlist.manual)};
      dialog.classList.add('is-playlist');
      titleNode.textContent = plan.title;
      noteNode.textContent = plan.note;
      listNode.replaceChildren(...(plan.rows.length ? plan.rows.map(drawRow) : [emptyRow()]));
      selectedButton.hidden = !playlist.manual;
      selectedButton.disabled = false;
      selectedButton.textContent = t('delete.playlistKeep');
      allButton.hidden = false;
      drawPlaylistTotals();
      dialog.showModal();
      cancelButton.focus();
      return new Promise(resolve => { settle = resolve; });
    },
  };

  /** The total line and the delete button's count follow the ticks. */
  function drawPlaylistTotals() {
    const rows = tickedRows();
    totalNode.hidden = !playlistPlan.rows.length;
    totalNode.textContent = playlistTotal(rows, format);
    allButton.disabled = rows.length === 0;
    // A downloaded playlist is only the videos that remain of it, so it goes
    // when every one is ticked and otherwise stays with those left.
    const key = playlistPlan.manual ? 'delete.playlistAndVideos'
      : rows.length === playlistPlan.rows.length ? 'delete.playlistEverything' : 'delete.playlistVideos';
    allButton.textContent = plural(key, rows.length);
  }
  function drawRow(row, index) {
    const node = document.createElement('label');
    node.className = 'delete-version';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(index);
    box.checked = true;
    const name = document.createElement('span');
    name.className = 'delete-version-name';
    name.textContent = name.title = row.title;
    const detail = document.createElement('span');
    detail.className = 'delete-version-detail';
    detail.textContent = row.detail;
    const formats = document.createElement('span');
    formats.className = 'delete-version-file';
    formats.textContent = row.formats ? t('delete.playlistRowFormats', {formats: row.formats}) : '';
    node.append(box, name, detail, formats);
    return node;
  }
  function emptyRow() {
    const node = document.createElement('div');
    node.className = 'delete-version is-sole';
    node.textContent = t('delete.playlistEmpty');
    return node;
  }
}
