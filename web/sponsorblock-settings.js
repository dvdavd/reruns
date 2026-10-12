/**
 * What the player does with each SponsorBlock category: play it as it comes,
 * offer a skip, jump past it, or run it by at speed. It is a viewer's preference rather
 * than part of the archive, so it is kept with the account; every category plays
 * normally until it is set otherwise.
 */
import {t} from './i18n.js';
import {preferences} from './preferences.js';

const ACTIONS_KEY = 'ytdlp-sponsorblock-actions-v1';
/** The categories-to-skip list this replaced, read once to carry choices over. */
const SKIP_KEY = 'ytdlp-sponsorblock-skip-v1';

export const SPONSOR_MODES = ['play', 'notify', 'skip', 'fast'];
export const sponsorModeLabels = () => Object.fromEntries(SPONSOR_MODES.map(mode => [mode, t(`sponsor.mode.${mode}`)]));
/** The speeds a fast-forwarded segment can run at; 2x unless chosen otherwise. */
export const FAST_SPEEDS = [1.5, 2, 3, 4, 6, 8];
export const FAST_SPEED_DEFAULT = 2;

function cleanAction(value) {
  const mode = SPONSOR_MODES.includes(value?.mode) ? value.mode : 'play';
  if (mode !== 'fast') return {mode};
  const speed = Number(value?.speed);
  return {mode, speed: FAST_SPEEDS.includes(speed) ? speed : FAST_SPEED_DEFAULT};
}

/**
 * A Map of category to `{mode, speed}`, holding only the categories that do
 * something; anything missing plays normally. A library saved before there
 * were modes at all is read as its skips, so nobody loses their choices.
 */
export function loadCategoryActions(storage = preferences) {
  const actions = new Map();
  try {
    const saved = storage.getItem(ACTIONS_KEY);
    if (saved) {
      for (const [category, value] of Object.entries(JSON.parse(saved) || {})) {
        const action = cleanAction(value);
        if (action.mode !== 'play') actions.set(category, action);
      }
      return actions;
    }
    const skips = JSON.parse(storage.getItem(SKIP_KEY) || '[]');
    if (Array.isArray(skips)) {
      for (const category of skips) {
        if (typeof category === 'string') actions.set(category, {mode: 'skip'});
      }
    }
  } catch (_) {}
  return actions;
}

export function saveCategoryActions(actions, storage = preferences) {
  const plain = {};
  for (const [category, action] of actions) {
    if (action?.mode && action.mode !== 'play') plain[category] = cleanAction(action);
  }
  try { storage.setItem(ACTIONS_KEY, JSON.stringify(plain)); } catch (_) {}
}

const ENABLED_KEY = 'ytdlp-sponsorblock-enabled-v1';
const CHANNELS_KEY = 'ytdlp-sponsorblock-channels-v1';

/** Whether SponsorBlock is on at all; it is unless switched off. */
export function loadSponsorBlockEnabled(storage = preferences) {
  try { return storage.getItem(ENABLED_KEY) !== '0'; } catch (_) { return true; }
}

export function saveSponsorBlockEnabled(enabled, storage = preferences) {
  try { storage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch (_) {}
}

/** Per-channel exceptions to the global switch, keyed by the archive's stable
 * channel id (or its name for older sidecars that do not have one). */
export function loadChannelOverrides(storage = preferences) {
  const overrides = new Map();
  try {
    const saved = JSON.parse(storage.getItem(CHANNELS_KEY) || '{}');
    for (const [key, value] of Object.entries(saved || {})) {
      if (!key || typeof value?.enabled !== 'boolean') continue;
      overrides.set(key, {enabled: value.enabled, name: String(value.name || key)});
    }
  } catch (_) {}
  return overrides;
}

export function saveChannelOverrides(overrides, storage = preferences) {
  const plain = {};
  for (const [key, value] of overrides) {
    if (key && typeof value?.enabled === 'boolean') {
      plain[key] = {enabled: value.enabled, name: String(value.name || key)};
    }
  }
  try { storage.setItem(CHANNELS_KEY, JSON.stringify(plain)); } catch (_) {}
}

export function sponsorBlockEnabledFor(channelKey, globalEnabled, overrides) {
  return overrides.get(channelKey)?.enabled ?? globalEnabled;
}

/**
 * The segment covering `seconds` that the viewer asked something of, with the
 * action to take, or null. The last moment of a segment is left alone so that
 * landing on its end never skips again.
 */
export function segmentActionAt(segments, seconds, actions) {
  for (const segment of segments) {
    if (seconds < segment.start || seconds >= segment.end - 0.25) continue;
    const action = actions.get(segment.category);
    if (action && action.mode !== 'play') return {segment, ...cleanAction(action)};
  }
  return null;
}
