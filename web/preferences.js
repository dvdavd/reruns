import {request} from './api.js';

/**
 * Settings that follow the account rather than the browser. This has
 * localStorage's interface, so the code that reads and writes a setting barely
 * changes, but a write also goes to the server, and what the browser holds is a
 * copy of what applies to whoever is signed in: their own choice, else the
 * admin's default for that key, else nothing (so the built-in default).
 *
 * The copy stays because the theme has to be known before the first paint, and
 * because the sign-in page follows whatever was used last. Signing in replaces
 * the copy with that account's settings and the admin defaults.
 */
const POSITION_PREFIX = 'reruns.playback:';
// Where a window was last browsing, and the palette's early stylesheet, belong
// to this browser and are derived from other keys rather than chosen.
const LOCAL_ONLY = new Set(['archive-directory', 'archive-palette-style']);
const SAVE_DELAY = 1500;

export const isSynced = key => typeof key === 'string' && (key.startsWith(POSITION_PREFIX)
  || /^(archive|ytdlp)-/.test(key) && !LOCAL_ONLY.has(key));
// A resume position is one person's, so only the other settings can be a default.
export const isDefaultable = key => isSynced(key) && !key.startsWith(POSITION_PREFIX);

function save(changes) {
  return request('/api/preferences', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({changes}),
    // Resume positions are written as the page closes.
    keepalive: true,
  });
}

// Reading it can throw where storage is blocked, and there is none under node.
function browserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function createPreferences({storage: fixed, send = save} = {}) {
  // Looked up each time so a test can put its own storage in place.
  const backing = () => fixed ?? browserStorage();
  let defaults = {};
  let signedIn = false;
  const pending = new Map();
  let timer = null;

  const keys = () => {
    const found = [];
    try { for (let index = 0; index < backing().length; index++) found.push(backing().key(index)); } catch { /* Nothing to copy. */ }
    return found.filter(isSynced);
  };

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending.size) return true;
    const changes = Object.fromEntries(pending);
    pending.clear();
    try { await send(changes); } catch {
      // Kept for the next change to carry, unless something newer has replaced it.
      for (const [key, value] of Object.entries(changes)) if (!pending.has(key)) pending.set(key, value);
      return false;
    }
    return true;
  }
  function queue(key, value) {
    if (!signedIn || !isSynced(key)) return;
    pending.set(key, value);
    timer ??= setTimeout(flush, SAVE_DELAY);
  }

  const store = {
    getItem: key => backing().getItem(key),
    setItem(key, value) {
      backing().setItem(key, value);
      queue(key, String(value));
    },
    /** Drops this account's own choice, so the admin's default (if any) applies. */
    removeItem(key) {
      if (signedIn && isDefaultable(key) && key in defaults) backing().setItem(key, defaults[key]);
      else backing().removeItem(key);
      queue(key, null);
    },
    flush,
    defaults: () => ({...defaults}),

    /** Makes the stored copy match the signed-in account. It runs before the
     * page reads any setting; without an account to save to (or a server that
     * has none) the browser's own copy simply stays in charge. */
    async sync() {
      let state;
      try { state = await request('/api/preferences'); } catch { return false; }
      defaults = state.defaults || {};
      const values = {...state.values};
      const effective = {};
      for (const [key, value] of Object.entries(defaults)) if (isDefaultable(key)) effective[key] = value;
      for (const [key, value] of Object.entries(values)) if (isSynced(key)) effective[key] = value;
      for (const key of keys()) if (!(key in effective)) backing().removeItem(key);
      for (const [key, value] of Object.entries(effective)) backing().setItem(key, value);
      signedIn = true;
      return true;
    },

    /** What this browser now has becomes the default for everyone who has not
     * chosen otherwise, and for the sign-in page. */
    async setDefaults() {
      const values = {};
      for (const key of keys()) if (isDefaultable(key)) values[key] = backing().getItem(key);
      await request('/api/preferences/defaults', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({values}),
      });
      defaults = values;
      return values;
    },
    async clearDefaults() {
      await request('/api/preferences/defaults', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({values: {}}),
      });
      defaults = {};
    },
  };
  return store;
}

export const preferences = createPreferences();
// Top-level, so every module that imports this waits for the account's settings
// before it reads one.
await preferences.sync();
// Safari on a phone may never send pagehide, but does say the page is hidden.
globalThis.addEventListener?.('pagehide', () => { preferences.flush(); });
globalThis.document?.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') preferences.flush();
});
