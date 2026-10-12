// The head of a channel's page: the
// channel's picture beside its name and a line of what the archive holds.

import {accentFromImage, formatBytes, whenImageLoaded} from 'media-ui';
import {post} from './api.js';
import {setHeart} from './creator-shelf.js';
import {anchorPopover} from './popover.js';
import {createSubscriptionControls, fillProfileMenu, starredProfile, subscriptionOwnsProfile,
  subscriptionProfileName}
  from './subscription-controls.js';
import {channelSubscribeUrl, channelSubscriptionIdFor} from './subscription-target.js';
import {formatDate} from './watch-details.js';
import {plural, t} from './i18n.js';


/** A long total reads in hours and minutes, not as a clock. */
export function formatRuntime(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes < 60) return t('runtime.long.minutes', {minutes});
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? t('runtime.long.hoursMinutes', {hours, minutes: minutes % 60}) : t('runtime.long.hours', {hours});
}

/** The statistics line for a channel's videos and playlists. */
export function channelStats(items, playlists = []) {
  const runtime = items.reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0);
  const size = items.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const favourites = items.filter(item => item.favourite).length;
  const latest = Math.max(0, ...items.map(item => Number(item.archive?.uploadedAt || 0)));
  return [
    plural('count.videos', items.length),
    playlists.length ? plural('count.playlists', playlists.length) : '',
    runtime ? formatRuntime(runtime) : '',
    size ? formatBytes(size) : '',
    favourites ? plural('count.favourites', favourites) : '',
    latest ? t('channel.latest', {date: formatDate(latest)}) : '',
  ].filter(Boolean);
}

export function createChannelProfile({section, loadImage, onToggleFavourite, onBrowse, subscriptions, report}) {
  const image = section.querySelector('[data-channel-profile-image]');
  const name = section.querySelector('[data-channel-profile-name]');
  const initial = section.querySelector('[data-channel-profile-initial]');
  const stats = section.querySelector('[data-channel-profile-stats]');
  const heart = section.querySelector('[data-channel-profile-favourite]');
  const subscribe = section.querySelector('[data-channel-profile-subscribe]');
  const browse = section.querySelector('[data-channel-profile-browse]');
  const profileTrigger = section.querySelector('[data-channel-download-trigger]');
  const profileMenu = section.querySelector('#channel-download-profile-menu');
  const profileLabel = profileTrigger.querySelector('[data-channel-download-label]');
  let current = null;
  let profiles = [];
  let defaultProfile = '';
  let channelProfiles = {};
  let saving = false;
  let renderedChannelId = '';
  let renderedProfiles = null;
  let renderedDefault = '';
  let subscribeUrl = '';
  let subscriptionId = null;
  let subscription = null;
  const subscriptionControls = createSubscriptionControls({
    interval: section.querySelector('[data-channel-subscription-interval]'),
    intervalMenu: section.querySelector('#channel-subscription-interval-menu'),
    check: section.querySelector('[data-channel-subscription-check]'),
    subscriptions,
  });
  // Said inside the menu, above the choices, when the subscription's own
  // profile is the one its checks use: the button then names that profile
  // rather than the channel's, and choosing hands the say back to the channel.
  const profileNote = document.createElement('p');
  profileNote.className = 'download-profile-menu-note';
  anchorPopover(profileTrigger, profileMenu);
  image.addEventListener('error', () => { image.hidden = true; });
  heart.addEventListener('click', () => current && onToggleFavourite(current));
  browse.addEventListener('click', () => {
    if (subscribeUrl) onBrowse?.({kind: 'channel', url: subscribeUrl, title: current?.name || ''});
  });
  subscribe.addEventListener('click', () => {
    if (!subscribeUrl) return;
    if (subscriptionId) subscriptions.unsubscribe(subscriptionId, current?.name || t('subscriptions.thisChannel'));
    else subscriptions.subscribe(subscribeUrl, {channelId: current?.channelId || ''});
  });

  function drawProfileChoice() {
    const channelId = current?.channelId;
    profileTrigger.hidden = !channelId;
    if (!channelId) {
      if (profileMenu.matches(':popover-open')) profileMenu.hidePopover();
      renderedChannelId = '';
      return;
    }
    if (saving) return;
    if (channelId !== renderedChannelId || profiles !== renderedProfiles
        || defaultProfile !== renderedDefault) {
      if (profileMenu.matches(':popover-open')) profileMenu.hidePopover();
      const starred = starredProfile(profiles, defaultProfile);
      fillProfileMenu(profileMenu, [{id: '', name: starred ? t('channel.noOverrideStarred', {name: starred.name}) : t('channel.noOverride')},
        ...profiles.map(profile => (profile === starred ? {...profile, detail: t('profiles.default')} : profile))],
        '', chooseProfile);
      profileMenu.prepend(profileNote);
      renderedChannelId = channelId;
      renderedProfiles = profiles;
      renderedDefault = defaultProfile;
    }
    const chosen = channelProfiles[channelId] || '';
    const override = profiles.find(profile => profile.id === chosen)?.name;
    // The subscription's checks are what this page most wants to be honest
    // about, so a subscription with its own profile names that one here even
    // though the menu still sets the channel's.
    const owned = subscriptionOwnsProfile(subscription);
    const ownName = owned ? subscriptionProfileName(subscription, profiles, defaultProfile) : '';
    profileLabel.textContent = owned ? ownName : override || t('profiles.downloadProfile');
    profileTrigger.title = owned
      ? t('channel.subscriptionProfile', {name: ownName})
      : t('channel.profile', {name: override || t('channel.noOverride')});
    profileNote.hidden = !owned;
    profileNote.textContent = owned
      ? t('channel.note', {name: ownName})
      : '';
    profileTrigger.disabled = false;
    for (const button of profileMenu.querySelectorAll('[role="menuitemradio"]')) {
      button.setAttribute('aria-checked', String(button.dataset.profile === chosen));
    }
  }
  async function chooseProfile(selectedProfile) {
    if (!current?.channelId || saving) return;
    const channelId = current.channelId;
    saving = true;
    profileTrigger.disabled = true;
    try {
      const settings = await post('/api/settings/channel-profile',
        {channelId, profile: selectedProfile});
      channelProfiles = settings.channelProfiles || {};
      // One menu decides it: a subscription that chose its own profile goes
      // back to Default, which follows the channel's. Only the subscriptions
      // drawer gives a subscription a profile apart from its channel.
      if (subscriptionId && subscriptionOwnsProfile(subscription)) {
        await subscriptions.update(subscriptionId, {profile: '', channelId},
          'subscriptions.error.updateOne');
      }
    } catch (error) {
      report(t('error.reason', {message: t('channel.error.profile'), reason: error.message || error}), {error: true});
    } finally {
      saving = false;
      drawProfileChoice();
    }
  }

  return {
    setProfiles(settings = {}) {
      profiles = settings.downloadProfiles || [];
      defaultProfile = settings.defaultProfile || '';
      channelProfiles = settings.channelProfiles || {};
      drawProfileChoice();
    },
    /** `channel` is `{id, name, channelId}`, or null to put the head away. */
    update(channel, {items = [], playlists = [], favourite = false} = {}) {
      section.hidden = !channel;
      if (!channel) { current = null; drawProfileChoice(); return; }
      const changed = current?.id !== channel.id;
      current = channel;
      name.textContent = channel.name;
      initial.textContent = ([...String(channel.name || '').trim()][0] || '').toLocaleUpperCase();
      stats.textContent = channelStats(items, playlists).join(' · ');
      setHeart(heart, channel.name, favourite);
      subscribeUrl = channelSubscribeUrl(items);
      subscriptionId = subscribeUrl
        ? channelSubscriptionIdFor(subscriptions.list(), items, channel.channelId) : null;
      subscription = subscriptions.list().find(entry => entry.id === subscriptionId) || null;
      subscriptionControls.update(subscription);
      drawProfileChoice();
      subscribe.hidden = !subscribeUrl;
      browse.hidden = !subscribeUrl || !onBrowse;
      subscribe.textContent = subscriptionId ? t('subscriptions.unsubscribe') : t('subscriptions.subscribe');
      subscribe.classList.toggle('is-subscribed', Boolean(subscriptionId));
      if (!changed) return;
      image.hidden = true;
      image.removeAttribute('src');
      section.style.removeProperty('--card-accent');
      loadImage(channel.channelId).then(url => {
        if (!url || current?.id !== channel.id) return;
        image.src = url;
        image.hidden = false;
        whenImageLoaded(image, () => {
          const accent = accentFromImage(image, 32, 32);
          if (accent) section.style.setProperty('--card-accent', accent);
        });
      });
    },
  };
}
