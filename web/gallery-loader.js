import {request} from './api.js';
import {applyPlaybackPositions} from './playback-position.js';
import {applyPlaylists, groupFormats, selectFormat, toMediaItem, toPlaylist} from './item-adapter.js';
import {markPlaylistDirection} from './playlists.js';
import {t} from './i18n.js';

export function createLibraryLoader({
  store, player, report, setStatus,
  applyMetadata, replaceItems,
}) {
  let loading = false;
  let loadQueued = false;
  async function load({refreshPlayer = true, beforeReveal} = {}) {
    // A library change can arrive while another scan is running. Run one
    // more scan afterward so the removed path cannot leave its old items up.
    if (loading) { loadQueued = true; return; }
    loading = true;
    // The first scan has nothing to show yet, so it gets the shared loading
    // panel in place of the page; a rescan keeps the page up. Its progress
    // goes to the toast rather than the summary line: that line sits in the
    // flow above the gallery, and showing then hiding it shifted every card
    // 26px - the browser's scroll anchoring made that a jump, and near the
    // top the rescan anchor captured the shifted layout and kept it.
    const firstLoad = !store.allItems().length;
    if (firstLoad) document.body.dataset.loading = 'true';
    else report(t('gallery.scanning'), {persistent: true});
    try {
      const [raw, records, settings] = await Promise.all([
        request('/api/items'),
        // A playlist sidecar is optional, so a failure here must not lose the
        // gallery; the items keep whatever their own sidecars recorded.
        request('/api/playlists').catch(() => []),
        request('/api/settings').catch(() => null),
      ]);
      const playlistRecords = records.map(toPlaylist);
      // Directories must follow the scan that established the listing.
      const directories = await request('/api/directories').catch(() => []);
      const playlistOrder = applyMetadata({playlistRecords, directories, settings});
      const current = new Map(store.allItems().map(item => [item.id, item]));
      // Grouped before anything else reads the list: a video downloaded in
      // several formats is one video from here on, and the copies the
      // gallery does not show must not count towards a playlist's run or be
      // sorted as videos of their own.
      const items = markPlaylistDirection(applyPlaylists(
        groupFormats(raw.map(toMediaItem).filter(item => item.archive.downloaded),
          new Set(current.keys())),
        playlistRecords,
      ), playlistOrder);
      for (const item of items) {
        const old = current.get(item.id);
        if (old) {
          item.watch = old.watch;
          item.session = old.session;
          // A rescan under a video being watched must not quietly put it back
          // to its best format: the rebuilt item keeps whichever copy the
          // viewer chose, as long as that copy is still on disk.
          selectFormat(item, old.archive.formatId);
          // Accents are sampled from thumbnails once and kept on the item, and
          // a card already sampled is not sampled again, so a rebuilt item
          // without them drew its cards uncoloured until the page reloaded
          // (fetching comments rescans under the related row). They hold for
          // as long as the thumbnail they came from.
          const sameThumbnail = (a, b) => Boolean(a?.thumbnail?.url) && a.thumbnail.url === b?.thumbnail?.url;
          if (old.accent && sameThumbnail(item.parts?.[0], old.parts?.[0])) item.accent ??= old.accent;
          const oldParts = new Map((old.parts || []).map(part => [part.id, part]));
          for (const part of item.parts || []) {
            const oldPart = oldParts.get(part.id);
            if (oldPart) {
              part.watch = oldPart.watch;
              part.session = oldPart.session;
              if (oldPart.accent && sameThumbnail(part, oldPart)) part.accent ??= oldPart.accent;
            }
          }
        }
      }
      items.forEach(applyPlaybackPositions);
      replaceItems(items, {firstLoad});
      // A subtitle-only job changes the sidecar beside an already-open video.
      // Refresh its track list in place so the settings menu does not require
      // a full page reload to see the newly downloaded caption.
      if (refreshPlayer) player.refreshActiveItem?.();
      await beforeReveal?.();
      report('');
    } catch (error) {
      setStatus(t('gallery.couldNotLoad'));
      report(t('error.reason', {message: t('gallery.scanFailed'), reason: error.message || error}), {error: true, timeout: 0});
    } finally {
      delete document.body.dataset.loading;
      loading = false;
      if (loadQueued) {
        loadQueued = false;
        await load();
      }
    }
  }
  return {load};
}
