import {formatBytes, formatDuration, html, iconHref, render, VideoCard} from 'media-ui';
import {accentFromImage, whenImageLoaded} from 'media-ui/accent.js';
import {createAnchoredMenu} from './popover.js';
import {suggestedCodec} from './download-profiles.js';
import {createChatSection} from './player-chat.js';
import {createCommentsSection} from './comments-ui.js';
import {channelIdOf, createChannelImages} from './channel-image.js';
import {initialiseCardAccents} from './card-accents.js';
import {channelSubscribeUrl, channelSubscriptionIdFor} from './subscription-target.js';
import {watchDetails, watchLinks, relatedPanel} from './watch-details.js';
import {setPageTitle} from './page-title.js';
import {t} from './i18n.js';

const format = {bytes: formatBytes, duration: formatDuration};

/** A details redraw may finish before an uncached poster loads. The poster
 * still belongs to the same video, so only a different video or picture
 * should cancel its pending accent sample. */
export function samplePosterAccent(item, poster, currentId, apply, sample = accentFromImage) {
  const src = poster?.getAttribute('src');
  if (!src || item.accent || item.parts?.[0]?.accent) return;
  whenImageLoaded(poster, () => {
    if (currentId() !== item.id || poster.getAttribute('src') !== src) return;
    const accent = item.accent || item.parts?.[0]?.accent || sample(poster);
    if (!accent) return;
    item.accent = accent;
    apply(accent);
  });
}

export function createWatchPage({
  page, element, mediaPlayer, getActiveItem,
  getItems, open, timeline, seekInput,
  drawFormats, drawSubtitles,
}) {
  const relatedPane = page.querySelector('.archive-related');
  const relatedRoot = page.querySelector('.archive-related-list');
  // The gallery's card props and the video whose related row is on screen, so
  // the row can be redrawn when the gallery's card state changes under it.
  let cardProps = item => ({item});
  let relatedItem = null;
  let openDownload = null;
  let deleteVideo = null;
  let refreshMetadata = null;
  const channelImages = createChannelImages();
  let channelToken = 0;

  const titleNode = page.querySelector('[data-watch-title]');
  const summaryNode = page.querySelector('[data-watch-summary]');
  const avatarNode = page.querySelector('[data-watch-avatar]');
  const avatarLink = page.querySelector('[data-watch-avatar-link]');
  // Supplied by the gallery: the link for a channel or playlist facet.
  let facetLink = null;
  /**
   * Points an anchor at a gallery filter. A plain click filters in place, as
   * the gallery's own chips do; a modified one is left to the browser, so the
   * link still opens in a new tab.
   */
  function linkTo(anchor, kind, target) {
    const link = target && facetLink?.(kind, target);
    if (link) anchor.href = link.href; else anchor.removeAttribute('href');
    anchor.onclick = link ? event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      link.open();
    } : null;
    return Boolean(link);
  }
  // A cached picture that has since gone from disk should leave no broken box.
  avatarNode.addEventListener('error', () => { avatarNode.hidden = true; });
  const descriptionNode = page.querySelector('[data-watch-description]');
  const descriptionText = page.querySelector('[data-watch-description-text]');
  const descriptionToggle = page.querySelector('[data-watch-description-toggle]');
  const specsNode = page.querySelector('[data-watch-specs]');
  const comments = createCommentsSection(page, {
    seek: seconds => { mediaPlayer.video.currentTime = seconds; },
    duration: () => Number(mediaPlayer.video.duration) || 0,
    // Only an account that may fetch has the refresher set.
    canFetch: () => Boolean(refreshMetadata),
    fetchComments: item => refreshMetadata({id: item.archive?.formatId || item.id, commentsOnly: true}),
  });
  const chat = createChatSection(page, {video: mediaPlayer.video});
  /** Only the laid-out element can say whether the description is clamped, and
   *  a hidden one lays out as nothing, so the toggle is judged on each draw. */
  function drawDescriptionToggle() {
    descriptionToggle.hidden = true;
    requestAnimationFrame(() => {
      descriptionToggle.hidden = descriptionText.scrollHeight <= descriptionText.clientHeight + 1
        && !descriptionNode.classList.contains('is-expanded');
    });
  }
  const sourceLink = page.querySelector('[data-watch-source]');
  const fileLink = page.querySelector('[data-watch-file]');
  const downloadButton = page.querySelector('[data-watch-download]');
  const deleteButton = page.querySelector('[data-watch-delete]');
  const refreshButton = page.querySelector('[data-watch-refresh]');
  refreshButton.addEventListener('click', async () => {
    const item = getActiveItem();
    const key = item?.archive?.formatId || item?.id;
    if (!key || !refreshMetadata) return;
    refreshButton.disabled = true;
    try { await refreshMetadata({id: key}); } catch { /* Already reported by the downloads UI. */ }
    refreshButton.disabled = false;
  });
  // The gallery's own delete, which asks which copies to remove and closes
  // this page if the one playing goes.
  deleteButton.addEventListener('click', () => {
    const item = getActiveItem();
    if (item) deleteVideo?.(item);
  });
  downloadButton.addEventListener('click', () => {
    const item = getActiveItem();
    if (!item || !openDownload) return;
    const encoding = item.parts?.[0]?.encoding;
    const unplayable = element.classList.contains('is-unplayable');
    const suggestion = unplayable ? suggestedCodec(type => mediaPlayer.video.canPlayType(type)) : null;
    // The popup ignores a press on its own button (downloads-ui.js), so this
    // click is what closes it when it is already open.
    openDownload(downloadButton, {
      toggle: true,
      url: item.archive.webpageUrl,
      suggestion,
      note: suggestion ? t('watch.wontPlay', {name: encoding?.name || t('watch.thisVideo'), suggestion: suggestion.name}) : '',
    });
  });
  // On a narrow page the rarer actions fold into one menu (see the
  // `is-secondary` rule in web/styles). Each row presses the real button, so
  // its handler, state and permissions stay where they were.
  const overflowButton = page.querySelector('[data-watch-overflow]');
  const overflowMenu = createAnchoredMenu({label: t('watch.moreActions'), className: 'watch-overflow-menu', prefer: 'down'});
  const secondaryActions = () => [
    [sourceLink, 'watch.source'],
    [fileLink, 'watch.saveFile'],
    [refreshButton, 'watch.refreshLabel'],
    [deleteButton, 'watch.delete'],
  ].filter(([control]) => !control.hidden);
  /** Shown only while there is something in it; the stylesheet decides
   *  whether the menu or the buttons themselves are on view. */
  function drawOverflow() {
    overflowButton.hidden = !secondaryActions().length;
  }
  overflowButton.addEventListener('click', () => {
    const rows = secondaryActions().map(([control, key]) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.classList.toggle('danger', control === deleteButton);
      row.textContent = t(key);
      row.addEventListener('click', () => {
        overflowMenu.close();
        // The source page opens off-site, so it keeps the link's own
        // no-referrer, no-opener terms rather than a bare window.open.
        control.click();
      });
      return row;
    });
    if (overflowMenu.open(overflowButton, rows)) rows[0]?.focus({preventScroll: true});
  });
  const favouriteButton = page.querySelector('[data-watch-favourite]');
  const channelSubscribeButton = page.querySelector('[data-watch-subscribe-channel]');
  let toggleFavourite = null;
  let addToPlaylists = null;
  const addPlaylistButton = page.querySelector('[data-watch-add-playlist]');
  addPlaylistButton?.addEventListener('click', () => {
    const item = getActiveItem();
    if (item) addToPlaylists?.(item, addPlaylistButton);
  });
  // Wired in from outside once the subscriptions module exists; a stable
  // proxy, so the button works whether or not it has landed yet.
  let subscriptionsBackend = null;
  const subscriptions = {
    list: () => subscriptionsBackend?.list() || [],
    subscribe: url => subscriptionsBackend?.subscribe(url),
    unsubscribe: (id, label) => subscriptionsBackend?.unsubscribe(id, label),
  };
  let channelFollowUrl = '';
  let channelSubscriptionId = null;
  /** The button's state for whichever item is open, read fresh each time so
   *  a subscribe/unsubscribe elsewhere in the app is reflected here too. */
  function drawChannelSubscribe(item) {
    channelFollowUrl = channelSubscribeUrl([item]);
    channelSubscriptionId = channelFollowUrl
      ? channelSubscriptionIdFor(subscriptions.list(), [item]) : null;
    channelSubscribeButton.hidden = !channelFollowUrl;
    channelSubscribeButton.textContent = channelSubscriptionId ? t('subscriptions.unsubscribe') : t('subscriptions.subscribe');
    channelSubscribeButton.classList.toggle('is-subscribed', Boolean(channelSubscriptionId));
  }
  channelSubscribeButton.addEventListener('click', () => {
    if (!channelFollowUrl) return;
    if (channelSubscriptionId) {
      subscriptions.unsubscribe(channelSubscriptionId, getItems().find(entry =>
        entry.id === activeId)?.facets.owner?.name || t('subscriptions.thisChannel'));
    } else {
      subscriptions.subscribe(channelFollowUrl);
    }
  });
  /** The heart follows the store, so a change from a card shows here too. */
  function drawFavourite() {
    const item = getActiveItem();
    const favourite = Boolean(item?.favourite);
    favouriteButton.hidden = !item || !toggleFavourite;
    favouriteButton.setAttribute('aria-pressed', String(favourite));
    favouriteButton.setAttribute('aria-label',
      t(favourite ? 'watch.removeFavourite' : 'watch.addFavourite'));
    favouriteButton.querySelector('use')
      .setAttribute('href', iconHref(favourite ? 'heart-filled' : 'heart-outline'));
  }
  favouriteButton.addEventListener('click', () => {
    const item = getActiveItem();
    if (item) toggleFavourite?.(item);
  });

  /** The words sit beside the chevron. */
  function setDescriptionToggleLabel(expanded) {
    const label = expanded ? t('watch.showLess') : t('watch.showMore');
    descriptionToggle.querySelector('[data-shelf-more-label]').textContent = label;
  }

  descriptionToggle.addEventListener('click', () => {
    const expanded = descriptionNode.classList.toggle('is-expanded');
    descriptionToggle.setAttribute('aria-expanded', String(expanded));
    setDescriptionToggleLabel(expanded);
  });

  function drawDetails(item) {
    const details = watchDetails(item, format);
    setPageTitle(details.title);
    const links = watchLinks(item);
    titleNode.textContent = details.title;
    // The channel leads the summary, so it is the part that links.
    const owner = item.facets.owner?.name;
    if (owner && details.summary[0] === owner && links.channel) {
      const channel = document.createElement('a');
      channel.className = 'archive-watch-channel';
      channel.textContent = owner;
      linkTo(channel, 'channel', links.channel);
      const rest = details.summary.slice(1).join(' · ');
      summaryNode.replaceChildren(channel, ...(rest ? [` · ${rest}`] : []));
    } else {
      summaryNode.textContent = details.summary.join(' · ');
    }
    linkTo(avatarLink, 'channel', links.channel);
    avatarLink.setAttribute('aria-label', owner ? t('watch.channelOf', {owner}) : t('watch.channel'));
    drawChannelImage(item);
    drawChannelSubscribe(item);

    descriptionNode.classList.remove('is-expanded');
    descriptionToggle.setAttribute('aria-expanded', 'false');
    setDescriptionToggleLabel(false);
    descriptionText.textContent = details.description;
    descriptionNode.hidden = !details.description;
    drawDescriptionToggle();
    comments.show(item);
    chat.show(item);

    drawFileFacts(item, details, links);

    timeline.drawChapters(details, item.durationSeconds);
    timeline.loadSponsorSegments(item);
    seekInput.style.setProperty('--archive-heat', details.heat || 'linear-gradient(transparent, transparent)');
    drawAccent(item);
    drawFormats(item);
    drawSubtitles(item);

    sourceLink.href = details.sourceUrl;
    sourceLink.hidden = !details.sourceUrl;
    downloadButton.hidden = !details.sourceUrl || !openDownload;
    deleteButton.hidden = !deleteVideo;
    refreshButton.hidden = !refreshMetadata || !details.sourceUrl;
    drawOverflow();
    drawFavourite();
  }

  /**
   * Everything on the page that describes the file rather than the video: the
   * specification rows and the link that saves it. Switching format changes
   * all of it and nothing else, so it is drawn on its own rather than by
   * redrawing the whole page under a video that has not changed.
   */
  function drawFileFacts(item, details = watchDetails(item, format), links = watchLinks(item)) {
    specsNode.replaceChildren(...details.specs.map(({label, value, link}) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const definition = document.createElement('dd');
      const anchor = document.createElement('a');
      if (link && linkTo(anchor, link, links[link])) {
        anchor.textContent = value;
        definition.append(anchor);
      } else {
        definition.textContent = value;
      }
      row.append(term, definition);
      return row;
    }));
    fileLink.href = item.sourceRef || '';
    fileLink.download = item.filename || '';
    fileLink.hidden = !item.sourceRef;
    drawOverflow();
  }

  const relatedHeading = page.querySelector('[data-related-heading]');

  /**
   * The row of neighbouring videos under the details. With nothing to put in
   * it the row goes away entirely rather than standing empty.
   */
  function drawRelated(item = relatedItem) {
    relatedItem = item;
    const panel = item ? relatedPanel(item, getItems()) : {entries: [], heading: ''};
    relatedPane.hidden = panel.entries.length === 0;
    if (relatedPane.hidden) return render(null, relatedRoot);
    relatedHeading.textContent = panel.heading;
    // The gallery's own card props, so a related card carries the same menu
    // as the card it is a copy of, acting on the same items. Its own surface
    // name keeps the two menus from opening together, and opening this one
    // redraws the gallery, which redraws this row in turn.
    render(panel.entries.map(entry => html`
      <${VideoCard} key=${entry.id} ...${cardProps(entry, 'related')}
                    libraryCard=${false} onOpenDetails=${open} />`), relatedRoot);
    initialiseCardAccents(relatedRoot, id => getItems().find(entry => entry.id === id));
    fitRelated();
  }

  /**
   * In the wide layout the related videos are a column beside the facts, the
   * description and the comments. It shows as many whole cards as reach the
   * bottom of the tallest of those, so opening the comments lengthens the
   * column with them and closing them takes it back, and it never stands
   * far past what is beside it. Narrow, the row-fitting rules in the
   * stylesheet decide instead. The marker is the page's own, not Preact's:
   * a card's attributes are left alone by the render.
   */
  const WIDE_LOWER = 940; // the watch column's width at which the stylesheet goes three columns
  const lowerNode = page.querySelector('.archive-watch-lower');
  const RELATED_OVERSHOOT = 48;
  const RELATED_MINIMUM = 2;
  function fitRelated() {
    const cards = [...relatedRoot.children];
    for (const card of cards) delete card.dataset.fit;
    if (lowerNode.clientWidth < WIDE_LOWER || relatedPane.hidden) return;
    let bottom = 0;
    for (const side of fitSides) {
      if (side.hidden || !side.offsetParent) continue;
      bottom = Math.max(bottom, side.getBoundingClientRect().bottom);
    }
    cards.forEach((card, index) => {
      if (index >= RELATED_MINIMUM && card.getBoundingClientRect().bottom > bottom + RELATED_OVERSHOOT) {
        card.dataset.fit = 'hidden';
      }
    });
  }
  const fitSides = ['.archive-watch-facts', '.archive-watch-story', '.archive-watch-discussion']
    .map(selector => page.querySelector(selector));
  // The siblings' own sizes decide the column, and the column does not decide
  // theirs, so watching them cannot loop. The width is watched too: a wider
  // column makes taller cards.
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => fitRelated());
    for (const side of [...fitSides, lowerNode]) observer.observe(side);
  }

  /**
   * The video's own accent, which tints the panels and the player's seek bar.
   * The gallery samples it from the card thumbnail and caches it on the item.
   */
  function drawAccent(item) {
    const cached = item.accent || item.parts?.[0]?.accent;
    if (cached) setAccent(cached);
    else clearAccent();
  }

  /** The accent tints the watch page itself; the Appearance option for video
   *  colours also lifts it to the root, since the topbar and the tokens derived
   *  from --color-accent live outside the page. The flag lets the stylesheet
   *  skip a video with no accent rather than lose the palette's. */
  function setAccent(accent) {
    page.style.setProperty('--card-accent', accent);
    document.documentElement.style.setProperty('--video-accent', accent);
    document.body.dataset.watchAccent = '';
  }

  function clearAccent() {
    page.style.removeProperty('--card-accent');
    document.documentElement.style.removeProperty('--video-accent');
    delete document.body.dataset.watchAccent;
  }

  /** A page restored straight from its URL has no card to sample, so read the
   *  poster the player has since loaded. Called once that poster is in place,
   *  since until then it still shows the video watched before this one. */
  function sampleAccent(item) {
    samplePosterAccent(item, mediaPlayer.poster, () => getActiveItem()?.id,
      accent => setAccent(accent));
  }

  /** The channel picture, once the server has it. A video opened in the
   *  meantime cancels this one by bumping the token. */
  async function drawChannelImage(item) {
    const token = ++channelToken;
    avatarLink.hidden = true;
    avatarNode.removeAttribute('src');
    const url = await channelImages(channelIdOf(item));
    if (!url || token !== channelToken) return;
    avatarNode.src = url;
    avatarNode.alt = item.facets.owner?.name ? `${item.facets.owner.name} channel picture` : '';
    avatarLink.hidden = false;
  }

  return {
    drawDetails, drawFileFacts, drawRelated, drawFavourite, clearAccent, sampleAccent, linkTo,
    setPlaylistEditor(add) { addToPlaylists = add; },
    setCardProps(props) { cardProps = props; },
    setFavouriteToggle(toggle) { toggleFavourite = toggle; drawFavourite(); },
    setFormatDownloader(open) { openDownload = open; },
    setDeleter(remove) { deleteVideo = remove; },
    setMetadataRefresher(refresh) { refreshMetadata = refresh; },
    setFacetLinks(link) { facetLink = link; },
    setSubscriptions(backend) {
      subscriptionsBackend = backend;
      backend.onChange(() => {
        const item = getActiveItem();
        if (item) drawChannelSubscribe(item);
      });
    },
  };
}
