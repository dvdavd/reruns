// Resolves the picture for a channel. The server fetches it with yt-dlp the
// first time it is asked and caches it on disk, so this polls until it has an
// answer and then remembers that answer for the life of the page: one lookup
// per channel however many of its videos get opened.

import {request} from './api.js';

const POLL_LIMIT = 20;

/** The id the server indexes channels by, matching the adapted owner facet. */
export function channelIdOf(item) {
  return item?.facets?.owner?.id || '';
}

/**
 * The picture's URL, or '' when the channel has none this archive can reach.
 * `fetchState` and `wait` are injected so the polling is testable.
 */
export async function loadChannelImage(channelId, {
  cache = new Map(),
  fetchState = id => request(`/api/channel-image/${encodeURIComponent(id)}`),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!channelId) return '';
  const pending = cache.get(channelId);
  if (pending) return pending;
  const resolved = (async () => {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      let state;
      try {
        state = await fetchState(channelId);
      } catch {
        return '';  // A channel with no picture is not worth reporting.
      }
      if (state?.state === 'ready') return state.imageUrl || '';
      if (state?.state !== 'queued' && state?.state !== 'running') return '';
      await wait(Number(state.retryAfterMs) || 1200);
    }
    return '';
  })();
  cache.set(channelId, resolved);
  return resolved;
}

/** A page-lifetime cache, so every caller shares the one lookup per channel. */
export function createChannelImages(options = {}) {
  const cache = new Map();
  return channelId => loadChannelImage(channelId, {...options, cache});
}
