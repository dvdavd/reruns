import {preferences} from './preferences.js';
export const positionKey = (item, partIndex = 0) => `reruns.playback:${JSON.stringify([item.id, partIndex])}`;

export const resumablePosition = (position, duration = 0) =>
  Number.isFinite(position) && position >= 10 && (!(duration > 0) || duration - position >= 10);

export function savedPosition(item, partIndex = 0, duration = 0) {
  try {
    const key = positionKey(item, partIndex);
    const stored = preferences.getItem(key);
    const saved = Number(stored);
    if (resumablePosition(saved, duration)) return saved;
    if (stored !== null) preferences.removeItem(key);
  } catch { /* Storage can be unavailable. */ }
  return 0;
}

export function applyPlaybackPositions(item) {
  const apply = (target, index) => {
    const duration = Number(target.durationSeconds || item.durationSeconds || 0);
    const resumeSeconds = savedPosition(item, index, duration);
    target.watch = {...target.watch, resumeSeconds,
      progress: duration > 0 ? Math.min(100, resumeSeconds / duration * 100) : 0};
  };
  apply(item, 0);
  (item.parts || []).forEach(apply);
  return item;
}
