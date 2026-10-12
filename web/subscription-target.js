// Where a subscription's name leads: the gallery of what it has already
// brought into the archive, found by matching its address against the videos.

const CHANNEL_ROOT = /^https?:\/\/(?:www\.|m\.)?([^/]+)\/(@[^/?#]+|channel\/[\w-]+|c\/[^/?#]+|user\/[^/?#]+)/i;

/** A channel address reduced to host and channel part, ignoring its tab. */
export function channelKey(url) {
  const match = CHANNEL_ROOT.exec(String(url || ''));
  return match ? `${match[1].toLowerCase()}/${decodeURIComponent(match[2]).toLowerCase()}` : '';
}

function playlistIdOf(url) {
  try {
    return new URL(url).searchParams.get('list') || '';
  } catch {
    return '';
  }
}

/** A channel's own address, from whichever of its videos recorded one. */
export function channelSubscribeUrl(items) {
  for (const item of items || []) {
    const url = item.archive?.channelUrls?.[0];
    if (url) return url;
  }
  return '';
}

/** A playlist's address: its recorded page, or one built from its id. */
export function playlistSubscribeUrl(playlist) {
  if (playlist?.manual) return '';
  if (playlist?.url) return playlist.url;
  return playlist?.id ? `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.id)}` : '';
}

/** The id of the subscription already following a playlist address, or null
 *  when nothing does — so a Subscribe shortcut can offer Unsubscribe instead.
 *  A channel has more than one address; channelSubscriptionIdFor tries them. */
export function subscribedIdFor(subscriptions, kind, url) {
  if (!url || kind !== 'playlist') return null;
  const id = playlistIdOf(url);
  if (!id) return null;
  return subscriptions.find(item => item.kind === 'playlist' && playlistIdOf(item.url) === id)?.id || null;
}

/** The id of the subscription following the channel these videos come from,
 *  or null. A channel answers to several addresses — its /channel/UC… page
 *  and its @handle — and a subscription added by hand may name either, while
 *  the page only offers the first its videos recorded. So every address they
 *  recorded is tried, and the channel's id besides, which a subscription
 *  learns from its first listing. */
export function channelSubscriptionIdFor(subscriptions, items, channelId = '') {
  const keys = new Set((items || []).flatMap(item => item.archive?.channelUrls || [])
    .map(channelKey).filter(Boolean));
  const ids = new Set([channelId, ...(items || []).map(item => item.facets?.owner?.id)]
    .filter(Boolean).map(id => String(id).toLowerCase()));
  return subscriptions.find(item => {
    if (item.kind !== 'channel') return false;
    const key = channelKey(item.url);
    return keys.has(key) || ids.has(String(item.channelId || '').toLowerCase())
      || [...ids].some(id => key.endsWith(`/channel/${id}`));
  })?.id || null;
}

/**
 * The facet a subscription opens, as {kind, target}, or null when the
 * archive holds nothing from it yet. A playlist matches on YouTube's list id;
 * a channel on the addresses its videos recorded, or its UC id.
 */
export function subscriptionTarget(subscription, items) {
  if (subscription.kind === 'playlist') {
    const id = playlistIdOf(subscription.url);
    if (!id) return null;
    for (const item of items) {
      const playlist = item.archive?.playlist;
      if (playlist?.id === id) return {kind: 'playlist', target: {id, name: playlist.title || ''}};
      const collection = item.facets?.collections?.find(entry => entry.id === id);
      if (collection) return {kind: 'playlist', target: {id, name: collection.name || ''}};
    }
    return null;
  }
  if (subscription.kind === 'channel') {
    const key = channelKey(subscription.url);
    if (!key) return null;
    for (const item of items) {
      const owner = item.facets?.owner;
      if (!owner?.id) continue;
      const keys = (item.archive?.channelUrls || []).map(channelKey);
      if (keys.includes(key) || key.endsWith(`/channel/${String(owner.id).toLowerCase()}`)) {
        return {kind: 'channel', target: {id: owner.id, name: owner.name}};
      }
    }
  }
  return null;
}
