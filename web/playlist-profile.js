// The head of an individual playlist: collection art made from its own videos,
// followed by its name, owner, archive totals and subscription control.

import {formatBytes} from 'media-ui';
import {formatRuntime} from './channel-profile.js';
import {setHeart} from './creator-shelf.js';
import {anchorPopover} from './popover.js';
import {choiceFor, createSubscriptionControls, fillProfileMenu, profileChoices,
  subscriptionProfileName}
  from './subscription-controls.js';
import {playlistSubscribeUrl, subscribedIdFor} from './subscription-target.js';
import {plural, t} from './i18n.js';


/** `tracks` is the tracklist's own summary, when the playlist is shown as
 *  one: it counts tracks rather than videos. An album's year is not among the
 *  figures; it sits beside the artist. */
export function playlistStats(playlist, tracks = null) {
  const items = playlist?.items || [];
  const runtime = items.reduce((sum, item) => sum + Number(item.durationSeconds || 0), 0);
  const size = items.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
  const count = Number(playlist?.count || items.length);
  const noun = tracks ? 'count.tracks' : 'count.videos';
  return [
    count > items.length ? t('playlist.partial', {held: items.length, total: plural(noun, count)}) : plural(noun, items.length),
    runtime ? formatRuntime(runtime) : '',
    size ? formatBytes(size) : '',
  ].filter(Boolean);
}

export function createPlaylistProfile({section, subscriptions, onOpenOwner, onToggleFavourite, onBrowse}) {
  const name = section.querySelector('[data-playlist-profile-name]');
  const byline = section.querySelector('[data-playlist-profile-byline]');
  const ownerLink = section.querySelector('[data-playlist-profile-owner]');
  const uploader = section.querySelector('[data-playlist-profile-uploader]');
  const year = section.querySelector('[data-playlist-profile-year]');
  const stats = section.querySelector('[data-playlist-profile-stats]');
  const subscribe = section.querySelector('#playlist-subscribe');
  const browse = section.querySelector('#playlist-browse');
  const images = [...section.querySelectorAll('[data-playlist-profile-image]')];
  const heart = section.querySelector('[data-playlist-profile-favourite]');
  const profileTrigger = section.querySelector('[data-playlist-download-trigger]');
  const profileLabel = section.querySelector('[data-playlist-download-label]');
  const profileMenu = section.querySelector('#playlist-download-profile-menu');
  const subscriptionControls = createSubscriptionControls({
    interval: section.querySelector('[data-playlist-subscription-interval]'),
    intervalMenu: section.querySelector('#playlist-subscription-interval-menu'),
    check: section.querySelector('[data-playlist-subscription-check]'),
    subscriptions,
  });
  let url = '';
  let subscriptionId = null;
  let subscription = null;
  let profiles = [];
  let defaultProfile = '';
  let owner = null;
  let current = null;
  anchorPopover(profileTrigger, profileMenu);

  heart.addEventListener('click', () => current && onToggleFavourite?.(current));

  browse.addEventListener('click', () => {
    if (url) onBrowse?.({kind: 'playlist', url, title: name.textContent});
  });
  subscribe.addEventListener('click', () => {
    if (!url) return;
    if (subscriptionId) subscriptions.unsubscribe(subscriptionId, name.textContent);
    else subscriptions.subscribe(url);
  });
  ownerLink.addEventListener('click', event => {
    event.preventDefault();
    if (owner) onOpenOwner(owner);
  });

  /* A playlist has no profile of its own apart from its subscription's, so
     unlike a channel's page this button is the subscription's choice, the
     same menu as its row in the subscriptions drawer. Default follows the
     owning channel's profile, as it does there. */
  function drawProfileChoice() {
    profileTrigger.hidden = !subscription;
    if (!subscription) {
      if (profileMenu.matches(':popover-open')) profileMenu.hidePopover();
      return;
    }
    const selection = choiceFor(subscription.profileSelection ?? 'manual', defaultProfile);
    const profileName = subscriptionProfileName(subscription, profiles, defaultProfile);
    profileLabel.textContent = selection === '' ? t('profiles.downloadProfile') : profileName;
    profileTrigger.title = t('playlist.subscriptionProfile', {name: profileName});
    if (profileMenu.matches(':popover-open')) return;
    const id = subscription.id;
    fillProfileMenu(profileMenu, [...profileChoices(profiles, defaultProfile),
      {id: 'manual', name: t('subscriptions.currentSettings')}], selection, chosen => {
      if (chosen === selection) return;
      subscriptions.update(id, chosen === 'manual' ? {profileSelection: 'manual'} : {profile: chosen},
        'subscriptions.error.profile');
    });
  }

  return {
    setProfiles(settings = {}) {
      profiles = settings.downloadProfiles || [];
      defaultProfile = settings.defaultProfile || '';
      drawProfileChoice();
    },
    update(playlist, {favourite = false, tracks = null} = {}) {
      section.hidden = !playlist;
      current = playlist;
      if (!playlist) return;
      name.textContent = playlist.title;
      setHeart(heart, playlist.title, favourite, {noun: 'playlists'});
      owner = playlist.owner?.id ? playlist.owner : null;
      // An album is by its artist. YouTube files one under a "Topic" channel
      // named for them, which is still where the link goes.
      const artist = tracks?.album ? tracks.artist : '';
      const ownerName = artist || owner?.name || playlist.uploader;
      byline.hidden = !ownerName;
      ownerLink.hidden = !owner;
      ownerLink.textContent = owner ? artist || owner.name : '';
      uploader.hidden = Boolean(owner);
      uploader.textContent = owner ? '' : artist || playlist.uploader || '';
      year.hidden = !tracks?.year;
      year.textContent = tracks?.year ? String(tracks.year) : '';
      stats.textContent = playlistStats(playlist, tracks).join(' · ');
      url = playlistSubscribeUrl(playlist);
      subscriptionId = url ? subscribedIdFor(subscriptions.list(), 'playlist', url) : null;
      subscription = subscriptions.list().find(entry => entry.id === subscriptionId) || null;
      subscribe.hidden = !url;
      browse.hidden = !url || !onBrowse;
      subscriptionControls.update(subscription);
      drawProfileChoice();
      subscribe.textContent = subscriptionId ? t('subscriptions.unsubscribe') : t('subscriptions.subscribe');
      subscribe.classList.toggle('is-subscribed', Boolean(subscriptionId));
      // Every track of an album wears the same cover, so a stack of four
      // would be four of one; the album shows it once, square and larger.
      section.toggleAttribute('data-album', Boolean(tracks?.album));
      section.toggleAttribute('data-covers', Boolean(tracks?.covers));
      images.forEach((image, index) => {
        const thumbnail = tracks?.album && index ? ''
          : playlist.items[index]?.thumbnail?.url || playlist.items[index]?.thumbnail?.src || '';
        image.hidden = !thumbnail;
        if (thumbnail) image.src = thumbnail;
        else image.removeAttribute('src');
      });
      section.dataset.thumbnailCount = String(images.filter(image => !image.hidden).length);
    },
  };
}
