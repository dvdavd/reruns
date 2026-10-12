import {createMenu, createStatusToast, initTopbarScroll} from 'media-ui/chrome.js';
import {browseSourceFor, createBrowseUI, isSearch, searchNeedsYouTube} from './browse-ui.js';
import {createDirectoryUI} from './directory-ui.js';
import {createDownloadsUI} from './downloads-ui.js';
import {createAboutUI} from './about-ui.js';
import {createStatisticsUI} from './statistics-ui.js';
import {createOrphansUI} from './orphans-ui.js';
import {createAccountsUI} from './accounts-ui.js';
import {createActivityUI} from './activity-ui.js';
import {post, request} from './api.js';
import {chosenLanguage, createCustomisationUI} from './customisation.js';
import {t, translateMarkup, useLocale} from './i18n.js';
import {preferences} from './preferences.js';
import {createLibrariesUI} from './libraries-ui.js';
import {createPasswordDialog} from './password-dialog.js';
import {createProfilesUI} from './profiles-ui.js';
import {createGalleryController} from './gallery-controller.js';
import {createShelfSettingsUI} from './shelf-settings.js';
import {createHoverPreview} from './hover-preview.js';
import {createPlayerController} from './player-controller.js';
import {selectOnFocus} from './select-on-focus.js';
import {subscriptionTarget} from './subscription-target.js';
import {createSubscriptionsUI} from './subscriptions-ui.js';

const account = await request('/api/auth/me');
if (account.authEnabled === false) {
  for (const action of ['accounts', 'password', 'logout']) {
    document.querySelector(`[data-settings-action="${action}"]`).hidden = true;
  }
}
document.body.dataset.canFetch = String(account.role === 'admin' || Boolean(account.fetch && account.grants.length));
document.body.dataset.canDelete = String(account.role === 'admin');
// An account that signs in through OIDC has no password here to change.
if (!account.username) document.querySelector('[data-settings-action="password"]').hidden = true;
if (account.role !== 'admin') {
  for (const action of ['libraries', 'profiles', 'subscriptions', 'activity', 'orphans', 'statistics', 'about', 'accounts']) {
    document.querySelector(`[data-settings-action="${action}"]`)?.setAttribute('hidden', '');
  }
  document.querySelector('#download-subscribe').hidden = true;
  document.querySelector('#download-submit').hidden = !account.fetch || !account.grants.length;
  document.querySelector('#download-advanced-toggle').hidden = !account.fetch || !account.grants.length;

}
// Hiding a group's items must not leave its dividers behind: a divider only
// shows between two visible items.
const children = [...document.querySelector('#archive-settings-menu').children];
let after = false;
for (const [index, child] of children.entries()) {
  if (!child.classList.contains('menu-divider')) {
    after ||= !child.hidden;
    continue;
  }
  child.hidden = !after || !children.slice(index + 1).some(next =>
    !next.classList.contains('menu-divider') && !next.hidden);
  if (!child.hidden) after = false;
}
initTopbarScroll();
// The catalogue must be in place before anything draws text from it.
await useLocale(chosenLanguage());
document.documentElement.lang = chosenLanguage();
translateMarkup(document);
// The toast is made further down; a failed save is only reported once a
// person has made a choice, long after it exists.
const customisation = createCustomisationUI(document.querySelector('#customisation-drawer'),
  {report: (message, options) => report(message, options)});
for (const page of ['home', 'channel', 'playlist', 'videos', 'playlists']) {
  createShelfSettingsUI(page, document.querySelector(`#${page}-sections-toggle`),
    document.querySelector(`#${page}-sections-menu`));
}
// Both of the app's text fields hold one thing each — a search, a folder —
// so focusing one offers what is there to be typed over.
for (const field of document.querySelectorAll('input[type="search"], input[type="text"]')) {
  selectOnFocus(field);
}
const toast = createStatusToast(document.querySelector('#status-toast'));
const report = (message, options) => toast.show(message, options);
// Only an admin sets what everyone else falls back to.
const defaults = document.querySelector('[data-customisation-defaults]');
defaults.hidden = account.role !== 'admin' || account.authEnabled === false;
async function changeDefaults(action, done) {
  try { await action(); report(done); } catch (error) { report(t('error.reason', {message: t('accounts.defaults.error'), reason: error.message || error}), {error: true}); }
}
defaults.querySelector('[data-customisation-set-defaults]').addEventListener('click', () =>
  changeDefaults(() => preferences.setDefaults(), t('accounts.defaults.saved')));
defaults.querySelector('[data-customisation-clear-defaults]').addEventListener('click', () =>
  changeDefaults(() => preferences.clearDefaults(), t('accounts.defaults.cleared')));

const directory = createDirectoryUI({
  button: document.querySelector('#directory-toggle'),
  menu: document.querySelector('#directory-menu'),
  label: document.querySelector('#directory-label'),
  onChange: key => gallery.setDirectory(key),
});
const player = createPlayerController(document.querySelector('#archive-player'), report);
const gallery = createGalleryController({
  directory,
  root: document.querySelector('#archive-gallery'),
  summary: document.querySelector('#archive-summary'),
  playlistsSummary: document.querySelector('#playlists-summary'),
  channelsSummary: document.querySelector('#channels-summary'),
  count: document.querySelector('#archive-search-count'),
  search: document.querySelector('#archive-search'),
  searchClear: document.querySelector('#archive-search-clear'),
  shelf: {
    section: document.querySelector('#creator-shelf'),
    track: document.querySelector('#creator-shelf-track'),
    moreButton: document.querySelector('#creator-shelf-more'),
    emptyHint: document.querySelector('#creator-shelf-hint'),
  },
  videoShelf: {
    section: document.querySelector('#video-shelf'),
    track: document.querySelector('#video-shelf-track'),
    moreButton: document.querySelector('#video-shelf-more'),
  },
  playlistShelf: {
    section: document.querySelector('#playlist-shelf'),
    track: document.querySelector('#playlist-shelf-track'),
    moreButton: document.querySelector('#playlist-shelf-more'),
    emptyHint: document.querySelector('#playlist-shelf-hint'),
  },
  playlistsRoot: document.querySelector('#playlist-grid'),
  playlistsHeading: document.querySelector('#playlists-heading'),
  channelProfile: document.querySelector('#channel-profile'),
  playlistProfile: document.querySelector('#playlist-profile'),
  channelPlaylists: {
    section: document.querySelector('#channel-playlists'),
    track: document.querySelector('#channel-playlists-track'),
    moreButton: document.querySelector('#channel-playlists-more'),
  },
  pagePlaylistShelf: {
    section: document.querySelector('#page-playlist-shelf'),
    track: document.querySelector('#page-playlist-shelf-track'),
    moreButton: document.querySelector('#page-playlist-shelf-more'),
  },
  viewPlaylistShelf: {
    section: document.querySelector('#view-playlist-shelf'),
    track: document.querySelector('#view-playlist-shelf-track'),
    moreButton: document.querySelector('#view-playlist-shelf-more'),
  },
  pageVideoShelf: {
    section: document.querySelector('#page-video-shelf'),
    track: document.querySelector('#page-video-shelf-track'),
    moreButton: document.querySelector('#page-video-shelf-more'),
  },
  channels: {
    section: document.querySelector('#channels-view'),
    track: document.querySelector('#channel-grid'),
  },
  navButtons: [...document.querySelectorAll('[data-main-view]')],
  heading: document.querySelector('#archive-heading'),
  sortControl: document.querySelector('#gallery-sort'),
  layoutControl: document.querySelector('#gallery-layout'),
  tracklist: document.querySelector('#playlist-tracklist'),
  deleteDialog: document.querySelector('#delete-dialog'),
  player,
  report,
});
player.setGalleryTitle(gallery.refreshPageTitle);
const downloads = createDownloadsUI({
  access: account,
  directory,
  form: document.querySelector('#download-form'),
  urlInput: document.querySelector('#archive-search'),
  jobsElement: document.querySelector('#download-jobs'),
  advancedToggle: document.querySelector('#download-advanced-toggle'),
  advancedPanel: document.querySelector('#download-advanced'),
  profileMenu: document.querySelector('#download-profile-menu'),
  manualPanel: document.querySelector('#download-manual'),
  subscribeButton: document.querySelector('#download-subscribe'),
  queueToggle: document.querySelector('#download-queue-toggle'),
  queueCount: document.querySelector('#download-queue-count'),
  drawer: document.querySelector('#download-drawer'),
  drawerClose: document.querySelector('#download-drawer-close'),
  drawerSummary: document.querySelector('#download-drawer-summary'),
  onJobs: jobs => browse.updateJobs(jobs),
  playLocal: {keyFor: gallery.keyForSource, play: gallery.playByKey},
  // What has just arrived reads as held in the browse panel once the
  // library has been read again.
  onSettled: async () => {
    await gallery.load();
    player.redrawActive();
    browse.refresh();
  },
  report,
});
if (document.body.dataset.canFetch === 'true') {
  player.setSubtitleDownloader(downloads.downloadSubtitles);
  player.setMetadataRefresher(downloads.refreshMetadata);
  player.setFormatDownloader(downloads.openForVideo);
  gallery.setFormatDownloader(downloads.openForVideo, downloads.closeForVideo);
}

// The brand is a link home; a plain click goes there without
// reloading, and a modified click still opens a new tab.
document.querySelector('#archive-brand').addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  gallery.reset();
  // Going home rewinds the logo too: its arrows slide in again, as on load.
  for (const arrow of event.currentTarget.querySelectorAll('.arrow')) {
    for (const animation of arrow.getAnimations()) {
      animation.cancel();
      animation.play();
    }
  }
});
for (const button of document.querySelectorAll('[data-main-view]')) {
  button.addEventListener('click', () => gallery.setView(button.dataset.mainView));
}
// Started with the panel's own profile choice, which opens on the default;
// the topbar arrow's pick is for what is typed into the field.
const browse = createBrowseUI({
  drawer: document.querySelector('#browse-drawer'),
  drawerClose: document.querySelector('#browse-close'),
  backButton: document.querySelector('#browse-back'),
  title: document.querySelector('#browse-title'),
  summary: document.querySelector('#browse-summary'),
  filter: document.querySelector('#browse-filter'),
  optionsButton: document.querySelector('#browse-options'),
  optionsMenu: document.querySelector('#browse-options-menu'),
  list: document.querySelector('#browse-list'),
  moreButton: document.querySelector('#browse-more'),
  download: document.body.dataset.canFetch === 'true' ? async (entry, profile) => {
    const job = await post('/api/download', {url: entry.url, profile});
    downloads.schedulePoll();
    return job;
  } : null,
  jobAction: downloads.jobAction,
  playLocal: (key, event) => gallery.playByKey(key, event),
  report,
});
gallery.setBrowse(browse.open);
const subscriptions = createSubscriptionsUI({
  form: document.querySelector('#download-form'),
  urlInput: document.querySelector('#archive-search'),
  subscribeButton: document.querySelector('#download-subscribe'),
  readOptions: downloads.readOptions,
  selection: downloads.selection,
  isLink: downloads.isLink,
  reset: downloads.reset,
  drawer: document.querySelector('#subscriptions-drawer'),
  drawerClose: document.querySelector('#subscriptions-close'),
  summary: document.querySelector('#subscriptions-summary'),
  list: document.querySelector('#subscriptions-list'),
  intervalSelect: document.querySelector('#subscriptions-interval'),
  backlogSelect: document.querySelector('#subscriptions-backlog'),
  onCheck: downloads.schedulePoll,
  onBrowse: browse.open,
  report,
});

// The button beside Subscribe: what is in the field, listed rather than
// downloaded. It follows the field the way Subscribe does, after the
// downloads module has decided whether that is a link.
const browseButton = document.querySelector('#download-browse');
const topbarSearch = document.querySelector('#download-form');
const searchField = document.querySelector('#archive-search');
function topbarBrowseSource() {
  return gallery.channelBrowseSource()
    || browseSourceFor(searchField.value, {link: downloads.isLink(), view: gallery.currentView()});
}
const SEARCH_BUTTON_TITLES = {
  search: 'topbar.searchYouTubeTitle',
  'search-playlists': 'topbar.searchYouTubePlaylistsTitle',
  'search-channels': 'topbar.searchYouTubeChannelsTitle',
};
function syncBrowseButton() {
  const source = topbarBrowseSource();
  const searching = isSearch(source);
  topbarSearch.dataset.browse = source ? (searching ? 'search' : 'link') : '';
  topbarSearch.dataset.browseMissing = String(searchNeedsYouTube(source, gallery.items(), gallery.viewMatches()));
  browseButton.tabIndex = source ? 0 : -1;
  browseButton.setAttribute('aria-hidden', String(!source));
  browseButton.setAttribute('aria-label', t(searching ? 'topbar.searchYouTube' : 'topbar.browse'));
  browseButton.title = t(searching ? SEARCH_BUTTON_TITLES[source.kind] : 'topbar.browseTitle');
}
searchField.addEventListener('input', syncBrowseButton);
searchField.addEventListener('searchsync', syncBrowseButton);
gallery.subscribe(syncBrowseButton);
browseButton.addEventListener('click', () => {
  const source = topbarBrowseSource();
  if (source) browse.open(source);
});
topbarSearch.addEventListener('submit', event => {
  const source = topbarBrowseSource();
  if (!searchNeedsYouTube(source, gallery.items(), gallery.viewMatches())) return;
  event.preventDefault();
  browse.open(source);
});
syncBrowseButton();

const accounts = createAccountsUI({
  drawer: document.querySelector('#accounts-drawer'),
  drawerClose: document.querySelector('#accounts-close'),
  summary: document.querySelector('#accounts-summary'),
  list: document.querySelector('#accounts-list'),
  form: document.querySelector('#accounts-form'),
  report,
});
const passwordDialog = createPasswordDialog({
  dialog: document.querySelector('#password-dialog'),
  form: document.querySelector('#password-form'),
  message: document.querySelector('#password-message'),
  cancel: document.querySelector('#password-cancel'),
  report,
});
const libraries = createLibrariesUI({
  drawer: document.querySelector('#libraries-drawer'),
  drawerClose: document.querySelector('#libraries-close'),
  summary: document.querySelector('#libraries-summary'),
  list: document.querySelector('#libraries-list'),
  form: document.querySelector('#libraries-form'),
  pathInput: document.querySelector('#libraries-path'),
  onChange: () => gallery.load(),
  report,
});

// The drawer and the download arrow show the same profiles, so whichever
// changes them hands the settings payload straight to the other.
const profiles = createProfilesUI({
  drawer: document.querySelector('#profiles-drawer'),
  drawerClose: document.querySelector('#profiles-close'),
  resetButton: document.querySelector('#profiles-reset'),
  summary: document.querySelector('#profiles-summary'),
  list: document.querySelector('#profiles-list'),
  onChange: payload => {
    downloads.setProfiles(payload);
    browse.setProfiles(payload);
    gallery.setDownloadProfiles(payload);
    subscriptions.setProfiles(payload);
  },
  report,
});

const about = createAboutUI({
  drawer: document.querySelector('#about-drawer'),
  drawerClose: document.querySelector('#about-close'),
  summary: document.querySelector('#about-summary'),
  list: document.querySelector('#about-list'),
  report,
});

const statistics = createStatisticsUI({
  drawer: document.querySelector('#statistics-drawer'),
  drawerClose: document.querySelector('#statistics-close'),
  scopeSwitch: document.querySelector('#statistics-scope'),
  subtitle: document.querySelector('#statistics-subtitle'),
  stats: document.querySelector('#statistics-content'),
  items: () => gallery.items(),
  currentView: () => gallery.statisticsView(),
  facetLink: (kind, target) => gallery.facetLink(kind, target),
  playVideo: (item, event) => gallery.playByKey(item.id, event),
});

const activity = createActivityUI({
  drawer: document.querySelector('#activity-drawer'),
  drawerClose: document.querySelector('#activity-close'),
  summary: document.querySelector('#activity-summary'),
  list: document.querySelector('#activity-list'),
  sourceSelect: document.querySelector('#activity-source'),
  levelSelect: document.querySelector('#activity-level'),
  copyButton: document.querySelector('#activity-copy'),
  report,
});

const orphans = createOrphansUI({
  drawer: document.querySelector('#orphans-drawer'),
  drawerClose: document.querySelector('#orphans-close'),
  summary: document.querySelector('#orphans-summary'),
  list: document.querySelector('#orphans-list'),
  fetchAll: document.querySelector('#orphans-fetch-all'),
  confirm: document.querySelector('#orphans-confirm'),
  menuItem: document.querySelector('[data-settings-action="orphans"]'),
  // A fetched sidecar turns the file into a gallery item.
  onFetched: () => gallery.load(),
  report,
});

createMenu({
  button: document.querySelector('#archive-settings-toggle'),
  menu: document.querySelector('#archive-settings-menu'),
  closeDelay: 140,
  onSelect: item => {
    if (item.dataset.settingsAction === 'libraries') libraries.open();
    if (item.dataset.settingsAction === 'subscriptions') subscriptions.open();
    if (item.dataset.settingsAction === 'profiles') profiles.open();
    if (item.dataset.settingsAction === 'activity') activity.open();
    if (item.dataset.settingsAction === 'orphans') orphans.open();
    if (item.dataset.settingsAction === 'about') about.open();
    if (item.dataset.settingsAction === 'statistics') statistics.open();
    if (item.dataset.settingsAction === 'accounts') accounts.open();
    if (item.dataset.settingsAction === 'password') passwordDialog.open();
    if (item.dataset.settingsAction === 'logout') post('/api/auth/logout').then(() => location.replace('/auth.html'));
    if (item.dataset.settingsAction === 'customisation') customisation.open();
    if (item.dataset.settingsAction === 'sponsorblock') player.openSponsorBlock();
  },
});

player.setItemsProvider(gallery.items);
player.setPlaylistEditor(gallery.addToPlaylists);
createHoverPreview({
  root: document.querySelector('#archive-home'),
  itemFor: card => {
    const id = card.dataset.partId || card.dataset.id;
    return gallery.items().find(item => item.id === id);
  },
});
player.setFavouriteToggle(gallery.toggleFavourite);
if (account.role === 'admin') player.setDeleter(gallery.deleteVideo);
player.setPlaylistDirectionToggle(gallery.togglePlaylistDirection);
player.setFacetLinks(gallery.facetLink);
player.setCardProps(gallery.cardProps);
gallery.registerCardSurface(player.redrawRelated);
const subscriptionsApi = {
  subscribe: subscriptions.subscribe, unsubscribe: subscriptions.unsubscribe,
  list: subscriptions.list, onChange: subscriptions.onChange, refresh: subscriptions.refresh,
  update: subscriptions.update, check: subscriptions.check,
};
if (account.role === 'admin') {
  gallery.setSubscriptions(subscriptionsApi);
  player.setSubscriptions(subscriptionsApi);
  browse.setSubscriptions(subscriptionsApi);
}
subscriptions.setLinks(subscription => {
  const found = subscriptionTarget(subscription, gallery.items());
  return found && gallery.facetLink(found.kind, found.target);
});
gallery.subscribe(() => player.refreshFavourite());
// A video in the address opens before the loading panel comes down, so a
// refresh on the watch page does not show home on its way there.
await gallery.load({beforeReveal: player.restoreRoute});
await downloads.poll();
// The channel/playlist/watch Subscribe shortcuts need to know what is
// already followed before the user opens the subscriptions drawer.
if (account.role === 'admin') await subscriptions.refresh();
// The menu entry only appears when there is something for the panel to list.
if (account.role === 'admin') orphans.refresh();
// One settings fetch serves both: the folder list a fresh install needs, and
// the profiles the download arrow offers.
const settings = await libraries.refresh();
downloads.setProfiles(settings || {});
browse.setProfiles(settings || {});
gallery.setDownloadProfiles(settings || {});
subscriptions.setProfiles(settings || {});
subscriptions.setDefaults(settings || {});
// A fresh install has nothing to show until a folder is added, so say how
// before dropping someone at an empty form.
if (account.role === 'admin' && settings?.libraries.length === 0) {
  const welcome = document.querySelector('#welcome-dialog');
  const path = document.querySelector('#welcome-path');
  const message = document.querySelector('#welcome-message');
  document.querySelector('#welcome-later').addEventListener('click', () => welcome.close());
  path.addEventListener('input', () => { message.hidden = true; });
  document.querySelector('#welcome-form').addEventListener('submit', async event => {
    event.preventDefault();
    const failure = await libraries.add(path.value.trim());
    message.textContent = failure;
    message.hidden = !failure;
    if (!failure) welcome.close();
  });
  welcome.showModal();
}
