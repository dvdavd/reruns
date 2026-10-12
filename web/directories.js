// Narrowing the archive to one of its folders. The server lists the folders
// (see Archive.directories) and every item's id starts with its folder's key,
// so a folder's videos are a prefix match and channels and playlists follow
// from those videos like everything else.
//
// The choice is kept per browser, as the shelf settings are: a phone and a
// desktop may well be looking at different parts of the same archive.

export const DIRECTORY_KEY = 'archive-directory';

/**
 * What the menu offers, top to bottom, each with how deep it is indented.
 * With one library its root is the same thing as "All videos", so only the
 * folders in it are listed; with several, each library's root is a row.
 */
export function directoryRows(entries) {
  const several = new Set(entries.map(entry => entry.library)).size > 1;
  const rows = [];
  for (const entry of entries) {
    if (!entry.path) {
      if (several) rows.push({key: entry.key, name: entry.name, depth: 0, count: entry.count});
      continue;
    }
    rows.push({key: entry.key, name: entry.name, count: entry.count,
      depth: entry.path.split('/').length - (several ? 0 : 1)});
  }
  return rows;
}

/** Whether there is anything to choose between. One library with no folders
 *  in it leaves only "All videos", which is no choice at all. */
export const offersDirectories = entries => directoryRows(entries).length > 0;

/** Whether an item lives in the folder a key names; the empty key is all. */
export const inDirectory = (item, key) => !key || String(item.id).startsWith(key);

/** The saved folder, or all of them when it is gone or unreadable. */
export function readDirectory(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(DIRECTORY_KEY);
    return typeof saved === 'string' ? saved : '';
  } catch { return ''; }
}

export function saveDirectory(key, storage = globalThis.localStorage) {
  try {
    if (key) storage?.setItem(DIRECTORY_KEY, key);
    else storage?.removeItem(DIRECTORY_KEY);
  } catch { /* Still applies for this session. */ }
}
